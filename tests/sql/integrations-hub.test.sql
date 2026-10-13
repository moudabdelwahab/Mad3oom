-- ============================================================================
-- مركز التكاملات (087_integrations_hub) على نسخة مطابقة لشكل الإنتاج
--
--   ⓪ قبل 087: بصمات ما لا يجوز أن يتغيّر (ومنها دوال integration_* القائمة في الإنتاج)
--   ① 087: الكائنات والصلاحيات، والمزوّدون مقفلون
--   ② النظرة العامة: للمدير فقط، لا للعميل ولا للموظف ولا لطاقم المنصة ولا للمعاينة
--   ③ تجهيز الربط: المزوّد المقفل، الاستحقاق، الأدوار، العزل بين الشركات
--   ④ دوال الخادم: ممنوعة على authenticated، الحساب الخارجي لا يُربط بشركتين، صحة الربط
--   ⑤ OAuth state: مرة واحدة، انتهاء الصلاحية، سلة فقط
--   ⑥ الأحداث: غير المربوط يُتجاهل، التكرار، خارج الترتيب، الفشل والإعادة والموت، الحجز
--   ⑦ سياق التذكرة: من يرى ومن لا يرى، R4 بالمحفّز، min_view_role
--   ⑧ ربط العملاء: صريح فقط، عبر الشركات مرفوض
--   ⑨ طلبات ووردبريس: الحدود، التحويل لعميل الشركة فقط، الرفض
--   ⑩ الفصل: حذف الأسرار والنسخ، الربط المفصول لا يعود، التدقيق إلحاقي
--   ⑪ الاحتفاظ
--   ⑫ عدم المساس، إعادة التشغيل، التراجع، إعادة التطبيق
-- ============================================================================
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

\i tests/fixtures/prod-shape/load.sql
SET search_path = public, extensions;

DROP SCHEMA IF EXISTS t CASCADE;
CREATE SCHEMA t;
CREATE EXTENSION IF NOT EXISTS dblink SCHEMA t;
GRANT USAGE ON SCHEMA t TO authenticated, service_role, anon;

-- ── أدوات ─────────────────────────────────────────────────────────────────
CREATE FUNCTION t.act(p uuid) RETURNS void LANGUAGE sql AS $$
  select set_config('request.jwt.claim.sub', coalesce(p::text, ''), false),
         set_config('request.jwt.claim.role', case when p is null then '' else 'authenticated' end, false),
         set_config('request.jwt.claims', case when p is null then ''
                      else jsonb_build_object('sub', p, 'role', 'authenticated')::text end, false); $$;
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
CREATE FUNCTION t.errd(p uuid, p_sql text) RETURNS text LANGUAGE plpgsql AS $$
declare d text;
begin
  perform t.call(p, p_sql);
  return 'ok';
exception when others then
  get stacked diagnostics d = pg_exception_detail;
  return sqlstate || '|' || coalesce(d, '');
end $$;
-- نداء بدور service_role (الدوال الطرفية)
CREATE FUNCTION t.svc(p_sql text) RETURNS jsonb LANGUAGE plpgsql AS $$
declare v jsonb;
begin
  perform t.act(null);
  execute 'set local role service_role';
  execute 'select to_jsonb((' || p_sql || '))' into v;
  execute 'reset role';
  return v;
exception when others then
  execute 'reset role';
  raise;
end $$;
CREATE FUNCTION t.svc_err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
declare d text;
begin
  perform t.svc(p_sql);
  return 'ok';
exception when others then
  get stacked diagnostics d = pg_exception_detail;
  return sqlstate || '|' || coalesce(d, '');
