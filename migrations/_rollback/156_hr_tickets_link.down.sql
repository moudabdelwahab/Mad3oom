-- ============================================================================
-- 156_hr_tickets_link.down — تراجع 156
--   يحذف RPCs إحصاءات التذاكر الأربع والدالة الداخلية. بلا جداول جديدة
--   وبلا مفاتيح كتالوج في 156 فلا شيء آخر يُسترجع. التراجع غير تدميري
--   للبيانات (القراءة فقط لم تكتب شيئًا أصلًا — لا tickets ولا hr_*).
-- ============================================================================

drop function if exists public.hr_department_ticket_stats(date, date);
drop function if exists public.hr_employees_ticket_summary(uuid[]);
drop function if exists public.hr_employee_tickets_list(uuid, integer, integer, text);
drop function if exists public.hr_employee_ticket_stats(uuid, date, date);
drop function if exists public._hr_tickets_can_see_employee(uuid, uuid);
