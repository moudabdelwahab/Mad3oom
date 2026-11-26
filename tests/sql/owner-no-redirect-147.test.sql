-- ============================================================================
-- اختبار تنفيذي لـ migrations/147_owner_no_redirect_rpcs.sql.
--
-- يثبّت الخصائص التي طُلبت صراحةً، كل واحدة تفشل إن انكسرت:
--
--   ① غير المالك يُرفض بـ 42501 في الدوال السبع.
--   ② المالك بلا تحقق بخطوتين: ①–④ تنجح، و⑤–⑦ تُرفض بـ 42501.
--   ③ `owner_service_status()`: الخدمات + الحوادث + ملخص البلاغات
--      (المحلولة مستبعَدة، والمراسلون بأسمائهم).
--   ④ `owner_set_service_status()`: حالة غير صالحة 22023، خدمة مفقودة
--      P0002، نجاح يحدّث الخدمة ويُدخل صف سجل بـ response_time NULL.
--   ⑤ `owner_company_store_overview()`: شركة مفقودة P0002، شركة ليست
--      متجرًا P0002، نجاح لمتجر بلا عدّادات خاطئة: الاستحقاقات لشركة
--      الهدف لا للمنادي (متجر ثانٍ بلا اشتراك → كلها false وطلباته NULL)،
--      والتذاكر المفتوحة تُعدّ مباشرةً (2 لشركة الهدف، و1 للمتجر الثاني).
--   ⑥ `owner_list_mcp_servers()`: الخوادم والاتصالات بلا أي عمود سرّي
--      (env/headers وكل *_encrypted وoauth_client_id/state غائبة من JSON).
--   ⑦ `owner_set_user_role()`: رتبة غير مسموحة 22023، مستخدم مفقود
--      P0002، الذات 42501، مالك منصة آخر 42501، نجاح user↔admin مع سطر
--      تدقيق واحد بالضبط لكل تغيير (محفِّز 053 — بلا إدخال ثانٍ من RPC)،
--      ونفس الرتبة تعيد changed=false بلا سجل جديد.
--   ⑧ `owner_ban_user()`: سبب قصير/غائب 22023، مستخدم مفقود P0002،
--      الذات 42501، مالك منصة آخر 42501، حظر دائم ('permanent' بلا حتى)
--      ثم مؤقت ('temporary' بحتى) مع سطر تدقيق واحد بالضبط لكل حظر
--      (محفِّز 053)، ثم رفع الحظر عبر `p_until` = الآن تمامًا (استدعاء
--      F3) وعبر تاريخ ماضٍ — كلاهما يعيد 'none' بلا حتى ولا سبب، و
--      `is_banned()` (029) تعيد false، وسطر تدقيق ثالث لرفع الحظر.
--      ورفع حظر مستخدم غير محظور يعيد 'none' بلا سجل جديد.
--   ⑨ `owner_set_user_points()`: سالب/NULL 22023، مستخدم مفقود P0002،
--      الذات 42501، نجاح يحدّث profiles.points ومحفظته مع سطر
--      'points.change'؛ ومستخدم بلا صف محفظة تُحدَّث نقاطه ويعود
--      wallet_total_points NULL (بلا إدخال صف، كما في users.js).
--   ⑩ التراجع يسقط الدوال الثماني ويعيد بوابة `manage_user_points`
--      إلى بريد 134 (المالك بلا بريد support@ يُرفض بـ UNAUTHORIZED).
--   ⑪ إعادة تطبيق 147 بعد التراجع تنجح.
--   ⑫ بوابة `manage_user_points` الموسَّعة: بلا بريد وبلا مالك →
--      UNAUTHORIZED؛ وsupport@ والمالك (بسياقه) يجمّدان ويفكّان
--      ويضيفان، وكل عملية تُسجَّل في central_wallet_transactions.
--
-- النمط منسوخ من owner-account-transfer-details.test.sql: دور authenticated
-- حقيقي + ادعاء JWT عبر request.jwt.claim.sub، لأن postgres يتجاوز RLS.
-- المتعاونون يُبذَرون بنسخ دنيا تحاكي توقيعاتها الحية: owner_capability /
-- owner_critical_ok عبر test.is_owner/test.step_up، و_owner_require() يرفع
-- 42501 بلا قدرة owner_only، وaccount_tier() من رتبة profiles (053 يقرأ
-- platform_authority — لا صفوف سلطة في هذا الاختبار)، وlog_privileged يكتب
-- في privileged_audit المزروع، و_ihub_connection_json يعيد المزوّد والحالة.
-- ومحفِّز التدقيق trg_audit_profile_privileged منسوخ من 053 لفرعي الرتبة
-- والحظر فقط — لإثبات أن ⑤ و⑥ تسجّلان سطرًا واحدًا لا سطرين.
-- و`can_manage_central_wallet()` منسوخ من 117 حرفيًا (بريد support@ ∨
-- owner_capability)، و`is_banned()` من 029 حرفيًا، و`auth.jwt()` يقرأ
-- بريد الجلسة من test.jwt_email — لاختبار بوابة manage_user_points
-- الموسَّعة في ⑫ ورفع الحظر في ⑧. وauth.users وcentral_wallet_transactions
-- مزروعان بأدنى الأعمدة التي تقرؤها manage_user_points.
-- محفِّز النقاط 008 غير مثبَّت هنا: سلوكه (يسمح لغير الذات) طبقة ثانية،
-- ورفض الذات يُختبر على مستوى الـRPC نفسه.
--
-- لم تُنفَّذ محليًا إن غاب Postgres (run-sql-tests.sh يتخطاها بصوت عالٍ) —
-- تُنفَّذ في CI.
-- ============================================================================
\set ON_ERROR_STOP on
\pset tuples_only on

CREATE SCHEMA IF NOT EXISTS auth;

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true),'')::uuid; $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
END $$;
GRANT USAGE ON SCHEMA auth, public TO authenticated, anon;

-- ── بذور الجداول (الأعمدة التي يقرؤها الترحيل وحدها) ────────────────────
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY, email text, full_name text, role text DEFAULT 'user',
  points integer DEFAULT 0, ban_status text DEFAULT 'none', ban_until timestamptz,
  ban_reason text, is_locked boolean DEFAULT false,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE TABLE public.user_wallets (
  user_id uuid PRIMARY KEY, total_points integer DEFAULT 0,
  available_points integer DEFAULT 0, is_frozen boolean DEFAULT false,
  updated_at timestamptz DEFAULT now());
CREATE TABLE public.services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, description text,
  status text DEFAULT 'operational', response_time integer, service_key text,
  status_changed_at timestamptz, last_checked timestamptz,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE TABLE public.service_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), service_id uuid NOT NULL,
  status text NOT NULL, response_time integer, created_at timestamptz DEFAULT now());
CREATE TABLE public.incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text NOT NULL, description text,
  status text DEFAULT 'investigating', affected_services text[] DEFAULT '{}',
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  resolved_at timestamptz);
CREATE TABLE public.customer_service_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL,
  service_id uuid NOT NULL, incident_id uuid, episode_key text NOT NULL,
  status text NOT NULL DEFAULT 'open', source text NOT NULL DEFAULT 'customer_portal',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_name text NOT NULL,
  user_id uuid, status text DEFAULT 'active', account_kind text DEFAULT 'company');
CREATE TABLE public.whatsapp_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, company_id uuid,
  plan text, status text, billing_cycle text,
  start_date timestamptz, end_date timestamptz);
CREATE TABLE public.subscription_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), key text UNIQUE, name text);
CREATE TABLE public.plan_features (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), plan_id uuid, feature_key text,
  enabled boolean DEFAULT true);
CREATE TABLE public.company_feature_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid,
  feature_key text, expires_at timestamptz);
