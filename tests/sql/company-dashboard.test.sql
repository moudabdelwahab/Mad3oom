-- اختبار تنفيذي لـ migrations/016_company_dashboard.sql
--
-- بيبني نموذج مصغّر مطابق للجزء المعني من قاعدة البيانات الحقيقية (companies
-- بقيود NOT NULL الأصلية، whatsapp_subscriptions بسياساتها، subscription_plans
-- و plan_features و feature_flags، وتسلسل profiles.super_user_id)، وبيثبّت:
--
--   1) الشركة بتتكوّن من مسار الاشتراك بالبيانات القانونية الأساسية فقط.
--   2) الاشتراك بيترتبط بالشركة، والامتيازات بتختلف فعليًا حسب الباقة.
--   3) انتهاء الاشتراك بيسحب الامتيازات تلقائيًا (نفس تعريف المنصة للفعالية).
--   4) عزل كامل: مستخدم شركة A لا يقرأ ولا يعدّل ولا يربط أي شيء بشركة B،
--      ولا بتغيير ID في الطلب — لأن الدوال أصلًا لا تأخذ معرّف شركة.
\set ON_ERROR_STOP on
\pset tuples_only on

CREATE SCHEMA IF NOT EXISTS auth;

-- تعريف Supabase الحقيقي
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
END $$;

CREATE TABLE public.profiles (
  id            uuid PRIMARY KEY,
  email         text,
  role          text NOT NULL DEFAULT 'user',
  super_user_id uuid
);

-- نفس تعريف الإنتاج بالضبط، بما فيه NOT NULL على الحقول التشغيلية
-- (الترحيل هو اللي بيخففها — لو ما خففهاش الاختبار A2 هيفشل).
CREATE TABLE public.companies (
  id                             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                        uuid NOT NULL UNIQUE,
  company_name                   varchar NOT NULL,
  commercial_registration_number varchar NOT NULL UNIQUE,
  company_email                  varchar NOT NULL,
  company_phone                  varchar NOT NULL,
  address                        text    NOT NULL,
  city                           varchar NOT NULL,
  country                        varchar NOT NULL,
  website                        varchar,
  industry                       varchar,
  employee_count                 varchar,
  tax_id                         varchar,
  created_at                     timestamptz DEFAULT now(),
  updated_at                     timestamptz DEFAULT now()
);

CREATE TABLE public.subscription_plans (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key        text NOT NULL UNIQUE,
  name       text NOT NULL,
  name_ar    text,
  is_active  boolean NOT NULL DEFAULT true,
  sort_order int NOT NULL DEFAULT 100
);

CREATE TABLE public.feature_flags (
  key         text PRIMARY KEY,
  name        text,
  name_ar     text,
  description text
);

CREATE TABLE public.plan_features (
  plan_id     uuid NOT NULL REFERENCES public.subscription_plans(id) ON DELETE CASCADE,
  feature_key text NOT NULL REFERENCES public.feature_flags(key) ON DELETE CASCADE,
  enabled     boolean NOT NULL DEFAULT true,
  limits      jsonb   NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (plan_id, feature_key)
);

CREATE TABLE public.whatsapp_subscriptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL,
  ticket_id     uuid,
  status        text DEFAULT 'active' CHECK (status IN ('active','expired','pending','rejected')),
  billing_cycle text CHECK (billing_cycle IN ('monthly','yearly')),
  start_date    timestamptz DEFAULT now(),
  end_date      timestamptz NOT NULL,
  plan          text NOT NULL DEFAULT 'whatsapp' CHECK (plan IN ('support','whatsapp','bundle')),
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  RETURN EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin');
END; $$;

-- بديل مبسّط لـis_main_admin(): في الإنتاج بتقرأ auth.users، وهنا بتقرأ
-- public.profiles.email عشان النموذج المصغّر ما يحتاجش سكيما auth كاملة.
-- المُختبَر هنا هو منطق الحارس الجديد، مش منطق is_main_admin نفسها.
CREATE OR REPLACE FUNCTION public.is_main_admin() RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  RETURN COALESCE(
    (SELECT email FROM public.profiles WHERE id = auth.uid())
      IN ('support@mad3oom.online', 'info@mad3oom.online'),
    false);
END; $$;

