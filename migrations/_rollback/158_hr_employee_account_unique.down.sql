-- ============================================================================
-- 158_hr_employee_account_unique.down — تراجع 158
--   يسقط الفهرس الفريد الجزئي (company_id, user_id)، ويعيد
--   hr_link_employee_account إلى نسخة 143 حرفيًا (بلا فرع العدمية (0) —
--   إعادة ربط نفس الحساب تعود ترفض «الموظف مرتبط بحساب بالفعل»).
--   تحقق (6) العربي ضد الربط المكرر يبقى (من 143) — التراجع يزيل
--   ضمان قاعدة البيانات ضد السباق فقط، لا قاعدة المنع نفسها.
--   التراجع آمن على البيانات: لا يحذف جداول ولا يمسّ أي ربط قائم.
-- ============================================================================

drop index if exists public.hr_employees_company_user_uidx;

-- إعادة الدالة إلى نسخة 143 حرفيًا.
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

-- المنح كما في 143.
revoke all on function public.hr_link_employee_account(uuid,uuid,text) from public, anon;
grant execute on function public.hr_link_employee_account(uuid,uuid,text) to authenticated;
