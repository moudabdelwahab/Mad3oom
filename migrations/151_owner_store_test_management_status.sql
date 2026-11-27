-- ============================================================================
-- 151_owner_store_test_management_status
--   • owner_store_test_status() (133) تضم 'shopify_management' في قائمة
--     امتيازات متجر الاختبار — أربعة بدل ثلاثة — فتظهر حالته (غير ممنوح /
--     نشط حتى / منتهٍ) في صفحة المالك «المتاجر وشوبيفاي» بلا نداء إضافي.
--   • لا يمس owner_store_test_management() (120) ولا المنح نفسه ولا أي دالة
--     أخرى ولا الجداول ولا الامتيازات ولا المزوّد. الصلاحيات كما في 133:
--     authenticated وحده.
--   • التراجع: migrations/_rollback/151_owner_store_test_management_status.down.sql
--     (يعيد نسخة 133 بثلاثة امتيازات).
-- ============================================================================

create or replace function public.owner_store_test_status()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  v_name    text;
  v_kind    text;
begin
  perform public._owner_require();
  select c.id, c.company_name, c.account_kind into v_company, v_name, v_kind
    from public.companies c where c.user_id = auth.uid() order by c.created_at asc limit 1;
  return jsonb_build_object(
    'company_id', v_company, 'company_name', v_name, 'account_kind', v_kind,
    'has_company', v_company is not null,
    'is_test_store', coalesce(v_kind = 'ecommerce_store', false),
    'entitlements', (select coalesce(jsonb_agg(jsonb_build_object(
        'feature_key', f.feature_key,
        'granted', o.company_id is not null,
        'active', o.company_id is not null and (o.expires_at is null or o.expires_at > now()),
        'granted_at', o.granted_at, 'expires_at', o.expires_at,
        'days_remaining', case when o.expires_at is null then null
                               when o.expires_at <= now() then 0
                               else ceil(extract(epoch from (o.expires_at - now())) / 86400)::int end)
        order by f.feature_key), '[]'::jsonb)
      from unnest(array['integrations_hub', 'shopify_integration', 'shopify_management', 'store_support']) f(feature_key)
      left join public.company_feature_overrides o
        on o.company_id = v_company and o.feature_key = f.feature_key));
end $$;
comment on function public.owner_store_test_status() is
  '151: حالة امتيازات متجر الاختبار لشركة المالك — أربعة، منها shopify_management (120) — قراءة وصفية، بلا رموز.';


-- ============================================================================
-- الصلاحيات — كما في 133: authenticated وحده، بلا anon
-- ============================================================================
do $$
begin
  execute format('revoke all on function %s from public, anon, authenticated', 'public.owner_store_test_status()');
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute format('revoke all on function %s from service_role', 'public.owner_store_test_status()');
  end if;
  execute format('grant execute on function %s to authenticated', 'public.owner_store_test_status()');
end $$;


-- ============================================================================
-- تحقق ذاتي — على نمط 133: القائمة تضم الإدارة، والثلاثة القديمة باقية
-- ============================================================================
do $$
declare
  v_def text;
begin
  v_def := pg_get_functiondef('public.owner_store_test_status()'::regprocedure);
  if v_def not like '%shopify_management%' then
    raise exception '151: shopify_management غائب من owner_store_test_status()';
  end if;
  if v_def not like '%integrations_hub%' or v_def not like '%shopify_integration%' or v_def not like '%store_support%' then
    raise exception '151: أحد امتيازات 133 الثلاثة غائب من owner_store_test_status()';
  end if;
end $$;
