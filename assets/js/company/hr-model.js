/**
 * hr-model.js — لغة وحدة الموارد البشرية كدوال خالصة (التصميم §7.1).
 *
 * كل ما هنا دوال خالصة بلا أي اتصال بالشبكة أو بالـDOM، عشان تتّختبر بمعزل
 * (tests/hr-model.test.mjs) — نفس أسلوب company-model.js.
 *
 * قاعدة مهمة: الدوال دي **عرض وتحقق أولي** فقط. مفيش قرار صلاحية أو استحقاق
 * بيتاخد هنا؛ القرار في قاعدة البيانات (_hr_gate في الترحيل 143)، والخادم
 * هو الحكم النهائي على كل صف (المعاينة تقول «جاهز حسب آخر لقطة» لا «مضمون»).
 */

/* ── الحالات والمفاتيح ──────────────────────────────────────────────────── */

export const HR_EMPLOYEE_STATUSES = Object.freeze({
    active: { label: 'نشط', pill: 'status-tone-success' },
    on_leave: { label: 'في إجازة', pill: 'status-tone-warning' },
    suspended: { label: 'موقوف', pill: 'status-tone-danger' },
    terminated: { label: 'منتهٍ (مؤرشف)', pill: 'status-neutral' },
    pending_data: { label: 'بيانات ناقصة', pill: 'status-tone-warning' }
});

export function employeeStatusInfo(status) {
    return HR_EMPLOYEE_STATUSES[status] || { label: 'غير معروفة', pill: 'status-neutral' };
}

export const HR_SECTION_KEYS = Object.freeze([
    'hr_employees', 'hr_leave', 'hr_payroll', 'hr_tasks', 'hr_attendance', 'hr_reports'
]);

export const HR_SECTION_LABELS = Object.freeze({
    hr: { label: 'وحدة الموارد البشرية', hint: 'البوابة الرئيسية — بلا هذا المفتاح لا يعمل أي قسم' },
    hr_employees: { label: 'الموظفون والهيكل', hint: 'ملفات الموظفين والأقسام والفروع والمسميات والاستيراد' },
    hr_leave: { label: 'الإجازات والاستئذان', hint: 'طلبات الإجازات والاستئذان والأرصدة (المرحلة 3)' },
    hr_payroll: { label: 'الرواتب', hint: 'الرواتب وكشوفها (المرحلة 6 — آخر مرحلة مالية)' },
    hr_tasks: { label: 'مهام الموظفين', hint: 'مهام الموظفين وإسنادها (المرحلة 4)' },
    hr_attendance: { label: 'الحضور والانصراف', hint: 'الحضور والانصراف والورديات (المرحلة 7)' },
    hr_reports: { label: 'تقارير الموارد البشرية', hint: 'التقارير والتصدير المتقدم' }
});

/** حالة إتاحة HR لشركة من صف owner_hr_list_companies (حالات وعدّادات فقط). */
export function hrCompanyStatusInfo(company) {
    if (!company) return { label: 'غير معروفة', pill: 'status-neutral' };
    const overrides = Array.isArray(company.overrides) ? company.overrides : [];
    if (overrides.some(o => o.status === 'suspended')) {
        return { label: 'قسم موقوف', pill: 'status-tone-warning' };
    }
    if (company.hr_enabled === true) return { label: 'مفعّلة', pill: 'status-tone-success' };
    return { label: 'بلا استحقاق', pill: 'status-neutral' };
}

/** ملخص أقسام شركة: كم قسمًا مفعّلًا من الستة. */
export function hrEntitlementSummary(sections) {
    const s = sections || {};
    const enabled = HR_SECTION_KEYS.filter(k => s[k] === true).length;
    return { enabled, total: HR_SECTION_KEYS.length, allEnabled: enabled === HR_SECTION_KEYS.length };
}

/* ── التقنيع والعرض ────────────────────────────────────────────────────── */

/**
 * تقنيع الرقم القومي في العميل (مرآة _hr_mask_national_id في القاعدة —
 * القاعدة هي الحكم، وهذه للعرض فقط حين يصل الرقم كاملًا خطأً).
 */
export function maskNationalId(value) {
    const v = String(value || '');
    if (!v) return '';
    if (v.length < 6) return '****';
    return v.slice(0, 3) + '********' + v.slice(-2);
}

