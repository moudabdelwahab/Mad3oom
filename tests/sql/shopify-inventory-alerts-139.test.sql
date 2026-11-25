-- ============================================================================
-- 139_shopify_inventory_alerts على نسخة مطابقة للإنتاج + 118 + 119 + 120
--
--   ① 139 مرتين: الجداول بلا صلاحيات مباشرة، دوال 120 كما هي، الكتالوج 61
--      بلا عمليات checkout مهمل أو شحن، الدوال الداخلية مغلقة
--   ② البوابة: الامتياز (integrations_hub + shopify_integration + shopify_management)،
--      العزل بين المتجرين، صلاحية store.inventory (المدير يملكها، الموظف والمشرف لا
--      إلا بمنح)، المعاينة ترفض
--   ③ الحدود: تحقق المدخلات، إنشاء وتحديث (صف واحد لكل نطاق/متغير)، قائمة
--      (حد المتجر أولًا)، حذف يحلّ التنبيهات المفتوحة ولا يمحوها
--   ④ التقرير: تنبيه مفتوح واحد لكل حد، إشعار واحد لمالك الشركة عند أول عبور
--      (بلا تكرار ما دام مفتوحًا)، الحلّ عند عودة الكمية فوق الحد، تجاهل
--      العناصر بلا حد مطابق، عدّادات صحيحة
--   ④أ حد المتجر: تنبيه وإشعار من التقرير، وعنصر ناقص (بلا available أو بلا
--      min_quantity) يُتجاهل ولا يحلّ تنبيهًا مفتوحًا
--   ⑤ العزل: حدود متجر لا تُرى ولا تُبلَّغ من متجر آخر
--   ⑥ التراجع يرفض مع سجل تنبيهات، يعيد حالة 120، ثم إعادة التطبيق
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
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;

\i migrations/118_ecommerce_store_accounts.sql
\i migrations/119_shopify_store_integration.sql
\i migrations/120_shopify_store_management.sql
\i migrations/120_shopify_store_management.sql
SET search_path = public, extensions;

DO $$
BEGIN
  INSERT INTO t.saved VALUES
    ('catalog_120', (select md5(string_agg(key||perm||risk||confirm, ',' order by key)) from public._ihub_shopify_op_catalog())),
    ('fn_authorize', t.fn_md5('public.ihub_shopify_op_authorize(uuid,text,text,text)')),
    ('fn_status', t.fn_md5('public.ihub_shopify_manage_status(uuid)')),
    ('fn_gate', t.fn_md5('public._ihub_shopify_op_gate(uuid,text)')),
    ('fn_catalog', t.fn_md5('public._ihub_shopify_op_catalog()'));
END $$;

\i migrations/139_shopify_inventory_alerts.sql
\i migrations/139_shopify_inventory_alerts.sql
SET search_path = public, extensions;

-- ── متجران (كما في اختبار 120) ───────────────────────────────────────────
INSERT INTO auth.users (id, email, email_confirmed_at)
SELECT t.s(n), lower(n) || '@store.test', now() - interval '30 days' FROM unnest(array['ST','SC','SG','SS','SX','XC']) n;
INSERT INTO public.profiles (id, email, full_name, role, phone, created_at) VALUES
  (t.s('ST'), 'st@store.test', 'تاجر أ', 'user', '01200000001', '2026-09-01'),
  (t.s('SX'), 'sx@store.test', 'تاجر ب', 'user', '01200000002', '2026-09-01');
UPDATE public.subscription_plans SET price_monthly = 1, price_yearly = 10, is_active = true WHERE key = 'store';
DO $$
DECLARE r jsonb; u text;
BEGIN
  FOREACH u IN ARRAY array['ST', 'SX'] LOOP
    r := t.call(t.s(u), format('public.submit_store_account_request(%L, %L, ''2030-01-01'')', 'متجر ' || u, 'CR-' || u || '-139'));
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
DECLARE r jsonb;
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
  INSERT INTO public.company_feature_overrides (company_id, feature_key, reason)
  VALUES (t.sv('co_ST')::uuid, 'shopify_management', 'اختبار 139'),
         (t.sv('co_SX')::uuid, 'shopify_management', 'اختبار 139');
