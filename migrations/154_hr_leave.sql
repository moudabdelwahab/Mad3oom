-- ============================================================================
-- 154_hr_leave.sql — وحدة الموارد البشرية، المرحلة 3 (القسم 1): الإجازات
--   (تصميم docs/hr-design.md §8.1 المرحلة 3 — الأنواع والأرصدة والطلبات فقط؛
--   الاستئذان hr_permission_requests والعطل hr_holidays وتقاويم العمل
--   hr_work_calendars ليست في هذا القسم، وتبقى لعمل لاحق).
--
--   • جداول public.hr_* جديدة: hr_leave_types وhr_leave_balances
--     وhr_leave_requests — RLS مفعّلة + كل الصلاحيات مسحوبة + سياسة
--     gate_account_active التقييدية الوحيدة (نمط 143 §6).
--   • التفعيل ثلاثي عبر _hr_gate('hr_leave', ...) من 143: مفتاح المنصة
--     hr_module_enabled + استحقاق الشركة 'hr' + مفتاح القسم 'hr_leave'
--     (الباقة أو تجاوز المالك) — لا مستوى وحده يكفي (القرار 3).
--   • مفاتيح الصلاحية (التصميم §4.1): hr.leave.view وhr.leave.manage من 143،
--     ويُضاف هنا hr.leave.request (كان مؤجلًا في 143) للموظف المرتبط الذي
--     يطلب إجازة عن نفسه؛ _hr_has_permission يُمدَّد بفرع ذاتي له على نمط
--     hr.self.view، وبقية المصفوفة حرفيًا كما في 143.
--   • الخصم عند الاعتماد فقط (لا عند الطلب)؛ والرفض لا يحرّر شيئًا؛ وإعادة
--     الاعتماد مستحيلة لأن القرار يقبل pending فقط (انتقال pending→approved
--     وحده يخصم، وصف الطلب يُقفل FOR UPDATE).
--   • عدد الأيام = أيام تقويمية شاملة الطرفين (start..end)؛ لا استثناء
--     لعطل نهاية الأسبوع أو عطل رسمية في هذا القسم (بلا جدول عطل بعد).
--   • الطلب داخل سنة ميلادية واحدة — العابر لحد السنة مرفوض (الرصيد سنوي
--     ولا تقسيم عبر سنتين في هذا القسم).
--   • أنواع افتراضية تُزرع كسولًا لكل شركة عند أول قراءة/كتابة:
--     annual سنوية 21 يومًا (تخصم)، sick مرضية 15 يومًا (تخصم)،
--     unpaid بدون أجر 0 (لا تخصم ولا رصيد لها).
--   • الأرصدة تُنشأ كسولًا من افتراضيات النوع عند أول قراءة/اعتماد — فقط
--     حين يكون القسم مفعّلًا للكتابة (لا كتابة أثناء إيقاف القسم §3.4).
--   • من يقرر: مالك الشركة، أو حامل hr.leave.manage (مدير HR وموظف HR
--     على مستوى الشركة؛ مدير القسم داخل قسمه فقط)، أو المدير المباشر
--     (manager_employee_id) — والمدير المباشر يرى طلبات مرؤوسيه أيضًا (§4.3).
--   • لا إلغاء طلب في هذا القسم (المدير يرفض الطلب المعلق)؛ ولا إشعار
--     دفع — يُشعَر الموظف المرتبط بقرار الطلب عبر notifications (نمط
--     hr_link_employee_account في 143)؛ وفئات إشعار hr_leave وtriggers
--     الحالة تبقى لعمل لاحق.
--
--   يعتمد على 143 (البوابة والصلاحيات والتدقيق وhr_employees وhr_audit_logs).
--   قابل لإعادة التشغيل.
--   التراجع: migrations/_rollback/154_hr_leave.down.sql
-- ============================================================================

-- ============================================================================
-- 0) المتطلبات
-- ============================================================================
do $$
begin
  if to_regprocedure('public._hr_gate(text,boolean)') is null then
    raise exception '154: يلزم الترحيل 143 أولًا (_hr_gate غائبة)';
  end if;
  if to_regclass('public.hr_employees') is null then
    raise exception '154: يلزم الترحيل 143 أولًا (hr_employees غائب)';
  end if;
  if to_regprocedure('public.hr_leave_types_list(boolean)') is not null then
    raise notice '154: أُعيد التطبيق — الكائنات موجودة أصلًا';
  end if;
end $$;

-- ============================================================================
-- 1) مفتاح الصلاحية hr.leave.request في الكتالوج (التصميم §4.1؛ كان مؤجلًا
--    في 143 §1.4). مفتاح ذاتي: لا يُمنح افتراضيًا لأي دور — يُشتق من الربط.
-- ============================================================================
insert into public.company_permission_catalog (key, label_ar, description_ar, default_supervisor, default_agent, sort) values
  ('hr.leave.request', 'طلب إجازة عن النفس', 'تقديم طلب إجازة عن النفس للموظف المرتبط بحساب (المرحلة 3).', false, false, 322)
on conflict (key) do update set label_ar = excluded.label_ar, description_ar = excluded.description_ar,
  default_supervisor = excluded.default_supervisor, default_agent = excluded.default_agent, sort = excluded.sort;

-- ============================================================================
-- 2) _hr_has_permission: فرع ذاتي واحد جديد لـ hr.leave.request على نمط
--    hr.self.view (موظف مرتبط غير مؤرشف)؛ بقية المصفوفة حرفيًا كما في 143.
-- ============================================================================
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

-- ============================================================================
-- 3) الجداول
-- ============================================================================

