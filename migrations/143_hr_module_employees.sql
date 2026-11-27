-- ============================================================================
-- 143_hr_module_employees.sql — وحدة الموارد البشرية، المرحلة 2: الأساسيات
--   والموظفون (تصميم docs/hr-design.md؛ قرارات محمود الملزمة 2026-11-25).
--
--   • جداول public.hr_* جديدة مستقلة؛ emp_ops يبقى داخليًا فقط — لا امتداد له
--     ولا إشارة إليه ولا خلط بيانات (القرار 1).
--   • مفتاح تكرار الموظف = employee_number فريد داخل كل شركة (القرار 2).
--   • التفعيل ثلاثي: مفتاح المنصة hr_module_enabled + ميزة الباقة/التجاوز
--     (hr + مفتاح القسم) — لا مستوى وحده يكفي (القرار 3).
--   • الرواتب والحضور والمهام والإجازات والتقارير مفاتيح مستقلة (القرار 4).
--   • لا تفعيل تجاري هنا: المفتاح العام مطفأ، وكل plan_features مُدخلة
--     enabled=false، ولا تجاوز يُمنح لأي شركة.
--
--   الرقم 143 لا 142: الرقم 142 مستخدم في فرعين غير مدمجين
--   (142_trial_request_notification.sql و142_ultimate_cancel_refund.sql).
--   الاسم 143_hr_module_employees.sql (لا 143_hr_module_phase2_employees.sql
--   كما في التصميم §0.1) — اسم الملف المطلوب في مهمة البناء.
--
--   ما يُغيَّر في كائنات قائمة (مقصود وموثَّق):
--   • company_feature_overrides: قيد CHECK يُوسَّع آمنًا (DO يقرأ التعريف
--     الحالي أولًا) من 4 مفاتيح إلى 10 بإضافة مفاتيح hr_*؛ وأعمدة حالة جديدة
--     status/suspended_at/suspended_by/suspend_reason (التصميم §3.1).
--   • company_has_feature(): تُعاد كتابتها حرفيًا كما في 099 مع شرط إضافي
--     واحد — التجاوز بحالة suspended لا يمنح الميزة (التصميم §3.3 خطوة 6،
--     ومصفوفة §3.4: القسم الموقوف قراءته مسموحة وكتابته محجوبة، ويفحص ذلك
--     _hr_entitled لا company_has_feature وحدها).
--
--   يعتمد على 016 و029 و035 و038 و042 و053 و088 و092 و096 و098 و099
--   (كلها على main). قابل لإعادة التشغيل.
--   التراجع: migrations/_rollback/143_hr_module_employees.down.sql
--   (يحذف دوال وجداول HR؛ ويعيد قيد التجاوزات إلى مفاتيحه الأربعة).
-- ============================================================================


-- ============================================================================
-- 0) المتطلبات
-- ============================================================================
do $$
declare f text;
begin
  foreach f in array array[
    'public.current_company_id()', 'public.company_has_feature(text)',
    'public.is_banned(uuid)', 'public._feature_on(text)',
    'public._owner_require()', 'public.owner_capability(text)',
    'public.owner_critical_ok()', 'public.log_privileged(text,uuid,jsonb,jsonb)',
    'public._reason_check(text)', 'public.is_company_admin()'] loop
    if to_regprocedure(f) is null then
      raise exception '143 يتطلب %', f;
    end if;
  end loop;
  foreach f in array array[
    'public.companies', 'public.profiles', 'public.company_memberships',
    'public.whatsapp_subscriptions', 'public.subscription_plans',
    'public.plan_features', 'public.feature_flags',
    'public.company_permission_catalog', 'public.company_feature_overrides',
    'public.platform_feature_switches', 'public.subscription_audit_log',
    'public.notifications', 'public.privileged_audit'] loop
    if to_regclass(f) is null then
      raise exception '143 يتطلب الجدول %', f;
    end if;
  end loop;
end $$;


-- ============================================================================
-- 1) مفاتيح الميزات — سجل المفاتيح + المفتاح العام + مزايا الباقات + الكتالوج
--    كل شيء مطفأ: لا تفعيل تجاري في هذا الترحيل.
-- ============================================================================

-- 1.1) feature_flags: مفاتيح HR السبعة (التصميم §3.2).
insert into public.feature_flags (key, name, name_ar, description) values
  ('hr',            'HR Module',        'وحدة الموارد البشرية', 'البوابة الرئيسية لوحدة الموارد البشرية في الشركة.'),
  ('hr_employees',  'HR Employees',     'الموظفون والهيكل',    'ملفات الموظفين والأقسام والفروع والمسميات والاستيراد.'),
  ('hr_leave',      'HR Leave',         'الإجازات والاستئذان', 'طلبات الإجازات والاستئذان والأرصدة (المرحلة 3).'),
  ('hr_payroll',    'HR Payroll',       'الرواتب',              'الرواتب وكشوفها (المرحلة 6 — آخر مرحلة مالية).'),
  ('hr_tasks',      'HR Tasks',         'مهام الموظفين',       'مهام الموظفين وإسنادها (المرحلة 4).'),
  ('hr_attendance', 'HR Attendance',    'الحضور والانصراف',   'الحضور والانصراف والورديات (المرحلة 7).'),
  ('hr_reports',    'HR Reports',       'تقارير الموارد البشرية','التقارير والتصدير المتقدم للموارد البشرية.')
on conflict (key) do nothing;

-- 1.2) platform_feature_switches: المفتاح العام hr_module_enabled — مطفأ.
--     (شكل الجدول من 096: key / enabled / description / updated_by / updated_at.)
insert into public.platform_feature_switches (key, enabled, description) values
  ('hr_module_enabled', false, 'الإتاحة العامة لوحدة الموارد البشرية على المنصة كلها. إطفاؤه يوقف كل HR في كل شركة دون حذف بيانات.')
on conflict (key) do nothing;

-- 1.3) plan_features: صف لكل خطة × مفتاح HR — كلها enabled=false (لا تفعيل).
insert into public.plan_features (plan_id, feature_key, enabled, limits)
select sp.id, k.key, false, '{}'::jsonb
  from public.subscription_plans sp
 cross join (values ('hr'), ('hr_employees'), ('hr_leave'), ('hr_payroll'),
                    ('hr_tasks'), ('hr_attendance'), ('hr_reports')) as k(key)
on conflict (plan_id, feature_key) do nothing;

-- 1.4) company_permission_catalog: مفاتيح hr.* الستة عشر (التصميم §4.1 مع
--     تعديل موثَّق: مفاتيح الأدوار/التدقيق/الذاتية hr.roles.manage وhr.audit.view
--     وhr.leave.request وhr.self.view تُؤجَّل لمرحلتي الأدوار والخدمة الذاتية
--     لأن لا RPC يستخدمها في هذه المرحلة؛ ويُضاف بدلًا منها
--     hr.departments.manage وhr.announcements.manage كما في مهمة البناء.
--     default_supervisor/agent على نمط 098: المشرف يرى ويدير، والموظف بلا شيء
--     افتراضيًا — القرار النهائي في _hr_has_permission لا هنا.)
-- توسيع قيد مفتاح الكتالوج (098: نمط بلا نقطة ثانية) ليتسع لمفاتيح hr.*
-- بنقطتين (hr.employees.view) — بفحص التعريف الحالي أولًا؛ المفاتيح القائمة
-- كلها بنقطة واحدة فتبقى صالحة. (انحراف موثق عن التصميم §4.1: القيد
-- القديم لا يقبل مفاتيح hr.* المطلوبة في المهمة.)
do $$
declare v_con text; v_def text;
begin
  select conname, pg_get_constraintdef(oid) into v_con, v_def
    from pg_constraint
   where conrelid = 'public.company_permission_catalog'::regclass
     and contype = 'c' and pg_get_constraintdef(oid) like '%^[a-z]+%'
     limit 1;
  if v_con is not null and v_def not like '%(\\.[a-z_]+)%' then
    execute format('alter table public.company_permission_catalog drop constraint %I', v_con);
    alter table public.company_permission_catalog
      add constraint company_permission_catalog_key_check
      check (key ~ '^[a-z]+(\.[a-z_]+){1,2}$');
  end if;
end $$;

insert into public.company_permission_catalog (key, label_ar, description_ar, default_supervisor, default_agent, sort) values
  ('hr.employees.view',      'عرض الموظفين',          'عرض قوائم وتفاصيل الموظفين (الرقم القومي مقنّع في القوائم، وبلا رواتب).',        true,  false, 300),
  ('hr.employees.manage',    'إدارة الموظفين',        'إنشاء موظفين وتعديلهم وتغيير حالاتهم (الأرشفة لمالك الشركة ومدير HR فقط).',       true,  false, 301),
  ('hr.departments.manage',  'إدارة الهيكل التنظيمي', 'إدارة الأقسام والفروع والمسميات الوظيفية.',                                       true,  false, 302),
  ('hr.import',               'الاستيراد الجماعي',     'تنفيذ الاستيراد الجماعي للموظفين وعرض تشغيلاته.',                                 true,  false, 303),
  ('hr.link_account',        'ربط الموظف بحساب',     'ربط ملف موظف بحساب دخول / فك الربط (إجراء صريح موثّق فقط).',                    true,  false, 304),
  ('hr.payroll.view',        'عرض الرواتب',           'عرض الرواتب وكشوفها — مستقل تمامًا عن عرض الموظفين (المرحلة 6).',              false, false, 310),
  ('hr.payroll.manage',      'إدارة الرواتب',         'إنشاء الرواتب وتعديلها واعتمادها (المرحلة 6).',                                  false, false, 311),
  ('hr.leave.view',          'عرض الإجازات',         'عرض طلبات الإجازات والأرصدة (المرحلة 3).',                                       true,  false, 320),
  ('hr.leave.manage',        'إدارة الإجازات',       'اعتماد طلبات الإجازات ورفضها وإدارة الأنواع والأرصدة (المرحلة 3).',             true,  false, 321),
  ('hr.tasks.view',          'عرض مهام الموظفين',    'عرض مهام الموظفين (المرحلة 4).',                                                true,  false, 330),
  ('hr.tasks.manage',        'إدارة مهام الموظفين',  'إنشاء مهام الموظفين وإسنادها وإغلاقها (المرحلة 4).',                            true,  false, 331),
  ('hr.attendance.view',     'عرض الحضور',           'عرض الحضور والانصراف (المرحلة 7).',                                             true,  false, 340),
  ('hr.attendance.manage',   'إدارة الحضور',         'إدارة الحضور والانصراف والورديات (المرحلة 7).',                                 true,  false, 341),
  ('hr.reports.view',        'عرض تقارير HR',        'عرض تقارير الموارد البشرية والتصدير المتقدم.',                                   true,  false, 350),
  ('hr.settings.manage',     'إعدادات الموارد البشرية','تعديل إعدادات HR للشركة (الترقيم التلقائي وفترة التجربة ومدة الاحتفاظ بالسجل).',  true,  false, 351),
  ('hr.announcements.manage','إدارة إعلانات HR',     'إدارة الإعلانات الداخلية للموظفين (المرحلة 5).',                                true,  false, 352)
on conflict (key) do update set label_ar = excluded.label_ar, description_ar = excluded.description_ar,
  default_supervisor = excluded.default_supervisor, default_agent = excluded.default_agent, sort = excluded.sort;


-- ============================================================================
-- 2) توسيع company_feature_overrides لمفاتيح HR + حالة الإيقاف (التصميم §3.1)
--    آمن ضد الحالتين: القيد الضيق الأصلي (integrations_hub وحده) والقيد
--    الموسَّع الحي (4 مفاتيح: integrations_hub, shopify_integration,
--    store_support, shopify_management — خط الأساس 2026-11-25).
-- ============================================================================

-- 2.1) أعمدة الحالة (التصميم §3.1): الإيقاف حالة على صف التجاوز، لا حذف له.
alter table public.company_feature_overrides
  add column if not exists status text not null default 'active'
    check (status in ('active', 'suspended')),
  add column if not exists suspended_at timestamptz,
  add column if not exists suspended_by uuid,
  add column if not exists suspend_reason text
    check (status = 'active' or char_length(btrim(suspend_reason)) >= 10);

-- 2.2) توسيع قيد CHECK: يُفحص التعريف الحالي أولًا؛ إن كان يحوي مفاتيح hr
--     أصلًا يُتخطى، وإلا أُزيل وأُعيد إنشاؤه بالقائمة الكاملة (10 مفاتيح).
do $$
declare v_def text;
begin
  select pg_get_constraintdef(oid) into v_def
    from pg_constraint
   where conname = 'company_feature_overrides_pilot_only'
     and conrelid = 'public.company_feature_overrides'::regclass;
  if v_def is null then
    raise exception '143 يتطلب قيد company_feature_overrides_pilot_only (092 غير مطبّق)';
  end if;
  if v_def not like '%''hr''%' then
    alter table public.company_feature_overrides
      drop constraint company_feature_overrides_pilot_only;
    alter table public.company_feature_overrides
      add constraint company_feature_overrides_pilot_only
      check (feature_key in ('integrations_hub', 'shopify_integration', 'store_support',
                             'shopify_management', 'hr', 'hr_employees', 'hr_leave', 'hr_payroll',
                             'hr_tasks', 'hr_attendance', 'hr_reports'));
  end if;
end $$;

-- 2.3) company_has_feature(): نفس تعريف 099 حرفيًا مع شرط إضافي واحد —
--     التجاوز بحالة suspended لا يمنح الميزة (التصميم §3.3 خطوة 6).
--     القراءة في حالة الإيقاف تُسمح بها _hr_entitled (p_write=false) لا هنا.
create or replace function public.company_has_feature(p_feature_key text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select not (public._feature_on('company_suspension_enforced')
              and exists (select 1 from public.companies c where c.id = public.current_company_id() and c.status = 'suspended'))
  and (
  exists (
    select 1
      from public.companies c
      join public.whatsapp_subscriptions s on (s.company_id = c.id or s.user_id = c.user_id)
      join public.subscription_plans sp on sp.key = s.plan
      join public.plan_features pf on pf.plan_id = sp.id and pf.enabled = true
     where c.id = public.current_company_id()
       and s.status = 'active'
       and s.start_date <= now()
       and s.end_date   >  now()
       and pf.feature_key = p_feature_key)
  or exists (
    select 1
      from public.company_feature_overrides o
     where o.company_id = public.current_company_id()
       and o.feature_key = p_feature_key
       and o.status = 'active'
       and (o.expires_at is null or o.expires_at > now())));
$function$;
comment on function public.company_has_feature(text) is
  '143: كما في 099 + التجاوز الموقوف (status=suspended) لا يمنح الميزة. القراءة في حالة الإيقاف يسمح بها _hr_entitled(p_write=false).';

-- ============================================================================
-- 3) الجداول — كلها public.hr_*، وكلها company_id NOT NULL (عدا ما يُذكر)،
--    ولا عمود مالي في hr_employees إطلاقًا (التصميم المبدأ 9).
--    المفاتيح الخارجية المتقاطعة (موظف ↔ قسم/فرع/مسمى) تُضاف بـ ALTER في
--    فقرة 3.2 لأن الجداول تشير إلى بعضها دائريًا.
-- ============================================================================

-- 3.1.1) hr_employees — ملف الموظف (التصميم §2.1 + أعمدة المهمة:
--     date_of_birth وaddress وemergency_contact jsonb — كلها اختيارية).
create table if not exists public.hr_employees (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references public.companies(id) on delete cascade,
  employee_number       text not null,
  full_name             text not null check (char_length(btrim(full_name)) >= 2),
  phone                 text check (phone is null or char_length(btrim(phone)) between 7 and 20),
  email                 text,
  national_id           text,
  date_of_birth         date,
  address               text,
  emergency_contact     jsonb,
  department_id         uuid,
  branch_id             uuid,
  position_id           uuid,
  manager_employee_id   uuid references public.hr_employees(id) on delete set null,
  job_title             text,
  hire_date             date check (hire_date is null or hire_date <= current_date),
  contract_type         text check (contract_type is null or contract_type in ('full_time', 'part_time', 'contract', 'intern', 'temporary')),
  employment_status     text not null default 'active'
    check (employment_status in ('active', 'on_leave', 'suspended', 'terminated', 'pending_data')),
  user_id               uuid references public.profiles(id) on delete set null,
  notes                 text,
  created_by            uuid,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  archived_at           timestamptz,
  archived_by           uuid,
  archive_reason        text check (archived_at is null or char_length(btrim(archive_reason)) >= 10)
);
comment on table public.hr_employees is
  '143: ملف موظف إداري مستقل — ليس حساب دخول. user_id اختياري NULL دائمًا عند الإنشاء، يُملأ فقط بـ hr_link_employee_account.';

