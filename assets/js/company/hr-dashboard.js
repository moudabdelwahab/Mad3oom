/**
 * hr-dashboard.js — واجهة وحدة الموارد البشرية في لوحة الشركة (الترحيل 143).
 *
 *   Pages: hr-overview / hr-employees / hr-departments / hr-import
 *   (التنقل والحجب عبر company-routes.js + applyViewerRole في company-dashboard.js).
 *
 *   كل إجراء هنا ينادي RPC حقيقي من hr-data.js (مفيش أزرار زائفة):
 *   - قائمة الموظفين: ترقيم وبحث وتصفية من الخادم (hr_employees_list)،
 *     إضافة/تعديل (hr_employee_create/update)، أرشفة بتأكيد وسبب
 *     (hr_employee_archive — ينقّل للحالة terminated ولا يحذف).
 *   - الاستيراد: تنزيل قالب → رفع CSV → معاينة أولية صفًا صفًا (تحقق أولي
 *     في hr-model.js مع ترويسة صريحة أن القرار النهائي للخادم) → تنفيذ
 *     بنداء RPC واحد hr_import_employees → تقرير نهائي صفًا صفًا.
 *   - الأقسام/الفروع/المسميات: قوائم CRUD بسيطة.
 *   - لو بلا استحقاق: حالة حجب صريحة بلا أرقام وهمية؛ مفيش أرقام تظهر
 *     قبل رجوع القاعدة (صفر يُعرض فقط بعد رجوع القاعدة بقيم صفرية).
 *
 *   حالة الحجب (renderState) من portal-ui.js، والهروب من escapeHtml —
 *   نفس أدوات company-dashboard.js.
 */

import { renderState, escapeHtml as esc } from '/assets/js/customer/portal-ui.js';
import {
    employeeRowForDisplay, employeeStatusInfo, hrPageParams, hrPaginationView,
    parseHrEmployeesCsv, checkHrImportLimit, validateHrImportRows, summarizeHrImportResults,
    hrImportTemplateCsv, hrImportResultsToCsv, buildOrgTree, HR_IMPORT_MAX_ROWS,
    HR_IMPORT_MAX_FILE_BYTES, validateEmployeeForm, HR_SECTION_LABELS, maskNationalId
} from '/assets/js/company/hr-model.js';
import {
    fetchHrEmployees, fetchHrEmployeesCount, fetchHrEmployeeDetail,
    createHrEmployee, updateHrEmployee, archiveHrEmployee, reactivateHrEmployee,
    setHrEmployeeStatus, fetchHrDepartments, createHrDepartment, updateHrDepartment,
    archiveHrDepartment, fetchHrBranches, createHrBranch, updateHrBranch, archiveHrBranch,
    fetchHrPositions, createHrPosition, updateHrPosition, archiveHrPosition,
    fetchHrSettings, updateHrSettings, importHrEmployees, fetchHrImportRuns, fetchHrImportRunDetail
} from '/assets/js/company/hr-data.js';

/* ── أدوات محلية ───────────────────────────────────────────────────────── */

function blockReason(err) {
    const msg = String(err?.error || err?.message || err || '');
    if (/لا يملك الشركة/.test(msg) || /لا يملك صلاحية/.test(msg)) return 'صلاحية غير كافية لهذا الإجراء';
    if (/مفتاح المنصة/.test(msg) || /معطَّل/.test(msg)) return 'وحدة الموارد البشرية معطَّلة من المنصة';
    if (/اشتراك/.test(msg)) return 'باقتك الحالية لا تشمل وحدة الموارد البشرية';
    if (/موقوف/.test(msg)) return 'وحدة الموارد البشرية موقوفة لهذه الشركة';
    if (/محظور/.test(msg)) return 'الحساب محظور';
    return msg || 'تعذّر تنفيذ الطلب';
}

/** نافذة سبب مدمجة (لا window.prompt): السبب يُوثَّق في سجل التدقيق. */
function askReason(title) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'hr-modal-overlay';
        overlay.innerHTML = `<div class="hr-modal" role="dialog" aria-modal="true">
            <h3>${esc(title)}</h3>
            <p class="muted">السبب مطلوب (10 أحرف على الأقل) — يُوثَّق في سجل التدقيق.</p>
            <textarea data-hr-reason rows="3"></textarea>
            <p class="error-text" data-hr-reason-error hidden></p>
            <div class="form-actions">
                <button type="button" class="btn-primary" data-hr-reason-ok>تأكيد</button>
                <button type="button" class="btn-ghost" data-hr-reason-cancel>إلغاء</button>
            </div></div>`;
        document.body.appendChild(overlay);
        const close = (value) => { overlay.remove(); resolve(value); };
        overlay.querySelector('[data-hr-reason-cancel]').addEventListener('click', () => close(null));
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
        overlay.querySelector('[data-hr-reason-ok]').addEventListener('click', () => {
            const t = String(overlay.querySelector('[data-hr-reason]').value || '').trim();
            if (t.length < 10) {
                const errEl = overlay.querySelector('[data-hr-reason-error]');
                errEl.textContent = 'السبب مطلوب (10 أحرف على الأقل).';
                errEl.hidden = false;
                return;
            }
            close(t);
        });
        overlay.querySelector('[data-hr-reason]').focus();
    });
}