-- 3.1) hr_leave_types — أنواع الإجازات لكل شركة (التصميم §2.8).
create table if not exists public.hr_leave_types (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id) on delete cascade,
  code            text not null check (code ~ '^[a-z][a-z0-9_]*$'),
  name_ar         text not null check (char_length(btrim(name_ar)) between 2 and 120),
  default_days    integer not null default 0 check (default_days between 0 and 365),
  deducts_balance boolean not null default true,
  is_active       boolean not null default true,
  sort_order      integer not null default 0,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
comment on table public.hr_leave_types is
  '154: أنواع إجازات الشركة. code فريد داخل الشركة؛ default_days رصيد السنة الافتراضي؛ deducts_balance=false تعني بلا رصيد (إجازة بدون أجر).';

-- 3.2) hr_leave_balances — رصيد سنوي لكل موظف × نوع (التصميم §2.8).
create table if not exists public.hr_leave_balances (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id) on delete cascade,
  employee_id    uuid not null references public.hr_employees(id) on delete cascade,
  leave_type_id  uuid not null references public.hr_leave_types(id) on delete cascade,
  year           integer not null check (year between 2000 and 2100),
  total_days     integer not null default 0 check (total_days >= 0),
  used_days      integer not null default 0 check (used_days >= 0),
  created_by     uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
comment on table public.hr_leave_balances is
  '154: رصيد إجازة سنوي. used_days يزيد عند الاعتماد فقط؛ لا يُنشأ رصيد لنوع لا يخصم (deducts_balance=false).';

-- 3.3) hr_leave_requests — طلبات الإجازات (التصميم §2.8).
create table if not exists public.hr_leave_requests (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id) on delete cascade,
  employee_id     uuid not null references public.hr_employees(id) on delete cascade,
  leave_type_id   uuid not null references public.hr_leave_types(id) on delete restrict,
  start_date      date not null,
  end_date        date not null check (end_date >= start_date),
  days            integer not null check (days > 0),
  status          text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected')),
  note            text check (note is null or char_length(note) <= 1000),
  requested_by    uuid,
  decided_by      uuid,
  decided_at      timestamptz,
  decision_reason text check (status <> 'rejected' or char_length(btrim(decision_reason)) >= 10),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
comment on table public.hr_leave_requests is
  '154: طلب إجازة. days أيام تقويمية شاملة الطرفين تُحسب خادمًا عند الإنشاء؛ الرفض يتطلب سببًا ≥ 10 أحرف؛ النوع لا يُحذف وله طلبات (restrict) — يُؤرشف بدلًا من ذلك.';

-- ============================================================================
-- 4) الفهارس — جزء من تعريف الجداول.
-- ============================================================================
create unique index if not exists hr_leave_types_company_code_uidx
  on public.hr_leave_types (company_id, code);
create index if not exists hr_leave_types_company_active_idx
  on public.hr_leave_types (company_id, is_active);

create unique index if not exists hr_leave_balances_company_emp_type_year_uidx
  on public.hr_leave_balances (company_id, employee_id, leave_type_id, year);
create index if not exists hr_leave_balances_company_emp_year_idx
  on public.hr_leave_balances (company_id, employee_id, year);

create index if not exists hr_leave_requests_company_emp_status_idx
  on public.hr_leave_requests (company_id, employee_id, status, created_at desc);
create index if not exists hr_leave_requests_company_status_idx
  on public.hr_leave_requests (company_id, status, created_at desc);
-- فحص التداخل (التصميم §8.1 المرحلة 3: GiST على daterange).
create index if not exists hr_leave_requests_range_gist_idx
  on public.hr_leave_requests using gist (daterange(start_date, end_date, '[]'));

-- ============================================================================
-- 5) المحفّزات: لمس updated_at (إعادة استخدام _hr_touch_updated_at من 143).
-- ============================================================================
do $$
declare t text;
begin
  foreach t in array array['hr_leave_types', 'hr_leave_balances', 'hr_leave_requests'] loop
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
  foreach t in array array['hr_leave_types', 'hr_leave_balances', 'hr_leave_requests'] loop
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
-- 7) الدوال الداخلية _hr_leave_* — بلا GRANT إطلاقًا (تُسحب في فقرة 10).
-- ============================================================================

-- 7.1) عدد الأيام التقويمية شاملًا الطرفين.
create or replace function public._hr_leave_days(p_start date, p_end date)
returns integer
language sql
immutable
set search_path to 'public'
as $$
  select (p_end - p_start + 1)::integer;
$$;

-- 7.2) زرع الأنواع الافتراضية للشركة إن لم يكن لها أي نوع بعد (لا يمس
--     أنواعًا موجودة — التخصيص لاحقًا لا يُستبدل).
create or replace function public._hr_leave_ensure_types(p_company uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if exists (select 1 from public.hr_leave_types t where t.company_id = p_company) then
    return;
  end if;
  insert into public.hr_leave_types (company_id, code, name_ar, default_days, deducts_balance, sort_order, created_by)
  values
    (p_company, 'annual', 'إجازة سنوية', 21, true, 1, auth.uid()),
    (p_company, 'sick', 'إجازة مرضية', 15, true, 2, auth.uid()),
    (p_company, 'unpaid', 'إجازة بدون أجر', 0, false, 3, auth.uid())
  on conflict (company_id, code) do nothing;
end $$;

-- 7.3) إنشاء أرصدة السنة للموظف من افتراضيات الأنواع النشطة التي تخصم
--     (لا رصيد لنوع لا يخصم). idempotent عبر ON CONFLICT DO NOTHING.
create or replace function public._hr_leave_ensure_balances(p_company uuid, p_employee_id uuid, p_year integer)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  insert into public.hr_leave_balances (company_id, employee_id, leave_type_id, year, total_days, used_days, created_by)
  select p_company, p_employee_id, t.id, p_year, t.default_days, 0, auth.uid()
    from public.hr_leave_types t
   where t.company_id = p_company and t.is_active and t.deducts_balance
  on conflict (company_id, employee_id, leave_type_id, year) do nothing;
