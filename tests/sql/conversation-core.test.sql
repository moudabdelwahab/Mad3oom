-- ============================================================================
-- اختبار تنفيذي لـ 064 (Conversation Core — المرحلة B) على PostgreSQL حقيقي.
--
-- يثبّت، كل خاصية تفشل إن انكسرت (التزامن باتصالات حقيقية عبر dblink):
--   Ⓐ قبل 064 مفيش ضمان (محادثتين نشطتين لنفس الـ chat ممكنين)
--   Ⓑ الأعلام التلاتة مقفولة، conv_* لـ service_role بس، والعميل مايكتبش
--      أعمدة Core، ورسالته العادية شغالة
--   Ⓒ الإثباتات السبعة:
--      1 نفس الرسالة مرتين ⇒ رسالة واحدة (واتساب: whatsapp-inbound-idempotency)
--      2 نفس الرسالة من اتصالين متزامنين ⇒ created=true مرة واحدة (وكيل واحد)
--      3 رسالتين متزامنتين ⇒ مفيش حالة ضايعة (والدور القديم يترفض)
--      4 commitTurn بنسخة قديمة ⇒ فشل من غير أي أثر
--      5 استلام إنسان أثناء الوكيل ⇒ commit الوكيل يفشل (قبل/متزامن/استلام وإرجاع)
--      6 إنشاء محادثة متزامن ⇒ محادثة واحدة (وتبنّي الجلسة القديمة)
--      7 إعادة محاولة الإرسال ⇒ مفيش رسالة صادرة تانية
--   Ⓓ الأحداث في نفس المعاملة، والإقفال حدث واحد من أي مسار
--   Ⓔ المسارات القديمة: persist_bot_turn (أندرويد/sie-api)، رد الدعم، الترحيب،
--      062 و 059
--   Ⓕ إعادة التشغيل idempotent، والتراجع بيشيل الحدود ويسيب البيانات
--
-- التجهيز منقول آليًا من chat-message-authority.test.sql (جداول وسياسات
-- الإنتاج، 054–062، persist_bot_turn / create_ticket_… حرفيًا).
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


\i migrations/061_chat_server_notices.sql
\i migrations/062_chat_message_authority.sql

-- ── إضافات 064: جداول ومحفّزات الإنتاج اللي Core بيلمسها ─────────────────
-- channel_identities و sie_settings بشكل الإنتاج (information_schema، 2026-09-29).
CREATE TABLE public.channel_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, channel text, channel_user_id text,
  channel_chat_id text, display_name text, is_active boolean DEFAULT true,
  linked_at timestamptz DEFAULT now(), last_seen_at timestamptz);
CREATE TABLE public.sie_settings (
  key text PRIMARY KEY, value jsonb, updated_at timestamptz DEFAULT now(), updated_by uuid);
INSERT INTO public.sie_settings (key, value) VALUES ('engine_enabled', 'true');
GRANT SELECT ON public.channel_identities, public.sie_settings TO authenticated, service_role;
-- محفّزات الإشعارات على chat_sessions / chat_messages: نص الإنتاج حرفيًا
-- (pg_get_functiondef، 2026-10-05) — عشان أي تداخل أقفال أو أخطاء يبان هنا.
CREATE OR REPLACE FUNCTION public.handle_new_chat_message()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
    admin_id UUID;
    customer_name TEXT;
    session_user_id TEXT;
BEGIN
    SELECT user_id INTO session_user_id FROM public.chat_sessions WHERE id = NEW.session_id;
    IF NEW.is_bot_reply = FALSE AND NEW.is_admin_reply = FALSE THEN
        BEGIN
            SELECT full_name INTO customer_name FROM public.profiles WHERE id::text = session_user_id;
        EXCEPTION WHEN OTHERS THEN
            customer_name := 'عميل جديد';
        END;
        IF customer_name IS NULL THEN
            customer_name := 'عميل (ضيف)';
        END IF;
        FOR admin_id IN (SELECT id FROM public.profiles WHERE role = 'admin') LOOP
            INSERT INTO public.notifications (user_id, title, message, type, link)
            VALUES (admin_id, 'رسالة جديدة من ' || customer_name, NEW.message_text, 'chat',
                    '/chat-admin.html?session=' || NEW.session_id);
        END LOOP;
    END IF;
    RETURN NEW;
END;
$function$;
CREATE TRIGGER on_new_chat_message AFTER INSERT ON public.chat_messages
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_chat_message();
CREATE OR REPLACE FUNCTION public.notify_admin_on_new_chat()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  admin_record record;
  customer_name text;
begin
  begin
    select full_name into customer_name from profiles where id = new.user_id;
  exception when others then
    customer_name := 'زائر';
  end;
  if customer_name is null then
    customer_name := 'زائر';
  end if;
  for admin_record in
    select id from profiles where role = 'admin'
  loop
    insert into notifications (user_id, title, message, type, link)
    values (admin_record.id, 'محادثة جديدة', 'العميل ' || customer_name || ' بدأ محادثة جديدة الآن', 'info',
            'chat-admin.html?session=' || new.id);
  end loop;
  return new;
end;
$function$;
CREATE TRIGGER tr_on_new_chat AFTER INSERT ON public.chat_sessions
  FOR EACH ROW EXECUTE FUNCTION public.notify_admin_on_new_chat();

-- Supabase بيمنح EXECUTE تلقائيًا لـ anon/authenticated/service_role على أي
-- دالة جديدة. لو 064 نسيت تسحبها، الاختبار لازم يمسكها.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

-- عملاء Core: C3 / C4 من غير أي جلسة قديمة. C2 عنده جلسة موقع قديمة نشطة (002).
INSERT INTO public.profiles (id, email, full_name, role) VALUES
  ('00000000-0000-4000-8000-0000000000c3', 'c3@t', 'عميل تلاتة', 'user'),
  ('00000000-0000-4000-8000-0000000000c4', 'c4@t', 'عميل أربعة', 'user');
-- جلسة تيليجرام قديمة (المسار القديم: guest_id = channel:telegram:<chat>) لـ C4.
INSERT INTO public.chat_sessions (id, user_id, guest_id) VALUES
  ('5e550000-0000-4000-8000-0000000000a4', '00000000-0000-4000-8000-0000000000c4', 'channel:telegram:777');

CREATE OR REPLACE FUNCTION t.ingest(p_channel text, p_user uuid, p_thread text, p_ext text, p_text text)
RETURNS jsonb LANGUAGE plpgsql AS $$
begin
  return public.conv_ingest_message(p_channel, p_user, p_thread, p_ext, p_text,
           jsonb_build_array(jsonb_build_object('type', 'text', 'text', p_text)));
