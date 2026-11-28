-- ============================================================================
-- 158_hr_employee_account_unique.sql — وحدة الموارد البشرية، المرحلة 3 (تابع):
--   قاعدة منع تكرار ربط الحساب — حساب دخول واحد يربط موظفًا واحدًا فقط.
--
--   قرار محمود 2026-11-28 على سؤال التذاكر رقم 2 من تقرير المرحلة 2:
--   «كل حساب موظف يكون منفصل عن الآخر» — بلا تكرار.
--
--   النطاق: داخل الشركة الواحدة (company_id, user_id) — لا عبر الشركات.
--   الشخص نفسه قد يكون موظفًا في شركتين مختلفتين (سجلان منفصلان، وكل
--   شركة ترى تذاكرها وحدها في 156)، فلا ازدواج عدّ داخل أي شركة. إحصاءات
--   156 تُحسب داخل الشركة الحالية فقط عبر _hr_gate، فلا يوجد تجميع
--   عبر الشركات يمكن أن يضاعف العدّ — لا دليل يستدعي توسيع النطاق
--   إلى فهرس عالمي على user_id وحدها.
--
--   ما كان موجودًا أصلًا في 143 (لا يُعاد اختراعه):
--   • تحقق (6) في hr_link_employee_account يرفض الربط المكرر برسالة
--     عربية «الحساب مرتبط بموظف آخر في الشركة بالفعل» — لكنه تحقق
--     قراءةٍ قبل الكتابة: ربطان متزامنان قد يتجاوزاه معًا.
--   • لا trigger ولا استيراد يلمس user_id إطلاقًا (تحققنا: الكتابتان
--     الوحيدتان على hr_employees.user_id هما الربط 2530 وفك الربط 2568
--     في 143؛ إنشاء الموظف والاستيراد يُدخلان بلا عمود user_id فيبقى
--     NULL؛ محفّزات 143 على updated_at وعمق الهيكل وثبات التدقيق فقط).
--
--   ما يضيفه 158:
--   1. فهرس فريد جزئي (company_id, user_id) حيث user_id غير NULL —
--      ضمان قاعدة البيانات ضد السباق، حتى لو تجاوز متزامنان التحقق (6).
--      الفهرس القديم غير الفريد hr_employees_user_idx يبقى (يخدم البحث
--      بـ user_id وحده؛ حذفه بلا فائدة).
--   2. إعادة ربط نفس الموظف بنفس الحساب تصبح عملية عدمية: نجاح بلا
--      تدقيق وبلا إشعار (143 كانت ترفضها «الموظف مرتبط بحساب بالفعل»).
--   3. بلا مفتاح كتالوج جديد وبلا مفتاح ميزة جديد (الربط مغطى أصلًا
--      بـ hr.link_account وبوابة hr_employees).
--
--   يعتمد على 143 (الجدول ودالة الربط والبوابة والصلاحيات).
--   قابل لإعادة التشغيل.
--   التراجع: migrations/_rollback/158_hr_employee_account_unique.down.sql
-- ============================================================================

-- ============================================================================
-- 0) المتطلبات
-- ============================================================================
do $$
begin
  if to_regclass('public.hr_employees') is null then
    raise exception '158: يلزم الترحيل 143 أولًا (جدول hr_employees غائب)';
  end if;
  if to_regprocedure('public.hr_link_employee_account(uuid,uuid,text)') is null then
    raise exception '158: يلزم الترحيل 143 أولًا (hr_link_employee_account غائبة)';
  end if;
  if to_regprocedure('public._hr_gate(text,boolean)') is null then
    raise exception '158: يلزم الترحيل 143 أولًا (_hr_gate غائبة)';
  end if;
  if to_regprocedure('public._hr_has_permission(uuid,text)') is null then
    raise exception '158: يلزم الترحيل 143 أولًا (_hr_has_permission غائبة)';
  end if;
  -- لا تكرار قائم أصلًا (143 منعتْه بالتحقق (6) منذ الولادة، والبيانات
  -- الحية موظف واحد بلا حساب — لكن الفهرس الفريد يفشل برسالة خام إن
  -- وُجد تكرار، فنرفض أولًا برسالة عربية صريحة).
  if exists (select 1 from public.hr_employees
              where user_id is not null
              group by company_id, user_id having count(*) > 1) then
    raise exception '158: توجد حسابات مرتبطة بأكثر من موظف في نفس الشركة — نظّف التكرار قبل تطبيق الترحيل';
  end if;
