-- ============================================================================
-- اختبار تنفيذي لـ 058: جدولة ردود الدعم.
--
-- يثبّت:
--   ① الجدولة للطاقم اللي يوصل للمحادثة، بحدود (دقيقة..30 يوم، مش مقفولة،
--      مرفق في مجلد الكاتب، 20 مستني بالكتير) — والعميل لا يرى ولا يكتب
--   ② الموزّع يبعت المستحق بس، باسم الكاتب، بنفس عقد الرد الفوري
--      (is_manual_mode ثم is_admin_reply، والمرفق من محفّز 054)
--   ③ إعادة التحقق وقت الإرسال: فقد الوصول / حظر / إقفال / ملف ممسوح ⇒
--      failed بسبب + حدث + إشعار، ومفيش رسالة نص، والباقي يكمل
--   ④ الإلغاء: الكاتب أو المشرف، والمستني بس
--   ⑤ التوازي: موزّعان في جلستين حقيقيتين (dblink) ⇒ كل رد يتبعت مرة واحدة
--   ⑥ inbox_send_reply بعد إعادة الهيكلة كما كان
--   ⑦ التراجع الموثّق، والرد الفوري بعده كما في 056
--
-- التمهيد منسوخ من inbox-phase2.test.sql (حالة الإنتاج بعد 054/055/056).
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

-- ── مساعدات الاختبار ─────────────────────────────────────────────────────
DROP SCHEMA IF EXISTS t CASCADE;
CREATE SCHEMA t;
CREATE EXTENSION IF NOT EXISTS dblink SCHEMA t;
GRANT USAGE ON SCHEMA t TO authenticated;
CREATE OR REPLACE FUNCTION t.act(p uuid) RETURNS void LANGUAGE sql AS $$
  select set_config('request.jwt.claim.sub', p::text, false); $$;
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
GRANT EXECUTE ON FUNCTION t.act(uuid), t.fails(text, text) TO authenticated;
-- الموزّع بيشتغل من pg_cron كـ postgres ومن غير مستخدم: auth.uid() = NULL.
CREATE OR REPLACE FUNCTION t.as_cron() RETURNS void LANGUAGE sql AS $$
  select set_config('request.jwt.claim.sub', '', false); $$;
-- «الوقت فات»: الموزّع بيقارن send_at بـ now()، فبنرجّع send_at للماضي بدل ما نستنى.
CREATE OR REPLACE FUNCTION t.due(p_body text) RETURNS void LANGUAGE sql AS $$
  update public.inbox_scheduled_replies set send_at = now() - interval '1 second' where body = p_body; $$;
CREATE OR REPLACE FUNCTION t.sched(p_body text) RETURNS public.inbox_scheduled_replies LANGUAGE sql AS $$
  select * from public.inbox_scheduled_replies where body = p_body; $$;

-- ── تجهيز: S1 مسندة لـ A1، وملفات في المستودع ─────────────────────────────
INSERT INTO storage.objects (bucket_id, name) VALUES
  ('chat-attachments', '00000000-0000-4000-8000-0000000000a1/5e550000-0000-4000-8000-000000000001-1.png'),
  ('chat-attachments', '00000000-0000-4000-8000-0000000000a1/5e550000-0000-4000-8000-000000000001-2.pdf'),
  ('chat-attachments', '00000000-0000-4000-8000-0000000000c1/own.png');
SET ROLE authenticated;
SELECT t.act('00000000-0000-4000-8000-0000000000e1');
SELECT public.inbox_assign('5e550000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1');

