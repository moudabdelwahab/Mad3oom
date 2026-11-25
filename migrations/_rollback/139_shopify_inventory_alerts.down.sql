-- ============================================================================
-- التراجع عن 139_shopify_inventory_alerts
--   يرفض إن وُجد سجل تنبيهات (ihub_shopify_inventory_alerts) — حذفه يمحو سجلًا حقيقيًا.
--   لتجاوز ذلك بعد تصدير السجل:
--     set local mad3oom.rollback_discard_shopify_alerts = 'on';  في المعاملة نفسها.
--   لا يمس دوال 119 ولا 120 ولا الكتالوج ولا الامتيازات.
-- ============================================================================
do $$
begin
  if to_regclass('public.ihub_shopify_inventory_alerts') is not null
     and exists (select 1 from public.ihub_shopify_inventory_alerts)
     and coalesce(current_setting('mad3oom.rollback_discard_shopify_alerts', true), '') <> 'on' then
    raise exception 'التراجع عن 139 مرفوض: سجل تنبيهات المخزون غير فارغ (صدّره أولًا)';
  end if;
end $$;

drop function if exists public.ihub_shopify_thresholds_list(uuid);
drop function if exists public.ihub_shopify_threshold_set(uuid,text,text,text,text,integer);
drop function if exists public.ihub_shopify_threshold_delete(uuid,uuid);
drop function if exists public.ihub_shopify_inventory_alerts_list(uuid,integer);
drop function if exists public.ihub_shopify_inventory_alerts_report(uuid,jsonb);
drop function if exists public._ihub_shopify_threshold_gate(uuid);

drop table if exists public.ihub_shopify_inventory_alerts;
drop table if exists public.ihub_shopify_inventory_thresholds;
