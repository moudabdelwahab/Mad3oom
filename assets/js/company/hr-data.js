/**
 * hr-data.js — طبقة استدعاءات RPC لوحدة الموارد البشرية (الترحيل 143).
 *
 *   RPCs المستخدمة (الترحيل 143_hr_module_employees.sql):
 *   - hr_employees_list(p_page, p_page_size, p_search, p_status, p_department_id, p_branch_id, p_include_archived)
 *     قراءة؛ بوابة hr: مفتاح المنصة hr_module_enabled + استحقاق الشركة 'hr'
 *     أو 'hr_employees' + غير موقوفة، وإذن hr.employees.view أو نطاق قسم.
 *   - hr_employees_count() قراءة؛ نفس البوابة.
 *   - hr_employee_create(...) / hr_employee_update(...) / hr_employee_archive(uuid, text)
 *     / hr_employee_reactivate(uuid, text) / hr_employee_set_status(uuid, text, text)
 *     كتابة؛ إذن hr.employees.manage (الأرشفة: مشرف الشركة أو hr_manager).
 *   - hr_employee_detail(uuid) قراءة؛ الرقم القومي الكامل للمسؤول فقط.
 *   - hr_departments_list(boolean) / hr_department_create(text, uuid, text, uuid, integer)
 *     / hr_department_update(uuid, text, uuid, text, uuid, boolean, integer)
 *     / hr_department_archive(uuid, text) — ومثيلاتها للفروع والمواضع
 *     (hr_branches و hr_positions بنفس النمط)؛ إذن hr.departments.manage.
 *   - hr_settings_get() / hr_settings_update(text, integer, integer, jsonb)؛
 *     إذن hr.settings.manage للكتابة.
 *   - hr_import_employees(jsonb, uuid, text) كتابة؛ إذن hr.import؛ حد 100
 *     صف، ومفتاح عدم تكرار؛ لا يمسّ أي جدول حسابات.
 *   - hr_import_runs_list(integer, integer) / hr_import_run_detail(uuid) قراءة.
 *   - hr_link_employee_account(uuid, uuid, text) / hr_link_employee_unlink(uuid, text)
 *     / hr_unlink_employee_account(uuid, text) كتابة؛ إذن hr.link_account.
 *   - hr_my_employee() قراءة لصف الموظف المرتبط بنفس المستخدم.
 *
 *   كل دالة RPC في 143 SECURITY DEFINER، والشركة تُشتق من الجلسة داخل
 *   قاعدة البيانات — لا يوجد معرّف شركة في أي مُعامل هنا.
 *   كل دالة ترجّع { ok, data, error } بدل رمي استثناء (اصطلاح company-data.js).
 *   الخطأ P0002 من القاعدة يحمل رسالة عربية جاهزة للعرض.
 */

/**
 * hr-data.js — RPC layer for the HR module (migration 143).
 *
 * RPCs used (143_hr_module_employees.sql): hr_employees_list/count,
 * hr_employee_create/update/archive/reactivate/set_status/detail,
 * hr_departments/branches/positions list/create/update/archive,
 * hr_settings_get/update, hr_import_employees, hr_import_runs_list/detail,
 * hr_link_employee_account/unlink, hr_unlink_employee_account, hr_my_employee.
 * RPCs used (154_hr_leave.sql): hr_leave_types_list, hr_leave_type_create/
 * update/archive, hr_leave_balances_list, hr_leave_balance_set,
 * hr_leave_request_create/decide, hr_leave_requests_list, hr_leave_request_detail.
 * RPCs used (156_hr_tickets_link.sql): hr_employee_ticket_stats,
 * hr_employee_tickets_list, hr_employees_ticket_summary,
 * hr_department_ticket_stats — read-only ticket stats via
 * hr_employees.user_id ←→ tickets.assigned_to (scope='company' only).
 * RPCs used (157_hr_reports.sql): hr_reports_headcount, hr_reports_attendance,
 * hr_reports_leave, hr_reports_tickets — read-only aggregations of 154/155/156
 * (each takes a date range, default current month; each returns {rows, total}
 * plus a company-wide totals object, and an available=false block when its
 * source section is not entitled for read).
 * RPCs used (158_hr_employee_account_unique.sql): no new RPC — partial UNIQUE
 * index (company_id, user_id) on hr_employees + idempotent re-link in
 * hr_link_employee_account; hr-data maps a raw unique-violation to the
 * Arabic duplicate message.
 * RPCs used (159_hr_link_registers_company_staff.sql): no new RPC — the link
 * RPC now also registers the account in company_staff (role 'agent') so it
 * shows as staff in the accounts tree and becomes eligible for ticket
 * assignment, and returns staff_registered/staff_as; hr_employee_detail now
 * returns linked_user_id/linked_account_name. Candidates for the link picker
 * reuse company_members() (096/152) via fetchHrLinkCandidates below.
 * All are SECURITY DEFINER; the company is derived from the session inside
 * the database — no company_id parameter anywhere here.
 * Every function returns { ok, data, error } (company-data.js convention).
 */