END $$;

-- ══ ① 139 قابل لإعادة التشغيل؛ 120 كما هو ═══════════════════════════════
DO $$
BEGIN
  PERFORM t.ok((select count(*) from public._ihub_shopify_op_catalog()) = 61, '① الكتالوج ما زال 61 عملية');
  PERFORM t.ok((select md5(string_agg(key||perm||risk||confirm, ',' order by key)) from public._ihub_shopify_op_catalog()) = t.sv('catalog_120'), '① الكتالوج لم يتغير');
  PERFORM t.ok(not exists (select 1 from public._ihub_shopify_op_catalog()
                            where key ~* 'checkout|shipping|delivery'), '① لا عمليات checkout أو شحن في الكتالوج');
  PERFORM t.ok(t.fn_md5('public.ihub_shopify_op_authorize(uuid,text,text,text)') = t.sv('fn_authorize')
               and t.fn_md5('public.ihub_shopify_manage_status(uuid)') = t.sv('fn_status')
               and t.fn_md5('public._ihub_shopify_op_gate(uuid,text)') = t.sv('fn_gate')
               and t.fn_md5('public._ihub_shopify_op_catalog()') = t.sv('fn_catalog'), '① دوال 120 لم تتغير');
  PERFORM t.ok(to_regclass('public.ihub_shopify_inventory_thresholds') is not null
               and to_regclass('public.ihub_shopify_inventory_alerts') is not null, '① الجداول موجودة');
  PERFORM t.ok(not has_table_privilege('authenticated', 'public.ihub_shopify_inventory_thresholds', 'SELECT')
               and not has_table_privilege('authenticated', 'public.ihub_shopify_inventory_alerts', 'INSERT')
               and not has_table_privilege('service_role', 'public.ihub_shopify_inventory_thresholds', 'SELECT'), '① لا صلاحيات مباشرة');
  PERFORM t.ok(t.exec(t.s('ST'), 'select 1 from public.ihub_shopify_inventory_thresholds') = '42501', '① الحدود لا تُقرأ مباشرة');
  PERFORM t.ok(not has_function_privilege('authenticated', 'public._ihub_shopify_threshold_gate(uuid)', 'EXECUTE'), '① البوابة الداخلية مغلقة');
  PERFORM t.ok(not has_function_privilege('anon', 'public.ihub_shopify_thresholds_list(uuid)', 'EXECUTE')
               and not has_function_privilege('anon', 'public.ihub_shopify_inventory_alerts_report(uuid,jsonb)', 'EXECUTE'), '① anon بلا شيء');
  RAISE NOTICE 'PASS ① 139 قابل لإعادة التشغيل؛ الكتالوج 61 بلا checkout أو شحن؛ دوال 120 كما هي';
END $$;