end $$;
CREATE FUNCTION t.err_anon(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
begin
  perform t.act(null);
  execute 'set local role anon';
  execute p_sql;
  execute 'reset role';
  return 'ok';
exception when others then
  return sqlstate;
end $$;
CREATE FUNCTION t.err_super(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate;
end $$;
CREATE FUNCTION t.ok(p_cond boolean, p_label text) RETURNS void LANGUAGE plpgsql AS $$
begin
  if p_cond is distinct from true then raise exception 'FAIL %', p_label; end if;
end $$;
CREATE FUNCTION t.u(p text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  select (case p
    when 'OA'  then '00000000-0000-4000-8000-000000000101' when 'OB'  then '00000000-0000-4000-8000-000000000102'
    when 'OC'  then '00000000-0000-4000-8000-000000000103' when 'OW'  then '00000000-0000-4000-8000-0000000001f0'
    when 'A1'  then '00000000-0000-4000-8000-000000000111' when 'A2'  then '00000000-0000-4000-8000-000000000112'
    when 'A3'  then '00000000-0000-4000-8000-000000000113' when 'A4'  then '00000000-0000-4000-8000-000000000114'
    when 'B1'  then '00000000-0000-4000-8000-000000000121' when 'PU'  then '00000000-0000-4000-8000-000000000131'
    when 'SUP' then '00000000-0000-4000-8000-000000000141' when 'AD'  then '00000000-0000-4000-8000-000000000142'
    when 'CA'  then 'c0000000-0000-4000-8000-00000000000a' when 'CB'  then 'c0000000-0000-4000-8000-00000000000b'
    when 'CC'  then 'c0000000-0000-4000-8000-00000000000c' when 'CW'  then 'c0000000-0000-4000-8000-00000000000f'
    when 'TA1' then 'a1000000-0000-4000-8000-000000000001' when 'TA2' then 'a1000000-0000-4000-8000-000000000002'
    when 'TB1' then 'b1000000-0000-4000-8000-000000000001' when 'TOA' then 'a0000000-0000-4000-8000-000000000001'
    when 'NOPE' then '00000000-0000-4000-8000-0000000001ee'
  end)::uuid $$;
CREATE FUNCTION t.ctx(p_context text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
begin
  perform set_config('app.owner_context_write', 'on', true);
  insert into public.owner_context_state (user_id, context, entered_at, expires_at)
  values (t.u('OW'), p_context, now(), now() + interval '12 hours')
  on conflict (user_id) do update set context = excluded.context, entered_at = excluded.entered_at,
                                      expires_at = excluded.expires_at;
  perform set_config('app.owner_context_write', 'off', true);
end $$;
-- بصمات ما لا يجوز أن يغيّره 087
SET check_function_bodies = off;
CREATE FUNCTION t.untouched_digest() RETURNS text LANGUAGE sql AS $$
  select md5(concat_ws('#',
    (select string_agg(md5(x::text), ',' order by x.id) from public.companies x),
    (select string_agg(md5(x::text), ',' order by x.id) from public.ticket_replies x),
    (select string_agg(md5(x::text), ',' order by x.id) from public.company_staff x),
    (select string_agg(md5(x::text), ',' order by x.id) from public.external_integrations x),
    (select string_agg(md5(x::text), ',' order by x.id) from public.integration_clients x))) $$;
CREATE FUNCTION t.fn_digest() RETURNS text LANGUAGE sql AS $$
  select md5(string_agg(pg_get_functiondef(p.oid) || '|' ||
                        has_function_privilege('authenticated', p.oid, 'EXECUTE')::text || '|' ||
                        has_function_privilege('service_role', p.oid, 'EXECUTE')::text || '|' ||
                        has_function_privilege('anon', p.oid, 'EXECUTE')::text, '#' order by p.oid::regprocedure::text))
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and (p.proname like 'integration\_%' or p.proname like 'company\_staff\_%'
          or p.proname in ('ticket_in_my_scope', 'current_company_id', 'company_has_feature',
                           'is_company_admin', 'is_company_member', 'set_external_integration_models_updated_at')) $$;
CREATE FUNCTION t.policy_digest() RETURNS text LANGUAGE sql AS $$
  select md5(string_agg(concat_ws('|', tablename, policyname, permissive, cmd, qual, with_check), '#'
                        order by tablename, policyname))
    from pg_policies where schemaname in ('public', 'storage') and tablename not like 'ihub\_%' $$;
CREATE TABLE t.saved (k text PRIMARY KEY, v text);
CREATE FUNCTION t.conn(p_company text, p_provider text) RETURNS uuid LANGUAGE sql AS $$
  select id from public.ihub_connections
   where company_id = t.u(p_company) and provider = p_provider and status <> 'disconnected' $$;
CREATE FUNCTION t.ev_status(p_id bigint) RETURNS text LANGUAGE sql AS $$
  select status || ':' || attempts from public.ihub_webhook_events where id = p_id $$;
RESET check_function_bodies;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;

-- ── الفاعلون ──────────────────────────────────────────────────────────────
--  OA مالك أ (باقة support + integrations_hub) · OB مالك ب (نفسها) · OC مالك ج (whatsapp: بلا تكاملات)
--  OW مالك المنصة ويملك شركة W · A1..A3 عملاء أ (A2 يصير موظف دعم، A3 مشرفًا) · A4 محظور · B1 عميل ب
--  PU مستخدم عادي · SUP دعم المنصة · AD أدمن المنصة
INSERT INTO auth.users (id, email)
SELECT t.u(n), lower(n) || '@t.io'
  FROM unnest(array['OA','OB','OC','OW','A1','A2','A3','A4','B1','PU','SUP','AD']) n;
INSERT INTO public.profiles (id, email, full_name, role, phone, created_at) VALUES
  (t.u('OA'),  'oa@t.io',  'مالك أ',      'user',           '01000000101', '2026-09-01'),
  (t.u('OB'),  'ob@t.io',  'مالك ب',      'user',           '01000000102', '2026-09-01'),
  (t.u('OC'),  'oc@t.io',  'مالك ج',      'user',           '01000000103', '2026-09-01'),
  (t.u('OW'),  'ow@t.io',  'مالك المنصة', 'platform_owner', '01000000104', '2026-09-01'),
  (t.u('PU'),  'pu@t.io',  'مستخدم',      'user',           '01000000131', '2026-09-01'),
  (t.u('SUP'), 'sup@t.io', 'دعم',         'support',        '01000000141', '2026-09-01'),
  (t.u('AD'),  'ad@t.io',  'أدمن',        'admin',          '01000000142', '2026-09-01');
INSERT INTO public.platform_authority (user_id, level) VALUES (t.u('OW'), 'owner');
INSERT INTO public.companies (id, user_id, company_name, commercial_registration_number) VALUES
  (t.u('CA'), t.u('OA'), 'شركة أ', 'CR-A'), (t.u('CB'), t.u('OB'), 'شركة ب', 'CR-B'),
  (t.u('CC'), t.u('OC'), 'شركة ج', 'CR-C'), (t.u('CW'), t.u('OW'), 'شركة المالك', 'CR-W');
INSERT INTO public.profiles (id, email, full_name, role, phone, super_user_id, created_at) VALUES
  (t.u('A1'), 'a1@t.io', 'عميل أ1', 'user', '01000000111', t.u('OA'), '2026-09-01'),
  (t.u('A2'), 'a2@t.io', 'موظف أ2', 'user', '01000000112', t.u('OA'), '2026-09-01'),
  (t.u('A3'), 'a3@t.io', 'مشرف أ3', 'user', '01000000113', t.u('OA'), '2026-09-01'),
  (t.u('A4'), 'a4@t.io', 'محظور أ4', 'user', '01000000114', t.u('OA'), '2026-09-01'),
  (t.u('B1'), 'b1@t.io', 'عميل ب1', 'user', '01000000121', t.u('OB'), '2026-09-01');
UPDATE public.profiles SET ban_status = 'banned' WHERE id = t.u('A4');
INSERT INTO public.whatsapp_subscriptions (user_id, plan, status, billing_cycle, start_date, end_date, duration_days, company_id) VALUES
  (t.u('OA'), 'support',  'active', 'monthly', now() - interval '5 days', now() + interval '25 days', 30, t.u('CA')),
  (t.u('OB'), 'support',  'active', 'monthly', now() - interval '5 days', now() + interval '25 days', 30, t.u('CB')),
  (t.u('OC'), 'whatsapp', 'active', 'monthly', now() - interval '5 days', now() + interval '25 days', 30, t.u('CC')),
  (t.u('OW'), 'support',  'active', 'monthly', now() - interval '5 days', now() + interval '25 days', 30, t.u('CW'));
INSERT INTO public.tickets (id, user_id, title, description) VALUES
  (t.u('TA1'), t.u('A1'), 'طلب لم يصل', 'وصف'),
  (t.u('TA2'), t.u('A1'), 'استفسار', 'وصف'),
  (t.u('TB1'), t.u('B1'), 'تذكرة ب', 'وصف'),
  (t.u('TOA'), t.u('OA'), 'تذكرة الشركة مع مدعوم', 'وصف');

\i migrations/086_company_staff.sql

-- ══ ⓪ قبل 087 ════════════════════════════════════════════════════════════
DO $$
BEGIN
  PERFORM t.ok((SELECT role FROM public.profiles WHERE id = t.u('OA')) = 'company_admin', 'SETUP OA company_admin');
  PERFORM t.call(t.u('OA'), format('public.company_staff_set(%L::uuid, %L)', t.u('A2'), 'agent'));
  PERFORM t.call(t.u('OA'), format('public.company_staff_set(%L::uuid, %L)', t.u('A3'), 'supervisor'));
  PERFORM t.ok(t.call(t.u('A2'), 'public.company_staff_role()') #>> '{}' = 'agent', 'SETUP A2 agent');
  PERFORM t.ok(t.call(t.u('A3'), 'public.company_staff_role()') #>> '{}' = 'supervisor', 'SETUP A3 supervisor');
  PERFORM t.ok(t.call(t.u('OA'), format('public.ticket_in_my_scope(%L::uuid)', t.u('TA1')))::boolean, 'SETUP OA يرى تذكرة عميله');
  PERFORM t.ok(NOT t.call(t.u('A2'), format('public.ticket_in_my_scope(%L::uuid)', t.u('TA1')))::boolean,
               'SETUP موظف الفريق لا يرى تذاكر العملاء اليوم (حدّ قائم)');
  PERFORM t.ok(EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'integration_api_key_create'),
               'SETUP دوال integration_* الإنتاجية موجودة في النسخة');
  RAISE NOTICE 'PASS ⓪ الإعداد: ثلاث شركات + شركة لمالك المنصة + عملاء وموظفون + تذاكر';
END $$;
INSERT INTO t.saved VALUES ('untouched', t.untouched_digest()), ('fn', t.fn_digest()), ('pol', t.policy_digest()),
  ('tickets', (SELECT md5(string_agg(md5(x::text), ',' order by x.id)) FROM public.tickets x));

-- ══ ① 087 ════════════════════════════════════════════════════════════════
\i migrations/087_integrations_hub.sql

DO $$
BEGIN
  PERFORM t.ok((SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'ihub\_%') = 11, '① 11 جدولًا');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.ihub_providers WHERE enabled), '① كل المزوّدين مقفلون');
  PERFORM t.ok((SELECT count(*) FROM public.ihub_providers) = 4, '① أربعة مزوّدين');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.ihub_providers p, jsonb_each_text(p.capabilities) c
                            WHERE c.value = 'implemented_verified'), '① لا قدرة موثّقة قبل التحقق الفعلي');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.plan_features WHERE feature_key = 'integrations_hub'),
               '① لا باقة تشمل integrations_hub');
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.feature_flags WHERE key = 'integrations_hub'), '① المفتاح معرَّف');
  PERFORM t.ok(NOT has_table_privilege('service_role', 'public.ihub_credentials', 'SELECT')
               AND NOT has_table_privilege('authenticated', 'public.ihub_connections', 'SELECT')
               AND NOT has_table_privilege('anon', 'public.ihub_providers', 'SELECT'), '① لا صلاحيات جداول');
  PERFORM t.ok(has_function_privilege('authenticated', 'public.ihub_overview()', 'EXECUTE')
               AND NOT has_function_privilege('service_role', 'public.ihub_overview()', 'EXECUTE')
               AND NOT has_function_privilege('authenticated', 'public.ihub_svc_get_credentials(uuid)', 'EXECUTE')
               AND has_function_privilege('service_role', 'public.ihub_svc_get_credentials(uuid)', 'EXECUTE')
               AND NOT has_function_privilege('anon', 'public.ihub_svc_get_credentials(uuid)', 'EXECUTE')
               AND NOT has_function_privilege('authenticated', 'public._ihub_require_admin()', 'EXECUTE')
               AND NOT has_function_privilege('service_role', 'public.ihub_retention_sweep()', 'EXECUTE'),
               '① صلاحيات الدوال');
  PERFORM t.ok(t.err_anon('select public.ihub_overview()') = '42501', '① anon مرفوض');
  PERFORM t.ok(t.fn_digest() = (SELECT v FROM t.saved WHERE k = 'fn'),
               '① دوال integration_* الإنتاجية ودوال الشركة: التعريف والصلاحيات كما هي حرفيًا');
  RAISE NOTICE 'PASS ① 087 مطبّق: 11 جدولًا بلا صلاحيات، المزوّدون مقفلون، دوال integration_* القائمة لم تُمس';
END $$;

-- الاستحقاق والمزوّدون (قرارات المالك — هنا للاختبار فقط)
INSERT INTO public.plan_features (plan_id, feature_key, enabled)
SELECT id, 'integrations_hub', true FROM public.subscription_plans WHERE key = 'support';

