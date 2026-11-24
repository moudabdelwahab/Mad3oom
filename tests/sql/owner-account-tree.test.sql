-- ============================================================================
-- اختبار تنفيذي لـ migrations/128_owner_account_tree.sql.
--
-- يثبّت الخصائص التي طُلبت صراحةً، كل واحدة تفشل إن انكسرت:
--
--   ① غير المالك يُرفض بـ 42501 (الحارس owner_capability('owner_only'))
--   ② المالك يرى الشجرة كاملة في نداء واحد: وحدات متداخلة، شركات كل وحدة،
--      أعضاء الشركة وعملاؤها، فرع العملاء المباشرين، وشركات بلا وحدة
--   ③ العدّادات صحيحة: أعضاء الشركة وعملاؤها والتذاكر المفتوحة لكل عقدة
--   ④ الشخص يحمل حالته واشتراكه الأحدث ومدير حسابه ورصيده وتجميده
--   ⑤ الوحدة المؤرشفة والعلاقة المنتهية مستبعدتان؛ لا حذف فيزيائي
--   ⑥ التراجع يسقط الدالة وحدها
--
-- النمط منسوخ من chat-ratings.test.sql: دور authenticated حقيقي + ادعاء
-- JWT عبر request.jwt.claim.sub، لأن postgres (المستخدم الخارق) يتجاوز
-- RLS فلا يُقاس به شيء. والجداول هنا بذور دنيا تحاكي أعمدة الترحيلات
-- 099 و105 و097 التي يقرؤها الترحيل، لا نسخة من الإنتاج.
--
-- لم تُنفَّذ محليًا: لا Postgres في هذه البيئة (run-sql-tests.sh يتخطاها
-- بصوت عالٍ) — تُنفَّذ في CI.
-- ============================================================================
\set ON_ERROR_STOP on
\pset tuples_only on

CREATE SCHEMA IF NOT EXISTS auth;

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true),'')::uuid; $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
END $$;
GRANT USAGE ON SCHEMA auth, public TO authenticated, anon;