-- ══ ② البوابة ════════════════════════════════════════════════════════════
DO $$
DECLARE ca text := t.sv('cn_a'); cb text := t.sv('cn_b');
BEGIN
  PERFORM t.ok(t.errd(t.s('SX'), format('public.ihub_shopify_thresholds_list(%L)', ca)) LIKE 'P0002|%not_found%', '② ربط متجر آخر غير موجود له');
  PERFORM t.ok(t.errd(t.s('SC'), format('public.ihub_shopify_thresholds_list(%L)', ca)) LIKE 'P0002|%not_a_store%', '② عميل المتجر لا يدخل');
  -- كاختبار 120 §③: خفض حد رؤية الربط إلى agent أولًا، وإلا حُجب الربط عن
  -- الموظف والمشرف بـ not_found قبل أن يصلا إلى فحص store.inventory.
  PERFORM t.call(t.s('ST'), format('public.ihub_set_view_role(%L, ''agent'')', ca));
  PERFORM t.ok(t.errd(t.s('SG'), format('public.ihub_shopify_thresholds_list(%L)', ca)) LIKE '42501|%forbidden%', '② الموظف بلا store.inventory');
  PERFORM t.ok(t.errd(t.s('SS'), format('public.ihub_shopify_thresholds_list(%L)', ca)) LIKE '42501|%forbidden%', '② المشرف بلا store.inventory افتراضيًا');
  INSERT INTO public.company_role_permissions (company_id, role, permission_key, allowed)
  VALUES (t.sv('co_ST')::uuid, 'supervisor', 'store.inventory', true);
  PERFORM t.ok(t.err(t.s('SS'), format('public.ihub_shopify_thresholds_list(%L)', ca)) = 'ok', '② المشرف بعد منح store.inventory');
  PERFORM t.ok(t.err(t.s('ST'), format('public.ihub_shopify_thresholds_list(%L)', ca)) = 'ok', '② المدير يملكها');
  DELETE FROM public.company_feature_overrides WHERE company_id = t.sv('co_ST')::uuid AND feature_key = 'shopify_management';
  PERFORM t.ok(t.errd(t.s('ST'), format('public.ihub_shopify_thresholds_list(%L)', ca)) LIKE '42501|%management_not_enabled%', '② بلا امتياز الإدارة');
  INSERT INTO public.company_feature_overrides (company_id, feature_key, reason)
  VALUES (t.sv('co_ST')::uuid, 'shopify_management', 'اختبار 139');
  UPDATE public.ihub_providers SET enabled = false WHERE key = 'shopify';
  PERFORM t.ok(t.err(t.s('ST'), format('public.ihub_shopify_thresholds_list(%L)', ca)) = 'P0002', '② المزوّد المقفل');
  UPDATE public.ihub_providers SET enabled = true WHERE key = 'shopify';
  -- المعاينة (كما في اختبار 120 §⑩): المالك في سياق معاينة عضو شركة لا يعبر
  PERFORM t.ctx('company_user_preview');
  PERFORM t.ok(t.err(t.u('OW'), format('public.ihub_shopify_thresholds_list(%L)', ca)) <> 'ok', '② المعاينة لا تعبر');
  PERFORM t.ctx(null);
  RAISE NOTICE 'PASS ② البوابة: امتياز الإدارة + عزل المتجرين + store.inventory + معاينة مرفوضة';
END $$;

-- ══ ③ الحدود: تحقق وإنشاء وتحديث وقائمة وحذف ═════════════════════════════
DO $$
DECLARE
  ca text := t.sv('cn_a');
  v jsonb; v_id text; w_id text;
  ITEM constant text := 'gid://shopify/InventoryItem/111';
  VAR constant text := 'gid://shopify/ProductVariant/201';
