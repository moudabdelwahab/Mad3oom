-- ============================================================================
-- 142_owner_requests_aggregator على نسخة مطابقة للإنتاج + 118 + 119 + 133
-- + 135 + 136 + 137 + 138 + 140 + 134 + 142 (تعويض)
--
--   ⓪ 142 مرتين: قابل لإعادة التشغيل، ودالة واحدة SECURITY DEFINER
--      للمالك وحده (authenticated بلا anon)، وبلا أي جدول جديد، وتعريفها
--      يقرأ الجداول الخمسة، وبلا أي كتابة
--   ① التجميع: 9 صفوف من الأنواع الخمسة كلها، والمعلّقة أولًا؛ التعويض
--      مرة واحدة كمصدر واحد؛ كل صف بنوعه ومصدره وحالته وتاريخه ورابطه
--      العميق لصفحته الأصلية؛ وطلب المتجر المعلّق براية قائمة المتاجر
--      ورابطها — بلا صف مكرر
--   ② المرشّحات: p_type و p_status، ورفض القيم غير الصالحة بـ 22023
--   ③ الحارس: غير المالك 42501، والمالك بلا سياق 42501
--   ④ التراجع يحذف الدالة وحدها؛ وإعادة التطبيق تعيد القائمة كاملةً
--      والجداول والصفوف بلا مساس
-- ============================================================================
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
SET client_min_messages = warning;

\i tests/fixtures/ecommerce/chain.sql

CREATE OR REPLACE FUNCTION t.sv(p_k text) RETURNS text LANGUAGE sql AS $$ select v from t.saved where k = p_k $$;
CREATE OR REPLACE FUNCTION t.svc(p_sql text) RETURNS jsonb LANGUAGE plpgsql AS $$
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
\i migrations/133_owner_store_price_and_sync_actions.sql
\i migrations/135_owner_store_plan_deactivate_pause_sync.sql
\i migrations/136_company_self_service_renewal_cancel.sql
\i migrations/137_saas_trial_3_days.sql
\i migrations/138_standalone_company_account_request.sql
\i migrations/140_company_data_export_and_deletion.sql
\i migrations/134_admin_fix_suggestions_wallet_workflows.sql
\i migrations/142_cancel_refund.sql
\i migrations/142_owner_requests_aggregator.sql
\i migrations/142_owner_requests_aggregator.sql
SET search_path = public, extensions;

-- ── بيانات الاختبار: صفان لكل نوع عدا التعويض (صف واحد — والعدّ واحد) ──
INSERT INTO public.whatsapp_subscriptions
  (user_id, company_id, plan, billing_cycle, status, start_date, end_date, duration_days,
   payment_method, price_snapshot)
VALUES
  (t.u('OA'), t.u('CA'), 'ultimate', 'monthly', 'active',
   now() - interval '20 days', now() + interval '10 days', 30,
   'bank_transfer', '{"amount": 1999, "currency": "EGP"}'::jsonb);
INSERT INTO t.saved VALUES ('sub_OA_ult_m', (select id::text from public.whatsapp_subscriptions where user_id = t.u('OA') and plan = 'ultimate' and billing_cycle = 'monthly' and duration_days = 30));

INSERT INTO public.company_account_requests
  (user_id, company_name, commercial_registration_number, commercial_registration_expiry,
   company_email, company_phone, requested_plan, requested_billing_cycle, status,
   account_kind, store_platform, store_domain_hint)
VALUES
  (t.u('OA'), 'متجر الطلب', 'CR-STORE-1', now()::date + interval '1 year',
   'store@x.test', '01000000001', 'store', 'monthly', 'pending',
   'ecommerce_store', 'shopify', 'ward.myshopify.com'),
  (t.u('OB'), 'شركة ب الجديدة', 'CR-B-NEW-1', now()::date + interval '1 year',
   'b-new@x.test', '01000000002', 'ultimate', 'yearly', 'approved',
   'company', null, null);

INSERT INTO public.saas_trial_requests
  (company_id, plan_key, requested_by, status, requested_at, trial_starts_at, trial_ends_at)
VALUES
  (t.u('CA'), 'ultimate', t.u('OA'), 'pending', now() - interval '1 day', null, null),
  (t.u('CB'), 'support', t.u('OB'), 'approved', now() - interval '2 days',
   now() - interval '1 day', now() + interval '2 days');

INSERT INTO public.refund_requests
  (company_id, user_id, subscription_id, plan, billing_cycle, cycle_days, remaining_days,
   amount_paid, refund_amount, currency, cancel_reason, status)
