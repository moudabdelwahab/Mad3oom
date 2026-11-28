-- اختبار تنفيذي لـ migrations/154_hr_leave.sql
-- الإجازات (المرحلة 3، القسم 1): الأنواع والأرصدة والطلبات.
--   ① التفعيل (منصة + وحدة + قسم الموظفين + قسم الإجازات)
--   ② موظفون + قسم + مدير مباشر + مدير قسم + ربط ذاتي (إعداد مباشر — الربط
--      نفسه مختبَر في 143)
--   ③ الأنواع: زرع الافتراضيات الثلاث + إنشاء مخصص + تكرار الكود + أرشفة
--   ④ الأرصدة: إنشاء كسول من الافتراضيات + ضبط يدوي + رفض ما دون المستخدم
--   ⑤ الطلبات: إنشاء مدير/ذاتي + تداخل + سنة عابرة + نهاية قبل البداية +
--      نوع مؤرشف + موظف مؤرشف + بلا صلاحية
--   ⑥ البتّ: اعتماد يخصم + إعادة اعتماد مرفوضة + رفض بلا سبب مرفوض + رفض
--      يثبّت الرصيد + اعتماد المدير المباشر + نطاق مدير القسم + رصيد لا
--      يكفي + بدون أجر بلا خصم + إشعار للمقرر له
--   ⑦ القوائم والتفاصيل: مغلف {rows, total} + فلاتر + ترقيم + نطاق الذاتية
--   ⑧ البوابة: شركة بلا hr_leave تُرفض؛ وإبطال القسم يحجب ثم إعادة التفعيل
--   ⑨ التراجع يعيد 143 حرفيًا (بلا جداول/دوال الإجازات وبلا hr.leave.request)
--      ثم إعادة التطبيق
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
SET client_min_messages = warning;

\i tests/fixtures/ecommerce/chain.sql
\i migrations/118_ecommerce_store_accounts.sql
\i migrations/119_shopify_store_integration.sql
\i migrations/143_hr_module_employees.sql
\i migrations/154_hr_leave.sql
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
  r := t.call(t.u('OW'), format('public.owner_hr_set_section(%L, ''hr_leave'', true, %L)', t.u('CA'), 'تفعيل قسم الإجازات للشركة أ'));
  PERFORM t.ctx(null);
  PERFORM t.ok((select enabled from public.platform_feature_switches where key = 'hr_module_enabled') = true, '① المفتاح العام مفعّل');
  PERFORM t.ok((select count(*) from public.company_permission_catalog where key like 'hr.%') = 17, '① الكتالوج 17 بعد hr.leave.request');
  RAISE NOTICE 'PASS ① التفعيل';
END $$;

-- ══ ② موظفون وهيكل وربط ═══════════════════════════════════════════════
DO $$
DECLARE
  r jsonb;
  v_dept_sales uuid; v_dept_fin uuid;
  v_e1 uuid; v_e2 uuid; v_e3 uuid; v_e4 uuid;