function downloadText(filename, text, mime = 'text/csv;charset=utf-8') {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function uuid() {
    return (window.crypto?.randomUUID && window.crypto.randomUUID())
        || 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
}

function pill(statusInfo) {
    return `<span class="status-pill ${esc(statusInfo.pill)}">${esc(statusInfo.label)}</span>`;
}

/* ── نظرة عامة ─────────────────────────────────────────────────────────── */

/** نظرة عامة: عدد الموظفين والأقسام من القاعدة فقط — بلا أرقام قبل رجوعها. */
export async function loadHrOverview() {
    const container = document.getElementById('hrOverviewBody');
    if (!container) return;
    renderState(container, { variant: 'loading', title: 'جارٍ تحميل نظرة الموارد البشرية…', text: '' });
    const [countRes, deptRes, branchRes] = await Promise.all([
        fetchHrEmployeesCount(), fetchHrDepartments(false), fetchHrBranches(false)
    ]);
    if (!countRes.ok) {
        renderState(container, {
            variant: 'error', title: 'تعذّر تحميل نظرة الموارد البشرية',
            text: blockReason(countRes), action: { label: 'إعادة المحاولة', retry: 'hr-overview', variant: 'btn-primary' }
        });
        return;
    }
    const counts = countRes.data || {};
    const depts = Array.isArray(deptRes.data) ? deptRes.data : [];
    const branches = Array.isArray(branchRes.data) ? branchRes.data : [];
    const byStatus = counts.by_status || {};
    const statusCards = Object.entries(byStatus).map(([status, n]) => {
        const info = employeeStatusInfo(status);
        return `<div class="kpi-card"><div class="kpi-value">${esc(String(n))}</div><div class="kpi-label">${esc(info.label)}</div></div>`;
    }).join('');
    container.innerHTML = `
        <div class="kpi-row">
            <div class="kpi-card"><div class="kpi-value">${esc(String(counts.total || 0))}</div><div class="kpi-label">إجمالي الموظفين</div></div>
            ${statusCards}
            <div class="kpi-card"><div class="kpi-value">${esc(String(depts.length))}</div><div class="kpi-label">الأقسام</div></div>
            <div class="kpi-card"><div class="kpi-value">${esc(String(branches.length))}</div><div class="kpi-label">الفروع</div></div>
        </div>
        <p class="muted">هذه الأرقام من قاعدة البيانات مباشرة. أقسام الإجازات والرواتب والمهام
        والحضور والتقارير تُفعَّل من المالك كل على حدة، وتظهر هنا حين تُتاح.</p>`;
}

/* ── قائمة الموظفين ────────────────────────────────────────────────────── */

const empState = {
    page: 1, pageSize: 20, search: '', status: null, departmentId: null, branchId: null,
    includeTerminated: false, rows: [], total: 0, loaded: false
};
let orgCache = { departments: [], branches: [], positions: [], employees: [], loaded: false };

async function ensureOrgCache() {
    if (orgCache.loaded) return orgCache;
    const [d, b, p] = await Promise.all([fetchHrDepartments(false), fetchHrBranches(false), fetchHrPositions(false)]);
    orgCache = {
        departments: Array.isArray(d.data) ? d.data : [],
        branches: Array.isArray(b.data) ? b.data : [],
        positions: Array.isArray(p.data) ? p.data : [],
        employees: [], loaded: true
    };
    return orgCache;
}

function orgOptions(list, selectedId, placeholder) {
    const opts = list.map(r => `<option value="${esc(r.id)}" ${String(r.id) === String(selectedId) ? 'selected' : ''}>${esc(r.name)}</option>`).join('');
    return `<option value="">${esc(placeholder)}</option>${opts}`;
}

export async function loadHrEmployees() {
    const container = document.getElementById('hrEmployeesBody');
    if (!container) return;
    await ensureOrgCache();
    renderEmployeesToolbar(container);
    await refreshEmployeesList(container);
}

function renderEmployeesToolbar(container) {
    const toolbar = document.getElementById('hrEmployeesToolbar');
    if (!toolbar) return;
    toolbar.innerHTML = `
        <div class="hr-toolbar-row">
            <input type="search" id="hrEmpSearch" placeholder="ابحث بالاسم أو الرقم الوظيفي أو الهاتف…" value="${esc(empState.search)}" aria-label="بحث عن موظف">
            <select id="hrEmpStatus" aria-label="تصفية بالحالة">
                <option value="">كل الحالات</option>
                <option value="active" ${empState.status === 'active' ? 'selected' : ''}>نشط</option>
                <option value="on_leave" ${empState.status === 'on_leave' ? 'selected' : ''}>في إجازة</option>
                <option value="suspended" ${empState.status === 'suspended' ? 'selected' : ''}>موقوف</option>
                <option value="pending_data" ${empState.status === 'pending_data' ? 'selected' : ''}>بيانات ناقصة</option>
            </select>
            <select id="hrEmpDept" aria-label="تصفية بالقسم">${orgOptions(orgCache.departments, empState.departmentId, 'كل الأقسام')}</select>
            <label class="hr-check"><input type="checkbox" id="hrEmpTerminated" ${empState.includeTerminated ? 'checked' : ''}> إظهار المؤرشفين</label>
            <button type="button" class="btn-primary" id="hrEmpAddBtn">+ إضافة موظف</button>
        </div>
        <div id="hrEmpFormSlot"></div>`;
    document.getElementById('hrEmpSearch').addEventListener('input', (e) => {
        empState.search = e.target.value;
        empState.page = 1;
        refreshEmployeesList(container);
    });
    document.getElementById('hrEmpStatus').addEventListener('change', (e) => {
        empState.status = e.target.value || null;
        empState.page = 1;
        refreshEmployeesList(container);
    });
    document.getElementById('hrEmpDept').addEventListener('change', (e) => {
        empState.departmentId = e.target.value || null;
        empState.page = 1;
        refreshEmployeesList(container);
    });
    document.getElementById('hrEmpTerminated').addEventListener('change', (e) => {
        empState.includeTerminated = e.target.checked;
        empState.page = 1;
        refreshEmployeesList(container);
    });
    document.getElementById('hrEmpAddBtn').addEventListener('click', () => openEmployeeForm(null, container));
}

async function refreshEmployeesList(container) {
    const list = document.getElementById('hrEmployeesList');
    if (!list) return;
    renderState(list, { variant: 'loading', title: 'جارٍ تحميل الموظفين…', text: '' });
    const { page, pageSize } = hrPageParams(empState.page, empState.pageSize);
    const result = await fetchHrEmployees({
        page, pageSize, search: empState.search, status: empState.status,
        departmentId: empState.departmentId, branchId: empState.branchId,
        includeTerminated: empState.includeTerminated
    });
    if (!result.ok) {
        renderState(list, {
            variant: 'error', title: 'تعذّر تحميل الموظفين', text: blockReason(result),
            action: { label: 'إعادة المحاولة', retry: 'hr-employees', variant: 'btn-primary' }
        });
        return;
    }
    const data = result.data || {};
    const rows = Array.isArray(data.rows) ? data.rows.map(employeeRowForDisplay) : [];
    empState.rows = rows;
    empState.total = Number(data.total_count || data.total || 0);
    empState.loaded = true;
    const view = hrPaginationView(empState.total, page, pageSize);
    if (!rows.length) {
        renderState(list, {
            variant: 'empty', title: 'لا يوجد موظفون بعد',
            text: empState.search || empState.status ? 'لا تطابق نتائجُ البحث أي موظف.' : 'أضف أول موظف أو استورد ملف CSV من صفحة الاستيراد.'
        });
        return;
    }
    list.innerHTML = `
        <table class="data-table"><thead><tr>
            <th>الرقم الوظيفي</th><th>الاسم</th><th>الهاتف</th><th>البريد</th>
            <th>الرقم القومي</th><th>القسم</th><th>الفرع</th><th>الحالة</th><th>إجراءات</th>
        </tr></thead><tbody>
        ${rows.map(r => `<tr>
            <td dir="ltr">${esc(r.employeeNumber)}</td>
            <td>${esc(r.fullName)}</td><td dir="ltr">${esc(r.phone)}</td><td dir="ltr">${esc(r.email)}</td>
            <td dir="ltr">${esc(r.nationalId)}</td><td>${esc(r.departmentName)}</td><td>${esc(r.branchName)}</td>
            <td>${pill(r.statusInfo)}</td>
            <td><button type="button" class="btn-ghost" data-hr-view="${esc(r.id)}">عرض</button>
                <button type="button" class="btn-ghost" data-hr-edit="${esc(r.id)}">تعديل</button>
                ${r.status === 'terminated'
                    ? `<button type="button" class="btn-ghost" data-hr-reactivate="${esc(r.id)}">إعادة تفعيل</button>`
                    : `<button type="button" class="btn-ghost" data-hr-archive="${esc(r.id)}">أرشفة</button>`}
            </td></tr>`).join('')}
        </tbody></table>
        <div class="pager" data-hr-pager>
            <button type="button" class="btn-ghost" data-hr-prev ${view.hasPrev ? '' : 'disabled'}>السابقة</button>
            <span>صفحة ${esc(String(view.page))} من ${esc(String(view.totalPages))} — ${esc(String(view.total))} موظفًا</span>
            <button type="button" class="btn-ghost" data-hr-next ${view.hasNext ? '' : 'disabled'}>التالية</button>
        </div>`;
    list.querySelector('[data-hr-prev]')?.addEventListener('click', () => { empState.page = view.page - 1; refreshEmployeesList(container); });
    list.querySelector('[data-hr-next]')?.addEventListener('click', () => { empState.page = view.page + 1; refreshEmployeesList(container); });
    list.querySelectorAll('[data-hr-view]').forEach(b => b.addEventListener('click', () => showEmployeeDetail(b.getAttribute('data-hr-view'), container)));
    list.querySelectorAll('[data-hr-edit]').forEach(b => b.addEventListener('click', () => openEmployeeForm(b.getAttribute('data-hr-edit'), container)));
    list.querySelectorAll('[data-hr-archive]').forEach(b => b.addEventListener('click', () => archiveEmployee(b.getAttribute('data-hr-archive'), container)));
    list.querySelectorAll('[data-hr-reactivate]').forEach(b => b.addEventListener('click', () => reactivateEmployee(b.getAttribute('data-hr-reactivate'), container)));
}

async function showEmployeeDetail(employeeId, container) {
    const slot = document.getElementById('hrEmpFormSlot');
    if (!slot) return;
    slot.innerHTML = '<p class="muted">جارٍ تحميل التفاصيل…</p>';
    const result = await fetchHrEmployeeDetail(employeeId);
    if (!result.ok) {
        slot.innerHTML = `<p class="error-text">${esc(blockReason(result))}</p>`;
        return;
    }
    const d = result.data || {};
    const row = employeeRowForDisplay(d);
    const history = Array.isArray(d.status_history) ? d.status_history : [];
    slot.innerHTML = `
        <div class="hr-detail-card">
            <h3>${esc(row.fullName)} <small dir="ltr">${esc(row.employeeNumber)}</small></h3>
            <dl>
                <dt>الهاتف</dt><dd dir="ltr">${esc(row.phone)}</dd>
                <dt>البريد</dt><dd dir="ltr">${esc(row.email)}</dd>
                <dt>الرقم القومي</dt><dd dir="ltr">${esc(d.national_id || row.nationalId)}</dd>
                <dt>القسم / الفرع / المسمى</dt><dd>${esc(row.departmentName)} / ${esc(row.branchName)} / ${esc(row.positionName)}</dd>
                <dt>المدير</dt><dd>${esc(row.managerName)}</dd>
                <dt>المسمى الحر</dt><dd>${esc(row.jobTitle)}</dd>
                <dt>تاريخ التعيين</dt><dd>${esc(row.hireDate || '—')}</dd>
                <dt>نوع العقد</dt><dd>${esc(row.contractType || '—')}</dd>
                <dt>الحالة</dt><dd>${pill(row.statusInfo)}</dd>
                <dt>حساب مرتبط</dt><dd>${row.linked ? 'مرتبط بحساب' : 'بلا حساب مرتبط'}</dd>
            </dl>
            <h4>سجل الحالات</h4>
            ${history.length ? `<ul>${history.map(h => `<li>${esc(h.created_at || '')} — ${esc(employeeStatusInfo(h.to_status).label)} — ${esc(h.reason || '')}</li>`).join('')}</ul>` : '<p class="muted">لا يوجد سجل حالات بعد.</p>'}
            <button type="button" class="btn-ghost" data-hr-close-detail>إغلاق</button>
        </div>`;
    slot.querySelector('[data-hr-close-detail]')?.addEventListener('click', () => { slot.innerHTML = ''; });
}

function employeeFormHtml(values, orgs) {
    const v = values || {};
    return `
        <form class="hr-form" data-hr-emp-form>
            <h3>${v.id ? 'تعديل موظف' : 'إضافة موظف'}</h3>
            <div class="form-grid">
                <label>الاسم الكامل <input name="fullName" required value="${esc(v.fullName || '')}"></label>
                <label>الرقم الوظيفي (اختياري — يُولَّد تلقائيًا) <input name="employeeNumber" dir="ltr" value="${esc(v.employeeNumber || '')}" ${v.id ? 'disabled' : ''}></label>
                <label>الهاتف <input name="phone" dir="ltr" value="${esc(v.phone || '')}"></label>
                <label>البريد الإلكتروني <input name="email" type="email" dir="ltr" value="${esc(v.email || '')}"></label>
                <label>الرقم القومي <input name="nationalId" dir="ltr" value="${esc(v.nationalId || '')}"></label>
                <label>تاريخ التعيين <input name="hireDate" type="date" value="${esc(v.hireDate || '')}"></label>
                <label>نوع العقد <select name="contractType">
                    <option value="">—</option>
                    ${['full_time', 'part_time', 'contract', 'intern', 'temporary'].map(c => `<option value="${c}" ${v.contractType === c ? 'selected' : ''}>${esc({ full_time: 'دوام كامل', part_time: 'دوام جزئي', contract: 'عقد', intern: 'تدريب', temporary: 'مؤقت' }[c])}</option>`).join('')}
                </select></label>
                <label>القسم <select name="departmentId">${orgOptions(orgs.departments, v.departmentId, 'بلا قسم')}</select></label>
                <label>الفرع <select name="branchId">${orgOptions(orgs.branches, v.branchId, 'بلا فرع')}</select></label>
                <label>المسمى الوظيفي <select name="positionId">${orgOptions(orgs.positions, v.positionId, 'بلا مسمى')}</select></label>
                <label>المسمى الحر <input name="jobTitle" value="${esc(v.jobTitle || '')}"></label>
                <label>تاريخ الميلاد <input name="dateOfBirth" type="date" value="${esc(v.dateOfBirth || '')}"></label>
                <label>العنوان <input name="address" value="${esc(v.address || '')}"></label>
            </div>
            <p class="muted">الأرشفة وحالة الموظف وتعديل الرقم الوظيفي ليست هنا؛ الحالة من
            إجراءات القائمة، والرقم الوظيفي لا يتغير بعد الإنشاء.</p>
            <div class="form-actions">
                <button type="submit" class="btn-primary">${v.id ? 'حفظ التعديلات' : 'إضافة الموظف'}</button>
                <button type="button" class="btn-ghost" data-hr-cancel-form>إلغاء</button>
            </div>
            <p class="error-text" data-hr-form-error hidden></p>
        </form>`;
}

async function openEmployeeForm(employeeId, container) {
    const slot = document.getElementById('hrEmpFormSlot');
    if (!slot) return;
    await ensureOrgCache();
    let values = null;
    if (employeeId) {
        const result = await fetchHrEmployeeDetail(employeeId);
        if (!result.ok) {
            slot.innerHTML = `<p class="error-text">${esc(blockReason(result))}</p>`;
            return;
        }
        const d = result.data || {};
        values = {
            id: d.id, fullName: d.full_name, employeeNumber: d.employee_number, phone: d.phone,
            email: d.email, nationalId: d.national_id, departmentId: d.department_id,
            branchId: d.branch_id, positionId: d.position_id, jobTitle: d.job_title,
            hireDate: d.hire_date, contractType: d.contract_type,
            dateOfBirth: d.date_of_birth, address: d.address
        };
    }
    slot.innerHTML = employeeFormHtml(values, orgCache);
    const form = slot.querySelector('[data-hr-emp-form]');
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const fields = {
            fullName: String(fd.get('fullName') || '').trim(),
            employeeNumber: String(fd.get('employeeNumber') || '').trim(),
            phone: String(fd.get('phone') || '').trim(),
            email: String(fd.get('email') || '').trim(),
            nationalId: String(fd.get('nationalId') || '').trim(),
            departmentId: String(fd.get('departmentId') || '') || null,
            branchId: String(fd.get('branchId') || '') || null,
            positionId: String(fd.get('positionId') || '') || null,
            jobTitle: String(fd.get('jobTitle') || '').trim(),
            hireDate: String(fd.get('hireDate') || '') || null,
            contractType: String(fd.get('contractType') || '') || null,
            dateOfBirth: String(fd.get('dateOfBirth') || '') || null,
            address: String(fd.get('address') || '').trim()
        };
        const check = validateEmployeeForm(fields);
        const errEl = form.querySelector('[data-hr-form-error]');
        if (!check.isValid) {
            errEl.textContent = Object.values(check.errors)[0];
            errEl.hidden = false;
            return;
        }
        const result = values?.id
            ? await updateHrEmployee(values.id, fields)
            : await createHrEmployee(fields);
        if (!result.ok) {
            errEl.textContent = blockReason(result);
            errEl.hidden = false;
            return;
        }
        slot.innerHTML = '';
        await refreshEmployeesList(container);
    });
    slot.querySelector('[data-hr-cancel-form]')?.addEventListener('click', () => { slot.innerHTML = ''; });
}