import { supabase } from '/api-config.js';

async function safe(label, fn) {
    try {
        const data = await fn();
        return { ok: true, data, error: null };
    } catch (err) {
        console.error(`[HrData] ${label}:`, err?.message || err);
        return { ok: false, data: null, error: err?.message || 'تعذّر تنفيذ الطلب' };
    }
}

async function callRpc(label, fnName, args) {
    return safe(label, async () => {
        const { data, error } = await supabase.rpc(fnName, args);
        if (error) throw error;
        return data;
    });
}

/* ── الموظفون ─────────────────────────────────────────────────────────── */

/** قائمة موظفين مُرقَّمة من الخادم مع بحث وتصفية (صفحة ≤100، الافتراضي 20). */
export async function fetchHrEmployees({ page = 1, pageSize = 20, search = '', status = null, departmentId = null, branchId = null, includeTerminated = false } = {}) {
    return callRpc('hrEmployeesList', 'hr_employees_list', {
        p_page: page, p_page_size: pageSize,
        p_search: search || null, p_status: status || null,
        p_department_id: departmentId || null, p_branch_id: branchId || null,
        p_include_archived: includeTerminated === true
    });
}

export async function fetchHrEmployeesCount() {
    return callRpc('hrEmployeesCount', 'hr_employees_count', {});
}

export async function fetchHrEmployeeDetail(employeeId) {
    return callRpc('hrEmployeeDetail', 'hr_employee_detail', { p_employee_id: employeeId });
}

export async function createHrEmployee(fields) {
    return callRpc('hrEmployeeCreate', 'hr_employee_create', {
        p_full_name: fields.fullName, p_employee_number: fields.employeeNumber || null,
        p_phone: fields.phone || null, p_email: fields.email || null,
        p_national_id: fields.nationalId || null,
        p_department_id: fields.departmentId || null, p_branch_id: fields.branchId || null,
        p_position_id: fields.positionId || null, p_manager_employee_id: fields.managerEmployeeId || null,
        p_job_title: fields.jobTitle || null, p_hire_date: fields.hireDate || null,
        p_contract_type: fields.contractType || null, p_date_of_birth: fields.dateOfBirth || null,
        p_address: fields.address || null, p_emergency_contact: fields.emergencyContact || null
    });
}

export async function updateHrEmployee(employeeId, fields) {
    return callRpc('hrEmployeeUpdate', 'hr_employee_update', {
        p_employee_id: employeeId,
        p_full_name: fields.fullName, p_phone: fields.phone, p_email: fields.email,
        p_national_id: fields.nationalId,
        p_department_id: fields.departmentId, p_branch_id: fields.branchId,
        p_position_id: fields.positionId, p_manager_employee_id: fields.managerEmployeeId,
        p_job_title: fields.jobTitle, p_hire_date: fields.hireDate,
        p_contract_type: fields.contractType, p_date_of_birth: fields.dateOfBirth,
        p_address: fields.address, p_emergency_contact: fields.emergencyContact
    });
}

export async function archiveHrEmployee(employeeId, reason) {
    return callRpc('hrEmployeeArchive', 'hr_employee_archive', { p_employee_id: employeeId, p_reason: reason });
}

export async function reactivateHrEmployee(employeeId, reason) {
    return callRpc('hrEmployeeReactivate', 'hr_employee_reactivate', { p_employee_id: employeeId, p_reason: reason });
}

export async function setHrEmployeeStatus(employeeId, status, reason) {
    return callRpc('hrEmployeeSetStatus', 'hr_employee_set_status', {
        p_employee_id: employeeId, p_status: status, p_reason: reason
    });
}

