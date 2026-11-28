-- ============================================================================
-- 162_store_into_super على نسخة مطابقة للإنتاج + 118 + 119 + 133 + 135 + 137
-- + 142_trial_request_notification
--
--   ⓪ 162 مرتين: قابل لإعادة التشغيل، والدوال موجودة بتوقيعاتها
--   ① الفائقة تكتسب مزايا المتجر الثلاثة، والمتجر متقاعد بلا سعرين، وباقي
--      الأسعار بلا تغيير، والشاملة بلا مزايا متجر، وصفوف مزايا المتجر باقية
--   ② company_has_feature: صحيح لاشتراك فائقة فعّال، وخطأ لاشتراك دعم فقط
--   ③ اشتراك متجر قائم: يحتفظ بمزاياه، والإيقاف/الاستئناف/تعديل الانتهاء
--      تعمل، وتحويل الدورة يستخدم سعري اللقطة مع سعرَي باقة NULL،
--      ويرفض 22023 بلا سعرين في الموضعين
--   ④ الدوال المتقاعدة: 42501 لغير المالك، و22023 برسالة الدمج للمالك
--   ⑤ التجربة: طلب store مرفوض 22023، وultimate يعمل، وحالة الشركة بلا
--      store، وإدخال store المباشر مرفوض بقيد الخطة
--   ⑥ طلب حساب متجر: store مرفوض 22023، وultimate يعمل بلا دفع مسبق
--   ⑦ التراجع يعيد الفائقة بلا مزايا المتجر والقيد إلى 3 خطط ودالة السعر
--      لحالها؛ وإعادة تطبيق 162 تنجح
-- ============================================================================
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
SET client_min_messages = warning;

\i tests/fixtures/ecommerce/chain.sql

