-- اختبار تنفيذي لـ migrations/023_subscription_purchase_rpc.sql
--
-- الثغرة (C1): العميل كان يكتب لنفسه صفًّا بحالة 'active' وتاريخ انتهاء بعيد،
-- فيحصل على كل الخدمات المدفوعة مجانًا بنداء REST واحد.
--
-- الاختبار يبدأ بإثبات الثغرة على الحالة القديمة (ضابط سلبي مدمج): لو لم تنجح
-- محاولة الاستغلال قبل الترحيل، فالاختبار بعده لا يثبت شيئًا.
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
  id uuid PRIMARY KEY, email text, role text NOT NULL DEFAULT 'user',
  super_user_id uuid, whatsapp_enabled boolean NOT NULL DEFAULT false
);
CREATE TABLE public.tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL,
  title text, description text, status text NOT NULL DEFAULT 'open', priority text
);
CREATE TABLE public.subscription_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), key text NOT NULL UNIQUE,
  name text NOT NULL, name_ar text, is_active boolean NOT NULL DEFAULT true
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
  user_id uuid NOT NULL, ticket_id uuid REFERENCES public.tickets(id),
  status text DEFAULT 'active' CHECK (status IN ('active','expired','pending','rejected','superseded')),
  billing_cycle text CHECK (billing_cycle IN ('monthly','yearly')),
  start_date timestamptz DEFAULT now(), end_date timestamptz NOT NULL,
  plan text NOT NULL DEFAULT 'whatsapp' CHECK (plan IN ('support','whatsapp','bundle')),
  is_renewal boolean NOT NULL DEFAULT false, duration_days int,
  previous_end_date timestamptz, reviewed_by uuid, reviewed_at timestamptz,
  payment_method text, payment_reference text, company_id uuid,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN RETURN EXISTS (SELECT 1 FROM public.profiles WHERE id=auth.uid() AND role='admin'); END; $$;

CREATE OR REPLACE FUNCTION public.plan_feature_keys(p_plan_key text) RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT coalesce(array_agg(DISTINCT pf.feature_key), '{}'::text[])
    FROM public.subscription_plans sp
    JOIN public.plan_features pf ON pf.plan_id = sp.id AND pf.enabled
   WHERE sp.key = p_plan_key;
$$;

CREATE OR REPLACE FUNCTION public.owned_feature_keys(p_user_id uuid DEFAULT auth.uid()) RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT coalesce(array_agg(DISTINCT pf.feature_key), '{}'::text[])
    FROM public.whatsapp_subscriptions s
    JOIN public.subscription_plans sp ON sp.key = s.plan
    JOIN public.plan_features pf ON pf.plan_id = sp.id AND pf.enabled
   WHERE s.user_id = p_user_id AND s.status='active'
     AND s.start_date <= now() AND s.end_date > now();
$$;

CREATE OR REPLACE FUNCTION public.subscription_purchase_check(
  p_plan text, p_is_renewal boolean DEFAULT false, p_user_id uuid DEFAULT auth.uid())
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_offered text[]; v_owned text[]; v_missing text[]; v_same boolean;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('allowed',false,'code','not_authenticated','reason','يجب تسجيل الدخول أولًا'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.subscription_plans WHERE key=p_plan AND is_active) THEN
    RETURN jsonb_build_object('allowed',false,'code','unknown_plan','reason','باقة غير معروفة'); END IF;
  v_offered := public.plan_feature_keys(p_plan);
  v_owned   := public.owned_feature_keys(p_user_id);
  SELECT EXISTS (SELECT 1 FROM public.whatsapp_subscriptions s
    WHERE s.user_id=p_user_id AND s.plan=p_plan AND s.status='active' AND s.end_date>now()) INTO v_same;
  IF p_is_renewal AND v_same THEN
    RETURN jsonb_build_object('allowed',true,'code','renewal','reason','تجديد اشتراك قائم'); END IF;
  IF v_same THEN
    RETURN jsonb_build_object('allowed',false,'code','duplicate_plan','reason','لديك اشتراك فعّال في هذه الباقة بالفعل.'); END IF;
  SELECT coalesce(array_agg(f),'{}'::text[]) INTO v_missing FROM unnest(v_offered) f WHERE NOT (f = ANY(v_owned));
  IF array_length(v_missing,1) IS NULL THEN
    RETURN jsonb_build_object('allowed',false,'code','redundant','reason','كل خدمات هذه الباقة متاحة لك بالفعل.'); END IF;
  RETURN jsonb_build_object('allowed',true,'code','adds_features','reason','الباقة تضيف خدمات جديدة');
