-- ============================================================================
-- 143_hr_module_employees على نسخة مطابقة للإنتاج + 118 + 119
--
--   ⓪ 143 مرتين: قابل لإعادة التشغيل؛ الجداول والدوال والفهارس والبذرة كلها
--     موجودة؛ قيدا التجاوزات والكتالوج موسَّعان؛ المفتاح العام مطفأ افتراضيًا
--   ① بوابة الاستحقاق تحجب والمفتاح مطفأ؛ غير المالك مرفوض من دوال المالك
--   ② المالك يفعّل المفتاح العام والوحدة والقسم لشركة أ (بسبب + تحقق حديث)
--   ③ إنشاء موظف + ترقيم تلقائي + UNIQUE(company_id, employee_number)
--      + user_id nullable و FK بـ SET NULL + CHECK الحالة يرفض القيم السيئة
--   ④ عزل الشركات: شركة ب المستحقة لا ترى موظفي أ عبر RPCs
--   ⑤ الأرشفة لا تحذف أبدًا + سجل حالات + سجل تدقيق؛ إعادة التفعيل؛
--      set_status يرفض terminated؛ سجل التدقيق غير قابل للتعديل
--   ⑥ الاستيراد: نتائج صفًا صفًا + حد 100 صف + إعادة مفتاح عدم التكرار
--      تعيد النتيجة المخزنة بلا إدراج جديد
--   ⑦ الربط بالحساب: نجاح + رفض المنصة/المحظور/شركة أخرى/ربط مكرر + فك الربط
--   ⑧ تجاوز موقوف: القراءة مسموحة والكتابة محظورة
--   ⑨ حارس عمق الهيكل (6 مستويات) + منع النقل تحت حفيد
--   ⑩ قائمة المالك وسجله: حالة استحقاق وعدد موظفين فقط — بلا بيانات موظفين
-- ============================================================================
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
SET client_min_messages = warning;

\i tests/fixtures/ecommerce/chain.sql
\i migrations/118_ecommerce_store_accounts.sql
\i migrations/119_shopify_store_integration.sql
\i migrations/143_hr_module_employees.sql
\i migrations/143_hr_module_employees.sql
SET search_path = public, extensions;

-- مساعد محلي (نمط account-hierarchy-customers.test.sql): قراءة قيمة محفوظة
CREATE FUNCTION t.sv(p text) RETURNS uuid LANGUAGE sql AS $$ select v::uuid from t.saved where k = p $$;

