-- ============================================================================
-- اختبار تنفيذي لـ 061 + 062: رد البوت ورد الدعم من الخادم بس (Phase 3).
--
-- يثبّت، كل خاصية تفشل إن انكسرت:
--   Ⓐ الثغرات موجودة فعلًا قبل 062 (بسياسات الإنتاج نفسها): العميل يدرج رد دعم
--      ورد بوت، ينادي persist_bot_turn بأي نص، ويعدّل bot_state
--   Ⓑ chat_post_notice (061): الترحيب مرة واحدة ومن إعدادات شات الموقع، صاحب
--      الجلسة بس، أنواع معروفة بس، رسالة واحدة لكل رسالة عميل، حد المعدل مقيّد،
--      سبب «SIE مش متاح» من الخادم، وصمت لو المحادثة مع الدعم أو مقفولة
--   Ⓒ سباق الترحيب بجلستين حقيقيتين (dblink): ترحيب واحد بس
--   Ⓓ بعد 062: الثغرات مقفولة، ومسارات الإنتاج الشرعية شغالة (رسالة العميل،
--      الأدمن المرتفع، الخادم/تيليجرام، chat_post_notice، رد الدعم، إقفال
--      العميل للمحادثة، و 059 لسه شغال)
--   Ⓔ إعادة التشغيل idempotent، والتراجع يرجّع السياسة والصلاحيات حرفيًا
--
-- التجهيز منقول آليًا من handoff-guarantee.test.sql (جداول وسياسات الإنتاج،
-- 055–060، و persist_bot_turn / create_ticket_… حرفيًا من الإنتاج).
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

-- ── إضافات Phase 3 ─────────────────────────────────────────────────────────
-- إعدادات البوت بشكل الإنتاج: صف شات الموقع العام (phone_number_id IS NULL)
-- وصف لرقم واتساب لازم مايتقراش.
CREATE TABLE public.bot_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, phone_number_id text,
  welcome_message text, updated_at timestamptz DEFAULT now());
-- صف واتساب الأحدث عن قصد: لو الفلتر على phone_number_id اتشال، الأحدث يكسب ويبان.
INSERT INTO public.bot_settings (user_id, phone_number_id, welcome_message, updated_at) VALUES
  ('00000000-0000-4000-8000-00000000000f', null, 'أهلًا من إعدادات الموقع', now() - interval '1 day'),
  ('00000000-0000-4000-8000-00000000000f', '111000111', 'ترحيب واتساب — لازم مايظهرش', now());
-- sie_my_entitlement: بديل قابل للضبط من الاختبار (الإنتاج SECURITY DEFINER بيرجّع jsonb).
CREATE TABLE t_ent (has_access boolean, reason text);
INSERT INTO t_ent VALUES (true, null);
CREATE OR REPLACE FUNCTION public.sie_my_entitlement() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  select jsonb_build_object('signed_in', true, 'has_access', has_access, 'reason', reason) from t_ent limit 1; $$;
GRANT EXECUTE ON FUNCTION public.sie_my_entitlement() TO authenticated;

-- جلسات Phase 3 (كلها للعميل C1): فاضية للترحيب والإشعارات والسباق.
INSERT INTO public.chat_sessions (id, user_id) VALUES
  ('5e550000-0000-4000-8000-000000000031', '00000000-0000-4000-8000-0000000000c1'),
  ('5e550000-0000-4000-8000-000000000032', '00000000-0000-4000-8000-0000000000c1'),
  ('5e550000-0000-4000-8000-000000000033', '00000000-0000-4000-8000-0000000000c1'),
  ('5e550000-0000-4000-8000-000000000034', '00000000-0000-4000-8000-0000000000c1'),
  ('5e550000-0000-4000-8000-000000000035', '00000000-0000-4000-8000-0000000000c1'),
  ('5e550000-0000-4000-8000-000000000036', '00000000-0000-4000-8000-0000000000c1');

-- «ينجح ثم يترجع»: يرجّع true لو الأمر نجح (والأثر اترجع)، false لو اترفض.
CREATE OR REPLACE FUNCTION t.succeeds(p_sql text) RETURNS boolean LANGUAGE plpgsql AS $$
begin
  execute p_sql;
  raise exception 'T_ROLLBACK';
exception when others then
  return sqlerrm = 'T_ROLLBACK';
