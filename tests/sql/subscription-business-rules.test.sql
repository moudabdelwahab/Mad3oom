-- اختبار تنفيذي لـ migrations/017_subscription_business_rules.sql
--
-- بيثبّت مصفوفة التداخل المطلوبة كاملة، والأهم: إن المنع في القاعدة نفسها،
-- فطلب مباشر على الـAPI (INSERT خام) بيترفض زي ما بيترفض من الواجهة.
\set ON_ERROR_STOP on
\pset tuples_only on

CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
END $$;

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY, email text, role text NOT NULL DEFAULT 'user', super_user_id uuid
);
CREATE TABLE public.subscription_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), key text NOT NULL UNIQUE,
  name text NOT NULL, name_ar text, is_active boolean NOT NULL DEFAULT true,
  sort_order int NOT NULL DEFAULT 100
);
CREATE TABLE public.feature_flags (key text PRIMARY KEY, name text, name_ar text, description text);
CREATE TABLE public.plan_features (
  plan_id uuid NOT NULL REFERENCES public.subscription_plans(id) ON DELETE CASCADE,
  feature_key text NOT NULL REFERENCES public.feature_flags(key) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true, limits jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (plan_id, feature_key)
);
CREATE TABLE public.whatsapp_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL, ticket_id uuid,
  status text DEFAULT 'active' CHECK (status IN ('active','expired','pending','rejected')),
  billing_cycle text CHECK (billing_cycle IN ('monthly','yearly')),
  start_date timestamptz DEFAULT now(), end_date timestamptz NOT NULL,
  plan text NOT NULL DEFAULT 'whatsapp' CHECK (plan IN ('support','whatsapp','bundle')),
  is_renewal boolean NOT NULL DEFAULT false,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
);
-- الجدول الميت الذي كانت has_feature_access تقرأ منه (يبقى فاضيًا عمدًا)
CREATE TABLE public.customer_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, plan_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active', start_date timestamptz NOT NULL DEFAULT now(),
  end_date timestamptz
);

CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN RETURN EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role='admin'); END; $$;
CREATE OR REPLACE FUNCTION public.is_main_admin() RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN RETURN COALESCE((SELECT email FROM public.profiles WHERE id=auth.uid())
  IN ('support@mad3oom.online','info@mad3oom.online'), false); END; $$;

-- النسخة القديمة (تقرأ الجدول الفاضي) — الترحيل هو اللي بيستبدلها
CREATE OR REPLACE FUNCTION public.has_feature_access(p_feature_key text, p_user_id uuid DEFAULT auth.uid())
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select exists (
    select 1 from public.customer_subscriptions cs
    join public.plan_features pf on pf.plan_id = cs.plan_id and pf.enabled = true
    where cs.user_id = p_user_id and cs.status='active'
      and (cs.end_date is null or cs.end_date > now())
      and pf.feature_key = p_feature_key
  ) or public.is_admin();
$$;

-- النسخة الأصلية من حارس التبعية كما هي في الإنتاج قبل الترحيل: لاحظ غياب
-- استثناء مفتاح الخدمة (auth.uid() IS NULL) الموجود في كل الحرّاس الأخرى.
-- ده بالضبط سبب تعطّل create-sub-user، والترحيل هو اللي بيضيفه.
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

ALTER TABLE public.whatsapp_subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view their own subscriptions" ON public.whatsapp_subscriptions
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can create their own subscriptions" ON public.whatsapp_subscriptions
  FOR INSERT WITH CHECK (auth.uid() = user_id);
-- سياسة الإنتاج الحقيقية للأدمن (منسوخة كما هي): بدونها لا يمكن اختبار
-- تسوية الأدمن اليدوية أصلًا لأن RLS ترفض قبل وصول الحارس.
CREATE POLICY "Admins can manage all subscriptions" ON public.whatsapp_subscriptions
  FOR ALL USING (EXISTS (SELECT 1 FROM public.profiles
    WHERE profiles.id = auth.uid() AND profiles.role = 'admin'));
GRANT USAGE ON SCHEMA public TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO authenticated;

INSERT INTO public.subscription_plans (key, name, name_ar, sort_order) VALUES
  ('support','Support','الدعم الفني',10),
  ('whatsapp','WhatsApp Business','واتساب بيزنس',20),
  ('bundle','Bundle','الباقة الشاملة',30);
INSERT INTO public.feature_flags (key, name_ar) VALUES
  ('api_tokens','مفاتيح API'), ('whatsapp_sender','إرسال واتساب'),
  ('whatsapp_autoreply','الردود التلقائية'), ('whatsapp_campaigns','الحملات'),
  ('whatsapp_wallet','رصيد واتساب'), ('support_tickets','تذاكر الدعم'),
  ('priority_support','أولوية الدعم'), ('sub_users','مستخدمون فرعيون');