-- ══ ⓪ إعادة التطبيق والبذرة ═══════════════════════════════════════════════
DO $$
DECLARE v_def text;
BEGIN
  PERFORM t.ok(to_regclass('public.hr_employees') is not null, '⓪ hr_employees');
  PERFORM t.ok(to_regclass('public.hr_departments') is not null, '⓪ hr_departments');
  PERFORM t.ok(to_regclass('public.hr_branches') is not null, '⓪ hr_branches');
  PERFORM t.ok(to_regclass('public.hr_positions') is not null, '⓪ hr_positions');
  PERFORM t.ok(to_regclass('public.hr_settings') is not null, '⓪ hr_settings');
  PERFORM t.ok(to_regclass('public.hr_audit_logs') is not null, '⓪ hr_audit_logs');
  PERFORM t.ok(to_regclass('public.hr_import_runs') is not null, '⓪ hr_import_runs');
  PERFORM t.ok(to_regclass('public.hr_employee_status_history') is not null, '⓪ status_history');
  PERFORM t.ok(to_regclass('public.hr_role_assignments') is not null, '⓪ role_assignments');
  PERFORM t.ok(to_regprocedure('public.hr_employees_list(integer,integer,text,text,uuid,uuid,boolean)') is not null, '⓪ list');
  PERFORM t.ok(to_regprocedure('public.hr_employee_create(text,text,text,text,text,uuid,uuid,uuid,uuid,text,date,text,date,text,jsonb)') is not null, '⓪ create');
  PERFORM t.ok(to_regprocedure('public.hr_import_employees(jsonb,uuid,text)') is not null, '⓪ import');
  PERFORM t.ok(to_regprocedure('public.hr_link_employee_account(uuid,uuid,text)') is not null, '⓪ link');
  PERFORM t.ok(to_regprocedure('public.owner_hr_set_module(uuid,boolean,text)') is not null, '⓪ owner set module');
  PERFORM t.ok(to_regprocedure('public.owner_hr_set_section(uuid,text,boolean,text)') is not null, '⓪ owner set section');
  PERFORM t.ok(to_regprocedure('public.owner_hr_list_companies(text,integer)') is not null, '⓪ owner list');
  PERFORM t.ok(to_regprocedure('public.owner_hr_operations_log(integer)') is not null, '⓪ owner log');
  PERFORM t.ok((select count(*) from public.feature_flags where key like 'hr%') = 7, '⓪ 7 feature_flags');
  PERFORM t.ok((select count(*) from public.company_permission_catalog where key like 'hr.%') = 16, '⓪ 16 catalog');
  PERFORM t.ok((select count(*) from public.plan_features where feature_key like 'hr%' and enabled) = 0, '⓪ لا مزايا HR مفعّلة في الباقات');
  PERFORM t.ok((select enabled from public.platform_feature_switches where key = 'hr_module_enabled') = false, '⓪ المفتاح العام مطفأ افتراضيًا');
  PERFORM t.ok((select relrowsecurity from pg_class where oid = 'public.hr_employees'::regclass), '⓪ RLS مفعّل على hr_employees');
  PERFORM t.ok(exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'hr_employees_company_number_uidx'), '⓪ UNIQUE(company_id, employee_number)');
  select pg_get_constraintdef(oid) into v_def from pg_constraint
   where conname = 'company_feature_overrides_pilot_only' and conrelid = 'public.company_feature_overrides'::regclass;
  PERFORM t.ok(v_def like '%''hr_employees''%' and v_def like '%''hr_payroll''%', '⓪ قيد التجاوزات موسَّع');
  select pg_get_constraintdef(oid) into v_def from pg_constraint
   where conname = 'company_permission_catalog_key_check' and conrelid = 'public.company_permission_catalog'::regclass;
  PERFORM t.ok(v_def like '%{1,2}%', '⓪ قيد الكتالوج يقبل نقطتين');
  RAISE NOTICE 'PASS ⓪ 143 قابل لإعادة التشغيل؛ البذرة والقيدان كما هو متوقع';
END $$;