-- ══ ② النظرة العامة ══════════════════════════════════════════════════════
DO $$
DECLARE v jsonb;
BEGIN
  v := t.call(t.u('OA'), 'public.ihub_overview()');
  PERFORM t.ok(v->>'company_id' = t.u('CA')::text AND (v->>'entitled')::boolean AND (v->>'can_manage')::boolean, '② OA يرى شركته');
  PERFORM t.ok(jsonb_array_length(v->'providers') = 4 AND jsonb_array_length(v->'connections') = 0, '② أربعة مزوّدين، لا روابط');
  PERFORM t.ok(NOT ((v->'providers'->0->>'enabled')::boolean), '② المزوّد مقفل في النظرة العامة');
  PERFORM t.ok(t.call(t.u('A1'), 'public.ihub_overview()') IS NULL, '② العميل: null');
  PERFORM t.ok(t.call(t.u('A2'), 'public.ihub_overview()') IS NULL, '② موظف الدعم: null');
  PERFORM t.ok(t.call(t.u('A3'), 'public.ihub_overview()') IS NULL, '② المشرف: null');
  PERFORM t.ok(t.call(t.u('AD'), 'public.ihub_overview()') IS NULL, '② أدمن المنصة: null (R1)');
  PERFORM t.ok(t.call(t.u('SUP'), 'public.ihub_overview()') IS NULL, '② دعم المنصة: null (R1)');
  PERFORM t.ok(t.call(t.u('PU'), 'public.ihub_overview()') IS NULL, '② مستخدم بلا شركة: null');
  v := t.call(t.u('OC'), 'public.ihub_overview()');
  PERFORM t.ok(NOT (v->>'entitled')::boolean AND NOT (v->>'can_manage')::boolean, '② OC بلا استحقاق');
  PERFORM t.ctx('admin');
  PERFORM t.ok(t.call(t.u('OW'), 'public.ihub_overview()') IS NULL, '② مالك المنصة في سياق الإدارة: null (R1)');
  PERFORM t.ctx('company_user_preview');
  PERFORM t.ok(t.call(t.u('OW'), 'public.ihub_overview()') IS NULL, '② مالك المنصة في معاينة عضو: null');
  PERFORM t.ctx('company_admin');
  PERFORM t.ok(t.call(t.u('OW'), 'public.ihub_overview()')->>'company_id' = t.u('CW')::text, '② مالك المنصة مديرًا لشركته هو فقط');
  PERFORM t.ctx('admin');
  RAISE NOTICE 'PASS ② النظرة العامة لمدير الشركة وحده';
END $$;

-- ══ ③ تجهيز الربط ════════════════════════════════════════════════════════
DO $$
DECLARE v jsonb; c uuid;
BEGIN
  PERFORM t.ok(t.errd(t.u('OA'), $s$public.ihub_prepare_connection('woocommerce', 'متجري')$s$) LIKE '22023|%provider_disabled%',
               '③ مزوّد مقفل يُرفض');
  UPDATE public.ihub_providers SET enabled = true;
  v := t.call(t.u('OA'), $s$public.ihub_prepare_connection('woocommerce', 'متجري')$s$);
  PERFORM t.ok(v->>'status' = 'pending' AND v->>'provider' = 'woocommerce', '③ ربط معلّق');
  PERFORM t.ok((t.call(t.u('OA'), $s$public.ihub_prepare_connection('woocommerce', null)$s$))->>'id' = v->>'id', '③ متكرر النتيجة');
  PERFORM t.ok(t.err(t.u('OA'), $s$public.ihub_prepare_connection('shopify', null)$s$) = '22023', '③ مزوّد مجهول');
  PERFORM t.ok(t.err(t.u('A2'), $s$public.ihub_prepare_connection('woocommerce', null)$s$) = '42501', '③ موظف الدعم مرفوض');
  PERFORM t.ok(t.err(t.u('A3'), $s$public.ihub_prepare_connection('woocommerce', null)$s$) = '42501', '③ المشرف مرفوض');
  PERFORM t.ok(t.err(t.u('A1'), $s$public.ihub_prepare_connection('woocommerce', null)$s$) = '42501', '③ العميل مرفوض');
  PERFORM t.ok(t.err(t.u('AD'), $s$public.ihub_prepare_connection('woocommerce', null)$s$) = '42501', '③ أدمن المنصة مرفوض (R1)');
  PERFORM t.ok(t.errd(t.u('OC'), $s$public.ihub_prepare_connection('woocommerce', null)$s$) LIKE '42501|%not_entitled%', '③ OC بلا استحقاق');
  PERFORM t.ok(t.err(t.u('A4'), $s$public.ihub_prepare_connection('woocommerce', null)$s$) = '42501', '③ المحظور مرفوض');

  c := t.conn('CA', 'woocommerce');
  PERFORM t.ok((t.call(t.u('OA'), format('public.ihub_authorize(%L::uuid, %L)', c, 'connect')))->>'company_id' = t.u('CA')::text, '③ تفويض المالك');
  PERFORM t.ok(t.errd(t.u('OB'), format('public.ihub_authorize(%L::uuid, %L)', c, 'connect')) LIKE 'P0002|%not_found%', '③ OB لا يصل لربط أ (P0002)');
  PERFORM t.ok(t.errd(t.u('OB'), format('public.ihub_authorize(%L::uuid, %L)', t.u('NOPE'), 'connect')) LIKE 'P0002|%not_found%', '③ غير موجود: نفس الخطأ');
  PERFORM t.ok(t.err(t.u('OB'), format('public.ihub_disconnect(%L::uuid)', c)) = 'P0002', '③ OB لا يفصل ربط أ');
  PERFORM t.ok(t.err(t.u('OB'), format('public.ihub_set_view_role(%L::uuid, %L)', c, 'agent')) = 'P0002', '③ OB لا يغيّر ربط أ');
  PERFORM t.ok(t.err(t.u('OA'), format('public.ihub_authorize(%L::uuid, %L)', c, 'drop_table')) = '22023', '③ عملية مجهولة');
  UPDATE public.ihub_providers SET enabled = false WHERE key = 'woocommerce';
  PERFORM t.ok(t.errd(t.u('OA'), format('public.ihub_authorize(%L::uuid, %L)', c, 'test')) LIKE '22023|%provider_disabled%', '③ مفتاح الإيقاف يوقف الاختبار أيضًا');
  PERFORM t.ok(t.errd(t.u('OA'), format('public.ihub_authorize(%L::uuid, %L)', c, 'rotate_secret')) LIKE '22023|%provider_disabled%', '③ والتدوير');
  UPDATE public.ihub_providers SET enabled = true WHERE key = 'woocommerce';

  PERFORM t.call(t.u('OB'), $s$public.ihub_prepare_connection('woocommerce', 'متجر ب')$s$);
  PERFORM t.call(t.u('OA'), $s$public.ihub_prepare_connection('salla', null)$s$);
  PERFORM t.call(t.u('OA'), $s$public.ihub_prepare_connection('wordpress', 'الموقع')$s$);
  PERFORM t.call(t.u('OA'), $s$public.ihub_prepare_connection('daftra', null)$s$);
  PERFORM t.ok((SELECT count(*) FROM public.ihub_audit_events WHERE action = 'connection.prepared') = 5, '③ كل تجهيز مسجَّل');
  RAISE NOTICE 'PASS ③ التجهيز: مزوّد مقفل يُرفض، المدير وحده، لا عبور بين الشركات';
END $$;

-- ══ ④ دوال الخادم ═══════════════════════════════════════════════════════
DO $$
DECLARE ca uuid := t.conn('CA', 'woocommerce'); cb uuid := t.conn('CB', 'woocommerce'); v jsonb;
BEGIN
  PERFORM t.ok(t.err(t.u('OA'), format('public.ihub_svc_get_credentials(%L::uuid)', ca)) = '42501', '④ authenticated لا ينادي دوال الخادم');
  PERFORM t.ok(t.err(t.u('OA'), format('public.ihub_svc_store_credentials(%L::uuid, %L, 1, null)', ca, repeat('x', 40))) = '42501', '④ ولا يكتب أسرارًا');

  PERFORM t.svc(format('public.ihub_svc_store_credentials(%L::uuid, %L, 1, null)', ca, repeat('A', 60)));
  v := t.svc(format('public.ihub_svc_get_credentials(%L::uuid)', ca));
  PERFORM t.ok(v->>'ciphertext' = repeat('A', 60) AND v->>'company_id' = t.u('CA')::text
               AND (v->>'provider_enabled')::boolean, '④ قراءة الخادم (ومعها مفتاح الإيقاف)');
  PERFORM t.ok(NOT ((t.call(t.u('OA'), 'public.ihub_overview()'))::text LIKE '%' || repeat('A', 60) || '%'), '④ النظرة العامة بلا أسرار');

  v := t.svc(format('public.ihub_svc_activate(%L::uuid, %L, %L, %L, %L::uuid)', ca, 'https://shop-a.example/', 'متجر أ', 'https://shop-a.example', t.u('OA')));
  PERFORM t.ok(v->>'status' = 'active', '④ تفعيل');
  PERFORM t.ok(t.svc_err(format('public.ihub_svc_activate(%L::uuid, %L, %L, %L, null)', cb, 'https://shop-a.example/', 'x', 'https://shop-a.example'))
               LIKE '23505|%account_in_use%', '④ نفس المتجر لا يُربط بشركتين');
  PERFORM t.svc(format('public.ihub_svc_activate(%L::uuid, %L, %L, %L, null)', cb, 'https://shop-b.example/', 'متجر ب', 'https://shop-b.example'));
  PERFORM t.ok(t.err_super(format($s$update public.ihub_connections set external_account_id = 'https://other/' where id = %L$s$, ca)) = '23514',
               '④ الحساب الخارجي للربط لا يتغير');
  PERFORM t.ok(t.err_super(format($s$update public.ihub_connections set company_id = %L where id = %L$s$, t.u('CB'), ca)) = '23514',
               '④ شركة الربط لا تتغير');
  PERFORM t.ok(t.err_super($s$update public.ihub_connections set base_url = 'http://insecure' where provider = 'woocommerce'$s$) = '23514',
               '④ base_url يجب أن يكون https');

  PERFORM t.svc(format('public.ihub_svc_record_health(%L::uuid, false, %L)', ca, 'rate_limited'));
  PERFORM t.ok((SELECT status || '/' || last_error_code FROM public.ihub_connections WHERE id = ca) = 'error/rate_limited', '④ خطأ مؤقت');
  PERFORM t.svc(format('public.ihub_svc_record_health(%L::uuid, false, %L)', ca, 'Bearer sk-123 leaked!'));
  PERFORM t.ok((SELECT last_error_code FROM public.ihub_connections WHERE id = ca) = 'unknown_error', '④ نص حر لا يُخزَّن كرمز خطأ');
  PERFORM t.svc(format('public.ihub_svc_record_health(%L::uuid, false, %L)', ca, 'auth_failed'));
  PERFORM t.ok((SELECT status FROM public.ihub_connections WHERE id = ca) = 'reauth_required', '④ فشل المصادقة');
  PERFORM t.svc(format('public.ihub_svc_record_health(%L::uuid, true, null)', ca));
  PERFORM t.ok((SELECT status || '/' || coalesce(last_error_code, '-') FROM public.ihub_connections WHERE id = ca) = 'active/-', '④ تعافٍ');
  v := t.svc($s$public.ihub_svc_find_connection('woocommerce', 'https://shop-b.example/')$s$);
  PERFORM t.ok(v->>'company_id' = t.u('CB')::text, '④ البحث بالحساب الخارجي');
  PERFORM t.ok(t.svc($s$public.ihub_svc_find_connection('woocommerce', 'https://nope/')$s$) IS NULL, '④ حساب مجهول: null');
  PERFORM t.ok(t.errd(t.u('OA'), $s$public.ihub_prepare_connection('woocommerce', null)$s$) LIKE '23505|%already_connected%', '④ ربط ثانٍ لنفس المزوّد مرفوض');
  RAISE NOTICE 'PASS ④ دوال الخادم: service_role وحده، الحساب الخارجي فريد، الأخطاء رموز ثابتة';
