-- ============================================================================
-- 162_store_into_super.down.sql — التراجع عن دمج باقة المتاجر في الفائقة.
--
-- يعيد: مفاتيح المتجر الثلاثة تُسحب من الفائقة؛ قيد التجربة يعود لثلاث
-- باقات؛ والدوال العشر تعود إلى تعريفاتها الحرفية قبل 162 (137/142
-- للتجربة، 118 لطلب المتجر، 133/135 لإدارة باقة المتاجر وتحويل الدورة). صف 'store'
-- نفسه لم يُحذف في 162 فلا يُستعاد هنا — كان ولا يزال غير مفعّل بلا سعر.
-- ملاحظة: طلبات تجربة/حساب بباقة store أُنشئت بعد 162 غير موجودة أصلًا
-- (162 يرفضها)، فلا بيانات تُفقد بالتراجع.
-- ============================================================================

-- سحب مفاتيح المتجر من الفائقة.
delete from public.plan_features pf using public.subscription_plans sp
 where pf.plan_id = sp.id and sp.key = 'ultimate'
   and pf.feature_key in ('integrations_hub', 'shopify_integration', 'store_support');

-- قيد التجربة يعود لثلاث باقات.
alter table public.saas_trial_requests drop constraint saas_trial_requests_plan_check;
alter table public.saas_trial_requests add constraint saas_trial_requests_plan_check
  check (plan_key in ('support', 'ultimate', 'store'));

create or replace function public._trial_plan_allowed(p_plan_key text, p_account_kind text)
returns boolean
language sql
immutable
security definer
set search_path to 'public'
as $$
  select p_plan_key in ('support', 'ultimate', 'store')
     and (p_plan_key <> 'store' or p_account_kind = 'ecommerce_store');
$$;

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
  -- 142: إشعار مالك المنصة بالطلب الجديد — على قناة notifications القائمة
  -- (جرس لوحة المالك)، في المعاملة نفسها فلا طلب بلا إشعار.
  perform public._trial_request_notify_owners(v_request_id);
  return public._trial_request_json(v_request_id);
end $$;
comment on function public.request_saas_trial(text) is
  '137 + 142: طلب تجربة مجانية 3 أيام من مالك الشركة — ينشئ طلبًا معلّقًا فقط، بلا اشتراك وبلا امتياز وبلا دفع، ويُشعر مالك المنصة بالطلب (notifications إلى owner/trials.html). التجربة تبدأ فقط بموافقة المالك (owner_decide_saas_trial).';

