-- اختبار تنفيذي لـ migrations/065_support_plans_egp_ticket_quota.sql
-- الحد الشهري للتذاكر مفروض من القاعدة، والخطط الجديدة بالجنيه.
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
  id uuid PRIMARY KEY, email text, full_name text, role text NOT NULL DEFAULT 'user', super_user_id uuid
);
CREATE TABLE public.subscription_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), key text NOT NULL UNIQUE, name text, name_ar text,
  is_active boolean DEFAULT true, sort_order int DEFAULT 0, requires_company boolean DEFAULT false,
  price_monthly numeric, price_yearly numeric, currency text DEFAULT 'USD',
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
);
CREATE TABLE public.feature_flags (key text PRIMARY KEY, name text, name_ar text, description text, created_at timestamptz DEFAULT now());
CREATE TABLE public.plan_features (
  plan_id uuid NOT NULL REFERENCES public.subscription_plans(id) ON DELETE CASCADE,
  feature_key text NOT NULL REFERENCES public.feature_flags(key) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true, limits jsonb DEFAULT '{}'::jsonb, PRIMARY KEY (plan_id, feature_key)
);
CREATE TABLE public.whatsapp_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, status text DEFAULT 'active',
  billing_cycle text DEFAULT 'monthly', start_date timestamptz DEFAULT now(), end_date timestamptz NOT NULL,
  plan text NOT NULL, company_id uuid,
  CONSTRAINT whatsapp_subscriptions_plan_check CHECK (plan = ANY (ARRAY['support','whatsapp','bundle']))
);
CREATE TABLE public.tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, title text, category text,
  created_at timestamptz DEFAULT now()
);
CREATE TABLE public.subdomain_requests (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, subdomain text);
CREATE TABLE public.notifications (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, title text, message text, type text, link text);

CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'); $$;
CREATE OR REPLACE FUNCTION public.owned_feature_keys(p_user_id uuid DEFAULT auth.uid()) RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select coalesce(array_agg(distinct pf.feature_key), '{}'::text[])
    from public.whatsapp_subscriptions s
    join public.subscription_plans sp on sp.key = s.plan
    join public.plan_features pf on pf.plan_id = sp.id and pf.enabled = true
   where s.user_id = p_user_id and s.status = 'active' and s.start_date <= now() and s.end_date > now(); $$;
CREATE OR REPLACE FUNCTION public.has_feature_access(p_feature_key text, p_user_id uuid DEFAULT auth.uid()) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select p_feature_key = any(public.owned_feature_keys(p_user_id)) or public.is_admin(); $$;

GRANT USAGE ON SCHEMA public TO authenticated, anon;

-- الحالة قبل الترحيل كما على الإنتاج: ثلاث باقات بالدولار.
INSERT INTO public.subscription_plans (key,name,name_ar,price_monthly,price_yearly,currency,sort_order,requires_company) VALUES
  ('support','Support','الدعم الفني',20,200,'USD',10,true),
  ('whatsapp','WhatsApp Business','واتساب بيزنس',25,250,'USD',20,true),
  ('bundle','Bundle','الباقة الشاملة',40,440,'USD',30,true);
INSERT INTO public.feature_flags (key,name_ar) VALUES
  ('support_tickets','تذاكر'),('priority_support','أولوية'),('sub_users','فرعيون'),('api_tokens','API'),('whatsapp_sender','واتساب');
INSERT INTO public.plan_features (plan_id,feature_key)
SELECT sp.id,f.k FROM public.subscription_plans sp JOIN (VALUES
  ('support','support_tickets'),('support','priority_support'),('support','sub_users'),('support','api_tokens'),
  ('whatsapp','whatsapp_sender'),
  ('bundle','support_tickets'),('bundle','priority_support'),('bundle','sub_users'),('bundle','api_tokens'),('bundle','whatsapp_sender')
) AS f(p,k) ON f.p=sp.key;

-- free: بلا اشتراك · adv: المتقدمة + عضو تابع · ult: الفائقة · staff: دعم فني
INSERT INTO public.profiles (id,email,role,super_user_id) VALUES
  ('11111111-1111-4111-8111-111111111111','free@t.local','user',NULL),
  ('22222222-2222-4222-8222-222222222222','adv@t.local','super_user',NULL),
  ('22222222-0000-4222-8222-000000000002','adv-member@t.local','company_user','22222222-2222-4222-8222-222222222222'),
  ('33333333-3333-4333-8333-333333333333','ult@t.local','super_user',NULL),
  ('44444444-4444-4444-8444-444444444444','staff@t.local','support',NULL),
  ('55555555-5555-4555-8555-555555555555','wa@t.local','user',NULL);
INSERT INTO public.whatsapp_subscriptions (user_id,plan,status,end_date) VALUES
  ('22222222-2222-4222-8222-222222222222','support','active', now() + interval '30 days'),
  ('55555555-5555-4555-8555-555555555555','whatsapp','active', now() + interval '30 days');

