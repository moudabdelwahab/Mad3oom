-- ============================================================================
-- التراجع عن 099_admin_hierarchy — يعيد دالتين كما كانتا بعد 098 حرفيًا ويحذف الهيكل الإداري.
--
-- حماية البيانات: يرفض التراجع إن كان مفتاح من مفاتيح 099 مفعّلًا، أو وُجدت وحدة أو تفويض أو سجل
-- هيكل (إلحاقي)، أو قرار مراجعة مُتَّخذ — تاريخ إداري لا يُحذف بتراجع.
--
-- الترتيب (REVIEW_FOLLOWUPS L5): 104 ← 103 ← 102 ← 101 ← 100 ← 099. يرفض قبل أي تغيير إن كان 100 أو 103
-- مطبَّقًا (company_documents.assigned_unit يشير إلى admin_units، فكان الحذف يفشل في منتصفه).
-- يُشغَّل في معاملة واحدة: psql --single-transaction -v ON_ERROR_STOP=1 -f <هذا الملف>
-- ============================================================================
do $$
begin
  if to_regclass('public.company_documents') is not null then
    raise exception 'التراجع عن 099 مرفوض: 100 مطبَّق — تراجع عن 100 أولًا';
  end if;
  if to_regprocedure('public._hierarchy_release_user(uuid,text)') is not null then
    raise exception 'التراجع عن 099 مرفوض: 103 مطبَّق — تراجع عن 103 أولًا';
  end if;
  if exists (select 1 from public.platform_feature_switches
              where key in ('delegation_enabled', 'company_suspension_enforced') and enabled) then
    raise exception 'التراجع عن 099 مرفوض: مفتاح التفويض أو الإيقاف مفعّل — أطفئه أولًا';
  end if;
  if to_regclass('public.hierarchy_events') is not null and (
       exists (select 1 from public.hierarchy_events) or exists (select 1 from public.admin_units)
       or exists (select 1 from public.platform_delegations)
       or exists (select 1 from public.admin_account_reviews where decision <> 'pending')) then
    raise exception 'التراجع عن 099 مرفوض: يوجد هيكل أو تفويضات أو قرارات مراجعة — سجل إداري لا يُحذف';
  end if;
end $$;

drop function if exists public.owner_unit_create(text, uuid, text);
drop function if exists public.owner_unit_archive(uuid, text);
drop function if exists public.unit_member_set(uuid, uuid, text);
drop function if exists public.unit_member_end(uuid, uuid, text);
drop function if exists public.owner_assign_company_unit(uuid, uuid, text);
drop function if exists public.owner_grant_delegation(uuid, uuid, text[], text, timestamptz);
drop function if exists public.owner_revoke_delegation(uuid, text);
drop function if exists public.owner_hierarchy();
drop function if exists public.my_delegations();
drop function if exists public.delegate_companies();
drop function if exists public.delegate_set_company_status(uuid, text, text);
drop function if exists public.owner_admin_reviews();
drop function if exists public.owner_decide_admin_review(uuid, text, text);
drop function if exists public.owner_apply_admin_review(uuid);
drop function if exists public.owner_reassign_admin_tickets(uuid, uuid, text);

-- الدالتان كما كانتا بعد 098 حرفيًا

-- public.guard_company_status()
CREATE OR REPLACE FUNCTION public.guard_company_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;
  if auth.uid() is null or public.is_admin() then
    return new;
  end if;
  raise exception 'حالة الشركة تُغيَّر من الإدارة فقط' using errcode = '42501';
end;
$function$;

-- public.company_has_feature(text)
CREATE OR REPLACE FUNCTION public.company_has_feature(p_feature_key text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1
      from public.companies c
      join public.whatsapp_subscriptions s on (s.company_id = c.id or s.user_id = c.user_id)
      join public.subscription_plans sp on sp.key = s.plan
      join public.plan_features pf on pf.plan_id = sp.id and pf.enabled = true
     where c.id = public.current_company_id()
       and s.status = 'active'
       and s.start_date <= now()
       and s.end_date   >  now()
       and pf.feature_key = p_feature_key)
  or exists (
    select 1
      from public.company_feature_overrides o
     where o.company_id = public.current_company_id()
       and o.feature_key = p_feature_key
       and (o.expires_at is null or o.expires_at > now()));
$function$;


drop function if exists public._admin_review_facts(uuid);
drop function if exists public._hierarchy_event(text, uuid, uuid, uuid, jsonb);
drop function if exists public._delegate_can(text, uuid);
drop function if exists public._unit_subtree(uuid);
drop function if exists public._company_unit(uuid);
drop function if exists public._owner_write_check();
drop function if exists public._reason_check(text);
drop table if exists public.admin_account_reviews;
drop table if exists public.hierarchy_events;
drop table if exists public.platform_delegations;
drop table if exists public.delegation_capabilities;
drop table if exists public.admin_unit_companies;
drop table if exists public.admin_unit_members;
drop table if exists public.admin_units;
drop function if exists public._hierarchy_append_only();
drop function if exists public._admin_unit_guard();
drop function if exists public._hierarchy_person_guard();
drop function if exists public._unit_company_guard();
drop function if exists public._hierarchy_eligible(uuid);
delete from public.platform_feature_switches where key in ('delegation_enabled', 'company_suspension_enforced');