end $$;
CREATE OR REPLACE FUNCTION t.b(j jsonb, k text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  select coalesce((j->>k)::boolean, false); $$;
CREATE OR REPLACE FUNCTION t.events(p uuid, p_kind text) RETURNS int LANGUAGE sql SECURITY DEFINER AS $$
  select count(*)::int from public.inbox_events where session_id = p and kind = p_kind; $$;
CREATE OR REPLACE FUNCTION t.version(p uuid) RETURNS int LANGUAGE plpgsql SECURITY DEFINER AS $$
begin
  return (select state_version from public.chat_sessions where id = p);
end $$;
CREATE OR REPLACE FUNCTION t.tickets() RETURNS int LANGUAGE sql SECURITY DEFINER AS $$
  select count(*)::int from public.tickets; $$;
CREATE OR REPLACE FUNCTION t.svc_conn(p_name text) RETURNS void LANGUAGE plpgsql AS $$
begin
  perform t.conn(p_name);
  perform t.dblink_exec(p_name, s) from (values
    ($s$set request.jwt.claim.sub = ''$s$), ($s$set request.jwt.claim.role = 'service_role'$s$),
    ('set role service_role'), ($s$set lock_timeout = '5s'$s$)) q(s);
end $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;

-- لقطة قبل 064 (للتراجع)
CREATE TABLE public._t_before_064 AS
  SELECT (SELECT count(*) FROM public.chat_messages) AS msgs,
         (SELECT count(*) FROM public.chat_sessions) AS sessions,
         (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'inbox_events_kind_check') AS kind_check;

-- ══ Ⓐ قبل 064: مفيش ضمان ═════════════════════════════════════════════════
-- المسار القديم (channel-session.js): بحث ثم إدراج. نفس رسالة تيليجرام مرتين
-- ⇒ صفين، ومحادثتين نشطتين لنفس الـ chat ممكن تتفتحوا.
DO $$
DECLARE n int;
BEGIN
  INSERT INTO public.chat_sessions (user_id, guest_id) VALUES
    ('00000000-0000-4000-8000-0000000000c3', 'channel:telegram:legacy-race'),
    ('00000000-0000-4000-8000-0000000000c3', 'channel:telegram:legacy-race');
  SELECT count(*) INTO n FROM public.chat_sessions
   WHERE user_id = '00000000-0000-4000-8000-0000000000c3' AND guest_id = 'channel:telegram:legacy-race' AND status = 'active';
  IF n IS DISTINCT FROM 2 THEN RAISE EXCEPTION 'FAIL A1: توقعنا إن قبل 064 مفيش قيد (n=%)', n; END IF;
  UPDATE public.chat_sessions SET status = 'closed'
   WHERE user_id = '00000000-0000-4000-8000-0000000000c3' AND guest_id = 'channel:telegram:legacy-race';
  IF to_regprocedure('public.conv_ingest_message(text, uuid, text, text, text, jsonb, jsonb, uuid, interval)') IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL A2: الدالة موجودة قبل 064';
  END IF;
  RAISE NOTICE 'PASS A: قبل 064 — محادثتين نشطتين لنفس الـ chat ممكنين، ومفيش حد ذري';
END $$;

\i migrations/064_conversation_core.sql

-- ══ Ⓑ الشكل: أعلام مقفولة، صلاحيات، أعمدة محمية ════════════════════════════
DO $$
DECLARE f text;
BEGIN
  IF (SELECT count(*) FROM public.sie_settings WHERE key IN ('core_ingest_website', 'core_ingest_telegram', 'agent_runtime_enabled')
        AND value = 'false'::jsonb) IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'FAIL B1: الأعلام مش التلاتة مقفولين';
  END IF;
  FOREACH f IN ARRAY ARRAY['public.conv_ingest_message(text, uuid, text, text, text, jsonb, jsonb, uuid, interval)',
                           'public.conv_commit_turn(uuid, integer, text, text, jsonb, jsonb, text, boolean, jsonb, text)',
                           'public.conv_claim_delivery(uuid, interval)', 'public.conv_record_delivery(uuid, text, text, text, integer)',
                           'public._conv_json(public.chat_sessions)', 'public.conv_assign_seq()',
                           'public.conv_log_message_event()', 'public.guard_conversation_core_columns()'] LOOP
    IF has_function_privilege('authenticated', f, 'EXECUTE') OR has_function_privilege('anon', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'FAIL B2: % متاحة لعميل', f;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM public.chat_messages WHERE seq IS NOT NULL) THEN
    RAISE EXCEPTION 'FAIL B3: الرسايل القديمة اتعدّلت (seq)';
  END IF;
  RAISE NOTICE 'PASS B1: الأعلام التلاتة مقفولة، conv_* لـ service_role بس، والرسايل القديمة ماتلمستش';
END $$;

SET ROLE authenticated;
SELECT t.act('00000000-0000-4000-8000-0000000000c1');
DO $$
BEGIN
  IF NOT t.fails($q$select public.conv_ingest_message('website', '00000000-0000-4000-8000-0000000000c1', '', 'x1', 'hi')$q$, '42501') THEN
    RAISE EXCEPTION 'FAIL B4: العميل نادى conv_ingest_message';
  END IF;
  IF NOT t.fails($q$insert into public.chat_messages (session_id, sender_id, message_text, external_id)
                   values ('5e550000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1', 'x', 'claim')$q$, '42501') THEN
    RAISE EXCEPTION 'FAIL B5: العميل كتب external_id';
  END IF;
  IF NOT t.fails($q$update public.chat_sessions set state_version = 99 where id = '5e550000-0000-4000-8000-000000000001'$q$, '42501') THEN
    RAISE EXCEPTION 'FAIL B6: العميل عدّل state_version';
  END IF;
  IF NOT t.fails($q$update public.chat_sessions set channel = 'telegram', external_thread_id = '1' where id = '5e550000-0000-4000-8000-000000000001'$q$, '42501') THEN
    RAISE EXCEPTION 'FAIL B7: العميل عدّل channel';
  END IF;
  IF NOT t.fails($q$insert into public.chat_sessions (user_id, channel, external_thread_id) values ('00000000-0000-4000-8000-0000000000c1', 'website', '')$q$, '42501') THEN
    RAISE EXCEPTION 'FAIL B8: العميل أنشأ محادثة Core';
  END IF;
  -- المسار القديم: رسالة عميل عادية لسه شغالة، وبتاخد seq.
  IF NOT t.succeeds($q$insert into public.chat_messages (session_id, sender_id, message_text)
                      values ('5e550000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1', 'رسالة عادية')$q$) THEN
    RAISE EXCEPTION 'FAIL B9: رسالة العميل العادية اترفضت';
  END IF;
  RAISE NOTICE 'PASS B2: العميل مايقدرش ينادي conv_* ولا يكتب أعمدة Core، ورسالته العادية شغالة';
END $$;
RESET ROLE;

-- ══ Ⓒ1 نفس الرسالة مرتين ⇒ رسالة واحدة ═══════════════════════════════════
-- (واتساب نفسه: tests/sql/whatsapp-inbound-idempotency.test.sql — 063)
SELECT t.as_service();
SET ROLE service_role;
DO $$
DECLARE r1 jsonb; r2 jsonb; sid uuid;
BEGIN
  r1 := t.ingest('telegram', '00000000-0000-4000-8000-0000000000c3', '9001', 'tg:9001:1', 'السلام عليكم');
  r2 := t.ingest('telegram', '00000000-0000-4000-8000-0000000000c3', '9001', 'tg:9001:1', 'السلام عليكم');
  sid := (r1->'conversation'->>'id')::uuid;
  IF NOT t.b(r1, 'created') OR t.b(r2, 'created') OR NOT t.b(r2, 'duplicate')
     OR r2->'message'->>'id' IS DISTINCT FROM r1->'message'->>'id' OR t.msgs(sid) IS DISTINCT FROM 1
     OR (r1->'message'->>'seq')::int IS DISTINCT FROM 1 OR r1->>'owner' IS DISTINCT FROM 'agent'
     OR (r2->>'stateVersion')::int IS DISTINCT FROM (r1->>'stateVersion')::int THEN
    RAISE EXCEPTION 'FAIL C1: % / %', r1, r2;
  END IF;
  IF r1->'conversation'->>'resolution' IS DISTINCT FROM 'created' OR t.events(sid, 'message_received') IS DISTINCT FROM 1
     OR t.events(sid, 'conversation_created') IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL C1b: % (events %/%)', r1, t.events(sid, 'message_received'), t.events(sid, 'conversation_created');
  END IF;
  RAISE NOTICE 'PASS C1: نفس الرسالة مرتين ⇒ صف واحد، التانية created=false (ولا وكيل يشتغل)، النسخة ماتغيرتش';
END $$;
RESET ROLE;

-- ══ Ⓒ2 نفس الرسالة من اتصالين في نفس اللحظة ⇒ تنفيذ وكيل واحد ════════════
SELECT t.svc_conn('w1'), t.svc_conn('w2');
DO $$
DECLARE busy int; a jsonb; b jsonb; sid uuid;
BEGIN
  PERFORM t.dblink_exec('w1', 'begin');
  SELECT x::jsonb INTO a FROM t.dblink('w1', $s$select t.ingest('telegram', '00000000-0000-4000-8000-0000000000c3', '9002', 'tg:9002:1', 'مرحبا')::text$s$) AS r(x text);
  PERFORM t.dblink_send_query('w2', $s$select t.ingest('telegram', '00000000-0000-4000-8000-0000000000c3', '9002', 'tg:9002:1', 'مرحبا')::text$s$);
  PERFORM pg_sleep(0.4);
  busy := t.dblink_is_busy('w2');
  IF busy IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'FAIL C2a: الاتصال التاني ماستناش (busy=%)', busy; END IF;
  PERFORM t.dblink_exec('w1', 'commit');
  SELECT x::jsonb INTO b FROM t.dblink_get_result('w2') AS r(x text);
  PERFORM * FROM t.dblink_get_result('w2', false) AS r(x text);
  sid := (a->'conversation'->>'id')::uuid;
  IF NOT t.b(a, 'created') OR t.b(b, 'created') OR t.msgs(sid) IS DISTINCT FROM 1
     OR (SELECT count(*) FROM public.chat_sessions WHERE external_thread_id = '9002') IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL C2b: % / %', a, b;
  END IF;
  RAISE NOTICE 'PASS C2: اتصالين بنفس الرسالة في نفس اللحظة ⇒ التاني استنى وطلع created=false ⇒ وكيل واحد بس';
END $$;

-- لو الأول اترجع (rollback)، التاني هو اللي يكسب — مفيش رسالة ضايعة.
DO $$
DECLARE a jsonb; b jsonb;
BEGIN
  PERFORM t.dblink_exec('w1', 'begin');
  SELECT x::jsonb INTO a FROM t.dblink('w1', $s$select t.ingest('telegram', '00000000-0000-4000-8000-0000000000c3', '9002', 'tg:9002:2', 'تانية')::text$s$) AS r(x text);
  PERFORM t.dblink_send_query('w2', $s$select t.ingest('telegram', '00000000-0000-4000-8000-0000000000c3', '9002', 'tg:9002:2', 'تانية')::text$s$);
  PERFORM pg_sleep(0.3);
  PERFORM t.dblink_exec('w1', 'rollback');
  SELECT x::jsonb INTO b FROM t.dblink_get_result('w2') AS r(x text);
  PERFORM * FROM t.dblink_get_result('w2', false) AS r(x text);
  IF NOT t.b(b, 'created') OR (SELECT count(*) FROM public.chat_messages WHERE external_id = 'tg:9002:2') IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL C2c: % / %', a, b;
  END IF;
  RAISE NOTICE 'PASS C2b: الأول اترجع ⇒ التاني اتخزّن (مفيش رسالة ضايعة)';
END $$;

-- ══ Ⓒ6 إنشاء المحادثة من اتصالين ⇒ محادثة واحدة ═════════════════════════
DO $$
DECLARE a jsonb; b jsonb;
BEGIN
  PERFORM t.dblink_exec('w1', 'begin');
  SELECT x::jsonb INTO a FROM t.dblink('w1', $s$select t.ingest('telegram', '00000000-0000-4000-8000-0000000000c3', '9003', 'tg:9003:1', 'أ')::text$s$) AS r(x text);
  PERFORM t.dblink_send_query('w2', $s$select t.ingest('telegram', '00000000-0000-4000-8000-0000000000c3', '9003', 'tg:9003:2', 'ب')::text$s$);
  PERFORM pg_sleep(0.3);
  PERFORM t.dblink_exec('w1', 'commit');
  SELECT x::jsonb INTO b FROM t.dblink_get_result('w2') AS r(x text);
  PERFORM * FROM t.dblink_get_result('w2', false) AS r(x text);
  IF a->'conversation'->>'id' IS DISTINCT FROM b->'conversation'->>'id'
     OR (SELECT count(*) FROM public.chat_sessions WHERE user_id = '00000000-0000-4000-8000-0000000000c3' AND external_thread_id = '9003') IS DISTINCT FROM 1
     OR a->'conversation'->>'resolution' IS DISTINCT FROM 'created' OR b->'conversation'->>'resolution' IS DISTINCT FROM 'existing'
     OR (a->'message'->>'seq')::int IS DISTINCT FROM 1 OR (b->'message'->>'seq')::int IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'FAIL C6: % / %', a, b;
  END IF;
  RAISE NOTICE 'PASS C6: رسالتين أول مرة في نفس اللحظة ⇒ محادثة واحدة، seq 1 و 2';
END $$;
-- الشبكة تحت القفل: محادثة نشطة تانية لنفس المفتاح مرفوضة من القيد نفسه.
DO $$
BEGIN
  IF NOT t.fails($q$insert into public.chat_sessions (user_id, channel, external_thread_id)
                   values ('00000000-0000-4000-8000-0000000000c3', 'telegram', '9003')$q$, '23505') THEN
    RAISE EXCEPTION 'FAIL C6b: القيد الفريد للمحادثة النشطة مش شغال';
  END IF;
  RAISE NOTICE 'PASS C6b: القيد الفريد بيمنع محادثة نشطة تانية لنفس (user, channel, thread)';
END $$;

-- تبنّي الجلسة القديمة بدل إنشاء جديدة: موقع (C2، جلسة 002) وتيليجرام (C4، 777).
SET ROLE service_role;
DO $$
DECLARE w jsonb; tg jsonb;
BEGIN
  w := t.ingest('website', '00000000-0000-4000-8000-0000000000c2', '', 'web:c2:1', 'سؤال');
  tg := public.conv_ingest_message('telegram', '00000000-0000-4000-8000-0000000000c4', '777', 'tg:777:1', 'هاي',
          '[]'::jsonb, '{}'::jsonb, null, interval '24 hours');
  IF w->'conversation'->>'id' IS DISTINCT FROM '5e550000-0000-4000-8000-000000000002' OR w->'conversation'->>'resolution' IS DISTINCT FROM 'adopted'
     OR tg->'conversation'->>'id' IS DISTINCT FROM '5e550000-0000-4000-8000-0000000000a4' OR tg->'conversation'->>'resolution' IS DISTINCT FROM 'adopted' THEN
    RAISE EXCEPTION 'FAIL C6c: % / %', w, tg;
  END IF;
  -- seq بيكمل بعد رسايل قديمة (NULL) — والقديمة ماتلمستش.
  IF (w->'message'->>'seq')::int IS DISTINCT FROM 1 OR (SELECT count(*) FROM public.chat_messages WHERE session_id = '5e550000-0000-4000-8000-000000000002' AND seq IS NULL) IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL C6d: %', w;
  END IF;
  RAISE NOTICE 'PASS C6c: الجلسة القديمة النشطة اتبنّت (موقع + تيليجرام) — نفس السجل اللي الدعم شايفه';
END $$;
RESET ROLE;

-- ══ Ⓒ3 رسالتين في نفس اللحظة ⇒ مفيش حالة ضايعة ══════════════════════════
DO $$
DECLARE a jsonb; b jsonb; sid uuid; ca jsonb; cb jsonb;
BEGIN
  PERFORM t.dblink_exec('w1', 'begin');
  SELECT x::jsonb INTO a FROM t.dblink('w1', $s$select t.ingest('telegram', '00000000-0000-4000-8000-0000000000c3', '9004', 'tg:9004:1', 'واحد')::text$s$) AS r(x text);
  PERFORM t.dblink_send_query('w2', $s$select t.ingest('telegram', '00000000-0000-4000-8000-0000000000c3', '9004', 'tg:9004:2', 'اتنين')::text$s$);
  PERFORM pg_sleep(0.3);
  PERFORM t.dblink_exec('w1', 'commit');
  SELECT x::jsonb INTO b FROM t.dblink_get_result('w2') AS r(x text);
  PERFORM * FROM t.dblink_get_result('w2', false) AS r(x text);
  sid := (a->'conversation'->>'id')::uuid;
  IF (b->>'stateVersion')::int IS DISTINCT FROM (a->>'stateVersion')::int + 1 THEN
    RAISE EXCEPTION 'FAIL C3a: النسختين % / %', a->>'stateVersion', b->>'stateVersion';
  END IF;
  -- وكيلين بيكتبوا حالة، كل واحد بالنسخة اللي شافها من ingest بتاعه.
  SET LOCAL ROLE service_role;
  ca := public.conv_commit_turn(sid, (a->>'stateVersion')::int, 'turn-a', 'رد على واحد', '[]', '{"sie":{"from":"a"}}');
  cb := public.conv_commit_turn(sid, (b->>'stateVersion')::int, 'turn-b', 'رد على الاتنين', '[]', '{"sie":{"from":"b"}}');
  IF t.b(ca, 'committed') OR ca->>'reason' IS DISTINCT FROM 'version_conflict' OR NOT t.b(cb, 'committed')
     OR t.state(sid)->'sie'->>'from' IS DISTINCT FROM 'b' OR t.bot_count(sid) IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL C3b: % / % / %', ca, cb, t.state(sid);
  END IF;
  RAISE NOTICE 'PASS C3: رسالتين متزامنتين ⇒ نسختين متتاليتين؛ دور الرسالة الأقدم اترفض (version_conflict) والأحدث اتثبّت — مفيش كتابة فوق كتابة';
END $$;

-- وكيلين بنفس النسخة على اتصالين ⇒ واحد بس يتثبّت.
DO $$
DECLARE sid uuid; v int; a jsonb; b jsonb;
BEGIN
  SELECT id INTO sid FROM public.chat_sessions WHERE external_thread_id = '9004';
  v := t.version(sid);
  PERFORM t.dblink_exec('w1', 'begin');
  SELECT x::jsonb INTO a FROM t.dblink('w1', format($s$select public.conv_commit_turn(%L, %s, 'race-1', 'رد 1', '[]', '{"sie":{"r":1}}')::text$s$, sid, v)) AS r(x text);
  PERFORM t.dblink_send_query('w2', format($s$select public.conv_commit_turn(%L, %s, 'race-2', 'رد 2', '[]', '{"sie":{"r":2}}')::text$s$, sid, v));
  PERFORM pg_sleep(0.3);
  IF t.dblink_is_busy('w2') IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'FAIL C3c: التاني ماستناش قفل الجلسة'; END IF;
  PERFORM t.dblink_exec('w1', 'commit');
  SELECT x::jsonb INTO b FROM t.dblink_get_result('w2') AS r(x text);
  PERFORM * FROM t.dblink_get_result('w2', false) AS r(x text);
  IF NOT t.b(a, 'committed') OR t.b(b, 'committed') OR b->>'reason' IS DISTINCT FROM 'version_conflict'
     OR t.state(sid)->'sie'->>'r' IS DISTINCT FROM '1' OR t.version(sid) IS DISTINCT FROM v + 1 THEN
    RAISE EXCEPTION 'FAIL C3d: % / %', a, b;
  END IF;
  RAISE NOTICE 'PASS C3b: commitTurn متزامنين بنفس النسخة ⇒ واحد اتثبّت والتاني version_conflict';
END $$;

-- ══ Ⓒ4 نسخة قديمة ⇒ فشل ومفيش أي أثر ═════════════════════════════════════
SET ROLE service_role;
DO $$
DECLARE sid uuid; v int; r jsonb; msgs int; tk int; st jsonb;
BEGIN
  SELECT id INTO sid FROM public.chat_sessions WHERE external_thread_id = '9004';
  v := t.version(sid); msgs := t.msgs(sid); tk := t.tickets(); st := t.state(sid);
  r := public.conv_commit_turn(sid, v - 1, 'stale-1', 'رد قديم', '[]', '{"sie":{"stale":true}}', 'sie', true,
         '{"category":"فوترة","description":"x"}', 'angry');
  IF t.b(r, 'committed') OR r->>'reason' IS DISTINCT FROM 'version_conflict' OR t.msgs(sid) IS DISTINCT FROM msgs
     OR t.tickets() IS DISTINCT FROM tk OR t.state(sid) IS DISTINCT FROM st OR t.version(sid) IS DISTINCT FROM v OR t.manual(sid) THEN
    RAISE EXCEPTION 'FAIL C4: %', r;
  END IF;
  RAISE NOTICE 'PASS C4: commitTurn بنسخة قديمة ⇒ version_conflict، ولا رد ولا تذكرة ولا حالة ولا تسليم';
END $$;
RESET ROLE;

-- ══ Ⓒ5 استلام إنسان أثناء تنفيذ الوكيل ⇒ commit الوكيل يفشل ═════════════════
-- (أ) الاستلام خلص قبل ما الوكيل يثبّت
DO $$
DECLARE r jsonb; sid uuid; v int; tk int;
BEGIN
  SET LOCAL ROLE service_role;
  r := t.ingest('telegram', '00000000-0000-4000-8000-0000000000c3', '9005', 'tg:9005:1', 'عايز حد');
  sid := (r->'conversation'->>'id')::uuid; v := (r->>'stateVersion')::int; tk := t.tickets();
  RESET ROLE;
  -- الأدمن المرتفع استلم من الصندوق (المسار الرسمي 059/060)
  SET LOCAL ROLE authenticated;
  PERFORM t.act('00000000-0000-4000-8000-0000000000e1');
  PERFORM public.inbox_take_over(sid, 'test');
  RESET ROLE;
  PERFORM t.as_service();
  SET LOCAL ROLE service_role;
  r := public.conv_commit_turn(sid, v, 'late-1', 'رد البوت', '[]', '{"sie":{"x":1}}', 'sie', true, '{"category":"دعم"}');
  RESET ROLE;
  IF t.b(r, 'committed') OR r->>'reason' IS DISTINCT FROM 'human_owner' OR t.bot_count(sid) IS DISTINCT FROM 0 OR t.tickets() IS DISTINCT FROM tk
     OR t.state(sid) IS DISTINCT FROM '{}'::jsonb OR t.events(sid, 'handoff_to_human') IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL C5a: %', r;
  END IF;
  RAISE NOTICE 'PASS C5a: الإنسان استلم ⇒ commit الوكيل human_owner، ولا رد ولا تذكرة ولا حالة';
END $$;

-- (ب) الاستلام شغال على اتصال تاني في نفس لحظة الـ commit
SELECT t.conn('admin1');
SELECT t.dblink_exec('admin1', s) FROM (VALUES
  ($s$set request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000e1'$s$),
  ($s$set request.jwt.claim.role = 'authenticated'$s$), ('set role authenticated'), ($s$set lock_timeout = '5s'$s$)) q(s);
-- المحادثة لازم تكون متثبّتة قبل ما الاتصال التاني يشوفها.
CREATE TABLE t.ctx (k text PRIMARY KEY, v jsonb);
GRANT SELECT, INSERT ON t.ctx TO service_role;
SET ROLE service_role;
INSERT INTO t.ctx SELECT 'c5b', t.ingest('telegram', '00000000-0000-4000-8000-0000000000c3', '9006', 'tg:9006:1', 'مشكلة');
RESET ROLE;
DO $$
DECLARE r jsonb; sid uuid; v int; c jsonb;
BEGIN
  SELECT ctx.v INTO r FROM t.ctx WHERE k = 'c5b';
  sid := (r->'conversation'->>'id')::uuid; v := (r->>'stateVersion')::int;
  PERFORM t.dblink_exec('admin1', 'begin');
  PERFORM * FROM t.dblink('admin1', format('select public.inbox_take_over(%L, %L)::text', sid, 'live')) AS q(x text);
  PERFORM t.dblink_send_query('w1', format($s$select public.conv_commit_turn(%L, %s, 'live-1', 'رد', '[]', '{"sie":{"y":1}}', 'sie', true, '{"category":"دعم"}')::text$s$, sid, v));
  PERFORM pg_sleep(0.4);
  IF t.dblink_is_busy('w1') IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'FAIL C5b: commit الوكيل ماستناش الاستلام'; END IF;
  PERFORM t.dblink_exec('admin1', 'commit');
  SELECT x::jsonb INTO c FROM t.dblink_get_result('w1') AS q(x text);
  PERFORM * FROM t.dblink_get_result('w1', false) AS q(x text);
  IF t.b(c, 'committed') OR c->>'reason' IS DISTINCT FROM 'human_owner' OR t.bot_count(sid) IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL C5c: %', c;
  END IF;
  RAISE NOTICE 'PASS C5b: استلام متزامن مع commit ⇒ الوكيل استنى القفل وطلع human_owner — الإنسان كسب';
END $$;

-- (ج) استلم ورجّع للبوت قبل ما الوكيل يخلص ⇒ النسخة اتغيرت ⇒ برضه يفشل.
DO $$
DECLARE r jsonb; sid uuid; v int;
BEGIN
  SET LOCAL ROLE service_role;
  r := t.ingest('telegram', '00000000-0000-4000-8000-0000000000c3', '9007', 'tg:9007:1', 'سؤال');
  RESET ROLE;
  sid := (r->'conversation'->>'id')::uuid; v := (r->>'stateVersion')::int;
  PERFORM public._handoff_set(sid, true, 'test', 'test', null);
  PERFORM public._handoff_set(sid, false, 'test', 'test', null);
  SET LOCAL ROLE service_role;
  r := public.conv_commit_turn(sid, v, 'bounce-1', 'رد', '[]', '{}');
  RESET ROLE;
  IF t.b(r, 'committed') OR r->>'reason' IS DISTINCT FROM 'version_conflict' OR t.version(sid) IS DISTINCT FROM v + 2
     OR t.events(sid, 'handoff_to_ai') IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL C5d: %', r;
  END IF;
  RAISE NOTICE 'PASS C5c: استلام ثم إرجاع أثناء الدور ⇒ النسخة زادت ⇒ الدور القديم مايتثبّتش';
END $$;

-- ══ Ⓒ7 إعادة محاولة الإرسال ⇒ مفيش رسالة صادرة تانية ═══════════════════════
SET ROLE service_role;
DO $$
DECLARE r jsonb; sid uuid; v int; c1 jsonb; c2 jsonb; mid uuid;
BEGIN
  r := t.ingest('telegram', '00000000-0000-4000-8000-0000000000c3', '9008', 'tg:9008:1', 'ممكن مساعدة');
  sid := (r->'conversation'->>'id')::uuid; v := (r->>'stateVersion')::int;
  c1 := public.conv_commit_turn(sid, v, 'out-1', 'أكيد', '[]', '{"sie":{"t":1}}', 'sie', true, '{"category":"فوترة","description":"d"}');
  -- الـ runtime وقع بعد الـ commit وأعاد المحاولة بنفس الدور (والنسخة القديمة)
  c2 := public.conv_commit_turn(sid, v, 'out-1', 'أكيد', '[]', '{"sie":{"t":1}}', 'sie', true, '{"category":"فوترة","description":"d"}');
  mid := (c1->>'messageId')::uuid;
  IF NOT t.b(c1, 'committed') OR NOT t.b(c2, 'duplicate') OR c2->>'messageId' IS DISTINCT FROM c1->>'messageId'
     OR t.bot_count(sid) IS DISTINCT FROM 1 OR (SELECT count(*) FROM public.tickets WHERE description = 'd') IS DISTINCT FROM 1
     OR c1->>'deliveryState' IS DISTINCT FROM 'pending' OR c1->>'ticketNumber' IS NULL THEN
    RAISE EXCEPTION 'FAIL C7a: % / %', c1, c2;
  END IF;
  c1 := public.conv_claim_delivery(mid);
  c2 := public.conv_claim_delivery(mid);
  IF NOT t.b(c1, 'claimed') OR t.b(c2, 'claimed') OR c2->>'deliveryState' IS DISTINCT FROM 'sending' THEN
    RAISE EXCEPTION 'FAIL C7b: % / %', c1, c2;
  END IF;
  -- فشل ⇒ إعادة المطالبة على نفس الصف (المحاولة 2)، ثم وصل.
  PERFORM public.conv_record_delivery(mid, 'failed', null, 'timeout', (c1->>'attempt')::int);
  c1 := public.conv_claim_delivery(mid);
  PERFORM public.conv_record_delivery(mid, 'sent', 'tg-msg-55', null, (c1->>'attempt')::int);
  c2 := public.conv_claim_delivery(mid);
  IF (c1->>'attempt')::int IS DISTINCT FROM 2 OR t.b(c2, 'claimed') OR c2->>'providerMessageId' IS DISTINCT FROM 'tg-msg-55'
     OR t.bot_count(sid) IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL C7c: % / %', c1, c2;
  END IF;
  -- للأمام بس: delivered مرتين = مرة، و sent بعد delivered مالوش أثر، و failed بعد sent مرفوض.
  -- (بالترتيب: OR في SQL مالوش ترتيب تقييم مضمون)
  c1 := public.conv_record_delivery(mid, 'delivered');
  c2 := public.conv_record_delivery(mid, 'delivered');
  r := public.conv_record_delivery(mid, 'sent', null, null, 2);
  IF NOT t.b(c1, 'updated') OR t.b(c2, 'updated') OR t.b(r, 'updated')
     OR t.b(public.conv_record_delivery(mid, 'failed', null, null, 2), 'updated')
     OR (SELECT delivery_state FROM public.chat_messages WHERE id = mid) IS DISTINCT FROM 'delivered' THEN
    RAISE EXCEPTION 'FAIL C7d: % / % / %', c1, c2, r;
  END IF;
  RAISE NOTICE 'PASS C7: إعادة commit بنفس الدور ⇒ نفس الرسالة (ولا تذكرة تانية)؛ مطالبة إرسال واحدة؛ الفشل يعيد نفس الصف؛ بعد الإرسال مفيش مطالبة';
END $$;
RESET ROLE;

-- مطالبتين متزامنتين ⇒ واحدة بس
SET ROLE service_role;
INSERT INTO t.ctx SELECT 'c7b', t.ingest('telegram', '00000000-0000-4000-8000-0000000000c3', '9009', 'tg:9009:1', 'x');
INSERT INTO t.ctx SELECT 'c7b-turn', public.conv_commit_turn((v->'conversation'->>'id')::uuid, (v->>'stateVersion')::int,
  'out-2', 'y', '[]', null, 'sie', true) FROM t.ctx WHERE k = 'c7b';
RESET ROLE;
DO $$
DECLARE mid uuid; a jsonb; b jsonb;
BEGIN
  SELECT (v->>'messageId')::uuid INTO mid FROM t.ctx WHERE k = 'c7b-turn';
  PERFORM t.dblink_exec('w1', 'begin');
  SELECT x::jsonb INTO a FROM t.dblink('w1', format('select public.conv_claim_delivery(%L)::text', mid)) AS q(x text);
  PERFORM t.dblink_send_query('w2', format('select public.conv_claim_delivery(%L)::text', mid));
  PERFORM pg_sleep(0.3);
  PERFORM t.dblink_exec('w1', 'commit');
  SELECT x::jsonb INTO b FROM t.dblink_get_result('w2') AS q(x text);
  PERFORM * FROM t.dblink_get_result('w2', false) AS q(x text);
  IF NOT t.b(a, 'claimed') OR t.b(b, 'claimed') THEN
    RAISE EXCEPTION 'FAIL C7e: % / %', a, b;
  END IF;
  RAISE NOTICE 'PASS C7b: مُرسلين في نفس اللحظة ⇒ واحد بس طالب الرسالة';
END $$;

-- مُرسل انتهت مهلته وتقريره وصل بعد ما مُرسل تاني طالب الرسالة ⇒ تقريره مالوش أثر.
SET ROLE service_role;
DO $$
DECLARE mid uuid; a jsonb; b jsonb; late jsonb; ok jsonb;
BEGIN
  SELECT (v->>'messageId')::uuid INTO mid FROM t.ctx WHERE k = 'c7b-turn';
  a := (SELECT jsonb_build_object('attempt', delivery_attempts) FROM public.chat_messages WHERE id = mid);
  RESET ROLE;
  UPDATE public.chat_messages SET delivery_updated_at = now() - interval '10 minutes' WHERE id = mid;
  SET LOCAL ROLE service_role;
  b := public.conv_claim_delivery(mid);
  late := public.conv_record_delivery(mid, 'failed', null, 'old sender timed out', (a->>'attempt')::int);
  IF NOT t.b(b, 'claimed') OR (b->>'attempt')::int IS DISTINCT FROM (a->>'attempt')::int + 1
     OR t.b(late, 'updated') OR (SELECT delivery_state FROM public.chat_messages WHERE id = mid) IS DISTINCT FROM 'sending' THEN
    RAISE EXCEPTION 'FAIL C7f: % / % / %', a, b, late;
  END IF;
  IF NOT t.fails(format($q$select public.conv_record_delivery(%L, 'sent')$q$, mid), '22023') THEN
    RAISE EXCEPTION 'FAIL C7g: sent من غير رقم محاولة اتقبل';
  END IF;
  ok := public.conv_record_delivery(mid, 'sent', 'p-2', null, (b->>'attempt')::int);
  IF NOT t.b(ok, 'updated') OR (SELECT delivery_state FROM public.chat_messages WHERE id = mid) IS DISTINCT FROM 'sent' THEN
    RAISE EXCEPTION 'FAIL C7h: %', ok;
  END IF;
  RAISE NOTICE 'PASS C7c: تقرير متأخر من محاولة قديمة مالوش أثر؛ المحاولة الحالية بس تسجّل sent/failed';
END $$;
RESET ROLE;

-- ══ Ⓒ8 الترتيب من أي مسار ═══════════════════════════════════════════════
-- رسالتين قديمتين (مش Core، مفيش قفل استشاري) لنفس الجلسة في نفس اللحظة ⇒
-- seq متتالي، مش تصادم.
DO $$
DECLARE a text; b text; s1 bigint; s2 bigint;
BEGIN
  PERFORM t.dblink_exec('w1', 'begin');
  SELECT x INTO a FROM t.dblink('w1', $s$insert into public.chat_messages (session_id, message_text)
    values ('5e550000-0000-4000-8000-000000000003', 'متزامنة 1') returning seq::text$s$) AS q(x text);
  PERFORM t.dblink_send_query('w2', $s$insert into public.chat_messages (session_id, message_text)
    values ('5e550000-0000-4000-8000-000000000003', 'متزامنة 2') returning seq::text$s$);
  PERFORM pg_sleep(0.3);
  IF t.dblink_is_busy('w2') IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'FAIL C8a: التاني ماستناش قفل الترتيب'; END IF;
  PERFORM t.dblink_exec('w1', 'commit');
  SELECT x INTO b FROM t.dblink_get_result('w2') AS q(x text);
  PERFORM * FROM t.dblink_get_result('w2', false) AS q(x text);
  IF b IS NULL OR b::bigint IS DISTINCT FROM a::bigint + 1 THEN
    RAISE EXCEPTION 'FAIL C8b: % / %', a, b;
  END IF;
  RAISE NOTICE 'PASS C8: رسالتين قديمتين متزامنتين ⇒ seq % و % (التاني استنى قفل الجلسة)', a, b;
END $$;
DO $$
DECLARE m public.chat_messages; mx bigint;
BEGIN
  SELECT max(seq) INTO mx FROM public.chat_messages WHERE session_id = '5e550000-0000-4000-8000-000000000003';
  INSERT INTO public.chat_messages (session_id, message_text, seq)
    VALUES ('5e550000-0000-4000-8000-000000000003', 'seq مزيّف', 999) RETURNING * INTO m;
  IF m.seq IS DISTINCT FROM mx + 1 THEN RAISE EXCEPTION 'FAIL C8c: seq من المُدرِج اتقبل (%)', m.seq; END IF;
  -- مرسل مش في profiles (زائر/قناة): الرسالة تتخزّن والحدث من غير فاعل.
  INSERT INTO public.chat_messages (session_id, sender_id, message_text)
    VALUES ('5e550000-0000-4000-8000-000000000003', '99999999-0000-4000-8000-000000000000', 'زائر') RETURNING * INTO m;
  IF (SELECT actor_id FROM public.inbox_events WHERE payload->>'message_id' = m.id::text) IS NOT NULL
     OR NOT EXISTS (SELECT 1 FROM public.inbox_events WHERE payload->>'message_id' = m.id::text AND kind = 'message_received') THEN
    RAISE EXCEPTION 'FAIL C8d';
  END IF;
  RAISE NOTICE 'PASS C8b: seq بيتحسب دايمًا على الخادم، ومرسل من غير profile مابيكسرش الإدراج';
END $$;
SELECT t.dblink_disconnect('w1'), t.dblink_disconnect('w2'), t.dblink_disconnect('admin1');

-- ══ Ⓓ الأحداث في نفس المعاملة ════════════════════════════════════════════
DO $$
DECLARE sid uuid; r jsonb; e jsonb; n int;
BEGIN
  SELECT id INTO sid FROM public.chat_sessions WHERE external_thread_id = '9008';
  SELECT payload INTO e FROM public.inbox_events WHERE session_id = sid AND kind = 'agent_replied';
  IF e->>'agent_id' IS DISTINCT FROM 'sie' OR e->>'source' IS DISTINCT FROM 'core:agent' OR e ? 'message_text' OR e->>'seq' IS DISTINCT FROM '2' THEN
    RAISE EXCEPTION 'FAIL D1: %', e;
  END IF;
  SELECT payload INTO e FROM public.inbox_events WHERE session_id = sid AND kind = 'message_received';
  IF e->>'source' IS DISTINCT FROM 'core:telegram' OR e->>'channel' IS DISTINCT FROM 'telegram' THEN RAISE EXCEPTION 'FAIL D2: %', e; END IF;
  -- حدث بيترجع مع الرسالة: ingest فشل ⇒ ولا رسالة ولا حدث.
  SELECT count(*) INTO n FROM public.inbox_events;
  IF NOT t.fails($q$select public.conv_ingest_message('telegram', '00000000-0000-4000-8000-0000000000c3', '9010', 'tg:9010:1', null, '"not-array"')$q$, '22023') THEN
    RAISE EXCEPTION 'FAIL D3: مدخلات غلط اتقبلت';
  END IF;
  IF (SELECT count(*) FROM public.inbox_events) IS DISTINCT FROM n THEN RAISE EXCEPTION 'FAIL D3b: حدث يتيم'; END IF;
  RAISE NOTICE 'PASS D1: agent_replied بـ agent_id و seq ومن غير محتوى، message_received بالقناة، ومفيش حدث من غير رسالته';
END $$;

-- الإقفال: inbox_close ⇒ حدث واحد (مش اتنين)؛ العميل يقفل من الودجت ⇒ حدث واحد.
SET ROLE authenticated;
SELECT t.act('00000000-0000-4000-8000-0000000000e1');
SELECT public.inbox_close(ARRAY[(SELECT id FROM public.chat_sessions WHERE external_thread_id = '9008')]);
SELECT t.act('00000000-0000-4000-8000-0000000000c2');
UPDATE public.chat_sessions SET status = 'closed' WHERE id = '5e550000-0000-4000-8000-000000000002';
RESET ROLE;
DO $$
DECLARE s1 uuid;
BEGIN
  SELECT id INTO s1 FROM public.chat_sessions WHERE external_thread_id = '9008';
  IF t.events(s1, 'closed') IS DISTINCT FROM 1 OR t.events('5e550000-0000-4000-8000-000000000002', 'closed') IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL D4: % / %', t.events(s1, 'closed'), t.events('5e550000-0000-4000-8000-000000000002', 'closed');
  END IF;
  IF (SELECT actor_id FROM public.inbox_events WHERE session_id = '5e550000-0000-4000-8000-000000000002' AND kind = 'closed')
       IS DISTINCT FROM '00000000-0000-4000-8000-0000000000c2' THEN
    RAISE EXCEPTION 'FAIL D5: فاعل الإقفال غلط';
  END IF;
  RAISE NOTICE 'PASS D2: الإقفال حدث واحد من أي مسار (inbox_close مايتكررش، وإقفال العميل بقى بيتسجل)';
END $$;

-- إقفال ثم رسالة جديدة لنفس الـ thread ⇒ محادثة جديدة، والتكرار متفحوص في المقفولة كمان.
SET ROLE service_role;
DO $$
DECLARE a jsonb; b jsonb; old uuid;
BEGIN
  SELECT id INTO old FROM public.chat_sessions WHERE external_thread_id = '9008';
  a := t.ingest('telegram', '00000000-0000-4000-8000-0000000000c3', '9008', 'tg:9008:1', 'ممكن مساعدة');
  b := t.ingest('telegram', '00000000-0000-4000-8000-0000000000c3', '9008', 'tg:9008:2', 'رجعت');
  IF t.b(a, 'created') OR a->'conversation'->>'id' IS DISTINCT FROM old::text
     OR b->'conversation'->>'id' = old::text OR b->'conversation'->>'resolution' IS DISTINCT FROM 'created' THEN
    RAISE EXCEPTION 'FAIL D6: % / %', a, b;
  END IF;
  RAISE NOTICE 'PASS D3: إعادة إرسال بعد الإقفال ⇒ مكررة؛ رسالة جديدة ⇒ محادثة جديدة';
END $$;
-- مقفولة: commit مرفوض.
DO $$
DECLARE r jsonb; old uuid;
BEGIN
  SELECT id INTO old FROM public.chat_sessions WHERE external_thread_id = '9008' AND status = 'closed';
  r := public.conv_commit_turn(old, t.version(old), 'after-close', 'x', '[]', null);
  IF t.b(r, 'committed') OR r->>'reason' IS DISTINCT FROM 'closed' THEN RAISE EXCEPTION 'FAIL D7: %', r; END IF;
  RAISE NOTICE 'PASS D4: commit على محادثة مقفولة ⇒ closed';
END $$;
-- الخمول (سياسة تيليجرام القديمة 24 ساعة)
DO $$
DECLARE r jsonb; sid uuid;
BEGIN
  SELECT id INTO sid FROM public.chat_sessions WHERE external_thread_id = '9007';
  RESET ROLE;
  UPDATE public.chat_sessions SET updated_at = now() - interval '2 days' WHERE id = sid;
  SET LOCAL ROLE service_role;
  r := public.conv_ingest_message('telegram', '00000000-0000-4000-8000-0000000000c3', '9007', 'tg:9007:9', 'بعد يومين',
         '[]', '{}', null, interval '24 hours');
  IF r->'conversation'->>'id' = sid::text OR (SELECT status FROM public.chat_sessions WHERE id = sid) IS DISTINCT FROM 'closed' THEN
    RAISE EXCEPTION 'FAIL D8: %', r;
  END IF;
  RAISE NOTICE 'PASS D5: محادثة خاملة أكتر من p_idle_after ⇒ اتقفلت واتفتحت جديدة';
END $$;
RESET ROLE;

-- ══ Ⓔ المسارات القديمة شغالة ═════════════════════════════════════════════
DO $$
DECLARE r jsonb; m public.chat_messages; ok int;
BEGIN
  -- persist_bot_turn من الخادم (Android chat-bot-reply / sie-api)
  PERFORM t.as_service();
  SET LOCAL ROLE service_role;
  r := public.persist_bot_turn('5e550000-0000-4000-8000-000000000003', 1, 'رد قديم', '{"sie":{"legacy":1}}');
  RESET ROLE;
  IF t.state('5e550000-0000-4000-8000-000000000003')->'sie'->>'legacy' IS DISTINCT FROM '1'
     OR (SELECT seq FROM public.chat_messages WHERE id = (r->>'message_id')::uuid) IS NULL
     OR t.events('5e550000-0000-4000-8000-000000000003', 'agent_replied') IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL E1: %', r;
  END IF;
  -- رد الدعم من الصندوق ⇒ human_reply + استلام
  SET LOCAL ROLE authenticated;
  PERFORM t.act('00000000-0000-4000-8000-0000000000e1');
  m := public.inbox_send_reply('5e550000-0000-4000-8000-000000000004', 'رد الدعم');
  RESET ROLE;
  IF t.events('5e550000-0000-4000-8000-000000000004', 'human_reply') IS DISTINCT FROM 1
     OR NOT t.manual('5e550000-0000-4000-8000-000000000004') OR m.seq IS NULL THEN
    RAISE EXCEPTION 'FAIL E2';
  END IF;
  -- chat_post_notice (061) من العميل
  SET LOCAL ROLE authenticated;
  PERFORM t.act('00000000-0000-4000-8000-0000000000c1');
  IF public.chat_post_notice('5e550000-0000-4000-8000-000000000005', 'greeting') IS NULL THEN
    RAISE EXCEPTION 'FAIL E3: الترحيب ماتكتبش';
  END IF;
  -- 062 لسه شغال: العميل مايكتبش رد بوت
  IF NOT t.fails($q$insert into public.chat_messages (session_id, sender_id, message_text, is_bot_reply)
                   values ('5e550000-0000-4000-8000-000000000005', null, 'مزيّف', true)$q$, NULL) THEN
    RAISE EXCEPTION 'FAIL E4: 062 اتكسر';
  END IF;
  RESET ROLE;
  -- 059 لسه شغال: رد بوت على محادثة مع إنسان مرفوض من المحفّز
  IF NOT t.fails($q$insert into public.chat_messages (session_id, message_text, is_bot_reply)
                   values ('5e550000-0000-4000-8000-000000000004', 'بوت', true)$q$, '55000') THEN
    RAISE EXCEPTION 'FAIL E5: 059 اتكسر';
  END IF;
  -- الترتيب في الجلسة القديمة متصل ومن غير فجوات
  SELECT count(*) INTO ok FROM (SELECT seq, row_number() OVER (ORDER BY seq) rn FROM public.chat_messages
                                 WHERE session_id = '5e550000-0000-4000-8000-000000000001' AND seq IS NOT NULL) x WHERE seq <> rn;
  IF ok IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'FAIL E6: فجوة في seq'; END IF;
  RAISE NOTICE 'PASS E: persist_bot_turn (أندرويد/sie-api)، رد الدعم، الترحيب، 062 و 059 — كله شغال، وبيكتب أحداث و seq';
END $$;

-- ══ Ⓕ إعادة التشغيل والتراجع ═════════════════════════════════════════════
UPDATE public.sie_settings SET value = 'true' WHERE key = 'core_ingest_telegram';
\i migrations/064_conversation_core.sql
DO $$
BEGIN
  IF (SELECT value FROM public.sie_settings WHERE key = 'core_ingest_telegram') IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'FAIL F1: إعادة التشغيل رجّعت علم مفتوح';
  END IF;
  RAISE NOTICE 'PASS F1: إعادة تشغيل 064 idempotent ومابترجّعش علم حد فتحه';
END $$;
UPDATE public.sie_settings SET value = 'false' WHERE key = 'core_ingest_telegram';

CREATE TABLE public._t_counts AS SELECT (SELECT count(*) FROM public.chat_messages) m, (SELECT count(*) FROM public.chat_sessions) s,
  (SELECT count(*) FROM public.chat_messages WHERE seq IS NOT NULL) seqd;
\i migrations/_rollback/064_conversation_core.down.sql
DO $$
DECLARE n int;
BEGIN
  IF to_regprocedure('public.conv_ingest_message(text, uuid, text, text, text, jsonb, jsonb, uuid, interval)') IS NOT NULL
     OR to_regprocedure('public.conv_commit_turn(uuid, integer, text, text, jsonb, jsonb, text, boolean, jsonb, text)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgname IN ('trg_seq_assign', 'trg_conv_message_event', 'trg_guard_core_columns',
                  'trg_conv_session_created', 'trg_conv_session_closed', 'trg_conv_handoff_version'))
     OR EXISTS (SELECT 1 FROM pg_indexes WHERE indexname IN ('chat_messages_session_seq_key', 'chat_messages_session_external_id_key', 'chat_sessions_active_thread_key'))
     OR EXISTS (SELECT 1 FROM public.sie_settings WHERE key IN ('core_ingest_website', 'core_ingest_telegram', 'agent_runtime_enabled')) THEN
    RAISE EXCEPTION 'FAIL F2: التراجع ناقص';
  END IF;
  IF (SELECT count(*) FROM public.chat_messages) IS DISTINCT FROM (SELECT m FROM public._t_counts)
     OR (SELECT count(*) FROM public.chat_sessions) IS DISTINCT FROM (SELECT s FROM public._t_counts)
     OR (SELECT count(*) FROM public.chat_messages WHERE seq IS NOT NULL) IS DISTINCT FROM (SELECT seqd FROM public._t_counts) THEN
    RAISE EXCEPTION 'FAIL F3: التراجع لمس بيانات';
  END IF;
  -- المسار القديم بعد التراجع: رسالة عادية + persist_bot_turn
  INSERT INTO public.chat_messages (session_id, sender_id, message_text)
    VALUES ('5e550000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1', 'بعد التراجع');
  IF EXISTS (SELECT 1 FROM public.chat_messages WHERE message_text = 'بعد التراجع' AND seq IS NOT NULL) THEN
    RAISE EXCEPTION 'FAIL F4: seq لسه بيتحسب بعد التراجع';
  END IF;
  RAISE NOTICE 'PASS F2: التراجع شال الدوال والمحفّزات والفهارس والأعلام، والبيانات والأعمدة زي ما هي، والمسار القديم شغال';
END $$;
\i migrations/064_conversation_core.sql
DO $$
BEGIN
  PERFORM t.as_service();
  SET LOCAL ROLE service_role;
  IF NOT t.b(t.ingest('telegram', '00000000-0000-4000-8000-0000000000c3', '9100', 'tg:9100:1', 'تاني'), 'created') THEN
    RAISE EXCEPTION 'FAIL F5';
  END IF;
  RAISE NOTICE 'PASS F3: 064 اتطبق تاني بعد التراجع وشغال';
END $$;

\echo 'ALL CONVERSATION-CORE TESTS PASSED'
