-- ============================================================================
-- 159_hr_link_registers_company_staff.sql — وحدة الموارد البشرية، المرحلة 3
--   (تابع): زر الربط + تسجيل الحساب المرتبط تحت شجرة الشركة.
--
--   أمر محمود 2026-11-28: «ابني زرار» (زر ربط/فك حساب في تفاصيل الموظف —
--   التصميم §5.5 سطّر الزر أصلًا ولم يُبنَ) + «والعميل يتسجل تحت شجره
--   الشركة» (الحساب المرتبط يظهر تحت عقدة الشركة في شجرة الحسابات).
--
--   ما وجدناه (تحققنا قبل البناء):
--   • الشجرة (128 owner_account_tree) تشتق «موظف» تحت الشركة من صف نشط
--     في company_staff حصرًا (086)؛ العضو بلا صف موظف يظهر kind='customer'
--     (ولو كان ملف HR مرتبطًا به). فالتسجيل في الشجرة = صف company_staff.
--   • إسناد التذاكر (098 company_ticket_assign) يشترط
--     _company_is_eligible_agent = دور موظف نشط في الشركة نفسها؛ فبلا
--     صف موظف لا تُسند تذاكر للحساب المرتبط، وتبقى إحصاءات 156 فارغة.
--     التسجيل في الفريق إذن ليس تجميلًا للشجرة فقط — هو ما يجعل ربط
--     التذاكر يعمل أصلًا.
--   • الربط (143) يشترط عضوية نشطة في نفس الشركة أو ملكيتها (تحقق 3)
--     ولا ينشئ عضوية؛ وjoined_via في company_memberships لا قيمة فيه
--     تناسب «ربط إداري» (backfill/legacy/invitation/transfer فقط) —
--     فلا ننشئ عضوية في الربط. منتقي الزر يعرض أعضاء الشركة القائمين
--     (company_members() — 096/152)، ورفض «ليس عضوًا» يظهر بالعربية
--     إن انتهت العضوية بين الاختيار والربط.
--
--   ما يضيفه 159:
--   1. hr_link_employee_account (نسخة 158 + خطوة 7): بعد ضبط user_id،
--      يسجّل الحساب في فريق الشركة بصف موظف دعم (role='agent' — الأدنى؛
--      'supervisor' إدارة على الآخرين فلا تُمنح ضمنيًا) + سجل حدث
--      (granted/agent/admin). مالك الشركة مستثنًى (مدير بالملكية، ولا
--      يُخزَّن في company_staff أصلًا — 086؛ يظهر في الشجرة كمالك).
--      الصف الموجود أصلًا بأي دور لا يُغيَّر (قد يكون مشرفًا). الفشل
--      (حارس 086: الحساب ليس تابعًا مباشرًا للمالك — عضوية ثانوية مثلًا،
--      أو حساب غير مفعّل) لا يُفشل الربط — يُعاد في staff_registered.
--      الإرجاع يضم staff_registered وstaff_as ('agent'/'supervisor'/
--      'owner'/null). فرع العدمية (0) يسجّل الفريق أيضًا (روابط 158
--      بلا صف موظف).
--   2. hr_employee_detail (+حقلان للقراءة فقط): linked_user_id و
--      linked_account_name (اسم العرض المحلي ثم full_name ثم username)
--      ليعرض التفاصيل اسم الحساب المرتبط لا «مرتبط بحساب» مبهمة.
--   3. بلا مفتاح كتالوج جديد وبلا مفتاح ميزة جديد (الربط مغطى أصلًا
--      بـ hr.link_account وبوابة hr_employees).
--
--   قرارات محافظة (التصميم ساكت عنها):
--   • فك الربط لا يمسّ company_staff إطلاقًا: الصف قد يسبق الربط
--     (مُنح مستقلًا من إدارة الفريق)، ولا عمود مصدر يميّز صفوف الربط؛
--     والإلغاء الصريح متاح للمدير من إدارة الفريق (company_staff_revoke).
--     التفاصيل تنبّه لهذا بسطر باهت. إن أراد محمود فكًّا يلغي الفريق،
--     يلزم تتبّع مصدر — متابعة لاحقة.
--   • إنشاء العضوية ليس جزءًا من الربط (أعلاه)؛ إضافة شخص جديد للشركة
--     تتم أولًا من مسار الدعوة/المستخدم الفرعي القائم، ثم الربط.
--   • منتقي الزر يعيد قائمة company_members() كما هي: المالك يرى الكل،
--     ومدير HR غير المالك يرى نفسه والمالك فقط (خصوصية 085) — فالمنتقي
--     كامل للمالك ومحدود لغيره. قائمة مرشحين مخصصة للربط لم تُخترع
--     (تُبنى لاحقًا إن طلبها محمود).
--
--   يعتمد على 143 (الجدول ودالة الربط والتفاصيل والبوابة والصلاحيات)
--   و158 (الفهرس الفريد + فرع العدمية) و086 (company_staff) و128
--   (الشجرة تقرأ company_staff) و152 (company_member_profiles).
--   قابل لإعادة التشغيل.
--   التراجع: migrations/_rollback/159_hr_link_registers_company_staff.down.sql
--   (يعيد الدالتين إلى نسختي 158/143 حرفيًا؛ صفوف الفريق التي أنشأها
--   الربط تبقى — بيانات عمل تُلغى من إدارة الفريق لا بالتراجع).
-- ============================================================================