CREATE TABLE public.ihub_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid, provider text,
  status text, created_at timestamptz DEFAULT now());
CREATE TABLE public.ihub_providers (key text PRIMARY KEY, enabled boolean DEFAULT true);
CREATE TABLE public.tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, company_id uuid,
  scope text DEFAULT 'individual', status text DEFAULT 'open',
  created_at timestamptz DEFAULT now());
CREATE TABLE public.store_order_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid, kind text,
  order_ref text, status text DEFAULT 'pending', due_at timestamptz,
  ticket_id uuid, created_at timestamptz DEFAULT now());
CREATE TABLE public.store_order_request_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, request_id uuid,
  company_id uuid, action text, to_status text, created_at timestamptz DEFAULT now());
CREATE TABLE public.ihub_ticket_links (
  ticket_id uuid PRIMARY KEY, unlinked_at timestamptz);
CREATE TABLE public.company_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid, status text DEFAULT 'open');
CREATE TABLE public.mcp_servers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
  transport text DEFAULT 'streamable_http', url text, command text,
  args jsonb DEFAULT '[]'::jsonb, env jsonb DEFAULT '{}'::jsonb,
  headers jsonb DEFAULT '{}'::jsonb, description text DEFAULT '',
  category text DEFAULT 'general', enabled boolean DEFAULT true,
  created_by uuid, created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(), connector_type text DEFAULT 'mcp_server',
  owner_id uuid NOT NULL);
CREATE TABLE public.mcp_server_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), server_id uuid NOT NULL,
  owner_id uuid NOT NULL, auth_type text DEFAULT 'none' NOT NULL,
  api_key_encrypted text, api_secret_encrypted text, bearer_token_encrypted text,
  custom_config_encrypted text, oauth_client_id text,
  oauth_client_secret_encrypted text, oauth_authorize_url text,
  oauth_token_url text, oauth_scope text, oauth_access_token_encrypted text,
  oauth_refresh_token_encrypted text, oauth_token_expires_at timestamptz,
  oauth_state text, status text DEFAULT 'pending' NOT NULL,
  tools jsonb DEFAULT '[]'::jsonb NOT NULL, last_checked_at timestamptz,
  last_error text, created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now());
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
CREATE TABLE public.central_wallet_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), admin_id uuid,
  target_user_id uuid, amount bigint, transaction_type text,
  previous_balance bigint, new_balance bigint,
  created_at timestamptz DEFAULT now());
CREATE TABLE public.privileged_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, at timestamptz DEFAULT now(),
  actor_id uuid, action text, target_user_id uuid, old_value jsonb, new_value jsonb);

-- ── بذور الدوال التي يعتمد عليها الترحيل (نسخ دنيا) ─────────────────────
CREATE OR REPLACE FUNCTION public.owner_capability(p_cap text) RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT current_setting('test.is_owner', true) = '1'; $$;
CREATE OR REPLACE FUNCTION public.owner_critical_ok() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT current_setting('test.is_owner', true) = '1' AND current_setting('test.step_up', true) = '1'; $$;
CREATE OR REPLACE FUNCTION public._owner_require() RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
begin
  if not coalesce(public.owner_capability('owner_only'), false) then
    raise exception 'لوحة المالك في سياق «مالك المنصة» فقط' using errcode = '42501';
  end if;
end $$;
CREATE OR REPLACE FUNCTION public.log_privileged(p_action text, p_target uuid, p_old jsonb, p_new jsonb) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $$
  INSERT INTO public.privileged_audit (actor_id, action, target_user_id, old_value, new_value)
  VALUES (auth.uid(), p_action, p_target, p_old, p_new);