async function archiveEmployee(employeeId, container) {
    const row = empState.rows.find(r => r.id === employeeId);
    const reason = await askReason(`أرشفة الموظف ${row ? row.fullName : ''}`);
    if (!reason) return;
    const result = await archiveHrEmployee(employeeId, reason);
    if (!result.ok) {
        window.alert(blockReason(result));
        return;
    }
    await refreshEmployeesList(container);
}

async function reactivateEmployee(employeeId, container) {
    const reason = await askReason('إعادة تفعيل الموظف المؤرشف');
    if (!reason) return;
    const result = await reactivateHrEmployee(employeeId, reason);
    if (!result.ok) {
        window.alert(blockReason(result));
        return;
    }
    await refreshEmployeesList(container);
}

/* ── الأقسام والفروع والمسميات ─────────────────────────────────────────── */

async function loadOrgSection(kind, container) {
    const labels = { departments: 'الأقسام', branches: 'الفروع', positions: 'المسميات' };
    const fetchers = { departments: fetchHrDepartments, branches: fetchHrBranches, positions: fetchHrPositions };
    const creators = { departments: createHrDepartment, branches: createHrBranch, positions: createHrPosition };
    const archivers = { departments: archiveHrDepartment, branches: archiveHrBranch, positions: archiveHrPosition };
    const listEl = document.getElementById(`hr${kind[0].toUpperCase()}${kind.slice(1)}List`);
    if (!listEl) return;
    renderState(listEl, { variant: 'loading', title: `جارٍ تحميل ${labels[kind]}…`, text: '' });
    const result = await fetchers[kind](false);
    if (!result.ok) {
        renderState(listEl, {
            variant: 'error', title: `تعذّر تحميل ${labels[kind]}`, text: blockReason(result),
            action: { label: 'إعادة المحاولة', retry: 'hr-departments', variant: 'btn-primary' }
        });
        return;
    }
    const rows = Array.isArray(result.data) ? result.data : [];
    const { tree, errors } = buildOrgTree(rows);
    const renderNode = (node) => `<li>
        <span>${esc(node.name)}</span>
        <small class="muted">${esc(String(node.employees_count || 0))} موظفًا · عمق ${esc(String(node.depth))}</small>
        <button type="button" class="btn-ghost" data-hr-org-archive="${esc(node.id)}" data-hr-org-kind="${kind}">أرشفة</button>
        ${node.children.length ? `<ul>${node.children.map(renderNode).join('')}</ul>` : ''}
    </li>`;
    listEl.innerHTML = `
        ${errors.length ? `<p class="error-text">${esc(errors.map(e => e.reason).join(' — '))}</p>` : ''}
        ${tree.length ? `<ul class="hr-tree">${tree.map(renderNode).join('')}</ul>`
            : `<p class="muted">لا توجد ${labels[kind]} بعد — أنشئ أول ${labels[kind].slice(0, -1)} من النموذج أدناه.</p>`}
        <form class="hr-inline-form" data-hr-org-form="${kind}">
            <input name="name" required placeholder="اسم جديد" aria-label="اسم جديد">
            <select name="parentId" aria-label="الأب">${orgOptions(rows, null, 'بلا أب (مستوى أول)')}</select>
            <button type="submit" class="btn-primary">إضافة</button>
            <span class="error-text" data-hr-org-error hidden></span>
        </form>`;
    listEl.querySelector(`[data-hr-org-form="${kind}"]`)?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const name = String(fd.get('name') || '').trim();
        const parentId = String(fd.get('parentId') || '') || null;
        const res = await creators[kind]({ name, parentId, sortOrder: 0 });
        if (!res.ok) {
            const errEl = listEl.querySelector('[data-hr-org-error]');
            errEl.textContent = blockReason(res);
            errEl.hidden = false;
            return;
        }
        orgCache.loaded = false;
        await loadOrgSection(kind, container);
    });
    listEl.querySelectorAll('[data-hr-org-archive]').forEach(b => b.addEventListener('click', async () => {
        const reason = await askReason(`أرشفة ${labels[kind].slice(0, -1)}`);
        if (!reason) return;
        const res = await archivers[kind](b.getAttribute('data-hr-org-archive'), reason);
        if (!res.ok) { window.alert(blockReason(res)); return; }
        orgCache.loaded = false;
        await loadOrgSection(kind, container);
    }));
}

