-- ============================================================================
-- 095_account_boundaries.sql
--   A1 — حدود الحسابات: عميل الشركة ليس موظفًا فيها، وأسرار الحساب لأصحابها.
--
-- القرار D8 (المالك 2026-10-13): عميل الشركة يستعمل بوابة عملاء منفصلة، ولوحة الشركة
--   لمالكها ومديريها وموظفيها فقط. والقرار P6/السؤال 11: حدود صلبة لا يتجاوزها حتى
--   مالك الشركة (رموز API الشخصية وسجلات استخدامها، التكاملات الشخصية وأسرارها،
--   بيانات الجهاز وIP، نقاط المكافآت).
--
-- ما كان قائمًا (قراءة الإنتاج 2026-10-13، وكل نص أدناه مطابق له قبل التعديل):
--   • get_my_company_dashboard() تعيد لأي تابع للشركة — أي لعملائها — السجل التجاري
--     والرقم الضريبي وكل الاشتراكات والامتيازات.
--   • سياسة "Company members can view their company" تعطي التابع صف companies كاملًا.
--   • link_subscription_to_my_company() ومحفّز enforce_subscription_company_owner
--     يسمحان لعميل الشركة بربط اشتراكه بالشركة، فيمنحها امتيازاته ويكشف فوترته.
--   • is_owner_or_super_of() = «أنا أو تابعي»: مالك الشركة يقرأ ويوقف ويحذف رموز API
--     الخاصة بعملائه، ويقرأ سجلات استخدامها (IP وuser agent)، ويقرأ ويعدّل
--     ويحذف تكاملاتهم الشخصية بما فيها credentials_encrypted، ودالة
--     manage-external-integration تنشئ تكاملًا باسم التابع.
--   • activity_logs_select_policy (فرع supervises) تكشف IP والجهاز والموقع للمالك.
--   • profiles_update_policy (فرع supervises) تسمح للمالك بتعديل ملف عميله، و
--     guard_profile_points_change لا يمنع غير صاحب الحساب — فيعدّل نقاط مكافآته.
--   • context_destination('company_user_preview') = لوحة الشركة، ومنظور العضو صار
--     بعد D8 هو بوابة العملاء.
--
-- ما يفعله
--   1) my_account_kind(): مصدر واحد لنوع الحساب على الخادم (التوجيه والبوابات).
--   2) my_company_portal(): ما يراه عميل الشركة عن شركته — الاسم فقط.
--   3) get_my_company_dashboard(): للفريق فقط (company_staff_role() غير فارغ)، وتفاصيل
--      السجل والضريبة والاشتراكات لمدير الشركة وحده. العميل يأخذ null.
--   4) سياسة قراءة companies: للفريق فقط (نفس اسم السياسة، شرط جديد).
--   5) ربط اشتراك بالشركة: لمدير الشركة وحده (الدالة والمحفّز).
--   6) is_owner_or_super_of(x) = auth.uid() = x (نفس الاسم والتوقيع) — يغلق دفعة واحدة
--      فروع api_tokens وapi_token_usage_logs وexternal_integrations(+models) وفحص
--      manage-external-integration. الاسم يبقى لأن 9 سياسات ودالة طرفية تناديه.
--   7) external_integrations(+models): التكامل الشخصي لصاحبه وحده؛ الإداري يدير
--      تكاملات المنصة فقط (owner_scope = 'platform').
--   8) activity_logs: بلا فرع supervises.
--   9) profiles_update_policy: بلا فرع supervises؛ guard_profile_points_change يرفض
--      أي تعديل لنقاط غيرك ما لم تكن إداريًا.
--  10) context_destination('company_user_preview') = '/portal/'.
--
-- ما لا يفعله
--   • لا يغيّر current_company_id() ولا company_members() ولا 086 ولا أي سياسة تذاكر.
--   • لا يغيّر profiles_select_policy: قائمة تذاكر العملاء في لوحة الشركة تضمّ ملف
--     العميل عبره. استبداله بدليل محدود الحقول في المرحلة M (العضويات).
--   • لا يمس الطاقم ولا الإداريين: فروع is_admin()/has_elevated_authority() كما هي،
--     عدا التكاملات الشخصية (البند 7).
--   • لا مفاتيح تفعيل: كل ما هنا تشديد.
--
-- البيانات على الإنتاج وقت الكتابة: 0 تابعين، 0 تكاملات غير منصّية — لا أثر على صف قائم.
--
-- قابل لإعادة التشغيل. التراجع: migrations/_rollback/095_account_boundaries.down.sql
-- ============================================================================