export async function fetchMyHrEmployee() {
    return callRpc('hrMyEmployee', 'hr_my_employee', {});
}

/* ── الهيكل التنظيمي ──────────────────────────────────────────────────── */

/* قوائم الهيكل في 143 ترجع مغلفًا {rows, total} لا مصفوفة عارية — تُفكّ
   هنا إلى مصفوفة؛ وإلا رأى كل مستهلك فراغًا صامتًا (Array.isArray على
   كائن يرفضه فيعرض 0). تقبل المصفوفة العارية أيضًا. */
function unwrapOrgRows(result) {
    if (!result?.ok) return result;
    const d = result.data;
    if (Array.isArray(d)) return result;
    if (d && Array.isArray(d.rows)) return { ...result, data: d.rows };
    return { ...result, data: [] };
}

export async function fetchHrDepartments(includeArchived = false) {
    return unwrapOrgRows(await callRpc('hrDepartmentsList', 'hr_departments_list', { p_include_archived: includeArchived === true }));
}

export async function createHrDepartment({ name, parentId = null, description = null, managerEmployeeId = null, sortOrder = 0 }) {
    return callRpc('hrDepartmentCreate', 'hr_department_create', {
        p_name: name, p_parent_id: parentId, p_description: description,
        p_manager_employee_id: managerEmployeeId, p_sort_order: sortOrder
    });
}

export async function updateHrDepartment(id, { name, parentId, description, managerEmployeeId, isActive, sortOrder }) {
    return callRpc('hrDepartmentUpdate', 'hr_department_update', {
        p_id: id, p_name: name, p_parent_id: parentId, p_description: description,
        p_manager_employee_id: managerEmployeeId, p_is_active: isActive, p_sort_order: sortOrder
    });
}

export async function archiveHrDepartment(id, reason) {
    return callRpc('hrDepartmentArchive', 'hr_department_archive', { p_id: id, p_reason: reason });
}

export async function fetchHrBranches(includeArchived = false) {
    return unwrapOrgRows(await callRpc('hrBranchesList', 'hr_branches_list', { p_include_archived: includeArchived === true }));
}

export async function createHrBranch({ name, parentId = null, description = null, managerEmployeeId = null, sortOrder = 0 }) {
    return callRpc('hrBranchCreate', 'hr_branch_create', {
        p_name: name, p_parent_id: parentId, p_description: description,
        p_manager_employee_id: managerEmployeeId, p_sort_order: sortOrder
    });
}

export async function updateHrBranch(id, { name, parentId, description, managerEmployeeId, isActive, sortOrder }) {
    return callRpc('hrBranchUpdate', 'hr_branch_update', {
        p_id: id, p_name: name, p_parent_id: parentId, p_description: description,
        p_manager_employee_id: managerEmployeeId, p_is_active: isActive, p_sort_order: sortOrder
    });
}

export async function archiveHrBranch(id, reason) {
    return callRpc('hrBranchArchive', 'hr_branch_archive', { p_id: id, p_reason: reason });
}

export async function fetchHrPositions(includeArchived = false) {
    return unwrapOrgRows(await callRpc('hrPositionsList', 'hr_positions_list', { p_include_archived: includeArchived === true }));
}

export async function createHrPosition({ name, parentId = null, description = null, managerEmployeeId = null, departmentId = null, level = 1, sortOrder = 0 }) {
    return callRpc('hrPositionCreate', 'hr_position_create', {
        p_name: name, p_parent_id: parentId, p_description: description,
        p_manager_employee_id: managerEmployeeId, p_department_id: departmentId,
        p_level: level, p_sort_order: sortOrder
    });
}

export async function updateHrPosition(id, { name, parentId, description, managerEmployeeId, departmentId, level, isActive, sortOrder }) {
    return callRpc('hrPositionUpdate', 'hr_position_update', {
        p_id: id, p_name: name, p_parent_id: parentId, p_description: description,
        p_manager_employee_id: managerEmployeeId, p_department_id: departmentId,
        p_level: level, p_is_active: isActive, p_sort_order: sortOrder
    });
}

export async function archiveHrPosition(id, reason) {
    return callRpc('hrPositionArchive', 'hr_position_archive', { p_id: id, p_reason: reason });
}