-- الحارس الحقيقي المنسوخ من الإنتاج على تبعية المستخدم: بيغطّي UPDATE فقط
-- (لاحظ شرط TG_OP = 'UPDATE')، وده بالظبط الفراغ اللي الترحيل بيسدّه بحارس
-- INSERT مستقل. وجوده هنا ضروري عشان الاختبار يعكس الإنتاج بأمانة.
CREATE OR REPLACE FUNCTION public.check_super_user_creation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
    IF NEW.role = 'super_user' THEN
        IF NOT public.is_main_admin() THEN
            RAISE EXCEPTION 'فقط support@mad3oom.online يمكنه إنشاء أو تعيين حسابات سوبر يوزر';
        END IF;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF OLD.super_user_id IS DISTINCT FROM NEW.super_user_id AND NOT public.is_main_admin() THEN
             RAISE EXCEPTION 'لا يمكن تغيير تبعية المستخدم إلا بواسطة الإدارة العليا';
        END IF;
    END IF;

    RETURN NEW;
END; $$;

CREATE TRIGGER tr_check_super_user_creation
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.check_super_user_creation();

-- السياسات الحقيقية المنسوخة من الإنتاج، قبل تطبيق الترحيل
ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view their own company" ON public.companies
  FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "Users can insert their own company" ON public.companies
  FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY "Users can update their own company" ON public.companies
  FOR UPDATE USING (user_id = auth.uid());

ALTER TABLE public.whatsapp_subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view their own subscriptions" ON public.whatsapp_subscriptions
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can create their own subscriptions" ON public.whatsapp_subscriptions
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update their own subscriptions" ON public.whatsapp_subscriptions
  FOR UPDATE USING (auth.uid() = user_id);

ALTER TABLE public.subscription_plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone authenticated can read subscription_plans" ON public.subscription_plans
  FOR SELECT USING (auth.uid() IS NOT NULL);
ALTER TABLE public.plan_features ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone authenticated can read plan_features" ON public.plan_features
  FOR SELECT USING (auth.uid() IS NOT NULL);

GRANT USAGE ON SCHEMA public TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO authenticated;

-- الباقات الثلاث بنفس مفاتيح الإنتاج
INSERT INTO public.subscription_plans (key, name, name_ar, sort_order) VALUES
  ('support',  'Support',           'الدعم الفني',   10),
  ('whatsapp', 'WhatsApp Business', 'واتساب بيزنس',  20),
  ('bundle',   'Bundle',            'الباقة الشاملة',30);

-- مفاتيح موجودة أصلًا في الإنتاج (الترحيل بيضيف الباقي)
INSERT INTO public.feature_flags (key, name, name_ar, description) VALUES
  ('api_tokens', 'API Access', 'مفاتيح API', 'إصدار وإدارة مفاتيح API'),
  ('mcp_client', 'MCP Client', 'عميل MCP',   'إدارة اتصالات MCP');

-- المستخدمون: مالك شركة A، مستخدم فرعي تابع له، مالك شركة B، ومستخدم بلا شركة
INSERT INTO public.profiles (id, email, role, super_user_id) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'owner-a@test.local', 'user', NULL),
  ('a5a5a5a5-a5a5-4a5a-8a5a-a5a5a5a5a5a5', 'staff-a@test.local',  'user', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'owner-b@test.local', 'user', NULL),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'solo@test.local',    'user', NULL);

\echo ''
\echo '--- applying migrations/016 ---'
\i migrations/016_company_dashboard.sql
\echo '--- migration applied ---'
\echo ''