/** صف موظف للعرض في القائمة: الرقم القومي مقنّع دائمًا، والحالة بتسميتها. */
export function employeeRowForDisplay(row) {
    if (!row) return null;
    return {
        id: row.id || null,
        employeeNumber: row.employee_number || '',
        fullName: row.full_name || '—',
        phone: row.phone || '—',
        email: row.email || '—',
        nationalId: maskNationalId(row.national_id),
        departmentName: row.department_name || '—',
        branchName: row.branch_name || '—',
        positionName: row.position_name || '—',
        managerName: row.manager_name || '—',
        jobTitle: row.job_title || row.position_name || '—',
        hireDate: row.hire_date || null,
        contractType: row.contract_type || null,
        status: row.employment_status || 'active',
        statusInfo: employeeStatusInfo(row.employment_status),
        linked: row.linked === true
    };
}

/* ── الترقيم ───────────────────────────────────────────────────────────── */

export const HR_PAGE_SIZE_DEFAULT = 20;
export const HR_PAGE_SIZE_MAX = 100;

/** معاملات ترقيم مُنظَّفة (صفحة ≥1، حجم 1..100) — مرآة حدود الخادم. */
export function hrPageParams(page, pageSize) {
    return {
        page: Math.max(1, Number(page) || 1),
        pageSize: Math.min(HR_PAGE_SIZE_MAX, Math.max(1, Number(pageSize) || HR_PAGE_SIZE_DEFAULT))
    };
}

/** عرض الترقيم: عدد الصفحات وهل توجد سابقة/تالية. */
export function hrPaginationView(total, page, pageSize) {
    const { page: p, pageSize: s } = hrPageParams(page, pageSize);
    const totalPages = Math.max(1, Math.ceil((Number(total) || 0) / s));
    return { total: Number(total) || 0, page: Math.min(p, totalPages), pageSize: s, totalPages,
             hasPrev: p > 1, hasNext: p < totalPages };
}

/* ── تحقق نموذج إضافة/تعديل موظف (عرض أولي؛ القاعدة تفرضه فعليًا) ───────── */

export const HR_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const HR_PHONE_RE = /^\+?[0-9][0-9 ()-]*$/;

export function validateEmployeeForm(values) {
    const errors = {};
    const fullName = String(values?.fullName || '').trim();
    const number = String(values?.employeeNumber || '').trim();
    const phone = String(values?.phone || '').trim();
    const email = String(values?.email || '').trim();
    const nationalId = String(values?.nationalId || '').trim();
    const hireDate = String(values?.hireDate || '').trim();
    const contractType = String(values?.contractType || '').trim();

    if (fullName.length < 2) errors.fullName = 'اسم الموظف مطلوب (حرفان على الأقل)';
    if (number && /\s/.test(number)) errors.employeeNumber = 'الرقم الوظيفي بلا مسافات';
    if (phone && (phone.length < 7 || phone.length > 20 || !HR_PHONE_RE.test(phone))) {
        errors.phone = 'رقم هاتف غير صالح';
    }
    if (email && (email.length > 320 || !HR_EMAIL_RE.test(email))) errors.email = 'بريد إلكتروني غير صالح';
    if (nationalId && (nationalId.length < 10 || nationalId.length > 20)) {
        errors.nationalId = 'الرقم القومي بين 10 و20 حرفًا';
    }
    if (hireDate) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(hireDate) || Number.isNaN(new Date(hireDate).getTime())) {
            errors.hireDate = 'تاريخ التعيين بصيغة YYYY-MM-DD';
        } else if (new Date(hireDate) > new Date(new Date().toDateString())) {
            errors.hireDate = 'تاريخ التعيين لا يكون في المستقبل';
        }
    }
    if (contractType && !['full_time', 'part_time', 'contract', 'intern', 'temporary'].includes(contractType)) {
        errors.contractType = 'نوع عقد غير صالح';
    }
    return { isValid: Object.keys(errors).length === 0, errors };
}

/* ── الاستيراد الجماعي من CSV (التصميم §6) ───────────────────────────────
 *
 * نفس هيكل parseCustomersCsv في company-model.js (حقول مقتبسة، BOM، CRLF،
 * سطور فارغة، ترويسة اختيارية)، مع إصلاح فجوة موثقة فيه: الحقل المقتبس
 * الذي يحوي سطرًا جديدًا كان يُقسَّم — هنا الماسح حرفًا بحرف فيحفظه.
 * الفاصلة وحدها فاصل؛ الفاصلة المنقوطة والتاب تُرفضان برسالة صريحة.
 */