END; $$;

-- الحارس كما كان في الإنتاج قبل 023: يفحص التداخل ولا يفحص الحالة إطلاقًا
CREATE OR REPLACE FUNCTION public.enforce_subscription_purchase_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_check jsonb;
BEGIN
  IF new.status IS DISTINCT FROM 'pending' AND new.status IS DISTINCT FROM 'active' THEN RETURN new; END IF;
  IF auth.uid() IS NULL OR public.is_admin() THEN RETURN new; END IF;
  v_check := public.subscription_purchase_check(new.plan, new.is_renewal, new.user_id);
  IF NOT (v_check->>'allowed')::boolean THEN
    RAISE EXCEPTION '%', v_check->>'reason' USING ERRCODE='42501'; END IF;
  RETURN new;
END; $$;

CREATE TRIGGER trg_enforce_subscription_purchase_rules
  BEFORE INSERT ON public.whatsapp_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_subscription_purchase_rules();

ALTER TABLE public.whatsapp_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tickets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view their own subscriptions" ON public.whatsapp_subscriptions
  FOR SELECT USING (auth.uid() = user_id);
-- السياسة الثغرة نفسها، كما هي في الإنتاج قبل 023
CREATE POLICY "Users can create their own subscriptions" ON public.whatsapp_subscriptions
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Admins can manage all subscriptions" ON public.whatsapp_subscriptions
  FOR ALL USING (EXISTS (SELECT 1 FROM public.profiles WHERE id=auth.uid() AND role='admin'));
CREATE POLICY "Users can create tickets" ON public.tickets FOR INSERT WITH CHECK (auth.uid()=user_id);
CREATE POLICY "Users read own tickets" ON public.tickets FOR SELECT USING (auth.uid()=user_id);

GRANT USAGE ON SCHEMA public TO authenticated, anon;
GRANT USAGE ON SCHEMA auth TO authenticated, anon;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;

INSERT INTO public.subscription_plans (key,name,name_ar) VALUES
  ('support','Support','الدعم الفني'),('whatsapp','WhatsApp','واتساب'),('bundle','Bundle','الباقة الشاملة');
INSERT INTO public.feature_flags (key,name_ar) VALUES
  ('api_tokens','مفاتيح API'),('whatsapp_sender','إرسال واتساب'),('whatsapp_autoreply','ردود تلقائية'),
  ('whatsapp_campaigns','حملات'),('whatsapp_wallet','رصيد'),('support_tickets','تذاكر'),
  ('priority_support','أولوية'),('sub_users','مستخدمون فرعيون');
INSERT INTO public.plan_features (plan_id, feature_key)
SELECT sp.id, f.k FROM public.subscription_plans sp JOIN (VALUES
  ('whatsapp','whatsapp_sender'),('whatsapp','whatsapp_autoreply'),('whatsapp','whatsapp_campaigns'),
  ('whatsapp','whatsapp_wallet'),('support','support_tickets'),('support','priority_support'),
  ('support','sub_users'),('support','api_tokens'),
  ('bundle','whatsapp_sender'),('bundle','whatsapp_autoreply'),('bundle','whatsapp_campaigns'),
  ('bundle','whatsapp_wallet'),('bundle','support_tickets'),('bundle','priority_support'),
  ('bundle','sub_users'),('bundle','api_tokens')
) AS f(p,k) ON f.p = sp.key;

INSERT INTO public.profiles (id,email,role) VALUES
  ('11111111-1111-4111-8111-111111111111','c1@test.local','user'),
  ('22222222-2222-4222-8222-222222222222','c2@test.local','user'),
  ('99999999-9999-4999-8999-999999999999','admin@test.local','admin');

\echo ''
\echo '=== 0) ضابط سلبي: الثغرة تعمل فعلًا قبل الترحيل ==='
SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
DO $$
DECLARE v_feats text[];
BEGIN
  INSERT INTO public.whatsapp_subscriptions (user_id, plan, status, billing_cycle, start_date, end_date)
  VALUES ('11111111-1111-4111-8111-111111111111','bundle','active','yearly', now(), now() + interval '10 years');

  v_feats := public.owned_feature_keys('11111111-1111-4111-8111-111111111111');
  IF array_length(v_feats,1) IS NULL THEN
    RAISE EXCEPTION 'FAIL 0: الاستغلال لم يمنح امتيازات — الاختبار بعده لا يثبت شيئًا'; END IF;
  RAISE NOTICE 'PASS 0: الثغرة مؤكدة قبل الترحيل (% خدمة مجانية)', array_length(v_feats,1);