BEGIN
  PERFORM t.ok(t.errd(t.s('ST'), format('public.ihub_shopify_threshold_set(%L, ''product'', null, null, null, 5)', ca)) LIKE '22023|%validation_failed%', '③ نطاق غير صالح');
  PERFORM t.ok(t.errd(t.s('ST'), format('public.ihub_shopify_threshold_set(%L, ''variant'', ''111'', %L, null, 5)', ca, VAR)) LIKE '22023|%validation_failed%', '③ معرّف صنف غير gid');
  PERFORM t.ok(t.errd(t.s('ST'), format('public.ihub_shopify_threshold_set(%L, ''variant'', %L, ''201'', null, 5)', ca, ITEM)) LIKE '22023|%validation_failed%', '③ معرّف متغير غير gid');
  PERFORM t.ok(t.errd(t.s('ST'), format('public.ihub_shopify_threshold_set(%L, ''store'', null, null, null, -1)', ca)) LIKE '22023|%validation_failed%', '③ حد سالب');
  PERFORM t.ok(t.errd(t.s('ST'), format('public.ihub_shopify_threshold_set(%L, ''store'', null, null, null, 1000000)', ca)) LIKE '22023|%validation_failed%', '③ حد فوق المدى');
  PERFORM t.ok(t.errd(t.s('ST'), format('public.ihub_shopify_threshold_set(%L, ''store'', %L, null, null, 5)', ca, ITEM)) LIKE '22023|%validation_failed%', '③ حد المتجر بلا متغير');
  v := t.call(t.s('ST'), format('public.ihub_shopify_threshold_set(%L, ''store'', null, null, null, 5)', ca));
  PERFORM t.ok((v->>'min_quantity') = '5' and (v->>'scope') = 'store', '③ حد المتجر يُنشأ');
  v := t.call(t.s('ST'), format('public.ihub_shopify_threshold_set(%L, ''store'', null, null, null, 0)', ca));
  PERFORM t.ok((v->>'min_quantity') = '0' and (select count(*) from public.ihub_shopify_inventory_thresholds
                                                where company_id = t.sv('co_ST')::uuid and scope = 'store') = 1, '③ حد المتجر يُحدَّث بلا صف ثانٍ (0 = النفاد)');
  INSERT INTO t.saved VALUES ('th_store', v->>'id');
  v := t.call(t.s('ST'), format('public.ihub_shopify_threshold_set(%L, ''variant'', %L, %L, ''قميص — L'', 3)', ca, ITEM, VAR));
  v_id := v->>'id';
  INSERT INTO t.saved VALUES ('th_var', v_id);
  PERFORM t.ok((v->>'min_quantity') = '3' and (v->>'product_title') = 'قميص — L', '③ حد المتغير يُنشأ');
  v := t.call(t.s('ST'), format('public.ihub_shopify_threshold_set(%L, ''variant'', %L, %L, ''قميص — L'', 7)', ca, ITEM, VAR));
  PERFORM t.ok((v->>'id') = v_id and (v->>'min_quantity') = '7'
               and (select count(*) from public.ihub_shopify_inventory_thresholds
                     where company_id = t.sv('co_ST')::uuid and scope = 'variant') = 1, '③ حد المتغير يُحدَّث بلا صف ثانٍ');
  v := t.call(t.s('ST'), format('public.ihub_shopify_thresholds_list(%L)', ca));
  PERFORM t.ok(jsonb_array_length(v) = 2 and (v->0->>'scope') = 'store' and (v->1->>'scope') = 'variant', '③ القائمة: حد المتجر أولًا ثم المتغيرات');
  PERFORM t.ok(t.err(t.s('ST'), format('public.ihub_shopify_threshold_delete(%L, ''00000000-0000-4000-8000-000000000000'')', ca)) = 'P0002', '③ حذف حد غير موجود');
  w_id := (t.call(t.s('ST'), format('public.ihub_shopify_threshold_set(%L, ''variant'', ''gid://shopify/InventoryItem/222'', ''gid://shopify/ProductVariant/202'', ''بنطال'', 2)', ca)))->>'id';
  PERFORM t.ok((t.call(t.s('ST'), format('public.ihub_shopify_threshold_delete(%L, %L)', ca, w_id))->>'deleted')::boolean, '③ حذف حد متغير');
  PERFORM t.ok(not exists (select 1 from public.ihub_shopify_inventory_thresholds where id = w_id::uuid), '③ الصف حُذف فعلًا');
  PERFORM t.ok(exists (select 1 from public.ihub_audit_events where action = 'shopify.threshold.set'
                        and detail->>'scope' = 'variant'), '③ الضبط مسجَّل في تدقيق ihub');
  RAISE NOTICE 'PASS ③ الحدود: تحقق صارم، إنشاء/تحديث بلا تكرار، قائمة مرتبة، حذف';
END $$;

-- ══ ④ التقرير: تنبيه واحد + إشعار واحد + حلّ ═════════════════════════════
DO $$
DECLARE
  ca text := t.sv('cn_a');
  th text := t.sv('th_var');
  ITEM constant text := 'gid://shopify/InventoryItem/111';
  r jsonb; n int;
