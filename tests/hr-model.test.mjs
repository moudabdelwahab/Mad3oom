/**
 * اختبارات الوحدات الخالصة لوحدة الموارد البشرية (assets/js/company/hr-model.js).
 *
 * الوحدات دي عرض وتحقق أولي فقط — قرار الصلاحية والاستحقاق والتحقق النهائي
 * بيتاخد في القاعدة (الترحيل 143)، ومُختبَر في tests/sql/hr-module-143.test.sql.
 * هنا نختبر: تقنيع الرقم القومي، ترقيم الصفحات، تحقق نموذج الموظف، تحليل CSV
 * (بما فيه الحقل المقتبس متعدد الأسطر)، التحقق الأولي من الصفوف، ملخص النتائج،
 * قالب الاستيراد، وبناء شجرة الهيكل التنظيمي.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const {
    employeeStatusInfo, maskNationalId, employeeRowForDisplay, hrPageParams, hrPaginationView,
    validateEmployeeForm, parseHrEmployeesCsv, checkHrImportLimit, validateHrImportRows,
    summarizeHrImportResults, hrImportTemplateCsv, hrImportResultsToCsv, buildOrgTree,
    checkOrgDepth, HR_SECTION_LABELS, hrCompanyStatusInfo, hrEntitlementSummary,
    leaveStatusInfo, leaveDaysBetween, validateLeaveRequestForm, validateLeaveTypeForm,
    leaveRequestRowForDisplay, leaveBalanceRowForDisplay
} = await import('../assets/js/company/hr-model.js');

/* ── التقنيع والحالات ─────────────────────────────────────────────────── */

test('maskNationalId: أول 3 + 8 نجوم + آخر 2، وقصير يُقنَّع كاملًا', () => {
    assert.equal(maskNationalId('29901011234567'), '299********67');
    assert.equal(maskNationalId('12345'), '****');
    assert.equal(maskNationalId(''), '');
    assert.equal(maskNationalId(null), '');
});

test('employeeStatusInfo: تسميات الحالات الخمس', () => {
    assert.equal(employeeStatusInfo('active').label, 'نشط');
    assert.equal(employeeStatusInfo('on_leave').label, 'في إجازة');
    assert.equal(employeeStatusInfo('suspended').label, 'موقوف');
    assert.equal(employeeStatusInfo('terminated').label, 'منتهٍ (مؤرشف)');
    assert.equal(employeeStatusInfo('pending_data').label, 'بيانات ناقصة');
    assert.equal(employeeStatusInfo('nope').label, 'غير معروفة');
});

test('employeeRowForDisplay: يقنّع الرقم القومي دائمًا', () => {
    const row = employeeRowForDisplay({
        id: 'e1', employee_number: 'EMP-0001', full_name: 'أحمد',
        phone: '0100', email: 'a@b.c', national_id: '29901011234567',
        department_name: 'الإدارة', employment_status: 'active', linked: false
    });
    assert.equal(row.nationalId, '299********67');
    assert.equal(row.statusInfo.label, 'نشط');
    assert.equal(row.fullName, 'أحمد');
});

/* ── الترقيم ─────────────────────────────────────────────────────────── */

test('hrPageParams: صفحة ≥1 وحجم 1..100', () => {
    assert.deepEqual(hrPageParams(0, 0), { page: 1, pageSize: 20 });
    assert.deepEqual(hrPageParams(3, 500), { page: 3, pageSize: 100 });
    assert.deepEqual(hrPageParams('2', '10'), { page: 2, pageSize: 10 });
});

test('hrPaginationView: عدد الصفحات والسابقة/التالية', () => {
    const v = hrPaginationView(45, 2, 20);
    assert.equal(v.totalPages, 3);
    assert.equal(v.hasPrev, true);
    assert.equal(v.hasNext, true);
    const last = hrPaginationView(45, 3, 20);
    assert.equal(last.hasNext, false);
    assert.equal(hrPaginationView(0, 1, 20).totalPages, 1);
});

/* ── تحقق نموذج الموظف ───────────────────────────────────────────────── */

