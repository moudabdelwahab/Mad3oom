-- ============================================================================
-- عُدّة اختبارات تعدد الشركات (095 وما بعده)
--
-- تُحمَّل بعد:
--   \i tests/fixtures/prod-shape/load.sql
--   \i tests/fixtures/prod-shape/chain-to-093.sql
--
-- تعطي: مخطط t بأدوات النداء بهوية مستخدم (t.call / t.err / t.errfull / t.rows)،
-- وفاعلين ثابتين في شركتين وطاقم منصة، وموظفين بأدوار 086.
--
--  OW مالك المنصة (يملك الشركة W)  · EA أدمن مرتفع · AD أدمن · SUP دعم · PU حساب فرد
--  OA مالك الشركة A (باقة support تشمل sub_users) · OB مالك الشركة B (نفس الباقة)
--  A1 A2 عملاء A · AS مشرف في A · AG موظف دعم في A · AX تابع A محظور
--  B1 عميل B · BS مشرف في B · DG حساب عادي (مفوَّض لاحقًا في H1)
-- ============================================================================
SET search_path = public, extensions;

DROP SCHEMA IF EXISTS t CASCADE;
CREATE SCHEMA t;
CREATE EXTENSION IF NOT EXISTS dblink SCHEMA t;
GRANT USAGE ON SCHEMA t TO authenticated, service_role, anon;

