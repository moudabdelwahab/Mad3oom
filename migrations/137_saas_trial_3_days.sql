-- ============================================================================
-- 137_saas_trial_3_days.sql
--   تجربة مجانية 3 أيام بالضبط للباقات المدفوعة للشركات والمتاجر
--   (support / ultimate للشركات، store للمتاجر الإلكترونية).
--
--   التدفق: طلب تجربة من مالك الشركة → موافقة/رفض المالك من لوحة المالك
--   أولًا → تبدأ الـ 3 أيام فقط لحظة موافقة المالك. بلا موافقة مالك لا
--   تبدأ التجربة إطلاقًا، ولا يوجد أي مسار ينشئ اشتراك تجربة من طلب
--   العميل مباشرة.
--
--   ── قيد صريح: لا بيئة تجريبية (Sandbox) إطلاقًا ─────────────────────────
--   التجربة على الحساب الحي نفسه: صف اشتراك عادي في whatsapp_subscriptions
--   (plan = الباقة المطلوبة، price_snapshot.trial = true) فيمنح امتيازات
--   الباقة كما تحسبها owned_feature_keys() — status='active' و
--   end_date > now() — على الحساب الحي، بلا نسخة حساب ولا صفحة sandbox
--   ولا وضع sandbox ولا أي جدول/دالة/واجهة تحمل هذا الاسم للتجربة. هذا
--   الملف لا ينشئ أيًا منها، والتحقق الذاتي في §9 يفشل الترحيل إن ظهر
--   لفظ sandbox في أي دالة من دواله أو عمود دفع في جدول الطلبات.
--
--   ── الانتهاء التلقائي وبلا تجديد وبلا دفع ───────────────────────────────
--   • المدة 3 أيام بالضبط: قيد قاعدة trial_ends_at = trial_starts_at +
--     interval '3 days'، فلا مدة أخرى ممكنة من أي مسار.
--   • لا بطاقة ولا دفع يُحفظ: جدول الطلبات بلا أي عمود دفع أو بطاقة، وصف
--     الاشتراك يُنشأ بـ payment_method = NULL و billing_cycle = NULL
--     (التجربة بلا دورة فوترة)، و price_snapshot يحمل amount = 0 مع
--     no_auto_renew = true و no_payment_method = true.
--   • الامتياز يتوقف لحظة الانتهاء حتى قبل قلب الحالة: owned_feature_keys
--     تشترط end_date > now()، فانتهاء المدة يسحب الخدمات فورًا. قلب
--     الحالة إلى 'expired' تقوم به الوظيفة المجدولة القائمة
--     expire_stale_subscriptions() (كل ساعة) لصفوف الاشتراكات،
--     و expire_saas_trials() هنا للطلبات المرتبطة بها.
--   • لا تحويل لاشتراك مدفوع: لا شيء في هذا الملف ينشئ اشتراكًا مدفوعًا أو
--     يجدّد التجربة؛ بعد الانتهاء يعود الحساب كما كان، والتجديد — إن أراده
--     العميل — شراء عادي من مسار الاشتراكات القائم.
--   • تجربة واحدة لكل شركة وكل باقة: طلب معلّق واحد لكل (شركة، باقة)،
--     وطلب واحد مستخدم (موافَق عليه أو منتهٍ) يمنع طلبًا جديدًا لنفس
--     الباقة إلى الأبد — فلا حلقة تجارب متتالية تعني اشتراكًا مجانيًا دائمًا.
--
--   يعتمد على 016 (current_company_id) و 018/065 (الاشتراكات) و 035
--   (recompute_user_access, expire_stale_subscriptions) و 053
--   (owner_critical_ok, log_privileged) و 118 (باقة store وجمهورها)
--   و 119 (_owner_require) و 133 (_store_audit, _store_reason).
--   قابل لإعادة التشغيل. بلا أي تحديث بيانات وبلا تفعيل باقة.
--   التراجع: migrations/_rollback/137_saas_trial_3_days.down.sql
-- ============================================================================