-- ============================================================================
-- 0) المتطلبات
-- ============================================================================
do $$
declare f text;
begin
  foreach f in array array[
    'public.current_company_id()', 'public.company_of(uuid)', 'public.owns_a_company(uuid)',
    'public.belongs_to_a_company(uuid)', 'public.company_staff_role()',
    'public._company_staff_role_of(uuid,uuid)', 'public.is_platform_owner()', 'public.is_admin()',
    'public.has_elevated_authority()', 'public.preview_mode()', 'public.active_context()',
    'public.get_my_company_dashboard()', 'public.link_subscription_to_my_company(uuid)',
    'public.enforce_subscription_company_owner()', 'public.is_owner_or_super_of(uuid)',
    'public.guard_profile_points_change()', 'public.context_destination(text)'] loop
    if to_regprocedure(f) is null then
      raise exception '095 يتطلب %', f;
    end if;
  end loop;
  if to_regclass('public.company_staff') is null then
    raise exception '095 يتطلب 086_company_staff';
  end if;
end $$;


-- ============================================================================
-- 1) نوع الحساب — مصدر واحد للتوجيه والبوابات
-- ============================================================================
--   anonymous        بلا جلسة
--   platform_owner   مالك المنصة (أيًّا كان سياقه؛ السياق يقرر صلاحياته لا نوعه)
--   platform_staff   admin | support
--   company_admin    يملك شركة
--   company_employee تابع بصف نشط في company_staff (مشرف/موظف دعم)
--   company_customer تابع بلا صف نشط — عميل الشركة (D2)
--   independent      حساب فرد لا شركة له
--
-- العلاقات تُقرأ مباشرة لا عبر company_staff_role(): النوع لا يتبدّل بالمعاينة ولا
-- بتعطيل الحساب (بوابة الحساب 042 تتولّى المعطّل قبل أي لوحة).
create or replace function public.my_account_kind()
returns text
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_uid  uuid := auth.uid();
  v_role text;
  v_company uuid;
begin
  if v_uid is null then
    return 'anonymous';
  end if;
  if coalesce(public.is_platform_owner(), false) then
    return 'platform_owner';
  end if;
  select p.role into v_role from public.profiles p where p.id = v_uid;
  if v_role in ('admin', 'support') then
    return 'platform_staff';
  end if;
  if public.owns_a_company(v_uid) then
    return 'company_admin';
  end if;
  v_company := public.company_of(v_uid);
  if v_company is not null then
    if public._company_staff_role_of(v_company, v_uid) in ('supervisor', 'agent') then
      return 'company_employee';
    end if;
    return 'company_customer';
  end if;
  return 'independent';
end $$;

comment on function public.my_account_kind() is
  '095: نوع حساب المنادي (anonymous | platform_owner | platform_staff | company_admin | '
  'company_employee | company_customer | independent). للتوجيه والعرض؛ الصلاحية الفعلية '
  'في كل دالة وسياسة.';

revoke all on function public.my_account_kind() from public, anon;
grant execute on function public.my_account_kind() to authenticated, service_role;


-- ============================================================================
-- 2) ما يراه عميل الشركة عن شركته
-- ============================================================================
-- عميل الشركة (تابع بلا دور موظف)، أو مالك المنصة في منظور العضو (معاينة للقراءة).
-- الاسم فقط: لا سجل تجاري ولا ضريبة ولا اشتراكات ولا فريق.
create or replace function public.my_company_portal()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_uid     uuid := auth.uid();
  v_kind    text;
  v_preview boolean;
  v_company public.companies%rowtype;
begin
  if v_uid is null then
    return null;
  end if;
  v_kind := public.my_account_kind();
  v_preview := coalesce(public.preview_mode(), false);
  if not (v_kind = 'company_customer' or (v_kind = 'platform_owner' and v_preview)) then
    return null;
  end if;
  select * into v_company from public.companies c where c.id = public.company_of(v_uid);
  if v_company.id is null then
    return null;
  end if;
  return jsonb_build_object(
    'company', jsonb_build_object('id', v_company.id, 'name', v_company.company_name),
    'preview', v_preview);