end $$;

-- 7.4) هل يحق للمتصل البتّ في طلب هذا الموظف؟ مالك الشركة، أو حامل
--     hr.leave.manage (مدير HR وموظف HR على مستوى الشركة؛ مدير القسم داخل
--     قسمه فقط أو لمرؤوس مباشر)، أو المدير المباشر للموظف (سجل موظف مرتبط
--     بالمتصل). من يحمل hr_manager وdept_manager معًا يبقى على مستوى الشركة
--     (دور hr_manager أوسع — لا يقيّده نطاق dept_manager).
create or replace function public._hr_leave_can_decide(p_company uuid, p_employee_id uuid)
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
  if public._hr_has_permission(p_company, 'hr.leave.manage')
     and (v_wide or v_scope is null
          or exists (select 1 from public.hr_employees e
                      where e.id = p_employee_id
                        and (e.department_id = v_scope or e.manager_employee_id = v_my))) then
    return true;
  end if;
  return exists (select 1 from public.hr_employees e
                  where e.id = p_employee_id and e.manager_employee_id = v_my);
end $$;

-- 7.5) هل يرى المتصل هذا الموظف في سياق الإجازات؟ مالك الشركة، أو حامل
--     hr.leave.view داخل نطاقه، أو المدير المباشر، أو الموظف نفسه.
create or replace function public._hr_leave_can_see_employee(p_company uuid, p_employee_id uuid)
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
  if public._hr_has_permission(p_company, 'hr.leave.view')
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
-- 8) RPCs الشركة — الإجازات (التصميم §5.1 نمطًا)
--    كلها SECURITY DEFINER، والشركة من current_company_id() لا من معامل،
--    والبوابة _hr_gate('hr_leave', ...) أولًا ثم فحص الصلاحية.
-- ============================================================================

-- 8.1) قائمة أنواع الإجازات: مغلف {rows, total} لا مصفوفة عارية (درس 143).
--     تُزرع الافتراضيات الثلاث عند أول قراءة حين يكون القسم مفعّلًا للكتابة.
create or replace function public.hr_leave_types_list(p_include_inactive boolean default false)
returns jsonb
language plpgsql
-- بلا STABLE عمدًا: تزرع الأنواع الافتراضية كسولًا (كتابة) عند أول قراءة.
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
begin
  v_company := public._hr_gate('hr_leave', false);
  if not public._hr_has_permission(v_company, 'hr.leave.view')
     and not public._hr_has_permission(v_company, 'hr.leave.request') then
    raise exception 'لا تملك صلاحية عرض أنواع الإجازات' using errcode = '42501';
  end if;
  -- زرع كسول — فقط حين يكون القسم مفعّلًا للكتابة (لا كتابة أثناء إيقافه).
  if public._hr_entitled(v_company, 'hr_leave', true) then
    perform public._hr_leave_ensure_types(v_company);
  end if;
  return (select jsonb_build_object(
      'rows', coalesce(jsonb_agg(jsonb_build_object(
          'id', t.id, 'code', t.code, 'name_ar', t.name_ar,
          'default_days', t.default_days, 'deducts_balance', t.deducts_balance,
          'is_active', t.is_active, 'sort_order', t.sort_order,
          'created_at', t.created_at) order by t.sort_order, t.name_ar), '[]'::jsonb),
      'total', count(*))
    from public.hr_leave_types t
   where t.company_id = v_company
     and (coalesce(p_include_inactive, false) or t.is_active));
end $$;
comment on function public.hr_leave_types_list(boolean) is
  '154: قائمة أنواع إجازات الشركة {rows, total}؛ تزرع الافتراضيات (سنوية 21، مرضية 15، بدون أجر بلا رصيد) عند أول قراءة مفعّلة للكتابة.';

-- 8.2) إنشاء نوع إجازة: الكود فريد داخل الشركة.
create or replace function public.hr_leave_type_create(p_code text, p_name_ar text,
                                                      p_default_days integer default 0,
                                                      p_deducts_balance boolean default true,
                                                      p_sort_order integer default 0)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  v_code    text := lower(btrim(coalesce(p_code, '')));
  v_name    text := btrim(coalesce(p_name_ar, ''));
  v_days    int := coalesce(p_default_days, 0);
  v_id      uuid;
begin
  v_company := public._hr_gate('hr_leave', true);
  if not public._hr_has_permission(v_company, 'hr.leave.manage') then
    raise exception 'لا تملك صلاحية إدارة الإجازات' using errcode = '42501';
  end if;
  if v_code !~ '^[a-z][a-z0-9_]*$' then
    raise exception 'رمز النوع أحرف إنجليزية صغيرة وأرقام وشرطة سفلية، يبدأ بحرف' using errcode = '22023';
  end if;
  if char_length(v_name) < 2 or char_length(v_name) > 120 then
    raise exception 'اسم النوع بين حرفين و120 حرفًا' using errcode = '22023';
  end if;
  if v_days < 0 or v_days > 365 then
    raise exception 'الرصيد الافتراضي بين 0 و365 يومًا' using errcode = '22023';
  end if;
  perform public._hr_leave_ensure_types(v_company);
  begin
    insert into public.hr_leave_types (company_id, code, name_ar, default_days, deducts_balance, sort_order, created_by)
    values (v_company, v_code, v_name, v_days, coalesce(p_deducts_balance, true), coalesce(p_sort_order, 0), auth.uid())
    returning id into v_id;
  exception when unique_violation then
    raise exception 'رمز نوع الإجازة مستخدم بالفعل في شركتك' using errcode = '23505';
  end;
  perform public._hr_audit(v_company, 'leave.type.created', 'leave_type', v_id, null, null,
    jsonb_build_object('code', v_code, 'name_ar', v_name, 'default_days', v_days,
      'deducts_balance', coalesce(p_deducts_balance, true)), null);
  return jsonb_build_object('id', v_id, 'code', v_code, 'name_ar', v_name,
    'default_days', v_days, 'deducts_balance', coalesce(p_deducts_balance, true));