export async function loadHrDepartments() {
    const container = document.getElementById('hrDepartmentsBody');
    if (!container) return;
    await Promise.all([
        loadOrgSection('departments', container),
        loadOrgSection('branches', container),
        loadOrgSection('positions', container)
    ]);
}

/* ── الاستيراد ─────────────────────────────────────────────────────────── */

const importState = { rows: [], valid: [], invalid: [], fileName: null, key: null, ran: null };

export function loadHrImport() {
    const container = document.getElementById('hrImportBody');
    if (!container) return;
    container.innerHTML = `
        <div class="hr-import-intro">
            <p>استورد ملف CSV بحد أقصى ${HR_IMPORT_MAX_ROWS} صفًا. ترتيب الأعمدة في القالب:
            الرقم الوظيفي، الاسم، الهاتف، البريد، الرقم القومي، القسم، الفرع، المسمى،
            رقم المدير، المسمى الحر، تاريخ التعيين، نوع العقد. الرقم الوظيفي الفارغ
            يُولَّد تلقائيًا، والصف بلا هاتف ولا بريد يُنشأ بحالة «بيانات ناقصة».</p>
            <p class="muted">الاستيراد لا ينشئ أي حساب دخول أبدًا — ملفات موظفين فقط،
            والربط بحساب قائم يتم لاحقًا من صفحة الموظفين بموافقة مدقَّقة.</p>
            <div class="hr-toolbar-row">
                <button type="button" class="btn-ghost" id="hrImportTemplateBtn">تنزيل القالب</button>
                <label class="btn-primary">اختيار ملف CSV <input type="file" id="hrImportFile" accept=".csv,text/csv" hidden></label>
                <button type="button" class="btn-ghost" id="hrImportRunsBtn">سجل عمليات الاستيراد السابقة</button>
            </div>
        </div>
        <div id="hrImportPreview"></div>
        <div id="hrImportResult"></div>
        <div id="hrImportRuns"></div>`;
    document.getElementById('hrImportTemplateBtn').addEventListener('click', () => {
        downloadText('hr-import-template.csv', hrImportTemplateCsv());
    });
    document.getElementById('hrImportFile').addEventListener('change', (e) => {
        const file = e.target.files?.[0];
        if (file) handleImportFile(file, container);
    });
    document.getElementById('hrImportRunsBtn').addEventListener('click', () => loadImportRuns(container));
}

