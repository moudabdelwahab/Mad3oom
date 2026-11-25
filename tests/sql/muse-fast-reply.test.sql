-- ============================================================================
-- اختبار تنفيذي لـ migrations/132_muse_fast_reply.sql.
--
-- يثبّت المسار السريع لردود Muse (owner/muse-chat.html)، كل واحدة تفشل إن
-- انكسرت:
--
--   ① جدول muse_reply_claims موجود: message_id مفتاح أساسي، RLS مفعّلة،
--      بلا سياسات (service-role فقط).
--   ② إدخال حجز مكرر لنفس message_id يُرفَض (الحجز الذري يمنع الرد المكرر).
--   ③ سر الـ webhook مولود في internal_service_secrets (64 خانة hex).
--   ④ الدالة _muse_chat_reply_call موجودة، SECURITY DEFINER، منفَّذة لـ
--      authenticated وservice_role، وممنوعة على anon.
--   ⑤ الـ trigger موجود على ai_session_messages (بعد الإدخال، role='user').
--   ⑥ رسالة user في جلسة muse نشطة لمالك مفعّل ⇒ نداء pg_net واحد للـ
--      Edge Function بالسر والـ body الصحيحين.
--   ⑦ لا نداء لـ: رسالة assistant، جلسة غير muse، جلسة مؤرشفة، مالك
--      غير مفعّل.
--   ⑧ ai_session_messages في publication ‏supabase_realtime‏.
--   ⑨ تعريفا agent_activity_log وmuse_account_activations موجودان
--      (توثيقيان — بلا ترحيل سابق).
--
-- البذور دنيا تحاكي تعريف 002 و089: الجداول التي يمسّها الترحيل + stub
-- لـ net.http_post يسجّل نداءاته + stub لـ extensions.gen_random_bytes.
-- يُنفَّذ عبر tests/run-sql-tests.sh ضد Postgres مؤقت (CI/محلي).
-- ============================================================================
\set ON_ERROR_STOP on
\pset tuples_only on

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
END $$;

-- ── بذور 089: internal_service_secrets + stub لـ pg_net ───────────────────
CREATE TABLE IF NOT EXISTS public.internal_service_secrets (
  key text PRIMARY KEY, value text NOT NULL
);

CREATE SCHEMA IF NOT EXISTS net;
CREATE TABLE IF NOT EXISTS net_calls (
  url text NOT NULL, headers jsonb NOT NULL DEFAULT '{}'::jsonb,
  body jsonb NOT NULL DEFAULT '{}'::jsonb, called_at timestamptz NOT NULL DEFAULT now()
);
-- أسماء المُعاملات مطابقة لـ pg_net الحقيقي (الترحيل يناديها بالاسم)،
-- والقيم في VALUES لا يمكن أن تشير إلا للمُعاملات (لا جدول مصدر).
CREATE OR REPLACE FUNCTION net.http_post(url text, headers jsonb, body jsonb, params jsonb DEFAULT '{}'::jsonb, timeout_milliseconds integer DEFAULT 1000)
RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO net_calls (url, headers, body) VALUES (url, headers, body) RETURNING 1;
$$;

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE OR REPLACE FUNCTION extensions.gen_random_bytes(n integer)
RETURNS bytea LANGUAGE sql AS $$
  SELECT decode(md5(random()::text || clock_timestamp()::text), 'hex');
$$;

