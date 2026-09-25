-- ============================================================================
-- 056_inbox_attachments_reactions_edits.sql
--   صندوق الرسائل — المرحلة 2: مرفقات الدعم، التفاعلات الداخلية، وتعديل
--   ردود الدعم وحذفها.
--
-- الخطة: docs/INBOX_HELPDESK_PLAN_AR.md (D4 = تفاعلات داخلية للطاقم).
-- يبني على 054_chat_composer_attachments و 055_inbox_helpdesk_core.
--
-- ════════════════════════════════════════════════════════════════════════════
-- ما تغيّر عن الخطة، ولماذا
-- ════════════════════════════════════════════════════════════════════════════
--   الخطة كانت جدول chat_message_attachments ومسار inbox/<session>/… . بعدها
--   طبّق 054 عمود chat_messages.attachment ومحفّز يفرض أن مسار أي مرفق داخل
--   مجلد **مرسل الرسالة** وموجود فعلًا. فمرفق الدعم يمشي نفس طريق مرفق
--   العميل حرفيًا:
--     • الموظف يرفع في مجلده هو (<uid>/…) — سياسة الرفع القائمة تسمح بذلك.
--     • الرسالة تحمل attachment (+ image_url/audio_url) — ومحفّز 054 يتحقق.
--   الناقص الوحيد: العميل لا يقرأ إلا مجلده. فسياسة قراءة **مضافة**: ملف
--   يشير إليه **رد دعم** في جلسة يملكها العميل.
--
-- ════════════════════════════════════════════════════════════════════════════
-- التغييرات
-- ════════════════════════════════════════════════════════════════════════════
--   ① chat_messages: عمودا edited_at و deleted_at (nullable بلا default) —
--      الإضافة الوحيدة على جدول يكتب فيه SIE؛ إدراجاته لا تتأثر.
--   ② inbox_send_reply(session, body, attachment) تحل محل (session, body).
--   ③ تعديل/حذف ردود الدعم فقط، عبر RPC، مع سجل نسخ (chat_message_revisions)
--      للطاقم. الحذف يمحو النص والمرفق من الصف لأن العميل يملك SELECT عليه.
--      رسائل العميل والبوت و SIE لا تُعدَّل ولا تُحذف.
--   ④ inbox_reactions: تفاعلات داخلية على رسالة أو ملاحظة (D4).
--   ⑤ سياسة قراءة تخزين مضافة لمرفقات ردود الدعم.
--
-- ما لا يفعله
--   • لا يغيّر سياسة قائمة على chat_sessions/chat_messages/storage.objects
--   • لا يلمس محفّز 054 ولا حدود المستودع ولا SIE
--
-- التراجع: آخر الملف.
-- ============================================================================


-- ============================================================================
-- 0) المتطلبات
-- ============================================================================
do $$
begin
  if to_regprocedure('public.inbox_can_access(uuid)') is null
     or to_regprocedure('public._inbox_require(uuid)') is null
     or to_regprocedure('public.inbox_send_reply(uuid, text)') is null then
    raise exception '056 يتطلب 055_inbox_helpdesk_core';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'chat_messages' and column_name = 'attachment')
     or to_regprocedure('public.guard_chat_message_attachment()') is null then
    raise exception '056 يتطلب 054_chat_composer_attachments (عمود attachment ومحفّز الحارس)';
  end if;
end $$;


-- ============================================================================
-- 1) أعمدة التعديل والحذف على chat_messages
-- ============================================================================
alter table public.chat_messages add column if not exists edited_at timestamptz;
alter table public.chat_messages add column if not exists deleted_at timestamptz;

comment on column public.chat_messages.edited_at is
  'آخر تعديل لرد الدعم (inbox_edit_message). NULL = لم يُعدَّل. النص السابق في chat_message_revisions.';
comment on column public.chat_messages.deleted_at is
  'حذف رد الدعم (inbox_delete_message): النص والمرفق يُمحيان من الصف، ونسختهما في chat_message_revisions.';


-- ============================================================================
-- 2) سجل النسخ — للطاقم فقط
-- ============================================================================
create table if not exists public.chat_message_revisions (
  id                  uuid primary key default gen_random_uuid(),
  message_id          uuid not null references public.chat_messages(id) on delete cascade,
  session_id          uuid not null references public.chat_sessions(id) on delete cascade,
  action              text not null check (action in ('edit', 'delete')),
  previous_text       text not null,
  previous_attachment jsonb,
  actor_id            uuid references public.profiles(id) on delete set null,
  created_at          timestamptz not null default now()
);
create index if not exists chat_message_revisions_message on public.chat_message_revisions (message_id, created_at);