-- نفس خريطة الترحيل 016: الباقة الشاملة = واتساب + الدعم الفني بالضبط
INSERT INTO public.plan_features (plan_id, feature_key)
SELECT sp.id, f.k FROM public.subscription_plans sp
JOIN (VALUES
  ('whatsapp','whatsapp_sender'),('whatsapp','whatsapp_autoreply'),
  ('whatsapp','whatsapp_campaigns'),('whatsapp','whatsapp_wallet'),
  ('support','support_tickets'),('support','priority_support'),
  ('support','sub_users'),('support','api_tokens'),
  ('bundle','whatsapp_sender'),('bundle','whatsapp_autoreply'),
  ('bundle','whatsapp_campaigns'),('bundle','whatsapp_wallet'),
  ('bundle','support_tickets'),('bundle','priority_support'),
  ('bundle','sub_users'),('bundle','api_tokens')
) AS f(p,k) ON f.p = sp.key;

INSERT INTO public.profiles (id, email, role) VALUES
  ('11111111-1111-4111-8111-111111111111','u1@test.local','user'),
  ('22222222-2222-4222-8222-222222222222','u2@test.local','user'),
  ('33333333-3333-4333-8333-333333333333','u3@test.local','user'),
  ('99999999-9999-4999-8999-999999999999','admin@test.local','admin');

