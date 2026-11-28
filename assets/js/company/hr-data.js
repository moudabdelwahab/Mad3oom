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

export async function fetchHrDepartments(includeArchived = false) {
    return callRpc('hrDepartmentsList', 'hr_departments_list', { p_include_archived: includeArchived === true });
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
    return callRpc('hrBranchesList', 'hr_branches_list', { p_include_archived: includeArchived === true });
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
    return callRpc('hrPositionsList', 'hr_positions_list', { p_include_archived: includeArchived === true });
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
    return callRpc('hrLinkEmployeeAccount', 'hr_link_employee_account', {
        p_employee_id: employeeId, p_user_id: userId, p_reason: reason
    });
}

export async function unlinkHrEmployeeAccount(employeeId, reason = null) {
    return callRpc('hrLinkEmployeeUnlink', 'hr_link_employee_unlink', {
        p_employee_id: employeeId, p_reason: reason
    });
}