-- ============================================================================
-- 0) المتطلبات
-- ============================================================================
do $$
declare f text;
begin
  foreach f in array array[
    'public.current_company_id()',
    'public._owner_require()', 'public.owner_critical_ok()',
    'public.log_privileged(text,uuid,jsonb,jsonb)',
    'public.recompute_user_access(uuid)',
    'public.expire_stale_subscriptions()',
    'public._store_audit(uuid,text,jsonb,jsonb,text)',
    'public._store_reason(text)'] loop
    if to_regprocedure(f) is null then
      raise exception '137 يتطلب %', f;
    end if;
  end loop;
  if to_regclass('public.companies') is null or to_regclass('public.subscription_plans') is null
     or to_regclass('public.whatsapp_subscriptions') is null
     or to_regclass('public.subscription_audit_log') is null
     or to_regclass('public.privileged_audit') is null then
    raise exception '137 يتطلب جداول 016 و 018 و 065 و 118';
  end if;
  if not exists (select 1 from public.subscription_plans where key in ('support', 'ultimate', 'store')) then
    raise exception '137 يتطلب صفوف الباقات support و ultimate و store في subscription_plans';
  end if;
end $$;


-- ============================================================================
-- 1) جدول طلبات التجربة — بلا أي عمود دفع أو بطاقة (انظر التعليق أعلاه)
-- ============================================================================
create table if not exists public.saas_trial_requests (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id) on delete cascade,
  plan_key        text not null,
  requested_by    uuid not null references public.profiles(id),
  status          text not null default 'pending',
  requested_at    timestamptz not null default now(),
  decided_at      timestamptz,
  decided_by      uuid references public.profiles(id),
  decision_reason text,
  trial_starts_at timestamptz,
  trial_ends_at   timestamptz,
  subscription_id uuid references public.whatsapp_subscriptions(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint saas_trial_requests_plan_check
    check (plan_key in ('support', 'ultimate', 'store')),
  constraint saas_trial_requests_status_check
    check (status in ('pending', 'approved', 'rejected', 'expired', 'cancelled')),
  -- المدة 3 أيام بالضبط، على مستوى القاعدة لا الواجهة وحدها.
  constraint saas_trial_requests_three_days_check
    check (trial_ends_at is null
           or (trial_starts_at is not null
               and trial_ends_at = trial_starts_at + interval '3 days')),
  constraint saas_trial_requests_window_check
    check (subscription_id is null or trial_starts_at is not null)
);
comment on table public.saas_trial_requests is
  '137: طلبات التجربة المجانية 3 أيام للباقات المدفوعة. بلا موافقة مالك لا تبدأ تجربة؛ بلا أي عمود دفع أو بطاقة؛ بلا بيئة تجريبية منفصلة — التجربة اشتراك عادي على الحساب الحي.';
comment on column public.saas_trial_requests.plan_key is
  '137: الباقة المطلوبة: support أو ultimate للشركات، store للمتاجر الإلكترونية فقط.';
comment on column public.saas_trial_requests.trial_ends_at is
  '137: نهاية التجربة = البداية + 3 أيام بالضبط (قيد saas_trial_requests_three_days_check).';

-- طلب معلّق واحد لكل (شركة، باقة) — يمنع إغراق المالك بطلبات مكررة.
create unique index if not exists saas_trial_requests_one_pending
  on public.saas_trial_requests (company_id, plan_key) where status = 'pending';
create index if not exists saas_trial_requests_company_idx
  on public.saas_trial_requests (company_id, requested_at desc);
create index if not exists saas_trial_requests_status_idx
  on public.saas_trial_requests (status, requested_at desc);

-- RLS على نمط login_locations (131): القراءة والإدراج لمالك الشركة وحده،
-- والتعديل عبر دوال RPC فقط (SECURITY DEFINER) — بلا سياسة UPDATE/DELETE.
alter table public.saas_trial_requests enable row level security;
drop policy if exists saas_trial_requests_select_own on public.saas_trial_requests;
create policy saas_trial_requests_select_own on public.saas_trial_requests
  for select to authenticated
  using (exists (select 1 from public.companies c
                  where c.id = saas_trial_requests.company_id and c.user_id = auth.uid()));