async function handleImportFile(file, container) {
    const preview = document.getElementById('hrImportPreview');
    const resultBox = document.getElementById('hrImportResult');
    if (resultBox) resultBox.innerHTML = '';
    if (file.size > HR_IMPORT_MAX_FILE_BYTES) {
        renderState(preview, { variant: 'error', title: 'الملف كبير جدًا', text: 'الحد الأقصى لحجم الملف 1 ميجابايت.' });
        return;
    }
    renderState(preview, { variant: 'loading', title: 'جارٍ قراءة الملف…', text: '' });
    const text = await file.text();
    const { rows, errors } = parseHrEmployeesCsv(text);
    const limit = checkHrImportLimit(rows.length);
    if (!limit.ok) {
        renderState(preview, { variant: 'error', title: 'تعذّر استيراد الملف', text: limit.error });
        return;
    }
    const [depts, branches, positions, countRes] = await Promise.all([
        fetchHrDepartments(false), fetchHrBranches(false), fetchHrPositions(false), fetchHrEmployeesCount()
    ]);
    // لقطة محلية للتحقق الأولي فقط — القرار النهائي للخادم.
    const existingNumbers = [];
    const existingEmails = [];
    const existingNids = [];
    const existingEmployees = [];
    if (countRes.ok && (countRes.data?.total || 0) > 0) {
        const all = await fetchHrEmployees({ page: 1, pageSize: HR_PAGE_SIZE_MAX, includeTerminated: true });
        if (all.ok) {
            for (const r of all.data?.rows || []) {
                existingNumbers.push(r.employee_number);
                existingEmails.push(r.email);
                existingNids.push(r.national_id);
                existingEmployees.push(r);
            }
        }
    }
    const { valid, invalid } = validateHrImportRows(rows, {
        existingNumbers, existingEmails, existingNids,
        departments: (depts.data || []).map(d => d.name),
        branches: (branches.data || []).map(b => b.name),
        positions: (positions.data || []).map(p => p.name),
        existingEmployees
    });
    importState.rows = rows;
    importState.valid = valid;
    importState.invalid = invalid;
    importState.fileName = file.name;
    importState.key = uuid();
    importState.ran = null;
    const rowHtml = (r, ok) => `<tr class="${ok ? '' : 'row-invalid'}">
        <td>${esc(String(r.line))}</td><td dir="ltr">${esc(r.employee_number || '—')}</td>
        <td>${esc(r.full_name)}</td><td dir="ltr">${esc(r.phone || '—')}</td><td dir="ltr">${esc(r.email || '—')}</td>
        <td>${ok ? 'جاهز' : esc(r.reason || 'مرفوض')}</td></tr>`;
    preview.innerHTML = `
        <p class="muted"><strong>تحقق أولي</strong> — بناءً على آخر لقطة محملة؛ القرار النهائي
        لخادم الاستيراد، وقد يرفض صفًا بدا جاهزًا (مثلًا: رقم أُنشئ بعد تحميل الصفحة).</p>
        ${errors.length ? `<p class="error-text">${errors.map(e => `سطر ${e.line}: ${e.reason}`).join(' — ')}</p>` : ''}
        <p>${valid.length} صفًا جاهزًا من ${rows.length}، و${invalid.length} صفًا مرفوضًا أوليًا.</p>
        <table class="data-table"><thead><tr>
            <th>السطر</th><th>الرقم الوظيفي</th><th>الاسم</th><th>الهاتف</th><th>البريد</th><th>الحالة</th>
        </tr></thead><tbody>
        ${valid.map(r => rowHtml(r, true)).join('')}
        ${invalid.map(r => rowHtml(r, false)).join('')}
        </tbody></table>
        <div class="form-actions">
            <button type="button" class="btn-primary" id="hrImportRunBtn" ${valid.length ? '' : 'disabled'}>
                استيراد ${valid.length} صفًا جاهزًا (نداء واحد)</button>
            <button type="button" class="btn-ghost" id="hrImportCancelBtn">إلغاء</button>
        </div>`;
    document.getElementById('hrImportRunBtn')?.addEventListener('click', () => runImport(container));
    document.getElementById('hrImportCancelBtn')?.addEventListener('click', () => {
        preview.innerHTML = '';
        importState.rows = [];
    });
}

