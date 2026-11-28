-- ============================================================================
-- 156_hr_tickets_link.sql — وحدة الموارد البشرية، المرحلة 3 (القسم 3):
--   ربط الموظفين بالتذاكر — إحصاءات قراءة فقط.
--
--   ما يدعمه مخطط التذاكر فعلًا (تحقَّق حيًا 2026-11-28 + مستودع):
--   • public.tickets.assigned_to uuid FK → profiles(id) (حيًا:
--     tickets_assigned_to_fkey) — هو رابط الإسناد: حساب الموظف المسندة
--     إليه التذكرة. لا يوجد أي عمود موظف/قسم على التذاكر.
--   • النطاق: scope ('company' | 'mad3oom_support') + company_id (097) —
--     إحصاءات HR تقرأ scope='company' لشركة المتصل فقط؛ تذاكر
--     mad3oom_support لا تدخل إحصاءات الشركة أبدًا.
--   • الحالات نص حر بلا CHECK حيًا؛ الكود يستعمل open وin-progress
--     وresolved وconfirmed وclosed وrejected (098/099). التصنيف دفاعي:
--     مفتوحة = open/in-progress، ومغلقة = resolved/confirmed/closed،
--     ومرفوضة = rejected، وأي حالة أخرى تُحسب في الإجمالي فقط.
--   • first_response_at (يُختم عند أول رد إداري — 034) وresolved_at
--     (يُختم عند الحل) موجودان حيًا ويدعمان متوسط/وسيط زمني الاستجابة
--     والحل على نمط company_team_performance (146) — لا حاجة لأي جدول جديد.
--
--   الجسر: hr_employees.user_id (ربط 143 hr_link_employee_account) ←→
--   tickets.assigned_to. لا جدول ربط جديد ولا عمود جديد: الموظف بلا
--   حساب مرتبط (user_id NULL) بلا إحصاءات، وتُعرض له رسالة صريحة بدل
--   أصفار موهمة. لا كتابة على أي جدول تذاكر إطلاقًا — قراءة فقط.
--
--   البوابة: _hr_gate('hr_employees', false) — لا مفتاح hr_tickets في
--   التصميم §3.2 ولا في CHECK الخاص بـ company_feature_overrides، وهذا
--   القسم يعيش في تفاصيل الموظف. الصلاحية: hr.employees.view من 143
--   (بلا مفتاح كتالوج جديد)، مع نطاق مدير القسم والمدير المباشر والذاتية
--   على نمط _hr_leave_can_see_employee من 154.
--
--   النافذة الافتراضية آخر 30 يومًا [from, to] شاملة، بحد 366 يومًا
--   (نمط 146). open_now لقطة لحظية (كل الفترات)؛ أما المُسندة خلال
--   النافذة فحسب created_at، والمحلولة خلالها فحسب resolved_at.
--   الإجماليات في hr_department_ticket_stats تغطي كل تذاكر الشركة
--   (بما فيها غير المسندة والمسندة لحساب غير مرتبط بموظف) حتى لا تضيع
--   تذكرة صامتة من التقارير.
--
--   يعتمد على 143 (البوابة والصلاحيات وhr_employees) وعلى 097
--   (tickets.company_id/scope). قابل لإعادة التشغيل.
--   التراجع: migrations/_rollback/156_hr_tickets_link.down.sql
-- ============================================================================

-- ============================================================================
-- 0) المتطلبات
-- ============================================================================
do $$
declare
  v_missing text;