BEGIN
  r := t.call(t.u('OA'), 'public.hr_department_create(''المبيعات'', null, null, null, 0)');
  v_dept_sales := (r ->> 'id')::uuid;
  r := t.call(t.u('OA'), 'public.hr_department_create(''المالية'', null, null, null, 0)');
  v_dept_fin := (r ->> 'id')::uuid;
  PERFORM t.ok(v_dept_sales is not null and v_dept_fin is not null, '② قسمان أُنشئا');

  r := t.call(t.u('OA'), 'public.hr_employee_create(''مدير الفريق'', ''EMP-0001'')');
  v_e1 := (r ->> 'employee_id')::uuid;
  r := t.call(t.u('OA'), format('public.hr_employee_create(''موظف المبيعات'', ''EMP-0002'', null, null, null, %L, null, null, %L)', v_dept_sales, v_e1));
  v_e2 := (r ->> 'employee_id')::uuid;
  r := t.call(t.u('OA'), 'public.hr_employee_create(''موظف ثالث'', ''EMP-0003'')');
  v_e3 := (r ->> 'employee_id')::uuid;
  r := t.call(t.u('OA'), format('public.hr_employee_create(''موظف المالية'', ''EMP-0004'', null, null, null, %L)', v_dept_fin));
  v_e4 := (r ->> 'employee_id')::uuid;
  PERFORM t.ok(v_e1 is not null and v_e2 is not null and v_e3 is not null and v_e4 is not null, '② أربعة موظفين أُنشئوا');
  -- ربط مباشر (إعداد اختبار — إجراء الربط نفسه مختبَر في 143):
  -- e1 ← A1 (مدير مباشر لـ e2)، e2 ← AG (يطلب عن نفسه).
  update public.hr_employees set user_id = t.u('A1') where id = v_e1;
  update public.hr_employees set user_id = t.u('AG') where id = v_e2;
  -- AS مدير قسم المبيعات.
  insert into public.hr_role_assignments (company_id, user_id, role, department_id, granted_by)
  values (t.u('CA'), t.u('AS'), 'dept_manager', v_dept_sales, t.u('OA'));
  insert into t.saved values ('e1', v_e1::text), ('e2', v_e2::text), ('e3', v_e3::text), ('e4', v_e4::text),
    ('dept_sales', v_dept_sales::text), ('dept_fin', v_dept_fin::text);
  RAISE NOTICE 'PASS ② موظفون وهيكل وربط';
END $$;

-- ══ ③ الأنواع: الزرع والتحقق ═══════════════════════════════════════════
DO $$
DECLARE
  r jsonb; v_study uuid; v_annual uuid; v_sick uuid; v_unpaid uuid;
BEGIN
  r := t.call(t.u('OA'), 'public.hr_leave_types_list(false)');
  PERFORM t.ok(jsonb_typeof(r -> 'rows') = 'array', '③ الأنواع: rows مصفوفة');
  PERFORM t.ok((r ->> 'total')::int = 3, '③ الأنواع: ثلاثة افتراضية');
  PERFORM t.ok((r -> 'rows' -> 0 ->> 'code') = 'annual' and (r -> 'rows' -> 0 ->> 'default_days')::int = 21
    and (r -> 'rows' -> 0 ->> 'deducts_balance')::boolean = true, '③ سنوية 21 تخصم');
  PERFORM t.ok((r -> 'rows' -> 1 ->> 'code') = 'sick' and (r -> 'rows' -> 1 ->> 'default_days')::int = 15, '③ مرضية 15');
  PERFORM t.ok((r -> 'rows' -> 2 ->> 'code') = 'unpaid' and (r -> 'rows' -> 2 ->> 'default_days')::int = 0
    and (r -> 'rows' -> 2 ->> 'deducts_balance')::boolean = false, '③ بدون أجر بلا رصيد');
  v_annual := (r -> 'rows' -> 0 ->> 'id')::uuid;
  v_sick := (r -> 'rows' -> 1 ->> 'id')::uuid;
  v_unpaid := (r -> 'rows' -> 2 ->> 'id')::uuid;
  -- قراءة ثانية لا تزرع مكررًا.
  r := t.call(t.u('OA'), 'public.hr_leave_types_list(false)');
  PERFORM t.ok((r ->> 'total')::int = 3, '③ الزرع idempotent');
  -- نوع مخصص + تكرار الكود.
  r := t.call(t.u('OA'), 'public.hr_leave_type_create(''study'', ''إجازة دراسية'', 10, true, 4)');
  v_study := (r ->> 'id')::uuid;
  PERFORM t.ok(v_study is not null, '③ نوع مخصص أُنشئ');
  PERFORM t.ok(t.err(t.u('OA'), 'public.hr_leave_type_create(''annual'', ''مكرر'', 5, true, 9)') = '23505', '③ تكرار الكود 23505');
  PERFORM t.ok(t.err(t.u('OA'), 'public.hr_leave_type_create(''BAD CODE'', ''سيئ'', 5, true, 9)') = '22023', '③ رمز غير صالح 22023');
  PERFORM t.ok(t.err(t.u('AG'), 'public.hr_leave_type_create(''x1'', ''ممنوع'', 5, true, 9)') = '42501', '③ موظف بلا manage لا ينشئ نوعًا');
  -- أرشفة المخصص: تُستبعد عند false وتظهر عند true.
  r := t.call(t.u('OA'), format('public.hr_leave_type_archive(%L, %L)', v_study, 'إيقاف الإجازة الدراسية مؤقتًا'));
  PERFORM t.ok((r ->> 'archived')::boolean = true, '③ النوع أُرشف');
  r := t.call(t.u('OA'), 'public.hr_leave_types_list(false)');
  PERFORM t.ok((r ->> 'total')::int = 3, '③ المؤرشف مستبعد عند false');
  r := t.call(t.u('OA'), 'public.hr_leave_types_list(true)');
  PERFORM t.ok((r ->> 'total')::int = 4, '③ المؤرشف يظهر عند true');
  insert into t.saved values ('annual', v_annual::text), ('sick', v_sick::text),
    ('unpaid', v_unpaid::text), ('study', v_study::text);
  RAISE NOTICE 'PASS ③ الأنواع';