-- ============================================================================
-- 0) المتطلبات
-- ============================================================================
do $$
begin
  if to_regclass('public.hr_employees') is null then
    raise exception '159: يلزم الترحيل 143 أولًا (جدول hr_employees غائب)';
  end if;
  if to_regprocedure('public.hr_link_employee_account(uuid,uuid,text)') is null then
    raise exception '159: يلزم الترحيل 143 أولًا (hr_link_employee_account غائبة)';
  end if;
  if to_regprocedure('public.hr_employee_detail(uuid)') is null then
    raise exception '159: يلزم الترحيل 143 أولًا (hr_employee_detail غائبة)';
  end if;
  if to_regclass('public.company_staff') is null then
    raise exception '159: يلزم الترحيل 086 أولًا (جدول company_staff غائب)';
  end if;
  if to_regclass('public.company_staff_events') is null then
    raise exception '159: يلزم الترحيل 086 أولًا (جدول company_staff_events غائب)';
  end if;
  if to_regprocedure('public._hr_gate(text,boolean)') is null then
    raise exception '159: يلزم الترحيل 143 أولًا (_hr_gate غائبة)';
  end if;
  if to_regprocedure('public._hr_has_permission(uuid,text)') is null then
    raise exception '159: يلزم الترحيل 143 أولًا (_hr_has_permission غائبة)';
  end if;
  if to_regprocedure('public._inbox_account_active(uuid)') is null then
    raise exception '159: يلزم _inbox_account_active (إسناد التذاكر يشترطه)';
  end if;
end $$;

