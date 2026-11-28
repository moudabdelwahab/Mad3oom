-- ============================================================================
-- 155_hr_attendance.down — تراجع 155
--   يحذف جداول الحضور الثلاث ودوالها، ويعيد _hr_has_permission() إلى
--   نسخة 154 حرفيًا (بلا فرع hr.attendance.checkin وبلا مفاتيح
--   hr.attendance.* في مصفوفة الأدوار)، ويحذف مفتاح الكتالوج
--   hr.attendance.checkin (فيعيد العد إلى 17). بيانات الورديات والإسناد
--   والسجلات تُحذف مع الجداول — التراجع إجراء تدميري مقصود على بيئة اختبار؛ لا
--   يُنفَّذ على قاعدة فيها بيانات حضور حية إلا بقرار موثق.
-- ============================================================================

-- إسقاط RPCs العامة أولًا (الترتيب لا يهم — بلا اعتماديات بينها).
drop function if exists public.hr_attendance_summary(uuid, date, date);
drop function if exists public.hr_attendance_list(integer, integer, uuid, date, date, text);
drop function if exists public.hr_attendance_today(uuid);
drop function if exists public.hr_attendance_correct(uuid, timestamp with time zone, timestamp with time zone, text, text);
drop function if exists public.hr_attendance_check_out(uuid, text);
drop function if exists public.hr_attendance_check_in(uuid, text);
drop function if exists public.hr_shift_assign(uuid, uuid, date);
drop function if exists public.hr_shift_update(uuid, text, time without time zone, time without time zone, smallint[], integer, boolean, integer);
drop function if exists public.hr_shift_create(text, time without time zone, time without time zone, smallint[], integer, integer);
drop function if exists public.hr_shifts_list(boolean);

-- الدوال الداخلية.
drop function if exists public._hr_attendance_can_see_employee(uuid, uuid);
drop function if exists public._hr_attendance_target(uuid, uuid);
drop function if exists public._hr_attendance_status(timestamp with time zone, time without time zone, integer);
drop function if exists public._hr_attendance_shift_for(uuid, uuid, date);

-- الجداول (تُسقط الفهارس والمحفّزات معها).
drop table if exists public.hr_attendance cascade;
drop table if exists public.hr_shift_assignments cascade;
drop table if exists public.hr_shifts cascade;

-- مفتاح الكتالوج المضاف في 155.
delete from public.company_permission_catalog where key = 'hr.attendance.checkin';

-- إعادة _hr_has_permission إلى نسخة 154 حرفيًا (بلا فرع hr.attendance.checkin
-- وبلا مفاتيح hr.attendance.* في مصفوفة الأدوار).
create or replace function public._hr_has_permission(p_company uuid, p_key text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select public._hr_is_company_admin(p_company)
      or ((p_key = 'hr.self.view' or p_key = 'hr.leave.request')
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
