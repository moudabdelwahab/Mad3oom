-- ============================================================================
-- 108_phase1_readiness_fixes.sql — ثلاثة إصلاحات وجدتها مراجعة جاهزية المرحلة 1 (docs/tenancy/PHASE1_READINESS_2026-10-20.md)
--
--   ① _access_grant_active (097، data_access_grants_enabled): المنحة كانت تبقى سارية لمن خُفِّض دوره من طاقم
--      المنصة، أو لنوع طاقم أوقف المالك حقه في الطلب، حتى نهايتها (حتى 168 ساعة). الطلب والموافقة يفحصان
--      الأهلية؛ القراءة لم تكن تفحصها. الآن كل قراءة عبر منحة (granted_company_tickets و granted_ticket_view)
--      تشترط أن يكون المستفيد ما زال من الطاقم وأن تسمح القاعدة لنوعه.
--   ② evaluate_customer_badges (قائم قبل 097، مراجعة 106 L3): دالة بامتياز المالك متاحة لكل مستخدم مسجَّل وتقبل
--      أي معرّف: يمنح مستخدمٌ حسابًا آخر شارات ويرسل له إشعارات، ويعرف من الشارات المكتسبة حديثًا أن لديه
--      اشتراك واتساب نشطًا أو عددًا من التذاكر. الآن النداء المباشر لنفسه أو لطاقم المنصة فقط؛ المحفّزات
--      ومفتاح الخدمة والواجهة (customer-dashboard.js تنادي بمعرّف المستخدم نفسه) بلا تغيير.
--   ③ get_my_company_dashboard (095): مع company_suspension_enforced كانت لوحة شركة موقوفة تعرض امتيازات باقتها
--      بينما company_has_feature ترفضها. 021 وحّد التعريفين صراحة؛ 099 غيّر أحدهما وحده. الآن قائمة الامتيازات فارغة
--      للشركة الموقوفة مع الإنفاذ، و access.suspended يوضّح السبب. عرض فقط: لا يمنح ولا يمنع وصولًا.
--
-- لا مفتاح يُفعَّل ولا يُشترط إطفاؤه (المفاتيح المفعّلة لا تمنع التطبيق). الصلاحيات لا تتغير (create or replace).
-- قابل لإعادة التشغيل. التراجع: migrations/_rollback/108_phase1_readiness_fixes.down.sql
-- ============================================================================
do $$
begin
  if to_regprocedure('public._access_grant_active(uuid)') is null or to_regprocedure('public._access_requester_kind(uuid)') is null
     or to_regprocedure('public.evaluate_customer_badges(uuid)') is null or to_regprocedure('public.is_platform_staff()') is null
     or to_regprocedure('public.get_my_company_dashboard()') is null then
    raise exception '108 يتطلب 097 ودالتي الشارات وطاقم المنصة';
  end if;
end $$;

-- ① ───────────────────────────────────────────────────────────────────────
create or replace function public._access_grant_active(p_grant uuid)
returns public.data_access_grants
language sql
stable
security definer
set search_path to 'public'
as $$
  select g.* from public.data_access_grants g
   where g.id = p_grant and g.grantee_id = auth.uid() and g.revoked_at is null
     and now() >= g.starts_at and now() < g.expires_at
     and public._feature_on('data_access_grants_enabled')
     and coalesce(public.account_is_active(), false)
     -- 108: المستفيد ما زال من الطاقم، والقاعدة ما زالت تسمح لنوعه (كما يُفحص عند الطلب والموافقة).
     -- بدونها يبقى طاقم سابق خُفِّض دوره يقرأ تذاكر الشركة حتى تنتهي المنحة (حتى 168 ساعة).
     and exists (select 1 from public.access_requester_rules ru
                  where ru.requester_kind = public._access_requester_kind(g.grantee_id) and ru.may_request);
$$;