END $$;

-- ══ ⑤ OAuth: state + بصمة التبويب + رمز الإكمال ═══════════════════════
-- الهجوم المقصود: مدير شركة أ يبدأ «ربط سلة» ويرسل رابط التفويض لتاجر ضحية.
-- الضحية توافق في متصفحها ⇒ الرجوع يحجز النتيجة ويعطي رمز الإكمال لمتصفح الضحية.
-- المهاجم يملك البصمة (بدأ هو) ولا يملك رمز الإكمال؛ الضحية تملك الرمز ولا تملك جلسته ولا بصمته.
DO $$
DECLARE cs uuid := t.conn('CA', 'salla'); cw uuid := t.conn('CA', 'woocommerce'); v jsonb;
        h text := repeat('a', 64); b text := repeat('f', 64); k text := repeat('9', 64); ct text := 'ihub1.' || repeat('Q', 40);
        take text := 'public.ihub_svc_take_oauth_result(%L::uuid, %L, %L, %L::uuid)';
BEGIN
  PERFORM t.ok(t.err(t.u('OA'), format('public.ihub_oauth_begin(%L::uuid, %L, %L)', cw, h, b)) = '22023', '⑤ ووكومرس لا يستعمل OAuth');
  PERFORM t.ok(t.err(t.u('OA'), format('public.ihub_oauth_begin(%L::uuid, %L, %L)', cs, 'not-a-hash', b)) = '22023', '⑤ hash غير صالح');
  PERFORM t.ok(t.err(t.u('OA'), format('public.ihub_oauth_begin(%L::uuid, %L, %L)', cs, h, h)) = '22023', '⑤ البصمة لا تساوي state');
  PERFORM t.ok(t.err(t.u('OA'), format('public.ihub_oauth_begin(%L::uuid, %L, null)', cs, h)) = '22023', '⑤ البصمة إلزامية');
  PERFORM t.ok(t.err(t.u('OB'), format('public.ihub_oauth_begin(%L::uuid, %L, %L)', cs, h, b)) = 'P0002', '⑤ OB لا يبدأ OAuth لربط أ');
  PERFORM t.call(t.u('OA'), format('public.ihub_oauth_begin(%L::uuid, %L, %L)', cs, h, b));

  PERFORM t.ok(NOT t.svc(format('public.ihub_svc_hold_oauth_result(%L, %L, %L)', h, ct, k))::boolean, '⑤ لا حجز قبل الاستهلاك');
  v := t.svc(format('public.ihub_svc_consume_oauth_state(%L)', h));
  PERFORM t.ok(v->>'connection_id' = cs::text AND v->>'user_id' = t.u('OA')::text, '⑤ استهلاك أول');
  PERFORM t.ok(t.svc(format('public.ihub_svc_consume_oauth_state(%L)', h)) IS NULL, '⑤ state مرة واحدة فقط');
  PERFORM t.ok(NOT t.svc(format('public.ihub_svc_hold_oauth_result(%L, %L, %L)', h, ct, 'x'))::boolean, '⑤ رمز إكمال غير صالح');
  PERFORM t.ok(NOT t.svc(format('public.ihub_svc_hold_oauth_result(%L, %L, %L)', h, ct, b))::boolean, '⑤ رمز الإكمال لا يساوي البصمة');
  PERFORM t.ok(t.svc(format('public.ihub_svc_hold_oauth_result(%L, %L, %L)', h, ct, k))::boolean, '⑤ حجز النتيجة');
  PERFORM t.ok(NOT t.svc(format('public.ihub_svc_hold_oauth_result(%L, %L, %L)', h, ct, k))::boolean, '⑤ لا حجز مرتين');
  PERFORM t.ok((SELECT status FROM public.ihub_connections WHERE id = cs) = 'pending', '⑤ الرجوع من المزوّد لا يفعّل شيئًا');

  PERFORM t.ok(t.svc(format(take, cs, b, repeat('8', 64), t.u('OA'))) IS NULL, '⑤ الهجوم: المهاجم يملك البصمة لا رمز الإكمال');
  PERFORM t.ok(t.svc(format(take, cs, repeat('e', 64), k, t.u('OA'))) IS NULL, '⑤ رمز صحيح من تبويب آخر');
  PERFORM t.ok(t.svc(format(take, cs, b, k, t.u('OB'))) IS NULL, '⑤ مستخدم آخر');
  PERFORM t.ok(t.svc(format(take, t.conn('CA', 'daftra'), b, k, t.u('OA'))) IS NULL, '⑤ ربط آخر');
  PERFORM t.ok(t.svc(format(take, cs, b, k, t.u('OA'))) #>> '{}' = ct, '⑤ الإكمال يسلّم النتيجة');
  PERFORM t.ok(t.svc(format(take, cs, b, k, t.u('OA'))) IS NULL, '⑤ الإكمال مرة واحدة');
  PERFORM t.ok((SELECT pending_cipher IS NULL AND completion_hash IS NULL FROM public.ihub_oauth_states WHERE state_hash = h), '⑤ لا شيء يبقى بعد الإكمال');
  PERFORM t.ok(t.err(t.u('OA'), format(take, cs, b, k, t.u('OA'))) = '42501', '⑤ authenticated لا يأخذ النتيجة');

  PERFORM t.call(t.u('OA'), format('public.ihub_oauth_begin(%L::uuid, %L, %L)', cs, repeat('c', 64), b));
  UPDATE public.ihub_oauth_states SET expires_at = now() - interval '1 second' WHERE state_hash = repeat('c', 64);
  PERFORM t.ok(t.svc(format('public.ihub_svc_consume_oauth_state(%L)', repeat('c', 64))) IS NULL, '⑤ منتهي الصلاحية');
  PERFORM t.call(t.u('OA'), format('public.ihub_oauth_begin(%L::uuid, %L, %L)', cs, repeat('d', 64), b));
  PERFORM t.svc(format('public.ihub_svc_consume_oauth_state(%L)', repeat('d', 64)));
  PERFORM t.svc(format('public.ihub_svc_hold_oauth_result(%L, %L, %L)', repeat('d', 64), ct, k));
  UPDATE public.ihub_oauth_states SET expires_at = now() - interval '1 second' WHERE state_hash = repeat('d', 64);
  PERFORM t.ok(t.svc(format(take, cs, b, k, t.u('OA'))) IS NULL, '⑤ نتيجة منتهية لا تُسلَّم');
  PERFORM t.call(t.u('OA'), format('public.ihub_oauth_begin(%L::uuid, %L, %L)', cs, repeat('1', 64), b));
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.ihub_oauth_states WHERE state_hash = repeat('d', 64)), '⑤ بدء جديد يمحو القديم ونتيجته');
  RAISE NOTICE 'PASS ⑤ OAuth: state لمرة واحدة؛ الرجوع يحجز ولا يفعّل؛ الإكمال لنفس المدير + نفس التبويب + رمز متصفح الموافقة';
END $$;