CREATE OR REPLACE FUNCTION t.s(p text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  select (case p
    when 'S8' then '5f000000-0000-4000-8000-000000000008'
    when 'S9' then '5f000000-0000-4000-8000-000000000009'
  end)::uuid $$;
CREATE OR REPLACE FUNCTION t.h(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ select encode(sha256(convert_to(p, 'UTF8')), 'hex') $$;
CREATE OR REPLACE FUNCTION t.sv(p_k text) RETURNS text LANGUAGE sql AS $$ select v from t.saved where k = p_k $$;

\i migrations/118_ecommerce_store_accounts.sql
\i migrations/119_shopify_store_integration.sql
\i migrations/133_owner_store_price_and_sync_actions.sql
\i migrations/135_owner_store_plan_deactivate_pause_sync.sql
\i migrations/137_saas_trial_3_days.sql
\i migrations/142_trial_request_notification.sql
\i migrations/162_store_into_super.sql
\i migrations/162_store_into_super.sql
SET search_path = public, extensions;

-- ── متجر تاجر جديد (S8) بلا اشتراك ───────────────────────────────────────
INSERT INTO auth.users (id, email, email_confirmed_at)
VALUES (t.s('S8'), 's8@store.test', now() - interval '30 days');
INSERT INTO public.profiles (id, email, full_name, role, phone, created_at) VALUES
  (t.s('S8'), 's8@store.test', 'تاجر ح', 'user', '01200000008', '2026-09-01');
DO $$
DECLARE r jsonb;
BEGIN
  r := t.call(t.s('S8'), format('public.submit_store_account_request(%L, %L, ''2030-01-01'')', 'متجر S8', 'CR-S8-162'));
  r := t.call(t.u('AD'), format('public.admin_review_company_account_request(%L, ''approve'')', r->>'id'));
  INSERT INTO t.saved VALUES ('co_S8', r->>'company_id');
  PERFORM t.ok((select account_kind from public.companies where id = (r->>'company_id')::uuid) = 'ecommerce_store', 'HARNESS شركة S8 متجر إلكتروني');
END $$;
-- تاجر جديد (S9) بلا شركة — لطلب حساب المتجر في ⑥
INSERT INTO auth.users (id, email, email_confirmed_at)
VALUES (t.s('S9'), 's9@store.test', now() - interval '30 days');
INSERT INTO public.profiles (id, email, full_name, role, phone, created_at) VALUES
  (t.s('S9'), 's9@store.test', 'تاجر ط', 'user', '01200000009', '2026-09-01');

-- ══ ⓪ إعادة التطبيق والدوال ═══════════════════════════════════════════
DO $$
BEGIN
  PERFORM t.ok(to_regprocedure('public.owner_set_store_plan_price(numeric,numeric,boolean,boolean,text)') is not null, '⓪ توقيع السعر المتقاعد');
  PERFORM t.ok(to_regprocedure('public.owner_store_grant_exception(uuid,text,timestamptz,text)') is not null, '⓪ توقيع المنح المتقاعد');
  PERFORM t.ok(to_regprocedure('public.owner_set_store_plan_quota_features(integer,text[],text)') is not null, '⓪ توقيع الحصة المتقاعد');
  PERFORM t.ok(to_regprocedure('public.request_saas_trial(text)') is not null, '⓪ request_saas_trial');
  PERFORM t.ok(to_regprocedure('public._trial_plan_allowed(text,text)') is not null, '⓪ _trial_plan_allowed');
  PERFORM t.ok(to_regprocedure('public.my_saas_trial_status()') is not null, '⓪ my_saas_trial_status');
  PERFORM t.ok(to_regprocedure('public.submit_store_account_request(text,text,date,text,text,text,text,text)') is not null, '⓪ submit_store_account_request');
  PERFORM t.ok(to_regprocedure('public.owner_store_change_cycle(uuid,text,text)') is not null, '⓪ owner_store_change_cycle');
  PERFORM t.ok(to_regprocedure('public.owner_store_plan_config()') is not null, '⓪ owner_store_plan_config');
  RAISE NOTICE 'PASS ⓪ 162 قابل لإعادة التشغيل والدوال موجودة';
END $$;

-- ══ ① المنح والتقاعد والأسعار ══════════════════════════════════════════
DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM public.plan_features pf JOIN public.subscription_plans sp ON sp.id = pf.plan_id
   WHERE sp.key = 'ultimate' AND pf.enabled AND pf.feature_key IN ('integrations_hub', 'shopify_integration', 'store_support');
  PERFORM t.ok(v_n = 3, '① الفائقة تحمل مزايا المتجر الثلاثة مفعّلة');
  PERFORM t.ok((select is_active from public.subscription_plans where key = 'store') = false, '① باقة المتجر غير مفعّلة');
  PERFORM t.ok((select price_monthly from public.subscription_plans where key = 'store') is null
           and (select price_yearly from public.subscription_plans where key = 'store') is null, '① باقة المتجر بلا سعرين');
  PERFORM t.ok((select price_monthly from public.subscription_plans where key = 'support') = 999
           and (select price_yearly from public.subscription_plans where key = 'support') = 9999, '① سعر الدعم 999/9999 بلا تغيير');
  PERFORM t.ok((select price_monthly from public.subscription_plans where key = 'ultimate') = 1999
           and (select price_yearly from public.subscription_plans where key = 'ultimate') = 19999, '① سعر الفائقة 1999/19999 بلا تغيير');
  PERFORM t.ok((select price_monthly from public.subscription_plans where key = 'whatsapp') = 1299
           and (select price_yearly from public.subscription_plans where key = 'whatsapp') = 12999, '① سعر الواتساب 1299/12999 بلا تغيير');
  PERFORM t.ok((select price_monthly from public.subscription_plans where key = 'bundle') = 2099
           and (select price_yearly from public.subscription_plans where key = 'bundle') = 22999, '① سعر الشاملة 2099/22999 بلا تغيير');
  SELECT count(*) INTO v_n FROM public.plan_features pf JOIN public.subscription_plans sp ON sp.id = pf.plan_id
   WHERE sp.key = 'bundle' AND pf.enabled AND pf.feature_key IN ('integrations_hub', 'shopify_integration', 'store_support');
  PERFORM t.ok(v_n = 0, '① الشاملة بلا مزايا متجر (الدمج في الفائقة وحدها)');
  SELECT count(*) INTO v_n FROM public.plan_features pf JOIN public.subscription_plans sp ON sp.id = pf.plan_id
   WHERE sp.key = 'store';
  PERFORM t.ok(v_n = 5, '① صفوف مزايا المتجر الخمسة باقية للاشتراكات القائمة');
  PERFORM t.ok(exists (select 1 from public.plan_features pf JOIN public.subscription_plans sp ON sp.id = pf.plan_id
                 where sp.key = 'store' and pf.feature_key = 'shopify_integration' and pf.enabled), '① مزايا المتجر باقية مفعّلة في صف الباقة');
  PERFORM t.ok(not public._trial_plan_allowed('store', 'ecommerce_store'), '① _trial_plan_allowed يرفض store');
  PERFORM t.ok(public._trial_plan_allowed('ultimate', 'ecommerce_store'), '① _trial_plan_allowed يقبل ultimate للمتجر');
  RAISE NOTICE 'PASS ① المنح والتقاعد والأسعار';
END $$;

-- ══ ② فحص المزايا عبر الاشتراك ════════════════════════════════════════
-- اشتراك فائقة فعّال لشركة أ (OA) — شركة الدعم وحدها (CW) تبقى بلا الميزة
INSERT INTO public.whatsapp_subscriptions (user_id, plan, status, billing_cycle, start_date, end_date, duration_days, company_id)
VALUES (t.u('OA'), 'ultimate', 'active', 'monthly', now() - interval '1 day', now() + interval '29 days', 30, t.u('CA'));
DO $$
BEGIN
  PERFORM t.ok((t.call(t.u('OA'), 'public.company_has_feature(''shopify_integration'')'))::text = 'true', '② حامل الفائقة يرى تكامل Shopify');
  PERFORM t.ok((t.call(t.u('OA'), 'public.company_has_feature(''store_support'')'))::text = 'true', '② حامل الفائقة يرى دعم المتجر');
  PERFORM t.ok((t.call(t.u('OA'), 'public.company_has_feature(''integrations_hub'')'))::text = 'true', '② حامل الفائقة يرى مركز التكاملات');
  PERFORM t.ok((t.call(t.u('OW'), 'public.company_has_feature(''shopify_integration'')'))::text = 'false', '② حامل الدعم وحده لا يرى تكامل Shopify');
  RAISE NOTICE 'PASS ② فحص المزايا عبر الاشتراك';
END $$;

-- ══ ③ اشتراك متجر قائم: المزايا والإدارة وتحويل الدورة ═══════════════
-- اشتراك متجر قديم بأسعار المنح مخزّنة في اللقطة (كما تركها 133)
INSERT INTO public.whatsapp_subscriptions (user_id, plan, status, billing_cycle, start_date, end_date, duration_days, company_id, price_snapshot)
VALUES (t.s('S8'), 'store', 'active', 'monthly', now() - interval '1 day', now() + interval '29 days', 30, t.sv('co_S8')::uuid,
        '{"amount":0,"exception":true,"cycle_price":500,"plan_price_monthly":500,"plan_price_yearly":5000}'::jsonb);
DO $$
DECLARE v_sub uuid; v_manual timestamptz := now() + interval '20 days';
BEGIN
  SELECT id INTO v_sub FROM public.whatsapp_subscriptions
   WHERE company_id = t.sv('co_S8')::uuid AND plan = 'store' ORDER BY created_at DESC LIMIT 1;
  INSERT INTO t.saved VALUES ('sub_S8_store', v_sub::text);
  PERFORM t.ok((t.call(t.s('S8'), 'public.company_has_feature(''shopify_integration'')'))::text = 'true', '③ اشتراك المتجر القائم يحتفظ بتكامل Shopify');
  PERFORM t.ctx('owner');
  PERFORM t.stepup(t.u('OW'));
  PERFORM t.ok(t.err(t.u('OW'), format('public.owner_store_pause(%L, ''إيقاف للاختبار'')', v_sub)) = 'ok', '③ إيقاف اشتراك المتجر القائم');
  PERFORM t.ok((select status from public.whatsapp_subscriptions where id = v_sub) = 'paused', '③ الاشتراك متوقف');
  PERFORM t.ok(t.err(t.u('OW'), format('public.owner_store_set_end_date(%L, %L, ''تعديل انتهاء أثناء الإيقاف'')', v_sub, v_manual)) = 'ok', '③ تعديل الانتهاء أثناء الإيقاف');
  PERFORM t.ok(t.err(t.u('OW'), format('public.owner_store_resume(%L, ''استئناف للاختبار'')', v_sub)) = 'ok', '③ استئناف اشتراك المتجر القائم');
  PERFORM t.ok((select status from public.whatsapp_subscriptions where id = v_sub) = 'active', '③ الاشتراك فعّال بعد الاستئناف');
  PERFORM t.ok((select end_date from public.whatsapp_subscriptions where id = v_sub) = v_manual, '③ التاريخ اليدوي نهائي — بلا تمديد بمدة التوقف');
  -- تحويل الدورة: سعرا الباقة NULL، فيسقط إلى سعري اللقطة 500/5000
  PERFORM t.ok(t.err(t.u('OW'), format('public.owner_store_change_cycle(%L, ''yearly'', ''تحويل الدورة للاختبار'')', v_sub)) = 'ok', '③ تحويل الدورة بسعري اللقطة');
  PERFORM t.ok((select billing_cycle from public.whatsapp_subscriptions where id = v_sub) = 'yearly', '③ الدورة صارت سنوية');
  PERFORM t.ok((select (price_snapshot->>'cycle_price')::numeric from public.whatsapp_subscriptions where id = v_sub) = 5000, '③ سعر الدورة السنوية 5000 من اللقطة');
  PERFORM t.ok((select end_date from public.whatsapp_subscriptions where id = v_sub) > now() + interval '360 days', '③ الانتهاء الجديد بعد 365 يومًا');
  PERFORM t.ctx(null);
  RAISE NOTICE 'PASS ③ اشتراك المتجر القائم يُدار وتحويل دورته من اللقطة';
END $$;
-- اشتراك متجر ثانٍ بلا أسعار في اللقطة ولا في صف الباقة: التحويل مرفوض
INSERT INTO public.whatsapp_subscriptions (user_id, plan, status, billing_cycle, start_date, end_date, duration_days, company_id, price_snapshot)
VALUES (t.s('S8'), 'store', 'active', 'monthly', now() - interval '1 day', now() + interval '29 days', 30, t.sv('co_S8')::uuid, '{}'::jsonb);
DO $$
DECLARE v_sub2 uuid;
BEGIN
  SELECT id INTO v_sub2 FROM public.whatsapp_subscriptions
   WHERE company_id = t.sv('co_S8')::uuid AND plan = 'store' AND (price_snapshot = '{}'::jsonb)
   ORDER BY created_at DESC LIMIT 1;
  PERFORM t.ctx('owner');
  PERFORM t.stepup(t.u('OW'));
  PERFORM t.ok(t.err(t.u('OW'), format('public.owner_store_change_cycle(%L, ''yearly'', ''تحويل الدورة للاختبار'')', v_sub2)) = '22023', '③ بلا سعرين في الموضعين: التحويل مرفوض 22023');
  PERFORM t.ctx(null);
  RAISE NOTICE 'PASS ③ تحويل الدورة بلا أسعار مرفوض';
END $$;

-- ══ ④ الدوال المتقاعدة ═══════════════════════════════════════════════
DO $$
DECLARE v_co uuid := t.sv('co_S8')::uuid;
BEGIN
  PERFORM t.ok(t.err(t.u('AD'), 'public.owner_set_store_plan_price(500, 5000, false)') = '42501', '④ السعر: ليس للمالك');
  PERFORM t.ctx('owner');
  PERFORM t.stepup(t.u('OW'));
  PERFORM t.ok(t.err(t.u('OW'), 'public.owner_set_store_plan_price(500, 5000, false)') = '22023', '④ السعر: المالك يلقى رسالة الدمج 22023');
  PERFORM t.ok(t.err(t.u('OW'), format('public.owner_store_grant_exception(%L, ''monthly'', %L, ''منح للاختبار'')', v_co, now() + interval '30 days')) = '22023', '④ المنح: رسالة الدمج 22023');
  PERFORM t.ok(t.err(t.u('OW'), 'public.owner_set_store_plan_quota_features(100, ''{integrations_hub}'', ''حصة للاختبار'')') = '22023', '④ الحصة: رسالة الدمج 22023');
  PERFORM t.ok(t.err(t.u('AD'), format('public.owner_store_grant_exception(%L, ''monthly'', %L, ''منح للاختبار'')', v_co, now() + interval '30 days')) = '42501', '④ المنح: ليس للمالك');
  PERFORM t.ctx(null);
  RAISE NOTICE 'PASS ④ الدوال المتقاعدة ترفض بالبوابة ثم برسالة الدمج';
END $$;

-- ══ ⑤ التجربة المجانية ═══════════════════════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM t.ok(t.err(t.u('OA'), 'public.request_saas_trial(''store'')') = '22023', '⑤ طلب تجربة store من شركة عادية مرفوض 22023');
  PERFORM t.ok(t.err(t.s('S8'), 'public.request_saas_trial(''store'')') = '22023', '⑤ طلب تجربة store من متجر مرفوض 22023');
  r := t.call(t.u('OB'), 'public.request_saas_trial(''ultimate'')');
  PERFORM t.ok((r->>'status') = 'pending' and (r->>'plan_key') = 'ultimate', '⑤ طلب تجربة ultimate يعمل');
  INSERT INTO t.saved VALUES ('req_OB_ult', r->>'id');
  r := t.call(t.u('OB'), 'public.my_saas_trial_status()');
  PERFORM t.ok(not exists (select 1 from jsonb_array_elements(r->'eligible_plans') e where e->>'plan_key' = 'store'), '⑤ حالة الشركة: بلا store في الباقات المؤهلة');
  PERFORM t.ok(exists (select 1 from jsonb_array_elements(r->'eligible_plans') e where e->>'plan_key' = 'ultimate'), '⑤ حالة الشركة: ultimate ما زالت في الباقات المؤهلة');
  RAISE NOTICE 'PASS ⑤ التجربة: store خارجها وultimate تعمل';
END $$;
-- إدخال store المباشر مرفوض بقيد الخطة (23514)
DO $$
BEGIN
  INSERT INTO public.saas_trial_requests (company_id, plan_key, requested_by)
  VALUES (t.u('CB'), 'store', t.u('OB'));
  PERFORM t.ok(false, '⑤ إدخال store المباشر كان يجب أن يفشل بالقيد');
EXCEPTION WHEN check_violation THEN
  PERFORM t.ok(true, '⑤ إدخال store المباشر مرفوض بقيد الخطة');
END $$;

-- ══ ⑥ طلب حساب متجر ═════════════════════════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM t.ok(t.err(t.s('S9'), 'public.submit_store_account_request(''متجر S9'', ''CR-S9-162'', ''2030-01-01'', null, null, ''store'')') = '22023', '⑥ طلب حساب متجر بباقة store مرفوض 22023');
  r := t.call(t.s('S9'), 'public.submit_store_account_request(''متجر S9'', ''CR-S9-162'', ''2030-01-01'', null, null, ''ultimate'')');
  PERFORM t.ok((r->>'status') = 'pending' and (r->>'account_kind') = 'ecommerce_store', '⑥ طلب حساب متجر بالفائقة معلّق كمتجر إلكتروني');
  PERFORM t.ok((select requested_plan from public.company_account_requests where id = (r->>'id')::uuid) = 'ultimate', '⑥ الطلب مسجَّل بالباقة الفائقة');
  PERFORM t.ok((select count(*) from public.whatsapp_subscriptions where user_id = t.s('S9')) = 0, '⑥ الطلب لم ينشئ أي اشتراك');
  RAISE NOTICE 'PASS ⑥ طلب حساب المتجر: store مرفوض وultimate يعمل';
END $$;

-- ══ ⑦ التراجع ثم إعادة التطبيق ═══════════════════════════════════════
\i migrations/_rollback/162_store_into_super.down.sql
SET search_path = public, extensions;
DO $$
DECLARE r jsonb; v_def text;
BEGIN
  PERFORM t.ok((select count(*) from public.plan_features pf JOIN public.subscription_plans sp ON sp.id = pf.plan_id
                 where sp.key = 'ultimate' and pf.enabled
                   and pf.feature_key in ('integrations_hub', 'shopify_integration', 'store_support')) = 0, '⑦ التراجع: الفائقة فقدت مزايا المتجر الثلاثة');
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint WHERE conname = 'saas_trial_requests_plan_check';
  PERFORM t.ok(v_def like '%store%', '⑦ التراجع: قيد خطة التجربة عاد إلى 3 خطط');
  PERFORM t.ctx('owner');
  PERFORM t.stepup(t.u('OW'));
  r := t.call(t.u('OW'), 'public.owner_set_store_plan_price(500, 5000, false)');
  PERFORM t.ok((r->>'price_monthly')::numeric = 500 and (r->>'price_yearly')::numeric = 5000, '⑦ التراجع: دالة السعر تعمل مجددًا 500/5000');
  PERFORM t.ctx(null);
  RAISE NOTICE 'PASS ⑦ التراجع يعيد الحال السابقة';
END $$;
\i migrations/162_store_into_super.sql
SET search_path = public, extensions;
DO $$
BEGIN
  PERFORM t.ok((select count(*) from public.plan_features pf JOIN public.subscription_plans sp ON sp.id = pf.plan_id
                 where sp.key = 'ultimate' and pf.enabled
                   and pf.feature_key in ('integrations_hub', 'shopify_integration', 'store_support')) = 3, '⑦ إعادة التطبيق: الفائقة تستعيد مزايا المتجر الثلاثة');
  PERFORM t.ok((select price_monthly from public.subscription_plans where key = 'store') is null, '⑦ إعادة التطبيق: باقة المتجر بلا سعرين مجددًا');
  RAISE NOTICE 'PASS ⑦ إعادة تطبيق 162 تنجح';
END $$;
