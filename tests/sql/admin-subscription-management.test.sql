-- اختبار تنفيذي لـ migrations/018_admin_subscription_management.sql
--
-- بيثبّت إن عمليات الإدارة تشتغل، وإن العميل لا يستطيع تنفيذها ولو نادى
-- الـRPC مباشرة، وإن تغيير الباقة أو تعطيل الاشتراك بيعيد حساب الامتيازات
-- فعليًا (مش مجرد تغيير شارة في الواجهة).
\set ON_ERROR_STOP on
\pset tuples_only on

CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
END $$;

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY, email text, full_name text, username text, phone text,
  role text NOT NULL DEFAULT 'user', super_user_id uuid,
  whatsapp_enabled boolean DEFAULT false
);
CREATE TABLE public.companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL UNIQUE,
  company_name varchar NOT NULL, commercial_registration_number varchar NOT NULL UNIQUE
);
CREATE TABLE public.tickets (id uuid PRIMARY KEY, ticket_number int, user_id uuid);
CREATE TABLE public.subscription_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), key text NOT NULL UNIQUE,
  name text NOT NULL, name_ar text, is_active boolean NOT NULL DEFAULT true
);
CREATE TABLE public.feature_flags (key text PRIMARY KEY, name_ar text);
CREATE TABLE public.plan_features (
  plan_id uuid NOT NULL REFERENCES public.subscription_plans(id) ON DELETE CASCADE,
  feature_key text NOT NULL REFERENCES public.feature_flags(key) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true, limits jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (plan_id, feature_key)
);
CREATE TABLE public.whatsapp_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, ticket_id uuid,
  status text DEFAULT 'active' CHECK (status IN ('active','expired','pending','rejected')),
  billing_cycle text, start_date timestamptz DEFAULT now(), end_date timestamptz NOT NULL,
  plan text NOT NULL DEFAULT 'whatsapp' CHECK (plan IN ('support','whatsapp','bundle')),
  is_renewal boolean NOT NULL DEFAULT false, company_id uuid,
  payment_method text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN RETURN EXISTS (SELECT 1 FROM public.profiles WHERE id=auth.uid() AND role='admin'); END; $$;
CREATE OR REPLACE FUNCTION public.is_main_admin() RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN RETURN COALESCE((SELECT email FROM public.profiles WHERE id=auth.uid())
  IN ('support@mad3oom.online'), false); END; $$;
CREATE OR REPLACE FUNCTION public.owned_feature_keys(p_user_id uuid DEFAULT auth.uid())
RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select coalesce(array_agg(distinct pf.feature_key), '{}'::text[])
    from public.whatsapp_subscriptions s
    join public.subscription_plans sp on sp.key = s.plan
    join public.plan_features pf on pf.plan_id = sp.id and pf.enabled = true
   where s.user_id = p_user_id and s.status='active' and s.end_date > now();
$$;

GRANT USAGE ON SCHEMA public TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO authenticated;

INSERT INTO public.subscription_plans (key,name,name_ar) VALUES
  ('support','Support','الدعم الفني'),('whatsapp','WhatsApp','واتساب بيزنس'),('bundle','Bundle','الباقة الشاملة');
INSERT INTO public.feature_flags (key,name_ar) VALUES
  ('whatsapp_sender','إرسال واتساب'),('whatsapp_campaigns','الحملات'),
  ('support_tickets','تذاكر الدعم'),('priority_support','أولوية الدعم');
INSERT INTO public.plan_features (plan_id,feature_key)
SELECT sp.id,f.k FROM public.subscription_plans sp JOIN (VALUES
  ('whatsapp','whatsapp_sender'),('whatsapp','whatsapp_campaigns'),
  ('support','support_tickets'),('support','priority_support'),
  ('bundle','whatsapp_sender'),('bundle','whatsapp_campaigns'),
  ('bundle','support_tickets'),('bundle','priority_support')
) AS f(p,k) ON f.p=sp.key;

