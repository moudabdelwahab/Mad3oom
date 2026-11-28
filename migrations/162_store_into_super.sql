-- ============================================================================
-- 162_store_into_super.sql — باقة المتاجر تنضم إلى الباقة الفائقة.
--
-- قرار المالك 2026-11-28: مزايا المتجر مشمولة في الباقة الفائقة
-- (super/ultimate)، بلا سعر مستقل وبلا تفعيل منفصل. باقة 'store' المنفصلة
-- تُسحَب من كل مسارات الشراء/التفعيل/العرض، وتبقى صفًا في
-- subscription_plans (غير مفعّلة، بلا سعرين) حتى لا ينكسر أي اشتراك
-- قائم عليها بصمت — وحيًّا لا يوجد أي اشتراك متجر (فحص 2026-11-28:
-- صفر whatsapp_subscriptions بباقة store، صفر طلبات تجربة/حساب بها).
--
-- ما يغيّره:
--   • الفائقة تمنح مفاتيح المتجر الثلاثة (integrations_hub،
--     shopify_integration، store_support) عبر plan_features — ففحص
--     المزايا company_has_feature() يرجعها لحاملي الفائقة بلا تعديل
--     في الدالة نفسها (الامتياز بيانات في plan_features، على نمط 141
--     حين ضمّ واتساب إلى الفائقة). الشاملة bundle لا تُمس.
--   • صف 'store': غير مفعّلة وبلا سعرين (كان كذلك حيًّا؛ التثبيت هنا
--     صريح حتى لا يعيد أحد تفعيلها بسعر).
--   • owner_set_store_plan_price (135) و owner_store_grant_exception
--     (133) و owner_set_store_plan_quota_features (133): بوابة المالك
--     كما هي، ثم رفض برسالة الدمج — لا سعر جديد ولا منح جديد ولا حد/
--     مزايا مستقلة للباقة المتقاعدة.
--   • owner_store_plan_config (135): يعيد 'merged_into': 'ultimate'.
--   • إدارة اشتراكات المتاجر القائمة (owner_store_subscription /
--     set_end_date / pause / resume): بلا تغيير — التوافق مع البيانات
--     القائمة. لا صف يُحذف ولا اشتراك يُحوَّل. وتحويل الدورة
--     (owner_store_change_cycle) يسقط إلى سعري الاشتراك نفسه المخزّنين
--     في price_snapshot حين تكون الباقة بلا سعرين (وهي كذلك حيًّا)،
--     وإلا لتعذّر التحويل نهائيًا بعد تقاعد دالة السعر.
--   • التجربة المجانية: 'store' خارج باقات التجربة — قيد
--     saas_trial_requests_plan_check يصير ('support','ultimate')،
--     و _trial_plan_allowed و request_saas_trial (نسخة 142 + سطر
--     الدمج) و owner_decide_saas_trial و my_saas_trial_status
--     يرفضونها برسالة الدمج؛ طلب معلّق قديم بباقة store لا يمكن
--     الموافقة عليه بعد الآن (يُرفض أو يُلغى).
--   • submit_store_account_request (118): طلب باقة 'store' مرفوض
--     برسالة الدمج؛ طلب حساب المتجر نفسه باقٍ — يطلب الفائقة (أو أي
--     باقة مفعّلة أخرى)، والتحقق من التفعيل يبقى في
--     submit_company_account_request.
--
-- ما لا يغيّره: لا سعر لأي باقة قائمة (الفائقة 1999/19999 كما هي)،
-- ولا صف plan_features لباقة 'store' نفسها (اشتراكاتها القديمة تحتفظ
-- بامتيازها)، ولا company_feature_overrides (منح متجر الاختبار
-- التجريبي باقية)، ولا دوال إدارة الاشتراكات القائمة، ولا
-- owner_entitlement_diagnostics، ولا مسار طلب حساب المتجر كنوع،
-- ولا أي شيء في SIE.
--
-- يعتمد على 118 و 133 و 135 و 137 و 142 (كلها مطبقة على الإنتاج).
-- قابل لإعادة التشغيل. التراجع: migrations/_rollback/162_store_into_super.down.sql
-- ============================================================================

