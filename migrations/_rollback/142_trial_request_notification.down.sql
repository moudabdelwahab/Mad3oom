-- ============================================================================
-- التراجع عن 142_trial_request_notification
--   يحذف دالة إشعار مالك المنصة بطلب التجربة، ويعيد request_saas_trial
--   إلى نسخة 137 حرفيًا (بلا إشعار) — 137 نفسه مطبَّق حيًا فلا يُمسّ
--   إلا باستعادة دالته كما كانت.
--   ما لا يسترجعه هذا الملف (موثّق عمدًا):
--   • صفوف notifications التي أُنشئت لإشعار المالك بطلبات سابقة: سجل
--     إشعارات قائم يبقى كما هو؛ احذفه من لوحة المالك إن لزم (تعليم
--     المقروء) لا من القاعدة.
--   • طلبات التجربة نفسها (saas_trial_requests): بلا مساس إطلاقًا.
-- ============================================================================
drop function if exists public._trial_request_notify_owners(uuid);

create or replace function public.request_saas_trial(p_plan_key text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company_id uuid;
  v_co         public.companies%rowtype;
  v_plan       public.subscription_plans%rowtype;
  v_request_id uuid;
begin
  if auth.uid() is null then
    raise exception 'سجّل الدخول أولًا' using errcode = '42501';
  end if;
  v_company_id := public.current_company_id();
  if v_company_id is null then
    raise exception 'هذا الطلب لحساب شركة أو متجر — أنشئ حساب الشركة أولًا' using errcode = '42501';
  end if;
  select * into v_co from public.companies where id = v_company_id;
  if v_co.user_id <> auth.uid() then
    raise exception 'طلب التجربة المجانية لمالك الشركة وحده' using errcode = '42501';
  end if;
  if p_plan_key is null or p_plan_key not in ('support', 'ultimate', 'store') then
    raise exception 'باقة غير صالحة للتجربة المجانية' using errcode = '22023';
  end if;
  if not public._trial_plan_allowed(p_plan_key, v_co.account_kind) then
    raise exception 'باقة المتاجر متاحة لحسابات المتاجر الإلكترونية فقط' using errcode = '22023';
  end if;
  select * into v_plan from public.subscription_plans where key = p_plan_key;
  if v_plan is null or not coalesce(v_plan.is_active, false) then
    raise exception 'هذه الباقة غير مفعّلة حاليًا — لا يمكن طلب تجربتها' using errcode = '22023';
  end if;
  if exists (select 1 from public.saas_trial_requests r
              where r.company_id = v_company_id and r.plan_key = p_plan_key and r.status = 'pending') then
    raise exception 'لديك طلب تجربة معلّق لهذه الباقة بالفعل — بانتظار قرار المالك' using errcode = '22023';
  end if;
  if exists (select 1 from public.saas_trial_requests r
              where r.company_id = v_company_id and r.plan_key = p_plan_key
                and r.status in ('approved', 'expired')) then
    raise exception 'سبق أن استخدمت هذه الشركة التجربة المجانية لهذه الباقة — التجربة مرة واحدة لكل باقة' using errcode = '22023';
  end if;
  if exists (select 1 from public.whatsapp_subscriptions s
              where s.company_id = v_company_id and s.plan = p_plan_key
                and s.status in ('active', 'paused') and s.end_date > now()
                and coalesce((s.price_snapshot->>'trial')::boolean, false) = false) then
    raise exception 'لديك اشتراك مدفوع فعّال في هذه الباقة بالفعل — لا حاجة للتجربة' using errcode = '22023';
  end if;
  insert into public.saas_trial_requests (company_id, plan_key, requested_by)
  values (v_company_id, p_plan_key, auth.uid())
  returning id into v_request_id;
  return public._trial_request_json(v_request_id);
end $$;
comment on function public.request_saas_trial(text) is
  '137: طلب تجربة مجانية 3 أيام من مالك الشركة — ينشئ طلبًا معلّقًا فقط، بلا اشتراك وبلا امتياز وبلا دفع. التجربة تبدأ فقط بموافقة المالك (owner_decide_saas_trial).';

do $$
begin
  execute 'revoke all on function public.request_saas_trial(text) from public, anon, authenticated';
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'revoke all on function public.request_saas_trial(text) from service_role';
  end if;
  execute 'grant execute on function public.request_saas_trial(text) to authenticated';
end $$;