-- ① الجدولة وحدودها ─────────────────────────────────────────────────────────
DO $$
DECLARE r public.inbox_scheduled_replies; n int;
BEGIN
  PERFORM t.act('00000000-0000-4000-8000-0000000000a1');
  r := public.inbox_schedule_reply('5e550000-0000-4000-8000-000000000001', 'رد مجدول نص', now() + interval '2 hours');
  IF r.status <> 'pending' OR r.author_id <> '00000000-0000-4000-8000-0000000000a1' THEN
    RAISE EXCEPTION 'FAIL 1a: %', row_to_json(r);
  END IF;
  PERFORM public.inbox_schedule_reply('5e550000-0000-4000-8000-000000000001', 'صورة مرفقة', now() + interval '1 hour',
    '{"kind":"image","path":"00000000-0000-4000-8000-0000000000a1/5e550000-0000-4000-8000-000000000001-1.png","name":"s.png"}');

  IF NOT t.fails($q$select public.inbox_schedule_reply('5e550000-0000-4000-8000-000000000001', 'x', now())$q$, '22023')
     OR NOT t.fails($q$select public.inbox_schedule_reply('5e550000-0000-4000-8000-000000000001', 'x', now() + interval '31 days')$q$, '22023')
     OR NOT t.fails($q$select public.inbox_schedule_reply('5e550000-0000-4000-8000-000000000001', '   ', now() + interval '1 hour')$q$, '22023') THEN
    RAISE EXCEPTION 'FAIL 1b: حدود الميعاد/النص';
  END IF;
  -- مرفق في مجلد العميل، أو ملف مش موجود — يترفض فورًا مش وقت الإرسال
  IF NOT t.fails($q$select public.inbox_schedule_reply('5e550000-0000-4000-8000-000000000001', 'x', now() + interval '1 hour',
        '{"kind":"image","path":"00000000-0000-4000-8000-0000000000c1/own.png"}')$q$, '42501')
     OR NOT t.fails($q$select public.inbox_schedule_reply('5e550000-0000-4000-8000-000000000001', 'x', now() + interval '1 hour',
        '{"kind":"file","path":"00000000-0000-4000-8000-0000000000a1/ghost.pdf"}')$q$, '42501') THEN
    RAISE EXCEPTION 'FAIL 1c: مرفق غريب اتقبل';
  END IF;
  -- مش مسند له
  PERFORM t.act('00000000-0000-4000-8000-0000000000a2');
  IF NOT t.fails($q$select public.inbox_schedule_reply('5e550000-0000-4000-8000-000000000001', 'x', now() + interval '1 hour')$q$, '42501') THEN
    RAISE EXCEPTION 'FAIL 1d: أدمن مش مسند له جدول';
  END IF;
  SELECT count(*) INTO n FROM public.inbox_scheduled_replies;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 1e: A2 يرى % رد مجدول', n; END IF;
  -- العميل: لا يرى ولا يجدول ولا يكتب مباشرة
  PERFORM t.act('00000000-0000-4000-8000-0000000000c1');
  SELECT count(*) INTO n FROM public.inbox_scheduled_replies;
  IF n <> 0 OR NOT t.fails($q$select public.inbox_schedule_reply('5e550000-0000-4000-8000-000000000001', 'x', now() + interval '1 hour')$q$, '42501')
     OR NOT t.fails($q$insert into public.inbox_scheduled_replies (session_id, author_id, body, send_at)
        values ('5e550000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1', 'x', now())$q$, '42501')
     OR NOT t.fails($q$select public.inbox_dispatch_scheduled()$q$, '42501') THEN
    RAISE EXCEPTION 'FAIL 1f: العميل وصل للجدولة';
  END IF;
  PERFORM t.act('00000000-0000-4000-8000-0000000000a1');
  IF (SELECT count(*) FROM public.inbox_events WHERE kind = 'scheduled') <> 2 THEN RAISE EXCEPTION 'FAIL 1g: السجل'; END IF;
  RAISE NOTICE 'PASS 1: الجدولة للطاقم الواصل وبحدودها، والعميل لا يرى ولا يكتب';
END $$;

