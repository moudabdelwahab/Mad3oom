-- ============================================================================
-- 058_inbox_scheduled_replies.sql
--   صندوق الرسائل — المرحلة 3: جدولة رد الدعم.
--
-- الخطة: docs/INBOX_HELPDESK_PLAN_AR.md (§1.10 و §3.4). يبني على 055/056/057.
--
-- ════════════════════════════════════════════════════════════════════════════
-- التصميم
-- ════════════════════════════════════════════════════════════════════════════
--   inbox_scheduled_replies   رد مستني ميعاده: نص + مرفق (نفس شكل 056) + send_at
--                             + حالة pending → sent | failed | cancelled.
--   inbox_schedule_reply      الطاقم يجدول (دقيقة لـ 30 يوم قدام).
--   inbox_cancel_scheduled    الكاتب أو المشرف يلغي قبل الإرسال.
--   inbox_dispatch_scheduled  pg_cron كل دقيقة — مش متاحة لأي مستخدم.
--
--   مسار إرسال واحد: منطق inbox_send_reply اتنقل لدالة داخلية
--   _inbox_post_reply(session, sender, body, attachment)، و inbox_send_reply
--   بقت = التحقق من المستخدم الحالي + نفس الدالة. المجدول بيعدّي على نفس
--   الدالة باسم كاتبه — فالويدجت بيستقبل INSERT عادي (is_manual_mode ثم
--   is_admin_reply)، ومحفّز 054 بيتحقق من المرفق في مجلد الكاتب، بالظبط زي
--   الرد الفوري.
--
--   وقت الإرسال بيتعاد التحقق (الظروف ممكن تتغير في 30 يوم):
--     • الكاتب لسه موظف، حسابه نشط، ويوصل للمحادثة (إسناد/فريق/سلطة)
--     • المحادثة مش مقفولة، والمرفق لسه موجود
--   أي فشل ⇒ failed بسبب مكتوب + حدث في السجل + إشعار للكاتب — مش إرسال صامت
--   ولا تجاهل صامت.
--
--   التوازي: for update skip locked — تشغيلتين متداخلتين مابيبعتوش نفس الرد
--   مرتين (مقيس بجلستين حقيقيتين في tests/sql/inbox-scheduled.test.sql).
--
-- ما لا يفعله
--   • لا يلمس جداول الشات ولا سياساتها ولا الويدجت ولا SIE
--   • لا يستخدم scheduled_messages (جدولة واتساب — phone_number NOT NULL)
--
-- التراجع: آخر الملف.
-- ============================================================================


-- ============================================================================
-- 0) المتطلبات
-- ============================================================================
do $$
begin
  if to_regprocedure('public._inbox_is_supervisor()') is null
     or to_regprocedure('public.inbox_send_reply(uuid, text, jsonb)') is null then
    raise exception '058 يتطلب 056 و 057';
  end if;
  if to_regprocedure('public.chat_attachment_path_ok(text, uuid)') is null then
    raise exception '058 يتطلب 054_chat_composer_attachments (chat_attachment_path_ok)';
  end if;
  if to_regprocedure('public.gate_is_exempt_account(uuid)') is null
     or to_regprocedure('public.account_is_whitelisted(uuid)') is null
     or to_regprocedure('public.account_verification_ok(uuid)') is null then
    raise exception '058 يتطلب دوال بوابة الحساب (042)';
  end if;
end $$;