END $$;

-- ملاحظة مقصودة: التنظيف يجري بعد RESET ROLE لأن العميل **لا يملك سياسة DELETE**
-- أصلًا — محاولة الحذف بهويته تنجح صامتة بصفر صفوف. هذا بالضبط العطل N1 الذي
-- كان يجعل «التراجع» في مسار رفع الإثبات وهميًا، وهو ما تعالجه
-- cancel_my_subscription_request في هذا الترحيل.
RESET ROLE;
RESET request.jwt.claim.sub;
DELETE FROM public.whatsapp_subscriptions WHERE user_id='11111111-1111-4111-8111-111111111111';

\echo ''
\echo '--- applying migrations/023 ---'
\i migrations/023_subscription_purchase_rpc.sql
\echo '--- migration applied ---'
\echo ''

\echo '=== A) لا مسار INSERT مباشر للعميل بأي حالة ==='
SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
DO $$ BEGIN
  BEGIN
    INSERT INTO public.whatsapp_subscriptions (user_id, plan, status, billing_cycle, end_date)
    VALUES ('11111111-1111-4111-8111-111111111111','bundle','active','yearly', now() + interval '10 years');
    RAISE EXCEPTION 'FAIL A1: العميل أنشأ اشتراكًا فعّالًا مباشرة';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'FAIL A1%' THEN RAISE; END IF;
  END;
  RAISE NOTICE 'PASS A1: INSERT مباشر بحالة active مرفوض';

  BEGIN
    INSERT INTO public.whatsapp_subscriptions (user_id, plan, status, billing_cycle, end_date)
    VALUES ('11111111-1111-4111-8111-111111111111','bundle','pending','monthly', now() + interval '30 days');
    RAISE EXCEPTION 'FAIL A2: العميل أنشأ صفًّا مباشرة رغم إغلاق المسار';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'FAIL A2%' THEN RAISE; END IF;
  END;
  RAISE NOTICE 'PASS A2: INSERT مباشر بحالة pending مرفوض كذلك';
END $$;
RESET ROLE;
RESET request.jwt.claim.sub;

-- خط الدفاع الثاني: لو أُعيدت سياسة INSERT يومًا ما بالخطأ، يجب أن يظل الحارس
-- يرفض الحالة الفعّالة. نحاكي ذلك الخطأ صراحةً هنا ثم نزيله.
CREATE POLICY "TEMP regression: user insert" ON public.whatsapp_subscriptions
  FOR INSERT WITH CHECK (auth.uid() = user_id);
SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
DO $$ BEGIN
  BEGIN
    INSERT INTO public.whatsapp_subscriptions (user_id, plan, status, billing_cycle, end_date)
    VALUES ('11111111-1111-4111-8111-111111111111','bundle','active','yearly', now() + interval '10 years');
    RAISE EXCEPTION 'FAIL A3: الحارس سمح بحالة فعّالة بعد عودة السياسة';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'FAIL A3%' THEN RAISE; END IF;
  END;
  RAISE NOTICE 'PASS A3: الحارس يرفض الحالة الفعّالة حتى لو عادت سياسة INSERT';

  -- وفي المقابل الطلب المعلّق يمر عبر نفس المسار (الحارس لا يمنع كل شيء)
  INSERT INTO public.whatsapp_subscriptions (user_id, plan, status, billing_cycle, end_date)
  VALUES ('11111111-1111-4111-8111-111111111111','bundle','pending','monthly', now() + interval '30 days');
  RAISE NOTICE 'PASS A4: الحارس يسمح بالطلب المعلّق — المنع ليس شاملًا';
END $$;
RESET ROLE;
RESET request.jwt.claim.sub;
DELETE FROM public.whatsapp_subscriptions WHERE user_id='11111111-1111-4111-8111-111111111111';
DROP POLICY "TEMP regression: user insert" ON public.whatsapp_subscriptions;
SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';

