-- اختبار تنفيذي لـ migrations/019_subscription_upgrade.sql
--
-- يثبّت: حساب الترقية بالتواريخ الفعلية، عدم تمديد الدورة، ذرّية التبديل،
-- منع التكرار والتأكيد المزدوج، وإصلاح احتساب الامتيازات قبل بداية الاشتراك.
\set ON_ERROR_STOP on
\pset tuples_only on

CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true),'')::uuid; $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
END $$;

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY, email text, full_name text, username text, phone text,
  role text NOT NULL DEFAULT 'user', super_user_id uuid, whatsapp_enabled boolean DEFAULT false
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
CREATE TABLE public.feature_flags (key text PRIMARY KEY, name_ar text, name text, description text);
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
  is_renewal boolean NOT NULL DEFAULT false, duration_days int, company_id uuid,
  reviewed_by uuid, reviewed_at timestamptz, payment_method text, payment_reference text,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX whatsapp_subscriptions_one_pending_per_plan
  ON public.whatsapp_subscriptions (user_id, plan) WHERE status = 'pending';
CREATE TABLE public.subscription_audit_log (
  id bigserial PRIMARY KEY, subscription_id uuid, target_user_id uuid, actor_user_id uuid,
  actor_email text, action text NOT NULL, old_values jsonb, new_values jsonb,
  reason text, created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN RETURN EXISTS (SELECT 1 FROM public.profiles WHERE id=auth.uid() AND role='admin'); END; $$;
CREATE OR REPLACE FUNCTION public.plan_feature_keys(p_plan_key text) RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select coalesce(array_agg(pf.feature_key order by pf.feature_key), '{}'::text[])
    from public.subscription_plans sp
    join public.plan_features pf on pf.plan_id=sp.id and pf.enabled
   where sp.key = p_plan_key; $$;
-- النسخة المعيبة قبل الترحيل: تتجاهل start_date
CREATE OR REPLACE FUNCTION public.owned_feature_keys(p_user_id uuid DEFAULT auth.uid()) RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select coalesce(array_agg(distinct pf.feature_key), '{}'::text[])
    from public.whatsapp_subscriptions s
    join public.subscription_plans sp on sp.key=s.plan
    join public.plan_features pf on pf.plan_id=sp.id and pf.enabled
   where s.user_id=p_user_id and s.status='active' and s.end_date > now(); $$;
CREATE OR REPLACE FUNCTION public.recompute_user_access(p_user_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v text[];
BEGIN
  v := public.owned_feature_keys(p_user_id);
  UPDATE public.profiles SET whatsapp_enabled = ('whatsapp_sender' = ANY(v)) WHERE id = p_user_id;
  RETURN jsonb_build_object('features', to_jsonb(v));
END; $$;

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

INSERT INTO public.profiles (id,email,role) VALUES
  ('11111111-1111-4111-8111-111111111111','wa@test.local','user'),
  ('22222222-2222-4222-8222-222222222222','sup@test.local','user'),
  ('33333333-3333-4333-8333-333333333333','yearly@test.local','user'),
  ('44444444-4444-4444-8444-444444444444','future@test.local','user'),
  ('99999999-9999-4999-8999-999999999999','admin@test.local','admin');

\echo ''
\echo '--- applying migrations/019 ---'
\i migrations/019_subscription_upgrade.sql
\echo '--- migration applied ---'
\echo ''
GRANT EXECUTE ON FUNCTION public.subscription_upgrade_quote(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.request_subscription_upgrade(text,uuid,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_confirm_subscription_upgrade(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.plan_price(text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.owned_feature_keys(uuid) TO authenticated;

\echo '=== A) الأسعار مصدر حقيقة في القاعدة ==='
DO $$ BEGIN
  IF public.plan_price('support','monthly')  <> 20  THEN RAISE EXCEPTION 'FAIL A1'; END IF;
  IF public.plan_price('support','yearly')   <> 200 THEN RAISE EXCEPTION 'FAIL A2'; END IF;
  IF public.plan_price('whatsapp','monthly') <> 25  THEN RAISE EXCEPTION 'FAIL A3'; END IF;
  IF public.plan_price('whatsapp','yearly')  <> 250 THEN RAISE EXCEPTION 'FAIL A4'; END IF;
  IF public.plan_price('bundle','monthly')   <> 40  THEN RAISE EXCEPTION 'FAIL A5'; END IF;
  IF public.plan_price('bundle','yearly')    <> 440 THEN RAISE EXCEPTION 'FAIL A6'; END IF;
  RAISE NOTICE 'PASS A: الأسعار الستة مقروءة من subscription_plans';
END $$;

\echo ''
\echo '=== B) التجديد المدفوع مسبقًا لا يمنح امتيازاته قبل موعده ==='
-- اشتراك واتساب جارٍ + تجديد مستقبلي مدفوع بخطة مختلفة (الباقة الشاملة)
INSERT INTO public.whatsapp_subscriptions (user_id,plan,status,billing_cycle,start_date,end_date) VALUES
  ('44444444-4444-4444-8444-444444444444','whatsapp','active','monthly', now() - interval '10 days', now() + interval '20 days'),
  ('44444444-4444-4444-8444-444444444444','bundle','active','monthly',   now() + interval '20 days', now() + interval '50 days');
DO $$
DECLARE f text[]; u uuid := '44444444-4444-4444-8444-444444444444';
BEGIN
  f := public.owned_feature_keys(u);
  IF 'support_tickets' = ANY(f) THEN
    RAISE EXCEPTION 'FAIL B1: امتيازات التجديد المستقبلي ظهرت قبل تاريخ بدايته (%)', f; END IF;
  IF NOT ('whatsapp_sender' = ANY(f)) THEN
    RAISE EXCEPTION 'FAIL B2: امتياز الاشتراك الجاري اختفى'; END IF;
  RAISE NOTICE 'PASS B: التجديد المستقبلي لا يمنح صلاحياته مبكرًا';
END $$;

\echo ''
\echo '=== C) حساب الترقية الشهري: واتساب ← الباقة الشاملة ==='
-- دورة 30 يومًا، مضى 20، متبقٍ 10 (مثال المواصفات حرفيًا)
INSERT INTO public.whatsapp_subscriptions (id,user_id,plan,status,billing_cycle,start_date,end_date) VALUES
  ('aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111',
   'whatsapp','active','monthly', now() - interval '20 days', now() + interval '10 days');
SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
DO $$
DECLARE q jsonb;
BEGIN
  q := public.subscription_upgrade_quote('bundle');
  IF (q->>'eligible')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'FAIL C1: الترقية غير مؤهلة (%)', q->>'code'; END IF;
  IF (q->>'remaining_days')::int <> 10 THEN RAISE EXCEPTION 'FAIL C2: أيام متبقية % بدل 10', q->>'remaining_days'; END IF;
  IF (q->>'cycle_days')::int <> 30 THEN RAISE EXCEPTION 'FAIL C3: أيام الدورة % بدل 30', q->>'cycle_days'; END IF;
  IF (q->>'price_difference')::numeric <> 15 THEN RAISE EXCEPTION 'FAIL C4: الفرق % بدل 15', q->>'price_difference'; END IF;
  -- (40 − 25) × 10/30 = 5.00
  IF (q->>'amount_due')::numeric <> 5.00 THEN RAISE EXCEPTION 'FAIL C5: المبلغ % بدل 5.00', q->>'amount_due'; END IF;
  IF (q->>'next_renewal_price')::numeric <> 40 THEN RAISE EXCEPTION 'FAIL C6: سعر التجديد القادم خطأ'; END IF;
  IF NOT (q->'added_features' @> '["support_tickets"]'::jsonb) THEN
    RAISE EXCEPTION 'FAIL C7: الخدمات المضافة غير صحيحة'; END IF;
  RAISE NOTICE 'PASS C: واتساب←الشاملة = 5.00$ على 10 أيام من 30 (الفرق 15$)';
END $$;

\echo ''
\echo '=== D) الدعم الفني ← الباقة الشاملة، والسنوي ==='
SET request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222';
INSERT INTO public.whatsapp_subscriptions (user_id,plan,status,billing_cycle,start_date,end_date) VALUES
  ('22222222-2222-4222-8222-222222222222','support','active','monthly', now() - interval '20 days', now() + interval '10 days');
DO $$
DECLARE q jsonb; BEGIN
  q := public.subscription_upgrade_quote('bundle');
  IF (q->>'price_difference')::numeric <> 20 THEN RAISE EXCEPTION 'FAIL D1: الفرق % بدل 20', q->>'price_difference'; END IF;
  -- (40 − 20) × 10/30 = 6.67
  IF (q->>'amount_due')::numeric <> 6.67 THEN RAISE EXCEPTION 'FAIL D2: المبلغ % بدل 6.67', q->>'amount_due'; END IF;
  RAISE NOTICE 'PASS D1: الدعم←الشاملة = 6.67$ على 10 أيام من 30 (الفرق 20$)';
END $$;

SET request.jwt.claim.sub = '33333333-3333-4333-8333-333333333333';
INSERT INTO public.whatsapp_subscriptions (user_id,plan,status,billing_cycle,start_date,end_date) VALUES
  ('33333333-3333-4333-8333-333333333333','whatsapp','active','yearly', now() - interval '185 days', now() + interval '180 days');
DO $$
DECLARE q jsonb; BEGIN
  q := public.subscription_upgrade_quote('bundle');
  IF (q->>'cycle_days')::int <> 365 THEN RAISE EXCEPTION 'FAIL D3: دورة سنوية % بدل 365', q->>'cycle_days'; END IF;
  IF (q->>'price_difference')::numeric <> 190 THEN RAISE EXCEPTION 'FAIL D4: الفرق السنوي خطأ'; END IF;
  -- (440 − 250) × 180/365 = 93.70
  IF (q->>'amount_due')::numeric <> 93.70 THEN RAISE EXCEPTION 'FAIL D5: المبلغ السنوي % بدل 93.70', q->>'amount_due'; END IF;
  IF (q->>'next_renewal_price')::numeric <> 440 THEN RAISE EXCEPTION 'FAIL D6: سعر التجديد السنوي خطأ'; END IF;
  RAISE NOTICE 'PASS D2: سنوي واتساب←الشاملة = 93.70$ على 180 يومًا من 365';
END $$;

\echo ''
\echo '=== E) الحالات غير المؤهلة ==='
SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
DO $$
DECLARE q jsonb; BEGIN
  -- نفس الباقة الفعّالة
  q := public.subscription_upgrade_quote('whatsapp');
  IF q->>'code' <> 'duplicate_plan' THEN RAISE EXCEPTION 'FAIL E1: كود % بدل duplicate_plan', q->>'code'; END IF;
  -- تخفيض (الدعم أرخص من واتساب) وليس ترقية
  q := public.subscription_upgrade_quote('support');
  IF q->>'code' <> 'not_an_upgrade' THEN RAISE EXCEPTION 'FAIL E2: كود % بدل not_an_upgrade', q->>'code'; END IF;
  RAISE NOTICE 'PASS E1: نفس الباقة = duplicate_plan، والأرخص = not_an_upgrade';
END $$;

-- من يملك الخدمتين منفصلتين: الباقة الشاملة لا تضيف شيئًا
SET request.jwt.claim.sub = '44444444-4444-4444-8444-444444444444';
RESET ROLE;
INSERT INTO public.whatsapp_subscriptions (user_id,plan,status,billing_cycle,start_date,end_date) VALUES
  ('44444444-4444-4444-8444-444444444444','support','active','monthly', now() - interval '5 days', now() + interval '25 days');
SET ROLE authenticated;
DO $$
DECLARE q jsonb; BEGIN
  q := public.subscription_upgrade_quote('bundle');
  IF q->>'code' <> 'redundant' THEN RAISE EXCEPTION 'FAIL E3: كود % بدل redundant', q->>'code'; END IF;
  RAISE NOTICE 'PASS E2: واتساب + دعم فني ← الشاملة = redundant (لا تضيف شيئًا)';
END $$;

-- بلا اشتراك فعّال
SET request.jwt.claim.sub = '99999999-9999-4999-8999-999999999999';
DO $$
DECLARE q jsonb; BEGIN
  q := public.subscription_upgrade_quote('bundle');
  IF q->>'code' <> 'no_active_subscription' THEN RAISE EXCEPTION 'FAIL E4: كود % بدل no_active_subscription', q->>'code'; END IF;
  RAISE NOTICE 'PASS E3: بلا اشتراك فعّال لا ترقية (المسار هو الشراء الكامل)';
END $$;

\echo ''
\echo '=== F) إنشاء الطلب لا يغيّر أي صلاحية، ولا يمدّد الدورة ==='
SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
DO $$
DECLARE r jsonb; nw public.whatsapp_subscriptions%rowtype; src public.whatsapp_subscriptions%rowtype;
        f_before text[]; f_after text[];
BEGIN
  f_before := public.owned_feature_keys('11111111-1111-4111-8111-111111111111');
  r := public.request_subscription_upgrade('bundle');

  SELECT * INTO nw FROM public.whatsapp_subscriptions WHERE id = (r->>'subscription_id')::uuid;
  SELECT * INTO src FROM public.whatsapp_subscriptions WHERE id = 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa';

  IF nw.status <> 'pending' THEN RAISE EXCEPTION 'FAIL F1: الطلب ليس pending'; END IF;
  IF nw.upgrade_amount <> 5.00 THEN RAISE EXCEPTION 'FAIL F2: المبلغ المخزّن % بدل 5.00', nw.upgrade_amount; END IF;
  -- يرث الدورة كما هي: لا تمديد ولا دورة جديدة
  IF nw.start_date <> src.start_date OR nw.end_date <> src.end_date THEN
    RAISE EXCEPTION 'FAIL F3: الترقية غيّرت تواريخ الدورة'; END IF;
  IF nw.upgraded_from_subscription_id <> src.id THEN RAISE EXCEPTION 'FAIL F4: الربط بالمصدر مفقود'; END IF;
  IF nw.price_snapshot->>'amount_due' IS NULL THEN RAISE EXCEPTION 'FAIL F5: لقطة السعر غير محفوظة'; END IF;

  -- ولا صلاحية اتغيرت: الدفع لسه ماتأكدش
  f_after := public.owned_feature_keys('11111111-1111-4111-8111-111111111111');
  IF 'support_tickets' = ANY(f_after) THEN
    RAISE EXCEPTION 'FAIL F6: امتيازات الباقة الجديدة مُنحت قبل تأكيد الدفع'; END IF;
  IF src.status <> 'active' THEN RAISE EXCEPTION 'FAIL F7: الاشتراك الأصلي تغيّر قبل التأكيد'; END IF;
  RAISE NOTICE 'PASS F: الطلب pending، ورث الدورة، وبلا أي تغيير في الصلاحيات';
END $$;

\echo ''
\echo '=== G) تكرار الطلب مرفوض (ضغط متكرر / طلبات متزامنة) ==='
DO $$ BEGIN
  BEGIN
    PERFORM public.request_subscription_upgrade('bundle');
    RAISE EXCEPTION 'FAIL G1: تم إنشاء طلب ترقية ثانٍ لنفس الاشتراك';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'FAIL G1%' THEN RAISE; END IF; END;
  RAISE NOTICE 'PASS G1: لا يمكن إنشاء طلبَي ترقية من نفس المصدر';
END $$;

\echo ''
\echo '=== H) تغيير الأسعار لا يغيّر طلبًا قائمًا ==='
RESET ROLE;
UPDATE public.subscription_plans SET price_monthly = 99 WHERE key = 'bundle';
DO $$
DECLARE nw public.whatsapp_subscriptions%rowtype; BEGIN
  SELECT * INTO nw FROM public.whatsapp_subscriptions
   WHERE upgraded_from_subscription_id = 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa' AND status='pending';
  IF nw.upgrade_amount <> 5.00 THEN RAISE EXCEPTION 'FAIL H1: المبلغ تغيّر مع سعر الباقة'; END IF;
  IF (nw.price_snapshot->>'to_price')::numeric <> 40 THEN
    RAISE EXCEPTION 'FAIL H2: لقطة السعر تغيّرت'; END IF;
  RAISE NOTICE 'PASS H: المبلغ المعتمد من price_snapshot، لا من الأسعار الحالية';
END $$;
UPDATE public.subscription_plans SET price_monthly = 40 WHERE key = 'bundle';

\echo ''
\echo '=== I) التأكيد ذرّي: تبديل كامل بلا لحظة تداخل ==='
SET ROLE authenticated;
SET request.jwt.claim.sub = '99999999-9999-4999-8999-999999999999';
DO $$
DECLARE
  sid uuid; res jsonb; nw public.whatsapp_subscriptions%rowtype;
  src public.whatsapp_subscriptions%rowtype; f text[]; n_active int;
BEGIN
  SELECT id INTO sid FROM public.whatsapp_subscriptions
   WHERE upgraded_from_subscription_id='aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa' AND status='pending';

  res := public.admin_confirm_subscription_upgrade(sid);

  SELECT * INTO nw  FROM public.whatsapp_subscriptions WHERE id = sid;
  SELECT * INTO src FROM public.whatsapp_subscriptions WHERE id = 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa';

  IF nw.status <> 'active' THEN RAISE EXCEPTION 'FAIL I1: الترقية لم تُفعَّل'; END IF;
  IF src.status <> 'superseded' THEN RAISE EXCEPTION 'FAIL I2: القديم % بدل superseded', src.status; END IF;
  IF nw.end_date <> src.end_date THEN RAISE EXCEPTION 'FAIL I3: تاريخ الانتهاء تغيّر'; END IF;

  -- لا اشتراكان فعّالان متداخلان
  SELECT count(*) INTO n_active FROM public.whatsapp_subscriptions
   WHERE user_id='11111111-1111-4111-8111-111111111111' AND status='active'
     AND start_date <= now() AND end_date > now();
  IF n_active <> 1 THEN RAISE EXCEPTION 'FAIL I4: % اشتراك فعّال متزامن بدل 1', n_active; END IF;

  -- والامتيازات أُعيد حسابها
  f := public.owned_feature_keys('11111111-1111-4111-8111-111111111111');
  IF NOT ('support_tickets' = ANY(f) AND 'whatsapp_sender' = ANY(f)) THEN
    RAISE EXCEPTION 'FAIL I5: امتيازات الباقة الشاملة غير مكتملة (%)', f; END IF;
  RAISE NOTICE 'PASS I: التبديل تم ذريًا — فعّال واحد، نفس تاريخ الانتهاء، امتيازات محدّثة';
END $$;

\echo ''
\echo '=== J) التأكيد المكرر لا ينفّذ العملية مرتين ==='
DO $$
DECLARE sid uuid; BEGIN
  SELECT id INTO sid FROM public.whatsapp_subscriptions
   WHERE upgraded_from_subscription_id='aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa';
  BEGIN
    PERFORM public.admin_confirm_subscription_upgrade(sid);
    RAISE EXCEPTION 'FAIL J1: التأكيد نُفّذ مرة ثانية';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'FAIL J1%' THEN RAISE; END IF; END;
  RAISE NOTICE 'PASS J1: التأكيد المكرر مرفوض (الحالة لم تعد pending)';
END $$;

\echo ''
\echo '=== K) سجل التدقيق يوثّق الترقية ==='
DO $$
DECLARE a jsonb; BEGIN
  SELECT jsonb_agg(jsonb_build_object('action',action,'new',new_values,'old',old_values))
    INTO a FROM public.subscription_audit_log WHERE action='upgrade';
  IF a IS NULL OR jsonb_array_length(a) <> 1 THEN RAISE EXCEPTION 'FAIL K1: صف تدقيق الترقية مفقود'; END IF;
  IF (a->0->'new'->>'amount_charged')::numeric <> 5.00 THEN
    RAISE EXCEPTION 'FAIL K2: المبلغ المسجّل خطأ'; END IF;
  IF a->0->'old'->>'plan' <> 'whatsapp' OR a->0->'new'->>'plan' <> 'bundle' THEN
    RAISE EXCEPTION 'FAIL K3: الباقتان قبل/بعد غير مسجّلتين'; END IF;
  RAISE NOTICE 'PASS K: الترقية مسجّلة بالمبلغ والباقتين';
END $$;

\echo ''
\echo '=== L) انتهاء الاشتراك أثناء انتظار الدفع ==='
-- التجهيز كـpostgres: الدور authenticated لا يملك DELETE (كما في الإنتاج)
RESET ROLE;
DELETE FROM public.whatsapp_subscriptions
 WHERE user_id='22222222-2222-4222-8222-222222222222' AND plan='support';
INSERT INTO public.whatsapp_subscriptions (id,user_id,plan,status,billing_cycle,start_date,end_date) VALUES
  ('bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb','22222222-2222-4222-8222-222222222222',
   'whatsapp','active','monthly', now() - interval '20 days', now() + interval '10 days');
SET ROLE authenticated;
SET request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222';
DO $$
DECLARE r jsonb; BEGIN
  r := public.request_subscription_upgrade('bundle');
  RAISE NOTICE 'تم إنشاء طلب ترقية بمبلغ %', r->>'amount_due';
END $$;

-- ينتهي الاشتراك الأصلي قبل أن يؤكد الأدمن
RESET ROLE;
UPDATE public.whatsapp_subscriptions SET end_date = now() - interval '1 hour'
 WHERE id = 'bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb';
SET ROLE authenticated;
SET request.jwt.claim.sub = '99999999-9999-4999-8999-999999999999';
DO $$
DECLARE sid uuid; src public.whatsapp_subscriptions%rowtype; f text[];
BEGIN
  SELECT id INTO sid FROM public.whatsapp_subscriptions
   WHERE upgraded_from_subscription_id='bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb' AND status='pending';
  BEGIN
    PERFORM public.admin_confirm_subscription_upgrade(sid);
    RAISE EXCEPTION 'FAIL L1: نُفّذت ترقية لاشتراك منتهٍ';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'FAIL L1%' THEN RAISE; END IF; END;

  SELECT * INTO src FROM public.whatsapp_subscriptions WHERE id='bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb';
  IF src.status <> 'active' THEN RAISE EXCEPTION 'FAIL L2: الاشتراك الأصلي تغيّر رغم فشل الترقية'; END IF;
  f := public.owned_feature_keys('22222222-2222-4222-8222-222222222222');
  IF 'support_tickets' = ANY(f) THEN RAISE EXCEPTION 'FAIL L3: مُنحت امتيازات رغم فشل الترقية'; END IF;
  RAISE NOTICE 'PASS L: الترقية لم تُنفَّذ، والاشتراك الأصلي والصلاحيات لم تُمَس';
END $$;

\echo ''
\echo '=== M) الصلاحيات: العميل لا يؤكّد ترقيته بنفسه ==='
SET request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222';
DO $$
DECLARE sid uuid; BEGIN
  SELECT id INTO sid FROM public.whatsapp_subscriptions
   WHERE upgraded_from_subscription_id='bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb';
  BEGIN
    PERFORM public.admin_confirm_subscription_upgrade(sid);
    RAISE EXCEPTION 'FAIL M1: العميل أكّد ترقيته بنفسه';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'FAIL M1%' THEN RAISE; END IF; END;
  RAISE NOTICE 'PASS M: تأكيد الترقية admin-only حتى من نداء RPC مباشر';
END $$;
RESET ROLE;

\echo ''
\echo '=== N) الترحيل قابل لإعادة التطبيق ==='
\i migrations/019_subscription_upgrade.sql
DO $$ BEGIN RAISE NOTICE 'PASS N: إعادة تطبيق الترحيل لم تفشل'; END $$;

\echo ''
\echo 'ALL SUBSCRIPTION UPGRADE TESTS PASSED'