-- 3.1.2) الهيكل الهرمي (التصميم §2.2): نفس الشكل للجداول الثلاثة.
create table if not exists public.hr_departments (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references public.companies(id) on delete cascade,
  parent_id             uuid references public.hr_departments(id) on delete set null,
  name                  text not null check (char_length(btrim(name)) between 2 and 120),
  description           text check (description is null or char_length(description) <= 1000),
  manager_employee_id   uuid,
  is_active             boolean not null default true,
  sort_order            integer not null default 0,
  created_by            uuid,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  archived_at           timestamptz
);
create table if not exists public.hr_branches (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references public.companies(id) on delete cascade,
  parent_id             uuid references public.hr_branches(id) on delete set null,
  name                  text not null check (char_length(btrim(name)) between 2 and 120),
  description           text check (description is null or char_length(description) <= 1000),
  manager_employee_id   uuid,
  is_active             boolean not null default true,
  sort_order            integer not null default 0,
  created_by            uuid,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  archived_at           timestamptz
);
create table if not exists public.hr_positions (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references public.companies(id) on delete cascade,
  parent_id             uuid references public.hr_positions(id) on delete set null,
  name                  text not null check (char_length(btrim(name)) between 2 and 120),
  description           text check (description is null or char_length(description) <= 1000),
  manager_employee_id   uuid,
  department_id         uuid,
  level                 integer check (level is null or level between 1 and 10),
  is_active             boolean not null default true,
  sort_order            integer not null default 0,
  created_by            uuid,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  archived_at           timestamptz
);
comment on table public.hr_departments is '143: أقسام الشركة — هرمية ذاتية بعمق أقصى 6 (حارس _hr_org_depth_guard)، أرشفة لا حذف.';
comment on table public.hr_branches is '143: فروع الشركة — هرمية ذاتية بعمق أقصى 6 (حارس _hr_org_depth_guard)، أرشفة لا حذف.';
comment on table public.hr_positions is '143: المسميات الوظيفية — هرمية ذاتية بعمق أقصى 6، وقد تنتمي لقسم اختياريًا.';

-- 3.1.3) hr_settings — صف واحد لكل شركة (التصميم §2.3 + عمود settings jsonb
--     من مهمة البناء: إعداد الحقول الإلزامية وافتراضيات الإجازات/أيام العمل).
create table if not exists public.hr_settings (
  company_id                uuid primary key references public.companies(id) on delete cascade,
  employee_number_prefix    text not null default '' check (char_length(employee_number_prefix) <= 10),
  employee_number_next      integer not null default 1 check (employee_number_next >= 1),
  default_probation_months  integer not null default 3 check (default_probation_months between 0 and 12),
  audit_retention_months    integer not null default 24 check (audit_retention_months between 6 and 120),
  settings                  jsonb not null default '{}'::jsonb,
  updated_by                uuid,
  updated_at                timestamptz not null default now()
);
comment on table public.hr_settings is '143: إعدادات HR لكل شركة. settings jsonb يحمل إعداد الحقول الإلزامية وافتراضيات الإجازات/أيام العمل.';

-- 3.1.4) hr_audit_logs — سجل إلحاقي (التصميم §2.4): بلا updated_at، وحرّاس
--     تمنع UPDATE/DELETE/TRUNCATE (فقرة 5).
create table if not exists public.hr_audit_logs (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id) on delete cascade,
  employee_id     uuid,
  actor_user_id   uuid,
  actor_role      text,
  action          text not null,
  entity_type     text not null,
  entity_id       uuid,
  old_values      jsonb,
  new_values      jsonb,
  reason          text,
  created_at      timestamptz not null default now()
);
comment on table public.hr_audit_logs is '143: سجل تدقيق HR الإلحاقي — لا تعديل ولا حذف ولا تقطيع (حرّاس trigger).';

-- 3.1.5) hr_import_runs — تشغيلات الاستيراد (التصميم §2.5).
create table if not exists public.hr_import_runs (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies(id) on delete cascade,
  idempotency_key   uuid not null,
  initiated_by      uuid not null,
  file_name         text,
  status            text not null default 'completed' check (status in ('completed', 'partial', 'failed')),
  total_rows        integer not null default 0 check (total_rows >= 0),
  inserted_count    integer not null default 0 check (inserted_count >= 0),
  duplicate_count   integer not null default 0 check (duplicate_count >= 0),
  invalid_count     integer not null default 0 check (invalid_count >= 0),
  results           jsonb not null default '[]'::jsonb,
  created_at        timestamptz not null default now(),
  completed_at      timestamptz,
  unique (company_id, idempotency_key)
);
comment on table public.hr_import_runs is '143: تشغيلات الاستيراد الجماعي — إعادة إرسال نفس المفتاح ترجع النتيجة المخزنة دون إعادة تنفيذ.';

-- 3.1.6) hr_employee_status_history — تاريخ حالات الموظف (التصميم §2.6)، إلحاقي.
create table if not exists public.hr_employee_status_history (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  employee_id   uuid not null references public.hr_employees(id) on delete cascade,
  from_status   text,
  to_status     text not null,
  reason        text not null check (char_length(btrim(reason)) >= 10),
  changed_by    uuid,
  created_at    timestamptz not null default now()
);
comment on table public.hr_employee_status_history is '143: تاريخ حالات الموظف — إلحاقي، يُكتب من RPCs تغيير الحالة فقط.';

-- 3.1.7) hr_role_assignments — أدوار HR داخل الشركة (التصميم §2.7).
--     التعيين هنا، ومفاتيح الصلاحية نفسها في company_permission_catalog.
create table if not exists public.hr_role_assignments (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id) on delete cascade,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  employee_id     uuid,
  role            text not null check (role in ('hr_manager', 'hr_officer', 'dept_manager', 'payroll_officer')),
  department_id   uuid,
  granted_by      uuid,
  granted_at      timestamptz not null default now(),
  revoked_at      timestamptz,
  revoked_by      uuid,
  revoke_reason   text,
  created_at      timestamptz not null default now()
);
comment on table public.hr_role_assignments is '143: تعيينات أدوار HR (شركة + مستخدم) — الإبطال لا الحذف. لا RPCs منح/إبطال في هذه المرحلة؛ الجدول أساس مصفوفة الصلاحيات.';

-- 3.2) المفاتيح الخارجية المتقاطعة (بعد وجود كل الجداول).
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'hr_employees_department_fk') then
    alter table public.hr_employees add constraint hr_employees_department_fk
      foreign key (department_id) references public.hr_departments(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'hr_employees_branch_fk') then
    alter table public.hr_employees add constraint hr_employees_branch_fk
      foreign key (branch_id) references public.hr_branches(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'hr_employees_position_fk') then
    alter table public.hr_employees add constraint hr_employees_position_fk
      foreign key (position_id) references public.hr_positions(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'hr_departments_manager_fk') then
    alter table public.hr_departments add constraint hr_departments_manager_fk
      foreign key (manager_employee_id) references public.hr_employees(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'hr_branches_manager_fk') then
    alter table public.hr_branches add constraint hr_branches_manager_fk
      foreign key (manager_employee_id) references public.hr_employees(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'hr_positions_manager_fk') then
    alter table public.hr_positions add constraint hr_positions_manager_fk
      foreign key (manager_employee_id) references public.hr_employees(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'hr_positions_department_fk') then
    alter table public.hr_positions add constraint hr_positions_department_fk
      foreign key (department_id) references public.hr_departments(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'hr_audit_logs_employee_fk') then
    alter table public.hr_audit_logs add constraint hr_audit_logs_employee_fk
      foreign key (employee_id) references public.hr_employees(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'hr_role_assignments_employee_fk') then
    alter table public.hr_role_assignments add constraint hr_role_assignments_employee_fk
      foreign key (employee_id) references public.hr_employees(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'hr_role_assignments_department_fk') then
    alter table public.hr_role_assignments add constraint hr_role_assignments_department_fk
      foreign key (department_id) references public.hr_departments(id) on delete set null;
  end if;
end $$;


-- ============================================================================
-- 4) الفهارس — جزء من تعريف الجداول (تُنشأ هنا لكونها لاحقة للجداول في الملف).
-- ============================================================================
create unique index if not exists hr_employees_company_number_uidx
  on public.hr_employees (company_id, employee_number);
create index if not exists hr_employees_company_status_idx
  on public.hr_employees (company_id, employment_status);
create index if not exists hr_employees_company_dept_idx
  on public.hr_employees (company_id, department_id);
create index if not exists hr_employees_company_branch_idx
  on public.hr_employees (company_id, branch_id);
create index if not exists hr_employees_user_idx
  on public.hr_employees (user_id) where user_id is not null;
create index if not exists hr_employees_company_name_idx
  on public.hr_employees (company_id, full_name);
create unique index if not exists hr_employees_company_email_uidx
  on public.hr_employees (company_id, lower(email)) where email is not null;
create unique index if not exists hr_employees_company_national_uidx
  on public.hr_employees (company_id, national_id) where national_id is not null;

create index if not exists hr_departments_company_parent_idx
  on public.hr_departments (company_id, parent_id);
create unique index if not exists hr_departments_company_parent_name_uidx
  on public.hr_departments (company_id, (coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid)), name);
create index if not exists hr_branches_company_parent_idx
  on public.hr_branches (company_id, parent_id);
create unique index if not exists hr_branches_company_parent_name_uidx
  on public.hr_branches (company_id, (coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid)), name);
create index if not exists hr_positions_company_parent_idx
  on public.hr_positions (company_id, parent_id);
create unique index if not exists hr_positions_company_parent_name_uidx
  on public.hr_positions (company_id, (coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid)), name);

create index if not exists hr_audit_logs_company_created_idx
  on public.hr_audit_logs (company_id, created_at desc);
create index if not exists hr_audit_logs_company_employee_idx
  on public.hr_audit_logs (company_id, employee_id, created_at desc);
create index if not exists hr_audit_logs_company_action_idx
  on public.hr_audit_logs (company_id, action, created_at desc);
create index if not exists hr_import_runs_company_created_idx
  on public.hr_import_runs (company_id, created_at desc);
create index if not exists hr_employee_status_history_employee_idx
  on public.hr_employee_status_history (employee_id, created_at desc);
create unique index if not exists hr_role_assignments_active_uidx
  on public.hr_role_assignments (company_id, user_id, role, (coalesce(department_id, '00000000-0000-0000-0000-000000000000'::uuid)))
  where revoked_at is null;
create index if not exists hr_role_assignments_company_user_idx
  on public.hr_role_assignments (company_id, user_id);


-- ============================================================================
-- 5) المحفّزات: لمس updated_at، وحارس العمق ≤ 6، وحرّاس الإلحاقية.
-- ============================================================================

-- 5.1) لمس updated_at.
create or replace function public._hr_touch_updated_at()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  new.updated_at := now();
  return new;
end $$;
do $$
declare t text;
begin
  foreach t in array array['hr_employees', 'hr_departments', 'hr_branches', 'hr_positions', 'hr_settings'] loop
    execute format('drop trigger if exists trg_%I_updated_at on public.%I', t, t);
    execute format('create trigger trg_%I_updated_at before update on public.%I for each row execute function public._hr_touch_updated_at()', t, t);
  end loop;
end $$;

-- 5.2) حارس العمق ≤ 6 ومنع الحلقة الذاتية (التصميم §2.2 — على نمط admin_units
--     في 099: حارس إجرائي يمشي سلسلة parent_id، بلا عمود depth).
--     دالة واحدة للجداول الثلاثة عبر TG_TABLE_NAME.
create or replace function public._hr_org_depth_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_parent uuid := new.parent_id;
  v_depth  int := 1;
  v_seen   uuid[] := '{}'::uuid[];
  v_next   uuid;
begin
  if new.parent_id is null then
    return new;
  end if;
  if new.parent_id = new.id then
    raise exception 'لا يمكن أن تكون العقدة أبًا لنفسها' using errcode = '22023';
  end if;
  loop
    if v_parent = new.id then
      raise exception 'لا يمكن نقل عقدة تحت أحد أحفادها' using errcode = '22023';
    end if;
    if v_parent = any(v_seen) then
      raise exception 'حلقة في الهيكل التنظيمي' using errcode = '22023';
    end if;
    v_seen := v_seen || v_parent;
    v_depth := v_depth + 1;
    if v_depth > 6 then
      raise exception 'العمق الأقصى للهيكل التنظيمي 6 مستويات' using errcode = '22023';
    end if;
    execute format('select parent_id from public.%I where id = $1', TG_TABLE_NAME)
       using v_parent into v_next;
    if v_next is null then
      return new;
    end if;
    v_parent := v_next;
  end loop;
end $$;
do $$
declare t text;
begin
  foreach t in array array['hr_departments', 'hr_branches', 'hr_positions'] loop
    execute format('drop trigger if exists trg_%I_depth_guard on public.%I', t, t);
    execute format('create trigger trg_%I_depth_guard before insert or update of parent_id on public.%I for each row execute function public._hr_org_depth_guard()', t, t);
  end loop;
end $$;

-- 5.3) حرّاس الإلحاقية: hr_audit_logs وhr_employee_status_history بلا
--     UPDATE/DELETE/TRUNCATE (على نمط hierarchy_events في 099).
create or replace function public._hr_audit_immutable()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  raise exception 'سجل HR إلحاقي: لا تعديل ولا حذف ولا تقطيع' using errcode = '42501';
end $$;
do $$
declare t text;
begin
  foreach t in array array['hr_audit_logs', 'hr_employee_status_history'] loop
    execute format('drop trigger if exists trg_%I_immutable on public.%I', t, t);
    execute format('create trigger trg_%I_immutable before update or delete on public.%I for each row execute function public._hr_audit_immutable()', t, t);
    execute format('drop trigger if exists trg_%I_no_truncate on public.%I', t, t);
    execute format('create trigger trg_%I_no_truncate before truncate on public.%I for each statement execute function public._hr_audit_immutable()', t, t);
  end loop;
end $$;


-- ============================================================================
-- 6) RLS — رفض افتراضي على نمط 096/113: كل الصلاحيات مسحوبة، وسياسة تقييدية
--    واحدة gate_account_active فقط، ولا قراءة مباشرة من الواجهة إطلاقًا.
-- ============================================================================
do $$
declare t text;
begin
  foreach t in array array['hr_employees', 'hr_departments', 'hr_branches', 'hr_positions',
                          'hr_settings', 'hr_audit_logs', 'hr_import_runs',
                          'hr_employee_status_history', 'hr_role_assignments'] loop
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
-- 7) الدوال الداخلية _hr_* — بلا GRANT إطلاقًا (تُسحب في فقرة 10).
-- ============================================================================

-- 7.1) _hr_entitled: هل تملك الشركة المفتاح؟ مسار الباقة (كما في
--     company_has_feature حرفيًا) أو تجاوز سارٍ. القسم الموقوف: الكتابة
--     محجوبة والقراءة مسموحة (التصميم §3.4) — يفرّق بينهما p_write.
create or replace function public._hr_entitled(p_company uuid, p_feature_key text, p_write boolean default true)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select
    exists (
      select 1
        from public.companies c
        join public.whatsapp_subscriptions s on (s.company_id = c.id or s.user_id = c.user_id)
        join public.subscription_plans sp on sp.key = s.plan
        join public.plan_features pf on pf.plan_id = sp.id and pf.enabled = true
       where c.id = p_company
         and s.status = 'active'
         and s.start_date <= now()
         and s.end_date   >  now()
         and pf.feature_key = p_feature_key)
    or exists (
      select 1
        from public.company_feature_overrides o
       where o.company_id = p_company
         and o.feature_key = p_feature_key
         and (o.expires_at is null or o.expires_at > now())
         and (o.status = 'active' or (not p_write and o.status = 'suspended')));
$$;

-- 7.2) _hr_gate: بوابة كل RPC في HR (التصميم §3.3) — بالترتيب: الحظر، ثم
--     مفتاح المنصة، ثم الشركة من الجلسة، ثم إيقاف الشركة (خلف مفتاحه)، ثم
--     استحقاق 'hr'، ثم استحقاق القسم. ترجع company_id للاستخدام داخل RPC.
create or replace function public._hr_gate(p_section_key text, p_write boolean default true)
returns uuid
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare v_company uuid;
begin
  -- HIGH في التدقيق: account_is_active() لا تستدعي is_banned() — كل RPC
  -- في HR يفحص الحظر صراحةً ولا يعتمد على سياسة gate_account_active وحدها.
  if coalesce(public.is_banned(), false) then
    raise exception 'الحساب محظور' using errcode = '42501';
  end if;
  if not public._feature_on('hr_module_enabled') then
    raise exception 'وحدة الموارد البشرية متوقفة على مستوى المنصة' using errcode = '42501';
  end if;
  v_company := public.current_company_id();
  if v_company is null then
    raise exception 'لا توجد شركة مرتبطة بحسابك' using errcode = '42501';
  end if;
  if public._feature_on('company_suspension_enforced')
     and exists (select 1 from public.companies c where c.id = v_company and c.status = 'suspended') then
    raise exception 'الشركة موقوفة' using errcode = '42501';
  end if;
  if not public._hr_entitled(v_company, 'hr', p_write) then
    raise exception 'وحدة الموارد البشرية غير متاحة لشركتك' using errcode = '42501';
  end if;
  if p_section_key <> 'hr' and not public._hr_entitled(v_company, p_section_key, p_write) then
    raise exception 'هذا القسم غير مفعّل لشركتك' using errcode = '42501';
  end if;
  return v_company;
