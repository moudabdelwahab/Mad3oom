-- ============================================================================
-- 119_shopify_store_integration على نسخة مطابقة للإنتاج (2026-10-28) + 118
--
--   ⓪ بصمات الإنتاج لدوال 088 التي يعيد 119 تعريفها، وكتالوج الصلاحيات
--   ① 119 مرتين: Shopify مقفل، المزوّدون الآخرون كما هم، لا صلاحيات مباشرة
--   ② الربط: المزوّد المقفل، الامتياز، نوع الحساب (شركة عادية مرفوضة حتى بامتياز)
--   ③ OAuth: state مربوط بالمتجر (متجر آخر = محروق)، إكمال للمدير نفسه، متجر لشركتين مرفوض،
--      إعادة الربط للمتجر نفسه فقط
--   ④ العزل: متجر أ ↔ متجر ب ↔ شركة ↔ عميل ↔ طاقم المنصة
--   ⑤ البحث الحي: الأدوار، صلاحية store.orders، min_view_role، المعاينة، الحد، سجل الوصول
--   ⑥ المزامنة: مهمة واحدة، الإيجار، التقدّم، النجاح والعلامة، الفشل والإعادة والموت، التأجيل، المطابقة الدورية
--   ⑦ الأحداث: queued، التكرار، خارج الترتيب، حذف المزوّد، الامتثال (redact / data_request / shop/redact)
--   ⑧ دعم المتجر: التصنيفات، تصنيف التذكرة، طلبات الطلبات وحالاتها، الإسناد، التأخر، إخطار تغيّر الطلب
--   ⑨ سياق التذكرة لموظف الشركة المخوَّل (098) وأنواع ربط Shopify
--   ⑩ المالك: تشخيص بيانات وصفية بلا أسرار، والأدمن مرفوض، واختبار الامتياز على متجر المالك وحده
--   ⑪ قفل تجديد الرمز
--   ⑫ التراجع يعيد نص الإنتاج، ثم إعادة التطبيق
-- ============================================================================
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
SET client_min_messages = warning;

\i tests/fixtures/ecommerce/chain.sql

