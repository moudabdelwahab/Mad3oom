-- ============================================================================
-- 059_inbox_handoff_guarantee — ضمان التسليم للإنسان (Phase 2)
--
-- المشكلة (مقيسة على الإنتاج، 2026-09-29):
--   chat_sessions.is_manual_mode كان الحارس الوحيد، والويدجت هو اللي بيقراه
--   قبل ما ينادي SIE. مفيش أي حارس في الخادم: persist_bot_turn و
--   create_ticket_with_message_and_session_update والإدراجات من المتصفح بعلم
--   is_bot_reply كلها بتكتب رد البوت حتى لو الدعم مسك المحادثة. 8 رسايل بوت
--   اتخزنت بعد رد بشري في جلستين، و inbox_events كان فاضي (مفيش سجل تسليم)،
--   ومفيش أي مسار يرجّع المحادثة للبوت، والعميل نفسه كان يقدر يرجّع
--   is_manual_mode = false بتحديث مباشر (سياسة chat_sessions_update_own_or_admin).
--
-- القرار: مصدر حقيقة واحد = chat_sessions.is_manual_mode (الموقع وتيليجرام).
-- واتساب له نظامه المستقل (bot_user_states '__BLOCKED__') على محادثات مختلفة
-- تمامًا، ومش بيتلمس هنا.
--
--   ① حارس رد البوت: أي صف chat_messages بـ is_bot_reply = true يقفل صف
--      الجلسة (FOR NO KEY UPDATE) ويقرا is_manual_mode جوه نفس المعاملة؛ لو
--      الإنسان ماسك ⇒ الإدراج يترفض (55000). بيغطي كل الكاتبين: RPCs بتاعة
--      SIE، إدراجات المتصفح، service_role، وأي دالة منشورة من غير مصدر.
--   ② حارس حالة التسليم: is_manual_mode مايتغيرش إلا من جوه _handoff_set
--      (علم معاملة + دور مالك الدالة). تحديث مباشر من العميل أو الموظف أو
--      service_role يترفض (42501).
--   ③ السجل: كل تغيير فعلي يكتب حدث handoff_to_human / handoff_to_ai في
--      inbox_events بالفاعل والسبب والمصدر. نفس الحالة مرتين = لا تغيير ولا
--      حدث (idempotent).
--   ④ المسارات الرسمية: inbox_take_over / inbox_return_to_ai (موظف له وصول
--      للمحادثة فقط، بنفس _inbox_require)، و sie_request_human (صاحب الجلسة أو
--      service_role — تشغيل فقط، مفيش إيقاف). _inbox_post_reply بقى يمر من
--      _handoff_set بدل التحديث المباشر، والباقي حرفيًا زي 058.
--
-- السباق: رد الموظف بيقفل صف الجلسة FOR UPDATE قبل ما يقلب العلم، وحارس ①
-- بيقفل نفس الصف قبل ما يقرا العلم. فالاتنين مايتداخلوش: يا رد البوت يتخزن
-- كله قبل التسليم، يا يستنى التسليم يخلص فيشوف true ويترفض. طلب بوت شغال
-- وقت التسليم يكمّل حسابه لكن مايقدرش يكتب رده بعده.
--
-- قابل لإعادة التشغيل. التراجع: آخر الملف.
-- ============================================================================

-- ── أنواع الأحداث الجديدة (توسيع فقط) ────────────────────────────────────────
alter table public.inbox_events drop constraint if exists inbox_events_kind_check;
alter table public.inbox_events add constraint inbox_events_kind_check check (kind in (
  'assigned', 'unassigned', 'transferred', 'tagged', 'untagged', 'archived', 'unarchived',
  'closed', 'note_added', 'note_edited', 'note_deleted', 'forwarded_as_note',
  'message_edited', 'message_deleted',
  'scheduled', 'schedule_cancelled', 'schedule_sent', 'schedule_failed',
  'handoff_to_human', 'handoff_to_ai'));

-- ── ② حارس حالة التسليم ────────────────────────────────────────────────────
-- مسموح بس لما _handoff_set يكون ضابط العلم في نفس المعاملة **و** التنفيذ
-- جوه دالة SECURITY DEFINER (current_user = مالك الدالة، مش دور من أدوار
-- الـ API). الاتنين مع بعض: العلم لوحده ممكن يتضبط من أي set_config، والدور
-- لوحده ممكن يعدّي دالة مالكة تانية نسيت السجل.
create or replace function public.guard_handoff_state()
returns trigger
language plpgsql
security invoker
set search_path to 'public'
as $$
begin
  if tg_op = 'INSERT' then
    if coalesce(new.is_manual_mode, false) = false then return new; end if;
  elsif new.is_manual_mode is not distinct from old.is_manual_mode then
    return new;
  end if;

  if coalesce(current_setting('mad3oom.handoff_authorized', true), '') <> 'on'
     or current_user in ('anon', 'authenticated', 'service_role') then
    raise exception 'حالة التسليم للإنسان ماتتغيرش إلا من المسار الرسمي'
      using errcode = '42501',
            hint = 'use inbox_take_over / inbox_return_to_ai / sie_request_human';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_handoff_state on public.chat_sessions;