-- ============================================================================
-- 1) الجدول
-- ============================================================================
create table if not exists public.inbox_scheduled_replies (
  id             uuid primary key default gen_random_uuid(),
  session_id     uuid not null references public.chat_sessions(id) on delete cascade,
  -- الكاتب اتمسح ⇒ الرد يفشل وقت ميعاده بسبب مكتوب، مش يتبعت باسم حد تاني.
  author_id      uuid references public.profiles(id) on delete set null,
  body           text not null check (length(btrim(body)) between 1 and 4000),
  attachment     jsonb,
  send_at        timestamptz not null,
  status         text not null default 'pending'
                   check (status in ('pending', 'sent', 'failed', 'cancelled')),
  message_id     uuid references public.chat_messages(id) on delete set null,
  failure_reason text,
  cancelled_by   uuid references public.profiles(id) on delete set null,
  sent_at        timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
-- الموزّع بيقرا المستحق بس — فهرس جزئي صغير مهما كبر السجل.
create index if not exists inbox_scheduled_due
  on public.inbox_scheduled_replies (send_at) where status = 'pending';
create index if not exists inbox_scheduled_session
  on public.inbox_scheduled_replies (session_id, send_at);

comment on table public.inbox_scheduled_replies is
  'ردود دعم مجدولة (058). الإرسال عبر inbox_dispatch_scheduled (pg_cron) بنفس مسار inbox_send_reply.';


-- ============================================================================
-- 2) RLS والاتفاقيات (041/042)
-- ============================================================================
alter table public.inbox_scheduled_replies enable row level security;
revoke all on table public.inbox_scheduled_replies from public, anon, authenticated;
grant select on table public.inbox_scheduled_replies to authenticated;

drop policy if exists gate_account_active on public.inbox_scheduled_replies;
create policy gate_account_active on public.inbox_scheduled_replies
  as restrictive for all to authenticated
  using (public.account_is_active()) with check (public.account_is_active());

drop trigger if exists trg_preview_read_only on public.inbox_scheduled_replies;
create trigger trg_preview_read_only
  before insert or update or delete on public.inbox_scheduled_replies
  for each statement execute function public.guard_preview_read_only();

drop policy if exists inbox_scheduled_replies_select on public.inbox_scheduled_replies;
create policy inbox_scheduled_replies_select on public.inbox_scheduled_replies
  for select to authenticated
  using ((select public.inbox_is_agent()) and public.inbox_can_access(session_id));


-- ============================================================================
-- 3) مسار الإرسال الواحد
-- ============================================================================
-- جسم inbox_send_reply من 056 حرفيًا، مع p_sender مكان auth.uid() — ومن غير
-- التحقق من المستخدم الحالي (المتصل هو اللي بيتحقق). داخلية: مش متاحة لأحد.
create or replace function public._inbox_post_reply(p_session uuid, p_sender uuid, p_body text, p_attachment jsonb)
returns public.chat_messages
language plpgsql security definer set search_path to 'public' as $$
declare
  v_body text := btrim(coalesce(p_body, ''));
  v_status text;
  v_kind text;
  v_path text;
  v_msg public.chat_messages;
begin
  if p_sender is null then
    raise exception 'مفيش مرسل' using errcode = '42501';
  end if;
  if length(v_body) = 0 then
    raise exception 'الرسالة فاضية' using errcode = '22023';
  end if;
  if length(v_body) > 4000 then
    raise exception 'الرسالة أطول من 4000 حرف' using errcode = '22023';
  end if;
  if p_attachment is not null then
    v_kind := p_attachment->>'kind';
    v_path := p_attachment->>'path';
    -- الشكل يُفرض بقيد 054 (chat_messages_attachment_shape)، والمسار بمحفّزه:
    -- داخل مجلد المرسل وموجود فعلًا في المستودع.
    if v_kind is null or v_path is null then
      raise exception 'المرفق ناقص (kind/path)' using errcode = '22023';
    end if;
  end if;

  select s.status into v_status from public.chat_sessions s where s.id = p_session for update;
  if v_status = 'closed' then
    raise exception 'المحادثة مقفولة — العميل مش هيشوف الرد' using errcode = '22023';
  end if;

  -- البوت يقف أولًا حتى لا يرد على نفس الرسالة (الويدجت يعرض «فريق الدعم انضم»).
  update public.chat_sessions set is_manual_mode = true
   where id = p_session and is_manual_mode is distinct from true;

  -- image_url/audio_url مكرّرة من المرفق للتوافق — نفس ما يكتبه ويدجت العميل.
  insert into public.chat_messages (session_id, sender_id, message_text, is_admin_reply,
                                    attachment, image_url, audio_url)
  values (p_session, p_sender, v_body, true,
          p_attachment,
          case when v_kind = 'image' then v_path end,
          case when v_kind = 'audio' then v_path end)
  returning * into v_msg;

  update public.inbox_conversations
     set archived_at = null, archived_by = null, updated_at = now(), updated_by = p_sender
   where session_id = p_session and archived_at is not null;
  if found then
    insert into public.inbox_events (session_id, actor_id, kind, payload)
    values (p_session, p_sender, 'unarchived', jsonb_build_object('reason', 'reply'));
  end if;

  return v_msg;