-- ② ───────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.evaluate_customer_badges(p_user_id uuid)
 RETURNS TABLE(badge_key text, newly_earned boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_badge record;
  v_qualifies boolean;
  v_ticket_count int;
  v_account_age_days int;
  v_points int;
  v_has_subdomain boolean;
  v_has_whatsapp boolean;
  v_has_forum boolean;
  v_has_rating boolean;
  v_has_fast_reply boolean;
begin
  if p_user_id is null then
    return;
  end if;

  -- 108: نداء مباشر من مستخدم مسجَّل: لنفسه وحده، أو لطاقم المنصة. لغيره نتيجة فارغة بلا كتابة
  -- (لا شارة ولا إشعار ولا كشف لاشتراك أو عدد تذاكر حساب آخر). المحفّزات (pg_trigger_depth() > 0)
  -- ومفتاح الخدمة (auth.uid() فارغ، مثل backfill_all_customer_badges) كما كانت.
  if pg_trigger_depth() = 0 and auth.uid() is not null
     and p_user_id is distinct from auth.uid()
     and not coalesce(public.is_platform_staff(), false) then
    return;
  end if;

  select count(*) into v_ticket_count from public.tickets where user_id = p_user_id;

  select coalesce(extract(day from now() - created_at)::int, 0), coalesce(points, 0)
    into v_account_age_days, v_points
  from public.profiles where id = p_user_id;

  if v_account_age_days is null then
    v_account_age_days := 0;
  end if;
  if v_points is null then
    v_points := 0;
  end if;

  select exists(
    select 1 from public.subdomain_requests
    where user_id = p_user_id and status = 'success'
  ) into v_has_subdomain;

  select exists(
    select 1 from public.whatsapp_subscriptions
    where user_id = p_user_id and status = 'active'
  ) into v_has_whatsapp;

  select exists(
    select 1 from public.forum_threads where author_id = p_user_id
    union all
    select 1 from public.forum_replies where author_id = p_user_id
  ) into v_has_forum;

  select exists(
    select 1 from public.ticket_ratings where user_id = p_user_id
  ) into v_has_rating;

  select exists (
    select 1
    from public.ticket_replies tr
    join public.tickets t on t.id = tr.ticket_id
    join public.profiles p on p.id = tr.user_id
    where t.user_id = p_user_id
      and tr.is_internal = false
      and coalesce(p.role, 'user') not in ('admin','support','super_user')
      and exists (
        select 1 from public.ticket_replies staff_r
        join public.profiles sp on sp.id = staff_r.user_id
        where staff_r.ticket_id = tr.ticket_id
          and coalesce(sp.role,'user') in ('admin','support','super_user')
          and staff_r.created_at < tr.created_at
          and tr.created_at - staff_r.created_at <= interval '10 minutes'
      )
  ) into v_has_fast_reply;

  for v_badge in
    select * from public.badge_definitions where is_active = true and criteria_type <> 'manual'
  loop
    v_qualifies := false;

    if v_badge.criteria_type = 'ticket_count' then
      v_qualifies := v_ticket_count >= coalesce((v_badge.criteria_value->>'count')::int, 1);
    elsif v_badge.criteria_type = 'fast_reply' then
      v_qualifies := v_has_fast_reply;
    elsif v_badge.criteria_type = 'account_age_days' then
      v_qualifies := v_account_age_days >= coalesce((v_badge.criteria_value->>'days')::int, 30);
    elsif v_badge.criteria_type = 'points_threshold' then
      v_qualifies := v_points >= coalesce((v_badge.criteria_value->>'points')::int, 100);
    elsif v_badge.criteria_type = 'subdomain_created' then
      v_qualifies := v_has_subdomain;
    elsif v_badge.criteria_type = 'whatsapp_subscriber' then
      v_qualifies := v_has_whatsapp;
    elsif v_badge.criteria_type = 'forum_post' then
      v_qualifies := v_has_forum;
    elsif v_badge.criteria_type = 'ticket_rating' then
      v_qualifies := v_has_rating;
    end if;

    if v_qualifies then
      insert into public.customer_badges (user_id, badge_id)
      values (p_user_id, v_badge.id)
      on conflict (user_id, badge_id) do nothing;

      if FOUND then
        insert into public.notifications (user_id, title, message, type, link)
        values (
          p_user_id,
          v_badge.icon || ' شارة جديدة: ' || v_badge.name,
          'مبروك! حصلت على شارة "' || v_badge.name || '" - ' || v_badge.description,
          'success',
          '/customer-dashboard.html'
        );

        badge_key := v_badge.key;
        newly_earned := true;
        return next;
      end if;
    end if;
  end loop;

  return;
end;
$function$;

-- ③ ───────────────────────────────────────────────────────────────────────
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
  v_suspended boolean;
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

  -- 108: نفس تعريف company_has_feature (021: لا تعريفان للاستحقاق في النظام). مع company_suspension_enforced
  -- لا تعرض لوحة شركة موقوفة امتيازات ترفضها دوال الامتيازات نفسها.
  v_suspended := public._feature_on('company_suspension_enforced') and v_company.status = 'suspended';
  if v_suspended then
    v_features := '[]'::jsonb;
  end if;

  if v_viewer <> 'admin' then
    return jsonb_build_object(
      'viewer_role', v_viewer,
      'company', jsonb_build_object('id', v_company.id, 'name', v_company.company_name, 'is_owner', false),
      'registration', null,
      'subscriptions', '[]'::jsonb,
      'entitlements', (select coalesce(jsonb_agg(e - 'granted_by' - 'limits'), '[]'::jsonb)
                         from jsonb_array_elements(v_features) e),
      'access', jsonb_build_object('active_plans', '[]'::jsonb,
        'has_active_subscription', (array_length(v_active_plans, 1) is not null), 'suspended', v_suspended));
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
      'has_active_subscription', (array_length(v_active_plans, 1) is not null), 'suspended', v_suspended));
end;
$$;

do $$
begin
  if position('access_requester_rules' in pg_get_functiondef('public._access_grant_active(uuid)'::regprocedure)) = 0
     or position('pg_trigger_depth() = 0' in pg_get_functiondef('public.evaluate_customer_badges(uuid)'::regprocedure)) = 0
     or position('v_suspended' in pg_get_functiondef('public.get_my_company_dashboard()'::regprocedure)) = 0 then
    raise exception '108: الشروط غير مركّبة';
  end if;
  if has_function_privilege('authenticated', 'public._access_grant_active(uuid)', 'execute')
     or has_function_privilege('anon', 'public.evaluate_customer_badges(uuid)', 'execute')
     or has_function_privilege('anon', 'public.get_my_company_dashboard()', 'execute') then
    raise exception '108: صلاحيات غير متوقعة';
  end if;
end $$;