do $$
begin
  if not exists (select 1 from public.subscription_plans where key = 'store') then
    raise exception '162 يتطلب صف باقة store (118)';
  end if;
  if not exists (select 1 from public.subscription_plans where key = 'ultimate') then
    raise exception '162 يتطلب صف الباقة الفائقة ultimate (065)';
  end if;
  if (select count(*) from public.feature_flags
       where key in ('integrations_hub', 'shopify_integration', 'store_support')) <> 3 then
    raise exception '162 يتطلب مفاتيح مزايا المتجر الثلاثة في feature_flags (118)';
  end if;
  if to_regprocedure('public.owner_set_store_plan_price(numeric,numeric,boolean,boolean,text)') is null then
    raise exception '162 يتطلب توقيع 135 لـ owner_set_store_plan_price';
  end if;
  if to_regprocedure('public.request_saas_trial(text)') is null
     or to_regprocedure('public._trial_plan_allowed(text,text)') is null
     or to_regprocedure('public.owner_decide_saas_trial(uuid,text,text)') is null
     or to_regprocedure('public.my_saas_trial_status()') is null
     or to_regprocedure('public.submit_store_account_request(text,text,date,text,text,text,text,text)') is null then
    raise exception '162 يتطلب دوال التجربة وطلب المتجر (137/142/118)';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'saas_trial_requests_plan_check') then
    raise exception '162 يتطلب قيد saas_trial_requests_plan_check (137)';
  end if;
end $$;


-- ============================================================================
-- 1) مزايا المتجر تمنح مع الباقة الفائقة — على نمط 141 (واتساب → الفائقة)
-- ============================================================================
insert into public.plan_features (plan_id, feature_key, enabled, limits)
select sp.id, f.key, true, '{}'::jsonb
  from public.subscription_plans sp
  cross join (values ('integrations_hub'), ('shopify_integration'),
                     ('store_support')) as f(key)
 where sp.key = 'ultimate'
on conflict (plan_id, feature_key) do update set enabled = true;

-- باقة 'store' نفسها: غير مفعّلة وبلا سعرين — تثبيت صريح للحالة الحية.
update public.subscription_plans
   set is_active = false, price_monthly = null, price_yearly = null, updated_at = now()
 where key = 'store';
comment on column public.subscription_plans.audience is
  '118: لمن تُباع الباقة. company: أي منظمة (السلوك القائم). ecommerce_store: مالك متجر فقط '
  '(محفّز enforce_plan_audience). باقة store متقاعدة (162): دُمجت في الفائقة، بلا سعر ولا تفعيل.';


-- ============================================================================
-- 2) سعر باقة المتاجر ومنحها وحدّها/مزاياها: بوابة المالك ثم رفض الدمج
-- ============================================================================
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
  raise exception 'باقة المتاجر دُمجت في الباقة الفائقة — بلا سعر مستقل ولا تفعيل منفصل' using errcode = '22023';
end $$;
comment on function public.owner_set_store_plan_price(numeric, numeric, boolean, boolean, text) is
  '162: سعر باقة المتاجر متقاعد — الباقة دُمجت في الفائقة، بلا سعر مستقل ولا تفعيل منفصل.';


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
  raise exception 'باقة المتاجر دُمجت في الباقة الفائقة — لا منح جديد لها؛ اشتراكات المتاجر القائمة تُدار كما هي' using errcode = '22023';
end $$;
comment on function public.owner_store_grant_exception(uuid, text, timestamptz, text) is
  '162: منح باقة المتاجر متقاعد — الباقة دُمجت في الفائقة؛ اشتراكات المتاجر القائمة تُدار كما هي.';


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
  raise exception 'باقة المتاجر دُمجت في الباقة الفائقة — لا حد ولا مزايا مستقلة لها' using errcode = '22023';
end $$;
comment on function public.owner_set_store_plan_quota_features(p_monthly_quota integer, p_features text[], p_reason text) is
  '162: حد/مزايا باقة المتاجر متقاعدة — الباقة دُمجت في الفائقة، بلا حد ولا مزايا مستقلة.';


-- ============================================================================
-- 3) إعداد باقة المتاجر يعلن الدمج
-- ============================================================================
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
    'merged_into', 'ultimate',
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

-- ============================================================================
-- 4) التجربة المجانية: بلا باقة متاجر منفصلة
-- ============================================================================
-- قيد الجدول أولًا: لا طلب جديد بباقة store حتى بإدراج مباشر.
alter table public.saas_trial_requests drop constraint saas_trial_requests_plan_check;
alter table public.saas_trial_requests add constraint saas_trial_requests_plan_check
  check (plan_key in ('support', 'ultimate'));
comment on column public.saas_trial_requests.plan_key is
  '137 + 162: الباقة المطلوبة: support أو ultimate فقط — باقة المتاجر دُمجت في الفائقة.';

