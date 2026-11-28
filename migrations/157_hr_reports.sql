-- ============================================================================
-- 157_hr_reports.sql — وحدة الموارد البشرية، المرحلة 3 (القسم 4 — الأخير):
--   التقارير — تجميع الأقسام الثلاثة السابقة، بلا جداول جديدة وبلا كتابة.
--
--   أربعة تقارير قراءة فقط، كلها SECURITY DEFINER، والشركة من
--   current_company_id() لا من معامل، والبوابة _hr_gate('hr_reports', false)
--   أولًا ثم الصلاحية hr.reports.view (من 143 — بلا مفتاح كتالوج جديد)،
--   ثم نطاق مدير القسم/المدير المباشر/الذاتية على نمط 154/155/156.
--
--   إعادة الاستخدام لا إعادة الاشتقاق (قرار المهمة):
--   • الحضور: كل موظف ظاهر يُمرَّر عبر hr_attendance_summary (155) — أي
--     أن الأيام المتوقعة/الحاضر/المتأخر/الغائب (المشتق)/في إجازة ومجموع
--     دقائق العمل كلها من 155 حرفيًا؛ التقرير الجديد يجمّعها فقط
--     (بالقسم + إجمالي الشركة) ويحوّلها إلى نسب.
--   • الإجازات: الأرصدة من hr_leave_balances_list (154) لكل موظف ظاهر
--     (مع سلوكها الموثق: إنشاء كسول لأرصدة السنة من افتراضيات الأنواع عند
--     أول قراءة حين يكون القسم مفعّلًا للكتابة)؛ والاستخدام داخل الفترة
--     من hr_leave_requests مباشرةً (أيام الطلبات المعتمَدة المتداخلة مع
--     الفترة — لا RPC قائمًا يرجع أيام تداخل، فالحساب هنا تقريري لا تكرار
--     لمنطق 154).
--   • التذاكر: تجميع الأقسام وإجماليات الشركة وتفصيل غير المرتبطة من
--     hr_department_ticket_stats (156) كما هي؛ وصف كل موظف من
--     hr_employee_ticket_stats (156).
--   • العدد: تجميع مباشر من hr_employees (لا RPC قائمًا يرجع عددًا حسب
--     القسم والحالة؛ hr_employees_count يرجع الإجمالي فقط).
--
--   الفترة: p_from/p_to لكل تقرير، الافتراضي الشهر الحالي حتى اليوم
--   (نمط 155 لا آخر 30 يومًا في 156)، بحد 366 يومًا (نمط 156).
--
--   قرارات حين سكت التصميم (موثقة في تقرير المهمة أيضًا):
--   1. العدد لقطة بتاريخ p_to: موظف يُحسب إن كان معيّنًا في p_to أو قبله
--      (hire_date فارغ يُحسب — تاريخ تعيين مجهول لا يُسقط الموظف) ولم
--      يُؤرشف في p_to أو قبلها؛ وتفصيل الحالات يستعمل الحالة الحالية.
--   2. نسب الحضور مقامها الأيام المتوقعة (أيام عمل الوردية السارية، من
--      155)؛ وقسم بلا أيام متوقعة ترجع نسبه null لا صفرًا، ويُعدّ
--      موظفوه في employees_no_expected_days.
--   3. أرصدة الإجازات لسنة p_from (الأرصدة سنوية)؛ والاستخدام داخل
--      الفترة أيام تقويمية من الطلبات المعتمَدة المتداخلة معها فقط.
--   4. الموظف بلا حساب مرتبط يظهر في تقرير التذاكر (linked=false
--      وعدّادات صفر) بدل إسقاطه صامتًا؛ وإجماليات الشركة تشمل كل تذاكر
--      الشركة (بما فيها غير المسندة والمسندة لحساب غير مرتبط) من 156.
--   5. الموظف المؤرشف مستبعد من التقارير الأربعة.
--   6. إن كان قسم مصدر غير مفعّل للقراءة (hr_leave / hr_attendance /
--      hr_employees)، بلوكه يرجع available=false وصفوفًا فارغة مع سبب
--      عربي، ولا يُفشل التقرير كاملًا — البوابة الوحيدة الفاصلة هي
--      hr_reports نفسها.
--   7. القراءة لا تُدوَّن في التدقيق (نمط 143/154/156 للقراءة).
--
--   يعتمد على 143 (البوابة والصلاحيات وhr_employees) وعلى 154 (الأرصدة
--   والطلبات) وعلى 155 (الملخص) وعلى 156 (إحصاءات التذاكر).
--   قابل لإعادة التشغيل.
--   التراجع: migrations/_rollback/157_hr_reports.down.sql
-- ============================================================================

