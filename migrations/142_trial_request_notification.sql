-- ============================================================================
-- 142_trial_request_notification.sql
--   إشعار مالك المنصة عند إرسال طلب تجربة مجانية 3 أيام (137).
--
--   الفحص: لا إشعار أصلًا عند إرسال الطلب — request_saas_trial (137)
--   يُدرج في saas_trial_requests وحده، ولا صفحة owner/trials.html ولا
--   جرس المالك يقرآن شيئًا عن الطلب الجديد؛ المالك لا يعرف بالطلب إلا
--   بفتح صفحة التجارب بنفسه. هذا الترحيل يسدّ الفجوة بلا قناة جديدة.
--
--   القناة القائمة نفسها، بلا اختراع:
--   • جدول public.notifications (نفس جدول جرس المالك) — يقرأه
--     notifications-service.js بفلتر user_id = المالك الحالي، ويعرضه
--     جرس لوحة المالك وقسم الإشعارات فيها (owner-notifications.js).
--   • نمط الإدراج للمالك من _account_request_notify_owners (105): صف
--     واحد لكل مالك منصة (platform_authority.level = 'owner' مع
--     profiles.role = 'platform_owner').
--   • الرابط /owner/trials.html — صفحة الموافقة القائمة نفسها (الطلبات
--     المعلّقة أولًا)، فيفتح الإشعار من الجرس على الطلب مباشرةً.
--   • التصنيف 'subscription' من تصنيف 011؛ و trigger 015 يشتق منه
--     action = 'open_section' تلقائيًا كأي إشعار اشتراك.
--
--   النطاق عمدًا: الإشعار عند الإرسال وحده. الإلغاء من صاحب الطلب لا
--   يُشعر المالك (الطلب يختفي من قائمة المعلّقة)، وقرار المالك (موافقة/
--   رفض) لا يُشعر صاحب الشركة هنا — تلك ميزة مستقلة إن طُلبت.
--
--   يعتمد على 011/015 (notifications + triggers) و 105 (نمط إشعار
--   المالك) و 137 (saas_trial_requests + request_saas_trial).
--   قابل لإعادة التشغيل. بلا أي تحديث بيانات وبلا تفعيل باقة.
--   التراجع: migrations/_rollback/142_trial_request_notification.down.sql
--   (يحذف دالة الإشعار ويعيد request_saas_trial إلى نسخة 137 حرفيًا).
-- ============================================================================


-- ============================================================================
-- 0) المتطلبات
-- ============================================================================
do $$
begin
  if to_regclass('public.notifications') is null
     or to_regclass('public.saas_trial_requests') is null
     or to_regclass('public.companies') is null
     or to_regclass('public.subscription_plans') is null
     or to_regclass('public.platform_authority') is null
     or to_regclass('public.profiles') is null then
    raise exception '142 يتطلب جداول notifications و saas_trial_requests و companies و subscription_plans و platform_authority و profiles';
  end if;
  if to_regprocedure('public.request_saas_trial(text)') is null then
    raise exception '142 يتطلب public.request_saas_trial(text) من 137';
  end if;
  if to_regprocedure('public._trial_request_json(uuid)') is null then
    raise exception '142 يتطلب public._trial_request_json(uuid) من 137';
  end if;
end $$;


-- ============================================================================
-- 1) دالة الإشعار الداخلية — على نمط _account_request_notify_owners (105)
--    صف واحد لكل مالك منصة، بالشركة والباقة العربية وتاريخ الطلب، ورابط
--    صفحة الموافقة، و reference_id = معرّف الطلب. تعيد عدد من أُشعروا
--    (صفر إن لم يوجد مالك منصة مسجَّل — بلا خطأ).
-- ============================================================================
create or replace function public._trial_request_notify_owners(p_request uuid)
returns integer
language sql
security definer
set search_path to 'public'
as $$
  with n as (
    insert into public.notifications (user_id, title, message, type, link, category, reference_id)
    select a.user_id,
           'طلب تجربة مجانية جديد',
           format('طلبت شركة «%s» تجربة مجانية لباقة «%s» في %s. بانتظار قرارك في «طلبات التجربة».',
                  c.company_name,
                  coalesce(sp.name_ar, sp.name, r.plan_key),
                  to_char(r.requested_at at time zone 'Africa/Cairo', 'YYYY-MM-DD HH24:MI')),
           'info',
           '/owner/trials.html',
           'subscription',
           r.id
      from public.saas_trial_requests r
      join public.companies c on c.id = r.company_id
      left join public.subscription_plans sp on sp.key = r.plan_key
      join public.platform_authority a on a.level = 'owner'
      join public.profiles p on p.id = a.user_id and p.role = 'platform_owner'
     where r.id = p_request
    returning 1
  )
  select count(*)::int from n;
$$;
comment on function public._trial_request_notify_owners(uuid) is
  '142: إشعار مالك المنصة بطلب تجربة جديد — صف في notifications لكل مالك منصة، بالشركة والباقة وتاريخ الطلب ورابط owner/trials.html. داخلية: تُنادى من request_saas_trial فقط.';