END $$;

-- ══ ④ الأرصدة ══════════════════════════════════════════════════════════
DO $$
DECLARE
  r jsonb; v_e2 uuid; v_annual uuid;
BEGIN
  select v into v_e2 from t.saved where k = 'e2';
  select v into v_annual from t.saved where k = 'annual';
  r := t.call(t.u('OA'), format('public.hr_leave_balances_list(%L, 2026)', v_e2));
  PERFORM t.ok(jsonb_typeof(r -> 'rows') = 'array', '④ الأرصدة: rows مصفوفة');
  PERFORM t.ok((r ->> 'total')::int = 2, '④ رصيدان فقط (بلا رصيد لبدون أجر)');
  PERFORM t.ok((r -> 'rows' -> 0 ->> 'total_days')::int = 21 and (r -> 'rows' -> 0 ->> 'remaining_days')::int = 21, '④ سنوي 21/21');
  PERFORM t.ok((r -> 'rows' -> 1 ->> 'total_days')::int = 15 and (r -> 'rows' -> 1 ->> 'used_days')::int = 0, '④ مرضي 15/0');
  -- ضبط يدوي إلى 25.
  r := t.call(t.u('OA'), format('public.hr_leave_balance_set(%L, %L, 2026, 25)', v_e2, v_annual));
  PERFORM t.ok((r ->> 'total_days')::int = 25 and (r ->> 'remaining_days')::int = 25, '④ الضبط إلى 25');
  r := t.call(t.u('OA'), format('public.hr_leave_balances_list(%L, 2026)', v_e2));
  PERFORM t.ok((r -> 'rows' -> 0 ->> 'total_days')::int = 25, '④ القراءة تعيد 25');
  -- بلا موظف: ملف المتصل نفسه (AG مرتبط بـ e2).
  r := t.call(t.u('AG'), 'public.hr_leave_balances_list(null, 2026)');
  PERFORM t.ok((r ->> 'total')::int = 2, '④ الذاتية: رصيدا ملفي بلا موظف صريح');
  PERFORM t.ok(t.err(t.u('AG'), format('public.hr_leave_balance_set(%L, %L, 2026, 30)', v_e2, v_annual)) = '42501', '④ موظف بلا manage لا يضبط رصيدًا');
  RAISE NOTICE 'PASS ④ الأرصدة';
END $$;

-- ══ ⑤ إنشاء الطلبات والتحقق ═══════════════════════════════════════════
DO $$
DECLARE
  r jsonb; v_e1 uuid; v_e2 uuid; v_e3 uuid; v_e4 uuid;
  v_annual uuid; v_sick uuid; v_unpaid uuid; v_study uuid;
  v_r1 uuid; v_r2 uuid; v_sick_req uuid; v_unpaid_req uuid; v_e4_req uuid; v_big_req uuid;