BEGIN
  PERFORM t.ok(t.errd(t.s('ST'), format('public.ihub_shopify_inventory_alerts_report(%L, ''{}''::jsonb)', ca)) LIKE '22023|%validation_failed%', '④ مدخل ليس مصفوفة');
  r := t.call(t.s('ST'), format('public.ihub_shopify_inventory_alerts_report(%L, %L)',
    ca, jsonb_build_array(jsonb_build_object('threshold_id', th, 'inventory_item_id', ITEM, 'product_title', 'قميص — L', 'available', 2, 'min_quantity', 7))));
  PERFORM t.ok((r->>'notified') = '1' and (r->>'open') = '1' and (r->>'skipped') = '0', '④ أول عبور: تنبيه واحد — ' || (r::text));
  PERFORM t.ok((select count(*) from public.ihub_shopify_inventory_alerts where threshold_id = th::uuid and status = 'open') = 1, '④ تنبيه مفتوح واحد');
  SELECT count(*) INTO n FROM public.notifications WHERE user_id = t.s('ST') AND category = 'store' AND reference_id = th::uuid;
  PERFORM t.ok(n = 1, '④ إشعار واحد لمالك الشركة');
  PERFORM t.ok(exists (select 1 from public.notifications where user_id = t.s('ST') and category = 'store' and reference_id = th::uuid
                        and type = 'warning' and link = '/company-dashboard/index.html#storeManage'
                        and title like 'تنبيه مخزون:%' and message like '%وصل مخزون%'), '④ الإشعار: تحذير، رابط إدارة المتجر، عنوان ورسالة عربيان');
  r := t.call(t.s('ST'), format('public.ihub_shopify_inventory_alerts_report(%L, %L)',
    ca, jsonb_build_array(jsonb_build_object('threshold_id', th, 'inventory_item_id', ITEM, 'product_title', 'قميص — L', 'available', 1, 'min_quantity', 7))));
  PERFORM t.ok((r->>'notified') = '0' and (r->>'open') = '1', '④ تقرير ثانٍ تحت الحد: بلا إشعار جديد ما دام مفتوحًا');
  SELECT count(*) INTO n FROM public.notifications WHERE user_id = t.s('ST') AND category = 'store' AND reference_id = th::uuid;
  PERFORM t.ok(n = 1, '④ ما زال إشعارًا واحدًا');
  r := t.call(t.s('ST'), format('public.ihub_shopify_inventory_alerts_report(%L, %L)',
    ca, jsonb_build_array(
      jsonb_build_object('threshold_id', th, 'inventory_item_id', ITEM, 'product_title', 'قميص — L', 'available', 9, 'min_quantity', 7),
      jsonb_build_object('threshold_id', '00000000-0000-4000-8000-000000000000', 'inventory_item_id', ITEM, 'available', 0, 'min_quantity', 7),
      jsonb_build_object('threshold_id', th, 'inventory_item_id', 'bad', 'available', 0, 'min_quantity', 7))));
  PERFORM t.ok((r->>'resolved') = '1' and (r->>'skipped') = '2' and (r->>'open') = '0', '④ عودة فوق الحد تحلّ التنبيه؛ بلا حد مطابق أو شكل سيئ يُتجاهل — ' || (r::text));
  PERFORM t.ok((select status from public.ihub_shopify_inventory_alerts where threshold_id = th::uuid) = 'resolved', '④ التنبيه محلول لا محذوف');
  r := t.call(t.s('ST'), format('public.ihub_shopify_inventory_alerts_report(%L, %L)',
    ca, jsonb_build_array(jsonb_build_object('threshold_id', th, 'inventory_item_id', ITEM, 'product_title', 'قميص — L', 'available', 0, 'min_quantity', 7))));
  PERFORM t.ok((r->>'notified') = '1' and (r->>'open') = '1', '④ عبور جديد بعد الحلّ: تنبيه وإشعار جديدان');
  PERFORM t.ok((select count(*) from public.notifications where user_id = t.s('ST') and category = 'store' and reference_id = th::uuid) = 2, '④ إشعاران إجمالًا (واحد لكل عبور منفصل)');
  RAISE NOTICE 'PASS ④ التقرير: تنبيه واحد لكل حد، إشعار واحد لكل عبور، حلّ عند التعافي';