-- ============================================================================
-- 2) request_saas_trial — نسخة 137 حرفيًا + سطر إشعار واحد بعد الإدراج
--    (داخل المعاملة نفسها: طلب بلا إشعار أو لا شيء). لا تعديل على 137
--    نفسه: الترحيل 137 مطبَّق حيًا ولا يُمسّ.
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
  -- 142: إشعار مالك المنصة بالطلب الجديد — على قناة notifications القائمة
  -- (جرس لوحة المالك)، في المعاملة نفسها فلا طلب بلا إشعار.
  perform public._trial_request_notify_owners(v_request_id);
  return public._trial_request_json(v_request_id);
end $$;
comment on function public.request_saas_trial(text) is
  '137 + 142: طلب تجربة مجانية 3 أيام من مالك الشركة — ينشئ طلبًا معلّقًا فقط، بلا اشتراك وبلا امتياز وبلا دفع، ويُشعر مالك المنصة بالطلب (notifications إلى owner/trials.html). التجربة تبدأ فقط بموافقة المالك (owner_decide_saas_trial).';


-- ============================================================================
-- 3) الصلاحيات — على نمط 137 §9: الطلب لـ authenticated وحده؛ دالة
--    الإشعار داخلية (بلا منح لأي دور — تُنادى من داخل request_saas_trial
--    بدور المالك عبر SECURITY DEFINER، فلا يستطيع أي مستخدم استدعاؤها
--    مباشرةً لإغراق المالك بإشعارات).
-- ============================================================================
do $$
begin
  execute 'revoke all on function public.request_saas_trial(text) from public, anon, authenticated';
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'revoke all on function public.request_saas_trial(text) from service_role';
  end if;
  execute 'grant execute on function public.request_saas_trial(text) to authenticated';
  execute 'revoke all on function public._trial_request_notify_owners(uuid) from public, anon, authenticated';
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'revoke all on function public._trial_request_notify_owners(uuid) from service_role';
  end if;
end $$;


-- ============================================================================
-- 4) تحقق ذاتي — على نمط 137 §10
-- ============================================================================
do $$
declare
  v_def text;
begin
  -- دالة الإشعار موجودة، والطلب يناديها بعد الإدراج مباشرةً.
  if to_regprocedure('public._trial_request_notify_owners(uuid)') is null then
    raise exception '142: _trial_request_notify_owners() غائبة';
  end if;
  v_def := pg_get_functiondef('public.request_saas_trial(text)'::regprocedure);
  if v_def not like '%_trial_request_notify_owners%' then
    raise exception '142: request_saas_trial() لا ينادي دالة الإشعار';
  end if;
  -- ضمانات 137 باقية في النسخة المستبدَلة: بوابات الطلب، وبلا اشتراك.
  if v_def not like '%current_company_id%' or v_def not like '%user_id <> auth.uid()%' then
    raise exception '142: request_saas_trial() فقدت بوابة شركة الحالية أو مالك الشركة';
  end if;
  if v_def like '%insert into public.whatsapp_subscriptions%' then
    raise exception '142: request_saas_trial() ينشئ اشتراكًا — الطلب وحده مسموح';
  end if;
  -- الإشعار على القناة القائمة: notifications لمالك المنصة، بالرابط
  -- والتصنيف ومرجع الطلب — بلا جدول أو قناة جديدة.
  v_def := pg_get_functiondef('public._trial_request_notify_owners(uuid)'::regprocedure);
  if v_def not like '%insert into public.notifications%' then
    raise exception '142: دالة الإشعار لا تُدرج في public.notifications';
  end if;
  if v_def not like '%platform_authority%' or v_def not like '%''owner''%'
     or v_def not like '%platform_owner%' then
    raise exception '142: دالة الإشعار لا تستهدف مالك المنصة (platform_authority owner)';
  end if;
  if v_def not like '%/owner/trials.html%' then
    raise exception '142: رابط صفحة الموافقة غائب من دالة الإشعار';
  end if;
  if v_def not like '%''subscription''%' then
    raise exception '142: تصنيف subscription غائب من دالة الإشعار';
  end if;
  if v_def not like '%reference_id%' then
    raise exception '142: مرجع الطلب (reference_id) غائب من دالة الإشعار';
  end if;
  if v_def not like '%company_name%' or v_def not like '%name_ar%' then
    raise exception '142: اسم الشركة أو اسم الباقة غائب من نص الإشعار';
  end if;
  -- الصلاحيات كما أُعلنت.
  if has_function_privilege('anon', 'public.request_saas_trial(text)'::regprocedure, 'EXECUTE') then
    raise exception '142: request_saas_trial() مكشوفة لـ anon';
  end if;
  if not has_function_privilege('authenticated', 'public.request_saas_trial(text)'::regprocedure, 'EXECUTE') then
    raise exception '142: request_saas_trial() غير ممنوحة لـ authenticated';
  end if;
  if has_function_privilege('authenticated', 'public._trial_request_notify_owners(uuid)'::regprocedure, 'EXECUTE') then
    raise exception '142: _trial_request_notify_owners() مكشوفة لـ authenticated — داخلية فقط';
  end if;
  if has_function_privilege('anon', 'public._trial_request_notify_owners(uuid)'::regprocedure, 'EXECUTE') then
    raise exception '142: _trial_request_notify_owners() مكشوفة لـ anon — داخلية فقط';
  end if;
  raise notice '142: إشعار طلب التجربة جاهز — الطلب يُشعر مالك المنصة في جرس لوحته برابط owner/trials.html';
end $$;