BEGIN
  select v into v_e1 from t.saved where k = 'e1';
  select v into v_e2 from t.saved where k = 'e2';
  select v into v_e3 from t.saved where k = 'e3';
  select v into v_e4 from t.saved where k = 'e4';
  select v into v_annual from t.saved where k = 'annual';
  select v into v_sick from t.saved where k = 'sick';
  select v into v_unpaid from t.saved where k = 'unpaid';
  select v into v_study from t.saved where k = 'study';
  -- مدير يطلب عن موظف: 5 أيام تقويمية شاملة.
  r := t.call(t.u('OA'), format('public.hr_leave_request_create(%L, %L, ''2026-06-01'', ''2026-06-05'')', v_e2, v_annual));
  v_r1 := (r ->> 'request_id')::uuid;
  PERFORM t.ok((r ->> 'days')::int = 5 and (r ->> 'status') = 'pending', '⑤ طلب سنوي 5 أيام معلق');
  -- تداخل مع معلق/معتمَد مرفوض؛ والمجاور مسموح.
  PERFORM t.ok(t.err(t.u('OA'), format('public.hr_leave_request_create(%L, %L, ''2026-06-05'', ''2026-06-07'')', v_e2, v_annual)) = '22023', '⑤ تداخل يوم واحد مرفوض');
  r := t.call(t.u('OA'), format('public.hr_leave_request_create(%L, %L, ''2026-06-06'', ''2026-06-07'')', v_e2, v_annual));
  v_r2 := (r ->> 'request_id')::uuid;
  PERFORM t.ok((r ->> 'days')::int = 2, '⑤ مجاور يومين مقبول');
  -- نهاية قبل البداية + سنة عابرة + نوع مؤرشف.
  PERFORM t.ok(t.err(t.u('OA'), format('public.hr_leave_request_create(%L, %L, ''2026-06-10'', ''2026-06-09'')', v_e2, v_annual)) = '22023', '⑤ نهاية قبل البداية مرفوضة');
  PERFORM t.ok(t.err(t.u('OA'), format('public.hr_leave_request_create(%L, %L, ''2026-12-30'', ''2027-01-02'')', v_e2, v_annual)) = '22023', '⑤ عابر للسنة مرفوض');
  PERFORM t.ok(t.err(t.u('OA'), format('public.hr_leave_request_create(%L, %L, ''2026-06-10'', ''2026-06-11'')', v_e2, v_study)) = '22023', '⑤ نوع مؤرشف مرفوض');
  -- ذاتي: AG عن نفسه (مرضية 3 أيام)؛ وعن غيره مرفوض؛ وبلا ربط مرفوض.
  r := t.call(t.u('AG'), format('public.hr_leave_request_create(%L, %L, ''2026-07-01'', ''2026-07-03'')', v_e2, v_sick));
  v_sick_req := (r ->> 'request_id')::uuid;
  PERFORM t.ok((r ->> 'days')::int = 3, '⑤ ذاتي مرضية 3 أيام');
  PERFORM t.ok(t.err(t.u('AG'), format('public.hr_leave_request_create(%L, %L, ''2026-07-01'', ''2026-07-02'')', v_e1, v_sick)) = '42501', '⑤ ذاتي عن غيره مرفوض');
  PERFORM t.ok(t.err(t.u('A1'), format('public.hr_leave_request_create(%L, %L, ''2026-07-01'', ''2026-07-02'')', v_e2, v_sick)) = '42501', '⑤ عميل بلا ربط وبلا manage مرفوض');
  -- موظف مؤرشف: لا طلبات جديدة.
  r := t.call(t.u('OA'), format('public.hr_employee_archive(%L, %L)', v_e3, 'إنهاء خدمة الموظف للاختبار'));
  PERFORM t.ok(t.err(t.u('OA'), format('public.hr_leave_request_create(%L, %L, ''2026-06-10'', ''2026-06-11'')', v_e3, v_annual)) = '22023', '⑤ مؤرشف لا تُقبل طلباته');
  -- بدون أجر 30 يومًا + طلب لموظف المالية (اختبار نطاق مدير القسم).
  r := t.call(t.u('OA'), format('public.hr_leave_request_create(%L, %L, ''2026-08-01'', ''2026-08-30'')', v_e2, v_unpaid));
  v_unpaid_req := (r ->> 'request_id')::uuid;
  PERFORM t.ok((r ->> 'days')::int = 30, '⑤ بدون أجر 30 يومًا');
  r := t.call(t.u('OA'), format('public.hr_leave_request_create(%L, %L, ''2026-09-01'', ''2026-09-02'')', v_e4, v_annual));
  v_e4_req := (r ->> 'request_id')::uuid;
  -- طلب كبير 25 يومًا (رصيد سنوي متبقٍ 20 بعد الاعتماد — يُرفض اعتماده في ⑥).
  r := t.call(t.u('OA'), format('public.hr_leave_request_create(%L, %L, ''2026-10-01'', ''2026-10-25'')', v_e2, v_annual));
  v_big_req := (r ->> 'request_id')::uuid;
  PERFORM t.ok((r ->> 'days')::int = 25, '⑤ طلب 25 يومًا أُنشئ معلقًا (بلا فحص رصيد عند الطلب)');
  insert into t.saved values ('r1', v_r1::text), ('r2', v_r2::text), ('sick_req', v_sick_req::text),
    ('unpaid_req', v_unpaid_req::text), ('e4_req', v_e4_req::text), ('big_req', v_big_req::text);
  RAISE NOTICE 'PASS ⑤ إنشاء الطلبات';