\echo ''
\echo '=== B) المسار الشرعي ينشئ pending فقط ==='
DO $$
DECLARE r jsonb; v_row public.whatsapp_subscriptions%rowtype;
BEGIN
  r := public.request_subscription_purchase('bundle','monthly',NULL,false,'gateway',NULL);
  SELECT * INTO v_row FROM public.whatsapp_subscriptions WHERE id = (r->>'subscription_id')::uuid;

  IF v_row.status <> 'pending' THEN RAISE EXCEPTION 'FAIL B1: الحالة % وليست pending', v_row.status; END IF;
  IF v_row.user_id <> auth.uid() THEN RAISE EXCEPTION 'FAIL B2: الهوية لم تُشتق من الجلسة'; END IF;
  IF v_row.reviewed_by IS NOT NULL OR v_row.reviewed_at IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL B3: حقول المراجعة مملوءة'; END IF;
  IF array_length(public.owned_feature_keys(auth.uid()),1) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL B4: طلب معلّق منح امتيازات'; END IF;
  RAISE NOTICE 'PASS B: الطلب pending، الهوية من الجلسة، ولا امتيازات قبل التأكيد';

  -- التواريخ محسوبة في الخادم: شهر = 30 يومًا بالضبط
  IF abs(extract(epoch FROM (v_row.end_date - v_row.start_date)) - 30*86400) > 60 THEN
    RAISE EXCEPTION 'FAIL B5: مدة غير متوقعة %', v_row.end_date - v_row.start_date; END IF;
  RAISE NOTICE 'PASS B5: مدة الطلب محسوبة في الخادم لا مُرسَلة من العميل';
END $$;

\echo ''
\echo '=== C) طلب مكرر لنفس الباقة مرفوض ==='
DO $$ BEGIN
  BEGIN
    PERFORM public.request_subscription_purchase('bundle','monthly',NULL,false,'gateway',NULL);
    RAISE EXCEPTION 'FAIL C: طلبان معلّقان لنفس الباقة';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'FAIL C%' THEN RAISE; END IF;
  END;
  RAISE NOTICE 'PASS C: طلب معلّق مكرر مرفوض';
END $$;

\echo ''
\echo '=== D) تذكرة عميل آخر مرفوضة (IDOR) ==='
RESET ROLE;
INSERT INTO public.tickets (id, user_id, title)
VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','22222222-2222-4222-8222-222222222222','تذكرة عميل آخر');
SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
DO $$ BEGIN
  BEGIN
    PERFORM public.request_subscription_purchase(
      'support','monthly','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',false,'gateway',NULL);
    RAISE EXCEPTION 'FAIL D: تعليق الطلب على تذكرة عميل آخر نجح';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'FAIL D%' THEN RAISE; END IF;
  END;
  RAISE NOTICE 'PASS D: التذكرة التي لا تخص المنادي مرفوضة';
END $$;

\echo ''
\echo '=== E) قاعدة التداخل ما زالت مفروضة عبر المسار الجديد ==='
RESET ROLE;
RESET request.jwt.claim.sub;
UPDATE public.whatsapp_subscriptions SET status='active', start_date=now(), end_date=now()+interval '30 days'
 WHERE user_id='11111111-1111-4111-8111-111111111111' AND status='pending';
SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
DO $$ BEGIN
  BEGIN
    PERFORM public.request_subscription_purchase('whatsapp','monthly',NULL,false,'gateway',NULL);
    RAISE EXCEPTION 'FAIL E: شراء واتساب مع باقة شاملة فعّالة';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'FAIL E%' THEN RAISE; END IF;
  END;
  RAISE NOTICE 'PASS E: الباقة المتضمَّنة بالفعل مرفوضة (redundant)';
END $$;

\echo ''
\echo '=== F) التجديد يرث نهاية الاشتراك القائم من القاعدة ==='
DO $$
DECLARE r jsonb; v_prev timestamptz; v_expected timestamptz;
BEGIN
  SELECT max(end_date) INTO v_expected FROM public.whatsapp_subscriptions
   WHERE user_id=auth.uid() AND plan='bundle' AND status='active';

  r := public.request_subscription_purchase('bundle','monthly',NULL,true,'gateway',NULL);
  SELECT previous_end_date INTO v_prev FROM public.whatsapp_subscriptions
   WHERE id=(r->>'subscription_id')::uuid;

  IF v_prev IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'FAIL F: previous_end_date % لا يطابق القاعدة %', v_prev, v_expected; END IF;
  RAISE NOTICE 'PASS F: التجديد مسموح ويقرأ تاريخ النهاية من القاعدة لا من العميل';
END $$;