async function runImport(container) {
    const resultBox = document.getElementById('hrImportResult');
    const btn = document.getElementById('hrImportRunBtn');
    if (btn) btn.disabled = true;
    renderState(resultBox, { variant: 'loading', title: 'جارٍ الاستيراد…', text: 'نداء واحد إلى الخادم؛ لا تغلق الصفحة.' });
    const payload = importState.valid.map(r => ({
        line: r.line, employee_number: r.employee_number || null, full_name: r.full_name,
        phone: r.phone || null, email: r.email || null, national_id: r.national_id || null,
        department: r.department || null, branch: r.branch || null, position: r.position || null,
        manager_employee_number: r.manager_employee_number || null, job_title: r.job_title || null,
        hire_date: r.hire_date || null, contract_type: r.contract_type || null,
        date_of_birth: r.date_of_birth || null, address: r.address || null
    }));
    const result = await importHrEmployees(payload, importState.key, importState.fileName);
    if (!result.ok) {
        renderState(resultBox, {
            variant: 'error', title: 'تعذّر الاستيراد', text: blockReason(result),
            action: { label: 'إعادة المحاولة', retry: 'hr-import', variant: 'btn-primary' }
        });
        if (btn) btn.disabled = false;
        return;
    }
    const data = result.data || {};
    const results = Array.isArray(data.results) ? data.results : [];
    const summary = summarizeHrImportResults(results);
    importState.ran = { results, summary, idempotencyKey: importState.key };
    resultBox.innerHTML = `
        <h3>نتيجة الاستيراد — ${esc(importState.fileName || '')}</h3>
        <p>أُدخل ${summary.inserted}، مكرر ${summary.duplicate}، مرفوض ${summary.invalid}، من ${summary.total} صفًا.</p>
        <table class="data-table"><thead><tr>
            <th>السطر</th><th>الرقم الوظيفي</th><th>الحالة</th><th>السبب</th>
        </tr></thead><tbody>
        ${results.map(r => `<tr>
            <td>${esc(String(r.line))}</td><td dir="ltr">${esc(r.employee_number || '—')}</td>
            <td>${r.status === 'inserted' ? 'أُدخل' : r.status === 'duplicate' ? 'مكرر' : 'مرفوض'}</td>
            <td>${esc(r.reason || '')}</td></tr>`).join('')}
        </tbody></table>
        <div class="form-actions">
            <button type="button" class="btn-ghost" id="hrImportReportBtn">تنزيل التقرير CSV</button>
            <button type="button" class="btn-ghost" id="hrImportAgainBtn">استيراد ملف آخر</button>
        </div>`;
    document.getElementById('hrImportReportBtn')?.addEventListener('click', () => {
        downloadText('hr-import-report.csv', hrImportResultsToCsv(results));
    });
    document.getElementById('hrImportAgainBtn')?.addEventListener('click', () => {
        document.getElementById('hrImportPreview').innerHTML = '';
        resultBox.innerHTML = '';
    });
    // حدّث القائمة بعد الاستيراد إن كانت محمّلة
    empState.loaded = false;
}

