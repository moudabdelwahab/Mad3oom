-- اختبار ترحيل 134 (إصلاحات لوحة الإدارة): الاقتراحات، دوال المحفظة
-- المركزية واختبار تيليجرام، ودوال سير العمل — مع إعادة تشغيل الترحيل
-- نفسه مرتين للتحقق من قابليته لإعادة التشغيل.
--
-- النمط كما في باقي tests/sql/*.test.sql: ننمذج ما يعتمد عليه الترحيل
-- من خارج migrations/ — auth.uid()/auth.jwt() كما يعرّفهما Supabase،
-- و is_admin()/wf_is_admin()/wf_is_staff() (معرّفة في 027/040 و 117،
-- وتُنمذج هنا plpgsql لتأجيل حلّ الجداول حتى التنفيذ)، و pgcrypto
-- لـ gen_random_uuid() كما في Supabase.
\set ON_ERROR_STOP on
\pset tuples_only on

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS auth;

-- أدوار Supabase غير موجودة في Postgres عادي (نمط باقي اختبارات SQL).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
END $$;

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('email', NULLIF(current_setting('request.jwt.claim.email', true), ''));
$$;

CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY, email text);

CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin');
END $$;

CREATE OR REPLACE FUNCTION public.wf_is_admin() RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN public.is_admin();
END $$;

CREATE OR REPLACE FUNCTION public.wf_is_staff() RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN EXISTS (SELECT 1 FROM public.profiles
                 WHERE id = auth.uid() AND role IN ('admin', 'support'));
END $$;

\echo '--- applying migrations/134 (first run) ---'
\i migrations/134_admin_fix_suggestions_wallet_workflows.sql
\echo '--- applying migrations/134 (second run: idempotency) ---'
\i migrations/134_admin_fix_suggestions_wallet_workflows.sql

-- بيانات الاختبار
INSERT INTO auth.users (id, email) VALUES
  ('11111111-1111-4111-8111-111111111111', 'support@mad3oom.online'),
  ('22222222-2222-4222-8222-222222222222', 'customer@example.com')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles (id, email, role) VALUES
  ('11111111-1111-4111-8111-111111111111', 'support@mad3oom.online', 'admin'),
  ('22222222-2222-4222-8222-222222222222', 'customer@example.com', 'user')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.user_wallets (user_id, available_points, total_points, is_frozen)
SELECT '22222222-2222-4222-8222-222222222222', 100, 100, false
WHERE NOT EXISTS (SELECT 1 FROM public.user_wallets WHERE user_id = '22222222-2222-4222-8222-222222222222');

INSERT INTO public.central_wallet (balance, total_transferred)
SELECT 1000000, 0
WHERE NOT EXISTS (SELECT 1 FROM public.central_wallet);

\echo ''
\echo '=== A) جدول suggestions: موجود، وسياساته 4، وقيد الحالة يرفض قيمة غريبة ==='
DO $$
DECLARE v_count int;
BEGIN
  IF to_regclass('public.suggestions') IS NULL THEN
    RAISE EXCEPTION 'FAIL A: suggestions table missing';
  END IF;
  SELECT count(*) INTO v_count FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'suggestions';
  IF v_count <> 4 THEN
    RAISE EXCEPTION 'FAIL A: suggestions policies = % (expected 4)', v_count;
  END IF;
  INSERT INTO public.suggestions (user_id, title, description, category, status)
  VALUES ('22222222-2222-4222-8222-222222222222', 'اقتراح اختبار', 'وصف', 'feature', 'pending');
  BEGIN
    INSERT INTO public.suggestions (user_id, title, status)
    VALUES ('22222222-2222-4222-8222-222222222222', 'سيئ', 'nonsense');
    RAISE EXCEPTION 'FAIL A: status check accepted a nonsense status';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS A: suggestions table + 4 policies + status check';
  END;
END $$;

\echo ''
\echo '=== B) manage_user_points: غير المصرّح يُرفض، و add/deduct/freeze تعمل ==='
-- كمستخدم عادي (بريد غير support@)
SET request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222';
SET request.jwt.claim.email = 'customer@example.com';
DO $$
DECLARE r jsonb;
BEGIN
  r := public.manage_user_points('customer@example.com', 10, 'add');
  IF r->>'success' <> 'false' OR r->>'error_code' <> 'UNAUTHORIZED' THEN
    RAISE EXCEPTION 'FAIL B1: non-support was not rejected: %', r;
  END IF;
  RAISE NOTICE 'PASS B1: non-support rejected (UNAUTHORIZED)';
END $$;

-- كبريد الدعم
SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
SET request.jwt.claim.email = 'support@mad3oom.online';
DO $$
DECLARE
  r jsonb;
  bal int;
  frozen boolean;
BEGIN
  r := public.manage_user_points('customer@example.com', 50, 'add');
  IF r->>'success' <> 'true' THEN RAISE EXCEPTION 'FAIL B2: add failed: %', r; END IF;
  SELECT available_points INTO bal FROM public.user_wallets WHERE user_id = '22222222-2222-4222-8222-222222222222';
  IF bal <> 150 THEN RAISE EXCEPTION 'FAIL B2: balance after add = % (expected 150)', bal; END IF;

  r := public.manage_user_points('customer@example.com', 200, 'deduct');
  IF r->>'success' <> 'false' OR r->>'error_code' <> 'INSUFFICIENT_BALANCE' THEN
    RAISE EXCEPTION 'FAIL B3: over-deduct not rejected: %', r;
  END IF;

  r := public.manage_user_points('customer@example.com', 30, 'deduct');
  IF r->>'success' <> 'true' THEN RAISE EXCEPTION 'FAIL B4: deduct failed: %', r; END IF;
  SELECT available_points INTO bal FROM public.user_wallets WHERE user_id = '22222222-2222-4222-8222-222222222222';
  IF bal <> 120 THEN RAISE EXCEPTION 'FAIL B4: balance after deduct = % (expected 120)', bal; END IF;

  r := public.manage_user_points('customer@example.com', 0, 'freeze');
  IF r->>'success' <> 'true' THEN RAISE EXCEPTION 'FAIL B5: freeze failed: %', r; END IF;
  SELECT is_frozen INTO frozen FROM public.user_wallets WHERE user_id = '22222222-2222-4222-8222-222222222222';
  IF NOT frozen THEN RAISE EXCEPTION 'FAIL B5: wallet not frozen'; END IF;

  r := public.manage_user_points('customer@example.com', 0, 'unfreeze');
  SELECT is_frozen INTO frozen FROM public.user_wallets WHERE user_id = '22222222-2222-4222-8222-222222222222';
  IF frozen THEN RAISE EXCEPTION 'FAIL B6: wallet not unfrozen'; END IF;

  r := public.manage_user_points('customer@example.com', 0, 'burn');
  IF r->>'success' <> 'false' OR r->>'error_code' <> 'INVALID_ACTION' THEN
    RAISE EXCEPTION 'FAIL B7: invalid action not rejected: %', r;
  END IF;
  RAISE NOTICE 'PASS B: manage_user_points add/deduct/freeze/unfreeze/invalid-action';
END $$;

\echo ''
\echo '=== C) transfer_points_from_central: رصيد غير كافٍ يُرفض، والتحويل يخصم ويضيف ==='
DO $$
DECLARE
  r jsonb;
  central_bal bigint;
  user_bal int;
BEGIN
  r := public.transfer_points_from_central('customer@example.com', 2000000);
  IF r->>'success' <> 'false' OR r->>'error_code' <> 'INSUFFICIENT_BALANCE' THEN
    RAISE EXCEPTION 'FAIL C1: over-transfer not rejected: %', r;
  END IF;

  r := public.transfer_points_from_central('customer@example.com', 200);
  IF r->>'success' <> 'true' THEN RAISE EXCEPTION 'FAIL C2: transfer failed: %', r; END IF;
  SELECT balance INTO central_bal FROM public.central_wallet LIMIT 1;
  IF central_bal <> 999800 THEN RAISE EXCEPTION 'FAIL C2: central balance = % (expected 999800)', central_bal; END IF;
  SELECT available_points INTO user_bal FROM public.user_wallets WHERE user_id = '22222222-2222-4222-8222-222222222222';
  IF user_bal <> 320 THEN RAISE EXCEPTION 'FAIL C2: user balance = % (expected 320)', user_bal; END IF;
  RAISE NOTICE 'PASS C: transfer_points_from_central';
END $$;

\echo ''
\echo '=== D) send_test_telegram_alert: بلا ربط يُرفض، وبربط ينجح (بلا توكن = صامت) ==='
DO $$
DECLARE r jsonb;
BEGIN
  r := public.send_test_telegram_alert();
  IF r->>'success' <> 'false' OR r->>'error' <> 'no_telegram_linked' THEN
    RAISE EXCEPTION 'FAIL D1: unlinked user was not rejected: %', r;
  END IF;
  UPDATE public.profiles SET telegram_chat_id = '12345'
   WHERE id = '11111111-1111-4111-8111-111111111111';
  r := public.send_test_telegram_alert();
  IF r->>'success' <> 'true' THEN RAISE EXCEPTION 'FAIL D2: linked alert failed: %', r; END IF;
  RAISE NOTICE 'PASS D: send_test_telegram_alert';
END $$;

\echo ''
\echo '=== E) دوال سير العمل: مسودة ثم نشر يفعّل التدفق ==='
DO $$
DECLARE
  v_wf uuid;
  v_ver uuid;
  v_status text;
  v_pub uuid;
BEGIN
  INSERT INTO public.wf_workflows (name, status, trigger_event_key, trigger_config)
  VALUES ('تدفق اختبار', 'draft', 'ticket_created', '{}'::jsonb)
  RETURNING id INTO v_wf;

  v_ver := public.create_workflow_draft_version(v_wf, NULL, 'اختبار');
  IF v_ver IS NULL THEN RAISE EXCEPTION 'FAIL E1: no draft version id'; END IF;

  UPDATE public.wf_workflow_versions
     SET definition = '{"nodes":[{"id":"t1","type":"trigger.ticket_created","config":{}}],"edges":[]}'::jsonb,
         trigger_event_key = 'ticket_created'
   WHERE id = v_ver;

  PERFORM public.publish_workflow(v_wf);
  SELECT status, published_version_id INTO v_status, v_pub
    FROM public.wf_workflows WHERE id = v_wf;
  IF v_status <> 'active' THEN RAISE EXCEPTION 'FAIL E2: workflow status = % (expected active)', v_status; END IF;
  IF v_pub <> v_ver THEN RAISE EXCEPTION 'FAIL E2: published_version_id mismatch'; END IF;
  RAISE NOTICE 'PASS E: create_workflow_draft_version + publish_workflow';
END $$;

\echo ''
\echo 'ALL ADMIN-FIX-134 SQL TESTS DONE'
