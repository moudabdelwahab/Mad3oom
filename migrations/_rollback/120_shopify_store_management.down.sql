-- ============================================================================
-- التراجع عن 120_shopify_store_management
--   يرفض إن وُجد سجل عمليات (ihub_shopify_ops) — حذفه يمحو سجل تدقيق حقيقيًا. لتجاوز ذلك بعد
--   تصدير السجل:  set local mad3oom.rollback_discard_shopify_ops = 'on';  في المعاملة نفسها.
--   يعيد قيد الاستثناءات وبيانات المزوّد الوصفية إلى ما كانت عليه بعد 119. لا يمس دوال 119.
-- ============================================================================
do $$
begin
  if to_regclass('public.ihub_shopify_ops') is not null
     and exists (select 1 from public.ihub_shopify_ops)
     and coalesce(current_setting('mad3oom.rollback_discard_shopify_ops', true), '') <> 'on' then
    raise exception 'التراجع عن 120 مرفوض: سجل عمليات Shopify غير فارغ (صدّره أولًا)';
  end if;
end $$;

drop function if exists public.ihub_shopify_op_confirm_begin(uuid,text,text,text);
drop function if exists public.ihub_shopify_op_authorize(uuid,text,text,text);
drop function if exists public.ihub_shopify_manage_status(uuid);
drop function if exists public.ihub_shopify_ops_list(uuid,integer);
drop function if exists public.owner_store_test_management(boolean,integer,text);
drop function if exists public.ihub_svc_shopify_op_result(uuid,text,text,text,jsonb);
drop function if exists public._ihub_shopify_op_gate(uuid,text);
drop function if exists public._ihub_scopes_missing(text[],text[]);
drop function if exists public._ihub_shopify_op_catalog();

drop table if exists public.ihub_shopify_confirmations;
drop table if exists public.ihub_shopify_ops;

delete from public.company_user_permissions where permission_key in
  ('store.catalog', 'store.inventory', 'store.orders_manage', 'store.customers_manage', 'store.discounts', 'store.fulfillment', 'store.returns');
delete from public.company_role_permissions where permission_key in
  ('store.catalog', 'store.inventory', 'store.orders_manage', 'store.customers_manage', 'store.discounts', 'store.fulfillment', 'store.returns');
delete from public.company_permission_catalog where key in
  ('store.catalog', 'store.inventory', 'store.orders_manage', 'store.customers_manage', 'store.discounts', 'store.fulfillment', 'store.returns');

delete from public.company_feature_overrides where feature_key = 'shopify_management';
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'company_feature_overrides_pilot_only') then
    alter table public.company_feature_overrides drop constraint company_feature_overrides_pilot_only;
  end if;
  alter table public.company_feature_overrides add constraint company_feature_overrides_pilot_only
    check (feature_key in ('integrations_hub', 'shopify_integration', 'store_support'));
end $$;
delete from public.plan_features where feature_key = 'shopify_management';
delete from public.feature_flags where key = 'shopify_management';

update public.ihub_providers
   set capabilities = (capabilities - array['manage_products', 'manage_inventory', 'manage_orders', 'manage_customers',
                                            'manage_discounts', 'manage_fulfillment', 'manage_returns', 'financial_operations'])
                      || jsonb_build_object('write_operations', 'missing')
 where key = 'shopify';