-- ============================================================================
-- 0) المتطلبات
-- ============================================================================
do $$
declare
  v_missing text;
begin
  if to_regprocedure('public._hr_gate(text,boolean)') is null then
    raise exception '157: يلزم الترحيل 143 أولًا (_hr_gate غائبة)';
  end if;
  if to_regprocedure('public._hr_entitled(uuid,text,boolean)') is null then
    raise exception '157: يلزم الترحيل 143 أولًا (_hr_entitled غائبة)';
  end if;
  if to_regprocedure('public._hr_has_permission(uuid,text)') is null then
    raise exception '157: يلزم الترحيل 143 أولًا (_hr_has_permission غائبة)';
  end if;
  if to_regprocedure('public._hr_is_company_admin(uuid)') is null then
    raise exception '157: يلزم الترحيل 143 أولًا (_hr_is_company_admin غائب)';
  end if;
  if to_regprocedure('public._hr_dept_scope(uuid)') is null then
    raise exception '157: يلزم الترحيل 143 أولًا (_hr_dept_scope غائب)';
  end if;
  if to_regprocedure('public._hr_leave_can_see_employee(uuid,uuid)') is null then
    raise exception '157: يلزم الترحيل 154 أولًا (_hr_leave_can_see_employee غائب)';
  end if;
  if to_regprocedure('public._hr_attendance_can_see_employee(uuid,uuid)') is null then
    raise exception '157: يلزم الترحيل 155 أولًا (_hr_attendance_can_see_employee غائب)';
  end if;
  if to_regprocedure('public._hr_tickets_can_see_employee(uuid,uuid)') is null then
    raise exception '157: يلزم الترحيل 156 أولًا (_hr_tickets_can_see_employee غائب)';
  end if;
  if to_regprocedure('public.hr_leave_balances_list(uuid,integer)') is null then
    raise exception '157: يلزم الترحيل 154 أولًا (hr_leave_balances_list غائب)';
  end if;
  if to_regprocedure('public.hr_attendance_summary(uuid,date,date)') is null then
    raise exception '157: يلزم الترحيل 155 أولًا (hr_attendance_summary غائب)';
  end if;
  if to_regprocedure('public.hr_department_ticket_stats(date,date)') is null then
    raise exception '157: يلزم الترحيل 156 أولًا (hr_department_ticket_stats غائب)';
  end if;
  if to_regprocedure('public.hr_employee_ticket_stats(uuid,date,date)') is null then
    raise exception '157: يلزم الترحيل 156 أولًا (hr_employee_ticket_stats غائب)';
  end if;
  select string_agg(t, ', ') into v_missing
    from (values ('hr_employees'), ('hr_departments'), ('hr_leave_types'),
                 ('hr_leave_balances'), ('hr_leave_requests'), ('hr_attendance'),
                 ('hr_shifts'), ('hr_shift_assignments'), ('tickets')) as need(t)
   where to_regclass('public.' || need.t) is null;
  if v_missing is not null then
    raise exception '157: جداول ناقصة: %', v_missing;
  end if;
  if to_regprocedure('public.hr_reports_headcount(date,date)') is not null then
    raise notice '157: أُعيد التطبيق — الكائنات موجودة أصلًا';
  end if;
end $$;

-- ============================================================================
-- 1) _hr_has_permission: نسخة 155 حرفيًا + مفتاح hr.reports.view (من 143،
--    بلا صف كتالوج جديد) في مصفوفة الأدوار:
--    - hr_manager / hr_officer: عرض التقارير على مستوى الشركة.
--    - dept_manager: عرض التقارير داخل نطاق قسمه فقط (تفرضه كل RPC).
--    - payroll_officer: بلا تقارير (لا بيانات رواتب في التقارير الأربعة).
-- ============================================================================
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
               'hr.attendance.view', 'hr.attendance.manage', 'hr.attendance.checkin',
               'hr.reports.view'))
             or (r.role = 'hr_officer' and p_key in (
               'hr.employees.view', 'hr.employees.manage', 'hr.import',
               'hr.audit.view', 'hr.leave.view', 'hr.leave.manage',
               'hr.tasks.view', 'hr.tasks.manage',
               'hr.attendance.view', 'hr.attendance.manage', 'hr.attendance.checkin',
               'hr.reports.view'))
             or (r.role = 'dept_manager' and p_key in (
               'hr.employees.view', 'hr.leave.view', 'hr.leave.manage',
               'hr.tasks.view', 'hr.tasks.manage',
               'hr.attendance.view',
               'hr.reports.view'))
             or (r.role = 'payroll_officer' and p_key in (
               'hr.payroll.view', 'hr.payroll.manage'))
           ));