GRANT EXECUTE ON FUNCTION public.upsert_my_company(text,text,date,text,text,text,text,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_company_dashboard() TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_company_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.company_has_feature(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.link_subscription_to_my_company(uuid) TO authenticated;

\echo '=== A) إنشاء الشركة من مسار الاشتراك ==='
SET ROLE authenticated;
SET request.jwt.claim.sub = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
DO $$
DECLARE cid uuid; failed boolean;
BEGIN
  -- A1: الحقول القانونية الثلاثة إلزامية
  FOR failed IN SELECT true LOOP END LOOP;
  BEGIN
    PERFORM public.upsert_my_company('', '1010101010', current_date + 365);
    RAISE EXCEPTION 'FAIL A1: تم قبول شركة بلا اسم';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'FAIL A1%' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.upsert_my_company('شركة أ', '', current_date + 365);
    RAISE EXCEPTION 'FAIL A1b: تم قبول شركة بلا سجل تجاري';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'FAIL A1b%' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.upsert_my_company('شركة أ', '1010101010', NULL);
    RAISE EXCEPTION 'FAIL A1c: تم قبول شركة بلا تاريخ انتهاء سجل';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'FAIL A1c%' THEN RAISE; END IF;
  END;
  RAISE NOTICE 'PASS A1: البيانات القانونية الأساسية إلزامية';

  -- A2: الإنشاء ينجح بالبيانات الأساسية وحدها (NOT NULL التشغيلية اتخففت)
  cid := public.upsert_my_company('شركة أ', '1010101010', current_date + 365);
  IF cid IS NULL THEN RAISE EXCEPTION 'FAIL A2: لم تُنشأ الشركة'; END IF;
  RAISE NOTICE 'PASS A2: الشركة تُنشأ بالبيانات القانونية الأساسية فقط';

  -- A3: تاريخ انتهاء السجل محفوظ فعلًا
  IF NOT EXISTS (SELECT 1 FROM public.companies
                  WHERE id = cid AND commercial_registration_expiry = current_date + 365) THEN
    RAISE EXCEPTION 'FAIL A3: تاريخ انتهاء السجل لم يُحفظ';
  END IF;
  RAISE NOTICE 'PASS A3: تاريخ انتهاء السجل التجاري محفوظ';
END $$;

-- شركة ب لمالك آخر
SET request.jwt.claim.sub = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
DO $$
DECLARE cid uuid;
BEGIN
  cid := public.upsert_my_company('شركة ب', '2020202020', current_date + 200);
  IF cid IS NULL THEN RAISE EXCEPTION 'FAIL A4: لم تُنشأ شركة ب'; END IF;

  -- A5: رقم السجل التجاري فريد على مستوى المنصة
  BEGIN
    PERFORM public.upsert_my_company('شركة ب', '1010101010', current_date + 200);
    RAISE EXCEPTION 'FAIL A5: تم قبول رقم سجل تجاري مكرر';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'FAIL A5%' THEN RAISE; END IF;
  END;
  RAISE NOTICE 'PASS A4/A5: شركة ثانية مستقلة، ورقم السجل التجاري فريد';
END $$;

\echo ''
\echo '=== B) ربط الاشتراك بالشركة والامتيازات حسب الباقة ==='
SET request.jwt.claim.sub = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
INSERT INTO public.whatsapp_subscriptions (id, user_id, plan, status, billing_cycle, start_date, end_date)
VALUES ('11111111-1111-4111-8111-111111111111',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'whatsapp', 'active', 'monthly', now(), now() + interval '30 days');

DO $$
DECLARE d jsonb; linked boolean; keys text[];
BEGIN
  -- B1: الربط ينجح لاشتراك المنادي نفسه
  linked := public.link_subscription_to_my_company('11111111-1111-4111-8111-111111111111');
  IF NOT linked THEN RAISE EXCEPTION 'FAIL B1: لم يتم ربط الاشتراك بالشركة'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.whatsapp_subscriptions
                  WHERE id = '11111111-1111-4111-8111-111111111111'
                    AND company_id = public.current_company_id()) THEN
    RAISE EXCEPTION 'FAIL B1b: company_id لم يُكتب';
  END IF;
  RAISE NOTICE 'PASS B1: الاشتراك مرتبط بالشركة';

  -- B2: اللوحة تعرض الشركة واشتراكها الفعّال
  d := public.get_my_company_dashboard();
  IF d IS NULL THEN RAISE EXCEPTION 'FAIL B2: اللوحة فاضية لمستخدم مؤهل'; END IF;
  IF d->'company'->>'name' <> 'شركة أ' THEN
    RAISE EXCEPTION 'FAIL B2b: اسم شركة غير متوقع %', d->'company'->>'name'; END IF;
  IF (d->'access'->>'has_active_subscription')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL B2c: الاشتراك الفعّال غير محتسب'; END IF;
  RAISE NOTICE 'PASS B2: لوحة الشركة تظهر للمستخدم المؤهل';

  -- B3: امتيازات باقة واتساب فقط — ولا شيء من امتيازات الدعم الفني
  SELECT array_agg(e->>'feature_key' ORDER BY e->>'feature_key')
    INTO keys FROM jsonb_array_elements(d->'entitlements') e;
  IF NOT ('whatsapp_sender' = ANY(keys)) THEN
    RAISE EXCEPTION 'FAIL B3: امتياز واتساب غير ظاهر (%)', keys; END IF;
  IF 'support_tickets' = ANY(keys) OR 'priority_support' = ANY(keys) THEN
    RAISE EXCEPTION 'FAIL B3b: امتيازات الدعم الفني ظهرت لباقة واتساب (%)', keys; END IF;
  RAISE NOTICE 'PASS B3: الامتيازات مشتقة من الباقة المشترَك بها فقط';

  -- B4: نفس النتيجة من دالة الفحص المفردة
  IF NOT public.company_has_feature('whatsapp_sender') THEN
    RAISE EXCEPTION 'FAIL B4: company_has_feature أنكرت امتيازًا قائمًا'; END IF;
  IF public.company_has_feature('priority_support') THEN
    RAISE EXCEPTION 'FAIL B4b: company_has_feature منحت امتيازًا غير مشترَك'; END IF;
  RAISE NOTICE 'PASS B4: فحص الامتياز المفرد متسق مع اللوحة';
END $$;

\echo ''
\echo '=== C) تعدد الاشتراكات: الامتيازات تتّحد ==='
INSERT INTO public.whatsapp_subscriptions (id, user_id, plan, status, billing_cycle, start_date, end_date)
VALUES ('33333333-3333-4333-8333-333333333333',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'support', 'active', 'monthly', now(), now() + interval '30 days');
DO $$
DECLARE keys text[];
BEGIN
  SELECT array_agg(e->>'feature_key' ORDER BY e->>'feature_key')
    INTO keys FROM jsonb_array_elements(public.get_my_company_dashboard()->'entitlements') e;
  IF NOT ('whatsapp_sender' = ANY(keys)) OR NOT ('support_tickets' = ANY(keys)) THEN
    RAISE EXCEPTION 'FAIL C1: اتحاد امتيازات الاشتراكين لم يحدث (%)', keys; END IF;
  RAISE NOTICE 'PASS C1: امتيازات كل الاشتراكات الفعّالة تظهر معًا';
END $$;

\echo ''
\echo '=== D) انتهاء الاشتراك يسحب الامتيازات ==='
RESET ROLE;
UPDATE public.whatsapp_subscriptions
   SET status = 'expired', end_date = now() - interval '1 day'
 WHERE user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
SET ROLE authenticated;
SET request.jwt.claim.sub = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
DO $$
DECLARE d jsonb;
BEGIN
  d := public.get_my_company_dashboard();
  IF d IS NULL THEN RAISE EXCEPTION 'FAIL D1: الشركة اختفت بانتهاء الاشتراك'; END IF;
  IF (d->'access'->>'has_active_subscription')::boolean IS NOT FALSE THEN
    RAISE EXCEPTION 'FAIL D1b: اشتراك منتهٍ ما زال محسوبًا فعّالًا'; END IF;
  IF jsonb_array_length(d->'entitlements') <> 0 THEN
    RAISE EXCEPTION 'FAIL D2: امتيازات باقية بعد انتهاء الاشتراك'; END IF;
  IF public.company_has_feature('whatsapp_sender') THEN
    RAISE EXCEPTION 'FAIL D3: امتياز باقٍ بعد انتهاء الاشتراك'; END IF;
  -- سجل الاشتراكات نفسه يفضل ظاهر للعرض (حالته expired)
  IF jsonb_array_length(d->'subscriptions') = 0 THEN
    RAISE EXCEPTION 'FAIL D4: سجل الاشتراكات اختفى'; END IF;
  RAISE NOTICE 'PASS D: انتهاء الاشتراك يغيّر الوصول والامتيازات تلقائيًا';
END $$;

-- إرجاع اشتراك واتساب لحالته الفعّالة لاختبارات العزل التالية
RESET ROLE;
UPDATE public.whatsapp_subscriptions
   SET status = 'active', end_date = now() + interval '30 days'
 WHERE id = '11111111-1111-4111-8111-111111111111';

-- جدول اختباري فقط: بيسرّب معرّف شركة أ عمدًا لمستخدم ب، عشان اختبار العبث
-- يبقى حقيقي. من غيره مستخدم ب مش هيقدر أصلًا يقرأ المعرّف (RLS بيحجبه)،
-- فالإدخال هيعدي بـNULL ومش هيختبر الـtrigger أصلًا.
CREATE TABLE public.test_ids (label text PRIMARY KEY, val uuid);
INSERT INTO public.test_ids
SELECT 'company_a', id FROM public.companies WHERE company_name = 'شركة أ';
GRANT SELECT ON public.test_ids TO authenticated;

SET ROLE authenticated;

\echo ''
\echo '=== E) العزل بين الشركات ==='
SET request.jwt.claim.sub = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
DO $$
DECLARE d jsonb; n int; linked boolean; a_company uuid;
BEGIN
  -- E1: اللوحة ترجّع شركة المنادي فقط
  d := public.get_my_company_dashboard();
  IF d->'company'->>'name' <> 'شركة ب' THEN
    RAISE EXCEPTION 'FAIL E1: مستخدم ب رأى % بدلًا من شركته', d->'company'->>'name'; END IF;
  RAISE NOTICE 'PASS E1: كل مستخدم يرى شركته هو';

  -- E2: القراءة المباشرة من الجدول محكومة بـRLS
  SELECT count(*) INTO n FROM public.companies;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL E2: مستخدم ب قرأ % صف من companies', n; END IF;
  SELECT count(*) INTO n FROM public.companies WHERE company_name = 'شركة أ';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL E2b: مستخدم ب قرأ بيانات شركة أ'; END IF;
  RAISE NOTICE 'PASS E2: لا قراءة لبيانات شركة أخرى';

  -- E3: لا يمكن ربط اشتراك شركة أ بشركة ب (تغيير ID في الطلب)
  linked := public.link_subscription_to_my_company('11111111-1111-4111-8111-111111111111');
  IF linked THEN RAISE EXCEPTION 'FAIL E3: تم ربط اشتراك مستخدم آخر'; END IF;
  RAISE NOTICE 'PASS E3: تمرير معرّف اشتراك غريب لا يفعل شيئًا';

  -- E4: تعديل مباشر على اشتراك شركة أ محجوب بـRLS
  UPDATE public.whatsapp_subscriptions
     SET company_id = public.current_company_id()
   WHERE id = '11111111-1111-4111-8111-111111111111';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL E4: مستخدم ب عدّل اشتراك مستخدم أ'; END IF;
  RAISE NOTICE 'PASS E4: تعديل اشتراك مستخدم آخر محجوب';

  -- E5: إدخال اشتراك خاص بي لكن مربوط بشركة أ — يرفضه الـtrigger.
  -- المعرّف متاح هنا عمدًا (public.test_ids) عشان نختبر أسوأ حالة: مهاجم
  -- يعرف معرّف الشركة التانية فعلًا ويحاول يمرّره في الطلب.
  SELECT val INTO a_company FROM public.test_ids WHERE label = 'company_a';
  IF a_company IS NULL THEN RAISE EXCEPTION 'FAIL E5-setup: معرّف شركة أ غير متاح للاختبار'; END IF;
  BEGIN
    INSERT INTO public.whatsapp_subscriptions (user_id, plan, status, billing_cycle, end_date, company_id)
    VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'whatsapp', 'pending', 'monthly',
            now() + interval '30 days', a_company);
    RAISE EXCEPTION 'FAIL E5: تم ربط اشتراكي بشركة غيري';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'FAIL E5%' THEN RAISE; END IF;
  END;
  RAISE NOTICE 'PASS E5: القاعدة ترفض ربط اشتراك بشركة لا تخص الحساب';

  -- E5b: ونفس المنع على التحديث، مش الإدخال بس
  INSERT INTO public.whatsapp_subscriptions (id, user_id, plan, status, billing_cycle, end_date)
  VALUES ('22222222-2222-4222-8222-222222222222',
          'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'whatsapp', 'pending', 'monthly',
          now() + interval '30 days');
  BEGIN
    UPDATE public.whatsapp_subscriptions
       SET company_id = a_company
     WHERE id = '22222222-2222-4222-8222-222222222222';
    RAISE EXCEPTION 'FAIL E5b: تم تحويل اشتراكي لشركة غيري بالتحديث';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'FAIL E5b%' THEN RAISE; END IF;
  END;
  RAISE NOTICE 'PASS E5b: التحديث كذلك لا يسمح بالتحويل لشركة أخرى';

  -- E6: تعديل بيانات شركة أخرى محجوب
  UPDATE public.companies SET company_name = 'مخترقة' WHERE company_name = 'شركة أ';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL E6: مستخدم ب عدّل بيانات شركة أ'; END IF;
  RAISE NOTICE 'PASS E6: تعديل بيانات شركة أخرى محجوب';

  -- E7: امتيازات شركة ب لا تتأثر باشتراكات شركة أ
  IF public.company_has_feature('whatsapp_sender') THEN
    RAISE EXCEPTION 'FAIL E7: شركة ب ورثت امتياز اشتراك شركة أ'; END IF;
  RAISE NOTICE 'PASS E7: الامتيازات لا تتسرّب بين الشركات';
