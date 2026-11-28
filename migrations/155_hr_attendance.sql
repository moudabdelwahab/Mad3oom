-- ============================================================================
-- 155_hr_attendance.sql — وحدة الموارد البشرية، المرحلة 7 (القسم 2): الحضور والانصراف
--   (تصميم docs/hr-design.md §8.1 المرحلة 7 — الورديات وسجلات الحضور فقط؛
--   المستندات والتقييم وقرارات الإدارة ليست في هذا القسم، وتبقى لعمل لاحق).
--
--   • جداول public.hr_* جديدة: hr_shifts وhr_shift_assignments
--     وhr_attendance — RLS مفعّلة + كل الصلاحيات مسحوبة + سياسة
--     gate_account_active التقييدية الوحيدة (نمط 143 §6).
--   • التفعيل ثلاثي عبر _hr_gate('hr_attendance', ...) من 143: مفتاح المنصة
--     hr_module_enabled + استحقاق الشركة 'hr' + مفتاح القسم 'hr_attendance'
--     (الباقة أو تجاوز المالك) — لا مستوى وحده يكفي (القرار 3).
--   • مفاتيح الصلاحية: hr.attendance.view وhr.attendance.manage موجودان من
--     143؛ ويُضاف هنا hr.attendance.checkin (تسجيل الحضور/الانصراف عن النفس
--     للموظف المرتبط)؛ _hr_has_permission يُمدَّد بفرع ذاتي له على نمط
--     hr.self.view، وبقية المصفوفة حرفيًا كما في 154.
--   • وقت الخادم فقط: تاريخ ووقت الحضور من ساعة قاعدة البيانات (now() /
--     CURRENT_DATE) — لا يُقبل أي وقت من العميل إطلاقًا (درس emp_ops).
--   • سجل واحد لكل موظف في اليوم: UNIQUE(company_id, employee_id,
--     work_date)؛ تسجيل دخول ثانٍ في اليوم نفسه خطأ، وخروج بلا دخول خطأ.
--   • التأخير: الدخول بعد بداية الوردية + فترة سماح (افتراضي 15 دقيقة،
--     قابلة للضبط لكل وردية) = late؛ والدخول قبل البداية مسموح ويُحسب
--     present. الغياب مشتق لا مخزَّن: يوم عمل بلا سجل وبلا إجازة معتمَدة.
--   • الوردية السارية ليوم: آخر إسناد effective_from <= اليوم؛ وردية
--     مؤرشفة تتوقف عن السريان ولا تمسّ السجلات القائمة (تحتفظ بـ shift_id).
--   • بلا وردية مسندة: الدخول مسموح ويُحسب present (بلا تقييم تأخير).
--   • يوم الإجازة المعتمَدة (154) لا يُحسب غيابًا في الملخص — يُعدّ on_leave.
--   • الخروج يغلق آخر سجل مفتوح للموظف (اليوم عادةً؛ وإن تُرك سجل الأمس
--     مفتوحًا أُغلق هو أولًا)؛ وworked_minutes تُحسب خادمًا عند الخروج.
--   • لا دمج مع emp_ops إطلاقًا (قرار محمود 1) — نظام شركات جديد مستقل؛
--     دروس emp_ops المستعارة: وقت الخادم، وسقف الدقيقة، لا غير.
--
--   يعتمد على 143 (البوابة والصلاحيات والتدقيق وhr_employees وhr_audit_logs)
--   وعلى 154 (جدول hr_leave_requests لاستثناء أيام الإجازة المعتمَدة من
--   الغياب في الملخص). قابل لإعادة التشغيل.
--   التراجع: migrations/_rollback/155_hr_attendance.down.sql
-- ============================================================================

-- ============================================================================
-- 0) المتطلبات
-- ============================================================================
do $$
begin
  if to_regprocedure('public._hr_gate(text,boolean)') is null then
    raise exception '155: يلزم الترحيل 143 أولًا (_hr_gate غائبة)';
  end if;
  if to_regclass('public.hr_employees') is null then
    raise exception '155: يلزم الترحيل 143 أولًا (hr_employees غائب)';
  end if;
  if to_regclass('public.hr_leave_requests') is null then
    raise exception '155: يلزم الترحيل 154 أولًا (hr_leave_requests غائب)';
  end if;
  if to_regprocedure('public.hr_shifts_list(boolean)') is not null then
    raise notice '155: أُعيد التطبيق — الكائنات موجودة أصلًا';
  end if;
end $$;

-- ============================================================================
-- 1) مفتاح الصلاحية hr.attendance.checkin في الكتالوج (نمط hr.leave.request
--    في 154). مفتاح ذاتي: لا يُمنح افتراضيًا لأي دور — يُشتق من الربط.
-- ============================================================================
insert into public.company_permission_catalog (key, label_ar, description_ar, default_supervisor, default_agent, sort) values
  ('hr.attendance.checkin', 'تسجيل الحضور والانصراف عن النفس', 'تسجيل الحضور والانصراف عن النفس للموظف المرتبط بحساب (المرحلة 7).', false, false, 342)
on conflict (key) do update set label_ar = excluded.label_ar, description_ar = excluded.description_ar,
  default_supervisor = excluded.default_supervisor, default_agent = excluded.default_agent, sort = excluded.sort;

-- ============================================================================
-- 2) _hr_has_permission: فرع ذاتي لـ hr.attendance.checkin + مفاتيح
--    hr.attendance.* في مصفوفة الأدوار؛ بقية المصفوفة حرفيًا كما في 154.
--    - hr_manager / hr_officer: view + manage + checkin (على مستوى الشركة).
--    - dept_manager: view فقط داخل نطاقه؛ وتسجيله عن نفسه عبر الفرع الذاتي.
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

-- ============================================================================
-- 3) الجداول
-- ============================================================================