drop policy if exists saas_trial_requests_insert_own on public.saas_trial_requests;
create policy saas_trial_requests_insert_own on public.saas_trial_requests
  for insert to authenticated
  with check (exists (select 1 from public.companies c
                       where c.id = saas_trial_requests.company_id and c.user_id = auth.uid()));


-- ============================================================================
-- 2) مسنَدات داخلية
-- ============================================================================
create or replace function public._trial_request_json(p_request uuid)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select jsonb_build_object(
    'id', r.id, 'company_id', r.company_id, 'company_name', c.company_name,
    'account_kind', c.account_kind, 'plan_key', r.plan_key,
    'plan_name_ar', coalesce(sp.name_ar, sp.name, r.plan_key),
    'status', r.status, 'requested_by', r.requested_by,
    'requested_by_email', (select email from public.profiles where id = r.requested_by),
    'requested_at', r.requested_at, 'decided_at', r.decided_at, 'decided_by', r.decided_by,
    'decision_reason', r.decision_reason,
    'trial_starts_at', r.trial_starts_at, 'trial_ends_at', r.trial_ends_at,
    'subscription_id', r.subscription_id,
    'is_trial_active', r.status = 'approved' and r.trial_ends_at is not null and r.trial_ends_at > now(),
    'days_remaining', case when r.status = 'approved' and r.trial_ends_at is not null and r.trial_ends_at > now()
                           then ceil(extract(epoch from (r.trial_ends_at - now())) / 86400)::int
                           else 0 end)
    from public.saas_trial_requests r
    join public.companies c on c.id = r.company_id
    left join public.subscription_plans sp on sp.key = r.plan_key
   where r.id = p_request;
$$;
comment on function public._trial_request_json(uuid) is
  '137: طلب تجربة واحد كـ JSON للواجهتين — بلا مصدر صلاحية.';

-- هل الباقة متاحة لنوع الحساب؟ store للمتاجر الإلكترونية فقط.
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


-- ============================================================================
-- 3) طلب تجربة — مالك الشركة وحده، والشركة من auth.uid() (بلا معامل
--    شركة، على نمط company-data.js: لا معامل في النداء يوجّه الطلب
--    لشركة أخرى حتى لو عُدّل من المتصفح).
--    ينشئ طلبًا معلّقًا فقط — لا اشتراك ولا امتياز ولا دفع هنا إطلاقًا.
-- ============================================================================
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


-- ============================================================================
-- 4) إلغاء طلب معلّق — مالك الشركة صاحب الطلب وحده
-- ============================================================================
create or replace function public.cancel_saas_trial(p_request uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_req public.saas_trial_requests%rowtype;
  v_co  public.companies%rowtype;
begin
  if auth.uid() is null then
    raise exception 'سجّل الدخول أولًا' using errcode = '42501';
  end if;
  select * into v_req from public.saas_trial_requests where id = p_request;
  if not found then
    raise exception 'الطلب غير موجود' using errcode = 'P0002';
  end if;
  select * into v_co from public.companies where id = v_req.company_id;
  if v_co.user_id <> auth.uid() then
    raise exception 'إلغاء الطلب لمالك الشركة صاحبة الطلب وحده' using errcode = '42501';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'الإلغاء من طلب معلّق فقط' using errcode = '22023';
  end if;
  update public.saas_trial_requests
     set status = 'cancelled', updated_at = now()
   where id = p_request;
  return public._trial_request_json(p_request);
end $$;
comment on function public.cancel_saas_trial(uuid) is
  '137: إلغاء طلب تجربة معلّق من مالك الشركة صاحبة الطلب.';


-- ============================================================================
-- 5) حالة التجربة لشركتي — قراءة مالك/عضو الشركة الحالية (بلا معامل)
--    الباقات المؤهلة تُحسب هنا لا في الواجهة: الجمهور، وتفعيل الباقة،
--    واشتراك مدفوع فعّال، وطلب معلّق، وتجربة سابقة أو جارية.
-- ============================================================================
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