-- الحد: 20 مستني في المحادثة
DO $$
DECLARE i int;
BEGIN
  PERFORM t.act('00000000-0000-4000-8000-0000000000a1');
  FOR i IN 1..18 LOOP
    PERFORM public.inbox_schedule_reply('5e550000-0000-4000-8000-000000000001', 'حشو ' || i, now() + interval '10 days');
  END LOOP;
  IF NOT t.fails($q$select public.inbox_schedule_reply('5e550000-0000-4000-8000-000000000001', 'الـ 21', now() + interval '1 hour')$q$, '22023') THEN
    RAISE EXCEPTION 'FAIL 1h: أكتر من 20 مستني';
  END IF;
  RAISE NOTICE 'PASS 1h: 20 رد مستني بالكتير في المحادثة';
END $$;

-- ④ الإلغاء (قبل الإرسال عشان نحرر مكان) ──────────────────────────────────
DO $$
DECLARE r public.inbox_scheduled_replies;
BEGIN
  PERFORM t.act('00000000-0000-4000-8000-0000000000a1');
  r := public.inbox_cancel_scheduled((t.sched('حشو 1')).id);
  IF r.status <> 'cancelled' OR r.cancelled_by <> '00000000-0000-4000-8000-0000000000a1' THEN RAISE EXCEPTION 'FAIL 4a'; END IF;
  IF NOT t.fails(format('select public.inbox_cancel_scheduled(%L)', (t.sched('حشو 1')).id), '22023') THEN
    RAISE EXCEPTION 'FAIL 4b: إلغاء غير المستني';
  END IF;
  -- زميل عضو في فريق المحادثة (يوصل) لكن مش الكاتب ومش مشرف
  PERFORM t.act('00000000-0000-4000-8000-0000000000e1');
  PERFORM public.inbox_save_team(null, 'فريق', null);
  PERFORM public.inbox_set_team_member((select id from public.inbox_teams where name = 'فريق'), '00000000-0000-4000-8000-0000000000a2', 'member');
  PERFORM public.inbox_set_team_member((select id from public.inbox_teams where name = 'فريق'), '00000000-0000-4000-8000-0000000000a1', 'member');
  PERFORM public.inbox_assign('5e550000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1',
                              (select id from public.inbox_teams where name = 'فريق'));
  PERFORM t.act('00000000-0000-4000-8000-0000000000a2');
  IF NOT t.fails(format('select public.inbox_cancel_scheduled(%L)', (t.sched('حشو 2')).id), '42501') THEN
    RAISE EXCEPTION 'FAIL 4c: زميل ألغى رد غيره';
  END IF;
  PERFORM t.act('00000000-0000-4000-8000-0000000000e1');   -- المشرف يلغي
  PERFORM public.inbox_cancel_scheduled((t.sched('حشو 2')).id);
  RAISE NOTICE 'PASS 4: الإلغاء للكاتب أو المشرف، والمستني بس';
END $$;

