-- ============================================================================
-- 140_company_data_export_and_deletion — تصدير بيانات الشركة وطلب حذفها
--
-- على نمط admin-fix-134.test.sql: بذور دنيا لما يعتمد عليه الترحيل فقط
-- (auth.uid() كما يعرّفه Supabase، وcurrent_company_id() /
-- is_company_admin() بنسختين أمينتين للمالك — التعريف الحقيقي في
-- 016/040 يضيف سياق العضوية وفحص الرتبة/القدرة، والبوابة المُختبَرة
-- هنا هي «المالك مقابل غير المالك» لا تفاصيل ذلك الفحص)، ثم الترحيل
-- مرتين للتحقق من قابليته لإعادة التشغيل.
--
--   ⓪ الكائنات والصلاحيات وRLS، والتراجع وإعادة التطبيق
--   ① التصدير: الأقسام الخمسة كاملة وبحدودها، والفواتير صراحةً
--      available=false، وبلا هواتف أعضاء وبلا بيانات دفع، وصف التدقيق
--   ② العزل: العضو غير المدير مرفوض، والفرد مرفوض، وشركة أخرى لا ترى
--      شيئًا من الأولى
--   ③ قائمة التصدير: آخر العمليات بترتيبها
--   ④ طلب الحذف: البوابة، والسبب الإلزامي (20 حرفًا)، ومانع التكرار
--      (23505)، والحالة، والإلغاء، وطلب جديد بعد الإلغاء
-- ============================================================================
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

CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY, email text);

-- بذرة أمينة لسياق الشركة: شركة المنادي = الشركة التي يملكها (016/095
-- تضيفان سياق العضوية؛ التصدير والحذف للمالك، فالمالك يكفي هنا).
-- plpgsql عمدًا: لغة SQL تحلّ الجداول وقت الإنشاء، والجداول تُبذر بعدها.
CREATE OR REPLACE FUNCTION public.current_company_id() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
BEGIN
  RETURN (SELECT id FROM public.companies WHERE user_id = auth.uid() LIMIT 1);
END $$;

-- بذرة أمينة لمدير الشركة: مالك شركة (040 يضيف فحص الرتبة/القدرة؛
-- البوابة المُختبَرة هنا هي المالك مقابل غير المالك).
CREATE OR REPLACE FUNCTION public.is_company_admin() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
BEGIN
  RETURN EXISTS (SELECT 1 FROM public.companies WHERE user_id = auth.uid());
END $$;

-- مساعد: رمز حالة الخطأ لنداء، أو 'ok'.
CREATE OR REPLACE FUNCTION t_err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE 'select ' || p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN sqlstate; END $$;

-- ── بذور الجداول (الأعمدة التي يقرؤها الترحيل وحدها) ─────────────────────
CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid PRIMARY KEY, email text, role text, full_name text, username text,
  phone text, created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS public.companies (
  id uuid PRIMARY KEY, user_id uuid NOT NULL, company_name varchar(255) NOT NULL,
  commercial_registration_number varchar(100) NOT NULL,
  commercial_registration_expiry date, status text DEFAULT 'active',
  company_email varchar(320), company_phone varchar(20), address text,
  city varchar(100), country varchar(100), website varchar(255),
  industry varchar(100), employee_count varchar(50), tax_id varchar(100),
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS public.company_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
  user_id uuid NOT NULL, is_primary boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active', joined_at timestamptz DEFAULT now(),
  joined_via text NOT NULL DEFAULT 'invitation',
  ended_at timestamptz, ended_by uuid, end_cause text);
CREATE TABLE IF NOT EXISTS public.tickets (
  id uuid PRIMARY KEY, user_id uuid NOT NULL, title text NOT NULL,
  description text NOT NULL, status text DEFAULT 'open', priority text DEFAULT 'medium',
  category text, ticket_type text DEFAULT 'problem', ticket_number bigint,
  scope text, company_id uuid, assigned_to uuid,
  created_at timestamptz DEFAULT now(), first_response_at timestamptz,
  resolved_at timestamptz, last_updated_at timestamptz);