end;
$$;
revoke all on function public._inbox_post_reply(uuid, uuid, text, jsonb) from public, anon, authenticated;

create or replace function public.inbox_send_reply(p_session uuid, p_body text, p_attachment jsonb default null)
returns public.chat_messages
language plpgsql security definer set search_path to 'public' as $$
begin
  perform public._inbox_require(p_session);
  return public._inbox_post_reply(p_session, auth.uid(), p_body, p_attachment);
end;
$$;


-- ============================================================================
-- 4) الجدولة والإلغاء
-- ============================================================================
create or replace function public.inbox_schedule_reply(p_session uuid, p_body text, p_send_at timestamptz,
                                                       p_attachment jsonb default null)
returns public.inbox_scheduled_replies
language plpgsql security definer set search_path to 'public' as $$
declare
  v_body text := btrim(coalesce(p_body, ''));
  v_row public.inbox_scheduled_replies;
begin
  perform public._inbox_require(p_session);
  if length(v_body) = 0 or length(v_body) > 4000 then
    raise exception 'الرسالة لازم تكون بين 1 و 4000 حرف' using errcode = '22023';
  end if;
  if p_send_at is null or p_send_at < now() + interval '1 minute' then
    raise exception 'ميعاد الإرسال لازم يكون بعد دقيقة على الأقل' using errcode = '22023';
  end if;
  if p_send_at > now() + interval '30 days' then
    raise exception 'ميعاد الإرسال لازم يكون خلال 30 يوم' using errcode = '22023';
  end if;
  if (select s.status from public.chat_sessions s where s.id = p_session) = 'closed' then
    raise exception 'المحادثة مقفولة — العميل مش هيشوف الرد' using errcode = '22023';
  end if;
  -- المرفق يتحقق دلوقتي (مش بس وقت الإرسال) عشان الغلط يبان للكاتب فورًا.
  if p_attachment is not null then
    if p_attachment->>'kind' is null or p_attachment->>'path' is null then
      raise exception 'المرفق ناقص (kind/path)' using errcode = '22023';
    end if;
    if not public.chat_attachment_path_ok(p_attachment->>'path', auth.uid()) then
      raise exception 'مرفق غير صالح: يجب أن يكون ملفًا مرفوعًا في مجلدك' using errcode = '42501';
    end if;
  end if;
  if (select count(*) from public.inbox_scheduled_replies r
       where r.session_id = p_session and r.status = 'pending') >= 20 then
    raise exception 'فيه 20 رد مجدول مستني في المحادثة دي بالفعل' using errcode = '22023';
  end if;

  insert into public.inbox_scheduled_replies (session_id, author_id, body, attachment, send_at)
  values (p_session, auth.uid(), v_body, p_attachment, p_send_at)
  returning * into v_row;
  perform public._inbox_log(p_session, 'scheduled',
    jsonb_build_object('schedule_id', v_row.id, 'send_at', v_row.send_at));
  return v_row;
end;
$$;

