-- ============================================================================
-- 067_conversation_core_gate — إغلاق فجوات Conversation Core قبل أي بيئة
--
-- المرجع: docs/CONVERSATION_CORE_GATE_AR.md (بوابة ما قبل الإنتاج لـ 064).
-- يعتمد على: 059–063 و 064 و 065 (ticket_account_owner و enforce_ticket_quota).
-- كل اختبار في tests/sql/conversation-core-gate.test.sql بيشتغل على نسخة
-- مطابقة لشكل الإنتاج (tests/fixtures/prod-shape) مش على جداول مكتوبة باليد.
--
-- اللي بيتصلّح (كل بند ليه إثبات «قبل» و«بعد» في الاختبار):
--
--   D1  حصة التذاكر (065) كانت بترمي استثناء جوه conv_commit_turn ⇒ الدور كله
--       يترجع ⇒ العميل مايوصلوش رد خالص. دلوقتي التذكرة جوه savepoint:
--         • الحصة خلصت ⇒ الرد يتسجّل + نص الحصة من الخادم يتضاف له، من غير
--           تذكرة، والسبب يرجع (ticketError) ويتسجل حدث ticket_failed.
--         • أي فشل تاني في التذكرة ⇒ الرد يتسجّل + نص ثابت + تسليم لإنسان
--           (حد لازم يشوف التذكرة اللي ماتفتحتش)، والحدث بالـ sqlstate.
--       والرسالة نفسها لو فشلت ⇒ مفيش أي أثر (التذكرة كمان بتترجع).
--   L1  ترتيب الأقفال: 064 كانت بتقفل الجلسة وبعدين قفل الحصة (من محفّز
--       التذكرة)، والمسار القديم (create_ticket_with_message_…) بيقفل الحصة
--       وبعدين الجلسة ⇒ deadlock مثبت. دلوقتي قفل الحصة الأول لما فيه تذكرة.
--   D2  المرفقات: ingest بيكتب attachment + image_url/audio_url (نفس شكل 054
--       وردود الدعم)، بنفس حارس المسار (مجلد المرسل وموجود في المستودع)،
--       ونص تلقائي زي الويدجت لو مفيش تعليق. النوع غير المدعوم يترفض قبل أي كتابة.
--   D3  ملكية الإنسان: المحادثة اللي ماسكها إنسان مابتتقفلش بالخمول، ولا
--       جلسة قديمة ماسكها إنسان بتتساب عشان خاملة. الثابت:
--         «المالك مابيتغيرش إلا عبر _handoff_set أو إقفال صريح».
--   D4  كاتب واحد: لما علم القناة يتفتح، العميل مايقدرش يكتب رسالة في محادثة
--       Core ولا ينشئ جلسة موقع بنفسه (سياسات RESTRICTIVE). والعميل عمومًا
--       مايقدرش يرجّع جلسة Core مقفولة ولا يغيّر user_id / guest_id / created_at فيها.
--       العلم مقفول ⇒ السلوك القديم بالظبط (ده اللي بيخلّي الرجوع ممكن).
--       وكمان كتّاب الخادم القدام (persist_bot_turn، create_ticket_with_message_…،
--       chat_post_notice، مسار تيليجرام القديم): محفّز على chat_messages بيرفض
--       أي رسالة غير رد موظف في محادثة Core علمها مفتوح، إلا لو جاية من conv_*
--       نفسها. يعني مستحيل ردّين من مسارين لنفس المحادثة.
--   G1  بوابة الحساب (042/066): Core بيشتغل بـ service_role فكان بيعدّي
--       السياسات RESTRICTIVE. ingest بيرفض الحساب المحظور/غير المعتمد.
--   N1  مساحة أسماء الدور: external_id بيبدأ بـ 'turn:' محجوز لردود الوكيل.
--       قبلها عميل يقدر يبعت رسالة بمعرّف 'turn:<key>' فـ commit بنفس المفتاح
--       يرجّع duplicate من غير ما يكتب رد (إسكات البوت). مثبت.
--   R1  محاولات الإرسال: حد أقصى (افتراضي 5)؛ بعده الرسالة failed نهائيًا
--       ومابتتطالبش تاني (dead letter قابل للاستعلام).
--   F1  أعلام تدريجية: core_ingest_<channel> تقبل true/false أو
--       {"enabled":bool,"users":[uuid…],"percent":0..100}.
--
-- قابل لإعادة التشغيل. مفيش حذف بيانات.
-- التراجع: migrations/_rollback/067_conversation_core_gate.down.sql
-- ============================================================================

