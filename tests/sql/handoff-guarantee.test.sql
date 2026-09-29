-- ============================================================================
-- اختبار تنفيذي لـ 059: ضمان التسليم للإنسان (Phase 2).
--
-- يثبّت، كل خاصية تفشل إن انكسرت:
--   ① البوت يرد من كل المسارات والمحادثة مع البوت
--   ② بعد رد الدعم: persist_bot_turn و create_ticket وإدراج المتصفح ومسار
--      تيليجرام (service_role، حتى بـ BYPASSRLS) كلهم مرفوضين ولا أثر
--   ③ العميل والأدمن و service_role مايقدروش يغيّروا is_manual_mode مباشرة
--   ④ الرجوع للبوت: موظف له وصول بس، idempotent، والبوت يرد بعده
--   ⑤ السجل: حدث واحد لكل تغيير بالفاعل والسبب والمصدر
--   ⑥ تصعيد SIE يسلّم فعلًا (صاحب الجلسة / service_role)
--   ⑦ السباق بجلسات حقيقية متوازية (dblink): تسليم شغال، قراءة قديمة، البوت
--      الأول، وردّين بوت متوازيين
--   ⑧ إعادة تشغيل الترحيل  ⑨ التراجع يرجّع 058 حرفيًا
--
-- التجهيز (السطور 18–202 من inbox-scheduled.test.sql، منقولة آليًا) =
-- جداول وسياسات الإنتاج + 055–058.
-- ============================================================================
\set ON_ERROR_STOP on
\pset tuples_only on

CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true),'')::uuid; $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
END $$;
GRANT USAGE ON SCHEMA auth, public TO authenticated, anon;

-- ── الجداول بشكل الإنتاج ─────────────────────────────────────────────────
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY, email text, full_name text, role text DEFAULT 'user',
  phone text, ban_status text, created_at timestamptz DEFAULT now());
CREATE TABLE public.platform_authority (
  user_id uuid PRIMARY KEY, level text NOT NULL, granted_at timestamptz DEFAULT now(), note text);
CREATE TABLE public.chat_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, status text DEFAULT 'active',
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), guest_id text,
  is_manual_mode boolean DEFAULT false, bot_state jsonb NOT NULL DEFAULT '{}'::jsonb);
CREATE TABLE public.chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), session_id uuid REFERENCES public.chat_sessions(id),
  sender_id uuid, message_text text NOT NULL, is_bot_reply boolean DEFAULT false,
  created_at timestamptz DEFAULT now(), is_admin_reply boolean DEFAULT false,
  image_url text, audio_url text, attachment jsonb);

-- 054_chat_composer_attachments (مطبَّق على الإنتاج قبل 055): حارس المرفقات
-- على chat_messages منسوخ حرفيًا، حتى يمرّ رد الدعم عبر inbox_send_reply من
-- نفس المحفّز الذي يمرّ منه في الإنتاج.
CREATE SCHEMA IF NOT EXISTS storage;
CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text);
-- storage.foldername كما في Supabase: أجزاء المسار ما عدا اسم الملف.
CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1]; $$;
GRANT USAGE ON SCHEMA storage TO authenticated;
GRANT SELECT ON storage.objects TO authenticated;
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
CREATE OR REPLACE FUNCTION public.chat_attachment_path_ok(p_path text, p_sender uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT p_sender IS NOT NULL
     AND p_path !~ '^[a-zA-Z][a-zA-Z0-9+.-]*:'
     AND p_path !~ '(^|/)\.\.?(/|$)'
     AND left(p_path, 1) <> '/'
     AND split_part(p_path, '/', 1) = p_sender::text
     AND EXISTS (SELECT 1 FROM storage.objects o
                  WHERE o.bucket_id = 'chat-attachments' AND o.name = p_path); $$;
CREATE OR REPLACE FUNCTION public.guard_chat_message_attachment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_path text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.image_url IS NOT DISTINCT FROM OLD.image_url
     AND NEW.audio_url IS NOT DISTINCT FROM OLD.audio_url
     AND NEW.attachment IS NOT DISTINCT FROM OLD.attachment THEN
    RETURN NEW;
  END IF;
  FOREACH v_path IN ARRAY ARRAY[NEW.image_url, NEW.audio_url, NEW.attachment->>'path'] LOOP
    IF v_path IS NOT NULL AND NOT public.chat_attachment_path_ok(v_path, NEW.sender_id) THEN
      RAISE EXCEPTION 'مرفق غير صالح: يجب أن يكون ملفًا مرفوعًا في مجلد المرسل نفسه' USING ERRCODE = '42501';
    END IF;
  END LOOP;
  RETURN NEW;
END; $$;
CREATE TRIGGER trg_guard_chat_message_attachment
  BEFORE INSERT OR UPDATE ON public.chat_messages
  FOR EACH ROW EXECUTE FUNCTION public.guard_chat_message_attachment();
CREATE TABLE public.ticket_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
  color text NOT NULL DEFAULT '#4DA3FF', created_by uuid, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, title text NOT NULL, message text NOT NULL,
  type text DEFAULT 'info', is_read boolean DEFAULT false, link text, created_at timestamptz DEFAULT now());
DROP PUBLICATION IF EXISTS supabase_realtime;
CREATE PUBLICATION supabase_realtime;
ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_sessions, public.chat_messages;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;