CREATE FUNCTION t.fn_md5(p regprocedure) RETURNS text LANGUAGE sql AS $$ select md5(pg_get_functiondef(p)) $$;
CREATE FUNCTION t.s(p text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  select (case p
    when 'ST' then '5a000000-0000-4000-8000-000000000001' when 'SC' then '5a000000-0000-4000-8000-000000000011'
    when 'SG' then '5a000000-0000-4000-8000-000000000021' when 'SS' then '5a000000-0000-4000-8000-000000000022'
    when 'SX' then '5b000000-0000-4000-8000-000000000001' when 'XC' then '5b000000-0000-4000-8000-000000000011'
  end)::uuid $$;
CREATE FUNCTION t.h(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ select encode(sha256(convert_to(p, 'UTF8')), 'hex') $$;
CREATE FUNCTION t.sv(p_k text) RETURNS text LANGUAGE sql AS $$ select v from t.saved where k = p_k $$;
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
  return coalesce(v, 'null'::jsonb);
exception when others then
  execute 'reset role';
  raise;
end $$;
CREATE FUNCTION t.svc_err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
begin
  perform t.svc(p_sql);
  return 'ok';
exception when others then
  return sqlstate;
end $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;

-- ══ ⓪ بصمات الإنتاج ═══════════════════════════════════════════════════════
DO $$
BEGIN
  PERFORM t.ok(t.fn_md5('public._ihub_ticket_company(uuid)') = 'd00935a83bd9d069b91a6bba49e5731e', '⓪ _ihub_ticket_company');
  PERFORM t.ok(t.fn_md5('public._ihub_ticket_viewer(uuid)') = 'fd40fb7e87d3a0bcb511da291449c7f0', '⓪ _ihub_ticket_viewer');
  PERFORM t.ok(t.fn_md5('public._ihub_connection_json(public.ihub_connections)') = '7bfda665f992d6f23df1ffea0dba40fc', '⓪ _ihub_connection_json');
  PERFORM t.ok(t.fn_md5('public.ihub_ticket_context(uuid)') = '27aa73738bfa75706b5b4689923ee797', '⓪ ihub_ticket_context');
  PERFORM t.ok(t.fn_md5('public.ihub_customer_link(uuid,uuid,text)') = '5eb27800872e54de6f47b99155eb2351', '⓪ ihub_customer_link');
  PERFORM t.ok(t.fn_md5('public.ihub_svc_claim_due_events(integer)') = 'afcba6002844789a966e1e1daee3845f', '⓪ ihub_svc_claim_due_events');
  PERFORM t.ok(t.fn_md5('public._ihub_require_admin()') = '7077ddafed498776f79c440737d83755', '⓪ _ihub_require_admin (لا يُلمس)');
  PERFORM t.ok(t.fn_md5('public.ihub_svc_apply_record(uuid,text,text,text,jsonb,text,timestamp with time zone,bigint,boolean)') = '2e24d53febcdb8ff08b24388719e7894', '⓪ apply_record (لا يُلمس)');
  PERFORM t.ok(t.fn_md5('public._company_ticket_access(uuid,text)') = '3170b61b12e4531443d243b5973947dd', '⓪ _company_ticket_access');
  PERFORM t.ok((select md5(string_agg(key||default_supervisor||default_agent, ',' order by key)) from public.company_permission_catalog)
               = 'c7cf8f4f00537acda16ca07d51cb2674', '⓪ كتالوج الصلاحيات');
  INSERT INTO t.saved VALUES ('providers', (select md5(string_agg(key||enabled||capabilities::text, ',' order by key)) from public.ihub_providers));
  RAISE NOTICE 'PASS ⓪ النسخة مطابقة للإنتاج في دوال 088 التي يمسّها 119';
END $$;

\i migrations/118_ecommerce_store_accounts.sql
\i migrations/119_shopify_store_integration.sql
\i migrations/119_shopify_store_integration.sql
SET search_path = public, extensions;

-- ── متجران وشركة عادية ────────────────────────────────────────────────────
INSERT INTO auth.users (id, email, email_confirmed_at)
SELECT t.s(n), lower(n) || '@store.test', now() - interval '30 days' FROM unnest(array['ST','SC','SG','SS','SX','XC']) n;
INSERT INTO public.profiles (id, email, full_name, role, phone, created_at) VALUES
  (t.s('ST'), 'st@store.test', 'تاجر أ', 'user', '01200000001', '2026-09-01'),
  (t.s('SX'), 'sx@store.test', 'تاجر ب', 'user', '01200000002', '2026-09-01');
UPDATE public.subscription_plans SET price_monthly = 1, price_yearly = 10, is_active = true WHERE key = 'store';  -- قيمة اختبار
DO $$
DECLARE r jsonb; u text;
BEGIN
  FOREACH u IN ARRAY array['ST', 'SX'] LOOP
    r := t.call(t.s(u), format('public.submit_store_account_request(%L, %L, ''2030-01-01'')', 'متجر ' || u, 'CR-' || u || '-119'));
    r := t.call(t.u('AD'), format('public.admin_review_company_account_request(%L, ''approve'')', r->>'id'));
    INSERT INTO t.saved VALUES ('co_' || u, r->>'company_id');
    INSERT INTO public.whatsapp_subscriptions (user_id, plan, status, billing_cycle, start_date, end_date, duration_days, company_id)
    VALUES (t.s(u), 'store', 'active', 'monthly', now() - interval '1 day', now() + interval '29 days', 30, (r->>'company_id')::uuid);
  END LOOP;
END $$;
-- عملاء وفريق المتجر أ؛ عميل المتجر ب
INSERT INTO public.profiles (id, email, full_name, role, phone, super_user_id, created_at) VALUES
  (t.s('SC'), 'sc@store.test', 'عميل المتجر', 'user', '01200000011', t.s('ST'), '2026-09-01'),
  (t.s('SG'), 'sg@store.test', 'موظف المتجر', 'user', '01200000021', t.s('ST'), '2026-09-01'),
  (t.s('SS'), 'ss@store.test', 'مشرف المتجر', 'user', '01200000022', t.s('ST'), '2026-09-01'),
  (t.s('XC'), 'xc@store.test', 'عميل ب', 'user', '01200000031', t.s('SX'), '2026-09-01');
DO $$
BEGIN
  PERFORM t.call(t.s('ST'), format('public.company_staff_set(%L::uuid, %L)', t.s('SG'), 'agent'));
  PERFORM t.call(t.s('ST'), format('public.company_staff_set(%L::uuid, %L)', t.s('SS'), 'supervisor'));
END $$;
INSERT INTO public.tickets (id, user_id, title, description) VALUES
  ('5d000000-0000-4000-8000-0000000000a1', t.s('SC'), 'أين طلبي؟', 'وصف'),
  ('5d000000-0000-4000-8000-0000000000b1', t.s('XC'), 'تذكرة ب', 'وصف');
INSERT INTO t.saved VALUES ('tk_a', '5d000000-0000-4000-8000-0000000000a1'), ('tk_b', '5d000000-0000-4000-8000-0000000000b1');
DO $$
BEGIN
  PERFORM t.ok((select scope = 'company' and company_id = t.sv('co_ST')::uuid from public.tickets where id = t.sv('tk_a')::uuid), 'HARNESS تذكرة المتجر أ مختومة بشركته');
  PERFORM t.ok(t.call(t.s('SG'), 'public.company_staff_role()') #>> '{}' = 'agent', 'HARNESS SG agent');
END $$;

-- ══ ① 119 ════════════════════════════════════════════════════════════════
DO $$
BEGIN
  PERFORM t.ok((select not enabled and auth_kind = 'oauth2' from public.ihub_providers where key = 'shopify'), '① Shopify مقفل');
  PERFORM t.ok((select md5(string_agg(key||enabled||capabilities::text, ',' order by key)) from public.ihub_providers where key <> 'shopify')
               = t.sv('providers'), '① المزوّدون الآخرون كما هم');
  PERFORM t.ok(not has_table_privilege('authenticated', 'public.store_order_requests', 'SELECT')
               and not has_table_privilege('service_role', 'public.ihub_sync_jobs', 'SELECT'), '① لا صلاحيات مباشرة');
  PERFORM t.ok(t.exec(t.s('ST'), 'select 1 from public.store_order_requests') = '42501', '① الجدول لا يُقرأ مباشرة');
  PERFORM t.ok(t.exec(t.s('ST'), 'select 1 from public.ihub_compliance_requests') = '42501', '① ولا طلبات الامتثال');
  PERFORM t.ok(not has_function_privilege('authenticated', 'public.ihub_svc_compliance(text,text,text,text[],text)', 'EXECUTE'), '① svc ليست لـ authenticated');
  PERFORM t.ok(not has_function_privilege('anon', 'public.store_overview()', 'EXECUTE'), '① anon بلا شيء');
  PERFORM t.ok((select count(*) from public.company_permission_catalog where key in ('store.orders', 'store.requests')) = 2, '① صلاحيتا المتجر في الكتالوج');
  RAISE NOTICE 'PASS ① 119 قابل لإعادة التشغيل؛ Shopify مقفل؛ الباقي كما هو';
END $$;

-- ══ ② الربط والامتياز ونوع الحساب ════════════════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM t.ok(t.errd(t.s('ST'), 'public.ihub_prepare_connection(''shopify'')') LIKE '22023|%provider_disabled%', '② المزوّد المقفل');
  UPDATE public.ihub_providers SET enabled = true WHERE key = 'shopify';
  -- شركة عادية بامتياز مركز التكاملات: الحارس على الجدول يرفض Shopify
  INSERT INTO public.company_feature_overrides (company_id, feature_key, reason) VALUES (t.u('CA'), 'integrations_hub', 'اختبار 119');
  PERFORM t.ok(t.errd(t.u('OA'), 'public.ihub_prepare_connection(''shopify'')') LIKE '42501|%not_a_store%', '② الشركة العادية لا تربط Shopify');
  PERFORM t.ok(t.err(t.s('SG'), 'public.ihub_prepare_connection(''shopify'')') = '42501', '② الموظف لا يربط');
  PERFORM t.ok(t.err(t.s('SC'), 'public.ihub_prepare_connection(''shopify'')') = '42501', '② العميل لا يربط');
  r := t.call(t.s('ST'), 'public.ihub_prepare_connection(''shopify'', ''متجري'')');
  INSERT INTO t.saved VALUES ('cn_a', r->>'id');
  r := t.call(t.s('SX'), 'public.ihub_prepare_connection(''shopify'')');
  INSERT INTO t.saved VALUES ('cn_b', r->>'id');
  PERFORM t.ok(r->>'status' = 'pending' and r ? 'granted_scopes', '② ربط معلّق بالحقول الجديدة');
  RAISE NOTICE 'PASS ② Shopify لحسابات المتاجر المستحقة ومديرها فقط';
END $$;

-- ══ ③ OAuth ══════════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb; c uuid := t.sv('cn_a')::uuid; v text;
BEGIN
  PERFORM t.ok(t.errd(t.s('ST'), format('public.ihub_shopify_begin(%L, %L, %L, ''evil.example.com'')', c, t.h('s1'), t.h('b1'))) LIKE '22023|%invalid_shop%', '③ متجر بغير myshopify مرفوض');
  PERFORM t.ok(t.errd(t.s('ST'), format('public.ihub_shopify_begin(%L, %L, %L, ''a.myshopify.com.evil.io'')', c, t.h('s1'), t.h('b1'))) LIKE '22023|%invalid_shop%', '③ لاحقة مزيّفة مرفوضة');
  PERFORM t.ok(t.err(t.s('SX'), format('public.ihub_shopify_begin(%L, %L, %L, ''shop-a.myshopify.com'')', c, t.h('s1'), t.h('b1'))) = 'P0002', '③ متجر ب لا يبدأ على ربط أ');
  r := t.call(t.s('ST'), format('public.ihub_shopify_begin(%L, %L, %L, ''shop-a.myshopify.com'')', c, t.h('s1'), t.h('b1')));
  PERFORM t.ok(r->>'shop' = 'shop-a.myshopify.com', '③ state مربوط بالمتجر');
  -- رجوع موقَّع لكن لمتجر آخر: محروق
  r := t.svc(format('public.ihub_svc_consume_shop_oauth_state(%L, ''shop-x.myshopify.com'')', t.h('s1')));
  PERFORM t.ok((r->>'mismatch')::boolean, '③ متجر غير المقصود = mismatch');
  PERFORM t.ok(t.svc(format('public.ihub_svc_consume_shop_oauth_state(%L, ''shop-a.myshopify.com'')', t.h('s1'))) = 'null'::jsonb, '③ والـstate محروق');
  -- البداية من جديد ثم المسار الصحيح
  PERFORM t.call(t.s('ST'), format('public.ihub_shopify_begin(%L, %L, %L, ''Shop-A.myshopify.com'')', c, t.h('s2'), t.h('b2')));
  r := t.svc(format('public.ihub_svc_consume_shop_oauth_state(%L, ''shop-a.myshopify.com'')', t.h('s2')));
  PERFORM t.ok(r->>'connection_id' = c::text and r->>'user_id' = t.s('ST')::text, '③ الاستهلاك يعطي الربط والمدير');
  PERFORM t.ok(t.svc(format('public.ihub_svc_consume_shop_oauth_state(%L, ''shop-a.myshopify.com'')', t.h('s2'))) = 'null'::jsonb, '③ مرة واحدة');
  PERFORM t.ok((t.svc(format('public.ihub_svc_hold_oauth_result(%L, ''ihub1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbb'', %L)', t.h('s2'), t.h('done2'))) #>> '{}')::boolean, '③ حجز النتيجة');
  PERFORM t.ok(t.svc(format('public.ihub_svc_take_oauth_result(%L, %L, %L, %L)', c, t.h('b2'), t.h('done2'), t.s('SX'))) = 'null'::jsonb, '③ مدير آخر لا يأخذها');
  PERFORM t.ok(t.svc(format('public.ihub_svc_take_oauth_result(%L, %L, %L, %L)', c, t.h('bX'), t.h('done2'), t.s('ST'))) = 'null'::jsonb, '③ بصمة تبويب خاطئة');
  v := t.svc(format('public.ihub_svc_take_oauth_result(%L, %L, %L, %L)', c, t.h('b2'), t.h('done2'), t.s('ST'))) #>> '{}';
  PERFORM t.ok(v like 'ihub1.%', '③ المدير نفسه من التبويب نفسه يأخذها');
  -- التفعيل (كما تفعل الدالة الطرفية)
  r := t.svc(format('public.ihub_svc_activate(%L, ''shop-a.myshopify.com'', ''متجر أ'', ''https://shop-a.myshopify.com'', %L)', c, t.s('ST')));
  PERFORM t.ok(r->>'status' = 'active', '③ نشط');
  PERFORM t.svc(format('public.ihub_svc_store_credentials(%L, ''ihub1.cccccccccccccccc.dddddddddddddddddddddddd'', 1, now() + interval ''1 hour'')', c));
  r := t.svc(format('public.ihub_svc_set_shop_details(%L, array[''read_orders'',''read_customers'',''read_products'',''read_orders''], ''gid://shopify/Shop/123'')', c));
  PERFORM t.ok(r->'granted_scopes' = '["read_customers","read_orders","read_products"]'::jsonb, '③ النطاقات مطبَّعة');
  PERFORM t.ok(t.svc_err(format('public.ihub_svc_set_shop_details(%L, array[''read orders; drop''])', c)) = '22023', '③ نطاق غير صالح مرفوض');
  -- المتجر نفسه لشركة ثانية: account_in_use
  PERFORM t.ok(t.svc_err(format('public.ihub_svc_activate(%L, ''shop-a.myshopify.com'', ''سرقة'', null, %L)', t.sv('cn_b'), t.s('SX'))) = '23505', '③ متجر واحد لشركة واحدة');
  -- إعادة الربط: المتجر نفسه فقط
  PERFORM t.ok(t.errd(t.s('ST'), format('public.ihub_shopify_begin(%L, %L, %L, ''shop-z.myshopify.com'')', c, t.h('s3'), t.h('b3'))) LIKE '22023|%shop_mismatch%', '③ إعادة الربط لمتجر آخر مرفوضة');
  PERFORM t.ok(t.err(t.s('ST'), format('public.ihub_shopify_begin(%L, %L, %L, ''shop-a.myshopify.com'')', c, t.h('s3'), t.h('b3'))) = 'ok', '③ وللمتجر نفسه مقبولة');
  -- متجر ب نشط على متجره
  PERFORM t.svc(format('public.ihub_svc_activate(%L, ''shop-b.myshopify.com'', ''متجر ب'', ''https://shop-b.myshopify.com'', %L)', t.sv('cn_b'), t.s('SX')));
  RAISE NOTICE 'PASS ③ OAuth مربوط بالمتجر والمدير والتبويب؛ متجر لشركة واحدة؛ إعادة الربط للمتجر نفسه';
END $$;

-- ══ ④ العزل ══════════════════════════════════════════════════════════════
DO $$
DECLARE ca text := t.sv('cn_a'); p text;
BEGIN
  PERFORM t.ok(t.err(t.s('SX'), format('public.ihub_sync_status(%L)', ca)) = 'P0002', '④ متجر ب لا يرى مزامنة أ');
  PERFORM t.ok(t.err(t.s('SX'), format('public.ihub_authorize_lookup(%L, ''order'', ''search'')', ca)) = 'P0002', '④ ولا يبحث في أ');
  PERFORM t.ok(t.err(t.s('SX'), format('public.ihub_store_record_context(%L, ''order'', ''1001'')', ca)) = 'P0002', '④ ولا سياق سجلاتها');
  PERFORM t.ok(t.err(t.s('SX'), format('public.store_ticket_meta_get(%L)', t.sv('tk_a'))) = 'P0002', '④ ولا تذاكرها');
  PERFORM t.ok(t.err(t.s('SX'), format('public.ihub_sync_request(%L)', ca)) = 'P0002', '④ ولا يطلب مزامنتها');
  FOREACH p IN ARRAY array['OA', 'PU', 'A1'] LOOP
    PERFORM t.ok(t.err(t.u(p), 'public.store_overview()') = 'P0002', '④ ليس متجرًا: ' || p);
    PERFORM t.ok(t.err(t.u(p), format('public.ihub_authorize_lookup(%L, ''order'', ''search'')', ca)) = 'P0002', '④ ولا بحث: ' || p);
  END LOOP;
  PERFORM t.ok(t.err(t.s('SC'), 'public.store_overview()') = 'P0002', '④ عميل المتجر لا يرى لوحته');
  PERFORM t.ok(t.err(t.s('SC'), format('public.ihub_authorize_lookup(%L, ''customer'', ''search'')', ca)) = 'P0002', '④ ولا بيانات Shopify');
  FOREACH p IN ARRAY array['AD', 'EA', 'SUP'] LOOP
    PERFORM t.ok(t.err(t.u(p), 'public.store_overview()') = 'P0002', '④ طاقم المنصة لا يرى المتجر: ' || p);
    PERFORM t.ok(t.err(t.u(p), format('public.ihub_sync_status(%L)', ca)) = '42501', '④ ولا مزامنته: ' || p);
    PERFORM t.ok(t.err(t.u(p), format('public.ihub_authorize_lookup(%L, ''order'', ''record'')', ca)) = 'P0002', '④ ولا بياناته: ' || p);
  END LOOP;
  PERFORM t.ctx('admin');
  PERFORM t.ok(t.err(t.u('OW'), format('public.ihub_authorize_lookup(%L, ''order'', ''record'')', ca)) <> 'ok', '④ المالك في سياق الإدارة لا يرى بيانات متجر');
  PERFORM t.ctx('owner');
  PERFORM t.ok(t.err(t.u('OW'), format('public.ihub_authorize_lookup(%L, ''order'', ''record'')', ca)) <> 'ok', '④ ولا في سياق المالك');
  PERFORM t.ctx(null);
  RAISE NOTICE 'PASS ④ متجر ↔ متجر ↔ شركة ↔ عميل ↔ طاقم المنصة: لا عبور';
END $$;

-- ══ ⑤ البحث الحي ═════════════════════════════════════════════════════════
DO $$
DECLARE ca text := t.sv('cn_a'); r jsonb; n int;
BEGIN
  n := (select count(*) from public.ihub_audit_events where action = 'data.viewed');
  r := t.call(t.s('ST'), format('public.ihub_authorize_lookup(%L, ''order'', ''search'')', ca));
  PERFORM t.ok(r->>'external_account_id' = 'shop-a.myshopify.com' and r->>'role' = 'admin', '⑤ مدير المتجر يبحث');
  PERFORM t.ok((select count(*) from public.ihub_audit_events where action = 'data.viewed') = n + 1, '⑤ كل وصول في سجل الوصول');
  PERFORM t.ok(not (r::text ~ 'ciphertext|access_token'), '⑤ بلا أسرار');
  PERFORM t.ok(t.err(t.s('SG'), format('public.ihub_authorize_lookup(%L, ''order'', ''search'')', ca)) = 'P0002', '⑤ الموظف تحت min_view_role (admin)');
  PERFORM t.call(t.s('ST'), format('public.ihub_set_view_role(%L, ''agent'')', ca));
  PERFORM t.ok(t.err(t.s('SG'), format('public.ihub_authorize_lookup(%L, ''order'', ''search'')', ca)) = 'ok', '⑤ بعد خفضه: الموظف يبحث');
  PERFORM t.ok(t.err(t.s('SG'), format('public.ihub_authorize_lookup(%L, ''invoice'', ''search'')', ca)) = '22023', '⑤ نوع غير مدعوم');
  INSERT INTO public.company_user_permissions (company_id, user_id, permission_key, allowed)
  VALUES (t.sv('co_ST')::uuid, t.s('SG'), 'store.orders', false);
  PERFORM t.ok(t.errd(t.s('SG'), format('public.ihub_authorize_lookup(%L, ''order'', ''search'')', ca)) LIKE '42501|%forbidden%', '⑤ سحب store.orders يمنع');
  DELETE FROM public.company_user_permissions WHERE user_id = t.s('SG') AND permission_key = 'store.orders';
  -- الحد: 60 في الدقيقة لكل مستخدم
  INSERT INTO public.ihub_audit_events (company_id, connection_id, actor_id, actor_kind, action)
  SELECT t.sv('co_ST')::uuid, ca::uuid, t.s('SS'), 'user', 'data.viewed' FROM generate_series(1, 60);
  PERFORM t.ok(t.errd(t.s('SS'), format('public.ihub_authorize_lookup(%L, ''order'', ''search'')', ca)) LIKE 'P0001|%rate_limited%', '⑤ الحد في الدقيقة');
  PERFORM t.ok(t.err(t.s('SG'), format('public.ihub_authorize_lookup(%L, ''order'', ''search'')', ca)) = 'ok', '⑤ الحد لكل مستخدم');
  -- الامتياز: اشتراك منتهٍ = لا بحث
  UPDATE public.whatsapp_subscriptions SET status = 'expired' WHERE user_id = t.s('ST') AND plan = 'store';
  PERFORM t.ok(t.errd(t.s('ST'), format('public.ihub_authorize_lookup(%L, ''order'', ''search'')', ca)) LIKE '42501|%not_entitled%', '⑤ المنتهي لا يبحث');
  PERFORM t.ok(t.errd(t.s('ST'), format('public.ihub_sync_request(%L)', ca)) LIKE '42501%', '⑤ ولا يزامن');
  UPDATE public.whatsapp_subscriptions SET status = 'active' WHERE user_id = t.s('ST') AND plan = 'store';
  RAISE NOTICE 'PASS ⑤ البحث الحي: الدور + store.orders + min_view_role + الامتياز + الحد، وكل وصول مسجَّل';
END $$;

-- ══ ⑥ المزامنة ═══════════════════════════════════════════════════════════
DO $$
DECLARE ca uuid := t.sv('cn_a')::uuid; r jsonb; j bigint; v jsonb; i int;
BEGIN
  r := t.svc(format('public.ihub_svc_enqueue_sync(%L, ''initial'')', ca));
  j := (r->>'job_id')::bigint;
  PERFORM t.ok(not (r->>'existing')::boolean, '⑥ مهمة أولى');
  PERFORM t.ok((t.svc(format('public.ihub_svc_enqueue_sync(%L, ''manual'')', ca))->>'existing')::boolean, '⑥ مهمة نشطة واحدة');
  PERFORM t.ok((select since_at between now() - interval '30 days 1 minute' and now() - interval '29 days' from public.ihub_sync_jobs where id = j), '⑥ نافذة 30 يومًا');
  v := t.svc('public.ihub_svc_claim_sync_jobs(5)');
  PERFORM t.ok(jsonb_array_length(v) = 1 and (v->0->>'id')::bigint = j, '⑥ الحجز');
  PERFORM t.ok(jsonb_array_length(t.svc('public.ihub_svc_claim_sync_jobs(5)')) = 0, '⑥ الإيجار يمنع حجزًا ثانيًا');
  PERFORM t.ok((t.svc(format('public.ihub_svc_sync_progress(%s, ''cursor-1'', 5, now() - interval ''2 days'')', j)) #>> '{}')::boolean, '⑥ تقدّم');
  PERFORM t.svc(format('public.ihub_svc_sync_finish(%s, ''yield'', null, true, 30)', j));
  PERFORM t.ok((select status = 'queued' and cursor = 'cursor-1' and attempts = 0 from public.ihub_sync_jobs where id = j), '⑥ التأجيل يحفظ المؤشر بلا محاولة');
  PERFORM t.ok(jsonb_array_length(t.svc('public.ihub_svc_claim_sync_jobs(5)')) = 0, '⑥ المؤجَّل غير مستحق بعد');
  UPDATE public.ihub_sync_jobs SET next_attempt_at = now() WHERE id = j;
  PERFORM t.ok(jsonb_array_length(t.svc('public.ihub_svc_claim_sync_jobs(5)')) = 1, '⑥ يُحجز حين يستحق');
  PERFORM t.svc(format('public.ihub_svc_sync_progress(%s, null, 3, now() - interval ''1 day'')', j));
  PERFORM t.svc(format('public.ihub_svc_sync_finish(%s, ''succeeded'')', j));
  PERFORM t.ok((select last_sync_status = 'succeeded' and last_sync_at is not null
                       and sync_watermark between now() - interval '1 day 1 minute' and now() - interval '23 hours'
                  from public.ihub_connections where id = ca), '⑥ النجاح يضبط آخر مزامنة والعلامة');
  PERFORM t.ok((select records = 8 and pages = 2 from public.ihub_sync_jobs where id = j), '⑥ العدّادات');
  -- الطلب اليدوي: حد دقيقتين
  PERFORM t.ok(t.errd(t.s('ST'), format('public.ihub_sync_request(%L)', ca)) LIKE 'P0001|%rate_limited%', '⑥ يدوي بعد نجاح حديث: انتظر');
  UPDATE public.ihub_sync_jobs SET finished_at = now() - interval '5 minutes' WHERE id = j;
  PERFORM t.ok(t.err(t.s('SG'), format('public.ihub_sync_request(%L)', ca)) = '42501', '⑥ الموظف لا يطلب مزامنة');
  r := t.call(t.s('ST'), format('public.ihub_sync_request(%L)', ca));
  j := (r->>'job_id')::bigint;
  PERFORM t.ok((select kind = 'manual' and since_at > now() - interval '1 day 11 minutes' from public.ihub_sync_jobs where id = j), '⑥ اليدوي تزايدي من العلامة');
  -- الفشل: إعادة بمهلة ثم dead بعد 6
  FOR i IN 1..6 LOOP
    UPDATE public.ihub_sync_jobs SET next_attempt_at = now() WHERE id = j;
    PERFORM t.svc('public.ihub_svc_claim_sync_jobs(5)');
    v := t.svc(format('public.ihub_svc_sync_finish(%s, ''failed'', ''provider_unavailable'', true)', j));
  END LOOP;
  PERFORM t.ok(v->>'status' = 'dead' and (v->>'attempts')::int = 6, '⑥ dead بعد 6: ' || v::text);
  PERFORM t.ok((select last_sync_status = 'failed' and last_sync_error_code = 'provider_unavailable' from public.ihub_connections where id = ca), '⑥ الفشل ظاهر على الربط');
  -- المطابقة الدورية: الربط بلا مزامنة حديثة وبلا مهمة نشطة
  UPDATE public.ihub_connections SET last_sync_at = now() - interval '7 hours' WHERE id = ca;
  PERFORM t.ok((t.svc('public.ihub_svc_schedule_reconciliation(360)') #>> '{}')::int = 1, '⑥ المطابقة تجدول متجر أ وحده (ب بلا اعتماد)');
  PERFORM t.ok((t.svc('public.ihub_svc_schedule_reconciliation(360)') #>> '{}')::int = 0, '⑥ ولا تكرر');
  r := t.call(t.s('ST'), format('public.ihub_sync_status(%L)', ca));
  PERFORM t.ok(jsonb_array_length(r->'jobs') = 3 and r->'connection'->>'last_sync_status' is not null, '⑥ حالة المزامنة للمدير');
  PERFORM t.ok(t.err(t.s('SS'), format('public.ihub_sync_status(%L)', ca)) = '42501', '⑥ المشرف لا يرى تشخيص الربط');
  RAISE NOTICE 'PASS ⑥ المزامنة: مهمة واحدة، إيجار، تأجيل، علامة، إعادة محدودة، مطابقة دورية';
END $$;

-- ══ ⑦ الأحداث والامتثال ═══════════════════════════════════════════════════
DO $$
DECLARE ca uuid := t.sv('cn_a')::uuid; r jsonb; v jsonb; rec uuid; n int;
BEGIN
  r := t.svc(format('public.ihub_svc_enqueue_event(%L, ''orders/updated'', %L, ''order'', ''1001'', now() - interval ''1 hour'')', ca, t.h('w1')));
  PERFORM t.ok(not (r->>'duplicate')::boolean, '⑦ حدث في الطابور');
  PERFORM t.ok((t.svc(format('public.ihub_svc_enqueue_event(%L, ''orders/updated'', %L, ''order'', ''1001'', now())', ca, t.h('w1')))->>'duplicate')::boolean, '⑦ التكرار يُكتشف');
  v := t.svc('public.ihub_svc_claim_due_events(20)');
  PERFORM t.ok(exists (select 1 from jsonb_array_elements(v) x where x->>'topic' = 'orders/updated' and x->>'external_id' = '1001'), '⑦ العامل يحجز queued مع الموضوع');
  r := t.svc(format('public.ihub_svc_apply_record(%L, ''order'', ''1001'', ''#1001'', ''{"financial_status":"paid","fulfillment_status":"unfulfilled","customer_ref":"555"}'', null, now() - interval ''1 hour'', %s, true)',
                    ca, (select (x->>'id') from jsonb_array_elements(v) x where x->>'external_id' = '1001')));
  rec := (r->>'record_id')::uuid;
  INSERT INTO t.saved VALUES ('rec_1001', rec::text);
  PERFORM t.ok((r->>'applied')::boolean, '⑦ الطلب يُنشأ من الحدث');
  PERFORM t.ok((select status from public.ihub_webhook_events where dedupe_key = t.h('w1')) = 'processed', '⑦ الحدث معالج');
  r := t.svc(format('public.ihub_svc_apply_record(%L, ''order'', ''1001'', ''#1001'', ''{"financial_status":"pending"}'', null, now() - interval ''2 hours'', null, true)', ca));
  PERFORM t.ok((r->>'stale')::boolean and (select summary->>'financial_status' from public.ihub_external_records where id = rec) = 'paid', '⑦ الأقدم لا يُطبَّق');
  -- حذف عند المزوّد: المربوط يُعلَّم، غير المربوط يُحذف
  r := t.svc(format('public.ihub_svc_apply_record(%L, ''product'', ''77'', ''قميص'', ''{"title":"قميص"}'', null, now(), null, true)', ca));
  PERFORM t.svc(format('public.ihub_svc_link_ticket(%L, %L, %L)', t.sv('tk_a'), r->>'record_id', t.s('ST')));
  PERFORM t.svc(format('public.ihub_svc_apply_record(%L, ''product'', ''78'', ''حذاء'', ''{"title":"حذاء"}'', null, now(), null, true)', ca));
  PERFORM t.ok((t.svc(format('public.ihub_svc_forget_record(%L, ''product'', ''77'', ''products_delete'')', ca))->>'kept')::boolean, '⑦ المنتج المربوط يُعلَّم');
  PERFORM t.ok((select (summary->>'deleted_in_provider')::boolean from public.ihub_external_records where connection_id = ca and external_id = '77'), '⑦ علامة الحذف');
  r := t.svc(format('public.ihub_svc_forget_record(%L, ''product'', ''78'', ''products_delete'')', ca));
  PERFORM t.ok(not (r->>'kept')::boolean, '⑦ غير المربوط لا يُعلَّم');
  PERFORM t.ok(not exists (select 1 from public.ihub_external_records where connection_id = ca and external_id = '78'), '⑦ غير المربوط يُحذف');
  -- customers/redact: يحذف سجلات العميل وطلباته المخزّنة
  PERFORM t.svc(format('public.ihub_svc_apply_record(%L, ''order'', ''1002'', ''#1002'', ''{"customer_ref":"556"}'', null, now(), null, true)', ca));
  PERFORM t.svc(format('public.ihub_svc_apply_record(%L, ''customer'', ''556'', ''عميل'', ''{"name":"عميل"}'', null, now(), null, true)', ca));
  r := t.svc('public.ihub_svc_compliance(''customers/redact'', ''shop-a.myshopify.com'', ''556'', array[''1002'',''x''], null)');
  PERFORM t.ok(r->>'status' = 'completed' and (r->>'records_deleted')::int = 2, '⑦ redact يحذف فورًا: ' || r::text);
  PERFORM t.ok(not exists (select 1 from public.ihub_external_records where connection_id = ca and external_id in ('1002', '556')), '⑦ لا بقايا');
  PERFORM t.ok(exists (select 1 from public.ihub_external_records where id = rec), '⑦ طلبات غيره باقية');
  -- customers/data_request: يُسجَّل ويُخطَر المدير ويصدّره هو وحده
  n := (select count(*) from public.notifications where user_id = t.s('ST'));
  r := t.svc('public.ihub_svc_compliance(''customers/data_request'', ''shop-a.myshopify.com'', ''555'', array[''1001''], ''9001'')');
  PERFORM t.ok(r->>'status' = 'received', '⑦ data_request مسجّل');
  PERFORM t.ok((select count(*) from public.notifications where user_id = t.s('ST')) = n + 1, '⑦ المدير مُخطَر');
  PERFORM t.ok(jsonb_array_length(t.call(t.s('ST'), 'public.ihub_compliance_list()')) = 2, '⑦ قائمة الامتثال للمدير');
  PERFORM t.ok(t.err(t.s('SX'), format('public.ihub_compliance_export(%L)', r->>'request_id')) = 'P0002', '⑦ متجر ب لا يصدّر');
  PERFORM t.ok(t.err(t.s('SS'), format('public.ihub_compliance_export(%L)', r->>'request_id')) = '42501', '⑦ ولا المشرف');
  v := t.call(t.s('ST'), format('public.ihub_compliance_export(%L)', r->>'request_id'));
  PERFORM t.ok(jsonb_array_length(v->'stored_records') = 1, '⑦ التصدير يحمل المخزّن للعميل');
  PERFORM t.ok((select status from public.ihub_compliance_requests where id = (r->>'request_id')::uuid) = 'completed', '⑦ مكتمل');
  r := t.svc('public.ihub_svc_compliance(''shop/redact'', ''nobody.myshopify.com'')');
  PERFORM t.ok(r->>'status' = 'not_applicable', '⑦ متجر غير مربوط: لا شيء');
  PERFORM t.ok(t.svc_err('public.ihub_svc_compliance(''shop/redact'', ''evil.com'')') = '22023', '⑦ نطاق غير صالح');
  -- shop/redact لمتجر ب: حذف كل شيء وفصل
  PERFORM t.svc(format('public.ihub_svc_store_credentials(%L, ''ihub1.cccccccccccccccc.dddddddddddddddddddddddd'')', t.sv('cn_b')));
  PERFORM t.svc(format('public.ihub_svc_enqueue_sync(%L, ''initial'')', t.sv('cn_b')));
  r := t.svc('public.ihub_svc_compliance(''shop/redact'', ''shop-b.myshopify.com'')');
  PERFORM t.ok(r->>'status' = 'completed', '⑦ shop/redact مكتمل');
  PERFORM t.ok((select status from public.ihub_connections where id = t.sv('cn_b')::uuid) = 'disconnected'
               and not exists (select 1 from public.ihub_credentials where connection_id = t.sv('cn_b')::uuid)
               and not exists (select 1 from public.ihub_sync_jobs where connection_id = t.sv('cn_b')::uuid and status in ('queued','running','failed')), '⑦ مفصول بلا أسرار ولا مهام');
  PERFORM t.ok((t.svc('public.ihub_svc_compliance(''customers/redact'', ''shop-b.myshopify.com'', ''1'')')->>'status') = 'completed', '⑦ بعد الفصل: مكتمل بلا حذف');
  -- app/uninstalled (088) → إعادة تفويض + إخطار
  RAISE NOTICE 'PASS ⑦ الأحداث بلا تكرار وبالترتيب، وحذف المزوّد، والامتثال الثلاثة';
END $$;

-- ══ ⑧ دعم المتجر ═════════════════════════════════════════════════════════
DO $$
DECLARE tk text := t.sv('tk_a'); rec text := t.sv('rec_1001'); r jsonb; q text; n int;
BEGIN
  PERFORM t.ok(jsonb_array_length(t.call(t.s('SG'), 'public.store_categories()')) = 10, '⑧ عشرة تصنيفات افتراضية');
  PERFORM t.ok(t.err(t.s('SG'), 'public.store_category_save(''gift_card'', ''بطاقة هدية'')') = '42501', '⑧ الموظف لا يدير التصنيفات');
  PERFORM t.ok(jsonb_array_length(t.call(t.s('ST'), 'public.store_category_save(''gift_card'', ''بطاقة هدية'', ''Gift card'')')) = 11, '⑧ تصنيف مخصص');
  PERFORM t.call(t.s('ST'), 'public.store_category_save(''other'', ''أخرى'', null, false)');
  PERFORM t.ok(t.err(t.s('ST'), 'public.store_category_save(''Bad Key'', ''x'')') = '22023', '⑧ مفتاح غير صالح');
  PERFORM t.ok(jsonb_array_length(t.call(t.s('SX'), 'public.store_categories()')) = 10, '⑧ تصنيفات أ لا تظهر لب');
  -- تصنيف التذكرة: صلاحية 098
  PERFORM t.ok(t.err(t.s('SG'), format('public.store_ticket_set_category(%L, ''shipping_delay'')', tk)) = 'P0002', '⑧ الموظف بلا رؤية التذكرة');
  PERFORM t.ok(t.err(t.s('SS'), format('public.store_ticket_set_category(%L, ''shipping_delay'')', tk)) = 'ok', '⑧ المشرف يصنّف');
  PERFORM t.ok(t.err(t.s('SS'), format('public.store_ticket_set_category(%L, ''other'')', tk)) = '22023', '⑧ تصنيف موقوف مرفوض');
  PERFORM t.ok(t.err(t.s('SX'), format('public.store_ticket_set_category(%L, ''shipping_delay'')', tk)) = 'P0002', '⑧ متجر ب لا يصنّف');
  PERFORM t.call(t.s('ST'), format('public.company_ticket_assign(%L, %L)', tk, t.s('SG')));
  PERFORM t.ok(t.call(t.s('SG'), format('public.store_ticket_meta_get(%L)', tk))->>'category_key' = 'shipping_delay', '⑧ بعد الإسناد يراها الموظف');
  -- طلبات المتجر
  PERFORM t.ok(t.errfull(t.s('SS'), format('public.store_request_create(''refund_inquiry'', %L, %L, ''يسأل عن الاسترداد'', %L)', tk, rec, t.s('SC'))) LIKE '23514%', '⑧ الإسناد لعميل مرفوض');
  n := (select count(*) from public.notifications where user_id = t.s('SG'));
  r := t.call(t.s('SS'), format('public.store_request_create(''refund_inquiry'', %L, %L, ''يسأل عن الاسترداد'', %L, now() + interval ''1 day'')', tk, rec, t.s('SG')));
  q := r->>'id';
  INSERT INTO t.saved VALUES ('rq', q);
  PERFORM t.ok(r->>'status' = 'recorded' and r->>'order_ref' = '#1001' and not (r->>'executes_in_shopify')::boolean, '⑧ طلب مسجّل لا عملية في Shopify');
  PERFORM t.ok((select count(*) from public.notifications where user_id = t.s('SG')) = n + 1, '⑧ المُسنَد إليه مُخطَر');
  PERFORM t.ok(t.err(t.s('SX'), format('public.store_request_create(''return'', null, %L)', rec)) = 'P0002', '⑧ متجر ب لا يسجّل على طلب أ');
  PERFORM t.ok(t.err(t.s('SX'), format('public.store_request_get(%L)', q)) = 'P0002', '⑧ ولا يرى طلب أ');
  PERFORM t.ok(t.err(t.s('SC'), format('public.store_request_get(%L)', q)) = 'P0002', '⑧ العميل لا يرى الطلبات الداخلية');
  PERFORM t.ok(t.err(t.s('SS'), 'public.store_request_create(''teleport'', null, null)') = '22023', '⑧ نوع غير معروف');
  r := t.call(t.s('SG'), format('public.store_request_update(%L, ''in_review'')', q));
  PERFORM t.ok(r->>'status' = 'in_review', '⑧ قيد المراجعة');
  r := t.call(t.s('SG'), format('public.store_request_update(%L, ''resolved'', null, ''تم إبلاغ العميل بمسار الاسترداد في Shopify'')', q));
  PERFORM t.ok(r->>'status' = 'resolved' and r->>'resolved_at' is not null, '⑧ محسوم في مدعوم');
  PERFORM t.ok(t.errd(t.s('SG'), format('public.store_request_update(%L, null, ''ملاحظة'')', q)) LIKE '22023|%request_closed%', '⑧ المحسوم ثابت');
  PERFORM t.ok(t.err(t.s('SS'), format('public.store_request_update(%L, ''in_review'')', q)) = '22023', '⑧ إعادة الفتح ليست للمشرف');
  PERFORM t.ok(t.call(t.s('ST'), format('public.store_request_update(%L, ''in_review'')', q))->>'status' = 'in_review', '⑧ المدير يعيد الفتح');
  PERFORM t.ok(jsonb_array_length(t.call(t.s('SS'), format('public.store_request_get(%L)', q))->'events') = 4, '⑧ كل تغيير في السجل');
  PERFORM t.ok(t.exec(t.s('ST'), format('update public.store_order_request_events set action = ''x'' where request_id = %L', q)) = '42501', '⑧ السجل لا يُكتب مباشرة');
  PERFORM t.ok(t.err_super_ok(format('update public.store_order_request_events set action = ''x.y'' where request_id = %L', q)) = '23514', '⑧ إلحاقي حتى للمالك');
  PERFORM t.ok(t.err_super_ok(format('delete from public.store_order_request_events where request_id = %L', q)) = '23514', '⑧ لا حذف مباشر');
  -- التأخر: إخطار مرة واحدة
  UPDATE public.store_order_requests SET due_at = now() - interval '1 hour' WHERE id = q::uuid;
  PERFORM t.ok((public.store_maintenance_sweep()->>'overdue_notified')::int = 1, '⑧ المتأخر يُخطَر');
  PERFORM t.ok((public.store_maintenance_sweep()->>'overdue_notified')::int = 0, '⑧ مرة واحدة');
  PERFORM t.ok((t.call(t.s('SS'), 'public.store_overview()')->>'overdue_requests')::int = 1, '⑧ والنظرة العامة تعدّه');
  -- تغيّر الطلب في Shopify (طلب متابعة مفتوح): إخطار
  n := (select count(*) from public.notifications where user_id = t.s('ST'));
  PERFORM t.svc(format('public.ihub_svc_apply_record(%L, ''order'', ''1001'', ''#1001'', ''{"financial_status":"refunded","fulfillment_status":"unfulfilled","customer_ref":"555"}'', null, now(), null, false)', t.sv('cn_a')));
  PERFORM t.ok((select count(*) from public.notifications where user_id = t.s('ST')) = n + 1, '⑧ تغيّر حالة الطلب يُخطر');
  -- التقارير
  PERFORM t.ok(t.err(t.s('SG'), 'public.store_report(30)') = '42501', '⑧ التقارير ليست للموظف');
  r := t.call(t.s('SS'), 'public.store_report(30)');
  PERFORM t.ok((r->>'ticket_volume')::int = 1 and (r->>'order_related_tickets')::int = 1
               and (r->'categories'->>'shipping_delay')::int = 1 and (r->'requests_by_kind'->>'refund_inquiry')::int = 1, '⑧ التقرير من البيانات: ' || r::text);
  -- الامتياز
  UPDATE public.whatsapp_subscriptions SET end_date = now() - interval '1 minute' WHERE user_id = t.s('ST') AND plan = 'store';
  PERFORM t.ok(t.errd(t.s('SS'), 'public.store_requests_list()') LIKE '42501|%not_entitled%', '⑧ المنتهي: لا أدوات متجر');
  PERFORM t.ok(t.err(t.s('SS'), 'public.store_overview()') = 'ok', '⑧ لكن النظرة العامة تعرض الحالة');
  UPDATE public.whatsapp_subscriptions SET end_date = now() + interval '29 days' WHERE user_id = t.s('ST') AND plan = 'store';
  RAISE NOTICE 'PASS ⑧ التصنيفات والطلبات وحالاتها والإسناد والتأخر والتقارير — كلها في حدود المتجر';
END $$;

-- ══ ⑨ سياق التذكرة ═══════════════════════════════════════════════════════
DO $$
DECLARE tk text := t.sv('tk_a'); r jsonb;
BEGIN
  r := t.call(t.s('SG'), format('public.ihub_ticket_context(%L)', tk));
  PERFORM t.ok((select x->'link_types' = '["order","customer","product"]'::jsonb from jsonb_array_elements(r->'connections') x where x->>'provider' = 'shopify'), '⑨ أنواع ربط Shopify');
  PERFORM t.ok(jsonb_array_length(r->'links') = 1, '⑨ الموظف المخوَّل يرى الربط');
  PERFORM t.ok(t.err(t.s('SC'), format('public.ihub_ticket_context(%L)', tk)) = 'P0002', '⑨ صاحب التذكرة (العميل) لا يرى سياق المتجر');
  PERFORM t.ok(t.err(t.s('SX'), format('public.ihub_ticket_context(%L)', tk)) = 'P0002', '⑨ متجر ب لا يرى');
  PERFORM t.ok(jsonb_array_length(t.call(t.s('SX'), format('public.ihub_ticket_context(%L)', t.sv('tk_b')))->'connections') = 0, '⑨ متجر ب يرى تذكرته بلا ربط حي (مفصول)');
  PERFORM t.call(t.s('ST'), format('public.company_ticket_assign(%L, null)', tk));
  PERFORM t.ok(t.err(t.s('SG'), format('public.ihub_ticket_context(%L)', tk)) = 'P0002', '⑨ بلا رؤية التذكرة لا سياق');
  -- رابط تذكرة شركة أخرى بسجل أ: المحفّز يرفض حتى للمالك
  PERFORM t.ok(t.err_super_ok(format('insert into public.ihub_ticket_links (company_id, ticket_id, record_id) values (%L, %L, %L)',
                                      t.sv('co_ST'), t.sv('tk_b'), t.sv('rec_1001'))) = '23514', '⑨ R4 بالمحفّز');
  -- ربط العميل اليدوي (096: عميل نشط لا موظف)، و Shopify مدعوم
  PERFORM t.ok(t.err(t.s('ST'), format('public.ihub_customer_link(%L, %L, ''555'')', t.sv('cn_a'), t.s('SC'))) = 'ok', '⑨ ربط عميل Shopify يدويًا');
  PERFORM t.ok(t.err(t.s('ST'), format('public.ihub_customer_link(%L, %L, ''556'')', t.sv('cn_a'), t.s('SG'))) = 'P0002', '⑨ الموظف ليس عميلًا');
  PERFORM t.ok(t.err(t.s('ST'), format('public.ihub_customer_link(%L, %L, ''557'')', t.sv('cn_a'), t.s('XC'))) = 'P0002', '⑨ عميل متجر ب ليس عميل أ');
  PERFORM t.ok((t.call(t.s('SS'), format('public.ihub_store_record_context(%L, ''customer'', ''555'')', t.sv('cn_a')))->'linked_customer'->>'customer_id') = t.s('SC')::text, '⑨ ملف العميل يجمع Shopify ومدعوم');
  RAISE NOTICE 'PASS ⑨ سياق Shopify في التذكرة لموظف الشركة المخوَّل وحده';
END $$;

-- ══ ⑩ المالك ═════════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb; p text;
BEGIN
  FOREACH p IN ARRAY array['AD', 'EA', 'SUP', 'OA'] LOOP
    PERFORM t.ok(t.err(t.u(p), 'public.owner_store_integrations()') = '42501', '⑩ ليس للمالك: ' || p);
    PERFORM t.ok(t.err(t.u(p), 'public.owner_accounts_overview()') = '42501', '⑩ ولا الحسابات: ' || p);
  END LOOP;
  PERFORM t.ok(t.err(t.s('ST'), 'public.owner_entitlement_diagnostics()') = '42501', '⑩ ولا التاجر');
  PERFORM t.ctx('admin');
  PERFORM t.ok(t.err(t.u('OW'), 'public.owner_store_integrations()') = '42501', '⑩ المالك في سياق الإدارة مرفوض');
  PERFORM t.ctx('owner');
  r := t.call(t.u('OW'), 'public.owner_store_integrations()');
  PERFORM t.ok(jsonb_array_length(r->'connections') = 1 and r->'connections'->0->>'shop' = 'shop-a.myshopify.com', '⑩ تشخيص الربط');
  PERFORM t.ok(r->'connections'->0->'missing_scopes' = '[]'::jsonb and (r->'connections'->0->>'entitled')::boolean, '⑩ النطاقات والامتياز');
  PERFORM t.ok(not (r::text ~* 'ciphertext|access_token|refresh_token|secret|"summary"|customer_ref'), '⑩ بلا أسرار ولا بيانات عملاء');
  r := t.call(t.u('OW'), 'public.owner_accounts_overview(''ecommerce_store'')');
  PERFORM t.ok((r->>'total')::int = 2 and (r->'counts'->>'ecommerce_store')::int = 2 and (r->'counts'->>'company')::int >= 2
               and (r->'counts'->>'individual')::int >= 1, '⑩ الأنواع الثلاثة: ' || (r->'counts')::text);
  PERFORM t.ok(r->'items'->0->'subscription'->>'plan' = 'store', '⑩ الاشتراك');
  PERFORM t.ok(jsonb_array_length(t.call(t.u('OW'), format('public.owner_store_events(%L)', t.sv('cn_a')))->'jobs') >= 1, '⑩ الأحداث والمهام');
  r := t.call(t.u('OW'), 'public.owner_entitlement_diagnostics()');
  PERFORM t.ok(jsonb_array_length(r->'live_connection_without_entitlement') = 0 and (r->'store_plan'->>'is_active')::boolean, '⑩ لا تعارض');
  UPDATE public.whatsapp_subscriptions SET status = 'expired' WHERE user_id = t.s('ST') AND plan = 'store';
  r := t.call(t.u('OW'), 'public.owner_entitlement_diagnostics()');
  PERFORM t.ok(jsonb_array_length(r->'live_connection_without_entitlement') = 1, '⑩ ربط حي بلا امتياز يظهر');
  UPDATE public.whatsapp_subscriptions SET status = 'active' WHERE user_id = t.s('ST') AND plan = 'store';
  -- اختبار الامتياز: متجر المالك وحده، بتحقق حديث
  PERFORM t.ok(t.err(t.u('OW'), 'public.owner_store_test_entitlements(true, 7, ''اختبار تجربة المتجر'')') = '42501', '⑩ بلا تحقق حديث');
  PERFORM t.stepup(t.u('OW'));
  PERFORM t.ok(t.err(t.u('OW'), 'public.owner_store_test_entitlements(true, 7, ''اختبار تجربة المتجر'')') = '22023', '⑩ شركة المالك ليست متجرًا بعد');
  PERFORM t.call(t.u('OW'), format('public.owner_set_company_account_kind(%L, ''ecommerce_store'', ''متجر المالك التجريبي'')', t.u('CW')));
  r := t.call(t.u('OW'), 'public.owner_store_test_entitlements(true, 90, ''اختبار تجربة المتجر'')');
  PERFORM t.ok((select count(*) = 3 and max(expires_at) <= now() + interval '30 days 1 minute' from public.company_feature_overrides where company_id = t.u('CW')), '⑩ ثلاثة امتيازات بحد 30 يومًا');
  PERFORM t.ok(not exists (select 1 from public.company_feature_overrides where company_id <> t.u('CW') and feature_key in ('shopify_integration', 'store_support')), '⑩ لا أحد غير متجر المالك');
  PERFORM t.ok(exists (select 1 from public.privileged_audit where action = 'store.test_entitlements.granted'), '⑩ مدقَّق');
  PERFORM t.call(t.u('OW'), 'public.owner_store_test_entitlements(false)');
  PERFORM t.ok(not exists (select 1 from public.company_feature_overrides where company_id = t.u('CW') and feature_key = 'shopify_integration'), '⑩ السحب');
  -- المعاينة: قراءة فقط ولا بيانات حية
  PERFORM t.call(t.u('OW'), 'public.owner_store_test_entitlements(true, 1, ''اختبار المعاينة للقراءة'')');
  PERFORM t.ctx('company_user_preview');
  PERFORM t.ok(t.err(t.u('OW'), format('public.ihub_authorize_lookup(%L, ''order'', ''search'')', t.sv('cn_a'))) <> 'ok', '⑩ المعاينة لا تعبر لمتجر آخر');
  PERFORM t.ok(t.err(t.u('OW'), 'public.store_request_create(''other'', null, null)') <> 'ok', '⑩ ولا تكتب');
  PERFORM t.ctx(null);
  RAISE NOTICE 'PASS ⑩ المالك: تشخيص وصفي في سياقه وحده، واختبار الامتياز على متجره التجريبي فقط';
END $$;

-- ══ ⑪ قفل تجديد الرمز ════════════════════════════════════════════════════
DO $$
DECLARE ca text := t.sv('cn_a');
BEGIN
  PERFORM t.ok((t.svc(format('public.ihub_svc_claim_token_refresh(%L, 30)', ca)) #>> '{}')::boolean, '⑪ القفل');
  PERFORM t.ok(not (t.svc(format('public.ihub_svc_claim_token_refresh(%L, 30)', ca)) #>> '{}')::boolean, '⑪ كاتب واحد');
  PERFORM t.svc(format('public.ihub_svc_release_token_refresh(%L)', ca));
  PERFORM t.ok((t.svc(format('public.ihub_svc_claim_token_refresh(%L, 30)', ca)) #>> '{}')::boolean, '⑪ بعد التحرير');
  PERFORM t.ok(t.err(t.s('ST'), format('public.ihub_svc_claim_token_refresh(%L, 30)', ca)) = '42501', '⑪ ليست للمستخدم');
  RAISE NOTICE 'PASS ⑪ تجديد الرمز بكاتب واحد';
END $$;

-- ══ ⑫ التراجع ════════════════════════════════════════════════════════════
\set ON_ERROR_STOP off
BEGIN;
\i migrations/_rollback/119_shopify_store_integration.down.sql
ROLLBACK;
\set ON_ERROR_STOP on
DO $$
BEGIN
  PERFORM t.ok(to_regclass('public.store_order_requests') is not null, '⑫ التراجع رُفض مع روابط وطلبات');
END $$;
-- تنظيف بيانات Shopify والمتجر (يدويًا، كما يفعل المشغّل بعد قرار صريح)
DELETE FROM public.store_order_requests;   -- الحذف المتسلسل لسجل الطلب مسموح
DO $$ BEGIN PERFORM t.ok(not exists (select 1 from public.store_order_request_events), '⑫ الحذف المتسلسل يمر'); END $$;
DELETE FROM public.ihub_connections WHERE provider = 'shopify';
\i migrations/_rollback/119_shopify_store_integration.down.sql
DO $$
BEGIN
  PERFORM t.ok(t.fn_md5('public._ihub_ticket_company(uuid)') = 'd00935a83bd9d069b91a6bba49e5731e', '⑫ _ihub_ticket_company');
  PERFORM t.ok(t.fn_md5('public._ihub_ticket_viewer(uuid)') = 'fd40fb7e87d3a0bcb511da291449c7f0', '⑫ _ihub_ticket_viewer');
  PERFORM t.ok(t.fn_md5('public._ihub_connection_json(public.ihub_connections)') = '7bfda665f992d6f23df1ffea0dba40fc', '⑫ _ihub_connection_json');
  PERFORM t.ok(t.fn_md5('public.ihub_ticket_context(uuid)') = '27aa73738bfa75706b5b4689923ee797', '⑫ ihub_ticket_context');
  PERFORM t.ok(t.fn_md5('public.ihub_customer_link(uuid,uuid,text)') = '5eb27800872e54de6f47b99155eb2351', '⑫ ihub_customer_link');
  PERFORM t.ok(t.fn_md5('public.ihub_svc_claim_due_events(integer)') = 'afcba6002844789a966e1e1daee3845f', '⑫ ihub_svc_claim_due_events');
  PERFORM t.ok(has_function_privilege('service_role', 'public.ihub_svc_claim_due_events(integer)', 'EXECUTE')
               and not has_function_privilege('authenticated', 'public.ihub_svc_claim_due_events(integer)', 'EXECUTE')
               and has_function_privilege('authenticated', 'public.ihub_ticket_context(uuid)', 'EXECUTE'), '⑫ الصلاحيات');
  PERFORM t.ok((select md5(string_agg(key||default_supervisor||default_agent, ',' order by key)) from public.company_permission_catalog)
               = 'c7cf8f4f00537acda16ca07d51cb2674', '⑫ الكتالوج');
  PERFORM t.ok((select md5(string_agg(key||enabled||capabilities::text, ',' order by key)) from public.ihub_providers) = t.sv('providers'), '⑫ المزوّدون');
  PERFORM t.ok(to_regclass('public.ihub_sync_jobs') is null and to_regprocedure('public.store_overview()') is null, '⑫ الكائنات حُذفت');
END $$;
\i migrations/119_shopify_store_integration.sql
SET search_path = public, extensions;
DO $$
BEGIN
  PERFORM t.ok(to_regclass('public.ihub_sync_jobs') is not null and exists (select 1 from public.ihub_providers where key = 'shopify' and not enabled), '⑫ إعادة التطبيق');
  RAISE NOTICE 'PASS ⑫ التراجع يرفض مع بيانات، يعيد نص الإنتاج حرفيًا، وإعادة التطبيق تنجح';
  RAISE NOTICE 'ALL 119 SHOPIFY STORE INTEGRATION TESTS PASSED';
END $$;