create or replace function public._trial_plan_allowed(p_plan_key text, p_account_kind text)
returns boolean
language sql
immutable
security definer
set search_path to 'public'
as $$
  select p_plan_key in ('support', 'ultimate');
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
  if p_plan_key = 'store' then
    raise exception 'باقة المتاجر دُمجت في الباقة الفائقة — جرّب الفائقة بدلًا منها' using errcode = '22023';
  end if;
  if p_plan_key is null or p_plan_key not in ('support', 'ultimate') then
    raise exception 'باقة غير صالحة للتجربة المجانية' using errcode = '22023';
  end if;
  if not public._trial_plan_allowed(p_plan_key, v_co.account_kind) then
    raise exception 'باقة المتاجر دُمجت في الباقة الفائقة — جرّب الفائقة بدلًا منها' using errcode = '22023';
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
  '137 + 142 + 162: طلب تجربة مجانية 3 أيام من مالك الشركة — باقة المتاجر خارج التجربة (دُمجت في الفائقة) — ينشئ طلبًا معلّقًا فقط، بلا اشتراك وبلا امتياز وبلا دفع، ويُشعر مالك المنصة بالطلب (notifications إلى owner/trials.html). التجربة تبدأ فقط بموافقة المالك (owner_decide_saas_trial).';

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
    raise exception 'باقة المتاجر دُمجت في الباقة الفائقة — لا تجربة منفصلة لها' using errcode = '22023';
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
              then jsonb_build_object('eligible', false, 'reason', 'هذه الباقة غير متاحة لنوع حسابك')
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
       where sp.key in ('support', 'ultimate')),
    'requests', (
      select coalesce(jsonb_agg(public._trial_request_json(r.id) order by r.requested_at desc), '[]'::jsonb)
        from public.saas_trial_requests r where r.company_id = v_company_id));
end $$;
comment on function public.my_saas_trial_status() is
  '137 + 162: حالة التجربة لشركة المستخدم الحالي (بلا باقة متاجر — دُمجت في الفائقة): الباقات المؤهلة مع سبب عدم الأهلية، والطلبات، والتجربة الجارية إن وجدت.';

-- ============================================================================
-- 5) طلب حساب المتجر: الباقة المطلوبة لم تعد 'store'
-- ============================================================================
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
  if p_requested_plan = 'store' then
    raise exception 'باقة المتاجر دُمجت في الباقة الفائقة — اطلب الفائقة لحساب متجرك' using errcode = '22023';
  end if;

  v_res := public.submit_company_account_request(
    p_store_name, p_commercial_registration_number, p_commercial_registration_expiry,
    p_company_email, p_company_phone, p_requested_plan, p_requested_billing_cycle);

  update public.company_account_requests
     set account_kind = 'ecommerce_store', store_platform = 'shopify', store_domain_hint = v_domain
   where id = (v_res->>'id')::uuid and user_id = auth.uid();

  return v_res || jsonb_build_object('account_kind', 'ecommerce_store');
end $$;

-- ============================================================================
-- 6) تحويل دورة اشتراك متجر قائم: سعر الاشتراك نفسه بديلًا عن سعر الباقة
-- ============================================================================
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
  -- 162: الباقة متقاعدة بلا سعرين؛ تحويل دورة اشتراك قائم يستخدم سعري
  -- الاشتراك نفسه المخزّنين في price_snapshot (من المنح الأصلي)، ويسقط
  -- إلى سعري صف الباقة إن وُجدا. بلا سعرين في الموضعين يرفض التحويل.
  select price_monthly, price_yearly into v_m, v_y from public.subscription_plans where key = 'store';
  if v_m is null then
    v_m := (coalesce(v_sub.price_snapshot, '{}'::jsonb)->>'plan_price_monthly')::numeric;
  end if;
  if v_y is null then
    v_y := (coalesce(v_sub.price_snapshot, '{}'::jsonb)->>'plan_price_yearly')::numeric;
  end if;
  if v_m is null or v_y is null then
    raise exception 'لا سعر محفوظ لتحويل دورة هذا الاشتراك' using errcode = '22023';
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
-- ============================================================================
-- تحقق ذاتي
-- ============================================================================
do $$
declare
  v_ultimate_features integer;
  v_def text;