-- ── بدائل يتحكم فيها الاختبار ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.owner_capability(p_capability text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select coalesce(current_setting('test.owner_context', true), '') = 'on'
     and exists (select 1 from public.platform_authority a where a.user_id = auth.uid() and a.level = 'owner'); $$;
CREATE OR REPLACE FUNCTION public.preview_mode() RETURNS boolean
LANGUAGE sql STABLE AS $$ select coalesce(current_setting('test.preview', true), '') = 'on'; $$;
CREATE OR REPLACE FUNCTION public.is_banned(p_user_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select exists (select 1 from public.profiles p where p.id = p_user_id and p.ban_status = 'permanent'); $$;
CREATE OR REPLACE FUNCTION public.account_is_active() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select auth.uid() is null or not public.is_banned(auth.uid()); $$;

-- ── منسوخة من الإنتاج حرفيًا ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.has_elevated_authority() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select exists (
           select 1
             from public.platform_authority a
             join public.profiles p on p.id = a.user_id
            where a.user_id = auth.uid()
              and a.level   = 'elevated_admin'
              and p.role    = 'admin'
         )
      or public.owner_capability('owner_only'); $$;
CREATE OR REPLACE FUNCTION public.is_platform_staff() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select exists (
           select 1 from public.profiles p
            where p.id = auth.uid() and p.role in ('admin', 'support')
         )
      or public.owner_capability('staff'); $$;
CREATE OR REPLACE FUNCTION public.guard_preview_read_only() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
begin
  if public.preview_mode() then
    raise exception 'معاينة عضو الشركة للقراءة فقط — اخرج من السياق للكتابة'
      using errcode = '42501';
  end if;
  return null;
end; $$;

-- ── سياسات الشات القائمة في الإنتاج ──────────────────────────────────────
ALTER TABLE public.chat_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY chat_sessions_select_own_or_admin ON public.chat_sessions
  FOR SELECT USING (user_id = auth.uid() OR public.has_elevated_authority());
CREATE POLICY chat_sessions_insert_own ON public.chat_sessions
  FOR INSERT WITH CHECK (user_id = auth.uid() OR public.has_elevated_authority());
CREATE POLICY chat_sessions_update_own_or_admin ON public.chat_sessions
  FOR UPDATE USING (user_id = auth.uid() OR public.has_elevated_authority());
CREATE POLICY chat_messages_select_own_or_admin ON public.chat_messages
  FOR SELECT USING (public.has_elevated_authority() OR sender_id = auth.uid()
    OR session_id IN (SELECT s.id FROM public.chat_sessions s WHERE s.user_id = auth.uid()));
CREATE POLICY chat_messages_insert_own_or_admin ON public.chat_messages
  FOR INSERT WITH CHECK (public.has_elevated_authority() OR (
    session_id IN (SELECT s.id FROM public.chat_sessions s WHERE s.user_id = auth.uid())
    AND (sender_id = auth.uid() OR sender_id IS NULL)));
CREATE POLICY gate_account_active ON public.chat_sessions AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.account_is_active()) WITH CHECK (public.account_is_active());
CREATE POLICY gate_account_active ON public.chat_messages AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.account_is_active()) WITH CHECK (public.account_is_active());

-- ── الفاعلون والبيانات ────────────────────────────────────────────────────
--   O  مالك المنصة        E  أدمن مرتفع          A1/A2 أدمن عادي
--   S1 دعم                B  أدمن محظور          C1/C2 عملاء
INSERT INTO public.profiles (id, email, full_name, role, ban_status) VALUES
  ('00000000-0000-4000-8000-00000000000f', 'owner@t', 'المالك', 'platform_owner', null),
  ('00000000-0000-4000-8000-0000000000e1', 'e@t', 'أدمن مرتفع', 'admin', null),
  ('00000000-0000-4000-8000-0000000000a1', 'a1@t', 'أدمن واحد', 'admin', null),
  ('00000000-0000-4000-8000-0000000000a2', 'a2@t', 'أدمن اتنين', 'admin', null),
  ('00000000-0000-4000-8000-0000000000b1', 'b@t', 'أدمن محظور', 'admin', 'permanent'),
  ('00000000-0000-4000-8000-00000000005a', 's1@t', 'دعم واحد', 'support', null),
  ('00000000-0000-4000-8000-0000000000c1', 'c1@t', 'عميل واحد', 'user', null),
  ('00000000-0000-4000-8000-0000000000c2', 'c2@t', 'عميل اتنين', 'user', null);
INSERT INTO public.platform_authority (user_id, level) VALUES
  ('00000000-0000-4000-8000-00000000000f', 'owner'),
  ('00000000-0000-4000-8000-0000000000e1', 'elevated_admin');
INSERT INTO public.chat_sessions (id, user_id) VALUES
  ('5e550000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1'),
  ('5e550000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-0000000000c2');
INSERT INTO public.chat_messages (id, session_id, sender_id, message_text, is_bot_reply) VALUES
  ('3e550000-0000-4000-8000-000000000001', '5e550000-0000-4000-8000-000000000001', null, 'أهلاً', true),
  ('3e550000-0000-4000-8000-000000000002', '5e550000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1', 'عندي مشكلة', false),
  ('3e550000-0000-4000-8000-000000000003', '5e550000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-0000000000c2', 'سؤال من عميل تاني', false);
INSERT INTO public.ticket_tags (id, name) VALUES ('7a900000-0000-4000-8000-000000000001', 'فوترة');

-- سياسة القراءة القائمة في الإنتاج على المستودع (منسوخة حرفيًا)
CREATE POLICY chat_attachments_read_own_or_staff ON storage.objects FOR SELECT TO authenticated
  USING ((bucket_id = 'chat-attachments'::text) AND (public.is_platform_staff() OR ((storage.foldername(name))[1] = (auth.uid())::text)));

