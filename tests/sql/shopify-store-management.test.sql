-- ============================================================================
-- 120_shopify_store_management على نسخة مطابقة للإنتاج + 118 + 119
--
--   ① 120 مرتين: الامتياز غير ممنوح لأي باقة، الصلاحيات مطفأة افتراضيًا، الكتالوج متسق،
--      لا صلاحيات مباشرة، دوال 119 والمزوّدون كما هم، Shopify مقفل
--   ② البوابة: المزوّد المقفل، الامتياز (integrations_hub + shopify_integration + shopify_management)
--   ③ الصلاحيات: المدير، المشرف والموظف بلا صلاحية ثم بمنحها، السحب على مستوى المستخدم، min_view_role
--   ④ النطاقات: ربط قديم للقراءة فقط = missing_scope للكتابة والقراءة تعمل؛ write_x يغطي read_x
--   ⑤ التأكيد: مطلوب، مربوط بالمستخدم والعملية والمدخلات، لمرة واحدة، ينتهي، واحد معلّق لكل عملية
--   ⑥ العزل: متجر ↔ متجر، شركة عادية، عميل المتجر، طاقم المنصة، المالك، المعاينة
--   ⑦ الحدود: القراءة 60، الكتابة 20/مستخدم و100/شركة، الحذف 5، التأكيد 30
--   ⑧ السجل: requested ← نتيجة الخادم مرة واحدة، تحقق الحقول، سجل للمدير وحده، unknown للمعلّق
--   ⑨ حالة الإدارة لكل عملية
--   ⑩ المالك: امتياز الإدارة لمتجره التجريبي وحده
--   ⑪ التراجع يرفض مع سجل، يعيد حالة 119، ثم إعادة التطبيق
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
-- نداء تفويض كتابة بلا تأكيد / بتأكيد
CREATE FUNCTION t.auth(p uuid, p_conn text, p_op text, p_input text, p_token text default null) RETURNS text LANGUAGE sql AS $$
  select t.errd(p, format('public.ihub_shopify_op_authorize(%L, %L, %L, %L)', p_conn, p_op, t.h(p_input),
                          case when p_token is null then null else t.h(p_token) end)) $$;
CREATE FUNCTION t.confirm(p uuid, p_conn text, p_op text, p_input text, p_token text) RETURNS text LANGUAGE sql AS $$
  select t.errd(p, format('public.ihub_shopify_op_confirm_begin(%L, %L, %L, %L)', p_conn, p_op, t.h(p_input), t.h(p_token))) $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;

\i migrations/118_ecommerce_store_accounts.sql
\i migrations/119_shopify_store_integration.sql
SET search_path = public, extensions;

DO $$
BEGIN
  INSERT INTO t.saved VALUES
    ('catalog_119', (select md5(string_agg(key||default_supervisor||default_agent, ',' order by key)) from public.company_permission_catalog)),
    ('caps_119', (select md5(string_agg(key||capabilities::text, ',' order by key)) from public.ihub_providers)),
    ('others_119', (select md5(string_agg(key||enabled||capabilities::text, ',' order by key)) from public.ihub_providers where key <> 'shopify')),
    ('fn_lookup', t.fn_md5('public.ihub_authorize_lookup(uuid,text,text)')),
    ('fn_gate', t.fn_md5('public._ihub_shopify_admin(uuid)')),
    ('fn_test_ent', t.fn_md5('public.owner_store_test_entitlements(boolean,integer,text)')),
    ('fn_begin', t.fn_md5('public.ihub_shopify_begin(uuid,text,text,text)')),
    ('pilot_119', (select pg_get_constraintdef(oid) from pg_constraint where conname = 'company_feature_overrides_pilot_only'));
END $$;

\i migrations/120_shopify_store_management.sql
\i migrations/120_shopify_store_management.sql
SET search_path = public, extensions;

-- ── متجران وشركة عادية (كما في اختبار 119) ───────────────────────────────
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
    r := t.call(t.s(u), format('public.submit_store_account_request(%L, %L, ''2030-01-01'')', 'متجر ' || u, 'CR-' || u || '-120'));
    r := t.call(t.u('AD'), format('public.admin_review_company_account_request(%L, ''approve'')', r->>'id'));
    INSERT INTO t.saved VALUES ('co_' || u, r->>'company_id');
    INSERT INTO public.whatsapp_subscriptions (user_id, plan, status, billing_cycle, start_date, end_date, duration_days, company_id)
    VALUES (t.s(u), 'store', 'active', 'monthly', now() - interval '1 day', now() + interval '29 days', 30, (r->>'company_id')::uuid);
  END LOOP;
END $$;
INSERT INTO public.profiles (id, email, full_name, role, phone, super_user_id, created_at) VALUES
  (t.s('SC'), 'sc@store.test', 'عميل المتجر', 'user', '01200000011', t.s('ST'), '2026-09-01'),
  (t.s('SG'), 'sg@store.test', 'موظف المتجر', 'user', '01200000021', t.s('ST'), '2026-09-01'),
  (t.s('SS'), 'ss@store.test', 'مشرف المتجر', 'user', '01200000022', t.s('ST'), '2026-09-01'),
  (t.s('XC'), 'xc@store.test', 'عميل ب', 'user', '01200000031', t.s('SX'), '2026-09-01');
