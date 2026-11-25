-- ============================================================================
-- التراجع عن 135_owner_store_plan_deactivate_pause_sync
--   يحذف توقيع السعر الجديد ويعيد توقيع 133 (بلا إلغاء تفعيل).
--   ما لا يسترجعه هذا الملف وحده (موثّق عمدًا):
--   • owner_store_set_end_date / owner_store_resume /
--     owner_store_change_cycle / _store_subscription_json /
--     owner_store_plan_config / owner_store_operations_log /
--     owner_ihub_sync_request: تعود بإعادة تطبيق 133 كاملًا.
--   • ihub_sync_request: تعود بإعادة تطبيق 119 كاملًا.
--   • الأسعار وحالة التفعيل بيانات تبقى كما هي؛ إلغاء تفعيل تم حيًا لا
--     يعيده التراجع — أعد التفعيل من نموذج السعر إن لزم.
--   • علامة end_date_set_while_paused في price_snapshot لاشتراك متوقف:
--     تتجاهلها دوال 133 (الاستئناف يمدّد كالمعتاد)؛ تُمسح عند أول استئناف.
-- ============================================================================
drop function if exists public.owner_set_store_plan_price(numeric, numeric, boolean, boolean, text);
create or replace function public.owner_set_store_plan_price(p_monthly numeric, p_yearly numeric,
                                                            p_activate boolean default false)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_old       jsonb;
  v_new       jsonb;
  v_activated boolean := false;
begin
  if not public.owner_critical_ok() then
    raise exception 'سعر باقة المتاجر لمالك المنصة في سياقه وبتحقق حديث' using errcode = '42501';
  end if;
  if p_monthly is null or p_yearly is null or p_monthly <= 0 or p_yearly <= 0 then
    raise exception 'السعران الشهري والسنوي موجبان (بالجنيه)' using errcode = '22023';
  end if;
  select jsonb_build_object('key', key, 'is_active', is_active, 'price_monthly', price_monthly,
                            'price_yearly', price_yearly, 'currency', currency)
    into v_old from public.subscription_plans where key = 'store';
  if v_old is null then
    raise exception 'باقة المتاجر غير موجودة (118 غير مطبّق)' using errcode = 'P0002';
  end if;
  v_activated := coalesce(p_activate, false) and not (v_old->>'is_active')::boolean;
  update public.subscription_plans
     set price_monthly = p_monthly, price_yearly = p_yearly, currency = 'EGP',
         is_active = case when coalesce(p_activate, false) then true else is_active end
   where key = 'store'
   returning jsonb_build_object('key', key, 'is_active', is_active, 'price_monthly', price_monthly,
                                'price_yearly', price_yearly, 'currency', currency)
    into v_new;
  perform public.log_privileged('store.plan_price', null, v_old,
    v_new || jsonb_build_object('activated', v_activated));
  return v_new || jsonb_build_object('activated', v_activated);
end $$;
comment on function public.owner_set_store_plan_price(numeric, numeric, boolean) is
  '133: سعر باقة المتاجر (store) فقط — لا معامل مفتاح، فلا خطة أخرى تُمس. التفعيل مع السعرين فقط.';
do $$
declare
  f text := 'public.owner_set_store_plan_price(numeric,numeric,boolean)';
begin
  execute format('revoke all on function %s from public, anon, authenticated', f);
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute format('revoke all on function %s from service_role', f);
  end if;
  execute format('grant execute on function %s to authenticated', f);
end $$;
