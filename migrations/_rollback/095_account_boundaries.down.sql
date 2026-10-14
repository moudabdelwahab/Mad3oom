-- ============================================================================
-- التراجع عن 095_account_boundaries — يعيد النصوص والشروط كما كانت حرفيًا
-- (قراءة الإنتاج 2026-10-13). تحذير: التراجع يعيد فتح ما أغلقه 095 (لوحة الشركة
-- لعملائها، رموز العملاء وتكاملاتهم لمالك الشركة، IP والجهاز في سجل النشاط).
-- ============================================================================

drop function if exists public.my_company_portal();
drop function if exists public.my_account_kind();

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
begin
  if auth.uid() is null then return null; end if;
  v_company_id := public.current_company_id();
  if v_company_id is null then return null; end if;
  select * into v_company from public.companies where id = v_company_id;

  select coalesce(array_agg(distinct s.plan), '{}'::text[]) into v_active_plans
    from public.whatsapp_subscriptions s
   where (s.company_id = v_company_id or s.user_id = v_company.user_id)
     and s.status = 'active' and s.start_date <= now() and s.end_date > now();

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

  return jsonb_build_object(
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

alter policy "Company members can view their company" on public.companies
  using (id = public.current_company_id());

-- النصّان الأصليان على الإنتاج بنهايات أسطر CRLF؛ نعيدهما حرفيًا (بصمة مطابقة).
do $rb$
begin
  execute format($f$create or replace function public.link_subscription_to_my_company(p_subscription_id uuid)
 returns boolean language plpgsql security definer set search_path to 'public' as %L$f$, replace($src$
declare
  v_company_id uuid;
  v_updated    int;
begin
  if auth.uid() is null then
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
$src$, E'\n', E'\r\n'));

  execute format($f$create or replace function public.enforce_subscription_company_owner()
 returns trigger language plpgsql security definer set search_path to 'public' as %L$f$, replace($src$
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

  return new;
end;
$src$, E'\n', E'\r\n'));
end $rb$;

create or replace function public.is_owner_or_super_of(target_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select target_id is not null
     and (auth.uid() = target_id or public.supervises(target_id));
$$;
comment on function public.is_owner_or_super_of(uuid) is null;

alter policy "View own/managed/platform integrations" on public.external_integrations
  using (is_admin() OR (owner_scope = 'platform'::text) OR is_owner_or_super_of(owner_id));
alter policy "Insert own/managed integrations" on public.external_integrations
  with check (is_admin() OR ((owner_scope <> 'platform'::text) AND is_owner_or_super_of(owner_id)));
alter policy "Update own/managed/platform integrations" on public.external_integrations
  using (is_admin() OR ((owner_scope <> 'platform'::text) AND is_owner_or_super_of(owner_id)))
  with check (is_admin() OR ((owner_scope <> 'platform'::text) AND is_owner_or_super_of(owner_id)));
alter policy "Delete own/managed/platform integrations" on public.external_integrations
  using (is_admin() OR ((owner_scope <> 'platform'::text) AND is_owner_or_super_of(owner_id)));
alter policy "Manage models of writable integrations" on public.external_integration_models
  using (EXISTS ( SELECT 1 FROM external_integrations ei
                   WHERE ((ei.id = external_integration_models.integration_id)
                     AND (is_admin() OR ((ei.owner_scope <> 'platform'::text) AND is_owner_or_super_of(ei.owner_id))))))
  with check (EXISTS ( SELECT 1 FROM external_integrations ei
                        WHERE ((ei.id = external_integration_models.integration_id)
                          AND (is_admin() OR ((ei.owner_scope <> 'platform'::text) AND is_owner_or_super_of(ei.owner_id))))));

alter policy activity_logs_select_policy on public.activity_logs
  using ((user_id = auth.uid()) OR has_elevated_authority()
         OR (( SELECT p.role FROM profiles p WHERE (p.id = auth.uid())) = 'admin'::text) OR supervises(user_id));

alter policy profiles_update_policy on public.profiles
  using ((auth.uid() = id) OR has_elevated_authority() OR supervises(id));

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

  return new;
end $$;

create or replace function public.context_destination(p_context text)
returns text
language sql
immutable
as $$
  select case p_context
    when 'owner'                then '/owner-dashboard.html'
    when 'admin'                then '/admin-dashboard.html'
    when 'company_admin'        then '/company-dashboard/'
    when 'company_user_preview' then '/company-dashboard/'
    when 'customer'             then '/customer-dashboard.html'
    else null
  end;
$$;