DO $$
DECLARE r jsonb; c text;
BEGIN
  PERFORM t.call(t.s('ST'), format('public.company_staff_set(%L::uuid, %L)', t.s('SG'), 'agent'));
  PERFORM t.call(t.s('ST'), format('public.company_staff_set(%L::uuid, %L)', t.s('SS'), 'supervisor'));
  UPDATE public.ihub_providers SET enabled = true WHERE key = 'shopify';
  r := t.call(t.s('ST'), 'public.ihub_prepare_connection(''shopify'', ''متجري'')');
  INSERT INTO t.saved VALUES ('cn_a', r->>'id');
  r := t.call(t.s('SX'), 'public.ihub_prepare_connection(''shopify'')');
  INSERT INTO t.saved VALUES ('cn_b', r->>'id');
  PERFORM t.svc(format('public.ihub_svc_activate(%L, ''shop-a.myshopify.com'', ''متجر أ'', ''https://shop-a.myshopify.com'', %L)', t.sv('cn_a'), t.s('ST')));
  PERFORM t.svc(format('public.ihub_svc_activate(%L, ''shop-b.myshopify.com'', ''متجر ب'', ''https://shop-b.myshopify.com'', %L)', t.sv('cn_b'), t.s('SX')));
  -- ربط أ قديم: نطاقات القراءة الثلاثة فقط (كما يُنشأ قبل 120)
  PERFORM t.svc(format('public.ihub_svc_set_shop_details(%L, array[''read_orders'',''read_customers'',''read_products''], ''gid://shopify/Shop/1'')', t.sv('cn_a')));
  PERFORM t.svc(format('public.ihub_svc_set_shop_details(%L, array[''write_products'',''read_orders'',''read_customers''], ''gid://shopify/Shop/2'')', t.sv('cn_b')));
  PERFORM t.ok(t.call(t.s('SG'), 'public.company_staff_role()') #>> '{}' = 'agent', 'HARNESS SG agent');
END $$;

-- ══ ① 120 ════════════════════════════════════════════════════════════════
DO $$
BEGIN
  PERFORM t.ok(exists (select 1 from public.feature_flags where key = 'shopify_management'), '① الامتياز معرَّف');
  PERFORM t.ok(not exists (select 1 from public.plan_features where feature_key = 'shopify_management'), '① ولا تمنحه أي باقة');
  PERFORM t.ok((select count(*) from public.company_permission_catalog
                 where key in ('store.catalog', 'store.inventory', 'store.orders_manage', 'store.customers_manage',
                               'store.discounts', 'store.fulfillment', 'store.returns')
                   and not default_supervisor and not default_agent) = 7, '① سبع صلاحيات مطفأة افتراضيًا');
  PERFORM t.ok((select count(*) from public._ihub_shopify_op_catalog()) = 61, '① 61 عملية');
  PERFORM t.ok(not exists (select 1 from public._ihub_shopify_op_catalog() where risk = 'destructive' and not confirm), '① كل حذف/إلغاء بتأكيد');
  PERFORM t.ok(not exists (select 1 from public._ihub_shopify_op_catalog() where risk <> 'read' and not exists (
                 select 1 from unnest(scopes) s where s like 'write\_%')), '① كل كتابة تطلب نطاق كتابة');
  PERFORM t.ok(not exists (select 1 from public._ihub_shopify_op_catalog() where key ~* 'refund|capture|transaction|mark_paid|complete'), '① لا عمليات مالية');
  PERFORM t.ok(not has_table_privilege('authenticated', 'public.ihub_shopify_ops', 'SELECT')
               and not has_table_privilege('service_role', 'public.ihub_shopify_confirmations', 'SELECT'), '① لا صلاحيات مباشرة');
  PERFORM t.ok(t.exec(t.s('ST'), 'select 1 from public.ihub_shopify_ops') = '42501', '① السجل لا يُقرأ مباشرة');
  PERFORM t.ok(not has_function_privilege('authenticated', 'public.ihub_svc_shopify_op_result(uuid,text,text,text,jsonb)', 'EXECUTE'), '① نتيجة الخادم ليست لـauthenticated');
  PERFORM t.ok(not has_function_privilege('authenticated', 'public._ihub_shopify_op_gate(uuid,text)', 'EXECUTE')
               and not has_function_privilege('authenticated', 'public._ihub_shopify_op_catalog()', 'EXECUTE'), '① الداخلية مغلقة');
  PERFORM t.ok(not has_function_privilege('anon', 'public.ihub_shopify_op_authorize(uuid,text,text,text)', 'EXECUTE'), '① anon بلا شيء');
  PERFORM t.ok(t.fn_md5('public.ihub_authorize_lookup(uuid,text,text)') = t.sv('fn_lookup')
               and t.fn_md5('public._ihub_shopify_admin(uuid)') = t.sv('fn_gate')
               and t.fn_md5('public.owner_store_test_entitlements(boolean,integer,text)') = t.sv('fn_test_ent')
               and t.fn_md5('public.ihub_shopify_begin(uuid,text,text,text)') = t.sv('fn_begin'), '① دوال 119 لم تتغير');
  PERFORM t.ok((select md5(string_agg(key||enabled||capabilities::text, ',' order by key)) from public.ihub_providers where key <> 'shopify')
               = t.sv('others_119'), '① المزوّدون الآخرون كما هم');
  PERFORM t.ok((select capabilities->>'write_operations' = 'implemented_unverified' and capabilities->>'financial_operations' = 'not_implemented'
                  from public.ihub_providers where key = 'shopify'), '① بيانات Shopify الوصفية');
  RAISE NOTICE 'PASS ① 120 قابل لإعادة التشغيل؛ لا امتياز لباقة؛ صلاحيات مطفأة؛ دوال 119 كما هي';
END $$;

-- ══ ② البوابة والامتياز ══════════════════════════════════════════════════
DO $$
DECLARE ca text := t.sv('cn_a');
BEGIN
  PERFORM t.ok(t.errd(t.s('ST'), format('public.ihub_shopify_op_authorize(%L, ''shop.info'', null)', ca)) LIKE '42501|%management_not_enabled%', '② بلا امتياز الإدارة');
  PERFORM t.ok((t.call(t.s('ST'), format('public.ihub_shopify_manage_status(%L)', ca))->>'reason') = 'management_not_enabled', '② الحالة تقول السبب');
  PERFORM t.ok(not (t.call(t.s('ST'), format('public.ihub_shopify_manage_status(%L)', ca))->>'entitled')::boolean, '② غير مستحق ⇒ OAuth بنطاقات القراءة');
  INSERT INTO public.company_feature_overrides (company_id, feature_key, reason) VALUES (t.sv('co_ST')::uuid, 'shopify_management', 'اختبار 120');
  PERFORM t.ok(t.err(t.s('ST'), format('public.ihub_shopify_op_authorize(%L, ''shop.info'', null)', ca)) = 'ok', '② بالامتياز: يمر');
  PERFORM t.ok(t.errd(t.s('ST'), format('public.ihub_shopify_op_authorize(%L, ''product.drop_all'', null)', ca)) LIKE '22023|%validation_failed%', '② عملية غير معروفة');
  PERFORM t.ok(t.errd(t.s('SX'), format('public.ihub_shopify_op_authorize(%L, ''shop.info'', null)', t.sv('cn_b'))) LIKE '42501|%management_not_enabled%', '② امتياز أ لا يعبر لمتجر ب');
  UPDATE public.ihub_providers SET enabled = false WHERE key = 'shopify';
  PERFORM t.ok(t.err(t.s('ST'), format('public.ihub_shopify_op_authorize(%L, ''shop.info'', null)', ca)) = 'P0002', '② المزوّد المقفل');
  PERFORM t.ok((t.call(t.s('ST'), format('public.ihub_shopify_manage_status(%L)', ca))->>'reason') = 'provider_disabled', '② والحالة');
  UPDATE public.ihub_providers SET enabled = true WHERE key = 'shopify';
  UPDATE public.ihub_connections SET status = 'pending' WHERE id = ca::uuid;
  PERFORM t.ok((select (x->>'entitled')::boolean and x->>'reason' = 'connection_inactive'
                  from (select t.call(t.s('ST'), format('public.ihub_shopify_manage_status(%L)', ca)) x) s), '② ربط معلّق مستحق ⇒ OAuth بنطاقات الإدارة');
  UPDATE public.ihub_connections SET status = 'active' WHERE id = ca::uuid;
  UPDATE public.ihub_providers SET enabled = true WHERE key = 'shopify';
  UPDATE public.whatsapp_subscriptions SET status = 'expired' WHERE user_id = t.s('ST') AND plan = 'store';
  PERFORM t.ok(t.errd(t.s('ST'), format('public.ihub_shopify_op_authorize(%L, ''shop.info'', null)', ca)) LIKE '42501|%not_entitled%', '② الاشتراك المنتهي');
  UPDATE public.whatsapp_subscriptions SET status = 'active' WHERE user_id = t.s('ST') AND plan = 'store';
  UPDATE public.ihub_connections SET status = 'reauth_required' WHERE id = ca::uuid;
  PERFORM t.ok(t.err(t.s('ST'), format('public.ihub_shopify_op_authorize(%L, ''shop.info'', null)', ca)) = 'P0002', '② الربط الذي يحتاج إعادة تفويض');
  UPDATE public.ihub_connections SET status = 'active' WHERE id = ca::uuid;
  RAISE NOTICE 'PASS ② الإدارة تحتاج المزوّد والامتيازات الثلاثة وربطًا نشطًا';
END $$;

-- ══ ③ الصلاحيات ══════════════════════════════════════════════════════════
DO $$
DECLARE ca text := t.sv('cn_a');
BEGIN
  PERFORM t.ok(t.err(t.s('SS'), format('public.ihub_shopify_op_authorize(%L, ''product.list'', null)', ca)) = 'P0002', '③ المشرف تحت min_view_role');
  PERFORM t.call(t.s('ST'), format('public.ihub_set_view_role(%L, ''agent'')', ca));
  PERFORM t.ok(t.errd(t.s('SS'), format('public.ihub_shopify_op_authorize(%L, ''product.list'', null)', ca)) LIKE '42501|%forbidden%', '③ المشرف بلا store.catalog');
  PERFORM t.ok(t.errd(t.s('SG'), format('public.ihub_shopify_op_authorize(%L, ''inventory.levels'', null)', ca)) LIKE '42501|%forbidden%', '③ الموظف بلا store.inventory');
  PERFORM t.ok(t.err(t.s('SG'), format('public.ihub_shopify_op_authorize(%L, ''order.get'', null)', ca)) = 'ok', '③ القراءة بـstore.orders القائمة');
  INSERT INTO public.company_role_permissions (company_id, role, permission_key, allowed) VALUES (t.sv('co_ST')::uuid, 'supervisor', 'store.catalog', true);
  PERFORM t.ok(t.err(t.s('SS'), format('public.ihub_shopify_op_authorize(%L, ''product.list'', null)', ca)) = 'ok', '③ بعد منح الدور');
  INSERT INTO public.company_user_permissions (company_id, user_id, permission_key, allowed) VALUES (t.sv('co_ST')::uuid, t.s('SS'), 'store.catalog', false);
  PERFORM t.ok(t.errd(t.s('SS'), format('public.ihub_shopify_op_authorize(%L, ''product.list'', null)', ca)) LIKE '42501|%forbidden%', '③ السحب للمستخدم يغلب');
  DELETE FROM public.company_user_permissions WHERE user_id = t.s('SS') AND permission_key = 'store.catalog';
  PERFORM t.ok(t.errd(t.s('SG'), format('public.ihub_shopify_op_authorize(%L, ''order.cancel'', %L)', ca, t.h('x'))) LIKE '42501|%forbidden%', '③ الإلغاء بلا store.orders_manage');
  PERFORM t.ok(t.errd(t.s('SC'), format('public.ihub_shopify_op_authorize(%L, ''shop.info'', null)', ca)) LIKE 'P0002|%not_a_store%', '③ عميل المتجر لا يدخل');
  RAISE NOTICE 'PASS ③ صلاحية لكل عملية من الخادم، والمنح والسحب يعملان';
END $$;

-- ══ ④ النطاقات ═══════════════════════════════════════════════════════════
DO $$
DECLARE ca text := t.sv('cn_a'); v text;
BEGIN
  v := t.auth(t.s('ST'), ca, 'product.create', 'p1');
  PERFORM t.ok(v LIKE '42501|%missing_scope%', '④ ربط القراءة فقط: لا كتابة — ' || v);
  PERFORM t.ok(t.err(t.s('ST'), format('public.ihub_shopify_op_authorize(%L, ''product.get'', null)', ca)) = 'ok', '④ والقراءة تعمل كما كانت');
  PERFORM t.ok(t.err(t.s('ST'), format('public.ihub_shopify_op_authorize(%L, ''location.list'', null)', ca)) <> 'ok', '④ المواقع تحتاج read_locations');
  PERFORM t.svc(format('public.ihub_svc_set_shop_details(%L, array[''write_products'',''read_orders'',''write_customers'',''write_inventory'',''read_locations'',''write_orders'',''write_discounts'',''write_merchant_managed_fulfillment_orders'',''write_returns'',''write_publications'',''write_draft_orders''])', ca));
  PERFORM t.ok(t.auth(t.s('ST'), ca, 'product.create', 'p1') = 'ok', '④ بعد إعادة التفويض: الكتابة تمر');
  PERFORM t.ok(t.err(t.s('ST'), format('public.ihub_shopify_op_authorize(%L, ''product.get'', null)', ca)) = 'ok', '④ write_products يغطي read_products');
  PERFORM t.ok(t.err(t.s('ST'), format('public.ihub_shopify_op_authorize(%L, ''inventory.levels'', null)', ca)) = 'ok', '④ write_inventory يغطي read_inventory');
  PERFORM t.ok(public._ihub_scopes_missing(array['read_products'], array['write_products']) = array['write_products'], '④ القراءة لا تغطي الكتابة');
  PERFORM t.ok(public._ihub_scopes_missing(array['write_orders'], array['read_orders', 'read_products']) = array['read_products'], '④ الناقص فقط');
  RAISE NOTICE 'PASS ④ النطاق لكل عملية من الخادم؛ الربط القديم يبقى قراءة';
END $$;

-- ══ ⑤ التأكيد ════════════════════════════════════════════════════════════
DO $$
DECLARE ca text := t.sv('cn_a'); v text; n int;
BEGIN
  PERFORM t.ok(t.auth(t.s('ST'), ca, 'product.delete', 'del-77') LIKE '22023|%confirmation_required%', '⑤ الحذف بلا تأكيد مرفوض');
  PERFORM t.ok(t.confirm(t.s('ST'), ca, 'product.create', 'p1', 'tok0') LIKE '22023|%validation_failed%', '⑤ عملية بلا تأكيد لا تُصدر رمزًا');
  PERFORM t.ok(t.confirm(t.s('ST'), ca, 'product.delete', 'del-77', 'tok1') = 'ok', '⑤ إصدار التأكيد');
  PERFORM t.ok(exists (select 1 from public.ihub_audit_events where action = 'shopify.confirm.issued' and detail->>'op' = 'product.delete'), '⑤ الإصدار مسجَّل');
  PERFORM t.ok(not exists (select 1 from public.ihub_shopify_confirmations where token_hash = t.h('tok1') and input_hash <> t.h('del-77')), '⑤ البصمة وحدها مخزّنة');
  PERFORM t.ok(t.auth(t.s('ST'), ca, 'product.delete', 'del-78', 'tok1') LIKE '22023|%confirmation_invalid%', '⑤ مدخلات تغيّرت بعد التأكيد');
  PERFORM t.ok(t.auth(t.s('ST'), ca, 'product.archive', 'del-77', 'tok1') LIKE '22023|%confirmation_invalid%', '⑤ عملية أخرى');
  PERFORM t.call(t.s('ST'), format('public.ihub_set_view_role(%L, ''agent'')', ca));
  INSERT INTO public.company_role_permissions (company_id, role, permission_key, allowed) VALUES (t.sv('co_ST')::uuid, 'supervisor', 'store.catalog', true)
  ON CONFLICT DO NOTHING;
  PERFORM t.ok(t.auth(t.s('SS'), ca, 'product.delete', 'del-77', 'tok1') LIKE '22023|%confirmation_invalid%', '⑤ مستخدم آخر لا يستعمل تأكيدي');
  n := (select count(*) from public.ihub_shopify_ops);
  v := t.auth(t.s('ST'), ca, 'product.delete', 'del-77', 'tok1');
  PERFORM t.ok(v = 'ok', '⑤ المدخلات نفسها والمستخدم نفسه: يمر — ' || v);
  PERFORM t.ok((select count(*) from public.ihub_shopify_ops) = n + 1
               and exists (select 1 from public.ihub_shopify_ops where op = 'product.delete' and confirmed and risk = 'destructive' and status = 'requested'), '⑤ مسجَّل مؤكَّدًا');
  PERFORM t.ok(t.auth(t.s('ST'), ca, 'product.delete', 'del-77', 'tok1') LIKE '22023|%confirmation_invalid%', '⑤ لمرة واحدة');
  -- الانتهاء
  PERFORM t.confirm(t.s('ST'), ca, 'order.cancel', 'cancel-1', 'tok2');
  UPDATE public.ihub_shopify_confirmations SET expires_at = now() - interval '1 second' WHERE token_hash = t.h('tok2');
  PERFORM t.ok(t.auth(t.s('ST'), ca, 'order.cancel', 'cancel-1', 'tok2') LIKE '22023|%confirmation_invalid%', '⑤ المنتهي مرفوض');
  -- واحد معلّق لكل مستخدم وعملية: الجديد يلغي القديم
  PERFORM t.confirm(t.s('ST'), ca, 'order.cancel', 'cancel-1', 'tok3');
  PERFORM t.confirm(t.s('ST'), ca, 'order.cancel', 'cancel-1', 'tok4');
  PERFORM t.ok(t.auth(t.s('ST'), ca, 'order.cancel', 'cancel-1', 'tok3') LIKE '22023|%confirmation_invalid%', '⑤ القديم أُلغي');
  PERFORM t.ok(t.auth(t.s('ST'), ca, 'order.cancel', 'cancel-1', 'tok4') = 'ok', '⑤ الأحدث يعمل');
  PERFORM t.ok(not exists (select 1 from public.ihub_shopify_confirmations where expires_at < now()), '⑤ المنتهي يُنظَّف');
  PERFORM t.ok(t.errd(t.s('ST'), format('public.ihub_shopify_op_confirm_begin(%L, ''order.cancel'', %L, %L)', ca, t.h('same'), t.h('same'))) LIKE '22023%', '⑤ الرمز غير البصمة');
  PERFORM t.ok(t.errd(t.s('ST'), format('public.ihub_shopify_op_authorize(%L, ''product.create'', ''not-a-hash'')', ca)) LIKE '22023%', '⑤ بصمة غير صالحة');
  RAISE NOTICE 'PASS ⑤ التأكيد على الخادم: للمستخدم والعملية والمدخلات، مرة واحدة، 5 دقائق';
END $$;

-- ══ ⑥ العزل ══════════════════════════════════════════════════════════════
DO $$
DECLARE ca text := t.sv('cn_a'); cb text := t.sv('cn_b'); p text;
BEGIN
  INSERT INTO public.company_feature_overrides (company_id, feature_key, reason) VALUES (t.sv('co_SX')::uuid, 'shopify_management', 'اختبار 120 ب');
  PERFORM t.ok(t.err(t.s('SX'), format('public.ihub_shopify_op_authorize(%L, ''product.list'', null)', ca)) = 'P0002', '⑥ مدير ب لا يقرأ من ربط أ');
  PERFORM t.ok(t.auth(t.s('SX'), ca, 'product.create', 'p-x') LIKE 'P0002%', '⑥ ولا يكتب فيه');
  PERFORM t.ok(t.confirm(t.s('SX'), ca, 'product.delete', 'x', 'tok-x') LIKE 'P0002%', '⑥ ولا يصدر تأكيدًا له');
  PERFORM t.ok(t.err(t.s('SX'), format('public.ihub_shopify_manage_status(%L)', ca)) = 'P0002', '⑥ ولا يرى حالته');
  PERFORM t.ok(t.err(t.s('SX'), format('public.ihub_shopify_ops_list(%L)', ca)) = 'P0002', '⑥ ولا سجله');
  -- رمز صادر لربط أ لا يُستهلك على ربط ب
  PERFORM t.confirm(t.s('ST'), ca, 'product.delete', 'cross', 'tok-cross');
  PERFORM t.ok(t.auth(t.s('SX'), cb, 'product.delete', 'cross', 'tok-cross') LIKE '22023|%confirmation_invalid%', '⑥ تأكيد أ لا يعمل على ب');
  PERFORM t.ok(t.err(t.s('SX'), format('public.ihub_shopify_op_authorize(%L, ''product.list'', null)', cb)) = 'ok', '⑥ وب يعمل على ربطه');
  FOREACH p IN ARRAY array['OA', 'PU', 'A1', 'AD', 'EA', 'SUP'] LOOP
    PERFORM t.ok(t.err(t.u(p), format('public.ihub_shopify_op_authorize(%L, ''shop.info'', null)', ca)) <> 'ok', '⑥ ليس متجرًا أ: ' || p);
    PERFORM t.ok(t.err(t.u(p), format('public.ihub_shopify_manage_status(%L)', ca)) <> 'ok', '⑥ ولا حالة: ' || p);
  END LOOP;
  PERFORM t.ok(t.err(t.s('XC'), format('public.ihub_shopify_op_authorize(%L, ''shop.info'', null)', cb)) <> 'ok', '⑥ عميل ب لا يدخل');
  PERFORM t.ctx('admin');
  PERFORM t.ok(t.err(t.u('OW'), format('public.ihub_shopify_op_authorize(%L, ''shop.info'', null)', ca)) <> 'ok', '⑥ المالك في سياق الإدارة');
  PERFORM t.ctx('owner');
  PERFORM t.ok(t.err(t.u('OW'), format('public.ihub_shopify_op_authorize(%L, ''shop.info'', null)', ca)) <> 'ok', '⑥ ولا في سياق المالك');
  PERFORM t.ctx(null);
  PERFORM t.ok(not exists (select 1 from public.ihub_shopify_ops where company_id <> t.sv('co_ST')::uuid and connection_id = ca::uuid), '⑥ لا سجل عابر');
  RAISE NOTICE 'PASS ⑥ متجر ↔ متجر ↔ شركة ↔ عميل ↔ طاقم المنصة ↔ المالك: لا عبور';
END $$;

-- ══ ⑦ الحدود ═════════════════════════════════════════════════════════════
DO $$
DECLARE ca text := t.sv('cn_a'); co uuid := t.sv('co_ST')::uuid; i int;
BEGIN
  -- الكتابة: 20 في الدقيقة للمستخدم (SS له store.catalog)
  INSERT INTO public.ihub_shopify_ops (company_id, connection_id, actor_id, op, risk, input_hash)
  SELECT co, ca::uuid, t.s('SS'), 'product.update', 'write', t.h('rl' || g) FROM generate_series(1, 20) g;
  PERFORM t.ok(t.auth(t.s('SS'), ca, 'product.update', 'rl-x') LIKE 'P0001|%rate_limited%', '⑦ 20 كتابة في الدقيقة');
  PERFORM t.ok(t.err(t.s('SS'), format('public.ihub_shopify_op_authorize(%L, ''product.list'', null)', ca)) = 'ok', '⑦ القراءة حدها منفصل');
  DELETE FROM public.ihub_shopify_ops WHERE actor_id = t.s('SS');
  -- الحذف: 5 في الدقيقة
  INSERT INTO public.ihub_shopify_ops (company_id, connection_id, actor_id, op, risk, input_hash)
  SELECT co, ca::uuid, t.s('SS'), 'product.delete', 'destructive', t.h('d' || g) FROM generate_series(1, 5) g;
  PERFORM t.confirm(t.s('SS'), ca, 'product.delete', 'd-x', 'tok-d');
  PERFORM t.ok(t.auth(t.s('SS'), ca, 'product.delete', 'd-x', 'tok-d') LIKE 'P0001|%rate_limited%', '⑦ 5 حذف في الدقيقة');
  PERFORM t.ok(exists (select 1 from public.ihub_shopify_confirmations where token_hash = t.h('tok-d')), '⑦ التأكيد لا يُستهلك عند الحد');
  PERFORM t.ok(t.auth(t.s('SS'), ca, 'product.update', 'w-x') = 'ok', '⑦ والكتابة العادية تمر');
  DELETE FROM public.ihub_shopify_ops WHERE actor_id = t.s('SS');
  -- الشركة: 100 في الدقيقة
  INSERT INTO public.ihub_shopify_ops (company_id, connection_id, actor_id, op, risk, input_hash, created_at)
  SELECT co, ca::uuid, null, 'product.update', 'write', t.h('c' || g), now() FROM generate_series(1, 100) g;
  PERFORM t.ok(t.auth(t.s('SS'), ca, 'product.update', 'c-x') LIKE 'P0001|%rate_limited%', '⑦ 100 للشركة');
  UPDATE public.ihub_shopify_ops SET created_at = now() - interval '2 minutes' WHERE actor_id IS NULL;
  PERFORM t.ok(t.auth(t.s('SS'), ca, 'product.update', 'c-x') = 'ok', '⑦ النافذة دقيقة');
  -- القراءة: تشارك حد البحث (60)
  INSERT INTO public.ihub_audit_events (company_id, connection_id, actor_id, actor_kind, action)
  SELECT co, ca::uuid, t.s('SS'), 'user', 'data.viewed' FROM generate_series(1, 60);
  PERFORM t.ok(t.errd(t.s('SS'), format('public.ihub_shopify_op_authorize(%L, ''product.list'', null)', ca)) LIKE 'P0001|%rate_limited%', '⑦ القراءة 60');
  PERFORM t.ok(t.errd(t.s('SS'), format('public.ihub_authorize_lookup(%L, ''product'', ''search'')', ca)) LIKE 'P0001|%rate_limited%', '⑦ مشتركة مع البحث');
  -- التأكيد: 30
  INSERT INTO public.ihub_audit_events (company_id, connection_id, actor_id, actor_kind, action, detail)
  SELECT co, ca::uuid, t.s('SS'), 'user', 'shopify.confirm.issued', '{"op":"product.delete"}' FROM generate_series(1, 30);
  PERFORM t.ok(t.confirm(t.s('SS'), ca, 'variant.delete', 'v-x', 'tok-v') LIKE 'P0001|%rate_limited%', '⑦ التأكيد 30');
  RAISE NOTICE 'PASS ⑦ الحدود: قراءة 60 مشتركة، كتابة 20/100، حذف 5، تأكيد 30';
END $$;

-- ══ ⑧ السجل ══════════════════════════════════════════════════════════════
DO $$
DECLARE ca text := t.sv('cn_a'); r jsonb; v_op uuid; v jsonb;
BEGIN
  PERFORM t.confirm(t.s('ST'), ca, 'inventory.adjust', 'adj-1', 'tok-adj');
  r := t.call(t.s('ST'), format('public.ihub_shopify_op_authorize(%L, ''inventory.adjust'', %L, %L)', ca, t.h('adj-1'), t.h('tok-adj')));
  v_op := (r->>'op_id')::uuid;
  PERFORM t.ok(r->>'external_account_id' = 'shop-a.myshopify.com' and (r->>'confirmed')::boolean and not (r::text ~* 'token|cipher|secret'), '⑧ التفويض بلا أسرار');
  PERFORM t.ok(exists (select 1 from public.ihub_audit_events where action = 'shopify.write.requested' and detail->>'op_id' = v_op::text and actor_id = t.s('ST')), '⑧ الطلب في سجل التدقيق');
  PERFORM t.ok(t.svc_err(format('public.ihub_svc_shopify_op_result(%L, ''succeeded'', ''provider_rejected'')', v_op)) = '22023', '⑧ النجاح بلا رمز خطأ');
  PERFORM t.ok(t.svc_err(format('public.ihub_svc_shopify_op_result(%L, ''failed'')', v_op)) = '22023', '⑧ الفشل يحتاج رمزًا');
  PERFORM t.ok(t.svc_err(format('public.ihub_svc_shopify_op_result(%L, ''succeeded'', null, ''gid://shopify/Product/1'')', v_op)) = '22023', '⑧ شكل المرجع');
  PERFORM t.ok(t.svc_err(format('public.ihub_svc_shopify_op_result(%L, ''succeeded'', null, null, %L)', v_op, jsonb_build_object('x', repeat('a', 5000)))) = '22023', '⑧ حجم التفاصيل');
  v := t.svc(format('public.ihub_svc_shopify_op_result(%L, ''succeeded'', null, ''InventoryItem/42'', %L)', v_op,
                    '{"changes":[{"location":"Location/7","delta":-2,"reason":"damaged","quantity_after":8}]}'));
  PERFORM t.ok(v->>'status' = 'succeeded', '⑧ النتيجة');
  PERFORM t.ok((select status = 'succeeded' and resource_ref = 'InventoryItem/42' and detail->'changes'->0->>'reason' = 'damaged' and finished_at is not null
                  from public.ihub_shopify_ops where id = v_op), '⑧ كل تعديل مخزون مسجَّل بفرقه وسببه');
  PERFORM t.ok(exists (select 1 from public.ihub_audit_events where action = 'shopify.write.succeeded' and detail->>'op_id' = v_op::text and actor_id = t.s('ST') and actor_kind = 'system'), '⑧ النتيجة في سجل التدقيق باسم الطالب');
  PERFORM t.ok(t.svc_err(format('public.ihub_svc_shopify_op_result(%L, ''failed'', ''provider_rejected'')', v_op)) = 'P0002', '⑧ النتيجة مرة واحدة');
  PERFORM t.ok(t.exec(t.s('ST'), format('select public.ihub_svc_shopify_op_result(%L, ''failed'', ''x'')', v_op)) = '42501', '⑧ المستخدم لا يكتب النتيجة');
  -- عملية انقطعت: requested قديمة = unknown
  UPDATE public.ihub_shopify_ops SET created_at = now() - interval '11 minutes' WHERE status = 'requested' AND op = 'product.create';
  r := t.call(t.s('ST'), format('public.ihub_shopify_ops_list(%L, 200)', ca));
  PERFORM t.ok(exists (select 1 from jsonb_array_elements(r) x where x->>'op' = 'product.create' and x->>'status' = 'unknown'), '⑧ المعلّق القديم = غير معروف');
  PERFORM t.ok(exists (select 1 from jsonb_array_elements(r) x where x->>'id' = v_op::text and x->>'actor_name' = 'تاجر أ'), '⑧ السجل يذكر المنفّذ');
  PERFORM t.ok(t.errd(t.s('SS'), format('public.ihub_shopify_ops_list(%L)', ca)) LIKE '42501|%forbidden%', '⑧ السجل لمدير المتجر وحده');
  RAISE NOTICE 'PASS ⑧ السجل: طلب ← نتيجة من الخادم مرة واحدة، تفاصيل محدودة، للمدير وحده';
END $$;

-- ══ ⑨ حالة الإدارة ═══════════════════════════════════════════════════════
DO $$
DECLARE ca text := t.sv('cn_a'); cb text := t.sv('cn_b'); r jsonb;
BEGIN
  r := t.call(t.s('ST'), format('public.ihub_shopify_manage_status(%L)', ca));
  PERFORM t.ok((r->>'enabled')::boolean and r->>'reason' is null and jsonb_array_length(r->'ops') = 61, '⑨ مفعّل لمدير أ');
  PERFORM t.ok((select bool_and((x->>'permitted')::boolean) from jsonb_array_elements(r->'ops') x), '⑨ المدير يملك كل الصلاحيات');
  PERFORM t.ok((select x->'missing_scopes' from jsonb_array_elements(r->'ops') x where x->>'key' = 'return.list') = '[]'::jsonb, '⑨ write_returns يغطي القراءة');
  r := t.call(t.s('SG'), format('public.ihub_shopify_manage_status(%L)', ca));
  PERFORM t.ok((select (x->>'permitted')::boolean from jsonb_array_elements(r->'ops') x where x->>'key' = 'order.get')
               and not (select (x->>'permitted')::boolean from jsonb_array_elements(r->'ops') x where x->>'key' = 'order.cancel'), '⑨ الموظف: قراءة الطلب لا إلغاؤه');
  r := t.call(t.s('SX'), format('public.ihub_shopify_manage_status(%L)', cb));
  PERFORM t.ok((select x->'missing_scopes' from jsonb_array_elements(r->'ops') x where x->>'key' = 'inventory.adjust') = '["read_locations", "write_inventory"]'::jsonb, '⑨ ب: النطاقات الناقصة للمخزون');
  PERFORM t.ok((select x->'missing_scopes' from jsonb_array_elements(r->'ops') x where x->>'key' = 'product.update') = '[]'::jsonb, '⑨ ب: المنتجات متاحة');
  PERFORM t.ok(not (r::text ~* 'cipher|access_token|secret'), '⑨ بلا أسرار');
  RAISE NOTICE 'PASS ⑨ الحالة لكل عملية من الخادم';
END $$;

-- ══ ⑩ المالك ═════════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM t.ctx('owner');
  PERFORM t.ok(t.err(t.u('OW'), 'public.owner_store_test_management(true, 7, ''اختبار إدارة المتجر'')') = '42501', '⑩ بلا تحقق حديث');
  PERFORM t.stepup(t.u('OW'));
  PERFORM t.ok(t.err(t.u('OW'), 'public.owner_store_test_management(true, 7, ''اختبار إدارة المتجر'')') = '22023', '⑩ شركة المالك ليست متجرًا بعد');
  PERFORM t.call(t.u('OW'), format('public.owner_set_company_account_kind(%L, ''ecommerce_store'', ''متجر المالك التجريبي'')', t.u('CW')));
  PERFORM t.ok(t.err(t.u('OW'), 'public.owner_store_test_management(true, 7, ''قصير'')') = '22023', '⑩ السبب مطلوب');
  r := t.call(t.u('OW'), 'public.owner_store_test_management(true, 90, ''اختبار إدارة المتجر'')');
  PERFORM t.ok((select count(*) = 1 and max(expires_at) <= now() + interval '30 days 1 minute' from public.company_feature_overrides
                 where company_id = t.u('CW') and feature_key = 'shopify_management'), '⑩ امتياز واحد بحد 30 يومًا');
  PERFORM t.ok(exists (select 1 from public.privileged_audit where action = 'store.test_management.granted'), '⑩ مدقَّق');
  PERFORM t.ok(not exists (select 1 from public.company_feature_overrides where feature_key = 'shopify_management'
                            and company_id not in (t.u('CW'), t.sv('co_ST')::uuid, t.sv('co_SX')::uuid)), '⑩ لا أحد غيره');
  PERFORM t.call(t.u('OW'), 'public.owner_store_test_management(false)');
  PERFORM t.ok(not exists (select 1 from public.company_feature_overrides where company_id = t.u('CW') and feature_key = 'shopify_management'), '⑩ السحب');
  PERFORM t.ctx(null);
  PERFORM t.ok(t.err(t.u('AD'), 'public.owner_store_test_management(true, 7, ''اختبار إدارة المتجر'')') = '42501', '⑩ الأدمن مرفوض');
  PERFORM t.ok(t.err(t.s('ST'), 'public.owner_store_test_management(true, 7, ''اختبار إدارة المتجر'')') = '42501', '⑩ والتاجر');
  -- المعاينة لا تكتب
  PERFORM t.ctx('company_user_preview');
  PERFORM t.ok(t.err(t.u('OW'), format('public.ihub_shopify_op_authorize(%L, ''shop.info'', null)', t.sv('cn_a'))) <> 'ok', '⑩ المعاينة لا تعبر');
  PERFORM t.ctx(null);
  RAISE NOTICE 'PASS ⑩ المالك: امتياز الإدارة لمتجره التجريبي وحده، بتحقق حديث وسبب ومدة';
END $$;

-- ══ ⑪ التراجع ════════════════════════════════════════════════════════════
\set ON_ERROR_STOP off
BEGIN;
\i migrations/_rollback/120_shopify_store_management.down.sql
ROLLBACK;
\set ON_ERROR_STOP on
DO $$
BEGIN
  PERFORM t.ok(to_regclass('public.ihub_shopify_ops') is not null, '⑪ التراجع رُفض مع سجل');
END $$;
BEGIN;
SET LOCAL mad3oom.rollback_discard_shopify_ops = 'on';
\i migrations/_rollback/120_shopify_store_management.down.sql
COMMIT;
DO $$
BEGIN
  PERFORM t.ok(to_regclass('public.ihub_shopify_ops') is null and to_regprocedure('public.ihub_shopify_op_authorize(uuid,text,text,text)') is null, '⑪ الكائنات حُذفت');
  PERFORM t.ok((select md5(string_agg(key||default_supervisor||default_agent, ',' order by key)) from public.company_permission_catalog) = t.sv('catalog_119'), '⑪ الكتالوج كما بعد 119');
  PERFORM t.ok((select md5(string_agg(key||capabilities::text, ',' order by key)) from public.ihub_providers) = t.sv('caps_119'), '⑪ بيانات المزوّدين الوصفية كما بعد 119');
  PERFORM t.ok((select capabilities->>'write_operations' = 'missing' and not capabilities ? 'manage_products' from public.ihub_providers where key = 'shopify'), '⑪ بيانات Shopify الوصفية كما في 119');
  PERFORM t.ok((select pg_get_constraintdef(oid) from pg_constraint where conname = 'company_feature_overrides_pilot_only') = t.sv('pilot_119'), '⑪ قيد الاستثناءات');
  PERFORM t.ok(not exists (select 1 from public.feature_flags where key = 'shopify_management'), '⑪ الامتياز حُذف');
  PERFORM t.ok(t.fn_md5('public.ihub_authorize_lookup(uuid,text,text)') = t.sv('fn_lookup'), '⑪ دوال 119 كما هي');
END $$;
\i migrations/120_shopify_store_management.sql
SET search_path = public, extensions;
DO $$
BEGIN
  PERFORM t.ok(to_regclass('public.ihub_shopify_ops') is not null and (select count(*) from public._ihub_shopify_op_catalog()) = 61, '⑪ إعادة التطبيق');
  RAISE NOTICE 'PASS ⑪ التراجع يرفض مع سجل، يعيد حالة 119، وإعادة التطبيق تنجح';
  RAISE NOTICE 'ALL 120 SHOPIFY STORE MANAGEMENT TESTS PASSED';
END $$;