-- ============================================================================
-- 6) قائمة طلبات التجربة للمالك — المعلّقة أولًا
-- ============================================================================
create or replace function public.owner_list_saas_trial_requests(p_status text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  perform public._owner_require();
  if p_status is not null and p_status not in ('pending', 'approved', 'rejected', 'expired', 'cancelled') then
    raise exception 'حالة طلب غير صالحة' using errcode = '22023';
  end if;
  return (select coalesce(jsonb_agg(public._trial_request_json(r.id)
                    order by (r.status = 'pending') desc, r.requested_at desc), '[]'::jsonb)
            from public.saas_trial_requests r
           where p_status is null or r.status = p_status);
end $$;
comment on function public.owner_list_saas_trial_requests(text) is
  '137: قائمة طلبات التجربة المجانية للمالك — المعلّقة أولًا، مع الشركة والباقة والطالب.';


-- ============================================================================
-- 7) قرار المالك: موافقة تبدأ الـ 3 أيام فورًا، رفض يغلق الطلب
--    الموافقة تنشئ اشتراك تجربة على الحساب الحي نفسه (بلا بيئة تجريبية):
--    plan = الباقة، status = active، start = الآن، end = الآن + 3 أيام
--    بالضبط، duration_days = 3، payment_method = NULL و billing_cycle =
--    NULL (بلا دفع وبلا دورة فوترة)، و price_snapshot.trial = true مع
--    no_auto_renew و no_payment_method. بلا أي إنشاء لاشتراك مدفوع.
-- ============================================================================
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


-- ============================================================================
-- 8) انتهاء التجارب — للوظيفة المجدولة فقط (دور service_role)، وليست
--    زرًا في الواجهة. تقلب صفوف الاشتراكات أولًا عبر
--    expire_stale_subscriptions() القائمة (فتصل إشعار «انتهى اشتراكك»
--    لصاحبها)، ثم تقلب الطلبات الموافَق عليها المنتهية إلى 'expired'.
--    الامتياز نفسه يتوقف عند end_date حتى لو تأخر هذا النداء، لأن
--    owned_feature_keys() تشترط end_date > now().
-- ============================================================================
create or replace function public.expire_saas_trials()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_n int;
begin
  perform public.expire_stale_subscriptions();
  update public.saas_trial_requests
     set status = 'expired', updated_at = now()
   where status = 'approved' and trial_ends_at is not null and trial_ends_at <= now();
  get diagnostics v_n = row_count;
  return jsonb_build_object('expired_requests', v_n);
end $$;
comment on function public.expire_saas_trials() is
  '137: قلب طلبات التجربة المنتهية إلى expired (بعد قلب الاشتراكات عبر expire_stale_subscriptions). للوظيفة المجدولة بدور service_role فقط — بلا تجديد وبلا خصم.';


-- ============================================================================
-- 9) الصلاحيات — على نمط 133/135: authenticated وحده للواجهتين،
--    و expire_saas_trials لـ service_role وحده (وظيفة مجدولة)
-- ============================================================================
do $$
declare
  f text;
  v_rpc text[] := array[
    'public.request_saas_trial(text)',
    'public.cancel_saas_trial(uuid)',
    'public.my_saas_trial_status()',
    'public.owner_list_saas_trial_requests(text)',
    'public.owner_decide_saas_trial(uuid,text,text)'];
begin
  foreach f in array v_rpc loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke all on function %s from service_role', f);
    end if;
  end loop;
  foreach f in array v_rpc loop
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  execute 'revoke all on function public.expire_saas_trials() from public, anon, authenticated';
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'revoke all on function public.expire_saas_trials() from service_role';
    execute 'grant execute on function public.expire_saas_trials() to service_role';
  end if;
end $$;


-- ============================================================================
-- 10) تحقق ذاتي — على نمط 130/133/135
-- ============================================================================
do $$
declare
  v_def text;
  f text;
  v_rpc text[] := array[
    'public.request_saas_trial(text)',
    'public.cancel_saas_trial(uuid)',
    'public.my_saas_trial_status()',
    'public.owner_list_saas_trial_requests(text)',
    'public.owner_decide_saas_trial(uuid,text,text)'];