create or replace function public.inbox_cancel_scheduled(p_id uuid)
returns public.inbox_scheduled_replies
language plpgsql security definer set search_path to 'public' as $$
declare v_row public.inbox_scheduled_replies;
begin
  select * into v_row from public.inbox_scheduled_replies where id = p_id for update;
  if v_row.id is null then
    raise exception 'الرد المجدول غير موجود' using errcode = 'P0002';
  end if;
  perform public._inbox_require(v_row.session_id);
  if v_row.author_id is distinct from auth.uid() and not public._inbox_is_supervisor() then
    raise exception 'مينفعش تلغي رد مجدول لحد تاني' using errcode = '42501';
  end if;
  if v_row.status <> 'pending' then
    raise exception 'الرد ده مش مستني — حالته %', v_row.status using errcode = '22023';
  end if;

  update public.inbox_scheduled_replies
     set status = 'cancelled', cancelled_by = auth.uid(), updated_at = now()
   where id = p_id returning * into v_row;
  perform public._inbox_log(v_row.session_id, 'schedule_cancelled', jsonb_build_object('schedule_id', p_id));
  return v_row;
end;
$$;


-- ============================================================================
-- 5) الموزّع (pg_cron)
-- ============================================================================
-- نفس account_is_active() لكن لمستخدم بعينه: الموزّع بيشتغل من غير جلسة
-- مستخدم (auth.uid() = NULL)، فالتحقق من الكاتب لازم يكون بمعرّفه.
create or replace function public._inbox_account_active(p_user uuid)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select p_user is not null
     and not public.is_banned(p_user)
     and coalesce(public.gate_is_exempt_account(p_user)
                  or (public.account_is_whitelisted(p_user) and public.account_verification_ok(p_user)),
                  false);
$$;
revoke all on function public._inbox_account_active(uuid) from public, anon, authenticated;

create or replace function public.inbox_dispatch_scheduled(p_limit int default 100)
returns int
language plpgsql security definer set search_path to 'public' as $$
declare
  r public.inbox_scheduled_replies;
  v_msg public.chat_messages;
  v_reason text;
  v_done int := 0;
begin
  for r in
    select * from public.inbox_scheduled_replies
     where status = 'pending' and send_at <= now()
     order by send_at
     limit greatest(coalesce(p_limit, 100), 1)
     for update skip locked
  loop
    v_reason := null;
    -- إعادة التحقق وقت الإرسال: الظروف ممكن تتغير من وقت الجدولة.
    if r.author_id is null then
      v_reason := 'حساب الكاتب اتمسح';
    elsif not public._inbox_account_active(r.author_id) then
      v_reason := 'حساب الكاتب موقوف أو ناقص التفعيل';
    elsif not public._inbox_user_can_access(r.author_id, r.session_id) then
      v_reason := 'الكاتب مابقاش يوصل للمحادثة (اتنقلت أو اتشال من الفريق)';
    else
      begin
        -- معاملة فرعية: فشل رد واحد مايوقفش الباقي ومايسيبش أثر نص.
        v_msg := public._inbox_post_reply(r.session_id, r.author_id, r.body, r.attachment);
      exception when others then
        v_reason := sqlerrm;
      end;
    end if;

    if v_reason is null then
      update public.inbox_scheduled_replies
         set status = 'sent', message_id = v_msg.id, sent_at = now(), updated_at = now()
       where id = r.id;
      insert into public.inbox_events (session_id, actor_id, kind, payload)
      values (r.session_id, r.author_id, 'schedule_sent',
              jsonb_build_object('schedule_id', r.id, 'message_id', v_msg.id));
    else
      update public.inbox_scheduled_replies
         set status = 'failed', failure_reason = v_reason, updated_at = now()
       where id = r.id;
      insert into public.inbox_events (session_id, actor_id, kind, payload)
      values (r.session_id, r.author_id, 'schedule_failed',
              jsonb_build_object('schedule_id', r.id, 'reason', v_reason));
      perform public._inbox_notify(r.author_id, 'رد مجدول ماتبعتش', v_reason, r.session_id);
    end if;
    v_done := v_done + 1;
  end loop;
  return v_done;
end;
$$;
revoke all on function public.inbox_dispatch_scheduled(int) from public, anon, authenticated;