END $$;

-- ══ ⑥ البتّ: خصم ورفض ونطاق ════════════════════════════════════════════
DO $$
DECLARE
  r jsonb; v_e2 uuid; v_e4 uuid; v_annual uuid; v_sick uuid;
  v_r1 uuid; v_r2 uuid; v_sick_req uuid; v_unpaid_req uuid; v_e4_req uuid; v_big_req uuid;
BEGIN
  select v into v_e2 from t.saved where k = 'e2';
  select v into v_e4 from t.saved where k = 'e4';
  select v into v_annual from t.saved where k = 'annual';
  select v into v_sick from t.saved where k = 'sick';
  select v into v_r1 from t.saved where k = 'r1';
  select v into v_r2 from t.saved where k = 'r2';
  select v into v_sick_req from t.saved where k = 'sick_req';
  select v into v_unpaid_req from t.saved where k = 'unpaid_req';
  select v into v_e4_req from t.saved where k = 'e4_req';
  select v into v_big_req from t.saved where k = 'big_req';
  -- اعتماد r1 (5 أيام سنوية): يخصم من الرصيد 25 → متبقٍ 20.
  r := t.call(t.u('OA'), format('public.hr_leave_request_decide(%L, true)', v_r1));
  PERFORM t.ok((r ->> 'status') = 'approved', '⑥ اعتماد r1');
  r := t.call(t.u('OA'), format('public.hr_leave_balances_list(%L, 2026)', v_e2));
  PERFORM t.ok((r -> 'rows' -> 0 ->> 'used_days')::int = 5 and (r -> 'rows' -> 0 ->> 'remaining_days')::int = 20, '⑥ خصم 5 وبقي 20');
  -- إعادة الاعتماد مرفوضة (لا خصم مزدوج).
  PERFORM t.ok(t.err(t.u('OA'), format('public.hr_leave_request_decide(%L, true)', v_r1)) = '22023', '⑥ إعادة الاعتماد مرفوضة');
  r := t.call(t.u('OA'), format('public.hr_leave_balances_list(%L, 2026)', v_e2));
  PERFORM t.ok((r -> 'rows' -> 0 ->> 'used_days')::int = 5, '⑥ بلا خصم مزدوج');
  -- الرفض بلا سبب مرفوض؛ وبرر سبب يثبّت الرصيد.
  PERFORM t.ok(t.err(t.u('OA'), format('public.hr_leave_request_decide(%L, false)', v_r2)) = '22023', '⑥ رفض بلا سبب مرفوض');
  r := t.call(t.u('OA'), format('public.hr_leave_request_decide(%L, false, %L)', v_r2, 'تعارض مع خطة العمل في هذا الأسبوع'));
  PERFORM t.ok((r ->> 'status') = 'rejected', '⑥ رفض r2 بسبب');
  r := t.call(t.u('OA'), format('public.hr_leave_balances_list(%L, 2026)', v_e2));
  PERFORM t.ok((r -> 'rows' -> 0 ->> 'used_days')::int = 5, '⑥ الرفض لا يغيّر الرصيد');
  -- المدير المباشر (A1 مرتبط بـ e1 مدير e2) يعتمد المرضية — والرصيد يخصم 3.
  r := t.call(t.u('A1'), format('public.hr_leave_request_decide(%L, true)', v_sick_req));
  PERFORM t.ok((r ->> 'status') = 'approved', '⑥ المدير المباشر يعتمد');
  r := t.call(t.u('OA'), format('public.hr_leave_balances_list(%L, 2026)', v_e2));
  PERFORM t.ok((r -> 'rows' -> 1 ->> 'used_days')::int = 3 and (r -> 'rows' -> 1 ->> 'remaining_days')::int = 12, '⑥ مرضي مستخدم 3 وبقي 12');
  -- إشعار وصل للموظف المرتبط (AG) بالقرار.
  PERFORM t.ok((select count(*) from public.notifications where user_id = t.u('AG') and category = 'hr') >= 1, '⑥ إشعار القرار وصل للموظف');
  -- مدير القسم: AS يبتّ في طلب قسمه (بدون أجر — بلا خصم) ويرفض خارجه.
  r := t.call(t.u('AS'), format('public.hr_leave_request_decide(%L, true)', v_unpaid_req));
  PERFORM t.ok((r ->> 'status') = 'approved', '⑥ مدير القسم يعتمد طلب قسمه');
  PERFORM t.ok(t.err(t.u('AS'), format('public.hr_leave_request_decide(%L, true)', v_e4_req)) = '42501', '⑥ مدير القسم لا يبتّ خارج قسمه');
  -- رصيد لا يكفي: طلب 25 يومًا والمتبقي 20 — يبقى معلقًا والرصيد ثابت.
  PERFORM t.ok(t.err(t.u('OA'), format('public.hr_leave_request_decide(%L, true)', v_big_req)) = '22023', '⑥ رصيد لا يكفي مرفوض');
  r := t.call(t.u('OA'), format('public.hr_leave_request_detail(%L)', v_big_req));
  PERFORM t.ok((r ->> 'status') = 'pending', '⑥ الطلب الكبير ما زال معلقًا');
  -- ضبط رصيد دون المستخدم مرفوض (مستخدم 5، الجديد 3).
  PERFORM t.ok(t.err(t.u('OA'), format('public.hr_leave_balance_set(%L, %L, 2026, 3)', v_e2, v_annual)) = '22023', '⑥ ضبط دون المستخدم مرفوض');
  -- بلا رصيد لبدون أجر: القائمة ما زالت صفين فقط.
  r := t.call(t.u('OA'), format('public.hr_leave_balances_list(%L, 2026)', v_e2));
  PERFORM t.ok((r ->> 'total')::int = 2, '⑥ بدون أجر بلا رصيد بعد الاعتماد');
  -- سجل التدقيق يحوي أحداث الإجازات.
  PERFORM t.ok((select count(*) from public.hr_audit_logs where company_id = t.u('CA') and action like 'leave.%') >= 8, '⑥ أحداث الإجازات في التدقيق');
  RAISE NOTICE 'PASS ⑥ البتّ';
