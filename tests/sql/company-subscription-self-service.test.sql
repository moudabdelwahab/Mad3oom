-- ============================================================================
-- 136: إدارة الاشتراك ذاتيًا من لوحة الشركة — تجديد وترقية وتخفيض وإلغاء
--
-- النمط كما في admin-fix-134.test.sql: ننمذج ما يعتمد عليه الترحيل من خارج
-- migrations/ — auth.uid() كما يعرّفه Supabase، و is_admin() (027/040)،
-- و plan_price / plan_feature_keys / owned_feature_keys / subscription_
-- purchase_check منسوخة حرفيًا من 019 و 017/024 (آخر تعريف للفحص في 024)،
-- و _open_billing_request_ticket مبسّط من 069 (يختم scope=مدعوم كما يفعل
-- محفّز a_ticket_scope_stamp في 097)، و current_company_id /
-- company_staff_role / _feature_on مبسّطة من 096/086 بما يكفي لاختبار
-- فروع حمولة اللوحة (095/108). الترحيل نفسه يُطبَّق كما هو مرتين.
--
-- ما يُثبَت هنا (كلها على كود 136 نفسه، لا على البدائل):
--   D1  عرض التخفيض: مؤهل، بلا مبلغ الآن، يسري من نهاية الدورة، والميزات
--       المُزالة محسوبة من القاعدة.
--   D2  أكواد عدم الأهلية: نفس الباقة، والأغلى ليست تخفيضًا، وبلا اشتراك فعّال.
--   D3  طلب التخفيض بتذكرته: صف pending يبدأ من نهاية المصدر، is_renewal،
--       والتذكرة مدعوم (scope) ومرتبطة، ويرث company_id.
--   D4  تذكرة خارج مدعوم مرفوضة (111).
--   D5  الحارس: طلب معلّق واحد لكل مصدر — تخفيض يمنع تجديدًا وترقية،
--       والعكس؛ وطلب تخفيض ثانٍ من المصدر نفسه مرفوض؛ وفي كل الاتجاهات:
--       ترقية مع تجديد معلّق، وتجديد ثانٍ، وتجديد مع ترقية معلّقة (D5e).
--   D6  الحارس القديم ما زال يمنع صفًا فعّالًا مباشرًا (023).
--   D7  الإلغاء في نهاية المدة: علَم فقط، الخدمة والامتياز باقيان، تدقيق،
--       وإعادة الإلغاء لا تكرر التدقيق؛ والتراجع يمسح العلَم ويدقّق.
--   D8  الإلغاء لغير المالك مرفوض، وللمنتهي/المعلّق مرفوض، ولصاحبه مع طلب
--       معلّق على المصدر مرفوض حتى يُلغى الطلب (D8d).
--   D9  حمولة اللوحة: علَم الإلغاء مع الصفوف، وفحص الفريق (095) ومنطق
--       الإيقاف (108) ما زالا يعملان — أي أن 136 لم تُرجع 021.
--   D10 الوظيفة الدورية: الملغى بطلب صاحبه يُشعَر بصيغة مختلفة عن المنتهي
--       عاديًا، ثم تنتهي حالته كالمعتاد.
--   D11 anon خارج كل الدوال الجديدة.
-- ============================================================================
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS auth;

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
GRANT USAGE ON SCHEMA auth TO authenticated, anon, service_role;

-- ── الجداول (الحد الأدنى الذي يلمسه 136) ────────────────────────────────────
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY,
  email text,
  role text NOT NULL DEFAULT 'user',
  whatsapp_enabled boolean NOT NULL DEFAULT false
);

CREATE TABLE public.companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE,
  company_name text NOT NULL,
  commercial_registration_number text,
  commercial_registration_expiry date,
  company_email text,
  company_phone text,
  address text,
  city text,
  country text,
  website text,
  industry text,
  tax_id text,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE public.subscription_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  name text NOT NULL,
  name_ar text,
  is_active boolean NOT NULL DEFAULT true,
  price_monthly numeric(14,2),
  price_yearly numeric(14,2),
  currency text NOT NULL DEFAULT 'USD',
  sort_order int NOT NULL DEFAULT 100
);

CREATE TABLE public.feature_flags (
  key text PRIMARY KEY,
  name text,
  name_ar text,
  description text
);

CREATE TABLE public.plan_features (
  plan_id uuid NOT NULL REFERENCES public.subscription_plans(id) ON DELETE CASCADE,
  feature_key text NOT NULL REFERENCES public.feature_flags(key) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  limits jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (plan_id, feature_key)
);

CREATE TABLE public.tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  title text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'open',
  priority text,
  category text,
  scope text,
  company_id uuid,
  ticket_number bigint,
  sla_response_due_at timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE public.whatsapp_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  ticket_id uuid REFERENCES public.tickets(id) ON DELETE SET NULL,
  plan text NOT NULL DEFAULT 'whatsapp',
  status text NOT NULL DEFAULT 'active',
  billing_cycle text,
  start_date timestamptz DEFAULT now(),
  end_date timestamptz NOT NULL,
  duration_days int,
  previous_end_date timestamptz,
  is_renewal boolean NOT NULL DEFAULT false,
  payment_method text,
  payment_reference text,
  company_id uuid,
  upgraded_from_subscription_id uuid REFERENCES public.whatsapp_subscriptions(id) ON DELETE SET NULL,
  upgrade_amount numeric(14,2),
  price_snapshot jsonb,
  rejection_reason text,
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE public.subscription_audit_log (
  id bigserial PRIMARY KEY,
  subscription_id uuid,
  target_user_id uuid,
  actor_user_id uuid,
  actor_email text,
  action text NOT NULL,
  old_values jsonb,
  new_values jsonb,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  title text,
  message text,
  type text,
  link text,
  created_at timestamptz DEFAULT now()
);