-- ============================================================================
-- 3) التفاعلات الداخلية (D4)
-- ============================================================================
-- session_id مكرّر عمدًا: السياسة تسأل inbox_can_access(session_id) مباشرة
-- بدل ربط بالرسالة أو الملاحظة لكل صف.
create table if not exists public.inbox_reactions (
  id         uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.chat_sessions(id) on delete cascade,
  message_id uuid references public.chat_messages(id) on delete cascade,
  note_id    uuid references public.inbox_notes(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  emoji      text not null,
  created_at timestamptz not null default now(),
  constraint inbox_reactions_one_target check (num_nonnulls(message_id, note_id) = 1)
);
create unique index if not exists inbox_reactions_message_once
  on public.inbox_reactions (message_id, user_id, emoji) where message_id is not null;
create unique index if not exists inbox_reactions_note_once
  on public.inbox_reactions (note_id, user_id, emoji) where note_id is not null;
create index if not exists inbox_reactions_session on public.inbox_reactions (session_id);


-- ============================================================================
-- 4) RLS والاتفاقيات (041/042) على الجدولين الجديدين
-- ============================================================================
do $$
declare
  t text;
begin
  foreach t in array array['chat_message_revisions', 'inbox_reactions'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    execute format('grant select on table public.%I to authenticated', t);
    execute format('drop policy if exists gate_account_active on public.%I', t);
    execute format($f$
      create policy gate_account_active on public.%I
        as restrictive for all to authenticated
        using (public.account_is_active()) with check (public.account_is_active())
    $f$, t);
    execute format('drop trigger if exists trg_preview_read_only on public.%I', t);
    execute format(
      'create trigger trg_preview_read_only
         before insert or update or delete on public.%I
         for each statement execute function public.guard_preview_read_only()', t);
  end loop;
end $$;

drop policy if exists chat_message_revisions_select on public.chat_message_revisions;
create policy chat_message_revisions_select on public.chat_message_revisions
  for select to authenticated
  using ((select public.inbox_is_agent()) and public.inbox_can_access(session_id));

drop policy if exists inbox_reactions_select on public.inbox_reactions;
create policy inbox_reactions_select on public.inbox_reactions
  for select to authenticated
  using ((select public.inbox_is_agent()) and public.inbox_can_access(session_id));


-- ============================================================================
-- 5) رد الدعم بمرفق — يحل محل (uuid, text)
-- ============================================================================
-- التوقيع القديم يُحذف: بقاؤه مع الجديد (ذي الافتراضي) يجعل نداء PostgREST
-- بالمعاملين غامضًا. الواجهة الحالية (معاملان) تصل للجديد عبر الافتراضي.
drop function if exists public.inbox_send_reply(uuid, text);

create or replace function public.inbox_send_reply(p_session uuid, p_body text, p_attachment jsonb default null)
returns public.chat_messages
language plpgsql security definer set search_path to 'public' as $$
declare
  v_body text := btrim(coalesce(p_body, ''));
  v_status text;
  v_kind text;
  v_path text;
  v_msg public.chat_messages;
begin
  perform public._inbox_require(p_session);
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
    -- داخل مجلد المرسل (auth.uid()) وموجود فعلًا في المستودع.
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
  values (p_session, auth.uid(), v_body, true,
          p_attachment,
          case when v_kind = 'image' then v_path end,
          case when v_kind = 'audio' then v_path end)
  returning * into v_msg;

  update public.inbox_conversations
     set archived_at = null, archived_by = null, updated_at = now(), updated_by = auth.uid()
   where session_id = p_session and archived_at is not null;
  if found then
    perform public._inbox_log(p_session, 'unarchived', jsonb_build_object('reason', 'reply'));
  end if;

  return v_msg;
end;
$$;


-- ============================================================================
-- 6) تعديل رد الدعم وحذفه
-- ============================================================================

create or replace function public._inbox_own_reply(p_message uuid, p_allow_elevated boolean)
returns public.chat_messages
language plpgsql security definer set search_path to 'public' as $$
declare v public.chat_messages;
begin
  select * into v from public.chat_messages where id = p_message for update;
  if v.id is null then
    raise exception 'الرسالة غير موجودة' using errcode = 'P0002';
  end if;
  perform public._inbox_require(v.session_id);
  -- رسائل العميل والبوت و SIE سجل المحادثة وأثر التشخيص — لا تُلمس.
  if not coalesce(v.is_admin_reply, false) then
    raise exception 'التعديل والحذف لردود الدعم بس' using errcode = '42501';
  end if;
  if v.sender_id is distinct from auth.uid()
     and not (p_allow_elevated and public.has_elevated_authority()) then
    raise exception 'مينفعش تعدّل أو تحذف رد حد تاني' using errcode = '42501';
  end if;
  if v.deleted_at is not null then
    raise exception 'الرسالة دي اتحذفت' using errcode = '22023';
  end if;
  return v;