CREATE FUNCTION t.u(p text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  select (case p
    when 'OW' then '0e000000-0000-4000-8000-000000000001' when 'EA' then '0e000000-0000-4000-8000-000000000002'
    when 'AD' then '0e000000-0000-4000-8000-000000000003' when 'SUP' then '0e000000-0000-4000-8000-000000000004'
    when 'PU' then '0e000000-0000-4000-8000-000000000005' when 'DG' then '0e000000-0000-4000-8000-000000000006'
    when 'DH' then '0e000000-0000-4000-8000-000000000007'
    when 'OA' then '0a000000-0000-4000-8000-000000000001' when 'A1' then '0a000000-0000-4000-8000-000000000011'
    when 'A2' then '0a000000-0000-4000-8000-000000000012' when 'AS' then '0a000000-0000-4000-8000-000000000021'
    when 'AG' then '0a000000-0000-4000-8000-000000000022' when 'AX' then '0a000000-0000-4000-8000-000000000099'
    when 'OB' then '0b000000-0000-4000-8000-000000000001' when 'B1' then '0b000000-0000-4000-8000-000000000011'
    when 'BS' then '0b000000-0000-4000-8000-000000000021'
    when 'CA' then 'ca000000-0000-4000-8000-00000000000a' when 'CB' then 'cb000000-0000-4000-8000-00000000000b'
    when 'CW' then 'cf000000-0000-4000-8000-00000000000f'
    when 'NOPE' then '0d000000-0000-4000-8000-0000000000ee'
  end)::uuid $$;

-- هوية الطلب كما يضبطها PostgREST
CREATE FUNCTION t.act(p uuid) RETURNS void LANGUAGE sql AS $$
  select set_config('request.jwt.claim.sub', coalesce(p::text, ''), false),
         set_config('request.jwt.claim.role', case when p is null then '' else 'authenticated' end, false),
         set_config('request.jwt.claims', case when p is null then ''
                      else jsonb_build_object('sub', p, 'role', 'authenticated', 'session_id', 'sess-' || p)::text end, false); $$;

-- تعبير بهوية مستخدم ودور authenticated (RLS فعّالة)
CREATE FUNCTION t.call(p uuid, p_sql text) RETURNS jsonb LANGUAGE plpgsql AS $$
declare v jsonb;
begin
  perform t.act(p);
  execute 'set local role authenticated';
  execute 'select to_jsonb((' || p_sql || '))' into v;
  execute 'reset role';
  perform t.act(null);
  return v;
exception when others then
  perform t.act(null);
  raise;
end $$;
CREATE FUNCTION t.err(p uuid, p_sql text) RETURNS text LANGUAGE plpgsql AS $$
begin
  perform t.call(p, p_sql);
  return 'ok';
exception when others then
  return sqlstate;
end $$;
CREATE FUNCTION t.errfull(p uuid, p_sql text) RETURNS text LANGUAGE plpgsql AS $$
declare m text; d text;
begin
  perform t.call(p, p_sql);
  return 'ok';
exception when others then
  get stacked diagnostics m = message_text, d = pg_exception_detail;
  return sqlstate || '|' || m || '|' || coalesce(d, '');
end $$;
-- عدد الصفوف التي يراها المستخدم من استعلام (RLS فعّالة)
CREATE FUNCTION t.rows(p uuid, p_from_where text) RETURNS int LANGUAGE plpgsql AS $$
declare n int;
begin
  perform t.act(p);
  execute 'set local role authenticated';
  execute 'select count(*)::int from ' || p_from_where into n;
  execute 'reset role';
  perform t.act(null);
  return n;
exception when others then
  perform t.act(null);
  raise;
end $$;
-- جملة كتابة بهوية مستخدم: 'ok' أو SQLSTATE
CREATE FUNCTION t.exec(p uuid, p_sql text) RETURNS text LANGUAGE plpgsql AS $$
begin
  perform t.act(p);
  execute 'set local role authenticated';
  execute p_sql;
  execute 'reset role';
  perform t.act(null);
  return 'ok';
exception when others then
  perform t.act(null);
  return sqlstate;
end $$;
-- عدد الصفوف التي غيّرتها جملة كتابة بهوية مستخدم (RLS قد تجعلها 0 بلا خطأ)
CREATE FUNCTION t.affected(p uuid, p_sql text) RETURNS int LANGUAGE plpgsql AS $$
declare n int;
begin
  perform t.act(p);
  execute 'set local role authenticated';
  execute p_sql;
  get diagnostics n = row_count;
  execute 'reset role';
  perform t.act(null);
  return n;
exception when others then
  perform t.act(null);
  return -1;
end $$;
CREATE FUNCTION t.ok(p_cond boolean, p_label text) RETURNS void LANGUAGE plpgsql AS $$
begin
  if p_cond is distinct from true then raise exception 'FAIL %', p_label; end if;
end $$;
-- سياق مالك المنصة (040)
CREATE FUNCTION t.ctx(p_context text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
begin
  perform set_config('app.owner_context_write', 'on', true);
  if p_context is null then
    delete from public.owner_context_state where user_id = t.u('OW');
  else
    insert into public.owner_context_state (user_id, context, entered_at, expires_at)
    values (t.u('OW'), p_context, now(), now() + interval '12 hours')
    on conflict (user_id) do update set context = excluded.context, entered_at = excluded.entered_at,
                                        expires_at = excluded.expires_at;
  end if;
  perform set_config('app.owner_context_write', 'off', true);
end $$;
-- تحقق خطوتين حديث لمالك المنصة (053) — لاختبار ما يتطلب owner_critical_ok()
CREATE FUNCTION t.stepup(p_user uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
begin
  delete from public.privileged_step_ups where user_id = p_user;
  insert into public.privileged_step_ups (user_id, session_id, verified_at, expires_at)
  values (p_user, 'sess-' || p_user, now(), now() + interval '10 minutes');  -- نفس جلسة t.act
end $$;
CREATE TABLE t.saved (k text PRIMARY KEY, v text);
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;
GRANT ALL ON t.saved TO authenticated, service_role, anon;

-- ── الفاعلون ──────────────────────────────────────────────────────────────
INSERT INTO auth.users (id, email)
SELECT t.u(n), lower(n) || '@tenancy.test'
  FROM unnest(array['OW','EA','AD','SUP','PU','DG','DH','OA','A1','A2','AS','AG','AX','OB','B1','BS']) n;

INSERT INTO public.profiles (id, email, full_name, role, phone, created_at) VALUES
  (t.u('OW'),  'ow@tenancy.test',  'مالك المنصة', 'platform_owner', '01100000001', '2026-09-01'),
  (t.u('EA'),  'ea@tenancy.test',  'أدمن مرتفع',  'admin',          '01100000002', '2026-09-01'),
  (t.u('AD'),  'ad@tenancy.test',  'أدمن',        'admin',          '01100000003', '2026-09-01'),
  (t.u('SUP'), 'sup@tenancy.test', 'دعم',         'support',        '01100000004', '2026-09-01'),
  (t.u('PU'),  'pu@tenancy.test',  'حساب فرد',    'user',           '01100000005', '2026-09-01'),
  (t.u('DG'),  'dg@tenancy.test',  'مفوَّض',       'user',           '01100000006', '2026-09-01'),
  (t.u('DH'),  'dh@tenancy.test',  'مفوَّض ثانٍ',   'user',           '01100000007', '2026-09-01'),
  (t.u('OA'),  'oa@tenancy.test',  'مالك أ',      'user',           '01100000010', '2026-09-01'),
  (t.u('OB'),  'ob@tenancy.test',  'مالك ب',      'user',           '01100000020', '2026-09-01');
INSERT INTO public.platform_authority (user_id, level) VALUES (t.u('OW'), 'owner'), (t.u('EA'), 'elevated_admin');
INSERT INTO public.companies (id, user_id, company_name, commercial_registration_number, tax_id, company_email) VALUES
  (t.u('CA'), t.u('OA'), 'شركة أ', 'CR-A-095', 'TAX-A', 'a@company.test'),
  (t.u('CB'), t.u('OB'), 'شركة ب', 'CR-B-095', 'TAX-B', 'b@company.test'),
  (t.u('CW'), t.u('OW'), 'شركة المالك', 'CR-W-095', 'TAX-W', 'w@company.test');
INSERT INTO public.profiles (id, email, full_name, role, phone, super_user_id, created_at) VALUES
  (t.u('A1'), 'a1@tenancy.test', 'عميل أ1',  'user', '01100000011', t.u('OA'), '2026-09-01'),
  (t.u('A2'), 'a2@tenancy.test', 'عميل أ2',  'user', '01100000012', t.u('OA'), '2026-09-01'),
  (t.u('AS'), 'as@tenancy.test', 'مشرف أ',   'user', '01100000013', t.u('OA'), '2026-09-01'),
  (t.u('AG'), 'ag@tenancy.test', 'موظف أ',   'user', '01100000014', t.u('OA'), '2026-09-01'),
  (t.u('AX'), 'ax@tenancy.test', 'تابع محظور', 'user', '01100000019', t.u('OA'), '2026-09-01'),
  (t.u('B1'), 'b1@tenancy.test', 'عميل ب1',  'user', '01100000021', t.u('OB'), '2026-09-01'),
  (t.u('BS'), 'bs@tenancy.test', 'مشرف ب',   'user', '01100000022', t.u('OB'), '2026-09-01');
UPDATE public.profiles SET ban_status = 'banned' WHERE id = t.u('AX');
INSERT INTO public.whatsapp_subscriptions (user_id, plan, status, billing_cycle, start_date, end_date, duration_days, company_id) VALUES
  (t.u('OA'), 'support', 'active', 'monthly', now() - interval '5 days', now() + interval '25 days', 30, t.u('CA')),
  (t.u('OB'), 'support', 'active', 'monthly', now() - interval '5 days', now() + interval '25 days', 30, t.u('CB')),
  (t.u('OW'), 'support', 'active', 'monthly', now() - interval '5 days', now() + interval '25 days', 30, t.u('CW'));

-- الموظفون بالمسار الرسمي (086)، بهوية مالك الشركة
DO $$
BEGIN
  PERFORM t.call(t.u('OA'), format('public.company_staff_set(%L::uuid, %L)', t.u('AS'), 'supervisor'));
  PERFORM t.call(t.u('OA'), format('public.company_staff_set(%L::uuid, %L)', t.u('AG'), 'agent'));
  PERFORM t.call(t.u('OB'), format('public.company_staff_set(%L::uuid, %L)', t.u('BS'), 'supervisor'));
  PERFORM t.ok(t.call(t.u('AS'), 'public.company_staff_role()') #>> '{}' = 'supervisor', 'HARNESS AS supervisor');
  PERFORM t.ok(t.call(t.u('AG'), 'public.company_staff_role()') #>> '{}' = 'agent', 'HARNESS AG agent');
  PERFORM t.ok(t.call(t.u('A1'), 'public.company_staff_role()') IS NULL, 'HARNESS A1 customer');
  PERFORM t.ok(t.call(t.u('OA'), 'public.company_staff_role()') #>> '{}' = 'admin', 'HARNESS OA admin');
END $$;
