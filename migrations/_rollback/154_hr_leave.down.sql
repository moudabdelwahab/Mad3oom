-- ============================================================================
-- 154_hr_leave.down — تراجع 154
--   يحذف جداول الإجازات الثلاث ودوالها، ويعيد _hr_has_permission() إلى
--   نسخة 143 حرفيًا (بلا فرع hr.leave.request)، ويحذف مفتاح الكتالوج
--   hr.leave.request (فيعيد العد إلى 16). بيانات الطلبات والأرصدة والأنواع
--   تُحذف مع الجداول — التراجع إجراء تدميري مقصود على بيئة اختبار؛ لا
--   يُنفَّذ على قاعدة فيها بيانات إجازات حية إلا بقرار موثق.
-- ============================================================================

-- إسقاط RPCs العامة أولًا (الترتيب لا يهم — بلا اعتماديات بينها).
drop function if exists public.hr_leave_request_detail(uuid);
drop function if exists public.hr_leave_requests_list(integer, integer, uuid, text, uuid, integer);
drop function if exists public.hr_leave_request_decide(uuid, boolean, text);
drop function if exists public.hr_leave_request_create(uuid, uuid, date, date, text);
drop function if exists public.hr_leave_balance_set(uuid, uuid, integer, integer);
drop function if exists public.hr_leave_balances_list(uuid, integer);
drop function if exists public.hr_leave_type_archive(uuid, text);
drop function if exists public.hr_leave_type_update(uuid, text, integer, boolean, boolean, integer);
drop function if exists public.hr_leave_type_create(text, text, integer, boolean, integer);
drop function if exists public.hr_leave_types_list(boolean);

-- الدوال الداخلية.
drop function if exists public._hr_leave_can_see_employee(uuid, uuid);
drop function if exists public._hr_leave_can_decide(uuid, uuid);
drop function if exists public._hr_leave_ensure_balances(uuid, uuid, integer);
drop function if exists public._hr_leave_ensure_types(uuid);
drop function if exists public._hr_leave_days(date, date);

-- الجداول (تُسقط الفهارس والمحفّزات معها).
drop table if exists public.hr_leave_requests cascade;
drop table if exists public.hr_leave_balances cascade;
drop table if exists public.hr_leave_types cascade;

-- مفتاح الكتالوج المضاف في 154.
delete from public.company_permission_catalog where key = 'hr.leave.request';

-- إعادة _hr_has_permission إلى نسخة 143 حرفيًا (بلا فرع hr.leave.request).
create or replace function public._hr_has_permission(p_company uuid, p_key text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select public._hr_is_company_admin(p_company)
      or (p_key = 'hr.self.view'
          and exists (select 1 from public.hr_employees e
                       where e.company_id = p_company and e.user_id = auth.uid()
                         and e.archived_at is null))
      or exists (
        select 1 from public.hr_role_assignments r
         where r.company_id = p_company
           and r.user_id = auth.uid()
           and r.revoked_at is null
           and (
             (r.role = 'hr_manager' and p_key in (
               'hr.employees.view', 'hr.employees.manage', 'hr.departments.manage',
               'hr.import', 'hr.link_account', 'hr.roles.manage', 'hr.settings.manage',
               'hr.audit.view', 'hr.leave.view', 'hr.leave.manage',
               'hr.tasks.view', 'hr.tasks.manage'))
             or (r.role = 'hr_officer' and p_key in (
               'hr.employees.view', 'hr.employees.manage', 'hr.import',
               'hr.audit.view', 'hr.leave.view', 'hr.leave.manage',
               'hr.tasks.view', 'hr.tasks.manage'))
             or (r.role = 'dept_manager' and p_key in (
               'hr.employees.view', 'hr.leave.view', 'hr.leave.manage',
               'hr.tasks.view', 'hr.tasks.manage'))
             or (r.role = 'payroll_officer' and p_key in (
               'hr.payroll.view', 'hr.payroll.manage'))
           ));
$$;