end;
$$;
revoke all on function public._inbox_own_reply(uuid, boolean) from public, anon, authenticated;

create or replace function public.inbox_edit_message(p_message uuid, p_body text)
returns public.chat_messages
language plpgsql security definer set search_path to 'public' as $$
declare
  v_body text := btrim(coalesce(p_body, ''));
  v public.chat_messages;
begin
  v := public._inbox_own_reply(p_message, false);
  if length(v_body) = 0 or length(v_body) > 4000 then
    raise exception 'الرسالة لازم تكون بين 1 و 4000 حرف' using errcode = '22023';
  end if;
  if v_body = v.message_text then return v; end if;

  insert into public.chat_message_revisions (message_id, session_id, action, previous_text, previous_attachment, actor_id)
  values (v.id, v.session_id, 'edit', v.message_text, v.attachment, auth.uid());

  update public.chat_messages set message_text = v_body, edited_at = now()
   where id = v.id returning * into v;
  perform public._inbox_log(v.session_id, 'message_edited', jsonb_build_object('message_id', v.id));
  return v;
end;
$$;

-- الحذف يمحو النص والمرفق من الصف نفسه: العميل يملك SELECT عليه، فعلامة
-- «محذوف» وحدها كانت ستترك النص مقروءًا. الملف في المستودع يبقى، لكن سياسة
-- قراءة العميل (أدناه) تتجاهل المحذوف فيفقد الوصول إليه.
create or replace function public.inbox_delete_message(p_message uuid)
returns public.chat_messages
language plpgsql security definer set search_path to 'public' as $$
declare v public.chat_messages;
begin
  v := public._inbox_own_reply(p_message, true);

  insert into public.chat_message_revisions (message_id, session_id, action, previous_text, previous_attachment, actor_id)
  values (v.id, v.session_id, 'delete', v.message_text,
          coalesce(v.attachment,
                   case when v.image_url is not null then jsonb_build_object('kind', 'image', 'path', v.image_url) end,
                   case when v.audio_url is not null then jsonb_build_object('kind', 'audio', 'path', v.audio_url) end),
          auth.uid());

  update public.chat_messages
     set message_text = '', attachment = null, image_url = null, audio_url = null, deleted_at = now()
   where id = v.id returning * into v;
  -- تفاعلات الطاقم على رسالة محذوفة لا معنى لها.
  delete from public.inbox_reactions where message_id = v.id;
  perform public._inbox_log(v.session_id, 'message_deleted', jsonb_build_object('message_id', v.id));
  return v;
end;
$$;


-- ============================================================================
-- 7) التفاعلات
-- ============================================================================
-- قائمة مغلقة: التفاعل إشارة للفريق («شفته»، «هتابع»)، لا نص حر.
create or replace function public.inbox_toggle_reaction(p_message uuid, p_note uuid, p_emoji text)
returns boolean
language plpgsql security definer set search_path to 'public' as $$
declare
  v_session uuid;
  v_deleted timestamptz;
begin
  if num_nonnulls(p_message, p_note) <> 1 then
    raise exception 'التفاعل على رسالة أو ملاحظة واحدة' using errcode = '22023';
  end if;
  if p_emoji is null or not (p_emoji = any (array['👍', '✅', '👀', '🙏', '❤️', '😂', '⚠️', '🔥'])) then
    raise exception 'رمز غير مسموح' using errcode = '22023';
  end if;

  if p_message is not null then
    select m.session_id, m.deleted_at into v_session, v_deleted from public.chat_messages m where m.id = p_message;
  else
    select n.session_id, n.deleted_at into v_session, v_deleted from public.inbox_notes n where n.id = p_note;
  end if;
  if v_session is null then
    raise exception 'الرسالة أو الملاحظة غير موجودة' using errcode = 'P0002';
  end if;
  perform public._inbox_require(v_session);
  if v_deleted is not null then
    raise exception 'مينفعش تتفاعل مع حاجة اتحذفت' using errcode = '22023';
  end if;

  delete from public.inbox_reactions
   where user_id = auth.uid() and emoji = p_emoji
     and message_id is not distinct from p_message and note_id is not distinct from p_note;
  if found then return false; end if;

  insert into public.inbox_reactions (session_id, message_id, note_id, user_id, emoji)
  values (v_session, p_message, p_note, auth.uid(), p_emoji);
  return true;