-- ② الإرسال في ميعاده ────────────────────────────────────────────────────────
RESET ROLE;
SELECT t.as_cron();
DO $$
DECLARE n int; m public.chat_messages; s public.chat_sessions;
BEGIN
  n := public.inbox_dispatch_scheduled();
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 2a: اتبعت % قبل ميعاده', n; END IF;

  PERFORM t.due('رد مجدول نص');
  PERFORM t.due('صورة مرفقة');
  UPDATE public.chat_sessions SET is_manual_mode = false WHERE id = '5e550000-0000-4000-8000-000000000001';
  n := public.inbox_dispatch_scheduled();
  IF n <> 2 THEN RAISE EXCEPTION 'FAIL 2b: الموزّع عالج %', n; END IF;

  SELECT * INTO m FROM public.chat_messages WHERE message_text = 'رد مجدول نص';
  IF m.sender_id <> '00000000-0000-4000-8000-0000000000a1' OR NOT m.is_admin_reply THEN
    RAISE EXCEPTION 'FAIL 2c: الرسالة %', row_to_json(m);
  END IF;
  SELECT * INTO s FROM public.chat_sessions WHERE id = '5e550000-0000-4000-8000-000000000001';
  IF NOT s.is_manual_mode THEN RAISE EXCEPTION 'FAIL 2d: البوت ماوقفش'; END IF;
  SELECT * INTO m FROM public.chat_messages WHERE message_text = 'صورة مرفقة';
  IF m.image_url <> '00000000-0000-4000-8000-0000000000a1/5e550000-0000-4000-8000-000000000001-1.png' THEN
    RAISE EXCEPTION 'FAIL 2e: المرفق';
  END IF;
  IF (t.sched('رد مجدول نص')).status <> 'sent' OR (t.sched('رد مجدول نص')).message_id IS NULL
     OR (SELECT count(*) FROM public.inbox_events WHERE kind = 'schedule_sent'
          AND actor_id = '00000000-0000-4000-8000-0000000000a1') <> 2 THEN
    RAISE EXCEPTION 'FAIL 2f: الحالة/السجل';
  END IF;
  IF public.inbox_dispatch_scheduled() <> 0 THEN RAISE EXCEPTION 'FAIL 2g: اتبعت تاني'; END IF;
  RAISE NOTICE 'PASS 2: المستحق بس، باسم الكاتب، بنفس عقد الرد الفوري، مرة واحدة';
END $$;

-- ③ إعادة التحقق وقت الإرسال ────────────────────────────────────────────────
SET ROLE authenticated;
SELECT t.act('00000000-0000-4000-8000-0000000000a1');
SELECT public.inbox_schedule_reply('5e550000-0000-4000-8000-000000000001', 'ملف هيتمسح', now() + interval '1 hour',
  '{"kind":"file","path":"00000000-0000-4000-8000-0000000000a1/5e550000-0000-4000-8000-000000000001-2.pdf","name":"f.pdf"}');
SELECT public.inbox_schedule_reply('5e550000-0000-4000-8000-000000000001', 'بعد النقل', now() + interval '1 hour');
SELECT t.act('00000000-0000-4000-8000-0000000000e1');
SELECT public.inbox_schedule_reply('5e550000-0000-4000-8000-000000000002', 'من المرتفع قبل الحظر', now() + interval '1 hour');
SELECT public.inbox_schedule_reply('5e550000-0000-4000-8000-000000000002', 'قبل الإقفال', now() + interval '1 hour');
RESET ROLE;
SELECT t.as_cron();
DO $$
DECLARE n int;
BEGIN
  -- الملف اتمسح من المستودع
  DELETE FROM storage.objects WHERE name = '00000000-0000-4000-8000-0000000000a1/5e550000-0000-4000-8000-000000000001-2.pdf';
  PERFORM t.due('ملف هيتمسح');
  -- A1 اتشال من المحادثة والفريق
  UPDATE public.inbox_conversations SET assignee_id = '00000000-0000-4000-8000-0000000000a2', team_id = null
   WHERE session_id = '5e550000-0000-4000-8000-000000000001';
  PERFORM t.due('بعد النقل');
  n := public.inbox_dispatch_scheduled();
  IF n <> 2 THEN RAISE EXCEPTION 'FAIL 3a: %', n; END IF;
  IF (t.sched('بعد النقل')).status <> 'failed' OR (t.sched('بعد النقل')).failure_reason NOT LIKE '%مابقاش يوصل%' THEN
    RAISE EXCEPTION 'FAIL 3b: %', row_to_json(t.sched('بعد النقل'));
  END IF;
  IF (t.sched('ملف هيتمسح')).status <> 'failed' THEN RAISE EXCEPTION 'FAIL 3c'; END IF;
  IF EXISTS (SELECT 1 FROM public.chat_messages WHERE message_text IN ('بعد النقل', 'ملف هيتمسح')) THEN
    RAISE EXCEPTION 'FAIL 3d: رسالة فاشلة اتكتبت';
  END IF;

  -- المرتفع اتحظر، والمحادثة التانية اتقفلت
  UPDATE public.profiles SET ban_status = 'permanent' WHERE id = '00000000-0000-4000-8000-0000000000e1';
  PERFORM t.due('من المرتفع قبل الحظر');
  n := public.inbox_dispatch_scheduled();
  UPDATE public.profiles SET ban_status = null WHERE id = '00000000-0000-4000-8000-0000000000e1';
  UPDATE public.chat_sessions SET status = 'closed' WHERE id = '5e550000-0000-4000-8000-000000000002';
  PERFORM t.due('قبل الإقفال');
  n := n + public.inbox_dispatch_scheduled();
  IF n <> 2 OR (t.sched('من المرتفع قبل الحظر')).failure_reason NOT LIKE '%موقوف%'
     OR (t.sched('قبل الإقفال')).failure_reason NOT LIKE '%مقفولة%' THEN
    RAISE EXCEPTION 'FAIL 3e: % / % / %', n, (t.sched('من المرتفع قبل الحظر')).failure_reason, (t.sched('قبل الإقفال')).failure_reason;
  END IF;
  IF (SELECT count(*) FROM public.inbox_events WHERE kind = 'schedule_failed') <> 4
     OR (SELECT count(*) FROM public.notifications WHERE title = 'رد مجدول ماتبعتش') <> 4 THEN
    RAISE EXCEPTION 'FAIL 3f: السجل/الإشعارات';
  END IF;
  UPDATE public.chat_sessions SET status = 'active' WHERE id = '5e550000-0000-4000-8000-000000000002';
  UPDATE public.inbox_conversations SET assignee_id = '00000000-0000-4000-8000-0000000000a1'
   WHERE session_id = '5e550000-0000-4000-8000-000000000001';
  RAISE NOTICE 'PASS 3: فقد الوصول / ملف ممسوح / حظر / إقفال ⇒ failed بسبب وحدث وإشعار، ومفيش رسالة';
