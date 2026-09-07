-- ============================================================================
-- 021_reconcile_company_dashboard.sql
--   تصحيحات على ما طُبِّق فعلًا من الترحيل 016.
--
-- لماذا ترحيل مستقل ولا تعديل في 016؟
--   لأن 016 اندمج في main وطُبِّق على الإنتاج بالفعل (وأُنشئت به شركة حقيقية).
--   الترحيل المُطبَّق يصير غير قابل للتعديل: أي تصحيح يأتي في ترحيل تالٍ حتى
--   يظل تاريخ القاعدة مطابقًا لتاريخ الملفات.
--
-- ما الذي يصححه
--   1) الباقة الشاملة كانت تمنح mcp_client زيادةً على واتساب + الدعم الفني.
--      ده يكسر تعريف الباقة المعتمد (الشاملة = واتساب + دعم فني بالضبط)،
--      والأهم إنه يكسر قاعدة منع التداخل في 017: عميل يملك واتساب + دعم فني
--      كان هيقدر يشتري الشاملة لأنها "تضيف" mcp_client، وهو مش من خدماتها.
--
--   2) حارس تعيين profiles.super_user_id عند الإنشاء لم يصل للإنتاج (أُضيف
--      إلى 016 بعد اندماجه). عضوية الشركة تُشتق من العمود ده، فبقاؤه بلا حارس
--      إدخال يترك الاعتماد على ثلاث حمايات غير مقصودة بدل منع صريح.
--
--   3) company_has_feature و get_my_company_dashboard كانتا تحسبان الاشتراك
--      الفعّال بـ(status='active' AND end_date > now()) بدون start_date، فتجديد
--      مدفوع مسبقًا يمنح امتيازاته قبل موعده. الترحيل 019 أصلح
--      owned_feature_keys؛ وهنا نوحّد المسارين الآخرين على نفس التعريف حتى لا
--      يبقى في النظام تعريفان مختلفان لكلمة "فعّال".
--
-- ما الذي لم يُلمَس عمدًا
--   * companies.status: العمود مطبَّق على الإنتاج وغير مقروء من أي كود. حذفه
--     تغيير هدّام بلا ضرورة تشغيلية، فتُرك كما هو. لا يُشتق منه أي قرار وصول،
--     ولو احتاجت المنصة تعليقًا إداريًا مستقبلًا فمكانه ترحيل مستقل بحارس
--     يمنع المالك من تعديل حالته بنفسه.
--   * لا حذف ولا تعديل لأي اشتراك أو بيانات عميل.
-- ============================================================================

-- ── 1) الباقة الشاملة = واتساب + الدعم الفني بالضبط ─────────────────────────
delete from public.plan_features pf
 using public.subscription_plans sp
 where pf.plan_id = sp.id
   and sp.key = 'bundle'
   and pf.feature_key = 'mcp_client';


-- ── 2) حارس تعيين التبعية عند الإنشاء ───────────────────────────────────────
create or replace function public.guard_profile_super_user_id_insert()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  -- المسار الشائع: العمود فاضي، فمفيش تبعية تتحرّس أصلًا
  if new.super_user_id is null then
    return new;
  end if;

  -- بدون JWT مستخدم = service_role أو مهمة خلفية (مسار create-sub-user)
  if auth.uid() is null then
    return new;
  end if;

  -- نفس الاستثناء المستخدَم في حارس UPDATE القائم، حرفيًا
  if public.is_main_admin() then
    return new;
  end if;

  raise exception 'لا يمكن تعيين تبعية المستخدم عند الإنشاء'
    using errcode = '42501';
end;
$function$;

drop trigger if exists guard_profile_super_user_id_insert on public.profiles;
create trigger guard_profile_super_user_id_insert
  before insert on public.profiles
  for each row execute function public.guard_profile_super_user_id_insert();