end $$;

-- 8.3) تعديل نوع إجازة: NULL تعني «بلا تغيير». تغيير default_days لا يمسّ
--     أرصدة السنوات القائمة (لقطات) — يسري على سنوات جديدة فقط.
create or replace function public.hr_leave_type_update(p_type_id uuid, p_name_ar text default null,
                                                      p_default_days integer default null,
                                                      p_deducts_balance boolean default null,
                                                      p_is_active boolean default null,
                                                      p_sort_order integer default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  t         public.hr_leave_types;
  v_name    text;
  v_days    int;
  v_deducts boolean;
  v_active  boolean;
  v_sort    int;
begin
  v_company := public._hr_gate('hr_leave', true);
  if not public._hr_has_permission(v_company, 'hr.leave.manage') then
    raise exception 'لا تملك صلاحية إدارة الإجازات' using errcode = '42501';
  end if;
  select * into t from public.hr_leave_types where id = p_type_id and company_id = v_company;
  if not found then
    raise exception 'نوع الإجازة غير موجود' using errcode = 'P0002';
  end if;
  v_name := case when p_name_ar is null then t.name_ar else btrim(p_name_ar) end;
  v_days := coalesce(p_default_days, t.default_days);
  v_deducts := coalesce(p_deducts_balance, t.deducts_balance);
  v_active := coalesce(p_is_active, t.is_active);
  v_sort := coalesce(p_sort_order, t.sort_order);
  if char_length(v_name) < 2 or char_length(v_name) > 120 then
    raise exception 'اسم النوع بين حرفين و120 حرفًا' using errcode = '22023';
  end if;
  if v_days < 0 or v_days > 365 then
    raise exception 'الرصيد الافتراضي بين 0 و365 يومًا' using errcode = '22023';
  end if;
  update public.hr_leave_types set
    name_ar = v_name, default_days = v_days, deducts_balance = v_deducts,
    is_active = v_active, sort_order = v_sort
  where id = t.id;
  perform public._hr_audit(v_company, 'leave.type.updated', 'leave_type', t.id, null,
    jsonb_build_object('name_ar', t.name_ar, 'default_days', t.default_days,
      'deducts_balance', t.deducts_balance, 'is_active', t.is_active, 'sort_order', t.sort_order),
    jsonb_build_object('name_ar', v_name, 'default_days', v_days,
      'deducts_balance', v_deducts, 'is_active', v_active, 'sort_order', v_sort), null);
  return jsonb_build_object('id', t.id, 'code', t.code, 'name_ar', v_name,
    'default_days', v_days, 'deducts_balance', v_deducts, 'is_active', v_active);
end $$;

-- 8.4) أرشفة نوع إجازة (is_active=false — لا حذف): الطلبات الجديدة عليه
--     تُرفض، والمعلقة عليه يبقى البتّ فيها ممكنًا.
create or replace function public.hr_leave_type_archive(p_type_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  v_reason  text;
  t         public.hr_leave_types;
begin
  v_company := public._hr_gate('hr_leave', true);
  if not public._hr_has_permission(v_company, 'hr.leave.manage') then
    raise exception 'لا تملك صلاحية إدارة الإجازات' using errcode = '42501';
  end if;
  v_reason := public._reason_check(p_reason);
  select * into t from public.hr_leave_types where id = p_type_id and company_id = v_company;
  if not found then
    raise exception 'نوع الإجازة غير موجود' using errcode = 'P0002';
  end if;
  if not t.is_active then
    raise exception 'نوع الإجازة مؤرشف بالفعل' using errcode = '22023';
  end if;
  update public.hr_leave_types set is_active = false where id = t.id;
  perform public._hr_audit(v_company, 'leave.type.archived', 'leave_type', t.id, null,
    jsonb_build_object('is_active', true), jsonb_build_object('is_active', false), v_reason);
  return jsonb_build_object('id', t.id, 'code', t.code, 'archived', true);
end $$;

-- 8.5) قائمة أرصدة موظف لسنة: مغلف {rows, total}. تُنشأ أرصدة السنة كسولًا
--     من افتراضيات الأنواع حين يكون القسم مفعّلًا للكتابة. بلا موظف يحدَّد
--     ملف المتصل نفسه؛ وبلا ملف مرتبط يُطلب موظف صريح.
create or replace function public.hr_leave_balances_list(p_employee_id uuid default null, p_year integer default null)
returns jsonb
language plpgsql
-- بلا STABLE عمدًا: تُنشئ أرصدة السنة كسولًا (كتابة) عند أول قراءة.
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  v_emp     uuid;
  v_year    int := coalesce(p_year, extract(year from current_date)::int);
