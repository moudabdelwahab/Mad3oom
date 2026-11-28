-- اختبار تنفيذي لشكل قوائم الهيكل في 143 (العقد الذي تعتمد عليه hr-data.js)
-- hr_departments_list / hr_branches_list / hr_positions_list ترجع مغلفًا
-- {rows, total} لا مصفوفة عارية — الواجهة كانت تعاملها كمصفوفة فتعرض 0 دائمًا
-- (وتعطّل معاينة CSV بـ TypeError على .map).
--   ① التفعيل (منصة + وحدة + قسم الموظفين)
--   ② إنشاء قسم وفرع ومسمى، وقراءة القوائم: المغلف + الصفوف + total
--   ③ المؤرشف يُستبعد عند false ويظهر عند true
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

-- ══ ②③ إنشاء وقراءة الشكل والأرشفة ════════════════════════════════════
DO $$
DECLARE
  r jsonb; v_dept uuid;
BEGIN
  r := t.call(t.u('OA'), 'public.hr_department_create(''الادارة'', null, null, null, 0)');
  v_dept := (r ->> 'id')::uuid;
  PERFORM t.ok(v_dept is not null, '② القسم أُنشئ');
  r := t.call(t.u('OA'), 'public.hr_branch_create(''الرئيسي'', null, null, null, 0)');
  PERFORM t.ok((r ->> 'id') is not null, '② الفرع أُنشئ');
  r := t.call(t.u('OA'), 'public.hr_position_create(''مدير قسم'', null, null, null, null, 1, 0)');
  PERFORM t.ok((r ->> 'id') is not null, '② المسمى أُنشئ');
  -- الشكل: مغلف {rows, total} والصفوف تحمل الاسم
  r := t.call(t.u('OA'), 'public.hr_departments_list(false)');
  PERFORM t.ok(jsonb_typeof(r -> 'rows') = 'array', '② الأقسام: rows مصفوفة');
  PERFORM t.ok(jsonb_array_length(r -> 'rows') = 1, '② الأقسام: صف واحد');
  PERFORM t.ok((r -> 'rows' -> 0 ->> 'name') = 'الادارة', '② الأقسام: الاسم في الصف');
  PERFORM t.ok((r ->> 'total')::int = 1, '② الأقسام: total = 1');
  r := t.call(t.u('OA'), 'public.hr_branches_list(false)');
  PERFORM t.ok(jsonb_array_length(r -> 'rows') = 1 and (r -> 'rows' -> 0 ->> 'name') = 'الرئيسي' and (r ->> 'total')::int = 1, '② الفروع: مغلف وصف وtotal');
  r := t.call(t.u('OA'), 'public.hr_positions_list(false)');
  PERFORM t.ok(jsonb_array_length(r -> 'rows') = 1 and (r -> 'rows' -> 0 ->> 'name') = 'مدير قسم' and (r ->> 'total')::int = 1, '② المسميات: مغلف وصف وtotal');
  -- ③ المؤرشف يُستبعد عند false ويظهر عند true
  r := t.call(t.u('OA'), format('public.hr_department_archive(%L, %L)', v_dept, 'اختبار الأرشفة'));
  PERFORM t.ok((r ->> 'archived')::boolean = true, '③ القسم أُرشف');
  r := t.call(t.u('OA'), 'public.hr_departments_list(false)');
  PERFORM t.ok(jsonb_array_length(r -> 'rows') = 0 and (r ->> 'total')::int = 0, '③ المؤرشف مستبعد عند false');
  r := t.call(t.u('OA'), 'public.hr_departments_list(true)');
  PERFORM t.ok(jsonb_array_length(r -> 'rows') = 1 and (r ->> 'total')::int = 1, '③ المؤرشف يظهر عند true');
  RAISE NOTICE 'PASS ②③ شكل قوائم الهيكل {rows, total} والأرشفة';
END $$;

SELECT 'ALL hr-org-list-shape tests passed';