-- ── الأحداث: ticket_failed (توسيع فقط) ─────────────────────────────────────
alter table public.inbox_events drop constraint if exists inbox_events_kind_check;
alter table public.inbox_events add constraint inbox_events_kind_check check (kind in (
  'assigned', 'unassigned', 'transferred', 'tagged', 'untagged', 'archived', 'unarchived',
  'closed', 'note_added', 'note_edited', 'note_deleted', 'forwarded_as_note',
  'message_edited', 'message_deleted',
  'scheduled', 'schedule_cancelled', 'schedule_sent', 'schedule_failed',
  'handoff_to_human', 'handoff_to_ai',
  'conversation_created', 'message_received', 'agent_replied', 'human_reply',
  'ticket_failed'));

-- ── F1 الأعلام ─────────────────────────────────────────────────────────────
-- STABLE + SECURITY DEFINER: بتتنده من سياسات RLS بدور العميل، ومابتكشفش غير
-- قرار واحد (مفعّل لك ولا لأ)، مش محتوى الإعداد.
create or replace function public.conv_channel_enabled(p_channel text, p_user uuid)
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v jsonb;
begin
  if p_channel is null then return false; end if;
  select s.value into v from public.sie_settings s where s.key = 'core_ingest_' || p_channel;
  if v is null then return false; end if;
  if jsonb_typeof(v) = 'boolean' then return v::text = 'true'; end if;
  if jsonb_typeof(v) <> 'object' then return false; end if;
  if coalesce((v->>'enabled')::boolean, false) is not true then return false; end if;
  if p_user is not null and jsonb_typeof(v->'users') = 'array'
     and (v->'users') ? p_user::text then
    return true;
  end if;
  return p_user is not null
     and coalesce((v->>'percent')::int, 0) > 0
     and ((hashtextextended(p_user::text, 67) & 9223372036854775807) % 100) < least((v->>'percent')::int, 100);
end;
$$;
revoke all on function public.conv_channel_enabled(text, uuid) from public, anon, authenticated;
grant execute on function public.conv_channel_enabled(text, uuid) to authenticated;