GRANT USAGE ON SCHEMA public TO authenticated, anon, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated, anon, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated, anon, service_role;

-- ── بدائل الاعتماديات (منسوخة من ترحيلاتها، أو مبسّطة بما يكفي للفروع) ──────
CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin');
END $$;

CREATE OR REPLACE FUNCTION public.account_is_active() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT true $$;

-- 019 حرفيًا
CREATE OR REPLACE FUNCTION public.plan_price(p_plan_key text, p_billing_cycle text)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT CASE WHEN p_billing_cycle = 'yearly' THEN sp.price_yearly ELSE sp.price_monthly END
    FROM public.subscription_plans sp WHERE sp.key = p_plan_key;
$function$;

-- 017 حرفيًا
CREATE OR REPLACE FUNCTION public.plan_feature_keys(p_plan_key text)
RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT COALESCE(array_agg(pf.feature_key ORDER BY pf.feature_key), '{}'::text[])
    FROM public.subscription_plans sp
    JOIN public.plan_features pf ON pf.plan_id = sp.id AND pf.enabled = true
   WHERE sp.key = p_plan_key;
$function$;

-- 019 حرفيًا (مع شرط start_date)
CREATE OR REPLACE FUNCTION public.owned_feature_keys(p_user_id uuid DEFAULT auth.uid())
RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT COALESCE(array_agg(DISTINCT pf.feature_key), '{}'::text[])
    FROM public.whatsapp_subscriptions s
    JOIN public.subscription_plans sp ON sp.key = s.plan
    JOIN public.plan_features pf ON pf.plan_id = sp.id AND pf.enabled = true
   WHERE s.user_id = p_user_id
     AND s.status = 'active'
     AND s.start_date <= now()
     AND s.end_date   >  now();
$function$;

-- 024 حرفيًا (آخر تعريف؛ 017 هي المنطق نفسه بلا فحص الحساب الآخر)
CREATE OR REPLACE FUNCTION public.subscription_purchase_check(
  p_plan text, p_is_renewal boolean DEFAULT false, p_user_id uuid DEFAULT auth.uid()
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_offered text[]; v_owned text[]; v_missing text[]; v_same_active boolean;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('allowed', false, 'code', 'not_authenticated',
                              'reason', 'يجب تسجيل الدخول أولًا');
  END IF;
  IF auth.uid() IS NOT NULL
     AND p_user_id IS DISTINCT FROM auth.uid()
     AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'لا يمكنك فحص اشتراك حساب آخر' USING errcode = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.subscription_plans WHERE key = p_plan AND is_active) THEN
    RETURN jsonb_build_object('allowed', false, 'code', 'unknown_plan',
                              'reason', 'باقة غير معروفة أو غير مفعّلة');
  END IF;
  v_offered := public.plan_feature_keys(p_plan);
  v_owned   := public.owned_feature_keys(p_user_id);
  SELECT EXISTS (
    SELECT 1 FROM public.whatsapp_subscriptions s
     WHERE s.user_id = p_user_id AND s.plan = p_plan
       AND s.status = 'active' AND s.end_date > now()
  ) INTO v_same_active;
  IF p_is_renewal AND v_same_active THEN
    RETURN jsonb_build_object('allowed', true, 'code', 'renewal', 'reason', 'تجديد اشتراك قائم');
  END IF;
  IF v_same_active THEN
    RETURN jsonb_build_object('allowed', false, 'code', 'duplicate_plan',
      'reason', 'لديك اشتراك فعّال في هذه الباقة بالفعل. استخدم زر التجديد لتمديده.');
  END IF;
  SELECT COALESCE(array_agg(f), '{}'::text[]) INTO v_missing
    FROM unnest(v_offered) f WHERE NOT (f = ANY(v_owned));
  IF array_length(v_missing, 1) IS NULL THEN
    RETURN jsonb_build_object(
      'allowed', false, 'code', 'redundant',
      'reason', 'كل خدمات هذه الباقة متاحة لك بالفعل ضمن اشتراكك الحالي.',
      'owned_features', to_jsonb(v_owned));
  END IF;
  RETURN jsonb_build_object(
    'allowed', true, 'code', 'adds_features',
    'reason', 'الباقة تضيف خدمات جديدة', 'new_features', to_jsonb(v_missing));
END;
$function$;

-- 069 مبسّطًا: محفّز a_ticket_scope_stamp (097) يختم تذكرة «subscription»
-- بـ scope=مدعوم؛ لا محفّزات تذاكر هنا فالختم مكتوب صراحةً.
CREATE OR REPLACE FUNCTION public._open_billing_request_ticket(
  p_title text, p_description text, p_payment_method text
)
RETURNS public.tickets LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_title text := nullif(btrim(coalesce(p_title, '')), '');
  v_desc text := nullif(btrim(coalesce(p_description, '')), '');
  v_ticket public.tickets%rowtype;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'يجب تسجيل الدخول أولًا' USING errcode = '42501'; END IF;
  IF NOT public.account_is_active() THEN RAISE EXCEPTION 'حسابك غير مفعّل بعد' USING errcode = '42501'; END IF;
  IF v_title IS NULL OR char_length(v_title) > 200 THEN RAISE EXCEPTION 'عنوان التذكرة غير صالح' USING errcode = '22023'; END IF;
  IF v_desc IS NULL OR char_length(v_desc) > 4000 THEN RAISE EXCEPTION 'وصف التذكرة غير صالح' USING errcode = '22023'; END IF;
  INSERT INTO public.tickets (user_id, title, description, status, priority, category, scope, sla_response_due_at)
  VALUES (v_uid, v_title, v_desc, 'open', 'high', 'subscription', 'mad3oom_support',
          CASE WHEN coalesce(p_payment_method, '') IN ('bank_transfer', 'cash_wallet', 'instapay')
               THEN now() + interval '1 hour' END)
  RETURNING * INTO v_ticket;
  RETURN v_ticket;