-- 3.1) hr_shifts — ورديات الشركة. working_days مصفوفة أيام أسبوع بأرقام
--     Postgres (dow: 0=الأحد … 6=السبت)؛ الافتراضي أحد–خميس {0,1,2,3,4}.
--     لا ورديات ليلية عابرة لمنتصف الليل في هذا القسم (end_time > start_time).
create table if not exists public.hr_shifts (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  name          text not null check (char_length(btrim(name)) between 2 and 120),
  start_time    time not null,
  end_time      time not null check (end_time > start_time),
  working_days  smallint[] not null default '{0,1,2,3,4}'
    check (cardinality(working_days) between 1 and 7
           and working_days <@ array[0,1,2,3,4,5,6]::smallint[]),
  grace_minutes integer not null default 15 check (grace_minutes between 0 and 120),
  is_active     boolean not null default true,
  sort_order    integer not null default 0,
  created_by    uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
comment on table public.hr_shifts is
  '155: ورديات الشركة. working_days بأرقام dow (0=الأحد)؛ grace_minutes فترة سماح التأخير بالدقائق؛ end_time > start_time (بلا ورديات ليلية في هذا القسم).';

-- 3.2) hr_shift_assignments — إسناد موظف لوردية سارٍ من تاريخ. الإسناد
--     الساري ليوم هو آخر effective_from <= اليوم؛ والتاريخ نفسه فريد للموظف.
create table if not exists public.hr_shift_assignments (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id) on delete cascade,
  employee_id    uuid not null references public.hr_employees(id) on delete cascade,
  shift_id       uuid not null references public.hr_shifts(id) on delete cascade,
  effective_from date not null,
  created_by     uuid,
  created_at     timestamptz not null default now()
);
comment on table public.hr_shift_assignments is
  '155: إسناد وردية لموظف من تاريخ سريان. آخر إسناد سارٍ هو الفعّال لليوم؛ وحذف الوردية يسقط إسناداتها (لا سجلات الحضور).';

-- 3.3) hr_attendance — سجل حضور يومي واحد لكل موظف. status مخزَّن
--     present/late فقط؛ الغياب مشتق في الملخص لا يُخزَّن. work_date تاريخ
--     الدخول بساعة الخادم؛ وcheck_in_at/check_out_at طوابع ساعة الخادم.
create table if not exists public.hr_attendance (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id) on delete cascade,
  employee_id    uuid not null references public.hr_employees(id) on delete cascade,
  work_date      date not null,
  check_in_at    timestamptz not null,
  check_out_at   timestamptz check (check_out_at is null or check_out_at >= check_in_at),
  status         text not null default 'present' check (status in ('present', 'late')),
  shift_id       uuid references public.hr_shifts(id) on delete set null,
  worked_minutes integer check (worked_minutes is null or worked_minutes >= 0),
  note           text check (note is null or char_length(note) <= 1000),
  created_by     uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
comment on table public.hr_attendance is
  '155: سجل حضور يومي. سجل واحد لكل موظف في اليوم (قيد فريد)؛ status = present/late عند الدخول؛ worked_minutes تُحسب عند الخروج؛ الغياب مشتق في الملخص.';

-- ============================================================================
-- 4) الفهارس — جزء من تعريف الجداول.
-- ============================================================================
create unique index if not exists hr_shifts_company_name_uidx
  on public.hr_shifts (company_id, name);
create index if not exists hr_shifts_company_active_idx
  on public.hr_shifts (company_id, is_active);

create unique index if not exists hr_shift_assignments_company_emp_from_uidx
  on public.hr_shift_assignments (company_id, employee_id, effective_from);
create index if not exists hr_shift_assignments_company_emp_idx
  on public.hr_shift_assignments (company_id, employee_id, effective_from desc);

create unique index if not exists hr_attendance_company_emp_date_uidx
  on public.hr_attendance (company_id, employee_id, work_date);
create index if not exists hr_attendance_company_date_idx
  on public.hr_attendance (company_id, work_date desc);
create index if not exists hr_attendance_company_emp_open_idx
  on public.hr_attendance (company_id, employee_id, work_date desc) where check_out_at is null;

-- ============================================================================
-- 5) المحفّزات: لمس updated_at (إعادة استخدام _hr_touch_updated_at من 143).
-- ============================================================================
do $$
declare t text;
begin
  foreach t in array array['hr_shifts', 'hr_attendance'] loop
    execute format('drop trigger if exists trg_%I_updated_at on public.%I', t, t);
    execute format('create trigger trg_%I_updated_at before update on public.%I for each row execute function public._hr_touch_updated_at()', t, t);
  end loop;
end $$;

-- ============================================================================
-- 6) RLS — رفض افتراضي على نمط 143 §6: كل الصلاحيات مسحوبة، وسياسة
--    تقييدية واحدة gate_account_active فقط، ولا قراءة مباشرة من الواجهة.
-- ============================================================================
do $$
declare t text;
begin
  foreach t in array array['hr_shifts', 'hr_shift_assignments', 'hr_attendance'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke all on table public.%I from service_role', t);
    end if;
    execute format('drop policy if exists gate_account_active on public.%I', t);
    execute format('create policy gate_account_active on public.%I as restrictive for all to authenticated '
                   'using (public.account_is_active()) with check (public.account_is_active())', t);
  end loop;
end $$;

-- ============================================================================
-- 7) الدوال الداخلية _hr_attendance_* — بلا GRANT إطلاقًا (تُسحب في فقرة 10).
-- ============================================================================

-- 7.1) الوردية السارية لموظف في تاريخ: آخر إسناد effective_from <= التاريخ
--     وورديته نشطة؛ وبلا إسناد (أو وردية مؤرشفة) ترجع NULL — والدخول يبقى
--     مسموحًا بلا تقييم تأخير.
create or replace function public._hr_attendance_shift_for(p_company uuid, p_employee_id uuid, p_date date)
returns public.hr_shifts
language sql
stable
security definer
set search_path to 'public'
as $$
  select sh.*
    from public.hr_shift_assignments a
    join public.hr_shifts sh on sh.id = a.shift_id
   where a.company_id = p_company and a.employee_id = p_employee_id
     and a.effective_from <= p_date and sh.is_active
     and sh.company_id = p_company
   order by a.effective_from desc
   limit 1;
$$;

-- 7.2) حالة الدخول: late إن تجاوز وقت الدخول بداية الوردية + السماح؛
--     وبلا وردية (start_time NULL) present دائمًا.
create or replace function public._hr_attendance_status(p_check_in timestamptz, p_start_time time, p_grace_minutes integer)
returns text
language sql
immutable
set search_path to 'public'
as $$
  select case
           when p_start_time is null then 'present'
           when p_check_in::time > p_start_time + make_interval(mins => coalesce(p_grace_minutes, 15))
             then 'late'
           else 'present'
         end;