end $$;
CREATE OR REPLACE FUNCTION t.msgs(p uuid) RETURNS int LANGUAGE sql SECURITY DEFINER AS $$
  select count(*)::int from public.chat_messages where session_id = p; $$;
CREATE OR REPLACE FUNCTION t.state(p uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER AS $$
  select bot_state from public.chat_sessions where id = p; $$;
-- آخر رسالة بوت (مش «آخر رسالة»: رسالة العميل والإشعار في نفس المعاملة
-- بيتعادلوا في created_at، والترتيب بالـ id عشوائي).
CREATE OR REPLACE FUNCTION t.last_text(p uuid) RETURNS text LANGUAGE sql SECURITY DEFINER AS $$
  select message_text from public.chat_messages where session_id = p and is_bot_reply
   order by created_at desc, id desc limit 1; $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;

-- لقطة الإنتاج قبل 062 (للتراجع الحرفي)
CREATE TABLE public._t_before_062 AS
  SELECT (SELECT pg_get_expr(polwithcheck, polrelid) FROM pg_policy
            WHERE polrelid = 'public.chat_messages'::regclass AND polname = 'chat_messages_insert_own_or_admin') AS ins_check,
         -- مجموعة الصلاحيات (مش نص proacl: ترتيب العناصر بيختلف والمعنى واحد)
         (SELECT array_agg(p.proname || ':' || coalesce(g.rolname, 'PUBLIC') || '=' || a.privilege_type
                     ORDER BY p.proname || ':' || coalesce(g.rolname, 'PUBLIC') || '=' || a.privilege_type)
            FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a LEFT JOIN pg_roles g ON g.oid = a.grantee
           WHERE p.proname IN ('persist_bot_turn', 'create_ticket_with_message_and_session_update')
             AND p.pronamespace = 'public'::regnamespace) AS acls;

-- ══ Ⓐ الثغرات قبل 062 (سياسات الإنتاج الحالية) ═══════════════════════════
SET ROLE authenticated;
SELECT t.act('00000000-0000-4000-8000-0000000000c1');
DO $$
BEGIN
  IF NOT t.succeeds($q$insert into public.chat_messages (session_id, sender_id, message_text, is_admin_reply)
                      values ('5e550000-0000-4000-8000-000000000001', null, 'رد دعم مزيّف', true)$q$) THEN
    RAISE EXCEPTION 'FAIL A1: توقعنا إن العميل يقدر يزيّف رد دعم قبل 062';
  END IF;
  IF NOT t.succeeds($q$select public.persist_bot_turn('5e550000-0000-4000-8000-000000000001', 9, 'رد بوت مزيّف', '{"sie":{"x":1}}')$q$) THEN
    RAISE EXCEPTION 'FAIL A2: توقعنا إن العميل يقدر ينادي persist_bot_turn قبل 062';
  END IF;
  IF NOT t.succeeds($q$update public.chat_sessions set bot_state = '{"sie":{"forged":true}}'
                      where id = '5e550000-0000-4000-8000-000000000001'$q$) THEN
    RAISE EXCEPTION 'FAIL A3: توقعنا إن العميل يقدر يعدّل bot_state قبل 062';
  END IF;
  RAISE NOTICE 'PASS A: الثغرات التلاتة موجودة فعلًا بسياسات الإنتاج قبل 062 (رد دعم مزيّف، persist_bot_turn مباشر، bot_state)';
END $$;
RESET ROLE;

\i migrations/061_chat_server_notices.sql

-- ══ Ⓑ chat_post_notice ═══════════════════════════════════════════════════
SET ROLE authenticated;
SELECT t.act('00000000-0000-4000-8000-0000000000c1');
DO $$
DECLARE id1 uuid; id2 uuid;
BEGIN
  id1 := public.chat_post_notice('5e550000-0000-4000-8000-000000000031', 'greeting');
  id2 := public.chat_post_notice('5e550000-0000-4000-8000-000000000031', 'greeting');
  IF id1 IS NULL OR id2 IS NOT NULL OR t.msgs('5e550000-0000-4000-8000-000000000031') <> 1 THEN
    RAISE EXCEPTION 'FAIL B1: الترحيب لازم يتكتب مرة واحدة (% / % / %)', id1, id2, t.msgs('5e550000-0000-4000-8000-000000000031');
  END IF;
  IF position('أهلًا من إعدادات الموقع' in t.last_text('5e550000-0000-4000-8000-000000000031')) = 0
     OR position('واتساب' in t.last_text('5e550000-0000-4000-8000-000000000031')) > 0 THEN
    RAISE EXCEPTION 'FAIL B2: الترحيب مش من صف شات الموقع: %', t.last_text('5e550000-0000-4000-8000-000000000031');
  END IF;
  IF (t.state('5e550000-0000-4000-8000-000000000031')->>'greeted') IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'FAIL B3: greeted مااتعلّمش';
  END IF;
  IF public.chat_post_notice('5e550000-0000-4000-8000-000000000001', 'greeting') IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL B4: ترحيب في محادثة فيها رسايل';
  END IF;
  RAISE NOTICE 'PASS B1: الترحيب مرة واحدة، من إعدادات شات الموقع، ومعلَّم greeted';
END $$;

DO $$
BEGIN
  PERFORM t.act('00000000-0000-4000-8000-0000000000c2');
  IF NOT t.fails($q$select public.chat_post_notice('5e550000-0000-4000-8000-000000000032', 'greeting')$q$, '42501') THEN
    RAISE EXCEPTION 'FAIL B5: عميل تاني كتب في محادثة مش بتاعته';
  END IF;
  PERFORM t.act('00000000-0000-4000-8000-0000000000a1');
  IF NOT t.fails($q$select public.chat_post_notice('5e550000-0000-4000-8000-000000000032', 'error')$q$, '42501') THEN
    RAISE EXCEPTION 'FAIL B6: موظف كتب رسالة بوت في محادثة عميل';
  END IF;
  PERFORM t.act('00000000-0000-4000-8000-0000000000c1');
  IF NOT t.fails($q$select public.chat_post_notice('5e550000-0000-4000-8000-000000000032', 'anything')$q$, '22023') THEN
    RAISE EXCEPTION 'FAIL B7: نوع غير معروف اتقبل';
  END IF;
  IF t.msgs('5e550000-0000-4000-8000-000000000032') <> 0 THEN RAISE EXCEPTION 'FAIL B8: أثر بعد رفض'; END IF;
  RAISE NOTICE 'PASS B2: صاحب الجلسة بس (لا عميل تاني ولا موظف)، وأنواع معروفة بس';
END $$;
RESET ROLE;
SET ROLE anon;
DO $$
BEGIN
  PERFORM t.act(null);
  IF NOT t.fails($q$select public.chat_post_notice('5e550000-0000-4000-8000-000000000032', 'greeting')$q$, '42501') THEN
    RAISE EXCEPTION 'FAIL B9: anon نادى chat_post_notice';
  END IF;
  RAISE NOTICE 'PASS B3: anon مالوش مسار';
END $$;
RESET ROLE;

SET ROLE authenticated;
SELECT t.act('00000000-0000-4000-8000-0000000000c1');
DO $$
BEGIN
  -- مفيش رسالة عميل لسه: مفيش إشعار
  IF public.chat_post_notice('5e550000-0000-4000-8000-000000000032', 'sie_error') IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL B10: إشعار من غير رسالة عميل';
  END IF;
END $$;
-- كل خطوة في معاملة لوحدها زي الإنتاج (كل طلب من المتصفح معاملة).
INSERT INTO public.chat_messages (session_id, sender_id, message_text)
  VALUES ('5e550000-0000-4000-8000-000000000032', '00000000-0000-4000-8000-0000000000c1', 'عندي مشكلة');
SELECT set_config('t.a', coalesce(public.chat_post_notice('5e550000-0000-4000-8000-000000000032', 'sie_error')::text, 'null'), false);
SELECT set_config('t.b', coalesce(public.chat_post_notice('5e550000-0000-4000-8000-000000000032', 'error')::text, 'null'), false);
DO $$
BEGIN
  IF current_setting('t.a') = 'null' OR current_setting('t.b') <> 'null' OR t.msgs('5e550000-0000-4000-8000-000000000032') <> 2 THEN
    RAISE EXCEPTION 'FAIL B11: لازم إشعار واحد لكل رسالة عميل (% / %)', current_setting('t.a'), current_setting('t.b');
  END IF;
END $$;
INSERT INTO public.chat_messages (session_id, sender_id, message_text)
  VALUES ('5e550000-0000-4000-8000-000000000032', '00000000-0000-4000-8000-0000000000c1', 'تاني');
SELECT set_config('t.c', coalesce(public.chat_post_notice('5e550000-0000-4000-8000-000000000032', 'rate_limited', 99999)::text, 'null'), false);
DO $$
BEGIN
  IF current_setting('t.c') = 'null' OR position('3600 ثانية' in t.last_text('5e550000-0000-4000-8000-000000000032')) = 0 THEN
    RAISE EXCEPTION 'FAIL B12: حد المعدل مش متقيّد: %', t.last_text('5e550000-0000-4000-8000-000000000032');
  END IF;
  -- وفي نفس المعاملة: رسالة العميل والإشعار بنفس الوقت ⇒ التعادل بيرفض (مش ترتيب عشوائي)
  INSERT INTO public.chat_messages (session_id, sender_id, message_text)
    VALUES ('5e550000-0000-4000-8000-000000000032', '00000000-0000-4000-8000-0000000000c1', 'تالت');
  IF public.chat_post_notice('5e550000-0000-4000-8000-000000000032', 'error') IS NULL THEN
    RAISE EXCEPTION 'FAIL B12b: أول إشعار بعد رسالة جديدة اترفض';
  END IF;
  IF public.chat_post_notice('5e550000-0000-4000-8000-000000000032', 'error') IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL B12c: إشعار تاني في نفس اللحظة اتقبل';
  END IF;
  RAISE NOTICE 'PASS B4: إشعار واحد يرد على آخر رسالة عميل (مفيش إغراق، والتعادل بيرفض)، وحد المعدل متقيّد بـ 3600';
END $$;
RESET ROLE;

-- «SIE مش متاح»: السبب من الخادم، ولو عنده وصول فعلًا مفيش رسالة
UPDATE t_ent SET has_access = false, reason = 'quota_exceeded';
SET ROLE authenticated;
SELECT t.act('00000000-0000-4000-8000-0000000000c1');
DO $$
BEGIN
  INSERT INTO public.chat_messages (session_id, sender_id, message_text)
    VALUES ('5e550000-0000-4000-8000-000000000033', '00000000-0000-4000-8000-0000000000c1', 'سؤال');
  IF public.chat_post_notice('5e550000-0000-4000-8000-000000000033', 'sie_unavailable') IS NULL
     OR position('استهلكت كل رسائل' in t.last_text('5e550000-0000-4000-8000-000000000033')) = 0 THEN
    RAISE EXCEPTION 'FAIL B13: سبب الرفض مش من الخادم: %', t.last_text('5e550000-0000-4000-8000-000000000033');
  END IF;
END $$;
RESET ROLE;
UPDATE t_ent SET has_access = true, reason = null;
SET ROLE authenticated;
SELECT t.act('00000000-0000-4000-8000-0000000000c1');
DO $$
BEGIN
  INSERT INTO public.chat_messages (session_id, sender_id, message_text)
    VALUES ('5e550000-0000-4000-8000-000000000033', '00000000-0000-4000-8000-0000000000c1', 'تاني');
  IF public.chat_post_notice('5e550000-0000-4000-8000-000000000033', 'sie_unavailable') IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL B14: «مش متاح» اتكتبت لعميل عنده وصول';
  END IF;
  RAISE NOTICE 'PASS B5: سبب «SIE مش متاح» محسوب على الخادم، ومابيتكتبش لعميل عنده وصول';
END $$;
RESET ROLE;

-- مع فريق الدعم أو مقفولة: صمت
SELECT public._handoff_set('5e550000-0000-4000-8000-000000000034', true, 'test', 'test', null);
UPDATE public.chat_sessions SET status = 'closed' WHERE id = '5e550000-0000-4000-8000-000000000035';
SET ROLE authenticated;
SELECT t.act('00000000-0000-4000-8000-0000000000c1');
DO $$
BEGIN
  IF public.chat_post_notice('5e550000-0000-4000-8000-000000000034', 'greeting') IS NOT NULL
     OR public.chat_post_notice('5e550000-0000-4000-8000-000000000035', 'greeting') IS NOT NULL
     OR t.msgs('5e550000-0000-4000-8000-000000000034') + t.msgs('5e550000-0000-4000-8000-000000000035') <> 0 THEN
    RAISE EXCEPTION 'FAIL B15: البوت اتكلم في محادثة مع الدعم أو مقفولة';
  END IF;
  RAISE NOTICE 'PASS B6: محادثة مع فريق الدعم أو مقفولة: البوت ساكت';
END $$;
RESET ROLE;

-- ══ Ⓒ سباق الترحيب: تبويبين في نفس اللحظة ════════════════════════════════
SELECT t.conn('tab1'), t.conn('tab2');
SELECT t.dblink_exec(c, s) FROM (VALUES ('tab1'), ('tab2')) v(c),
  LATERAL (VALUES ($s$set request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000c1'$s$),
                  ($s$set request.jwt.claim.role = 'authenticated'$s$),
                  ('set role authenticated'), ($s$set lock_timeout = '5s'$s$)) q(s);
DO $$
DECLARE busy int; first text; second text;
BEGIN
  PERFORM t.dblink_exec('tab1', 'begin');
  SELECT x INTO first FROM t.dblink('tab1', $s$select coalesce(public.chat_post_notice('5e550000-0000-4000-8000-000000000036', 'greeting')::text, 'null')$s$) AS r(x text);
  PERFORM t.dblink_send_query('tab2', $s$select coalesce(public.chat_post_notice('5e550000-0000-4000-8000-000000000036', 'greeting')::text, 'null')$s$);
  PERFORM pg_sleep(0.4);
  busy := t.dblink_is_busy('tab2');
  IF busy <> 1 THEN RAISE EXCEPTION 'FAIL C1: التبويب التاني ماستناش القفل (busy=%)', busy; END IF;
  PERFORM t.dblink_exec('tab1', 'commit');
  SELECT x INTO second FROM t.dblink_get_result('tab2') AS r(x text);
  PERFORM * FROM t.dblink_get_result('tab2', false) AS r(x text);
  IF first = 'null' OR second <> 'null' OR t.msgs('5e550000-0000-4000-8000-000000000036') <> 1 THEN
    RAISE EXCEPTION 'FAIL C2: ترحيبين (% / % / %)', first, second, t.msgs('5e550000-0000-4000-8000-000000000036');
  END IF;
  RAISE NOTICE 'PASS C: تبويبين في نفس اللحظة ⇒ التاني استنى القفل وشاف الترحيب ⇒ ترحيب واحد بس';
END $$;
SELECT t.dblink_disconnect('tab1'), t.dblink_disconnect('tab2');

\i migrations/062_chat_message_authority.sql

-- ══ Ⓓ بعد 062 ════════════════════════════════════════════════════════════
SET ROLE authenticated;
SELECT t.act('00000000-0000-4000-8000-0000000000c1');
DO $$
BEGIN
  IF NOT t.succeeds($q$insert into public.chat_messages (session_id, sender_id, message_text)
                      values ('5e550000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1', 'رسالة عادية')$q$) THEN
    RAISE EXCEPTION 'FAIL D1: رسالة العميل العادية اترفضت';
  END IF;
  IF NOT t.fails($q$insert into public.chat_messages (session_id, sender_id, message_text, is_admin_reply)
                   values ('5e550000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1', 'رد دعم مزيّف', true)$q$, '42501')
     OR NOT t.fails($q$insert into public.chat_messages (session_id, sender_id, message_text, is_admin_reply)
                   values ('5e550000-0000-4000-8000-000000000001', null, 'رد دعم مزيّف', true)$q$, '42501')
     OR NOT t.fails($q$insert into public.chat_messages (session_id, sender_id, message_text, is_bot_reply)
                   values ('5e550000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1', 'رد بوت مزيّف', true)$q$, '42501')
     OR NOT t.fails($q$insert into public.chat_messages (session_id, sender_id, message_text)
                   values ('5e550000-0000-4000-8000-000000000001', null, 'من غير مرسل')$q$, '42501')
     OR NOT t.fails($q$insert into public.chat_messages (session_id, sender_id, message_text)
                   values ('5e550000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c2', 'باسم عميل تاني')$q$, '42501') THEN
    RAISE EXCEPTION 'FAIL D2: العميل لسه يقدر يزيّف رد دعم/بوت أو يكتب من غير مرسل/باسم غيره';
  END IF;
  RAISE NOTICE 'PASS D1: العميل يكتب رسايله هو بس — مفيش رد دعم ولا بوت مزيّف، ولا من غير مرسل، ولا باسم غيره';
END $$;

DO $$
BEGIN
  IF NOT t.fails($q$select public.persist_bot_turn('5e550000-0000-4000-8000-000000000001', 9, 'رد بوت مزيّف', '{}')$q$, '42501')
     OR NOT t.fails($q$select public.create_ticket_with_message_and_session_update('5e550000-0000-4000-8000-000000000001', 9, 'x', '{}', null, 'other', 'تذكرة مزيّفة')$q$, '42501') THEN
    RAISE EXCEPTION 'FAIL D3: العميل لسه ينادي RPC دور البوت';
  END IF;
  IF NOT t.fails($q$update public.chat_sessions set bot_state = '{"sie":{"forged":true}}' where id = '5e550000-0000-4000-8000-000000000001'$q$, '42501')
     OR NOT t.fails($q$insert into public.chat_sessions (user_id, bot_state) values ('00000000-0000-4000-8000-0000000000c1', '{"sie":{"x":1}}')$q$, '42501') THEN
    RAISE EXCEPTION 'FAIL D4: العميل لسه يكتب bot_state';
  END IF;
  IF NOT t.succeeds($q$insert into public.chat_sessions (user_id, status) values ('00000000-0000-4000-8000-0000000000c1', 'active')$q$)
     OR NOT t.succeeds($q$update public.chat_sessions set status = 'closed' where id = '5e550000-0000-4000-8000-000000000033'$q$) THEN
    RAISE EXCEPTION 'FAIL D5: إنشاء جلسة أو إقفالها من العميل اتكسر';
  END IF;
  IF public.chat_post_notice('5e550000-0000-4000-8000-000000000032', 'greeting') IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL D6: ترحيب في محادثة فيها رسايل';
  END IF;
  RAISE NOTICE 'PASS D2: persist_bot_turn/التذكرة وتعديل bot_state مقفولين على العميل؛ إنشاء الجلسة وإقفالها شغالين';
END $$;
RESET ROLE;

-- chat_post_notice لسه شغالة بعد 062 (دالة مالكة: تعدّي السياسة والحارس)
INSERT INTO public.chat_sessions (id, user_id) VALUES ('5e550000-0000-4000-8000-000000000037', '00000000-0000-4000-8000-0000000000c1');
SET ROLE authenticated;
SELECT t.act('00000000-0000-4000-8000-0000000000c1');
DO $$
BEGIN
  IF public.chat_post_notice('5e550000-0000-4000-8000-000000000037', 'greeting') IS NULL
     OR (t.state('5e550000-0000-4000-8000-000000000037')->>'greeted') IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'FAIL D7: chat_post_notice اتكسرت بعد 062';
  END IF;
  RAISE NOTICE 'PASS D3: chat_post_notice شغالة بعد 062 (الترحيب و greeted)';
END $$;
RESET ROLE;

-- الأدمن المرتفع زي ما هو، ورد الدعم من الصندوق زي ما هو
SET ROLE authenticated;
DO $$
BEGIN
  PERFORM t.act('00000000-0000-4000-8000-0000000000e1');
  IF NOT t.succeeds($q$insert into public.chat_messages (session_id, sender_id, message_text, is_admin_reply)
                      values ('5e550000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000e1', 'رد أدمن مرتفع', true)$q$) THEN
    RAISE EXCEPTION 'FAIL D8: الأدمن المرتفع اتمنع';
  END IF;
  PERFORM public.inbox_assign('5e550000-0000-4000-8000-000000000031', '00000000-0000-4000-8000-0000000000a1');
  PERFORM t.act('00000000-0000-4000-8000-0000000000a1');
  IF NOT t.succeeds($q$select public.inbox_send_reply('5e550000-0000-4000-8000-000000000031', 'رد الدعم')$q$) THEN
    RAISE EXCEPTION 'FAIL D9: رد الدعم من الصندوق اتكسر';
  END IF;
  RAISE NOTICE 'PASS D4: الأدمن المرتفع ورد الدعم من الصندوق شغالين زي ما هم';
END $$;
RESET ROLE;

-- الخادم (sie-api بعميل الخادم / تيليجرام): دور البوت و bot_state شغالين، و 059 لسه شغال
SET ROLE service_role;
DO $$
BEGIN
  PERFORM t.as_service();
  IF NOT t.succeeds($q$select public.persist_bot_turn('5e550000-0000-4000-8000-000000000001', 10, 'رد SIE من الخادم', '{"sie":{"turnCount":10}}')$q$)
     OR NOT t.succeeds($q$select public.create_ticket_with_message_and_session_update('5e550000-0000-4000-8000-000000000001', 11, 'فتحتلك تذكرة', '{}', null, 'other', 'وصف')$q$)
     OR NOT t.succeeds($q$update public.chat_sessions set bot_state = '{"x":1}' where id = '5e550000-0000-4000-8000-000000000001'$q$) THEN
    RAISE EXCEPTION 'FAIL D10: مسار الخادم اتكسر';
  END IF;
  IF NOT t.fails($q$select public.persist_bot_turn('5e550000-0000-4000-8000-000000000034', 1, 'رد بوت والإنسان ماسك', '{}')$q$, '55000') THEN
    RAISE EXCEPTION 'FAIL D11: 059 مابقاش شغال';
  END IF;
  RAISE NOTICE 'PASS D5: الخادم يكتب دور البوت والتذكرة و bot_state، و 059 لسه بيرفض رد البوت والإنسان ماسك';
END $$;
RESET ROLE;

-- ══ Ⓔ إعادة التشغيل والتراجع ═════════════════════════════════════════════
\i migrations/061_chat_server_notices.sql
\i migrations/062_chat_message_authority.sql
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_guard_bot_state') <> 1
     OR (SELECT count(*) FROM pg_policy WHERE polrelid = 'public.chat_messages'::regclass AND polname = 'chat_messages_insert_own_or_admin') <> 1 THEN
    RAISE EXCEPTION 'FAIL E1: إعادة التشغيل كرّرت حاجة';
  END IF;
  RAISE NOTICE 'PASS E1: 061 و 062 قابلين لإعادة التشغيل';
END $$;

\i migrations/_rollback/062_chat_message_authority.down.sql
DO $$
BEGIN
  IF (SELECT pg_get_expr(polwithcheck, polrelid) FROM pg_policy WHERE polrelid = 'public.chat_messages'::regclass
        AND polname = 'chat_messages_insert_own_or_admin') IS DISTINCT FROM (SELECT ins_check FROM public._t_before_062) THEN
    RAISE EXCEPTION 'FAIL E2: السياسة بعد التراجع مش زي قبل 062';
  END IF;
  IF (SELECT array_agg(p.proname || ':' || coalesce(g.rolname, 'PUBLIC') || '=' || a.privilege_type
                     ORDER BY p.proname || ':' || coalesce(g.rolname, 'PUBLIC') || '=' || a.privilege_type)
            FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a LEFT JOIN pg_roles g ON g.oid = a.grantee
           WHERE p.proname IN ('persist_bot_turn', 'create_ticket_with_message_and_session_update')
             AND p.pronamespace = 'public'::regnamespace) IS DISTINCT FROM (SELECT acls FROM public._t_before_062) THEN
    RAISE EXCEPTION 'FAIL E3: الصلاحيات بعد التراجع مش زي قبل 062: % vs %', (SELECT array_agg(p.proname || ':' || coalesce(g.rolname, 'PUBLIC') || '=' || a.privilege_type
                     ORDER BY p.proname || ':' || coalesce(g.rolname, 'PUBLIC') || '=' || a.privilege_type)
            FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a LEFT JOIN pg_roles g ON g.oid = a.grantee
           WHERE p.proname IN ('persist_bot_turn', 'create_ticket_with_message_and_session_update')
             AND p.pronamespace = 'public'::regnamespace), (SELECT acls FROM public._t_before_062);
  END IF;
  RAISE NOTICE 'PASS E2: تراجع 062 رجّع السياسة والصلاحيات حرفيًا وشال الحارس';
END $$;
\i migrations/_rollback/061_chat_server_notices.down.sql
\i migrations/061_chat_server_notices.sql
\i migrations/062_chat_message_authority.sql
DO $$ BEGIN RAISE NOTICE 'ALL chat-message-authority: PASS'; END $$;