begin
  -- الفائقة تحمل مفاتيح المتجر الثلاثة مفعّلة.
  select count(*) into v_ultimate_features
    from public.plan_features pf
    join public.subscription_plans sp on sp.id = pf.plan_id
   where sp.key = 'ultimate' and pf.enabled
     and pf.feature_key in ('integrations_hub', 'shopify_integration', 'store_support');
  if v_ultimate_features <> 3 then
    raise exception '162: الفائقة يجب أن تحمل مفاتيح المتجر الثلاثة (وجد %)', v_ultimate_features;
  end if;

  -- باقة store متقاعدة: غير مفعّلة وبلا سعرين.
  if exists (select 1 from public.subscription_plans where key = 'store'
              and (is_active or price_monthly is not null or price_yearly is not null)) then
    raise exception '162: باقة store ليست متقاعدة (مفعّلة أو مسعّرة)';
  end if;

  -- بلا أي تغيير سعر: أي انحراف هنا يعني أن الترحيل مسّ سعرًا بالخطأ.
  if (select price_monthly from public.subscription_plans where key = 'ultimate') <> 1999
     or (select price_yearly from public.subscription_plans where key = 'ultimate') <> 19999 then
    raise exception '162: سعر الفائقة تغيّر';
  end if;
  if (select price_monthly from public.subscription_plans where key = 'support') <> 999
     or (select price_yearly from public.subscription_plans where key = 'support') <> 9999 then
    raise exception '162: سعر المتقدمة تغيّر';
  end if;
  if (select price_monthly from public.subscription_plans where key = 'whatsapp') <> 1299
     or (select price_yearly from public.subscription_plans where key = 'whatsapp') <> 12999 then
    raise exception '162: سعر واتساب تغيّر';
  end if;
  if (select price_monthly from public.subscription_plans where key = 'bundle') <> 2099
     or (select price_yearly from public.subscription_plans where key = 'bundle') <> 22999 then
    raise exception '162: سعر الشاملة تغيّر';
  end if;

  -- الشاملة لم تنل مزايا المتجر: الدمج للفائقة وحدها.
  if exists (select 1 from public.plan_features pf
              join public.subscription_plans sp on sp.id = pf.plan_id
             where sp.key = 'bundle' and pf.enabled
               and pf.feature_key in ('integrations_hub', 'shopify_integration', 'store_support')) then
    raise exception '162: الشاملة نالت مزايا المتجر خطأً';
  end if;

  -- قيد التجربة صار باقتين فقط.
  select pg_get_constraintdef(oid) into v_def from pg_constraint
   where conrelid = 'public.saas_trial_requests'::regclass
     and conname = 'saas_trial_requests_plan_check';
  if v_def is null or position('''store''' in v_def) <> 0 then
    raise exception '162: قيد باقات التجربة ما زال يذكر store';
  end if;

  -- التجربة: store مرفوضة حتى لمتجر إلكتروني، والباقتان مقبولتان.
  if public._trial_plan_allowed('store', 'ecommerce_store') then
    raise exception '162: _trial_plan_allowed ما زال يقبل store';
  end if;
  if not public._trial_plan_allowed('support', 'company')
     or not public._trial_plan_allowed('ultimate', 'ecommerce_store') then
    raise exception '162: _trial_plan_allowed رفض باقة تجربة صالحة';
  end if;

  -- الدوال المتقاعدة تعلن الدمج، وطلب التجربة يحتفظ بإشعار 142.
  for v_def in
    select pg_get_functiondef(p.oid)
      from pg_proc p
     where p.proname in ('owner_set_store_plan_price', 'owner_store_grant_exception',
                         'owner_set_store_plan_quota_features')
       and p.pronamespace = 'public'::regnamespace
  loop
    if position('دُمجت' in v_def) = 0 then
      raise exception '162: دالة متقاعدة بلا رسالة دمج';
    end if;
  end loop;
  v_def := pg_get_functiondef('public.owner_store_plan_config()'::regprocedure);
  if position('merged_into' in v_def) = 0 then
    raise exception '162: owner_store_plan_config بلا merged_into';
  end if;
  v_def := pg_get_functiondef('public.request_saas_trial(text)'::regprocedure);
  if position('دُمجت' in v_def) = 0 then
    raise exception '162: request_saas_trial بلا رفض store';
  end if;
  if position('_trial_request_notify_owners' in v_def) = 0 then
    raise exception '162: request_saas_trial فقد إشعار 142';
  end if;
  v_def := pg_get_functiondef('public.submit_store_account_request(text,text,date,text,text,text,text,text)'::regprocedure);
  if position('دُمجت' in v_def) = 0 then
    raise exception '162: submit_store_account_request بلا رفض store';
  end if;
  v_def := pg_get_functiondef('public.owner_store_change_cycle(uuid,text,text)'::regprocedure);
  if position('162: الباقة متقاعدة بلا سعرين' in v_def) = 0 then
    raise exception '162: owner_store_change_cycle بلا سقوط لسعر الاشتراك';
  end if;

  raise notice '162: مزايا المتجر في الفائقة؛ باقة store متقاعدة بلا سعر ولا تفعيل ولا تجربة منفصلة';
end $$;