begin
  v_company := public._hr_gate('hr_leave', false);
  if p_year is not null and (p_year < 2000 or p_year > 2100) then
    raise exception 'السنة بين 2000 و2100' using errcode = '22023';
  end if;
  v_emp := coalesce(p_employee_id, public._hr_my_employee_id(v_company));
  if v_emp is null then
    raise exception 'حدّد الموظف' using errcode = '22023';
  end if;
  if not public._hr_leave_can_see_employee(v_company, v_emp) then
    raise exception 'لا تملك صلاحية عرض أرصدة هذا الموظف' using errcode = '42501';
  end if;
  -- زرع كسول — فقط حين يكون القسم مفعّلًا للكتابة (لا كتابة أثناء إيقافه).
  if public._hr_entitled(v_company, 'hr_leave', true) then
    perform public._hr_leave_ensure_types(v_company);
    perform public._hr_leave_ensure_balances(v_company, v_emp, v_year);
  end if;
  return (select jsonb_build_object(
      'rows', coalesce(jsonb_agg(jsonb_build_object(
          'id', b.id, 'employee_id', b.employee_id,
          'employee_name', e.full_name, 'employee_number', e.employee_number,
          'leave_type_id', b.leave_type_id, 'type_code', t.code, 'type_name', t.name_ar,
          'year', b.year, 'total_days', b.total_days, 'used_days', b.used_days,
          'remaining_days', greatest(b.total_days - b.used_days, 0))
        order by t.sort_order, t.name_ar), '[]'::jsonb),
      'total', count(*))
    from public.hr_leave_balances b
    join public.hr_leave_types t on t.id = b.leave_type_id
    join public.hr_employees e on e.id = b.employee_id
   where b.company_id = v_company and b.employee_id = v_emp and b.year = v_year);
end $$;
comment on function public.hr_leave_balances_list(uuid, integer) is
  '154: أرصدة إجازات موظف لسنة {rows, total} مع remaining_days؛ تُنشأ كسولًا من افتراضيات الأنواع.';

-- 8.6) ضبط رصيد موظف لنوع وسنة (upsert): الرصيد الجديد لا يقل عن المستخدم
--     فعلًا؛ ولا رصيد لنوع لا يخصم.
create or replace function public.hr_leave_balance_set(p_employee_id uuid, p_leave_type_id uuid,
                                                      p_year integer, p_total_days integer)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  v_year    int := coalesce(p_year, extract(year from current_date)::int);
  v_total   int := coalesce(p_total_days, 0);
  e         public.hr_employees;
  t         public.hr_leave_types;
  b         public.hr_leave_balances;
begin
  v_company := public._hr_gate('hr_leave', true);
  if not public._hr_has_permission(v_company, 'hr.leave.manage') then
    raise exception 'لا تملك صلاحية إدارة الإجازات' using errcode = '42501';
  end if;
  if v_year < 2000 or v_year > 2100 then
    raise exception 'السنة بين 2000 و2100' using errcode = '22023';
  end if;
  if v_total < 0 or v_total > 365 then
    raise exception 'الرصيد بين 0 و365 يومًا' using errcode = '22023';
  end if;
  select * into e from public.hr_employees where id = p_employee_id and company_id = v_company;
  if not found then
    raise exception 'الموظف غير موجود' using errcode = 'P0002';
  end if;
  if e.archived_at is not null then
    raise exception 'الموظف مؤرشف' using errcode = '22023';
  end if;
  select * into t from public.hr_leave_types where id = p_leave_type_id and company_id = v_company;
  if not found then
    raise exception 'نوع الإجازة غير موجود' using errcode = 'P0002';
  end if;
  if not t.deducts_balance then
    raise exception 'هذا النوع بلا رصيد (لا يخصم)' using errcode = '22023';
  end if;
  perform public._hr_leave_ensure_types(v_company);
  insert into public.hr_leave_balances (company_id, employee_id, leave_type_id, year, total_days, used_days, created_by)
  values (v_company, p_employee_id, p_leave_type_id, v_year, v_total, 0, auth.uid())
  on conflict (company_id, employee_id, leave_type_id, year) do nothing;
  select * into b from public.hr_leave_balances
   where company_id = v_company and employee_id = p_employee_id
     and leave_type_id = p_leave_type_id and year = v_year for update;
  if v_total < b.used_days then
    raise exception 'الرصيد الجديد أقل من المستخدم فعلًا' using errcode = '22023';
  end if;
  update public.hr_leave_balances set total_days = v_total where id = b.id;
  perform public._hr_audit(v_company, 'leave.balance.set', 'leave_balance', b.id, p_employee_id,
    jsonb_build_object('total_days', b.total_days, 'used_days', b.used_days),
    jsonb_build_object('total_days', v_total, 'used_days', b.used_days), null);
  return jsonb_build_object('id', b.id, 'employee_id', p_employee_id,
    'leave_type_id', p_leave_type_id, 'year', v_year, 'total_days', v_total,
    'used_days', b.used_days, 'remaining_days', greatest(v_total - b.used_days, 0));
end $$;