export const HR_IMPORT_MAX_ROWS = 100;
export const HR_IMPORT_MAX_FILE_BYTES = 1024 * 1024;

const HR_CSV_HEADERS = new Map([
    ['employee_number', new Set(['employee_number', 'emp_no', 'employee no', 'emp number', 'الرقم الوظيفي', 'رقم الموظف', 'رقم وظيفي'])],
    ['full_name', new Set(['full_name', 'fullname', 'name', 'full name', 'employee name', 'الاسم', 'اسم الموظف', 'الاسم الكامل'])],
    ['phone', new Set(['phone', 'mobile', 'tel', 'telephone', 'الهاتف', 'الجوال', 'رقم الهاتف', 'رقم الجوال'])],
    ['email', new Set(['email', 'email address', 'البريد', 'البريد الإلكتروني', 'البريد الالكتروني'])],
    ['national_id', new Set(['national_id', 'national id', 'الرقم القومي', 'رقم الهوية', 'الهوية', 'الرقم الوطني'])],
    ['department', new Set(['department', 'dept', 'القسم'])],
    ['branch', new Set(['branch', 'الفرع'])],
    ['position', new Set(['position', 'المسمى الوظيفي', 'الوظيفة'])],
    ['manager_employee_number', new Set(['manager_employee_number', 'manager', 'manager number', 'manager_employee_no', 'الرقم الوظيفي للمدير', 'رقم المدير', 'المدير المباشر'])],
    ['job_title', new Set(['job_title', 'job title', 'title', 'المسمى'])],
    ['hire_date', new Set(['hire_date', 'hire date', 'تاريخ التعيين', 'تاريخ الالتحاق'])],
    ['contract_type', new Set(['contract_type', 'contract', 'نوع العقد', 'العقد'])],
    ['date_of_birth', new Set(['date_of_birth', 'birth date', 'birthdate', 'تاريخ الميلاد'])],
    ['address', new Set(['address', 'العنوان'])]
]);

/** يفكّ سجل CSV واحد (قد يمتد على عدة أسطر داخل اقتباس): حقول مقتبسة ("…")
 *  وفاصلة داخل الاقتباس، و"" هروبًا. يرجع null عند اقتباس غير مغلق. */
function parseCsvRecord(text) {
    const fields = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quoted) {
            if (ch === '"') {
                if (text[i + 1] === '"') { field += '"'; i++; }
                else quoted = false;
            } else field += ch;
        } else if (ch === '"') {
            quoted = true;
        } else if (ch === ',') {
            fields.push(field);
            field = '';
        } else field += ch;
    }
    if (quoted) return null;
    fields.push(field);
    return fields;
}

/**
 * يحوّل نص ملف CSV إلى صفوف موظفين.
 *  • يقسّم السجلات حرفًا بحرف فيحفظ الحقول المقتبسة متعددة الأسطر.
 *  • يقبل سطر عناوين (عربي/إنجليزي حسب HR_CSV_HEADERS) أو بلا عناوين
 *    (الترتيب الافتراضي: الرقم، الاسم، الهاتف، البريد، القومي، القسم، الفرع،
 *    المسمى، رقم المدير، المسمى الحر، تاريخ التعيين، نوع العقد).
 *  • يتجاهل الأسطر الفارغة، ويقبل CRLF وBOM.
 *  • يرجع { rows, errors }: errors سجلات لم تُفكّ (اقتباس غير مغلق) مع رقم
 *    السطر وسبب عربي — ولا يُرسَل أيٌّ منها.
 */