$$;
CREATE OR REPLACE FUNCTION public.account_tier(p_user_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT CASE WHEN p_user_id IS NULL THEN 'system'
    WHEN (SELECT p.role FROM public.profiles p WHERE p.id = p_user_id) = 'platform_owner' THEN 'owner'
    WHEN (SELECT p.role FROM public.profiles p WHERE p.id = p_user_id) = 'admin' THEN 'admin'
    WHEN (SELECT p.role FROM public.profiles p WHERE p.id = p_user_id) = 'support' THEN 'support'
    ELSE 'customer' END;
$$;
CREATE OR REPLACE FUNCTION public._ihub_connection_json(r public.ihub_connections) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT jsonb_build_object('provider', r.provider, 'status', r.status);
$$;
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb
LANGUAGE sql STABLE AS $$ SELECT jsonb_build_object('email', NULLIF(current_setting('test.jwt_email', true),'')); $$;
CREATE OR REPLACE FUNCTION public.can_manage_central_wallet() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT coalesce(auth.jwt() ->> 'email', '') = 'support@mad3oom.online'
      OR coalesce(public.owner_capability('owner_only'), false);
$$;
CREATE OR REPLACE FUNCTION public.is_banned(p_user_id uuid DEFAULT auth.uid()) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT coalesce((
    SELECT p.ban_status IS NOT NULL
       AND p.ban_status NOT IN ('none','active')
       AND (p.ban_until IS NULL OR p.ban_until > now())
      FROM public.profiles p WHERE p.id = p_user_id
  ), false);
$$;

-- محفِّز التدقيق من 053 (فرعا الرتبة والحظر فقط) — لإثبات عدم التكرار.
CREATE OR REPLACE FUNCTION public.audit_profile_privileged_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
begin
  if new.role is distinct from old.role then
    perform public.log_privileged('role.change', new.id,
      jsonb_build_object('role', old.role), jsonb_build_object('role', new.role));
  end if;
  if new.ban_status is distinct from old.ban_status
     or new.ban_until is distinct from old.ban_until
     or new.is_locked is distinct from old.is_locked then
    perform public.log_privileged('account.restriction', new.id,
      jsonb_build_object('ban_status', old.ban_status, 'ban_until', old.ban_until, 'is_locked', old.is_locked),
      jsonb_build_object('ban_status', new.ban_status, 'ban_until', new.ban_until, 'is_locked', new.is_locked,
                         'ban_reason', new.ban_reason));
  end if;
  return new;
end;
$$;
DROP TRIGGER IF EXISTS trg_audit_profile_privileged ON public.profiles;
CREATE TRIGGER trg_audit_profile_privileged
  AFTER UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.audit_profile_privileged_change();

\i migrations/147_owner_no_redirect_rpcs.sql

-- ── بذور البيانات ───────────────────────────────────────────────────────
DO $$
DECLARE
  v_owner  uuid := '11111111-1111-4111-8111-111111111111';
  v_owner2 uuid := '44444444-4444-4444-8444-444444444444';
  v_admin  uuid := '22222222-2222-4222-8222-222222222222';
  v_user1  uuid := '55555555-5555-4555-8555-555555555555';
  v_user2  uuid := '66666666-6666-4666-8666-666666666666';
  v_user3  uuid := '77777777-7777-4777-8777-777777777777';
  v_cowner uuid := '33333333-3333-4333-8333-333333333333';
  v_ca     uuid := 'c0000000-0000-4000-8000-000000000001';
  v_cb     uuid := 'c0000000-0000-4000-8000-000000000002';
  v_plan   uuid := 'f0000000-0000-4000-8000-000000000001';
  v_s1     uuid := 'a0000000-0000-4000-8000-000000000001';
  v_s2     uuid := 'a0000000-0000-4000-8000-000000000002';
  v_s3     uuid := 'a0000000-0000-4000-8000-000000000003';
  v_i1     uuid := 'b0000000-0000-4000-8000-000000000001';
  v_srv1   uuid := 'e0000000-0000-4000-8000-000000000001';
BEGIN
  INSERT INTO public.profiles (id, full_name, email, role, points) VALUES
    (v_owner,  'مالك المنصة',      'owner@mad3oom.com',  'platform_owner', 0),
    (v_owner2, 'مالك منصة ثانٍ',   'owner2@mad3oom.com', 'platform_owner', 0),
    (v_admin,  'إداري الوحدة',     'admin@mad3oom.com',  'admin',          0),
    (v_user1,  'عميل أول',         'user1@example.com',  'user',         120),
    (v_user2,  'عميل بلا محفظة',   'user2@example.com',  'user',          50),
    (v_user3,  'عميل للحظر',      'user3@example.com',  'user',           0),
    (v_cowner, 'مالك المتجر',      'cowner@example.com', 'company_admin', 10);
  INSERT INTO auth.users (id, email) VALUES
    (v_owner, 'owner@mad3oom.com'), (v_owner2, 'owner2@mad3oom.com'),
    (v_admin, 'admin@mad3oom.com'), (v_user1, 'user1@example.com'),
    (v_user2, 'user2@example.com'), (v_user3, 'user3@example.com'),
    (v_cowner, 'cowner@example.com');
  INSERT INTO public.user_wallets (user_id, total_points, available_points) VALUES
    (v_user1, 120, 100), (v_user3, 0, 0);
  INSERT INTO public.companies (id, company_name, user_id, status, account_kind) VALUES
    (v_ca, 'متجر الهدف', '33333333-3333-4333-8333-333333333333', 'active', 'ecommerce_store'),
    -- مالك مختلف بلا اشتراك: منطق 092 يطابق الاشتراك عبر company_id أو عبر
    -- user_id مالك الشركة، فمشاركة المالك نفسها كانت ستمنح v_cb الاستحقاق.
    (v_cb, 'متجر بلا اشتراك', '66666666-6666-4666-8666-666666666666', 'active', 'ecommerce_store');
  INSERT INTO public.subscription_plans (id, key, name) VALUES (v_plan, 'ultimate', 'الشاملة');
  INSERT INTO public.plan_features (plan_id, feature_key, enabled) VALUES
    (v_plan, 'store_support', true), (v_plan, 'shopify_integration', true);
  INSERT INTO public.whatsapp_subscriptions (user_id, company_id, plan, status, start_date, end_date)
    VALUES (v_cowner, v_ca, 'ultimate', 'active', now() - interval '10 days', now() + interval '20 days');
  INSERT INTO public.company_feature_overrides (company_id, feature_key, expires_at)
    VALUES (v_ca, 'integrations_hub', null);
  INSERT INTO public.ihub_providers (key, enabled) VALUES ('shopify', true);
  INSERT INTO public.ihub_connections (company_id, provider, status) VALUES (v_ca, 'shopify', 'connected');
  INSERT INTO public.tickets (id, user_id, company_id, scope, status) VALUES
    ('d0000000-0000-4000-8000-000000000001', v_user1, v_ca, 'company', 'open'),
    ('d0000000-0000-4000-8000-000000000002', v_user1, v_ca, 'company', 'in-progress'),
    ('d0000000-0000-4000-8000-000000000003', v_user1, v_ca, 'company', 'resolved'),
    ('d0000000-0000-4000-8000-000000000004', v_user1, v_cb, 'company', 'open');
  INSERT INTO public.ihub_ticket_links (ticket_id, unlinked_at) VALUES
    ('d0000000-0000-4000-8000-000000000001', null),
    ('d0000000-0000-4000-8000-000000000002', now());
  INSERT INTO public.company_conversations (company_id, status) VALUES
    (v_ca, 'open'), (v_ca, 'closed');
  INSERT INTO public.store_order_requests (id, company_id, kind, order_ref, status, due_at) VALUES
    ('90000000-0000-4000-8000-000000000001', v_ca, 'order', 'ORD-1', 'pending', now() + interval '2 days'),
    ('90000000-0000-4000-8000-000000000002', v_ca, 'order', 'ORD-2', 'pending', now() - interval '1 day'),
    ('90000000-0000-4000-8000-000000000003', v_ca, 'order', 'ORD-3', 'resolved', now() + interval '2 days');
  INSERT INTO public.store_order_request_events (request_id, company_id, action, to_status) VALUES
    ('90000000-0000-4000-8000-000000000001', v_ca, 'created', 'pending'),
    ('90000000-0000-4000-8000-000000000002', v_ca, 'created', 'pending');
  INSERT INTO public.services (id, name, status) VALUES
    (v_s1, 'المنصة', 'operational'),
    (v_s2, 'واتساب', 'degraded'),
    (v_s3, 'تجريبي', 'operational');
  INSERT INTO public.incidents (id, title, status, affected_services) VALUES
    (v_i1, 'تعطل جزئي', 'investigating', ARRAY['واتساب']);
  INSERT INTO public.customer_service_reports (user_id, service_id, incident_id, episode_key, status) VALUES
    (v_user1, v_s1, v_i1, 'incident:' || v_i1::text, 'open'),
    (v_user1, v_s2, null, 'service:' || v_s2::text || ':old', 'resolved'),
    (v_user2, v_s2, null, 'service:' || v_s2::text || ':x', 'open');
  INSERT INTO public.mcp_servers (id, name, transport, url, env, headers, owner_id) VALUES
    (v_srv1, 'خادم الأسرار', 'streamable_http', 'https://mcp.example.com',
     '{"API_KEY":"topsecret"}'::jsonb, '{"Authorization":"Bearer x"}'::jsonb, v_owner),
    ('e0000000-0000-4000-8000-000000000002', 'خادم عادي', 'streamable_http', 'https://plain.example.com',
     '{}'::jsonb, '{}'::jsonb, v_owner);
  INSERT INTO public.mcp_server_connections (server_id, owner_id, auth_type,
      api_key_encrypted, bearer_token_encrypted, oauth_client_id, oauth_client_secret_encrypted,
      oauth_access_token_encrypted, oauth_refresh_token_encrypted, oauth_state, status, tools) VALUES
    (v_srv1, v_owner, 'api_key', 'enc-key', 'enc-bearer', 'cid-123', 'enc-secret',
     'enc-access', 'enc-refresh', 'state-xyz', 'connected', '[{"name":"tool1"}]'::jsonb);
END $$;

-- ① غير المالك يُرفض بـ 42501 في الدوال السبع.
DO $$
DECLARE v_err text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '55555555-5555-4555-8555-555555555555', true);
  PERFORM set_config('test.is_owner', '0', true);
  PERFORM set_config('test.step_up', '0', true);
  BEGIN PERFORM public.owner_service_status(); RAISE EXCEPTION 'FAIL ①: service_status not rejected';
    EXCEPTION WHEN OTHERS THEN IF SQLSTATE <> '42501' THEN RAISE EXCEPTION 'FAIL ①: service_status wrong code %: expected 42501', SQLSTATE; END IF; END;
  BEGIN PERFORM public.owner_set_service_status('a0000000-0000-4000-8000-000000000001', 'down'); RAISE EXCEPTION 'FAIL ①: set_service_status not rejected';
    EXCEPTION WHEN OTHERS THEN IF SQLSTATE <> '42501' THEN RAISE EXCEPTION 'FAIL ①: set_service_status wrong code %: expected 42501', SQLSTATE; END IF; END;
  BEGIN PERFORM public.owner_company_store_overview('c0000000-0000-4000-8000-000000000001'); RAISE EXCEPTION 'FAIL ①: store_overview not rejected';
    EXCEPTION WHEN OTHERS THEN IF SQLSTATE <> '42501' THEN RAISE EXCEPTION 'FAIL ①: store_overview wrong code %: expected 42501', SQLSTATE; END IF; END;
  BEGIN PERFORM public.owner_list_mcp_servers(); RAISE EXCEPTION 'FAIL ①: list_mcp not rejected';
    EXCEPTION WHEN OTHERS THEN IF SQLSTATE <> '42501' THEN RAISE EXCEPTION 'FAIL ①: list_mcp wrong code %: expected 42501', SQLSTATE; END IF; END;
  BEGIN PERFORM public.owner_set_user_role('66666666-6666-4666-8666-666666666666', 'admin'); RAISE EXCEPTION 'FAIL ①: set_role not rejected';
    EXCEPTION WHEN OTHERS THEN IF SQLSTATE <> '42501' THEN RAISE EXCEPTION 'FAIL ①: set_role wrong code %: expected 42501', SQLSTATE; END IF; END;
  BEGIN PERFORM public.owner_ban_user('77777777-7777-4777-8777-777777777777', 'مخالفة متكررة للقواعد', null); RAISE EXCEPTION 'FAIL ①: ban not rejected';
    EXCEPTION WHEN OTHERS THEN IF SQLSTATE <> '42501' THEN RAISE EXCEPTION 'FAIL ①: ban wrong code %: expected 42501', SQLSTATE; END IF; END;
  BEGIN PERFORM public.owner_set_user_points('55555555-5555-4555-8555-555555555555', 10); RAISE EXCEPTION 'FAIL ①: set_points not rejected';
    EXCEPTION WHEN OTHERS THEN IF SQLSTATE <> '42501' THEN RAISE EXCEPTION 'FAIL ①: set_points wrong code %: expected 42501', SQLSTATE; END IF; END;
  RAISE NOTICE 'PASS ① غير المالك يُرفض بـ 42501 في الدوال السبع';