begin
  if to_regprocedure('public._hr_gate(text,boolean)') is null then
    raise exception '156: يلزم الترحيل 143 أولًا (_hr_gate غائبة)';
  end if;
  if to_regclass('public.hr_employees') is null then
    raise exception '156: يلزم الترحيل 143 أولًا (hr_employees غائب)';
  end if;
  if to_regclass('public.tickets') is null then
    raise exception '156: جدول tickets غائب';
  end if;
  select string_agg(c.column_name, ', ') into v_missing
    from (values ('company_id'), ('scope'), ('assigned_to'), ('status'),
                 ('created_at'), ('first_response_at'), ('resolved_at')) as need(col)
    left join information_schema.columns c
      on c.table_schema = 'public' and c.table_name = 'tickets'
     and c.column_name = need.col
   where c.column_name is null;
  if v_missing is not null then
    raise exception '156: أعمدة ناقصة في tickets: %', v_missing;
  end if;
  if to_regprocedure('public.hr_employee_ticket_stats(uuid,date,date)') is not null then
    raise notice '156: أُعيد التطبيق — الكائنات موجودة أصلًا';
  end if;
end $$;

-- ============================================================================
-- 1) الدالة الداخلية _hr_tickets_can_see_employee — هل يرى المتصل تذاكر
--    هذا الموظف؟ مالك الشركة، أو حامل hr.employees.view داخل نطاقه
--    (مدير HR/موظف HR على مستوى الشركة؛ مدير القسم داخل قسمه فقط أو
--    لمرؤوس مباشر)، أو المدير المباشر، أو الموظف نفسه.
--    (مطابقة _hr_leave_can_see_employee من 154 مع مفتاح hr.employees.view.)
-- ============================================================================
create or replace function public._hr_tickets_can_see_employee(p_company uuid, p_employee_id uuid)
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
  if public._hr_has_permission(p_company, 'hr.employees.view')
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
-- 2) RPCs الشركة — إحصاءات التذاكر (قراءة فقط؛ بلا أي كتابة على tickets
--    وبلا سطر تدقيق — القراءة لا تُدوَّن في 143/154 أيضًا).
--    كلها SECURITY DEFINER، والشركة من current_company_id() لا من معامل،
--    والبوابة _hr_gate('hr_employees', false) أولًا ثم فحص الرؤية.
-- ============================================================================