\echo ''
\echo '=== G) إلغاء الطلب المعلّق يعمل فعلًا (لا حذف صامت) ==='
DO $$
DECLARE v_id uuid; v_ok boolean;
BEGIN
  SELECT id INTO v_id FROM public.whatsapp_subscriptions
   WHERE user_id=auth.uid() AND status='pending' LIMIT 1;
  v_ok := public.cancel_my_subscription_request(v_id);
  IF NOT v_ok THEN RAISE EXCEPTION 'FAIL G1: الإلغاء أعاد false'; END IF;
  IF EXISTS (SELECT 1 FROM public.whatsapp_subscriptions WHERE id=v_id) THEN
    RAISE EXCEPTION 'FAIL G2: الصف ما زال موجودًا'; END IF;
  RAISE NOTICE 'PASS G: صاحب الطلب يلغي طلبه المعلّق فعليًا';
END $$;

\echo ''
\echo '=== H) لا يلغي العميل طلب غيره ولا اشتراكًا فعّالًا ==='
RESET ROLE;
RESET request.jwt.claim.sub;
INSERT INTO public.whatsapp_subscriptions (user_id, plan, status, billing_cycle, end_date)
VALUES ('22222222-2222-4222-8222-222222222222','support','pending','monthly', now()+interval '30 days');
SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
DO $$
DECLARE v_other uuid; v_mine uuid;
BEGIN
  SELECT id INTO v_other FROM public.whatsapp_subscriptions
   WHERE user_id='22222222-2222-4222-8222-222222222222' AND status='pending' LIMIT 1;
  IF public.cancel_my_subscription_request(v_other) THEN
    RAISE EXCEPTION 'FAIL H1: ألغى طلب عميل آخر'; END IF;
  RAISE NOTICE 'PASS H1: لا يمكن إلغاء طلب عميل آخر';

  SELECT id INTO v_mine FROM public.whatsapp_subscriptions
   WHERE user_id=auth.uid() AND status='active' LIMIT 1;
  IF public.cancel_my_subscription_request(v_mine) THEN
    RAISE EXCEPTION 'FAIL H2: ألغى اشتراكًا فعّالًا'; END IF;
  RAISE NOTICE 'PASS H2: لا يمكن إلغاء اشتراك فعّال بهذا المسار';
END $$;
RESET ROLE;
RESET request.jwt.claim.sub;

\echo ''
\echo '=== I) التوقيع لا يقبل هوية ولا حالة ولا تواريخ من العميل ==='
DO $$
DECLARE v_args text;
BEGIN
  SELECT pg_get_function_identity_arguments(p.oid) INTO v_args
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='request_subscription_purchase';

  IF v_args ~* '(user_id|status|start_date|end_date|reviewed)' THEN
    RAISE EXCEPTION 'FAIL I: التوقيع يقبل حقلًا يحدد القيمة أو الملكية: %', v_args; END IF;
  RAISE NOTICE 'PASS I: ما لا يُمرَّر لا يُزوَّر — التوقيع: %', v_args;
END $$;

\echo ''
\echo '=== J) الأدمن ما زال يفعّل ويسوّي يدويًا ==='
SET ROLE authenticated;
SET request.jwt.claim.sub = '99999999-9999-4999-8999-999999999999';
DO $$
DECLARE v_id uuid;
BEGIN
  SELECT id INTO v_id FROM public.whatsapp_subscriptions
   WHERE user_id='22222222-2222-4222-8222-222222222222' AND status='pending' LIMIT 1;
  UPDATE public.whatsapp_subscriptions
     SET status='active', start_date=now(), end_date=now()+interval '30 days',
         reviewed_by=auth.uid(), reviewed_at=now()
   WHERE id=v_id;
  IF (SELECT status FROM public.whatsapp_subscriptions WHERE id=v_id) <> 'active' THEN
    RAISE EXCEPTION 'FAIL J1: الأدمن لم يستطع التفعيل'; END IF;
  RAISE NOTICE 'PASS J1: التأكيد من الأدمن ما زال يحوّل الطلب إلى فعّال';

  INSERT INTO public.whatsapp_subscriptions (user_id, plan, status, billing_cycle, start_date, end_date)
  VALUES ('22222222-2222-4222-8222-222222222222','whatsapp','active','monthly', now(), now()+interval '30 days');
  RAISE NOTICE 'PASS J2: التسوية اليدوية من الأدمن ما زالت ممكنة';
END $$;
RESET ROLE;
RESET request.jwt.claim.sub;

\echo ''
\echo '=== K) إعادة تطبيق الترحيل آمنة ==='
\i migrations/023_subscription_purchase_rpc.sql
DO $$ BEGIN RAISE NOTICE 'PASS K: إعادة تطبيق 023 لم تفشل'; END $$;

\echo ''
\echo 'ALL SUBSCRIPTION PURCHASE HARDENING TESTS PASSED'