END $$;

-- ② المالك بلا تحقق بخطوتين: ①–④ تنجح، و⑤–⑦ تُرفض بـ 42501.
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
  PERFORM set_config('test.is_owner', '1', true);
  PERFORM set_config('test.step_up', '0', true);
  r := public.owner_service_status();
  IF jsonb_array_length(r -> 'services') <> 3 THEN RAISE EXCEPTION 'FAIL ②: service_status services %', r; END IF;
  r := public.owner_set_service_status('a0000000-0000-4000-8000-000000000003', 'degraded');
  IF (r ->> 'status') <> 'degraded' THEN RAISE EXCEPTION 'FAIL ②: set_service_status without step-up failed: %', r; END IF;
  r := public.owner_company_store_overview('c0000000-0000-4000-8000-000000000001');
  IF (r ->> 'company_id') <> 'c0000000-0000-4000-8000-000000000001' THEN RAISE EXCEPTION 'FAIL ②: store_overview without step-up failed: %', r; END IF;
  r := public.owner_list_mcp_servers();
  IF jsonb_array_length(r -> 'servers') <> 2 THEN RAISE EXCEPTION 'FAIL ②: list_mcp without step-up failed: %', r; END IF;
  BEGIN PERFORM public.owner_set_user_role('66666666-6666-4666-8666-666666666666', 'admin'); RAISE EXCEPTION 'FAIL ②: set_role without step-up not rejected';
    EXCEPTION WHEN OTHERS THEN IF SQLSTATE <> '42501' THEN RAISE EXCEPTION 'FAIL ②: set_role wrong code %: expected 42501', SQLSTATE; END IF; END;
  BEGIN PERFORM public.owner_ban_user('77777777-7777-4777-8777-777777777777', 'مخالفة متكررة للقواعد', null); RAISE EXCEPTION 'FAIL ②: ban without step-up not rejected';
    EXCEPTION WHEN OTHERS THEN IF SQLSTATE <> '42501' THEN RAISE EXCEPTION 'FAIL ②: ban wrong code %: expected 42501', SQLSTATE; END IF; END;
  BEGIN PERFORM public.owner_set_user_points('55555555-5555-4555-8555-555555555555', 10); RAISE EXCEPTION 'FAIL ②: set_points without step-up not rejected';
    EXCEPTION WHEN OTHERS THEN IF SQLSTATE <> '42501' THEN RAISE EXCEPTION 'FAIL ②: set_points wrong code %: expected 42501', SQLSTATE; END IF; END;
  RAISE NOTICE 'PASS ② المالك بلا تحقق: القراءات وتغيير الحالة تنجح، والحرجة تُرفض بـ 42501';
END $$;

-- ③ owner_service_status: الخدمات + الحوادث + ملخص البلاغات.
DO $$
DECLARE r jsonb; v_sum jsonb; v_g jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
  PERFORM set_config('test.is_owner', '1', true);
  PERFORM set_config('test.step_up', '1', true);
  r := public.owner_service_status();
  IF jsonb_array_length(r -> 'services') <> 3 THEN RAISE EXCEPTION 'FAIL ③: services expected 3, got %', r; END IF;
  IF jsonb_array_length(r -> 'incidents') <> 1 THEN RAISE EXCEPTION 'FAIL ③: incidents expected 1, got %', r; END IF;
  v_sum := r -> 'report_summary';
  IF jsonb_array_length(v_sum) <> 2 THEN RAISE EXCEPTION 'FAIL ③: report_summary expected 2 groups (resolved excluded), got %', v_sum; END IF;
  SELECT x INTO v_g FROM jsonb_array_elements(v_sum) x WHERE (x ->> 'service_id') = 'a0000000-0000-4000-8000-000000000001';
  IF v_g IS NULL OR (v_g ->> 'report_count') <> '1' THEN RAISE EXCEPTION 'FAIL ③: s1 group wrong: %', v_g; END IF;
  IF (v_g -> 'reporters' -> 0 ->> 'name') <> 'عميل أول' THEN RAISE EXCEPTION 'FAIL ③: reporter name wrong: %', v_g; END IF;
  IF (v_g ->> 'incident_id') <> 'b0000000-0000-4000-8000-000000000001' THEN RAISE EXCEPTION 'FAIL ③: incident_id wrong: %', v_g; END IF;
  RAISE NOTICE 'PASS ③ حالة الخدمات: 3 خدمات + حادثة + ملخص بلاغات بمجموعتين (المحلولة مستبعَدة)';
END $$;

-- ④ owner_set_service_status: الحراس والنجاح والسجل.
DO $$
DECLARE r jsonb; v_hist int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
  PERFORM set_config('test.is_owner', '1', true);
  PERFORM set_config('test.step_up', '1', true);
  BEGIN PERFORM public.owner_set_service_status('a0000000-0000-4000-8000-000000000001', 'broken'); RAISE EXCEPTION 'FAIL ④: bad status not rejected';
    EXCEPTION WHEN OTHERS THEN IF SQLSTATE <> '22023' THEN RAISE EXCEPTION 'FAIL ④: bad status wrong code %: expected 22023', SQLSTATE; END IF; END;
  BEGIN PERFORM public.owner_set_service_status('a0000000-0000-4000-8000-000000000099', 'down'); RAISE EXCEPTION 'FAIL ④: missing service not rejected';
    EXCEPTION WHEN OTHERS THEN IF SQLSTATE <> 'P0002' THEN RAISE EXCEPTION 'FAIL ④: missing service wrong code %: expected P0002', SQLSTATE; END IF; END;
  BEGIN PERFORM public.owner_set_service_status(null, 'down'); RAISE EXCEPTION 'FAIL ④: null service not rejected';
    EXCEPTION WHEN OTHERS THEN IF SQLSTATE <> '22023' THEN RAISE EXCEPTION 'FAIL ④: null service wrong code %: expected 22023', SQLSTATE; END IF; END;
  SELECT count(*) INTO v_hist FROM public.service_status_history WHERE service_id = 'a0000000-0000-4000-8000-000000000001';
  IF v_hist <> 0 THEN RAISE EXCEPTION 'FAIL ④: history not empty before success: %', v_hist; END IF;
  r := public.owner_set_service_status('a0000000-0000-4000-8000-000000000001', 'degraded');
  IF (r ->> 'status') <> 'degraded' THEN RAISE EXCEPTION 'FAIL ④: returned row status wrong: %', r; END IF;
  IF (SELECT status FROM public.services WHERE id = 'a0000000-0000-4000-8000-000000000001') <> 'degraded' THEN RAISE EXCEPTION 'FAIL ④: services row not updated'; END IF;
  SELECT count(*) INTO v_hist FROM public.service_status_history
    WHERE service_id = 'a0000000-0000-4000-8000-000000000001' AND status = 'degraded' AND response_time IS NULL;
  IF v_hist <> 1 THEN RAISE EXCEPTION 'FAIL ④: history row missing: %', v_hist; END IF;
  RAISE NOTICE 'PASS ④ تغيير حالة الخدمة: حراس + تحديث + صف سجل';