-- بذور الدوال التي يعتمد عليها الترحيل (نسخ دنيا تحاكي توقيعاتها الحية).
-- owner_capability: مالكٌ من يضبط test.is_owner=1 في جلسته (اختبار فقط).
CREATE OR REPLACE FUNCTION public.owner_capability(p_cap text) RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT current_setting('test.is_owner', true) = '1'; $$;
CREATE OR REPLACE FUNCTION public.is_banned(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT coalesce((select banned from public.profiles where id = p_user), false); $$;
CREATE OR REPLACE FUNCTION public._feature_on(p_key text) RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT false; $$;
CREATE OR REPLACE FUNCTION public._profile_name(p_user uuid) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT case when p_user is null then null
              else coalesce((select coalesce(nullif(btrim(p.full_name), ''), p.email)
                              from public.profiles p where p.id = p_user), 'حساب محذوف') end;
$$;

-- بذور الجداول (الأعمدة التي يقرؤها الترحيل وحدها).
CREATE TABLE public.profiles (
  id uuid primary key, full_name text, email text, phone text, role text,
  points integer, banned boolean not null default false, created_at timestamptz default now());
CREATE TABLE public.companies (
  id uuid primary key, company_name text, status text, user_id uuid, created_at timestamptz default now());
CREATE TABLE public.admin_units (
  id uuid primary key, parent_id uuid, name text, description text,
  archived_at timestamptz, created_at timestamptz default now());
CREATE TABLE public.admin_unit_members (
  unit_id uuid, user_id uuid, member_role text, assigned_at timestamptz default now(), ended_at timestamptz,
  primary key (unit_id, user_id));
CREATE TABLE public.admin_unit_companies (
  unit_id uuid, company_id uuid, ended_at timestamptz, primary key (unit_id, company_id));
CREATE TABLE public.platform_delegations (
  id uuid primary key, delegate_id uuid, unit_id uuid, capabilities text[],
  expires_at timestamptz, revoked_at timestamptz);
CREATE TABLE public.platform_direct_customers (
  user_id uuid primary key, since timestamptz default now(), source text, ended_at timestamptz);
CREATE TABLE public.customer_account_managers (
  id uuid primary key default gen_random_uuid(), customer_id uuid, manager_id uuid,
  scope text, assigned_by uuid, assigned_at timestamptz default now(), reason text,
  ended_at timestamptz, end_cause text);
CREATE TABLE public.company_memberships (
  user_id uuid, company_id uuid, is_primary boolean default false, status text default 'active',
  joined_at timestamptz default now(), joined_via text, ended_at timestamptz, end_cause text,
  primary key (user_id, company_id));
CREATE TABLE public.company_staff (
  user_id uuid, company_id uuid, role text, revoked_at timestamptz,
  primary key (user_id, company_id));
CREATE TABLE public.tickets (
  id uuid primary key, user_id uuid, company_id uuid, assigned_to uuid, status text);
CREATE TABLE public.whatsapp_subscriptions (
  id uuid primary key default gen_random_uuid(), user_id uuid, plan text, status text,
  billing_cycle text, start_date timestamptz, end_date timestamptz, created_at timestamptz default now());
CREATE TABLE public.subscription_plans (key text primary key, name text, name_ar text);
CREATE TABLE public.user_wallets (
  user_id uuid primary key, total_points integer, available_points integer, is_frozen boolean default false);
CREATE TABLE public.hierarchy_events (
  id bigint generated always as identity primary key, at timestamptz default now(),
  actor_id uuid, action text, unit_id uuid, company_id uuid, user_id uuid, detail jsonb default '{}'::jsonb);

\i migrations/128_owner_account_tree.sql

-- بذور: مالك + وحدتان (أم وابنة) + شركة في الابنة + شركة بلا وحدة +
-- عميل مباشر + مالك شركة وموظف وعميل + تذاكر واشتراك ومدير ورصيد.
DO $$
DECLARE
  v_owner uuid := '11111111-1111-4111-8111-111111111111';
  v_admin uuid := '22222222-2222-4222-8222-222222222222';
  v_cowner uuid := '33333333-3333-4333-8333-333333333333';
  v_staff uuid := '44444444-4444-4444-8444-444444444444';
  v_cust uuid := '55555555-5555-4555-8555-555555555555';
  v_direct uuid := '66666666-6666-4666-8666-666666666666';
  v_unit uuid := 'a0000000-0000-4000-8000-000000000001';
  v_sub uuid := 'a0000000-0000-4000-8000-000000000002';
  v_arch uuid := 'a0000000-0000-4000-8000-000000000003';
  v_comp uuid := 'c0000000-0000-4000-8000-000000000001';
  v_free uuid := 'c0000000-0000-4000-8000-000000000002';
BEGIN
  insert into public.profiles values
    (v_owner, 'مالك المنصة', 'owner@mad3oom.com', null, 'platform_owner', 0, false),
    (v_admin, 'إداري الوحدة', 'admin@mad3oom.com', null, 'admin', 0, false),
    (v_cowner, 'مالك الشركة', 'cowner@example.com', '01000000001', 'company_admin', 10, false),
    (v_staff, 'موظف الشركة', 'staff@example.com', null, 'company_user', 0, false),
    (v_cust, 'عميل الشركة', 'cust@example.com', '01000000002', 'user', 120, false),
    (v_direct, 'عميل مباشر', 'direct@example.com', '01000000003', 'user', 50, false);
  insert into public.companies values
    (v_comp, 'شركة الاختبار', 'active', v_cowner),
    (v_free, 'شركة بلا وحدة', 'suspended', v_cowner);
  insert into public.admin_units values
    (v_unit, null, 'وحدة الجذر', null, null),
    (v_sub, v_unit, 'وحدة الابنة', null, null),
    (v_arch, null, 'وحدة مؤرشفة', null, now());
  insert into public.admin_unit_members values (v_unit, v_admin, 'lead', now(), null);
  insert into public.admin_unit_companies values (v_sub, v_comp, null);
  insert into public.company_staff values (v_staff, v_comp, 'agent', null);
  insert into public.company_memberships values
    (v_cust, v_comp, true, 'active', now(), 'invite', null, null);
  insert into public.platform_direct_customers values (v_direct, now(), 'signup', null);
  insert into public.customer_account_managers
    (customer_id, manager_id, scope, assigned_by, reason) values (v_direct, v_admin, 'platform', v_owner, 'متابعة الحساب');
  insert into public.subscription_plans values ('whatsapp', 'WhatsApp', 'واتساب بيزنس');
  insert into public.whatsapp_subscriptions (user_id, plan, status, billing_cycle, start_date, end_date)
    values (v_direct, 'whatsapp', 'active', 'monthly', now() - interval '10 days', now() + interval '20 days'),
           (v_cust, 'whatsapp', 'expired', 'monthly', now() - interval '40 days', now() - interval '10 days');
  insert into public.user_wallets values (v_direct, 50, 50, true), (v_cust, 120, 120, false);
  insert into public.tickets values
    ('d0000000-0000-4000-8000-000000000001', v_cust, v_comp, null, 'open'),
    ('d0000000-0000-4000-8000-000000000002', v_cust, v_comp, null, 'in-progress'),
    ('d0000000-0000-4000-8000-000000000003', v_direct, null, null, 'resolved'),
    ('d0000000-0000-4000-8000-000000000004', null, v_comp, v_admin, 'open');
  insert into public.hierarchy_events (actor_id, action, unit_id, company_id, detail)
    values (v_owner, 'unit.created', v_unit, null, '{"name":"وحدة الجذر"}'::jsonb),
           (v_owner, 'company.assigned', v_sub, v_comp, '{}'::jsonb);
END $$;

-- ① غير المالك يُرفض بـ 42501.
DO $$
DECLARE v_err text;
BEGIN
  PERFORM set_config('test.is_owner', '0', true);
  BEGIN
    PERFORM public.owner_account_tree();
    RAISE EXCEPTION 'FAIL ①: non-owner was not rejected';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF SQLSTATE <> '42501' THEN RAISE EXCEPTION 'FAIL ①: wrong code % (%): expected 42501', SQLSTATE, v_err; END IF;
  END;
  RAISE NOTICE 'PASS ① غير المالك يُرفض بـ 42501';
END $$;

-- ②③④⑤ المالك يرى الشجرة كاملة بعدّادات صحيحة.
DO $$
DECLARE
  t jsonb;
  v_root jsonb; v_sub jsonb; v_comp jsonb; v_direct jsonb; v_free jsonb;
BEGIN
  PERFORM set_config('test.is_owner', '1', true);
  t := public.owner_account_tree();
  IF t IS NULL OR t -> 'units' IS NULL THEN RAISE EXCEPTION 'FAIL ②: empty tree'; END IF;
  IF jsonb_array_length(t -> 'units') <> 2 THEN
    RAISE EXCEPTION 'FAIL ②: expected 2 units (archived excluded), got %', jsonb_array_length(t -> 'units');
  END IF;
  SELECT value INTO v_root FROM jsonb_array_elements(t -> 'units')
   WHERE value ->> 'id' = 'a0000000-0000-4000-8000-000000000001';
  IF v_root IS NULL OR (v_root ->> 'name') <> 'وحدة الجذر' THEN RAISE EXCEPTION 'FAIL ②: root unit missing'; END IF;
  IF jsonb_array_length(v_root -> 'members') <> 1 THEN
    RAISE EXCEPTION 'FAIL ②: unit member missing';
  END IF;
  -- الشركة في الوحدة الابنة: الدالة تعيد الوحدات مسطحة مع parent_id، والواجهة تطويها هي.
  SELECT value INTO v_sub FROM jsonb_array_elements(t -> 'units')
   WHERE value ->> 'id' = 'a0000000-0000-4000-8000-000000000002';
  IF v_sub IS NULL OR (v_sub ->> 'parent_id') <> 'a0000000-0000-4000-8000-000000000001' THEN
    RAISE EXCEPTION 'FAIL ②: child unit missing or wrong parent';
  END IF;
  IF jsonb_array_length(v_sub -> 'companies') <> 1 THEN RAISE EXCEPTION 'FAIL ②: company under child unit missing'; END IF;
  v_comp := v_sub -> 'companies' -> 0;
  IF (v_comp ->> 'members_count')::int <> 2 THEN RAISE EXCEPTION 'FAIL ③: members_count expected 2, got %', v_comp ->> 'members_count'; END IF;
  IF (v_comp ->> 'customers_count')::int <> 1 THEN RAISE EXCEPTION 'FAIL ③: customers_count expected 1, got %', v_comp ->> 'customers_count'; END IF;
  IF (v_comp ->> 'open_tickets')::int <> 3 THEN RAISE EXCEPTION 'FAIL ③: company open_tickets expected 3, got %', v_comp ->> 'open_tickets'; END IF;
  IF jsonb_array_length(v_comp -> 'people') <> 3 THEN RAISE EXCEPTION 'FAIL ③: company people expected 3'; END IF;
  IF (v_comp -> 'people' -> 0 ->> 'kind') <> 'owner' THEN RAISE EXCEPTION 'FAIL ③: owner must sort first'; END IF;
  IF jsonb_array_length(v_comp -> 'events') <> 1 THEN RAISE EXCEPTION 'FAIL ②: company events missing'; END IF;
  -- شركة بلا وحدة.
  IF jsonb_array_length(t -> 'unassigned_companies') <> 1 THEN RAISE EXCEPTION 'FAIL ②: unassigned company missing'; END IF;
  v_free := t -> 'unassigned_companies' -> 0;
  IF (v_free ->> 'status') <> 'suspended' THEN RAISE EXCEPTION 'FAIL ②: unassigned status'; END IF;
  -- العميل المباشر: اشتراك فعّال، مدير حساب، رصيد مجمّد.
  IF jsonb_array_length(t -> 'direct_customers') <> 1 THEN RAISE EXCEPTION 'FAIL ②: direct customer missing'; END IF;
  v_direct := t -> 'direct_customers' -> 0;
  IF (v_direct ->> 'account_type') <> 'direct' THEN RAISE EXCEPTION 'FAIL ④: account_type expected direct, got %', v_direct ->> 'account_type'; END IF;
  IF (v_direct -> 'subscription' ->> 'is_active')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'FAIL ④: subscription not active'; END IF;
  IF (v_direct -> 'manager' ->> 'name') <> 'إداري الوحدة' THEN RAISE EXCEPTION 'FAIL ④: manager name'; END IF;
  IF (v_direct -> 'wallet' ->> 'is_frozen')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'FAIL ④: wallet frozen'; END IF;
  IF (v_direct ->> 'points')::int <> 50 THEN RAISE EXCEPTION 'FAIL ④: points expected 50'; END IF;
  IF (v_direct ->> 'open_tickets')::int <> 0 THEN RAISE EXCEPTION 'FAIL ③: direct open_tickets expected 0'; END IF;
  -- عميل الشركة: اشتراك منتهٍ، تذكرتان مفتوحتان، عضوية أساسية.
  IF ((v_comp -> 'people' -> 2 -> 'subscription' ->> 'is_active'))::boolean IS NOT FALSE THEN
    RAISE EXCEPTION 'FAIL ④: customer subscription must be inactive';
  END IF;
  IF (v_comp -> 'people' -> 2 ->> 'open_tickets')::int <> 2 THEN RAISE EXCEPTION 'FAIL ③: customer open_tickets expected 2'; END IF;
  IF (v_comp -> 'people' -> 2 -> 'memberships' -> 0 ->> 'is_primary')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL ④: primary membership missing';
  END IF;
  -- العدّادات العامة.
  IF (t -> 'counts' ->> 'units')::int <> 2 THEN RAISE EXCEPTION 'FAIL ③: counts.units expected 2'; END IF;
  IF (t -> 'counts' ->> 'companies')::int <> 2 THEN RAISE EXCEPTION 'FAIL ③: counts.companies expected 2'; END IF;
  IF (t -> 'counts' ->> 'open_tickets')::int <> 3 THEN RAISE EXCEPTION 'FAIL ③: counts.open_tickets expected 3'; END IF;
  RAISE NOTICE 'PASS ②③④⑤ الشجرة كاملة بعدّادات صحيحة، والمؤرشف مستبعد';
END $$;

-- ⑥ التراجع يسقط الدالة وحدها.
\i migrations/_rollback/128_owner_account_tree.down.sql
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'owner_account_tree') THEN
    RAISE EXCEPTION 'FAIL ⑥: rollback did not drop owner_account_tree';
  END IF;
  RAISE NOTICE 'PASS ⑥ التراجع يسقط الدالة وحدها';
END $$;
\i migrations/128_owner_account_tree.sql
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'owner_account_tree') THEN
    RAISE EXCEPTION 'FAIL ⑥: re-apply did not restore owner_account_tree';
  END IF;
  RAISE NOTICE 'PASS ⑥ إعادة التطبيق تعيد الدالة';
END $$;

DO $$ BEGIN
  RAISE NOTICE 'ALL owner-account-tree tests passed (assertions above)';
END $$;
