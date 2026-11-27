-- ============================================================================
-- التراجع عن 151_owner_store_test_management_status
--   يعيد owner_store_test_status() إلى نسخة 133 (ثلاثة امتيازات، بلا
--   shopify_management). لا يمس المنح نفسه: امتياز إدارة ممنوح لمتجر
--   الاختبار يبقى في company_feature_overrides حتى انتهائه أو سحبه عبر
--   owner_store_test_management(false).
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
      from unnest(array['integrations_hub', 'shopify_integration', 'store_support']) f(feature_key)
      left join public.company_feature_overrides o
        on o.company_id = v_company and o.feature_key = f.feature_key));
end $$;
comment on function public.owner_store_test_status() is
  '133: حالة امتيازات متجر الاختبار لشركة المالك — قراءة وصفية، بلا رموز.';