END $$;

-- ⑤ التوازي: موزّعان في جلستين حقيقيتين ──────────────────────────────────────
DO $$
DECLARE i int; n int; n2 int; conn text;
BEGIN
  -- الحشو من اختبار الحد يفضي مكان (مش مستحق، لكن بيعدّ في الـ 20)
  UPDATE public.inbox_scheduled_replies SET status = 'cancelled' WHERE body LIKE 'حشو %' AND status = 'pending';
  -- 5 ردود مستحقة (مجدولة من A1 على S1)
  PERFORM t.act('00000000-0000-4000-8000-0000000000a1');
  FOR i IN 1..5 LOOP
    PERFORM public.inbox_schedule_reply('5e550000-0000-4000-8000-000000000001', 'متوازي ' || i, now() + interval '1 hour');
    PERFORM t.due('متوازي ' || i);
  END LOOP;
END $$;
SELECT t.as_cron();
SELECT t.dblink_connect('other', format('dbname=%s port=%s host=%s user=postgres', current_database(),
         current_setting('port'), split_part(current_setting('unix_socket_directories'), ',', 1)));
-- الجلسة التانية: موزّع في معاملة مفتوحة — ماسك الصفوف لحد الـ commit
SELECT t.dblink_exec('other', 'begin');
DO $$
DECLARE n_other int; n_here int; total int;
BEGIN
  SELECT x INTO n_other FROM t.dblink('other', 'select public.inbox_dispatch_scheduled()') AS r(x int);
  -- هنا: نفس الصفوف ممسوكة ⇒ skip locked ⇒ صفر، من غير انتظار. lock_timeout
  -- يحوّل أي انتظار (لو skip locked اتشال) لفشل واضح بدل اختبار معلّق.
  PERFORM set_config('lock_timeout', '3s', true);
  n_here := public.inbox_dispatch_scheduled();
  IF n_other <> 5 OR n_here <> 0 THEN RAISE EXCEPTION 'FAIL 5a: التانية % وهنا %', n_other, n_here; END IF;