-- ============================================================================
-- 6) صلاحيات التنفيذ و Realtime و pg_cron
-- ============================================================================
do $$
declare f text;
begin
  foreach f in array array[
    'public.inbox_send_reply(uuid, text, jsonb)',
    'public.inbox_schedule_reply(uuid, text, timestamptz, jsonb)',
    'public.inbox_cancel_scheduled(uuid)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;

  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                      where pubname = 'supabase_realtime' and schemaname = 'public'
                        and tablename = 'inbox_scheduled_replies') then
    alter publication supabase_realtime add table public.inbox_scheduled_replies;
  end if;

  -- نفس نمط emp_ops_maintenance_tick في الإنتاج (كل دقيقة، كـ postgres).
  -- قاعدة من غير pg_cron (الاختبار المحلي): الموزّع موجود والجدولة لأ.
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(j.jobid) from cron.job j where j.jobname = 'inbox-dispatch-scheduled';
    perform cron.schedule('inbox-dispatch-scheduled', '* * * * *', 'select public.inbox_dispatch_scheduled()');
  end if;
end $$;


-- ============================================================================
-- 7) تحقق
-- ============================================================================
do $$
declare f text;
begin
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'inbox_scheduled_replies'
              and permissive = 'PERMISSIVE' and cmd <> 'SELECT') then
    raise exception '058: سياسة كتابة مباشرة على inbox_scheduled_replies';
  end if;
  if has_table_privilege('authenticated', 'public.inbox_scheduled_replies', 'INSERT')
     or has_table_privilege('authenticated', 'public.inbox_scheduled_replies', 'UPDATE')
     or has_table_privilege('authenticated', 'public.inbox_scheduled_replies', 'DELETE') then
    raise exception '058: صلاحية كتابة على inbox_scheduled_replies';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.inbox_scheduled_replies'::regclass
                  and tgname = 'trg_preview_read_only')
     or not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'inbox_scheduled_replies'
                     and policyname = 'gate_account_active' and permissive = 'RESTRICTIVE') then
    raise exception '058: inbox_scheduled_replies بلا اتفاقيات 041/042';
  end if;
  foreach f in array array['public._inbox_post_reply(uuid, uuid, text, jsonb)',
                           'public._inbox_account_active(uuid)',
                           'public.inbox_dispatch_scheduled(integer)'] loop
    if has_function_privilege('authenticated', f, 'EXECUTE') or has_function_privilege('anon', f, 'EXECUTE') then
      raise exception '058: دالة داخلية مكشوفة: %', f;
    end if;
  end loop;
  -- if متداخلة: PL/pgSQL بيخطط التعبير كله، فـ cron.job في نفس الشرط كانت
  -- بتكسر أي قاعدة من غير pg_cron.
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if not exists (select 1 from cron.job where jobname = 'inbox-dispatch-scheduled' and active) then
      raise exception '058: مهمة pg_cron مااتسجلتش';
    end if;
  end if;
  raise notice '058: جدولة ردود الدعم جاهزة';
end $$;

-- ============================================================================
-- التراجع (بالترتيب):
--   select cron.unschedule(jobid) from cron.job where jobname = 'inbox-dispatch-scheduled';
--   alter publication supabase_realtime drop table public.inbox_scheduled_replies;
--   drop function if exists public.inbox_dispatch_scheduled(int), public._inbox_account_active(uuid),
--     public.inbox_cancel_scheduled(uuid), public.inbox_schedule_reply(uuid, text, timestamptz, jsonb);
--   drop table if exists public.inbox_scheduled_replies;
--   inbox_send_reply و _inbox_post_reply يفضلوا: سلوكهم مطابق لـ 056 حرفيًا
--   (مقيس في tests/sql/inbox-scheduled.test.sql بعد التراجع).
--   (أحداث scheduled/schedule_* في inbox_events تبقى — السجل إلحاق فقط.)
-- ============================================================================
