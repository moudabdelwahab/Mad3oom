-- ============================================================================
-- 135_owner_store_plan_deactivate_pause_sync على نسخة مطابقة للإنتاج + 118 + 119 + 133
--
--   ⓪ 135 مرتين: قابل لإعادة التشغيل، والتوقيع الواحد للسعر، والبوابة الجديدة
--   ① سعر باقة المتاجر 500/5000: الحفظ والتفعيل والإلغاء (بلا تفعيل من الترحيل نفسه)
--   ② تمديد الإيقاف المزدوج: التاريخ اليدوي أثناء الإيقاف نهائي عند الاستئناف
--   ③ حد الدقيقتين: المهمة القائمة تُعاد بلا مكرر وبلا تدقيق مضلِّل (المالك + التوأم 119)
--   ④ إعداد الباقة يعيد التفعيل والسعرين (لنموذج السعر بلا تشخيص)
--   ⑤ سجل العمليات يلخّص الإلغاء بالعربي
--   ⑥ التراجع يعيد توقيع 133، وإعادة التطبيق تنجح
-- ============================================================================
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
SET client_min_messages = warning;

\i tests/fixtures/ecommerce/chain.sql

CREATE OR REPLACE FUNCTION t.s(p text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  select (case p
    when 'ST' then '5a000000-0000-4000-8000-000000000001' when 'SX' then '5b000000-0000-4000-8000-000000000001'
    when 'S5' then '5d000000-0000-4000-8000-000000000005' when 'S6' then '5d000000-0000-4000-8000-000000000006'
  end)::uuid $$;
CREATE OR REPLACE FUNCTION t.h(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ select encode(sha256(convert_to(p, 'UTF8')), 'hex') $$;
CREATE OR REPLACE FUNCTION t.sv(p_k text) RETURNS text LANGUAGE sql AS $$ select v from t.saved where k = p_k $$;
-- نداء بدور service_role (الدوال الطرفية)
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
-- ① الترحيل نفسه لا يفعّل: أصفّر الباقة قبل تطبيق 135
UPDATE public.subscription_plans SET price_monthly = null, price_yearly = null, is_active = false WHERE key = 'store';
\i migrations/135_owner_store_plan_deactivate_pause_sync.sql
\i migrations/135_owner_store_plan_deactivate_pause_sync.sql
SET search_path = public, extensions;

-- ── متجر تاجر جديد بربط Shopify نشط واشتراك فعّال ───────────────────────
INSERT INTO auth.users (id, email, email_confirmed_at)
VALUES (t.s('S5'), 's5@store.test', now() - interval '30 days');
INSERT INTO public.profiles (id, email, full_name, role, phone, created_at) VALUES
  (t.s('S5'), 's5@store.test', 'تاجر ج', 'user', '01200000005', '2026-09-01');
DO $$
DECLARE r jsonb;
BEGIN
  r := t.call(t.s('S5'), format('public.submit_store_account_request(%L, %L, ''2030-01-01'')', 'متجر S5', 'CR-S5-135'));
  r := t.call(t.u('AD'), format('public.admin_review_company_account_request(%L, ''approve'')', r->>'id'));
  INSERT INTO t.saved VALUES ('co_S5', r->>'company_id');
  INSERT INTO public.whatsapp_subscriptions (user_id, plan, status, billing_cycle, start_date, end_date, duration_days, company_id)
  VALUES (t.s('S5'), 'store', 'active', 'monthly', now() - interval '1 day', now() + interval '29 days', 30, (r->>'company_id')::uuid);
  INSERT INTO t.saved VALUES ('sub_s5', (select id::text from public.whatsapp_subscriptions
    where company_id = (r->>'company_id')::uuid and plan = 'store' order by created_at desc limit 1));
END $$;
UPDATE public.ihub_providers SET enabled = true WHERE key = 'shopify';
DO $$
DECLARE r jsonb;
BEGIN
  r := t.call(t.s('S5'), 'public.ihub_prepare_connection(''shopify'', ''متجري'')');
  INSERT INTO t.saved VALUES ('cn_s5', r->>'id');
  r := t.svc(format('public.ihub_svc_activate(%L, ''shop-s5.myshopify.com'', ''متجر ج'', ''https://shop-s5.myshopify.com'', %L)', t.sv('cn_s5'), t.s('S5')));
  PERFORM t.ok(r->>'status' = 'active', 'HARNESS الربط نشط');
END $$;

-- ══ ⓪ إعادة التطبيق والتوقيع الواحد والبوابة ═══════════════════════════
DO $$
DECLARE v_def text;
BEGIN
  PERFORM t.ok(to_regprocedure('public.owner_set_store_plan_price(numeric,numeric,boolean,boolean,text)') is not null, '⓪ توقيع 135 للسعر');
  PERFORM t.ok(to_regprocedure('public.owner_set_store_plan_price(numeric,numeric,boolean)') is null, '⓪ توقيع 133 للسعر حُذف');
  PERFORM t.ok((select price_monthly from public.subscription_plans where key = 'store') is null
               and (select price_yearly from public.subscription_plans where key = 'store') is null
               and not (select is_active from public.subscription_plans where key = 'store'), '⓪ 135 لم يحدّد سعرًا ولم يفعّل');
  v_def := pg_get_functiondef('public.owner_ihub_sync_request(uuid)'::regprocedure);
  PERFORM t.ok(v_def like '%existing%' and v_def not like '%and not exists (select 1 from public.ihub_sync_jobs%', '⓪ بوابة المالك بلا الشرط المعكوس');
  v_def := pg_get_functiondef('public.ihub_sync_request(uuid)'::regprocedure);
  PERFORM t.ok(v_def like '%_ihub_shopify_admin%' and v_def like '%existing%'
               and v_def not like '%and not exists (select 1 from public.ihub_sync_jobs%', '⓪ بوابة التوأم 119 كما هي بلا المعكوس');
  PERFORM t.ok(to_regprocedure('public._ihub_enqueue_sync(uuid,text,uuid)') is not null, '⓪ _ihub_enqueue_sync كما هو');
  RAISE NOTICE 'PASS ⓪ 135 قابل لإعادة التشغيل؛ الترحيل لم يفعّل الباقة';
END $$;

-- ══ ① السعر 500/5000 والتفعيل والإلغاء ════════════════════════════════
DO $$
DECLARE r jsonb; v_active boolean;
BEGIN
  PERFORM t.ctx('owner');
  PERFORM t.ok(t.err(t.u('AD'), 'public.owner_set_store_plan_price(500, 5000, false)') = '42501', '① ليس للمالك');
  DELETE FROM public.privileged_step_ups WHERE user_id = t.u('OW');
  PERFORM t.ok(t.err(t.u('OW'), 'public.owner_set_store_plan_price(500, 5000, false)') = '42501', '① بلا تحقق حديث');
  PERFORM t.stepup(t.u('OW'));
  PERFORM t.ok(t.err(t.u('OW'), 'public.owner_set_store_plan_price(500, 5000, true, true, ''تفعيل وإلغاء معًا للاختبار'')') = '22023', '① تفعيل وإلغاء معًا مرفوضان');
  PERFORM t.ok(t.err(t.u('OW'), 'public.owner_set_store_plan_price(0, 5000, false, true, ''إلغاء تفعيل الباقة للاختبار'')') = '22023', '① إلغاء بسعر صفر مرفوض');
  -- الحفظ العادي بالنداء القديم ذي الثلاثة معاملات: سعر بلا تغيير للتفعيل
  r := t.call(t.u('OW'), 'public.owner_set_store_plan_price(500, 5000, false)');
  PERFORM t.ok((r->>'price_monthly')::numeric = 500 and (r->>'price_yearly')::numeric = 5000
               and (r->>'currency') = 'EGP' and not (r->>'is_active')::boolean
               and not (r->>'activated')::boolean and not (r->>'deactivated')::boolean, '① حفظ 500/5000 بلا تفعيل');
  PERFORM t.ok((select price_monthly from public.subscription_plans where key = 'store') = 500, '① السعر 500 في القاعدة');
  -- التفعيل الصريح من المالك (إجراء يدوي — ليس من الترحيل)
  r := t.call(t.u('OW'), 'public.owner_set_store_plan_price(500, 5000, true)');
  PERFORM t.ok((r->>'is_active')::boolean and (r->>'activated')::boolean, '① تفعيل صريح مع السعرين');
  -- الحفظ العادي لا يلغي تفعيلًا قائمًا
  r := t.call(t.u('OW'), 'public.owner_set_store_plan_price(600, 6000, false)');
  PERFORM t.ok((r->>'is_active')::boolean and (r->>'price_monthly')::numeric = 600, '① حفظ السعر لا يوقف المفعّلة');
  -- الإلغاء بسعرين null: يبقي السعرين ويوقف الباقة
  r := t.call(t.u('OW'), 'public.owner_set_store_plan_price(null, null, false, true, ''إلغاء تفعيل الباقة للاختبار'')');
  PERFORM t.ok(not (r->>'is_active')::boolean and (r->>'deactivated')::boolean
               and (r->>'price_monthly')::numeric = 600 and (r->>'price_yearly')::numeric = 6000, '① إلغاء يبقي السعرين');
  -- إلغاء الموقوفة أصلًا: بلا أثر، وdeactivated=false
  r := t.call(t.u('OW'), 'public.owner_set_store_plan_price(null, null, false, true, ''إلغاء تفعيل الباقة للاختبار'')');
  PERFORM t.ok(not (r->>'is_active')::boolean and not (r->>'deactivated')::boolean, '① إلغاء الثانية بلا أثر');
  PERFORM t.ok(exists (select 1 from public.privileged_audit where action = 'store.plan_price'
                       and (new_value->>'deactivated')::boolean), '① الإلغاء مدقَّق');
  -- إعادة التفعيل بـ 500/5000 لحاجة باقي الأقسام
  r := t.call(t.u('OW'), 'public.owner_set_store_plan_price(500, 5000, true)');
  PERFORM t.ok((r->>'is_active')::boolean and (r->>'price_monthly')::numeric = 500, '① إعادة تفعيل 500/5000');
  PERFORM t.ctx(null);
  RAISE NOTICE 'PASS ① حفظ 500/5000 وتفعيل وإلغاء بلا تفعيل من الترحيل';
END $$;

-- ══ ② تمديد الإيقاف المزدوج ═══════════════════════════════════════════
DO $$
DECLARE r jsonb; v_sub uuid := t.sv('sub_s5')::uuid; v_manual timestamptz; v_end timestamptz;
BEGIN
  PERFORM t.ctx('owner');
  PERFORM t.ok(t.err(t.u('OW'), format('public.owner_store_pause(%L, ''إيقاف للاختبار'')', v_sub)) = 'ok', '② إيقاف الفعّال');
  UPDATE public.whatsapp_subscriptions SET paused_at = now() - interval '2 hours' WHERE id = v_sub;
  v_manual := date_trunc('second', now() + interval '40 days');
  r := t.call(t.u('OW'), format('public.owner_store_set_end_date(%L, %L, ''تعديل انتهاء أثناء الإيقاف'')', v_sub, v_manual));
  PERFORM t.ok((r->>'end_date_set_while_paused')::boolean, '② علامة التعديل اليدوي أثناء الإيقاف');
  PERFORM t.ok((r->>'end_date')::timestamptz = v_manual, '② التاريخ اليدوي محفوظ');
  r := t.call(t.u('OW'), format('public.owner_store_resume(%L, ''استئناف للاختبار'')', v_sub));
  PERFORM t.ok((r->>'status') = 'active' and (r->>'end_date')::timestamptz = v_manual, '② الاستئناف لم يمدّد التاريخ اليدوي');
  PERFORM t.ok(not (r->>'end_date_set_while_paused')::boolean, '② العلامة مُسحت عند الاستئناف');
  PERFORM t.ok(exists (select 1 from public.subscription_audit_log where subscription_id = v_sub and action = 'resume'
                       and new_values->>'resume_basis' = 'manual_end_date'), '② أساس الاستئناف manual_end_date مدقَّق');
  -- المسار العادي بلا تعديل يدوي: التمديد بمدة التوقف كما في 133
  PERFORM t.call(t.u('OW'), format('public.owner_store_pause(%L, ''إيقاف للاختبار'')', v_sub));
  UPDATE public.whatsapp_subscriptions SET paused_at = now() - interval '1 hour' WHERE id = v_sub;
  v_end := (select end_date from public.whatsapp_subscriptions where id = v_sub);
  r := t.call(t.u('OW'), format('public.owner_store_resume(%L, ''استئناف للاختبار'')', v_sub));
  PERFORM t.ok((r->>'end_date')::timestamptz >= v_end + interval '59 minutes'
               and (r->>'end_date')::timestamptz <= v_end + interval '61 minutes', '② بلا تعديل: التمديد بساعة التوقف');
  PERFORM t.ok(exists (select 1 from public.subscription_audit_log where subscription_id = v_sub and action = 'resume'
                       and new_values->>'resume_basis' = 'pause_extension'), '② أساس الاستئناف pause_extension مدقَّق');
  -- آخر قرار يفوز (أ): تحويل دورة أثناء الإيقاف ثم تعديل يدوي — اليدوي يفوز
  PERFORM t.call(t.u('OW'), format('public.owner_store_pause(%L, ''إيقاف للاختبار'')', v_sub));
  r := t.call(t.u('OW'), format('public.owner_store_change_cycle(%L, ''yearly'', ''تحويل دورة للاختبار'')', v_sub));
  PERFORM t.ok((r->>'cycle_changed_while_paused')::boolean and not (r->>'end_date_set_while_paused')::boolean, '② أ: علامة الدورة وحدها');
  v_manual := date_trunc('second', now() + interval '50 days');
  r := t.call(t.u('OW'), format('public.owner_store_set_end_date(%L, %L, ''تعديل انتهاء أثناء الإيقاف'')', v_sub, v_manual));
  PERFORM t.ok((r->>'end_date_set_while_paused')::boolean and not (r->>'cycle_changed_while_paused')::boolean, '② أ: اليدوي أبطل علامة الدورة');
  r := t.call(t.u('OW'), format('public.owner_store_resume(%L, ''استئناف للاختبار'')', v_sub));
  PERFORM t.ok((r->>'end_date')::timestamptz = v_manual and (r->>'billing_cycle') = 'yearly', '② أ: الاستئناف بالتاريخ اليدوي');
  -- آخر قرار يفوز (ب): تعديل يدوي ثم تحويل دورة أثناء الإيقاف — الدورة تفوز
  PERFORM t.call(t.u('OW'), format('public.owner_store_pause(%L, ''إيقاف للاختبار'')', v_sub));
  v_manual := date_trunc('second', now() + interval '60 days');
  r := t.call(t.u('OW'), format('public.owner_store_set_end_date(%L, %L, ''تعديل انتهاء أثناء الإيقاف'')', v_sub, v_manual));
  PERFORM t.ok((r->>'end_date_set_while_paused')::boolean, '② ب: علامة يدوية');
  r := t.call(t.u('OW'), format('public.owner_store_change_cycle(%L, ''monthly'', ''تحويل دورة للاختبار'')', v_sub));
  PERFORM t.ok((r->>'cycle_changed_while_paused')::boolean and not (r->>'end_date_set_while_paused')::boolean, '② ب: الدورة أبطلت العلامة اليدوية');
  r := t.call(t.u('OW'), format('public.owner_store_resume(%L, ''استئناف للاختبار'')', v_sub));
  PERFORM t.ok((r->>'end_date')::timestamptz > now() + interval '29 days'
               and (r->>'end_date')::timestamptz < now() + interval '31 days', '② ب: الاستئناف يبدأ الدورة الجديدة كاملة');
  PERFORM t.ctx(null);
  RAISE NOTICE 'PASS ② التاريخ اليدوي أثناء الإيقاف نهائي؛ آخر قرار صريح يفوز';
END $$;

-- ══ ③ حد الدقيقتين: بلا مكرر وبلا تدقيق مضلِّل ═════════════════════════
DO $$
DECLARE r jsonb; v_job bigint; v_n int;
BEGIN
  PERFORM t.ctx('owner');
  PERFORM t.ok(t.err(t.u('AD'), format('public.owner_ihub_sync_request(%L)', t.sv('cn_s5'))) = '42501', '③ المزامنة للمالك وحده');
  r := t.call(t.u('OW'), format('public.owner_ihub_sync_request(%L)', t.sv('cn_s5')));
  PERFORM t.ok((r->>'job_id') is not null and not (r->>'existing')::boolean, '③ مهمة جديدة');
  v_job := (r->>'job_id')::bigint;
  PERFORM t.ok((select count(*) from public.ihub_sync_jobs where connection_id = t.sv('cn_s5')::uuid) = 1, '③ صف مهمة واحد');
  PERFORM t.ok((select count(*) from public.ihub_audit_events where action = 'sync.requested'
                and connection_id = t.sv('cn_s5')::uuid and detail->>'via' = 'owner') = 1, '③ صف تدقيق واحد');
  r := t.call(t.u('OW'), format('public.owner_ihub_sync_request(%L)', t.sv('cn_s5')));
  PERFORM t.ok((r->>'job_id')::bigint = v_job and (r->>'existing')::boolean, '③ مهمة قائمة تُعاد كما هي');
  PERFORM t.ok((select count(*) from public.ihub_sync_jobs where connection_id = t.sv('cn_s5')::uuid) = 1, '③ بلا صف مكرر');
  PERFORM t.ok((select count(*) from public.ihub_audit_events where action = 'sync.requested'
                and connection_id = t.sv('cn_s5')::uuid and detail->>'via' = 'owner') = 1, '③ بلا صف تدقيق مضلِّل');
  UPDATE public.ihub_sync_jobs SET status = 'succeeded', finished_at = now() WHERE id = v_job;
  PERFORM t.ok(t.err(t.u('OW'), format('public.owner_ihub_sync_request(%L)', t.sv('cn_s5'))) = 'P0001', '③ حد الدقيقتين على المنتهية');
  UPDATE public.ihub_sync_jobs SET finished_at = now() - interval '3 minutes' WHERE id = v_job;
  r := t.call(t.u('OW'), format('public.owner_ihub_sync_request(%L)', t.sv('cn_s5')));
  PERFORM t.ok((r->>'job_id') is not null and not (r->>'existing')::boolean, '③ بعد 3 دقائق: مهمة جديدة');
  v_job := (r->>'job_id')::bigint;
  PERFORM t.ctx(null);
  -- التوأم 119 بسياق مدير المتجر: نفس البوابة
  r := t.call(t.s('S5'), format('public.ihub_sync_request(%L)', t.sv('cn_s5')));
  PERFORM t.ok((r->>'job_id')::bigint = v_job and (r->>'existing')::boolean, '③ التوأم يعيد القائمة');
  PERFORM t.ok((select count(*) from public.ihub_sync_jobs where connection_id = t.sv('cn_s5')::uuid) = 2, '③ التوأم بلا مكرر');
  UPDATE public.ihub_sync_jobs SET status = 'succeeded', finished_at = now() WHERE id = v_job;
  PERFORM t.ok(t.err(t.s('S5'), format('public.ihub_sync_request(%L)', t.sv('cn_s5'))) = 'P0001', '③ التوأم: حد الدقيقتين');
  UPDATE public.ihub_sync_jobs SET finished_at = now() - interval '3 minutes' WHERE id = v_job;
  r := t.call(t.s('S5'), format('public.ihub_sync_request(%L)', t.sv('cn_s5')));
  PERFORM t.ok((r->>'job_id') is not null and not (r->>'existing')::boolean, '③ التوأم بعد 3 دقائق: مهمة جديدة');
  RAISE NOTICE 'PASS ③ المهمة القائمة تُعاد بلا مكرر؛ حد الدقيقتين على المنتهية وحدها';
END $$;

-- ══ ④ إعداد الباقة يعيد التفعيل والسعرين ═════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM t.ctx('owner');
  r := t.call(t.u('OW'), 'public.owner_store_plan_config()');
  PERFORM t.ok((r->>'is_active')::boolean and (r->>'price_monthly')::numeric = 500
               and (r->>'price_yearly')::numeric = 5000 and (r->>'currency') = 'EGP', '④ التفعيل والسعران في الإعداد');
  PERFORM t.ok(jsonb_array_length(r->'features') = 5, '④ خمس مزايا كما في 133');
  PERFORM t.ctx(null);
  RAISE NOTICE 'PASS ④ إعداد الباقة يعيد التفعيل والسعرين لنموذج السعر';
END $$;

-- ══ ⑤ سجل العمليات يلخّص الإلغاء ═════════════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM t.ctx('owner');
  r := t.call(t.u('OW'), 'public.owner_set_store_plan_price(null, null, false, true, ''إلغاء تفعيل الباقة للاختبار'')');
  PERFORM t.ok(not (r->>'is_active')::boolean, '⑤ إلغاء للسجل');
  r := t.call(t.u('OW'), 'public.owner_store_operations_log(30)');
  PERFORM t.ok(exists (select 1 from jsonb_array_elements(r) a where a->>'action' = 'store.plan_price'
                       and (a->>'summary') like '%أُلغي تفعيلها%'), '⑤ ملخص الإلغاء بالعربي');
  PERFORM t.call(t.u('OW'), 'public.owner_set_store_plan_price(500, 5000, true)');
  PERFORM t.ctx(null);
  RAISE NOTICE 'PASS ⑤ سجل العمليات يلخّص إلغاء التفعيل';
END $$;

-- ══ ⑥ التراجع ═══════════════════════════════════════════════════════
\i migrations/_rollback/135_owner_store_plan_deactivate_pause_sync.down.sql
DO $$
BEGIN
  PERFORM t.ok(to_regprocedure('public.owner_set_store_plan_price(numeric,numeric,boolean,boolean,text)') is null, '⑥ توقيع 135 حُذف');
  PERFORM t.ok(to_regprocedure('public.owner_set_store_plan_price(numeric,numeric,boolean)') is not null, '⑥ توقيع 133 عاد');
  PERFORM t.ok((select price_monthly from public.subscription_plans where key = 'store') = 500, '⑥ السعر 500 باقٍ (بيانات)');
END $$;
\i migrations/135_owner_store_plan_deactivate_pause_sync.sql
SET search_path = public, extensions;
DO $$
BEGIN
  PERFORM t.ok(to_regprocedure('public.owner_set_store_plan_price(numeric,numeric,boolean,boolean,text)') is not null, '⑥ إعادة التطبيق');
  PERFORM t.ok(to_regprocedure('public.owner_set_store_plan_price(numeric,numeric,boolean)') is null, '⑥ التوقيع الواحد بعد إعادة التطبيق');
  RAISE NOTICE 'PASS ⑥ التراجع يعيد توقيع 133، وإعادة التطبيق تنجح';
  RAISE NOTICE 'ALL 135 OWNER STORE PLAN DEACTIVATE PAUSE SYNC TESTS PASSED';
END $$;