END $$;

\echo ''
\echo '=== F) عضو الشركة (مستخدم فرعي) والمستخدم بلا شركة ==='
SET request.jwt.claim.sub = 'a5a5a5a5-a5a5-4a5a-8a5a-a5a5a5a5a5a5';
DO $$
DECLARE d jsonb; n int;
BEGIN
  -- F1: المستخدم الفرعي التابع لمالك شركة أ يرى شركة أ
  d := public.get_my_company_dashboard();
  IF d IS NULL OR d->'company'->>'name' <> 'شركة أ' THEN
    RAISE EXCEPTION 'FAIL F1: عضو الشركة لا يرى شركته'; END IF;
  IF (d->'company'->>'is_owner')::boolean IS NOT FALSE THEN
    RAISE EXCEPTION 'FAIL F1b: العضو الفرعي معلَّم كمالك'; END IF;
  SELECT count(*) INTO n FROM public.companies;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL F1c: العضو قرأ % شركة', n; END IF;
  RAISE NOTICE 'PASS F1: عضو الشركة يقرأ شركته فقط وليس مالكًا لها';

  -- F2: العضو الفرعي لا ينشئ شركة موازية
  BEGIN
    PERFORM public.upsert_my_company('شركة موازية', '9090909090', current_date + 100);
    RAISE EXCEPTION 'FAIL F2: العضو الفرعي أنشأ شركة موازية';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'FAIL F2%' THEN RAISE; END IF;
  END;
  RAISE NOTICE 'PASS F2: العضو الفرعي لا ينشئ شركة موازية';