-- 2.1) إحصاءات موظف واحد: لقطة مفتوحة + نافذة 30 يومًا افتراضيًا +
--      متوسط/وسيط أول استجابة وحل + أحدث 5 تذاكر. بلا حساب مرتبط:
--      linked=false وكل العدّادات صفر وكل الأزمنة null (لا أصفار موهمة
--      عن نشاط — الرسالة في الواجهة).
create or replace function public.hr_employee_ticket_stats(p_employee_id uuid,
                                                          p_from date default null,
                                                          p_to date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  v_from    date := coalesce(p_from, current_date - 30);
  v_to      date := coalesce(p_to, current_date);
  v_from_ts timestamptz;
  v_to_ts   timestamptz;
  e         public.hr_employees;
  v_assigned bigint;
  v_open     bigint;
  v_in_prog  bigint;
  v_resolved bigint;
  v_res_win  bigint;
  v_rejected bigint;
  v_with_resp bigint;
  v_avg_first bigint;
  v_med_first bigint;
  v_avg_res   bigint;
  v_med_res   bigint;
begin
  v_company := public._hr_gate('hr_employees', false);
  if v_from > v_to then
    raise exception 'النافذة معكوسة' using errcode = '22023';
  end if;
  if (v_to - v_from) > 366 then
    raise exception 'النافذة أطول من 366 يومًا' using errcode = '22023';
  end if;
  v_from_ts := v_from::timestamptz;
  v_to_ts := (v_to + 1)::timestamptz;
  select * into e from public.hr_employees where id = p_employee_id and company_id = v_company;
  if not found then
    raise exception 'الموظف غير موجود' using errcode = 'P0002';
  end if;
  if not public._hr_tickets_can_see_employee(v_company, p_employee_id) then
    raise exception 'لا تملك صلاحية عرض تذاكر هذا الموظف' using errcode = '42501';
  end if;
  if e.user_id is null then
    return jsonb_build_object(
      'employee_id', e.id, 'employee_name', e.full_name, 'employee_number', e.employee_number,
      'linked', false, 'from', v_from, 'to', v_to, 'generated_at', now(),
      'assigned_in_window', 0, 'open_now', 0, 'in_progress_now', 0,
      'resolved_total', 0, 'resolved_in_window', 0, 'rejected_in_window', 0,
      'tickets_with_response', 0, 'first_response_rate', null,
      'avg_first_response_seconds', null, 'median_first_response_seconds', null,
      'avg_resolution_seconds', null, 'median_resolution_seconds', null,
      'recent_tickets', '[]'::jsonb);
  end if;
  select
    count(*) filter (where t.created_at >= v_from_ts and t.created_at < v_to_ts),
    count(*) filter (where t.status in ('open', 'in-progress')),
    count(*) filter (where t.status = 'in-progress'),
    count(*) filter (where t.status in ('resolved', 'confirmed', 'closed')),
    count(*) filter (where t.resolved_at >= v_from_ts and t.resolved_at < v_to_ts),
    count(*) filter (where t.status = 'rejected' and t.created_at >= v_from_ts and t.created_at < v_to_ts),
    count(*) filter (where t.created_at >= v_from_ts and t.created_at < v_to_ts and t.first_response_at is not null),
    round(avg(extract(epoch from (t.first_response_at - t.created_at)))
      filter (where t.created_at >= v_from_ts and t.created_at < v_to_ts and t.first_response_at is not null))::bigint,
    round(percentile_cont(0.5) within group (order by extract(epoch from (t.first_response_at - t.created_at)))
      filter (where t.created_at >= v_from_ts and t.created_at < v_to_ts and t.first_response_at is not null))::bigint,
    round(avg(extract(epoch from (t.resolved_at - t.created_at)))
      filter (where t.resolved_at >= v_from_ts and t.resolved_at < v_to_ts))::bigint,
    round(percentile_cont(0.5) within group (order by extract(epoch from (t.resolved_at - t.created_at)))
      filter (where t.resolved_at >= v_from_ts and t.resolved_at < v_to_ts))::bigint
    into v_assigned, v_open, v_in_prog, v_resolved, v_res_win, v_rejected, v_with_resp,
         v_avg_first, v_med_first, v_avg_res, v_med_res
    from public.tickets t
   where t.scope = 'company' and t.company_id = v_company and t.assigned_to = e.user_id;
  return jsonb_build_object(
    'employee_id', e.id, 'employee_name', e.full_name, 'employee_number', e.employee_number,
    'linked', true, 'from', v_from, 'to', v_to, 'generated_at', now(),
    'assigned_in_window', v_assigned, 'open_now', v_open, 'in_progress_now', v_in_prog,
    'resolved_total', v_resolved, 'resolved_in_window', v_res_win, 'rejected_in_window', v_rejected,
    'tickets_with_response', v_with_resp,
    'first_response_rate', case when v_assigned = 0 then null
      else round(100.0 * v_with_resp / v_assigned, 1) end,
    'avg_first_response_seconds', v_avg_first, 'median_first_response_seconds', v_med_first,
    'avg_resolution_seconds', v_avg_res, 'median_resolution_seconds', v_med_res,
    'recent_tickets', coalesce((select jsonb_agg(jsonb_build_object(
        'id', s.id, 'ticket_number', s.ticket_number, 'title', s.title,
        'status', s.status, 'priority', s.priority, 'category', s.category,
        'created_at', s.created_at, 'first_response_at', s.first_response_at,
        'resolved_at', s.resolved_at) order by s.created_at desc)
      from (select t.* from public.tickets t
             where t.scope = 'company' and t.company_id = v_company and t.assigned_to = e.user_id
             order by t.created_at desc limit 5) s), '[]'::jsonb));
end $$;
comment on function public.hr_employee_ticket_stats(uuid, date, date) is
  '156: إحصاءات تذاكر موظف (قراءة فقط عبر user_id ←→ tickets.assigned_to، نطاق company فقط): مفتوحة الآن + نافذة 30 يومًا + متوسط/وسيط أول استجابة وحل + أحدث 5 تذاكر. بلا حساب مرتبط linked=false.';

-- 2.2) قائمة تذاكر موظف: ترقيم خادم + فلتر حزمة حالة (open/resolved/
--      rejected)، مغلف {rows, total, page, page_size}.
create or replace function public.hr_employee_tickets_list(p_employee_id uuid,
                                                          p_page integer default 1,
                                                          p_page_size integer default 20,
                                                          p_status text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  v_page    int := greatest(coalesce(p_page, 1), 1);
  v_size    int := least(greatest(coalesce(p_page_size, 20), 1), 100);
  e         public.hr_employees;
begin
  v_company := public._hr_gate('hr_employees', false);
  if p_status is not null and p_status not in ('open', 'resolved', 'rejected') then
    raise exception 'حزمة حالة غير صالحة (open أو resolved أو rejected)' using errcode = '22023';
  end if;
  select * into e from public.hr_employees where id = p_employee_id and company_id = v_company;
  if not found then
    raise exception 'الموظف غير موجود' using errcode = 'P0002';
  end if;
  if not public._hr_tickets_can_see_employee(v_company, p_employee_id) then
    raise exception 'لا تملك صلاحية عرض تذاكر هذا الموظف' using errcode = '42501';
  end if;
  if e.user_id is null then
    return jsonb_build_object('rows', '[]'::jsonb, 'total', 0, 'total_count', 0,
      'page', v_page, 'page_size', v_size, 'linked', false);
  end if;
  return (
    with f as (
      select t.* from public.tickets t
       where t.scope = 'company' and t.company_id = v_company and t.assigned_to = e.user_id
         and (p_status is null
              or (p_status = 'open' and t.status in ('open', 'in-progress'))
              or (p_status = 'resolved' and t.status in ('resolved', 'confirmed', 'closed'))
              or (p_status = 'rejected' and t.status = 'rejected'))
    )
    select jsonb_build_object(
      'rows', coalesce((select jsonb_agg(jsonb_build_object(
          'id', s.id, 'ticket_number', s.ticket_number, 'title', s.title,
          'status', s.status, 'priority', s.priority, 'category', s.category,
          'created_at', s.created_at, 'first_response_at', s.first_response_at,
          'resolved_at', s.resolved_at, 'reopen_count', s.reopen_count)
        order by s.created_at desc)
        from (select * from f order by created_at desc limit v_size offset (v_page - 1) * v_size) s), '[]'::jsonb),
      'total', (select count(*) from f),
      'total_count', (select count(*) from f),
      'page', v_page, 'page_size', v_size, 'linked', true));
end $$;
comment on function public.hr_employee_tickets_list(uuid, integer, integer, text) is
  '156: قائمة تذاكر موظف بترقيم وفلتر حزمة حالة {rows, total, page, page_size}؛ بلا حساب مرتبط ترجع صفوفًا فارغة مع linked=false.';

-- 2.3) ملخص جماعي لصفحة قائمة الموظفين: نداء واحد بدل نداء لكل صف.
--      صف واحد لكل معرّف مطلوب يراه المتصل (المخفي/الغريب يُحذف صامتًا
--      بلا تسريب وجود)؛ بلا حساب مرتبط linked=false وأصفار.
create or replace function public.hr_employees_ticket_summary(p_employee_ids uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  v_n int;
begin
  v_company := public._hr_gate('hr_employees', false);
  v_n := coalesce(cardinality(p_employee_ids), 0);
  if v_n < 1 or v_n > 100 then
    raise exception 'قدّم بين 1 و100 موظف' using errcode = '22023';
  end if;
  return (select jsonb_build_object(
      'rows', coalesce(jsonb_agg(jsonb_build_object(
          'employee_id', s.id, 'linked', s.user_id is not null,
          'assigned_total', s.assigned_total, 'open_now', s.open_now,
          'resolved_total', s.resolved_total) order by s.full_name), '[]'::jsonb),
      'total', count(*))
    from (select e.id, e.full_name, e.user_id,
                 (select count(*) from public.tickets t
                   where t.scope = 'company' and t.company_id = v_company and t.assigned_to = e.user_id) as assigned_total,
                 (select count(*) from public.tickets t
                   where t.scope = 'company' and t.company_id = v_company and t.assigned_to = e.user_id
                     and t.status in ('open', 'in-progress')) as open_now,
                 (select count(*) from public.tickets t
                   where t.scope = 'company' and t.company_id = v_company and t.assigned_to = e.user_id
                     and t.status in ('resolved', 'confirmed', 'closed')) as resolved_total
            from public.hr_employees e
           where e.company_id = v_company and e.id = any (p_employee_ids)
             and public._hr_tickets_can_see_employee(v_company, e.id)) s);
end $$;
comment on function public.hr_employees_ticket_summary(uuid[]) is
  '156: ملخص تذاكر جماعي (1–100 موظف) لعمود قائمة الموظفين: مفتوحة الآن + أُغلقت إجمالًا لكل موظف يراه المتصل؛ بلا حساب linked=false.';

-- 2.4) تجميع الأقسام (لتقارير لاحقة): صف لكل قسم فيه موظف مرتبط واحد
--      على الأقل + صف «بلا قسم» للمرتبطين بلا قسم، مع إجماليات الشركة
--      الكاملة (كل تذاكر company — بما فيها غير المسندة والمسندة لحساب
--      غير مرتبط بموظف) وتفصيل غير المرتبطة في unlinked. مدير القسم يرى
--      قسمه فقط؛ بلا hr.employees.view يُرفض.
create or replace function public.hr_department_ticket_stats(p_from date default null,
                                                            p_to date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  v_from    date := coalesce(p_from, current_date - 30);
  v_to      date := coalesce(p_to, current_date);
  v_from_ts timestamptz;
  v_to_ts   timestamptz;
  v_scope   uuid;
  v_wide    boolean;
begin
  v_company := public._hr_gate('hr_employees', false);
  if not public._hr_has_permission(v_company, 'hr.employees.view') then
    raise exception 'لا تملك صلاحية عرض إحصاءات التذاكر' using errcode = '42501';
  end if;
  if v_from > v_to then
    raise exception 'النافذة معكوسة' using errcode = '22023';
  end if;
  if (v_to - v_from) > 366 then
    raise exception 'النافذة أطول من 366 يومًا' using errcode = '22023';
  end if;
  v_from_ts := v_from::timestamptz;
  v_to_ts := (v_to + 1)::timestamptz;
  if public._hr_is_company_admin(v_company) then
    v_scope := null;
  else
    v_scope := public._hr_dept_scope(v_company);
    select exists (select 1 from public.hr_role_assignments r
                    where r.company_id = v_company and r.user_id = auth.uid()
                      and r.revoked_at is null and r.role in ('hr_manager', 'hr_officer'))
      into v_wide;
    if v_wide then v_scope := null; end if;
  end if;
  return jsonb_build_object(
    'from', v_from, 'to', v_to, 'generated_at', now(),
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
        'department_id', s.department_id, 'department_name', s.department_name,
        'employees_linked', s.employees_linked,
        'assigned_in_window', s.assigned_in_window, 'open_now', s.open_now,
        'resolved_in_window', s.resolved_in_window, 'rejected_in_window', s.rejected_in_window,
        'tickets_with_response', s.tickets_with_response,
        'first_response_rate', case when s.assigned_in_window = 0 then null
          else round(100.0 * s.tickets_with_response / s.assigned_in_window, 1) end,
        'avg_first_response_seconds', s.avg_first_response_seconds,
        'median_first_response_seconds', s.median_first_response_seconds,
        'avg_resolution_seconds', s.avg_resolution_seconds,
        'median_resolution_seconds', s.median_resolution_seconds)
      order by s.department_name)
      from (select l.department_id,
                   coalesce(d.name, 'بلا قسم') as department_name,
                   count(distinct l.employee_id)::bigint as employees_linked,
                   count(t.id) filter (where t.created_at >= v_from_ts and t.created_at < v_to_ts)::bigint as assigned_in_window,
                   count(t.id) filter (where t.status in ('open', 'in-progress'))::bigint as open_now,
                   count(t.id) filter (where t.resolved_at >= v_from_ts and t.resolved_at < v_to_ts)::bigint as resolved_in_window,
                   count(t.id) filter (where t.status = 'rejected' and t.created_at >= v_from_ts and t.created_at < v_to_ts)::bigint as rejected_in_window,
                   count(t.id) filter (where t.created_at >= v_from_ts and t.created_at < v_to_ts and t.first_response_at is not null)::bigint as tickets_with_response,
                   round(avg(extract(epoch from (t.first_response_at - t.created_at)))
                     filter (where t.created_at >= v_from_ts and t.created_at < v_to_ts and t.first_response_at is not null))::bigint as avg_first_response_seconds,
                   round(percentile_cont(0.5) within group (order by extract(epoch from (t.first_response_at - t.created_at)))
                     filter (where t.created_at >= v_from_ts and t.created_at < v_to_ts and t.first_response_at is not null))::bigint as median_first_response_seconds,
                   round(avg(extract(epoch from (t.resolved_at - t.created_at)))
                     filter (where t.resolved_at >= v_from_ts and t.resolved_at < v_to_ts))::bigint as avg_resolution_seconds,
                   round(percentile_cont(0.5) within group (order by extract(epoch from (t.resolved_at - t.created_at)))
                     filter (where t.resolved_at >= v_from_ts and t.resolved_at < v_to_ts))::bigint as median_resolution_seconds
              from (select e.id as employee_id, e.department_id, e.user_id
                      from public.hr_employees e
                     where e.company_id = v_company and e.user_id is not null and e.archived_at is null
                       and (v_scope is null or e.department_id = v_scope)) l
              left join public.hr_departments d on d.id = l.department_id
              left join public.tickets t
                on t.scope = 'company' and t.company_id = v_company and t.assigned_to = l.user_id
             group by l.department_id, d.name) s), '[]'::jsonb),
    'total', (select count(*) from (select distinct e.department_id from public.hr_employees e
               where e.company_id = v_company and e.user_id is not null and e.archived_at is null
                 and (v_scope is null or e.department_id = v_scope)) d),
    'totals', (select jsonb_build_object(
        'assigned_in_window', count(*) filter (where t.created_at >= v_from_ts and t.created_at < v_to_ts),
        'open_now', count(*) filter (where t.status in ('open', 'in-progress')),
        'resolved_in_window', count(*) filter (where t.resolved_at >= v_from_ts and t.resolved_at < v_to_ts),
        'rejected_in_window', count(*) filter (where t.status = 'rejected' and t.created_at >= v_from_ts and t.created_at < v_to_ts),
        'tickets_with_response', count(*) filter (where t.created_at >= v_from_ts and t.created_at < v_to_ts and t.first_response_at is not null),
        'avg_first_response_seconds', round(avg(extract(epoch from (t.first_response_at - t.created_at)))
          filter (where t.created_at >= v_from_ts and t.created_at < v_to_ts and t.first_response_at is not null))::bigint,
        'median_first_response_seconds', round(percentile_cont(0.5) within group (order by extract(epoch from (t.first_response_at - t.created_at)))
          filter (where t.created_at >= v_from_ts and t.created_at < v_to_ts and t.first_response_at is not null))::bigint,
        'avg_resolution_seconds', round(avg(extract(epoch from (t.resolved_at - t.created_at)))
          filter (where t.resolved_at >= v_from_ts and t.resolved_at < v_to_ts))::bigint,
        'median_resolution_seconds', round(percentile_cont(0.5) within group (order by extract(epoch from (t.resolved_at - t.created_at)))
          filter (where t.resolved_at >= v_from_ts and t.resolved_at < v_to_ts))::bigint)
      from public.tickets t
     where t.scope = 'company' and t.company_id = v_company),
    'unlinked', (select jsonb_build_object(
        'unassigned_in_window', count(*) filter (where t.assigned_to is null and t.created_at >= v_from_ts and t.created_at < v_to_ts),
        'unassigned_open_now', count(*) filter (where t.assigned_to is null and t.status in ('open', 'in-progress')),
        'assigned_to_unlinked_in_window', count(*) filter (where t.assigned_to is not null and t.created_at >= v_from_ts and t.created_at < v_to_ts
          and not exists (select 1 from public.hr_employees e where e.company_id = v_company and e.user_id = t.assigned_to and e.archived_at is null)),
        'assigned_to_unlinked_open_now', count(*) filter (where t.assigned_to is not null and t.status in ('open', 'in-progress')
          and not exists (select 1 from public.hr_employees e where e.company_id = v_company and e.user_id = t.assigned_to and e.archived_at is null)))
      from public.tickets t
     where t.scope = 'company' and t.company_id = v_company));