$$;

-- ============================================================================
-- 2) الدالة الداخلية _hr_reports_dept_scope — نطاق القسم للتقرير:
--    null = مستوى الشركة (مالك الشركة أو hr_manager/hr_officer)، وإلا قسم
--    مدير القسم. (على نمط نطاق 156 §2.4؛ التقارير المعتمِدة على موظفين
--    تستعمل مساعدات can_see الخاصة بأقسامها بدلًا منها.)
-- ============================================================================
create or replace function public._hr_reports_dept_scope(p_company uuid)
returns uuid
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_scope uuid;
  v_wide  boolean;
begin
  if public._hr_is_company_admin(p_company) then
    return null;
  end if;
  v_scope := public._hr_dept_scope(p_company);
  select exists (select 1 from public.hr_role_assignments r
                  where r.company_id = p_company and r.user_id = auth.uid()
                    and r.revoked_at is null and r.role in ('hr_manager', 'hr_officer'))
    into v_wide;
  if v_wide then
    return null;
  end if;
  return v_scope;
end $$;

-- ============================================================================
-- 3) RPCs الشركة — التقارير (قراءة فقط؛ بلا أي كتابة وبلا سطر تدقيق).
--    كلها SECURITY DEFINER، والشركة من current_company_id() لا من معامل،
--    والبوابة _hr_gate('hr_reports', false) أولًا ثم hr.reports.view.
--    الفترة الافتراضية الشهر الحالي حتى اليوم؛ والحد 366 يومًا (نمط 156).
-- ============================================================================