-- 8.7) إنشاء طلب إجازة: مدير (hr.leave.manage داخل نطاقه) يطلبه عن موظف،
--     أو الموظف المرتبط يطلبه عن نفسه (hr.leave.request). لا فحص رصيد هنا —
--     الرصيد يُفحص عند الاعتماد (قد يتغير والطلب معلق).
create or replace function public.hr_leave_request_create(p_employee_id uuid, p_leave_type_id uuid,
                                                         p_start_date date, p_end_date date,
                                                         p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  v_my      uuid;
  v_can_mgr boolean;
  v_is_self boolean;
  e         public.hr_employees;
  t         public.hr_leave_types;
  v_days    int;
  v_id      uuid;
  v_note    text := nullif(btrim(coalesce(p_note, '')), '');
begin
  v_company := public._hr_gate('hr_leave', true);
  v_my := public._hr_my_employee_id(v_company);
  v_can_mgr := public._hr_has_permission(v_company, 'hr.leave.manage');
  v_is_self := v_my is not null and v_my = p_employee_id;
  if v_is_self then
    if not public._hr_has_permission(v_company, 'hr.leave.request') then
      raise exception 'لا تملك صلاحية طلب إجازة' using errcode = '42501';
    end if;
  elsif v_can_mgr then
    if not public._hr_leave_can_see_employee(v_company, p_employee_id) then
      raise exception 'الموظف خارج نطاقك' using errcode = '42501';
    end if;
  else
    raise exception 'لا تملك صلاحية طلب إجازة' using errcode = '42501';
  end if;
  select * into e from public.hr_employees where id = p_employee_id and company_id = v_company;
  if not found then
    raise exception 'الموظف غير موجود' using errcode = 'P0002';
  end if;
  if e.archived_at is not null or e.employment_status = 'terminated' then
    raise exception 'الموظف مؤرشف — لا تُقبل طلبات إجازة له' using errcode = '22023';
  end if;
  if p_start_date is null or p_end_date is null then
    raise exception 'حدّد تاريخي البداية والنهاية' using errcode = '22023';
  end if;
  if p_end_date < p_start_date then
    raise exception 'تاريخ النهاية قبل تاريخ البداية' using errcode = '22023';
  end if;
  if extract(year from p_start_date) <> extract(year from p_end_date) then
    raise exception 'الطلب يجب أن يكون داخل سنة ميلادية واحدة' using errcode = '22023';
  end if;
  perform public._hr_leave_ensure_types(v_company);
  select * into t from public.hr_leave_types where id = p_leave_type_id and company_id = v_company;
  if not found then
    raise exception 'نوع الإجازة غير موجود' using errcode = 'P0002';
  end if;
  if not t.is_active then
    raise exception 'نوع الإجازة مؤرشف — لا تُقبل طلبات جديدة عليه' using errcode = '22023';
  end if;
  if v_note is not null and char_length(v_note) > 1000 then
    raise exception 'ملاحظة الطلب 1000 حرف حدًا أقصى' using errcode = '22023';
  end if;
  if exists (select 1 from public.hr_leave_requests r
              where r.company_id = v_company and r.employee_id = p_employee_id
                and r.status in ('pending', 'approved')
                and daterange(r.start_date, r.end_date, '[]') && daterange(p_start_date, p_end_date, '[]')) then
    raise exception 'يوجد طلب إجازة متداخل مع هذه الفترة (معلق أو معتمَد)' using errcode = '22023';
  end if;
  v_days := public._hr_leave_days(p_start_date, p_end_date);
  insert into public.hr_leave_requests
    (company_id, employee_id, leave_type_id, start_date, end_date, days, status, note, requested_by)
  values (v_company, p_employee_id, p_leave_type_id, p_start_date, p_end_date, v_days, 'pending', v_note, auth.uid())
  returning id into v_id;
  perform public._hr_audit(v_company, 'leave.request.created', 'leave_request', v_id, p_employee_id, null,
    jsonb_build_object('leave_type_id', p_leave_type_id, 'start_date', p_start_date,
      'end_date', p_end_date, 'days', v_days, 'status', 'pending'), null);
  return jsonb_build_object('request_id', v_id, 'employee_id', p_employee_id,
    'leave_type_id', p_leave_type_id, 'start_date', p_start_date, 'end_date', p_end_date,
    'days', v_days, 'status', 'pending');
end $$;

-- 8.8) البتّ في طلب: اعتماد أو رفض. يقبل pending فقط (فيُستحال الخصم المزدوج
--     — إعادة الاعتماد تُرفض)؛ والخصم من الرصيد عند الاعتماد فقط، بعد قفل
--     صف الطلب وصف الرصيد؛ والرفض يتطلب سببًا ≥ 10 أحرف؛ ويُشعَر الموظف
--     المرتبط بالقرار عبر notifications (نمط hr_link_employee_account).
create or replace function public.hr_leave_request_decide(p_request_id uuid, p_approve boolean, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  v_reason  text := nullif(btrim(coalesce(p_reason, '')), '');
  r         public.hr_leave_requests;
  t         public.hr_leave_types;
  b         public.hr_leave_balances;
  v_year    int;
  v_emp     public.hr_employees;
begin
  v_company := public._hr_gate('hr_leave', true);
  if p_approve is null then
    raise exception 'حدّد اعتمادًا أو رفضًا' using errcode = '22023';
  end if;
  if not p_approve then
    v_reason := public._reason_check(p_reason);
  end if;
  select * into r from public.hr_leave_requests where id = p_request_id and company_id = v_company for update;
  if not found then
    raise exception 'طلب الإجازة غير موجود' using errcode = 'P0002';
  end if;
  if not public._hr_leave_can_decide(v_company, r.employee_id) then
    raise exception 'لا تملك صلاحية البتّ في هذا الطلب' using errcode = '42501';
  end if;
  if r.status <> 'pending' then
    raise exception 'الطلب ليس معلقًا — سبق البتّ فيه' using errcode = '22023';
  end if;
  select * into t from public.hr_leave_types where id = r.leave_type_id;
  v_year := extract(year from r.start_date)::int;
  if p_approve and t.deducts_balance then
    perform public._hr_leave_ensure_balances(v_company, r.employee_id, v_year);
    select * into b from public.hr_leave_balances
     where company_id = v_company and employee_id = r.employee_id
       and leave_type_id = r.leave_type_id and year = v_year for update;
    if b is null then
      raise exception 'لا يوجد رصيد لهذا النوع والسنة' using errcode = '22023';
    end if;
    if b.total_days - b.used_days < r.days then
      raise exception 'رصيد الإجازة لا يكفي — المتبقي أقل من أيام الطلب' using errcode = '22023';
    end if;
    update public.hr_leave_balances set used_days = used_days + r.days where id = b.id;
  end if;
  update public.hr_leave_requests set
    status = case when p_approve then 'approved' else 'rejected' end,
    decided_by = auth.uid(), decided_at = now(), decision_reason = v_reason
  where id = r.id;
  perform public._hr_audit(v_company,
    case when p_approve then 'leave.request.approved' else 'leave.request.rejected' end,
    'leave_request', r.id, r.employee_id,
    jsonb_build_object('status', 'pending'),
    jsonb_build_object('status', case when p_approve then 'approved' else 'rejected' end,
      'days', r.days, 'decision_reason', v_reason), v_reason);
  select * into v_emp from public.hr_employees where id = r.employee_id;
  if v_emp.user_id is not null then
    insert into public.notifications (user_id, title, message, type, link, category)
    values (v_emp.user_id,
            case when p_approve then 'تم اعتماد طلب إجازتك' else 'تم رفض طلب إجازتك' end,
            case when p_approve
                 then 'اعتُمد طلب إجازتك ' || t.name_ar || ' من ' || r.start_date || ' إلى ' || r.end_date || ' (' || r.days || ' أيام).'
                 else 'رُفض طلب إجازتك ' || t.name_ar || ' من ' || r.start_date || ' إلى ' || r.end_date || '. السبب: ' || coalesce(v_reason, '') end,
            'info', '/company-dashboard/#hr-leave', 'hr');
  end if;
  return jsonb_build_object('request_id', r.id, 'employee_id', r.employee_id,
    'status', case when p_approve then 'approved' else 'rejected' end,
    'days', r.days, 'decision_reason', v_reason);
end $$;

-- 8.9) قائمة الطلبات: ترقيم خادم + فلاتر خادم، مغلف {rows, total, page,
--     page_size}. من بلا hr.leave.view يرى طلباته هو فقط (يُفرض موظفه).
create or replace function public.hr_leave_requests_list(p_page integer default 1, p_page_size integer default 20,
                                                        p_employee_id uuid default null, p_status text default null,
                                                        p_leave_type_id uuid default null, p_year integer default null)
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
begin
  v_company := public._hr_gate('hr_leave', false);
  v_admin := public._hr_is_company_admin(v_company);
  v_can_view := public._hr_has_permission(v_company, 'hr.leave.view');
  v_self_id := public._hr_my_employee_id(v_company);
  if not v_can_view and v_self_id is null then
    raise exception 'لا تملك صلاحية عرض طلبات الإجازات' using errcode = '42501';
  end if;
  if p_status is not null and p_status not in ('pending', 'approved', 'rejected') then
    raise exception 'حالة غير صالحة' using errcode = '22023';
  end if;
  if p_year is not null and (p_year < 2000 or p_year > 2100) then
    raise exception 'السنة بين 2000 و2100' using errcode = '22023';
  end if;
  -- بلا عرض عام: الموظف يرى طلباته هو فقط مهما طُلب.
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
      select r.* from public.hr_leave_requests r
       join public.hr_employees e on e.id = r.employee_id
       where r.company_id = v_company
         and (v_emp is null or r.employee_id = v_emp)
         and (p_status is null or r.status = p_status)
         and (p_leave_type_id is null or r.leave_type_id = p_leave_type_id)
         and (p_year is null or extract(year from r.start_date) = p_year)
         and (v_admin
              or not v_can_view and r.employee_id = v_self_id
              or v_can_view and (v_wide or v_scope is null
                 or e.department_id = v_scope or e.manager_employee_id = v_self_id)
              or e.manager_employee_id = v_self_id)
    )
    select jsonb_build_object(
      'rows', coalesce((select jsonb_agg(jsonb_build_object(
          'id', s.id, 'employee_id', s.employee_id,
          'employee_name', s.employee_name, 'employee_number', s.employee_number,
          'leave_type_id', s.leave_type_id, 'type_name', s.type_name, 'type_code', s.type_code,
          'start_date', s.start_date, 'end_date', s.end_date, 'days', s.days,
          'status', s.status, 'note', s.note, 'requested_by', s.requested_by,
          'decided_by', s.decided_by, 'decided_at', s.decided_at,
          'decision_reason', s.decision_reason, 'created_at', s.created_at)
        order by s.created_at desc)
        from (select f.*,
                     (select full_name from public.hr_employees where id = f.employee_id) employee_name,
                     (select employee_number from public.hr_employees where id = f.employee_id) employee_number,
                     (select name_ar from public.hr_leave_types where id = f.leave_type_id) type_name,
                     (select code from public.hr_leave_types where id = f.leave_type_id) type_code
                from f order by f.created_at desc limit v_size offset (v_page - 1) * v_size) s), '[]'::jsonb),
      'total', (select count(*) from f),
      'total_count', (select count(*) from f),
      'page', v_page, 'page_size', v_size));