begin
  -- المدة 3 أيام بالضبط في القرار وفي قيد الجدول، وبلا تجديد وبلا دفع.
  v_def := pg_get_functiondef('public.owner_decide_saas_trial(uuid,text,text)'::regprocedure);
  if v_def not like '%owner_critical_ok%' then
    raise exception '137: owner_critical_ok() غائب من owner_decide_saas_trial()';
  end if;
  if v_def not like '%interval ''3 days''%' then
    raise exception '137: مدة 3 أيام غائبة من owner_decide_saas_trial()';
  end if;
  if v_def not like '%no_auto_renew%' or v_def not like '%no_payment_method%' then
    raise exception '137: علامتا بلا تجديد وبلا دفع غائبتان من owner_decide_saas_trial()';
  end if;
  if v_def not like '%_trial_request_json%' then
    raise exception '137: owner_decide_saas_trial() لا يعيد JSON الطلب';
  end if;
  -- الطلب: مالك الشركة من auth.uid()، وبلا أي إنشاء اشتراك فيه.
  v_def := pg_get_functiondef('public.request_saas_trial(text)'::regprocedure);
  if v_def not like '%current_company_id%' or v_def not like '%user_id <> auth.uid()%' then
    raise exception '137: request_saas_trial() بلا شركة الحالية أو بلا مالك الشركة';
  end if;
  if v_def like '%insert into public.whatsapp_subscriptions%' then
    raise exception '137: request_saas_trial() ينشئ اشتراكًا — الطلب وحده مسموح';
  end if;
  -- لا بيئة تجريبية في أي دالة، ولا عمود دفع/بطاقة في جدول الطلبات.
  foreach f in array v_rpc || array['public.expire_saas_trials()'] loop
    v_def := pg_get_functiondef(f::regprocedure);
    if position('sandbox' in lower(v_def)) > 0 then
      raise exception '137: لفظ sandbox في % — ممنوع أي مسار تجريبي منفصل', f;
    end if;
  end loop;
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'saas_trial_requests'
                and (column_name like '%card%' or column_name like '%payment%'
                     or column_name like '%sandbox%')) then
    raise exception '137: عمود دفع/بطاقة في saas_trial_requests — ممنوع';
  end if;
  -- قيد 3 أيام على مستوى الجدول، وفهرس الطلب المعلق الواحد، و RLS.
  if not exists (select 1 from pg_constraint where conname = 'saas_trial_requests_three_days_check') then
    raise exception '137: قيد 3 أيام غائب من saas_trial_requests';
  end if;
  if not exists (select 1 from pg_indexes where indexname = 'saas_trial_requests_one_pending') then
    raise exception '137: فهرس الطلب المعلق الواحد غائب';
  end if;
  if not (select relrowsecurity from pg_class where relname = 'saas_trial_requests') then
    raise exception '137: RLS غير مفعّلة على saas_trial_requests';
  end if;
  -- الانتهاء يمر عبر الوظيفة القائمة للاشتراكات.
  v_def := pg_get_functiondef('public.expire_saas_trials()'::regprocedure);
  if v_def not like '%expire_stale_subscriptions%' then
    raise exception '137: expire_saas_trials() لا يمر عبر expire_stale_subscriptions()';
  end if;
  -- الصلاحيات كما أُعلنت.
  foreach f in array v_rpc loop
    if has_function_privilege('anon', f::regprocedure, 'EXECUTE') then
      raise exception '137: دالة مكشوفة لـ anon: %', f;
    end if;
    if not has_function_privilege('authenticated', f::regprocedure, 'EXECUTE') then
      raise exception '137: دالة غير ممنوحة لـ authenticated: %', f;
    end if;
  end loop;
  if has_function_privilege('authenticated', 'public.expire_saas_trials()'::regprocedure, 'EXECUTE') then
    raise exception '137: expire_saas_trials() مكشوفة لـ authenticated — للوظيفة المجدولة فقط';
  end if;
  if has_function_privilege('anon', 'public.expire_saas_trials()'::regprocedure, 'EXECUTE') then
    raise exception '137: expire_saas_trials() مكشوفة لـ anon';
  end if;
  raise notice '137: التجربة المجانية 3 أيام جاهزة — طلب ثم موافقة مالك ثم 3 أيام على الحساب الحي، بلا دفع وبلا تجديد وبلا بيئة تجريبية';
end $$;