END $$;

-- ⑤ owner_company_store_overview: الحراس والاستحقاقات لشركة الهدف والعدّادات.
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
  PERFORM set_config('test.is_owner', '1', true);
  PERFORM set_config('test.step_up', '1', true);
  BEGIN PERFORM public.owner_company_store_overview('c0000000-0000-4000-8000-000000000099'); RAISE EXCEPTION 'FAIL ⑤: missing company not rejected';
    EXCEPTION WHEN OTHERS THEN IF SQLSTATE <> 'P0002' THEN RAISE EXCEPTION 'FAIL ⑤: missing company wrong code %: expected P0002', SQLSTATE; END IF; END;
  r := public.owner_company_store_overview('c0000000-0000-4000-8000-000000000001');
  IF (r ->> 'company_id') <> 'c0000000-0000-4000-8000-000000000001' THEN RAISE EXCEPTION 'FAIL ⑤: company_id wrong: %', r; END IF;
  IF (r ->> 'my_role') <> 'owner' THEN RAISE EXCEPTION 'FAIL ⑤: my_role expected owner: %', r; END IF;
  IF NOT ((r -> 'entitlements' ->> 'store_support')::boolean
      AND (r -> 'entitlements' ->> 'shopify_integration')::boolean
      AND (r -> 'entitlements' ->> 'integrations_hub')::boolean) THEN RAISE EXCEPTION 'FAIL ⑤: entitlements expected all true: %', r -> 'entitlements'; END IF;
  IF (r -> 'connection' ->> 'provider') <> 'shopify' THEN RAISE EXCEPTION 'FAIL ⑤: connection wrong: %', r -> 'connection'; END IF;
  IF NOT (r ->> 'shopify_enabled')::boolean THEN RAISE EXCEPTION 'FAIL ⑤: shopify_enabled expected true'; END IF;
  IF (r ->> 'open_tickets') <> '2' THEN RAISE EXCEPTION 'FAIL ⑤: open_tickets expected 2: %', r; END IF;
  IF (r ->> 'active_conversations') <> '1' THEN RAISE EXCEPTION 'FAIL ⑤: active_conversations expected 1: %', r; END IF;
  IF (r ->> 'unresolved_requests') <> '2' THEN RAISE EXCEPTION 'FAIL ⑤: unresolved_requests expected 2: %', r; END IF;
  IF (r ->> 'overdue_requests') <> '1' THEN RAISE EXCEPTION 'FAIL ⑤: overdue_requests expected 1: %', r; END IF;
  IF (r ->> 'order_linked_open_tickets') <> '1' THEN RAISE EXCEPTION 'FAIL ⑤: order_linked_open_tickets expected 1: %', r; END IF;
  IF jsonb_array_length(r -> 'recent_activity') <> 2 THEN RAISE EXCEPTION 'FAIL ⑤: recent_activity expected 2: %', r; END IF;
  -- متجر ثانٍ بلا اشتراك ولا استثناء: الاستحقاقات كلها false، والطلبات NULL،
  -- وتذكرته المفتوحة الوحيدة تُعدّ — إثبات أن الحساب لشركة الهدف لا للمنادي.
  r := public.owner_company_store_overview('c0000000-0000-4000-8000-000000000002');
  IF ((r -> 'entitlements' ->> 'store_support')::boolean
      OR (r -> 'entitlements' ->> 'shopify_integration')::boolean
      OR (r -> 'entitlements' ->> 'integrations_hub')::boolean) THEN RAISE EXCEPTION 'FAIL ⑤: unentitled store entitlements not all false: %', r -> 'entitlements'; END IF;
  IF (r ->> 'unresolved_requests') IS NOT NULL THEN RAISE EXCEPTION 'FAIL ⑤: unresolved_requests expected NULL when not entitled: %', r; END IF;
  IF (r ->> 'open_tickets') <> '1' THEN RAISE EXCEPTION 'FAIL ⑤: second store open_tickets expected 1: %', r; END IF;
  RAISE NOTICE 'PASS ⑤ نظرة المتجر: حراس + استحقاقات شركة الهدف + عدّادات مباشرة';
END $$;

-- ⑥ owner_list_mcp_servers: بلا أي عمود سرّي.
DO $$
DECLARE r jsonb; v_text text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
  PERFORM set_config('test.is_owner', '1', true);
  PERFORM set_config('test.step_up', '1', true);
  r := public.owner_list_mcp_servers();
  IF jsonb_array_length(r -> 'servers') <> 2 THEN RAISE EXCEPTION 'FAIL ⑥: servers expected 2: %', r; END IF;
  IF jsonb_array_length(r -> 'connections') <> 1 THEN RAISE EXCEPTION 'FAIL ⑥: connections expected 1: %', r; END IF;
  v_text := r::text;
  IF v_text LIKE '%topsecret%' OR v_text LIKE '%Bearer x%' OR v_text LIKE '%enc-key%'
     OR v_text LIKE '%enc-bearer%' OR v_text LIKE '%cid-123%' OR v_text LIKE '%enc-secret%'
     OR v_text LIKE '%enc-access%' OR v_text LIKE '%enc-refresh%' OR v_text LIKE '%state-xyz%' THEN
    RAISE EXCEPTION 'FAIL ⑥: secret value leaked in response: %', r;
  END IF;
  IF v_text LIKE '%api_key_encrypted%' OR v_text LIKE '%api_secret_encrypted%'
     OR v_text LIKE '%bearer_token_encrypted%' OR v_text LIKE '%custom_config_encrypted%'
     OR v_text LIKE '%oauth_client_id%' OR v_text LIKE '%oauth_client_secret_encrypted%'
     OR v_text LIKE '%oauth_access_token_encrypted%' OR v_text LIKE '%oauth_refresh_token_encrypted%'
     OR v_text LIKE '%oauth_state%' OR v_text LIKE '%"env"%' OR v_text LIKE '%"headers"%' THEN
    RAISE EXCEPTION 'FAIL ⑥: secret column present in response: %', r;
  END IF;
  IF (r -> 'servers' -> 0 ->> 'name') NOT IN ('خادم الأسرار', 'خادم عادي') THEN RAISE EXCEPTION 'FAIL ⑥: server name missing: %', r; END IF;
  IF (r -> 'connections' -> 0 ->> 'status') <> 'connected' THEN RAISE EXCEPTION 'FAIL ⑥: connection status missing: %', r; END IF;
  RAISE NOTICE 'PASS ⑥ قائمة MCP: خادمان + اتصال، بلا أي سر';
END $$;