/* ── الإعدادات ───────────────────────────────────────────────────────── */

export async function fetchHrSettings() {
    return callRpc('hrSettingsGet', 'hr_settings_get', {});
}

export async function updateHrSettings({ prefix = null, startFrom = null, settings = null }) {
    return callRpc('hrSettingsUpdate', 'hr_settings_update', {
        p_employee_number_prefix: prefix, p_employee_number_next: startFrom, p_settings: settings
    });
}

/* ── الاستيراد الجماعي ───────────────────────────────────────────────── */

export async function importHrEmployees(rows, idempotencyKey, fileName = null) {
    return callRpc('hrImportEmployees', 'hr_import_employees', {
        p_rows: rows, p_idempotency_key: idempotencyKey, p_file_name: fileName
    });
}

export async function fetchHrImportRuns({ page = 1, pageSize = 20 } = {}) {
    return callRpc('hrImportRunsList', 'hr_import_runs_list', { p_page: page, p_page_size: pageSize });
}

export async function fetchHrImportRunDetail(runId) {
    return callRpc('hrImportRunDetail', 'hr_import_run_detail', { p_run_id: runId });
}

/* ── الربط بالحساب ──────────────────────────────────────────────────── */

export async function linkHrEmployeeAccount(employeeId, userId, reason = null) {
    const result = await callRpc('hrLinkEmployeeAccount', 'hr_link_employee_account', {
        p_employee_id: employeeId, p_user_id: userId, p_reason: reason
    });
    /* سباق نادر: تحقق 143 (6) يمنع التكرار عادةً، لكن ربطين متزامنين قد
       يتجاوزاه معًا فيرمي الفهرس الفريد 158 خطأ Postgres خامًا — نترجمه
       للرسالة العربية نفسها قبل وصوله لأي واجهة تعرض result.error. */
    if (!result.ok && result.error && result.error.includes('hr_employees_company_user_uidx')) {
        return { ok: false, data: null, error: 'الحساب مرتبط بموظف آخر في الشركة بالفعل' };
    }
    return result;
}

export async function unlinkHrEmployeeAccount(employeeId, reason = null) {
    return callRpc('hrLinkEmployeeUnlink', 'hr_link_employee_unlink', {
        p_employee_id: employeeId, p_reason: reason
    });
}

/** مرشحو الربط بالحساب: أعضاء الشركة من company_members() (096/152) —
 *  نفس مسار قائمة الأعضاء، بلا RPC جديد. المالك يرى الكل؛ غير المالك
 *  (كمدير HR) يرى نفسه والمالك فقط (خصوصية 085) — فالمنتقي كامل للمالك
 *  ومحدود لغيره. الخادم يرفض أي اختيار بلا عضوية نشطة برسالة عربية
 *  (تحقق 3 في hr_link_employee_account)، ويرفض المربوط أصلًا بموظف
 *  آخر برسالة عربية (تحقق 6 + ترجمة 158 هنا). */
export async function fetchHrLinkCandidates() {
    return callRpc('hrLinkCandidates', 'company_members', {});
}

/* ── الإجازات (الترحيل 154) ───────────────────────────────────────────── */

/* قوائم الإجازات ترجع مغلفًا {rows, total} لا مصفوفة عارية (نمط 143)؛
   الربط هنا يبقي المغلف كما هو — لوحة العرض تفكّه (data.rows). */
export async function fetchHrLeaveTypes(includeInactive = false) {
    return callRpc('hrLeaveTypesList', 'hr_leave_types_list', { p_include_inactive: includeInactive === true });
}

export async function createHrLeaveType({ code, nameAr, defaultDays = 0, deductsBalance = true, sortOrder = 0 }) {
    return callRpc('hrLeaveTypeCreate', 'hr_leave_type_create', {
        p_code: code, p_name_ar: nameAr, p_default_days: defaultDays,
        p_deducts_balance: deductsBalance, p_sort_order: sortOrder
    });
}

export async function updateHrLeaveType(typeId, { nameAr = null, defaultDays = null, deductsBalance = null, isActive = null, sortOrder = null }) {
    return callRpc('hrLeaveTypeUpdate', 'hr_leave_type_update', {
        p_type_id: typeId, p_name_ar: nameAr, p_default_days: defaultDays,
        p_deducts_balance: deductsBalance, p_is_active: isActive, p_sort_order: sortOrder
    });
}