END $$;

SET request.jwt.claim.sub = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
DO $$
DECLARE n int;
BEGIN
  -- F3: مستخدم بلا شركة لا لوحة له
  IF public.get_my_company_dashboard() IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL F3: ظهرت لوحة لمستخدم بلا شركة'; END IF;
  IF public.current_company_id() IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL F3b: مستخدم بلا شركة حصل على معرّف شركة'; END IF;
  IF public.company_has_feature('whatsapp_sender') THEN
    RAISE EXCEPTION 'FAIL F3c: مستخدم بلا شركة حصل على امتياز'; END IF;
  SELECT count(*) INTO n FROM public.companies;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL F3d: مستخدم بلا شركة قرأ % صف', n; END IF;
  RAISE NOTICE 'PASS F3: لا لوحة ولا امتيازات لمن لا يملك شركة';
END $$;

RESET request.jwt.claim.sub;
DO $$ BEGIN
  IF public.get_my_company_dashboard() IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL F4: الدالة رجّعت بيانات لمستخدم غير مسجّل'; END IF;
  RAISE NOTICE 'PASS F4: لا بيانات لغير المسجّلين';
END $$;
RESET ROLE;

\echo ''
\echo '=== SU) تبعية المستخدم (super_user_id) لا تُزوَّر عند الإنشاء ==='
-- عضوية الشركة بتُشتق من profiles.super_user_id، فلو مستخدم قدر يعيّن العمود
-- ده بنفسه على مالك شركة تانية، كان هيقرأ بياناتها. الحارس القائم بيغطّي
-- UPDATE فقط؛ الترحيل بيضيف حارس INSERT، والاختبار ده بيثبّت الاتنين.
SET ROLE authenticated;
SET request.jwt.claim.sub = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
DO $$
DECLARE owner_a uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
BEGIN
  -- SU1: مهاجم ينشئ بروفايله وهو مُعلَّم كتابع لمالك شركة أ
  BEGIN
    INSERT INTO public.profiles (id, email, role, super_user_id)
    VALUES ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'attacker@test.local', 'user', owner_a);
    RAISE EXCEPTION 'FAIL SU1: تم تعيين تبعية لمالك شركة أخرى عند الإنشاء';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'FAIL SU1%' THEN RAISE; END IF;
  END;
  RAISE NOTICE 'PASS SU1: لا يمكن تزوير التبعية عند الإنشاء';

  -- SU2: نفس الإدخال بدون تبعية مسموح (مسار التسجيل الطبيعي)
  INSERT INTO public.profiles (id, email, role, super_user_id)
  VALUES ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'attacker@test.local', 'user', NULL);
  RAISE NOTICE 'PASS SU2: التسجيل الطبيعي (بلا تبعية) لم يتأثر';

  -- SU3: وبالتالي لا شركة له ولا امتيازات
  IF public.current_company_id() IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL SU3: المهاجم حصل على شركة'; END IF;
  IF public.get_my_company_dashboard() IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL SU3b: المهاجم قرأ لوحة شركة'; END IF;
  RAISE NOTICE 'PASS SU3: لا وصول لشركة غيره';

  -- SU4: والتعديل اللاحق للتبعية مرفوض كذلك (الحارس القائم)
  BEGIN
    UPDATE public.profiles SET super_user_id = owner_a
     WHERE id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    RAISE EXCEPTION 'FAIL SU4: تم تغيير التبعية بالتحديث';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'FAIL SU4%' THEN RAISE; END IF;
  END;
  RAISE NOTICE 'PASS SU4: التحديث اللاحق للتبعية مرفوض أيضًا';
