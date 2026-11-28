-- ============================================================================
-- 157_hr_reports.down — تراجع 157
--   يحذف تقارير HR الأربعة ودالتها الداخلية، ويعيد _hr_has_permission()
--   إلى نسخة 155 حرفيًا (بلا مفتاح hr.reports.view في مصفوفة الأدوار).
--   بلا جداول جديدة في 157 وبلا مفاتيح كتالوج جديدة (hr.reports.view من
--   143 فيبقى) فلا حذف بيانات — التراجع غير تدميري.
-- ============================================================================

-- إسقاط RPCs العامة أولًا (الترتيب لا يهم — بلا اعتماديات بينها).
drop function if exists public.hr_reports_tickets(date, date);
drop function if exists public.hr_reports_leave(date, date);
drop function if exists public.hr_reports_attendance(date, date);
drop function if exists public.hr_reports_headcount(date, date);

-- الدالة الداخلية.
drop function if exists public._hr_reports_dept_scope(uuid);

-- إعادة _hr_has_permission إلى نسخة 155 حرفيًا (بلا فرع reports.view).
create or replace function public._hr_has_permission(p_company uuid, p_key text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select public._hr_is_company_admin(p_company)
      or ((p_key = 'hr.self.view' or p_key = 'hr.leave.request' or p_key = 'hr.attendance.checkin')
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
               'hr.tasks.view', 'hr.tasks.manage',
               'hr.attendance.view', 'hr.attendance.manage', 'hr.attendance.checkin'))
             or (r.role = 'hr_officer' and p_key in (
               'hr.employees.view', 'hr.employees.manage', 'hr.import',
               'hr.audit.view', 'hr.leave.view', 'hr.leave.manage',
               'hr.tasks.view', 'hr.tasks.manage',
               'hr.attendance.view', 'hr.attendance.manage', 'hr.attendance.checkin'))
             or (r.role = 'dept_manager' and p_key in (
               'hr.employees.view', 'hr.leave.view', 'hr.leave.manage',
               'hr.tasks.view', 'hr.tasks.manage',
               'hr.attendance.view'))
             or (r.role = 'payroll_officer' and p_key in (
               'hr.payroll.view', 'hr.payroll.manage'))
           ));
$$;