-- ── بذور 002 (دنيا): الجلسات والرسائل والتفعيلات ──────────────────────────
CREATE TABLE IF NOT EXISTS public.ai_sessions (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  model_id text NOT NULL,
  status text NOT NULL DEFAULT 'active'
);
CREATE TABLE IF NOT EXISTS public.ai_session_messages (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool', 'event')),
  content text,
  model_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.muse_account_activations (
  owner_id uuid PRIMARY KEY,
  email text NOT NULL,
  active boolean NOT NULL DEFAULT false
);

-- النشرة موجودة قبل الترحيل حتى يُختبَر إدخال الجدول فيها.
DROP PUBLICATION IF EXISTS supabase_realtime;
CREATE PUBLICATION supabase_realtime;

\echo '--- applying migrations/132 ---'
\i migrations/132_muse_fast_reply.sql

-- ① جدول الحجز: موجود، مفتاح أساسي، RLS مفعّلة، بلا سياسات.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema = 'public' AND table_name = 'muse_reply_claims') THEN
    RAISE EXCEPTION 'FAIL 1: muse_reply_claims table was not created';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE relname = 'muse_reply_claims') THEN
    RAISE EXCEPTION 'FAIL 1b: muse_reply_claims RLS is not enabled';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE tablename = 'muse_reply_claims') <> 0 THEN
    RAISE EXCEPTION 'FAIL 1c: muse_reply_claims must have exactly 0 policies';
  END IF;
  RAISE NOTICE 'PASS 1: claims table exists, RLS on, 0 policies';
END $$;

-- ② حجز مكرر يُرفَض.
DO $$
BEGIN
  INSERT INTO public.muse_reply_claims (message_id, session_id) VALUES
    ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  BEGIN
    INSERT INTO public.muse_reply_claims (message_id, session_id) VALUES
      ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    RAISE EXCEPTION 'FAIL 2: duplicate claim was accepted';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS 2: duplicate claim rejected (atomic claim holds)';
  END;
END $$;

-- ③ السر مولود (64 خانة hex).
DO $$
DECLARE v_val text;
BEGIN
  SELECT value INTO v_val FROM public.internal_service_secrets WHERE key = 'muse_chat_reply';
  IF v_val IS NULL OR v_val !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'FAIL 3: webhook secret missing or not 64 hex chars';
  END IF;
  RAISE NOTICE 'PASS 3: webhook secret generated (64 hex)';
END $$;