test('validateEmployeeForm: يقبل الصالح ويرفض الاسم القصير والبريد الفاسد', () => {
    assert.equal(validateEmployeeForm({ fullName: 'أحمد محمد', email: 'a@b.co', phone: '01001234567' }).isValid, true);
    const bad = validateEmployeeForm({ fullName: 'أ', email: 'not-an-email', phone: '12', nationalId: '123', hireDate: '2026-13-40', contractType: 'weird' });
    assert.equal(bad.isValid, false);
    assert.ok(bad.errors.fullName);
    assert.ok(bad.errors.email);
    assert.ok(bad.errors.phone);
    assert.ok(bad.errors.nationalId);
    assert.ok(bad.errors.hireDate);
    assert.ok(bad.errors.contractType);
});

test('validateEmployeeForm: تاريخ تعيين مستقبلي مرفوض', () => {
    const future = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const r = validateEmployeeForm({ fullName: 'أحمد', hireDate: future });
    assert.ok(r.errors.hireDate);
});

/* ── تحليل CSV ───────────────────────────────────────────────────────── */

test('parseHrEmployeesCsv: ترويسة عربية + CRLF + BOM', () => {
    const csv = '\uFEFFالرقم الوظيفي,الاسم,الهاتف,البريد\r\nEMP-0001,أحمد محمد,01001234567,ahmed@example.com\r\n';
    const { rows, errors } = parseHrEmployeesCsv(csv);
    assert.equal(errors.length, 0);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].employee_number, 'EMP-0001');
    assert.equal(rows[0].full_name, 'أحمد محمد');
    assert.equal(rows[0].phone, '01001234567');
    assert.equal(rows[0].line, 2);
});

test('parseHrEmployeesCsv: حقل مقتبس فيه فاصلة وسطر جديد لا يُقسَّم', () => {
    const csv = 'employee_number,full_name,address\nEMP-0001,أحمد,"شارع النيل،\nالدور الثاني"\nEMP-0002,سارة,القاهرة\n';
    const { rows, errors } = parseHrEmployeesCsv(csv);
    assert.equal(errors.length, 0);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].address, 'شارع النيل،\nالدور الثاني');
    assert.equal(rows[0].line, 2);
    assert.equal(rows[1].line, 4);
});

test('parseHrEmployeesCsv: بلا ترويسة يفترض الترتيب الافتراضي', () => {
    const { rows } = parseHrEmployeesCsv('EMP-0001,أحمد,0100,a@b.co\n');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].employee_number, 'EMP-0001');
    assert.equal(rows[0].full_name, 'أحمد');
});

test('parseHrEmployeesCsv: اقتباس غير مغلق خطأ برقم السطر', () => {
    const { rows, errors } = parseHrEmployeesCsv('employee_number,full_name\nEMP-0001,"أحمد\n');
    assert.equal(rows.length, 0);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].line, 2);
    assert.match(errors[0].reason, /اقتباس/);
});

test('parseHrEmployeesCsv: سطور فارغة تُتجاهل', () => {
    const { rows } = parseHrEmployeesCsv('employee_number,full_name\n\nEMP-0001,أحمد\n\n');
    assert.equal(rows.length, 1);
});

/* ── حد الاستيراد والتحقق الأولي ─────────────────────────────────────── */

test('checkHrImportLimit: صفر مرفوض وفوق 100 مرفوض', () => {
    assert.equal(checkHrImportLimit(0).ok, false);
    assert.equal(checkHrImportLimit(100).ok, true);
    assert.equal(checkHrImportLimit(101).ok, false);
    assert.match(checkHrImportLimit(101).error, /100/);
});

test('validateHrImportRows: صف صالح يمرّ', () => {
    const { valid, invalid } = validateHrImportRows(
        [{ line: 2, employee_number: 'EMP-0001', full_name: 'أحمد', phone: '01001234567', email: 'a@b.co', national_id: '', department: 'الإدارة', branch: '', position: '', manager_employee_number: '', job_title: '', hire_date: '2026-01-01', contract_type: 'full_time' }],
        { departments: ['الإدارة'] }
    );
    assert.equal(valid.length, 1);
    assert.equal(invalid.length, 0);
});