CREATE TABLE IF NOT EXISTS public.whatsapp_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL,
  plan text DEFAULT 'whatsapp', status text DEFAULT 'active',
  billing_cycle text, start_date timestamptz DEFAULT now(),
  end_date timestamptz NOT NULL, duration_days integer,
  company_id uuid, created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS public.activity_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, action text NOT NULL,
  details jsonb DEFAULT '{}'::jsonb, created_at timestamptz DEFAULT now(),
  ip_address text, user_agent text);
CREATE TABLE IF NOT EXISTS public.company_membership_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, company_id uuid NOT NULL,
  user_id uuid NOT NULL, actor_id uuid, action text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz DEFAULT now());

\echo '--- applying migrations/140 (first run) ---'
\i migrations/140_company_data_export_and_deletion.sql
\echo '--- applying migrations/140 (second run: idempotency) ---'
\i migrations/140_company_data_export_and_deletion.sql

-- ── بيانات الاختبار: شركتان، وعضو نشط وعضو منتهٍ، وفرد ──────────────────
INSERT INTO auth.users (id, email) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'oa@test'),
  ('a0000000-0000-4000-8000-000000000002', 'a1@test'),
  ('a0000000-0000-4000-8000-000000000003', 'ob@test'),
  ('a0000000-0000-4000-8000-000000000004', 'b1@test'),
  ('a0000000-0000-4000-8000-000000000005', 'a2@test'),
  ('a0000000-0000-4000-8000-000000000006', 'pu@test')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.profiles (id, email, role, full_name, phone, created_at) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'oa@test', 'company_admin', 'مالك أ', '01000000001', '2026-09-01'),
  ('a0000000-0000-4000-8000-000000000002', 'a1@test', 'user', 'عضو أ1', '01000000002', '2026-09-02'),
  ('a0000000-0000-4000-8000-000000000003', 'ob@test', 'company_admin', 'مالك ب', '01000000003', '2026-09-01'),
  ('a0000000-0000-4000-8000-000000000004', 'b1@test', 'user', 'عضو ب1', '01000000004', '2026-09-02'),
  ('a0000000-0000-4000-8000-000000000005', 'a2@test', 'user', 'عضو أ منتهٍ', '01000000005', '2026-09-03'),
  ('a0000000-0000-4000-8000-000000000006', 'pu@test', 'user', 'فرد', '01000000006', '2026-09-04')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.companies (id, user_id, company_name, commercial_registration_number, company_email, company_phone, city, country, tax_id) VALUES
  ('c0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'شركة أ', 'CR-A', 'a@company.test', '01000000101', 'القاهرة', 'مصر', 'TAX-A'),
  ('c0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000003', 'شركة ب', 'CR-B', 'b@company.test', '01000000102', 'الجيزة', 'مصر', 'TAX-B')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.company_memberships (company_id, user_id, is_primary, status, joined_at, joined_via) VALUES
  ('c0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002', false, 'active', '2026-09-02', 'invitation'),
  ('c0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000004', false, 'active', '2026-09-02', 'invitation')
ON CONFLICT DO NOTHING;
INSERT INTO public.company_memberships (company_id, user_id, is_primary, status, joined_at, joined_via, ended_at, end_cause) VALUES
  ('c0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000005', false, 'ended', '2026-09-03', 'invitation', '2026-10-01', 'removed')
ON CONFLICT DO NOTHING;
INSERT INTO public.tickets (id, user_id, title, description, ticket_number, scope, company_id, status, created_at) VALUES
  ('e0000000-0000-4000-8000-000000000011', 'a0000000-0000-4000-8000-000000000002', 'تذكرة شركة أ', 'وصف', 101, 'company', 'c0000000-0000-4000-8000-000000000001', 'open', '2026-10-01'),
  ('e0000000-0000-4000-8000-000000000012', 'a0000000-0000-4000-8000-000000000001', 'تذكرة دعم للمالك', 'وصف', 102, 'mad3oom_support', 'c0000000-0000-4000-8000-000000000001', 'open', '2026-10-02'),
  ('e0000000-0000-4000-8000-000000000013', 'a0000000-0000-4000-8000-000000000004', 'تذكرة شركة ب', 'وصف', 201, 'company', 'c0000000-0000-4000-8000-000000000002', 'open', '2026-10-01')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.whatsapp_subscriptions (id, user_id, plan, status, billing_cycle, start_date, end_date, duration_days, company_id) VALUES
  ('d0000000-0000-4000-8000-000000000011', 'a0000000-0000-4000-8000-000000000001', 'support', 'active', 'monthly', now() - interval '5 days', now() + interval '25 days', 30, 'c0000000-0000-4000-8000-000000000001'),
  ('d0000000-0000-4000-8000-000000000012', 'a0000000-0000-4000-8000-000000000001', 'whatsapp', 'active', 'monthly', now() - interval '5 days', now() + interval '25 days', 30, NULL),
  ('d0000000-0000-4000-8000-000000000013', 'a0000000-0000-4000-8000-000000000003', 'support', 'active', 'monthly', now() - interval '5 days', now() + interval '25 days', 30, 'c0000000-0000-4000-8000-000000000002')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.activity_logs (user_id, action, details, created_at, ip_address, user_agent) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'login', '{"device": "متصفح"}', '2026-10-05', '1.2.3.4', 'Mozilla-test'),
  ('a0000000-0000-4000-8000-000000000002', 'ticket_created', '{}', '2026-10-06', '5.6.7.8', 'Mozilla-test'),
  ('a0000000-0000-4000-8000-000000000004', 'login', '{}', '2026-10-05', '9.9.9.9', 'Mozilla-test'),
  ('a0000000-0000-4000-8000-000000000006', 'login', '{}', '2026-10-05', '8.8.8.8', 'Mozilla-test')