END $$;

-- ══ ⑦ القوائم والتفاصيل ════════════════════════════════════════════════
DO $$
DECLARE
  r jsonb; v_e2 uuid; v_e4 uuid; v_r1 uuid; v_big_req uuid; v_e4_req uuid;
BEGIN
  select v into v_e2 from t.saved where k = 'e2';
  select v into v_e4 from t.saved where k = 'e4';
  select v into v_r1 from t.saved where k = 'r1';
  select v into v_big_req from t.saved where k = 'big_req';
  select v into v_e4_req from t.saved where k = 'e4_req';
  r := t.call(t.u('OA'), 'public.hr_leave_requests_list(1, 20)');
  PERFORM t.ok(jsonb_typeof(r -> 'rows') = 'array', '⑦ القائمة: rows مصفوفة');
  PERFORM t.ok((r ->> 'total')::int = 6 and (r ->> 'page')::int = 1, '⑦ ستة طلبات إجمالًا');
  r := t.call(t.u('OA'), 'public.hr_leave_requests_list(1, 20, null, ''pending'')');
  PERFORM t.ok((r ->> 'total')::int = 2, '⑦ معلقان (المالية + الكبير)');
  r := t.call(t.u('OA'), 'public.hr_leave_requests_list(1, 20, null, ''approved'')');
  PERFORM t.ok((r ->> 'total')::int = 3, '⑦ ثلاثة معتمَدة');
  r := t.call(t.u('OA'), 'public.hr_leave_requests_list(1, 20, null, ''rejected'')');
  PERFORM t.ok((r ->> 'total')::int = 1, '⑦ واحد مرفوض');
  r := t.call(t.u('OA'), 'public.hr_leave_requests_list(1, 2)');
  PERFORM t.ok(jsonb_array_length(r -> 'rows') = 2 and (r ->> 'total')::int = 6, '⑦ ترقيم: صفحتان من 2 وtotal كامل');
  r := t.call(t.u('OA'), format('public.hr_leave_requests_list(1, 20, %L)', v_e4));
  PERFORM t.ok((r ->> 'total')::int = 1, '⑦ فلتر الموظف: طلب المالية وحده');
  -- الذاتية: AG يرى طلباته الخمسة فقط (لا طلب المالية).
  r := t.call(t.u('AG'), 'public.hr_leave_requests_list(1, 20)');
  PERFORM t.ok((r ->> 'total')::int = 5, '⑦ AG يرى طلباته الخمسة فقط');
  PERFORM t.ok(not exists (select 1 from jsonb_array_elements(r -> 'rows') x where (x ->> 'employee_id') <> v_e2::text), '⑦ لا طلب لغيره في قائمة AG');
  -- التفاصيل: رصيد اللقطة + can_decide.
  r := t.call(t.u('OA'), format('public.hr_leave_request_detail(%L)', v_r1));
  PERFORM t.ok((r ->> 'status') = 'approved' and (r -> 'balance' ->> 'remaining_days')::int = 20, '⑦ تفاصيل r1: معتمَد وبقي 20');
  PERFORM t.ok((r ->> 'can_decide')::boolean = true, '⑦ OA يستطيع البتّ');
  r := t.call(t.u('AG'), format('public.hr_leave_request_detail(%L)', v_r1));
  PERFORM t.ok((r ->> 'can_decide')::boolean = false, '⑦ AG لا يستطيع البتّ في طلبه');
  PERFORM t.ok(t.err(t.u('A1'), format('public.hr_leave_request_detail(%L)', v_e4_req)) = 'P0002', '⑦ مدير المبيعات لا يرى تفاصيل طلب المالية');
  RAISE NOTICE 'PASS ⑦ القوائم والتفاصيل';