-- ── G1 بوابة الحساب لمستخدم بعينه (نفس account_is_active() بالمعامل) ────────
create or replace function public.conv_account_active(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select p_user is not null
     and not public.is_banned(p_user)
     and coalesce(public.gate_is_exempt_account(p_user)
                  or (public.account_is_whitelisted(p_user) and public.account_verification_ok(p_user)), false);
$$;
revoke all on function public.conv_account_active(uuid) from public, anon, authenticated;

-- ── D4 الكاتب الواحد ───────────────────────────────────────────────────────
-- هل العميل يقدر يكتب في الجلسة دي مباشرة؟ جلسة قديمة (channel IS NULL) أو
-- قناة علمها مقفول لصاحبها ⇒ أيوه (السلوك القديم). غير كده ⇒ عبر Core بس.
create or replace function public.conv_client_may_write(p_session uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce((
    select s.channel is null or not public.conv_channel_enabled(s.channel, s.user_id)
      from public.chat_sessions s where s.id = p_session), true);
$$;
revoke all on function public.conv_client_may_write(uuid) from public, anon, authenticated;
grant execute on function public.conv_client_may_write(uuid) to authenticated;

drop policy if exists core_single_writer on public.chat_messages;
create policy core_single_writer on public.chat_messages
  as restrictive for insert to authenticated
  with check (public.has_elevated_authority() or public.conv_client_may_write(session_id));

drop policy if exists core_single_writer on public.chat_sessions;
create policy core_single_writer on public.chat_sessions
  as restrictive for insert to authenticated
  with check (public.has_elevated_authority() or not public.conv_channel_enabled('website', auth.uid()));

-- تعديل العميل لجلسة Core: الإقفال بس (active → closed). مفيش رجوع لجلسة
-- مقفولة (كانت بتفتح محادثة نشطة تانية جنب واحدة موجودة)، ولا تغيير هوية أو أصل.
-- الجلسات القديمة (channel IS NULL) ماتتلمسش عن قصد: التثبيت لازم مايغيّرش أي
-- سلوك قائم والأعلام مقفولة — والجلسة بتبقى Core بس لما conv_ingest_message يتبنّاها.
-- الطاقم المرتفع والدوال المالكة والخادم بيعدّوا (نفس فكرة 062 و 064).
create or replace function public.guard_client_session_update()
returns trigger
language plpgsql
security invoker
set search_path to 'public'
as $$
begin
  if current_user not in ('anon', 'authenticated') or old.channel is null
     or public.has_elevated_authority() then
    return new;
  end if;
  if new.user_id is distinct from old.user_id
     or new.guest_id is distinct from old.guest_id
     or new.created_at is distinct from old.created_at then
    raise exception 'الجلسة دي مايتغيرش أصلها من المتصفح'
      using errcode = '42501', hint = 'session identity is server-owned';
  end if;
  if new.status is distinct from old.status
     and not (old.status = 'active' and new.status = 'closed') then
    raise exception 'المحادثة المقفولة مابتترجعش من المتصفح'
      using errcode = '42501', hint = 'only active -> closed is allowed to the client';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_client_session_update() from public, anon, authenticated;

drop trigger if exists trg_guard_client_session_update on public.chat_sessions;
create trigger trg_guard_client_session_update
  before update on public.chat_sessions
  for each row execute function public.guard_client_session_update();

-- كاتب الخادم الواحد: لما علم القناة مفتوح لصاحب المحادثة، رسالة العميل ورد
-- البوت بييجوا من conv_ingest_message / conv_commit_turn بس (بيفتحوا
-- conv.writer لحظة الإدراج ويقفلوه بعده). رد الموظف (is_admin_reply) بيعدّي:
-- الصندوق هو الكاتب البشري، وتسليمه بيعدّي على _handoff_set.
create or replace function public.guard_core_single_writer()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_channel text;
  v_user uuid;
begin
  if coalesce(new.is_admin_reply, false) or new.session_id is null
     or coalesce(current_setting('conv.writer', true), '') = 'on' then
    return new;
  end if;
  select s.channel, s.user_id into v_channel, v_user from public.chat_sessions s where s.id = new.session_id;
  if v_channel is not null and public.conv_channel_enabled(v_channel, v_user) then
    raise exception 'المحادثة دي على Conversation Core — الكتابة عبر conv_* بس'
      using errcode = '55000', hint = 'core_owns_session';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_core_single_writer() from public, anon, authenticated;

drop trigger if exists trg_guard_core_single_writer on public.chat_messages;
create trigger trg_guard_core_single_writer
  before insert on public.chat_messages
  for each row execute function public.guard_core_single_writer();

-- ── D2 مساعد: نص المرفق التلقائي (نفس autoLabelFor في chat-attachments.js) ──
create or replace function public._conv_attachment_label(p_attachment jsonb)
returns text
language sql
immutable
set search_path to 'public'
as $$
  select case p_attachment->>'kind'
           when 'image' then 'صورة مرفقة'
           when 'audio' then 'رسالة صوتية'
           else 'ملف مرفق: ' || coalesce(nullif(btrim(p_attachment->>'name'), ''), 'مرفق')
         end;
$$;
revoke all on function public._conv_attachment_label(jsonb) from public, anon, authenticated;

-- ── conv_ingest_message (D2 + D3 + G1 + N1) ────────────────────────────────
-- توقيع جديد (p_attachment في الآخر). القديم بيتشال: لو فضل، أي نداء بـ 9
-- معاملات يبقى ملتبس بين النسختين.
drop function if exists public.conv_ingest_message(text, uuid, text, text, text, jsonb, jsonb, uuid, interval);

create or replace function public.conv_ingest_message(
  p_channel text,
  p_user_id uuid,
  p_external_thread_id text,
  p_external_id text,
  p_text text,
  p_parts jsonb default '[]'::jsonb,
  p_metadata jsonb default '{}'::jsonb,
  p_channel_identity_id uuid default null,
  p_idle_after interval default null,
  p_attachment jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_thread text := coalesce(p_external_thread_id, '');
  v_ext text := nullif(btrim(coalesce(p_external_id, '')), '');
  v_text text := btrim(coalesce(p_text, ''));
  v_kind text := p_attachment->>'kind';
  v_s public.chat_sessions;
  v_dup record;
  v_msg record;
  v_how text;
begin
  if p_channel is null or p_channel not in ('website', 'telegram') then
    raise exception 'قناة غير معروفة: %', p_channel using errcode = '22023';
  end if;
  if p_user_id is null then
    raise exception 'المحادثة لازم تكون لحساب' using errcode = '22023';
  end if;
  if v_ext is null then
    raise exception 'external_id مطلوب لمنع التكرار' using errcode = '22023';
  end if;
  -- N1: 'turn:' لردود الوكيل بس.
  if v_ext like 'turn:%' then
    raise exception 'external_id محجوز لردود الوكيل' using errcode = '22023';
  end if;
  if p_channel = 'website' and v_thread <> '' then
    raise exception 'محادثة الموقع واحدة لكل حساب (external_thread_id فاضي)' using errcode = '22023';
  end if;
  if p_channel <> 'website' and v_thread = '' then
    raise exception 'external_thread_id مطلوب للقناة %', p_channel using errcode = '22023';
  end if;
  if p_parts is not null and jsonb_typeof(p_parts) <> 'array' then
    raise exception 'parts لازم تكون مصفوفة' using errcode = '22023';
  end if;
  if p_metadata is not null and jsonb_typeof(p_metadata) <> 'object' then
    raise exception 'metadata لازم تكون كائن' using errcode = '22023';
  end if;
  -- D2: الشكل يتفحص قبل أي كتابة (القيد 054 والحارس بيكمّلوا عند الإدراج).
  if p_attachment is not null then
    if jsonb_typeof(p_attachment) <> 'object' or v_kind is null
       or v_kind not in ('image', 'audio', 'file')
       or jsonb_typeof(p_attachment->'path') is distinct from 'string' then
      raise exception 'مرفق غير مدعوم (المسموح: image / audio / file بمسار)' using errcode = '22023';
    end if;
  end if;
  if v_text = '' and p_attachment is null then
    raise exception 'الرسالة فاضية' using errcode = '22023';
  end if;
  -- G1: نفس بوابة الحساب اللي على المتصفح.
  if not public.conv_account_active(p_user_id) then
    raise exception 'الحساب غير مفعّل للمحادثة' using errcode = '42501', hint = 'account_inactive';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    format('conv:%s:%s:%s', p_user_id, p_channel, v_thread), 0));

  select m.id, m.seq, m.session_id into v_dup
    from public.chat_messages m
    join public.chat_sessions s on s.id = m.session_id
   where s.user_id = p_user_id and s.channel = p_channel and s.external_thread_id = v_thread
     and m.external_id = v_ext
   limit 1;
  if found then
    select * into v_s from public.chat_sessions where id = v_dup.session_id;
    return jsonb_build_object(
      'created', false, 'duplicate', true,
      'conversation', public._conv_json(v_s),
      'message', jsonb_build_object('id', v_dup.id, 'seq', v_dup.seq),
      'owner', case when coalesce(v_s.is_manual_mode, false) then 'human' else 'agent' end,
      'stateVersion', v_s.state_version);
  end if;

  perform set_config('conv.source', 'core:' || p_channel, true);

  select * into v_s from public.chat_sessions
   where user_id = p_user_id and channel = p_channel and external_thread_id = v_thread
     and status = 'active'
   for no key update;
  if found then
    v_how := 'existing';
    -- D3: الخمول بيقفل محادثة البوت بس. محادثة ماسكها إنسان تفضل زي ما هي.
    if p_idle_after is not null and v_s.updated_at < now() - p_idle_after
       and not coalesce(v_s.is_manual_mode, false) then
      update public.chat_sessions set status = 'closed' where id = v_s.id;
      v_s := null;
    end if;
  end if;

  if v_s.id is null then
    -- D3: جلسة قديمة ماسكها إنسان بتتبنّى حتى لو خاملة، وبتتقدّم على أي جلسة
    -- قديمة تانية.
    select * into v_s from public.chat_sessions
     where user_id = p_user_id and channel is null and status = 'active'
       and (case when p_channel = 'website' then guest_id is null
                 else guest_id = 'channel:' || p_channel || ':' || v_thread end)
       and (p_idle_after is null or updated_at >= now() - p_idle_after or coalesce(is_manual_mode, false))
     order by coalesce(is_manual_mode, false) desc, created_at desc, id desc
     limit 1
     for no key update;
    if found then
      update public.chat_sessions
         set channel = p_channel,
             external_thread_id = v_thread,
             channel_identity_id = coalesce(channel_identity_id, p_channel_identity_id)
       where id = v_s.id
       returning * into v_s;
      v_how := 'adopted';
    end if;
  end if;

  if v_s.id is null then
    insert into public.chat_sessions (user_id, status, guest_id, channel, external_thread_id, channel_identity_id)
    values (p_user_id, 'active',
            case when p_channel = 'website' then null else 'channel:' || p_channel || ':' || v_thread end,
            p_channel, v_thread, p_channel_identity_id)
    returning * into v_s;
    v_how := 'created';
  end if;

  perform set_config('conv.writer', 'on', true);
  insert into public.chat_messages (session_id, sender_id, message_text, is_bot_reply, is_admin_reply,
                                    channel, external_id, metadata, attachment, image_url, audio_url)
  values (v_s.id, p_user_id,
          case when v_text = '' then public._conv_attachment_label(p_attachment) else v_text end,
          false, false, p_channel, v_ext,
          jsonb_build_object('parts', coalesce(p_parts, '[]'::jsonb)) || coalesce(p_metadata, '{}'::jsonb),
          p_attachment,
          case when v_kind = 'image' then p_attachment->>'path' end,
          case when v_kind = 'audio' then p_attachment->>'path' end)
  returning id, seq, created_at into v_msg;
  perform set_config('conv.writer', '', true);

  update public.chat_sessions
     set state_version = state_version + 1, updated_at = now()
   where id = v_s.id
   returning * into v_s;

  return jsonb_build_object(
    'created', true, 'duplicate', false,
    'conversation', public._conv_json(v_s) || jsonb_build_object('resolution', v_how),
    'message', jsonb_build_object('id', v_msg.id, 'seq', v_msg.seq, 'createdAt', v_msg.created_at),
    'owner', case when coalesce(v_s.is_manual_mode, false) then 'human' else 'agent' end,
    'stateVersion', v_s.state_version);
end;
$$;
revoke all on function public.conv_ingest_message(text, uuid, text, text, text, jsonb, jsonb, uuid, interval, jsonb)
  from public, anon, authenticated;

-- ── conv_commit_turn (D1 + L1 + N1) — نفس التوقيع ──────────────────────────
-- p_ticket: { category, description, title?, type?: problem|inquiry,
--             priority?: low|medium|high, confirmation?: '... {ticket_number} ...' }
create or replace function public.conv_commit_turn(
  p_conversation_id uuid,
  p_expected_version integer,
  p_turn_key text,
  p_reply_text text,
  p_reply_parts jsonb default '[]'::jsonb,
  p_state jsonb default null,
  p_agent_id text default null,
  p_delivery_required boolean default false,
  p_ticket jsonb default null,
  p_handoff_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_key text := nullif(btrim(coalesce(p_turn_key, '')), '');
  v_owner uuid;
  v_s public.chat_sessions;
  v_prev record;
  v_msg record;
  v_ticket bigint;
  v_ticket_error text;
  v_ticket_sqlstate text;
  v_notice text;
  v_text text;
  v_hint text;
  v_errmsg text;
  v_handoff_reason text := nullif(btrim(coalesce(p_handoff_reason, '')), '');
  v_handoff boolean := false;
  v_reject text;
begin
  if p_conversation_id is null or p_expected_version is null then
    raise exception 'المحادثة والنسخة المتوقعة مطلوبين' using errcode = '22023';
  end if;
  if v_key is null then
    raise exception 'turn_key مطلوب لمنع التكرار' using errcode = '22023';
  end if;
  if p_reply_text is null or btrim(p_reply_text) = '' then
    raise exception 'الرد فاضي' using errcode = '22023';
  end if;
  if length(p_reply_text) > 4000 then
    raise exception 'الرد أطول من 4000 حرف' using errcode = '22023';
  end if;
  if p_state is not null and jsonb_typeof(p_state) <> 'object' then
    raise exception 'الحالة لازم تكون كائن' using errcode = '22023';
  end if;
  if p_reply_parts is not null and jsonb_typeof(p_reply_parts) <> 'array' then
    raise exception 'parts لازم تكون مصفوفة' using errcode = '22023';
  end if;
  if p_ticket is not null and jsonb_typeof(p_ticket) <> 'object' then
    raise exception 'التذكرة لازم تكون كائن' using errcode = '22023';
  end if;

  -- L1: قفل الحصة قبل قفل الجلسة — نفس ترتيب المسار القديم ومحفّز 065.
  -- (أقفال المعاملة الاستشارية reentrant، فالمحفّز بياخده تاني من غير انتظار.)
  if p_ticket is not null then
    select s.user_id into v_owner from public.chat_sessions s where s.id = p_conversation_id;
    if v_owner is not null then
      perform pg_advisory_xact_lock(hashtextextended(
        'ticket_quota:' || public.ticket_account_owner(v_owner)::text, 0));
    end if;
  end if;

  -- التذكرة ممكن تفرض تسليم (D1)، فقفل FOR UPDATE من الأول بدل ترقية القفل.
  if v_handoff_reason is not null or p_ticket is not null then
    select * into v_s from public.chat_sessions where id = p_conversation_id for update;
  else
    select * into v_s from public.chat_sessions where id = p_conversation_id for no key update;
  end if;
  if not found then
    raise exception 'المحادثة غير موجودة' using errcode = 'P0002';
  end if;
  if v_s.channel is null then
    raise exception 'المحادثة دي مش على Conversation Core' using errcode = '22023';
  end if;

  -- N1: رد وكيل بس، مش أي صف بنفس المفتاح.
  select m.id, m.seq, m.delivery_state, m.metadata into v_prev
    from public.chat_messages m
   where m.session_id = v_s.id and m.external_id = 'turn:' || v_key and m.is_bot_reply;
  if found then
    return jsonb_build_object('committed', true, 'duplicate', true,
      'messageId', v_prev.id, 'seq', v_prev.seq, 'deliveryState', v_prev.delivery_state,
      'ticketNumber', v_prev.metadata->'ticketNumber', 'ticketError', v_prev.metadata->>'ticketError',
      'stateVersion', v_s.state_version);
  end if;

  v_reject := case when v_s.status = 'closed' then 'closed'
                   when coalesce(v_s.is_manual_mode, false) then 'human_owner'
                   when v_s.state_version <> p_expected_version then 'version_conflict' end;
  if v_reject is not null then
    return jsonb_build_object('committed', false, 'reason', v_reject,
      'owner', case when coalesce(v_s.is_manual_mode, false) then 'human' else 'agent' end,
      'stateVersion', v_s.state_version);
  end if;

  perform set_config('conv.source', 'core:agent', true);
  perform set_config('conv.agent_id', coalesce(p_agent_id, ''), true);

  v_text := p_reply_text;

  -- D1: التذكرة جوه savepoint. فشلها مايلغيش الرد.
  if p_ticket is not null then
    begin
      insert into public.tickets (user_id, title, description, category, status, ticket_type, priority)
      values (v_s.user_id,
              left(coalesce(nullif(btrim(p_ticket->>'title'), ''),
                            coalesce(nullif(p_ticket->>'category', ''), 'دعم عام') || ' — عبر محرك الدعم الذكي'), 200),
              coalesce(p_ticket->>'description', ''),
              nullif(p_ticket->>'category', ''),
              'open',
              coalesce(nullif(p_ticket->>'type', ''), 'problem'),
              coalesce(nullif(p_ticket->>'priority', ''), 'medium'))
      returning tickets.ticket_number into v_ticket;
    exception when others then
      -- فشل عابر (تعارض/قفل/إلغاء) ⇒ الدور كله يترجع ويتعاد، مش يتسجّل ناقص.
      if sqlstate in ('40001', '40P01', '55P03', '57014') then
        raise;
      end if;
      get stacked diagnostics v_hint = pg_exception_hint, v_errmsg = message_text;
      v_ticket_sqlstate := sqlstate;
      if sqlstate = 'P0001' and v_hint in ('ticket_quota_exceeded', 'billing_quota_exceeded') then
        v_ticket_error := v_hint;
        v_notice := v_errmsg;  -- نص 065 نفسه: مكتوب للعميل
      else
        v_ticket_error := 'ticket_failed';
        v_notice := 'ماقدرناش نفتح التذكرة دلوقتي، فحوّلنا المحادثة لفريق الدعم يتابعها بنفسه.';
        v_handoff_reason := coalesce(v_handoff_reason, 'ticket_failed');
      end if;
      v_ticket := null;
    end;

    if v_ticket is not null and nullif(btrim(p_ticket->>'confirmation'), '') is not null then
      v_text := v_text || E'\n' || replace(p_ticket->>'confirmation', '{ticket_number}', v_ticket::text);
    elsif v_notice is not null then
      v_text := v_text || E'\n' || v_notice;
    end if;
  end if;

  perform set_config('conv.writer', 'on', true);
  insert into public.chat_messages (session_id, sender_id, message_text, is_bot_reply, is_admin_reply,
                                    channel, external_id, metadata, delivery_state, delivery_updated_at)
  values (v_s.id, null, left(v_text, 4500), true, false, v_s.channel, 'turn:' || v_key,
          jsonb_strip_nulls(jsonb_build_object('parts', coalesce(p_reply_parts, '[]'::jsonb),
                                               'agentId', p_agent_id, 'turnKey', v_key,
                                               'ticketNumber', v_ticket, 'ticketError', v_ticket_error)),
          case when p_delivery_required then 'pending' end,
          case when p_delivery_required then now() end)
  returning id, seq, created_at into v_msg;
  perform set_config('conv.writer', '', true);

  if v_ticket_error is not null then
    insert into public.inbox_events (session_id, actor_id, kind, payload)
    values (v_s.id, null, 'ticket_failed', jsonb_build_object(
      'reason', v_ticket_error, 'sqlstate', v_ticket_sqlstate, 'turnKey', v_key,
      'agentId', p_agent_id, 'messageId', v_msg.id));
  end if;

  update public.chat_sessions
     set bot_state = coalesce(p_state, bot_state),
         state_version = state_version + 1,
         updated_at = now()
   where id = v_s.id;

  if v_handoff_reason is not null then
    v_handoff := public._handoff_set(v_s.id, true, v_handoff_reason, 'agent', null);
  end if;

  perform set_config('conv.agent_id', '', true);
  select * into v_s from public.chat_sessions where id = v_s.id;
  return jsonb_build_object('committed', true, 'duplicate', false,
    'messageId', v_msg.id, 'seq', v_msg.seq, 'createdAt', v_msg.created_at,
    'deliveryState', case when p_delivery_required then 'pending' end,
    'ticketNumber', v_ticket, 'ticketError', v_ticket_error, 'handoff', v_handoff,
    'owner', case when coalesce(v_s.is_manual_mode, false) then 'human' else 'agent' end,
    'stateVersion', v_s.state_version);
end;
$$;
revoke all on function public.conv_commit_turn(uuid, integer, text, text, jsonb, jsonb, text, boolean, jsonb, text)
  from public, anon, authenticated;

-- ── R1 conv_claim_delivery بحد أقصى للمحاولات ───────────────────────────────
drop function if exists public.conv_claim_delivery(uuid, interval);

create or replace function public.conv_claim_delivery(
  p_message_id uuid,
  p_lease interval default interval '2 minutes',
  p_max_attempts integer default 5)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v record;
  v_max int := greatest(coalesce(p_max_attempts, 5), 1);
  v_lease interval := coalesce(p_lease, interval '2 minutes');
begin
  update public.chat_messages
     set delivery_state = 'sending',
         delivery_attempts = delivery_attempts + 1,
         delivery_updated_at = now(),
         delivery_error = null
   where id = p_message_id
     and delivery_attempts < v_max
     and (delivery_state in ('pending', 'failed')
          or (delivery_state = 'sending' and delivery_updated_at < now() - v_lease))
  returning id, session_id, channel, delivery_attempts, message_text, metadata into v;
  if found then
    return jsonb_build_object('claimed', true, 'messageId', v.id, 'conversationId', v.session_id,
      'channel', v.channel, 'attempt', v.delivery_attempts, 'text', v.message_text, 'metadata', v.metadata);
  end if;

  -- مُرسِل وقع في آخر محاولة مسموحة ⇒ failed نهائيًا (dead letter).
  update public.chat_messages
     set delivery_state = 'failed',
         delivery_updated_at = now(),
         delivery_error = 'max_attempts: lease expired on the last allowed attempt'
   where id = p_message_id
     and delivery_attempts >= v_max
     and delivery_state = 'sending' and delivery_updated_at < now() - v_lease;

  select id, delivery_state, delivery_attempts, provider_message_id into v
    from public.chat_messages where id = p_message_id;
  if not found then
    raise exception 'الرسالة غير موجودة' using errcode = 'P0002';
  end if;
  return jsonb_build_object('claimed', false, 'deliveryState', v.delivery_state,
    'attempt', v.delivery_attempts, 'providerMessageId', v.provider_message_id,
    'exhausted', v.delivery_state in ('pending', 'failed', 'sending') and v.delivery_attempts >= v_max);
end;
$$;
revoke all on function public.conv_claim_delivery(uuid, interval, integer) from public, anon, authenticated;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function
      public.conv_ingest_message(text, uuid, text, text, text, jsonb, jsonb, uuid, interval, jsonb),
      public.conv_commit_turn(uuid, integer, text, text, jsonb, jsonb, text, boolean, jsonb, text),
      public.conv_claim_delivery(uuid, interval, integer),
      public.conv_channel_enabled(text, uuid),
      public.conv_account_active(uuid)
      to service_role;
  end if;
end $$;

-- ============================================================================
-- التحقق
-- ============================================================================
do $$
declare
  f text;
begin
  if to_regprocedure('public.conv_ingest_message(text, uuid, text, text, text, jsonb, jsonb, uuid, interval)') is not null then
    raise exception '067: نسخة ingest القديمة لسه موجودة (نداء ملتبس)';
  end if;
  if to_regprocedure('public.conv_claim_delivery(uuid, interval)') is not null then
    raise exception '067: نسخة claim القديمة لسه موجودة (نداء ملتبس)';
  end if;
  foreach f in array array[
    'public.conv_ingest_message(text, uuid, text, text, text, jsonb, jsonb, uuid, interval, jsonb)',
    'public.conv_commit_turn(uuid, integer, text, text, jsonb, jsonb, text, boolean, jsonb, text)',
    'public.conv_claim_delivery(uuid, interval, integer)',
    'public.conv_account_active(uuid)'] loop
    if has_function_privilege('authenticated', f, 'EXECUTE') or has_function_privilege('anon', f, 'EXECUTE') then
      raise exception '067: % متاحة لعميل', f;
    end if;
  end loop;
  if (select count(*) from pg_policy where polname = 'core_single_writer'
        and polrelid in ('public.chat_messages'::regclass, 'public.chat_sessions'::regclass)
        and not polpermissive) <> 2 then
    raise exception '067: سياسات الكاتب الواحد ناقصة أو مش RESTRICTIVE';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.chat_messages'::regclass
                  and tgname = 'trg_guard_core_single_writer' and not tgisinternal) then
    raise exception '067: حارس كاتب الخادم الواحد ناقص';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.chat_sessions'::regclass
                  and tgname = 'trg_guard_client_session_update' and not tgisinternal) then
    raise exception '067: حارس تعديل الجلسة ناقص';
  end if;
  raise notice '067: فجوات Core اتقفلت — الأعلام زي ما هي';
end $$;
