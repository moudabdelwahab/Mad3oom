-- ============================================================================
-- 133_owner_store_price_and_sync_actions على نسخة مطابقة للإنتاج + 118 + 119
--
--   ⓪ 133 مرتين: قابل لإعادة التشغيل، ودوال 119 التي يبني عليها لم تُلمس
--   ① سعر باقة المتاجر: المالك وحده، بتحقق حديث، بسعرين موجبين، لـ 'store' فقط
--   ② مزامنة المالك: بلا سياق مدير المتجر، ونفس حد الدقيقتين في 119
--   ③ إعادة الأحداث الميتة: آخر 7 أيام فقط، وexternal_type غير null
--   ④ حالة متجر الاختبار: شركة المالك مباشرة، بلا بحث نصي
--   ⑤ الصلاحيات: authenticated وحده، ولا خطة أخرى تُمس
--   ⑥ التراجع يحذف الدوال الأربع، وإعادة التطبيق تنجح
-- ============================================================================
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
SET client_min_messages = warning;

\i tests/fixtures/ecommerce/chain.sql

CREATE FUNCTION t.s(p text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  select (case p
    when 'ST' then '5a000000-0000-4000-8000-000000000001' when 'SX' then '5b000000-0000-4000-8000-000000000001'
  end)::uuid $$;
CREATE FUNCTION t.h(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ select encode(sha256(convert_to(p, 'UTF8')), 'hex') $$;
CREATE FUNCTION t.sv(p_k text) RETURNS text LANGUAGE sql AS $$ select v from t.saved where k = p_k $$;
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
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;

\i migrations/118_ecommerce_store_accounts.sql
\i migrations/119_shopify_store_integration.sql
\i migrations/133_owner_store_price_and_sync_actions.sql
\i migrations/133_owner_store_price_and_sync_actions.sql
SET search_path = public, extensions;

-- ── متجر تاجر واحد بربط Shopify نشط ──────────────────────────────────────
INSERT INTO auth.users (id, email, email_confirmed_at)
SELECT t.s(n), lower(n) || '@store.test', now() - interval '30 days' FROM unnest(array['ST']) n;
INSERT INTO public.profiles (id, email, full_name, role, phone, created_at) VALUES
  (t.s('ST'), 'st@store.test', 'تاجر أ', 'user', '01200000001', '2026-09-01');
UPDATE public.subscription_plans SET price_monthly = 1, price_yearly = 10, is_active = false WHERE key = 'store';  -- قيمة اختبار
DO $$
DECLARE r jsonb;
BEGIN
  r := t.call(t.s('ST'), format('public.submit_store_account_request(%L, %L, ''2030-01-01'')', 'متجر ST', 'CR-ST-133'));
  r := t.call(t.u('AD'), format('public.admin_review_company_account_request(%L, ''approve'')', r->>'id'));
  INSERT INTO t.saved VALUES ('co_ST', r->>'company_id');
  INSERT INTO public.whatsapp_subscriptions (user_id, plan, status, billing_cycle, start_date, end_date, duration_days, company_id)
  VALUES (t.s('ST'), 'store', 'active', 'monthly', now() - interval '1 day', now() + interval '29 days', 30, (r->>'company_id')::uuid);
END $$;
UPDATE public.ihub_providers SET enabled = true WHERE key = 'shopify';
DO $$
DECLARE r jsonb;
BEGIN
  r := t.call(t.s('ST'), 'public.ihub_prepare_connection(''shopify'', ''متجري'')');
  INSERT INTO t.saved VALUES ('cn_a', r->>'id');
  r := t.svc(format('public.ihub_svc_activate(%L, ''shop-a.myshopify.com'', ''متجر أ'', ''https://shop-a.myshopify.com'', %L)', t.sv('cn_a'), t.s('ST')));
  PERFORM t.ok(r->>'status' = 'active', 'HARNESS الربط نشط');
END $$;

-- ══ ⓪ إعادة التطبيق ودوال 119 ═══════════════════════════════════════════
DO $$
BEGIN
  PERFORM t.ok(to_regprocedure('public.owner_set_store_plan_price(numeric,numeric,boolean)') is not null, '⓪ السعر');
  PERFORM t.ok(to_regprocedure('public.owner_ihub_sync_request(uuid)') is not null, '⓪ مزامنة المالك');
  PERFORM t.ok(to_regprocedure('public.owner_ihub_events_retry(uuid)') is not null, '⓪ إعادة الأحداث');
  PERFORM t.ok(to_regprocedure('public.owner_store_test_status()') is not null, '⓪ حالة الاختبار');
  PERFORM t.ok(to_regprocedure('public.ihub_sync_request(uuid)') is not null, '⓪ ihub_sync_request كما هو');
  PERFORM t.ok(to_regprocedure('public.ihub_events_retry(uuid)') is not null, '⓪ ihub_events_retry كما هو');
  PERFORM t.ok(to_regprocedure('public._ihub_enqueue_sync(uuid,text,uuid)') is not null, '⓪ _ihub_enqueue_sync كما هو');
  RAISE NOTICE 'PASS ⓪ 133 قابل لإعادة التشغيل؛ دوال 119 لم تُلمس';
END $$;

-- ══ ① سعر باقة المتاجر ══════════════════════════════════════════════════
DO $$
DECLARE r jsonb; v_support numeric;
BEGIN
  PERFORM t.ctx('owner');
  v_support := (select price_monthly from public.subscription_plans where key = 'support');
  PERFORM t.ok(t.err(t.u('AD'), 'public.owner_set_store_plan_price(1499, 14999, false)') = '42501', '① ليس للمالك');
  PERFORM t.ok(t.err(t.u('OW'), 'public.owner_set_store_plan_price(1499, 14999, false)') = '42501', '① بلا تحقق حديث');
  PERFORM t.stepup(t.u('OW'));
  PERFORM t.ok(t.err(t.u('OW'), 'public.owner_set_store_plan_price(0, 14999, false)') = '22023', '① شهري صفر');
  PERFORM t.ok(t.err(t.u('OW'), 'public.owner_set_store_plan_price(1499, -5, false)') = '22023', '① سنوي سالب');
  PERFORM t.ok(t.err(t.u('OW'), 'public.owner_set_store_plan_price(null, 14999, false)') = '22023', '① شهري null');
  r := t.call(t.u('OW'), 'public.owner_set_store_plan_price(1499, 14999, false)');
  PERFORM t.ok((r->>'price_monthly')::numeric = 1499 and (r->>'price_yearly')::numeric = 14999
               and (r->>'currency') = 'EGP' and not (r->>'is_active')::boolean
               and not (r->>'activated')::boolean, '① سعر بلا تفعيل');
  r := t.call(t.u('OW'), 'public.owner_set_store_plan_price(1799, 17999, true)');
  PERFORM t.ok((r->>'price_monthly')::numeric = 1799 and (r->>'is_active')::boolean
               and (r->>'activated')::boolean, '① تفعيل مع السعرين');
  PERFORM t.ok((select price_monthly from public.subscription_plans where key = 'support') = v_support, '① باقة الدعم كما هي');
  PERFORM t.ok((select count(*) from public.subscription_plans where key <> 'store') >= 4, '① باقي الباقات كما هي');
  PERFORM t.ok(exists (select 1 from public.privileged_audit where action = 'store.plan_price'), '① مدقَّق');
  PERFORM t.ctx(null);
  RAISE NOTICE 'PASS ① سعر باقة المتاجر للمالك وحده، بتحقق حديث، لـ store فقط';
END $$;

-- ══ ② مزامنة المالك ═════════════════════════════════════════════════════
DO $$
DECLARE r jsonb; v_job bigint;
BEGIN
  PERFORM t.ok(t.err(t.u('AD'), format('public.owner_ihub_sync_request(%L)', t.sv('cn_a'))) = '42501', '② ليس للمالك');
  PERFORM t.ok(t.err(t.s('ST'), format('public.owner_ihub_sync_request(%L)', t.sv('cn_a'))) = '42501', '② ولا مدير المتجر');
  PERFORM t.ok(t.err(t.u('OW'), 'public.owner_ihub_sync_request(''00000000-0000-4000-8000-000000000000'')') = 'P0002', '② ربط غير موجود');
  PERFORM t.ctx('admin');
  PERFORM t.ok(t.err(t.u('OW'), format('public.owner_ihub_sync_request(%L)', t.sv('cn_a'))) = '42501', '② المالك في سياق الإدارة مرفوض');
  PERFORM t.ctx('owner');
  r := t.call(t.u('OW'), format('public.owner_ihub_sync_request(%L)', t.sv('cn_a')));
  PERFORM t.ok((r->>'job_id') is not null and not (r->>'existing')::boolean, '② مهمة جديدة');
  v_job := (r->>'job_id')::bigint;
  r := t.call(t.u('OW'), format('public.owner_ihub_sync_request(%L)', t.sv('cn_a')));
  PERFORM t.ok((r->>'job_id')::bigint = v_job and (r->>'existing')::boolean, '② مهمة قائمة لا تتكرر');
  PERFORM t.ok(exists (select 1 from public.ihub_audit_events where action = 'sync.requested'
                       and connection_id = t.sv('cn_a')::uuid and detail->>'via' = 'owner'), '② مدقَّق كمزامنة مالك');
  -- حد الدقيقتين: مهمة منتهية حديثًا بلا مهمة قائمة = انتظر
  UPDATE public.ihub_sync_jobs SET status = 'succeeded', finished_at = now() WHERE id = v_job;
  PERFORM t.ok(t.err(t.u('OW'), format('public.owner_ihub_sync_request(%L)', t.sv('cn_a'))) = 'P0001', '② حد الدقيقتين');
  UPDATE public.ihub_sync_jobs SET finished_at = now() - interval '3 minutes' WHERE id = v_job;
  r := t.call(t.u('OW'), format('public.owner_ihub_sync_request(%L)', t.sv('cn_a')));
  PERFORM t.ok((r->>'job_id') is not null and not (r->>'existing')::boolean, '② بعد 3 دقائق: مهمة جديدة');
  -- المزوّد المقفل
  UPDATE public.ihub_providers SET enabled = false WHERE key = 'shopify';
  PERFORM t.ok(t.err(t.u('OW'), format('public.owner_ihub_sync_request(%L)', t.sv('cn_a'))) = '22023', '② المزوّد المقفل');
  UPDATE public.ihub_providers SET enabled = true WHERE key = 'shopify';
  -- الربط المعلّق يحتاج إعادة تفويض
  UPDATE public.ihub_connections SET status = 'pending' WHERE id = t.sv('cn_a')::uuid;
  PERFORM t.ok(t.err(t.u('OW'), format('public.owner_ihub_sync_request(%L)', t.sv('cn_a'))) = '22023', '② المعلّق يحتاج تفويضًا');
  UPDATE public.ihub_connections SET status = 'active' WHERE id = t.sv('cn_a')::uuid;
  PERFORM t.ctx(null);
  RAISE NOTICE 'PASS ② مزامنة المالك بلا سياق مدير، ونفس حد الدقيقتين';
END $$;

-- ══ ③ إعادة الأحداث الميتة ═══════════════════════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  INSERT INTO public.ihub_webhook_events (connection_id, company_id, provider, topic, dedupe_key, external_type, status, received_at, attempts, last_error_code)
  VALUES
    (t.sv('cn_a')::uuid, t.sv('co_ST')::uuid, 'shopify', 'orders/create', t.h('e1'), 'order', 'dead', now() - interval '1 hour', 6, 'timeout'),
    (t.sv('cn_a')::uuid, t.sv('co_ST')::uuid, 'shopify', 'orders/updated', t.h('e2'), 'order', 'dead', now() - interval '2 hours', 6, 'timeout'),
    (t.sv('cn_a')::uuid, t.sv('co_ST')::uuid, 'shopify', 'orders/create', t.h('e3'), null, 'dead', now() - interval '1 hour', 6, 'timeout'),
    (t.sv('cn_a')::uuid, t.sv('co_ST')::uuid, 'shopify', 'orders/create', t.h('e4'), 'order', 'dead', now() - interval '8 days', 6, 'timeout'),
    (t.sv('cn_a')::uuid, t.sv('co_ST')::uuid, 'shopify', 'orders/create', t.h('e5'), 'order', 'failed', now() - interval '1 hour', 2, 'timeout');
  PERFORM t.ok(t.err(t.u('AD'), format('public.owner_ihub_events_retry(%L)', t.sv('cn_a'))) = '42501', '③ ليس للمالك');
  PERFORM t.ok(t.err(t.u('OW'), 'public.owner_ihub_events_retry(''00000000-0000-4000-8000-000000000000'')') = 'P0002', '③ ربط غير موجود');
  PERFORM t.ctx('owner');
  r := t.call(t.u('OW'), format('public.owner_ihub_events_retry(%L)', t.sv('cn_a')));
  PERFORM t.ok((r->>'requeued')::int = 2, '③ حديثة ميتة بنوع فقط: ' || (r->>'requeued'));
  PERFORM t.ok((select count(*) from public.ihub_webhook_events where connection_id = t.sv('cn_a')::uuid
                 and status = 'queued' and attempts = 0 and last_error_code is null) = 2, '③ أُعيدت للطابور من جديد');
  PERFORM t.ok((select count(*) from public.ihub_webhook_events where connection_id = t.sv('cn_a')::uuid
                 and status = 'dead') = 2, '③ القديمة وبلا نوع بقيتا ميتتين');
  PERFORM t.ok(exists (select 1 from public.ihub_audit_events where action = 'events.retried'
                       and connection_id = t.sv('cn_a')::uuid and detail->>'via' = 'owner'), '③ مدقَّق');
  r := t.call(t.u('OW'), format('public.owner_ihub_events_retry(%L)', t.sv('cn_a')));
  PERFORM t.ok((r->>'requeued')::int = 0, '③ ثانية: لا شيء');
  PERFORM t.ctx(null);
  RAISE NOTICE 'PASS ③ إعادة الأحداث الميتة (آخر 7 أيام، بنوع) فقط';
END $$;

-- ══ ④ حالة متجر الاختبار ═══════════════════════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM t.ok(t.err(t.u('AD'), 'public.owner_store_test_status()') = '42501', '④ ليس للمالك');
  PERFORM t.ctx('owner');
  r := t.call(t.u('OW'), 'public.owner_store_test_status()');
  PERFORM t.ok((r->>'company_id') = t.u('CW')::text and (r->>'account_kind') = 'company'
               and (r->>'has_company')::boolean and not (r->>'is_test_store')::boolean, '④ شركة المالك شركة عادية');
  PERFORM t.ok(jsonb_array_length(r->'entitlements') = 3
               and not ((r->'entitlements'->0->>'granted')::boolean), '④ بلا امتيازات');
  PERFORM t.call(t.u('OW'), format('public.owner_set_company_account_kind(%L, ''ecommerce_store'', ''متجر المالك التجريبي'')', t.u('CW')));
  PERFORM t.call(t.u('OW'), 'public.owner_store_test_entitlements(true, 7, ''اختبار تجربة المتجر'')');
  r := t.call(t.u('OW'), 'public.owner_store_test_status()');
  PERFORM t.ok((r->>'is_test_store')::boolean, '④ صارت متجر اختبار');
  PERFORM t.ok((select count(*) from jsonb_array_elements(r->'entitlements') e
                 where (e->>'granted')::boolean and (e->>'active')::boolean) = 3, '④ ثلاثة امتيازات نشطة');
  PERFORM t.ok((select min((e->>'days_remaining')::int) from jsonb_array_elements(r->'entitlements') e) between 6 and 7, '④ الأيام المتبقية');
  PERFORM t.ok((select (e->>'expires_at') is not null from jsonb_array_elements(r->'entitlements') e limit 1), '④ تاريخ انتهاء معروض');
  PERFORM t.call(t.u('OW'), 'public.owner_store_test_entitlements(false)');
  r := t.call(t.u('OW'), 'public.owner_store_test_status()');
  PERFORM t.ok((select count(*) from jsonb_array_elements(r->'entitlements') e
                 where (e->>'granted')::boolean) = 0, '④ بعد السحب: بلا امتيازات');
  PERFORM t.ctx(null);
  RAISE NOTICE 'PASS ④ حالة متجر الاختبار من شركة المالك مباشرة';
END $$;

-- ══ ⑤ الصلاحيات ═════════════════════════════════════════════════════════
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY array[
    'public.owner_set_store_plan_price(numeric,numeric,boolean)',
    'public.owner_ihub_sync_request(uuid)',
    'public.owner_ihub_events_retry(uuid)',
    'public.owner_store_test_status()'] LOOP
    PERFORM t.ok(not has_function_privilege('anon', f::regprocedure, 'EXECUTE'), '⑤ anon بلا: ' || f);
    PERFORM t.ok(has_function_privilege('authenticated', f::regprocedure, 'EXECUTE'), '⑤ authenticated له: ' || f);
    PERFORM t.ok(not has_function_privilege('service_role', f::regprocedure, 'EXECUTE'), '⑤ service_role بلا: ' || f);
  END LOOP;
  RAISE NOTICE 'PASS ⑤ الصلاحيات: authenticated وحده';
END $$;

-- ══ ⑥ التراجع ═══════════════════════════════════════════════════════════
\i migrations/_rollback/133_owner_store_price_and_sync_actions.down.sql
DO $$
BEGIN
  PERFORM t.ok(to_regprocedure('public.owner_set_store_plan_price(numeric,numeric,boolean)') is null, '⑥ السعر حُذف');
  PERFORM t.ok(to_regprocedure('public.owner_ihub_sync_request(uuid)') is null, '⑥ المزامنة حُذفت');
  PERFORM t.ok(to_regprocedure('public.owner_ihub_events_retry(uuid)') is null, '⑥ الإعادة حُذفت');
  PERFORM t.ok(to_regprocedure('public.owner_store_test_status()') is null, '⑥ الحالة حُذفت');
  PERFORM t.ok(to_regprocedure('public.ihub_sync_request(uuid)') is not null, '⑥ دوال 119 باقية');
  PERFORM t.ok((select price_monthly from public.subscription_plans where key = 'store') = 1799, '⑥ السعر المحدَّد باقٍ (بيانات)');
END $$;
\i migrations/133_owner_store_price_and_sync_actions.sql
SET search_path = public, extensions;
DO $$
BEGIN
  PERFORM t.ok(to_regprocedure('public.owner_set_store_plan_price(numeric,numeric,boolean)') is not null, '⑥ إعادة التطبيق');
  RAISE NOTICE 'PASS ⑥ التراجع يحذف الدوال الأربع، وإعادة التطبيق تنجح';
END $$;

-- ══ ⑦ منح باقة المتاجر كاستثناء ══════════════════════════════════════════
INSERT INTO auth.users (id, email, email_confirmed_at)
VALUES (t.s('SX'), 'sx@store.test', now() - interval '30 days');
INSERT INTO public.profiles (id, email, full_name, role, phone, created_at) VALUES
  (t.s('SX'), 'sx@store.test', 'تاجر ب', 'user', '01200000002', '2026-09-01');
DO $$
DECLARE r jsonb;
BEGIN
  r := t.call(t.s('SX'), format('public.submit_store_account_request(%L, %L, ''2030-01-01'')', 'متجر SX', 'CR-SX-133'));
  r := t.call(t.u('AD'), format('public.admin_review_company_account_request(%L, ''approve'')', r->>'id'));
  INSERT INTO t.saved VALUES ('co_SX', r->>'company_id');
END $$;
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM t.ctx('owner');
  PERFORM t.ok(t.err(t.u('AD'), format('public.owner_store_grant_exception(%L, ''monthly'', now() + interval ''30 days'', ''منح استثناء للاختبار'')', t.sv('co_SX'))) = '42501', '⑦ ليس للمالك');
  DELETE FROM public.privileged_step_ups WHERE user_id = t.u('OW');
  PERFORM t.ok(t.err(t.u('OW'), format('public.owner_store_grant_exception(%L, ''monthly'', now() + interval ''30 days'', ''منح استثناء للاختبار'')', t.sv('co_SX'))) = '42501', '⑦ بلا تحقق حديث');
  PERFORM t.stepup(t.u('OW'));
  PERFORM t.ok(t.err(t.u('OW'), format('public.owner_store_grant_exception(%L, ''monthly'', now() + interval ''30 days'', ''قصير'')', t.sv('co_SX'))) = '22023', '⑦ سبب قصير');
  PERFORM t.ok(t.err(t.u('OW'), format('public.owner_store_grant_exception(%L, ''weekly'', now() + interval ''30 days'', ''منح استثناء للاختبار'')', t.sv('co_SX'))) = '22023', '⑦ دورة غير صالحة');
  PERFORM t.ok(t.err(t.u('OW'), format('public.owner_store_grant_exception(%L, ''monthly'', now() - interval ''1 day'', ''منح استثناء للاختبار'')', t.sv('co_SX'))) = '22023', '⑦ انتهاء في الماضي');
  PERFORM t.ok(t.err(t.u('OW'), format('public.owner_store_grant_exception(%L, ''monthly'', now() + interval ''400 days'', ''منح استثناء للاختبار'')', t.sv('co_SX'))) = '22023', '⑦ انتهاء بعد سنة');
  PERFORM t.ok(t.err(t.u('OW'), format('public.owner_store_grant_exception(%L, ''monthly'', now() + interval ''30 days'', ''منح استثناء للاختبار'')', t.u('CA'))) = '22023', '⑦ منح لغير متجر مرفوض');
  PERFORM t.ok(t.err(t.u('OW'), format('public.owner_store_grant_exception(%L, ''monthly'', now() + interval ''30 days'', ''منح استثناء للاختبار'')', t.sv('co_ST'))) = '22023', '⑦ منح مع اشتراك فعّال مرفوض');
  PERFORM t.call(t.u('OW'), 'public.owner_set_store_plan_price(500, 5000, false)');
  r := t.call(t.u('OW'), format('public.owner_store_grant_exception(%L, ''monthly'', now() + interval ''30 days'', ''منح استثناء للاختبار'')', t.sv('co_SX')));
  INSERT INTO t.saved VALUES ('sub_sx', r->>'id');
  PERFORM t.ok((r->>'status') = 'active' and (r->>'billing_cycle') = 'monthly' and (r->>'duration_days')::int = 30, '⑦ اشتراك فعّال 30 يومًا');
  PERFORM t.ok((r->'price_snapshot'->>'amount')::numeric = 0 and (r->'price_snapshot'->>'exception')::boolean
               and (r->'price_snapshot'->>'plan_price_monthly')::numeric = 500
               and (r->'price_snapshot'->>'cycle_price')::numeric = 500, '⑦ لقطة السعر: 500/5000 ومبلغ 0');
  PERFORM t.ok((r->>'payment_method') = 'owner_exception' and (r->>'effective')::boolean, '⑦ طريقة الدفع والفعالية');
  PERFORM t.ok(exists (select 1 from public.subscription_audit_log where subscription_id = (r->>'id')::uuid and action = 'grant_exception'), '⑦ مدقَّق في سجل الاشتراكات');
  PERFORM t.ok(exists (select 1 from public.privileged_audit where action = 'store.grant_exception'), '⑦ ومدقَّق في سجل المالك');
  PERFORM t.ok(t.err(t.u('OW'), format('public.owner_store_grant_exception(%L, ''yearly'', now() + interval ''30 days'', ''منح استثناء للاختبار'')', t.sv('co_SX'))) = '22023', '⑦ منح ثانٍ مع القائم مرفوض');
  r := t.call(t.u('OW'), format('public.owner_store_subscription(%L)', t.sv('co_SX')));
  PERFORM t.ok((r->>'id') = t.sv('sub_sx') and (r->>'effective')::boolean, '⑦ القراءة تعيد الاشتراك');
  PERFORM t.ok(t.call(t.u('OW'), format('public.owner_store_subscription(%L)', t.u('CW'))) = 'null'::jsonb, '⑦ بلا اشتراك متجر = null');
  PERFORM t.ok(t.err(t.u('AD'), format('public.owner_store_subscription(%L)', t.sv('co_SX'))) = '42501', '⑦ القراءة للمالك وحده');
  PERFORM t.ctx(null);
  RAISE NOTICE 'PASS ⑦ منح باقة المتاجر كاستثناء بسعر الخطة ومبلغ صفر';
END $$;

-- ══ ⑧ انتهاء/إيقاف/استئناف/دورة ══════════════════════════════════════════
DO $$
DECLARE r jsonb; v_end timestamptz; v_sub uuid := t.sv('sub_sx')::uuid;
BEGIN
  PERFORM t.ctx('owner');
  PERFORM t.ok(t.err(t.u('OW'), format('public.owner_store_set_end_date(%L, now() - interval ''1 day'', ''تعديل انتهاء للاختبار'')', v_sub)) = '22023', '⑧ انتهاء لماضٍ مرفوض');
  PERFORM t.ok(t.err(t.u('OW'), format('public.owner_store_set_end_date(%L, now() + interval ''60 days'', ''تعديل انتهاء للاختبار'')', v_sub)) = 'ok', '⑧ تعديل الانتهاء');
  r := t.call(t.u('OW'), format('public.owner_store_subscription(%L)', t.sv('co_SX')));
  PERFORM t.ok((r->>'duration_days')::int = 60, '⑧ المدة 60 يومًا');
  PERFORM t.ok(t.err(t.u('OW'), format('public.owner_store_pause(%L, ''إيقاف للاختبار'')', v_sub)) = 'ok', '⑧ إيقاف الفعّال');
  r := t.call(t.u('OW'), format('public.owner_store_subscription(%L)', t.sv('co_SX')));
  PERFORM t.ok((r->>'status') = 'paused' and (r->>'paused_at') is not null and not (r->>'effective')::boolean, '⑧ متوقف وليس فعّالًا');
  PERFORM t.ok(t.err(t.u('OW'), format('public.owner_store_pause(%L, ''إيقاف للاختبار'')', v_sub)) = '22023', '⑧ إيقاف غير الفعّال مرفوض');
  PERFORM t.ok(t.err(t.u('OW'), format('public.owner_store_grant_exception(%L, ''monthly'', now() + interval ''30 days'', ''منح استثناء للاختبار'')', t.sv('co_SX'))) = '22023', '⑧ منح مع المتوقف مرفوض — الاستئناف هو المسار');
  UPDATE public.whatsapp_subscriptions SET paused_at = now() - interval '1 hour' WHERE id = v_sub;
  v_end := (select end_date from public.whatsapp_subscriptions where id = v_sub);
  PERFORM t.ok(t.err(t.u('OW'), format('public.owner_store_resume(%L, ''استئناف للاختبار'')', v_sub)) = 'ok', '⑧ استئناف المتوقف');
  r := t.call(t.u('OW'), format('public.owner_store_subscription(%L)', t.sv('co_SX')));
  PERFORM t.ok((r->>'status') = 'active' and (r->>'paused_at') is null, '⑧ فعّال بلا paused_at');
  PERFORM t.ok((r->>'end_date')::timestamptz >= v_end + interval '59 minutes'
               and (r->>'end_date')::timestamptz <= v_end + interval '61 minutes', '⑧ الانتهاء امتدّ بساعة التوقف');
  PERFORM t.ok(t.err(t.u('OW'), format('public.owner_store_resume(%L, ''استئناف للاختبار'')', v_sub)) = '22023', '⑧ استئناف غير المتوقف مرفوض');
  PERFORM t.ok(t.err(t.u('OW'), format('public.owner_store_change_cycle(%L, ''monthly'', ''تحويل دورة للاختبار'')', v_sub)) = '22023', '⑧ نفس الدورة مرفوضة');
  r := t.call(t.u('OW'), format('public.owner_store_change_cycle(%L, ''yearly'', ''تحويل دورة للاختبار'')', v_sub));
  PERFORM t.ok((r->>'billing_cycle') = 'yearly' and (r->>'end_date')::timestamptz > now() + interval '364 days'
               and (r->>'end_date')::timestamptz < now() + interval '366 days', '⑧ تحويل لسنوي: انتهاء بعد سنة');
  PERFORM t.ok((r->'price_snapshot'->>'cycle_price')::numeric = 5000 and (r->'price_snapshot'->>'amount')::numeric = 0, '⑧ لقطة السعر السنوي مع بقاء الاستثناء');
  PERFORM t.call(t.u('OW'), format('public.owner_store_pause(%L, ''إيقاف للاختبار'')', v_sub));
  v_end := (select end_date from public.whatsapp_subscriptions where id = v_sub);
  r := t.call(t.u('OW'), format('public.owner_store_change_cycle(%L, ''monthly'', ''تحويل دورة للاختبار'')', v_sub));
  PERFORM t.ok((r->>'billing_cycle') = 'monthly' and (r->>'end_date')::timestamptz = v_end, '⑧ تحويل أثناء الإيقاف: الانتهاء مجمّد');
  PERFORM t.ok((r->'price_snapshot'->>'cycle_changed_while_paused')::boolean, '⑧ علامة التحويل أثناء الإيقاف');
  r := t.call(t.u('OW'), format('public.owner_store_resume(%L, ''استئناف للاختبار'')', v_sub));
  PERFORM t.ok((r->>'end_date')::timestamptz > now() + interval '29 days'
               and (r->>'end_date')::timestamptz < now() + interval '31 days', '⑧ الاستئناف يبدأ الدورة الجديدة كاملة');
  PERFORM t.ok((r->'price_snapshot'->>'cycle_changed_while_paused') is null, '⑧ العلامة مُسحت');
  UPDATE public.whatsapp_subscriptions SET status = 'expired' WHERE id = v_sub;
  PERFORM t.ok(t.err(t.u('OW'), format('public.owner_store_change_cycle(%L, ''yearly'', ''تحويل دورة للاختبار'')', v_sub)) = '22023', '⑧ تحويل المنتهي مرفوض');
  UPDATE public.whatsapp_subscriptions SET status = 'active' WHERE id = v_sub;
  PERFORM t.ctx(null);
  RAISE NOTICE 'PASS ⑧ انتهاء/إيقاف/استئناف/دورة بقواعد التمديد والتحويل';
END $$;

-- ══ ⑨ طلبات المتاجر: قراءة وقرار ════════════════════════════════════════
INSERT INTO auth.users (id, email, email_confirmed_at)
VALUES ('5c000000-0000-4000-8000-000000000001', 'rq@store.test', now() - interval '30 days'),
       ('5c000000-0000-4000-8000-000000000002', 'rq2@store.test', now() - interval '30 days');
INSERT INTO public.profiles (id, email, full_name, role, phone, created_at) VALUES
  ('5c000000-0000-4000-8000-000000000001', 'rq@store.test', 'طالب الطلب', 'user', '01200000031', '2026-09-01'),
  ('5c000000-0000-4000-8000-000000000002', 'rq2@store.test', 'طالبة الطلب', 'user', '01200000032', '2026-09-01');
INSERT INTO public.company_account_requests (user_id, company_name, commercial_registration_number, commercial_registration_expiry, company_email, account_kind, requested_plan, requested_billing_cycle, status)
VALUES ('5c000000-0000-4000-8000-000000000001', 'متجر الطلب', 'CR-RQ-133', '2030-01-01', 'rq@store.test', 'ecommerce_store', 'store', 'monthly', 'pending');
INSERT INTO t.saved VALUES ('rq_req', (select id::text from public.company_account_requests where user_id = '5c000000-0000-4000-8000-000000000001'));
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM t.ok(t.err(t.u('AD'), 'public.owner_store_requests()') = '42501', '⑨ القراءة للمالك وحده');
  PERFORM t.ctx('owner');
  r := t.call(t.u('OW'), 'public.owner_store_requests()');
  PERFORM t.ok(jsonb_array_length(r) = 1 and r->0->>'company_name' = 'متجر الطلب', '⑨ طلب معلّق واحد');
  PERFORM t.ok(t.err(t.u('OW'), format('public.owner_store_request_decide(%L, ''approve'', ''قصير'')', t.sv('rq_req'))) = '22023', '⑨ سبب قصير');
  PERFORM t.ok(t.err(t.u('OW'), format('public.owner_store_request_decide(%L, ''maybe'', ''اعتماد طلب متجر الاختبار'')', t.sv('rq_req'))) = '22023', '⑨ قرار غير معروف');
  r := t.call(t.u('OW'), format('public.owner_store_request_decide(%L, ''approve'', ''اعتماد طلب متجر الاختبار'')', t.sv('rq_req')));
  PERFORM t.ok((r->>'status') = 'approved' and (r->>'decision') = 'approve' and (r->>'company_id') is not null, '⑨ اعتماد ينشئ الشركة');
  PERFORM t.ok((select account_kind from public.companies where id = (r->>'company_id')::uuid) = 'ecommerce_store', '⑨ الشركة الجديدة متجر');
  PERFORM t.ok(exists (select 1 from public.privileged_audit where action = 'store.request_decided'), '⑨ مدقَّق');
  PERFORM t.ok(t.err(t.u('OW'), format('public.owner_store_request_decide(%L, ''approve'', ''اعتماد طلب متجر الاختبار'')', t.sv('rq_req'))) = '22023', '⑨ قرار ثانٍ مرفوض');
  INSERT INTO public.company_account_requests (user_id, company_name, commercial_registration_number, commercial_registration_expiry, company_email, account_kind, requested_plan, requested_billing_cycle, status)
  VALUES ('5c000000-0000-4000-8000-000000000002', 'متجر الطلب الثاني', 'CR-RQ2-133', '2030-01-01', 'rq2@store.test', 'ecommerce_store', 'store', 'yearly', 'pending');
  r := t.call(t.u('OW'), format('public.owner_store_request_decide(%L, ''reject'', ''رفض طلب متجر الاختبار'')',
    (select id from public.company_account_requests where user_id = '5c000000-0000-4000-8000-000000000002')));
  PERFORM t.ok((r->>'status') = 'rejected', '⑨ رفض بسبب');
  PERFORM t.ok(exists (select 1 from public.notifications where user_id = '5c000000-0000-4000-8000-000000000002' and type = 'warning'), '⑨ الرفض يُخطر صاحب الطلب');
  INSERT INTO public.company_account_requests (user_id, company_name, commercial_registration_number, commercial_registration_expiry, company_email, account_kind, status)
  VALUES ('5c000000-0000-4000-8000-000000000002', 'شركة عادية', 'CR-RQ3-133', '2030-01-01', 'rq2@store.test', 'company', 'pending');
  PERFORM t.ok(t.err(t.u('OW'), format('public.owner_store_request_decide(%L, ''approve'', ''اعتماد طلب متجر الاختبار'')',
    (select id from public.company_account_requests where commercial_registration_number = 'CR-RQ3-133'))) = '22023', '⑨ طلب شركة عادية ليس من هذه الصفحة');
  PERFORM t.ctx(null);
  RAISE NOTICE 'PASS ⑨ طلبات المتاجر: قراءة وقرار عبر المراجعة القائمة';
END $$;

-- ══ ⑩ حد التذاكر والمزايا + مبدّل المزوّد ═══════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM t.ctx('owner');
  r := t.call(t.u('OW'), 'public.owner_store_plan_config()');
  PERFORM t.ok((r->>'quota_defined')::boolean = false and (r->>'ticket_quota') is null, '⑩ بلا حد تعريفًا');
  PERFORM t.ok(jsonb_array_length(r->'features') = 5, '⑩ خمس مزايا');
  PERFORM t.ok(t.err(t.u('AD'), 'public.owner_set_store_plan_quota_features(100, ''{integrations_hub}'', ''تحديد حد ومزايا للاختبار'')') = '42501', '⑩ ليس للمالك');
  PERFORM t.ok(t.err(t.u('OW'), 'public.owner_set_store_plan_quota_features(0, ''{integrations_hub}'', ''تحديد حد ومزايا للاختبار'')') = '22023', '⑩ حد صفر مرفوض');
  PERFORM t.ok(t.err(t.u('OW'), 'public.owner_set_store_plan_quota_features(100, ''{nope}'', ''تحديد حد ومزايا للاختبار'')') = '22023', '⑩ ميزة غير معروفة');
  PERFORM t.ok(t.err(t.u('OW'), 'public.owner_set_store_plan_quota_features(100, ''{integrations_hub}'', ''قصير'')') = '22023', '⑩ سبب قصير');
  r := t.call(t.u('OW'), 'public.owner_set_store_plan_quota_features(100, ''{integrations_hub, shopify_integration}'', ''تحديد حد ومزايا للاختبار'')');
  PERFORM t.ok((r->>'ticket_quota')::int = 100, '⑩ الحد 100');
  PERFORM t.ok((select count(*) from jsonb_array_elements(r->'features') e where (e->>'enabled')::boolean) = 2, '⑩ ميزتان مفعّلتان');
  r := t.call(t.u('OW'), 'public.owner_set_store_plan_quota_features(null, ''{support_tickets, sub_users, integrations_hub, shopify_integration, store_support}'', ''إلغاء حد التذاكر للاختبار'')');
  PERFORM t.ok((r->>'ticket_quota') is null and (r->>'quota_defined')::boolean, '⑩ إلغاء الحد = null');
  PERFORM t.ok(exists (select 1 from public.privileged_audit where action = 'store.plan_quota_features'), '⑩ مدقَّق');
  PERFORM t.ok(t.err(t.u('AD'), 'public.owner_set_shopify_provider_enabled(false, ''إيقاف مزود الاختبار'')') = '42501', '⑩ المبدّل للمالك وحده');
  PERFORM t.ok(t.err(t.u('OW'), 'public.owner_set_shopify_provider_enabled(false, ''قصير'')') = '22023', '⑩ سبب قصير');
  PERFORM t.ok(t.err(t.u('OW'), 'public.owner_set_shopify_provider_enabled(null, ''إيقاف مزود الاختبار'')') = '22023', '⑩ بلا قيمة');
  r := t.call(t.u('OW'), 'public.owner_set_shopify_provider_enabled(false, ''إيقاف مزود الاختبار'')');
  PERFORM t.ok((r->>'enabled')::boolean = false, '⑩ إيقاف المزوّد');
  r := t.call(t.u('OW'), 'public.owner_set_shopify_provider_enabled(true, ''تشغيل مزود الاختبار'')');
  PERFORM t.ok((r->>'enabled')::boolean, '⑩ إعادة التشغيل');
  PERFORM t.ok(exists (select 1 from public.privileged_audit where action = 'store.provider_enabled'), '⑩ مدقَّق');
  PERFORM t.ctx(null);
  RAISE NOTICE 'PASS ⑩ حد التذاكر والمزايا ومبدّل المزوّد';
END $$;

-- ══ ⑪ التنبيهات وسجل العمليات ══════════════════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  UPDATE public.ihub_connections SET status = 'error', last_error_code = 'timeout', last_sync_status = 'failed' WHERE id = t.sv('cn_a')::uuid;
  UPDATE public.whatsapp_subscriptions SET status = 'expired' WHERE user_id = t.s('ST') AND plan = 'store';
  INSERT INTO public.ihub_webhook_events (connection_id, company_id, provider, topic, dedupe_key, external_type, status, received_at, attempts, last_error_code)
  VALUES (t.sv('cn_a')::uuid, t.sv('co_ST')::uuid, 'shopify', 'orders/create', t.h('a1'), 'order', 'dead', now() - interval '1 hour', 6, 'timeout');
  INSERT INTO public.ihub_compliance_requests (connection_id, company_id, provider, topic, status, received_at)
  VALUES (t.sv('cn_a')::uuid, t.sv('co_ST')::uuid, 'shopify', 'customers/redact', 'received', now() - interval '1 hour');
  PERFORM t.ok(t.err(t.u('AD'), 'public.owner_store_alerts()') = '42501', '⑪ التنبيهات للمالك وحده');
  PERFORM t.ctx('owner');
  r := t.call(t.u('OW'), 'public.owner_store_alerts()');
  PERFORM t.ok((r->>'count')::int >= 5, '⑪ خمسة تنبيهات على الأقل: ' || (r->>'count'));
  PERFORM t.ok((r->>'critical')::int >= 1, '⑪ حرج واحد على الأقل');
  PERFORM t.ok(exists (select 1 from jsonb_array_elements(r->'alerts') a where a->>'kind' = 'connection_error'), '⑪ ربط بخطأ');
  PERFORM t.ok(exists (select 1 from jsonb_array_elements(r->'alerts') a where a->>'kind' = 'sync_failed'), '⑪ مزامنة فاشلة');
  PERFORM t.ok(exists (select 1 from jsonb_array_elements(r->'alerts') a where a->>'kind' = 'dead_events'), '⑪ أحداث ميتة');
  PERFORM t.ok(exists (select 1 from jsonb_array_elements(r->'alerts') a where a->>'kind' = 'compliance_pending'), '⑪ خصوصية معلّقة');
  PERFORM t.ok(exists (select 1 from jsonb_array_elements(r->'alerts') a where a->>'kind' = 'no_entitlement'), '⑪ ربط حي بلا امتياز');
  PERFORM t.ok(not (r::text ~* 'ciphertext|access_token|refresh_token|secret'), '⑪ بلا أسرار');
  r := t.call(t.u('OW'), 'public.owner_store_operations_log(30)');
  PERFORM t.ok(jsonb_array_length(r) >= 5, '⑪ عمليات مسجّلة');
  PERFORM t.ok(exists (select 1 from jsonb_array_elements(r) a where a->>'action' = 'store.plan_price'), '⑪ سعر الباقة في السجل');
  PERFORM t.ok(exists (select 1 from jsonb_array_elements(r) a where a->>'action' = 'store.grant_exception'), '⑪ المنح في السجل');
  PERFORM t.ok(exists (select 1 from jsonb_array_elements(r) a where a->>'action' = 'store.subscription_pause'), '⑪ الإيقاف في السجل');
  PERFORM t.ok(exists (select 1 from jsonb_array_elements(r) a where (a->>'summary') <> ''), '⑪ ملخص عربي');
  r := t.call(t.u('OW'), 'public.owner_store_operations_log(2)');
  PERFORM t.ok(jsonb_array_length(r) = 2, '⑪ الحد يعمل');
  PERFORM t.ok(t.err(t.u('AD'), 'public.owner_store_operations_log(30)') = '42501', '⑪ السجل للمالك وحده');
  PERFORM t.ctx(null);
  RAISE NOTICE 'PASS ⑪ التنبيهات وسجل العمليات';
END $$;

-- ══ ⑫ فلاتر الحسابات والبحث بدومين المتجر ═══════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM t.ctx('owner');
  r := t.call(t.u('OW'), 'public.owner_accounts_overview(''ecommerce_store'')');
  PERFORM t.ok((r->>'total')::int >= 2, '⑫ النداء القديم بمعامل واحد يعمل');
  r := t.call(t.u('OW'), 'public.owner_accounts_overview(null, null, 50, 0, ''active'', null, null)');
  PERFORM t.ok((r->>'total')::int >= 1, '⑫ فعّال: واحد على الأقل');
  r := t.call(t.u('OW'), 'public.owner_accounts_overview(null, null, 50, 0, ''none'', null, null)');
  PERFORM t.ok((r->>'total')::int >= 1, '⑫ بلا اشتراك: واحد على الأقل');
  r := t.call(t.u('OW'), 'public.owner_accounts_overview(null, null, 50, 0, null, ''error'', null)');
  PERFORM t.ok((r->>'total')::int >= 1, '⑫ شوبيفاي خطأ: واحد على الأقل');
  r := t.call(t.u('OW'), 'public.owner_accounts_overview(null, ''shop-a.myshopify.com'', 50, 0, null, null, null)');
  PERFORM t.ok((r->>'total')::int >= 1 and r->'items'->0->>'company_name' = 'متجر ST', '⑫ بحث بدومين المتجر');
  r := t.call(t.u('OW'), 'public.owner_accounts_overview(null, null, 50, 0, null, null, true)');
  PERFORM t.ok((r->>'total')::int = 0, '⑫ موقوفة: لا شيء');
  PERFORM t.ok(t.err(t.u('OW'), 'public.owner_accounts_overview(null, null, 50, 0, ''bogus'', null, null)') = '22023', '⑫ حالة اشتراك غير صالحة');
  PERFORM t.ctx(null);
  RAISE NOTICE 'PASS ⑫ فلاتر الحسابات والبحث بدومين المتجر';
END $$;

-- ══ ⑬ التراجع الموسّع ═══════════════════════════════════════════════════
\i migrations/_rollback/133_owner_store_price_and_sync_actions.down.sql
DO $$
BEGIN
  PERFORM t.ok(to_regprocedure('public.owner_store_grant_exception(uuid,text,timestamptz,text)') is null, '⑬ المنح حُذف');
  PERFORM t.ok(to_regprocedure('public.owner_store_alerts()') is null, '⑬ التنبيهات حُذفت');
  PERFORM t.ok(to_regprocedure('public.owner_set_shopify_provider_enabled(boolean,text)') is null, '⑬ المبدّل حُذف');
  PERFORM t.ok(to_regprocedure('public.owner_accounts_overview(text,text,integer,integer,text,text,boolean)') is not null, '⑬ فلاتر الحسابات باقية (موثّق)');
  PERFORM t.ok((select price_monthly from public.subscription_plans where key = 'store') = 500, '⑬ السعر 500 باقٍ (بيانات)');
END $$;
\i migrations/133_owner_store_price_and_sync_actions.sql
SET search_path = public, extensions;
DO $$
BEGIN
  PERFORM t.ok(to_regprocedure('public.owner_store_grant_exception(uuid,text,timestamptz,text)') is not null, '⑬ إعادة التطبيق');
  PERFORM t.ok(to_regprocedure('public.owner_store_alerts()') is not null, '⑬ والتنبيهات');
  RAISE NOTICE 'PASS ⑬ التراجع يحذف دوال 133، وإعادة التطبيق تنجح';
  RAISE NOTICE 'ALL 133 OWNER STORE PRICE AND SYNC ACTIONS TESTS PASSED';
END $$;