-- بوابة الحساب (042) لمستخدم بعينه — بدائل: الكل معفى إلا المحظور.
CREATE OR REPLACE FUNCTION public.gate_is_exempt_account(p_user_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$ select p_user_id is not null; $$;
CREATE OR REPLACE FUNCTION public.account_is_whitelisted(p_user_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$ select false; $$;
CREATE OR REPLACE FUNCTION public.account_verification_ok(p_user_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$ select false; $$;

\i migrations/055_inbox_helpdesk_core.sql
\i migrations/056_inbox_attachments_reactions_edits.sql
\i migrations/057_inbox_owner_admin_context.sql
\i migrations/058_inbox_scheduled_replies.sql

-- ── إضافات 059: auth.role، service_role، ومسارات SIE كما في الإنتاج ──────────
CREATE OR REPLACE FUNCTION auth.role() RETURNS text
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.role', true), ''); $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF;
END $$;
GRANT USAGE ON SCHEMA auth, public TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role;

CREATE TABLE public.tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, title text NOT NULL,
  description text NOT NULL, category text, status text, ticket_number bigserial);
GRANT SELECT, INSERT, UPDATE ON public.tickets TO authenticated, service_role;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO authenticated, service_role;

-- persist_bot_turn و create_ticket_with_message_and_session_update: نص الإنتاج
-- حرفيًا (pg_get_functiondef، 2026-09-29) — SECURITY INVOKER كما هما.
CREATE OR REPLACE FUNCTION public.persist_bot_turn(p_session_id uuid, p_turn integer, p_message_text text, p_bot_state jsonb)
 RETURNS jsonb LANGUAGE plpgsql SET search_path TO 'public'
AS $function$
declare
    v_message_id uuid;
    v_message_created_at timestamptz;
    v_actor uuid;
begin
    if auth.uid() is not null then
        v_actor := auth.uid();
    elsif coalesce(auth.role(), '') = 'service_role' then
        select user_id into v_actor from chat_sessions where id = p_session_id;
    end if;
    if v_actor is null then
        raise exception 'not permitted to write to chat_sessions row %', p_session_id;
    end if;
    insert into chat_messages (session_id, sender_id, message_text, is_admin_reply, is_bot_reply)
    values (p_session_id, null, p_message_text, false, true)
    returning id, created_at into v_message_id, v_message_created_at;
    update chat_sessions
    set bot_state = p_bot_state,
        updated_at = now()
    where id = p_session_id
      and user_id = v_actor;
    if not found then
        raise exception 'chat_sessions row % not found or not permitted for this user', p_session_id;
    end if;
    return jsonb_build_object('message_id', v_message_id, 'message_created_at', v_message_created_at,
        'session_id', p_session_id, 'turn', p_turn);
end;
$function$;
CREATE OR REPLACE FUNCTION public.create_ticket_with_message_and_session_update(p_session_id uuid, p_turn integer, p_message_text text, p_bot_state jsonb, p_scenario_id text, p_category text, p_description text)
 RETURNS TABLE(ticket_number bigint) LANGUAGE plpgsql SET search_path TO 'public'
AS $function$
declare
    v_ticket_number bigint;
    v_title text;
    v_actor uuid;
begin
    if auth.uid() is not null then
        v_actor := auth.uid();
    elsif coalesce(auth.role(), '') = 'service_role' then
        select user_id into v_actor from chat_sessions where id = p_session_id;
    end if;
    if v_actor is null then
        raise exception 'not permitted to write to chat_sessions row %', p_session_id;
    end if;
    v_title := left(coalesce(nullif(p_category, ''), 'دعم عام') || ' — عبر محرك الدعم الذكي', 200);
    insert into tickets (user_id, title, description, category, status)
    values (v_actor, v_title, coalesce(p_description, ''), p_category, 'open')
    returning tickets.ticket_number into v_ticket_number;
    insert into chat_messages (session_id, sender_id, message_text, is_admin_reply, is_bot_reply)
    values (p_session_id, null, p_message_text, false, true);
    update chat_sessions
    set bot_state = p_bot_state,
        updated_at = now()
    where id = p_session_id
      and user_id = v_actor;
    if not found then
        raise exception 'chat_sessions row % not found or not permitted for this user', p_session_id;
    end if;
    return query select v_ticket_number;
end;
$function$;
GRANT EXECUTE ON FUNCTION public.persist_bot_turn(uuid, integer, text, jsonb),
  public.create_ticket_with_message_and_session_update(uuid, integer, text, jsonb, text, text, text)
  TO authenticated, anon, service_role;

-- جلسة تالتة لسباق التزامن، وجلسة رابعة «قديمة» ماتتلمسش لحد بعد الترحيل.
INSERT INTO public.chat_sessions (id, user_id) VALUES
  ('5e550000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-0000000000c1'),
  ('5e550000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-0000000000c1'),
  ('5e550000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-0000000000c1');

-- بصمة _inbox_post_reply قبل 059 (للتحقق من التراجع حرفيًا).
CREATE TABLE public._t_fp AS
  SELECT md5(pg_get_functiondef('public._inbox_post_reply(uuid, uuid, text, jsonb)'::regprocedure)) AS before_059;

\i migrations/059_inbox_handoff_guarantee.sql
\i migrations/060_inbox_handoff_close_lock.sql

-- ── مساعدات الاختبار ─────────────────────────────────────────────────────
DROP SCHEMA IF EXISTS t CASCADE;
CREATE SCHEMA t;
CREATE EXTENSION IF NOT EXISTS dblink SCHEMA t;
GRANT USAGE ON SCHEMA t TO authenticated, service_role, anon;
CREATE OR REPLACE FUNCTION t.act(p uuid) RETURNS void LANGUAGE sql AS $$
  select set_config('request.jwt.claim.sub', coalesce(p::text, ''), false),
         set_config('request.jwt.claim.role', case when p is null then '' else 'authenticated' end, false); $$;
CREATE OR REPLACE FUNCTION t.as_service() RETURNS void LANGUAGE sql AS $$
  select set_config('request.jwt.claim.sub', '', false),
         set_config('request.jwt.claim.role', 'service_role', false); $$;
CREATE OR REPLACE FUNCTION t.fails(p_sql text, p_code text) RETURNS boolean LANGUAGE plpgsql AS $$
begin
  execute p_sql;
  return false;
exception when others then
  if p_code is not null and sqlstate <> p_code then
    raise notice '   (رمز غير متوقع % : %)', sqlstate, sqlerrm;
    return false;
  end if;
  return true;
end $$;
CREATE OR REPLACE FUNCTION t.manual(p uuid) RETURNS boolean LANGUAGE sql SECURITY DEFINER AS $$
  select coalesce(is_manual_mode, false) from public.chat_sessions where id = p; $$;
CREATE OR REPLACE FUNCTION t.bot_count(p uuid) RETURNS int LANGUAGE sql SECURITY DEFINER AS $$
  select count(*)::int from public.chat_messages where session_id = p and is_bot_reply; $$;
CREATE OR REPLACE FUNCTION t.handoff_events(p uuid) RETURNS SETOF public.inbox_events LANGUAGE sql SECURITY DEFINER AS $$
  select * from public.inbox_events where session_id = p and kind like 'handoff_%' order by id; $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;
CREATE OR REPLACE FUNCTION t.conn(p_name text) RETURNS text LANGUAGE sql AS $$
  select t.dblink_connect(p_name, format('dbname=%s port=%s host=%s user=postgres', current_database(),
         current_setting('port'), split_part(current_setting('unix_socket_directories'), ',', 1))); $$;

-- ── تجهيز: S1 و S3 و S5 مسندة لـ A1 ────────────────────────────────────────
SET ROLE authenticated;
SELECT t.act('00000000-0000-4000-8000-0000000000e1');
SELECT public.inbox_assign('5e550000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1');
SELECT public.inbox_assign('5e550000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-0000000000a1');
SELECT public.inbox_assign('5e550000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-0000000000a1');

-- ① البوت يرد عادي والمحادثة مع البوت — من كل مسار ───────────────────────────
DO $$
BEGIN
  PERFORM t.act('00000000-0000-4000-8000-0000000000c1');
  PERFORM public.persist_bot_turn('5e550000-0000-4000-8000-000000000001', 1, 'رد SIE', '{}');
  PERFORM public.create_ticket_with_message_and_session_update('5e550000-0000-4000-8000-000000000001', 2,
    'فتحتلك تذكرة', '{}', null, 'billing', 'وصف');
  INSERT INTO public.chat_messages (session_id, sender_id, message_text, is_bot_reply)
    VALUES ('5e550000-0000-4000-8000-000000000001', null, 'ترحيب من المتصفح', true);
  IF t.bot_count('5e550000-0000-4000-8000-000000000001') <> 4 THEN  -- 1 من التجهيز + 3
    RAISE EXCEPTION 'FAIL 1: البوت مارديش في وضع البوت (%)', t.bot_count('5e550000-0000-4000-8000-000000000001');
  END IF;
  RAISE NOTICE 'PASS 1: البوت يرد من كل المسارات والمحادثة مع البوت';
END $$;
RESET ROLE; SET ROLE service_role;
DO $$
BEGIN
  PERFORM t.as_service();
  PERFORM public.persist_bot_turn('5e550000-0000-4000-8000-000000000001', 4, 'رد service_role مباشر', '{}');
  RAISE NOTICE 'PASS 1b: service_role (BYPASSRLS) يكتب رد البوت في وضع البوت';
END $$;
RESET ROLE; SET ROLE authenticated;

-- ② رد الموظف يسلّم المحادثة، وبعدها ولا مسار بوت يكتب ─────────────────────
DO $$
DECLARE before_bots int; before_tickets int;
BEGIN
  PERFORM t.act('00000000-0000-4000-8000-0000000000a1');
  PERFORM public.inbox_send_reply('5e550000-0000-4000-8000-000000000001', 'أنا معاك من الدعم');
  IF NOT t.manual('5e550000-0000-4000-8000-000000000001') THEN RAISE EXCEPTION 'FAIL 2a: الرد ماسلّمش'; END IF;
  before_bots := t.bot_count('5e550000-0000-4000-8000-000000000001');
  SELECT count(*) INTO before_tickets FROM public.tickets;

  PERFORM t.act('00000000-0000-4000-8000-0000000000c1');
  IF NOT t.fails($q$select public.persist_bot_turn('5e550000-0000-4000-8000-000000000001', 5, 'x', '{}')$q$, '55000') THEN
    RAISE EXCEPTION 'FAIL 2b: persist_bot_turn عدّى بعد التسليم';
  END IF;
  IF NOT t.fails($q$select public.create_ticket_with_message_and_session_update('5e550000-0000-4000-8000-000000000001', 6, 'x', '{}', null, 'c', 'd')$q$, '55000') THEN
    RAISE EXCEPTION 'FAIL 2c: create_ticket عدّى بعد التسليم';
  END IF;
  IF NOT t.fails($q$insert into public.chat_messages (session_id, sender_id, message_text, is_bot_reply)
                    values ('5e550000-0000-4000-8000-000000000001', null, 'SIE واجه مشكلة', true)$q$, '55000') THEN
    RAISE EXCEPTION 'FAIL 2d: إدراج بوت من المتصفح عدّى بعد التسليم';
  END IF;
  IF t.bot_count('5e550000-0000-4000-8000-000000000001') <> before_bots
     OR (SELECT count(*) FROM public.tickets) <> before_tickets THEN
    RAISE EXCEPTION 'FAIL 2f: فيه أثر اتكتب رغم الرفض';
  END IF;

  -- رسالة العميل العادية ورد الموظف التاني شغالين
  PERFORM t.act('00000000-0000-4000-8000-0000000000c1');
  INSERT INTO public.chat_messages (session_id, sender_id, message_text)
    VALUES ('5e550000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1', 'لسه موجود');
  PERFORM t.act('00000000-0000-4000-8000-0000000000a1');
  PERFORM public.inbox_send_reply('5e550000-0000-4000-8000-000000000001', 'رد تاني من الدعم');
  RAISE NOTICE 'PASS 2: بعد التسليم كل مسارات البوت مرفوضة (SIE/تذكرة/متصفح/تيليجرام) ولا أثر، والعميل والدعم شغالين';
END $$;
RESET ROLE; SET ROLE service_role;
DO $$
BEGIN
  PERFORM t.as_service();
  IF NOT t.fails($q$select public.persist_bot_turn('5e550000-0000-4000-8000-000000000001', 7, 'x', '{}')$q$, '55000') THEN
    RAISE EXCEPTION 'FAIL 2e: مسار تيليجرام (service_role) عدّى بعد التسليم';
  END IF;
  IF NOT t.fails($q$insert into public.chat_messages (session_id, sender_id, message_text, is_bot_reply)
                    values ('5e550000-0000-4000-8000-000000000001', null, 'x', true)$q$, '55000') THEN
    RAISE EXCEPTION 'FAIL 2g: service_role (BYPASSRLS) كتب رد بوت بعد التسليم';
  END IF;
  IF NOT t.fails($q$update public.chat_messages set is_bot_reply = true
                    where session_id = '5e550000-0000-4000-8000-000000000001' and message_text = 'لسه موجود'$q$, '55000') THEN
    RAISE EXCEPTION 'FAIL 2h: تحويل رسالة موجودة لرد بوت عدّى';
  END IF;
  RAISE NOTICE 'PASS 2b: حتى service_role بـ BYPASSRLS مرفوض، وتحويل رسالة لرد بوت مرفوض';
END $$;
RESET ROLE; SET ROLE authenticated;

-- ③ العميل (وأي كاتب مباشر) مايقدرش يغيّر حالة التسليم ──────────────────────
DO $$
BEGIN
  PERFORM t.act('00000000-0000-4000-8000-0000000000c1');
  IF NOT t.fails($q$update public.chat_sessions set is_manual_mode = false where id = '5e550000-0000-4000-8000-000000000001'$q$, '42501') THEN
    RAISE EXCEPTION 'FAIL 3a: العميل رجّع البوت بتحديث مباشر';
  END IF;
  IF NOT t.fails($q$update public.chat_sessions set is_manual_mode = true where id = '5e550000-0000-4000-8000-000000000004'$q$, '42501') THEN
    RAISE EXCEPTION 'FAIL 3b: العميل قلب الحالة مباشرة';
  END IF;
  IF NOT t.fails($q$insert into public.chat_sessions (user_id, is_manual_mode) values ('00000000-0000-4000-8000-0000000000c1', true)$q$, '42501') THEN
    RAISE EXCEPTION 'FAIL 3c: جلسة جديدة بحالة يدوية من العميل';
  END IF;
  -- حتى لو ضبط العلم بنفسه: الدور authenticated مرفوض
  PERFORM set_config('mad3oom.handoff_authorized', 'on', false);
  IF NOT t.fails($q$update public.chat_sessions set is_manual_mode = false where id = '5e550000-0000-4000-8000-000000000001'$q$, '42501') THEN
    RAISE EXCEPTION 'FAIL 3d: العلم المضبوط يدويًا فتح الباب';
  END IF;
  PERFORM set_config('mad3oom.handoff_authorized', '', false);
  IF NOT t.fails($q$select public.inbox_return_to_ai('5e550000-0000-4000-8000-000000000001', 'x')$q$, '42501') THEN
    RAISE EXCEPTION 'FAIL 3e: العميل نادى inbox_return_to_ai';
  END IF;
  IF NOT t.fails($q$select public._handoff_set('5e550000-0000-4000-8000-000000000001', false, 'x', 'x', null)$q$, '42501') THEN
    RAISE EXCEPTION 'FAIL 3f: _handoff_set مكشوفة';
  END IF;
  -- الأدمن المرتفع برضه: الكتابة المباشرة ممنوعة، المسار الرسمي بس
  PERFORM t.act('00000000-0000-4000-8000-0000000000e1');
  IF NOT t.fails($q$update public.chat_sessions set is_manual_mode = false where id = '5e550000-0000-4000-8000-000000000001'$q$, '42501') THEN
    RAISE EXCEPTION 'FAIL 3g: أدمن مرتفع كتب الحالة مباشرة';
  END IF;
  -- وتحديث bot_state العادي مايتأثرش
  PERFORM t.act('00000000-0000-4000-8000-0000000000c1');
  UPDATE public.chat_sessions SET bot_state = '{"greeted":true}' WHERE id = '5e550000-0000-4000-8000-000000000004';
  IF NOT t.manual('5e550000-0000-4000-8000-000000000001') THEN RAISE EXCEPTION 'FAIL 3h: الحالة اتغيرت'; END IF;
  RAISE NOTICE 'PASS 3: العميل والأدمن مايقدروش يغيّروا الحالة مباشرة (حتى بالعلم)، والمسارات الداخلية مقفولة';
END $$;
RESET ROLE; SET ROLE service_role;
DO $$
BEGIN
  PERFORM t.as_service();
  IF NOT t.fails($q$update public.chat_sessions set is_manual_mode = false where id = '5e550000-0000-4000-8000-000000000001'$q$, '42501') THEN
    RAISE EXCEPTION 'FAIL 3i: service_role كتب الحالة مباشرة';
  END IF;
  RAISE NOTICE 'PASS 3b: service_role برضه مايكتبش الحالة مباشرة';
END $$;
RESET ROLE; SET ROLE anon;
DO $$
BEGIN
  IF NOT t.fails($q$select public.inbox_return_to_ai('5e550000-0000-4000-8000-000000000001', 'x')$q$, '42501')
     OR NOT t.fails($q$select public.sie_request_human('5e550000-0000-4000-8000-000000000004', 'x')$q$, '42501') THEN
    RAISE EXCEPTION 'FAIL 3j: anon نادى مسار تسليم';
  END IF;
  RAISE NOTICE 'PASS 3c: anon مالوش أي مسار تسليم';
END $$;
RESET ROLE; SET ROLE authenticated;

-- ④ الرجوع للبوت: موظف له وصول بس، idempotent، والبوت يرد تاني ──────────────
DO $$
BEGIN
  PERFORM t.act('00000000-0000-4000-8000-0000000000a2');
  IF NOT t.fails($q$select public.inbox_return_to_ai('5e550000-0000-4000-8000-000000000001', 'x')$q$, '42501') THEN
    RAISE EXCEPTION 'FAIL 4a: أدمن مش مسند رجّع البوت';
  END IF;
  PERFORM t.act('00000000-0000-4000-8000-0000000000a1');
  IF NOT public.inbox_return_to_ai('5e550000-0000-4000-8000-000000000001', 'العميل اتحلت مشكلته') THEN
    RAISE EXCEPTION 'FAIL 4b: الرجوع ماتمش';
  END IF;
  IF public.inbox_return_to_ai('5e550000-0000-4000-8000-000000000001', 'تاني') THEN
    RAISE EXCEPTION 'FAIL 4c: الرجوع التاني مش idempotent';
  END IF;
  IF t.manual('5e550000-0000-4000-8000-000000000001') THEN RAISE EXCEPTION 'FAIL 4d: الحالة ماتغيرتش'; END IF;
  PERFORM t.act('00000000-0000-4000-8000-0000000000c1');
  PERFORM public.persist_bot_turn('5e550000-0000-4000-8000-000000000001', 8, 'البوت رجع', '{}');
  -- الاستلام اليدوي من غير رد، ومرتين = حدث واحد
  PERFORM t.act('00000000-0000-4000-8000-0000000000a1');
  IF NOT public.inbox_take_over('5e550000-0000-4000-8000-000000000001', 'متابعة شكوى') THEN RAISE EXCEPTION 'FAIL 4e'; END IF;
  IF public.inbox_take_over('5e550000-0000-4000-8000-000000000001', 'مرة تانية') THEN RAISE EXCEPTION 'FAIL 4f: الاستلام التاني مش idempotent'; END IF;
  -- المقفولة
  PERFORM public.inbox_close(ARRAY['5e550000-0000-4000-8000-000000000005']::uuid[]);
  IF NOT t.fails($q$select public.inbox_return_to_ai('5e550000-0000-4000-8000-000000000005', 'x')$q$, '22023') THEN
    RAISE EXCEPTION 'FAIL 4g: رجوع البوت لمحادثة مقفولة';
  END IF;
  RAISE NOTICE 'PASS 4: الرجوع للبوت للموظف صاحب الوصول بس، idempotent، والبوت يرد بعده؛ الاستلام idempotent';
END $$;

-- ⑤ السجل: الفاعل والسبب والمصدر، ولا تكرار ────────────────────────────────
RESET ROLE;
DO $$
DECLARE e public.inbox_events[]; n int;
BEGIN
  SELECT array_agg(x ORDER BY x.id) INTO e FROM t.handoff_events('5e550000-0000-4000-8000-000000000001') x;
  n := coalesce(array_length(e, 1), 0);
  IF n <> 3 THEN RAISE EXCEPTION 'FAIL 5a: متوقع 3 أحداث تسليم لقيت %', n; END IF;
  IF e[1].kind IS DISTINCT FROM 'handoff_to_human' OR e[1].actor_id IS DISTINCT FROM '00000000-0000-4000-8000-0000000000a1'
     OR e[1].payload->>'reason' IS DISTINCT FROM 'human_reply' OR e[1].payload->>'source' IS DISTINCT FROM 'inbox_reply'
     OR e[1].payload->>'from' IS DISTINCT FROM 'ai' OR e[1].payload->>'to' IS DISTINCT FROM 'human' THEN
    RAISE EXCEPTION 'FAIL 5b: حدث الرد %', row_to_json(e[1]);
  END IF;
  IF e[2].kind IS DISTINCT FROM 'handoff_to_ai' OR e[2].actor_id IS DISTINCT FROM '00000000-0000-4000-8000-0000000000a1'
     OR e[2].payload->>'reason' IS DISTINCT FROM 'العميل اتحلت مشكلته' OR e[2].payload->>'source' IS DISTINCT FROM 'inbox' THEN
    RAISE EXCEPTION 'FAIL 5c: حدث الرجوع %', row_to_json(e[2]);
  END IF;
  IF e[3].kind IS DISTINCT FROM 'handoff_to_human' OR e[3].payload->>'reason' IS DISTINCT FROM 'متابعة شكوى' THEN
    RAISE EXCEPTION 'FAIL 5d: حدث الاستلام %', row_to_json(e[3]);
  END IF;
  -- السجل مايتكتبش من بره
  IF has_table_privilege('authenticated', 'public.inbox_events', 'INSERT') THEN
    SET LOCAL ROLE authenticated;
    PERFORM t.act('00000000-0000-4000-8000-0000000000c1');
    IF NOT t.fails($q$insert into public.inbox_events (session_id, kind) values ('5e550000-0000-4000-8000-000000000001', 'handoff_to_ai')$q$, null) THEN
      RAISE EXCEPTION 'FAIL 5e: العميل زوّر حدث تسليم';
    END IF;
  END IF;
  RAISE NOTICE 'PASS 5: كل تغيير = حدث واحد بالفاعل والسبب والمصدر، والتكرار من غير حدث، والتزوير مرفوض';
END $$;

-- ⑥ تصعيد SIE ─────────────────────────────────────────────────────────────
SET ROLE authenticated;
DO $$
DECLARE e public.inbox_events;
BEGIN
  PERFORM t.act('00000000-0000-4000-8000-0000000000c2');
  IF NOT t.fails($q$select public.sie_request_human('5e550000-0000-4000-8000-000000000004', 'human_request')$q$, '42501') THEN
    RAISE EXCEPTION 'FAIL 6a: عميل تاني صعّد جلسة مش بتاعته';
  END IF;
  PERFORM t.act('00000000-0000-4000-8000-0000000000c1');
  IF NOT public.sie_request_human('5e550000-0000-4000-8000-000000000004', 'human_request') THEN RAISE EXCEPTION 'FAIL 6b'; END IF;
  IF NOT t.manual('5e550000-0000-4000-8000-000000000004') THEN RAISE EXCEPTION 'FAIL 6c: التصعيد ماسلّمش'; END IF;
  IF public.sie_request_human('5e550000-0000-4000-8000-000000000004', 'human_request') THEN RAISE EXCEPTION 'FAIL 6d: مش idempotent'; END IF;
  IF NOT t.fails($q$select public.persist_bot_turn('5e550000-0000-4000-8000-000000000004', 1, 'x', '{}')$q$, '55000') THEN
    RAISE EXCEPTION 'FAIL 6e: البوت رد بعد التصعيد';
  END IF;
  SELECT * INTO e FROM t.handoff_events('5e550000-0000-4000-8000-000000000004') LIMIT 1;
  IF e.actor_id IS DISTINCT FROM '00000000-0000-4000-8000-0000000000c1' OR e.payload->>'reason' IS DISTINCT FROM 'sie:human_request'
     OR e.payload->>'source' IS DISTINCT FROM 'sie' THEN
    RAISE EXCEPTION 'FAIL 6f: حدث التصعيد %', row_to_json(e);
  END IF;
  RAISE NOTICE 'PASS 6: تصعيد SIE يسلّم للإنسان فعلًا (صاحب الجلسة بس)، ومسجّل، والبوت يسكت';
END $$;
RESET ROLE; SET ROLE service_role;
DO $$
DECLARE e public.inbox_events;
BEGIN
  PERFORM t.as_service();
  IF NOT public.sie_request_human('5e550000-0000-4000-8000-000000000002', 'frustration') THEN RAISE EXCEPTION 'FAIL 6g'; END IF;
  SELECT * INTO e FROM t.handoff_events('5e550000-0000-4000-8000-000000000002') LIMIT 1;
  IF e.actor_id IS NOT NULL OR e.payload->>'source' IS DISTINCT FROM 'sie' THEN RAISE EXCEPTION 'FAIL 6h: %', row_to_json(e); END IF;
  RAISE NOTICE 'PASS 6b: تصعيد تيليجرام (service_role) يسلّم ومسجّل بلا فاعل بشري';
END $$;
RESET ROLE;

-- ⑦ السباق — جلسات حقيقية متوازية (dblink) ─────────────────────────────────
-- S3: مع البوت ومسندة لـ A1.
SELECT t.conn('human');
SELECT t.conn('ai');
SELECT t.dblink_exec('human', $s$set request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1'$s$);
SELECT t.dblink_exec('human', $s$set request.jwt.claim.role = 'authenticated'$s$);
SELECT t.dblink_exec('human', 'set role authenticated');
SELECT t.dblink_exec('ai', $s$set request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000c1'$s$);
SELECT t.dblink_exec('ai', $s$set request.jwt.claim.role = 'authenticated'$s$);
SELECT t.dblink_exec('ai', 'set role authenticated');

-- ⑦أ التسليم شغال (مش committed) ⇒ رد البوت يستنى، وبعد الـ commit يترفض
DO $$
DECLARE busy int; err text; ok boolean;
BEGIN
  PERFORM t.dblink_exec('human', 'begin');
  PERFORM * FROM t.dblink('human', $s$select public.inbox_send_reply('5e550000-0000-4000-8000-000000000003', 'مسكتها')::text$s$) AS r(x text);
  -- البوت خلّص حسابه وبيحاول يكتب:
  PERFORM t.dblink_send_query('ai', $s$select public.persist_bot_turn('5e550000-0000-4000-8000-000000000003', 1, 'رد بوت متأخر', '{}')::text$s$);
  PERFORM pg_sleep(0.5);
  busy := t.dblink_is_busy('ai');
  IF busy <> 1 THEN RAISE EXCEPTION 'FAIL 7a: رد البوت ماستناش قفل التسليم (busy=%)', busy; END IF;
  PERFORM t.dblink_exec('human', 'commit');
  -- نتيجة البوت: خطأ 55000
  BEGIN
    PERFORM * FROM t.dblink_get_result('ai') AS r(x text);
    ok := true;
  EXCEPTION WHEN others THEN
    ok := false; err := sqlerrm;
  END;
  PERFORM * FROM t.dblink_get_result('ai') AS r(x text);  -- تفريغ
  IF ok OR err NOT LIKE '%البوت مايقدرش يرد%' THEN RAISE EXCEPTION 'FAIL 7b: رد البوت اتكتب بعد التسليم (%)', err; END IF;
  IF t.bot_count('5e550000-0000-4000-8000-000000000003') <> 0 THEN RAISE EXCEPTION 'FAIL 7c: فيه رد بوت محفوظ'; END IF;
  RAISE NOTICE 'PASS 7a: تسليم شغال ⇒ رد البوت استنى القفل ثم اترفض بعد الـ commit، ولا صف محفوظ';
END $$;

-- ⑦ب قراءة قديمة: البوت قرا «مع البوت» قبل التسليم، والتسليم خلص، وبعدين كتب
SELECT * FROM t.dblink('human', $s$select public.inbox_return_to_ai('5e550000-0000-4000-8000-000000000003', 'تجهيز 7ب')::text$s$) AS r(x text);
DO $$
DECLARE stale text; err text; ok boolean;
BEGIN
  PERFORM t.dblink_exec('ai', 'begin');
  SELECT x INTO stale FROM t.dblink('ai', $s$select is_manual_mode::text from public.chat_sessions where id = '5e550000-0000-4000-8000-000000000003'$s$) AS r(x text);
  IF stale IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'FAIL 7d: تجهيز'; END IF;
  PERFORM * FROM t.dblink('human', $s$select public.inbox_send_reply('5e550000-0000-4000-8000-000000000003', 'مسكتها تاني')::text$s$) AS r(x text);
  BEGIN
    PERFORM * FROM t.dblink('ai', $s$select public.persist_bot_turn('5e550000-0000-4000-8000-000000000003', 2, 'رد على قراءة قديمة', '{}')::text$s$) AS r(x text);
    ok := true;
  EXCEPTION WHEN others THEN ok := false; err := sqlerrm;
  END;
  PERFORM t.dblink_exec('ai', 'rollback');
  IF ok THEN RAISE EXCEPTION 'FAIL 7e: البوت كتب بناءً على قراءة قديمة'; END IF;
  IF t.bot_count('5e550000-0000-4000-8000-000000000003') <> 0 THEN RAISE EXCEPTION 'FAIL 7f'; END IF;
  RAISE NOTICE 'PASS 7b: طلب البوت اللي بدأ قبل التسليم خلّص حسابه لكن كتابته بعد التسليم اترفضت';
END $$;

-- ⑦ج البوت كتب الأول (مش committed) ⇒ التسليم يستنى، والترتيب: بوت ثم إنسان
SELECT * FROM t.dblink('human', $s$select public.inbox_return_to_ai('5e550000-0000-4000-8000-000000000003', 'تجهيز 7ج')::text$s$) AS r(x text);
DO $$
DECLARE busy int; bot_at timestamptz; human_at timestamptz; ev_at timestamptz;
BEGIN
  PERFORM t.dblink_exec('ai', 'begin');
  PERFORM * FROM t.dblink('ai', $s$select public.persist_bot_turn('5e550000-0000-4000-8000-000000000003', 3, 'رد بوت سابق', '{}')::text$s$) AS r(x text);
  PERFORM t.dblink_send_query('human', $s$select public.inbox_send_reply('5e550000-0000-4000-8000-000000000003', 'الإنسان بعد البوت')::text$s$);
  PERFORM pg_sleep(0.5);
  busy := t.dblink_is_busy('human');
  IF busy <> 1 THEN RAISE EXCEPTION 'FAIL 7g: التسليم ماستناش كتابة البوت (busy=%)', busy; END IF;
  PERFORM t.dblink_exec('ai', 'commit');
  PERFORM * FROM t.dblink_get_result('human') AS r(x text);
  PERFORM * FROM t.dblink_get_result('human') AS r(x text);
  SELECT created_at INTO bot_at FROM public.chat_messages WHERE message_text = 'رد بوت سابق';
  SELECT created_at INTO human_at FROM public.chat_messages WHERE message_text = 'الإنسان بعد البوت';
  SELECT max(created_at) INTO ev_at FROM public.inbox_events WHERE session_id = '5e550000-0000-4000-8000-000000000003' AND kind = 'handoff_to_human';
  IF bot_at IS NULL OR human_at IS NULL OR NOT t.manual('5e550000-0000-4000-8000-000000000003') THEN
    RAISE EXCEPTION 'FAIL 7h: الرسالتين/الحالة';
  END IF;
  IF (SELECT count(*) FROM public.chat_messages WHERE session_id = '5e550000-0000-4000-8000-000000000003'
        AND is_bot_reply AND created_at > (SELECT max(created_at) FROM public.chat_messages WHERE message_text = 'الإنسان بعد البوت')) <> 0 THEN
    RAISE EXCEPTION 'FAIL 7i: رد بوت بعد رد الإنسان';
  END IF;
  RAISE NOTICE 'PASS 7c: البوت بدأ الكتابة الأول ⇒ التسليم استنى، والرد اتحفظ كله قبل التسليم (مفيش تداخل)';
END $$;

-- ⑦د ردّين بوت متوازيين على نفس الجلسة: يتسلسلوا من غير deadlock
SELECT * FROM t.dblink('human', $s$select public.inbox_return_to_ai('5e550000-0000-4000-8000-000000000003', 'تجهيز 7د')::text$s$) AS r(x text);
SELECT t.conn('ai2');
SELECT t.dblink_exec('ai2', $s$set request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000c1'$s$);
SELECT t.dblink_exec('ai2', $s$set request.jwt.claim.role = 'authenticated'$s$);
SELECT t.dblink_exec('ai2', 'set role authenticated');
SELECT t.dblink_exec('ai2', $s$set lock_timeout = '5s'$s$);
DO $$
DECLARE before int;
BEGIN
  before := t.bot_count('5e550000-0000-4000-8000-000000000003');
  PERFORM t.dblink_exec('ai', 'begin');
  PERFORM * FROM t.dblink('ai', $s$select public.persist_bot_turn('5e550000-0000-4000-8000-000000000003', 4, 'متوازي 1', '{}')::text$s$) AS r(x text);
  PERFORM t.dblink_send_query('ai2', $s$select public.persist_bot_turn('5e550000-0000-4000-8000-000000000003', 5, 'متوازي 2', '{}')::text$s$);
  PERFORM pg_sleep(0.3);
  PERFORM t.dblink_exec('ai', 'commit');
  PERFORM * FROM t.dblink_get_result('ai2') AS r(x text);
  PERFORM * FROM t.dblink_get_result('ai2') AS r(x text);
  IF t.bot_count('5e550000-0000-4000-8000-000000000003') <> before + 2 THEN RAISE EXCEPTION 'FAIL 7j: مش الاتنين اتكتبوا'; END IF;
  RAISE NOTICE 'PASS 7d: ردّين بوت متوازيين في وضع البوت اتكتبوا بالترتيب من غير deadlock';
END $$;
-- ⑦هـ الإقفال والرجوع للبوت على نفس المحادثة (060): الرجوع يستنى الإقفال ويشوفه
SELECT * FROM t.dblink('human', $s$select public.inbox_take_over('5e550000-0000-4000-8000-000000000003', 'تجهيز 7هـ')::text$s$) AS r(x text);
SELECT t.conn('staff2');
SELECT t.dblink_exec('staff2', $s$set request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1'$s$);
SELECT t.dblink_exec('staff2', $s$set request.jwt.claim.role = 'authenticated'$s$);
SELECT t.dblink_exec('staff2', 'set role authenticated');
SELECT t.dblink_exec('staff2', $s$set lock_timeout = '5s'$s$);
DO $$
DECLARE busy int; refused boolean := false; ev_before int;
BEGIN
  SELECT count(*) INTO ev_before FROM t.handoff_events('5e550000-0000-4000-8000-000000000003') WHERE kind = 'handoff_to_ai';
  PERFORM t.dblink_exec('human', 'begin');
  PERFORM * FROM t.dblink('human', $s$select public.inbox_close(array['5e550000-0000-4000-8000-000000000003']::uuid[])::text$s$) AS r(x text);
  PERFORM t.dblink_send_query('staff2', $s$select public.inbox_return_to_ai('5e550000-0000-4000-8000-000000000003', 'سباق الإقفال')::text$s$);
  PERFORM pg_sleep(0.5);
  busy := t.dblink_is_busy('staff2');
  IF busy <> 1 THEN RAISE EXCEPTION 'FAIL 7k: الرجوع للبوت ماستناش الإقفال (busy=%)', busy; END IF;
  PERFORM t.dblink_exec('human', 'commit');
  BEGIN
    PERFORM * FROM t.dblink_get_result('staff2') AS r(x text);
  EXCEPTION WHEN others THEN
    refused := position('مقفولة' in sqlerrm) > 0;
  END;
  PERFORM * FROM t.dblink_get_result('staff2', false) AS r(x text);  -- تفريغ
  IF NOT refused THEN RAISE EXCEPTION 'FAIL 7l: محادثة اتقفلت للتو رجعت للبوت'; END IF;
  IF NOT t.manual('5e550000-0000-4000-8000-000000000003')
     OR (SELECT count(*) FROM t.handoff_events('5e550000-0000-4000-8000-000000000003') WHERE kind = 'handoff_to_ai') <> ev_before THEN
    RAISE EXCEPTION 'FAIL 7m: الحالة أو السجل اتغيروا بعد الإقفال';
  END IF;
  RAISE NOTICE 'PASS 7e: الإقفال والرجوع للبوت بيتسلسلوا — محادثة اتقفلت مابترجعش للبوت';
END $$;
SELECT t.dblink_disconnect('staff2');
SELECT t.dblink_disconnect('human');
SELECT t.dblink_disconnect('ai');
SELECT t.dblink_disconnect('ai2');

-- ⑧ إعادة تشغيل الترحيل: idempotent ولا أثر جانبي ──────────────────────────
DO $$ BEGIN PERFORM set_config('t.events_before', (SELECT count(*)::text FROM public.inbox_events), false); END $$;
\i migrations/059_inbox_handoff_guarantee.sql
\i migrations/060_inbox_handoff_close_lock.sql
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_trigger WHERE tgname IN ('trg_guard_ai_reply_handoff','trg_guard_handoff_state','trg_log_handoff_change')) <> 3
     OR (SELECT count(*) FROM public.inbox_events)::text <> current_setting('t.events_before') THEN
    RAISE EXCEPTION 'FAIL 8a: إعادة التشغيل غيّرت حاجة';
  END IF;
  -- جلسات موجودة قبل الترحيل ولسه ماتلمستش: شغالة زي ما هي
  IF t.manual('5e550000-0000-4000-8000-000000000005') THEN RAISE EXCEPTION 'FAIL 8b: الحالة القديمة اتغيرت'; END IF;
  RAISE NOTICE 'PASS 8: الترحيل قابل لإعادة التشغيل، والمحادثات القائمة ما اتغيرتش';
END $$;

-- ⑨أ تراجع 060: الدالتين يرجعوا نص 059 حرفيًا
DO $$ BEGIN PERFORM set_config('t.ret_060', md5(pg_get_functiondef('public.inbox_return_to_ai(uuid, text)'::regprocedure)), false); END $$;
\i migrations/_rollback/060_inbox_handoff_close_lock.down.sql
DO $$
BEGIN
  IF md5(pg_get_functiondef('public.inbox_return_to_ai(uuid, text)'::regprocedure)) = current_setting('t.ret_060') THEN
    RAISE EXCEPTION 'FAIL 9d: تراجع 060 ماغيّرش الدالة';
  END IF;
  IF has_function_privilege('anon', 'public.inbox_return_to_ai(uuid, text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.inbox_return_to_ai(uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL 9e: صلاحيات الدالة اتغيرت بعد تراجع 060';
  END IF;
  RAISE NOTICE 'PASS 9a: تراجع 060 رجّع نسخة 059 بنفس الصلاحيات';
END $$;

-- ⑨ التراجع: يرجّع سلوك 058 حرفيًا، والسجل يفضل ────────────────────────────
\i migrations/_rollback/059_inbox_handoff_guarantee.down.sql
DO $$
BEGIN
  IF md5(pg_get_functiondef('public._inbox_post_reply(uuid, uuid, text, jsonb)'::regprocedure)) <> (SELECT before_059 FROM public._t_fp) THEN
    RAISE EXCEPTION 'FAIL 9a: _inbox_post_reply بعد التراجع مش نص 058';
  END IF;
  IF to_regprocedure('public._handoff_set(uuid, boolean, text, text, uuid)') IS NOT NULL
     OR to_regprocedure('public.inbox_return_to_ai(uuid, text)') IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 9b: دوال 059 لسه موجودة';
  END IF;
  IF (SELECT count(*) FROM public.inbox_events WHERE kind LIKE 'handoff_%') = 0 THEN
    RAISE EXCEPTION 'FAIL 9c: السجل اتمسح';
  END IF;
  -- بعد التراجع: رد الدعم بيسلّم زي 058
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000a1', false);
  SET LOCAL ROLE authenticated;
  PERFORM public.inbox_close(ARRAY[]::uuid[]);
  RAISE NOTICE 'PASS 9: التراجع رجّع 058 حرفيًا وشال الدوال والمحفّزات، والسجل فضل';
END $$;
-- وتاني لقدّام بعد التراجع
\i migrations/059_inbox_handoff_guarantee.sql
\i migrations/060_inbox_handoff_close_lock.sql
RESET ROLE;
DO $$ BEGIN RAISE NOTICE 'ALL handoff-guarantee: PASS'; END $$;