\echo ''
\echo '--- applying migrations/017 ---'
\i migrations/017_subscription_business_rules.sql
\echo '--- migration applied ---'
\echo ''
GRANT EXECUTE ON FUNCTION public.subscription_purchase_check(text, boolean, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.owned_feature_keys(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.plan_feature_keys(text) TO authenticated;

-- مساعد اختباري: يمنح اشتراكًا فعّالًا بتجاوز الحارس (كأنه أدمن سوّاه يدويًا)
CREATE OR REPLACE FUNCTION public.t_grant(p_user uuid, p_plan text) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO public.whatsapp_subscriptions (user_id, plan, status, billing_cycle, end_date)
  VALUES (p_user, p_plan, 'active', 'monthly', now() + interval '30 days');
$$;

\echo '=== A) الباقة الشاملة = واتساب + الدعم الفني بالضبط ==='
DO $$
DECLARE b text[]; w text[]; s text[]; u text[];
BEGIN
  b := public.plan_feature_keys('bundle');
  w := public.plan_feature_keys('whatsapp');
  s := public.plan_feature_keys('support');
  SELECT array_agg(DISTINCT x ORDER BY x) INTO u FROM (SELECT unnest(w||s) x) q;
  IF NOT (b @> u AND u @> b) THEN
    RAISE EXCEPTION 'FAIL A1: الباقة الشاملة ليست اتحاد الباقتين بالضبط (% مقابل %)', b, u; END IF;
  RAISE NOTICE 'PASS A1: الباقة الشاملة = واتساب + الدعم الفني بالضبط';
END $$;

\echo ''
\echo '=== B) مصفوفة التداخل (القرار مبني على الامتيازات لا الأسماء) ==='
-- u1: الباقة الشاملة فعّالة
SELECT public.t_grant('11111111-1111-4111-8111-111111111111','bundle');
-- u2: واتساب فقط
SELECT public.t_grant('22222222-2222-4222-8222-222222222222','whatsapp');
-- u3: واتساب + دعم فني (منفصلين)
SELECT public.t_grant('33333333-3333-4333-8333-333333333333','whatsapp');
SELECT public.t_grant('33333333-3333-4333-8333-333333333333','support');

DO $$
DECLARE
  u1 uuid := '11111111-1111-4111-8111-111111111111';
  u2 uuid := '22222222-2222-4222-8222-222222222222';
  u3 uuid := '33333333-3333-4333-8333-333333333333';
  r jsonb;
BEGIN
  -- الباقة الشاملة فعّالة → واتساب ممنوع
  r := public.subscription_purchase_check('whatsapp', false, u1);
  IF (r->>'allowed')::boolean THEN RAISE EXCEPTION 'FAIL B1: سُمح بشراء واتساب مع باقة شاملة'; END IF;
  IF r->>'code' <> 'redundant' THEN RAISE EXCEPTION 'FAIL B1b: كود غير متوقع %', r->>'code'; END IF;
  RAISE NOTICE 'PASS B1: الباقة الشاملة فعّالة → شراء واتساب مرفوض';

  -- الباقة الشاملة فعّالة → الدعم الفني ممنوع
  r := public.subscription_purchase_check('support', false, u1);
  IF (r->>'allowed')::boolean THEN RAISE EXCEPTION 'FAIL B2: سُمح بشراء الدعم مع باقة شاملة'; END IF;
  RAISE NOTICE 'PASS B2: الباقة الشاملة فعّالة → شراء الدعم الفني مرفوض';

  -- الباقة الشاملة فعّالة → شراؤها مرة أخرى ممنوع
  r := public.subscription_purchase_check('bundle', false, u1);
  IF (r->>'allowed')::boolean THEN RAISE EXCEPTION 'FAIL B3: سُمح بشراء نفس الباقة مرتين'; END IF;
  IF r->>'code' <> 'duplicate_plan' THEN RAISE EXCEPTION 'FAIL B3b: كود غير متوقع %', r->>'code'; END IF;
  RAISE NOTICE 'PASS B3: نفس الباقة الفعّالة لا تُشترى مرتين';

  -- لكن تجديدها مسموح
  r := public.subscription_purchase_check('bundle', true, u1);
  IF NOT (r->>'allowed')::boolean THEN RAISE EXCEPTION 'FAIL B4: التجديد مُنع'; END IF;
  RAISE NOTICE 'PASS B4: تجديد الباقة الفعّالة مسموح';

  -- واتساب فعّال → واتساب ممنوع
  r := public.subscription_purchase_check('whatsapp', false, u2);
  IF (r->>'allowed')::boolean THEN RAISE EXCEPTION 'FAIL B5: سُمح بتكرار واتساب'; END IF;
  RAISE NOTICE 'PASS B5: واتساب فعّال → شراء واتساب مرفوض';

  -- واتساب فعّال → الدعم الفني مسموح (خدمة إضافية حقيقية)
  r := public.subscription_purchase_check('support', false, u2);
  IF NOT (r->>'allowed')::boolean THEN RAISE EXCEPTION 'FAIL B6: مُنع شراء خدمة إضافية حقيقية'; END IF;
  IF r->>'code' <> 'adds_features' THEN RAISE EXCEPTION 'FAIL B6b: كود غير متوقع %', r->>'code'; END IF;
  RAISE NOTICE 'PASS B6: واتساب فعّال → شراء الدعم الفني مسموح';

  -- واتساب فعّال → الباقة الشاملة مسموحة (ترقية: تضيف امتيازات الدعم)
  r := public.subscription_purchase_check('bundle', false, u2);
  IF NOT (r->>'allowed')::boolean THEN RAISE EXCEPTION 'FAIL B7: مُنعت ترقية حقيقية للباقة الشاملة'; END IF;
  RAISE NOTICE 'PASS B7: واتساب فعّال → الترقية للباقة الشاملة مسموحة';

  -- واتساب + دعم فني → الباقة الشاملة ممنوعة (لا تضيف شيئًا)
  r := public.subscription_purchase_check('bundle', false, u3);
  IF (r->>'allowed')::boolean THEN RAISE EXCEPTION 'FAIL B8: سُمح بالباقة الشاملة رغم امتلاك كل خدماتها'; END IF;
  IF r->>'code' <> 'redundant' THEN RAISE EXCEPTION 'FAIL B8b: كود غير متوقع %', r->>'code'; END IF;
  RAISE NOTICE 'PASS B8: واتساب + دعم فني فعّالان → الباقة الشاملة مرفوضة';
END $$;

\echo ''
\echo '=== C) انتهاء الاشتراك يعيد فتح الشراء ==='
DO $$
DECLARE u2 uuid := '22222222-2222-4222-8222-222222222222'; r jsonb;
BEGIN
  UPDATE public.whatsapp_subscriptions SET status='expired', end_date = now() - interval '1 day'
   WHERE user_id = u2;
  IF array_length(public.owned_feature_keys(u2), 1) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL C1: امتيازات باقية بعد الانتهاء'; END IF;
  r := public.subscription_purchase_check('whatsapp', false, u2);
  IF NOT (r->>'allowed')::boolean THEN RAISE EXCEPTION 'FAIL C2: مُنع الشراء بعد انتهاء الاشتراك'; END IF;
  RAISE NOTICE 'PASS C: انتهاء الاشتراك يسحب الامتيازات ويعيد إتاحة الشراء';
END $$;

\echo ''
\echo '=== D) المنع في القاعدة: طلب API مباشر يُرفض ==='
SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
DO $$ BEGIN
  -- محاولة تجاوز الواجهة تمامًا بـINSERT خام
  BEGIN
    INSERT INTO public.whatsapp_subscriptions (user_id, plan, status, billing_cycle, end_date)
    VALUES ('11111111-1111-4111-8111-111111111111','whatsapp','pending','monthly', now() + interval '30 days');
    RAISE EXCEPTION 'FAIL D1: طلب API مباشر تجاوز قاعدة التداخل';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'FAIL D1%' THEN RAISE; END IF;
  END;
  RAISE NOTICE 'PASS D1: القاعدة ترفض الاشتراك المتداخل حتى من طلب مباشر';

  -- وتكرار نفس الباقة كذلك
  BEGIN
    INSERT INTO public.whatsapp_subscriptions (user_id, plan, status, billing_cycle, end_date)
    VALUES ('11111111-1111-4111-8111-111111111111','bundle','pending','monthly', now() + interval '30 days');
    RAISE EXCEPTION 'FAIL D2: تكرار نفس الباقة تجاوز المنع';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'FAIL D2%' THEN RAISE; END IF;
  END;
  RAISE NOTICE 'PASS D2: تكرار نفس الباقة مرفوض من القاعدة';
END $$;

-- والترقية الحقيقية تمر
SET request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222';
DO $$ BEGIN
  INSERT INTO public.whatsapp_subscriptions (user_id, plan, status, billing_cycle, end_date)
  VALUES ('22222222-2222-4222-8222-222222222222','bundle','pending','monthly', now() + interval '30 days');
  RAISE NOTICE 'PASS D3: الاشتراك الذي يضيف خدمات جديدة يمر';
END $$;
RESET ROLE;

\echo ''
\echo '=== E) الأدمن له تسوية يدوية، والخلفية كذلك ==='
SET ROLE authenticated;
SET request.jwt.claim.sub = '99999999-9999-4999-8999-999999999999';
DO $$ BEGIN
  INSERT INTO public.whatsapp_subscriptions (user_id, plan, status, billing_cycle, end_date)
  VALUES ('11111111-1111-4111-8111-111111111111','whatsapp','active','monthly', now() + interval '30 days');
  RAISE NOTICE 'PASS E1: الأدمن يستطيع التسوية اليدوية رغم التداخل';
END $$;
RESET ROLE;

\echo ''
\echo '=== F) توحيد مصدر الامتيازات ==='
-- مهم: هوية المنادي هنا لازم تكون عميلًا عاديًا. has_feature_access بتنتهي بـ
-- "or is_admin()" (سلوك أصلي محفوظ)، فلو فضلت هوية الأدمن من القسم السابق
-- هترجّع true لأي مفتاح ويبقى الاختبار بلا معنى.
SET ROLE authenticated;
SET request.jwt.claim.sub = '33333333-3333-4333-8333-333333333333';
DO $$
DECLARE u3 uuid := '33333333-3333-4333-8333-333333333333';
BEGIN
  -- customer_subscriptions فاضي تمامًا؛ الدالة القديمة كانت هترجّع false دائمًا
  IF (SELECT count(*) FROM public.customer_subscriptions) <> 0 THEN
    RAISE EXCEPTION 'FAIL F0: الجدول الميت ليس فاضيًا في الاختبار'; END IF;
  IF NOT public.has_feature_access('whatsapp_sender', u3) THEN
    RAISE EXCEPTION 'FAIL F1: has_feature_access ما زالت تقرأ المصدر الميت'; END IF;
  IF public.has_feature_access('feature_غير_موجود', u3) THEN
    RAISE EXCEPTION 'FAIL F2: منحت امتيازًا غير موجود'; END IF;
  RAISE NOTICE 'PASS F: has_feature_access موحّدة مع المصدر الحي';
END $$;

\echo ''
\echo '=== G) تبعية المستخدم: مفتاح الخدمة يمر، والمستخدم لا ==='
-- بلا هوية = مفتاح الخدمة، وهو بالضبط سياق create-sub-user
RESET ROLE;
RESET request.jwt.claim.sub;
DO $$ BEGIN
  -- بدون JWT (مفتاح الخدمة) — مسار create-sub-user
  UPDATE public.profiles SET super_user_id = '11111111-1111-4111-8111-111111111111'
   WHERE id = '22222222-2222-4222-8222-222222222222';
  RAISE NOTICE 'PASS G1: مفتاح الخدمة يستطيع ربط المستخدم الفرعي (كان محجوبًا)';
END $$;

SET ROLE authenticated;
SET request.jwt.claim.sub = '33333333-3333-4333-8333-333333333333';
DO $$ BEGIN
  BEGIN
    UPDATE public.profiles SET super_user_id = '11111111-1111-4111-8111-111111111111'
     WHERE id = '33333333-3333-4333-8333-333333333333';
    RAISE EXCEPTION 'FAIL G2: مستخدم غيّر تبعيته بنفسه';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'FAIL G2%' THEN RAISE; END IF;
  END;
  RAISE NOTICE 'PASS G2: المستخدم ما زال ممنوعًا من تغيير تبعيته';
END $$;
RESET ROLE;

\echo ''
\echo '=== H) الترحيل قابل لإعادة التطبيق ==='
\i migrations/017_subscription_business_rules.sql
DO $$ BEGIN RAISE NOTICE 'PASS H: إعادة تطبيق الترحيل لم تفشل'; END $$;

\echo ''
\echo 'ALL SUBSCRIPTION BUSINESS RULE TESTS PASSED'