END;
$function$;
REVOKE ALL ON FUNCTION public._open_billing_request_ticket(text, text, text) FROM public, anon, authenticated;

-- 096/086 مبسّطة لحدود هذا الاختبار: الشركة يملكها المنادي، ودوره فيها admin.
CREATE OR REPLACE FUNCTION public.current_company_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT id FROM public.companies WHERE user_id = auth.uid() LIMIT 1;
$$;
CREATE OR REPLACE FUNCTION public.company_staff_role() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM public.companies WHERE user_id = auth.uid())
         THEN 'admin' ELSE NULL END;
$$;
CREATE OR REPLACE FUNCTION public._feature_on(p_key text) RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT true $$;

-- ── أدوات الاختبار ──────────────────────────────────────────────────────────
DROP SCHEMA IF EXISTS t CASCADE;
CREATE SCHEMA t;
GRANT USAGE ON SCHEMA t TO authenticated, service_role, anon;
CREATE FUNCTION t.act(p uuid) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claim.sub', coalesce(p::text, ''), false),
         set_config('request.jwt.claim.role', CASE WHEN p IS NULL THEN '' ELSE 'authenticated' END, false); $$;
CREATE FUNCTION t.try(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RAISE EXCEPTION USING errcode = 'TT000';
EXCEPTION WHEN others THEN
  RETURN CASE WHEN sqlstate = 'TT000' THEN 'ok' ELSE sqlstate END;
END $$;
CREATE FUNCTION t.err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN NULL;
EXCEPTION WHEN others THEN
  RETURN sqlerrm;
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;

-- ── الفاعلون والبيانات ──────────────────────────────────────────────────────
INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-4000-8000-0000000000a1', 'owner@co.test'),
  ('00000000-0000-4000-8000-0000000000a2', 'other@co.test'),
  ('00000000-0000-4000-8000-0000000000a3', 'free@co.test');
INSERT INTO public.profiles (id, email, role) VALUES
  ('00000000-0000-4000-8000-0000000000a1', 'owner@co.test', 'user'),
  ('00000000-0000-4000-8000-0000000000a2', 'other@co.test', 'user'),
  ('00000000-0000-4000-8000-0000000000a3', 'free@co.test', 'user');
INSERT INTO public.companies (id, user_id, company_name, company_email, company_phone, status)
VALUES ('c0000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000a1',
        'شركة الاختبار', 'co@test', '0500000000', 'active');
INSERT INTO public.subscription_plans (key, name, name_ar, price_monthly, price_yearly, currency) VALUES
  ('support', 'Support', 'الدعم الفني', 20, 200, 'USD'),
  ('whatsapp', 'WhatsApp', 'واتساب', 25, 250, 'USD'),
  ('bundle', 'Bundle', 'الشاملة', 40, 440, 'USD');
INSERT INTO public.feature_flags (key, name_ar) VALUES
  ('tickets', 'تذاكر الدعم'), ('wa', 'رسائل واتساب');
INSERT INTO public.plan_features (plan_id, feature_key)
SELECT id, 'tickets' FROM public.subscription_plans WHERE key IN ('support', 'bundle');
INSERT INTO public.plan_features (plan_id, feature_key)
SELECT id, 'wa' FROM public.subscription_plans WHERE key IN ('whatsapp', 'bundle');

-- U1: اشتراك «الشاملة» فعّال شهري (بدأ قبل 10 أيام، ينتهي بعد 20 يومًا)
INSERT INTO public.whatsapp_subscriptions (id, user_id, plan, status, billing_cycle, start_date, end_date, duration_days, company_id)
VALUES ('d0000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-0000000000a1',
        'bundle', 'active', 'monthly', now() - interval '10 days', now() + interval '20 days', 30,
        'c0000000-0000-4000-8000-0000000000c1');
-- U2: اشتراك «الدعم» فعّال (لاختبار العزل)
INSERT INTO public.whatsapp_subscriptions (id, user_id, plan, status, billing_cycle, start_date, end_date, duration_days)
VALUES ('d0000000-0000-4000-8000-0000000000d2', '00000000-0000-4000-8000-0000000000a2',
        'support', 'active', 'monthly', now() - interval '5 days', now() + interval '25 days', 30);

\echo '--- applying migrations/136 (first run) ---'
\i migrations/136_company_self_service_renewal_cancel.sql
\echo '--- applying migrations/136 (second run: idempotency) ---'
\i migrations/136_company_self_service_renewal_cancel.sql
SET search_path = public, extensions;

-- محفّز 017 (الحارس نفسه يأتي من 136؛ المحفّز يُنشأ هنا كما أنشأه 017)
DROP TRIGGER IF EXISTS trg_enforce_subscription_purchase_rules ON public.whatsapp_subscriptions;
CREATE TRIGGER trg_enforce_subscription_purchase_rules
  BEFORE INSERT ON public.whatsapp_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_subscription_purchase_rules();

DO $$
DECLARE q jsonb;
BEGIN
  PERFORM t.act('00000000-0000-4000-8000-0000000000a1');
  SET LOCAL ROLE authenticated;
  q := public.subscription_downgrade_quote('support');
  IF (q->>'eligible')::boolean IS NOT TRUE OR (q->>'amount_due')::numeric <> 0
     OR (q->>'code') <> 'downgrade' OR (q->>'next_renewal_price')::numeric <> 20
     OR NOT ('wa' = ANY(SELECT jsonb_array_elements_text(q->'removed_features'))) THEN
    RESET ROLE; RAISE EXCEPTION 'FAIL D1: عرض التخفيض (%)', q;
  END IF;
  IF (q->>'effective_date')::timestamptz <> (SELECT end_date FROM public.whatsapp_subscriptions
                                               WHERE id = 'd0000000-0000-4000-8000-0000000000d1') THEN
    RESET ROLE; RAISE EXCEPTION 'FAIL D1: تاريخ السريان ليس نهاية الدورة';
  END IF;
  IF (public.subscription_downgrade_quote('bundle')->>'code') <> 'duplicate_plan'
     OR (public.subscription_downgrade_quote('nope')->>'code') <> 'unknown_plan' THEN
    RESET ROLE; RAISE EXCEPTION 'FAIL D2: أكواد عدم الأهلية';
  END IF;
  RESET ROLE;
  -- الأغلى ليست تخفيضًا: U2 على «الدعم» (20) و«واتساب» (25) أغلى منها
  PERFORM t.act('00000000-0000-4000-8000-0000000000a2');
  SET LOCAL ROLE authenticated;
  IF (public.subscription_downgrade_quote('whatsapp')->>'code') <> 'not_a_downgrade'
     OR (public.subscription_downgrade_quote('bundle')->>'code') <> 'not_a_downgrade' THEN
    RESET ROLE; RAISE EXCEPTION 'FAIL D2: الأغلى ليست تخفيضًا';
  END IF;
  RESET ROLE;
  PERFORM t.act('00000000-0000-4000-8000-0000000000a3');
  SET LOCAL ROLE authenticated;
  IF (public.subscription_downgrade_quote('support')->>'code') <> 'no_active_subscription' THEN
    RESET ROLE; RAISE EXCEPTION 'FAIL D2: المجاني بلا اشتراك فعّال';
  END IF;
  RESET ROLE;
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS D1/D2: عرض التخفيض مؤهل بلا مبلغ ويسري من نهاية الدورة مع الميزات المُزالة، والأكواد صحيحة';
END $$;

-- ── D3: طلب التخفيض بتذكرته ────────────────────────────────────────────────
DO $$
DECLARE r jsonb; s record; tk record;
BEGIN
  PERFORM t.act('00000000-0000-4000-8000-0000000000a1');
  SET LOCAL ROLE authenticated;
  r := public.submit_subscription_downgrade('support', 'طلب تخفيض - الدعم الفني', 'تخفيض من الشاملة إلى الدعم', 'bank_transfer', 'REF-D1');
  RESET ROLE;
  SELECT * INTO s FROM public.whatsapp_subscriptions WHERE id = (r->>'subscription_id')::uuid;
  SELECT * INTO tk FROM public.tickets WHERE id = (r->'ticket'->>'id')::uuid;
  IF s.status <> 'pending' OR s.plan <> 'support' OR s.is_renewal IS NOT TRUE
     OR s.downgraded_from_subscription_id <> 'd0000000-0000-4000-8000-0000000000d1'
     OR s.company_id <> 'c0000000-0000-4000-8000-0000000000c1'
     OR s.start_date <> (SELECT end_date FROM public.whatsapp_subscriptions WHERE id = 'd0000000-0000-4000-8000-0000000000d1')
     OR s.previous_end_date <> s.start_date
     OR (s.price_snapshot->>'amount_due')::numeric <> 0
     OR (s.price_snapshot->>'to_price')::numeric <> 20 THEN
    RAISE EXCEPTION 'FAIL D3: صف طلب التخفيض (%)', row_to_json(s);
  END IF;
  IF tk.user_id <> '00000000-0000-4000-8000-0000000000a1' OR tk.category <> 'subscription'
     OR tk.scope <> 'mad3oom_support' OR tk.status <> 'open' THEN
    RAISE EXCEPTION 'FAIL D3: التذكرة (%)', row_to_json(tk);
  END IF;
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS D3: طلب التخفيض pending من نهاية المصدر بتذكرته (مدعوم) ويرث الشركة';
END $$;

-- ── D4: تذكرة خارج مدعوم مرفوضة (111) ──────────────────────────────────────
DO $$
DECLARE e text; comp_ticket uuid;
BEGIN
  INSERT INTO public.tickets (user_id, title, description, status, category, scope)
  VALUES ('00000000-0000-4000-8000-0000000000a1', 'تذكرة شركة', 'وصف', 'open', 'support', 'company')
  RETURNING id INTO comp_ticket;
  PERFORM t.act('00000000-0000-4000-8000-0000000000a1');
  SET LOCAL ROLE authenticated;
  e := t.err(format($s$select public.request_subscription_downgrade('whatsapp', %L, 'bank_transfer', null)$s$, comp_ticket));
  RESET ROLE;
  IF e NOT LIKE '%لا تخص حسابك%' THEN RAISE EXCEPTION 'FAIL D4: %', e; END IF;
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS D4: طلب التخفيض بتذكرة شركة مرفوض (111)';
END $$;

-- ── D5: طلب معلّق واحد لكل مصدر ────────────────────────────────────────────
DO $$
DECLARE e text;
BEGIN
  PERFORM t.act('00000000-0000-4000-8000-0000000000a1');
  SET LOCAL ROLE authenticated;
  -- تخفيض ثانٍ من المصدر نفسه (عبر الدالة): رسالة عربية قبل الحارس
  e := t.err($s$select public.submit_subscription_downgrade('whatsapp', 'طلب تخفيض آخر', 'وصف', 'bank_transfer', null)$s$);
  IF e NOT LIKE '%طلب قيد المراجعة%' THEN RESET ROLE; RAISE EXCEPTION 'FAIL D5a: %', e; END IF;
  -- تجديد مباشر (إدراج) لنفس الباقة والمصدر: الحارس فرع (ج)
  e := t.err($s$insert into public.whatsapp_subscriptions (user_id, plan, status, billing_cycle, start_date, end_date, duration_days, is_renewal)
                values (auth.uid(), 'bundle', 'pending', 'monthly', now(), now() + interval '30 days', 30, true)$s$);
  IF e NOT LIKE '%طلب تخفيض قيد المراجعة%' THEN RESET ROLE; RAISE EXCEPTION 'FAIL D5b: %', e; END IF;
  -- ترقية مباشرة (إدراج) من المصدر نفسه: الحارس فرع (ب)
  e := t.err($s$insert into public.whatsapp_subscriptions (user_id, plan, status, billing_cycle, start_date, end_date, duration_days, upgraded_from_subscription_id)
                values (auth.uid(), 'support', 'pending', 'monthly', now(), now() + interval '30 days', 30, 'd0000000-0000-4000-8000-0000000000d1')$s$);
  IF e NOT LIKE '%طلب تخفيض قيد المراجعة%' THEN RESET ROLE; RAISE EXCEPTION 'FAIL D5c: %', e; END IF;
  -- إدراج تخفيض مباشر من مصدر عليه ترقية معلّقة: الحارس فرع (أ) — نجهّز
  -- ترقية معلّقة من مصدر U2 أولًا (خارج هذه المعاملة: إدراج كخدمة)
  RESET ROLE;
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS D5: التخفيض المعلّق يمنع تجديدًا وترقية وتخفيضًا آخر من المصدر نفسه';
END $$;

-- ترقية معلّقة من مصدر U2، ثم تخفيض مباشر منه (فرع أ) — كخدمة بلا auth
DO $$
DECLARE e text;
BEGIN
  INSERT INTO public.whatsapp_subscriptions (user_id, plan, status, billing_cycle, start_date, end_date, duration_days, upgraded_from_subscription_id)
  VALUES ('00000000-0000-4000-8000-0000000000a2', 'bundle', 'pending', 'monthly', now(), now() + interval '30 days', 30,
          'd0000000-0000-4000-8000-0000000000d2');
  PERFORM t.act('00000000-0000-4000-8000-0000000000a2');
  SET LOCAL ROLE authenticated;
  e := t.err($s$insert into public.whatsapp_subscriptions (user_id, plan, status, billing_cycle, start_date, end_date, duration_days, downgraded_from_subscription_id)
                values (auth.uid(), 'whatsapp', 'pending', 'monthly', now(), now() + interval '30 days', 30, 'd0000000-0000-4000-8000-0000000000d2')$s$);
  RESET ROLE;
  IF e NOT LIKE '%طلب قيد المراجعة%' THEN RAISE EXCEPTION 'FAIL D5d: %', e; END IF;
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS D5d: ترقية معلّقة تمنع تخفيضًا من المصدر نفسه (فرع أ)';
END $$;

-- ── D5e: الحارس مكتمل — ترقية/تجديد من المصدر نفسه لا يجتمعان معلّقين ─────
-- (كان الفرعان ب/ج يفحصان التخفيض وحده، فمرّت ترقيةٌ مع تجديد معلّق،
-- وتجديدٌ ثانٍ، وتجديدٌ مع ترقية معلّقة — والمساران لا يسدّانها: 019 بلا
-- فحص معلّق أصلًا، و 023 يفحص الباقة نفسها فقط.)
DO $$
DECLARE e text;
BEGIN
  -- ترقية معلّقة من مصدر U2 (خلّفها D5d) تمنع تجديدًا منه (فرع ج)
  PERFORM t.act('00000000-0000-4000-8000-0000000000a2');
  SET LOCAL ROLE authenticated;
  e := t.err($s$insert into public.whatsapp_subscriptions (user_id, plan, status, billing_cycle, start_date, end_date, duration_days, is_renewal)
                values (auth.uid(), 'support', 'pending', 'monthly', now(), now() + interval '30 days', 30, true)$s$);
  IF coalesce(e, '') NOT LIKE '%قيد المراجعة%' THEN RESET ROLE; RAISE EXCEPTION 'FAIL D5e1: %', e; END IF;
  -- وترقية ثانية منه (فرع ب)
  e := t.err($s$insert into public.whatsapp_subscriptions (user_id, plan, status, billing_cycle, start_date, end_date, duration_days, upgraded_from_subscription_id)
                values (auth.uid(), 'bundle', 'pending', 'monthly', now(), now() + interval '30 days', 30, 'd0000000-0000-4000-8000-0000000000d2')$s$);
  IF coalesce(e, '') NOT LIKE '%قيد المراجعة%' THEN RESET ROLE; RAISE EXCEPTION 'FAIL D5e2: %', e; END IF;
  RESET ROLE;
  -- بعد إلغاء الترقية المعلّقة: تجديد معلّق، ثم ترقية منه مرفوضة (فرع ب)
  -- وتجديد ثانٍ مرفوض (فرع ج)
  DELETE FROM public.whatsapp_subscriptions
   WHERE status = 'pending' AND user_id = '00000000-0000-4000-8000-0000000000a2'
     AND upgraded_from_subscription_id = 'd0000000-0000-4000-8000-0000000000d2';
  PERFORM t.act('00000000-0000-4000-8000-0000000000a2');
  SET LOCAL ROLE authenticated;
  -- تجديد معلّق يبقى فعلًا (إدراج مباشر لا عبر t.try — هو يتراجع عن جملته)
  INSERT INTO public.whatsapp_subscriptions (user_id, plan, status, billing_cycle, start_date, end_date, duration_days, is_renewal)
  VALUES (auth.uid(), 'support', 'pending', 'monthly', now(), now() + interval '30 days', 30, true);
  e := t.err($s$insert into public.whatsapp_subscriptions (user_id, plan, status, billing_cycle, start_date, end_date, duration_days, upgraded_from_subscription_id)
                values (auth.uid(), 'bundle', 'pending', 'monthly', now(), now() + interval '30 days', 30, 'd0000000-0000-4000-8000-0000000000d2')$s$);
  IF coalesce(e, '') NOT LIKE '%قيد المراجعة%' THEN RESET ROLE; RAISE EXCEPTION 'FAIL D5e4: %', e; END IF;
  e := t.err($s$insert into public.whatsapp_subscriptions (user_id, plan, status, billing_cycle, start_date, end_date, duration_days, is_renewal)
                values (auth.uid(), 'support', 'pending', 'monthly', now(), now() + interval '30 days', 30, true)$s$);
  IF coalesce(e, '') NOT LIKE '%قيد المراجعة%' THEN RESET ROLE; RAISE EXCEPTION 'FAIL D5e5: %', e; END IF;
  RESET ROLE;
  -- ترقية معلّقة من مصدر U1 (كخدمة بلا auth: مسح المطالبة أولًا، كما في D5d)
  PERFORM t.act(NULL);
  INSERT INTO public.whatsapp_subscriptions (user_id, plan, status, billing_cycle, start_date, end_date, duration_days, upgraded_from_subscription_id)
  VALUES ('00000000-0000-4000-8000-0000000000a1', 'support', 'pending', 'monthly', now(), now() + interval '30 days', 30,
          'd0000000-0000-4000-8000-0000000000d1');
  PERFORM t.act('00000000-0000-4000-8000-0000000000a1');
  SET LOCAL ROLE authenticated;
  e := t.err($s$insert into public.whatsapp_subscriptions (user_id, plan, status, billing_cycle, start_date, end_date, duration_days, is_renewal)
                values (auth.uid(), 'bundle', 'pending', 'monthly', now(), now() + interval '30 days', 30, true)$s$);
  IF coalesce(e, '') NOT LIKE '%قيد المراجعة%' THEN RESET ROLE; RAISE EXCEPTION 'FAIL D5e6: %', e; END IF;
  e := t.err($s$insert into public.whatsapp_subscriptions (user_id, plan, status, billing_cycle, start_date, end_date, duration_days, upgraded_from_subscription_id)
                values (auth.uid(), 'whatsapp', 'pending', 'monthly', now(), now() + interval '30 days', 30, 'd0000000-0000-4000-8000-0000000000d1')$s$);
  IF coalesce(e, '') NOT LIKE '%قيد المراجعة%' THEN RESET ROLE; RAISE EXCEPTION 'FAIL D5e7: %', e; END IF;
  RESET ROLE;
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS D5e: ترقية/تجديد من المصدر نفسه لا يجتمعان معلّقين في أي اتجاه';
END $$;

-- تنظيف الطلبات المعلّقة التي خلّفتها D3/D5 (تخفيض U1، وتجديد U2، وترقية
-- U1): الإلغاء في D7/D8 يرفض وجود طلب معلّق على المصدر، فلا يبقى أيٌّ منها.
DELETE FROM public.whatsapp_subscriptions
 WHERE status = 'pending'
   AND user_id IN ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a2');

-- ── D6: الحارس القديم (023) ما زال يمنع صفًا فعّالًا مباشرًا ───────────────
DO $$
DECLARE e text;
BEGIN
  PERFORM t.act('00000000-0000-4000-8000-0000000000a3');
  SET LOCAL ROLE authenticated;
  e := t.err($s$insert into public.whatsapp_subscriptions (user_id, plan, status, billing_cycle, start_date, end_date, duration_days)
                values (auth.uid(), 'support', 'active', 'monthly', now(), now() + interval '30 days', 30)$s$);
  RESET ROLE;
  IF e NOT LIKE '%الطلبات تبدأ قيد المراجعة%' THEN RAISE EXCEPTION 'FAIL D6: %', e; END IF;
  -- وطلب pending شرعي يمرّ (فحص الشراء الحقيقي: الدعم يضيف تذاكر لمجاني)
  SET LOCAL ROLE authenticated;
  IF t.try($s$insert into public.whatsapp_subscriptions (user_id, plan, status, billing_cycle, start_date, end_date, duration_days, is_renewal)
              values (auth.uid(), 'support', 'pending', 'monthly', now(), now() + interval '30 days', 30, false)$s$) <> 'ok' THEN
    RESET ROLE; RAISE EXCEPTION 'FAIL D6: طلب pending شرعي رُفض';
  END IF;
  RESET ROLE;
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS D6: إنشاء صف فعّال مباشرة مرفوض، والطلب الشرعي pending يمرّ';
END $$;

-- ── D7/D8: الإلغاء والتراجع ───────────────────────────────────────────────
DO $$
DECLARE r jsonb; n_before int; n_after int;
BEGIN
  SELECT count(*) INTO n_before FROM public.subscription_audit_log;
  PERFORM t.act('00000000-0000-4000-8000-0000000000a1');
  SET LOCAL ROLE authenticated;
  r := public.cancel_my_active_subscription('d0000000-0000-4000-8000-0000000000d1', 'أسباب مالية');
  IF (r->>'status') <> 'cancel_at_period_end' OR (r->>'cancel_at_period_end')::boolean IS NOT TRUE THEN
    RESET ROLE; RAISE EXCEPTION 'FAIL D7a: %', r;
  END IF;
  -- إعادة الإلغاء: نفس النتيجة بلا تدقيق مكرر
  r := public.cancel_my_active_subscription('d0000000-0000-4000-8000-0000000000d1', 'مرة أخرى');
  IF (r->>'status') <> 'already_cancelled' THEN RESET ROLE; RAISE EXCEPTION 'FAIL D7b: %', r; END IF;
  SELECT count(*) INTO n_after FROM public.subscription_audit_log;
  IF n_after <> n_before + 1 THEN RESET ROLE; RAISE EXCEPTION 'FAIL D7c: التدقيق %→%', n_before, n_after; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.subscription_audit_log
                  WHERE subscription_id = 'd0000000-0000-4000-8000-0000000000d1'
                    AND action = 'cancel_at_period_end' AND reason = 'أسباب مالية'
                    AND actor_user_id = '00000000-0000-4000-8000-0000000000a1') THEN
    RESET ROLE; RAISE EXCEPTION 'FAIL D7d: صف التدقيق';
  END IF;
  -- الخدمة باقية: الحالة active والامتياز ما زال مملوكًا
  IF NOT EXISTS (SELECT 1 FROM public.whatsapp_subscriptions
                  WHERE id = 'd0000000-0000-4000-8000-0000000000d1' AND status = 'active' AND cancel_at_period_end)
     OR NOT ('wa' = ANY(public.owned_feature_keys('00000000-0000-4000-8000-0000000000a1'))) THEN
    RESET ROLE; RAISE EXCEPTION 'FAIL D7e: الإلغاء غيّر الحالة أو الامتياز قبل الانتهاء';
  END IF;
  -- التراجع يمسح العلَم ويدقّق
  r := public.resume_my_subscription('d0000000-0000-4000-8000-0000000000d1');
  IF (r->>'cancel_at_period_end')::boolean IS NOT FALSE THEN RESET ROLE; RAISE EXCEPTION 'FAIL D7f: %', r; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.subscription_audit_log
                  WHERE subscription_id = 'd0000000-0000-4000-8000-0000000000d1' AND action = 'cancel_revoked') THEN
    RESET ROLE; RAISE EXCEPTION 'FAIL D7g: تدقيق التراجع';
  END IF;
  -- تراجع بلا إلغاء مرفوض
  IF t.err($s$select public.resume_my_subscription('d0000000-0000-4000-8000-0000000000d1')$s$)
       NOT LIKE '%غير ملغى%' THEN RESET ROLE; RAISE EXCEPTION 'FAIL D7h: تراجع بلا إلغاء'; END IF;
  -- ألغِه مجددًا ليبقى ملغى لاختبار D9
  PERFORM public.cancel_my_active_subscription('d0000000-0000-4000-8000-0000000000d1', 'أسباب مالية');
  RESET ROLE;
  PERFORM t.act('00000000-0000-4000-8000-0000000000a2');
  SET LOCAL ROLE authenticated;
  IF t.err($s$select public.cancel_my_active_subscription('d0000000-0000-4000-8000-0000000000d1', 'x')$s$)
       NOT LIKE '%لا يخص حسابك%' THEN RESET ROLE; RAISE EXCEPTION 'FAIL D8a: غير المالك ألغى'; END IF;
  -- إلغاء مع طلب معلّق على المصدر مرفوض (D8d): تجديد معلّق من d2 ثم إلغاؤه.
  -- الإدراج مباشر لا عبر t.try (هو يتراجع عن جملته)، والتأكيد آمن من NULL
  -- (نجاح غير متوقع يعيد NULL فيمرّ LIKE بصمت).
  INSERT INTO public.whatsapp_subscriptions (user_id, plan, status, billing_cycle, start_date, end_date, duration_days, is_renewal)
  VALUES (auth.uid(), 'support', 'pending', 'monthly', now(), now() + interval '30 days', 30, true);
  IF coalesce(t.err($s$select public.cancel_my_active_subscription('d0000000-0000-4000-8000-0000000000d2', 'x')$s$), '')
       NOT LIKE '%قيد المراجعة%' THEN RESET ROLE; RAISE EXCEPTION 'FAIL D8d: إلغاء مع طلب معلّق'; END IF;
  DELETE FROM public.whatsapp_subscriptions
   WHERE status = 'pending' AND user_id = '00000000-0000-4000-8000-0000000000a2' AND is_renewal AND plan = 'support';
  -- U2 يلغي اشتراكه هو وينجح، ثم يتراجع عنه ليبقى غير ملغى لاختبار D10
  IF t.err($s$select public.cancel_my_active_subscription('d0000000-0000-4000-8000-0000000000d2', 'x')$s$) IS NOT NULL THEN
    RESET ROLE; RAISE EXCEPTION 'FAIL D8b: U2 لم يستطع إلغاء اشتراكه هو';
  END IF;
  IF t.err($s$select public.resume_my_subscription('d0000000-0000-4000-8000-0000000000d2')$s$) IS NOT NULL THEN
    RESET ROLE; RAISE EXCEPTION 'FAIL D8b: U2 لم يستطع التراجع عن إلغائه';
  END IF;
  RESET ROLE;
  PERFORM t.act('00000000-0000-4000-8000-0000000000a1');
  SET LOCAL ROLE authenticated;
  -- طلب معلّق لـ U1 أولًا (تنظيف D5 حذف طلب التخفيض القديم)، ثم إلغاؤه
  -- بهذا المسار مرفوض لأنه غير فعّال. الإدراج مباشر لا عبر t.try (هو
  -- يتراجع عن جملته)، والتأكيد آمن من NULL.
  INSERT INTO public.whatsapp_subscriptions (user_id, plan, status, billing_cycle, start_date, end_date, duration_days, is_renewal)
  VALUES (auth.uid(), 'bundle', 'pending', 'monthly', now(), now() + interval '30 days', 30, true);
  IF coalesce(t.err($s$select public.cancel_my_active_subscription((SELECT id FROM public.whatsapp_subscriptions WHERE status = 'pending' AND user_id = auth.uid() LIMIT 1), 'x')$s$), '')
       NOT LIKE '%غير فعّال%' THEN RESET ROLE; RAISE EXCEPTION 'FAIL D8c: إلغاء طلب معلّق بهذا المسار'; END IF;
  RESET ROLE;
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS D7/D8: الإلغاء علَم فقط مع تدقيق وبلا أثر قبل الانتهاء، والتراجع يمسحه، وغير المالك والمعلّق مرفوضان، والإلغاء مع طلب معلّق مرفوض';
END $$;