END $$;

-- SU5: مسار create-sub-user الشرعي (مفتاح الخدمة، بلا JWT) لم يتأثر
RESET ROLE;
RESET request.jwt.claim.sub;
DO $$ BEGIN
  INSERT INTO public.profiles (id, email, role, super_user_id)
  VALUES ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'staff2-a@test.local', 'user',
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  RAISE NOTICE 'PASS SU5: إنشاء مستخدم فرعي بمفتاح الخدمة ما زال يعمل';
END $$;

-- SU6: والمستخدم الفرعي الشرعي ده فعلًا بيشوف شركة مالكه
SET ROLE authenticated;
SET request.jwt.claim.sub = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
DO $$ BEGIN
  IF public.get_my_company_dashboard()->'company'->>'name' <> 'شركة أ' THEN
    RAISE EXCEPTION 'FAIL SU6: المستخدم الفرعي الشرعي لا يرى شركة مالكه'; END IF;
  RAISE NOTICE 'PASS SU6: العضوية الشرعية ما زالت تعمل بعد الحارس';
END $$;
RESET ROLE;

\echo ''
\echo '=== G) صلاحيات التنفيذ ==='
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.get_my_company_dashboard()',
    'public.current_company_id()',
    'public.company_has_feature(text)',
    'public.link_subscription_to_my_company(uuid)',
    'public.upsert_my_company(text,text,date,text,text,text,text,text,text)'
  ] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'FAIL G1: anon يقدر ينفّذ %', f; END IF;
    IF NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'FAIL G2: authenticated لا يقدر ينفّذ %', f; END IF;
  END LOOP;
  RAISE NOTICE 'PASS G: كل دوال لوحة الشركة متاحة للمسجّلين فقط';
END $$;

\echo ''
\echo '=== H) الترحيل قابل لإعادة التطبيق (idempotent) ==='
\i migrations/016_company_dashboard.sql
DO $$ BEGIN
  RAISE NOTICE 'PASS H: إعادة تطبيق الترحيل لم تفشل';
END $$;

\echo ''
\echo 'ALL COMPANY DASHBOARD TESTS PASSED'