end $$;

-- ============================================================================
-- 1) الفهرس الفريد الجزئي — ضمان قاعدة البيانات ضد سباق الربط
-- ============================================================================
create unique index if not exists hr_employees_company_user_uidx
  on public.hr_employees (company_id, user_id) where user_id is not null;

-- ============================================================================
-- 2) hr_link_employee_account — نسخة 143 حرفيًا + فرع العدمية (0)
--     (المنح محفوظة عبر CREATE OR REPLACE؛ تُعاد تأكيدًا في §3).
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

-- فك الربط يبقى كما هو في 143: يضع user_id = NULL فيحرّر الحساب فورًا
-- ليربط موظفًا آخر — لم يُمسّ هنا، والفهرس الجزئي يستثني NULL أصلًا.

-- ============================================================================
-- 3) المنح (نمط 143/157): الدالة المستبدلة تبقى لـ authenticated فقط
-- ============================================================================
do $$
begin
  execute format('revoke all on function %s from public, anon',
                 'public.hr_link_employee_account(uuid,uuid,text)');
  execute format('grant execute on function %s to authenticated',
                 'public.hr_link_employee_account(uuid,uuid,text)');
end $$;

-- ============================================================================
-- 4) تحقق ذاتي (على نمط 154 §10): الفهرس موجود، والدالة تحمل فرع
--     العدمية وتحقق (6)، والكتالوج ما زال 18 مفتاح hr.* (بلا جديد).
-- ============================================================================
do $$
declare
  v_def text;
begin
  if not exists (select 1 from pg_indexes where schemaname = 'public'
                  and indexname = 'hr_employees_company_user_uidx') then
    raise exception '158: الفهرس الفريد hr_employees_company_user_uidx غائب';
  end if;
  if (select indexdef from pg_indexes where schemaname = 'public'
       and indexname = 'hr_employees_company_user_uidx')
     not like '%WHERE (user_id IS NOT NULL)%' then
    raise exception '158: الفهرس الفريد يجب أن يكون جزئيًا (WHERE user_id IS NOT NULL)';
  end if;
  if to_regprocedure('public.hr_link_employee_account(uuid,uuid,text)') is null then
    raise exception '158: الدالة hr_link_employee_account غائبة';
  end if;
  if not has_function_privilege('authenticated',
        'public.hr_link_employee_account(uuid,uuid,text)'::regprocedure, 'EXECUTE') then
    raise exception '158: الدالة hr_link_employee_account غير ممنوحة لـ authenticated';
  end if;
  v_def := pg_get_functiondef('public.hr_link_employee_account(uuid,uuid,text)'::regprocedure);
  if position('عملية عدمية' in v_def) = 0 then
    raise exception '158: الدالة بلا فرع العدمية (إعادة ربط نفس الحساب)';
  end if;
  if position('الحساب مرتبط بموظف آخر في الشركة بالفعل' in v_def) = 0 then
    raise exception '158: الدالة بلا تحقق (6) ضد الربط المكرر';
  end if;
  if (select count(*) from public.company_permission_catalog where key like 'hr.%') <> 18 then
    raise exception '158: مفاتيح hr.* في الكتالوج يجب أن تبقى 18 (بلا مفتاح جديد في 158)';
  end if;
  raise notice '158: منع تكرار ربط الحساب — فهرس فريد (شركة، حساب) + ربط مكرر عدمي (مطفأ تجاريًا مع بقية HR حتى يفعّلها المالك لكل شركة)';
end $$;