end $$;

-- 7.3) مالك الشركة: يملك الشركة الحالية (العلاقة) أو is_company_admin()
--     (الرتبة + العلاقة). العلاقة وحدها تكفي هنا لأن السياق الحالي هو الشركة.
create or replace function public._hr_is_company_admin(p_company uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (select 1 from public.companies c where c.id = p_company and c.user_id = auth.uid())
      or coalesce(public.is_company_admin(), false);
$$;

-- 7.4) _hr_has_permission: مصفوفة الأدوار (التصميم §4.2). مالك الشركة كل
--     المفاتيح؛ الأدوار من hr_role_assignments النشطة؛ الذاتية من الربط.
--     payroll_officer يحمل مفاتيح الرواتب فقط — وهي خاملة في المرحلة 2
--     (لا RPC رواتب بعد)، وتُفعَّل مع جداول الرواتب في المرحلة 6.
create or replace function public._hr_has_permission(p_company uuid, p_key text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select public._hr_is_company_admin(p_company)
      or (p_key = 'hr.self.view'
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

-- 7.5) الأرشفة لمالك الشركة ومدير HR فقط (التصميم §4.2 — موظف HR العادي
--     لا يؤرشف).
create or replace function public._hr_can_archive(p_company uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select public._hr_is_company_admin(p_company)
      or exists (select 1 from public.hr_role_assignments r
                  where r.company_id = p_company and r.user_id = auth.uid()
                    and r.role = 'hr_manager' and r.revoked_at is null);
$$;

-- 7.6) ملف الموظف المرتبط بالمتصل (أساس الخدمة الذاتية) ونطاق قسمه.
create or replace function public._hr_my_employee_id(p_company uuid)
returns uuid
language sql
stable
security definer
set search_path to 'public'
as $$
  select e.id from public.hr_employees e
   where e.company_id = p_company and e.user_id = auth.uid() and e.archived_at is null
   limit 1;
$$;

create or replace function public._hr_dept_scope(p_company uuid)
returns uuid
language sql
stable
security definer
set search_path to 'public'
as $$
  select r.department_id from public.hr_role_assignments r
   where r.company_id = p_company and r.user_id = auth.uid()
     and r.role = 'dept_manager' and r.revoked_at is null
     and r.department_id is not null
   limit 1;
$$;

-- 7.7) كتابة سجل HR + سجل الاشتراكات (للأحداث التي بلا اشتراك — التصميم §3.5:
--     subscription_id يبقى NULL والهدف مالك الشركة).
create or replace function public._hr_audit(p_company uuid, p_action text, p_entity_type text,
                                           p_entity_id uuid, p_employee_id uuid,
                                           p_old jsonb, p_new jsonb, p_reason text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  insert into public.hr_audit_logs
    (company_id, employee_id, actor_user_id, actor_role, action, entity_type, entity_id,
     old_values, new_values, reason)
  values (p_company, p_employee_id, auth.uid(),
          (select role from public.profiles where id = auth.uid()),
          p_action, p_entity_type, p_entity_id, p_old, p_new, p_reason);
end $$;

create or replace function public._hr_subscription_audit(p_company uuid, p_action text,
                                                         p_old jsonb, p_new jsonb, p_reason text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  insert into public.subscription_audit_log
    (subscription_id, target_user_id, actor_user_id, actor_email, action, old_values, new_values, reason)
  values (null,
          (select user_id from public.companies where id = p_company),
          auth.uid(),
          (select email from public.profiles where id = auth.uid()),
          p_action, p_old, p_new, nullif(btrim(coalesce(p_reason, '')), ''));
end $$;

-- 7.8) تقنيع الرقم القومي في القوائم (التصميم §2.1): أول 3 + نجوم + آخر 2.
--     الصيغة الدقيقة اختيار هذه المرحلة؛ الكامل يظهر فقط في التفاصيل لحاملي
--     الصلاحية الكاملة.
create or replace function public._hr_mask_national_id(p_national_id text)
returns text
language sql
immutable
set search_path to 'public'
as $$
  select case when p_national_id is null then null
              when char_length(p_national_id) < 6 then '****'
              else left(p_national_id, 3) || '********' || right(p_national_id, 2)
         end;
$$;

-- 7.9) الترقيم التلقائي من hr_settings (البادئة + العدّاد — التصميم §5.1):
--     يُنشئ صف الإعدادات إن غاب، ويقفز فوق أي رقم مستخدم فعلًا.
create or replace function public._hr_next_employee_number(p_company uuid)
returns text
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_prefix text;
  v_next   int;
  v_num    text;
  v_tries  int := 0;
begin
  insert into public.hr_settings (company_id) values (p_company)
    on conflict (company_id) do nothing;
  select employee_number_prefix, employee_number_next into v_prefix, v_next
    from public.hr_settings where company_id = p_company for update;
  loop
    v_num := coalesce(v_prefix, '') || lpad(v_next::text, 4, '0');
    exit when not exists (select 1 from public.hr_employees e
                           where e.company_id = p_company and e.employee_number = v_num);
    v_next := v_next + 1;
    v_tries := v_tries + 1;
    if v_tries > 100 then
      raise exception 'تعذّر توليد رقم وظيفي متاح' using errcode = 'P0001';
    end if;
  end loop;
  update public.hr_settings set employee_number_next = v_next + 1, updated_by = auth.uid()
   where company_id = p_company;
  return v_num;
end $$;

-- 7.10) التحقق المشترك بين الإنشاء اليدوي والاستيراد (التصميم §5.7 و§6.3):
--      قاعدة واحدة لا منطقين. يرجع {valid, code, reason, normalized}.
--      التكرار داخل الملف نفسه مسؤولية المستدعي (الاستيراد)، لا هذه الدالة.
--      المدير غير الموجود في قاعدة البيانات يُرجع unknown_manager مع
--      manager_in_db=false — والاستيراد قد يحلّه من الملف نفسه.
create or replace function public._hr_validate_employee_row(p_row jsonb, p_company uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_name        text := btrim(coalesce(p_row ->> 'full_name', ''));
  v_number      text := nullif(btrim(coalesce(p_row ->> 'employee_number', '')), '');
  v_phone       text := nullif(btrim(coalesce(p_row ->> 'phone', '')), '');
  v_email       text := nullif(btrim(coalesce(p_row ->> 'email', '')), '');
  v_nid         text := nullif(btrim(coalesce(p_row ->> 'national_id', '')), '');
  v_dept_name   text := nullif(btrim(coalesce(p_row ->> 'department', '')), '');
  v_branch_name text := nullif(btrim(coalesce(p_row ->> 'branch', '')), '');
  v_pos_name    text := nullif(btrim(coalesce(p_row ->> 'position', '')), '');
  v_mgr_number  text := nullif(btrim(coalesce(p_row ->> 'manager_employee_number', '')), '');
  v_job         text := nullif(btrim(coalesce(p_row ->> 'job_title', '')), '');
  v_hire_txt    text := nullif(btrim(coalesce(p_row ->> 'hire_date', '')), '');
  v_contract    text := nullif(btrim(coalesce(p_row ->> 'contract_type', '')), '');
  v_hire        date;
  v_dept_id     uuid;
  v_branch_id   uuid;
  v_pos_id      uuid;
  v_mgr_id      uuid;
  v_norm        jsonb;
  v_fail        jsonb;
begin
  if char_length(v_name) < 2 then
    return jsonb_build_object('valid', false, 'code', 'missing_name', 'reason', 'الاسم مطلوب (حرفان على الأقل)');
  end if;
  if v_number is not null and v_number ~ '\s' then
    return jsonb_build_object('valid', false, 'code', 'missing_employee_number', 'reason', 'الرقم الوظيفي بلا مسافات');
  end if;
  if v_number is not null and exists (select 1 from public.hr_employees e
                                       where e.company_id = p_company and e.employee_number = v_number) then
    return jsonb_build_object('valid', false, 'code', 'duplicate_employee_number', 'reason', 'الرقم الوظيفي مستخدم بالفعل في شركتك');
  end if;
  if v_phone is not null and (char_length(v_phone) < 7 or char_length(v_phone) > 20
      or v_phone !~ '^\+?[0-9][0-9 ()-]*$') then
    return jsonb_build_object('valid', false, 'code', 'invalid_phone', 'reason', 'رقم هاتف غير صالح');
  end if;
  if v_email is not null and (char_length(v_email) > 320 or v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$') then
    return jsonb_build_object('valid', false, 'code', 'invalid_email', 'reason', 'بريد إلكتروني غير صالح');
  end if;
  if v_email is not null and exists (select 1 from public.hr_employees e
                                      where e.company_id = p_company and lower(e.email) = lower(v_email)) then
    return jsonb_build_object('valid', false, 'code', 'duplicate_email', 'reason', 'البريد الإلكتروني مستخدم بالفعل في شركتك');
  end if;
  if v_nid is not null and (char_length(v_nid) < 10 or char_length(v_nid) > 20) then
    return jsonb_build_object('valid', false, 'code', 'invalid_national_id', 'reason', 'الرقم القومي بين 10 و20 حرفًا');
  end if;
  if v_nid is not null and exists (select 1 from public.hr_employees e
                                    where e.company_id = p_company and e.national_id = v_nid) then
    return jsonb_build_object('valid', false, 'code', 'duplicate_national_id', 'reason', 'الرقم القومي مستخدم بالفعل في شركتك');
  end if;
  if v_hire_txt is not null then
    if v_hire_txt !~ '^\d{4}-\d{2}-\d{2}$' then
      return jsonb_build_object('valid', false, 'code', 'invalid_date', 'reason', 'تاريخ التعيين بصيغة YYYY-MM-DD');
    end if;
    begin
      v_hire := v_hire_txt::date;
    exception when others then
      return jsonb_build_object('valid', false, 'code', 'invalid_date', 'reason', 'تاريخ التعيين غير صالح');
    end;
    if v_hire > current_date then
      return jsonb_build_object('valid', false, 'code', 'invalid_date', 'reason', 'تاريخ التعيين لا يكون في المستقبل');
    end if;
  end if;
  if v_contract is not null and v_contract not in ('full_time', 'part_time', 'contract', 'intern', 'temporary') then
    return jsonb_build_object('valid', false, 'code', 'invalid_contract_type', 'reason', 'نوع عقد غير صالح');
  end if;
  if v_dept_name is not null then
    select id into v_dept_id from public.hr_departments
     where company_id = p_company and lower(btrim(name)) = lower(v_dept_name)
       and archived_at is null and is_active limit 1;
    if v_dept_id is null then
      return jsonb_build_object('valid', false, 'code', 'unknown_department', 'reason', 'القسم غير موجود في شركتك: ' || v_dept_name);
    end if;
  end if;
  if v_branch_name is not null then
    select id into v_branch_id from public.hr_branches
     where company_id = p_company and lower(btrim(name)) = lower(v_branch_name)
       and archived_at is null and is_active limit 1;
    if v_branch_id is null then
      return jsonb_build_object('valid', false, 'code', 'unknown_branch', 'reason', 'الفرع غير موجود في شركتك: ' || v_branch_name);
    end if;
  end if;
  if v_pos_name is not null then
    select id into v_pos_id from public.hr_positions
     where company_id = p_company and lower(btrim(name)) = lower(v_pos_name)
       and archived_at is null and is_active limit 1;
    if v_pos_id is null then
      return jsonb_build_object('valid', false, 'code', 'unknown_position', 'reason', 'المسمى الوظيفي غير موجود في شركتك: ' || v_pos_name);
    end if;
  end if;
  if v_mgr_number is not null then
    select id into v_mgr_id from public.hr_employees
     where company_id = p_company and employee_number = v_mgr_number and archived_at is null limit 1;
    if v_mgr_id is null then
      -- ليس فشلًا نهائيًا للاستيراد: قد يكون المدير صفًا لاحقًا في الملف نفسه.
      return jsonb_build_object('valid', false, 'code', 'unknown_manager',
        'reason', 'الرقم الوظيفي للمدير غير موجود: ' || v_mgr_number, 'manager_in_db', false,
        'normalized', jsonb_build_object(
          'full_name', v_name, 'employee_number', v_number, 'phone', v_phone, 'email', v_email,
          'national_id', v_nid, 'department_id', v_dept_id, 'branch_id', v_branch_id,
          'position_id', v_pos_id, 'manager_employee_number', v_mgr_number,
          'job_title', v_job, 'hire_date', v_hire_txt, 'contract_type', v_contract));
    end if;
  end if;
  v_norm := jsonb_build_object(
    'full_name', v_name, 'employee_number', v_number, 'phone', v_phone, 'email', v_email,
    'national_id', v_nid, 'department_id', v_dept_id, 'branch_id', v_branch_id,
    'position_id', v_pos_id, 'manager_employee_id', v_mgr_id,
    'manager_employee_number', v_mgr_number, 'job_title', v_job, 'hire_date', v_hire_txt,
    'contract_type', v_contract,
    'employment_status', case when v_phone is null and v_email is null then 'pending_data' else 'active' end);
  return jsonb_build_object('valid', true, 'code', null, 'reason', null, 'normalized', v_norm);
end $$;

-- 7.11) _hr_in_my_scope: هل هذا الموظف في نطاق المنادي؟ (على نمط
--     ticket_in_my_scope — boolean عن المنادي فقط، بلا تسريب.)
create or replace function public._hr_in_my_scope(p_employee_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select auth.uid() is not null
     and not coalesce(public.is_banned(), false)
     and exists (
       select 1 from public.hr_employees e
        where e.id = p_employee_id
          and e.company_id = public.current_company_id()
          and e.archived_at is null
          and (
            public._hr_is_company_admin(e.company_id)
            or public._hr_has_permission(e.company_id, 'hr.employees.view')
               and (public._hr_dept_scope(e.company_id) is null
                    or e.department_id = public._hr_dept_scope(e.company_id)
                    or e.manager_employee_id = public._hr_my_employee_id(e.company_id))
            or e.id = public._hr_my_employee_id(e.company_id)
          ));
$$;

-- ============================================================================
-- 8) RPCs الشركة — الموظفون (التصميم §5.1)
--    كلها SECURITY DEFINER، والشركة من current_company_id() لا من معامل.
-- ============================================================================

-- 8.1) قائمة الموظفين: ترقيم خادم + بحث خادم + فلاتر خادم (بلا تصفية عميل).
--     الرقم القومي مقنّع في القوائم دائمًا. نطاق مدير القسم يُطبق في WHERE.
create or replace function public.hr_employees_list(p_page integer default 1, p_page_size integer default 20,
                                                   p_search text default null, p_status text default null,
                                                   p_department_id uuid default null, p_branch_id uuid default null,
                                                   p_include_archived boolean default false)
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
  v_term     text := nullif(btrim(coalesce(p_search, '')), '');
  v_admin    boolean;
  v_can_view boolean;
  v_self_id  uuid;
  v_scope    uuid;