-- ── 3) تعريف واحد لـ"الاشتراك الفعّال" في كل مسارات الامتيازات ──────────────
create or replace function public.company_has_feature(p_feature_key text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select exists (
    select 1
      from public.companies c
      join public.whatsapp_subscriptions s
        on (s.company_id = c.id or s.user_id = c.user_id)
      join public.subscription_plans sp on sp.key = s.plan
      join public.plan_features pf on pf.plan_id = sp.id and pf.enabled = true
     where c.id = public.current_company_id()
       and s.status = 'active'
       and s.start_date <= now()
       and s.end_date   >  now()
       and pf.feature_key = p_feature_key
  );
$function$;

-- get_my_company_dashboard: نفس التصحيح على حساب الباقات الفعّالة وحالة
-- الاشتراك. باقي الحمولة كما هي حرفيًا.
create or replace function public.get_my_company_dashboard()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_company_id   uuid;
  v_company      public.companies%rowtype;
  v_active_plans text[];
  v_subs         jsonb;
  v_features     jsonb;
begin
  if auth.uid() is null then
    return null;
  end if;

  v_company_id := public.current_company_id();
  if v_company_id is null then
    return null;
  end if;

  select * into v_company from public.companies where id = v_company_id;

  select coalesce(array_agg(distinct s.plan), '{}'::text[])
    into v_active_plans
    from public.whatsapp_subscriptions s
   where (s.company_id = v_company_id or s.user_id = v_company.user_id)
     and s.status = 'active'
     and s.start_date <= now()
     and s.end_date   >  now();

  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'id',             s.id,
               'plan',           s.plan,
               'plan_name_ar',   coalesce(sp.name_ar, sp.name, s.plan),
               'status',         s.status,
               'billing_cycle',  s.billing_cycle,
               'start_date',     s.start_date,
               'end_date',       s.end_date,
               'is_active',      (s.status = 'active' and s.start_date <= now() and s.end_date > now()),
               'days_remaining', greatest(0, ceil(extract(epoch from (s.end_date - now())) / 86400))::int
             ) order by s.end_date desc
           ),
           '[]'::jsonb
         )
    into v_subs
    from public.whatsapp_subscriptions s
    left join public.subscription_plans sp on sp.key = s.plan
   where (s.company_id = v_company_id or s.user_id = v_company.user_id);

  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'feature_key',  f.feature_key,
               'name_ar',      coalesce(ff.name_ar, ff.name, f.feature_key),
               'description',  coalesce(ff.description, ''),
               'limits',       f.limits,
               'granted_by',   f.plan_keys
             ) order by f.feature_key
           ),
           '[]'::jsonb
         )
    into v_features
    from (
      select pf.feature_key,
             jsonb_agg(distinct sp.key)   as plan_keys,
             (array_agg(pf.limits))[1]    as limits
        from public.subscription_plans sp
        join public.plan_features pf on pf.plan_id = sp.id and pf.enabled = true
       where sp.key = any(v_active_plans)
       group by pf.feature_key
    ) f
    left join public.feature_flags ff on ff.key = f.feature_key;

  return jsonb_build_object(
    'company', jsonb_build_object(
      'id',            v_company.id,
      'name',          v_company.company_name,
      'cr_number',     v_company.commercial_registration_number,
      'cr_expiry',     v_company.commercial_registration_expiry,
      'email',         v_company.company_email,
      'phone',         v_company.company_phone,
      'address',       v_company.address,
      'city',          v_company.city,
      'country',       v_company.country,
      'website',       v_company.website,
      'industry',      v_company.industry,
      'tax_id',        v_company.tax_id,
      'created_at',    v_company.created_at,
      'is_owner',      (v_company.user_id = auth.uid())
    ),
    'registration', jsonb_build_object(
      'expiry_date',    v_company.commercial_registration_expiry,
      'is_expired',     (v_company.commercial_registration_expiry is not null
                          and v_company.commercial_registration_expiry < current_date),
      'days_to_expiry', case
                          when v_company.commercial_registration_expiry is null then null
                          else (v_company.commercial_registration_expiry - current_date)
                        end
    ),
    'subscriptions', v_subs,
    'entitlements',  v_features,
    'access', jsonb_build_object(
      'active_plans',            to_jsonb(v_active_plans),
      'has_active_subscription', (array_length(v_active_plans, 1) is not null)
    )
  );
end;
$function$;

revoke all on function public.get_my_company_dashboard() from public, anon;
grant execute on function public.get_my_company_dashboard() to authenticated;
revoke all on function public.company_has_feature(text) from public, anon;
grant execute on function public.company_has_feature(text) to authenticated;