ON CONFLICT DO NOTHING;
INSERT INTO public.company_membership_events (company_id, user_id, actor_id, action, detail, created_at) VALUES
  ('c0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'joined', '{}', '2026-09-02'),
  ('c0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000003', 'joined', '{}', '2026-09-02')
ON CONFLICT DO NOTHING;

\echo ''
\echo '=== ⓪ الكائنات والصلاحيات وRLS ==='
DO $$
BEGIN
  IF to_regprocedure('public.company_export_data()') IS NULL
     OR to_regprocedure('public.company_data_exports_list()') IS NULL
     OR to_regprocedure('public.company_request_account_deletion(text)') IS NULL
     OR to_regprocedure('public.company_deletion_request_status()') IS NULL
     OR to_regprocedure('public.company_cancel_deletion_request()') IS NULL THEN
    RAISE EXCEPTION 'FAIL ⓪: إحدى دوال 140 غائبة';
  END IF;
  IF to_regclass('public.company_data_exports') IS NULL
     OR to_regclass('public.company_deletion_requests') IS NULL THEN
    RAISE EXCEPTION 'FAIL ⓪: جدولا 140 غائبان';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.company_export_data()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.company_request_account_deletion(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL ⓪: دوال 140 غير ممنوحة لـ authenticated';
  END IF;
  IF has_function_privilege('anon', 'public.company_export_data()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.company_request_account_deletion(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL ⓪: دوال 140 مكشوفة لـ anon';
  END IF;
  IF (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.company_data_exports'::regclass) IS DISTINCT FROM true
     OR (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.company_deletion_requests'::regclass) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL ⓪: RLS غير مفعّل على جدولي 140';
  END IF;
  RAISE NOTICE 'PASS ⓪: دوال 140 الخمس وجدولاها وRLS والمنح كما أُعلنت';
END $$;

\echo ''
\echo '=== ① التصدير الكامل لمدير الشركة أ ==='
SET request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000001';
DO $$
DECLARE v jsonb; v_audit int;
BEGIN
  v := public.company_export_data();
  IF v->>'format' <> 'mad3oom-company-data-export' OR (v->>'format_version')::int <> 1 THEN
    RAISE EXCEPTION 'FAIL ①: صيغة التصدير ليست mad3oom-company-data-export v1: %', v->'format';
  END IF;
  IF v->'company'->>'name' <> 'شركة أ' OR v->'company'->>'cr_number' <> 'CR-A' THEN
    RAISE EXCEPTION 'FAIL ①: الملف الشخصي للشركة ناقص أو لشركة أخرى';
  END IF;
  IF jsonb_array_length(v->'members') <> 2 THEN
    RAISE EXCEPTION 'FAIL ①: الأعضاء = % (المتوقع 2: المالك + العضو النشط، بلا المنتهي)', jsonb_array_length(v->'members');
  END IF;
  IF v::text LIKE '%عضو أ منتهٍ%' THEN
    RAISE EXCEPTION 'FAIL ①: العضو المنتهي تسرّب إلى التصدير';
  END IF;
  IF v->'members'->0 ? 'phone' OR v->'members'->1 ? 'phone' THEN
    RAISE EXCEPTION 'FAIL ①: هواتف الأعضاء دخلت الملف (085 تحجبها)';
  END IF;
  IF jsonb_array_length(v->'tickets') <> 1 OR v->'tickets'->0->>'title' <> 'تذكرة شركة أ' THEN
    RAISE EXCEPTION 'FAIL ①: التذاكر = % (المتوقع تذكرة نطاق الشركة وحدها، بلا تذكرة الدعم)', jsonb_array_length(v->'tickets');
  END IF;
  IF jsonb_array_length(v->'subscriptions') <> 2 THEN
    RAISE EXCEPTION 'FAIL ①: الاشتراكات = % (المتوقع 2: المرتبط بالشركة + اشتراك مالكها)', jsonb_array_length(v->'subscriptions');
  END IF;
  IF v->'subscriptions'->0 ? 'payment_reference' OR v->'subscriptions'->1 ? 'payment_reference' THEN
    RAISE EXCEPTION 'FAIL ①: بيانات دفع دخلت الملف';
  END IF;
  IF (v->'invoices'->>'available')::boolean THEN
    RAISE EXCEPTION 'FAIL ①: الفواتير أُعلنت متاحة — لا مصدر موثوق لها';
  END IF;
  IF v->'invoices'->>'table' <> 'accounting_invoices'
     OR v->'invoices'->>'invoice_home' <> 'subscription_request_ticket'
     OR v->'invoices'->>'reason' NOT LIKE '%بلا عمود يربط الفاتورة بشركة%' THEN
    RAISE EXCEPTION 'FAIL ①: قسم الفواتير الصريح ناقص (الجدول/السبب/الموطن)';
  END IF;
  IF jsonb_array_length(v->'activity') <> 2 THEN
    RAISE EXCEPTION 'FAIL ①: سجل النشاط = % (المتوقع 2: المالك والعضو، بلا شركة ب والفرد)', jsonb_array_length(v->'activity');
  END IF;
  IF v::text LIKE '%1.2.3.4%' OR v::text LIKE '%5.6.7.8%' OR v::text LIKE '%Mozilla-test%' THEN
    RAISE EXCEPTION 'FAIL ①: عنوان IP أو وكيل المستخدم تسرّب إلى سجل النشاط المصدَّر';
  END IF;
  IF v->'activity'->0 ? 'ip_address' OR v->'activity'->0 ? 'user_agent' THEN
    RAISE EXCEPTION 'FAIL ①: عمودا ip_address/user_agent دخلا صفوف النشاط المصدَّرة';
  END IF;
  IF jsonb_array_length(v->'membership_events') <> 1 THEN
    RAISE EXCEPTION 'FAIL ①: أحداث العضويات = % (المتوقع حدث شركة أ وحده)', jsonb_array_length(v->'membership_events');
  END IF;
  IF (v->'counts'->>'members')::int <> 2 OR (v->'counts'->>'tickets')::int <> 1
     OR (v->'counts'->>'subscriptions')::int <> 2 OR (v->'counts'->>'invoices')::int <> 0 THEN
    RAISE EXCEPTION 'FAIL ①: العدّادات لا تطابق الأقسام: %', v->'counts';
  END IF;
  IF v->>'file_name' NOT LIKE 'mad3oom-company-data-%.json' THEN
    RAISE EXCEPTION 'FAIL ①: اسم الملف ليس بالنمط المتوقع: %', v->>'file_name';
  END IF;
  SELECT count(*) INTO v_audit FROM public.company_data_exports
   WHERE company_id = 'c0000000-0000-4000-8000-000000000001'
     AND exported_by = 'a0000000-0000-4000-8000-000000000001';
  IF v_audit <> 1 THEN
    RAISE EXCEPTION 'FAIL ①: صف التدقيق لم يُكتب (العدد %)', v_audit;
  END IF;
  RAISE NOTICE 'PASS ①: التصدير كامل — الأقسام الخمسة، والفواتير صراحةً غير متاحة، وصف التدقيق مكتوب';
END $$;

\echo ''
\echo '=== ② العزل: العضو والفرد وشركة أخرى ==='
DO $$
BEGIN
  IF t_err('public.company_export_data()') <> 'ok' THEN
    RAISE EXCEPTION 'FAIL ②: الإعداد خاطئ — تصدير المالك نفسه فشل';
  END IF;
END $$;
SET request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000002';
DO $$
BEGIN
  IF t_err('public.company_export_data()') <> '42501' THEN
    RAISE EXCEPTION 'FAIL ②: العضو غير المدير صدّر (المتوقع 42501)';
  END IF;
  IF t_err('public.company_request_account_deletion(''سبب طويل بما يكفي للطلب هنا'')') <> '42501' THEN
    RAISE EXCEPTION 'FAIL ②: العضو غير المدير طلب الحذف (المتوقع 42501)';
  END IF;
  RAISE NOTICE 'PASS ②a: العضو غير المدير مرفوض في التصدير والحذف';
END $$;
SET request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000006';
DO $$
BEGIN
  IF t_err('public.company_export_data()') <> '42501' THEN
    RAISE EXCEPTION 'FAIL ②: الحساب الفردي صدّر (المتوقع 42501)';
  END IF;
  RAISE NOTICE 'PASS ②b: الحساب الفردي مرفوض';
END $$;
SET request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000003';
DO $$
DECLARE v jsonb;
BEGIN
  v := public.company_export_data();
  IF v->'company'->>'name' <> 'شركة ب' THEN
    RAISE EXCEPTION 'FAIL ②: مدير شركة ب رأى شركة غير شركته';
  END IF;
  IF v::text LIKE '%شركة أ%' OR v::text LIKE '%عضو أ1%' THEN
    RAISE EXCEPTION 'FAIL ②: بيانات شركة أ تسرّبت إلى تصدير شركة ب';
  END IF;
  IF jsonb_array_length(v->'members') <> 2 OR jsonb_array_length(v->'tickets') <> 1 THEN
    RAISE EXCEPTION 'FAIL ②: تصدير شركة ب ناقص (الأعضاء %، التذاكر %)', jsonb_array_length(v->'members'), jsonb_array_length(v->'tickets');
  END IF;
  RAISE NOTICE 'PASS ②c: مدير شركة ب يرى شركته وحدها';
END $$;

\echo ''
\echo '=== ③ قائمة التصدير ==='
SET request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000001';
DO $$
DECLARE v jsonb;
BEGIN
  v := public.company_data_exports_list();
  IF jsonb_array_length(v) <> 2 THEN
    RAISE EXCEPTION 'FAIL ③: قائمة التصدير = % (المتوقع 2: تصديرا المالك أ)', jsonb_array_length(v);
  END IF;
  IF (v->0->'sections'->>'members')::int <> 2 THEN
    RAISE EXCEPTION 'FAIL ③: أحدث تصدير في القائمة بلا عدّاداته';
  END IF;
  RAISE NOTICE 'PASS ③: قائمة التصدير تعيد آخر العمليات بعدّاداتها';
END $$;
SET request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000002';
DO $$
BEGIN
  IF public.company_data_exports_list() IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL ③: العضو غير المدير رأى قائمة التصدير';
  END IF;
  RAISE NOTICE 'PASS ③b: قائمة التصدير null لغير المدير';
END $$;

\echo ''
\echo '=== ④ طلب الحذف: السبب، ومانع التكرار، والحالة، والإلغاء ==='
SET request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000001';
DO $$
DECLARE v jsonb; v_n int;
BEGIN
  IF public.company_deletion_request_status() IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL ④: حالة الحذف ليست null قبل أي طلب';
  END IF;
  IF t_err('public.company_request_account_deletion(''قصير'')') <> '22023' THEN
    RAISE EXCEPTION 'FAIL ④: سبب قصير قُبل (المتوقع 22023)';
  END IF;
  IF t_err('public.company_request_account_deletion(''   '')') <> '22023' THEN
    RAISE EXCEPTION 'FAIL ④: سبب فارغ قُبل (المتوقع 22023)';
  END IF;
  v := public.company_request_account_deletion('أغلقنا الشركة نهائيًا ونريد حذف بياناتها من المنصة');
  IF v->>'status' <> 'pending' OR v->>'company_id' <> 'c0000000-0000-4000-8000-000000000001' THEN
    RAISE EXCEPTION 'FAIL ④: الطلب الأول لم يرجع pending لشركة أ: %', v;
  END IF;
  IF v->>'note' NOT LIKE '%لا يُحذف شيء فورًا%' THEN
    RAISE EXCEPTION 'FAIL ④: الطلب لم يعلن أنه لا يحذف فورًا';
  END IF;
  SELECT count(*) INTO v_n FROM public.companies WHERE id = 'c0000000-0000-4000-8000-000000000001' AND status = 'active';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'FAIL ④: الطلب أوقف الشركة فورًا — المطلوب أن تبقى نشطة حتى المراجعة';
  END IF;
  IF t_err('public.company_request_account_deletion(''أغلقنا الشركة نهائيًا ونريد حذف بياناتها من المنصة'')') <> '23505' THEN
    RAISE EXCEPTION 'FAIL ④: طلب ثانٍ معلّق قُبل (المتوقع 23505)';
  END IF;
  v := public.company_deletion_request_status();
  IF v IS NULL OR v->>'status' <> 'pending' OR v->>'reason' NOT LIKE '%أغلقنا الشركة%' THEN
    RAISE EXCEPTION 'FAIL ④: حالة الطلب المعلّق لا تعيده';
  END IF;
  RAISE NOTICE 'PASS ④a: الطلب pending، والسبب الإلزامي ومانع التكرار يعملان، والشركة ما زالت نشطة';
END $$;
SET request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000002';
DO $$
BEGIN
  IF t_err('public.company_cancel_deletion_request()') <> '42501' THEN
    RAISE EXCEPTION 'FAIL ④: العضو غير المدير ألغى الطلب (المتوقع 42501)';
  END IF;
  RAISE NOTICE 'PASS ④b: إلغاء الطلب لمدير الشركة وحده';
END $$;
SET request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000001';
DO $$
DECLARE v jsonb;
BEGIN
  v := public.company_cancel_deletion_request();
  IF v->>'status' <> 'cancelled' THEN
    RAISE EXCEPTION 'FAIL ④: الإلغاء لم يرجع cancelled: %', v;
  END IF;
  IF public.company_deletion_request_status() IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL ④: الحالة ما زالت تعيد طلبًا بعد إلغائه';
  END IF;
  IF t_err('public.company_cancel_deletion_request()') <> 'P0002' THEN
    RAISE EXCEPTION 'FAIL ④: إلغاء بلا طلب معلّق قُبل (المتوقع P0002)';
  END IF;
  v := public.company_request_account_deletion('أغلقنا الشركة نهائيًا ونريد حذف بياناتها من المنصة');
  IF v->>'status' <> 'pending' THEN
    RAISE EXCEPTION 'FAIL ④: طلب جديد بعد الإلغاء لم ينجح';
  END IF;
  PERFORM public.company_cancel_deletion_request();
  RAISE NOTICE 'PASS ④c: الإلغاء يعمل، وطلب جديد بعد الإلغاء ينجح (الفهرس الجزئي على المعلّق وحده)';
END $$;

\echo ''
\echo '=== ⑤ التراجع وإعادة التطبيق ==='
\i migrations/_rollback/140_company_data_export_and_deletion.down.sql
DO $$
BEGIN
  IF to_regprocedure('public.company_export_data()') IS NOT NULL
     OR to_regprocedure('public.company_request_account_deletion(text)') IS NOT NULL
     OR to_regclass('public.company_data_exports') IS NOT NULL
     OR to_regclass('public.company_deletion_requests') IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL ⑤: التراجع لم يسقط دوال وجداول 140';
  END IF;
  RAISE NOTICE 'PASS ⑤a: التراجع يسقط الدوال والجداول';
END $$;
\i migrations/140_company_data_export_and_deletion.sql
DO $$
BEGIN
  IF to_regprocedure('public.company_export_data()') IS NULL
     OR to_regprocedure('public.company_request_account_deletion(text)') IS NULL THEN
    RAISE EXCEPTION 'FAIL ⑤: إعادة التطبيق بعد التراجع لم تعد الدوال';
  END IF;
  RAISE NOTICE 'PASS ⑤b: إعادة التطبيق بعد التراجع تعمل';
END $$;

\echo ''
\echo 'ALL 140 company data export and deletion tests passed'