async function loadImportRuns(container) {
    const box = document.getElementById('hrImportRuns');
    if (!box) return;
    renderState(box, { variant: 'loading', title: 'جارٍ تحميل سجل الاستيراد…', text: '' });
    const result = await fetchHrImportRuns({ page: 1, pageSize: 20 });
    if (!result.ok) {
        renderState(box, { variant: 'error', title: 'تعذّر تحميل سجل الاستيراد', text: blockReason(result) });
        return;
    }
    const data = result.data || {};
    const rows = Array.isArray(data.rows) ? data.rows : [];
    if (!rows.length) {
        renderState(box, { variant: 'empty', title: 'لا توجد عمليات استيراد سابقة', text: '' });
        return;
    }
    box.innerHTML = `<table class="data-table"><thead><tr>
        <th>الملف</th><th>الحالة</th><th>الصفوف</th><th>أُدخل</th><th>مكرر</th><th>مرفوض</th><th>التاريخ</th><th></th>
    </tr></thead><tbody>
    ${rows.map(r => `<tr>
        <td>${esc(r.file_name || '—')}</td><td>${esc(r.status)}</td>
        <td>${esc(String(r.total_rows))}</td><td>${esc(String(r.inserted_count))}</td>
        <td>${esc(String(r.duplicate_count))}</td><td>${esc(String(r.invalid_count))}</td>
        <td>${esc(r.created_at || '')}</td>
        <td><button type="button" class="btn-ghost" data-hr-run="${esc(r.id)}">التفاصيل</button></td>
    </tr>`).join('')}</tbody></table>`;
    box.querySelectorAll('[data-hr-run]').forEach(b => b.addEventListener('click', async () => {
        const detail = await fetchHrImportRunDetail(b.getAttribute('data-hr-run'));
        if (!detail.ok) { window.alert(blockReason(detail)); return; }
        const d = detail.data || {};
        const results = Array.isArray(d.results) ? d.results : [];
        const summary = summarizeHrImportResults(results);
        const resultBox = document.getElementById('hrImportResult');
        if (!resultBox) return;
        resultBox.innerHTML = `
            <h3>تفاصيل عملية استيراد — ${esc(d.file_name || '')}</h3>
            <p>أُدخل ${summary.inserted}، مكرر ${summary.duplicate}، مرفوض ${summary.invalid}، من ${summary.total} صفًا.</p>
            <table class="data-table"><thead><tr>
                <th>السطر</th><th>الرقم الوظيفي</th><th>الحالة</th><th>السبب</th>
            </tr></thead><tbody>
            ${results.map(r => `<tr>
                <td>${esc(String(r.line))}</td><td dir="ltr">${esc(r.employee_number || '—')}</td>
                <td>${r.status === 'inserted' ? 'أُدخل' : r.status === 'duplicate' ? 'مكرر' : 'مرفوض'}</td>
                <td>${esc(r.reason || '')}</td></tr>`).join('')}
            </tbody></table>`;
    }));
}