-- ============================================================================
-- 1) مساعد داخلي: تسجيل حساب في فريق الشركة (شجرة الحسابات)
--     بلا منح — يُنادى فقط من hr_link_employee_account (SECURITY DEFINER).
-- ============================================================================
create or replace function public._hr_link_register_staff(p_company uuid, p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_owner    uuid;
  v_existing text;
begin
  select c.user_id into v_owner from public.companies c where c.id = p_company;
  if v_owner is null then
    return jsonb_build_object('registered', false, 'as', null);
  end if;
  -- المالك مدير الفريق بالملكية: يظهر في الشجرة كمالك، ولا يُخزَّن صف
  -- في company_staff أصلًا (086 يرفضه صراحةً).
  if p_user = v_owner then
    return jsonb_build_object('registered', true, 'as', 'owner');
  end if;
  -- مسجَّل أصلًا بأي دور — لا نغيّره (قد يكون مشرفًا منحته إدارة الفريق).
  select s.role into v_existing from public.company_staff s
   where s.company_id = p_company and s.user_id = p_user and s.revoked_at is null;
  if found then
    return jsonb_build_object('registered', true, 'as', v_existing);
  end if;
  -- الحساب غير مفعّل لا تُسند له تذاكر أصلًا (_company_is_eligible_agent
  -- يشترط _inbox_account_active) — لا نسجّله في الفريق.
  if not coalesce(public._inbox_account_active(p_user), false) then
    return jsonb_build_object('registered', false, 'as', null);
  end if;
  begin
    insert into public.company_staff (company_id, user_id, role, granted_by, updated_by)
    values (p_company, p_user, 'agent', auth.uid(), auth.uid());
    insert into public.company_staff_events (company_id, actor_id, target_id, action, role_to, cause)
    values (p_company, auth.uid(), p_user, 'granted', 'agent', 'admin');
    return jsonb_build_object('registered', true, 'as', 'agent');
  exception when others then
    -- حارس 086: الحساب ليس تابعًا مباشرًا لمالك هذه الشركة (عضوية
    -- ثانوية مثلًا) — الربط نفسه ينجح، والتسجيل في الفريق يُترك
    -- لإدارة الفريق؛ لا نفشل الربط بسبب التسجيل.
    return jsonb_build_object('registered', false, 'as', null);
  end;
end $$;

-- ============================================================================
-- 2) hr_link_employee_account — نسخة 158 حرفيًا + خطوة (7) تسجيل الفريق
--     (المنح محفوظة عبر CREATE OR REPLACE؛ تُعاد تأكيدًا في §4).
-- ============================================================================
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
  v_staff   jsonb;
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
  --     جديد وبلا إشعار — لا تُعامل كخطأ (جديد 158). التسجيل في الفريق
  --     يُضمن هنا أيضًا (روابط 158 بلا صف موظف).
  if e.user_id = p_user_id then
    v_staff := public._hr_link_register_staff(v_company, p_user_id);
    return jsonb_build_object('employee_id', e.id, 'user_id', p_user_id, 'linked', true,
      'staff_registered', coalesce((v_staff ->> 'registered')::boolean, false),
      'staff_as', v_staff ->> 'as');
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
  --     الفهرس الفريد في 158 هو الضمان الخلفي إن تجاوز متزامنان هذا
  --     التحقق؛ الرسالة هنا هي ما يراه المستخدم في المسار العادي.
  if exists (select 1 from public.hr_employees x
              where x.company_id = v_company and x.user_id = p_user_id and x.id <> e.id) then
    raise exception 'الحساب مرتبط بموظف آخر في الشركة بالفعل' using errcode = '22023';
  end if;
  update public.hr_employees set user_id = p_user_id where id = e.id;
  -- ملف الموظف المرتبط بصاحب الدور (لتحديد «الذات» ونطاق القسم).
  update public.hr_role_assignments set employee_id = e.id
   where company_id = v_company and user_id = p_user_id and revoked_at is null;
  -- (7) تسجيل الحساب في فريق الشركة (شجرة الحسابات): صف موظف دعم
  --     (agent) في company_staff إن لم يكن موجودًا — به يظهر الحساب
  --     في الشجرة كموظف شركة (لا كعميل)، ويصبح مؤهلًا لإسناد التذاكر
  --     (156). مالك الشركة مستثنًى (مدير بالملكية). الفشل هنا لا يفشل
  --     الربط — يُعاد في staff_registered (جديد 159).
  v_staff := public._hr_link_register_staff(v_company, p_user_id);
  perform public._hr_audit(v_company, 'employee.linked', 'employee', e.id, e.id,
    jsonb_build_object('user_id', null), jsonb_build_object('user_id', p_user_id), v_reason);
  insert into public.notifications (user_id, title, message, type, link, category)
  values (p_user_id, 'تم ربط ملفك الوظيفي',
          'ربطت شركتك ملفك الوظيفي بحسابك في مدعوم — يمكنك الآن الوصول لبياناتك وطلباتك من لوحة الشركة.',
          'info', '/company-dashboard/#hr-employees', 'hr');
  return jsonb_build_object('employee_id', e.id, 'user_id', p_user_id, 'linked', true,
    'staff_registered', coalesce((v_staff ->> 'registered')::boolean, false),
    'staff_as', v_staff ->> 'as');
end $$;