END $$;

-- ══ ⑧ البوابة: بلا قسم تُرفض ═══════════════════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  -- شركة ب بلا HR أصلًا.
  PERFORM t.ok(t.err(t.u('OB'), 'public.hr_leave_types_list(false)') = '42501', '⑧ شركة بلا hr_leave تُرفض');
  -- إبطال قسم الإجازات للشركة أ يحجب؛ وإعادة التفعيل تعيده.
  PERFORM t.ctx('owner');
  PERFORM t.stepup(t.u('OW'));
  r := t.call(t.u('OW'), format('public.owner_hr_set_section(%L, ''hr_leave'', false, %L)', t.u('CA'), 'إبطال قسم الإجازات مؤقتًا للاختبار'));
  PERFORM t.ctx(null);
  PERFORM t.ok(t.err(t.u('OA'), 'public.hr_leave_types_list(false)') = '42501', '⑧ بعد الإبطال تُرفض القراءة');
  PERFORM t.ctx('owner');
  PERFORM t.stepup(t.u('OW'));
  r := t.call(t.u('OW'), format('public.owner_hr_set_section(%L, ''hr_leave'', true, %L)', t.u('CA'), 'إعادة تفعيل قسم الإجازات للشركة أ'));
  PERFORM t.ctx(null);
  r := t.call(t.u('OA'), 'public.hr_leave_types_list(false)');
  PERFORM t.ok((r ->> 'total')::int = 3, '⑧ بعد إعادة التفعيل تعود الأنواع');
  RAISE NOTICE 'PASS ⑧ البوابة';