$$;

-- 7.3) حلّ الموظف المستهدف: صريح أو ملف المتصل نفسه؛ وبلا أيٍّ منهما خطأ.
create or replace function public._hr_attendance_target(p_company uuid, p_employee_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare v_emp uuid;
begin
  v_emp := coalesce(p_employee_id, public._hr_my_employee_id(p_company));
  if v_emp is null then
    raise exception 'حدّد الموظف' using errcode = '22023';
  end if;
  return v_emp;
end $$;

-- 7.4) هل يرى المتصل هذا الموظف في سياق الحضور؟ مالك الشركة، أو حامل
--     hr.attendance.view داخل نطاقه، أو المدير المباشر، أو الموظف نفسه.
create or replace function public._hr_attendance_can_see_employee(p_company uuid, p_employee_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_wide boolean;
  v_my   uuid;
  v_scope uuid;
begin
  if not exists (select 1 from public.hr_employees e
                  where e.id = p_employee_id and e.company_id = p_company) then
    return false;
  end if;
  if public._hr_is_company_admin(p_company) then
    return true;
  end if;
  v_my := public._hr_my_employee_id(p_company);
  v_scope := public._hr_dept_scope(p_company);
  select exists (select 1 from public.hr_role_assignments r
                  where r.company_id = p_company and r.user_id = auth.uid()
                    and r.revoked_at is null and r.role in ('hr_manager', 'hr_officer'))
    into v_wide;
  if public._hr_has_permission(p_company, 'hr.attendance.view')
     and (v_wide or v_scope is null
          or exists (select 1 from public.hr_employees e
                      where e.id = p_employee_id
                        and (e.department_id = v_scope or e.manager_employee_id = v_my))) then
    return true;
  end if;
  return exists (select 1 from public.hr_employees e
                  where e.id = p_employee_id
                    and (e.manager_employee_id = v_my or e.id = v_my));
end $$;

-- ============================================================================
-- 8) RPCs الشركة — الحضور والانصراف (التصميم §5.1 نمطًا)
--    كلها SECURITY DEFINER، والشركة من current_company_id() لا من معامل،
--    والبوابة _hr_gate('hr_attendance', ...) أولًا ثم فحص الصلاحية.
-- ============================================================================

-- 8.1) قائمة الورديات: مغلف {rows, total} لا مصفوفة عارية (درس 143).
create or replace function public.hr_shifts_list(p_include_inactive boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
begin
  v_company := public._hr_gate('hr_attendance', false);
  if not public._hr_has_permission(v_company, 'hr.attendance.view') then
    raise exception 'لا تملك صلاحية عرض الحضور' using errcode = '42501';
  end if;
  return (select jsonb_build_object(
      'rows', coalesce(jsonb_agg(jsonb_build_object(
          'id', s.id, 'name', s.name,
          'start_time', s.start_time, 'end_time', s.end_time,
          'working_days', s.working_days, 'grace_minutes', s.grace_minutes,
          'is_active', s.is_active, 'sort_order', s.sort_order,
          'assignments_count', (select count(*) from public.hr_shift_assignments a
                                 where a.company_id = v_company and a.shift_id = s.id),
          'created_at', s.created_at) order by s.sort_order, s.name), '[]'::jsonb),
      'total', count(*))
    from public.hr_shifts s
   where s.company_id = v_company
     and (coalesce(p_include_inactive, false) or s.is_active));
end $$;
comment on function public.hr_shifts_list(boolean) is
  '155: قائمة ورديات الشركة {rows, total} مع عدد المسندين لكل وردية.';

-- 8.2) إنشاء وردية: الاسم فريد داخل الشركة؛ والنهاية بعد البداية.
create or replace function public.hr_shift_create(p_name text, p_start_time time, p_end_time time,
                                                 p_working_days smallint[] default null,
                                                 p_grace_minutes integer default 15,
                                                 p_sort_order integer default 0)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  v_name    text := btrim(coalesce(p_name, ''));
  v_days    smallint[] := coalesce(p_working_days, array[0,1,2,3,4]::smallint[]);
  v_grace   int := coalesce(p_grace_minutes, 15);
  v_id      uuid;
begin
  v_company := public._hr_gate('hr_attendance', true);
  if not public._hr_has_permission(v_company, 'hr.attendance.manage') then
    raise exception 'لا تملك صلاحية إدارة الحضور' using errcode = '42501';
  end if;
  if char_length(v_name) < 2 or char_length(v_name) > 120 then
    raise exception 'اسم الوردية بين حرفين و120 حرفًا' using errcode = '22023';
  end if;
  if p_start_time is null or p_end_time is null then
    raise exception 'حدّد وقتي بداية الوردية ونهايتها' using errcode = '22023';
  end if;
  if p_end_time <= p_start_time then
    raise exception 'وقت نهاية الوردية يجب أن يكون بعد وقت بدايتها (بلا ورديات ليلية في هذا القسم)' using errcode = '22023';
  end if;
  if cardinality(v_days) < 1 or cardinality(v_days) > 7
     or exists (select 1 from unnest(v_days) d where d < 0 or d > 6) then
    raise exception 'أيام العمل أرقام بين 0 (الأحد) و6 (السبت)' using errcode = '22023';
  end if;
  if v_grace < 0 or v_grace > 120 then
    raise exception 'فترة السماح بين 0 و120 دقيقة' using errcode = '22023';
  end if;
  begin
    insert into public.hr_shifts (company_id, name, start_time, end_time, working_days, grace_minutes, sort_order, created_by)
    values (v_company, v_name, p_start_time, p_end_time, v_days, v_grace, coalesce(p_sort_order, 0), auth.uid())
    returning id into v_id;
  exception when unique_violation then
    raise exception 'اسم الوردية مستخدم بالفعل في شركتك' using errcode = '23505';
  end;
  perform public._hr_audit(v_company, 'attendance.shift.created', 'shift', v_id, null, null,
    jsonb_build_object('name', v_name, 'start_time', p_start_time, 'end_time', p_end_time,
      'working_days', v_days, 'grace_minutes', v_grace), null);
  return jsonb_build_object('id', v_id, 'name', v_name, 'start_time', p_start_time,
    'end_time', p_end_time, 'working_days', v_days, 'grace_minutes', v_grace, 'is_active', true);