export async function archiveHrLeaveType(typeId, reason) {
    return callRpc('hrLeaveTypeArchive', 'hr_leave_type_archive', { p_type_id: typeId, p_reason: reason });
}

export async function fetchHrLeaveBalances({ employeeId = null, year = null } = {}) {
    return callRpc('hrLeaveBalancesList', 'hr_leave_balances_list', {
        p_employee_id: employeeId || null, p_year: year || null
    });
}

export async function setHrLeaveBalance(employeeId, leaveTypeId, year, totalDays) {
    return callRpc('hrLeaveBalanceSet', 'hr_leave_balance_set', {
        p_employee_id: employeeId, p_leave_type_id: leaveTypeId, p_year: year, p_total_days: totalDays
    });
}

export async function createHrLeaveRequest({ employeeId, leaveTypeId, startDate, endDate, note = null }) {
    return callRpc('hrLeaveRequestCreate', 'hr_leave_request_create', {
        p_employee_id: employeeId, p_leave_type_id: leaveTypeId,
        p_start_date: startDate, p_end_date: endDate, p_note: note || null
    });
}

export async function decideHrLeaveRequest(requestId, approve, reason = null) {
    return callRpc('hrLeaveRequestDecide', 'hr_leave_request_decide', {
        p_request_id: requestId, p_approve: approve === true, p_reason: reason || null
    });
}

export async function fetchHrLeaveRequests({ page = 1, pageSize = 20, employeeId = null, status = null, leaveTypeId = null, year = null } = {}) {
    return callRpc('hrLeaveRequestsList', 'hr_leave_requests_list', {
        p_page: page, p_page_size: pageSize,
        p_employee_id: employeeId || null, p_status: status || null,
        p_leave_type_id: leaveTypeId || null, p_year: year || null
    });
}

export async function fetchHrLeaveRequestDetail(requestId) {
    return callRpc('hrLeaveRequestDetail', 'hr_leave_request_detail', { p_request_id: requestId });
}

/* ── ربط الموظفين بالتذاكر (الترحيل 156 — قراءة فقط) ──────────────────── */

/* إحصاءات موظف: مفتوحة الآن + نافذة (افتراضيًا آخر 30 يومًا) + متوسط/وسيط
   أول استجابة وحل + أحدث 5 تذاكر. بلا حساب مرتبط ترجع linked=false. */
export async function fetchHrEmployeeTicketStats(employeeId, { from = null, to = null } = {}) {
    return callRpc('hrEmployeeTicketStats', 'hr_employee_ticket_stats', {
        p_employee_id: employeeId, p_from: from || null, p_to: to || null
    });
}

/* قائمة تذاكر موظف بترقيم؛ p_status حزمة: open أو resolved أو rejected. */
export async function fetchHrEmployeeTickets({ employeeId, page = 1, pageSize = 20, status = null } = {}) {
    return callRpc('hrEmployeeTicketsList', 'hr_employee_tickets_list', {
        p_employee_id: employeeId, p_page: page, p_page_size: pageSize, p_status: status || null
    });
}

/* ملخص جماعي (نداء واحد لصفحة القائمة): مفتوحة الآن + أُغلقت لكل موظف. */
export async function fetchHrEmployeesTicketSummary(employeeIds) {
    return callRpc('hrEmployeesTicketSummary', 'hr_employees_ticket_summary', {
        p_employee_ids: Array.isArray(employeeIds) ? employeeIds : []
    });
}

/* تجميع الأقسام للتقارير: صف لكل قسم + «بلا قسم» + إجماليات الشركة. */
export async function fetchHrDepartmentTicketStats({ from = null, to = null } = {}) {
    return callRpc('hrDepartmentTicketStats', 'hr_department_ticket_stats', {
        p_from: from || null, p_to: to || null
    });
}

/* ── الحضور والانصراف (الترحيل 155) ───────────────────────────────────── */

/* قوائم الحضور ترجع مغلفًا {rows, total} لا مصفوفة عارية (نمط 143)؛
   الربط هنا يبقي المغلف كما هو — لوحة العرض تفكّه (data.rows). */
