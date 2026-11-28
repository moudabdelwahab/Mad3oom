-- اختبار تنفيذي لـ migrations/153_hr_settings_employee_number_next.sql
-- hr_settings_update() بمعامل خامس p_employee_number_next يضبط عدّاد الترقيم.
--   ① التفعيل (منصة + وحدة + قسم الموظفين) ثم قراءة الإعدادات الافتراضية
--   ② ضبط العدّاد إلى 100 ثم قراءته من hr_settings_get
--   ③ التوافق الرجعي: استدعاء بأربعة معاملات (توقيع 143) يعمل والعدّاد ثابت
--   ④ null تعني «بلا تغيير»؛ 0 مرفوضة 22023
--   ⑤ التراجع يعيد نسخة 143 حرفيًا (بلا المعامل الخامس) ثم إعادة التطبيق
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
SET client_min_messages = warning;

\i tests/fixtures/ecommerce/chain.sql
\i migrations/118_ecommerce_store_accounts.sql
\i migrations/119_shopify_store_integration.sql
\i migrations/143_hr_module_employees.sql
SET search_path = public, extensions;

-- ══ ① التفعيل ═══════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM t.ctx('owner');
  PERFORM t.stepup(t.u('OW'));
  r := t.call(t.u('OW'), 'public.owner_set_feature_switch(''hr_module_enabled'', true, ''تفعيل وحدة الموارد البشرية بعد المراجعة'')');
  r := t.call(t.u('OW'), format('public.owner_hr_set_module(%L, true, %L)', t.u('CA'), 'تفعيل وحدة الموارد البشرية للشركة أ'));
  r := t.call(t.u('OW'), format('public.owner_hr_set_section(%L, ''hr_employees'', true, %L)', t.u('CA'), 'تفعيل قسم الموظفين للشركة أ'));
  PERFORM t.ctx(null);
  PERFORM t.ok((select enabled from public.platform_feature_switches where key = 'hr_module_enabled') = true, '① المفتاح العام مفعّل');
  RAISE NOTICE 'PASS ① التفعيل';
END $$;

\i migrations/153_hr_settings_employee_number_next.sql

-- ══ ②③④ ضبط العدّاد والتوافق والتحقق ═══════════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  r := t.call(t.u('OA'), 'public.hr_settings_get()');
  PERFORM t.ok((r ->> 'employee_number_next')::int = 1, '② العدّاد الافتراضي 1');
  r := t.call(t.u('OA'), 'public.hr_settings_update(null, null, null, null, 100)');
  PERFORM t.ok((r ->> 'employee_number_next')::int = 100, '② ضبط العدّاد إلى 100');
  r := t.call(t.u('OA'), 'public.hr_settings_get()');
  PERFORM t.ok((r ->> 'employee_number_next')::int = 100, '② القراءة تعيد 100');
  -- ③ توقيع 143 بأربعة معاملات ما زال يعمل، والعدّاد لا يتغير
  r := t.call(t.u('OA'), 'public.hr_settings_update(''EMP-'')');
  PERFORM t.ok((r ->> 'employee_number_prefix') = 'EMP-', '③ البادئة تغيرت');
  PERFORM t.ok((r ->> 'employee_number_next')::int = 100, '③ العدّاد ثابت مع توقيع 143');
  -- ④ null بلا تغيير؛ 0 مرفوضة
  r := t.call(t.u('OA'), 'public.hr_settings_update(null, null, null, null, null)');
  PERFORM t.ok((r ->> 'employee_number_next')::int = 100, '④ null بلا تغيير');
  PERFORM t.ok(t.err(t.u('OA'), 'public.hr_settings_update(null, null, null, null, 0)') = '22023', '④ صفر مرفوضة');
  RAISE NOTICE 'PASS ②③④ العدّاد يُضبط ويُقرأ والتوافق محفوظ';
END $$;

-- ══ ⑤ التراجع ثم إعادة التطبيق ═════════════════════════════════════════
\i migrations/_rollback/153_hr_settings_employee_number_next.down.sql
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM t.ok(to_regprocedure('public.hr_settings_update(text,integer,integer,jsonb,integer)') is null, '⑤ التراجع أزال المعامل الخامس');
  PERFORM t.ok(to_regprocedure('public.hr_settings_update(text,integer,integer,jsonb)') is not null, '⑤ توقيع 143 عاد');
  r := t.call(t.u('OA'), 'public.hr_settings_get()');
  PERFORM t.ok((r ->> 'employee_number_next')::int = 100, '⑤ البيانات لم تُمس بالتراجع');
  RAISE NOTICE 'PASS ⑤ التراجع يعيد نسخة 143 حرفيًا';
END $$;
\i migrations/153_hr_settings_employee_number_next.sql
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM t.ok(to_regprocedure('public.hr_settings_update(text,integer,integer,jsonb,integer)') is not null, '⑤ إعادة التطبيق تعيد المعامل الخامس');
  r := t.call(t.u('OA'), 'public.hr_settings_update(null, null, null, null, 250)');
  PERFORM t.ok((r ->> 'employee_number_next')::int = 250, '⑤ إعادة التطبيق تعمل');
  RAISE NOTICE 'PASS ⑤ إعادة التطبيق';
END $$;

SELECT 'ALL hr-settings-update-153 tests passed';