VALUES
  (t.u('CA'), t.u('OA'), t.sv('sub_OA_ult_m')::uuid, 'ultimate', 'monthly', 30, 10,
   1999, 666.33, 'EGP', 'إغلاق النشاط مؤقتًا', 'pending');

INSERT INTO public.company_deletion_requests
  (company_id, requested_by, reason, status, created_at)
VALUES
  (t.u('CA'), t.u('OA'), 'إغلاق النشاط نهائيًا بعد انتهاء العقود الحالية', 'pending', now() - interval '3 hours'),
  (t.u('CB'), t.u('OB'), 'إغلاق النشاط نهائيًا بعد انتهاء العقود الحالية', 'executed', now() - interval '2 days');

INSERT INTO public.suggestions
  (user_id, title, description, category, status)
VALUES
  (t.u('OA'), 'اقتراح اختبار أول', 'وصف الاقتراح الأول للاختبار', 'feature', 'pending'),
  (t.u('OB'), 'اقتراح اختبار ثانٍ', 'وصف الاقتراح الثاني للاختبار', 'general', 'implemented');

-- ══ ⓪ إعادة التطبيق والدالة والصلاحيات وبلا جدول جديد ═══════════════════
DO $$
DECLARE v_def text;
BEGIN
  PERFORM t.ok(to_regprocedure('public.owner_list_requests(text, text)') is not null, '⓪ دالة التجميع موجودة');
  PERFORM t.ok(has_function_privilege('authenticated', 'public.owner_list_requests(text, text)'::regprocedure, 'EXECUTE'), '⓪ لـ authenticated');
  PERFORM t.ok(not has_function_privilege('anon', 'public.owner_list_requests(text, text)'::regprocedure, 'EXECUTE'), '⓪ ليست لـ anon');
  PERFORM t.ok((select prosecdef from pg_proc where oid = 'public.owner_list_requests(text, text)'::regprocedure), '⓪ SECURITY DEFINER');
  PERFORM t.ok(not exists (select 1 from pg_class where relname = 'owner_requests' and relkind = 'r'), '⓪ بلا جدول جديد');
  v_def := pg_get_functiondef('public.owner_list_requests(text, text)'::regprocedure);
  PERFORM t.ok(position('company_account_requests' in v_def) > 0, '⓪ تقرأ حساب الشركة');
  PERFORM t.ok(position('saas_trial_requests' in v_def) > 0, '⓪ تقرأ التجربة');
  PERFORM t.ok(position('refund_requests' in v_def) > 0, '⓪ تقرأ التعويض');
  PERFORM t.ok(position('company_deletion_requests' in v_def) > 0, '⓪ تقرأ الحذف');
  PERFORM t.ok(position('suggestions' in v_def) > 0, '⓪ تقرأ الاقتراحات');
  PERFORM t.ok(position('insert into' in lower(v_def)) = 0, '⓪ بلا إدراج');
  PERFORM t.ok(position('update public.' in lower(v_def)) = 0, '⓪ بلا تحديث');
  PERFORM t.ok(position('delete from public.' in lower(v_def)) = 0, '⓪ بلا حذف');
  RAISE NOTICE 'PASS ⓪ 142 قابل لإعادة التشغيل؛ دالة واحدة للمالك، بلا جدول جديد وبلا كتابة';
END $$;

-- ══ ① التجميع: الأنواع الخمسة والروابط العميقة وبلا تكرار ═══════════════
DO $$
DECLARE
  r jsonb;
  v_store jsonb;
  v_company jsonb;
  v_trial jsonb;
  v_refund jsonb;
  v_deletion jsonb;
  v_suggestion jsonb;