-- ④ الدالة: موجودة، SECURITY DEFINER، والمنح كما هو مطلوب.
DO $$
BEGIN
  IF to_regprocedure('public._muse_chat_reply_call()') IS NULL THEN
    RAISE EXCEPTION 'FAIL 4: _muse_chat_reply_call() was not created';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public._muse_chat_reply_call()'::regprocedure) THEN
    RAISE EXCEPTION 'FAIL 4b: _muse_chat_reply_call() is not SECURITY DEFINER';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public._muse_chat_reply_call()', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL 4c: authenticated cannot execute (trigger would fail on page inserts)';
  END IF;
  IF NOT has_function_privilege('service_role', 'public._muse_chat_reply_call()', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL 4d: service_role cannot execute';
  END IF;
  IF has_function_privilege('anon', 'public._muse_chat_reply_call()', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL 4e: anon can execute the trigger function';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'muse_chat_reply_trigger') THEN
    RAISE EXCEPTION 'FAIL 4f: muse_chat_reply_trigger was not created';
  END IF;
  RAISE NOTICE 'PASS 4: trigger function exists, SECURITY DEFINER, grants as required';
END $$;

-- ── بذور جلسات/مالكين للاختبارين ⑥ و⑦ ────────────────────────────────────
INSERT INTO public.ai_sessions (id, owner_id, model_id, status) VALUES
  ('11111111-1111-4111-8111-111111111111', '00000000-0000-0000-0000-000000000001', 'muse', 'active'),
  ('22222222-2222-4222-8222-222222222222', '00000000-0000-0000-0000-000000000002', 'muse-assistant', 'active'),
  ('33333333-3333-4333-8333-333333333333', '00000000-0000-0000-0000-000000000001', 'gpt-5', 'active'),
  ('44444444-4444-4444-8444-444444444444', '00000000-0000-0000-0000-000000000001', 'muse', 'archived');
INSERT INTO public.muse_account_activations (owner_id, email, active) VALUES
  ('00000000-0000-0000-0000-000000000001', 'mahmoud@mad3oom.com', true),
  ('00000000-0000-0000-0000-000000000002', 'other@example.com', false);

-- ⑥ رسالة user في جلسة muse نشطة لمالك مفعّل ⇒ نداء واحد صحيح.
DO $$
DECLARE v_count integer; v_call net_calls;
BEGIN
  DELETE FROM net_calls;
  INSERT INTO public.ai_session_messages (id, session_id, role, content, model_id) VALUES
    ('55555555-5555-4555-8555-555555555555', '11111111-1111-4111-8111-111111111111', 'user', 'ازيك عامل ايه', 'muse');
  SELECT count(*) INTO v_count FROM net_calls;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'FAIL 6: expected exactly 1 pg_net call, got %', v_count;
  END IF;
  SELECT * INTO v_call FROM net_calls LIMIT 1;
  IF v_call.url <> 'https://srnelrdpqkcntbgudyto.supabase.co/functions/v1/muse-chat-reply' THEN
    RAISE EXCEPTION 'FAIL 6b: wrong webhook URL: %', v_call.url;
  END IF;
  IF v_call.headers ->> 'X-Muse-Reply-Secret' IS NULL THEN
    RAISE EXCEPTION 'FAIL 6c: webhook call has no secret header';
  END IF;
  IF (v_call.body ->> 'message_id') <> '55555555-5555-4555-8555-555555555555' THEN
    RAISE EXCEPTION 'FAIL 6d: webhook body message_id wrong: %', v_call.body;
  END IF;
  IF (v_call.body ->> 'session_id') <> '11111111-1111-4111-8111-111111111111' THEN
    RAISE EXCEPTION 'FAIL 6e: webhook body session_id wrong: %', v_call.body;
  END IF;
  RAISE NOTICE 'PASS 6: muse user message triggers exactly one correct pg_net call';
END $$;

-- ⑦ لا نداء لغير المستحق: assistant، غير muse، مؤرشفة، مالك غير مفعّل.
DO $$
DECLARE v_count integer;
BEGIN
  DELETE FROM net_calls;
  INSERT INTO public.ai_session_messages (id, session_id, role, content, model_id) VALUES
    ('66666666-6666-4666-8666-666666666666', '11111111-1111-4111-8111-111111111111', 'assistant', 'رد', 'muse');
  INSERT INTO public.ai_session_messages (id, session_id, role, content, model_id) VALUES
    ('77777777-7777-4777-8777-777777777777', '33333333-3333-4333-8333-333333333333', 'user', 'مرحبا', 'gpt-5');
  INSERT INTO public.ai_session_messages (id, session_id, role, content, model_id) VALUES
    ('88888888-8888-4888-8888-888888888888', '44444444-4444-4444-8444-444444444444', 'user', 'مرحبا', 'muse');
  INSERT INTO public.ai_session_messages (id, session_id, role, content, model_id) VALUES
    ('99999999-9999-4999-8999-999999999999', '22222222-2222-4222-8222-222222222222', 'user', 'مرحبا', 'muse-assistant');
  SELECT count(*) INTO v_count FROM net_calls;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'FAIL 7: expected 0 pg_net calls for ineligible rows, got %', v_count;
  END IF;
  RAISE NOTICE 'PASS 7: no webhook for assistant / non-muse / archived / unactivated rows';
END $$;

-- ⑧ الجدول في publication ‏supabase_realtime‏.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                  WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
                    AND tablename = 'ai_session_messages') THEN
    RAISE EXCEPTION 'FAIL 8: ai_session_messages not in supabase_realtime';
  END IF;
  RAISE NOTICE 'PASS 8: ai_session_messages in supabase_realtime';
END $$;

-- ⑨ الجدولان التوثيقيان موجودان.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema = 'public' AND table_name = 'agent_activity_log') THEN
    RAISE EXCEPTION 'FAIL 9: agent_activity_log table missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema = 'public' AND table_name = 'muse_account_activations') THEN
    RAISE EXCEPTION 'FAIL 9b: muse_account_activations table missing';
  END IF;
  RAISE NOTICE 'PASS 9: documentation tables exist';
END $$;

DO $$ BEGIN RAISE NOTICE 'ALL muse-fast-reply tests passed'; END $$;
