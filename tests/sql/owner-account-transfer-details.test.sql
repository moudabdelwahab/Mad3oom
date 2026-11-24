-- ============================================================================
-- اختبار تنفيذي لـ migrations/129_owner_account_transfer_details.sql.
--
-- يثبّت الخصائص التي طُلبت صراحةً، كل واحدة تفشل إن انكسرت:
--
--   ① غير المالك يُرفض بـ 42501 في الدوال الثلاث
--   ② النقل: سبب قصير 22023، بلا مفتاح 22023، بلا عضوية أساسية P0002،
--      وجهة يملكها العميل P0002، مالك/موظف المصدر 55000، العزل مطفأ 0A000
--   ③ النقل الناجح: مكتمل + إعادة بنفس المفتاح replayed + طلب معلّق سابق
--      يُلغى + حدثان في hierarchy_events + سطر في privileged_audit +
--      استدعاء _transfer_execute مرة واحدة
--   ④ التفاصيل الكاملة: كل الاشتراكات والعضويات (ومنها المنتهية) والمدير
--      والمحفظة وأحدث قيود usage_ledger والتذاكر بعدّاداتها وسجل التدقيق
--      المدمج من مصادره الأربعة؛ وحساب غير موجود P0002
--   ⑤ التعديل: الاسم والجوال فقط، سبب قصير 22023، جوال بحروف 22023،
--      اسم قصير 22023، عدم التغيير يعيد changed=false بلا سجل، الحساب
--      الحسّاس بلا تحقق 42501 ومعه ينجح، والتوقيع بلا معامل بريد أو رتبة
--   ⑥ التراجع يسقط الدوال الثلاث والدالة الداخلية
--
-- النمط منسوخ من owner-account-tree.test.sql: دور authenticated حقيقي +
-- ادعاء JWT عبر request.jwt.claim.sub، لأن postgres يتجاوز RLS.
-- المتعاونون يُبذَرون بنسخ دنيا تحاكي توقيعاتها الحية: _transfer_execute
-- يسجّل استدعاءه ويعيد «مكتمل» (تنفيذه الذري الحقيقي مغطى في
-- customer-transfers-carry.test.sql PASS ③ بما فيه الاستثنائي)، و
-- _company_customer_active و _reason_check بنسختين أمينتين، و
-- log_privileged و _hierarchy_event يكتبان في جدولي السجل المزروعين.
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
-- owner_capability / owner_critical_ok: مالكٌ من يضبط test.is_owner=1،
-- وتحقق بخطوتين سارٍ من يضبط test.step_up=1 أيضًا (اختبار فقط).
CREATE OR REPLACE FUNCTION public.owner_capability(p_cap text) RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT current_setting('test.is_owner', true) = '1'; $$;
CREATE OR REPLACE FUNCTION public.owner_critical_ok() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT current_setting('test.is_owner', true) = '1' AND current_setting('test.step_up', true) = '1'; $$;
CREATE OR REPLACE FUNCTION public._feature_on(p_key text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN current_setting('test.isolation_off', true) = '1'
                   AND p_key IN ('company_isolation_enforced', 'company_permissions_enabled')
              THEN false ELSE true END;
$$;
CREATE OR REPLACE FUNCTION public.is_banned(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT coalesce((select banned from public.profiles where id = p_user), false); $$;
CREATE OR REPLACE FUNCTION public._profile_name(p_user uuid) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT case when p_user is null then null
              else coalesce((select coalesce(nullif(btrim(p.full_name), ''), p.email)
                              from public.profiles p where p.id = p_user), 'حساب محذوف') end;
$$;
-- _reason_check أمينة: ≥10 أحرف، مقصوصة عند 500 (099).
CREATE OR REPLACE FUNCTION public._reason_check(p_reason text) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
begin
  if char_length(btrim(coalesce(p_reason, ''))) < 10 then
    raise exception 'السبب مطلوب (10 أحرف على الأقل)' using errcode = '22023';
  end if;
  return left(btrim(p_reason), 500);
end $$;
-- _company_customer_active أمينة: عضوية نشطة + ليس مالك الشركة ولا موظفها (096).
CREATE OR REPLACE FUNCTION public._company_customer_active(p_company uuid, p_user uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT p_company IS NOT NULL AND p_user IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.company_memberships m
                  WHERE m.company_id = p_company AND m.user_id = p_user AND m.status = 'active')
     AND NOT EXISTS (SELECT 1 FROM public.companies c WHERE c.id = p_company AND c.user_id = p_user)
     AND NOT EXISTS (SELECT 1 FROM public.company_staff s
                      WHERE s.company_id = p_company AND s.user_id = p_user AND s.revoked_at IS NULL);
$$;
-- _transfer_execute دنيا: يسجّل استدعاءه ويعيد «مكتمل»؛ التنفيذ الذري الحقيقي
-- مغطى في customer-transfers-carry.test.sql.
CREATE TABLE IF NOT EXISTS public._test_transfer_calls (transfer_id uuid primary key, called_at timestamptz default now());
CREATE OR REPLACE FUNCTION public._transfer_execute(p_transfer uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
begin
  insert into public._test_transfer_calls (transfer_id) values (p_transfer)
  on conflict (transfer_id) do nothing;
  update public.customer_transfers set status = 'completed', completed_at = now(),
         outcome = jsonb_build_object('kept_source_secondary', false) where id = p_transfer;
  return jsonb_build_object('transfer_id', p_transfer, 'status', 'completed', 'kept_source_secondary', false);
end $$;
-- log_privileged و _hierarchy_event دنيا: تكتبان في جدولي السجل المزروعين.
CREATE OR REPLACE FUNCTION public.log_privileged(p_action text, p_target uuid, p_old jsonb, p_new jsonb) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $$
  INSERT INTO public.privileged_audit (actor_id, action, target_user_id, old_value, new_value)
  VALUES (auth.uid(), p_action, p_target, p_old, p_new);
$$;
CREATE OR REPLACE FUNCTION public._hierarchy_event(p_action text, p_unit uuid, p_company uuid, p_user uuid,
                                                   p_detail jsonb default '{}'::jsonb) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $$
  INSERT INTO public.hierarchy_events (actor_id, action, unit_id, company_id, user_id, detail)
  VALUES (auth.uid(), p_action, p_unit, p_company, p_user, coalesce(p_detail, '{}'::jsonb));
$$;

-- بذور الجداول (الأعمدة التي يقرؤها الترحيل وحدها).
CREATE TABLE public.profiles (
  id uuid primary key, full_name text, email text, phone text, whatsapp_phone text,
  whatsapp_enabled boolean default false, is_verified boolean default false, role text,
  points integer, banned boolean not null default false, ban_until timestamptz,
  created_at timestamptz default now(), updated_at timestamptz default now());
CREATE TABLE public.companies (
  id uuid primary key, company_name text, status text, user_id uuid, created_at timestamptz default now());
CREATE TABLE public.company_memberships (
  user_id uuid, company_id uuid, is_primary boolean default false, status text default 'active',
  joined_at timestamptz default now(), joined_via text, ended_at timestamptz, end_cause text,
  primary key (user_id, company_id));
CREATE TABLE public.company_staff (
  user_id uuid, company_id uuid, revoked_at timestamptz, primary key (user_id, company_id));
CREATE TABLE public.platform_direct_customers (
  user_id uuid primary key, since timestamptz default now(), source text, ended_at timestamptz);
CREATE TABLE public.customer_account_managers (
  id uuid primary key default gen_random_uuid(), customer_id uuid, manager_id uuid,
  scope text, assigned_by uuid, assigned_at timestamptz default now(), reason text,
  ended_at timestamptz, end_cause text);
CREATE TABLE public.whatsapp_subscriptions (
  id uuid primary key default gen_random_uuid(), user_id uuid, company_id uuid, plan text, status text,
  billing_cycle text, start_date timestamptz, end_date timestamptz, created_at timestamptz default now());
CREATE TABLE public.subscription_plans (key text primary key, name text, name_ar text);
CREATE TABLE public.user_wallets (
  user_id uuid primary key, total_points integer, available_points integer, is_frozen boolean default false);
CREATE TABLE public.usage_ledger (
  id bigint generated always as identity primary key, recorded_at timestamptz default now(),
  period date, event text, counter text, units integer, account_id uuid,
  ticket_id uuid, ticket_user_id uuid, company_id uuid, source text);
CREATE TABLE public.tickets (
  id uuid primary key, ticket_number integer, title text, user_id uuid, company_id uuid,
  status text, created_at timestamptz default now());
CREATE TABLE public.customer_transfers (
  id uuid primary key default gen_random_uuid(), customer_id uuid not null,
  from_company uuid not null, to_company uuid not null, initiated_by uuid not null,
  initiated_as text not null, idempotency_key uuid not null, status text not null default 'pending',
  keep_source_secondary boolean not null default false, customer_confirmed_at timestamptz,
  owner_reason text, created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '14 days',
  completed_at timestamptz, outcome jsonb,
  unique (initiated_by, idempotency_key));
CREATE TABLE public.hierarchy_events (
  id bigint generated always as identity primary key, at timestamptz default now(),
  actor_id uuid, action text, unit_id uuid, company_id uuid, user_id uuid, detail jsonb default '{}'::jsonb);
CREATE TABLE public.privileged_audit (
  id bigint generated always as identity primary key, at timestamptz default now(),
  actor_id uuid, action text, target_user_id uuid, old_value jsonb, new_value jsonb);
CREATE TABLE public.company_membership_events (
  id bigint generated always as identity primary key, company_id uuid, user_id uuid,
  actor_id uuid, action text, detail jsonb default '{}'::jsonb, created_at timestamptz default now());
CREATE TABLE public.subscription_audit_log (
  id bigserial primary key, subscription_id uuid, target_user_id uuid, actor_user_id uuid,
  actor_email text, action text, old_values jsonb, new_values jsonb, reason text,
  created_at timestamptz default now());
CREATE TABLE public.account_requests (
  id uuid primary key default gen_random_uuid(), request_type text, customer_id uuid,
  company_id uuid, status text, requested_at timestamptz default now());

\i migrations/129_owner_account_transfer_details.sql

-- بذور: مالك + عميل بعضوية أساسية في cA + عميل مباشر بلا عضوية + مالك شركة cA
-- (عضوية أساسية فيها أيضًا) + إداري + شركتان + اشتراكان + محفظة + قيود + تذاكر + سجلات.
DO $$
DECLARE
  v_owner uuid := '11111111-1111-4111-8111-111111111111';
  v_cust uuid := '55555555-5555-4555-8555-555555555555';
  v_direct uuid := '66666666-6666-4666-8666-666666666666';
  v_cowner uuid := '33333333-3333-4333-8333-333333333333';
  v_admin uuid := '22222222-2222-4222-8222-222222222222';
  v_cust2 uuid := '77777777-7777-4777-8777-777777777777';
  v_ca uuid := 'c0000000-0000-4000-8000-000000000001';
  v_cb uuid := 'c0000000-0000-4000-8000-000000000002';
  v_cc uuid := 'c0000000-0000-4000-8000-000000000003';
BEGIN
  insert into public.profiles values
    (v_owner, 'مالك المنصة', 'owner@mad3oom.com', null, null, false, false, 'platform_owner', 0, false, null),
    (v_cust, 'عميل الشركة', 'cust@example.com', '01000000002', null, false, false, 'user', 120, false, null),
    (v_direct, 'عميل مباشر', 'direct@example.com', '01000000003', null, false, false, 'user', 50, false, null),
    (v_cowner, 'مالك الشركة', 'cowner@example.com', '01000000001', null, false, false, 'company_admin', 10, false, null),
    (v_admin, 'إداري الوحدة', 'admin@mad3oom.com', null, null, false, false, 'admin', 0, false, null),
    (v_cust2, 'عميل يملك شركة', 'cust2@example.com', '01000000004', null, false, false, 'user', 0, false, null);
  insert into public.companies values
    (v_ca, 'شركة المصدر', 'active', v_cowner),
    (v_cb, 'شركة الوجهة', 'active', v_admin),
    (v_cc, 'شركة العميل الثاني', 'active', v_cust2);
  insert into public.company_memberships values
    (v_cust, v_ca, true, 'active', now() - interval '30 days', 'invite', null, null),
    (v_cowner, v_ca, true, 'active', now() - interval '30 days', 'invite', null, null),
    (v_cust2, v_ca, true, 'active', now() - interval '30 days', 'invite', null, null),
    (v_cust, v_cb, false, 'ended', now() - interval '60 days', 'invite', now() - interval '40 days', 'left');
  insert into public.platform_direct_customers values (v_direct, now(), 'signup', null);
  insert into public.customer_account_managers
    (customer_id, manager_id, scope, assigned_by, reason) values (v_cust, v_admin, 'platform', v_owner, 'متابعة الحساب');
  insert into public.subscription_plans values ('whatsapp', 'WhatsApp', 'واتساب بيزنس');
  insert into public.whatsapp_subscriptions (user_id, plan, status, billing_cycle, start_date, end_date)
    values (v_cust, 'whatsapp', 'active', 'monthly', now() - interval '10 days', now() + interval '20 days'),
           (v_cust, 'whatsapp', 'expired', 'monthly', now() - interval '40 days', now() - interval '10 days');
  insert into public.user_wallets values (v_cust, 120, 100, false);
  insert into public.usage_ledger (period, event, counter, units, account_id, ticket_id, ticket_user_id, company_id, source)
    values ('2026-11-01', 'ticket_created', 'used', 1, v_cust, 'd0000000-0000-4000-8000-000000000001', v_cust, v_ca, 'trigger'),
           ('2026-11-01', 'billing_linked', 'billing', 1, v_cust, 'd0000000-0000-4000-8000-000000000001', v_cust, v_ca, 'trigger');
  insert into public.tickets values
    ('d0000000-0000-4000-8000-000000000001', 42, 'مشكلة', v_cust, v_ca, 'open'),
    ('d0000000-0000-4000-8000-000000000002', 43, 'سؤال', v_cust, v_ca, 'in-progress'),
    ('d0000000-0000-4000-8000-000000000003', 44, 'قديمة', v_cust, v_ca, 'resolved');
  insert into public.company_membership_events (company_id, user_id, actor_id, action)
    values (v_ca, v_cust, v_owner, 'joined');
  insert into public.privileged_audit (actor_id, action, target_user_id)
    values (v_owner, 'customer.transfer.exceptional', v_cust);
  insert into public.hierarchy_events (actor_id, action, company_id, user_id)
    values (v_owner, 'company.assigned', v_ca, null),
           (v_owner, 'customer.transferred', v_ca, v_cust);
  insert into public.subscription_audit_log (target_user_id, actor_user_id, actor_email, action)
    values (v_cust, v_owner, 'owner@mad3oom.com', 'renewed');
  insert into public.account_requests (request_type, customer_id, company_id, status)
    values ('join', v_cust, v_cb, 'pending');
  -- طلب نقل معلّق سابق للعميل: نقل المالك الناجح يلغيه.
  insert into public.customer_transfers (customer_id, from_company, to_company, initiated_by, initiated_as, idempotency_key, status)
    values (v_cust, v_ca, v_cb, v_cust, 'customer', 'e0000000-0000-4000-8000-000000000001', 'pending');
END $$;

-- ① غير المالك يُرفض بـ 42501 في الدوال الثلاث.
DO $$
DECLARE v_err text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '55555555-5555-4555-8555-555555555555', true);
  PERFORM set_config('test.is_owner', '0', true);
  PERFORM set_config('test.step_up', '0', true);
  BEGIN
    PERFORM public.owner_account_transfer('55555555-5555-4555-8555-555555555555'::uuid,
      'c0000000-0000-4000-8000-000000000002'::uuid, 'سبب نقل طويل بما يكفي للتحقق', false, gen_random_uuid());
    RAISE EXCEPTION 'FAIL ①: non-owner transfer was not rejected';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF SQLSTATE <> '42501' THEN RAISE EXCEPTION 'FAIL ①: transfer wrong code % (%): expected 42501', SQLSTATE, v_err; END IF;
  END;
  BEGIN
    PERFORM public.owner_account_details('55555555-5555-4555-8555-555555555555'::uuid);
    RAISE EXCEPTION 'FAIL ①: non-owner details was not rejected';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> '42501' THEN RAISE EXCEPTION 'FAIL ①: details wrong code %: expected 42501', SQLSTATE; END IF;
  END;
  BEGIN
    PERFORM public.owner_update_account_profile('55555555-5555-4555-8555-555555555555'::uuid,
      'اسم جديد', null, 'سبب تعديل طويل بما يكفي');
    RAISE EXCEPTION 'FAIL ①: non-owner edit was not rejected';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> '42501' THEN RAISE EXCEPTION 'FAIL ①: edit wrong code %: expected 42501', SQLSTATE; END IF;
  END;
  RAISE NOTICE 'PASS ① غير المالك يُرفض بـ 42501 في الدوال الثلاث';
END $$;

-- ② حراس النقل: سبب قصير، بلا مفتاح، بلا عضوية أساسية، وجهة مملوكة، مالك المصدر، عزل مطفأ.
DO $$
DECLARE v_err text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
  PERFORM set_config('test.is_owner', '1', true);
  PERFORM set_config('test.step_up', '1', true);
  BEGIN
    PERFORM public.owner_account_transfer('55555555-5555-4555-8555-555555555555'::uuid,
      'c0000000-0000-4000-8000-000000000002'::uuid, 'قصير', false, gen_random_uuid());
    RAISE EXCEPTION 'FAIL ②: short reason was not rejected';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> '22023' THEN RAISE EXCEPTION 'FAIL ②: reason wrong code %: expected 22023', SQLSTATE; END IF;
  END;
  BEGIN
    PERFORM public.owner_account_transfer('55555555-5555-4555-8555-555555555555'::uuid,
      'c0000000-0000-4000-8000-000000000002'::uuid, 'سبب نقل طويل بما يكفي للتحقق', false, null);
    RAISE EXCEPTION 'FAIL ②: null key was not rejected';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> '22023' THEN RAISE EXCEPTION 'FAIL ②: key wrong code %: expected 22023', SQLSTATE; END IF;
  END;
  BEGIN
    PERFORM public.owner_account_transfer('66666666-6666-4666-8666-666666666666'::uuid,
      'c0000000-0000-4000-8000-000000000002'::uuid, 'سبب نقل طويل بما يكفي للتحقق', false, gen_random_uuid());
    RAISE EXCEPTION 'FAIL ②: direct-only customer was transferred';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> 'P0002' THEN RAISE EXCEPTION 'FAIL ②: no-primary wrong code %: expected P0002', SQLSTATE; END IF;
  END;
  BEGIN
    -- الوجهة cC يملكها العميل الثاني نفسه (وعضويته الأساسية في cA) → P0002 عبر فحص الملكية لا عبر تساوي الشركتين.
    PERFORM public.owner_account_transfer('77777777-7777-4777-8777-777777777777'::uuid,
      'c0000000-0000-4000-8000-000000000003'::uuid, 'سبب نقل طويل بما يكفي للتحقق', false, gen_random_uuid());
    RAISE EXCEPTION 'FAIL ②: owned destination was not rejected';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> 'P0002' THEN RAISE EXCEPTION 'FAIL ②: owned-dest wrong code %: expected P0002', SQLSTATE; END IF;
  END;
  BEGIN
    -- مالك المصدر: عضوية أساسية في cA لكنه مالكها → 55000 (يُفحص قبل الوجهة cB الصالحة).
    PERFORM public.owner_account_transfer('33333333-3333-4333-8333-333333333333'::uuid,
      'c0000000-0000-4000-8000-000000000002'::uuid, 'سبب نقل طويل بما يكفي للتحقق', false, gen_random_uuid());
    RAISE EXCEPTION 'FAIL ②: company owner was transferred as customer';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> '55000' THEN RAISE EXCEPTION 'FAIL ②: owner-as-customer wrong code %: expected 55000', SQLSTATE; END IF;
  END;
  PERFORM set_config('test.isolation_off', '1', true);
  BEGIN
    PERFORM public.owner_account_transfer('55555555-5555-4555-8555-555555555555'::uuid,
      'c0000000-0000-4000-8000-000000000002'::uuid, 'سبب نقل طويل بما يكفي للتحقق', false, gen_random_uuid());
    RAISE EXCEPTION 'FAIL ②: transfer with isolation off was not rejected';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> '0A000' THEN RAISE EXCEPTION 'FAIL ②: isolation wrong code %: expected 0A000', SQLSTATE; END IF;
  END;
  PERFORM set_config('test.isolation_off', '0', true);
  RAISE NOTICE 'PASS ② حراس النقل: السبب والمفتاح والعضوية والوجهة والمالك والعزل';
END $$;

-- ③ النقل الناجح: مكتمل + إعادة + إلغاء المعلق + سجلان + استدعاء واحد.
DO $$
DECLARE
  k uuid := 'e0000000-0000-4000-8000-000000000002';
  r jsonb;
  v_hier int; v_priv int; v_calls int; v_cancelled int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
  PERFORM set_config('test.is_owner', '1', true);
  PERFORM set_config('test.step_up', '1', true);
  r := public.owner_account_transfer('55555555-5555-4555-8555-555555555555'::uuid,
    'c0000000-0000-4000-8000-000000000002'::uuid, 'تصحيح ربط خاطئ بطلب موثَّق من العميل', false, k);
  IF (r ->> 'status') <> 'completed' THEN RAISE EXCEPTION 'FAIL ③: transfer not completed: %', r; END IF;
  IF (r ->> 'owner_transfer')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'FAIL ③: owner_transfer flag missing'; END IF;
  r := public.owner_account_transfer('55555555-5555-4555-8555-555555555555'::uuid,
    'c0000000-0000-4000-8000-000000000002'::uuid, 'تصحيح ربط خاطئ بطلب موثَّق من العميل', false, k);
  IF (r ->> 'replayed')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'FAIL ③: replay not detected: %', r; END IF;
  SELECT count(*) INTO v_cancelled FROM public.customer_transfers
   WHERE idempotency_key = 'e0000000-0000-4000-8000-000000000001' AND status = 'cancelled';
  IF v_cancelled <> 1 THEN RAISE EXCEPTION 'FAIL ③: pending transfer was not cancelled'; END IF;
  SELECT count(*) INTO v_hier FROM public.hierarchy_events
   WHERE user_id = '55555555-5555-4555-8555-555555555555'::uuid AND action IN ('customer.transferred', 'customer.transferred_in');
  IF v_hier <> 2 THEN RAISE EXCEPTION 'FAIL ③: expected 2 hierarchy events, got %', v_hier; END IF;
  SELECT count(*) INTO v_priv FROM public.privileged_audit
   WHERE target_user_id = '55555555-5555-4555-8555-555555555555'::uuid AND action = 'customer.transfer.owner';
  IF v_priv <> 1 THEN RAISE EXCEPTION 'FAIL ③: privileged audit row missing'; END IF;
  SELECT count(*) INTO v_calls FROM public._test_transfer_calls;
  IF v_calls <> 1 THEN RAISE EXCEPTION 'FAIL ③: _transfer_execute called % times, expected 1 (replay must not re-execute)', v_calls; END IF;
  RAISE NOTICE 'PASS ③ النقل الناجح: مكتمل + إعادة + إلغاء المعلق + سجلان + استدعاء واحد';
END $$;

-- ④ التفاصيل الكاملة للمالك.
DO $$
DECLARE
  t jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
  PERFORM set_config('test.is_owner', '1', true);
  t := public.owner_account_details('55555555-5555-4555-8555-555555555555'::uuid);
  IF (t -> 'profile' ->> 'email') <> 'cust@example.com' THEN RAISE EXCEPTION 'FAIL ④: profile email'; END IF;
  IF (t ->> 'account_type') <> 'company_customer' THEN RAISE EXCEPTION 'FAIL ④: account_type %', t ->> 'account_type'; END IF;
  IF jsonb_array_length(t -> 'subscriptions') <> 2 THEN RAISE EXCEPTION 'FAIL ④: expected 2 subscriptions, got %', jsonb_array_length(t -> 'subscriptions'); END IF;
  IF jsonb_array_length(t -> 'memberships') <> 2 THEN RAISE EXCEPTION 'FAIL ④: expected 2 memberships (incl. ended)'; END IF;
  IF (t -> 'manager' ->> 'name') <> 'إداري الوحدة' THEN RAISE EXCEPTION 'FAIL ④: manager name'; END IF;
  IF (t -> 'wallet' ->> 'available_points')::int <> 100 THEN RAISE EXCEPTION 'FAIL ④: wallet'; END IF;
  IF jsonb_array_length(t -> 'usage') <> 2 THEN RAISE EXCEPTION 'FAIL ④: usage ledger rows'; END IF;
  IF (t -> 'tickets' -> 'counts' ->> 'open')::int <> 1 OR (t -> 'tickets' ->> 'open')::int <> 2 THEN
    RAISE EXCEPTION 'FAIL ④: ticket counts: %', t -> 'tickets';
  END IF;
  IF jsonb_array_length(t -> 'tickets' -> 'latest') <> 3 THEN RAISE EXCEPTION 'FAIL ④: latest tickets'; END IF;
  IF jsonb_array_length(t -> 'audit') < 4 THEN RAISE EXCEPTION 'FAIL ④: audit must merge 4 sources, got %', jsonb_array_length(t -> 'audit'); END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(t -> 'audit') e WHERE e ->> 'source' = 'privileged') THEN
    RAISE EXCEPTION 'FAIL ④: privileged audit source missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(t -> 'audit') e WHERE e ->> 'source' = 'subscription') THEN
    RAISE EXCEPTION 'FAIL ④: subscription audit source missing';
  END IF;
  BEGIN
    PERFORM public.owner_account_details('99999999-9999-4999-8999-999999999999'::uuid);
    RAISE EXCEPTION 'FAIL ④: unknown user was not rejected';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> 'P0002' THEN RAISE EXCEPTION 'FAIL ④: unknown user wrong code %: expected P0002', SQLSTATE; END IF;
  END;
  RAISE NOTICE 'PASS ④ التفاصيل الكاملة: اشتراكات وعضويات ومدير ومحفظة وقيود وتذاكر وسجل مدمج';
END $$;

-- ⑤ التعديل: نجاح + عدم تغيير + حراس + حساب حسّاس + التوقيع بلا بريد/رتبة.
DO $$
DECLARE
  r jsonb; v_name text; v_priv int; v_hier int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
  PERFORM set_config('test.is_owner', '1', true);
  PERFORM set_config('test.step_up', '0', true);
  -- عميل عادي: بلا تحقق بخطوتين.
  r := public.owner_update_account_profile('55555555-5555-4555-8555-555555555555'::uuid,
    'عميل محدَّث', '01000000009', 'تصحيح بيانات التواصل بطلب العميل');
  IF (r ->> 'changed')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'FAIL ⑤: edit not applied: %', r; END IF;
  SELECT full_name INTO v_name FROM public.profiles WHERE id = '55555555-5555-4555-8555-555555555555'::uuid;
  IF v_name <> 'عميل محدَّث' THEN RAISE EXCEPTION 'FAIL ⑤: profiles.full_name not updated'; END IF;
  SELECT count(*) INTO v_priv FROM public.privileged_audit
   WHERE target_user_id = '55555555-5555-4555-8555-555555555555'::uuid AND action = 'profile.update.owner';
  SELECT count(*) INTO v_hier FROM public.hierarchy_events
   WHERE user_id = '55555555-5555-4555-8555-555555555555'::uuid AND action = 'account.profile_updated';
  IF v_priv <> 1 OR v_hier <> 1 THEN RAISE EXCEPTION 'FAIL ⑤: audit rows missing (priv %, hier %)', v_priv, v_hier; END IF;
  -- عدم تغيير: القيم نفسها تعيد changed=false بلا سجل جديد.
  r := public.owner_update_account_profile('55555555-5555-4555-8555-555555555555'::uuid,
    'عميل محدَّث', '01000000009', 'تصحيح بيانات التواصل بطلب العميل');
  IF (r ->> 'changed')::boolean IS NOT FALSE THEN RAISE EXCEPTION 'FAIL ⑤: noop must return changed=false'; END IF;
  SELECT count(*) INTO v_priv FROM public.privileged_audit
   WHERE target_user_id = '55555555-5555-4555-8555-555555555555'::uuid AND action = 'profile.update.owner';
  IF v_priv <> 1 THEN RAISE EXCEPTION 'FAIL ⑤: noop wrote an audit row'; END IF;
  -- حراس المدخلات.
  BEGIN
    PERFORM public.owner_update_account_profile('55555555-5555-4555-8555-555555555555'::uuid,
      'اسم آخر', null, 'قصير');
    RAISE EXCEPTION 'FAIL ⑤: short reason was not rejected';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> '22023' THEN RAISE EXCEPTION 'FAIL ⑤: reason wrong code %: expected 22023', SQLSTATE; END IF;
  END;
  BEGIN
    PERFORM public.owner_update_account_profile('55555555-5555-4555-8555-555555555555'::uuid,
      null, 'abc-123', 'تصحيح بيانات التواصل بطلب العميل');
    RAISE EXCEPTION 'FAIL ⑤: bad phone was not rejected';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> '22023' THEN RAISE EXCEPTION 'FAIL ⑤: phone wrong code %: expected 22023', SQLSTATE; END IF;
  END;
  BEGIN
    PERFORM public.owner_update_account_profile('55555555-5555-4555-8555-555555555555'::uuid,
      'س', null, 'تصحيح بيانات التواصل بطلب العميل');
    RAISE EXCEPTION 'FAIL ⑤: short name was not rejected';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> '22023' THEN RAISE EXCEPTION 'FAIL ⑤: name wrong code %: expected 22023', SQLSTATE; END IF;
  END;
  -- حساب حسّاس (إداري) بلا تحقق: 42501؛ ومع التحقق: ينجح.
  BEGIN
    PERFORM public.owner_update_account_profile('22222222-2222-4222-8222-222222222222'::uuid,
      'إداري محدَّث', null, 'تصحيح بيانات التواصل بطلب الإدارة');
    RAISE EXCEPTION 'FAIL ⑤: sensitive account edited without step-up';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> '42501' THEN RAISE EXCEPTION 'FAIL ⑤: sensitive wrong code %: expected 42501', SQLSTATE; END IF;
  END;
  PERFORM set_config('test.step_up', '1', true);
  r := public.owner_update_account_profile('22222222-2222-4222-8222-222222222222'::uuid,
    'إداري محدَّث', null, 'تصحيح بيانات التواصل بطلب الإدارة');
  IF (r ->> 'changed')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'FAIL ⑤: sensitive edit with step-up failed'; END IF;
  -- التوقيع بلا معامل بريد أو رتبة: البريد والرتبة خارج التعديل عمدًا.
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'owner_update_account_profile'
                AND (p.proargnames @> ARRAY['p_email'] OR p.proargnames @> ARRAY['p_role'])) THEN
    RAISE EXCEPTION 'FAIL ⑤: edit signature must not accept email or role';
  END IF;
  RAISE NOTICE 'PASS ⑤ التعديل: نجاح وعدم تغيير وحراس وحساب حسّاس وتوقيع بلا بريد/رتبة';
END $$;

-- ⑥ التراجع يسقط الدوال الثلاث والدالة الداخلية.
\i migrations/_rollback/129_owner_account_transfer_details.down.sql
DO $$
BEGIN
  IF to_regprocedure('public.owner_account_transfer(uuid,uuid,text,boolean,uuid)') IS NOT NULL
     OR to_regprocedure('public.owner_account_details(uuid)') IS NOT NULL
     OR to_regprocedure('public.owner_update_account_profile(uuid,text,text,text)') IS NOT NULL
     OR to_regprocedure('public._owner_transfer_safety_ok()') IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL ⑥: rollback left a 129 function behind';
  END IF;
  RAISE NOTICE 'PASS ⑥ التراجع يسقط الدوال الأربع';
END $$;

SELECT 'ALL 129 TESTS PROVEN' AS result;
