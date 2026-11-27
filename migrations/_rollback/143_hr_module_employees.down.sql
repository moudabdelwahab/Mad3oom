-- ============================================================================
-- 143_hr_module_employees.down.sql — التراجع عن ترحيل وحدة HR (المرحلة 2).
--
--   يحذف دوال وجداول HR (والبيانات فيها — تراجع تدميري للبيانات، يُنفَّذ
--   بموافقة صريحة فقط)، ويعيد قيد company_feature_overrides إلى مفاتيحه
--   الأربعة قبل HR، ويحذف أعمدة الحالة، ويعيد company_has_feature()
--   إلى تعريف 099 حرفيًا، ويمسح صفوف البذرة (المفاتيح/المفتاح العام/
--   مزايا الباقات/الكتالوج).
--   لا يسترجع أي تجاوز HR كان ممنوحًا (صُفوفه حُذفت مع القيد الضيق).
-- ============================================================================

-- الجداول أولًا: إسقاطها يزيل المحفزات والسياسات والفهارس التابعة، فلا يبقى
-- ما يمنع إسقاط دوال المحفزات (_hr_touch_updated_at وغيرها) بعدها.
drop table if exists public.hr_role_assignments cascade;
drop table if exists public.hr_employee_status_history cascade;
drop table if exists public.hr_import_runs cascade;
drop table if exists public.hr_audit_logs cascade;
drop table if exists public.hr_settings cascade;
drop table if exists public.hr_employees cascade;
drop table if exists public.hr_positions cascade;
drop table if exists public.hr_branches cascade;
drop table if exists public.hr_departments cascade;

do $$
declare f text;
begin
  foreach f in array array[
    'public.hr_employees_list(integer,integer,text,text,uuid,uuid,boolean)',
    'public.hr_employees_count()',
    'public.hr_employee_create(text,text,text,text,text,uuid,uuid,uuid,uuid,text,date,text,date,text,jsonb)',
    'public.hr_employee_update(uuid,text,text,text,text,uuid,uuid,uuid,uuid,text,date,text,date,text,jsonb)',
    'public.hr_employee_archive(uuid,text)',
    'public.hr_employee_reactivate(uuid,text)',
    'public.hr_employee_set_status(uuid,text,text)',
    'public.hr_employee_detail(uuid)',
    'public.hr_my_employee()',
    'public.hr_in_my_scope(uuid)',
    'public.hr_departments_list(boolean)',
    'public.hr_department_create(text,uuid,text,uuid,integer)',
    'public.hr_department_update(uuid,text,uuid,text,uuid,boolean,integer)',
    'public.hr_department_archive(uuid,text)',
    'public.hr_branches_list(boolean)',
    'public.hr_branch_create(text,uuid,text,uuid,integer)',
    'public.hr_branch_update(uuid,text,uuid,text,uuid,boolean,integer)',
    'public.hr_branch_archive(uuid,text)',
    'public.hr_positions_list(boolean)',
    'public.hr_position_create(text,uuid,text,uuid,uuid,integer,integer)',
    'public.hr_position_update(uuid,text,uuid,text,uuid,uuid,integer,boolean,integer)',
    'public.hr_position_archive(uuid,text)',
    'public.hr_settings_get()',
    'public.hr_settings_update(text,integer,integer,jsonb)',
    'public.hr_import_employees(jsonb,uuid,text)',
    'public.hr_import_runs_list(integer,integer)',
    'public.hr_import_run_detail(uuid)',
    'public.hr_link_employee_account(uuid,uuid,text)',
    'public.hr_link_employee_unlink(uuid,text)',
    'public.hr_unlink_employee_account(uuid,text)',
    'public.owner_hr_set_module(uuid,boolean,text)',
    'public.owner_hr_set_section(uuid,text,boolean,text)',
    'public.owner_hr_list_companies(text,integer)',
    'public.owner_hr_operations_log(integer)',
    'public._hr_gate(text,boolean)', 'public._hr_entitled(uuid,text,boolean)',
    'public._hr_is_company_admin(uuid)', 'public._hr_has_permission(uuid,text)',
    'public._hr_can_archive(uuid)', 'public._hr_my_employee_id(uuid)',
    'public._hr_dept_scope(uuid)', 'public._hr_audit(uuid,text,text,uuid,uuid,jsonb,jsonb,text)',
    'public._hr_subscription_audit(uuid,text,jsonb,jsonb,text)',
    'public._hr_mask_national_id(text)', 'public._hr_next_employee_number(uuid)',
    'public._hr_validate_employee_row(jsonb,uuid)', 'public._hr_in_my_scope(uuid)',
    'public._hr_touch_updated_at()', 'public._hr_org_depth_guard()',
    'public._hr_audit_immutable()'] loop
    execute format('drop function if exists %s', f);
  end loop;
end $$;

-- إعادة قيد التجاوزات إلى المفاتيح الأربعة قبل HR، وحذف أعمدة الحالة.
do $$
declare v_def text;
begin
  delete from public.company_feature_overrides where feature_key like 'hr%';
  select pg_get_constraintdef(oid) into v_def from pg_constraint
   where conname = 'company_feature_overrides_pilot_only'
     and conrelid = 'public.company_feature_overrides'::regclass;
  if v_def is not null and v_def like '%''hr''%' then
    alter table public.company_feature_overrides drop constraint company_feature_overrides_pilot_only;
    alter table public.company_feature_overrides
      add constraint company_feature_overrides_pilot_only
      check (feature_key in ('integrations_hub', 'shopify_integration', 'store_support', 'shopify_management'));
  end if;
  alter table public.company_feature_overrides
    drop column if exists suspend_reason,
    drop column if exists suspended_by,
    drop column if exists suspended_at,
    drop column if exists status;
end $$;

-- إعادة company_has_feature() إلى تعريف 099 حرفيًا.
create or replace function public.company_has_feature(p_feature_key text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select not (public._feature_on('company_suspension_enforced')
              and exists (select 1 from public.companies c where c.id = public.current_company_id() and c.status = 'suspended'))
  and (
  exists (
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
       and (o.expires_at is null or o.expires_at > now())));
$function$;

-- مسح صفوف البذرة.
delete from public.plan_features where feature_key like 'hr%';
delete from public.company_permission_catalog where key like 'hr.%';
delete from public.platform_feature_switches where key = 'hr_module_enabled';
delete from public.feature_flags where key in
  ('hr', 'hr_employees', 'hr_leave', 'hr_payroll', 'hr_tasks', 'hr_attendance', 'hr_reports');

-- إعادة قيد مفتاح الكتالوج إلى نمط النقطة الواحدة (بعد حذف مفاتيح hr.*).
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'company_permission_catalog_key_check'
             and conrelid = 'public.company_permission_catalog'::regclass) then
    alter table public.company_permission_catalog drop constraint company_permission_catalog_key_check;
    alter table public.company_permission_catalog
      add constraint company_permission_catalog_key_check
      check (key ~ '^[a-z]+\.[a-z_]+$');
  end if;
end $$;

do $$ begin
  raise notice '143 rolled back: HR tables/functions dropped, overrides constraint restored to 4 keys';
end $$;