-- ── D9: حمولة اللوحة — علَم الإلغاء + بقاء 095/108 ────────────────────────
DO $$
DECLARE d jsonb; s jsonb;
BEGIN
  PERFORM t.act('00000000-0000-4000-8000-0000000000a1');
  SET LOCAL ROLE authenticated;
  d := public.get_my_company_dashboard();
  RESET ROLE;
  IF d IS NULL OR (d->>'viewer_role') <> 'admin' OR (d->'access'->>'suspended')::boolean IS NOT FALSE THEN
    RAISE EXCEPTION 'FAIL D9a: الحمولة (%)', d;
  END IF;
  SELECT e INTO s FROM jsonb_array_elements(d->'subscriptions') e WHERE e->>'id' = 'd0000000-0000-4000-8000-0000000000d1';
  IF s IS NULL OR (s->>'cancel_at_period_end')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL D9b: علَم الإلغاء غائب من الحمولة (%)', s;
  END IF;
  -- غير الفريق: null (095)
  PERFORM t.act('00000000-0000-4000-8000-0000000000a3');
  SET LOCAL ROLE authenticated;
  IF public.get_my_company_dashboard() IS NOT NULL THEN RESET ROLE; RAISE EXCEPTION 'FAIL D9c: غير الفريق رأى اللوحة'; END IF;
  RESET ROLE;
  -- شركة موقوفة: suspended=true وبلا امتيازات (108)
  UPDATE public.companies SET status = 'suspended' WHERE id = 'c0000000-0000-4000-8000-0000000000c1';
  PERFORM t.act('00000000-0000-4000-8000-0000000000a1');
  SET LOCAL ROLE authenticated;
  d := public.get_my_company_dashboard();
  RESET ROLE;
  IF (d->'access'->>'suspended')::boolean IS NOT TRUE OR jsonb_array_length(d->'entitlements') <> 0 THEN
    RAISE EXCEPTION 'FAIL D9d: منطق الإيقاف (%)', d->'access';
  END IF;
  UPDATE public.companies SET status = 'active' WHERE id = 'c0000000-0000-4000-8000-0000000000c1';
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS D9: علَم الإلغاء في الحمولة، وفحص الفريق والإيقاف يعملان (لم تُرجع 021)';
END $$;