END $$;

-- ══ ⑨ التراجع ثم إعادة التطبيق ═════════════════════════════════════════
\i migrations/_rollback/154_hr_leave.down.sql
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM t.ok(to_regclass('public.hr_leave_types') is null, '⑨ التراجع أزال جدول الأنواع');
  PERFORM t.ok(to_regclass('public.hr_leave_balances') is null, '⑨ التراجع أزال جدول الأرصدة');
  PERFORM t.ok(to_regclass('public.hr_leave_requests') is null, '⑨ التراجع أزال جدول الطلبات');
  PERFORM t.ok(to_regprocedure('public.hr_leave_types_list(boolean)') is null, '⑨ التراجع أزال RPC الأنواع');
  PERFORM t.ok(to_regprocedure('public.hr_leave_request_decide(uuid,boolean,text)') is null, '⑨ التراجع أزال RPC البتّ');
  PERFORM t.ok((select count(*) from public.company_permission_catalog where key like 'hr.%') = 16, '⑨ الكتالوج عاد إلى 16');
  RAISE NOTICE 'PASS ⑨ التراجع يعيد 143 حرفيًا';
END $$;
\i migrations/154_hr_leave.sql
DO $$
DECLARE r jsonb; v_e2 uuid; v_annual uuid;
BEGIN
  PERFORM t.ok(to_regprocedure('public.hr_leave_types_list(boolean)') is not null, '⑨ إعادة التطبيق تعيد RPC الأنواع');
  PERFORM t.ok((select count(*) from public.company_permission_catalog where key like 'hr.%') = 17, '⑨ الكتالوج عاد إلى 17');
  r := t.call(t.u('OA'), 'public.hr_leave_types_list(false)');
  PERFORM t.ok((r ->> 'total')::int = 3, '⑨ إعادة التطبيق تزرع الافتراضيات من جديد');
  select v into v_e2 from t.saved where k = 'e2';
  select v into v_annual from t.saved where k = 'annual';
  -- ملاحظة: معرّفات الأنواع أُعيد زرعها جديدة — تُقرأ من القائمة لا من t.saved.
  v_annual := (r -> 'rows' -> 0 ->> 'id')::uuid;
  r := t.call(t.u('OA'), format('public.hr_leave_request_create(%L, %L, ''2026-11-02'', ''2026-11-03'')', v_e2, v_annual));
  PERFORM t.ok((r ->> 'days')::int = 2 and (r ->> 'status') = 'pending', '⑨ إعادة التطبيق تعمل: طلب جديد');
  RAISE NOTICE 'PASS ⑨ إعادة التطبيق';
END $$;

SELECT 'ALL hr-leave-154 tests passed';