-- ══ ① البوابة تحجب والمفتاح مطفأ ══════════════════════════════════════════
DO $$
BEGIN
  PERFORM t.ok(t.err(t.u('OA'), 'public.hr_employees_list()') = '42501', '① قائمة بلا مفتاح عام');
  PERFORM t.ok(t.err(t.u('OA'), 'public.hr_employee_create(''أحمد محمد'', ''EMP-0001'')') = '42501', '① إنشاء بلا مفتاح عام');
  PERFORM t.ok(t.err(t.u('OA'), 'public.owner_hr_list_companies(null, 1)') = '42501', '① قائمة المالك ليست لمالك شركة');
  PERFORM t.ok(t.err(t.u('OA'), 'public.owner_hr_set_module(''' || t.u('CA') || ''', true, ''تفعيل وحدة الموارد البشرية'')') = '42501', '① set_module ليس لمالك شركة');
  PERFORM t.ok(t.err(t.u('OW'), 'public.owner_hr_set_module(''' || t.u('CA') || ''', true, ''تفعيل وحدة الموارد البشرية'')') = '42501', '① set_module بلا تحقق حديث');
  -- السبب القصير لا يُفحص إلا بعد سياق المالك + تحقق حديث، وإلا سبقه 42501
  PERFORM t.ctx('owner');
  PERFORM t.stepup(t.u('OW'));
  PERFORM t.ok(t.err(t.u('OW'), 'public.owner_hr_set_module(''' || t.u('CA') || ''', true, ''قصير'')') = '22023', '① سبب أقل من 10 أحرف');
  PERFORM t.ctx(null);
  RAISE NOTICE 'PASS ① البوابة تحجب والمفتاح مطفأ؛ دوال المالك للمالك وحده';
END $$;

-- ══ ② المالك يفعّل ═══════════════════════════════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM t.ctx('owner');
  PERFORM t.stepup(t.u('OW'));
  r := t.call(t.u('OW'), 'public.owner_set_feature_switch(''hr_module_enabled'', true, ''تفعيل وحدة الموارد البشرية بعد المراجعة'')');
  PERFORM t.ok((select enabled from public.platform_feature_switches where key = 'hr_module_enabled') = true, '② المفتاح العام فُعِّل');
  r := t.call(t.u('OW'), format('public.owner_hr_set_module(%L, true, %L)', t.u('CA'), 'تفعيل وحدة الموارد البشرية للشركة أ'));
  PERFORM t.ok((r ->> 'enabled')::boolean = true, '② الوحدة مفعّلة لشركة أ');
  r := t.call(t.u('OW'), format('public.owner_hr_set_section(%L, ''hr_employees'', true, %L)', t.u('CA'), 'تفعيل قسم الموظفين للشركة أ'));
  PERFORM t.ok((r ->> 'enabled')::boolean = true, '② قسم الموظفين مفعّل لشركة أ');
  -- شركة ب بلا تجاوز: قائمتها محجوبة حتى بعد تفعيل المفتاح العام
  PERFORM t.ok(t.err(t.u('OB'), 'public.hr_employees_list()') = '42501', '② شركة ب بلا تجاوز محجوبة');
  PERFORM t.ctx(null);
  RAISE NOTICE 'PASS ② المالك فعّل المفتاح العام والوحدة والقسم لشركة أ';
END $$;

-- ══ ③ الإنشاء والترقيم والتفرد وuser_id ═══════════════════════════════════
DO $$
DECLARE r jsonb; v_id uuid; v_auto text; v_conf text;
BEGIN
  r := t.call(t.u('OA'), 'public.hr_employee_create(''أحمد محمد'', ''EMP-0001'', ''01001234567'', ''ahmed@a.test'', ''29901011234567'', null, null, null, null, ''مهندس'', ''2026-01-01'', ''full_time'')');
  PERFORM t.ok((r ->> 'employee_number') = 'EMP-0001', '③ رقم صريح');
  -- hr_employee_create يعيد {employee_id, employee_number} فقط — الحالة وuser_id تُقرآن من الصف
  v_id := (r ->> 'employee_id')::uuid;
  PERFORM t.ok((select employment_status from public.hr_employees where id = v_id) = 'active', '③ الحالة الافتراضية نشط');
  PERFORM t.ok((select user_id from public.hr_employees where id = v_id) is null, '③ user_id فارغ افتراضيًا');
  INSERT INTO t.saved VALUES ('emp_ahmed', v_id::text);
  -- ترقيم تلقائي: البادئة الافتراضية '' (التصميم §2.3) — نضبط 'EMP-' أولًا
  -- فيثبت أن التوليد يتخطى EMP-0001 المستخدم إلى EMP-0002
  r := t.call(t.u('OA'), 'public.hr_settings_update(''EMP-'')');
  PERFORM t.ok((r ->> 'employee_number_prefix') = 'EMP-', '③ ضبط بادئة الترقيم');
  r := t.call(t.u('OA'), 'public.hr_employee_create(''سارة علي'', null, ''01001234568'', ''sara@a.test'')');
  v_auto := r ->> 'employee_number';
  PERFORM t.ok(v_auto = 'EMP-0002', '③ ترقيم تلقائي EMP-0002');
  INSERT INTO t.saved VALUES ('emp_sara', (r ->> 'employee_id')::text);
  -- تكرار الرقم داخل الشركة عبر RPC: المحقق يرفض 22023 برسالة عربية
  -- (معالج 23505 في الإنشاء لمسار السباق فقط — لا يُصَل إليه عادة)
  PERFORM t.ok(t.errfull(t.u('OA'), 'public.hr_employee_create(''مكرر'', ''EMP-0001'')') like '22023|%الرقم الوظيفي مستخدم بالفعل%', '③ تكرار الرقم 22023 عربي');
  -- والقيد الفريد نفسه يرفض 23505 بإدراج مباشر
  BEGIN
    INSERT INTO public.hr_employees (company_id, employee_number, full_name)
    VALUES (t.u('CA'), 'EMP-0001', 'مكرر مباشر');
    PERFORM t.ok(false, '③ UNIQUE كان يجب أن يرفض');
  EXCEPTION WHEN unique_violation THEN
    PERFORM t.ok(true, '③ UNIQUE(company_id, employee_number) 23505');
  END;
  -- بريد فاسد وهاتف قصير
  PERFORM t.ok(t.err(t.u('OA'), 'public.hr_employee_create(''بريد فاسد'', ''EMP-0009'', null, ''not-an-email'')') = '22023', '③ بريد فاسد');
  PERFORM t.ok(t.err(t.u('OA'), 'public.hr_employee_create(''هاتف قصير'', ''EMP-0010'', ''12'')') = '22023', '③ هاتف قصير');
  -- CHECK الحالة يرفض قيمة سيئة بإدراج مباشر (كمالك الجدول: RLS لا تحجب
  -- المالك، فيصل الإدراج إلى CHECK ويرفض 23514)
  BEGIN
    INSERT INTO public.hr_employees (company_id, employee_number, full_name, employment_status)
    VALUES (t.u('CA'), 'EMP-0099', 'سيئ', 'fired');
    PERFORM t.ok(false, '③ CHECK الحالة كان يجب أن يرفض');
  EXCEPTION WHEN check_violation THEN
    PERFORM t.ok(true, '③ CHECK الحالة');
  END;
  -- user_id nullable و FK بـ SET NULL
  select pg_get_constraintdef(oid) into v_conf from pg_constraint
   where conrelid = 'public.hr_employees'::regclass and conname like '%user_id%fkey';
  PERFORM t.ok(v_conf like '%ON DELETE SET NULL%', '③ FK user_id بـ SET NULL');
  RAISE NOTICE 'PASS ③ إنشاء وترقيم تلقائي وتفرد وuser_id';
END $$;

-- ══ ④ عزل الشركات ═══════════════════════════════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  -- منح شركة ب التجاوز (الوحدة + قسم الموظفين) ثم التأكد أنها لا ترى موظفي أ
  -- (القائمة تبوَّب على القسم أيضًا — الوحدة وحدها لا تكفي)
  PERFORM t.ctx('owner');
  PERFORM t.stepup(t.u('OW'));
  r := t.call(t.u('OW'), format('public.owner_hr_set_module(%L, true, %L)', t.u('CB'), 'تفعيل وحدة الموارد البشرية للشركة ب'));
  r := t.call(t.u('OW'), format('public.owner_hr_set_section(%L, ''hr_employees'', true, %L)', t.u('CB'), 'تفعيل قسم الموظفين للشركة ب'));
  PERFORM t.ctx(null);
  r := t.call(t.u('OB'), 'public.hr_employees_list()');
  PERFORM t.ok((r ->> 'total_count')::int = 0, '④ شركة ب ترى صفر موظفين');
  PERFORM t.ok(t.err(t.u('OB'), format('public.hr_employee_detail(%L)', t.sv('emp_ahmed'))) = 'P0002', '④ تفاصيل موظف أ مرفوضة من ب');
  r := t.call(t.u('OA'), 'public.hr_employees_list()');
  PERFORM t.ok((r ->> 'total_count')::int = 2, '④ شركة أ ترى موظفيها (2)');
  r := t.call(t.u('OA'), 'public.hr_employees_list(1, 20, ''أحمد'')');
  PERFORM t.ok((r ->> 'total_count')::int = 1, '④ بحث بالاسم');
  r := t.call(t.u('OA'), 'public.hr_employees_list(1, 20, null, ''active'')');
  PERFORM t.ok((r ->> 'total_count')::int = 2, '④ تصفية بالحالة');
  -- الرقم القومي مقنّع في القائمة
  PERFORM t.ok((r -> 'rows' -> 0 ->> 'national_id') like '299********67' or (r -> 'rows' -> 1 ->> 'national_id') like '299********67', '④ الرقم القومي مقنّع في القائمة');
  RAISE NOTICE 'PASS ④ عزل الشركات عبر RPCs + بحث وتصفية وتقنيع';
END $$;

-- ══ ⑤ الأرشفة لا تحذف ════════════════════════════════════════════════════
DO $$
DECLARE r jsonb; v_before int; v_after int;
BEGIN
  PERFORM t.ok(t.err(t.u('OA'), format('public.hr_employee_archive(%L, ''قصير'')', t.sv('emp_ahmed'))) = '22023', '⑤ أرشفة بسبب قصير');
  v_before := (select count(*) from public.hr_employees where company_id = t.u('CA'));
  r := t.call(t.u('OA'), format('public.hr_employee_archive(%L, %L)', t.sv('emp_ahmed'), 'انتهاء عقد الموظف بعد مراجعة الإدارة'));
  PERFORM t.ok((r ->> 'employment_status') = 'terminated', '⑤ الحالة terminated');
  PERFORM t.ok(exists (select 1 from public.hr_employees where id = t.sv('emp_ahmed')::uuid and archived_at is not null), '⑤ archived_at مضبوط');
  v_after := (select count(*) from public.hr_employees where company_id = t.u('CA'));
  PERFORM t.ok(v_before = v_after, '⑤ الأرشفة لا تحذف الصف');
  PERFORM t.ok(exists (select 1 from public.hr_employee_status_history where employee_id = t.sv('emp_ahmed')::uuid and to_status = 'terminated'), '⑤ سجل حالة الأرشفة');
  PERFORM t.ok(exists (select 1 from public.hr_audit_logs where employee_id = t.sv('emp_ahmed')::uuid and action = 'employee.archived'), '⑤ سجل تدقيق الأرشفة');
  -- set_status يرفض terminated مباشرة
  PERFORM t.ok(t.err(t.u('OA'), format('public.hr_employee_set_status(%L, ''terminated'', %L)', t.sv('emp_sara'), 'محاولة تعيين حالة منتهٍ مباشرة')) = '22023', '⑤ set_status يرفض terminated');
  r := t.call(t.u('OA'), format('public.hr_employee_set_status(%L, ''on_leave'', %L)', t.sv('emp_sara'), 'إجازة سنوية للموظفة سارة'));
  PERFORM t.ok((r ->> 'employment_status') = 'on_leave', '⑤ set_status إلى on_leave');
  -- إعادة التفعيل
  r := t.call(t.u('OA'), format('public.hr_employee_reactivate(%L, %L)', t.sv('emp_ahmed'), 'عودة الموظف بعد انتهاء الإجازة'));
  PERFORM t.ok((r ->> 'employment_status') = 'active', '⑤ إعادة التفعيل');
  -- سجل التدقيق غير قابل للتعديل أو الحذف (كمالك الجدول: RLS لا تحجب
  -- المالك، فيصل التعديل إلى المحفز ويرفض 42501 — _hr_audit_immutable).
  -- علم منفصل لأن t.ok نفسه يرمي P0001 فلا يصح التقاطه في نفس المعالج.
  DECLARE
    v_blocked boolean := false;
  BEGIN
    BEGIN
      UPDATE public.hr_audit_logs SET reason = 'x';
    EXCEPTION WHEN insufficient_privilege THEN
      v_blocked := true;
    END;
    PERFORM t.ok(v_blocked, '⑤ UPDATE على سجل التدقيق مرفوض');
    v_blocked := false;
    BEGIN
      DELETE FROM public.hr_audit_logs;
    EXCEPTION WHEN insufficient_privilege THEN
      v_blocked := true;
    END;
    PERFORM t.ok(v_blocked, '⑤ DELETE على سجل التدقيق مرفوض');
  END;
  RAISE NOTICE 'PASS ⑤ الأرشفة لا تحذف؛ سجل الحالات والتدقيق؛ التدقيق غير قابل للتعديل';
END $$;

-- ══ ⑥ الاستيراد ═════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb; v_before int; v_after int; v_key uuid := '11111111-1111-4111-8111-111111111111';
  v_rows jsonb := '[
    {"line": 2, "employee_number": "EMP-0010", "full_name": "خالد حسن", "phone": "01001111111", "email": "khaled@a.test"},
    {"line": 3, "employee_number": "EMP-0001", "full_name": "مكرر الرقم", "phone": "01002222222"},
    {"line": 4, "employee_number": "EMP-0011", "full_name": "", "phone": "01003333333"},
    {"line": 5, "employee_number": "EMP-0012", "full_name": "ليلى سمير", "manager_employee_number": "EMP-0001"}
  ]'::jsonb;
BEGIN
  v_before := (select count(*) from public.hr_employees where company_id = t.u('CA'));
  -- فوق الحد: 101 صفًا
  PERFORM t.ok(t.err(t.u('OA'), format('public.hr_import_employees(%L::jsonb, %L, ''big.csv'')',
    (select jsonb_agg(jsonb_build_object('line', i + 1, 'employee_number', 'EMP-9' || i, 'full_name', 'موظف ' || i)) from generate_series(1, 101) i),
    '22222222-2222-4222-8222-222222222222')) = '54000', '⑥ حد 100 صف');
  r := t.call(t.u('OA'), format('public.hr_import_employees(%L::jsonb, %L, ''batch1.csv'')', v_rows, v_key));
  PERFORM t.ok((r ->> 'inserted')::int = 2, '⑥ أُدخل صفان');
  PERFORM t.ok((r ->> 'duplicate')::int = 1, '⑥ مكرر واحد');
  PERFORM t.ok((r ->> 'invalid')::int = 1, '⑥ مرفوض واحد');
  PERFORM t.ok((r -> 'results' -> 0 ->> 'status') = 'inserted', '⑥ الصف الأول أُدخل');
  PERFORM t.ok((r -> 'results' -> 1 ->> 'status') = 'duplicate', '⑥ الصف الثاني مكرر');
  PERFORM t.ok((r -> 'results' -> 2 ->> 'status') = 'invalid', '⑥ الصف الثالث مرفوض');
  PERFORM t.ok((r -> 'results' -> 3 ->> 'status') = 'inserted', '⑥ الصف الرابع (مديره EMP-0001) أُدخل');
  v_after := (select count(*) from public.hr_employees where company_id = t.u('CA'));
  PERFORM t.ok(v_after = v_before + 2, '⑥ عدد الصفوف زاد بمقدار المُدخَل فقط');
  -- إعادة مفتاح عدم التكرار: نفس النتيجة بلا إدراج جديد
  r := t.call(t.u('OA'), format('public.hr_import_employees(%L::jsonb, %L, ''batch1.csv'')', v_rows, v_key));
  PERFORM t.ok((r ->> 'inserted')::int = 2, '⑥ إعادة المفتاح تعيد النتيجة المخزنة');
  PERFORM t.ok((select count(*) from public.hr_employees where company_id = t.u('CA')) = v_after, '⑥ إعادة المفتاح بلا إدراج جديد');
  -- مفتاح جديد لنفس الصفوف: الكل مكرر/مرفوض
  r := t.call(t.u('OA'), format('public.hr_import_employees(%L::jsonb, %L, ''batch1.csv'')', v_rows, '33333333-3333-4333-8333-333333333333'));
  PERFORM t.ok((r ->> 'inserted')::int = 0, '⑥ مفتاح جديد: لا إدراج مكرر');
  PERFORM t.ok((r ->> 'duplicate')::int = 3, '⑥ مفتاح جديد: ثلاثة مكررات');
  -- الاستيراد لم يمسّ أي جدول حسابات
  PERFORM t.ok((select count(*) from public.company_memberships where user_id in (select id from public.profiles where email like '%@a.test')) = 0, '⑥ الاستيراد لم ينشئ عضويات');
  PERFORM t.ok(exists (select 1 from public.hr_import_runs where idempotency_key = v_key and status = 'partial'), '⑥ سجل التشغيل جزئي (2 من 4)');
  RAISE NOTICE 'PASS ⑥ الاستيراد: نتائج صفًا صفًا + حد 100 + عدم تكرار';
END $$;

-- ══ ⑦ الربط بالحساب ═════════════════════════════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  -- عضوية نشطة لعميل أ1 في شركة أ (لمسار الربط) — 096 يعبّئها أصلًا من
  -- super_user_id، فالإدراج هنا احتياطي فقط إن غابت
  INSERT INTO public.company_memberships (company_id, user_id, status, joined_via)
  SELECT t.u('CA'), t.u('A1'), 'active', 'invitation'
  WHERE NOT EXISTS (select 1 from public.company_memberships
                     where company_id = t.u('CA') and user_id = t.u('A1') and status = 'active');
  r := t.call(t.u('OA'), format('public.hr_link_employee_account(%L, %L, %L)', t.sv('emp_sara'), t.u('A1'), 'ربط الموظفة سارة بحسابها القائم'));
  PERFORM t.ok((r ->> 'linked')::boolean = true, '⑦ ربط ناجح');
  r := t.call(t.u('OA'), format('public.hr_employee_detail(%L)', t.sv('emp_sara')));
  PERFORM t.ok((r ->> 'linked')::boolean = true, '⑦ التفاصيل تظهر الربط');
  -- ربط مكرر لنفس الموظف
  PERFORM t.ok(t.err(t.u('OA'), format('public.hr_link_employee_account(%L, %L, %L)', t.sv('emp_sara'), t.u('A2'), 'محاولة ربط ثانية للموظفة سارة')) = '22023', '⑦ ربط مكرر مرفوض');
  -- حساب شركة أخرى
  PERFORM t.ok(t.err(t.u('OA'), format('public.hr_link_employee_account(%L, %L, %L)', t.sv('emp_ahmed'), t.u('B1'), 'محاولة ربط بحساب شركة أخرى')) = '42501', '⑦ حساب شركة أخرى مرفوض');
  -- طاقم المنصة
  PERFORM t.ok(t.err(t.u('OA'), format('public.hr_link_employee_account(%L, %L, %L)', t.sv('emp_ahmed'), t.u('AD'), 'محاولة ربط بأدمن منصة')) = '42501', '⑦ أدمن المنصة مرفوض');
  -- محظور
  PERFORM t.ok(t.err(t.u('OA'), format('public.hr_link_employee_account(%L, %L, %L)', t.sv('emp_ahmed'), t.u('AX'), 'محاولة ربط بحساب محظور')) = '42501', '⑦ المحظور مرفوض');
  -- فك الربط
  r := t.call(t.u('OA'), format('public.hr_link_employee_unlink(%L, %L)', t.sv('emp_sara'), 'فك ربط الموظفة سارة بحسابها'));
  PERFORM t.ok((r ->> 'linked')::boolean = false, '⑦ فك الربط ناجح');
  PERFORM t.ok(exists (select 1 from public.hr_audit_logs where employee_id = t.sv('emp_sara')::uuid and action in ('employee.linked', 'employee.unlinked')), '⑦ تدقيق الربط وفك الربط');
  RAISE NOTICE 'PASS ⑦ الربط بالحساب: نجاح ورفض وفك ربط';
END $$;

-- ══ ⑧ تجاوز موقوف: قراءة مسموحة وكتابة محظورة ═══════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  UPDATE public.company_feature_overrides SET status = 'suspended', suspended_at = now(), suspended_by = t.u('OW'), suspend_reason = 'إيقاف مؤقت للمراجعة'
   WHERE company_id = t.u('CA') AND feature_key = 'hr';
  r := t.call(t.u('OA'), 'public.hr_employees_list()');
  PERFORM t.ok((r ->> 'total_count')::int >= 2, '⑧ القراءة مسموحة مع تجاوز موقوف');
  PERFORM t.ok(t.err(t.u('OA'), 'public.hr_employee_create(''موقوف'', ''EMP-0090'')') = '42501', '⑧ الكتابة محظورة مع تجاوز موقوف');
  UPDATE public.company_feature_overrides SET status = 'active', suspended_at = null, suspended_by = null, suspend_reason = null
   WHERE company_id = t.u('CA') AND feature_key = 'hr';
  r := t.call(t.u('OA'), 'public.hr_employee_create(''بعد الاستئناف'', ''EMP-0090'')');
  PERFORM t.ok((r ->> 'employee_number') = 'EMP-0090', '⑧ الكتابة تعود بعد استئناف التجاوز');
  RAISE NOTICE 'PASS ⑧ تجاوز موقوف: قراءة مسموحة وكتابة محظورة';
END $$;

-- ══ ⑨ حارس عمق الهيكل ═══════════════════════════════════════════════════
DO $$
DECLARE r jsonb; v_parent uuid := null; v_id uuid;
BEGIN
  FOR i IN 1 .. 6 LOOP
    r := t.call(t.u('OA'), format('public.hr_department_create(%L, %L, null, null, %s)', 'قسم مستوى ' || i, v_parent, 0));
    v_id := (r ->> 'id')::uuid;
    v_parent := v_id;
  END LOOP;
  PERFORM t.ok(t.err(t.u('OA'), format('public.hr_department_create(%L, %L, null, null, %s)', 'قسم مستوى 7', v_parent, 0)) = '22023', '⑨ المستوى السابع مرفوض');
  -- نقل عقدة تحت أحد أحفادها مرفوض (الجذر تحت المستوى 6)
  PERFORM t.ok(t.err(t.u('OA'), format('public.hr_department_update(%L, null, %L, null, null, null, null)', (select id from public.hr_departments where company_id = t.u('CA') and parent_id is null limit 1), v_parent)) = '22023', '⑨ النقل تحت حفيد مرفوض');
  RAISE NOTICE 'PASS ⑨ عمق الهيكل ≤6 ومنع النقل تحت حفيد';
END $$;

-- ══ ⑩ قائمة المالك وسجله: بلا بيانات موظفين ═════════════════════════════
DO $$
DECLARE r jsonb; v_text text;
BEGIN
  PERFORM t.ctx('owner');
  r := t.call(t.u('OW'), 'public.owner_hr_list_companies(null, 1)');
  PERFORM t.ok((r ->> 'total')::int >= 2, '⑩ قائمة المالك تحوي الشركات');
  v_text := r::text;
  PERFORM t.ok(v_text not like '%أحمد محمد%' and v_text not like '%29901011234567%', '⑩ قائمة المالك بلا أسماء موظفين ولا أرقام قومية');
  PERFORM t.ok(v_text like '%شركة أ%' and v_text like '%employees_total%', '⑩ قائمة المالك: اسم الشركة وعدد الموظفين');
  r := t.call(t.u('OW'), 'public.owner_hr_operations_log(10)');
  PERFORM t.ok(jsonb_array_length(r) >= 1, '⑩ سجل العمليات غير فارغ');
  PERFORM t.ok((r::text) like '%hr.module_enabled%', '⑩ سجل العمليات يحوي تفعيل الوحدة');
  PERFORM t.ctx(null);
  -- المحظور محجوب من كل RPC حتى مع الاستحقاق
  PERFORM t.ok(t.err(t.u('AX'), 'public.hr_employees_list()') = '42501', '⑩ المحظور محجوب');
  RAISE NOTICE 'PASS ⑩ قائمة المالك وسجله بلا بيانات موظفين؛ المحظور محجوب';
END $$;

-- ══ التراجع يعيد الحالة ═════════════════════════════════════════════════
DO $$
BEGIN
  PERFORM t.ok(to_regprocedure('public.hr_employees_list(integer,integer,text,text,uuid,uuid,boolean)') is not null, 'التراجع: الدوال موجودة قبل التراجع');
END $$;
\i migrations/_rollback/143_hr_module_employees.down.sql
DO $$
BEGIN
  PERFORM t.ok(to_regprocedure('public.hr_employees_list(integer,integer,text,text,uuid,uuid,boolean)') is null, 'التراجع: دوال HR حُذفت');
  PERFORM t.ok(to_regclass('public.hr_employees') is null, 'التراجع: جداول HR حُذفت');
  PERFORM t.ok((select count(*) from public.company_permission_catalog where key like 'hr.%') = 0, 'التراجع: مفاتيح الكتالوج حُذفت');
  PERFORM t.ok((select count(*) from public.feature_flags where key like 'hr%') = 0, 'التراجع: مفاتيح feature_flags حُذفت');
  PERFORM t.ok(not exists (select 1 from public.platform_feature_switches where key = 'hr_module_enabled'), 'التراجع: المفتاح العام حُذف');
  PERFORM t.ok((select pg_get_constraintdef(oid) from pg_constraint where conname = 'company_feature_overrides_pilot_only') like '%integrations_hub%' and (select pg_get_constraintdef(oid) from pg_constraint where conname = 'company_feature_overrides_pilot_only') not like '%''hr''%', 'التراجع: قيد التجاوزات عاد إلى 4 مفاتيح');
  RAISE NOTICE 'PASS التراجع يعيد الحالة؛ إعادة التطبيق تنجح';
END $$;
\i migrations/143_hr_module_employees.sql
DO $$
BEGIN
  PERFORM t.ok(to_regprocedure('public.hr_employees_list(integer,integer,text,text,uuid,uuid,boolean)') is not null, 'إعادة التطبيق بعد التراجع');
  RAISE NOTICE 'PASS hr-module-143 كامل';
END $$;