export function parseHrEmployeesCsv(text) {
    const rows = [];
    const errors = [];
    const clean = String(text || '').replace(/^\uFEFF/, '');
    // تقسيم السجلات مع تتبّع الاقتباس حتى لا يُقسَّم حقل مقتبس متعدد الأسطر.
    const records = [];
    let current = '';
    let quoted = false;
    let startLine = 1;
    let line = 1;
    for (let i = 0; i < clean.length; i++) {
        const ch = clean[i];
        if (ch === '"') {
            // "" داخل اقتباس هروب لا إغلاق
            if (quoted && clean[i + 1] === '"') { current += '""'; i++; continue; }
            quoted = !quoted;
            current += ch;
            continue;
        }
        if (!quoted && (ch === '\n' || ch === '\r')) {
            if (ch === '\r' && clean[i + 1] === '\n') i++;
            records.push({ text: current, line: startLine });
            current = '';
            line++;
            startLine = line;
            continue;
        }
        if (ch === '\n') line++;
        current += ch;
    }
    if (current.trim() !== '') records.push({ text: current, line: startLine });
    if (!records.length) return { rows, errors };

    const headerOf = (cell) => {
        const key = String(cell || '').trim().toLowerCase();
        for (const [field, names] of HR_CSV_HEADERS) {
            if (names.has(key)) return field;
        }
        return null;
    };
    // ترتيب افتراضي بلا ترويسة (قالب الاستيراد نفسه بهذا الترتيب).
    const DEFAULT_ORDER = ['employee_number', 'full_name', 'phone', 'email', 'national_id',
        'department', 'branch', 'position', 'manager_employee_number', 'job_title',
        'hire_date', 'contract_type'];
    let columns = null;
    let started = false;
    for (const record of records) {
        if (!record.text.trim()) continue;
        const fields = parseCsvRecord(record.text);
        if (fields === null) {
            errors.push({ line: record.line, reason: 'سطر غير صالح: علامة اقتباس غير مغلقة' });
            continue;
        }
        if (!started) {
            started = true;
            const mapped = fields.map(headerOf);
            if (mapped.some(Boolean)) {
                columns = mapped;
                continue; // سطر العناوين نفسه ليس صفًا
            }
            columns = DEFAULT_ORDER;
        }
        const get = (field) => {
            const idx = columns.indexOf(field);
            return idx < 0 ? '' : String(fields[idx] ?? '').trim();
        };
        const row = {
            line: record.line,
            employee_number: get('employee_number'),
            full_name: get('full_name'),
            phone: get('phone'),
            email: get('email'),
            national_id: get('national_id'),
            department: get('department'),
            branch: get('branch'),
            position: get('position'),
            manager_employee_number: get('manager_employee_number'),
            job_title: get('job_title'),
            hire_date: get('hire_date'),
            contract_type: get('contract_type'),
            date_of_birth: get('date_of_birth'),
            address: get('address')
        };
        if (!row.employee_number && !row.full_name && !row.phone && !row.email) continue;
        rows.push(row);
    }
    return { rows, errors };
}

/**
 * حدّ الصفوف قبل أي تحقّق: بلا صفوف، أو فوق الحد الأقصى.
 * يُفحص عدد الصفوف + السجلات غير الصالحة معًا — ملف فوق الحد يُرفض كاملًا.
 */
export function checkHrImportLimit(count) {
    if (!count || count <= 0) return { ok: false, error: 'الملف لا يحتوي على أي صفوف' };
    if (count > HR_IMPORT_MAX_ROWS) {
        return { ok: false, error: `الملف يحتوي على ${count} صفًا — الحد الأقصى ${HR_IMPORT_MAX_ROWS} صفوف في كل عملية استيراد` };
    }
    return { ok: true, error: null };
}

/**
 * يتحقق أوليًا من صفوف الاستيراد بقواعد §6.3 على لقطة محلية:
 * الاسم ≥ حرفين، الرقم الوظيفي (أو يُترك فارغًا للترقيم التلقائي)، صيغ
 * الهاتف/البريد/القومي/التاريخ/العقد، التكرار داخل الملف، التكرار ضد
 * الموظفين الحاليين، ووجود القسم/الفرع/المسمى/المدير في اللقطة.
 * القوائم المرجعية أسماء كما ترجعها القاعدة (مطابقة بعد القص وخفض الحالة).
 * يرجع { valid, invalid } — كل صف { line, ..., reason, code }.
 * ترويسة صريحة في الواجهة: «تحقق أولي — القرار النهائي للخادم».
 */