end $$;

comment on function public.my_company_portal() is
  '095: بيانات بوابة عميل الشركة — اسم الشركة فقط. null لغير عميل الشركة (ولمعاينة المالك يعيدها).';

revoke all on function public.my_company_portal() from public, anon;
grant execute on function public.my_company_portal() to authenticated, service_role;


-- ============================================================================
-- 3) لوحة الشركة للفريق فقط
-- ============================================================================
-- نفس النص السابق حرفيًا مع بوابة في أوله، وحمولة مختصرة لغير المدير:
--   المدير (admin)          كما كان + viewer_role.
--   مشرف/موظف دعم          اسم الشركة والامتيازات (للعرض) — بلا سجل تجاري ولا ضريبة
--                           ولا تواصل ولا اشتراكات ولا خطط.
--   عميل/معاينة/غير مفعّل   null (كأن لا شركة).
create or replace function public.get_my_company_dashboard()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_company_id uuid; v_company public.companies%rowtype;
  v_active_plans text[]; v_subs jsonb; v_features jsonb;
  v_viewer text;
begin
  if auth.uid() is null then return null; end if;
  -- 095: الفريق فقط. company_staff_role() = admin | supervisor | agent | null.
  v_viewer := public.company_staff_role();
  if v_viewer is null then return null; end if;
  v_company_id := public.current_company_id();
  if v_company_id is null then return null; end if;
  select * into v_company from public.companies where id = v_company_id;

  select coalesce(array_agg(distinct s.plan), '{}'::text[]) into v_active_plans
    from public.whatsapp_subscriptions s
   where (s.company_id = v_company_id or s.user_id = v_company.user_id)
     and s.status = 'active' and s.start_date <= now() and s.end_date > now();

  select coalesce(jsonb_agg(jsonb_build_object(
      'feature_key', f.feature_key,
      'name_ar', coalesce(ff.name_ar, ff.name, f.feature_key),
      'description', coalesce(ff.description, ''),
      'limits', f.limits, 'granted_by', f.plan_keys
    ) order by f.feature_key), '[]'::jsonb) into v_features
    from (
      select pf.feature_key, jsonb_agg(distinct sp.key) as plan_keys, (array_agg(pf.limits))[1] as limits
        from public.subscription_plans sp
        join public.plan_features pf on pf.plan_id = sp.id and pf.enabled = true
       where sp.key = any(v_active_plans) group by pf.feature_key
    ) f
    left join public.feature_flags ff on ff.key = f.feature_key;

  if v_viewer <> 'admin' then
    return jsonb_build_object(
      'viewer_role', v_viewer,
      'company', jsonb_build_object('id', v_company.id, 'name', v_company.company_name, 'is_owner', false),
      'registration', null,
      'subscriptions', '[]'::jsonb,
      'entitlements', (select coalesce(jsonb_agg(e - 'granted_by' - 'limits'), '[]'::jsonb)
                         from jsonb_array_elements(v_features) e),
      'access', jsonb_build_object('active_plans', '[]'::jsonb,
        'has_active_subscription', (array_length(v_active_plans, 1) is not null)));
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', s.id, 'plan', s.plan,
      'plan_name_ar', coalesce(sp.name_ar, sp.name, s.plan),
      'status', s.status, 'billing_cycle', s.billing_cycle,
      'start_date', s.start_date, 'end_date', s.end_date,
      'is_active', (s.status = 'active' and s.start_date <= now() and s.end_date > now()),
      'days_remaining', greatest(0, ceil(extract(epoch from (s.end_date - now())) / 86400))::int
    ) order by s.end_date desc), '[]'::jsonb) into v_subs
    from public.whatsapp_subscriptions s
    left join public.subscription_plans sp on sp.key = s.plan
   where (s.company_id = v_company_id or s.user_id = v_company.user_id);

  return jsonb_build_object(
    'viewer_role', v_viewer,
    'company', jsonb_build_object(
      'id', v_company.id, 'name', v_company.company_name,
      'cr_number', v_company.commercial_registration_number,
      'cr_expiry', v_company.commercial_registration_expiry,
      'email', v_company.company_email, 'phone', v_company.company_phone,
      'address', v_company.address, 'city', v_company.city, 'country', v_company.country,
      'website', v_company.website, 'industry', v_company.industry, 'tax_id', v_company.tax_id,
      'created_at', v_company.created_at, 'is_owner', (v_company.user_id = auth.uid())),
    'registration', jsonb_build_object(
      'expiry_date', v_company.commercial_registration_expiry,
      'is_expired', (v_company.commercial_registration_expiry is not null
                      and v_company.commercial_registration_expiry < current_date),
      'days_to_expiry', case when v_company.commercial_registration_expiry is null then null
                             else (v_company.commercial_registration_expiry - current_date) end),
    'subscriptions', v_subs, 'entitlements', v_features,
    'access', jsonb_build_object('active_plans', to_jsonb(v_active_plans),
      'has_active_subscription', (array_length(v_active_plans, 1) is not null)));