end;
$$;


-- ============================================================================
-- 8) قراءة العميل لمرفقات ردود الدعم
-- ============================================================================
-- مضافة (permissive) ولا تعدّل chat_attachments_read_own_or_staff. العميل
-- يقرأ ملفًا فقط إن كان مرفق **رد دعم غير محذوف** في جلسة يملكها — لا ملفات
-- عملاء آخرين (المرسل موظف دائمًا هنا) ولا ملفات لم تُرسل بعد.
-- s.user_id و deleted_at طبقة ثانية لا الأولى: الاستعلام الداخلي يمرّ أصلًا
-- من RLS العميل على chat_messages، والحذف يمحو المسار من الصف. مقيسٌ في
-- tests/sql/inbox-phase2.test.sql (حذف السياسة كلها يُسقط PASS 2).
drop policy if exists chat_attachments_read_support_reply on storage.objects;
create policy chat_attachments_read_support_reply on storage.objects
  for select to authenticated
  using (
    bucket_id = 'chat-attachments'
    and exists (
      select 1
        from public.chat_messages m
        join public.chat_sessions s on s.id = m.session_id
       where s.user_id = auth.uid()
         and m.is_admin_reply
         and m.deleted_at is null
         and (m.attachment->>'path' = storage.objects.name
              or m.image_url = storage.objects.name
              or m.audio_url = storage.objects.name))
  );


-- ============================================================================
-- 9) صلاحيات التنفيذ و Realtime
-- ============================================================================
do $$
declare f text;
begin
  foreach f in array array[
    'public.inbox_send_reply(uuid, text, jsonb)',
    'public.inbox_edit_message(uuid, text)',
    'public.inbox_delete_message(uuid)',
    'public.inbox_toggle_reaction(uuid, uuid, text)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;

  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'inbox_reactions') then
    alter publication supabase_realtime add table public.inbox_reactions;
  end if;
end $$;


-- ============================================================================
-- 10) تحقق
-- ============================================================================
do $$
declare t text;
begin
  foreach t in array array['chat_message_revisions', 'inbox_reactions'] loop
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t
                and permissive = 'PERMISSIVE' and cmd <> 'SELECT') then
      raise exception '056: سياسة كتابة مباشرة على %', t;
    end if;
    if not exists (select 1 from pg_trigger where tgrelid = ('public.' || t)::regclass and tgname = 'trg_preview_read_only')
       or not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t
                       and policyname = 'gate_account_active' and permissive = 'RESTRICTIVE') then
      raise exception '056: % بلا اتفاقيات 041/042', t;
    end if;
    if has_table_privilege('authenticated', 'public.' || t, 'INSERT')
       or has_table_privilege('authenticated', 'public.' || t, 'UPDATE')
       or has_table_privilege('authenticated', 'public.' || t, 'DELETE') then
      raise exception '056: صلاحية كتابة على %', t;
    end if;
  end loop;
  if to_regprocedure('public.inbox_send_reply(uuid, text)') is not null then
    raise exception '056: التوقيع القديم لـ inbox_send_reply ما زال موجودًا';
  end if;
  if has_function_privilege('authenticated', 'public._inbox_own_reply(uuid, boolean)', 'EXECUTE') then
    raise exception '056: دالة داخلية مكشوفة';
  end if;
  raise notice '056: مرفقات الدعم والتفاعلات والتعديل/الحذف جاهزة';
end $$;

-- ============================================================================
-- التراجع (بالترتيب):
--   drop policy if exists chat_attachments_read_support_reply on storage.objects;
--   alter publication supabase_realtime drop table public.inbox_reactions;
--   drop function if exists public.inbox_toggle_reaction(uuid, uuid, text),
--     public.inbox_delete_message(uuid), public.inbox_edit_message(uuid, text),
--     public._inbox_own_reply(uuid, boolean), public.inbox_send_reply(uuid, text, jsonb);
--   -- ثم أعد inbox_send_reply(uuid, text) كما في 055 (القسم 6) مع صلاحياتها.
--   drop table if exists public.inbox_reactions, public.chat_message_revisions;
--   alter table public.chat_messages drop column if exists deleted_at, drop column if exists edited_at;
--   (الرسائل المحذوفة تبقى بنص فارغ؛ نصوصها الأصلية تضيع مع chat_message_revisions.)
-- ============================================================================