END $$;

-- ══ ④أ حد المتجر: تنبيه وإشعار من التقرير + عناصر ناقصة تُتجاهل بلا حلّ ═══
DO $$
DECLARE
  ca text := t.sv('cn_a');
  th text := t.sv('th_store');
  ITEM constant text := 'gid://shopify/InventoryItem/111';
  r jsonb;
BEGIN
  -- تنبيه المتغير من §④ ما زال مفتوحًا، فالعدّاد المفتوح هنا يشمل الاثنين.
  PERFORM t.call(t.s('ST'), format('public.ihub_shopify_threshold_set(%L, ''store'', null, null, null, 5)', ca));
  r := t.call(t.s('ST'), format('public.ihub_shopify_inventory_alerts_report(%L, %L)',
    ca, jsonb_build_array(jsonb_build_object('threshold_id', th, 'inventory_item_id', ITEM, 'product_title', 'قميص — L', 'available', 2, 'min_quantity', 5))));
  PERFORM t.ok((r->>'notified') = '1' and (r->>'open') = '2' and (r->>'skipped') = '0', '④أ حد المتجر تحت الحد: تنبيه وإشعار — ' || (r::text));
  r := t.call(t.s('ST'), format('public.ihub_shopify_inventory_alerts_report(%L, %L)',
    ca, jsonb_build_array(jsonb_build_object('threshold_id', th, 'inventory_item_id', ITEM, 'product_title', 'قميص — L', 'available', 1, 'min_quantity', 5))));
  PERFORM t.ok((r->>'notified') = '0' and (r->>'open') = '2', '④أ تقرير ثانٍ تحت الحد: بلا إشعار جديد');
  -- عنصر بلا available وآخر بلا min_quantity: يُتجاهلان ولا يحلّان التنبيه المفتوح
  -- (قبل الإصلاح كانا يمران للفرع «فوق الحد» فيحلّان التنبيه خطأً).
  r := t.call(t.s('ST'), format('public.ihub_shopify_inventory_alerts_report(%L, %L)',
    ca, jsonb_build_array(
      jsonb_build_object('threshold_id', th, 'inventory_item_id', ITEM, 'product_title', 'قميص — L', 'min_quantity', 5),
      jsonb_build_object('threshold_id', th, 'inventory_item_id', ITEM, 'product_title', 'قميص — L', 'available', 1))));
  PERFORM t.ok((r->>'skipped') = '2' and (r->>'notified') = '0' and (r->>'resolved') = '0' and (r->>'open') = '2', '④أ عناصر ناقصة تُتجاهل بلا حلّ للتنبيه — ' || (r::text));
  PERFORM t.ok((select count(*) from public.ihub_shopify_inventory_alerts where threshold_id = th::uuid and status = 'open') = 1, '④أ تنبيه حد المتجر ما زال مفتوحًا');
  r := t.call(t.s('ST'), format('public.ihub_shopify_inventory_alerts_report(%L, %L)',
    ca, jsonb_build_array(jsonb_build_object('threshold_id', th, 'inventory_item_id', ITEM, 'product_title', 'قميص — L', 'available', 9, 'min_quantity', 5))));
  PERFORM t.ok((r->>'resolved') = '1' and (r->>'open') = '1', '④أ عودة فوق الحد تحلّ تنبيه حد المتجر (وبقي تنبيه المتغير)');
  RAISE NOTICE 'PASS ④أ حد المتجر: تنبيه وإشعار واحد، عناصر ناقصة تُتجاهل بلا حلّ';
END $$;