begin
  v_company := public._hr_gate('hr_employees', false);
  v_admin := public._hr_is_company_admin(v_company);
  v_can_view := public._hr_has_permission(v_company, 'hr.employees.view');
  v_self_id := public._hr_my_employee_id(v_company);
  if not v_can_view and v_self_id is null then
    raise exception 'لا تملك صلاحية عرض الموظفين' using errcode = '42501';
  end if;
  v_scope := case when v_admin then null else public._hr_dept_scope(v_company) end;
  if p_status is not null and p_status not in ('active', 'on_leave', 'suspended', 'terminated', 'pending_data') then
    raise exception 'حالة غير صالحة' using errcode = '22023';
  end if;
  if v_term is not null then
    v_term := replace(replace(replace(v_term, '\', '\\'), '%', '\%'), '_', '\_');
  end if;
  return (
    with f as (
      select e.* from public.hr_employees e
       where e.company_id = v_company
         and (coalesce(p_include_archived, false) or e.employment_status <> 'terminated')
         and (p_status is null or e.employment_status = p_status)
         and (p_department_id is null or e.department_id = p_department_id)
         and (p_branch_id is null or e.branch_id = p_branch_id)
         and (v_can_view or e.id = v_self_id)
         and (v_scope is null or e.department_id = v_scope or e.manager_employee_id = v_self_id)
         and (v_term is null
              or e.full_name ilike '%' || v_term || '%' escape '\'
              or e.employee_number ilike '%' || v_term || '%' escape '\'
              or coalesce(e.phone, '') ilike '%' || v_term || '%' escape '\')
    )
    select jsonb_build_object(
      'rows', coalesce((select jsonb_agg(jsonb_build_object(
          'id', s.id, 'employee_number', s.employee_number, 'full_name', s.full_name,
          'phone', s.phone, 'email', s.email,
          'national_id', public._hr_mask_national_id(s.national_id),
          'department_id', s.department_id, 'department_name', s.department_name,
          'branch_id', s.branch_id, 'branch_name', s.branch_name,
          'position_id', s.position_id, 'position_name', s.position_name,
          'manager_employee_id', s.manager_employee_id, 'manager_name', s.manager_name,
          'job_title', s.job_title, 'hire_date', s.hire_date, 'contract_type', s.contract_type,
          'employment_status', s.employment_status, 'linked', s.user_id is not null,
          'created_at', s.created_at)
        order by s.full_name)
        from (select f.*,
                     (select name from public.hr_departments where id = f.department_id) department_name,
                     (select name from public.hr_branches where id = f.branch_id) branch_name,
                     (select name from public.hr_positions where id = f.position_id) position_name,
                     (select full_name from public.hr_employees where id = f.manager_employee_id) manager_name
                from f order by f.full_name limit v_size offset (v_page - 1) * v_size) s), '[]'::jsonb),
      'total', (select count(*) from f),
      'total_count', (select count(*) from f),
      'page', v_page, 'page_size', v_size));
end $$;
comment on function public.hr_employees_list(integer, integer, text, text, uuid, uuid, boolean) is
  '143: قائمة موظفين بترقيم وبحث خادمين (20 افتراضيًا، 100 حدًا أقصى). الرقم القومي مقنّع؛ نطاق مدير القسم في WHERE.';

-- 8.2) عدّادات مجمعة للوحة (بلا جلب صفوف).
create or replace function public.hr_employees_count()
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
begin
  v_company := public._hr_gate('hr_employees', false);
  v_admin := public._hr_is_company_admin(v_company);
  v_can_view := public._hr_has_permission(v_company, 'hr.employees.view');
  v_self_id := public._hr_my_employee_id(v_company);
  if not v_can_view and v_self_id is null then
    raise exception 'لا تملك صلاحية عرض الموظفين' using errcode = '42501';
  end if;
  v_scope := case when v_admin then null else public._hr_dept_scope(v_company) end;
  return (select jsonb_build_object(
      'total', count(*),
      'active', count(*) filter (where e.employment_status = 'active'),
      'on_leave', count(*) filter (where e.employment_status = 'on_leave'),
      'suspended', count(*) filter (where e.employment_status = 'suspended'),
      'terminated', count(*) filter (where e.employment_status = 'terminated'),
      'pending_data', count(*) filter (where e.employment_status = 'pending_data'),
      'linked', count(*) filter (where e.user_id is not null))
    from public.hr_employees e
   where e.company_id = v_company
     and (v_can_view or e.id = v_self_id)
     and (v_scope is null or e.department_id = v_scope or e.manager_employee_id = v_self_id));
end $$;

-- 8.3) إنشاء موظف: user_id يبقى NULL دائمًا؛ الرقم الفارغ يُرقَّم تلقائيًا.
create or replace function public.hr_employee_create(p_full_name text, p_employee_number text,
                                                    p_phone text default null, p_email text default null,
                                                    p_national_id text default null,
                                                    p_department_id uuid default null, p_branch_id uuid default null,
                                                    p_position_id uuid default null, p_manager_employee_id uuid default null,
                                                    p_job_title text default null, p_hire_date date default null,
                                                    p_contract_type text default null,
                                                    p_date_of_birth date default null, p_address text default null,
                                                    p_emergency_contact jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  v_val     jsonb;
  v_norm    jsonb;
  v_num     text;
  v_id      uuid;
  v_row     jsonb;
begin
  v_company := public._hr_gate('hr_employees', true);
  if not public._hr_has_permission(v_company, 'hr.employees.manage') then
    raise exception 'لا تملك صلاحية إدارة الموظفين' using errcode = '42501';
  end if;
  v_row := jsonb_build_object(
    'full_name', p_full_name, 'employee_number', p_employee_number, 'phone', p_phone,
    'email', p_email, 'national_id', p_national_id,
    'department', (select name from public.hr_departments where id = p_department_id),
    'branch', (select name from public.hr_branches where id = p_branch_id),
    'position', (select name from public.hr_positions where id = p_position_id),
    'manager_employee_number', (select employee_number from public.hr_employees where id = p_manager_employee_id),
    'job_title', p_job_title,
    'hire_date', case when p_hire_date is null then null else to_char(p_hire_date, 'YYYY-MM-DD') end,
    'contract_type', p_contract_type);
  -- المراجع بمعرّفات UUID يجب أن تنتمي لنفس الشركة (أي مرجع من شركة أخرى
  -- يُرفض دون تسريب وجوده — الرسالة عامة عمدًا).
  if p_department_id is not null and not exists (select 1 from public.hr_departments where id = p_department_id and company_id = v_company) then
    raise exception 'القسم غير موجود' using errcode = 'P0002';
  end if;
  if p_branch_id is not null and not exists (select 1 from public.hr_branches where id = p_branch_id and company_id = v_company) then
    raise exception 'الفرع غير موجود' using errcode = 'P0002';
  end if;
  if p_position_id is not null and not exists (select 1 from public.hr_positions where id = p_position_id and company_id = v_company) then
    raise exception 'المسمى الوظيفي غير موجود' using errcode = 'P0002';
  end if;
  if p_manager_employee_id is not null and not exists (select 1 from public.hr_employees where id = p_manager_employee_id and company_id = v_company and archived_at is null) then
    raise exception 'المدير غير موجود' using errcode = 'P0002';
  end if;
  v_val := public._hr_validate_employee_row(v_row, v_company);
  if not (v_val ->> 'valid')::boolean then
    raise exception '%', (v_val ->> 'reason') using errcode = '22023';
  end if;
  v_norm := v_val -> 'normalized';
  v_num := v_norm ->> 'employee_number';
  if v_num is null then
    v_num := public._hr_next_employee_number(v_company);
  end if;
  begin
    -- المعرّفات الممرَّرة نفسها (بعد فحص انتمائها للشركة أعلاه) لا المعرّفات
    -- المحلولة بالاسم من المحقق — فالاسم قد يتكرر تحت آباء مختلفين.
    insert into public.hr_employees
      (company_id, employee_number, full_name, phone, email, national_id, date_of_birth, address,
       emergency_contact, department_id, branch_id, position_id, manager_employee_id,
       job_title, hire_date, contract_type, employment_status, created_by)
    values (v_company, v_num, v_norm ->> 'full_name', v_norm ->> 'phone', v_norm ->> 'email',
            v_norm ->> 'national_id', p_date_of_birth, nullif(btrim(coalesce(p_address, '')), ''),
            p_emergency_contact,
            p_department_id, p_branch_id, p_position_id, p_manager_employee_id,
            v_norm ->> 'job_title',
            case when v_norm ->> 'hire_date' is null then null else (v_norm ->> 'hire_date')::date end,
            v_norm ->> 'contract_type', 'active', auth.uid())
    returning id into v_id;
  exception when unique_violation then
    raise exception 'الرقم الوظيفي مستخدم بالفعل في شركتك' using errcode = '23505';
  end;
  insert into public.hr_employee_status_history (company_id, employee_id, from_status, to_status, reason, changed_by)
  values (v_company, v_id, null, 'active', 'إنشاء ملف الموظف', auth.uid());
  perform public._hr_audit(v_company, 'employee.created', 'employee', v_id, v_id, null,
    jsonb_build_object('employee_number', v_num, 'full_name', v_norm ->> 'full_name'), null);
  return jsonb_build_object('employee_id', v_id, 'employee_number', v_num);
end $$;

-- 8.4) تعديل موظف: NULL تعني «بلا تغيير» عدا الحقول القابلة للمسح صراحةً
--     (سلسلة فارغة). لا يغيّر employee_number ولا user_id ولا employment_status.
create or replace function public.hr_employee_update(p_employee_id uuid, p_full_name text default null,
                                                    p_phone text default null, p_email text default null,
                                                    p_national_id text default null,
                                                    p_department_id uuid default null, p_branch_id uuid default null,
                                                    p_position_id uuid default null, p_manager_employee_id uuid default null,
                                                    p_job_title text default null, p_hire_date date default null,
                                                    p_contract_type text default null,
                                                    p_date_of_birth date default null, p_address text default null,
                                                    p_emergency_contact jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  e         public.hr_employees;
  v_name    text;
  v_phone   text;
  v_email   text;
  v_nid     text;
  v_job     text;
  v_addr    text;
  v_mgr     uuid;
  v_old     jsonb;
  v_new     jsonb;
  v_walk    uuid;
  v_seen    uuid[] := '{}'::uuid[];
begin
  v_company := public._hr_gate('hr_employees', true);
  if not public._hr_has_permission(v_company, 'hr.employees.manage') then
    raise exception 'لا تملك صلاحية إدارة الموظفين' using errcode = '42501';
  end if;
  select * into e from public.hr_employees where id = p_employee_id and company_id = v_company;
  if not found then
    raise exception 'الموظف غير موجود' using errcode = 'P0002';
  end if;
  if e.archived_at is not null then
    raise exception 'الموظف مؤرشف — أعد تفعيله أولًا قبل التعديل' using errcode = '22023';
  end if;
  v_name := case when p_full_name is null then e.full_name else btrim(p_full_name) end;
  v_phone := case when p_phone is null then e.phone when btrim(p_phone) = '' then null else btrim(p_phone) end;
  v_email := case when p_email is null then e.email when btrim(p_email) = '' then null else btrim(p_email) end;
  v_nid := case when p_national_id is null then e.national_id when btrim(p_national_id) = '' then null else btrim(p_national_id) end;
  v_job := case when p_job_title is null then e.job_title when btrim(p_job_title) = '' then null else btrim(p_job_title) end;
  v_addr := case when p_address is null then e.address when btrim(p_address) = '' then null else btrim(p_address) end;
  v_mgr := coalesce(p_manager_employee_id, e.manager_employee_id);
  if char_length(v_name) < 2 then
    raise exception 'الاسم مطلوب (حرفان على الأقل)' using errcode = '22023';
  end if;
  if v_phone is not null and (char_length(v_phone) < 7 or char_length(v_phone) > 20 or v_phone !~ '^\+?[0-9][0-9 ()-]*$') then
    raise exception 'رقم هاتف غير صالح' using errcode = '22023';
  end if;
  if v_email is not null and (char_length(v_email) > 320 or v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$') then
    raise exception 'بريد إلكتروني غير صالح' using errcode = '22023';
  end if;
  if v_email is not null and exists (select 1 from public.hr_employees x where x.company_id = v_company and x.id <> e.id and lower(x.email) = lower(v_email)) then
    raise exception 'البريد الإلكتروني مستخدم بالفعل في شركتك' using errcode = '22023';
  end if;
  if v_nid is not null and (char_length(v_nid) < 10 or char_length(v_nid) > 20) then
    raise exception 'الرقم القومي بين 10 و20 حرفًا' using errcode = '22023';
  end if;
  if v_nid is not null and exists (select 1 from public.hr_employees x where x.company_id = v_company and x.id <> e.id and x.national_id = v_nid) then
    raise exception 'الرقم القومي مستخدم بالفعل في شركتك' using errcode = '22023';
  end if;
  if coalesce(p_hire_date, e.hire_date) is not null and coalesce(p_hire_date, e.hire_date) > current_date then
    raise exception 'تاريخ التعيين لا يكون في المستقبل' using errcode = '22023';
  end if;
  if coalesce(p_contract_type, e.contract_type) is not null
     and coalesce(p_contract_type, e.contract_type) not in ('full_time', 'part_time', 'contract', 'intern', 'temporary') then
    raise exception 'نوع عقد غير صالح' using errcode = '22023';
  end if;
  if coalesce(p_date_of_birth, e.date_of_birth) is not null and coalesce(p_date_of_birth, e.date_of_birth) > current_date then
    raise exception 'تاريخ الميلاد لا يكون في المستقبل' using errcode = '22023';
  end if;
  if p_department_id is not null and not exists (select 1 from public.hr_departments where id = p_department_id and company_id = v_company) then
    raise exception 'القسم غير موجود' using errcode = 'P0002';
  end if;
  if p_branch_id is not null and not exists (select 1 from public.hr_branches where id = p_branch_id and company_id = v_company) then
    raise exception 'الفرع غير موجود' using errcode = 'P0002';
  end if;
  if p_position_id is not null and not exists (select 1 from public.hr_positions where id = p_position_id and company_id = v_company) then
    raise exception 'المسمى الوظيفي غير موجود' using errcode = 'P0002';
  end if;
  if p_manager_employee_id is not null then
    if p_manager_employee_id = e.id then
      raise exception 'لا يمكن أن يكون الموظف مديرًا لنفسه' using errcode = '22023';
    end if;
    if not exists (select 1 from public.hr_employees where id = p_manager_employee_id and company_id = v_company and archived_at is null) then
      raise exception 'المدير غير موجود' using errcode = 'P0002';
    end if;
    -- منع حلقة الإدارة: المشي صعودًا من المدير الجديد يجب ألا يصل للموظف.
    v_walk := p_manager_employee_id;
    loop
      if v_walk = any(v_seen) then
        raise exception 'حلقة إدارة: المدير الجديد يدير هذا الموظف عبر سلسلة' using errcode = '22023';
      end if;
      if v_walk = e.id then
        raise exception 'حلقة إدارة: المدير الجديد يدير هذا الموظف عبر سلسلة' using errcode = '22023';
      end if;
      v_seen := v_seen || v_walk;
      select manager_employee_id into v_walk from public.hr_employees where id = v_walk;
      if v_walk is null then exit; end if;
    end loop;
  end if;
  v_old := jsonb_build_object('full_name', e.full_name, 'phone', e.phone, 'email', e.email,
    'national_id', e.national_id, 'department_id', e.department_id, 'branch_id', e.branch_id,
    'position_id', e.position_id, 'manager_employee_id', e.manager_employee_id,
    'job_title', e.job_title, 'hire_date', e.hire_date, 'contract_type', e.contract_type,
    'date_of_birth', e.date_of_birth, 'address', e.address);
  update public.hr_employees set
    full_name = v_name, phone = v_phone, email = v_email, national_id = v_nid,
    department_id = coalesce(p_department_id, e.department_id),
    branch_id = coalesce(p_branch_id, e.branch_id),
    position_id = coalesce(p_position_id, e.position_id),
    manager_employee_id = v_mgr,
    job_title = v_job, hire_date = coalesce(p_hire_date, e.hire_date),
    contract_type = coalesce(p_contract_type, e.contract_type),
    date_of_birth = coalesce(p_date_of_birth, e.date_of_birth),
    address = v_addr,
    emergency_contact = coalesce(p_emergency_contact, e.emergency_contact)
  where id = e.id
  returning jsonb_build_object('full_name', full_name, 'phone', phone, 'email', email,
    'national_id', national_id, 'department_id', department_id, 'branch_id', branch_id,
    'position_id', position_id, 'manager_employee_id', manager_employee_id,
    'job_title', job_title, 'hire_date', hire_date, 'contract_type', contract_type,
    'date_of_birth', date_of_birth, 'address', address) into v_new;
  perform public._hr_audit(v_company, 'employee.updated', 'employee', e.id, e.id, v_old, v_new, null);
  return jsonb_build_object('employee_id', e.id, 'changed', v_old is distinct from v_new);
end $$;

-- 8.5) أرشفة موظف: terminated + archived_at، لا حذف أبدًا (التصميم §2.1.1).
create or replace function public.hr_employee_archive(p_employee_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  v_reason  text;
  e         public.hr_employees;
begin
  v_company := public._hr_gate('hr_employees', true);
  if not public._hr_has_permission(v_company, 'hr.employees.manage') then
    raise exception 'لا تملك صلاحية إدارة الموظفين' using errcode = '42501';
  end if;
  if not public._hr_can_archive(v_company) then
    raise exception 'الأرشفة لمالك الشركة ومدير HR فقط' using errcode = '42501';
  end if;
  v_reason := public._reason_check(p_reason);
  select * into e from public.hr_employees where id = p_employee_id and company_id = v_company;
  if not found then
    raise exception 'الموظف غير موجود' using errcode = 'P0002';
  end if;
  if e.archived_at is not null then
    raise exception 'الموظف مؤرشف بالفعل' using errcode = '22023';
  end if;
  update public.hr_employees set employment_status = 'terminated', archived_at = now(),
    archived_by = auth.uid(), archive_reason = v_reason where id = e.id;
  insert into public.hr_employee_status_history (company_id, employee_id, from_status, to_status, reason, changed_by)
  values (v_company, e.id, e.employment_status, 'terminated', v_reason, auth.uid());
  perform public._hr_audit(v_company, 'employee.archived', 'employee', e.id, e.id,
    jsonb_build_object('employment_status', e.employment_status),
    jsonb_build_object('employment_status', 'terminated'), v_reason);
  return jsonb_build_object('employee_id', e.id, 'employment_status', 'terminated');
end $$;

-- 8.6) إعادة تفعيل موظف مؤرشف (terminated → active).
create or replace function public.hr_employee_reactivate(p_employee_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  v_reason  text;
  e         public.hr_employees;
begin
  v_company := public._hr_gate('hr_employees', true);
  if not public._hr_has_permission(v_company, 'hr.employees.manage') then
    raise exception 'لا تملك صلاحية إدارة الموظفين' using errcode = '42501';
  end if;
  if not public._hr_can_archive(v_company) then
    raise exception 'إعادة التفعيل لمالك الشركة ومدير HR فقط' using errcode = '42501';
  end if;
  v_reason := public._reason_check(p_reason);
  select * into e from public.hr_employees where id = p_employee_id and company_id = v_company;
  if not found then
    raise exception 'الموظف غير موجود' using errcode = 'P0002';
  end if;
  if e.archived_at is null then
    raise exception 'الموظف غير مؤرشف' using errcode = '22023';
  end if;
  update public.hr_employees set employment_status = 'active', archived_at = null,
    archived_by = null, archive_reason = null where id = e.id;
  insert into public.hr_employee_status_history (company_id, employee_id, from_status, to_status, reason, changed_by)
  values (v_company, e.id, 'terminated', 'active', v_reason, auth.uid());
  perform public._hr_audit(v_company, 'employee.reactivated', 'employee', e.id, e.id,
    jsonb_build_object('employment_status', 'terminated'),
    jsonb_build_object('employment_status', 'active'), v_reason);
  return jsonb_build_object('employee_id', e.id, 'employment_status', 'active');
end $$;

-- 8.7) تغيير الحالة (بلا terminated المباشر — له الأرشفة).
create or replace function public.hr_employee_set_status(p_employee_id uuid, p_status text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  v_reason  text;
  e         public.hr_employees;
begin
  v_company := public._hr_gate('hr_employees', true);
  if not public._hr_has_permission(v_company, 'hr.employees.manage') then
    raise exception 'لا تملك صلاحية إدارة الموظفين' using errcode = '42501';
  end if;
  v_reason := public._reason_check(p_reason);
  if p_status not in ('active', 'on_leave', 'suspended') then
    raise exception 'الحالة تُغيَّر إلى نشط أو في إجازة أو موقوف فقط — الإنهاء عبر الأرشفة' using errcode = '22023';
  end if;
  select * into e from public.hr_employees where id = p_employee_id and company_id = v_company;
  if not found then
    raise exception 'الموظف غير موجود' using errcode = 'P0002';
  end if;
  if e.archived_at is not null then
    raise exception 'الموظف مؤرشف — أعد تفعيله أولًا' using errcode = '22023';
  end if;
  if e.employment_status = p_status then
    return jsonb_build_object('employee_id', e.id, 'employment_status', p_status, 'changed', false);
  end if;
  if e.employment_status = 'terminated' then
    raise exception 'الموظف منتهٍ — أعد تفعيله أولًا' using errcode = '22023';
  end if;
  update public.hr_employees set employment_status = p_status where id = e.id;
  insert into public.hr_employee_status_history (company_id, employee_id, from_status, to_status, reason, changed_by)
  values (v_company, e.id, e.employment_status, p_status, v_reason, auth.uid());
  perform public._hr_audit(v_company, 'employee.status_changed', 'employee', e.id, e.id,
    jsonb_build_object('employment_status', e.employment_status),
    jsonb_build_object('employment_status', p_status), v_reason);
  return jsonb_build_object('employee_id', e.id, 'employment_status', p_status, 'changed', true);
end $$;

-- 8.8) تفاصيل موظف: الرقم القومي كامل فقط لحاملي الصلاحية الكاملة
--     (مالك الشركة أو مدير/موظف HR)؛ المدير المباشر والذاتية يريانه مقنّعًا.
--     مدير قسم خارج قسم الموظف يرى «غير موجود» (بلا تسريب).
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

-- 8.9) ملفي المرتبط (أساس الخدمة الذاتية — المرحلة 5).
create or replace function public.hr_my_employee()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  v_id      uuid;
begin
  v_company := public._hr_gate('hr_employees', false);
  v_id := public._hr_my_employee_id(v_company);
  if v_id is null then
    return null;
  end if;
  return public.hr_employee_detail(v_id);
end $$;

-- 8.10) هل هذه الشركة في نطاقي؟ (على نمط ticket_in_my_scope — boolean عن
--      المنادي فقط، بلا فحص مفاتيح: حارس النطاق لا حارس الاستحقاق.)
create or replace function public.hr_in_my_scope(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select auth.uid() is not null
     and not coalesce(public.is_banned(), false)
     and public.current_company_id() = p_company_id;
$$;

-- ============================================================================
-- 9) RPCs الشركة — الأقسام والفروع والمسميات + الإعدادات (التصميم §5.2 و§5.3)
--    القوائم مسطحة مع العمق (الشجرة تُبنى في العميل من القائمة المسطحة) —
--    انحراف موثَّق عن دوال الشجرة hr_*_tree في التصميم §5.2.
-- ============================================================================

-- 9.1) الأقسام ---------------------------------------------------------------
create or replace function public.hr_departments_list(p_include_archived boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  v_rows    jsonb;
begin
  v_company := public._hr_gate('hr_employees', false);
  if not public._hr_has_permission(v_company, 'hr.employees.view') then
    raise exception 'لا تملك صلاحية عرض الموظفين' using errcode = '42501';
  end if;
  with recursive tree as (
    select d.*, 1 as depth from public.hr_departments d
     where d.company_id = v_company and d.parent_id is null
       and (coalesce(p_include_archived, false) or d.archived_at is null)
    union all
    select d.*, t.depth + 1 from public.hr_departments d
      join tree t on d.parent_id = t.id
     where d.company_id = v_company
       and (coalesce(p_include_archived, false) or d.archived_at is null)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', s.id, 'parent_id', s.parent_id, 'name', s.name, 'description', s.description,
      'manager_employee_id', s.manager_employee_id,
      'manager_name', (select full_name from public.hr_employees where id = s.manager_employee_id),
      'is_active', s.is_active, 'sort_order', s.sort_order, 'depth', s.depth,
      'archived_at', s.archived_at, 'employees_count', s.employees_count)
    order by s.depth, s.sort_order, s.name), '[]'::jsonb)
    into v_rows
    from (select t.*, (select count(*) from public.hr_employees e
                        where e.department_id = t.id and e.archived_at is null) employees_count
            from tree t) s;
  return jsonb_build_object('rows', v_rows, 'total', jsonb_array_length(v_rows));