create trigger trg_guard_handoff_state
  before insert or update of is_manual_mode on public.chat_sessions
  for each row execute function public.guard_handoff_state();

-- ── ③ السجل ───────────────────────────────────────────────────────────────
create or replace function public.log_handoff_change()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_actor uuid := nullif(current_setting('mad3oom.handoff_actor', true), '')::uuid;
begin
  if new.is_manual_mode is not distinct from old.is_manual_mode then return null; end if;
  insert into public.inbox_events (session_id, actor_id, kind, payload)
  values (new.id,
          v_actor,
          case when coalesce(new.is_manual_mode, false) then 'handoff_to_human' else 'handoff_to_ai' end,
          jsonb_build_object(
            'reason', coalesce(nullif(current_setting('mad3oom.handoff_reason', true), ''), 'unspecified'),
            'source', coalesce(nullif(current_setting('mad3oom.handoff_source', true), ''), 'unknown'),
            'from', case when coalesce(old.is_manual_mode, false) then 'human' else 'ai' end,
            'to',   case when coalesce(new.is_manual_mode, false) then 'human' else 'ai' end));
  return null;
end;
$$;
revoke all on function public.log_handoff_change() from public, anon, authenticated;

drop trigger if exists trg_log_handoff_change on public.chat_sessions;
create trigger trg_log_handoff_change
  after update of is_manual_mode on public.chat_sessions
  for each row execute function public.log_handoff_change();

-- ── المسار الوحيد اللي يغيّر الحالة ─────────────────────────────────────────
-- داخلي: مش ممنوح لأي دور من أدوار الـ API. بيرجّع true لو الحالة اتغيرت
-- فعلًا، false لو كانت كده أصلًا (idempotent — ولا حدث مكرر).
create or replace function public._handoff_set(
  p_session uuid, p_to_human boolean, p_reason text, p_source text, p_actor uuid)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_current boolean;
begin
  if p_session is null or p_to_human is null then
    raise exception 'مدخلات التسليم ناقصة' using errcode = '22023';
  end if;
  -- نفس القفل اللي بياخده حارس رد البوت: ده اللي بيمنع التداخل.
  select coalesce(s.is_manual_mode, false) into v_current
    from public.chat_sessions s where s.id = p_session for update;
  if not found then
    raise exception 'المحادثة غير موجودة' using errcode = 'P0002';
  end if;
  if v_current = p_to_human then
    return false;
  end if;

  perform set_config('mad3oom.handoff_authorized', 'on', true);
  perform set_config('mad3oom.handoff_reason', left(coalesce(nullif(btrim(p_reason), ''), 'unspecified'), 500), true);
  perform set_config('mad3oom.handoff_source', coalesce(nullif(btrim(p_source), ''), 'unknown'), true);
  perform set_config('mad3oom.handoff_actor', coalesce(p_actor::text, ''), true);

  update public.chat_sessions set is_manual_mode = p_to_human where id = p_session;

  -- العلم مايفضلش مفتوح لباقي المعاملة.
  perform set_config('mad3oom.handoff_authorized', '', true);
  perform set_config('mad3oom.handoff_reason', '', true);
  perform set_config('mad3oom.handoff_source', '', true);
  perform set_config('mad3oom.handoff_actor', '', true);
  return true;
end;
$$;
revoke all on function public._handoff_set(uuid, boolean, text, text, uuid) from public, anon, authenticated;

-- ── ① حارس رد البوت ───────────────────────────────────────────────────────
create or replace function public.guard_ai_reply_handoff()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_manual boolean;
begin
  if coalesce(new.is_bot_reply, false) = false or new.session_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and coalesce(old.is_bot_reply, false) then
    return new;  -- تعديل رسالة بوت قديمة مش رد جديد
  end if;
  -- القفل قبل القراءة: لو تسليم شغال على الجلسة دي، نستناه ونقرا نتيجته.
  select coalesce(s.is_manual_mode, false) into v_manual
    from public.chat_sessions s where s.id = new.session_id for no key update;
  if v_manual then
    raise exception 'المحادثة مع فريق الدعم — البوت مايقدرش يرد دلوقتي'
      using errcode = '55000', hint = 'human_handoff';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_ai_reply_handoff() from public, anon, authenticated;

drop trigger if exists trg_guard_ai_reply_handoff on public.chat_messages;
create trigger trg_guard_ai_reply_handoff
  before insert or update of is_bot_reply on public.chat_messages
  for each row execute function public.guard_ai_reply_handoff();

-- ── رد الدعم: نفس 058 حرفيًا، والتسليم من المسار الرسمي ─────────────────────
create or replace function public._inbox_post_reply(p_session uuid, p_sender uuid, p_body text, p_attachment jsonb)
returns public.chat_messages
language plpgsql
security definer
set search_path to 'public'
as $$
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
  -- 059: من المسار الرسمي — نفس الأثر، ومعاه حدث handoff_to_human في السجل.
  perform public._handoff_set(p_session, true, 'human_reply', 'inbox_reply', p_sender);

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