export async function fetchHrShifts(includeInactive = false) {
    return callRpc('hrShiftsList', 'hr_shifts_list', { p_include_inactive: includeInactive === true });
}

export async function createHrShift({ name, startTime, endTime, workingDays = null, graceMinutes = 15, sortOrder = 0 }) {
    return callRpc('hrShiftCreate', 'hr_shift_create', {
        p_name: name, p_start_time: startTime, p_end_time: endTime,
        p_working_days: workingDays, p_grace_minutes: graceMinutes, p_sort_order: sortOrder
    });
}

export async function updateHrShift(shiftId, { name = null, startTime = null, endTime = null, workingDays = null, graceMinutes = null, isActive = null, sortOrder = null }) {
    return callRpc('hrShiftUpdate', 'hr_shift_update', {
        p_shift_id: shiftId, p_name: name, p_start_time: startTime, p_end_time: endTime,
        p_working_days: workingDays, p_grace_minutes: graceMinutes,
        p_is_active: isActive, p_sort_order: sortOrder
    });
}

export async function assignHrShift(employeeId, shiftId, effectiveFrom = null) {
    return callRpc('hrShiftAssign', 'hr_shift_assign', {
        p_employee_id: employeeId, p_shift_id: shiftId, p_effective_from: effectiveFrom || null
    });
}

export async function checkInHrAttendance(employeeId = null, note = null) {
    return callRpc('hrAttendanceCheckIn', 'hr_attendance_check_in', {
        p_employee_id: employeeId || null, p_note: note || null
    });
}

export async function checkOutHrAttendance(employeeId = null, note = null) {
    return callRpc('hrAttendanceCheckOut', 'hr_attendance_check_out', {
        p_employee_id: employeeId || null, p_note: note || null
    });
}

export async function correctHrAttendance(attendanceId, { checkInAt = null, checkOutAt = null, note = null, reason }) {
    return callRpc('hrAttendanceCorrect', 'hr_attendance_correct', {
        p_attendance_id: attendanceId, p_check_in_at: checkInAt || null,
        p_check_out_at: checkOutAt || null, p_note: note, p_reason: reason
    });
}

export async function fetchHrAttendanceToday(employeeId = null) {
    return callRpc('hrAttendanceToday', 'hr_attendance_today', { p_employee_id: employeeId || null });
}

export async function fetchHrAttendanceList({ page = 1, pageSize = 20, employeeId = null, startDate = null, endDate = null, status = null } = {}) {
    return callRpc('hrAttendanceList', 'hr_attendance_list', {
        p_page: page, p_page_size: pageSize,
        p_employee_id: employeeId || null, p_start_date: startDate || null,
        p_end_date: endDate || null, p_status: status || null
    });
}

export async function fetchHrAttendanceSummary({ employeeId = null, startDate = null, endDate = null } = {}) {
    return callRpc('hrAttendanceSummary', 'hr_attendance_summary', {
        p_employee_id: employeeId || null, p_start_date: startDate || null, p_end_date: endDate || null
    });
}

/* ── التقارير (الترحيل 157 — قراءة فقط، تجميع 154/155/156) ─────────────── */

/* كل تقرير يأخذ فترة (الافتراضي الشهر الحالي حتى اليوم) ويرجع مغلفًا
   {rows, total} + إجماليات الشركة (totals)؛ وبلوك مصدره غير مفعّل يرجع
   available=false بدل الفشل — الواجهة تعرض ملاحظة صريحة لذلك البلوك. */
export async function fetchHrReportsHeadcount({ from = null, to = null } = {}) {
    return callRpc('hrReportsHeadcount', 'hr_reports_headcount', {
        p_from: from || null, p_to: to || null
    });
}

export async function fetchHrReportsAttendance({ from = null, to = null } = {}) {
    return callRpc('hrReportsAttendance', 'hr_reports_attendance', {
        p_from: from || null, p_to: to || null
    });
}

export async function fetchHrReportsLeave({ from = null, to = null } = {}) {
    return callRpc('hrReportsLeave', 'hr_reports_leave', {
        p_from: from || null, p_to: to || null
    });
}

export async function fetchHrReportsTickets({ from = null, to = null } = {}) {
    return callRpc('hrReportsTickets', 'hr_reports_tickets', {
        p_from: from || null, p_to: to || null
    });
}