-- ══ ⑥ الأحداث ═══════════════════════════════════════════════════════════
DO $$
DECLARE c uuid := t.conn('CA', 'woocommerce'); v jsonb; r jsonb; e bigint; k1 text := md5('1') || md5('1');
BEGIN
  -- حدث لطلب غير مربوط بأي تذكرة: يُسجَّل بلا حمولة ويُتجاهل
  v := t.svc(format('public.ihub_svc_ingest_event(%L::uuid, %L, %L, %L, %L, %L::timestamptz)',
                    c, 'order.updated', k1, 'order', '501', '2026-10-01T10:00:00Z'));
  PERFORM t.ok(NOT (v->>'duplicate')::boolean AND NOT (v->>'linked')::boolean, '⑥ غير مربوط');
  PERFORM t.ok(t.ev_status((v->>'event_id')::bigint) = 'ignored:0', '⑥ متجاهل فورًا');
  v := t.svc(format('public.ihub_svc_ingest_event(%L::uuid, %L, %L, %L, %L, %L::timestamptz)',
                    c, 'order.updated', k1, 'order', '501', '2026-10-01T10:00:00Z'));
  PERFORM t.ok((v->>'duplicate')::boolean, '⑥ تكرار التسليم يُكتشف');
  PERFORM t.ok((SELECT count(*) FROM public.ihub_webhook_events WHERE dedupe_key = k1) = 1, '⑥ صف واحد');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.ihub_external_records), '⑥ لا تخزين لطلب غير مربوط');

  -- ربط تذكرة بطلب (المسار عند الطلب: الخادم يجلب ثم ينشئ)
  r := t.svc(format('public.ihub_svc_apply_record(%L::uuid, %L, %L, %L, %L::jsonb, %L, %L::timestamptz, null, true)',
                    c, 'order', '501', '#501', '{"status":"processing","total":"10.00"}', 'https://shop-a.example/wp-admin/post.php?post=501&action=edit', '2026-10-01T10:00:00Z'));
  PERFORM t.ok((r->>'applied')::boolean, '⑥ إنشاء نسخة');
  PERFORM t.svc(format('public.ihub_svc_link_ticket(%L::uuid, %L::uuid, %L::uuid)', t.u('TA1'), r->>'record_id', t.u('OA')));
  PERFORM t.ok((t.svc(format('public.ihub_svc_link_ticket(%L::uuid, %L::uuid, %L::uuid)', t.u('TA1'), r->>'record_id', t.u('OA'))))->>'created' = 'false',
               '⑥ الربط متكرر النتيجة');

  -- حدث أحدث لطلب مربوط
  v := t.svc(format('public.ihub_svc_ingest_event(%L::uuid, %L, %L, %L, %L, %L::timestamptz)',
                    c, 'order.updated', md5('2') || md5('2'), 'order', '501', '2026-10-02T10:00:00Z'));
  PERFORM t.ok((v->>'linked')::boolean AND t.ev_status((v->>'event_id')::bigint) = 'received:0', '⑥ مربوط: يُستقبل');
  r := t.svc(format('public.ihub_svc_apply_record(%L::uuid, %L, %L, %L, %L::jsonb, null, %L::timestamptz, %s, false)',
                    c, 'order', '501', '#501', '{"status":"completed"}', '2026-10-02T10:00:00Z', v->>'event_id'));
  PERFORM t.ok((r->>'applied')::boolean AND t.ev_status((v->>'event_id')::bigint) = 'processed:0', '⑥ يُطبَّق');
  -- حدث أقدم وصل متأخرًا: لا يعيد الحالة للخلف
  v := t.svc(format('public.ihub_svc_ingest_event(%L::uuid, %L, %L, %L, %L, %L::timestamptz)',
                    c, 'order.updated', md5('3') || md5('3'), 'order', '501', '2026-10-01T12:00:00Z'));
  r := t.svc(format('public.ihub_svc_apply_record(%L::uuid, %L, %L, %L, %L::jsonb, null, %L::timestamptz, %s, false)',
                    c, 'order', '501', '#501', '{"status":"processing"}', '2026-10-01T12:00:00Z', v->>'event_id'));
  PERFORM t.ok(NOT (r->>'applied')::boolean AND (r->>'stale')::boolean, '⑥ حدث قديم لا يُطبَّق');
  PERFORM t.ok((SELECT summary->>'status' FROM public.ihub_external_records WHERE external_id = '501') = 'completed', '⑥ الحالة باقية الأحدث');
  PERFORM t.ok(t.svc_err(format('public.ihub_svc_apply_record(%L::uuid, %L, %L, %L, %L::jsonb, null, null, null, true)',
                    c, 'order', '502', '#502', jsonb_build_object('blob', repeat('x', 5000)))) LIKE '23514|%', '⑥ الملخص محدود الحجم');

  -- فشل المعالجة: مهلة متزايدة ثم dead
  v := t.svc(format('public.ihub_svc_ingest_event(%L::uuid, %L, %L, %L, %L, %L::timestamptz)',
                    c, 'order.updated', md5('4') || md5('4'), 'order', '501', '2026-10-03T10:00:00Z'));
  e := (v->>'event_id')::bigint;
  PERFORM t.svc(format('public.ihub_svc_event_failed(%s, %L, true)', e, 'provider_unavailable'));
  PERFORM t.ok(t.ev_status(e) = 'failed:1', '⑥ فشل أول');
  PERFORM t.ok((SELECT next_attempt_at BETWEEN now() + interval '50 seconds' AND now() + interval '70 seconds'
                  FROM public.ihub_webhook_events WHERE id = e), '⑥ إعادة بعد دقيقة');
  PERFORM t.ok(jsonb_array_length(t.svc('public.ihub_svc_claim_due_events(10)')) = 0, '⑥ غير مستحق بعد');
  UPDATE public.ihub_webhook_events SET next_attempt_at = now() - interval '1 second' WHERE id = e;
  v := t.svc('public.ihub_svc_claim_due_events(10)');
  PERFORM t.ok(jsonb_array_length(v) = 1 AND v->0->>'external_id' = '501', '⑥ الحجز');
  PERFORM t.ok(jsonb_array_length(t.svc('public.ihub_svc_claim_due_events(10)')) = 0, '⑥ المحجوز لا يُحجز مرتين (إيجار)');
  PERFORM t.svc(format('public.ihub_svc_event_failed(%s, %L, true)', e, 'provider_unavailable')) FROM generate_series(1, 5);
  PERFORM t.ok(t.ev_status(e) = 'dead:6', '⑥ dead بعد 6 محاولات');
  PERFORM t.svc(format('public.ihub_svc_event_failed(%s, %L, false)', (t.svc(format('public.ihub_svc_ingest_event(%L::uuid, %L, %L, %L, %L, null)',
                    c, 'order.updated', md5('5') || md5('5'), 'order', '501')))->>'event_id', 'invalid_payload'));
  PERFORM t.ok((SELECT status FROM public.ihub_webhook_events WHERE dedupe_key = md5('5') || md5('5')) = 'dead', '⑥ حمولة غير صالحة: dead بلا إعادة');
  PERFORM t.ok(t.svc_err(format('public.ihub_svc_ingest_event(%L::uuid, %L, %L, null, null, null)', c, 'x', 'nothex')) LIKE '23514|%', '⑥ مفتاح التكرار sha256 فقط');
  RAISE NOTICE 'PASS ⑥ الأحداث: بلا حمولة، تكرار، ترتيب، إعادة بمهلة، dead، حجز SKIP LOCKED';
END $$;