end $$;

create or replace function public.hr_department_create(p_name text, p_parent_id uuid default null,
                                                       p_description text default null,
                                                       p_manager_employee_id uuid default null,
                                                       p_sort_order integer default 0)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  v_name    text := btrim(coalesce(p_name, ''));
  v_id      uuid;
begin
  v_company := public._hr_gate('hr_employees', true);
  if not (public._hr_has_permission(v_company, 'hr.departments.manage')
          or public._hr_has_permission(v_company, 'hr.employees.manage')) then
    raise exception 'لا تملك صلاحية إدارة الهيكل التنظيمي' using errcode = '42501';
  end if;
  if char_length(v_name) < 2 or char_length(v_name) > 120 then
    raise exception 'اسم القسم بين حرفين و120 حرفًا' using errcode = '22023';
  end if;
  if p_parent_id is not null and not exists (select 1 from public.hr_departments where id = p_parent_id and company_id = v_company and archived_at is null) then
    raise exception 'القسم الأب غير موجود أو مؤرشف' using errcode = 'P0002';
  end if;
  if p_manager_employee_id is not null and not exists (select 1 from public.hr_employees where id = p_manager_employee_id and company_id = v_company and archived_at is null) then
    raise exception 'مدير القسم غير موجود' using errcode = 'P0002';
  end if;
  begin
    insert into public.hr_departments (company_id, parent_id, name, description, manager_employee_id, sort_order, created_by)
    values (v_company, p_parent_id, v_name, nullif(btrim(coalesce(p_description, '')), ''), p_manager_employee_id,
            coalesce(p_sort_order, 0), auth.uid())
    returning id into v_id;
  exception when unique_violation then
    raise exception 'اسم القسم مستخدم بالفعل تحت نفس الأب' using errcode = '23505';
  end;
  perform public._hr_audit(v_company, 'department.created', 'department', v_id, null, null,
    jsonb_build_object('name', v_name, 'parent_id', p_parent_id), null);
  return jsonb_build_object('id', v_id, 'name', v_name);
end $$;

create or replace function public.hr_department_update(p_id uuid, p_name text default null,
                                                       p_parent_id uuid default null,
                                                       p_description text default null,
                                                       p_manager_employee_id uuid default null,
                                                       p_is_active boolean default null,
                                                       p_sort_order integer default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  d         public.hr_departments;
  v_name    text;
begin
  v_company := public._hr_gate('hr_employees', true);
  if not (public._hr_has_permission(v_company, 'hr.departments.manage')
          or public._hr_has_permission(v_company, 'hr.employees.manage')) then
    raise exception 'لا تملك صلاحية إدارة الهيكل التنظيمي' using errcode = '42501';
  end if;
  select * into d from public.hr_departments where id = p_id and company_id = v_company;
  if not found then
    raise exception 'القسم غير موجود' using errcode = 'P0002';
  end if;
  if d.archived_at is not null then
    raise exception 'القسم مؤرشف' using errcode = '22023';
  end if;
  v_name := case when p_name is null then d.name else btrim(p_name) end;
  if char_length(v_name) < 2 or char_length(v_name) > 120 then
    raise exception 'اسم القسم بين حرفين و120 حرفًا' using errcode = '22023';
  end if;
  if p_parent_id is not null then
    if p_parent_id = d.id then
      raise exception 'لا يمكن أن يكون القسم أبًا لنفسه' using errcode = '22023';
    end if;
    if not exists (select 1 from public.hr_departments where id = p_parent_id and company_id = v_company and archived_at is null) then
      raise exception 'القسم الأب غير موجود أو مؤرشف' using errcode = 'P0002';
    end if;
  end if;
  if p_manager_employee_id is not null and not exists (select 1 from public.hr_employees where id = p_manager_employee_id and company_id = v_company and archived_at is null) then
    raise exception 'مدير القسم غير موجود' using errcode = 'P0002';
  end if;
  begin
    update public.hr_departments set
      name = v_name,
      parent_id = coalesce(p_parent_id, d.parent_id),
      description = case when p_description is null then d.description when btrim(p_description) = '' then null else btrim(p_description) end,
      manager_employee_id = coalesce(p_manager_employee_id, d.manager_employee_id),
      is_active = coalesce(p_is_active, d.is_active),
      sort_order = coalesce(p_sort_order, d.sort_order)
    where id = d.id;
  exception when unique_violation then
    raise exception 'اسم القسم مستخدم بالفعل تحت نفس الأب' using errcode = '23505';
  end;
  perform public._hr_audit(v_company, 'department.updated', 'department', d.id, null,
    jsonb_build_object('name', d.name), jsonb_build_object('name', v_name), null);
  return jsonb_build_object('id', d.id, 'name', v_name);
end $$;

create or replace function public.hr_department_archive(p_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  v_reason  text;
  d         public.hr_departments;
  v_kids    int;
  v_emps    int;
begin
  v_company := public._hr_gate('hr_employees', true);
  if not (public._hr_has_permission(v_company, 'hr.departments.manage')
          or public._hr_has_permission(v_company, 'hr.employees.manage')) then
    raise exception 'لا تملك صلاحية إدارة الهيكل التنظيمي' using errcode = '42501';
  end if;
  v_reason := public._reason_check(p_reason);
  select * into d from public.hr_departments where id = p_id and company_id = v_company;
  if not found then
    raise exception 'القسم غير موجود' using errcode = 'P0002';
  end if;
  if d.archived_at is not null then
    raise exception 'القسم مؤرشف بالفعل' using errcode = '22023';
  end if;
  select count(*) into v_kids from public.hr_departments where parent_id = d.id and archived_at is null;
  select count(*) into v_emps from public.hr_employees where department_id = d.id and archived_at is null;
  if v_kids > 0 or v_emps > 0 then
    raise exception 'لا يمكن أرشفة القسم: تحته % أقسام غير مؤرشفة و% موظفين نشطين' , v_kids, v_emps using errcode = '22023';
  end if;
  update public.hr_departments set archived_at = now() where id = d.id;
  perform public._hr_audit(v_company, 'department.archived', 'department', d.id, null,
    jsonb_build_object('name', d.name), jsonb_build_object('archived', true), v_reason);
  return jsonb_build_object('id', d.id, 'archived', true);
end $$;

-- 9.2) الفروع (نفس نمط الأقسام) ------------------------------------------------
create or replace function public.hr_branches_list(p_include_archived boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  v_rows    jsonb;
begin
  v_company := public._hr_gate('hr_employees', false);
  if not public._hr_has_permission(v_company, 'hr.employees.view') then
    raise exception 'لا تملك صلاحية عرض الموظفين' using errcode = '42501';
  end if;
  with recursive tree as (
    select b.*, 1 as depth from public.hr_branches b
     where b.company_id = v_company and b.parent_id is null
       and (coalesce(p_include_archived, false) or b.archived_at is null)
    union all
    select b.*, t.depth + 1 from public.hr_branches b
      join tree t on b.parent_id = t.id
     where b.company_id = v_company
       and (coalesce(p_include_archived, false) or b.archived_at is null)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', s.id, 'parent_id', s.parent_id, 'name', s.name, 'description', s.description,
      'manager_employee_id', s.manager_employee_id,
      'manager_name', (select full_name from public.hr_employees where id = s.manager_employee_id),
      'is_active', s.is_active, 'sort_order', s.sort_order, 'depth', s.depth,
      'archived_at', s.archived_at, 'employees_count', s.employees_count)
    order by s.depth, s.sort_order, s.name), '[]'::jsonb)
    into v_rows
    from (select t.*, (select count(*) from public.hr_employees e
                        where e.branch_id = t.id and e.archived_at is null) employees_count
            from tree t) s;
  return jsonb_build_object('rows', v_rows, 'total', jsonb_array_length(v_rows));
end $$;

create or replace function public.hr_branch_create(p_name text, p_parent_id uuid default null,
                                                  p_description text default null,
                                                  p_manager_employee_id uuid default null,
                                                  p_sort_order integer default 0)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  v_name    text := btrim(coalesce(p_name, ''));
  v_id      uuid;
begin
  v_company := public._hr_gate('hr_employees', true);
  if not (public._hr_has_permission(v_company, 'hr.departments.manage')
          or public._hr_has_permission(v_company, 'hr.employees.manage')) then
    raise exception 'لا تملك صلاحية إدارة الهيكل التنظيمي' using errcode = '42501';
  end if;
  if char_length(v_name) < 2 or char_length(v_name) > 120 then
    raise exception 'اسم الفرع بين حرفين و120 حرفًا' using errcode = '22023';
  end if;
  if p_parent_id is not null and not exists (select 1 from public.hr_branches where id = p_parent_id and company_id = v_company and archived_at is null) then
    raise exception 'الفرع الأب غير موجود أو مؤرشف' using errcode = 'P0002';
  end if;
  if p_manager_employee_id is not null and not exists (select 1 from public.hr_employees where id = p_manager_employee_id and company_id = v_company and archived_at is null) then
    raise exception 'مدير الفرع غير موجود' using errcode = 'P0002';
  end if;
  begin
    insert into public.hr_branches (company_id, parent_id, name, description, manager_employee_id, sort_order, created_by)
    values (v_company, p_parent_id, v_name, nullif(btrim(coalesce(p_description, '')), ''), p_manager_employee_id,
            coalesce(p_sort_order, 0), auth.uid())
    returning id into v_id;
  exception when unique_violation then
    raise exception 'اسم الفرع مستخدم بالفعل تحت نفس الأب' using errcode = '23505';
  end;
  perform public._hr_audit(v_company, 'branch.created', 'branch', v_id, null, null,
    jsonb_build_object('name', v_name, 'parent_id', p_parent_id), null);
  return jsonb_build_object('id', v_id, 'name', v_name);
end $$;