create or replace function public.owner_decide_saas_trial(p_request uuid, p_decision text,
                                                          p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_req    public.saas_trial_requests%rowtype;
  v_co     public.companies%rowtype;
  v_plan   public.subscription_plans%rowtype;
  v_reason text;
  v_start  timestamptz := now();
  v_end    timestamptz := now() + interval '3 days';
  v_sub    public.whatsapp_subscriptions%rowtype;
begin
  if not public.owner_critical_ok() then
    raise exception 'قرار طلبات التجربة لمالك المنصة في سياقه وبتحقق حديث' using errcode = '42501';
  end if;
  if p_decision is null or p_decision not in ('approved', 'rejected') then
    raise exception 'القرار موافقة أو رفض فقط' using errcode = '22023';
  end if;
  select * into v_req from public.saas_trial_requests where id = p_request;
  if not found then
    raise exception 'طلب التجربة غير موجود' using errcode = 'P0002';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'القرار من طلب معلّق فقط' using errcode = '22023';
  end if;
  select * into v_co from public.companies where id = v_req.company_id;
  if not found then
    raise exception 'الشركة غير موجودة' using errcode = 'P0002';
  end if;
  if not public._trial_plan_allowed(v_req.plan_key, v_co.account_kind) then
    raise exception 'باقة المتاجر متاحة لحسابات المتاجر الإلكترونية فقط' using errcode = '22023';
  end if;
  select * into v_plan from public.subscription_plans where key = v_req.plan_key;
  if v_plan is null or not coalesce(v_plan.is_active, false) then
    raise exception 'هذه الباقة غير مفعّلة حاليًا — فعّلها أولًا قبل الموافقة على تجربتها' using errcode = '22023';
  end if;
  if exists (select 1 from public.whatsapp_subscriptions s
              where s.company_id = v_req.company_id and s.plan = v_req.plan_key
                and s.status in ('active', 'paused') and s.end_date > now()
                and coalesce((s.price_snapshot->>'trial')::boolean, false) = false) then
    raise exception 'للشركة اشتراك مدفوع فعّال في هذه الباقة بالفعل — لا تجربة مع اشتراك قائم' using errcode = '22023';
  end if;
  if exists (select 1 from public.saas_trial_requests r
              where r.company_id = v_req.company_id and r.plan_key = v_req.plan_key
                and r.status in ('approved', 'expired') and r.id <> p_request) then
    raise exception 'سبق أن استخدمت هذه الشركة التجربة المجانية لهذه الباقة' using errcode = '22023';
  end if;

  if p_decision = 'rejected' then
    -- الرفض بسبب مسجَّل (10 أحرف على الأقل، على نمط منح المتاجر 133).
    v_reason := public._store_reason(p_reason);
    update public.saas_trial_requests
       set status = 'rejected', decided_at = now(), decided_by = auth.uid(),
           decision_reason = v_reason, updated_at = now()
     where id = p_request;
    perform public.log_privileged('trial.rejected', null,
      jsonb_build_object('request_id', p_request, 'company_id', v_req.company_id, 'plan_key', v_req.plan_key),
      jsonb_build_object('request_id', p_request, 'decision', 'rejected', 'reason', left(v_reason, 300)));
    return public._trial_request_json(p_request);
  end if;

  -- الموافقة: السبب اختياري، والبداية الآن والنهاية الآن + 3 أيام بالضبط.
  v_reason := nullif(btrim(coalesce(p_reason, '')), '');
  insert into public.whatsapp_subscriptions
    (user_id, company_id, plan, billing_cycle, status, start_date, end_date, duration_days,
     payment_method, payment_reference, price_snapshot, reviewed_by, reviewed_at)
  values (v_co.user_id, v_co.id, v_req.plan_key, null, 'active', v_start, v_end, 3,
          null, null,
          jsonb_build_object('trial', true, 'trial_days', 3, 'amount', 0, 'currency', 'EGP',
                             'no_auto_renew', true, 'no_payment_method', true,
                             'trial_request_id', v_req.id,
                             'plan_price_monthly', v_plan.price_monthly,
                             'plan_price_yearly', v_plan.price_yearly),
          auth.uid(), now())
  returning * into v_sub;
  update public.saas_trial_requests
     set status = 'approved', decided_at = now(), decided_by = auth.uid(),
         decision_reason = v_reason, trial_starts_at = v_start, trial_ends_at = v_end,
         subscription_id = v_sub.id, updated_at = now()
   where id = p_request;
  perform public.recompute_user_access(v_co.user_id);
  perform public._store_audit(v_sub.id, 'trial_started', null,
    jsonb_build_object('status', 'active', 'plan', v_req.plan_key,
                       'trial_starts_at', v_start, 'trial_ends_at', v_end,
                       'trial_days', 3, 'no_auto_renew', true), v_reason);
  perform public.log_privileged('trial.approved', null,
    jsonb_build_object('request_id', p_request, 'company_id', v_req.company_id, 'plan_key', v_req.plan_key),
    jsonb_build_object('request_id', p_request, 'decision', 'approved',
                       'subscription_id', v_sub.id, 'trial_starts_at', v_start, 'trial_ends_at', v_end,
                       'reason', left(coalesce(v_reason, ''), 300)));
  return public._trial_request_json(p_request);
end $$;
comment on function public.owner_decide_saas_trial(uuid, text, text) is
  '137: قرار المالك على طلب تجربة: موافقة تبدأ 3 أيام فورًا باشتراك تجربة على الحساب الحي (بلا دفع، بلا تجديد تلقائي، بلا بيئة تجريبية)، أو رفض بسبب مسجَّل. بتحقق حديث ومدقَّقة.';

create or replace function public.my_saas_trial_status()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_company_id uuid;
  v_co         public.companies%rowtype;
  v_active     jsonb;
begin
  v_company_id := public.current_company_id();
  if v_company_id is null then
    return jsonb_build_object('has_company', false, 'eligible_plans', '[]'::jsonb,
                              'requests', '[]'::jsonb, 'active_trial', null, 'can_request', false);
  end if;
  select * into v_co from public.companies where id = v_company_id;
  select public._trial_request_json(r.id) into v_active
    from public.saas_trial_requests r
   where r.company_id = v_company_id and r.status = 'approved'
     and r.trial_ends_at is not null and r.trial_ends_at > now()
   order by r.trial_ends_at desc limit 1;
  return jsonb_build_object(
    'has_company', true, 'company_id', v_co.id, 'company_name', v_co.company_name,
    'account_kind', v_co.account_kind, 'can_request', v_co.user_id = auth.uid(),
    'active_trial', v_active,
    'eligible_plans', (
      select coalesce(jsonb_agg(jsonb_build_object(
          'plan_key', sp.key, 'plan_name_ar', coalesce(sp.name_ar, sp.name, sp.key),
          'is_active', sp.is_active,
          'eligible', (elig.e->>'eligible')::boolean, 'reason', elig.e->>'reason')
          order by sp.sort_order, sp.key), '[]'::jsonb)
        from public.subscription_plans sp
        cross join lateral (
          select case
            when not public._trial_plan_allowed(sp.key, v_co.account_kind)
              then jsonb_build_object('eligible', false, 'reason', 'باقة المتاجر متاحة لحسابات المتاجر الإلكترونية فقط')
            when not coalesce(sp.is_active, false)
              then jsonb_build_object('eligible', false, 'reason', 'هذه الباقة غير مفعّلة حاليًا')
            when exists (select 1 from public.saas_trial_requests r
                          where r.company_id = v_company_id and r.plan_key = sp.key and r.status = 'pending')
              then jsonb_build_object('eligible', false, 'reason', 'لديك طلب تجربة معلّق لهذه الباقة — بانتظار قرار المالك')
            when exists (select 1 from public.saas_trial_requests r
                          where r.company_id = v_company_id and r.plan_key = sp.key and r.status in ('approved', 'expired'))
              then jsonb_build_object('eligible', false, 'reason', 'سبق أن استخدمت هذه الشركة التجربة المجانية لهذه الباقة')
            when exists (select 1 from public.whatsapp_subscriptions s
                          where s.company_id = v_company_id and s.plan = sp.key
                            and s.status in ('active', 'paused') and s.end_date > now()
                            and coalesce((s.price_snapshot->>'trial')::boolean, false) = false)
              then jsonb_build_object('eligible', false, 'reason', 'لديك اشتراك مدفوع فعّال في هذه الباقة بالفعل')
            else jsonb_build_object('eligible', true, 'reason', null)
          end as e) elig
       where sp.key in ('support', 'ultimate', 'store')),
    'requests', (
      select coalesce(jsonb_agg(public._trial_request_json(r.id) order by r.requested_at desc), '[]'::jsonb)
        from public.saas_trial_requests r where r.company_id = v_company_id));
end $$;
comment on function public.my_saas_trial_status() is
  '137: حالة التجربة لشركة المستخدم الحالي: الباقات المؤهلة مع سبب عدم الأهلية، والطلبات، والتجربة الجارية إن وجدت.';

create or replace function public.submit_store_account_request(
  p_store_name text, p_commercial_registration_number text, p_commercial_registration_expiry date,
  p_company_email text default null, p_company_phone text default null,
  p_requested_plan text default null, p_requested_billing_cycle text default null,
  p_store_domain text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_res    jsonb;
  v_domain text := lower(btrim(coalesce(p_store_domain, '')));
begin
  if v_domain = '' then
    v_domain := null;
  elsif v_domain !~ '\.myshopify\.com$' then
    v_domain := v_domain || '.myshopify.com';
  end if;
  if v_domain is not null and v_domain !~ '^[a-z0-9][a-z0-9-]{0,59}\.myshopify\.com$' then
    raise exception 'نطاق المتجر غير صالح — اكتب اسم متجرك في Shopify مثل my-store.myshopify.com'
      using errcode = '22023';
  end if;
  if p_requested_plan is not null and not exists (
       select 1 from public.subscription_plans where key = p_requested_plan and audience = 'ecommerce_store') then
    raise exception 'هذه الباقة ليست باقة متاجر' using errcode = '22023';
  end if;

  v_res := public.submit_company_account_request(
    p_store_name, p_commercial_registration_number, p_commercial_registration_expiry,
    p_company_email, p_company_phone, p_requested_plan, p_requested_billing_cycle);

  update public.company_account_requests
     set account_kind = 'ecommerce_store', store_platform = 'shopify', store_domain_hint = v_domain
   where id = (v_res->>'id')::uuid and user_id = auth.uid();

  return v_res || jsonb_build_object('account_kind', 'ecommerce_store');
end $$;

-- سعر باقة المتاجر (135): التوقيع الخماسي يعود كما كان.
drop function if exists public.owner_set_store_plan_price(numeric, numeric, boolean, boolean, text);
create or replace function public.owner_set_store_plan_price(p_monthly numeric, p_yearly numeric,
                                                            p_activate boolean default false,
                                                            p_deactivate boolean default false,
                                                            p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_old         jsonb;
  v_new         jsonb;
  v_activated   boolean := false;
  v_deactivated boolean := false;
  v_reason      text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if not public.owner_critical_ok() then
    raise exception 'سعر باقة المتاجر لمالك المنصة في سياقه وبتحقق حديث' using errcode = '42501';
  end if;
  if coalesce(p_activate, false) and coalesce(p_deactivate, false) then
    raise exception 'لا يمكن تفعيل باقة المتاجر وإلغاء تفعيلها معًا' using errcode = '22023';
  end if;
  if coalesce(p_deactivate, false) then
    if (p_monthly is not null and p_monthly <= 0) or (p_yearly is not null and p_yearly <= 0) then
      raise exception 'السعران الشهري والسنوي موجبان (بالجنيه) إن أُرسلا' using errcode = '22023';
    end if;
  elsif p_monthly is null or p_yearly is null or p_monthly <= 0 or p_yearly <= 0 then
    raise exception 'السعران الشهري والسنوي موجبان (بالجنيه)' using errcode = '22023';
  end if;
  select jsonb_build_object('key', key, 'is_active', is_active, 'price_monthly', price_monthly,
                            'price_yearly', price_yearly, 'currency', currency)
    into v_old from public.subscription_plans where key = 'store';
  if v_old is null then
    raise exception 'باقة المتاجر غير موجودة (118 غير مطبّق)' using errcode = 'P0002';
  end if;
  v_activated := coalesce(p_activate, false) and not (v_old->>'is_active')::boolean;
  v_deactivated := coalesce(p_deactivate, false) and (v_old->>'is_active')::boolean;
  update public.subscription_plans
     set price_monthly = coalesce(p_monthly, price_monthly),
         price_yearly = coalesce(p_yearly, price_yearly), currency = 'EGP',
         is_active = case when coalesce(p_deactivate, false) then false
                          when coalesce(p_activate, false) then true
                          else is_active end
   where key = 'store'
   returning jsonb_build_object('key', key, 'is_active', is_active, 'price_monthly', price_monthly,
                                'price_yearly', price_yearly, 'currency', currency)
    into v_new;
  perform public.log_privileged('store.plan_price', null, v_old,
    v_new || jsonb_build_object('activated', v_activated, 'deactivated', v_deactivated,
                                'reason', left(v_reason, 300)));
  return v_new || jsonb_build_object('activated', v_activated, 'deactivated', v_deactivated);
end $$;
comment on function public.owner_set_store_plan_price(numeric, numeric, boolean, boolean, text) is
  '135: سعر باقة المتاجر (store) فقط + إلغاء تفعيلها (p_deactivate) بتأكيد وسبب. التفعيل مع السعرين فقط؛ الإلغاء يبقي السعرين.';

create or replace function public.owner_store_grant_exception(p_company uuid, p_billing_cycle text,
                                                             p_end_date timestamptz, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_co     public.companies%rowtype;
  v_reason text;
  v_m      numeric;
  v_y      numeric;
  v_price  numeric;
  v_days   int;
  v_sub    public.whatsapp_subscriptions%rowtype;
begin
  if not public.owner_critical_ok() then
    raise exception 'منح باقة المتاجر لمالك المنصة في سياقه وبتحقق حديث' using errcode = '42501';
  end if;
  v_reason := public._store_reason(p_reason);
  if p_billing_cycle is null or p_billing_cycle not in ('monthly', 'yearly') then
    raise exception 'دورة فوترة غير صالحة' using errcode = '22023';
  end if;
  if p_end_date is null or p_end_date <= now() or p_end_date > now() + interval '1 year' then
    raise exception 'تاريخ الانتهاء في المستقبل وبحد أقصى سنة من الآن' using errcode = '22023';
  end if;
  select * into v_co from public.companies where id = p_company;
  if not found then
    raise exception 'الشركة غير موجودة' using errcode = 'P0002';
  end if;
  if v_co.account_kind <> 'ecommerce_store' then
    raise exception 'المنح كاستثناء لمتجر إلكتروني فقط' using errcode = '22023';
  end if;
  if exists (select 1 from public.whatsapp_subscriptions s where s.company_id = p_company and s.plan = 'store'
              and s.status in ('active', 'paused') and s.end_date > now()) then
    raise exception 'للشركة اشتراك متجر قائم (فعّال أو متوقف) — استأنف المتوقف أو عدّل القائم' using errcode = '22023';
  end if;
  select price_monthly, price_yearly into v_m, v_y from public.subscription_plans where key = 'store';
  if v_m is null or v_y is null then
    raise exception 'حدّد سعر باقة المتاجر أولًا (owner_set_store_plan_price)' using errcode = '22023';
  end if;
  v_price := case when p_billing_cycle = 'yearly' then v_y else v_m end;
  v_days := greatest(1, ceil(extract(epoch from (p_end_date - now())) / 86400)::int);
  insert into public.whatsapp_subscriptions
    (user_id, company_id, plan, billing_cycle, status, start_date, end_date, duration_days,
     payment_method, payment_reference, price_snapshot, reviewed_by, reviewed_at)
  values (v_co.user_id, v_co.id, 'store', p_billing_cycle, 'active', now(), p_end_date, v_days,
          'owner_exception', left(v_reason, 300),
          jsonb_build_object('plan_price_monthly', v_m, 'plan_price_yearly', v_y, 'cycle_price', v_price,
                             'amount', 0, 'currency', 'EGP', 'exception', true, 'billing_cycle', p_billing_cycle),
          auth.uid(), now())
  returning * into v_sub;
  perform public.recompute_user_access(v_co.user_id);
  perform public._store_audit(v_sub.id, 'grant_exception', null,
    jsonb_build_object('status', 'active', 'billing_cycle', p_billing_cycle, 'end_date', p_end_date, 'price', v_price), v_reason);
  perform public.log_privileged('store.grant_exception', null, null,
    jsonb_build_object('company_id', v_co.id, 'subscription_id', v_sub.id, 'billing_cycle', p_billing_cycle,
                       'end_date', p_end_date, 'reason', left(v_reason, 300)));
  return public._store_subscription_json(v_sub.id);
end $$;
comment on function public.owner_store_grant_exception(uuid, text, timestamptz, text) is
  '133: منح باقة المتاجر لمتجر عميل بدون شراء — استثناء مالك بتحقق حديث وسبب، مبلغ 0.';

create or replace function public.owner_set_store_plan_quota_features(p_monthly_quota integer, p_features text[], p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_reason text;
  v_old    jsonb;
  v_plan   uuid;
begin
  if not public.owner_critical_ok() then
    raise exception 'إعداد باقة المتاجر لمالك المنصة في سياقه وبتحقق حديث' using errcode = '42501';
  end if;
  v_reason := public._store_reason(p_reason);
  if p_monthly_quota is not null and p_monthly_quota <= 0 then
    raise exception 'حد التذاكر رقم موجب أو فارغ (بلا حد)' using errcode = '22023';
  end if;
  select id into v_plan from public.subscription_plans where key = 'store';
  if v_plan is null then
    raise exception 'باقة المتاجر غير موجودة (118 غير مطبّق)' using errcode = 'P0002';
  end if;
  if exists (select 1 from unnest(coalesce(p_features, '{}')) f
              where f not in (select feature_key from public.plan_features where plan_id = v_plan)) then
    raise exception 'ميزة غير معروفة لباقة المتاجر' using errcode = '22023';
  end if;
  v_old := public.owner_store_plan_config();
  insert into public.plan_ticket_quotas (plan_key, monthly_tickets) values ('store', p_monthly_quota)
  on conflict (plan_key) do update set monthly_tickets = excluded.monthly_tickets, updated_at = now();
  update public.plan_features set enabled = (feature_key = any (coalesce(p_features, '{}')))
   where plan_id = v_plan;
  perform public.log_privileged('store.plan_quota_features', null, v_old,
    public.owner_store_plan_config() || jsonb_build_object('reason', left(v_reason, 300)));
  return public.owner_store_plan_config();
end $$;

create or replace function public.owner_store_plan_config()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  perform public._owner_require();
  return jsonb_build_object(
    'ticket_quota', (select monthly_tickets from public.plan_ticket_quotas where plan_key = 'store'),
    'quota_defined', exists (select 1 from public.plan_ticket_quotas where plan_key = 'store'),
    'is_active', (select is_active from public.subscription_plans where key = 'store'),
    'price_monthly', (select price_monthly from public.subscription_plans where key = 'store'),
    'price_yearly', (select price_yearly from public.subscription_plans where key = 'store'),
    'currency', (select currency from public.subscription_plans where key = 'store'),
    'features', (select coalesce(jsonb_agg(jsonb_build_object('feature_key', pf.feature_key, 'enabled', pf.enabled)
                                           order by pf.feature_key), '[]'::jsonb)
                  from public.plan_features pf join public.subscription_plans sp on sp.id = pf.plan_id
                 where sp.key = 'store'));
end $$;

create or replace function public.owner_store_change_cycle(p_subscription uuid, p_billing_cycle text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_sub    public.whatsapp_subscriptions%rowtype;
  v_reason text;
  v_m      numeric;
  v_y      numeric;
  v_price  numeric;
  v_days   int;
  v_new_end timestamptz;
  v_snap   jsonb;
  v_amount numeric;
begin
  if not public.owner_critical_ok() then
    raise exception 'تحويل دورة اشتراك المتجر لمالك المنصة في سياقه وبتحقق حديث' using errcode = '42501';
  end if;
  v_reason := public._store_reason(p_reason);
  select * into v_sub from public.whatsapp_subscriptions where id = p_subscription;
  if not found then
    raise exception 'الاشتراك غير موجود' using errcode = 'P0002';
  end if;
  if v_sub.plan <> 'store' then
    raise exception 'هذه الدالة لاشتراكات المتاجر فقط' using errcode = '22023';
  end if;
  if p_billing_cycle is null or p_billing_cycle not in ('monthly', 'yearly') then
    raise exception 'دورة فوترة غير صالحة' using errcode = '22023';
  end if;
  if p_billing_cycle = v_sub.billing_cycle then
    raise exception 'الاشتراك على هذه الدورة بالفعل' using errcode = '22023';
  end if;
  if v_sub.status not in ('active', 'paused') then
    raise exception 'تحويل الدورة للاشتراك الفعّال أو المتوقف فقط' using errcode = '22023';
  end if;
  select price_monthly, price_yearly into v_m, v_y from public.subscription_plans where key = 'store';
  if v_m is null or v_y is null then
    raise exception 'حدّد سعر باقة المتاجر أولًا (owner_set_store_plan_price)' using errcode = '22023';
  end if;
  v_price := case when p_billing_cycle = 'yearly' then v_y else v_m end;
  v_snap := coalesce(v_sub.price_snapshot, '{}'::jsonb);
  v_amount := case when coalesce((v_snap->>'exception')::boolean, false) then 0 else v_price end;
  v_snap := v_snap || jsonb_build_object('plan_price_monthly', v_m, 'plan_price_yearly', v_y,
                                         'cycle_price', v_price, 'amount', v_amount, 'billing_cycle', p_billing_cycle);
  if v_sub.status = 'active' then
    v_days := case when p_billing_cycle = 'yearly' then 365 else 30 end;
    v_new_end := now() + make_interval(days => v_days);
    v_days := greatest(1, ceil(extract(epoch from (v_new_end - v_sub.start_date)) / 86400)::int);
    update public.whatsapp_subscriptions
       set billing_cycle = p_billing_cycle, end_date = v_new_end, duration_days = v_days,
           price_snapshot = v_snap, updated_at = now()
     where id = p_subscription;
  else
    v_snap := (v_snap - 'end_date_set_while_paused')
              || jsonb_build_object('cycle_changed_while_paused', true);
    update public.whatsapp_subscriptions
       set billing_cycle = p_billing_cycle, price_snapshot = v_snap, updated_at = now()
     where id = p_subscription;
    v_new_end := v_sub.end_date;
  end if;
  perform public.recompute_user_access(v_sub.user_id);
  perform public._store_audit(p_subscription, 'change_cycle',
    jsonb_build_object('billing_cycle', v_sub.billing_cycle, 'end_date', v_sub.end_date),
    jsonb_build_object('billing_cycle', p_billing_cycle, 'end_date', v_new_end), v_reason);
  perform public.log_privileged('store.subscription_cycle', null,
    jsonb_build_object('subscription_id', p_subscription, 'billing_cycle', v_sub.billing_cycle),
    jsonb_build_object('subscription_id', p_subscription, 'billing_cycle', p_billing_cycle,
                       'end_date', v_new_end, 'reason', left(v_reason, 300)));
  return public._store_subscription_json(p_subscription);
end $$;