export function validateHrImportRows(rows, {
    existingNumbers = [], existingEmails = [], existingNids = [],
    departments = [], branches = [], positions = [], existingEmployees = []
} = {}) {
    const norm = (s) => String(s || '').trim().toLowerCase();
    const existingNum = new Set((existingNumbers || []).map(norm).filter(Boolean));
    const existingMail = new Set((existingEmails || []).map(norm).filter(Boolean));
    const existingNid = new Set((existingNids || []).map(s => String(s || '').trim()).filter(Boolean));
    const deptNames = new Set((departments || []).map(norm).filter(Boolean));
    const branchNames = new Set((branches || []).map(norm).filter(Boolean));
    const posNames = new Set((positions || []).map(norm).filter(Boolean));
    const knownEmployees = new Set((existingEmployees || []).map(e => norm(e.employee_number)).filter(Boolean));
    const seenNumbers = new Set();
    const seenEmails = new Set();
    const seenNids = new Set();
    const fileNumbers = new Set((rows || []).map(r => norm(r.employee_number)).filter(Boolean));
    const valid = [];
    const invalid = [];
    for (const row of rows || []) {
        const entry = {
            line: row.line,
            employee_number: String(row.employee_number || '').trim(),
            full_name: String(row.full_name || '').trim(),
            phone: String(row.phone || '').trim(),
            email: String(row.email || '').trim().toLowerCase(),
            national_id: String(row.national_id || '').trim(),
            department: String(row.department || '').trim(),
            branch: String(row.branch || '').trim(),
            position: String(row.position || '').trim(),
            manager_employee_number: String(row.manager_employee_number || '').trim(),
            job_title: String(row.job_title || '').trim(),
            hire_date: String(row.hire_date || '').trim(),
            contract_type: String(row.contract_type || '').trim(),
            date_of_birth: String(row.date_of_birth || '').trim(),
            address: String(row.address || '').trim()
        };
        const fail = (code, reason) => invalid.push({ ...entry, code, reason });
        if (entry.full_name.length < 2) { fail('missing_name', 'الاسم مطلوب (حرفان على الأقل)'); continue; }
        if (entry.employee_number && /\s/.test(entry.employee_number)) {
            fail('missing_employee_number', 'الرقم الوظيفي بلا مسافات'); continue;
        }
        if (entry.employee_number && seenNumbers.has(norm(entry.employee_number))) {
            fail('duplicate_in_file', 'الرقم الوظيفي مكرر داخل الملف'); continue;
        }
        if (entry.employee_number && existingNum.has(norm(entry.employee_number))) {
            fail('duplicate_employee_number', 'الرقم الوظيفي موجود في الشركة بالفعل'); continue;
        }
        if (entry.phone && (entry.phone.length < 7 || entry.phone.length > 20 || !HR_PHONE_RE.test(entry.phone))) {
            fail('invalid_phone', 'رقم هاتف غير صالح'); continue;
        }
        if (entry.email && (entry.email.length > 320 || !HR_EMAIL_RE.test(entry.email))) {
            fail('invalid_email', 'بريد إلكتروني غير صالح'); continue;
        }
        if (entry.email && seenEmails.has(entry.email)) {
            fail('duplicate_in_file', 'البريد الإلكتروني مكرر داخل الملف'); continue;
        }
        if (entry.email && existingMail.has(entry.email)) {
            fail('duplicate_email', 'البريد الإلكتروني موجود في الشركة بالفعل'); continue;
        }
        if (entry.national_id && (entry.national_id.length < 10 || entry.national_id.length > 20)) {
            fail('invalid_national_id', 'الرقم القومي بين 10 و20 حرفًا'); continue;
        }
        if (entry.national_id && seenNids.has(entry.national_id)) {
            fail('duplicate_in_file', 'الرقم القومي مكرر داخل الملف'); continue;
        }
        if (entry.national_id && existingNid.has(entry.national_id)) {
            fail('duplicate_national_id', 'الرقم القومي موجود في الشركة بالفعل'); continue;
        }
        if (entry.hire_date) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.hire_date) || Number.isNaN(new Date(entry.hire_date).getTime())) {
                fail('invalid_date', 'تاريخ التعيين بصيغة YYYY-MM-DD'); continue;
            }
            if (new Date(entry.hire_date) > new Date(new Date().toDateString())) {
                fail('invalid_date', 'تاريخ التعيين لا يكون في المستقبل'); continue;
            }
        }
        if (entry.contract_type && !['full_time', 'part_time', 'contract', 'intern', 'temporary'].includes(entry.contract_type)) {
            fail('invalid_contract_type', 'نوع عقد غير صالح'); continue;
        }
        if (entry.department && !deptNames.has(norm(entry.department))) {
            fail('unknown_department', `القسم غير موجود في شركتك: ${entry.department}`); continue;
        }
        if (entry.branch && !branchNames.has(norm(entry.branch))) {
            fail('unknown_branch', `الفرع غير موجود في شركتك: ${entry.branch}`); continue;
        }
        if (entry.position && !posNames.has(norm(entry.position))) {
            fail('unknown_position', `المسمى الوظيفي غير موجود في شركتك: ${entry.position}`); continue;
        }
        if (entry.manager_employee_number
            && !knownEmployees.has(norm(entry.manager_employee_number))
            && !fileNumbers.has(norm(entry.manager_employee_number))) {
            fail('unknown_manager', `الرقم الوظيفي للمدير غير موجود: ${entry.manager_employee_number}`); continue;
        }
        if (entry.employee_number) seenNumbers.add(norm(entry.employee_number));
        if (entry.email) seenEmails.add(entry.email);
        if (entry.national_id) seenNids.add(entry.national_id);
        valid.push(entry);
    }
    return { valid, invalid };
}