\echo ''
\echo '--- applying migrations/065 ---'
\i migrations/065_support_plans_egp_ticket_quota.sql
\echo ''

-- الفائقة تُشترى بعد الترحيل (القيد يقبلها الآن).
INSERT INTO public.whatsapp_subscriptions (user_id,plan,status,end_date) VALUES
  ('33333333-3333-4333-8333-333333333333','ultimate','active', now() + interval '30 days');

\echo '=== A) الخطط والأسعار بالجنيه ==='
DO $$
DECLARE r record; BEGIN
  SELECT * INTO r FROM public.subscription_plans WHERE key='support';
  IF r.name_ar <> 'الخطة المتقدمة' OR r.price_monthly <> 999 OR r.price_yearly <> 9999 OR r.currency <> 'EGP' THEN
    RAISE EXCEPTION 'FAIL A1: المتقدمة % % % %', r.name_ar, r.price_monthly, r.price_yearly, r.currency; END IF;
  SELECT * INTO r FROM public.subscription_plans WHERE key='ultimate';
  IF r.name_ar <> 'الخطة الفائقة' OR r.price_monthly <> 1999 OR r.price_yearly <> 19999 OR r.is_active IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL A2: الفائقة'; END IF;
  IF EXISTS (SELECT 1 FROM public.subscription_plans WHERE currency <> 'EGP') THEN
    RAISE EXCEPTION 'FAIL A3: خطة ما زالت بعملة أخرى — الترقية تقارن الأسعار رقميًا'; END IF;
  IF NOT (SELECT bool_and(is_active) FROM public.subscription_plans WHERE key IN ('whatsapp','bundle')) THEN
    RAISE EXCEPTION 'FAIL A4: واتساب/الشاملة لازم تفضل مفعّلة لتجديد المشتركين الحاليين'; END IF;
  -- الترقية من المتقدمة للفائقة لازم تضيف امتيازًا (وإلا subscription_upgrade_quote يرفضها)
  IF NOT EXISTS (
     SELECT 1 FROM public.plan_features pf JOIN public.subscription_plans sp ON sp.id=pf.plan_id
      WHERE sp.key='ultimate' AND pf.feature_key='unlimited_tickets')
     OR EXISTS (
     SELECT 1 FROM public.plan_features pf JOIN public.subscription_plans sp ON sp.id=pf.plan_id
      WHERE sp.key='support' AND pf.feature_key='unlimited_tickets') THEN
    RAISE EXCEPTION 'FAIL A5: الفائقة لا تضيف امتيازًا عن المتقدمة'; END IF;
  RAISE NOTICE 'PASS A: المتقدمة 999/9999 والفائقة 1999/19999 بالجنيه، وكل الخطط بعملة واحدة';
END $$;

\echo '=== B) المجانية: 20 تذكرة ثم رفض ==='
SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
DO $$
DECLARE w jsonb; ok boolean := false; h text; BEGIN
  -- تذكرة من الشهر الماضي لا تُحسب
  INSERT INTO public.tickets (user_id,title,created_at) VALUES ('11111111-1111-4111-8111-111111111111','قديمة', now() - interval '40 days');
  FOR i IN 1..20 LOOP
    INSERT INTO public.tickets (user_id,title) VALUES ('11111111-1111-4111-8111-111111111111','تذكرة '||i);
  END LOOP;
  w := public.my_ticket_wallet();
  IF w->>'plan_key' <> 'free' OR (w->>'monthly_limit')::int <> 20 OR (w->>'used')::int <> 20 OR (w->>'remaining')::int <> 0 THEN
    RAISE EXCEPTION 'FAIL B1: %', w; END IF;
  BEGIN
    INSERT INTO public.tickets (user_id,title) VALUES ('11111111-1111-4111-8111-111111111111','الواحدة والعشرين');
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT;
    IF h = 'ticket_quota_exceeded' THEN ok := true; ELSE RAISE; END IF;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL B2: التذكرة رقم 21 اتقبلت'; END IF;
  RAISE NOTICE 'PASS B: 20 تذكرة شهريًا ثم رفض من القاعدة، والشهر الماضي خارج العد';
END $$;

\echo '=== C) طلب الترقية يعدّي حتى بعد نفاد الرصيد، ولا يُحسب ==='
DO $$
DECLARE w jsonb; BEGIN
  INSERT INTO public.tickets (user_id,title,category) VALUES ('11111111-1111-4111-8111-111111111111','طلب اشتراك - الخطة المتقدمة','subscription');
  w := public.my_ticket_wallet();
  IF (w->>'used')::int <> 20 THEN RAISE EXCEPTION 'FAIL C1: تذكرة الفوترة اتحسبت %', w->>'used'; END IF;
  RAISE NOTICE 'PASS C: تذاكر الفوترة خارج الحد وخارج العدّ';
END $$;

