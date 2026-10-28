-- ============================================================================
-- 118_ecommerce_store_accounts على نسخة مطابقة للإنتاج (2026-10-28)
--
--   ⓪ قبل 118: بصمات الإنتاج للدوال التي يعيد 118 تعريفها أو يعتمد عليها
--   ① 118 مرتين: الكائنات، الصلاحيات، والباقات القائمة لم تتغير
--   ② الفرد والشركة كما هما: شراء باقة support، طلب حساب شركة وموافقته
--   ③ طلب حساب متجر → موافقة الإدارة القائمة → منظمة ecommerce_store
--   ④ نوع الحساب لا يكتبه مالك الشركة (تحديث أو إدراج مباشر)
--   ⑤ باقة store: غير مفعّلة وبلا سعر؛ لا تفعيل بلا سعر؛ لمالك متجر فقط
--   ⑥ الامتيازات من الخادم: فعّال / منتهٍ / معلّق / مرفوض
--   ⑦ my_account_type لكل علاقة
--   ⑧ owner_set_company_account_kind: المالك بسياقه وتحقق حديث فقط، ومدقَّق
--   ⑨ التراجع يرفض مع بيانات، ويعيد نص الإنتاج حرفيًا، ثم إعادة التطبيق
-- ============================================================================
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
SET client_min_messages = warning;

\i tests/fixtures/ecommerce/chain.sql