-- ── D10: الوظيفة الدورية — صيغة الملغى مختلفة ─────────────────────────────
DO $$
DECLARE n1 text; n2 text;
BEGIN
  UPDATE public.whatsapp_subscriptions SET end_date = now() - interval '1 hour'
   WHERE id = 'd0000000-0000-4000-8000-0000000000d1';  -- ملغى بطلب صاحبه
  UPDATE public.whatsapp_subscriptions SET end_date = now() - interval '1 hour'
   WHERE id = 'd0000000-0000-4000-8000-0000000000d2';  -- منتهٍ عاديًا
  -- الخدمة مفعّلة قبل الانتهاء، لتُثبَت سحبها بعده
  UPDATE public.profiles SET whatsapp_enabled = true WHERE id = '00000000-0000-4000-8000-0000000000a1';
  PERFORM public.expire_stale_subscriptions();
  SELECT message INTO n1 FROM public.notifications
   WHERE user_id = '00000000-0000-4000-8000-0000000000a1' ORDER BY created_at DESC LIMIT 1;
  SELECT message INTO n2 FROM public.notifications
   WHERE user_id = '00000000-0000-4000-8000-0000000000a2' ORDER BY created_at DESC LIMIT 1;
  IF n1 NOT LIKE '%في الموعد الذي حددته%' THEN RAISE EXCEPTION 'FAIL D10a: %', n1; END IF;
  IF n2 NOT LIKE '%انتهت صلاحية اشتراكك%' THEN RAISE EXCEPTION 'FAIL D10b: %', n2; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.whatsapp_subscriptions
                  WHERE id = 'd0000000-0000-4000-8000-0000000000d1' AND status = 'expired') THEN
    RAISE EXCEPTION 'FAIL D10c: الملغى لم تنتهِ حالته';
  END IF;
  IF EXISTS (SELECT 1 FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000000000a1' AND whatsapp_enabled) THEN
    RAISE EXCEPTION 'FAIL D10d: خدمات الملغى لم تُسحب';
  END IF;
  RAISE NOTICE 'PASS D10: المنتهي الملغى بطلب صاحبه يُشعَر بصيغته الخاصة، والحالة والخدمات كالمعتاد';
END $$;

-- ── D11: anon خارج الدوال الجديدة ──────────────────────────────────────────
DO $$
BEGIN
  IF has_function_privilege('anon', 'public.cancel_my_active_subscription(uuid, text)', 'execute')
     OR has_function_privilege('anon', 'public.resume_my_subscription(uuid)', 'execute')
     OR has_function_privilege('anon', 'public.subscription_downgrade_quote(text)', 'execute')
     OR has_function_privilege('anon', 'public.request_subscription_downgrade(text, uuid, text, text)', 'execute')
     OR has_function_privilege('anon', 'public.submit_subscription_downgrade(text, text, text, text, text)', 'execute') THEN
    RAISE EXCEPTION 'FAIL D11: دالة جديدة متاحة لـ anon';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.cancel_my_active_subscription(uuid, text)', 'execute')
     OR NOT has_function_privilege('authenticated', 'public.submit_subscription_downgrade(text, text, text, text, text)', 'execute') THEN
    RAISE EXCEPTION 'FAIL D11: دالة جديدة غير متاحة لـ authenticated';
  END IF;
  RAISE NOTICE 'PASS D11: الدوال الجديدة لـ authenticated وحده';
END $$;

SELECT 'ALL COMPANY SUBSCRIPTION SELF-SERVICE TESTS PASSED';