test('validateHrImportRows: اسم مفقود وبريد فاسد ورقم مكرر داخل الملف', () => {
    const rows = [
        { line: 2, employee_number: 'EMP-0001', full_name: '', phone: '', email: '', national_id: '', department: '', branch: '', position: '', manager_employee_number: '', job_title: '', hire_date: '', contract_type: '' },
        { line: 3, employee_number: 'EMP-0002', full_name: 'سارة', phone: '', email: 'bad-email', national_id: '', department: '', branch: '', position: '', manager_employee_number: '', job_title: '', hire_date: '', contract_type: '' },
        { line: 4, employee_number: 'EMP-0003', full_name: 'عمر', phone: '', email: '', national_id: '', department: '', branch: '', position: '', manager_employee_number: '', job_title: '', hire_date: '', contract_type: '' },
        { line: 5, employee_number: 'EMP-0003', full_name: 'عمر 2', phone: '', email: '', national_id: '', department: '', branch: '', position: '', manager_employee_number: '', job_title: '', hire_date: '', contract_type: '' }
    ];
    const { valid, invalid } = validateHrImportRows(rows);
    assert.equal(valid.length, 1);
    assert.equal(invalid.length, 3);
    assert.equal(invalid[0].code, 'missing_name');
    assert.equal(invalid[1].code, 'invalid_email');
    assert.equal(invalid[2].code, 'duplicate_in_file');
});

test('validateHrImportRows: تكرار ضد الموظفين الحاليين وقسم/مدير غير موجودين', () => {
    const rows = [
        { line: 2, employee_number: 'EMP-0001', full_name: 'أحمد', phone: '', email: '', national_id: '', department: '', branch: '', position: '', manager_employee_number: '', job_title: '', hire_date: '', contract_type: '' },
        { line: 3, employee_number: 'EMP-0009', full_name: 'ب', phone: '', email: '', national_id: '', department: '', branch: '', position: '', manager_employee_number: '', job_title: '', hire_date: '', contract_type: '' }
    ];
    const { valid, invalid } = validateHrImportRows(rows, {
        existingNumbers: ['EMP-0001'], departments: ['الإدارة']
    });
    assert.equal(valid.length, 0);
    assert.equal(invalid.length, 2);
    assert.equal(invalid[0].code, 'duplicate_employee_number');
    assert.equal(invalid[1].code, 'missing_name');
    // قسم غير موجود ومدير غير موجود يُكشفان حين يمرّ الاسم والرقم
    const r2 = validateHrImportRows([
        { line: 2, employee_number: 'EMP-0010', full_name: 'جمال', phone: '', email: '', national_id: '', department: 'قسم وهمي', branch: '', position: '', manager_employee_number: '', job_title: '', hire_date: '', contract_type: '' },
        { line: 3, employee_number: 'EMP-0011', full_name: 'داليدا', phone: '', email: '', national_id: '', department: '', branch: '', position: '', manager_employee_number: 'EMP-9999', job_title: '', hire_date: '', contract_type: '' }
    ], { departments: ['الإدارة'] });
    assert.equal(r2.invalid[0].code, 'unknown_department');
    assert.equal(r2.invalid[1].code, 'unknown_manager');
});

test('validateHrImportRows: مدير داخل الملف نفسه مقبول', () => {
    const rows = [
        { line: 2, employee_number: 'EMP-0001', full_name: 'مدير', phone: '', email: '', national_id: '', department: '', branch: '', position: '', manager_employee_number: '', job_title: '', hire_date: '', contract_type: '' },
        { line: 3, employee_number: 'EMP-0002', full_name: 'موظف', phone: '', email: '', national_id: '', department: '', branch: '', position: '', manager_employee_number: 'EMP-0001', job_title: '', hire_date: '', contract_type: '' }
    ];
    const { valid, invalid } = validateHrImportRows(rows);
    assert.equal(valid.length, 2);
    assert.equal(invalid.length, 0);
});

test('validateHrImportRows: رقم وظيفي فارغ مقبول (ترقيم تلقائي)', () => {
    const { valid } = validateHrImportRows([
        { line: 2, employee_number: '', full_name: 'أحمد', phone: '', email: '', national_id: '', department: '', branch: '', position: '', manager_employee_number: '', job_title: '', hire_date: '', contract_type: '' }
    ]);
    assert.equal(valid.length, 1);
});