-- ⑦ owner_set_user_role: الحراس والنجاح وسطر تدقيق واحد بالضبط.
DO $$
DECLARE r jsonb; v_n int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
  PERFORM set_config('test.is_owner', '1', true);
  PERFORM set_config('test.step_up', '1', true);
  BEGIN PERFORM public.owner_set_user_role('55555555-5555-4555-8555-555555555555', 'support'); RAISE EXCEPTION 'FAIL ⑦: bad role not rejected';
    EXCEPTION WHEN OTHERS THEN IF SQLSTATE <> '22023' THEN RAISE EXCEPTION 'FAIL ⑦: bad role wrong code %: expected 22023', SQLSTATE; END IF; END;
  BEGIN PERFORM public.owner_set_user_role('55555555-5555-4555-8555-555555555599', 'admin'); RAISE EXCEPTION 'FAIL ⑦: missing user not rejected';
    EXCEPTION WHEN OTHERS THEN IF SQLSTATE <> 'P0002' THEN RAISE EXCEPTION 'FAIL ⑦: missing user wrong code %: expected P0002', SQLSTATE; END IF; END;
  BEGIN PERFORM public.owner_set_user_role('11111111-1111-4111-8111-111111111111', 'admin'); RAISE EXCEPTION 'FAIL ⑦: self role change not rejected';
    EXCEPTION WHEN OTHERS THEN IF SQLSTATE <> '42501' THEN RAISE EXCEPTION 'FAIL ⑦: self wrong code %: expected 42501', SQLSTATE; END IF; END;
  BEGIN PERFORM public.owner_set_user_role('44444444-4444-4444-8444-444444444444', 'admin'); RAISE EXCEPTION 'FAIL ⑦: second owner role change not rejected';
    EXCEPTION WHEN OTHERS THEN IF SQLSTATE <> '42501' THEN RAISE EXCEPTION 'FAIL ⑦: second owner wrong code %: expected 42501', SQLSTATE; END IF; END;
  r := public.owner_set_user_role('55555555-5555-4555-8555-555555555555', 'admin');
  IF NOT (r ->> 'changed')::boolean OR (r ->> 'old_role') <> 'user' OR (r ->> 'new_role') <> 'admin' THEN RAISE EXCEPTION 'FAIL ⑦: promote result wrong: %', r; END IF;
  IF (SELECT role FROM public.profiles WHERE id = '55555555-5555-4555-8555-555555555555') <> 'admin' THEN RAISE EXCEPTION 'FAIL ⑦: profile role not updated'; END IF;
  SELECT count(*) INTO v_n FROM public.privileged_audit WHERE action = 'role.change' AND target_user_id = '55555555-5555-4555-8555-555555555555';
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL ⑦: expected exactly 1 role.change audit row, got %', v_n; END IF;
  r := public.owner_set_user_role('55555555-5555-4555-8555-555555555555', 'user');
  IF NOT (r ->> 'changed')::boolean THEN RAISE EXCEPTION 'FAIL ⑦: demote result wrong: %', r; END IF;
  SELECT count(*) INTO v_n FROM public.privileged_audit WHERE action = 'role.change' AND target_user_id = '55555555-5555-4555-8555-555555555555';
  IF v_n <> 2 THEN RAISE EXCEPTION 'FAIL ⑦: expected 2 role.change rows after demote, got %', v_n; END IF;
  r := public.owner_set_user_role('55555555-5555-4555-8555-555555555555', 'user');
  IF (r ->> 'changed')::boolean THEN RAISE EXCEPTION 'FAIL ⑦: same-role must return changed=false: %', r; END IF;
  SELECT count(*) INTO v_n FROM public.privileged_audit WHERE action = 'role.change' AND target_user_id = '55555555-5555-4555-8555-555555555555';
  IF v_n <> 2 THEN RAISE EXCEPTION 'FAIL ⑦: same-role must not add an audit row, got %', v_n; END IF;
  RAISE NOTICE 'PASS ⑦ تغيير الرتبة: حراس + ترقية/سحب + سطر تدقيق واحد لكل تغيير';
END $$;

-- ⑧ owner_ban_user: الحراس والحظر الدائم ثم المؤقت وسطر تدقيق واحد لكل حظر.
DO $$
DECLARE r jsonb; v_n int; v_until timestamptz := now() + interval '7 days';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
  PERFORM set_config('test.is_owner', '1', true);
  PERFORM set_config('test.step_up', '1', true);
  BEGIN PERFORM public.owner_ban_user('77777777-7777-4777-8777-777777777777', 'abc', null); RAISE EXCEPTION 'FAIL ⑧: short reason not rejected';
    EXCEPTION WHEN OTHERS THEN IF SQLSTATE <> '22023' THEN RAISE EXCEPTION 'FAIL ⑧: short reason wrong code %: expected 22023', SQLSTATE; END IF; END;
  BEGIN PERFORM public.owner_ban_user('77777777-7777-4777-8777-777777777777', null, null); RAISE EXCEPTION 'FAIL ⑧: null reason not rejected';
    EXCEPTION WHEN OTHERS THEN IF SQLSTATE <> '22023' THEN RAISE EXCEPTION 'FAIL ⑧: null reason wrong code %: expected 22023', SQLSTATE; END IF; END;
  BEGIN PERFORM public.owner_ban_user('77777777-7777-4777-8777-777777777799', 'مخالفة متكررة للقواعد', null); RAISE EXCEPTION 'FAIL ⑧: missing user not rejected';
    EXCEPTION WHEN OTHERS THEN IF SQLSTATE <> 'P0002' THEN RAISE EXCEPTION 'FAIL ⑧: missing user wrong code %: expected P0002', SQLSTATE; END IF; END;
  BEGIN PERFORM public.owner_ban_user('11111111-1111-4111-8111-111111111111', 'مخالفة متكررة للقواعد', null); RAISE EXCEPTION 'FAIL ⑧: self ban not rejected';
    EXCEPTION WHEN OTHERS THEN IF SQLSTATE <> '42501' THEN RAISE EXCEPTION 'FAIL ⑧: self wrong code %: expected 42501', SQLSTATE; END IF; END;
  BEGIN PERFORM public.owner_ban_user('44444444-4444-4444-8444-444444444444', 'مخالفة متكررة للقواعد', null); RAISE EXCEPTION 'FAIL ⑧: second owner ban not rejected';
    EXCEPTION WHEN OTHERS THEN IF SQLSTATE <> '42501' THEN RAISE EXCEPTION 'FAIL ⑧: second owner wrong code %: expected 42501', SQLSTATE; END IF; END;
  r := public.owner_ban_user('77777777-7777-4777-8777-777777777777', 'مخالفة متكررة للقواعد', null);
  IF (r ->> 'ban_status') <> 'permanent' OR (r ->> 'ban_until') IS NOT NULL THEN RAISE EXCEPTION 'FAIL ⑧: permanent ban result wrong: %', r; END IF;
  IF (SELECT ban_status FROM public.profiles WHERE id = '77777777-7777-4777-8777-777777777777') <> 'permanent' THEN RAISE EXCEPTION 'FAIL ⑧: profile ban_status not permanent'; END IF;
  SELECT count(*) INTO v_n FROM public.privileged_audit WHERE action = 'account.restriction' AND target_user_id = '77777777-7777-4777-8777-777777777777';
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL ⑧: expected exactly 1 account.restriction row, got %', v_n; END IF;
  r := public.owner_ban_user('77777777-7777-4777-8777-777777777777', 'مخالفة متكررة للقواعد', v_until);
  IF (r ->> 'ban_status') <> 'temporary' OR (r ->> 'ban_until') IS NULL THEN RAISE EXCEPTION 'FAIL ⑧: temporary ban result wrong: %', r; END IF;
  IF NOT public.is_banned('77777777-7777-4777-8777-777777777777') THEN RAISE EXCEPTION 'FAIL ⑧: is_banned must be true after temporary ban'; END IF;
  SELECT count(*) INTO v_n FROM public.privileged_audit WHERE action = 'account.restriction' AND target_user_id = '77777777-7777-4777-8777-777777777777';
  IF v_n <> 2 THEN RAISE EXCEPTION 'FAIL ⑧: expected 2 account.restriction rows after second ban, got %', v_n; END IF;
  -- رفع الحظر باستدعاء F3 نفسه (p_until = الآن تمامًا): يعيد 'none' بلا حتى ولا سبب.
  r := public.owner_ban_user('77777777-7777-4777-8777-777777777777', 'إلغاء الحظر', now());
  IF (r ->> 'ban_status') <> 'none' OR (r ->> 'ban_until') IS NOT NULL OR (r ->> 'ban_reason') IS NOT NULL THEN RAISE EXCEPTION 'FAIL ⑧: unban result wrong: %', r; END IF;
  IF (SELECT ban_status FROM public.profiles WHERE id = '77777777-7777-4777-8777-777777777777') <> 'none'
     OR (SELECT ban_until FROM public.profiles WHERE id = '77777777-7777-4777-8777-777777777777') IS NOT NULL
     OR (SELECT ban_reason FROM public.profiles WHERE id = '77777777-7777-4777-8777-777777777777') IS NOT NULL THEN RAISE EXCEPTION 'FAIL ⑧: profile not unbanned'; END IF;
  IF public.is_banned('77777777-7777-4777-8777-777777777777') THEN RAISE EXCEPTION 'FAIL ⑧: is_banned must be false after unban'; END IF;
  SELECT count(*) INTO v_n FROM public.privileged_audit WHERE action = 'account.restriction' AND target_user_id = '77777777-7777-4777-8777-777777777777';
  IF v_n <> 3 THEN RAISE EXCEPTION 'FAIL ⑧: expected 3 account.restriction rows after unban, got %', v_n; END IF;
  -- رفع حظر بتاريخ ماضٍ صريح بعد حظر مؤقت جديد — بلا شرط سبب أيضًا.
  r := public.owner_ban_user('77777777-7777-4777-8777-777777777777', 'مخالفة متكررة للقواعد', v_until);
  IF (r ->> 'ban_status') <> 'temporary' THEN RAISE EXCEPTION 'FAIL ⑧: re-ban result wrong: %', r; END IF;
  r := public.owner_ban_user('77777777-7777-4777-8777-777777777777', 'x', now() - interval '1 day');
  IF (r ->> 'ban_status') <> 'none' THEN RAISE EXCEPTION 'FAIL ⑧: past-until unban result wrong: %', r; END IF;
  IF public.is_banned('77777777-7777-4777-8777-777777777777') THEN RAISE EXCEPTION 'FAIL ⑧: is_banned must be false after past-until unban'; END IF;
  -- رفع حظر مستخدم غير محظور أصلًا: يعيد 'none' بلا سجل تدقيق جديد.
  SELECT count(*) INTO v_n FROM public.privileged_audit WHERE action = 'account.restriction' AND target_user_id = '55555555-5555-4555-8555-555555555555';
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL ⑧: unexpected audit rows for user1 before unban, got %', v_n; END IF;
  r := public.owner_ban_user('55555555-5555-4555-8555-555555555555', 'إلغاء الحظر', now());
  IF (r ->> 'ban_status') <> 'none' THEN RAISE EXCEPTION 'FAIL ⑧: unban of unbanned user wrong: %', r; END IF;
  SELECT count(*) INTO v_n FROM public.privileged_audit WHERE action = 'account.restriction' AND target_user_id = '55555555-5555-4555-8555-555555555555';
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL ⑧: unban of unbanned user must not add audit rows, got %', v_n; END IF;
  RAISE NOTICE 'PASS ⑧ الحظر: حراس + دائم/مؤقت + سطر تدقيق واحد لكل حظر + رفع حظر (الآن/ماضٍ) يعيد none';