end;
$$;


-- ============================================================================
-- 4) صف الشركة للفريق فقط
-- ============================================================================
-- نفس اسم السياسة (لا إعادة تسمية). مالك الشركة يقرأ صفه بسياسة
-- "Users can view their own company" كما كان.
alter policy "Company members can view their company" on public.companies
  using (id = public.current_company_id() and public.company_staff_role() is not null);


-- ============================================================================
-- 5) ربط اشتراك بالشركة: لمدير الشركة وحده
-- ============================================================================
create or replace function public.link_subscription_to_my_company(p_subscription_id uuid)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company_id uuid;
  v_updated    int;
begin
  if auth.uid() is null then
    return false;
  end if;

  -- 095: الاشتراك الشخصي لعميل الشركة أو لموظفها لا يصير اشتراكًا للشركة.
  if public.company_staff_role() is distinct from 'admin' then
    return false;
  end if;

  v_company_id := public.current_company_id();
  if v_company_id is null then
    return false;
  end if;

  update public.whatsapp_subscriptions
     set company_id = v_company_id,
         updated_at = now()
   where id = p_subscription_id
     and user_id = auth.uid()
     and company_id is null;

  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

-- المحفّز يحرس كل مسار يكتب company_id (الشراء، الترقية، أي RPC قادم)، لا الدالة وحدها.
create or replace function public.enforce_subscription_company_owner()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if new.company_id is null then
    return new;
  end if;

  if auth.uid() is null or public.is_admin() then
    return new;
  end if;

  if new.company_id is distinct from public.current_company_id() then
    raise exception 'لا يمكن ربط الاشتراك بشركة لا تخص حسابك';
  end if;

  -- 095: عميل الشركة وموظفها لا يربطان اشتراكًا بها — مدير الشركة وحده.
  if public.company_staff_role() is distinct from 'admin' then
    raise exception 'ربط الاشتراك بالشركة لمدير الشركة وحده' using errcode = '42501';
  end if;

  return new;
end;
$$;


-- ============================================================================
-- 6) is_owner_or_super_of: صاحب الصف وحده
-- ============================================================================
-- الاسم والتوقيع كما هما (9 سياسات + manage-external-integration تناديه). المعنى
-- السابق «أنا أو تابعي» كان يمنح مالك الشركة رموز عملائه وتكاملاتهم وسجلات استخدامهم.
create or replace function public.is_owner_or_super_of(target_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  -- 095: الحسابات وأسرارها لأصحابها. لا فرع supervises.
  select target_id is not null and auth.uid() = target_id;
$$;

comment on function public.is_owner_or_super_of(uuid) is
  '095: صاحب الصف وحده (auth.uid() = target). الاسم تاريخي؛ فرع «المالك المشرف» أُزيل.';


-- ============================================================================
-- 7) التكاملات الشخصية لصاحبها؛ الإداري يدير تكاملات المنصة
-- ============================================================================
alter policy "View own/managed/platform integrations" on public.external_integrations
  using ((owner_scope = 'platform') or (owner_id = auth.uid()));

