-- ============================================================================
-- 159_hr_link_registers_company_staff.down — تراجع 159
--   يسقط المساعد الداخلي _hr_link_register_staff، ويعيد
--   hr_link_employee_account إلى نسخة 158 حرفيًا (بلا خطوة 7 — الربط لا
--   يسجّل الحساب في فريق الشركة)، ويعيد hr_employee_detail إلى نسخة
--   143 حرفيًا (بلا linked_user_id/linked_account_name).
--   التراجع آمن على البيانات: لا يحذف جداول ولا يمسّ أي ربط قائم، ولا
--   يزيل صفوف company_staff التي أنشأها الربط — فهي بيانات عمل تُلغى
--   صراحةً من إدارة الفريق (company_staff_revoke)، لا بالتراجع.
-- ============================================================================

drop function if exists public._hr_link_register_staff(uuid, uuid);

-- إعادة hr_link_employee_account إلى نسخة 158 حرفيًا.
create or replace function public.hr_link_employee_account(p_employee_id uuid, p_user_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  v_reason  text;
  e         public.hr_employees;
  p         public.profiles;
  v_member  boolean;
begin
  v_company := public._hr_gate('hr_employees', true);
  if not public._hr_has_permission(v_company, 'hr.link_account') then
    raise exception 'لا تملك صلاحية ربط الموظفين بالحسابات' using errcode = '42501';
  end if;
  v_reason := public._reason_check(p_reason);
  -- (1) الموظف في الشركة الحالية وغير مؤرشف.
  select * into e from public.hr_employees where id = p_employee_id and company_id = v_company;
  if not found then
    raise exception 'الموظف غير موجود' using errcode = 'P0002';
  end if;
  if e.archived_at is not null then
    raise exception 'الموظف مؤرشف — لا يُربط بحساب' using errcode = '22023';
  end if;
  -- (0) إعادة ربط نفس الموظف بنفس الحساب عملية عدمية: نجاح بلا تدقيق
  --     جديد وبلا إشعار — لا تُعامل كخطأ (جديد 158).
  if e.user_id = p_user_id then
    return jsonb_build_object('employee_id', e.id, 'user_id', p_user_id, 'linked', true);
  end if;
  if e.user_id is not null then
    raise exception 'الموظف مرتبط بحساب بالفعل — فك الربط أولًا' using errcode = '22023';
  end if;
  -- (2) الهدف ملف فعلي في profiles (لا ملف مختلق is_fallback).
  select * into p from public.profiles where id = p_user_id;
  if not found then
    raise exception 'الحساب غير موجود' using errcode = 'P0002';
  end if;
  -- (3) الهدف له عضوية نشطة في نفس الشركة أو هو مالكها.
  v_member := exists (select 1 from public.company_memberships m
                       where m.company_id = v_company and m.user_id = p_user_id
                         and m.status = 'active')
              or exists (select 1 from public.companies c
                          where c.id = v_company and c.user_id = p_user_id);
  if not v_member then
    raise exception 'الحساب ليس عضوًا في هذه الشركة' using errcode = '42501';
  end if;
  -- (4) الهدف ليس من طاقم المنصة.
  if coalesce(p.role, 'user') in ('platform_owner', 'admin', 'support') then
    raise exception 'لا يُربط حساب من طاقم المنصة بملف موظف' using errcode = '42501';
  end if;
  -- (5) الهدف غير محظور.
  if coalesce(public.is_banned(p_user_id), false) then
    raise exception 'الحساب محظور' using errcode = '42501';
  end if;
  -- (6) الهدف غير مرتبط بموظف آخر في نفس الشركة (موظف واحد لكل حساب).
  --     الفهرس الفريد في §1 هو الضمان الخلفي إن تجاوز متزامنان هذا
  --     التحقق؛ الرسالة هنا هي ما يراه المستخدم في المسار العادي.
  if exists (select 1 from public.hr_employees x
              where x.company_id = v_company and x.user_id = p_user_id and x.id <> e.id) then
    raise exception 'الحساب مرتبط بموظف آخر في الشركة بالفعل' using errcode = '22023';
  end if;
  update public.hr_employees set user_id = p_user_id where id = e.id;
  -- ملف الموظف المرتبط بصاحب الدور (لتحديد «الذات» ونطاق القسم).
  update public.hr_role_assignments set employee_id = e.id
   where company_id = v_company and user_id = p_user_id and revoked_at is null;
  perform public._hr_audit(v_company, 'employee.linked', 'employee', e.id, e.id,
    jsonb_build_object('user_id', null), jsonb_build_object('user_id', p_user_id), v_reason);
  insert into public.notifications (user_id, title, message, type, link, category)
  values (p_user_id, 'تم ربط ملفك الوظيفي',
          'ربطت شركتك ملفك الوظيفي بحسابك في مدعوم — يمكنك الآن الوصول لبياناتك وطلباتك من لوحة الشركة.',
          'info', '/company-dashboard/#hr-employees', 'hr');
  return jsonb_build_object('employee_id', e.id, 'user_id', p_user_id, 'linked', true);
end $$;

-- إعادة hr_employee_detail إلى نسخة 143 حرفيًا.
create or replace function public.hr_employee_detail(p_employee_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_company  uuid;
  v_admin    boolean;
  v_can_view boolean;
  v_self_id  uuid;
  v_scope    uuid;
  e          public.hr_employees;
  v_show_full boolean;
begin
  v_company := public._hr_gate('hr_employees', false);
  v_admin := public._hr_is_company_admin(v_company);
  v_can_view := public._hr_has_permission(v_company, 'hr.employees.view');
  v_self_id := public._hr_my_employee_id(v_company);
  v_scope := case when v_admin then null else public._hr_dept_scope(v_company) end;
  select * into e from public.hr_employees where id = p_employee_id and company_id = v_company;
  if not found then
    raise exception 'الموظف غير موجود' using errcode = 'P0002';
  end if;
  if not v_can_view and e.id <> v_self_id then
    raise exception 'الموظف غير موجود' using errcode = 'P0002';
  end if;
  if v_can_view and v_scope is not null
     and e.department_id is distinct from v_scope and e.manager_employee_id is distinct from v_self_id then
    raise exception 'الموظف غير موجود' using errcode = 'P0002';
  end if;
  v_show_full := v_admin or exists (
    select 1 from public.hr_role_assignments r
     where r.company_id = v_company and r.user_id = auth.uid()
       and r.role in ('hr_manager', 'hr_officer') and r.revoked_at is null);
  return jsonb_build_object(
    'id', e.id, 'employee_number', e.employee_number, 'full_name', e.full_name,
    'phone', e.phone, 'email', e.email,
    'national_id', case when v_show_full then e.national_id else public._hr_mask_national_id(e.national_id) end,
    'date_of_birth', e.date_of_birth, 'address', e.address, 'emergency_contact', e.emergency_contact,
    'department_id', e.department_id,
    'department_name', (select name from public.hr_departments where id = e.department_id),
    'branch_id', e.branch_id,
    'branch_name', (select name from public.hr_branches where id = e.branch_id),
    'position_id', e.position_id,
    'position_name', (select name from public.hr_positions where id = e.position_id),
    'manager_employee_id', e.manager_employee_id,
    'manager_name', (select full_name from public.hr_employees where id = e.manager_employee_id),
    'job_title', e.job_title, 'hire_date', e.hire_date, 'contract_type', e.contract_type,
    'employment_status', e.employment_status, 'linked', e.user_id is not null,
    'notes', e.notes, 'created_at', e.created_at, 'updated_at', e.updated_at,
    'archived_at', e.archived_at, 'archive_reason', e.archive_reason,
    'status_history', coalesce((select jsonb_agg(jsonb_build_object(
        'from_status', h.from_status, 'to_status', h.to_status, 'reason', h.reason,
        'created_at', h.created_at) order by h.created_at desc)
      from (select * from public.hr_employee_status_history where employee_id = e.id
             order by created_at desc limit 10) h), '[]'::jsonb));
end $$;

-- المنح كما كانت بعد 158.
do $$
begin
  execute format('revoke all on function %s from public, anon',
                 'public.hr_link_employee_account(uuid,uuid,text)');
  execute format('grant execute on function %s to authenticated',
                 'public.hr_link_employee_account(uuid,uuid,text)');
  execute format('revoke all on function %s from public, anon',
                 'public.hr_employee_detail(uuid)');
  execute format('grant execute on function %s to authenticated',
                 'public.hr_employee_detail(uuid)');
end $$;

do $$
begin
  raise notice '159: تراجع — عودة الربط إلى نسخة 158 والتفاصيل إلى نسخة 143 (صفوف الفريق المنشأة تبقى)';
end $$;