END $$;

-- ⑨ owner_set_user_points: الحراس والنجاح والمحفظة والتدقيق.
DO $$
DECLARE r jsonb; v_n int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
  PERFORM set_config('test.is_owner', '1', true);
  PERFORM set_config('test.step_up', '1', true);
  BEGIN PERFORM public.owner_set_user_points('55555555-5555-4555-8555-555555555555', -5); RAISE EXCEPTION 'FAIL ⑨: negative points not rejected';
    EXCEPTION WHEN OTHERS THEN IF SQLSTATE <> '22023' THEN RAISE EXCEPTION 'FAIL ⑨: negative wrong code %: expected 22023', SQLSTATE; END IF; END;
  BEGIN PERFORM public.owner_set_user_points('55555555-5555-4555-8555-555555555555', null); RAISE EXCEPTION 'FAIL ⑨: null points not rejected';
    EXCEPTION WHEN OTHERS THEN IF SQLSTATE <> '22023' THEN RAISE EXCEPTION 'FAIL ⑨: null wrong code %: expected 22023', SQLSTATE; END IF; END;
  BEGIN PERFORM public.owner_set_user_points('55555555-5555-4555-8555-555555555599', 10); RAISE EXCEPTION 'FAIL ⑨: missing user not rejected';
    EXCEPTION WHEN OTHERS THEN IF SQLSTATE <> 'P0002' THEN RAISE EXCEPTION 'FAIL ⑨: missing user wrong code %: expected P0002', SQLSTATE; END IF; END;
  BEGIN PERFORM public.owner_set_user_points('11111111-1111-4111-8111-111111111111', 10); RAISE EXCEPTION 'FAIL ⑨: self points not rejected';
    EXCEPTION WHEN OTHERS THEN IF SQLSTATE <> '42501' THEN RAISE EXCEPTION 'FAIL ⑨: self wrong code %: expected 42501', SQLSTATE; END IF; END;
  r := public.owner_set_user_points('55555555-5555-4555-8555-555555555555', 200);
  IF (r ->> 'points') <> '200' OR (r ->> 'wallet_total_points') <> '200' OR (r ->> 'wallet_available_points') <> '200' THEN RAISE EXCEPTION 'FAIL ⑨: points result wrong: %', r; END IF;
  IF (SELECT points FROM public.profiles WHERE id = '55555555-5555-4555-8555-555555555555') <> 200 THEN RAISE EXCEPTION 'FAIL ⑨: profile points not updated'; END IF;
  IF (SELECT total_points FROM public.user_wallets WHERE user_id = '55555555-5555-4555-8555-555555555555') <> 200
     OR (SELECT available_points FROM public.user_wallets WHERE user_id = '55555555-5555-4555-8555-555555555555') <> 200 THEN RAISE EXCEPTION 'FAIL ⑨: wallet not updated'; END IF;
  SELECT count(*) INTO v_n FROM public.privileged_audit WHERE action = 'points.change' AND target_user_id = '55555555-5555-4555-8555-555555555555';
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL ⑨: expected 1 points.change row, got %', v_n; END IF;
  IF ((SELECT old_value FROM public.privileged_audit WHERE action = 'points.change' AND target_user_id = '55555555-5555-4555-8555-555555555555') ->> 'points') <> '120' THEN RAISE EXCEPTION 'FAIL ⑨: points.change old value wrong'; END IF;
  -- مستخدم بلا صف محفظة: نقاطه تُحدَّث، وقيم المحفظة في الرد NULL بلا إدخال صف.
  r := public.owner_set_user_points('66666666-6666-4666-8666-666666666666', 75);
  IF (r ->> 'points') <> '75' OR (r ->> 'wallet_total_points') IS NOT NULL OR (r ->> 'wallet_available_points') IS NOT NULL THEN RAISE EXCEPTION 'FAIL ⑨: no-wallet result wrong: %', r; END IF;
  IF (SELECT points FROM public.profiles WHERE id = '66666666-6666-4666-8666-666666666666') <> 75 THEN RAISE EXCEPTION 'FAIL ⑨: no-wallet profile points not updated'; END IF;
  IF EXISTS (SELECT 1 FROM public.user_wallets WHERE user_id = '66666666-6666-4666-8666-666666666666') THEN RAISE EXCEPTION 'FAIL ⑨: wallet row must not be inserted'; END IF;
  RAISE NOTICE 'PASS ⑨ النقاط: حراس + تحديث الملف والمحفظة + تدقيق points.change';