CREATE FUNCTION t.fn_md5(p regprocedure) RETURNS text LANGUAGE sql AS $$ select md5(pg_get_functiondef(p)) $$;
CREATE FUNCTION t.s(p text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  select (case p when 'ST' then '5a000000-0000-4000-8000-000000000001' when 'SX' then '5b000000-0000-4000-8000-000000000001'
                 when 'NC' then '5c000000-0000-4000-8000-000000000001' end)::uuid $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;

INSERT INTO auth.users (id, email, email_confirmed_at)
SELECT t.s(n), lower(n) || '@store.test', now() - interval '30 days' FROM unnest(array['ST','SX','NC']) n;
INSERT INTO public.profiles (id, email, full_name, role, phone, created_at) VALUES
  (t.s('ST'), 'st@store.test', 'تاجر', 'user', '01200000001', '2026-09-01'),
  (t.s('SX'), 'sx@store.test', 'تاجر آخر', 'user', '01200000002', '2026-09-01'),
  (t.s('NC'), 'nc@store.test', 'شركة جديدة', 'user', '01200000003', '2026-09-01');

-- ══ ⓪ بصمات الإنتاج ═══════════════════════════════════════════════════════
DO $$
BEGIN
  PERFORM t.ok(t.fn_md5('public.my_company_account_request()') = '91666c394648d9e09fb823f7f0dd3d76', '⓪ my_company_account_request = الإنتاج');
  PERFORM t.ok(t.fn_md5('public.admin_list_company_account_requests()') = '4ae5f2572f0b05f3a16ce79ba781c2bb', '⓪ admin_list_company_account_requests = الإنتاج');
  PERFORM t.ok(t.fn_md5('public.admin_review_company_account_request(uuid,text,text)') = '5db2500f8b766bcdfacb329e75821894', '⓪ admin_review = الإنتاج');
  PERFORM t.ok(t.fn_md5('public.submit_company_account_request(text,text,date,text,text,text,text)') = '7d4e444c1b07a17d3467ea9328ce68ec', '⓪ submit_company_account_request = الإنتاج');
  PERFORM t.ok(t.fn_md5('public.request_subscription_purchase(text,text,uuid,boolean,text,text)') = 'c2c21c1fc0fa92e63138f66b6c91d1aa', '⓪ request_subscription_purchase = الإنتاج');
  PERFORM t.ok(t.fn_md5('public.subscription_purchase_check(text,boolean,uuid)') = '0486f3cfcd61f08a92a5bf527bf2d492', '⓪ subscription_purchase_check = الإنتاج');
  PERFORM t.ok(t.fn_md5('public.company_has_feature(text)') = '7f68068e687858c0a3294823fb0a7e5e', '⓪ company_has_feature = الإنتاج');
  INSERT INTO t.saved VALUES ('chf', t.fn_md5('public.company_has_feature(text)')),
                             ('rsp', t.fn_md5('public.request_subscription_purchase(text,text,uuid,boolean,text,text)')),
                             ('plans', (select md5(string_agg(key||price_monthly||price_yearly||is_active, ',' order by key)) from public.subscription_plans)),
                             ('pf', (select md5(string_agg(plan_id::text||feature_key||enabled, ',' order by plan_id, feature_key)) from public.plan_features));
  RAISE NOTICE 'PASS ⓪ النسخة مطابقة للإنتاج في الدوال التي يمسّها 118';
END $$;

-- ══ ① 118 مرتين ══════════════════════════════════════════════════════════
\i migrations/118_ecommerce_store_accounts.sql
\i migrations/118_ecommerce_store_accounts.sql
SET search_path = public, extensions;

DO $$
BEGIN
  PERFORM t.ok((select account_kind from public.companies where id = t.u('CA')) = 'company', '① الشركات القائمة company');
  PERFORM t.ok(not exists (select 1 from public.companies where account_kind <> 'company'), '① لا تحويل لأي منظمة');
  PERFORM t.ok((select md5(string_agg(key||price_monthly||price_yearly||is_active, ',' order by key))
                  from public.subscription_plans where key <> 'store') = (select v from t.saved where k = 'plans'), '① الباقات القائمة لم تتغير');
  PERFORM t.ok((select md5(string_agg(pf.plan_id::text||pf.feature_key||pf.enabled, ',' order by pf.plan_id, pf.feature_key))
                  from public.plan_features pf join public.subscription_plans sp on sp.id = pf.plan_id where sp.key <> 'store')
               = (select v from t.saved where k = 'pf'), '① مزايا الباقات القائمة لم تتغير');
  PERFORM t.ok(t.fn_md5('public.company_has_feature(text)') = (select v from t.saved where k = 'chf'), '① company_has_feature لم تُلمس');
  PERFORM t.ok(t.fn_md5('public.request_subscription_purchase(text,text,uuid,boolean,text,text)') = (select v from t.saved where k = 'rsp'), '① الشراء لم يُلمس');
  PERFORM t.ok((select not is_active and price_monthly is null and price_yearly is null and audience = 'ecommerce_store'
                  from public.subscription_plans where key = 'store'), '① باقة store غير مفعّلة وبلا سعر');
  PERFORM t.ok(not has_function_privilege('authenticated', 'public.enforce_plan_audience()', 'EXECUTE'), '① المحفّز غير قابل للنداء');
  PERFORM t.ok(not has_function_privilege('anon', 'public.submit_store_account_request(text,text,date,text,text,text,text,text)', 'EXECUTE'), '① anon بلا طلب متجر');
  RAISE NOTICE 'PASS ① 118 قابل لإعادة التشغيل ولا يغيّر الباقات أو الشركات القائمة';
END $$;

-- ══ ② الفرد والشركة كما هما ═══════════════════════════════════════════════
DO $$
DECLARE r jsonb; v_req uuid;
BEGIN
  r := t.call(t.u('PU'), 'public.request_subscription_purchase(''support'', ''monthly'')');
  PERFORM t.ok(r->>'status' = 'pending', '② الفرد يطلب support كما كان: ' || r::text);
  PERFORM t.ok(t.err(t.u('PU'), 'public.request_subscription_purchase(''support'', ''monthly'')') = '42501', '② طلب مكرر مرفوض كما كان');

  r := t.call(t.s('NC'), 'public.submit_company_account_request(''شركة جديدة'', ''CR-NC-118'', ''2030-01-01'', null, null, null, null)');
  v_req := (r->>'id')::uuid;
  PERFORM t.ok((select account_kind = 'company' and store_platform is null from public.company_account_requests where id = v_req), '② طلب الشركة company');
  r := t.call(t.u('AD'), format('public.admin_review_company_account_request(%L, ''approve'')', v_req));
  PERFORM t.ok((select account_kind from public.companies where id = (r->>'company_id')::uuid) = 'company', '② موافقة الشركة تنشئ company');
  PERFORM t.ok((t.call(t.s('NC'), 'public.my_account_type()')->>'account_type') = 'company', '② حساب الشركة company');
  PERFORM t.ok((t.call(t.s('NC'), 'public.my_company_account_request()')->>'account_kind') = 'company', '② الطلب يحمل النوع');
  RAISE NOTICE 'PASS ② مسار الفرد والشركة لم يتغير';
END $$;

-- ══ ③ طلب حساب متجر ══════════════════════════════════════════════════════
DO $$
DECLARE r jsonb; v_req uuid; v_company uuid;
BEGIN
  PERFORM t.ok(t.err(t.s('ST'), 'public.submit_store_account_request(''متجري'', ''CR-ST-118'', ''2030-01-01'', null, null, null, null, ''bad domain!'')') = '22023', '③ نطاق غير صالح مرفوض');
  PERFORM t.ok(t.err(t.s('ST'), 'public.submit_store_account_request(''متجري'', ''CR-ST-118'', ''2030-01-01'', null, null, ''support'', ''monthly'', null)') = '22023', '③ باقة غير متاجر مرفوضة');
  PERFORM t.ok(not exists (select 1 from public.company_account_requests where user_id = t.s('ST')), '③ الرفض لا يترك طلبًا');

  r := t.call(t.s('ST'), 'public.submit_store_account_request(''متجري'', ''CR-ST-118'', ''2030-01-01'', ''shop@store.test'', null, null, null, ''My-Store'')');
  v_req := (r->>'id')::uuid;
  PERFORM t.ok(r->>'account_kind' = 'ecommerce_store', '③ الرد يذكر النوع');
  PERFORM t.ok((select account_kind = 'ecommerce_store' and store_platform = 'shopify' and store_domain_hint = 'my-store.myshopify.com'
                  from public.company_account_requests where id = v_req), '③ الطلب موسوم متجرًا والنطاق مطبَّع');
  PERFORM t.ok(t.err(t.s('ST'), 'public.submit_store_account_request(''متجري2'', ''CR-ST2-118'', ''2030-01-01'')') <> 'ok', '③ طلب ثانٍ معلّق مرفوض (قاعدة 068)');
  PERFORM t.ok(t.err(t.s('ST'), format('public.admin_review_company_account_request(%L, ''approve'')', v_req)) = '42501', '③ صاحب الطلب لا يعتمده');
  PERFORM t.ok((select (x->>'account_kind') = 'ecommerce_store' and (x->>'store_domain_hint') = 'my-store.myshopify.com'
                  from jsonb_array_elements(t.call(t.u('AD'), 'public.admin_list_company_account_requests()')) x
                 where (x->>'id')::uuid = v_req), '③ الإدارة ترى النوع والنطاق');

  r := t.call(t.u('AD'), format('public.admin_review_company_account_request(%L, ''approve'')', v_req));
  v_company := (r->>'company_id')::uuid;
  PERFORM t.ok((select account_kind from public.companies where id = v_company) = 'ecommerce_store', '③ الموافقة تنشئ منظمة متجر');
  PERFORM t.ok((select user_type from public.profiles where id = t.s('ST')) = 'company', '③ user_type كما تكتبه الموافقة القائمة');
  INSERT INTO t.saved VALUES ('store_company', v_company::text);
  RAISE NOTICE 'PASS ③ طلب المتجر يمر بمسار الشركة نفسه وينتج منظمة ecommerce_store';
END $$;

-- ══ ④ نوع الحساب لا يكتبه مالك الشركة ═════════════════════════════════════
DO $$
BEGIN
  PERFORM t.ok(t.exec(t.u('OA'), format('update public.companies set account_kind = %L where id = %L', 'ecommerce_store', t.u('CA'))) = '42501', '④ مالك الشركة لا يحوّلها متجرًا');
  PERFORM t.ok(t.exec(t.s('ST'), format('update public.companies set account_kind = %L where user_id = %L', 'company', t.s('ST'))) = '42501', '④ التاجر لا يحوّل متجره شركة');
  PERFORM t.ok(t.exec(t.s('ST'), format('update public.companies set company_name = %L where user_id = %L', 'متجري الجديد', t.s('ST'))) = 'ok', '④ تعديل البيانات العادية كما هو');
  PERFORM t.ok(t.exec(t.s('SX'), format('insert into public.companies (user_id, company_name, commercial_registration_number, account_kind) values (%L, %L, %L, %L)',
                                         t.s('SX'), 'تجاوز', 'CR-SX-X', 'ecommerce_store')) <> 'ok', '④ إدراج منظمة متجر مباشرة مرفوض');
  PERFORM t.ok(t.affected(t.u('AD'), format('update public.companies set account_kind = %L where id = %L', 'ecommerce_store', t.u('CA'))) <= 0, '④ ولا الأدمن من هنا (رفض أو لا صف)');
  PERFORM t.ok((select account_kind from public.companies where id = t.u('CA')) = 'company', '④ لم يتغير شيء');
  RAISE NOTICE 'PASS ④ نوع الحساب محروس على مستوى الجدول';
END $$;

-- ══ ⑤ باقة المتاجر ═══════════════════════════════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM t.ok(t.err(t.s('ST'), 'public.request_subscription_purchase(''store'', ''monthly'')') = '22023', '⑤ باقة غير مفعّلة لا تُطلب');
  PERFORM t.ok(t.exec(t.u('AD'), 'update public.subscription_plans set is_active = true where key = ''store''') = '23514', '⑤ لا تفعيل بلا سعر (حتى للأدمن)');
  PERFORM t.ok(t.exec(t.u('AD'), 'update public.subscription_plans set price_monthly = 0, price_yearly = 0, is_active = true where key = ''store''') = '23514', '⑤ السعر صفر لا يكفي');
  -- المالك/الأدمن يحدد السعر ثم يفعّل (قيمة اختبار، ليست سعرًا تجاريًا)
  PERFORM t.ok(t.exec(t.u('AD'), 'update public.subscription_plans set price_monthly = 1, price_yearly = 10, is_active = true where key = ''store''') = 'ok', '⑤ تفعيل بسعر');

  PERFORM t.ok(t.errfull(t.u('PU'), 'public.request_subscription_purchase(''store'', ''monthly'')') LIKE '42501|%متاجر%', '⑤ الفرد لا يطلب باقة المتاجر');
  PERFORM t.ok(t.err(t.u('OA'), 'public.request_subscription_purchase(''store'', ''monthly'')') = '42501', '⑤ مالك شركة عادية لا يطلبها');
  PERFORM t.ok(t.err(t.u('A1'), 'public.request_subscription_purchase(''store'', ''monthly'')') = '42501', '⑤ عميل الشركة لا يطلبها');
  PERFORM t.ok(t.exec(t.u('PU'), format('insert into public.whatsapp_subscriptions (user_id, plan, status, billing_cycle, start_date, end_date, duration_days) values (%L, ''store'', ''pending'', ''monthly'', now(), now() + interval ''30 days'', 30)', t.u('PU'))) = '42501', '⑤ ولا بإدراج مباشر');

  r := t.call(t.s('ST'), 'public.request_subscription_purchase(''store'', ''monthly'')');
  PERFORM t.ok(r->>'status' = 'pending', '⑤ مالك المتجر يطلبها — قيد المراجعة: ' || r::text);
  PERFORM t.ok(t.exec(t.s('ST'), format('update public.whatsapp_subscriptions set status = ''active'' where id = %L', r->>'subscription_id')) <> 'ok'
               or (select status from public.whatsapp_subscriptions where id = (r->>'subscription_id')::uuid) = 'pending', '⑤ التاجر لا يفعّل اشتراكه');
  INSERT INTO t.saved VALUES ('store_sub', r->>'subscription_id');
  -- مالك المتجر يستطيع شراء باقة شركة أيضًا (المتجر منظمة)
  PERFORM t.ok(t.err(t.s('ST'), 'public.request_subscription_purchase(''whatsapp'', ''monthly'')') = 'ok', '⑤ باقات الشركات متاحة للمتجر');
  RAISE NOTICE 'PASS ⑤ باقة المتاجر لا تُباع بلا سعر، ولمالك متجر فقط حتى بنداء مباشر';
END $$;

-- ══ ⑥ الامتيازات من الخادم ═══════════════════════════════════════════════
DO $$
DECLARE v_sub uuid := (select v::uuid from t.saved where k = 'store_sub');
BEGIN
  PERFORM t.ok(not (t.call(t.s('ST'), 'public.company_has_feature(''shopify_integration'')') #>> '{}')::boolean, '⑥ المعلّق لا يمنح');
  UPDATE public.whatsapp_subscriptions SET status = 'active', company_id = (select v::uuid from t.saved where k = 'store_company') WHERE id = v_sub;
  PERFORM t.ok((t.call(t.s('ST'), 'public.company_has_feature(''shopify_integration'')') #>> '{}')::boolean, '⑥ الفعّال يمنح shopify_integration');
  PERFORM t.ok((t.call(t.s('ST'), 'public.company_has_feature(''store_support'')') #>> '{}')::boolean, '⑥ والفعّال يمنح store_support');
  PERFORM t.ok(not (t.call(t.u('OA'), 'public.company_has_feature(''shopify_integration'')') #>> '{}')::boolean, '⑥ باقة support لا تمنح Shopify');
  UPDATE public.whatsapp_subscriptions SET end_date = now() - interval '1 minute' WHERE id = v_sub;
  PERFORM t.ok(not (t.call(t.s('ST'), 'public.company_has_feature(''shopify_integration'')') #>> '{}')::boolean, '⑥ المنتهي بالتاريخ لا يمنح');
  UPDATE public.whatsapp_subscriptions SET end_date = now() + interval '20 days', status = 'expired' WHERE id = v_sub;
  PERFORM t.ok(not (t.call(t.s('ST'), 'public.company_has_feature(''shopify_integration'')') #>> '{}')::boolean, '⑥ expired لا يمنح');
  UPDATE public.whatsapp_subscriptions SET status = 'rejected' WHERE id = v_sub;
  PERFORM t.ok(not (t.call(t.s('ST'), 'public.company_has_feature(''shopify_integration'')') #>> '{}')::boolean, '⑥ rejected لا يمنح');
  UPDATE public.whatsapp_subscriptions SET status = 'active' WHERE id = v_sub;
  RAISE NOTICE 'PASS ⑥ الامتيازات تتبع حالة الاشتراك في القاعدة';
END $$;

-- ══ ⑦ my_account_type ════════════════════════════════════════════════════
DO $$
BEGIN
  PERFORM t.ok(t.call(t.u('PU'), 'public.my_account_type()')->>'account_type' = 'individual', '⑦ الفرد');
  PERFORM t.ok(t.call(t.u('OA'), 'public.my_account_type()')->>'account_type' = 'company', '⑦ مالك الشركة');
  PERFORM t.ok(t.call(t.u('AS'), 'public.my_account_type()')->>'relation' = 'staff', '⑦ مشرف الشركة');
  PERFORM t.ok((select x->>'account_type' = 'individual' and x->>'relation' = 'customer' and x->'organization_id' = 'null'::jsonb
                  from (select t.call(t.u('A1'), 'public.my_account_type()') x) s), '⑦ عميل الشركة فرد لا يرى معرّفها');
  PERFORM t.ok((select x->>'account_type' = 'ecommerce_store' and x->>'relation' = 'owner'
                  from (select t.call(t.s('ST'), 'public.my_account_type()') x) s), '⑦ مالك المتجر');
  PERFORM t.ok(coalesce(t.call(null, 'public.my_account_type()'), 'null'::jsonb) = 'null'::jsonb, '⑦ بلا جلسة null');
  RAISE NOTICE 'PASS ⑦ نوع الحساب لكل علاقة';
END $$;

-- ══ ⑧ owner_set_company_account_kind ════════════════════════════════════
DO $$
DECLARE n_audit int := (select count(*) from public.privileged_audit where action = 'company.account_kind');
BEGIN
  PERFORM t.ok(t.err(t.u('AD'), format('public.owner_set_company_account_kind(%L, ''ecommerce_store'', ''اختبار متجر المالك'')', t.u('CW'))) = '42501', '⑧ الأدمن مرفوض');
  PERFORM t.ok(t.err(t.u('EA'), format('public.owner_set_company_account_kind(%L, ''ecommerce_store'', ''اختبار متجر المالك'')', t.u('CW'))) = '42501', '⑧ الأدمن المرتفع مرفوض');
  PERFORM t.ctx('owner');
  PERFORM t.ok(t.err(t.u('OW'), format('public.owner_set_company_account_kind(%L, ''ecommerce_store'', ''اختبار متجر المالك'')', t.u('CW'))) = '42501', '⑧ المالك بلا تحقق حديث مرفوض');
  PERFORM t.stepup(t.u('OW'));
  PERFORM t.ok(t.err(t.u('OW'), format('public.owner_set_company_account_kind(%L, ''ecommerce_store'', ''قصير'')', t.u('CW'))) = '22023', '⑧ السبب مطلوب');
  PERFORM t.ok((t.call(t.u('OW'), format('public.owner_set_company_account_kind(%L, ''ecommerce_store'', ''اختبار متجر المالك التجريبي'')', t.u('CW')))->>'changed')::boolean, '⑧ المالك يحوّل متجره التجريبي');
  PERFORM t.ok((select account_kind from public.companies where id = t.u('CW')) = 'ecommerce_store', '⑧ تحوّل');
  PERFORM t.ok((select count(*) from public.privileged_audit where action = 'company.account_kind') = n_audit + 1, '⑧ مدقَّق في privileged_audit');
  PERFORM t.ctx('admin');
  PERFORM t.ok(t.err(t.u('OW'), format('public.owner_set_company_account_kind(%L, ''company'', ''إرجاع متجر المالك لشركة'')', t.u('CW'))) = '42501', '⑧ المالك في سياق الإدارة مرفوض');
  PERFORM t.ctx('owner');
  PERFORM t.ok((t.call(t.u('OW'), format('public.owner_set_company_account_kind(%L, ''company'', ''إرجاع متجر المالك لشركة'')', t.u('CW')))->>'changed')::boolean, '⑧ وإرجاعه');
  PERFORM t.ctx(null);
  RAISE NOTICE 'PASS ⑧ تغيير النوع للمالك في سياقه وبتحقق حديث، ومدقَّق';
END $$;

-- ══ ⑨ التراجع ════════════════════════════════════════════════════════════
-- داخل معاملة: الرفض يُبطل الملف كله (هكذا يُطبَّق على الإنتاج: begin; … commit;)
\set ON_ERROR_STOP off
BEGIN;
\i migrations/_rollback/118_ecommerce_store_accounts.down.sql
ROLLBACK;
\set ON_ERROR_STOP on
DO $$
BEGIN
  PERFORM t.ok(to_regprocedure('public.my_account_type()') is not null, '⑨ التراجع رُفض مع بيانات متاجر');
END $$;
-- تنظيف بيانات المتجر ثم التراجع
DELETE FROM public.whatsapp_subscriptions WHERE plan = 'store';
SELECT set_config('app.account_kind_write', 'on', false);
UPDATE public.companies SET account_kind = 'company' WHERE account_kind = 'ecommerce_store';
UPDATE public.company_account_requests SET account_kind = 'company', store_platform = null, store_domain_hint = null WHERE account_kind = 'ecommerce_store';
SELECT set_config('app.account_kind_write', 'off', false);
\i migrations/_rollback/118_ecommerce_store_accounts.down.sql
DO $$
BEGIN
  PERFORM t.ok(t.fn_md5('public.my_company_account_request()') = '91666c394648d9e09fb823f7f0dd3d76', '⑨ my_company_account_request عاد للإنتاج');
  PERFORM t.ok(t.fn_md5('public.admin_list_company_account_requests()') = '4ae5f2572f0b05f3a16ce79ba781c2bb', '⑨ admin_list عاد للإنتاج');
  PERFORM t.ok(to_regprocedure('public.my_account_type()') is null, '⑨ الدوال الجديدة حُذفت');
  PERFORM t.ok(not exists (select 1 from information_schema.columns where table_name = 'companies' and column_name = 'account_kind'), '⑨ العمود حُذف');
  PERFORM t.ok(not exists (select 1 from public.subscription_plans where key = 'store'), '⑨ الباقة حُذفت');
END $$;
\i migrations/118_ecommerce_store_accounts.sql
SET search_path = public, extensions;
DO $$
BEGIN
  PERFORM t.ok(to_regprocedure('public.my_account_type()') is not null and exists (select 1 from public.subscription_plans where key = 'store' and not is_active), '⑨ إعادة التطبيق');
  RAISE NOTICE 'PASS ⑨ التراجع يرفض مع بيانات، يعيد نص الإنتاج، وإعادة التطبيق تنجح';
  RAISE NOTICE 'ALL 118 ECOMMERCE STORE ACCOUNT TESTS PASSED';
END $$;