end $$;
comment on function public.hr_department_ticket_stats(date, date) is
  '156: تجميع تذاكر الأقسام (لتقارير لاحقة): صف لكل قسم فيه موظف مرتبط + صف «بلا قسم» + إجماليات الشركة الكاملة + تفصيل غير المرتبطة؛ مدير القسم يرى قسمه فقط.';

-- ============================================================================
-- 3) الصلاحيات — على نمط 154 §9: العامة للشركات عبر جلسة موثقة،
--    والداخلية _hr_tickets_* مغلقة تمامًا. بلا جداول جديدة فلا RLS هنا.
-- ============================================================================
do $$
declare f text;
begin
  foreach f in array array[
    'public._hr_tickets_can_see_employee(uuid,uuid)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
  foreach f in array array[
    'public.hr_employee_ticket_stats(uuid,date,date)',
    'public.hr_employee_tickets_list(uuid,integer,integer,text)',
    'public.hr_employees_ticket_summary(uuid[])',
    'public.hr_department_ticket_stats(date,date)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

-- ============================================================================
-- 4) تحقق ذاتي (على نمط 154 §10): كل دالة موجودة وممنوحة، وأعمدة التذاكر
--    المطلوبة موجودة. بلا جداول جديدة وبلا مفاتيح كتالوج جديدة في 156.
-- ============================================================================
do $$
declare
  v_funcs text[] := array[
    'public.hr_employee_ticket_stats(uuid,date,date)',
    'public.hr_employee_tickets_list(uuid,integer,integer,text)',
    'public.hr_employees_ticket_summary(uuid[])',
    'public.hr_department_ticket_stats(date,date)'];
  f text;
begin
  foreach f in array v_funcs loop
    if to_regprocedure(f) is null then
      raise exception '156: الدالة % غائبة', f;
    end if;
    if not has_function_privilege('authenticated', f::regprocedure, 'EXECUTE') then
      raise exception '156: الدالة % غير ممنوحة لـ authenticated', f;
    end if;
  end loop;
  if to_regprocedure('public._hr_tickets_can_see_employee(uuid,uuid)') is null then
    raise exception '156: الدالة الداخلية _hr_tickets_can_see_employee غائبة';
  end if;
  if has_function_privilege('authenticated', 'public._hr_tickets_can_see_employee(uuid,uuid)'::regprocedure, 'EXECUTE') then
    raise exception '156: الدالة الداخلية _hr_tickets_can_see_employee ممنوحة خطأً لـ authenticated';
  end if;
  raise notice '156: ربط الموظفين بالتذاكر — إحصاءات قراءة فقط — جاهز (بلا جداول جديدة؛ الجسر user_id ←→ tickets.assigned_to)';
end $$;