BEGIN
  PERFORM t.ctx('owner');
  r := t.call(t.u('OW'), 'public.owner_list_requests()');
  PERFORM t.ok(jsonb_array_length(r) = 9, '① تسعة صفوف مجمّعة');
  PERFORM t.ok((select count(*) from jsonb_array_elements(r) as e(val) where e.val->>'type' = 'company_account') = 2, '① طلبا حساب شركة');
  PERFORM t.ok((select count(*) from jsonb_array_elements(r) as e(val) where e.val->>'type' = 'trial') = 2, '① طلبا تجربة');
  PERFORM t.ok((select count(*) from jsonb_array_elements(r) as e(val) where e.val->>'type' = 'refund') = 1, '① طلب تعويض واحد — بلا تكرار');
  PERFORM t.ok((select count(*) from jsonb_array_elements(r) as e(val) where e.val->>'type' = 'deletion') = 2, '① طلبا حذف');
  PERFORM t.ok((select count(*) from jsonb_array_elements(r) as e(val) where e.val->>'type' = 'suggestion') = 2, '① اقتراحان');
  PERFORM t.ok((select count(*) from jsonb_array_elements(r) as e(val) where e.val->>'status' = 'pending') = 5, '① خمسة معلّقة');
  PERFORM t.ok((r->0->>'status') = 'pending', '① المعلّقة أولًا');
  PERFORM t.ok(not exists (select 1 from jsonb_array_elements(r) as e(val)
    where (e.val->>'id') is null or (e.val->>'type') is null or (e.val->>'source') is null
       or (e.val->>'title') is null or (e.val->>'status') is null
       or (e.val->>'requested_at') is null or (e.val->>'detail_url') is null),
    '① كل صف بنوعه ومصدره وحالته وتاريخه ورابطه');
  -- طلب المتجر المعلّق: الصف نفسه براية قائمة المتاجر ورابطها
  select e.val into v_store from jsonb_array_elements(r) as e(val)
   where e.val->>'type' = 'company_account' and (e.val->>'account_kind') = 'ecommerce_store';
  PERFORM t.ok((v_store->>'in_store_queue')::boolean, '① طلب المتجر في قائمة المتاجر');
  PERFORM t.ok((v_store->>'detail_url') = '/owner/stores.html#storeRequestsHeading', '① طلب المتجر يربط بقائمة المتاجر');
  PERFORM t.ok((v_store->>'title') = 'طلب إنشاء حساب متجر إلكتروني', '① عنوان طلب المتجر');
  -- طلب حساب الشركة غير المتجر: صفحة المراجعة الأصلية
  select e.val into v_company from jsonb_array_elements(r) as e(val)
   where e.val->>'type' = 'company_account' and (e.val->>'account_kind') = 'company';
  PERFORM t.ok(not (v_company->>'in_store_queue')::boolean, '① طلب الشركة ليس في قائمة المتاجر');
  PERFORM t.ok((v_company->>'detail_url') = '/admin/company-requests.html', '① طلب الشركة يربط بصفحة المراجعة');
  -- التجربة والتعويض والحذف والاقتراح: روابطهم الأصلية
  select e.val into v_trial from jsonb_array_elements(r) as e(val) where e.val->>'type' = 'trial' and e.val->>'status' = 'pending';
  PERFORM t.ok((v_trial->>'detail_url') = '/owner/trials.html#trialRequestsHeading', '① التجربة تربط بصفحتها');
  PERFORM t.ok((v_trial->>'plan_label') = 'الخطة الفائقة', '① تجربة الفائقة بتسميتها');
  select e.val into v_refund from jsonb_array_elements(r) as e(val) where e.val->>'type' = 'refund';
  PERFORM t.ok((v_refund->>'source') = 'companies', '① التعويض مصدر واحد: شركات');
  PERFORM t.ok((v_refund->>'detail_url') = '/owner/refunds.html#refundRequestsHeading', '① التعويض يربط بصفحته');
  PERFORM t.ok((v_refund->>'amount')::numeric = 666.33, '① مبلغ التعويض 666.33');
  PERFORM t.ok((v_refund->>'plan_label') = 'الخطة الفائقة', '① تعويض الفائقة بتسميتها');
  select e.val into v_deletion from jsonb_array_elements(r) as e(val) where e.val->>'type' = 'deletion' and e.val->>'status' = 'pending';
  PERFORM t.ok((v_deletion->>'source') = 'customers', '① الحذف مصدره العملاء');
  PERFORM t.ok((v_deletion->>'detail_url') = '/owner/accounts.html?id=' || t.u('CA')::text, '① الحذف يربط بشجرة الحسابات');
  select e.val into v_suggestion from jsonb_array_elements(r) as e(val) where e.val->>'type' = 'suggestion' and e.val->>'status' = 'pending';
  PERFORM t.ok((v_suggestion->>'source') = 'management', '① الاقتراح مصدره الإدارة');
  PERFORM t.ok((v_suggestion->>'detail_url') = '/admin/suggestions.html', '① الاقتراح يربط بصفحته');
  PERFORM t.ctx(null);
  RAISE NOTICE 'PASS ① التجميع يقرأ الأنواع الخمسة؛ التعويض مرة واحدة؛ كل صف برابطه الأصلي';
END $$;