-- ══ ⑤ العزل بين المتجرين ════════════════════════════════════════════════
DO $$
DECLARE ca text := t.sv('cn_a'); cb text := t.sv('cn_b'); v jsonb;
BEGIN
  PERFORM t.ok(jsonb_array_length(t.call(t.s('SX'), format('public.ihub_shopify_thresholds_list(%L)', cb))) = 0, '⑤ متجر ب بلا حدود');
  PERFORM t.ok(t.errd(t.s('SX'), format('public.ihub_shopify_threshold_set(%L, ''store'', null, null, null, 9)', ca)) LIKE 'P0002|%not_found%', '⑤ متجر ب لا يضبط حدًا على ربط أ');
  v := t.call(t.s('ST'), format('public.ihub_shopify_inventory_alerts_report(%L, %L)',
    ca, jsonb_build_array(jsonb_build_object('threshold_id', t.sv('th_var'), 'inventory_item_id', 'gid://shopify/InventoryItem/111', 'available', 9, 'min_quantity', 7))));
  PERFORM t.ok((v->>'resolved') = '1', '⑤ التقرير من صاحبه يحلّ تنبيهه');
  v := t.call(t.s('SX'), format('public.ihub_shopify_inventory_alerts_report(%L, %L)',
    cb, jsonb_build_array(jsonb_build_object('threshold_id', t.sv('th_var'), 'inventory_item_id', 'gid://shopify/InventoryItem/111', 'available', 0, 'min_quantity', 7))));
  PERFORM t.ok((v->>'skipped') = '1' and (v->>'notified') = '0', '⑤ تقرير متجر ب عن حد أ: يُتجاهل بلا إشعار');
  PERFORM t.ok((select count(*) from public.notifications where user_id = t.s('ST') and category = 'store') = 3, '⑤ إشعارات مالك أ لم تزد (2 من §④ + 1 من §④أ)');
  RAISE NOTICE 'PASS ⑤ العزل: حدود وتنبيهات وإشعارات كل متجر له وحده';
END $$;

-- ══ ⑥ التراجع ════════════════════════════════════════════════════════════
\set ON_ERROR_STOP off
BEGIN;
\i migrations/_rollback/139_shopify_inventory_alerts.down.sql
ROLLBACK;
\set ON_ERROR_STOP on
DO $$
BEGIN
  PERFORM t.ok(to_regclass('public.ihub_shopify_inventory_alerts') is not null, '⑥ التراجع رُفض مع سجل تنبيهات');
END $$;
BEGIN;
SET LOCAL mad3oom.rollback_discard_shopify_alerts = 'on';
\i migrations/_rollback/139_shopify_inventory_alerts.down.sql
COMMIT;
DO $$
BEGIN
  PERFORM t.ok(to_regclass('public.ihub_shopify_inventory_thresholds') is null
               and to_regprocedure('public.ihub_shopify_threshold_set(uuid,text,text,text,text,integer)') is null
               and to_regprocedure('public.ihub_shopify_inventory_alerts_report(uuid,jsonb)') is null, '⑥ الكائنات حُذفت');
  PERFORM t.ok((select md5(string_agg(key||perm||risk||confirm, ',' order by key)) from public._ihub_shopify_op_catalog()) = t.sv('catalog_120'), '⑥ الكتالوج كما بعد 120');
  PERFORM t.ok(t.fn_md5('public.ihub_shopify_op_authorize(uuid,text,text,text)') = t.sv('fn_authorize'), '⑥ دوال 120 كما هي');
END $$;
\i migrations/139_shopify_inventory_alerts.sql
SET search_path = public, extensions;
DO $$
BEGIN
  PERFORM t.ok(to_regclass('public.ihub_shopify_inventory_thresholds') is not null
               and (select count(*) from public.ihub_shopify_inventory_alerts) = 0, '⑥ إعادة التطبيق');
  RAISE NOTICE 'PASS ⑥ التراجع يرفض مع سجل، يعيد حالة 120، وإعادة التطبيق تنجح';
  RAISE NOTICE 'ALL 139 SHOPIFY INVENTORY ALERTS TESTS PASSED';
END $$;