/* ── ملخص النتائج والقالب والتقرير ───────────────────────────────────── */

test('summarizeHrImportResults: يعدّ الحالات الثلاث', () => {
    const s = summarizeHrImportResults([
        { status: 'inserted' }, { status: 'inserted' }, { status: 'duplicate' }, { status: 'invalid' }
    ]);
    assert.deepEqual(s, { total: 4, inserted: 2, duplicate: 1, invalid: 1 });
    assert.deepEqual(summarizeHrImportResults(null), { total: 0, inserted: 0, duplicate: 0, invalid: 0 });
});

test('hrImportTemplateCsv: ترويسة الأعمدة الافتراضية + صف مثال', () => {
    const tpl = hrImportTemplateCsv();
    assert.ok(tpl.startsWith('\uFEFFemployee_number,full_name,phone,email,national_id'));
    const parsed = parseHrEmployeesCsv(tpl);
    assert.equal(parsed.rows.length, 1);
    assert.equal(parsed.rows[0].employee_number, 'EMP-0001');
});

test('hrImportResultsToCsv: تسميات عربية وحماية من حقن الصيغ', () => {
    const csv = hrImportResultsToCsv([
        { line: 2, employee_number: 'EMP-0001', status: 'inserted', reason: 'أُدخل بنجاح' },
        { line: 3, employee_number: '=CMD', status: 'invalid', reason: 'مرفوض' }
    ]);
    assert.match(csv, /أُدخل/);
    assert.match(csv, /"'=CMD"/);
});

/* ── شجرة الهيكل التنظيمي ────────────────────────────────────────────── */

test('buildOrgTree: يبني شجرة بأعماق صحيحة', () => {
    const { tree, errors } = buildOrgTree([
        { id: 'd1', parent_id: null, name: 'الإدارة' },
        { id: 'd2', parent_id: 'd1', name: 'الموارد البشرية' },
        { id: 'd3', parent_id: 'd2', name: 'التوظيف' },
        { id: 'd4', parent_id: null, name: 'المبيعات' }
    ]);
    assert.equal(errors.length, 0);
    assert.equal(tree.length, 2);
    assert.equal(tree[0].children[0].children[0].name, 'التوظيف');
    assert.equal(tree[0].children[0].children[0].depth, 3);
});

test('buildOrgTree: أب مفقود وحلقة يُبلَّغان ويُتركان في الجذر', () => {
    const { tree, errors } = buildOrgTree([
        { id: 'd1', parent_id: 'missing', name: 'أ' },
        { id: 'd2', parent_id: 'd3', name: 'ب' },
        { id: 'd3', parent_id: 'd2', name: 'ج' }
    ]);
    assert.equal(tree.length, 3);
    // كل عقدة في الحلقة تُبلَّغ على حدة، إضافة إلى الأب المفقود
    assert.equal(errors.length, 3);
    assert.match(errors[0].reason, /غير موجود/);
    assert.equal(errors.filter(e => /حلقة/.test(e.reason)).length, 2);
});

test('checkOrgDepth: عمق 6 مسموح وأكثر مرفوض', () => {
    assert.equal(checkOrgDepth(5).ok, true);
    assert.equal(checkOrgDepth(6).ok, false);
});

/* ── ملخصات المالك ───────────────────────────────────────────────────── */

test('HR_SECTION_LABELS: سبعة مفاتيح بتسميات عربية', () => {
    assert.equal(HR_SECTION_LABELS.hr.label, 'وحدة الموارد البشرية');
    assert.equal(HR_SECTION_LABELS.hr_payroll.label, 'الرواتب');
    assert.equal(HR_SECTION_LABELS.hr_attendance.label, 'الحضور والانصراف');
});

test('hrCompanyStatusInfo: موقوفة تتقدم على مفعّلة', () => {
    assert.equal(hrCompanyStatusInfo({ hr_enabled: true, overrides: [] }).label, 'مفعّلة');
    assert.equal(hrCompanyStatusInfo({ hr_enabled: false, overrides: [] }).label, 'بلا استحقاق');
    assert.equal(hrCompanyStatusInfo({ hr_enabled: true, overrides: [{ status: 'suspended' }] }).label, 'قسم موقوف');
});