/** ملخص تقرير التنفيذ صفًا صفًا كما يرجعه hr_import_employees. */
export function summarizeHrImportResults(results) {
    const list = Array.isArray(results) ? results : [];
    const inserted = list.filter(r => r?.status === 'inserted').length;
    const duplicate = list.filter(r => r?.status === 'duplicate').length;
    const invalid = list.filter(r => r?.status === 'invalid').length;
    return { total: list.length, inserted, duplicate, invalid };
}

/** قالب CSV للاستيراد (نفس ترتيب الأعمدة الافتراضي في parseHrEmployeesCsv). */
export function hrImportTemplateCsv() {
    return '\uFEFFemployee_number,full_name,phone,email,national_id,department,branch,position,manager_employee_number,job_title,hire_date,contract_type\n'
        + 'EMP-0001,اسم الموظف,01000000000,employee@example.com,29901011234567,الإدارة,القاهرة,,,2026-01-01,full_time\n';
}

/** يحوّل نتائج الاستيراد إلى CSV للتقرير (مع حماية من حقن الصيغ). */
export function hrImportResultsToCsv(results) {
    const esc = (v) => {
        const s = String(v ?? '');
        const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
        return `"${safe.replace(/"/g, '""')}"`;
    };
    const lines = [['السطر', 'الرقم الوظيفي', 'الحالة', 'السبب'].map(esc).join(',')];
    for (const r of results || []) {
        const label = r?.status === 'inserted' ? 'أُدخل' : r?.status === 'duplicate' ? 'مكرر' : 'مرفوض';
        lines.push([r?.line ?? '', r?.employee_number ?? '', label, r?.reason ?? ''].map(esc).join(','));
    }
    return `\uFEFF${lines.join('\n')}\n`;
}

/* ── الهيكل التنظيمي (قائمة مسطحة ← شجرة) ─────────────────────────────── */

/**
 * يبني شجرة من قائمة مسطحة { id, parent_id, ... } كما ترجعها
 * hr_departments_list/hr_branches_list/hr_positions_list.
 * يرجع { tree, errors }: الحلقة أو الأب المفقود خطأ عربي في errors، والعقد
 * المعنية تُترك في الجذر حتى لا تضيع من العرض.
 */
export function buildOrgTree(rows) {
    const nodes = new Map();
    const roots = [];
    const errors = [];
    for (const row of rows || []) {
        nodes.set(row.id, { ...row, children: [], depth: 1 });
    }
    for (const row of rows || []) {
        const node = nodes.get(row.id);
        if (!row.parent_id) { roots.push(node); continue; }
        const parent = nodes.get(row.parent_id);
        if (!parent) {
            errors.push({ id: row.id, reason: `أب غير موجود: ${row.parent_id}` });
            roots.push(node);
            continue;
        }
        // منع الحلقة: المشي صعودًا من الأب يجب ألا يصل للعقدة نفسها.
        let walk = parent;
        let cycle = false;
        const seen = new Set([row.id]);
        while (walk) {
            if (seen.has(walk.id)) { cycle = true; break; }
            seen.add(walk.id);
            walk = walk.parent_id ? nodes.get(walk.parent_id) : null;
        }
        if (cycle) {
            errors.push({ id: row.id, reason: 'حلقة في الهيكل التنظيمي' });
            roots.push(node);
            continue;
        }
        parent.children.push(node);
    }
    const setDepth = (list, depth) => {
        for (const n of list) {
            n.depth = depth;
            setDepth(n.children, depth + 1);
        }
    };
    setDepth(roots, 1);
    return { tree: roots, errors };
}

/** فحص أولي للعمق والحلقة قبل الإرسال (الخادم يحسم — حارس _hr_org_depth_guard). */
export function checkOrgDepth(parentChainLength) {
    if (parentChainLength > 5) {
        return { ok: false, error: 'العمق الأقصى للهيكل التنظيمي 6 مستويات' };
    }
    return { ok: true, error: null };
}
