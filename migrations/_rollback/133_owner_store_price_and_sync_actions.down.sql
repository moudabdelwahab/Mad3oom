-- ============================================================================
-- التراجع عن 133_owner_store_price_and_sync_actions
--   يحذف دوال 133 كلها فقط.
--   ما لا يسترجعه التراجع (موثّق عمدًا):
--   • الأسعار المحدَّدة عبر owner_set_store_plan_price (بيانات تبقى كما هي).
--   • عمود paused_at وقيد الحالة الموسّع بـ 'paused' — اشتراك متوقف باقٍ
--     متوقفًا بلا دالة استئناف حتى إعادة التطبيق؛ حذف القيد كان سيكسر صفه.
--   • owner_accounts_overview تبقى بنسخة 133 (معاملات جديدة بلا أثر على
--     النداءات القديمة) — استعادتها تستلزم إعادة تطبيق 119 كاملًا.
-- ============================================================================
drop function if exists public.owner_set_store_plan_price(numeric, numeric, boolean);
drop function if exists public.owner_ihub_sync_request(uuid);
drop function if exists public.owner_ihub_events_retry(uuid);
drop function if exists public.owner_store_test_status();
drop function if exists public._store_reason(text);
drop function if exists public._store_audit(uuid, text, jsonb, jsonb, text);
drop function if exists public._store_subscription_json(uuid);
drop function if exists public.owner_store_grant_exception(uuid, text, timestamptz, text);
drop function if exists public.owner_store_subscription(uuid);
drop function if exists public.owner_store_set_end_date(uuid, timestamptz, text);
drop function if exists public.owner_store_pause(uuid, text);
drop function if exists public.owner_store_resume(uuid, text);
drop function if exists public.owner_store_change_cycle(uuid, text, text);
drop function if exists public.owner_store_alerts();
drop function if exists public.owner_store_requests();
drop function if exists public.owner_store_request_decide(uuid, text, text);
drop function if exists public.owner_store_plan_config();
drop function if exists public.owner_set_store_plan_quota_features(integer, text[], text);
drop function if exists public.owner_store_operations_log(integer);
drop function if exists public.owner_set_shopify_provider_enabled(boolean, text);