-- ══ ⑦ سياق التذكرة ══════════════════════════════════════════════════════
DO $$
DECLARE c uuid := t.conn('CA', 'woocommerce'); v jsonb; rec uuid; rb uuid;
BEGIN
  v := t.call(t.u('OA'), format('public.ihub_ticket_context(%L::uuid)', t.u('TA1')));
  PERFORM t.ok(v->>'my_role' = 'admin' AND jsonb_array_length(v->'links') = 1
               AND v->'links'->0->>'display_ref' = '#501' AND v->'links'->0->'summary'->>'status' = 'completed', '⑦ المالك يرى الطلب المربوط');
  PERFORM t.ok(jsonb_array_length(v->'connections') >= 1, '⑦ الروابط القابلة للربط');
  PERFORM t.ok(NOT (v::text LIKE '%wordpress%'), '⑦ ووردبريس ليس مصدر سجلات');
  PERFORM t.ok(jsonb_array_length((t.call(t.u('OA'), format('public.ihub_ticket_context(%L::uuid)', t.u('TA2'))))->'links') = 0, '⑦ تذكرة أخرى بلا روابط');
  PERFORM t.ok(t.errd(t.u('OB'), format('public.ihub_ticket_context(%L::uuid)', t.u('TA1'))) LIKE 'P0002|%', '⑦ OB لا يرى تذكرة أ');
  PERFORM t.ok(t.err(t.u('AD'), format('public.ihub_ticket_context(%L::uuid)', t.u('TA1'))) = 'P0002', '⑦ أدمن المنصة لا يرى (R1)');
  PERFORM t.ok(t.err(t.u('SUP'), format('public.ihub_ticket_context(%L::uuid)', t.u('TA1'))) = 'P0002', '⑦ دعم المنصة لا يرى (R1)');
  PERFORM t.ok(t.err(t.u('A1'), format('public.ihub_ticket_context(%L::uuid)', t.u('TA1'))) = 'P0002', '⑦ العميل صاحب التذكرة لا يرى بيانات المتجر');
  PERFORM t.ok(t.err(t.u('A2'), format('public.ihub_ticket_context(%L::uuid)', t.u('TA1'))) = 'P0002', '⑦ موظف الدعم: لا يرى التذكرة فلا يرى السياق');
  PERFORM t.ok(t.err(t.u('A3'), format('public.ihub_ticket_context(%L::uuid)', t.u('TA1'))) = 'P0002', '⑦ المشرف: نفس الشيء');
  PERFORM t.ok(t.err(t.u('OA'), format('public.ihub_ticket_context(%L::uuid)', t.u('TOA'))) = 'P0002', '⑦ تذكرة الشركة مع مدعوم ليست تذكرة عميل');
  PERFORM t.ok(t.err(t.u('OA'), format('public.ihub_ticket_context(%L::uuid)', t.u('NOPE'))) = 'P0002', '⑦ تذكرة غير موجودة');
  PERFORM t.ok(t.err(t.u('OB'), format('public.ihub_authorize_ticket_link(%L::uuid, %L::uuid)', t.u('TA1'), c)) = 'P0002', '⑦ OB لا يربط تذكرة أ');
  PERFORM t.ok(t.err(t.u('OA'), format('public.ihub_authorize_ticket_link(%L::uuid, %L::uuid)', t.u('TA1'), t.conn('CB', 'woocommerce'))) = 'P0002',
               '⑦ OA لا يربط بربط ب');
  PERFORM t.ok((t.call(t.u('OA'), format('public.ihub_authorize_ticket_link(%L::uuid, %L::uuid)', t.u('TA1'), c)))->>'provider' = 'woocommerce', '⑦ تفويض الربط');
  PERFORM t.ok(t.err(t.u('OA'), format('public.ihub_authorize_ticket_link(%L::uuid, %L::uuid)', t.u('TA1'), t.conn('CA', 'wordpress'))) = 'P0002',
               '⑦ لا ربط تذاكر بووردبريس');

  -- R4 بالمحفّز: تذكرة ب + سجل أ
  rec := (SELECT id FROM public.ihub_external_records WHERE external_id = '501');
  PERFORM t.ok(t.svc_err(format('public.ihub_svc_link_ticket(%L::uuid, %L::uuid, null)', t.u('TB1'), rec)) LIKE 'P0002|%', '⑦ R4: دالة الخادم ترفض');
  PERFORM t.ok(t.err_super(format('insert into public.ihub_ticket_links (company_id, ticket_id, record_id) values (%L, %L, %L)',
                                  t.u('CA'), t.u('TB1'), rec)) = '23514', '⑦ R4: المحفّز يرفض حتى من مالك القاعدة');
  PERFORM t.ok(t.err_super(format('insert into public.ihub_ticket_links (company_id, ticket_id, record_id) values (%L, %L, %L)',
                                  t.u('CA'), t.u('TOA'), rec)) = '23514', '⑦ R4: تذكرة المالك نفسه مرفوضة');
  PERFORM t.ok(t.err_super(format($s$insert into public.ihub_external_records (connection_id, company_id, record_type, external_id) values (%L, %L, 'order', '9')$s$,
                                  c, t.u('CB'))) = '23514', '⑦ R4: سجل بشركة غير شركة ربطه');

  -- min_view_role: العميل لا يصير مخوّلًا أبدًا، والمالك admin دائمًا
  PERFORM t.call(t.u('OA'), format('public.ihub_set_view_role(%L::uuid, %L)', c, 'agent'));
  PERFORM t.ok(t.err(t.u('A1'), format('public.ihub_ticket_context(%L::uuid)', t.u('TA1'))) = 'P0002', '⑦ min_view_role=agent لا يفتح للعميل');
  PERFORM t.ok(t.err(t.u('A2'), format('public.ihub_ticket_context(%L::uuid)', t.u('TA1'))) = 'P0002', '⑦ ولا لموظف لا يرى التذكرة');
  PERFORM t.ok((SELECT action FROM public.ihub_audit_events ORDER BY id DESC LIMIT 1) = 'connection.view_role', '⑦ تغيير الدور مسجَّل');
  PERFORM t.call(t.u('OA'), format('public.ihub_set_view_role(%L::uuid, %L)', c, 'admin'));

  -- فك الربط
  rb := (SELECT (v->'links'->0->>'link_id')::uuid);
  PERFORM t.ok(t.err(t.u('OB'), format('public.ihub_ticket_unlink(%L::uuid)', rb)) = 'P0002', '⑦ OB لا يفك ربط أ');
  PERFORM t.call(t.u('OA'), format('public.ihub_ticket_unlink(%L::uuid)', rb));
  PERFORM t.ok(jsonb_array_length((t.call(t.u('OA'), format('public.ihub_ticket_context(%L::uuid)', t.u('TA1'))))->'links') = 0, '⑦ فُك');
  PERFORM t.ok(t.err(t.u('OA'), format('public.ihub_ticket_unlink(%L::uuid)', rb)) = 'P0002', '⑦ فك مرتين');
  PERFORM t.ok(t.err_super(format('update public.ihub_ticket_links set unlinked_at = null where id = %L', rb)) = '23514', '⑦ الربط الملغى ثابت');
  PERFORM t.svc(format('public.ihub_svc_link_ticket(%L::uuid, %L::uuid, %L::uuid)', t.u('TA1'), rec, t.u('OA')));
  RAISE NOTICE 'PASS ⑦ سياق التذكرة: المالك وحده اليوم، لا طاقم منصة، لا عميل، R4 بالمحفّز';
END $$;

-- ══ ⑧ ربط العملاء ═══════════════════════════════════════════════════════
DO $$
DECLARE c uuid := t.conn('CA', 'woocommerce'); v jsonb;
BEGIN
  v := t.call(t.u('OA'), format('public.ihub_customer_link(%L::uuid, %L::uuid, %L)', c, t.u('A1'), '77'));
  PERFORM t.ok((v->>'linked')::boolean, '⑧ ربط صريح');
  PERFORM t.ok((t.call(t.u('OA'), format('public.ihub_ticket_context(%L::uuid)', t.u('TA1'))))->'customer_refs'->0->>'external_customer_id' = '77',
               '⑧ يظهر في سياق تذكرة العميل');
  PERFORM t.ok(t.errd(t.u('OA'), format('public.ihub_customer_link(%L::uuid, %L::uuid, %L)', c, t.u('B1'), '78')) LIKE 'P0002|%', '⑧ عميل شركة أخرى');
  PERFORM t.ok(t.err(t.u('OA'), format('public.ihub_customer_link(%L::uuid, %L::uuid, %L)', c, t.u('OA'), '79')) = 'P0002', '⑧ المالك ليس عميلًا');
  PERFORM t.ok(t.err(t.u('OA'), format('public.ihub_customer_link(%L::uuid, %L::uuid, %L)', c, t.u('NOPE'), '79')) = 'P0002', '⑧ غير موجود: نفس الخطأ');
  PERFORM t.ok(t.errd(t.u('OA'), format('public.ihub_customer_link(%L::uuid, %L::uuid, %L)', c, t.u('A3'), '77')) LIKE '23505|%already_linked%', '⑧ نفس المعرّف لعميلين');
  PERFORM t.ok(t.err(t.u('OA'), format('public.ihub_customer_link(%L::uuid, %L::uuid, %L)', c, t.u('A3'), 'x y')) = '22023', '⑧ معرّف غير صالح');
  PERFORM t.ok(t.err(t.u('OB'), format('public.ihub_customer_link(%L::uuid, %L::uuid, %L)', c, t.u('A1'), '80')) = 'P0002', '⑧ OB على ربط أ');
  PERFORM t.ok(t.err(t.u('A1'), 'public.ihub_customer_links_list()') = '42501', '⑧ العميل لا يقرأ القائمة');
  PERFORM t.ok(jsonb_array_length(t.call(t.u('OB'), 'public.ihub_customer_links_list()')) = 0, '⑧ OB لا يرى روابط أ');
  PERFORM t.ok(t.err_super(format($s$insert into public.ihub_customer_links (company_id, connection_id, customer_id, external_customer_id) values (%L, %L, %L, 'z')$s$,
                                  t.u('CA'), c, t.u('B1'))) = '23514', '⑧ R4 بالمحفّز');
  RAISE NOTICE 'PASS ⑧ ربط العملاء: يدوي، داخل الشركة فقط، فريد';
END $$;

