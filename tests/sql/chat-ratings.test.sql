-- ============================================================================
-- اختبار تنفيذي لـ migrations/124_chat_ratings.sql.
--
-- يثبّت الخصائص التي طُلبت صراحةً، كل واحدة تفشل إن انكسرت:
--
--   ① صاحب الجلسة يحفظ تقييمًا (1..5) مع تعليق اختياري
--   ② تقييم ثانٍ لنفس الجلسة مرفوض (قيد فريد) — نجمة واحدة لكل جلسة
--   ③ نجمة خارج 1..5 مرفوضة (قيد الفحص)
--   ④ غير صاحب الجلسة لا يستطيع الإدراج (RLS)
--   ⑤ غير صاحب الجلسة لا يرى التقييم (RLS تقيس بعدد الصفوف الفعلي)
--   ⑥ صاحب الجلسة يرى تقييمه
--
-- النمط منسوخ من account-gate.test.sql: دور authenticated حقيقي + ادعاء
-- JWT عبر request.jwt.claim.sub، لأن postgres (المستخدم الخارق) يتجاوز
-- RLS فلا يُقاس به شيء.
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

-- بذور الدوال التي يعتمد عليها الترحيل (نسخ دنيا تحاكي توقيعاتها الحية).
CREATE OR REPLACE FUNCTION public.has_elevated_authority() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT false; $$;
CREATE OR REPLACE FUNCTION public.account_is_active() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT true; $$;
CREATE OR REPLACE FUNCTION public.is_platform_staff() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT false; $$;
CREATE OR REPLACE FUNCTION public.inbox_can_access(p_session uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT false; $$;

CREATE TABLE public.chat_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  status text DEFAULT 'active'::text
);

-- جلستان: واحدة للمالك وواحدة لغريب.
INSERT INTO public.chat_sessions (id, user_id, status) VALUES
  ('11111111-1111-4111-8111-111111111111', '00000000-0000-0000-0000-0000000000a1', 'closed'),
  ('22222222-2222-4222-8222-222222222222', '00000000-0000-0000-0000-0000000000b2', 'closed');

\echo '--- applying migrations/124 ---'
\i migrations/124_chat_ratings.sql

-- ① صاحب الجلسة يحفظ تقييمًا.
DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  INSERT INTO public.chat_ratings (session_id, user_id, rating, comment)
  VALUES ('11111111-1111-4111-8111-111111111111', '00000000-0000-0000-0000-0000000000a1', 5, 'ممتاز');
  RESET ROLE;
  RAISE NOTICE 'PASS 1: صاحب الجلسة حفظ تقييم 5 نجوم';
END $$;

-- ② تقييم ثانٍ لنفس الجلسة مرفوض.
DO $$
DECLARE v_ok boolean := false;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO public.chat_ratings (session_id, user_id, rating)
    VALUES ('11111111-1111-4111-8111-111111111111', '00000000-0000-0000-0000-0000000000a1', 4);
  EXCEPTION WHEN unique_violation THEN v_ok := true;
  END;
  RESET ROLE;
  IF NOT v_ok THEN RAISE EXCEPTION 'FAIL 2: التقييم الثاني لنفس الجلسة لم يُرفض'; END IF;
  RAISE NOTICE 'PASS 2: تقييم ثانٍ لنفس الجلسة مرفوض بالقيد الفريد';
END $$;

-- ③ نجمة خارج 1..5 مرفوضة.
DO $$
DECLARE v_ok boolean := false;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000b2', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO public.chat_ratings (session_id, user_id, rating)
    VALUES ('22222222-2222-4222-8222-222222222222', '00000000-0000-0000-0000-0000000000b2', 6);
  EXCEPTION WHEN check_violation THEN v_ok := true;
  END;
  RESET ROLE;
  IF NOT v_ok THEN RAISE EXCEPTION 'FAIL 3: نجمة 6 لم تُرفض'; END IF;
  RAISE NOTICE 'PASS 3: نجمة خارج 1..5 مرفوضة';
END $$;

-- ④ غير صاحب الجلسة لا يستطيع الإدراج.
DO $$
DECLARE v_ok boolean := false;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000b2', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO public.chat_ratings (session_id, user_id, rating)
    VALUES ('11111111-1111-4111-8111-111111111111', '00000000-0000-0000-0000-0000000000b2', 1);
  EXCEPTION WHEN insufficient_privilege THEN v_ok := true;
  END;
  RESET ROLE;
  IF NOT v_ok THEN RAISE EXCEPTION 'FAIL 4: الغريب استطاع تقييم جلسة غيره'; END IF;
  RAISE NOTICE 'PASS 4: إدراج الغريب مرفوض بـ RLS';
END $$;

-- ⑤ الغريب لا يرى التقييم (عدد الصفوف الفعلي = 0).
DO $$
DECLARE v_n int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000b2', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM public.chat_ratings;
  RESET ROLE;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL 5: الغريب رأى % صف', v_n; END IF;
  RAISE NOTICE 'PASS 5: الغريب لا يرى أي تقييم';
END $$;

-- ⑥ صاحب الجلسة يرى تقييمه.
DO $$
DECLARE v_n int; v_r int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*), coalesce(max(rating), 0) INTO v_n, v_r FROM public.chat_ratings;
  RESET ROLE;
  IF v_n <> 1 OR v_r <> 5 THEN RAISE EXCEPTION 'FAIL 6: المالك رأى n=% rating=%', v_n, v_r; END IF;
  RAISE NOTICE 'PASS 6: المالك يرى تقييمه (5 نجوم)';
END $$;

\echo 'ALL chat-ratings checks passed'