-- ── ④ المسارات الرسمية ─────────────────────────────────────────────────────
-- الموظف يمسك المحادثة من غير ما يرد.
create or replace function public.inbox_take_over(p_session uuid, p_reason text default null)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  perform public._inbox_require(p_session);
  if (select s.status from public.chat_sessions s where s.id = p_session) = 'closed' then
    raise exception 'المحادثة مقفولة' using errcode = '22023';
  end if;
  return public._handoff_set(p_session, true, coalesce(nullif(btrim(p_reason), ''), 'manual_takeover'), 'inbox', auth.uid());
end;
$$;

-- الطريق الوحيد لرجوع البوت: موظف له وصول للمحادثة، من الخادم، ومسجَّل.
create or replace function public.inbox_return_to_ai(p_session uuid, p_reason text default null)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  perform public._inbox_require(p_session);
  if (select s.status from public.chat_sessions s where s.id = p_session) = 'closed' then
    raise exception 'المحادثة مقفولة — مفيش حد يرد عليه البوت' using errcode = '22023';
  end if;
  return public._handoff_set(p_session, false, coalesce(nullif(btrim(p_reason), ''), 'returned_by_agent'), 'inbox', auth.uid());
end;
$$;

-- تصعيد SIE: صاحب الجلسة (الموقع) أو service_role (تيليجرام). تشغيل بس —
-- مفيش مسار هنا يرجّع البوت.
create or replace function public.sie_request_human(p_session uuid, p_reason text default null)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_owner uuid;
begin
  select s.user_id into v_owner from public.chat_sessions s where s.id = p_session;
  if not found then
    raise exception 'المحادثة غير موجودة' using errcode = 'P0002';
  end if;
  if not (auth.uid() is not null and auth.uid() = v_owner)
     and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'مش مسموحلك تطلب تسليم المحادثة دي' using errcode = '42501';
  end if;
  return public._handoff_set(p_session, true,
    'sie:' || coalesce(nullif(btrim(p_reason), ''), 'escalation'), 'sie', auth.uid());
end;
$$;

do $$
declare f text;
begin
  foreach f in array array['public.inbox_take_over(uuid, text)',
                           'public.inbox_return_to_ai(uuid, text)',
                           'public.sie_request_human(uuid, text)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.sie_request_human(uuid, text) to service_role;
  end if;
end $$;

-- ============================================================================
-- التحقق
-- ============================================================================
do $$
declare f text;
begin
  if not exists (select 1 from pg_trigger where tgrelid = 'public.chat_messages'::regclass
                  and tgname = 'trg_guard_ai_reply_handoff' and not tgisinternal)
     or not exists (select 1 from pg_trigger where tgrelid = 'public.chat_sessions'::regclass
                  and tgname = 'trg_guard_handoff_state' and not tgisinternal)
     or not exists (select 1 from pg_trigger where tgrelid = 'public.chat_sessions'::regclass
                  and tgname = 'trg_log_handoff_change' and not tgisinternal) then
    raise exception '059: محفّزات التسليم ناقصة';
  end if;
  foreach f in array array['public._handoff_set(uuid, boolean, text, text, uuid)',
                           'public._inbox_post_reply(uuid, uuid, text, jsonb)',
                           'public.guard_ai_reply_handoff()',
                           'public.log_handoff_change()'] loop
    if has_function_privilege('authenticated', f, 'EXECUTE') or has_function_privilege('anon', f, 'EXECUTE') then
      raise exception '059: دالة داخلية مكشوفة: %', f;
    end if;
  end loop;
  foreach f in array array['public.inbox_take_over(uuid, text)',
                           'public.inbox_return_to_ai(uuid, text)',
                           'public.sie_request_human(uuid, text)'] loop
    if has_function_privilege('anon', f, 'EXECUTE') then
      raise exception '059: anon يقدر ينادي %', f;
    end if;
  end loop;
  raise notice '059: ضمان التسليم للإنسان جاهز';
end $$;

-- ============================================================================
-- التراجع (بالترتيب) — الملف الكامل: migrations/_rollback/059_inbox_handoff_guarantee.down.sql
--   drop trigger if exists trg_guard_ai_reply_handoff on public.chat_messages;
--   drop trigger if exists trg_guard_handoff_state on public.chat_sessions;
--   drop trigger if exists trg_log_handoff_change on public.chat_sessions;
--   _inbox_post_reply يرجع لنص 058 (التحديث المباشر لـ is_manual_mode) — لازم
--     قبل حذف _handoff_set.
--   drop function if exists public.inbox_take_over(uuid, text), public.inbox_return_to_ai(uuid, text),
--     public.sie_request_human(uuid, text), public._handoff_set(uuid, boolean, text, text, uuid),
--     public.guard_ai_reply_handoff(), public.guard_handoff_state(), public.log_handoff_change();
--   قيد inbox_events_kind_check الأوسع يفضل: أحداث handoff_* المكتوبة تبقى (السجل إلحاق فقط).
-- ============================================================================