create or replace function public.hr_branch_update(p_id uuid, p_name text default null,
                                                  p_parent_id uuid default null,
                                                  p_description text default null,
                                                  p_manager_employee_id uuid default null,
                                                  p_is_active boolean default null,
                                                  p_sort_order integer default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  b         public.hr_branches;
  v_name    text;
begin
  v_company := public._hr_gate('hr_employees', true);
  if not (public._hr_has_permission(v_company, 'hr.departments.manage')
          or public._hr_has_permission(v_company, 'hr.employees.manage')) then
    raise exception 'لا تملك صلاحية إدارة الهيكل التنظيمي' using errcode = '42501';
  end if;
  select * into b from public.hr_branches where id = p_id and company_id = v_company;
  if not found then
    raise exception 'الفرع غير موجود' using errcode = 'P0002';
  end if;
  if b.archived_at is not null then
    raise exception 'الفرع مؤرشف' using errcode = '22023';
  end if;
  v_name := case when p_name is null then b.name else btrim(p_name) end;
  if char_length(v_name) < 2 or char_length(v_name) > 120 then
    raise exception 'اسم الفرع بين حرفين و120 حرفًا' using errcode = '22023';
  end if;
  if p_parent_id is not null then
    if p_parent_id = b.id then
      raise exception 'لا يمكن أن يكون الفرع أبًا لنفسه' using errcode = '22023';
    end if;
    if not exists (select 1 from public.hr_branches where id = p_parent_id and company_id = v_company and archived_at is null) then
      raise exception 'الفرع الأب غير موجود أو مؤرشف' using errcode = 'P0002';
    end if;
  end if;
  if p_manager_employee_id is not null and not exists (select 1 from public.hr_employees where id = p_manager_employee_id and company_id = v_company and archived_at is null) then
    raise exception 'مدير الفرع غير موجود' using errcode = 'P0002';
  end if;
  begin
    update public.hr_branches set
      name = v_name, parent_id = coalesce(p_parent_id, b.parent_id),
      description = case when p_description is null then b.description when btrim(p_description) = '' then null else btrim(p_description) end,
      manager_employee_id = coalesce(p_manager_employee_id, b.manager_employee_id),
      is_active = coalesce(p_is_active, b.is_active),
      sort_order = coalesce(p_sort_order, b.sort_order)
    where id = b.id;
  exception when unique_violation then
    raise exception 'اسم الفرع مستخدم بالفعل تحت نفس الأب' using errcode = '23505';
  end;
  perform public._hr_audit(v_company, 'branch.updated', 'branch', b.id, null,
    jsonb_build_object('name', b.name), jsonb_build_object('name', v_name), null);
  return jsonb_build_object('id', b.id, 'name', v_name);
end $$;

create or replace function public.hr_branch_archive(p_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  v_reason  text;
  b         public.hr_branches;
  v_kids    int;
  v_emps    int;
begin
  v_company := public._hr_gate('hr_employees', true);
  if not (public._hr_has_permission(v_company, 'hr.departments.manage')
          or public._hr_has_permission(v_company, 'hr.employees.manage')) then
    raise exception 'لا تملك صلاحية إدارة الهيكل التنظيمي' using errcode = '42501';
  end if;
  v_reason := public._reason_check(p_reason);
  select * into b from public.hr_branches where id = p_id and company_id = v_company;
  if not found then
    raise exception 'الفرع غير موجود' using errcode = 'P0002';
  end if;
  if b.archived_at is not null then
    raise exception 'الفرع مؤرشف بالفعل' using errcode = '22023';
  end if;
  select count(*) into v_kids from public.hr_branches where parent_id = b.id and archived_at is null;
  select count(*) into v_emps from public.hr_employees where branch_id = b.id and archived_at is null;
  if v_kids > 0 or v_emps > 0 then
    raise exception 'لا يمكن أرشفة الفرع: تحته % فروع غير مؤرشفة و% موظفين نشطين', v_kids, v_emps using errcode = '22023';
  end if;
  update public.hr_branches set archived_at = now() where id = b.id;
  perform public._hr_audit(v_company, 'branch.archived', 'branch', b.id, null,
    jsonb_build_object('name', b.name), jsonb_build_object('archived', true), v_reason);
  return jsonb_build_object('id', b.id, 'archived', true);
end $$;

-- 9.3) المسميات الوظيفية (نفس النمط + قسم اختياري ودرجة 1–10) -----------------
create or replace function public.hr_positions_list(p_include_archived boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  v_rows    jsonb;
begin
  v_company := public._hr_gate('hr_employees', false);
  if not public._hr_has_permission(v_company, 'hr.employees.view') then
    raise exception 'لا تملك صلاحية عرض الموظفين' using errcode = '42501';
  end if;
  with recursive tree as (
    select p.*, 1 as depth from public.hr_positions p
     where p.company_id = v_company and p.parent_id is null
       and (coalesce(p_include_archived, false) or p.archived_at is null)
    union all
    select p.*, t.depth + 1 from public.hr_positions p
      join tree t on p.parent_id = t.id
     where p.company_id = v_company
       and (coalesce(p_include_archived, false) or p.archived_at is null)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', s.id, 'parent_id', s.parent_id, 'name', s.name, 'description', s.description,
      'manager_employee_id', s.manager_employee_id,
      'manager_name', (select full_name from public.hr_employees where id = s.manager_employee_id),
      'department_id', s.department_id,
      'department_name', (select name from public.hr_departments where id = s.department_id),
      'level', s.level, 'is_active', s.is_active, 'sort_order', s.sort_order, 'depth', s.depth,
      'archived_at', s.archived_at, 'employees_count', s.employees_count)
    order by s.depth, s.sort_order, s.name), '[]'::jsonb)
    into v_rows
    from (select t.*, (select count(*) from public.hr_employees e
                        where e.position_id = t.id and e.archived_at is null) employees_count
            from tree t) s;
  return jsonb_build_object('rows', v_rows, 'total', jsonb_array_length(v_rows));
end $$;

create or replace function public.hr_position_create(p_name text, p_parent_id uuid default null,
                                                    p_description text default null,
                                                    p_manager_employee_id uuid default null,
                                                    p_department_id uuid default null,
                                                    p_level integer default null,
                                                    p_sort_order integer default 0)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  v_name    text := btrim(coalesce(p_name, ''));
  v_id      uuid;
begin
  v_company := public._hr_gate('hr_employees', true);
  if not (public._hr_has_permission(v_company, 'hr.departments.manage')
          or public._hr_has_permission(v_company, 'hr.employees.manage')) then
    raise exception 'لا تملك صلاحية إدارة الهيكل التنظيمي' using errcode = '42501';
  end if;
  if char_length(v_name) < 2 or char_length(v_name) > 120 then
    raise exception 'اسم المسمى بين حرفين و120 حرفًا' using errcode = '22023';
  end if;
  if p_level is not null and (p_level < 1 or p_level > 10) then
    raise exception 'درجة المسمى بين 1 و10' using errcode = '22023';
  end if;
  if p_parent_id is not null and not exists (select 1 from public.hr_positions where id = p_parent_id and company_id = v_company and archived_at is null) then
    raise exception 'المسمى الأب غير موجود أو مؤرشف' using errcode = 'P0002';
  end if;
  if p_department_id is not null and not exists (select 1 from public.hr_departments where id = p_department_id and company_id = v_company and archived_at is null) then
    raise exception 'القسم غير موجود أو مؤرشف' using errcode = 'P0002';
  end if;
  if p_manager_employee_id is not null and not exists (select 1 from public.hr_employees where id = p_manager_employee_id and company_id = v_company and archived_at is null) then
    raise exception 'مدير المسمى غير موجود' using errcode = 'P0002';
  end if;
  begin
    insert into public.hr_positions (company_id, parent_id, name, description, manager_employee_id, department_id, level, sort_order, created_by)
    values (v_company, p_parent_id, v_name, nullif(btrim(coalesce(p_description, '')), ''), p_manager_employee_id,
            p_department_id, p_level, coalesce(p_sort_order, 0), auth.uid())
    returning id into v_id;
  exception when unique_violation then
    raise exception 'اسم المسمى مستخدم بالفعل تحت نفس الأب' using errcode = '23505';
  end;
  perform public._hr_audit(v_company, 'position.created', 'position', v_id, null, null,
    jsonb_build_object('name', v_name, 'parent_id', p_parent_id), null);
  return jsonb_build_object('id', v_id, 'name', v_name);
end $$;