END $$;

-- ⑩ التراجع يسقط الدوال الثماني ويعيد بوابة manage_user_points إلى بريد 134.
\i migrations/_rollback/147_owner_no_redirect_rpcs.down.sql
DO $$
DECLARE r jsonb;
BEGIN
  IF to_regprocedure('public.owner_service_status()') IS NOT NULL
     OR to_regprocedure('public.owner_set_service_status(uuid,text)') IS NOT NULL
     OR to_regprocedure('public.owner_company_store_overview(uuid)') IS NOT NULL
     OR to_regprocedure('public.owner_list_mcp_servers()') IS NOT NULL
     OR to_regprocedure('public.owner_set_user_role(uuid,text)') IS NOT NULL
     OR to_regprocedure('public.owner_ban_user(uuid,text,timestamptz)') IS NOT NULL
     OR to_regprocedure('public.owner_set_user_points(uuid,int)') IS NOT NULL
     OR to_regprocedure('public._owner_company_has_feature(uuid,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL ⑩: rollback left a 147 function behind';
  END IF;
  -- بعد التراجع تعود manage_user_points إلى بوابة بريد 134: المالك بلا
  -- بريد support@ يُرفض — ولو بقي التوسيع لنجح التجميد هنا.
  PERFORM set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
  PERFORM set_config('test.is_owner', '1', true);
  PERFORM set_config('test.jwt_email', '', true);
  r := public.manage_user_points('user1@example.com', 0, 'freeze');
  IF (r ->> 'success') <> 'false' OR (r ->> 'error_code') <> 'UNAUTHORIZED' THEN RAISE EXCEPTION 'FAIL ⑩: rollback did not restore email-only gate: %', r; END IF;
  RAISE NOTICE 'PASS ⑩ التراجع يسقط الدوال الثماني ويعيد بوابة manage_user_points إلى بريد 134';
END $$;

-- ⑪ إعادة تطبيق 147 بعد التراجع تنجح.
\i migrations/147_owner_no_redirect_rpcs.sql
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
  PERFORM set_config('test.is_owner', '1', true);
  PERFORM set_config('test.step_up', '1', true);
  IF to_regprocedure('public.owner_service_status()') IS NULL
     OR to_regprocedure('public.owner_set_service_status(uuid,text)') IS NULL
     OR to_regprocedure('public.owner_company_store_overview(uuid)') IS NULL
     OR to_regprocedure('public.owner_list_mcp_servers()') IS NULL
     OR to_regprocedure('public.owner_set_user_role(uuid,text)') IS NULL
     OR to_regprocedure('public.owner_ban_user(uuid,text,timestamptz)') IS NULL
     OR to_regprocedure('public.owner_set_user_points(uuid,int)') IS NULL
     OR to_regprocedure('public._owner_company_has_feature(uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'FAIL ⑪: re-apply left a 147 function missing';
  END IF;
  r := public.owner_service_status();
  IF jsonb_array_length(r -> 'services') <> 3 THEN RAISE EXCEPTION 'FAIL ⑪: smoke after re-apply failed: %', r; END IF;
  RAISE NOTICE 'PASS ⑪ إعادة التطبيق بعد التراجع تنجح';
END $$;

-- ⑫ بوابة manage_user_points الموسَّعة (147): بلا بريد وبلا مالك →
-- UNAUTHORIZED؛ وsupport@ والمالك (بسياقه) يجمّدان ويفكّان ويضيفان.
DO $$
DECLARE r jsonb; v_n int;
BEGIN
  -- بلا بريد support@ وبلا قدرة مالك: مرفوض.
  PERFORM set_config('request.jwt.claim.sub', '66666666-6666-4666-8666-666666666666', true);
  PERFORM set_config('test.is_owner', '0', true);
  PERFORM set_config('test.jwt_email', '', true);
  r := public.manage_user_points('user1@example.com', 0, 'freeze');
  IF (r ->> 'success') <> 'false' OR (r ->> 'error_code') <> 'UNAUTHORIZED' THEN RAISE EXCEPTION 'FAIL ⑫: plain user must be UNAUTHORIZED: %', r; END IF;
  IF (SELECT is_frozen FROM public.user_wallets WHERE user_id = '55555555-5555-4555-8555-555555555555') THEN RAISE EXCEPTION 'FAIL ⑫: wallet must stay unfrozen after rejected call'; END IF;
  -- بريد support@ كما كان: تجميد ثم إلغاء تجميد.
  PERFORM set_config('test.jwt_email', 'support@mad3oom.online', true);
  r := public.manage_user_points('user1@example.com', 0, 'freeze');
  IF (r ->> 'success') <> 'true' OR (r ->> 'action_type') <> 'freeze' OR (r ->> 'new_balance') <> '200' THEN RAISE EXCEPTION 'FAIL ⑫: support freeze wrong: %', r; END IF;
  IF NOT (SELECT is_frozen FROM public.user_wallets WHERE user_id = '55555555-5555-4555-8555-555555555555') THEN RAISE EXCEPTION 'FAIL ⑫: wallet not frozen by support'; END IF;
  r := public.manage_user_points('user1@example.com', 0, 'unfreeze');
  IF (r ->> 'success') <> 'true' OR (r ->> 'action_type') <> 'unfreeze' THEN RAISE EXCEPTION 'FAIL ⑫: support unfreeze wrong: %', r; END IF;
  IF (SELECT is_frozen FROM public.user_wallets WHERE user_id = '55555555-5555-4555-8555-555555555555') THEN RAISE EXCEPTION 'FAIL ⑫: wallet still frozen after support unfreeze'; END IF;
  -- المالك في سياقه بلا بريد support@: تجميد ثم إلغاء تجميد ثم إضافة.
  PERFORM set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
  PERFORM set_config('test.is_owner', '1', true);
  PERFORM set_config('test.jwt_email', '', true);
  r := public.manage_user_points('user1@example.com', 0, 'freeze');
  IF (r ->> 'success') <> 'true' OR (r ->> 'action_type') <> 'freeze' THEN RAISE EXCEPTION 'FAIL ⑫: owner freeze wrong: %', r; END IF;
  IF NOT (SELECT is_frozen FROM public.user_wallets WHERE user_id = '55555555-5555-4555-8555-555555555555') THEN RAISE EXCEPTION 'FAIL ⑫: wallet not frozen by owner'; END IF;
  r := public.manage_user_points('user1@example.com', 0, 'unfreeze');
  IF (r ->> 'success') <> 'true' THEN RAISE EXCEPTION 'FAIL ⑫: owner unfreeze wrong: %', r; END IF;
  r := public.manage_user_points('user1@example.com', 10, 'add');
  IF (r ->> 'success') <> 'true' OR (r ->> 'new_balance') <> '210' THEN RAISE EXCEPTION 'FAIL ⑫: owner add wrong: %', r; END IF;
  IF (SELECT available_points FROM public.user_wallets WHERE user_id = '55555555-5555-4555-8555-555555555555') <> 210
     OR (SELECT total_points FROM public.user_wallets WHERE user_id = '55555555-5555-4555-8555-555555555555') <> 210 THEN RAISE EXCEPTION 'FAIL ⑫: wallet balances wrong after owner add'; END IF;
  SELECT count(*) INTO v_n FROM public.central_wallet_transactions WHERE target_user_id = '55555555-5555-4555-8555-555555555555';
  IF v_n <> 5 THEN RAISE EXCEPTION 'FAIL ⑫: expected 5 central_wallet_transactions rows, got %', v_n; END IF;
  RAISE NOTICE 'PASS ⑫ بوابة manage_user_points: غير مصرّح بلا بريد/مالك، وsupport@ والمالك يجمّدان ويفكّان ويضيفان';
END $$;

SELECT 'ALL 147 TESTS PROVEN' AS result;