end $$;

-- 8.3) تعديل وردية: NULL تعني «بلا تغيير». تغيير البداية/السماح لا يمسّ
--     حالات سجلات سابقة (لقطات) — يسري على تسجيلات جديدة فقط.
create or replace function public.hr_shift_update(p_shift_id uuid, p_name text default null,
                                                 p_start_time time default null, p_end_time time default null,
                                                 p_working_days smallint[] default null,
                                                 p_grace_minutes integer default null,
                                                 p_is_active boolean default null,
                                                 p_sort_order integer default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  s         public.hr_shifts;
  v_name    text;
  v_start   time;
  v_end     time;
  v_days    smallint[];
  v_grace   int;
  v_active  boolean;
  v_sort    int;
begin
  v_company := public._hr_gate('hr_attendance', true);
  if not public._hr_has_permission(v_company, 'hr.attendance.manage') then
    raise exception 'لا تملك صلاحية إدارة الحضور' using errcode = '42501';
  end if;
  select * into s from public.hr_shifts where id = p_shift_id and company_id = v_company;
  if not found then
    raise exception 'الوردية غير موجودة' using errcode = 'P0002';
  end if;
  v_name := case when p_name is null then s.name else btrim(p_name) end;
  v_start := coalesce(p_start_time, s.start_time);
  v_end := coalesce(p_end_time, s.end_time);
  v_days := coalesce(p_working_days, s.working_days);
  v_grace := coalesce(p_grace_minutes, s.grace_minutes);
  v_active := coalesce(p_is_active, s.is_active);
  v_sort := coalesce(p_sort_order, s.sort_order);
  if char_length(v_name) < 2 or char_length(v_name) > 120 then
    raise exception 'اسم الوردية بين حرفين و120 حرفًا' using errcode = '22023';
  end if;
  if v_end <= v_start then
    raise exception 'وقت نهاية الوردية يجب أن يكون بعد وقت بدايتها (بلا ورديات ليلية في هذا القسم)' using errcode = '22023';
  end if;
  if cardinality(v_days) < 1 or cardinality(v_days) > 7
     or exists (select 1 from unnest(v_days) d where d < 0 or d > 6) then
    raise exception 'أيام العمل أرقام بين 0 (الأحد) و6 (السبت)' using errcode = '22023';
  end if;
  if v_grace < 0 or v_grace > 120 then
    raise exception 'فترة السماح بين 0 و120 دقيقة' using errcode = '22023';
  end if;
  begin
    update public.hr_shifts set
      name = v_name, start_time = v_start, end_time = v_end, working_days = v_days,
      grace_minutes = v_grace, is_active = v_active, sort_order = v_sort
    where id = s.id;
  exception when unique_violation then
    raise exception 'اسم الوردية مستخدم بالفعل في شركتك' using errcode = '23505';
  end;
  perform public._hr_audit(v_company, 'attendance.shift.updated', 'shift', s.id, null,
    jsonb_build_object('name', s.name, 'start_time', s.start_time, 'end_time', s.end_time,
      'working_days', s.working_days, 'grace_minutes', s.grace_minutes, 'is_active', s.is_active),
    jsonb_build_object('name', v_name, 'start_time', v_start, 'end_time', v_end,
      'working_days', v_days, 'grace_minutes', v_grace, 'is_active', v_active), null);
  return jsonb_build_object('id', s.id, 'name', v_name, 'start_time', v_start,
    'end_time', v_end, 'working_days', v_days, 'grace_minutes', v_grace, 'is_active', v_active);
end $$;

-- 8.4) إسناد وردية لموظف من تاريخ سريان (الافتراضي: اليوم بساعة الخادم).
--     نفس التاريخ مرتين يُحدَّث لا يُكرَّر.
create or replace function public.hr_shift_assign(p_employee_id uuid, p_shift_id uuid,
                                                 p_effective_from date default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  v_from    date := coalesce(p_effective_from, current_date);
  e         public.hr_employees;
  s         public.hr_shifts;
  a         public.hr_shift_assignments;
begin
  v_company := public._hr_gate('hr_attendance', true);
  if not public._hr_has_permission(v_company, 'hr.attendance.manage') then
    raise exception 'لا تملك صلاحية إدارة الحضور' using errcode = '42501';
  end if;
  select * into e from public.hr_employees where id = p_employee_id and company_id = v_company;
  if not found then
    raise exception 'الموظف غير موجود' using errcode = 'P0002';
  end if;
  if e.archived_at is not null or e.employment_status = 'terminated' then
    raise exception 'الموظف مؤرشف — لا تُسند وردية له' using errcode = '22023';
  end if;
  select * into s from public.hr_shifts where id = p_shift_id and company_id = v_company;
  if not found then
    raise exception 'الوردية غير موجودة' using errcode = 'P0002';
  end if;
  if not s.is_active then
    raise exception 'الوردية مؤرشفة — لا تُسند' using errcode = '22023';
  end if;
  insert into public.hr_shift_assignments (company_id, employee_id, shift_id, effective_from, created_by)
  values (v_company, p_employee_id, p_shift_id, v_from, auth.uid())
  on conflict (company_id, employee_id, effective_from)
    do update set shift_id = excluded.shift_id
  returning * into a;
  perform public._hr_audit(v_company, 'attendance.shift.assigned', 'shift_assignment', a.id, p_employee_id, null,
    jsonb_build_object('shift_id', p_shift_id, 'shift_name', s.name, 'effective_from', v_from), null);
  return jsonb_build_object('assignment_id', a.id, 'employee_id', p_employee_id,
    'shift_id', p_shift_id, 'shift_name', s.name, 'effective_from', v_from);
end $$;

-- 8.5) تسجيل دخول: وقت الخادم فقط؛ سجل واحد في اليوم؛ الحالة تُشتق من
--     وردية اليوم (late بعد البداية + السماح). عن النفس بمفتاح checkin،
--     وعن موظف آخر بمفتاح manage داخل نطاق المنادي.
create or replace function public.hr_attendance_check_in(p_employee_id uuid default null, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  v_emp     uuid;
  v_my      uuid;
  v_is_self boolean;
  e         public.hr_employees;
  v_date    date := current_date;
  v_now     timestamptz := now();
  v_shift   public.hr_shifts;
  v_status  text;
  v_id      uuid;
  v_note    text := nullif(btrim(coalesce(p_note, '')), '');
begin
  v_company := public._hr_gate('hr_attendance', true);
  v_emp := public._hr_attendance_target(v_company, p_employee_id);
  v_my := public._hr_my_employee_id(v_company);
  v_is_self := v_my is not null and v_my = v_emp;
  if v_is_self then
    if not public._hr_has_permission(v_company, 'hr.attendance.checkin') then
      raise exception 'لا تملك صلاحية تسجيل الحضور' using errcode = '42501';
    end if;
  elsif public._hr_has_permission(v_company, 'hr.attendance.manage')
        and public._hr_in_my_scope(v_emp) then
    null;
  else
    raise exception 'لا تملك صلاحية تسجيل حضور هذا الموظف' using errcode = '42501';
  end if;
  select * into e from public.hr_employees where id = v_emp and company_id = v_company;
  if not found then
    raise exception 'الموظف غير موجود' using errcode = 'P0002';
  end if;
  if e.archived_at is not null or e.employment_status = 'terminated' then
    raise exception 'الموظف مؤرشف — لا يُسجَّل حضور له' using errcode = '22023';
  end if;
  if exists (select 1 from public.hr_attendance a
              where a.company_id = v_company and a.employee_id = v_emp and a.work_date = v_date) then
    raise exception 'سُجل حضور هذا الموظف اليوم بالفعل' using errcode = '22023';
  end if;
  v_shift := public._hr_attendance_shift_for(v_company, v_emp, v_date);
  v_status := public._hr_attendance_status(v_now, v_shift.start_time, v_shift.grace_minutes);
  if v_note is not null and char_length(v_note) > 1000 then
    raise exception 'ملاحظة التسجيل 1000 حرف حدًا أقصى' using errcode = '22023';
  end if;
  insert into public.hr_attendance
    (company_id, employee_id, work_date, check_in_at, status, shift_id, note, created_by)
  values (v_company, v_emp, v_date, v_now, v_status,
          case when v_shift is null then null else v_shift.id end, v_note, auth.uid())
  returning id into v_id;
  perform public._hr_audit(v_company, 'attendance.check_in', 'attendance', v_id, v_emp, null,
    jsonb_build_object('work_date', v_date, 'check_in_at', v_now, 'status', v_status,
      'shift_id', case when v_shift is null then null else v_shift.id end), null);
  return jsonb_build_object('id', v_id, 'employee_id', v_emp, 'work_date', v_date,
    'check_in_at', v_now, 'check_out_at', null, 'status', v_status,
    'shift_id', case when v_shift is null then null else v_shift.id end,
    'shift_name', case when v_shift is null then null else v_shift.name end);
end $$;

-- 8.6) تسجيل خروج: يغلق آخر سجل مفتوح للموظف (اليوم عادةً)؛ وبلا سجل
--     مفتوح خطأ. worked_minutes تُحسب خادمًا من طابعي الخادم.
create or replace function public.hr_attendance_check_out(p_employee_id uuid default null, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  v_emp     uuid;
  v_my      uuid;
  v_is_self boolean;
  v_now     timestamptz := now();
  a         public.hr_attendance;
  v_minutes int;
  v_note    text := nullif(btrim(coalesce(p_note, '')), '');
begin
  v_company := public._hr_gate('hr_attendance', true);
  v_emp := public._hr_attendance_target(v_company, p_employee_id);
  v_my := public._hr_my_employee_id(v_company);
  v_is_self := v_my is not null and v_my = v_emp;
  if v_is_self then
    if not public._hr_has_permission(v_company, 'hr.attendance.checkin') then
      raise exception 'لا تملك صلاحية تسجيل الانصراف' using errcode = '42501';
    end if;
  elsif public._hr_has_permission(v_company, 'hr.attendance.manage')
        and public._hr_in_my_scope(v_emp) then
    null;
  else
    raise exception 'لا تملك صلاحية تسجيل انصراف هذا الموظف' using errcode = '42501';
  end if;
  select * into a from public.hr_attendance
   where company_id = v_company and employee_id = v_emp and check_out_at is null
   order by work_date desc limit 1 for update;
  if not found then
    raise exception 'لا يوجد تسجيل حضور مفتوح لإغلاقه' using errcode = '22023';
  end if;
  v_minutes := greatest(floor(extract(epoch from (v_now - a.check_in_at)) / 60)::int, 0);
  if v_note is not null and char_length(v_note) > 1000 then
    raise exception 'ملاحظة التسجيل 1000 حرف حدًا أقصى' using errcode = '22023';
  end if;
  update public.hr_attendance set
    check_out_at = v_now, worked_minutes = v_minutes,
    note = coalesce(v_note, note)
  where id = a.id;
  perform public._hr_audit(v_company, 'attendance.check_out', 'attendance', a.id, v_emp,
    jsonb_build_object('check_in_at', a.check_in_at, 'check_out_at', null, 'worked_minutes', null),
    jsonb_build_object('check_in_at', a.check_in_at, 'check_out_at', v_now, 'worked_minutes', v_minutes), null);
  return jsonb_build_object('id', a.id, 'employee_id', v_emp, 'work_date', a.work_date,
    'check_in_at', a.check_in_at, 'check_out_at', v_now, 'status', a.status,
    'shift_id', a.shift_id, 'worked_minutes', v_minutes);
end $$;

-- 8.7) تصحيح سجل (إدارة فقط): تعديل وقتي الدخول/الخروج بسبب موثق ≥ 10
--     أحرف؛ وتُعاد حساب الحالة من وردية يوم السجل والدقائق من الطابعين.
create or replace function public.hr_attendance_correct(p_attendance_id uuid,
                                                       p_check_in_at timestamptz default null,
                                                       p_check_out_at timestamptz default null,
                                                       p_note text default null,
                                                       p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  v_reason  text;
  a         public.hr_attendance;
  v_in      timestamptz;
  v_out     timestamptz;
  v_shift   public.hr_shifts;
  v_status  text;
  v_minutes int;
  v_note    text;
begin
  v_company := public._hr_gate('hr_attendance', true);
  if not public._hr_has_permission(v_company, 'hr.attendance.manage') then
    raise exception 'لا تملك صلاحية إدارة الحضور' using errcode = '42501';
  end if;
  v_reason := public._reason_check(p_reason);
  select * into a from public.hr_attendance where id = p_attendance_id and company_id = v_company for update;
  if not found then
    raise exception 'سجل الحضور غير موجود' using errcode = 'P0002';
  end if;
  if not public._hr_in_my_scope(a.employee_id) then
    raise exception 'سجل الحضور غير موجود' using errcode = 'P0002';
  end if;
  v_in := coalesce(p_check_in_at, a.check_in_at);
  v_out := p_check_out_at; -- NULL هنا تعني «بلا تغيير» لا «مسح الخروج»
  if p_check_out_at is null and a.check_out_at is not null then
    v_out := a.check_out_at;
  end if;
  if v_out is not null and v_out < v_in then
    raise exception 'وقت الخروج قبل وقت الدخول' using errcode = '22023';
  end if;
  if p_note is not null then
    v_note := nullif(btrim(p_note), '');
    if v_note is not null and char_length(v_note) > 1000 then
      raise exception 'ملاحظة التسجيل 1000 حرف حدًا أقصى' using errcode = '22023';
    end if;
  else
    v_note := a.note;
  end if;
  if a.shift_id is not null then
    select * into v_shift from public.hr_shifts where id = a.shift_id;
  end if;
  v_status := case when p_check_in_at is null then a.status
                   else public._hr_attendance_status(v_in, v_shift.start_time, v_shift.grace_minutes) end;
  v_minutes := case when v_out is null then null
                    else greatest(floor(extract(epoch from (v_out - v_in)) / 60)::int, 0) end;
  update public.hr_attendance set
    check_in_at = v_in, check_out_at = v_out, status = v_status,
    worked_minutes = v_minutes, note = v_note
  where id = a.id;
  perform public._hr_audit(v_company, 'attendance.corrected', 'attendance', a.id, a.employee_id,
    jsonb_build_object('check_in_at', a.check_in_at, 'check_out_at', a.check_out_at,
      'status', a.status, 'worked_minutes', a.worked_minutes),
    jsonb_build_object('check_in_at', v_in, 'check_out_at', v_out,
      'status', v_status, 'worked_minutes', v_minutes), v_reason);
  return jsonb_build_object('id', a.id, 'employee_id', a.employee_id, 'work_date', a.work_date,
    'check_in_at', v_in, 'check_out_at', v_out, 'status', v_status,
    'shift_id', a.shift_id, 'worked_minutes', v_minutes);
end $$;

-- 8.8) حالة اليوم: تاريخ ووقت الخادم + وردية المتصل اليوم + سجله اليوم
--     (أو سجل موظف يحدَّده المدير) — تغذي لوحة «تسجيل اليوم».
create or replace function public.hr_attendance_today(p_employee_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  v_emp     uuid;
  v_my      uuid;
  v_is_self boolean;
  e         public.hr_employees;
  v_shift   public.hr_shifts;
  a         public.hr_attendance;
begin
  v_company := public._hr_gate('hr_attendance', false);
  v_emp := public._hr_attendance_target(v_company, p_employee_id);
  v_my := public._hr_my_employee_id(v_company);
  v_is_self := v_my is not null and v_my = v_emp;
  if not v_is_self and not public._hr_attendance_can_see_employee(v_company, v_emp) then
    raise exception 'لا تملك صلاحية عرض حضور هذا الموظف' using errcode = '42501';
  end if;
  if not v_is_self and not public._hr_has_permission(v_company, 'hr.attendance.view')
     and not public._hr_has_permission(v_company, 'hr.attendance.checkin') then
    raise exception 'لا تملك صلاحية عرض حضور هذا الموظف' using errcode = '42501';
  end if;
  select * into e from public.hr_employees where id = v_emp and company_id = v_company;
  if not found then
    raise exception 'الموظف غير موجود' using errcode = 'P0002';
  end if;
  v_shift := public._hr_attendance_shift_for(v_company, v_emp, current_date);
  select * into a from public.hr_attendance
   where company_id = v_company and employee_id = v_emp and work_date = current_date;
  return jsonb_build_object(
    'server_date', current_date,
    'server_time', now()::time,
    'employee_id', v_emp, 'employee_name', e.full_name, 'employee_number', e.employee_number,
    'is_self', v_is_self,
    'shift', case when v_shift is null then null else jsonb_build_object(
      'id', v_shift.id, 'name', v_shift.name, 'start_time', v_shift.start_time,
      'end_time', v_shift.end_time, 'grace_minutes', v_shift.grace_minutes) end,
    'record', case when a is null then null else jsonb_build_object(
      'id', a.id, 'work_date', a.work_date, 'check_in_at', a.check_in_at,
      'check_out_at', a.check_out_at, 'status', a.status,
      'worked_minutes', a.worked_minutes, 'note', a.note) end,
    'can_check_in', a is null,
    'can_check_out', a is not null and a.check_out_at is null);
end $$;
comment on function public.hr_attendance_today(uuid) is
  '155: حالة حضور اليوم من ساعة الخادم: الوردية السارية + سجل اليوم + هل يصح الدخول/الخروج الآن.';

-- 8.9) قائمة سجلات الحضور: ترقيم خادم + فلاتر خادم، مغلف {rows, total, page,
--     page_size}. الافتراضي: الشهر الحالي حتى اليوم. من بلا hr.attendance.view
--     يرى سجلاته هو فقط (يُفرض موظفه).
create or replace function public.hr_attendance_list(p_page integer default 1, p_page_size integer default 20,
                                                    p_employee_id uuid default null,
                                                    p_start_date date default null, p_end_date date default null,
                                                    p_status text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_company  uuid;
  v_page     int := greatest(coalesce(p_page, 1), 1);
  v_size     int := least(greatest(coalesce(p_page_size, 20), 1), 100);
  v_admin    boolean;
  v_can_view boolean;
  v_self_id  uuid;
  v_scope    uuid;
  v_wide     boolean;
  v_emp      uuid := p_employee_id;
  v_start    date := coalesce(p_start_date, date_trunc('month', current_date)::date);
  v_end      date := coalesce(p_end_date, current_date);
begin
  v_company := public._hr_gate('hr_attendance', false);
  v_admin := public._hr_is_company_admin(v_company);
  v_can_view := public._hr_has_permission(v_company, 'hr.attendance.view');
  v_self_id := public._hr_my_employee_id(v_company);
  if not v_can_view and v_self_id is null then
    raise exception 'لا تملك صلاحية عرض سجلات الحضور' using errcode = '42501';
  end if;
  if p_status is not null and p_status not in ('present', 'late') then
    raise exception 'حالة غير صالحة — القائمة تعرض الحاضر والمتأخر فقط، والغياب في الملخص' using errcode = '22023';
  end if;
  if v_start > v_end then
    raise exception 'تاريخ البداية بعد تاريخ النهاية' using errcode = '22023';
  end if;
  if v_end - v_start > 366 then
    raise exception 'نطاق القائمة 366 يومًا حدًا أقصى' using errcode = '22023';
  end if;
  -- بلا عرض عام: الموظف يرى سجلاته هو فقط مهما طُلب.
  if not v_can_view then
    v_emp := v_self_id;
  end if;
  v_scope := case when v_admin then null else public._hr_dept_scope(v_company) end;
  select exists (select 1 from public.hr_role_assignments r
                  where r.company_id = v_company and r.user_id = auth.uid()
                    and r.revoked_at is null and r.role in ('hr_manager', 'hr_officer'))
    into v_wide;
  return (
    with f as (
      select a.* from public.hr_attendance a
       join public.hr_employees e on e.id = a.employee_id
       where a.company_id = v_company
         and a.work_date between v_start and v_end
         and (v_emp is null or a.employee_id = v_emp)
         and (p_status is null or a.status = p_status)
         and (v_admin
              or not v_can_view and a.employee_id = v_self_id
              or v_can_view and (v_wide or v_scope is null
                 or e.department_id = v_scope or e.manager_employee_id = v_self_id)
              or e.manager_employee_id = v_self_id)
    )
    select jsonb_build_object(
      'rows', coalesce((select jsonb_agg(jsonb_build_object(
          'id', s.id, 'employee_id', s.employee_id,
          'employee_name', s.employee_name, 'employee_number', s.employee_number,
          'work_date', s.work_date, 'check_in_at', s.check_in_at, 'check_out_at', s.check_out_at,
          'status', s.status, 'shift_id', s.shift_id, 'shift_name', s.shift_name,
          'worked_minutes', s.worked_minutes, 'note', s.note, 'created_at', s.created_at)
        order by s.work_date desc, s.check_in_at desc)
        from (select f.*,
                     (select full_name from public.hr_employees where id = f.employee_id) employee_name,
                     (select employee_number from public.hr_employees where id = f.employee_id) employee_number,
                     (select name from public.hr_shifts where id = f.shift_id) shift_name
                from f order by f.work_date desc, f.check_in_at desc limit v_size offset (v_page - 1) * v_size) s), '[]'::jsonb),
      'total', (select count(*) from f),
      'total_count', (select count(*) from f),
      'page', v_page, 'page_size', v_size));
end $$;
comment on function public.hr_attendance_list(integer, integer, uuid, date, date, text) is
  '155: قائمة سجلات حضور بترقيم وفلاتر خادمة {rows, total, page, page_size}؛ نطاق مدير القسم والمدير المباشر والذاتية في WHERE.';

-- 8.10) ملخص حضور موظف لفترة: الأيام المتوقعة من وردياته السارية وأيام
--      عملها، مقسمة حاضر/متأخر/غائب/في إجازة معتمَدة + مجموع دقائق العمل.
--      الافتراضي: الشهر الحالي حتى اليوم. الغياب مشتق هنا فقط.
create or replace function public.hr_attendance_summary(p_employee_id uuid default null,
                                                       p_start_date date default null,
                                                       p_end_date date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  v_emp     uuid;
  v_my      uuid;
  v_start   date := coalesce(p_start_date, date_trunc('month', current_date)::date);
  v_end     date := coalesce(p_end_date, current_date);
  e         public.hr_employees;
  v_present int;
  v_late    int;
  v_leave   int;
  v_expected int;
  v_minutes int;
begin
  v_company := public._hr_gate('hr_attendance', false);
  v_emp := public._hr_attendance_target(v_company, p_employee_id);
  v_my := public._hr_my_employee_id(v_company);
  if not (public._hr_has_permission(v_company, 'hr.attendance.view')
          and public._hr_attendance_can_see_employee(v_company, v_emp))
     and not (v_my is not null and v_my = v_emp) then
    raise exception 'لا تملك صلاحية عرض ملخص حضور هذا الموظف' using errcode = '42501';
  end if;
  if v_start > v_end then
    raise exception 'تاريخ البداية بعد تاريخ النهاية' using errcode = '22023';
  end if;
  if v_end - v_start > 366 then
    raise exception 'نطاق الملخص 366 يومًا حدًا أقصى' using errcode = '22023';
  end if;
  select * into e from public.hr_employees where id = v_emp and company_id = v_company;
  if not found then
    raise exception 'الموظف غير موجود' using errcode = 'P0002';
  end if;
  -- الأيام المتوقعة: كل يوم في النطاق ورديته السارية تعمل فيه.
  select count(*) into v_expected
    from generate_series(v_start, v_end, interval '1 day') gs(d)
   where exists (
     select 1 from public.hr_shift_assignments a
      join public.hr_shifts sh on sh.id = a.shift_id
      where a.company_id = v_company and a.employee_id = v_emp
        and a.effective_from <= gs.d::date and sh.is_active and sh.company_id = v_company
        and extract(dow from gs.d)::smallint = any (sh.working_days)
        and not exists ( -- إسناد أحدث يحجب الأقدم: تحقق من أن هذه الوردية هي السارية
          select 1 from public.hr_shift_assignments a2
           where a2.company_id = v_company and a2.employee_id = v_emp
             and a2.effective_from <= gs.d::date and a2.effective_from > a.effective_from));
  -- حاضر/متأخر من السجلات في النطاق؛ وفي إجازة: يوم متوقع بلا سجل تغطيه
  -- إجازة معتمَدة؛ والباقي من المتوقع غائب.
  select count(*) filter (where a.status = 'present'),
         count(*) filter (where a.status = 'late'),
         coalesce(sum(a.worked_minutes), 0)
    into v_present, v_late, v_minutes
    from public.hr_attendance a
   where a.company_id = v_company and a.employee_id = v_emp
     and a.work_date between v_start and v_end;
  select count(*) into v_leave
    from generate_series(v_start, v_end, interval '1 day') gs(d)
   where not exists (select 1 from public.hr_attendance a
                      where a.company_id = v_company and a.employee_id = v_emp
                        and a.work_date = gs.d::date)
     and exists (select 1 from public.hr_leave_requests lr
                  where lr.company_id = v_company and lr.employee_id = v_emp
                    and lr.status = 'approved'
                    and daterange(lr.start_date, lr.end_date, '[]') @> gs.d::date)
     and exists (
     select 1 from public.hr_shift_assignments a
      join public.hr_shifts sh on sh.id = a.shift_id
      where a.company_id = v_company and a.employee_id = v_emp
        and a.effective_from <= gs.d::date and sh.is_active and sh.company_id = v_company
        and extract(dow from gs.d)::smallint = any (sh.working_days)
        and not exists (
          select 1 from public.hr_shift_assignments a2
           where a2.company_id = v_company and a2.employee_id = v_emp
             and a2.effective_from <= gs.d::date and a2.effective_from > a.effective_from));
  return jsonb_build_object(
    'employee_id', v_emp, 'employee_name', e.full_name, 'employee_number', e.employee_number,
    'start_date', v_start, 'end_date', v_end,
    'expected_days', v_expected,
    'present_days', v_present,
    'late_days', v_late,
    'on_leave_days', v_leave,
    'absent_days', greatest(v_expected - v_present - v_late - v_leave, 0),
    'total_worked_minutes', v_minutes);
end $$;
comment on function public.hr_attendance_summary(uuid, date, date) is
  '155: ملخص حضور موظف لفترة: متوقع/حاضر/متأخر/غائب (مشتق)/في إجازة معتمَدة + مجموع دقائق العمل.';

-- ============================================================================
-- 9) الصلاحيات — على نمط 143 §13: العامة للشركات عبر جلسة موثقة،
--    والداخلية _hr_attendance_* مغلقة تمامًا.
-- ============================================================================
do $$
declare f text;
begin
  foreach f in array array[
    'public._hr_attendance_shift_for(uuid,uuid,date)',
    'public._hr_attendance_status(timestamp with time zone,time without time zone,integer)',
    'public._hr_attendance_target(uuid,uuid)',
    'public._hr_attendance_can_see_employee(uuid,uuid)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
  foreach f in array array[
    'public.hr_shifts_list(boolean)',
    'public.hr_shift_create(text,time without time zone,time without time zone,smallint[],integer,integer)',
    'public.hr_shift_update(uuid,text,time without time zone,time without time zone,smallint[],integer,boolean,integer)',
    'public.hr_shift_assign(uuid,uuid,date)',
    'public.hr_attendance_check_in(uuid,text)',
    'public.hr_attendance_check_out(uuid,text)',
    'public.hr_attendance_correct(uuid,timestamp with time zone,timestamp with time zone,text,text)',
    'public.hr_attendance_today(uuid)',
    'public.hr_attendance_list(integer,integer,uuid,date,date,text)',
    'public.hr_attendance_summary(uuid,date,date)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

-- ============================================================================
-- 10) تحقق ذاتي (على نمط 143 §14): كل جدول ودالة وفهرس وقيد ومفتاح.
-- ============================================================================
do $$
declare
  v_tables text[] := array['hr_shifts', 'hr_shift_assignments', 'hr_attendance'];
  v_funcs text[] := array[
    'public.hr_shifts_list(boolean)',
    'public.hr_shift_create(text,time without time zone,time without time zone,smallint[],integer,integer)',
    'public.hr_shift_update(uuid,text,time without time zone,time without time zone,smallint[],integer,boolean,integer)',
    'public.hr_shift_assign(uuid,uuid,date)',
    'public.hr_attendance_check_in(uuid,text)',
    'public.hr_attendance_check_out(uuid,text)',
    'public.hr_attendance_correct(uuid,timestamp with time zone,timestamp with time zone,text,text)',
    'public.hr_attendance_today(uuid)',
    'public.hr_attendance_list(integer,integer,uuid,date,date,text)',
    'public.hr_attendance_summary(uuid,date,date)'];
  t text;
  f text;
begin
  foreach t in array v_tables loop
    if to_regclass('public.' || t) is null then
      raise exception '155: الجدول % غائب', t;
    end if;
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception '155: RLS غير مفعّلة على %', t;
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t
                    and policyname = 'gate_account_active') then
      raise exception '155: سياسة gate_account_active غائبة على %', t;
    end if;
  end loop;
  foreach f in array v_funcs loop
    if to_regprocedure(f) is null then
      raise exception '155: الدالة % غائبة', f;
    end if;
    if not has_function_privilege('authenticated', f::regprocedure, 'EXECUTE') then
      raise exception '155: الدالة % غير ممنوحة لـ authenticated', f;
    end if;
  end loop;
  if not exists (select 1 from pg_indexes where schemaname = 'public'
                  and indexname = 'hr_attendance_company_emp_date_uidx') then
    raise exception '155: فهرس UNIQUE(شركة، موظف، تاريخ) غائب على الحضور';
  end if;
  if not exists (select 1 from pg_indexes where schemaname = 'public'
                  and indexname = 'hr_shifts_company_name_uidx') then
    raise exception '155: فهرس UNIQUE(شركة، اسم الوردية) غائب';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_hr_attendance_updated_at') then
    raise exception '155: محفّز updated_at غائب على الحضور';
  end if;
  if (select count(*) from public.company_permission_catalog where key like 'hr.%') <> 18 then
    raise exception '155: مفاتيح hr.* في الكتالوج يجب أن تكون 18 بعد إضافة hr.attendance.checkin';
  end if;
  if (select count(*) from public.feature_flags where key = 'hr_attendance') <> 1 then
    raise exception '155: مفتاح hr_attendance غائب من feature_flags (يلزم 143)';
  end if;
  raise notice '155: الحضور والانصراف — الورديات والإسناد والتسجيل والملخص — جاهزة (مطفأة تجاريًا مع بقية HR حتى يفعّلها المالك لكل شركة)';
end $$;