/* ── الإعدادات (بادئة الرقم الوظيفي) ──────────────────────────────────── */

export async function loadHrSettings() {
    const container = document.getElementById('hrSettingsBody');
    if (!container) return;
    renderState(container, { variant: 'loading', title: 'جارٍ تحميل إعدادات الموارد البشرية…', text: '' });
    const result = await fetchHrSettings();
    if (!result.ok) {
        renderState(container, { variant: 'error', title: 'تعذّر تحميل الإعدادات', text: blockReason(result) });
        return;
    }
    const s = result.data || {};
    container.innerHTML = `
        <form class="hr-form" data-hr-settings-form>
            <div class="form-grid">
                <label>بادئة الرقم الوظيفي <input name="prefix" dir="ltr" value="${esc(s.employee_number_prefix || 'EMP')}"></label>
                <label>يبدأ الترقيم من <input name="startFrom" type="number" min="0" value="${esc(String(s.employee_number_start_from ?? 0))}"></label>
            </div>
            <div class="form-actions">
                <button type="submit" class="btn-primary">حفظ الإعدادات</button>
            </div>
            <p class="error-text" data-hr-settings-error hidden></p>
        </form>`;
    container.querySelector('[data-hr-settings-form]')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const res = await updateHrSettings({
            prefix: String(fd.get('prefix') || 'EMP').trim(),
            startFrom: Number(fd.get('startFrom') || 0)
        });
        const errEl = container.querySelector('[data-hr-settings-error]');
        if (!res.ok) {
            errEl.textContent = blockReason(res);
            errEl.hidden = false;
            return;
        }
        await loadHrSettings();
    });
}

/** نقطة دخول واحدة من company-dashboard.js: ربط أزرار إعادة المحاولة. */
export function initHrDashboard() {
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-retry]');
        if (!btn) return;
        const section = btn.getAttribute('data-retry');
        if (section === 'hr-overview') loadHrOverview();
        if (section === 'hr-employees') loadHrEmployees();
        if (section === 'hr-departments') loadHrDepartments();
        if (section === 'hr-import') loadHrImport();
    });
}