test('hrEntitlementSummary: يعدّ الأقسام المفعّلة من الستة', () => {
    const s = hrEntitlementSummary({ hr_employees: true, hr_leave: true, hr_payroll: false });
    assert.deepEqual(s, { enabled: 2, total: 6, allEnabled: false });
    assert.equal(hrEntitlementSummary({ hr_employees: true, hr_leave: true, hr_payroll: true, hr_tasks: true, hr_attendance: true, hr_reports: true }).allEnabled, true);
});

/* ── الإجازات (الترحيل 154) ─────────────────────────────────────────── */

test('leaveStatusInfo: تسميات الحالات الثلاث', () => {
    assert.equal(leaveStatusInfo('pending').label, 'معلق');
    assert.equal(leaveStatusInfo('approved').label, 'معتمَد');
    assert.equal(leaveStatusInfo('rejected').label, 'مرفوض');
    assert.equal(leaveStatusInfo('nope').label, 'غير معروفة');
});

test('leaveDaysBetween: شامل الطرفين، ويوم واحد = 1', () => {
    assert.equal(leaveDaysBetween('2026-06-01', '2026-06-05'), 5);
    assert.equal(leaveDaysBetween('2026-06-01', '2026-06-01'), 1);
    assert.equal(leaveDaysBetween('2026-06-10', '2026-06-09'), null);
    assert.equal(leaveDaysBetween('bad', '2026-06-09'), null);
});

test('validateLeaveRequestForm: نهاية قبل البداية وسنة عابرة مرفوضتان', () => {
    const base = { employeeId: 'e1', leaveTypeId: 't1', startDate: '2026-06-01', endDate: '2026-06-05' };
    assert.equal(validateLeaveRequestForm(base).isValid, true);
    assert.equal(validateLeaveRequestForm(base).days, 5);
    assert.equal(validateLeaveRequestForm({ ...base, endDate: '2026-05-31' }).isValid, false);
    assert.equal(validateLeaveRequestForm({ ...base, endDate: '2027-01-02' }).isValid, false);
    assert.equal(validateLeaveRequestForm({ ...base, employeeId: null }).isValid, false);
    assert.equal(validateLeaveRequestForm({ ...base, leaveTypeId: '' }).isValid, false);
});

test('validateLeaveTypeForm: رمز إنجليزي صغير ورصيد 0..365', () => {
    assert.equal(validateLeaveTypeForm({ code: 'annual', nameAr: 'سنوية', defaultDays: 21 }).isValid, true);
    assert.equal(validateLeaveTypeForm({ code: 'BAD CODE', nameAr: 'سنوية', defaultDays: 21 }).isValid, false);
    assert.equal(validateLeaveTypeForm({ code: 'annual', nameAr: 'س', defaultDays: 21 }).isValid, false);
    assert.equal(validateLeaveTypeForm({ code: 'annual', nameAr: 'سنوية', defaultDays: 366 }).isValid, false);
});

test('leaveRequestRowForDisplay: حالة وحبوب وعدد الأيام', () => {
    const row = leaveRequestRowForDisplay({
        id: 'r1', employee_id: 'e1', employee_name: 'أحمد', employee_number: 'EMP-0001',
        leave_type_id: 't1', type_name: 'إجازة سنوية', start_date: '2026-06-01',
        end_date: '2026-06-05', days: 5, status: 'pending'
    });
    assert.equal(row.employeeName, 'أحمد');
    assert.equal(row.days, 5);
    assert.equal(row.statusInfo.label, 'معلق');
    assert.equal(leaveRequestRowForDisplay(null), null);
});

test('leaveBalanceRowForDisplay: المتبقي من الخادم أو محسوب', () => {
    const row = leaveBalanceRowForDisplay({
        id: 'b1', employee_id: 'e1', employee_name: 'أحمد', leave_type_id: 't1',
        type_name: 'سنوية', year: 2026, total_days: 21, used_days: 5, remaining_days: 16
    });
    assert.equal(row.remainingDays, 16);
    const fallback = leaveBalanceRowForDisplay({ total_days: 10, used_days: 12 });
    assert.equal(fallback.remainingDays, 0);
});