-- ══ ② المرشّحات ════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM t.ctx('owner');
  r := t.call(t.u('OW'), 'public.owner_list_requests(p_type := ''trial'')');
  PERFORM t.ok(jsonb_array_length(r) = 2 and (r->0->>'type') = 'trial' and (r->1->>'type') = 'trial', '② مرشّح النوع: تجربة فقط');
  r := t.call(t.u('OW'), 'public.owner_list_requests(p_type := ''refund'')');
  PERFORM t.ok(jsonb_array_length(r) = 1, '② مرشّح النوع: تعويض واحد');
  r := t.call(t.u('OW'), 'public.owner_list_requests(p_status := ''pending'')');
  PERFORM t.ok(jsonb_array_length(r) = 5, '② مرشّح الحالة: خمسة معلّقة');
  r := t.call(t.u('OW'), 'public.owner_list_requests(p_type := ''suggestion'', p_status := ''implemented'')');
  PERFORM t.ok(jsonb_array_length(r) = 1 and (r->0->>'title') = 'اقتراح اختبار ثانٍ', '② نوع + حالة معًا');
  r := t.call(t.u('OW'), 'public.owner_list_requests(p_type := ''deletion'', p_status := ''executed'')');
  PERFORM t.ok(jsonb_array_length(r) = 1, '② حذف منفَّذ واحد');
  PERFORM t.ok(t.err(t.u('OW'), 'public.owner_list_requests(p_type := ''store'')') = '22023', '② نوع غير صالح مرفوض');
  PERFORM t.ok(t.err(t.u('OW'), 'public.owner_list_requests(p_status := ''open'')') = '22023', '② حالة غير صالحة مرفوضة');
  PERFORM t.ctx(null);
  RAISE NOTICE 'PASS ② المرشّحات حسب النوع والحالة تعمل؛ والقيم غير الصالحة مرفوضة';
END $$;

-- ══ ③ الحارس: المالك وحده وفي سياقه ════════════════════════════════════
DO $$
BEGIN
  PERFORM t.ctx('owner');
  PERFORM t.ok(t.err(t.u('AD'), 'public.owner_list_requests()') = '42501', '③ غير المالك مرفوض');
  PERFORM t.ok(t.err(t.u('OA'), 'public.owner_list_requests()') = '42501', '③ مالك الشركة مرفوض');
  PERFORM t.ctx(null);
  PERFORM t.ok(t.err(t.u('OW'), 'public.owner_list_requests()') = '42501', '③ المالك بلا سياق مرفوض');
  RAISE NOTICE 'PASS ③ القائمة للمالك وحده وفي سياقه';
END $$;

-- ══ ④ التراجع وإعادة التطبيق ═══════════════════════════════════════════
\i migrations/_rollback/142_owner_requests_aggregator.down.sql
DO $$
BEGIN
  PERFORM t.ok(to_regprocedure('public.owner_list_requests(text, text)') is null, '④ الدالة حُذفت');
  PERFORM t.ok(to_regclass('public.company_account_requests') is not null, '④ جدول حساب الشركة باقٍ');
  PERFORM t.ok(to_regclass('public.saas_trial_requests') is not null, '④ جدول التجربة باقٍ');
  PERFORM t.ok(to_regclass('public.refund_requests') is not null, '④ جدول التعويض باقٍ');
  PERFORM t.ok(to_regclass('public.company_deletion_requests') is not null, '④ جدول الحذف باقٍ');
  PERFORM t.ok(to_regclass('public.suggestions') is not null, '④ جدول الاقتراحات باقٍ');
  PERFORM t.ok((select count(*) from public.company_account_requests) = 2, '④ صفوف حساب الشركة باقية');
  PERFORM t.ok((select count(*) from public.saas_trial_requests) = 2, '④ صفوف التجربة باقية');
  PERFORM t.ok((select count(*) from public.refund_requests) = 1, '④ صف التعويض باقٍ');
  PERFORM t.ok((select count(*) from public.company_deletion_requests) = 2, '④ صفوف الحذف باقية');
  PERFORM t.ok((select count(*) from public.suggestions) = 2, '④ الاقتراحات باقية');
END $$;
\i migrations/142_owner_requests_aggregator.sql
SET search_path = public, extensions;
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM t.ctx('owner');
  r := t.call(t.u('OW'), 'public.owner_list_requests()');
  PERFORM t.ok(jsonb_array_length(r) = 9, '④ إعادة التطبيق: القائمة كاملة 9 صفوف');
  PERFORM t.ctx(null);
  RAISE NOTICE 'PASS ④ التراجع يحذف الدالة وحدها، وإعادة التطبيق تعيد القائمة كاملةً';
  RAISE NOTICE 'ALL 142 OWNER REQUESTS AGGREGATOR TESTS PASSED';
END $$;