INSERT INTO public.profiles (id,email,full_name,role,whatsapp_enabled) VALUES
  ('11111111-1111-4111-8111-111111111111','cust@test.local','عميل','super_user',true),
  ('99999999-9999-4999-8999-999999999999','admin@test.local','أدمن','admin',false);
INSERT INTO public.companies (id,user_id,company_name,commercial_registration_number) VALUES
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','11111111-1111-4111-8111-111111111111','شركة أ','1010');
INSERT INTO public.whatsapp_subscriptions (id,user_id,plan,status,billing_cycle,end_date) VALUES
  ('55555555-5555-4555-8555-555555555555','11111111-1111-4111-8111-111111111111',
   'bundle','active','monthly', now() + interval '30 days');

\echo ''
\echo '--- applying migrations/018 ---'
\i migrations/018_admin_subscription_management.sql
\echo '--- migration applied ---'
\echo ''
GRANT EXECUTE ON FUNCTION public.admin_update_subscription(uuid,text,text,timestamptz,timestamptz,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_subscription_status(uuid,text,text,timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_subscriptions() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_subscription_audit(uuid) TO authenticated;
-- Supabase بتمنح الأدوار صلاحيات الجداول الجديدة افتراضيًا، فبنحاكي ده هنا.
-- بدونه كان الحجب سيأتي من نقص الصلاحية لا من RLS، والاختبار كان هيقيس
-- الحاجة الغلط.
GRANT SELECT, INSERT, UPDATE ON public.subscription_audit_log TO authenticated;

\echo '=== A) العميل لا يستطيع تنفيذ عمليات الإدارة ولو نادى الـRPC مباشرة ==='
SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
DO $$
DECLARE sid uuid := '55555555-5555-4555-8555-555555555555';
BEGIN
  BEGIN
    PERFORM public.admin_update_subscription(sid, 'whatsapp');
    RAISE EXCEPTION 'FAIL A1: العميل عدّل اشتراكه';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'FAIL A1%' THEN RAISE; END IF; END;

  BEGIN
    PERFORM public.admin_set_subscription_status(sid, 'expired');
    RAISE EXCEPTION 'FAIL A2: العميل عطّل اشتراكه';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'FAIL A2%' THEN RAISE; END IF; END;

  BEGIN
    PERFORM public.admin_list_subscriptions();
    RAISE EXCEPTION 'FAIL A3: العميل قرأ كل الاشتراكات';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'FAIL A3%' THEN RAISE; END IF; END;

  BEGIN
    PERFORM public.admin_subscription_audit(sid);
    RAISE EXCEPTION 'FAIL A4: العميل قرأ سجل التدقيق';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'FAIL A4%' THEN RAISE; END IF; END;

  -- وسجل التدقيق نفسه محجوب عنه بـRLS
  IF (SELECT count(*) FROM public.subscription_audit_log) <> 0 THEN
    RAISE EXCEPTION 'FAIL A5: العميل قرأ صفوف التدقيق مباشرة'; END IF;

  RAISE NOTICE 'PASS A: كل عمليات الإدارة مرفوضة للعميل (وليس مجرد إخفاء أزرار)';
END $$;

\echo ''
\echo '=== B) تغيير الباقة يعيد حساب الامتيازات فعليًا ==='
SET request.jwt.claim.sub = '99999999-9999-4999-8999-999999999999';
DO $$
DECLARE
  sid uuid := '55555555-5555-4555-8555-555555555555';
  cust uuid := '11111111-1111-4111-8111-111111111111';
  f text[]; r text; w boolean;
BEGIN
  f := public.owned_feature_keys(cust);
  IF NOT ('support_tickets' = ANY(f) AND 'whatsapp_sender' = ANY(f)) THEN
    RAISE EXCEPTION 'FAIL B0: الباقة الشاملة لا تمنح الخدمتين'; END IF;

  -- الشاملة → واتساب فقط: لازم امتيازات الدعم تختفي
  PERFORM public.admin_update_subscription(sid, 'whatsapp', NULL, NULL, NULL, 'تخفيض بطلب العميل');
  f := public.owned_feature_keys(cust);
  IF 'support_tickets' = ANY(f) THEN
    RAISE EXCEPTION 'FAIL B1: امتياز الدعم بقي بعد تغيير الباقة'; END IF;
  IF NOT ('whatsapp_sender' = ANY(f)) THEN
    RAISE EXCEPTION 'FAIL B2: امتياز واتساب ضاع بالخطأ'; END IF;
  RAISE NOTICE 'PASS B1: تغيير الباقة أزال امتيازات الباقة القديمة';

  -- والرتبة المشتقة نزلت لأن الدعم لم يعد مملوكًا
  SELECT role, whatsapp_enabled INTO r, w FROM public.profiles WHERE id = cust;
  IF r <> 'user' THEN RAISE EXCEPTION 'FAIL B3: الرتبة بقيت super_user بلا اشتراك دعم (%)', r; END IF;
  IF w IS NOT TRUE THEN RAISE EXCEPTION 'FAIL B4: whatsapp_enabled أُطفئ رغم امتلاك واتساب'; END IF;
  RAISE NOTICE 'PASS B2: الحالة المشتقة (الرتبة/تفعيل واتساب) أُعيد اشتقاقها';

  -- العودة للشاملة تعيد امتياز الدعم
  PERFORM public.admin_update_subscription(sid, 'bundle');
  f := public.owned_feature_keys(cust);
  IF NOT ('support_tickets' = ANY(f)) THEN
    RAISE EXCEPTION 'FAIL B5: الترقية للشاملة لم تُعِد امتياز الدعم'; END IF;
  RAISE NOTICE 'PASS B3: الترقية تعيد الامتيازات الجديدة';
END $$;

\echo ''
\echo '=== C) التعطيل يوقف الخدمات، وإعادة التفعيل محكومة بالحالة ==='
DO $$
DECLARE
  sid uuid := '55555555-5555-4555-8555-555555555555';
  cust uuid := '11111111-1111-4111-8111-111111111111';
  w boolean;
BEGIN
  PERFORM public.admin_set_subscription_status(sid, 'expired', 'عدم سداد');
  IF array_length(public.owned_feature_keys(cust), 1) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL C1: الخدمات ما زالت متاحة بعد التعطيل'; END IF;
  SELECT whatsapp_enabled INTO w FROM public.profiles WHERE id = cust;
  IF w IS NOT FALSE THEN RAISE EXCEPTION 'FAIL C2: whatsapp_enabled بقي مفعّلًا بعد التعطيل'; END IF;
  RAISE NOTICE 'PASS C1: التعطيل أوقف الخدمات والحالة المشتقة';

  -- إعادة تفعيل بتاريخ منتهٍ = اشتراك "فعّال" لا يعمل؛ ممنوع
  BEGIN
    PERFORM public.admin_set_subscription_status(sid, 'active', 'خطأ إداري', now() - interval '1 day');
    RAISE EXCEPTION 'FAIL C3: أُعيد التفعيل بتاريخ منتهٍ';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'FAIL C3%' THEN RAISE; END IF; END;
  RAISE NOTICE 'PASS C2: إعادة التفعيل بتاريخ ماضٍ مرفوضة';

  -- وبتاريخ مستقبلي تمر وتعيد الخدمات
  PERFORM public.admin_set_subscription_status(sid, 'active', 'تسوية', now() + interval '15 days');
  IF NOT ('support_tickets' = ANY(public.owned_feature_keys(cust))) THEN
    RAISE EXCEPTION 'FAIL C4: إعادة التفعيل لم تُعِد الخدمات'; END IF;
  RAISE NOTICE 'PASS C3: إعادة التفعيل بتاريخ صحيح تعيد الخدمات';

  -- انتقال غير مسموح
  BEGIN
    PERFORM public.admin_set_subscription_status(sid, 'pending');
    RAISE EXCEPTION 'FAIL C5: سُمح بانتقال active → pending';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'FAIL C5%' THEN RAISE; END IF; END;
  RAISE NOTICE 'PASS C4: الانتقالات غير المنطقية مرفوضة';
END $$;

\echo ''
\echo '=== D) حماية من الأخطاء البشرية في التواريخ ==='
DO $$
DECLARE sid uuid := '55555555-5555-4555-8555-555555555555';
BEGIN
  BEGIN
    PERFORM public.admin_update_subscription(sid, NULL, NULL, now(), now() - interval '5 days');
    RAISE EXCEPTION 'FAIL D1: قُبل تاريخ انتهاء قبل البداية';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'FAIL D1%' THEN RAISE; END IF; END;

  BEGIN
    PERFORM public.admin_update_subscription(sid, NULL, 'active', NULL, now() - interval '1 day');
    RAISE EXCEPTION 'FAIL D2: قُبل اشتراك فعّال بتاريخ منتهٍ';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'FAIL D2%' THEN RAISE; END IF; END;

  BEGIN
    PERFORM public.admin_update_subscription(sid, 'plan_وهمية');
    RAISE EXCEPTION 'FAIL D3: قُبلت باقة غير معروفة';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'FAIL D3%' THEN RAISE; END IF; END;

  RAISE NOTICE 'PASS D: التواريخ والباقات غير المنطقية مرفوضة';
END $$;

\echo ''
\echo '=== E) سجل التدقيق يسجّل من غيّر ماذا ==='
DO $$
DECLARE a jsonb; n int;
BEGIN
  a := public.admin_subscription_audit('55555555-5555-4555-8555-555555555555');
  n := jsonb_array_length(a);
  IF n < 4 THEN RAISE EXCEPTION 'FAIL E1: سجل ناقص (% صفوف)', n; END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(a) e
                  WHERE e->>'action'='deactivate' AND e->>'reason'='عدم سداد') THEN
    RAISE EXCEPTION 'FAIL E2: عملية التعطيل وسببها غير مسجّلين'; END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(a) e
                  WHERE e->>'actor_email'='admin@test.local') THEN
    RAISE EXCEPTION 'FAIL E3: هوية المنفّذ غير مسجّلة'; END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(a) e
                  WHERE e->'old_values'->>'plan'='bundle' AND e->'new_values'->>'plan'='whatsapp') THEN
    RAISE EXCEPTION 'FAIL E4: تغيير الباقة قبل/بعد غير مسجّل'; END IF;
  RAISE NOTICE 'PASS E: السجل يحفظ الفاعل والفعل والقيم قبل/بعد والسبب';