-- فك الربط يبقى كما هو في 143/158: يضع user_id = NULL فيحرّر الحساب فورًا
-- ليربط موظفًا آخر — لم يُمسّ هنا، ولا يمسّ company_staff (قرار محافظ:
-- الصف قد يسبق الربط، ولا عمود مصدر يميّز صفوف الربط؛ الإلغاء الصريح
-- من إدارة الفريق عبر company_staff_revoke).

-- ============================================================================
-- 3) hr_employee_detail — نسخة 143 حرفيًا + حقلا الحساب المرتبط
--     (للقراءة فقط: اسم الحساب في التفاصيل بدل «مرتبط بحساب» مبهمة).
-- ============================================================================
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
    'linked_user_id', e.user_id,
    'linked_account_name', case when e.user_id is null then null else
      (select coalesce(cp.display_name, p.full_name, p.username, 'حساب مرتبط')
         from public.profiles p
         left join public.company_member_profiles cp
           on cp.company_id = v_company and cp.user_id = p.id
        where p.id = e.user_id) end,
    'notes', e.notes, 'created_at', e.created_at, 'updated_at', e.updated_at,
    'archived_at', e.archived_at, 'archive_reason', e.archive_reason,
    'status_history', coalesce((select jsonb_agg(jsonb_build_object(
        'from_status', h.from_status, 'to_status', h.to_status, 'reason', h.reason,
        'created_at', h.created_at) order by h.created_at desc)
      from (select * from public.hr_employee_status_history where employee_id = e.id
             order by created_at desc limit 10) h), '[]'::jsonb));
end $$;

-- ============================================================================
-- 4) المنح (نمط 143/157/158): الدالتان المستبدلتان تبقيان لـ authenticated
--     فقط؛ المساعد الداخلي بلا منح إطلاقًا (يُنادى من دالة SECURITY DEFINER).
-- ============================================================================
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
  execute format('revoke all on function %s from public, anon, authenticated',
                 'public._hr_link_register_staff(uuid,uuid)');
end $$;

-- ============================================================================
-- 5) تحقق ذاتي (على نمط 158 §4): المساعد موجود، والربط يحمل خطوة (7)
--     ويعيد staff_registered، والتفاصيل تحمل linked_account_name،
--     والكتالوج ما زال 18 مفتاح hr.* (بلا جديد).
-- ============================================================================
do $$
declare
  v_def text;
begin
  if to_regprocedure('public._hr_link_register_staff(uuid,uuid)') is null then
    raise exception '159: المساعد _hr_link_register_staff غائب';
  end if;
  if to_regprocedure('public.hr_link_employee_account(uuid,uuid,text)') is null then
    raise exception '159: الدالة hr_link_employee_account غائبة';
  end if;
  if not has_function_privilege('authenticated',
        'public.hr_link_employee_account(uuid,uuid,text)'::regprocedure, 'EXECUTE') then
    raise exception '159: الدالة hr_link_employee_account غير ممنوحة لـ authenticated';
  end if;
  v_def := pg_get_functiondef('public.hr_link_employee_account(uuid,uuid,text)'::regprocedure);
  if position('_hr_link_register_staff' in v_def) = 0 then
    raise exception '159: الدالة بلا خطوة (7) تسجيل الفريق';
  end if;
  if position('staff_registered' in v_def) = 0 then
    raise exception '159: الدالة لا تعيد staff_registered';
  end if;
  if position('الحساب مرتبط بموظف آخر في الشركة بالفعل' in v_def) = 0 then
    raise exception '159: الدالة بلا تحقق (6) ضد الربط المكرر';
  end if;
  v_def := pg_get_functiondef('public.hr_employee_detail(uuid)'::regprocedure);
  if position('linked_account_name' in v_def) = 0 then
    raise exception '159: التفاصيل بلا linked_account_name';
  end if;
  if (select count(*) from public.company_permission_catalog where key like 'hr.%') <> 18 then
    raise exception '159: مفاتيح hr.* في الكتالوج يجب أن تبقى 18 (بلا مفتاح جديد في 159)';
  end if;
  raise notice '159: ربط الموظف بحساب يسجّله في فريق الشركة (شجرة الحسابات) + اسم الحساب المرتبط في التفاصيل (مطفأ تجاريًا مع بقية HR حتى يفعّلها المالك لكل شركة)';
end $$;