-- ══ ⑨ طلبات ووردبريس ════════════════════════════════════════════════════
DO $$
DECLARE cw uuid := t.conn('CA', 'wordpress'); v jsonb; i uuid; i2 uuid;
BEGIN
  PERFORM t.ok(t.svc_err(format('public.ihub_svc_wp_intake(%L::uuid, %L, %L, %L, %L, null, null)', cw, 'زائر', 'v@x.io', 'مشكلة', 'نص'))
               LIKE 'P0002|%', '⑨ ربط معلّق لا يستقبل');
  PERFORM t.svc(format('public.ihub_svc_activate(%L::uuid, %L, %L, %L, null)', cw, 'https://site-a.example/', 'موقع أ', 'https://site-a.example'));
  PERFORM t.ok(t.svc_err(format('public.ihub_svc_wp_intake(%L::uuid, %L, %L, %L, %L, null, null)', t.conn('CA', 'woocommerce'), 'x', 'v@x.io', 's', 'm'))
               LIKE 'P0002|%', '⑨ ربط غير ووردبريس لا يستقبل');
  v := t.svc(format('public.ihub_svc_wp_intake(%L::uuid, %L, %L, %L, %L, %L, null)', cw, 'زائر', 'V@X.io', 'طلبي متأخر', 'تفاصيل', '501'));
  i := (v->>'intake_id')::uuid;
  PERFORM t.ok((SELECT requester_email FROM public.ihub_intake_requests WHERE id = i) = 'v@x.io', '⑨ البريد مُطبَّع');
  PERFORM t.ok(t.svc_err(format('public.ihub_svc_wp_intake(%L::uuid, %L, %L, %L, %L, %L, null)', cw, 'x', 'bad', 's', 'm', null)) LIKE '23514|%', '⑨ بريد غير صالح');
  PERFORM t.ok(t.svc_err(format('public.ihub_svc_wp_intake(%L::uuid, %L, %L, %L, %L, %L, null)', cw, 'x', 'o@x.io', 's', repeat('m', 5001), null)) LIKE '23514|%', '⑨ رسالة طويلة');
  PERFORM t.ok(t.svc_err(format('public.ihub_svc_wp_intake(%L::uuid, %L, %L, %L, %L, %L, null)', cw, 'x', 'o@x.io', 's', 'm', '1; drop')) LIKE '23514|%', '⑨ مرجع طلب رقمي فقط');
  PERFORM t.svc(format('public.ihub_svc_wp_intake(%L::uuid, %L, %L, %L, %L, null, null)', cw, 'x', 'v@x.io', 's', 'm')) FROM generate_series(1, 4);
  PERFORM t.ok(t.svc_err(format('public.ihub_svc_wp_intake(%L::uuid, %L, %L, %L, %L, null, null)', cw, 'x', 'v@x.io', 's', 'm')) LIKE 'P0001|%rate_limited%',
               '⑨ 5 طلبات لكل بريد في الساعة');
  PERFORM t.ok(t.err(t.u('OA'), format('public.ihub_svc_wp_intake(%L::uuid, %L, %L, %L, %L, null, null)', cw, 'x', 'z@x.io', 's', 'm')) = '42501',
               '⑨ authenticated لا يكتب طلبات');

  PERFORM t.ok(jsonb_array_length(t.call(t.u('OA'), $s$public.ihub_intake_list('new', 50)$s$)) = 5, '⑨ المالك يرى الطلبات');
  PERFORM t.ok(jsonb_array_length(t.call(t.u('OB'), $s$public.ihub_intake_list('new', 50)$s$)) = 0, '⑨ OB لا يرى طلبات أ');
  PERFORM t.ok(t.err(t.u('A2'), $s$public.ihub_intake_list('new', 50)$s$) = '42501', '⑨ موظف الدعم لا يرى (إدارة)');
  PERFORM t.ok(t.err(t.u('AD'), $s$public.ihub_intake_list('new', 50)$s$) = '42501', '⑨ أدمن المنصة لا يرى (R1)');

  PERFORM t.ok(t.err(t.u('OA'), format('public.ihub_intake_convert(%L::uuid, %L::uuid)', i, t.u('B1'))) = 'P0002', '⑨ لا تحويل لعميل شركة أخرى');
  PERFORM t.ok(t.err(t.u('OA'), format('public.ihub_intake_convert(%L::uuid, %L::uuid)', i, t.u('OA'))) = 'P0002', '⑨ لا تحويل لتذكرة باسم المالك');
  PERFORM t.ok(t.errd(t.u('OA'), format('public.ihub_intake_convert(%L::uuid, %L::uuid)', i, t.u('A4'))) LIKE '22023|%customer_inactive%', '⑨ لا تحويل لعميل محظور');
  PERFORM t.ok(t.err(t.u('OB'), format('public.ihub_intake_convert(%L::uuid, %L::uuid)', i, t.u('B1'))) = 'P0002', '⑨ OB لا يحوّل طلب أ');
  v := t.call(t.u('OA'), format('public.ihub_intake_convert(%L::uuid, %L::uuid)', i, t.u('A1')));
  PERFORM t.ok(v->>'external_order_ref' = '501' AND v->>'ticket_id' IS NOT NULL, '⑨ تحويل');
  PERFORM t.ok((SELECT user_id FROM public.tickets WHERE id = (v->>'ticket_id')::uuid) = t.u('A1'), '⑨ التذكرة باسم العميل المختار');
  PERFORM t.ok(t.call(t.u('A1'), format('public.ticket_in_my_scope(%L::uuid)', v->>'ticket_id'))::boolean, '⑨ العميل يرى تذكرته');
  PERFORM t.ok(t.call(t.u('OA'), format('public.ticket_in_my_scope(%L::uuid)', v->>'ticket_id'))::boolean, '⑨ والمالك (تذاكر عملائي)');
  PERFORM t.ok(NOT t.call(t.u('OB'), format('public.ticket_in_my_scope(%L::uuid)', v->>'ticket_id'))::boolean, '⑨ وليس OB');
  PERFORM t.ok(t.err(t.u('OA'), format('public.ihub_intake_convert(%L::uuid, %L::uuid)', i, t.u('A1'))) = 'P0002', '⑨ لا تحويل مرتين');

  i2 := (SELECT id FROM public.ihub_intake_requests WHERE status = 'new' LIMIT 1);
  PERFORM t.call(t.u('OA'), format('public.ihub_intake_dismiss(%L::uuid)', i2));
  PERFORM t.ok((SELECT status FROM public.ihub_intake_requests WHERE id = i2) = 'dismissed', '⑨ رفض');
  PERFORM t.ok(t.err(t.u('OA'), format('public.ihub_intake_dismiss(%L::uuid)', i2)) = 'P0002', '⑨ لا رفض مرتين');

  PERFORM t.ok(t.svc(format('public.ihub_svc_use_nonce(%L::uuid, %L, 600)', cw, 'abcdefghijklmnop'))::boolean, '⑨ nonce أول');
  PERFORM t.ok(NOT t.svc(format('public.ihub_svc_use_nonce(%L::uuid, %L, 600)', cw, 'abcdefghijklmnop'))::boolean, '⑨ إعادة الإرسال مرفوضة');
  PERFORM t.ok(NOT t.svc(format('public.ihub_svc_use_nonce(%L::uuid, %L, 600)', cw, 'short'))::boolean, '⑨ nonce قصير مرفوض');
  RAISE NOTICE 'PASS ⑨ طلبات ووردبريس: حدود، تحويل لعميل الشركة فقط، nonce مرة واحدة';
END $$;

-- ══ ⑩ الفصل ═════════════════════════════════════════════════════════════
DO $$
DECLARE c uuid := t.conn('CA', 'woocommerce'); v jsonb; n_tickets int;
BEGIN
  n_tickets := (SELECT count(*) FROM public.tickets);
  PERFORM t.ok(t.err(t.u('A3'), format('public.ihub_disconnect(%L::uuid)', c)) = '42501', '⑩ المشرف لا يفصل');
  v := t.call(t.u('OA'), format('public.ihub_disconnect(%L::uuid)', c));
  PERFORM t.ok((v->>'disconnected')::boolean AND (v->>'records_deleted')::int = 1, '⑩ فصل');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.ihub_credentials WHERE connection_id = c), '⑩ الأسرار حُذفت');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.ihub_external_records WHERE connection_id = c)
               AND NOT EXISTS (SELECT 1 FROM public.ihub_ticket_links l WHERE l.ticket_id = t.u('TA1')), '⑩ النسخ والروابط حُذفت');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.ihub_webhook_events WHERE connection_id = c)
               AND NOT EXISTS (SELECT 1 FROM public.ihub_customer_links WHERE connection_id = c), '⑩ الأحداث وروابط العملاء حُذفت');
  PERFORM t.ok((SELECT count(*) FROM public.tickets) = n_tickets, '⑩ التذاكر لم تُمس');
  PERFORM t.ok(t.svc(format('public.ihub_svc_get_credentials(%L::uuid)', c)) IS NULL, '⑩ الخادم لا يجد الربط');
  PERFORM t.ok(t.svc_err(format('public.ihub_svc_ingest_event(%L::uuid, %L, %L, null, null, null)', c, 'x', md5('9') || md5('9'))) LIKE 'P0002|%',
               '⑩ لا أحداث لربط مفصول');
  PERFORM t.ok(t.err_super(format($s$update public.ihub_connections set status = 'active', disconnected_at = null where id = %L$s$, c)) = '23514',
               '⑩ الربط المفصول لا يعود');
  PERFORM t.ok(t.err(t.u('OA'), format('public.ihub_disconnect(%L::uuid)', c)) = 'P0002', '⑩ فصل مرتين');
  PERFORM t.ok((t.call(t.u('OA'), $s$public.ihub_prepare_connection('woocommerce', null)$s$))->>'status' = 'pending', '⑩ ربط جديد ممكن بعد الفصل');
  PERFORM t.svc(format('public.ihub_svc_activate(%L::uuid, %L, %L, %L, null)', t.conn('CA', 'woocommerce'), 'https://shop-a.example/', 'متجر أ', 'https://shop-a.example'));
  PERFORM t.ok(t.err_super('update public.ihub_audit_events set action = ''x.y.z''') = '23514'
               AND t.err_super('delete from public.ihub_audit_events') = '23514'
               AND t.err_super('truncate public.ihub_audit_events') = '23514', '⑩ التدقيق إلحاقي');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.ihub_audit_events WHERE detail::text ~* '(secret|token|AAAAAAAA|ciphertext)'), '⑩ التدقيق بلا أسرار');
  PERFORM t.ok(jsonb_array_length(t.call(t.u('OA'), 'public.ihub_audit_list(100)')) > 5
               AND jsonb_array_length(t.call(t.u('OB'), 'public.ihub_audit_list(100)')) < 5, '⑩ كل شركة ترى سجلها');
  -- سلة ألغت التثبيت
  PERFORM t.svc(format('public.ihub_svc_store_credentials(%L::uuid, %L, 1, now() + interval ''1 day'')', t.conn('CA', 'salla'), repeat('S', 40)));
  PERFORM t.svc(format('public.ihub_svc_activate(%L::uuid, %L, %L, null, null)', t.conn('CA', 'salla'), '1803665367', 'متجر سلة'));
  PERFORM t.ok(jsonb_array_length(t.svc('public.ihub_svc_tokens_due(172800)')) = 1, '⑩ رمز يقترب من الانتهاء');
  PERFORM t.svc(format('public.ihub_svc_revoked_by_provider(%L::uuid, %L)', t.conn('CA', 'salla'), 'app.uninstalled'));
  PERFORM t.ok((SELECT status FROM public.ihub_connections WHERE id = t.conn('CA', 'salla')) = 'reauth_required'
               AND NOT EXISTS (SELECT 1 FROM public.ihub_credentials WHERE connection_id = t.conn('CA', 'salla')), '⑩ إلغاء التثبيت يحذف الرموز');
  RAISE NOTICE 'PASS ⑩ الفصل يحذف الأسرار والنسخ ولا يمس التذاكر؛ الربط المفصول لا يعود؛ التدقيق إلحاقي';