END $$;
SELECT t.dblink_exec('other', 'commit');
SELECT t.dblink_disconnect('other');
DO $$
BEGIN
  IF public.inbox_dispatch_scheduled() <> 0 THEN RAISE EXCEPTION 'FAIL 5b: اتبعت تاني بعد الـ commit'; END IF;
  IF (SELECT count(*) FROM public.chat_messages WHERE message_text LIKE 'متوازي %') <> 5
     OR (SELECT count(DISTINCT message_text) FROM public.chat_messages WHERE message_text LIKE 'متوازي %') <> 5
     OR EXISTS (SELECT 1 FROM public.inbox_scheduled_replies WHERE body LIKE 'متوازي %' AND status <> 'sent') THEN
    RAISE EXCEPTION 'FAIL 5c: كل رد مرة واحدة';
  END IF;
  RAISE NOTICE 'PASS 5: موزّعان متوازيان (جلستين حقيقيتين) ⇒ كل رد اتبعت مرة واحدة';
END $$;

-- ⑥ الرد الفوري بعد إعادة الهيكلة ────────────────────────────────────────────
SET ROLE authenticated;
DO $$
DECLARE m public.chat_messages;
BEGIN
  PERFORM t.act('00000000-0000-4000-8000-0000000000a1');
  m := public.inbox_send_reply(p_session => '5e550000-0000-4000-8000-000000000001', p_body => 'رد فوري');
  IF m.sender_id <> '00000000-0000-4000-8000-0000000000a1' OR NOT m.is_admin_reply THEN RAISE EXCEPTION 'FAIL 6a'; END IF;
  PERFORM t.act('00000000-0000-4000-8000-0000000000a2');
  IF NOT t.fails($q$select public.inbox_send_reply('5e550000-0000-4000-8000-000000000001', 'x')$q$, '42501') THEN
    RAISE EXCEPTION 'FAIL 6b: غير المسند رد';
  END IF;
  PERFORM t.act('00000000-0000-4000-8000-0000000000c1');
  IF NOT t.fails($q$select public._inbox_post_reply('5e550000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1', 'x', null)$q$, '42501') THEN
    RAISE EXCEPTION 'FAIL 6c: الدالة الداخلية مكشوفة — العميل يقدر يكتب باسم موظف';
  END IF;
  RAISE NOTICE 'PASS 6: الرد الفوري كما كان، والمسار الداخلي مش متاح لأحد';
END $$;

-- ⑦ التراجع الموثّق ─────────────────────────────────────────────────────────
RESET ROLE;
DROP FUNCTION t.sched(text);   -- مساعد الاختبار بيرجّع نوع صف الجدول
alter publication supabase_realtime drop table public.inbox_scheduled_replies;
drop function if exists public.inbox_dispatch_scheduled(int), public._inbox_account_active(uuid),
  public.inbox_cancel_scheduled(uuid), public.inbox_schedule_reply(uuid, text, timestamptz, jsonb);
drop table if exists public.inbox_scheduled_replies;
SET ROLE authenticated;
DO $$
DECLARE m public.chat_messages;
BEGIN
  IF to_regclass('public.inbox_scheduled_replies') IS NOT NULL THEN RAISE EXCEPTION 'FAIL 7a'; END IF;
  PERFORM t.act('00000000-0000-4000-8000-0000000000a1');
  m := public.inbox_send_reply('5e550000-0000-4000-8000-000000000001', 'بعد التراجع');
  IF NOT m.is_admin_reply THEN RAISE EXCEPTION 'FAIL 7b'; END IF;
  RAISE NOTICE 'PASS 7: التراجع ينظّف الجدولة، والرد الفوري شغال بعده';
END $$;
RESET ROLE;

\echo 'ALL inbox-scheduled tests passed'