END $$;

\echo ''
\echo '=== F) قائمة الإدارة تعرض الشركة والامتيازات الفعلية ==='
DO $$
DECLARE rows jsonb; row1 jsonb;
BEGIN
  rows := public.admin_list_subscriptions();
  IF jsonb_array_length(rows) < 1 THEN RAISE EXCEPTION 'FAIL F1: القائمة فاضية'; END IF;
  row1 := rows->0;
  IF row1->>'company_name' <> 'شركة أ' THEN
    RAISE EXCEPTION 'FAIL F2: الشركة المرتبطة غير ظاهرة (%)', row1->>'company_name'; END IF;
  IF row1->>'customer_email' IS NULL THEN RAISE EXCEPTION 'FAIL F3: بيانات العميل ناقصة'; END IF;
  IF jsonb_array_length(row1->'effective_features') < 1 THEN
    RAISE EXCEPTION 'FAIL F4: الامتيازات الفعلية غير محسوبة'; END IF;
  RAISE NOTICE 'PASS F: القائمة تعرض العميل والشركة والباقة والامتيازات الفعلية';
END $$;
RESET ROLE;

\echo ''
\echo '=== G) الترحيل قابل لإعادة التطبيق ==='
\i migrations/018_admin_subscription_management.sql
DO $$ BEGIN RAISE NOTICE 'PASS G: إعادة تطبيق الترحيل لم تفشل'; END $$;

\echo ''
\echo 'ALL ADMIN SUBSCRIPTION MANAGEMENT TESTS PASSED'