-- 3.1) العدد حسب القسم والحالة — لقطة بتاريخ p_to: معيّن في p_to أو قبله
--      (hire_date فارغ يُحسب) ولم يُؤرشف في p_to أو قبلها؛ والحالات الحالية.
create or replace function public.hr_reports_headcount(p_from date default null,
                                                      p_to date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  v_from    date := coalesce(p_from, date_trunc('month', current_date)::date);
  v_to      date := coalesce(p_to, current_date);
  v_scope   uuid;
begin
  v_company := public._hr_gate('hr_reports', false);
  if not public._hr_has_permission(v_company, 'hr.reports.view') then
    raise exception 'لا تملك صلاحية عرض تقارير الموارد البشرية' using errcode = '42501';
  end if;
  if v_from > v_to then
    raise exception 'النافذة معكوسة' using errcode = '22023';
  end if;
  if (v_to - v_from) > 366 then
    raise exception 'النافذة أطول من 366 يومًا' using errcode = '22023';
  end if;
  v_scope := public._hr_reports_dept_scope(v_company);
  return (
    with f as (
      select e.department_id, coalesce(d.name, 'بلا قسم') as department_name,
             e.employment_status
        from public.hr_employees e
        left join public.hr_departments d on d.id = e.department_id
       where e.company_id = v_company
         and (e.hire_date is null or e.hire_date <= v_to)
         and (e.archived_at is null or e.archived_at::date > v_to)
         and (v_scope is null or e.department_id = v_scope)
    ), agg as (
      select department_id, department_name,
             count(*)::bigint as total,
             count(*) filter (where employment_status = 'active')::bigint as active,
             count(*) filter (where employment_status = 'on_leave')::bigint as on_leave,
             count(*) filter (where employment_status = 'suspended')::bigint as suspended,
             count(*) filter (where employment_status = 'terminated')::bigint as terminated,
             count(*) filter (where employment_status = 'pending_data')::bigint as pending_data
        from f
       group by department_id, department_name
    )
    select jsonb_build_object(
      'from', v_from, 'to', v_to, 'generated_at', now(), 'available', true,
      'rows', coalesce((select jsonb_agg(jsonb_build_object(
          'department_id', s.department_id, 'department_name', s.department_name,
          'total', s.total, 'active', s.active, 'on_leave', s.on_leave,
          'suspended', s.suspended, 'terminated', s.terminated, 'pending_data', s.pending_data)
        order by s.department_name) from agg s), '[]'::jsonb),
      'total', (select count(*) from agg),
      'totals', jsonb_build_object(
        'total', (select count(*) from f),
        'active', (select count(*) from f where employment_status = 'active'),
        'on_leave', (select count(*) from f where employment_status = 'on_leave'),
        'suspended', (select count(*) from f where employment_status = 'suspended'),
        'terminated', (select count(*) from f where employment_status = 'terminated'),
        'pending_data', (select count(*) from f where employment_status = 'pending_data'))));
end $$;
comment on function public.hr_reports_headcount(date, date) is
  '157: تقرير العدد حسب القسم والحالة — لقطة بتاريخ p_to (معيّن قبله ولم يُؤرشف قبله)؛ مدير القسم يرى قسمه فقط.';

-- 3.2) الحضور حسب القسم + إجمالي الشركة — كل موظف ظاهر عبر
--      hr_attendance_summary (155)؛ النسب مقامها الأيام المتوقعة، وnull حين
--      لا أيام متوقعة. القسم المصدر غير مفعّل → available=false.
create or replace function public.hr_reports_attendance(p_from date default null,
                                                       p_to date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  v_from    date := coalesce(p_from, date_trunc('month', current_date)::date);
  v_to      date := coalesce(p_to, current_date);
begin
  v_company := public._hr_gate('hr_reports', false);
  if not public._hr_has_permission(v_company, 'hr.reports.view') then
    raise exception 'لا تملك صلاحية عرض تقارير الموارد البشرية' using errcode = '42501';
  end if;
  if v_from > v_to then
    raise exception 'النافذة معكوسة' using errcode = '22023';
  end if;
  if (v_to - v_from) > 366 then
    raise exception 'النافذة أطول من 366 يومًا' using errcode = '22023';
  end if;
  if not public._hr_entitled(v_company, 'hr_attendance', false) then
    return jsonb_build_object(
      'from', v_from, 'to', v_to, 'generated_at', now(), 'available', false,
      'reason', 'قسم الحضور والانصراف غير مفعّل لشركتك',
      'rows', '[]'::jsonb, 'total', 0, 'totals', null);
  end if;
  return (
    with vis as (
      select e.id, e.department_id, coalesce(d.name, 'بلا قسم') as department_name
        from public.hr_employees e
        left join public.hr_departments d on d.id = e.department_id
       where e.company_id = v_company and e.archived_at is null
         and public._hr_attendance_can_see_employee(v_company, e.id)
    ), per_emp as (
      select v.department_id, v.department_name,
             (s.summary->>'expected_days')::int as expected_days,
             (s.summary->>'present_days')::int as present_days,
             (s.summary->>'late_days')::int as late_days,
             (s.summary->>'absent_days')::int as absent_days,
             (s.summary->>'on_leave_days')::int as on_leave_days,
             (s.summary->>'total_worked_minutes')::int as total_worked_minutes
        from vis v
       cross join lateral
         (select public.hr_attendance_summary(v.id, v_from, v_to) as summary) s
    ), agg as (
      select department_id, department_name,
             count(*)::bigint as employees_count,
             count(*) filter (where expected_days = 0)::bigint as employees_no_expected_days,
             coalesce(sum(expected_days), 0)::bigint as expected_days,
             coalesce(sum(present_days), 0)::bigint as present_days,
             coalesce(sum(late_days), 0)::bigint as late_days,
             coalesce(sum(absent_days), 0)::bigint as absent_days,
             coalesce(sum(on_leave_days), 0)::bigint as on_leave_days,
             coalesce(sum(total_worked_minutes), 0)::bigint as total_worked_minutes,
             case when sum(expected_days) = 0 then null
               else round(100.0 * sum(present_days) / sum(expected_days), 1) end as present_rate,
             case when sum(expected_days) = 0 then null
               else round(100.0 * sum(late_days) / sum(expected_days), 1) end as late_rate,
             case when sum(expected_days) = 0 then null
               else round(100.0 * sum(absent_days) / sum(expected_days), 1) end as absent_rate,
             case when sum(expected_days) = 0 then null
               else round(100.0 * sum(on_leave_days) / sum(expected_days), 1) end as on_leave_rate
        from per_emp
       group by department_id, department_name
    )
    select jsonb_build_object(
      'from', v_from, 'to', v_to, 'generated_at', now(), 'available', true,
      'rows', coalesce((select jsonb_agg(jsonb_build_object(
          'department_id', s.department_id, 'department_name', s.department_name,
          'employees_count', s.employees_count,
          'employees_no_expected_days', s.employees_no_expected_days,
          'expected_days', s.expected_days, 'present_days', s.present_days,
          'late_days', s.late_days, 'absent_days', s.absent_days,
          'on_leave_days', s.on_leave_days,
          'total_worked_minutes', s.total_worked_minutes,
          'present_rate', s.present_rate, 'late_rate', s.late_rate,
          'absent_rate', s.absent_rate, 'on_leave_rate', s.on_leave_rate)
        order by s.department_name) from agg s), '[]'::jsonb),
      'total', (select count(*) from agg),
      'totals', jsonb_build_object(
        'employees_count', (select count(*) from per_emp),
        'employees_no_expected_days', (select count(*) from per_emp where expected_days = 0),
        'expected_days', (select coalesce(sum(expected_days), 0) from per_emp),
        'present_days', (select coalesce(sum(present_days), 0) from per_emp),
        'late_days', (select coalesce(sum(late_days), 0) from per_emp),
        'absent_days', (select coalesce(sum(absent_days), 0) from per_emp),
        'on_leave_days', (select coalesce(sum(on_leave_days), 0) from per_emp),
        'total_worked_minutes', (select coalesce(sum(total_worked_minutes), 0) from per_emp),
        'present_rate', (select case when sum(expected_days) = 0 then null
          else round(100.0 * sum(present_days) / sum(expected_days), 1) end from per_emp),
        'late_rate', (select case when sum(expected_days) = 0 then null
          else round(100.0 * sum(late_days) / sum(expected_days), 1) end from per_emp),
        'absent_rate', (select case when sum(expected_days) = 0 then null
          else round(100.0 * sum(absent_days) / sum(expected_days), 1) end from per_emp),
        'on_leave_rate', (select case when sum(expected_days) = 0 then null
          else round(100.0 * sum(on_leave_days) / sum(expected_days), 1) end from per_emp))));
end $$;
comment on function public.hr_reports_attendance(date, date) is
  '157: تقرير الحضور حسب القسم + إجمالي الشركة — تجميع hr_attendance_summary (155) لكل موظف ظاهر؛ النسب مقامها الأيام المتوقعة؛ القسم غير مفعّل → available=false.';

-- 3.3) الإجازات حسب النوع والقسم — الأرصدة (سنة p_from) من
--      hr_leave_balances_list (154) لكل موظف ظاهر؛ والاستخدام داخل الفترة
--      أيام تقويمية من الطلبات المعتمَدة المتداخلة معها، والمعلقة عدّاد
--      طلبات متداخلة. الأنواع بلا رصيد (بدون أجر) تظهر بأرصدة null لا صفر.
--      القسم المصدر غير مفعّل → available=false.
create or replace function public.hr_reports_leave(p_from date default null,
                                                  p_to date default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  v_from    date := coalesce(p_from, date_trunc('month', current_date)::date);
  v_to      date := coalesce(p_to, current_date);
  v_year    int := extract(year from coalesce(p_from, date_trunc('month', current_date)::date))::int;
begin
  v_company := public._hr_gate('hr_reports', false);
  if not public._hr_has_permission(v_company, 'hr.reports.view') then
    raise exception 'لا تملك صلاحية عرض تقارير الموارد البشرية' using errcode = '42501';
  end if;
  if v_from > v_to then
    raise exception 'النافذة معكوسة' using errcode = '22023';
  end if;
  if (v_to - v_from) > 366 then
    raise exception 'النافذة أطول من 366 يومًا' using errcode = '22023';
  end if;
  if not public._hr_entitled(v_company, 'hr_leave', false) then
    return jsonb_build_object(
      'from', v_from, 'to', v_to, 'generated_at', now(), 'available', false,
      'reason', 'قسم الإجازات غير مفعّل لشركتك',
      'rows', '[]'::jsonb, 'total', 0, 'totals', null, 'year', v_year);
  end if;
  return (
    with vis as (
      select e.id, e.department_id, coalesce(d.name, 'بلا قسم') as department_name
        from public.hr_employees e
        left join public.hr_departments d on d.id = e.department_id
       where e.company_id = v_company and e.archived_at is null
         and public._hr_leave_can_see_employee(v_company, e.id)
    ), bal as (
      select v.id as employee_id, v.department_id, v.department_name,
             (b->>'leave_type_id')::uuid as leave_type_id,
             b->>'type_code' as type_code, b->>'type_name' as type_name,
             (b->>'total_days')::int as total_days,
             (b->>'used_days')::int as used_days,
             (b->>'remaining_days')::int as remaining_days
        from vis v
       cross join lateral
         jsonb_array_elements(public.hr_leave_balances_list(v.id, v_year)->'rows') as b
    ), use_rows as (
      select e.id as employee_id, e.department_id, coalesce(d.name, 'بلا قسم') as department_name,
             r.leave_type_id, t.code as type_code, t.name_ar as type_name,
             null::int as total_days, null::int as used_days, null::int as remaining_days,
             (least(r.end_date, v_to) - greatest(r.start_date, v_from) + 1) as approved_days_in_range,
             1 as approved_requests_in_range, 0 as pending_requests_in_range
        from public.hr_leave_requests r
        join public.hr_employees e on e.id = r.employee_id
        left join public.hr_departments d on d.id = e.department_id
        join public.hr_leave_types t on t.id = r.leave_type_id
       where r.company_id = v_company and r.status = 'approved'
         and r.start_date <= v_to and r.end_date >= v_from
         and e.archived_at is null
         and public._hr_leave_can_see_employee(v_company, e.id)
    ), pend_rows as (
      select e.id as employee_id, e.department_id, coalesce(d.name, 'بلا قسم') as department_name,
             r.leave_type_id, t.code as type_code, t.name_ar as type_name,
             null::int as total_days, null::int as used_days, null::int as remaining_days,
             0 as approved_days_in_range,
             0 as approved_requests_in_range, 1 as pending_requests_in_range
        from public.hr_leave_requests r
        join public.hr_employees e on e.id = r.employee_id
        left join public.hr_departments d on d.id = e.department_id
        join public.hr_leave_types t on t.id = r.leave_type_id
       where r.company_id = v_company and r.status = 'pending'
         and r.start_date <= v_to and r.end_date >= v_from
         and e.archived_at is null
         and public._hr_leave_can_see_employee(v_company, e.id)
    ), combined as (
      select employee_id, department_id, department_name, leave_type_id, type_code, type_name,
             total_days, used_days, remaining_days,
             0 as approved_days_in_range, 0 as approved_requests_in_range, 0 as pending_requests_in_range
        from bal
       union all
      select employee_id, department_id, department_name, leave_type_id, type_code, type_name,
             total_days, used_days, remaining_days,
             approved_days_in_range, approved_requests_in_range, pending_requests_in_range
        from use_rows
       union all
      select employee_id, department_id, department_name, leave_type_id, type_code, type_name,
             total_days, used_days, remaining_days,
             approved_days_in_range, approved_requests_in_range, pending_requests_in_range
        from pend_rows
    ), agg as (
      select department_id, department_name, leave_type_id, type_code, type_name,
             count(distinct employee_id)::bigint as employees_count,
             sum(total_days)::bigint as total_days,
             sum(used_days)::bigint as used_days,
             sum(remaining_days)::bigint as remaining_days,
             coalesce(sum(approved_days_in_range), 0)::bigint as approved_days_in_range,
             coalesce(sum(approved_requests_in_range), 0)::bigint as approved_requests_in_range,
             coalesce(sum(pending_requests_in_range), 0)::bigint as pending_requests_in_range
        from combined
       group by department_id, department_name, leave_type_id, type_code, type_name
    )
    select jsonb_build_object(
      'from', v_from, 'to', v_to, 'generated_at', now(), 'available', true, 'year', v_year,
      'rows', coalesce((select jsonb_agg(jsonb_build_object(
          'department_id', s.department_id, 'department_name', s.department_name,
          'leave_type_id', s.leave_type_id, 'type_code', s.type_code, 'type_name', s.type_name,
          'employees_count', s.employees_count,
          'total_days', s.total_days, 'used_days', s.used_days, 'remaining_days', s.remaining_days,
          'approved_days_in_range', s.approved_days_in_range,
          'approved_requests_in_range', s.approved_requests_in_range,
          'pending_requests_in_range', s.pending_requests_in_range)
        order by s.department_name, s.type_name) from agg s), '[]'::jsonb),
      'total', (select count(*) from agg),
      'totals', jsonb_build_object(
        'employees_count', (select count(distinct employee_id) from combined),
        'total_days', (select sum(total_days) from combined),
        'used_days', (select sum(used_days) from combined),
        'remaining_days', (select sum(remaining_days) from combined),
        'approved_days_in_range', (select coalesce(sum(approved_days_in_range), 0) from combined),
        'approved_requests_in_range', (select coalesce(sum(approved_requests_in_range), 0) from combined),
        'pending_requests_in_range', (select coalesce(sum(pending_requests_in_range), 0) from combined))));
end $$;
comment on function public.hr_reports_leave(date, date) is
  '157: تقرير الإجازات حسب النوع والقسم — أرصدة سنة p_from من hr_leave_balances_list (154) + أيام الطلبات المعتمَدة المتداخلة مع الفترة؛ القسم غير مفعّل → available=false.';

-- 3.4) التذاكر حسب الموظف والقسم — تجميع الأقسام والإجماليات وتفصيل غير
--      المرتبطة من hr_department_ticket_stats (156) كما هي، وصف كل موظف
--      ظاهر من hr_employee_ticket_stats (156)؛ وبلا حساب مرتبط يظهر
--      linked=false وأصفارًا. القسم المصدر (hr_employees) غير مفعّل →
--      available=false.
create or replace function public.hr_reports_tickets(p_from date default null,
                                                    p_to date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  v_from    date := coalesce(p_from, date_trunc('month', current_date)::date);
  v_to      date := coalesce(p_to, current_date);
  v_dept    jsonb;
begin
  v_company := public._hr_gate('hr_reports', false);
  if not public._hr_has_permission(v_company, 'hr.reports.view') then
    raise exception 'لا تملك صلاحية عرض تقارير الموارد البشرية' using errcode = '42501';
  end if;
  if v_from > v_to then
    raise exception 'النافذة معكوسة' using errcode = '22023';
  end if;
  if (v_to - v_from) > 366 then
    raise exception 'النافذة أطول من 366 يومًا' using errcode = '22023';
  end if;
  if not public._hr_entitled(v_company, 'hr_employees', false) then
    return jsonb_build_object(
      'from', v_from, 'to', v_to, 'generated_at', now(), 'available', false,
      'reason', 'قسم الموظفين غير مفعّل لشركتك',
      'rows', '[]'::jsonb, 'total', 0,
      'department_rows', '[]'::jsonb, 'department_total', 0,
      'totals', null, 'unlinked', null,
      'employees_linked', 0, 'employees_unlinked', 0);
  end if;
  v_dept := public.hr_department_ticket_stats(v_from, v_to);
  return (
    with vis as (
      select e.id, e.full_name, e.employee_number, e.department_id,
             coalesce(d.name, 'بلا قسم') as department_name,
             e.user_id is not null as linked
        from public.hr_employees e
        left join public.hr_departments d on d.id = e.department_id
       where e.company_id = v_company and e.archived_at is null
         and public._hr_tickets_can_see_employee(v_company, e.id)
    ), per_emp as (
      select v.id as employee_id, v.full_name as employee_name, v.employee_number,
             v.department_id, v.department_name, v.linked,
             (s.stats->>'assigned_in_window')::bigint as assigned_in_window,
             (s.stats->>'open_now')::bigint as open_now,
             (s.stats->>'in_progress_now')::bigint as in_progress_now,
             (s.stats->>'resolved_in_window')::bigint as resolved_in_window,
             (s.stats->>'resolved_total')::bigint as resolved_total,
             (s.stats->>'rejected_in_window')::bigint as rejected_in_window,
             (s.stats->>'tickets_with_response')::bigint as tickets_with_response,
             (s.stats->>'first_response_rate')::numeric as first_response_rate,
             (s.stats->>'avg_first_response_seconds')::bigint as avg_first_response_seconds,
             (s.stats->>'median_first_response_seconds')::bigint as median_first_response_seconds,
             (s.stats->>'avg_resolution_seconds')::bigint as avg_resolution_seconds,
             (s.stats->>'median_resolution_seconds')::bigint as median_resolution_seconds
        from vis v
       cross join lateral
         (select public.hr_employee_ticket_stats(v.id, v_from, v_to) as stats) s
    )
    select jsonb_build_object(
      'from', v_from, 'to', v_to, 'generated_at', now(), 'available', true,
      'rows', coalesce((select jsonb_agg(jsonb_build_object(
          'employee_id', s.employee_id, 'employee_name', s.employee_name,
          'employee_number', s.employee_number,
          'department_id', s.department_id, 'department_name', s.department_name,
          'linked', s.linked,
          'assigned_in_window', s.assigned_in_window, 'open_now', s.open_now,
          'in_progress_now', s.in_progress_now,
          'resolved_in_window', s.resolved_in_window, 'resolved_total', s.resolved_total,
          'rejected_in_window', s.rejected_in_window,
          'tickets_with_response', s.tickets_with_response,
          'first_response_rate', s.first_response_rate,
          'avg_first_response_seconds', s.avg_first_response_seconds,
          'median_first_response_seconds', s.median_first_response_seconds,
          'avg_resolution_seconds', s.avg_resolution_seconds,
          'median_resolution_seconds', s.median_resolution_seconds)
        order by s.assigned_in_window desc, s.employee_name) from per_emp s), '[]'::jsonb),
      'total', (select count(*) from per_emp),
      'department_rows', coalesce(v_dept->'rows', '[]'::jsonb),
      'department_total', coalesce((v_dept->>'total')::int, 0),
      'totals', v_dept->'totals',
      'unlinked', v_dept->'unlinked',
      'employees_linked', (select count(*) from per_emp where linked),
      'employees_unlinked', (select count(*) from per_emp where not linked)));
end $$;
comment on function public.hr_reports_tickets(date, date) is
  '157: تقرير التذاكر حسب الموظف والقسم — صفوف الموظفين من hr_employee_ticket_stats (156) + الأقسام والإجماليات من hr_department_ticket_stats (156)؛ بلا حساب مرتبط linked=false.';

-- ============================================================================
-- 4) الصلاحيات — على نمط 154 §9: العامة للشركات عبر جلسة موثقة،
--    والداخلية _hr_reports_* مغلقة تمامًا. بلا جداول جديدة وبلا مفاتيح
--    كتالوج جديدة (hr.reports.view من 143) فلا RLS هنا.
-- ============================================================================
do $$
declare f text;
begin
  foreach f in array array[
    'public._hr_reports_dept_scope(uuid)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
  foreach f in array array[
    'public.hr_reports_headcount(date,date)',
    'public.hr_reports_attendance(date,date)',
    'public.hr_reports_leave(date,date)',
    'public.hr_reports_tickets(date,date)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

-- ============================================================================
-- 5) تحقق ذاتي (على نمط 154 §10): كل دالة موجودة وممنوحة، والداخلية
--    مغلقة، ومفتاح الكتالوج hr.reports.view ما زال 18 مفتاح hr.*، ومفتاح
--    الميزة hr_reports موجود (من 143)، و_hr_has_permission تحمل
--    hr.reports.view.
-- ============================================================================
do $$
declare
  v_funcs text[] := array[
    'public.hr_reports_headcount(date,date)',
    'public.hr_reports_attendance(date,date)',
    'public.hr_reports_leave(date,date)',
    'public.hr_reports_tickets(date,date)'];
  f text;
begin
  foreach f in array v_funcs loop
    if to_regprocedure(f) is null then
      raise exception '157: الدالة % غائبة', f;
    end if;
    if not has_function_privilege('authenticated', f::regprocedure, 'EXECUTE') then
      raise exception '157: الدالة % غير ممنوحة لـ authenticated', f;
    end if;
  end loop;
  if to_regprocedure('public._hr_reports_dept_scope(uuid)') is null then
    raise exception '157: الدالة الداخلية _hr_reports_dept_scope غائبة';
  end if;
  if has_function_privilege('authenticated', 'public._hr_reports_dept_scope(uuid)'::regprocedure, 'EXECUTE') then
    raise exception '157: الدالة الداخلية _hr_reports_dept_scope ممنوحة خطأً لـ authenticated';
  end if;
  if (select count(*) from public.company_permission_catalog where key like 'hr.%') <> 18 then
    raise exception '157: مفاتيح hr.* في الكتالوج يجب أن تبقى 18 (بلا مفتاح جديد في 157)';
  end if;
  if (select count(*) from public.feature_flags where key = 'hr_reports') <> 1 then
    raise exception '157: مفتاح hr_reports غائب من feature_flags (يلزم 143)';
  end if;
  if position('hr.reports.view' in pg_get_functiondef('public._hr_has_permission(uuid,text)'::regprocedure)) = 0 then
    raise exception '157: _hr_has_permission بلا hr.reports.view';
  end if;
  raise notice '157: تقارير الموارد البشرية — العدد والحضور والإجازات والتذاكر — جاهزة (تجميع 154/155/156، بلا جداول جديدة؛ مطفأة تجاريًا حتى يفعّلها المالك لكل شركة)';
end $$;
