-- ============================================================================
-- 151_owner_store_test_management_status على نسخة مطابقة للإنتاج + 118 + 119
-- + 120 + 133
--
--   ⓪ 151 مرتين: قابل لإعادة التشغيل، والقائمة تضم الإدارة
--   ① الحالة: أربعة امتيازات، والإدارة غير ممنوحة افتراضيًا، ولغير المالك مرفوضة
--   ② المنح: الإدارة نشطة 7 أيام مع الثلاثة، والأيام المتبقية معروضة
--   ③ السحب: الإدارة وحدها تسقط والثلاثة تبقى نشطة
--   ④ التراجع يعيد نسخة 133 (ثلاثة) بلا مساس بالمنح، وإعادة التطبيق تنجح
-- ============================================================================
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
SET client_min_messages = warning;

\i tests/fixtures/ecommerce/chain.sql

\i migrations/118_ecommerce_store_accounts.sql
\i migrations/119_shopify_store_integration.sql
\i migrations/120_shopify_store_management.sql
\i migrations/133_owner_store_price_and_sync_actions.sql
\i migrations/151_owner_store_test_management_status.sql
\i migrations/151_owner_store_test_management_status.sql
SET search_path = public, extensions;

-- ══ ⓪ إعادة التطبيق والقائمة ════════════════════════════════════════════
DO $$
DECLARE v_def text;
BEGIN
  PERFORM t.ok(to_regprocedure('public.owner_store_test_status()') is not null, '⓪ الحالة');
  v_def := pg_get_functiondef('public.owner_store_test_status()'::regprocedure);
  PERFORM t.ok(v_def like '%shopify_management%', '⓪ القائمة تضم الإدارة');
  PERFORM t.ok(v_def like '%integrations_hub%' and v_def like '%shopify_integration%' and v_def like '%store_support%', '⓪ الثلاثة باقية');
  RAISE NOTICE 'PASS ⓪ 151 مرتين، والقائمة تضم الإدارة';
END $$;

-- ══ ① الحالة: أربعة، والإدارة غير ممنوحة ═══════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM t.ok(t.err(t.u('AD'), 'public.owner_store_test_status()') = '42501', '① ليس للمالك');
  PERFORM t.ctx('owner');
  PERFORM t.stepup(t.u('OW'));
  r := t.call(t.u('OW'), 'public.owner_store_test_status()');
  PERFORM t.ok((r->>'company_id') = t.u('CW')::text and (r->>'account_kind') = 'company', '① شركة المالك شركة عادية');
  PERFORM t.ok(jsonb_array_length(r->'entitlements') = 4, '① أربعة امتيازات');
  PERFORM t.ok((select (e->>'feature_key') from jsonb_array_elements(r->'entitlements') e
                 where (e->>'feature_key') = 'shopify_management') = 'shopify_management', '① الإدارة في القائمة');
  PERFORM t.ok((select not (e->>'granted')::boolean from jsonb_array_elements(r->'entitlements') e
                 where (e->>'feature_key') = 'shopify_management'), '① الإدارة غير ممنوحة افتراضيًا');
  PERFORM t.ctx(null);
  RAISE NOTICE 'PASS ① الحالة: أربعة امتيازات، والإدارة غير ممنوحة';
END $$;

-- ══ ② المنح: الإدارة نشطة مع الثلاثة ═══════════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM t.ctx('owner');
  PERFORM t.stepup(t.u('OW'));
  PERFORM t.call(t.u('OW'), format('public.owner_set_company_account_kind(%L, ''ecommerce_store'', ''متجر المالك التجريبي'')', t.u('CW')));
  PERFORM t.call(t.u('OW'), 'public.owner_store_test_entitlements(true, 7, ''اختبار تجربة المتجر'')');
  PERFORM t.call(t.u('OW'), 'public.owner_store_test_management(true, 7, ''اختبار إدارة المتجر'')');
  r := t.call(t.u('OW'), 'public.owner_store_test_status()');
  PERFORM t.ok((r->>'is_test_store')::boolean, '② صارت متجر اختبار');
  PERFORM t.ok((select count(*) from jsonb_array_elements(r->'entitlements') e
                 where (e->>'granted')::boolean and (e->>'active')::boolean) = 4, '② أربعة نشطة');
  PERFORM t.ok((select (e->>'days_remaining')::int from jsonb_array_elements(r->'entitlements') e
                 where (e->>'feature_key') = 'shopify_management') between 6 and 7, '② أيام الإدارة المتبقية');
  PERFORM t.ok((select (e->>'expires_at') is not null from jsonb_array_elements(r->'entitlements') e
                 where (e->>'feature_key') = 'shopify_management'), '② تاريخ انتهاء الإدارة معروض');
  PERFORM t.ctx(null);
  RAISE NOTICE 'PASS ② المنح: الإدارة نشطة 7 أيام مع الثلاثة';
END $$;

-- ══ ③ السحب: الإدارة وحدها تسقط ════════════════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM t.ctx('owner');
  PERFORM t.stepup(t.u('OW'));
  PERFORM t.call(t.u('OW'), 'public.owner_store_test_management(false)');
  r := t.call(t.u('OW'), 'public.owner_store_test_status()');
  PERFORM t.ok((select not (e->>'granted')::boolean from jsonb_array_elements(r->'entitlements') e
                 where (e->>'feature_key') = 'shopify_management'), '③ الإدارة سُحبت');
  PERFORM t.ok((select count(*) from jsonb_array_elements(r->'entitlements') e
                 where (e->>'granted')::boolean and (e->>'active')::boolean) = 3, '③ الثلاثة تبقى نشطة');
  PERFORM t.ctx(null);
  RAISE NOTICE 'PASS ③ السحب: الإدارة وحدها تسقط';
END $$;

-- ══ ④ التراجع يعيد نسخة 133، وإعادة التطبيق تنجح ════════════════════════
\i migrations/_rollback/151_owner_store_test_management_status.down.sql
DO $$
DECLARE r jsonb; v_def text;
BEGIN
  PERFORM t.ctx('owner');
  PERFORM t.stepup(t.u('OW'));
  r := t.call(t.u('OW'), 'public.owner_store_test_status()');
  PERFORM t.ok(jsonb_array_length(r->'entitlements') = 3, '④ التراجع: ثلاثة');
  PERFORM t.ok(not exists (select 1 from jsonb_array_elements(r->'entitlements') e
                 where (e->>'feature_key') = 'shopify_management'), '④ الإدارة غابت من القائمة');
  PERFORM t.ok(exists (select 1 from public.company_feature_overrides
                 where company_id = t.u('CW') and feature_key = 'shopify_management') = false, '④ لا منح قائم بعد سحب ③');
  PERFORM t.ctx(null);
  v_def := pg_get_functiondef('public.owner_store_test_status()'::regprocedure);
  PERFORM t.ok(v_def not like '%shopify_management%', '④ التعريف بلا الإدارة');
END $$;
\i migrations/151_owner_store_test_management_status.sql
SET search_path = public, extensions;
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM t.ctx('owner');
  PERFORM t.stepup(t.u('OW'));
  r := t.call(t.u('OW'), 'public.owner_store_test_status()');
  PERFORM t.ok(jsonb_array_length(r->'entitlements') = 4, '④ إعادة التطبيق: أربعة');
  PERFORM t.ctx(null);
  RAISE NOTICE 'PASS ④ التراجع يعيد نسخة 133، وإعادة التطبيق تنجح';
  RAISE NOTICE 'ALL 151 OWNER STORE TEST MANAGEMENT STATUS TESTS PASSED';
END $$;