END $$;

-- ══ ⑪ الاحتفاظ ══════════════════════════════════════════════════════════
DO $$
DECLARE v jsonb; c uuid := t.conn('CA', 'woocommerce'); r jsonb;
BEGIN
  r := t.svc(format('public.ihub_svc_apply_record(%L::uuid, %L, %L, %L, %L::jsonb, null, null, null, true)', c, 'order', '700', '#700', '{}'));
  PERFORM t.svc(format('public.ihub_svc_ingest_event(%L::uuid, %L, %L, %L, %L, null)', c, 'order.updated', md5('old') || md5('old'), 'order', '999'));
  UPDATE public.ihub_webhook_events SET received_at = now() - interval '15 days' WHERE dedupe_key = md5('old') || md5('old');
  UPDATE public.ihub_external_records SET fetched_at = now() - interval '31 days' WHERE id = (r->>'record_id')::uuid;
  INSERT INTO public.ihub_request_nonces VALUES (c, 'expiredexpiredexp', now() - interval '1 minute');
  UPDATE public.ihub_intake_requests SET decided_at = now() - interval '181 days' WHERE status = 'dismissed';
  UPDATE public.ihub_intake_requests SET created_at = now() - interval '181 days'
   WHERE id = (SELECT id FROM public.ihub_intake_requests WHERE status = 'new' ORDER BY created_at LIMIT 1);
  v := public.ihub_retention_sweep();
  PERFORM t.ok((v->>'events')::int >= 1 AND (v->>'records')::int = 1 AND (v->>'nonces')::int >= 1 AND (v->>'intake')::int = 2, '⑪ ' || v::text);
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.ihub_intake_requests WHERE status = 'converted'), '⑪ الطلب المحوَّل حديثًا باقٍ');
  -- النسخة بلا pg_cron؛ الترحيل يجدول فقط حين يوجد المخطط (كما في الإنتاج)
  PERFORM t.ok(to_regnamespace('cron') IS NULL, '⑪ (النسخة بلا pg_cron — الجدولة تُفحص بعد التطبيق في الإنتاج)');
  RAISE NOTICE 'PASS ⑪ الاحتفاظ: الأحداث 14 يومًا، النسخ غير المربوطة 30 يومًا، الطلبات المحسومة 180 يومًا';
END $$;

-- ══ ⑫ عدم المساس، إعادة التشغيل، التراجع ═══════════════════════════════
DO $$
BEGIN
  PERFORM t.ok(t.untouched_digest() = (SELECT v FROM t.saved WHERE k = 'untouched'), '⑫ الشركات والردود والفريق والتكاملات القائمة لم تتغير');
  PERFORM t.ok(t.fn_digest() = (SELECT v FROM t.saved WHERE k = 'fn'), '⑫ دوال integration_* والشركة كما هي');
  PERFORM t.ok(t.policy_digest() = (SELECT v FROM t.saved WHERE k = 'pol'), '⑫ لا سياسة قائمة تغيّرت');
  PERFORM t.ok((SELECT md5(string_agg(md5(x::text), ',' order by x.id)) FROM public.tickets x
                 WHERE x.id IN (t.u('TA1'), t.u('TA2'), t.u('TB1'), t.u('TOA')))
               = (SELECT v FROM t.saved WHERE k = 'tickets'), '⑫ التذاكر القائمة لم تتغير');
  RAISE NOTICE 'PASS ⑫ لا مساس بأي جدول أو دالة أو سياسة قائمة';
END $$;
INSERT INTO t.saved VALUES ('rows', (SELECT count(*) FROM public.ihub_connections)::text || '/' || (SELECT count(*) FROM public.ihub_audit_events)::text);

\i migrations/087_integrations_hub.sql
DO $$
BEGIN
  PERFORM t.ok((SELECT count(*) FROM public.ihub_connections)::text || '/' || (SELECT count(*) FROM public.ihub_audit_events)::text
               = (SELECT v FROM t.saved WHERE k = 'rows'), '⑫ إعادة التشغيل لا تمس البيانات');
  PERFORM t.ok((SELECT bool_and(enabled) FROM public.ihub_providers), '⑫ إعادة التشغيل لا تعيد قفل مزوّد فعّله المالك');
  PERFORM t.ok(t.fn_digest() = (SELECT v FROM t.saved WHERE k = 'fn'), '⑫ ولا تمس دوال integration_*');
  RAISE NOTICE 'PASS ⑫ إعادة تشغيل 087 آمنة';
END $$;

\set rollback_sql `cat migrations/_rollback/087_integrations_hub.down.sql`
SELECT set_config('t.rollback_sql', :'rollback_sql', false) IS NOT NULL;
DO $$
DECLARE c text;
BEGIN
  PERFORM t.dblink_connect('rb', format('dbname=%s port=%s host=%s user=postgres', current_database(),
            current_setting('port'), split_part(current_setting('unix_socket_directories'), ',', 1)));
  BEGIN
    PERFORM t.dblink_exec('rb', current_setting('t.rollback_sql'));
    c := 'ok';
  EXCEPTION WHEN others THEN c := sqlerrm;
  END;
  PERFORM t.dblink_disconnect('rb');
  PERFORM t.ok(c LIKE '%rollback_discard_data%', '⑫ رفض التراجع: ' || c);
  PERFORM t.ok(to_regclass('public.ihub_connections') IS NOT NULL, '⑫ التراجع رفض ولم يمس شيئًا');
  RAISE NOTICE 'PASS ⑫ التراجع يرفض مع وجود روابط';
END $$;

SET integrations_hub.rollback_discard_data = 'on';
\i migrations/_rollback/087_integrations_hub.down.sql
RESET integrations_hub.rollback_discard_data;
DO $$
BEGIN
  PERFORM t.ok(to_regclass('public.ihub_connections') IS NULL AND to_regprocedure('public.ihub_overview()') IS NULL, '⑫ التراجع حذف الكائنات');
  PERFORM t.ok(t.fn_digest() = (SELECT v FROM t.saved WHERE k = 'fn'), '⑫ دوال integration_* الإنتاجية باقية كما هي بعد التراجع');
  PERFORM t.ok(t.policy_digest() = (SELECT v FROM t.saved WHERE k = 'pol'), '⑫ السياسات القائمة كما كانت');
  PERFORM t.ok(to_regclass('public.integration_clients') IS NOT NULL AND to_regclass('public.external_integrations') IS NOT NULL, '⑫ جداول التكامل القائمة باقية');
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.tickets WHERE id = t.u('TA1')), '⑫ التذاكر باقية');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE key = 'integrations_hub')
               AND NOT EXISTS (SELECT 1 FROM public.plan_features WHERE feature_key = 'integrations_hub'), '⑫ المفتاح ومنحه حُذفا');
  RAISE NOTICE 'PASS ⑫ التراجع بإذن صريح يحذف 087 كاملًا ويترك الباقي كما كان';
END $$;

\i migrations/087_integrations_hub.sql
DO $$
BEGIN
  PERFORM t.ok((SELECT count(*) FROM public.ihub_connections) = 0 AND NOT EXISTS (SELECT 1 FROM public.ihub_providers WHERE enabled),
               '⑫ إعادة التطبيق: بداية نظيفة ومقفلة');
  RAISE NOTICE 'PASS ⑫ إعادة التطبيق بعد التراجع';
END $$;

SELECT 'ALL integrations-hub checks PASSED';