alter policy "Insert own/managed integrations" on public.external_integrations
  with check (((owner_scope = 'platform') and public.is_admin())
              or ((owner_scope <> 'platform') and owner_id = auth.uid()));

alter policy "Update own/managed/platform integrations" on public.external_integrations
  using (((owner_scope = 'platform') and public.is_admin())
         or ((owner_scope <> 'platform') and owner_id = auth.uid()))
  with check (((owner_scope = 'platform') and public.is_admin())
              or ((owner_scope <> 'platform') and owner_id = auth.uid()));

alter policy "Delete own/managed/platform integrations" on public.external_integrations
  using (((owner_scope = 'platform') and public.is_admin())
         or ((owner_scope <> 'platform') and owner_id = auth.uid()));

alter policy "Manage models of writable integrations" on public.external_integration_models
  using (exists (select 1 from public.external_integrations ei
                  where ei.id = external_integration_models.integration_id
                    and (((ei.owner_scope = 'platform') and public.is_admin())
                         or ((ei.owner_scope <> 'platform') and ei.owner_id = auth.uid()))))
  with check (exists (select 1 from public.external_integrations ei
                       where ei.id = external_integration_models.integration_id
                         and (((ei.owner_scope = 'platform') and public.is_admin())
                              or ((ei.owner_scope <> 'platform') and ei.owner_id = auth.uid()))));


-- ============================================================================
-- 8) سجل النشاط: بيانات الجهاز وIP لصاحبها وأمن المنصة
-- ============================================================================
alter policy activity_logs_select_policy on public.activity_logs
  using ((user_id = auth.uid()) or public.has_elevated_authority()
         or ((select p.role from public.profiles p where p.id = auth.uid()) = 'admin'::text));


-- ============================================================================
-- 9) ملف العميل لا يعدّله مالك الشركة، ونقاط المكافآت للإدارة وحدها
-- ============================================================================
-- فك الارتباط بالشركة يبقى عبر remove_company_member() (SECURITY DEFINER).
alter policy profiles_update_policy on public.profiles
  using ((auth.uid() = id) or public.has_elevated_authority());

create or replace function public.guard_profile_points_change()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if new.points is not distinct from old.points then
    return new;
  end if;

  -- service_role أو مهمة خلفية
  if auth.uid() is null then
    return new;
  end if;

  -- السلطة تُسأل مباشرة، لا تُستنتج من علَم يضبطه المتصل
  if public.is_admin() then
    return new;
  end if;

  if auth.uid() = new.id then
    raise exception 'لا يمكنك تعديل نقاط حسابك بنفسك' using errcode = '42501';
  end if;

  -- 095: ولا نقاط غيرك (كان مالك الشركة يعدّل نقاط عملائه عبر profiles_update_policy).
  raise exception 'نقاط المكافآت تعدّلها الإدارة وحدها' using errcode = '42501';
end $$;


-- ============================================================================
-- 10) منظور العضو = بوابة عملاء الشركة
-- ============================================================================
create or replace function public.context_destination(p_context text)
returns text
language sql
immutable
as $$
  select case p_context
    when 'owner'                then '/owner-dashboard.html'
    when 'admin'                then '/admin-dashboard.html'
    when 'company_admin'        then '/company-dashboard/'
    when 'company_user_preview' then '/portal/'
    when 'customer'             then '/customer-dashboard.html'
    else null
  end;
$$;


-- ============================================================================
-- 11) تحقق ذاتي
-- ============================================================================
do $$
begin
  if public.is_owner_or_super_of(null) is not false then
    raise exception '095: is_owner_or_super_of(null) يجب أن يكون false';
  end if;
  if (select qual from pg_policies where tablename = 'companies'
        and policyname = 'Company members can view their company') not like '%company_staff_role()%' then
    raise exception '095: سياسة قراءة الشركة لم تتغير';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public'
               and tablename in ('activity_logs', 'profiles') and cmd in ('SELECT', 'UPDATE')
               and policyname in ('activity_logs_select_policy', 'profiles_update_policy')
               and qual like '%supervises%') then
    raise exception '095: فرع supervises ما زال في سياسة النشاط أو تعديل الملف';
  end if;
  if public.context_destination('company_user_preview') <> '/portal/' then
    raise exception '095: وجهة منظور العضو';
  end if;
end $$;