create or replace function public.hr_position_update(p_id uuid, p_name text default null,
                                                    p_parent_id uuid default null,
                                                    p_description text default null,
                                                    p_manager_employee_id uuid default null,
                                                    p_department_id uuid default null,
                                                    p_level integer default null,
                                                    p_is_active boolean default null,
                                                    p_sort_order integer default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  p         public.hr_positions;
  v_name    text;
begin
  v_company := public._hr_gate('hr_employees', true);
  if not (public._hr_has_permission(v_company, 'hr.departments.manage')
          or public._hr_has_permission(v_company, 'hr.employees.manage')) then
    raise exception 'لا تملك صلاحية إدارة الهيكل التنظيمي' using errcode = '42501';
  end if;
  select * into p from public.hr_positions where id = p_id and company_id = v_company;
  if not found then
    raise exception 'المسمى غير موجود' using errcode = 'P0002';
  end if;
  if p.archived_at is not null then
    raise exception 'المسمى مؤرشف' using errcode = '22023';
  end if;
  v_name := case when p_name is null then p.name else btrim(p_name) end;
  if char_length(v_name) < 2 or char_length(v_name) > 120 then
    raise exception 'اسم المسمى بين حرفين و120 حرفًا' using errcode = '22023';
  end if;
  if coalesce(p_level, p.level) is not null and (coalesce(p_level, p.level) < 1 or coalesce(p_level, p.level) > 10) then
    raise exception 'درجة المسمى بين 1 و10' using errcode = '22023';
  end if;
  if p_parent_id is not null then
    if p_parent_id = p.id then
      raise exception 'لا يمكن أن يكون المسمى أبًا لنفسه' using errcode = '22023';
    end if;
    if not exists (select 1 from public.hr_positions where id = p_parent_id and company_id = v_company and archived_at is null) then
      raise exception 'المسمى الأب غير موجود أو مؤرشف' using errcode = 'P0002';
    end if;
  end if;
  if p_department_id is not null and not exists (select 1 from public.hr_departments where id = p_department_id and company_id = v_company and archived_at is null) then
    raise exception 'القسم غير موجود أو مؤرشف' using errcode = 'P0002';
  end if;
  if p_manager_employee_id is not null and not exists (select 1 from public.hr_employees where id = p_manager_employee_id and company_id = v_company and archived_at is null) then
    raise exception 'مدير المسمى غير موجود' using errcode = 'P0002';
  end if;
  begin
    update public.hr_positions set
      name = v_name, parent_id = coalesce(p_parent_id, p.parent_id),
      description = case when p_description is null then p.description when btrim(p_description) = '' then null else btrim(p_description) end,
      manager_employee_id = coalesce(p_manager_employee_id, p.manager_employee_id),
      department_id = coalesce(p_department_id, p.department_id),
      level = coalesce(p_level, p.level),
      is_active = coalesce(p_is_active, p.is_active),
      sort_order = coalesce(p_sort_order, p.sort_order)
    where id = p.id;
  exception when unique_violation then
    raise exception 'اسم المسمى مستخدم بالفعل تحت نفس الأب' using errcode = '23505';
  end;
  perform public._hr_audit(v_company, 'position.updated', 'position', p.id, null,
    jsonb_build_object('name', p.name), jsonb_build_object('name', v_name), null);
  return jsonb_build_object('id', p.id, 'name', v_name);
end $$;

create or replace function public.hr_position_archive(p_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  v_reason  text;
  p         public.hr_positions;
  v_kids    int;
  v_emps    int;
begin
  v_company := public._hr_gate('hr_employees', true);
  if not (public._hr_has_permission(v_company, 'hr.departments.manage')
          or public._hr_has_permission(v_company, 'hr.employees.manage')) then
    raise exception 'لا تملك صلاحية إدارة الهيكل التنظيمي' using errcode = '42501';
  end if;
  v_reason := public._reason_check(p_reason);
  select * into p from public.hr_positions where id = p_id and company_id = v_company;
  if not found then
    raise exception 'المسمى غير موجود' using errcode = 'P0002';
  end if;
  if p.archived_at is not null then
    raise exception 'المسمى مؤرشف بالفعل' using errcode = '22023';
  end if;
  select count(*) into v_kids from public.hr_positions where parent_id = p.id and archived_at is null;
  select count(*) into v_emps from public.hr_employees where position_id = p.id and archived_at is null;
  if v_kids > 0 or v_emps > 0 then
    raise exception 'لا يمكن أرشفة المسمى: تحته % مسميات غير مؤرشفة و% موظفين نشطين', v_kids, v_emps using errcode = '22023';
  end if;
  update public.hr_positions set archived_at = now() where id = p.id;
  perform public._hr_audit(v_company, 'position.archived', 'position', p.id, null,
    jsonb_build_object('name', p.name), jsonb_build_object('archived', true), v_reason);
  return jsonb_build_object('id', p.id, 'archived', true);
end $$;

-- 9.4) الإعدادات (التصميم §5.3) -------------------------------------------------
create or replace function public.hr_settings_get()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  s         public.hr_settings;
begin
  v_company := public._hr_gate('hr_employees', false);
  if not public._hr_has_permission(v_company, 'hr.employees.view') then
    raise exception 'لا تملك صلاحية عرض الموظفين' using errcode = '42501';
  end if;
  select * into s from public.hr_settings where company_id = v_company;
  if not found then
    return jsonb_build_object('company_id', v_company, 'employee_number_prefix', '',
      'employee_number_next', 1, 'default_probation_months', 3,
      'audit_retention_months', 24, 'settings', '{}'::jsonb);
  end if;
  return jsonb_build_object('company_id', s.company_id, 'employee_number_prefix', s.employee_number_prefix,
    'employee_number_next', s.employee_number_next, 'default_probation_months', s.default_probation_months,
    'audit_retention_months', s.audit_retention_months, 'settings', s.settings, 'updated_at', s.updated_at);
end $$;

create or replace function public.hr_settings_update(p_employee_number_prefix text default null,
                                                    p_default_probation_months integer default null,
                                                    p_audit_retention_months integer default null,
                                                    p_settings jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  s         public.hr_settings;
  v_prefix  text;
  v_prob    int;
  v_ret     int;
  v_set     jsonb;
begin
  v_company := public._hr_gate('hr_employees', true);
  if not public._hr_has_permission(v_company, 'hr.settings.manage') then
    raise exception 'لا تملك صلاحية إعدادات الموارد البشرية' using errcode = '42501';
  end if;
  insert into public.hr_settings (company_id) values (v_company)
    on conflict (company_id) do nothing;
  select * into s from public.hr_settings where company_id = v_company;
  v_prefix := case when p_employee_number_prefix is null then s.employee_number_prefix else btrim(p_employee_number_prefix) end;
  v_prob := coalesce(p_default_probation_months, s.default_probation_months);
  v_ret := coalesce(p_audit_retention_months, s.audit_retention_months);
  v_set := case when p_settings is null then s.settings else s.settings || p_settings end;
  if char_length(v_prefix) > 10 then
    raise exception 'بادئة الرقم الوظيفي 10 أحرف حدًا أقصى' using errcode = '22023';
  end if;
  if v_prob < 0 or v_prob > 12 then
    raise exception 'فترة التجربة الافتراضية بين 0 و12 شهرًا' using errcode = '22023';
  end if;
  if v_ret < 6 or v_ret > 120 then
    raise exception 'مدة الاحتفاظ بالسجل بين 6 و120 شهرًا' using errcode = '22023';
  end if;
  update public.hr_settings set
    employee_number_prefix = v_prefix, default_probation_months = v_prob,
    audit_retention_months = v_ret, settings = v_set, updated_by = auth.uid()
  where company_id = v_company;
  perform public._hr_audit(v_company, 'settings.changed', 'settings', v_company, null,
    jsonb_build_object('employee_number_prefix', s.employee_number_prefix,
      'default_probation_months', s.default_probation_months, 'audit_retention_months', s.audit_retention_months),
    jsonb_build_object('employee_number_prefix', v_prefix,
      'default_probation_months', v_prob, 'audit_retention_months', v_ret), null);
  return public.hr_settings_get();
end $$;

-- ============================================================================
-- 10) RPCs الشركة — الاستيراد الجماعي (التصميم §5.4 و§6)
--     RPC دفعي واحد، معاملة واحدة، حد 100 صف مفروض خادمًا، مفتاح عدم تكرار،
--     ولا كتابة إطلاقًا في profiles / company_memberships /
--     company_membership_invitations / auth.users، ولا استدعاء لأي مسار دعوة.
-- ============================================================================
create or replace function public.hr_import_employees(p_rows jsonb, p_idempotency_key uuid,
                                                     p_file_name text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company      uuid;
  v_total        int;
  v_run          public.hr_import_runs;
  v_results_map  jsonb := '{}'::jsonb;
  v_candidates   jsonb := '[]'::jsonb;
  v_todo         jsonb := '[]'::jsonb;
  v_next_todo    jsonb;
  v_seen_numbers text[] := '{}'::text[];
  v_seen_emails  text[] := '{}'::text[];
  v_seen_nids    text[] := '{}'::text[];
  v_file_numbers text[] := '{}'::text[];
  v_num_to_id    jsonb := '{}'::jsonb;
  v_row          jsonb;
  v_norm         jsonb;
  v_val          jsonb;
  v_line         int;
  v_num          text;
  v_mgr          text;
  v_id           uuid;
  v_inserted     int := 0;
  v_dup          int := 0;
  v_inv          int := 0;
  v_progress     boolean;
  v_status       text;
  v_results      jsonb := '[]'::jsonb;
  i              int;
  j              int;
begin
  v_company := public._hr_gate('hr_employees', true);
  if not public._hr_has_permission(v_company, 'hr.import') then
    raise exception 'لا تملك صلاحية الاستيراد الجماعي' using errcode = '42501';
  end if;
  if p_idempotency_key is null then
    raise exception 'مفتاح عدم التكرار مطلوب' using errcode = '22023';
  end if;
  -- إعادة التشغيل ترجع النتيجة المخزنة دون إعادة تنفيذ أو إعادة تحقق
  -- (على نمط owner_account_transfer في 129).
  select * into v_run from public.hr_import_runs
   where company_id = v_company and idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object('run_id', v_run.id, 'replayed', true, 'status', v_run.status,
      'total', v_run.total_rows, 'inserted', v_run.inserted_count,
      'duplicate', v_run.duplicate_count, 'invalid', v_run.invalid_count,
      'results', v_run.results);
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'صفوف الاستيراد مصفوفة JSON' using errcode = '22023';
  end if;
  v_total := jsonb_array_length(p_rows);
  if v_total = 0 then
    raise exception 'الملف لا يحتوي على أي صفوف' using errcode = '22023';
  end if;
  if v_total > 100 then
    raise exception 'الملف يتجاوز 100 صف — قسّمه إلى دفعات' using errcode = '54000';
  end if;
  for i in 0 .. v_total - 1 loop
    v_num := nullif(btrim(coalesce(p_rows -> i ->> 'employee_number', '')), '');
    if v_num is not null then
      v_file_numbers := v_file_numbers || v_num;
    end if;
  end loop;
  select coalesce(jsonb_object_agg(employee_number, id::text), '{}'::jsonb) into v_num_to_id
    from public.hr_employees where company_id = v_company;

  -- المرحلة 1 — تحقق خادمًا لكل صف (قاعدة التحقق الواحدة _hr_validate_employee_row).
  for i in 0 .. v_total - 1 loop
    v_row := p_rows -> i;
    v_line := case when (v_row ->> 'line') ~ '^\d+$' then (v_row ->> 'line')::int else i + 1 end;
    v_val := public._hr_validate_employee_row(v_row, v_company);
    if (v_val ->> 'valid')::boolean then
      v_candidates := v_candidates || jsonb_build_object('line', v_line, 'normalized', v_val -> 'normalized');
    elsif (v_val ->> 'code') = 'unknown_manager'
          and (v_val -> 'normalized' ->> 'manager_employee_number') = any(v_file_numbers) then
      -- المدير صف في الملف نفسه: يُؤجَّل حله لمرحلة الإدخال (ترتيب طوبولوجي).
      v_candidates := v_candidates || jsonb_build_object('line', v_line, 'normalized', v_val -> 'normalized');
    else
      -- التصميم §6: أكواد duplicate_* حالة «مكرر» لا «مرفوض» (مكرر داخل
      -- الملف يُكتشف في المرحلة 2؛ ومكرر الشركة هنا في المرحلة 1).
      v_results_map := v_results_map || jsonb_build_object(v_line::text, jsonb_build_object(
        'line', v_line, 'employee_number', v_row ->> 'employee_number',
        'status', case when (v_val ->> 'code') like 'duplicate%' then 'duplicate' else 'invalid' end,
        'reason', v_val ->> 'reason', 'code', v_val ->> 'code'));
      if (v_val ->> 'code') like 'duplicate%' then v_dup := v_dup + 1; else v_inv := v_inv + 1; end if;
    end if;
  end loop;

  -- المرحلة 2 — التكرار داخل الملف (الرقم/البريد/القومي) على المرشحين فقط.
  for i in 0 .. jsonb_array_length(v_candidates) - 1 loop
    v_row := v_candidates -> i;
    v_norm := v_row -> 'normalized';
    v_line := (v_row ->> 'line')::int;
    v_num := v_norm ->> 'employee_number';
    if v_num is not null and v_num = any(v_seen_numbers) then
      v_results_map := v_results_map || jsonb_build_object(v_line::text, jsonb_build_object(
        'line', v_line, 'employee_number', v_num, 'status', 'duplicate',
        'reason', 'الرقم الوظيفي مكرر داخل الملف', 'code', 'duplicate_in_file'));
      v_dup := v_dup + 1;
      continue;
    end if;
    if (v_norm ->> 'email') is not null and lower(v_norm ->> 'email') = any(v_seen_emails) then
      v_results_map := v_results_map || jsonb_build_object(v_line::text, jsonb_build_object(
        'line', v_line, 'employee_number', v_num, 'status', 'duplicate',
        'reason', 'البريد الإلكتروني مكرر داخل الملف', 'code', 'duplicate_in_file'));
      v_dup := v_dup + 1;
      continue;
    end if;
    if (v_norm ->> 'national_id') is not null and (v_norm ->> 'national_id') = any(v_seen_nids) then
      v_results_map := v_results_map || jsonb_build_object(v_line::text, jsonb_build_object(
        'line', v_line, 'employee_number', v_num, 'status', 'duplicate',
        'reason', 'الرقم القومي مكرر داخل الملف', 'code', 'duplicate_in_file'));
      v_dup := v_dup + 1;
      continue;
    end if;
    if v_num is not null then v_seen_numbers := v_seen_numbers || v_num; end if;
    if (v_norm ->> 'email') is not null then v_seen_emails := v_seen_emails || lower(v_norm ->> 'email'); end if;
    if (v_norm ->> 'national_id') is not null then v_seen_nids := v_seen_nids || (v_norm ->> 'national_id'); end if;
    v_todo := v_todo || v_row;
  end loop;

  -- المرحلة 3 — إدخال الصالحين في تمريرات: صف يُدخل حين يُحلّ مديره
  -- (في قاعدة البيانات أو في تمريرة سابقة من الملف نفسه).
  while jsonb_array_length(v_todo) > 0 loop
    v_progress := false;
    v_next_todo := '[]'::jsonb;
    for j in 0 .. jsonb_array_length(v_todo) - 1 loop
      v_row := v_todo -> j;
      v_norm := v_row -> 'normalized';
      v_line := (v_row ->> 'line')::int;
      v_mgr := v_norm ->> 'manager_employee_number';
      if v_mgr is null or (v_num_to_id ? v_mgr) then
        v_num := v_norm ->> 'employee_number';
        if v_num is null then
          v_num := public._hr_next_employee_number(v_company);
        end if;
        begin
          insert into public.hr_employees
            (company_id, employee_number, full_name, phone, email, national_id,
             department_id, branch_id, position_id, manager_employee_id,
             job_title, hire_date, contract_type, employment_status, created_by)
          values (v_company, v_num, v_norm ->> 'full_name', v_norm ->> 'phone', v_norm ->> 'email',
                  v_norm ->> 'national_id',
                  (v_norm ->> 'department_id')::uuid, (v_norm ->> 'branch_id')::uuid,
                  (v_norm ->> 'position_id')::uuid,
                  case when v_mgr is null then null else (v_num_to_id ->> v_mgr)::uuid end,
                  v_norm ->> 'job_title',
                  case when v_norm ->> 'hire_date' is null then null else (v_norm ->> 'hire_date')::date end,
                  v_norm ->> 'contract_type', v_norm ->> 'employment_status', auth.uid())
          returning id into v_id;
        exception when unique_violation then
          v_results_map := v_results_map || jsonb_build_object(v_line::text, jsonb_build_object(
            'line', v_line, 'employee_number', v_num, 'status', 'duplicate',
            'reason', 'الرقم الوظيفي مستخدم بالفعل في شركتك', 'code', 'duplicate_employee_number'));
          v_dup := v_dup + 1;
          v_progress := true;
          continue;
        end;
        v_num_to_id := v_num_to_id || jsonb_build_object(v_num, v_id::text);
        insert into public.hr_employee_status_history (company_id, employee_id, from_status, to_status, reason, changed_by)
        values (v_company, v_id, null, v_norm ->> 'employment_status', 'استيراد جماعي', auth.uid());
        v_results_map := v_results_map || jsonb_build_object(v_line::text, jsonb_build_object(
          'line', v_line, 'employee_number', v_num, 'status', 'inserted', 'reason', null));
        v_inserted := v_inserted + 1;
        v_progress := true;
      else
        v_next_todo := v_next_todo || v_row;
      end if;
    end loop;
    v_todo := v_next_todo;
    exit when not v_progress;
  end loop;

  -- المرحلة 4 — ما بقي بلا مدير محلول: حلقة إن كان المدير ما زال معلّقًا
  -- في الملف، وإلا مدير غير موجود (صفه كان مرفوضًا أو مكررًا).
  for j in 0 .. jsonb_array_length(v_todo) - 1 loop
    v_row := v_todo -> j;
    v_norm := v_row -> 'normalized';
    v_line := (v_row ->> 'line')::int;
    v_mgr := v_norm ->> 'manager_employee_number';
    if exists (select 1 from jsonb_array_elements(v_todo) t
                where t -> 'normalized' ->> 'employee_number' = v_mgr) then
      v_results_map := v_results_map || jsonb_build_object(v_line::text, jsonb_build_object(
        'line', v_line, 'employee_number', v_norm ->> 'employee_number', 'status', 'invalid',
        'reason', 'حلقة إدارة: المدير يعتمد على هذا الصف أو على صف معلّق', 'code', 'manager_cycle'));
    else
      v_results_map := v_results_map || jsonb_build_object(v_line::text, jsonb_build_object(
        'line', v_line, 'employee_number', v_norm ->> 'employee_number', 'status', 'invalid',
        'reason', 'الرقم الوظيفي للمدير غير موجود: ' || v_mgr, 'code', 'unknown_manager'));
    end if;
    v_inv := v_inv + 1;
  end loop;

  -- التقرير النهائي مرتبًا حسب رقم السطر الأصلي (قد لا يبدأ من 1 حين تحمل
  -- الصفوف أرقام سطور الملف)، ثم حفظ التشغيل والتدقيق.
  select coalesce(jsonb_agg(v order by (v ->> 'line')::int), '[]'::jsonb) into v_results
    from (select value as v from jsonb_each(v_results_map)) s;
  v_status := case when v_inserted = v_total then 'completed'
                   when v_inserted = 0 then 'failed'
                   else 'partial' end;
  insert into public.hr_import_runs
    (company_id, idempotency_key, initiated_by, file_name, status,
     total_rows, inserted_count, duplicate_count, invalid_count, results, completed_at)
  values (v_company, p_idempotency_key, auth.uid(), p_file_name, v_status,
          v_total, v_inserted, v_dup, v_inv, v_results, now())
  returning id into v_id;
  perform public._hr_audit(v_company, 'import.completed', 'import_run', v_id, null, null,
    jsonb_build_object('run_id', v_id, 'file_name', p_file_name, 'total', v_total,
      'inserted', v_inserted, 'duplicate', v_dup, 'invalid', v_inv), null);
  return jsonb_build_object('run_id', v_id, 'replayed', false, 'status', v_status,
    'total', v_total, 'inserted', v_inserted, 'duplicate', v_dup, 'invalid', v_inv,
    'results', v_results);
end $$;
comment on function public.hr_import_employees(jsonb, uuid, text) is
  '143: استيراد جماعي دفعي واحد — تحقق خادمًا، معاملة واحدة، حد 100 صف، مفتاح عدم تكرار. لا يكتب في profiles/memberships/invitations ولا يستدعي أي مسار دعوة؛ user_id يبقى NULL لكل صف.';

create or replace function public.hr_import_runs_list(p_page integer default 1, p_page_size integer default 20)
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
begin
  v_company := public._hr_gate('hr_employees', false);
  if not public._hr_has_permission(v_company, 'hr.import') then
    raise exception 'لا تملك صلاحية الاستيراد الجماعي' using errcode = '42501';
  end if;
  return (select jsonb_build_object(
      'rows', coalesce(jsonb_agg(jsonb_build_object(
          'id', r.id, 'file_name', r.file_name, 'status', r.status, 'total_rows', r.total_rows,
          'inserted_count', r.inserted_count, 'duplicate_count', r.duplicate_count,
          'invalid_count', r.invalid_count, 'created_at', r.created_at, 'completed_at', r.completed_at)
        order by r.created_at desc), '[]'::jsonb),
      'total', (select count(*) from public.hr_import_runs where company_id = v_company),
      'page', v_page, 'page_size', v_size)
    from (select * from public.hr_import_runs where company_id = v_company
           order by created_at desc limit v_size offset (v_page - 1) * v_size) r);
end $$;

create or replace function public.hr_import_run_detail(p_run_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  r         public.hr_import_runs;
begin
  v_company := public._hr_gate('hr_employees', false);
  if not public._hr_has_permission(v_company, 'hr.import') then
    raise exception 'لا تملك صلاحية الاستيراد الجماعي' using errcode = '42501';
  end if;
  select * into r from public.hr_import_runs where id = p_run_id and company_id = v_company;
  if not found then
    raise exception 'تشغيل الاستيراد غير موجود' using errcode = 'P0002';
  end if;
  return jsonb_build_object('id', r.id, 'file_name', r.file_name, 'status', r.status,
    'total_rows', r.total_rows, 'inserted_count', r.inserted_count,
    'duplicate_count', r.duplicate_count, 'invalid_count', r.invalid_count,
    'results', r.results, 'created_at', r.created_at, 'completed_at', r.completed_at);
end $$;


-- ============================================================================
-- 11) RPCs الشركة — الربط الاختياري بالحساب (التصميم §5.5)
--     إجراء صريح موثّق فقط: لا trigger ولا استيراد يلمس user_id إطلاقًا.
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

create or replace function public.hr_link_employee_unlink(p_employee_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  v_reason  text;
  e         public.hr_employees;
begin
  v_company := public._hr_gate('hr_employees', true);
  if not public._hr_has_permission(v_company, 'hr.link_account') then
    raise exception 'لا تملك صلاحية ربط الموظفين بالحسابات' using errcode = '42501';
  end if;
  v_reason := public._reason_check(p_reason);
  select * into e from public.hr_employees where id = p_employee_id and company_id = v_company;
  if not found then
    raise exception 'الموظف غير موجود' using errcode = 'P0002';
  end if;
  if e.user_id is null then
    raise exception 'الموظف غير مرتبط بأي حساب' using errcode = '22023';
  end if;
  update public.hr_role_assignments set employee_id = null
   where company_id = v_company and user_id = e.user_id and employee_id = e.id;
  update public.hr_employees set user_id = null where id = e.id;
  perform public._hr_audit(v_company, 'employee.unlinked', 'employee', e.id, e.id,
    jsonb_build_object('user_id', e.user_id), jsonb_build_object('user_id', null), v_reason);
  return jsonb_build_object('employee_id', e.id, 'user_id', null, 'linked', false);
end $$;

-- الاسم البديل في التصميم §5.5 (hr_unlink_employee_account) — غلاف رقيق على
-- الاسم المطلوب في مهمة البناء، حتى لا ينكسر أي منادٍ بأي من الاسمين.
create or replace function public.hr_unlink_employee_account(p_employee_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  return public.hr_link_employee_unlink(p_employee_id, p_reason);
end $$;

-- ============================================================================
-- 12) RPCs المالك — التحكم في الإتاحة فقط (التصميم §5.6 و§3.5)
--     لا واحدة منها ترجع صفوف موظفين أو PII أو رواتب — حالات ومفاتيح
--     وعدّادات فقط. الكتابة بـ owner_critical_ok() + سبب ≥10 أحرف + تدقيق
--     ثلاثي: log_privileged + subscription_audit_log + hr_audit_logs.
-- ============================================================================

-- 12.1) تفعيل/إبطال الوحدة لشركة (مفتاح 'hr' كتجاوز).
create or replace function public.owner_hr_set_module(p_company_id uuid, p_enabled boolean, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_reason text;
  v_old    jsonb;
  v_new    jsonb;
begin
  if not public.owner_critical_ok() then
    raise exception 'إدارة وحدة HR لمالك المنصة في سياقه وبتحقق حديث' using errcode = '42501';
  end if;
  v_reason := public._reason_check(p_reason);
  if p_enabled is null then
    raise exception 'حدّد تفعيلًا أو إبطالًا' using errcode = '22023';
  end if;
  if not exists (select 1 from public.companies where id = p_company_id) then
    raise exception 'الشركة غير موجودة' using errcode = 'P0002';
  end if;
  select jsonb_build_object('enabled', exists (select 1 from public.company_feature_overrides o
             where o.company_id = p_company_id and o.feature_key = 'hr' and o.status = 'active'
               and (o.expires_at is null or o.expires_at > now())))
    into v_old;
  if p_enabled then
    insert into public.company_feature_overrides (company_id, feature_key, reason, granted_by, expires_at, status)
    values (p_company_id, 'hr', v_reason, auth.uid(), null, 'active')
    on conflict (company_id, feature_key) do update
      set reason = excluded.reason, granted_by = excluded.granted_by, granted_at = now(),
          expires_at = null, status = 'active',
          suspended_at = null, suspended_by = null, suspend_reason = null;
  else
    delete from public.company_feature_overrides
     where company_id = p_company_id and feature_key = 'hr';
  end if;
  v_new := jsonb_build_object('company_id', p_company_id, 'feature_key', 'hr',
    'enabled', p_enabled, 'reason', v_reason);
  perform public.log_privileged('hr.module', p_company_id, v_old, v_new);
  perform public._hr_subscription_audit(p_company_id,
    case when p_enabled then 'hr.module_enabled' else 'hr.module_disabled' end,
    v_old, v_new, v_reason);
  perform public._hr_audit(p_company_id, 'entitlement.changed', 'entitlement', p_company_id, null,
    v_old, v_new, v_reason);
  return v_new;
end $$;
comment on function public.owner_hr_set_module(uuid, boolean, text) is
  '143: تفعيل/إبطال وحدة HR لشركة (تجاوز hr). الإبطال يحذف صف التجاوز؛ البيانات في الشركة تبقى محفوظة.';

-- 12.2) تفعيل/إبطال قسم لشركة (أحد مفاتيح الأقسام الستة).
create or replace function public.owner_hr_set_section(p_company_id uuid, p_feature_key text,
                                                      p_enabled boolean, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_reason text;
  v_old    jsonb;
  v_new    jsonb;
begin
  if not public.owner_critical_ok() then
    raise exception 'إدارة أقسام HR لمالك المنصة في سياقه وبتحقق حديث' using errcode = '42501';
  end if;
  v_reason := public._reason_check(p_reason);
  if p_feature_key not in ('hr_employees', 'hr_leave', 'hr_payroll', 'hr_tasks', 'hr_attendance', 'hr_reports') then
    raise exception 'مفتاح قسم غير صالح' using errcode = '22023';
  end if;
  if p_enabled is null then
    raise exception 'حدّد تفعيلًا أو إبطالًا' using errcode = '22023';
  end if;
  if not exists (select 1 from public.companies where id = p_company_id) then
    raise exception 'الشركة غير موجودة' using errcode = 'P0002';
  end if;
  select jsonb_build_object('enabled', exists (select 1 from public.company_feature_overrides o
             where o.company_id = p_company_id and o.feature_key = p_feature_key and o.status = 'active'
               and (o.expires_at is null or o.expires_at > now())))
    into v_old;
  if p_enabled then
    insert into public.company_feature_overrides (company_id, feature_key, reason, granted_by, expires_at, status)
    values (p_company_id, p_feature_key, v_reason, auth.uid(), null, 'active')
    on conflict (company_id, feature_key) do update
      set reason = excluded.reason, granted_by = excluded.granted_by, granted_at = now(),
          expires_at = null, status = 'active',
          suspended_at = null, suspended_by = null, suspend_reason = null;
  else
    delete from public.company_feature_overrides
     where company_id = p_company_id and feature_key = p_feature_key;
  end if;
  v_new := jsonb_build_object('company_id', p_company_id, 'feature_key', p_feature_key,
    'enabled', p_enabled, 'reason', v_reason);
  perform public.log_privileged('hr.section', p_company_id, v_old, v_new);
  perform public._hr_subscription_audit(p_company_id,
    case when p_enabled then 'hr.section_enabled' else 'hr.section_disabled' end,
    v_old, v_new, v_reason);
  perform public._hr_audit(p_company_id, 'entitlement.changed', 'entitlement', p_company_id, null,
    v_old, v_new, v_reason);
  return v_new;
end $$;
comment on function public.owner_hr_set_section(uuid, text, boolean, text) is
  '143: تفعيل/إبطال قسم HR لشركة (تجاوز لمفتاح القسم). الإبطال يحذف صف التجاوز؛ البيانات تبقى محفوظة.';

-- 12.3) قائمة الشركات مع حالة HR (حالات وعدّادات فقط — بلا PII).
create or replace function public.owner_hr_list_companies(p_search text default null, p_page integer default 1)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_page int := greatest(coalesce(p_page, 1), 1);
  v_size int := 25;
  v_term text := nullif(btrim(coalesce(p_search, '')), '');
begin
  perform public._owner_require();
  if v_term is not null then
    v_term := replace(replace(replace(v_term, '\', '\\'), '%', '\%'), '_', '\_');
  end if;
  return (
    with f as (
      select c.id company_id, c.company_name, c.status company_status,
             (select email from public.profiles where id = c.user_id) owner_email,
             (select count(*) from public.hr_employees e where e.company_id = c.id) employees_total,
             (select count(*) from public.hr_employees e where e.company_id = c.id and e.archived_at is null) employees_active
        from public.companies c
       where v_term is null
          or c.company_name ilike '%' || v_term || '%' escape '\'
          or exists (select 1 from public.profiles p where p.id = c.user_id and p.email ilike '%' || v_term || '%' escape '\')
    )
    select jsonb_build_object(
      'rows', coalesce((select jsonb_agg(jsonb_build_object(
          'company_id', s.company_id, 'company_name', s.company_name,
          'company_status', s.company_status, 'owner_email', s.owner_email,
          'hr_enabled', public._hr_entitled(s.company_id, 'hr', true),
          'sections', jsonb_build_object(
            'hr_employees', public._hr_entitled(s.company_id, 'hr_employees', true),
            'hr_leave', public._hr_entitled(s.company_id, 'hr_leave', true),
            'hr_payroll', public._hr_entitled(s.company_id, 'hr_payroll', true),
            'hr_tasks', public._hr_entitled(s.company_id, 'hr_tasks', true),
            'hr_attendance', public._hr_entitled(s.company_id, 'hr_attendance', true),
            'hr_reports', public._hr_entitled(s.company_id, 'hr_reports', true)),
          'overrides', coalesce((select jsonb_agg(jsonb_build_object(
              'feature_key', o.feature_key, 'status', o.status, 'expires_at', o.expires_at,
              'reason', o.reason) order by o.feature_key)
            from public.company_feature_overrides o
           where o.company_id = s.company_id and o.feature_key like 'hr%'), '[]'::jsonb),
          'employees_total', s.employees_total, 'employees_active', s.employees_active)
        order by s.company_name)
        from (select * from f order by company_name limit v_size offset (v_page - 1) * v_size) s), '[]'::jsonb),
      'total', (select count(*) from f),
      'page', v_page, 'page_size', v_size));
end $$;
comment on function public.owner_hr_list_companies(text, integer) is
  '143: شركات المنصة مع حالة إتاحة HR وعدّادي موظفين فقط — بلا أسماء موظفين ولا PII ولا رواتب.';

-- 12.4) سجل عمليات HR للمالك (على نمط owner_store_operations_log في 133):
--     اتحاد privileged_audit (hr.%) + subscription_audit_log (hr.%) +
--     hr_audit_logs لأحداث entitlement.changed — ملخصات عربية.
create or replace function public.owner_hr_operations_log(p_limit integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare v_n int := least(greatest(coalesce(p_limit, 30), 1), 100);
begin
  perform public._owner_require();
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'at', x.at, 'source', x.source, 'action', x.action, 'actor_email', x.actor_email,
      'company_name', x.company_name, 'summary', x.summary)
      order by x.at desc), '[]'::jsonb)
    from (select * from (
      select a.at, 'privileged' source, a.action,
             (select email from public.profiles where id = a.actor_id) actor_email,
             (select company_name from public.companies where id = a.target_user_id) company_name,
             case a.action
               when 'hr.module' then 'وحدة HR: ' || case when coalesce((a.new_value->>'enabled')::boolean, false) then 'فُعّلت' else 'أُبطلت' end
               when 'hr.section' then 'قسم ' || (a.new_value->>'feature_key') || ': ' || case when coalesce((a.new_value->>'enabled')::boolean, false) then 'فُعّل' else 'أُبطل' end
               else a.action end summary
        from public.privileged_audit a
       where a.action like 'hr.%'
      union all
      select l.created_at, 'subscription', l.action,
             l.actor_email,
             (select company_name from public.companies where user_id = l.target_user_id) company_name,
             case l.action
               when 'hr.module_enabled' then 'وحدة HR فُعّلت للشركة'
               when 'hr.module_disabled' then 'وحدة HR أُبطلت للشركة'
               when 'hr.section_enabled' then 'قسم HR فُعّل للشركة'
               when 'hr.section_disabled' then 'قسم HR أُبطل للشركة'
               else l.action end
        from public.subscription_audit_log l
       where l.action like 'hr.%'
      union all
      select h.created_at, 'hr_audit', h.action,
             (select email from public.profiles where id = h.actor_user_id) actor_email,
             (select company_name from public.companies where id = h.company_id) company_name,
             'تغيير استحقاق HR في الشركة'
        from public.hr_audit_logs h
       where h.action = 'entitlement.changed'
    ) u order by u.at desc limit v_n) x);
end $$;
comment on function public.owner_hr_operations_log(integer) is
  '143: سجل عمليات HR للمالك — ملخصات عربية من privileged_audit وsubscription_audit_log وhr_audit_logs.';


-- ============================================================================
-- 13) الصلاحيات — على نمط 129/133: العامة للشركات عبر جلسة موثقة،
--     والداخلية _hr_* مغلقة تمامًا.
-- ============================================================================
do $$
declare f text;
begin
  foreach f in array array[
    'public._hr_gate(text,boolean)', 'public._hr_entitled(uuid,text,boolean)',
    'public._hr_is_company_admin(uuid)', 'public._hr_has_permission(uuid,text)',
    'public._hr_can_archive(uuid)', 'public._hr_my_employee_id(uuid)',
    'public._hr_dept_scope(uuid)', 'public._hr_audit(uuid,text,text,uuid,uuid,jsonb,jsonb,text)',
    'public._hr_subscription_audit(uuid,text,jsonb,jsonb,text)',
    'public._hr_mask_national_id(text)', 'public._hr_next_employee_number(uuid)',
    'public._hr_validate_employee_row(jsonb,uuid)', 'public._hr_in_my_scope(uuid)',
    'public._hr_touch_updated_at()', 'public._hr_org_depth_guard()',
    'public._hr_audit_immutable()'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
  foreach f in array array[
    'public.hr_employees_list(integer,integer,text,text,uuid,uuid,boolean)',
    'public.hr_employees_count()',
    'public.hr_employee_create(text,text,text,text,text,uuid,uuid,uuid,uuid,text,date,text,date,text,jsonb)',
    'public.hr_employee_update(uuid,text,text,text,text,uuid,uuid,uuid,uuid,text,date,text,date,text,jsonb)',
    'public.hr_employee_archive(uuid,text)',
    'public.hr_employee_reactivate(uuid,text)',
    'public.hr_employee_set_status(uuid,text,text)',
    'public.hr_employee_detail(uuid)',
    'public.hr_my_employee()',
    'public.hr_in_my_scope(uuid)',
    'public.hr_departments_list(boolean)',
    'public.hr_department_create(text,uuid,text,uuid,integer)',
    'public.hr_department_update(uuid,text,uuid,text,uuid,boolean,integer)',
    'public.hr_department_archive(uuid,text)',
    'public.hr_branches_list(boolean)',
    'public.hr_branch_create(text,uuid,text,uuid,integer)',
    'public.hr_branch_update(uuid,text,uuid,text,uuid,boolean,integer)',
    'public.hr_branch_archive(uuid,text)',
    'public.hr_positions_list(boolean)',
    'public.hr_position_create(text,uuid,text,uuid,uuid,integer,integer)',
    'public.hr_position_update(uuid,text,uuid,text,uuid,uuid,integer,boolean,integer)',
    'public.hr_position_archive(uuid,text)',
    'public.hr_settings_get()',
    'public.hr_settings_update(text,integer,integer,jsonb)',
    'public.hr_import_employees(jsonb,uuid,text)',
    'public.hr_import_runs_list(integer,integer)',
    'public.hr_import_run_detail(uuid)',
    'public.hr_link_employee_account(uuid,uuid,text)',
    'public.hr_link_employee_unlink(uuid,text)',
    'public.hr_unlink_employee_account(uuid,text)',
    'public.owner_hr_set_module(uuid,boolean,text)',
    'public.owner_hr_set_section(uuid,text,boolean,text)',
    'public.owner_hr_list_companies(text,integer)',
    'public.owner_hr_operations_log(integer)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;


-- ============================================================================
-- 14) تحقق ذاتي (على نمط 129/133): كل جدول ودالة وفهرس وقيد وصف بذرة.
-- ============================================================================
do $$
declare
  v_tables text[] := array['hr_employees', 'hr_departments', 'hr_branches', 'hr_positions',
                           'hr_settings', 'hr_audit_logs', 'hr_import_runs',
                           'hr_employee_status_history', 'hr_role_assignments'];
  v_funcs text[] := array[
    'public.hr_employees_list(integer,integer,text,text,uuid,uuid,boolean)',
    'public.hr_employees_count()',
    'public.hr_employee_create(text,text,text,text,text,uuid,uuid,uuid,uuid,text,date,text,date,text,jsonb)',
    'public.hr_employee_update(uuid,text,text,text,text,uuid,uuid,uuid,uuid,text,date,text,date,text,jsonb)',
    'public.hr_employee_archive(uuid,text)',
    'public.hr_employee_reactivate(uuid,text)',
    'public.hr_employee_set_status(uuid,text,text)',
    'public.hr_employee_detail(uuid)',
    'public.hr_my_employee()',
    'public.hr_in_my_scope(uuid)',
    'public.hr_departments_list(boolean)',
    'public.hr_department_create(text,uuid,text,uuid,integer)',
    'public.hr_department_update(uuid,text,uuid,text,uuid,boolean,integer)',
    'public.hr_department_archive(uuid,text)',
    'public.hr_branches_list(boolean)',
    'public.hr_branch_create(text,uuid,text,uuid,integer)',
    'public.hr_branch_update(uuid,text,uuid,text,uuid,boolean,integer)',
    'public.hr_branch_archive(uuid,text)',
    'public.hr_positions_list(boolean)',
    'public.hr_position_create(text,uuid,text,uuid,uuid,integer,integer)',
    'public.hr_position_update(uuid,text,uuid,text,uuid,uuid,integer,boolean,integer)',
    'public.hr_position_archive(uuid,text)',
    'public.hr_settings_get()',
    'public.hr_settings_update(text,integer,integer,jsonb)',
    'public.hr_import_employees(jsonb,uuid,text)',
    'public.hr_import_runs_list(integer,integer)',
    'public.hr_import_run_detail(uuid)',
    'public.hr_link_employee_account(uuid,uuid,text)',
    'public.hr_link_employee_unlink(uuid,text)',
    'public.hr_unlink_employee_account(uuid,text)',
    'public.owner_hr_set_module(uuid,boolean,text)',
    'public.owner_hr_set_section(uuid,text,boolean,text)',
    'public.owner_hr_list_companies(text,integer)',
    'public.owner_hr_operations_log(integer)'];
  t text;
  f text;
  v_def text;
begin
  foreach t in array v_tables loop
    if to_regclass('public.' || t) is null then
      raise exception '143: الجدول % غائب', t;
    end if;
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception '143: RLS غير مفعّلة على %', t;
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t
                    and policyname = 'gate_account_active') then
      raise exception '143: سياسة gate_account_active غائبة على %', t;
    end if;
  end loop;
  foreach f in array v_funcs loop
    if to_regprocedure(f) is null then
      raise exception '143: الدالة % غائبة', f;
    end if;
    if not has_function_privilege('authenticated', f::regprocedure, 'EXECUTE') then
      raise exception '143: الدالة % غير ممنوحة لـ authenticated', f;
    end if;
  end loop;
  if not exists (select 1 from pg_indexes where schemaname = 'public'
                  and indexname = 'hr_employees_company_number_uidx') then
    raise exception '143: فهرس UNIQUE(company_id, employee_number) غائب';
  end if;
  if not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'hr_employees_company_email_uidx') then
    raise exception '143: فهرس البريد الفريد غائب';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_hr_departments_depth_guard') then
    raise exception '143: حارس العمق غائب على hr_departments';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_hr_audit_logs_immutable') then
    raise exception '143: حارس الإلحاقية غائب على hr_audit_logs';
  end if;
  if not exists (select 1 from public.platform_feature_switches where key = 'hr_module_enabled' and enabled = false) then
    raise exception '143: مفتاح المنصة hr_module_enabled غائب أو مفعّل — يجب أن يكون مطفأً';
  end if;
  if (select count(*) from public.feature_flags where key in
      ('hr', 'hr_employees', 'hr_leave', 'hr_payroll', 'hr_tasks', 'hr_attendance', 'hr_reports')) <> 7 then
    raise exception '143: مفاتيح HR السبعة غير مكتملة في feature_flags';
  end if;
  if (select count(*) from public.company_permission_catalog where key like 'hr.%') <> 16 then
    raise exception '143: مفاتيح hr.* في الكتالوج يجب أن تكون 16';
  end if;
  if (select count(*) from public.plan_features where feature_key like 'hr%' and enabled = true) <> 0 then
    raise exception '143: مزايا HR في الباقات يجب أن تكون كلها مطفأة';
  end if;
  select pg_get_constraintdef(oid) into v_def from pg_constraint
   where conname = 'company_feature_overrides_pilot_only'
     and conrelid = 'public.company_feature_overrides'::regclass;
  if v_def is null or v_def not like '%''hr_employees''%' or v_def not like '%''hr_payroll''%' then
    raise exception '143: قيد التجاوزات لم يُوسَّع لمفاتيح HR';
  end if;
  select pg_get_constraintdef(oid) into v_def from pg_constraint
   where conname = 'company_permission_catalog_key_check'
     and conrelid = 'public.company_permission_catalog'::regclass;
  if v_def is null or v_def not like '%{1,2}%' then
    raise exception '143: قيد مفتاح الكتالوج لا يقبل مفاتيح hr.* بنقطتين';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'company_feature_overrides'
                    and column_name = 'status') then
    raise exception '143: عمود status غائب من company_feature_overrides';
  end if;
  raise notice '143: وحدة HR — الأساسيات والموظفون — جاهزة (مطفأة تجاريًا: المفتاح العام off وكل مزايا الباقات off)';
end $$;