end $$;
comment on function public.hr_leave_requests_list(integer, integer, uuid, text, uuid, integer) is
  '154: قائمة طلبات إجازة بترقيم وفلاتر خادمة {rows, total, page, page_size}؛ نطاق مدير القسم والمدير المباشر والذاتية في WHERE.';

-- 8.10) تفاصيل طلب: الطلب + الموظف + النوع + لقطة رصيد نوعه وسنته + هل
--      يحق للمتصل البتّ فيه (لإظهار الأزرار — القرار في RPC البتّ).
create or replace function public.hr_leave_request_detail(p_request_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  r         public.hr_leave_requests;
  e         public.hr_employees;
  t         public.hr_leave_types;
  b         public.hr_leave_balances;
  v_year    int;
begin
  v_company := public._hr_gate('hr_leave', false);
  select * into r from public.hr_leave_requests where id = p_request_id and company_id = v_company;
  if not found then
    raise exception 'طلب الإجازة غير موجود' using errcode = 'P0002';
  end if;
  if not public._hr_leave_can_see_employee(v_company, r.employee_id) then
    raise exception 'طلب الإجازة غير موجود' using errcode = 'P0002';
  end if;
  select * into e from public.hr_employees where id = r.employee_id;
  select * into t from public.hr_leave_types where id = r.leave_type_id;
  v_year := extract(year from r.start_date)::int;
  select * into b from public.hr_leave_balances
   where company_id = v_company and employee_id = r.employee_id
     and leave_type_id = r.leave_type_id and year = v_year;
  return jsonb_build_object(
    'id', r.id, 'employee_id', r.employee_id, 'employee_name', e.full_name,
    'employee_number', e.employee_number, 'department_id', e.department_id,
    'leave_type_id', r.leave_type_id, 'type_name', t.name_ar, 'type_code', t.code,
    'deducts_balance', t.deducts_balance,
    'start_date', r.start_date, 'end_date', r.end_date, 'days', r.days,
    'status', r.status, 'note', r.note, 'requested_by', r.requested_by,
    'decided_by', r.decided_by, 'decided_at', r.decided_at,
    'decision_reason', r.decision_reason, 'created_at', r.created_at,
    'balance', case when b is null then null else jsonb_build_object(
      'total_days', b.total_days, 'used_days', b.used_days,
      'remaining_days', greatest(b.total_days - b.used_days, 0)) end,
    'can_decide', public._hr_leave_can_decide(v_company, r.employee_id));
end $$;

-- ============================================================================
-- 9) الصلاحيات — على نمط 143 §13: العامة للشركات عبر جلسة موثقة،
--    والداخلية _hr_leave_* مغلقة تمامًا.
-- ============================================================================
do $$
declare f text;
begin
  foreach f in array array[
    'public._hr_leave_days(date,date)',
    'public._hr_leave_ensure_types(uuid)',
    'public._hr_leave_ensure_balances(uuid,uuid,integer)',
    'public._hr_leave_can_decide(uuid,uuid)',
    'public._hr_leave_can_see_employee(uuid,uuid)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
  foreach f in array array[
    'public.hr_leave_types_list(boolean)',
    'public.hr_leave_type_create(text,text,integer,boolean,integer)',
    'public.hr_leave_type_update(uuid,text,integer,boolean,boolean,integer)',
    'public.hr_leave_type_archive(uuid,text)',
    'public.hr_leave_balances_list(uuid,integer)',
    'public.hr_leave_balance_set(uuid,uuid,integer,integer)',
    'public.hr_leave_request_create(uuid,uuid,date,date,text)',
    'public.hr_leave_request_decide(uuid,boolean,text)',
    'public.hr_leave_requests_list(integer,integer,uuid,text,uuid,integer)',
    'public.hr_leave_request_detail(uuid)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

-- ============================================================================
-- 10) تحقق ذاتي (على نمط 143 §14): كل جدول ودالة وفهرس وقيد ومفتاح.
-- ============================================================================
do $$
declare
  v_tables text[] := array['hr_leave_types', 'hr_leave_balances', 'hr_leave_requests'];
  v_funcs text[] := array[
    'public.hr_leave_types_list(boolean)',
    'public.hr_leave_type_create(text,text,integer,boolean,integer)',
    'public.hr_leave_type_update(uuid,text,integer,boolean,boolean,integer)',
    'public.hr_leave_type_archive(uuid,text)',
    'public.hr_leave_balances_list(uuid,integer)',
    'public.hr_leave_balance_set(uuid,uuid,integer,integer)',
    'public.hr_leave_request_create(uuid,uuid,date,date,text)',
    'public.hr_leave_request_decide(uuid,boolean,text)',
    'public.hr_leave_requests_list(integer,integer,uuid,text,uuid,integer)',
    'public.hr_leave_request_detail(uuid)'];
  t text;
  f text;
begin
  foreach t in array v_tables loop
    if to_regclass('public.' || t) is null then
      raise exception '154: الجدول % غائب', t;
    end if;
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception '154: RLS غير مفعّلة على %', t;
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t
                    and policyname = 'gate_account_active') then
      raise exception '154: سياسة gate_account_active غائبة على %', t;
    end if;
  end loop;
  foreach f in array v_funcs loop
    if to_regprocedure(f) is null then
      raise exception '154: الدالة % غائبة', f;
    end if;
    if not has_function_privilege('authenticated', f::regprocedure, 'EXECUTE') then
      raise exception '154: الدالة % غير ممنوحة لـ authenticated', f;
    end if;
  end loop;
  if not exists (select 1 from pg_indexes where schemaname = 'public'
                  and indexname = 'hr_leave_types_company_code_uidx') then
    raise exception '154: فهرس UNIQUE(company_id, code) غائب على الأنواع';
  end if;
  if not exists (select 1 from pg_indexes where schemaname = 'public'
                  and indexname = 'hr_leave_balances_company_emp_type_year_uidx') then
    raise exception '154: فهرس رصيد (شركة، موظف، نوع، سنة) غائب';
  end if;
  if not exists (select 1 from pg_indexes where schemaname = 'public'
                  and indexname = 'hr_leave_requests_range_gist_idx') then
    raise exception '154: فهرس GiST على نطاق التواريخ غائب';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_hr_leave_requests_updated_at') then
    raise exception '154: محفّز updated_at غائب على الطلبات';
  end if;
  if (select count(*) from public.company_permission_catalog where key like 'hr.%') <> 17 then
    raise exception '154: مفاتيح hr.* في الكتالوج يجب أن تكون 17 بعد إضافة hr.leave.request';
  end if;
  if (select count(*) from public.feature_flags where key = 'hr_leave') <> 1 then
    raise exception '154: مفتاح hr_leave غائب من feature_flags (يلزم 143)';
  end if;
  raise notice '154: الإجازات — الأنواع والأرصدة والطلبات — جاهزة (مطفأة تجاريًا مع بقية HR حتى يفعّلها المالك لكل شركة)';
end $$;