\echo '=== C2) تصنيف الفوترة مش باب خلفي: سقف 5 شهريًا ==='
DO $$
DECLARE ok boolean := false; h text; BEGIN
  FOR i IN 2..5 LOOP
    INSERT INTO public.tickets (user_id,title,category) VALUES ('11111111-1111-4111-8111-111111111111','فوترة '||i,'subscription');
  END LOOP;
  BEGIN
    INSERT INTO public.tickets (user_id,title,category) VALUES ('11111111-1111-4111-8111-111111111111','السادسة','subscription');
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT;
    IF h = 'billing_quota_exceeded' THEN ok := true; ELSE RAISE; END IF;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL C2: تصنيف subscription بيتجاوز الحد بلا سقف'; END IF;
  RAISE NOTICE 'PASS C2: طلبات الفوترة لها سقف مستقل (5)';
END $$;

\echo '=== D) المتقدمة: 300، والرصيد مشترك بين المالك وأعضاء حسابه ==='
SET request.jwt.claim.sub = '22222222-0000-4222-8222-000000000002';
DO $$
DECLARE w jsonb; BEGIN
  INSERT INTO public.tickets (user_id,title) VALUES ('22222222-0000-4222-8222-000000000002','من العضو');
  INSERT INTO public.tickets (user_id,title) VALUES ('22222222-2222-4222-8222-222222222222','من المالك');
  w := public.my_ticket_wallet();
  IF w->>'plan_key' <> 'support' OR (w->>'monthly_limit')::int <> 300 OR (w->>'used')::int <> 2
     OR (w->>'remaining')::int <> 298 OR (w->>'shared_account')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL D1: %', w; END IF;
  RAISE NOTICE 'PASS D: المتقدمة 300 تذكرة على مستوى الحساب كله';
END $$;

\echo '=== E) الفائقة بلا حد ==='
SET request.jwt.claim.sub = '33333333-3333-4333-8333-333333333333';
DO $$
DECLARE w jsonb; BEGIN
  FOR i IN 1..25 LOOP
    INSERT INTO public.tickets (user_id,title) VALUES ('33333333-3333-4333-8333-333333333333','تذكرة '||i);
  END LOOP;
  w := public.my_ticket_wallet();
  IF (w->>'unlimited')::boolean IS NOT TRUE OR w->>'remaining' IS NOT NULL OR (w->>'used')::int <> 25 THEN
    RAISE EXCEPTION 'FAIL E1: %', w; END IF;
  RAISE NOTICE 'PASS E: الفائقة بلا حد';
END $$;

\echo '=== F) اشتراك واتساب وحده لا يرفع حد التذاكر ==='
SET request.jwt.claim.sub = '55555555-5555-4555-8555-555555555555';
DO $$
DECLARE w jsonb; BEGIN
  w := public.my_ticket_wallet();
  IF w->>'plan_key' <> 'free' OR (w->>'monthly_limit')::int <> 20 THEN RAISE EXCEPTION 'FAIL F1: %', w; END IF;
  RAISE NOTICE 'PASS F: الواتساب وحده = حد المجانية';
END $$;

\echo '=== G) الطاقم خارج الحد ==='
SET request.jwt.claim.sub = '44444444-4444-4444-8444-444444444444';
DO $$ BEGIN
  FOR i IN 1..25 LOOP
    INSERT INTO public.tickets (user_id,title) VALUES ('44444444-4444-4444-8444-444444444444','داخلية '||i);
  END LOOP;
  RAISE NOTICE 'PASS G: موظف الدعم لا يتقيد';
END $$;

\echo '=== H) النطاق الفرعي للخطط المدفوعة فقط ==='
SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
DO $$
DECLARE ok boolean := false; h text; BEGIN
  BEGIN
    INSERT INTO public.subdomain_requests (user_id, subdomain) VALUES ('11111111-1111-4111-8111-111111111111','free-co');
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT;
    IF h = 'subdomain_requires_plan' THEN ok := true; ELSE RAISE; END IF;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL H1: المجانية طلبت نطاق فرعي'; END IF;
  RAISE NOTICE 'PASS H1: المجانية مرفوضة';
END $$;
SET request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222';
INSERT INTO public.subdomain_requests (user_id, subdomain) VALUES ('22222222-2222-4222-8222-222222222222','adv-co');
DO $$ BEGIN RAISE NOTICE 'PASS H2: المتقدمة تطلب نطاق فرعي'; END $$;

\echo '=== I) الصلاحيات ==='
SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
DO $$
DECLARE ok boolean := false; w jsonb; BEGIN
  w := public.my_ticket_wallet();
  IF w IS NULL THEN RAISE EXCEPTION 'FAIL I1: المستخدم مش قادر يقرأ محفظته'; END IF;
  BEGIN
    PERFORM public.ticket_quota_status('22222222-2222-4222-8222-222222222222');
  EXCEPTION WHEN insufficient_privilege THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL I2: مستخدم قرأ رصيد حساب غيره'; END IF;
  RAISE NOTICE 'PASS I: كل مستخدم يقرأ محفظته فقط';
END $$;
RESET ROLE;

\echo ''
\echo 'ALL ticket-quota tests passed'
