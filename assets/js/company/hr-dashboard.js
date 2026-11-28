/**
 * hr-dashboard.js — واجهة وحدة الموارد البشرية في لوحة الشركة (الترحيل 143).
 *
 *   Pages: hr-overview / hr-employees / hr-departments / hr-import / hr-leave
 *   / hr-attendance / hr-reports
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
 *   - الإجازات (الترحيل 154): أنواع (hr_leave_types_list/create/archive)،
 *     أرصدة سنوية (hr_leave_balances_list/set)، طلبات (hr_leave_request_create
 *     وhr_leave_requests_list/detail والبتّ hr_leave_request_decide — الخصم
 *     عند الاعتماد فقط). لو القسم غير مفعّل تظهر حالة «غير مفعّل» صريحة
 *     بلا أرقام وهمية — القرار في القاعدة.
 *   - الحضور والانصراف (الترحيل 155): ورديات (hr_shifts_list/create/update)
 *     وإسنادها (hr_shift_assign)، وتسجيل اليوم من ساعة الخادم
 *     (hr_attendance_today/check_in/check_out)، وسجلات بترقيم خادم
 *     (hr_attendance_list) مع تصحيح موثق (hr_attendance_correct)، وملخص
 *     شهري (hr_attendance_summary — الغياب مشتق لا مخزَّن). لو القسم غير
 *     مفعّل تظهر حالة «غير مفعّل» صريحة بلا أرقام وهمية — القرار في القاعدة.
 *   - التذاكر (الترحيل 156 — قراءة فقط): إحصاءات التذاكر المسندة للموظف
 *     عبر حسابه المرتبط (hr_employee_ticket_stats) في تفاصيل الموظف،
 *     وعمود ملخص في القائمة (hr_employees_ticket_summary — نداء واحد
 *     للصفحة). بلا حساب مرتبط تظهر رسالة صريحة بدل أصفار موهمة.
 *   - الربط بالحساب (الترحيل 159): زر «ربط بحساب» في تفاصيل الموظف غير
 *     المرتبط (منتقٍ من أعضاء الشركة + سبب موثق) وزر «فك الربط» للمرتبط؛
 *     الربط يسجّل الحساب أيضًا في فريق الشركة (company_staff بدور agent)
 *     فيظهر في شجرة الحسابات كموظف شركة ويصبح مؤهلًا لإسناد التذاكر.
 *     فك الربط لا يلغي عضوية الفريق (تُلغى من إدارة الفريق).
 *   - التقارير (الترحيل 157 — قراءة فقط): العدد حسب القسم والحالة،
 *     والحضور حسب القسم (تجميع hr_attendance_summary)، والإجازات حسب
 *     النوع والقسم (أرصدة hr_leave_balances_list + استخدام الفترة)،
 *     والتذاكر حسب الموظف والقسم (hr_employee_ticket_stats +
 *     hr_department_ticket_stats). الفترة الافتراضية الشهر الحالي حتى
 *     اليوم. بلوك مصدره غير مفعّل يظهر ملاحظة صريحة بدل أرقام وهمية.
 *   - لو بلا استحقاق: حالة حجب صريحة بلا أرقام وهمية؛ مفيش أرقام تظهر
 *     قبل رجوع القاعدة (صفر يُعرض فقط بعد رجوع القاعدة بقيم صفرية).
 *
 *   حالة الحجب (renderState) من portal-ui.js، والهروب من escapeHtml —
 *   نفس أدوات company-dashboard.js.
 */

import { renderState, escapeHtml as esc } from '/assets/js/customer/portal-ui.js';
import { icon } from '/assets/js/company/company-ui.js';
import {
    employeeRowForDisplay, employeeStatusInfo, hrPageParams, hrPaginationView,
    parseHrEmployeesCsv, checkHrImportLimit, validateHrImportRows, summarizeHrImportResults,
    hrImportTemplateCsv, hrImportResultsToCsv, buildOrgTree, HR_IMPORT_MAX_ROWS,
    HR_IMPORT_MAX_FILE_BYTES, HR_PAGE_SIZE_MAX, validateEmployeeForm, HR_SECTION_LABELS, maskNationalId,
    leaveStatusInfo, leaveRequestRowForDisplay, leaveBalanceRowForDisplay,
    validateLeaveRequestForm, validateLeaveTypeForm, leaveDaysBetween,
    formatHrDuration, ticketRowForDisplay, employeeTicketSummaryText,
    attendanceStatusInfo, attendanceRowForDisplay, attendanceWorkingDaysLabel,
    attendanceTimeLabel, formatWorkedMinutes, validateShiftForm, HR_WEEKDAYS,
    hrReportMonthDefaults, validateReportPeriod, hrReportShareLabel,
    headcountRowForDisplay, reportAttendanceRowForDisplay, reportLeaveRowForDisplay,
    reportTicketEmployeeRowForDisplay, reportTicketDepartmentRowForDisplay
} from '/assets/js/company/hr-model.js';
import {
    fetchHrEmployees, fetchHrEmployeesCount, fetchHrEmployeeDetail,
    linkHrEmployeeAccount, unlinkHrEmployeeAccount, fetchHrLinkCandidates,
    createHrEmployee, updateHrEmployee, archiveHrEmployee, reactivateHrEmployee,
    setHrEmployeeStatus, fetchHrDepartments, createHrDepartment, updateHrDepartment,
    archiveHrDepartment, fetchHrBranches, createHrBranch, updateHrBranch, archiveHrBranch,
    fetchHrPositions, createHrPosition, updateHrPosition, archiveHrPosition,
    fetchHrSettings, updateHrSettings, importHrEmployees, fetchHrImportRuns, fetchHrImportRunDetail,
    fetchHrLeaveTypes, createHrLeaveType, archiveHrLeaveType,
    fetchHrLeaveBalances, setHrLeaveBalance,
    createHrLeaveRequest, decideHrLeaveRequest, fetchHrLeaveRequests, fetchHrLeaveRequestDetail,
    fetchHrEmployeeTicketStats, fetchHrEmployeesTicketSummary,
    fetchHrShifts, createHrShift, updateHrShift, assignHrShift,
    checkInHrAttendance, checkOutHrAttendance, correctHrAttendance,
    fetchHrAttendanceToday, fetchHrAttendanceList, fetchHrAttendanceSummary,
    fetchHrReportsHeadcount, fetchHrReportsAttendance, fetchHrReportsLeave, fetchHrReportsTickets
} from '/assets/js/company/hr-data.js';

/* ── أدوات محلية ───────────────────────────────────────────────────────── */

function blockReason(err) {
    const msg = String(err?.error || err?.message || err || '');
    if (/لا يملك الشركة/.test(msg) || /لا يملك صلاحية/.test(msg)) return 'صلاحية غير كافية لهذا الإجراء';
    if (/غير مفعّل/.test(msg)) return 'هذا القسم غير مفعّل لشركتك — يفعّله مالك المنصة لكل قسم على حدة';
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
            <textarea class="form-control" data-hr-reason rows="3"></textarea>
            <p class="error-text" data-hr-reason-error hidden></p>
            <div class="form-actions">
                <button type="button" class="btn btn-primary" data-hr-reason-ok>تأكيد</button>
                <button type="button" class="btn btn-ghost" data-hr-reason-cancel>إلغاء</button>
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
    return `<span class="pill ${esc(statusInfo.pill)}">${esc(statusInfo.label)}</span>`;
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
    const statusTone = { active: 'kpi--success', on_leave: 'kpi--warning', suspended: 'kpi--danger', terminated: '', pending_data: 'kpi--warning' };
    const statusIcon = { active: 'check', on_leave: 'clock', suspended: 'warning', terminated: 'inbox', pending_data: 'info' };
    const statusCards = Object.entries(byStatus).map(([status, n]) => {
        const info = employeeStatusInfo(status);
        return `<div class="kpi ${statusTone[status] || ''}">
            <p class="kpi-label">${icon(statusIcon[status] || 'info', 16)}${esc(info.label)}</p>
            <p class="kpi-value">${esc(String(n))}</p>
        </div>`;
    }).join('');
    container.innerHTML = `
        <div class="kpi-grid">
            <div class="kpi kpi--accent">
                <p class="kpi-label">${icon('users', 16)}إجمالي الموظفين</p>
                <p class="kpi-value">${esc(String(counts.total || 0))}</p>
                <p class="kpi-hint">ملفات موظفين في قاعدة البيانات</p>
            </div>
            ${statusCards}
            <div class="kpi">
                <p class="kpi-label">${icon('briefcase', 16)}الأقسام</p>
                <p class="kpi-value">${esc(String(depts.length))}</p>
                <p class="kpi-hint">هيكل حتى 6 مستويات</p>
            </div>
            <div class="kpi">
                <p class="kpi-label">${icon('chart', 16)}الفروع</p>
                <p class="kpi-value">${esc(String(branches.length))}</p>
                <p class="kpi-hint">فروع الشركة</p>
            </div>
        </div>
        <section class="panel" aria-labelledby="hrNextStepsHeading">
            <div class="panel-header"><div>
                <h2 class="panel-title" id="hrNextStepsHeading">الخطوات التالية</h2>
                <p class="panel-subtitle">أضف موظفين أو استورد ملفًا أو نظّم الهيكل — كل رقم هنا من قاعدة البيانات مباشرة.</p>
            </div></div>
            <div class="hr-next-steps">
                <a class="btn btn-primary" href="/company-dashboard/#hrEmployees">إضافة موظف</a>
                <a class="btn btn-ghost" href="/company-dashboard/#hrImport">استيراد ملف CSV</a>
                <a class="btn btn-ghost" href="/company-dashboard/#hrDepartments">إدارة الأقسام والفروع</a>
                <a class="btn btn-ghost" href="/company-dashboard/#hrLeave">الإجازات والأرصدة</a>
                <a class="btn btn-ghost" href="/company-dashboard/#hrAttendance">الحضور والانصراف</a>
                <a class="btn btn-ghost" href="/company-dashboard/#hrReports">التقارير</a>
                <p class="muted">أقسام الرواتب والمهام تُفعَّل من المالك
                كل على حدة، وتظهر هنا حين تُتاح.</p>
            </div>
        </section>`;
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
        <div class="toolbar hr-toolbar">
            <input type="search" class="form-control search-input" id="hrEmpSearch" placeholder="ابحث بالاسم أو الرقم الوظيفي أو الهاتف…" value="${esc(empState.search)}" aria-label="بحث عن موظف">
            <select class="form-control filter-select" id="hrEmpStatus" aria-label="تصفية بالحالة">
                <option value="">كل الحالات</option>
                <option value="active" ${empState.status === 'active' ? 'selected' : ''}>نشط</option>
                <option value="on_leave" ${empState.status === 'on_leave' ? 'selected' : ''}>في إجازة</option>
                <option value="suspended" ${empState.status === 'suspended' ? 'selected' : ''}>موقوف</option>
                <option value="pending_data" ${empState.status === 'pending_data' ? 'selected' : ''}>بيانات ناقصة</option>
            </select>
            <select class="form-control filter-select" id="hrEmpDept" aria-label="تصفية بالقسم">${orgOptions(orgCache.departments, empState.departmentId, 'كل الأقسام')}</select>
            <label class="hr-check"><input type="checkbox" id="hrEmpTerminated" ${empState.includeTerminated ? 'checked' : ''}> إظهار المؤرشفين</label>
            <button type="button" class="btn btn-primary" id="hrEmpAddBtn">+ إضافة موظف</button>
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
        <div class="table-scroll hr-table-sticky"><table class="report-table"><thead><tr>
            <th>الرقم الوظيفي</th><th>الاسم</th><th>الهاتف</th><th>البريد</th>
            <th>الرقم القومي</th><th>القسم</th><th>الفرع</th><th>الحالة</th><th>التذاكر</th><th>إجراءات</th>
        </tr></thead><tbody>
        ${rows.map(r => `<tr>
            <td dir="ltr">${esc(r.employeeNumber)}</td>
            <td>${esc(r.fullName)}</td><td dir="ltr">${esc(r.phone)}</td><td dir="ltr">${esc(r.email)}</td>
            <td dir="ltr">${esc(r.nationalId)}</td><td>${esc(r.departmentName)}</td><td>${esc(r.branchName)}</td>
            <td>${pill(r.statusInfo)}</td>
            <td class="hr-tickets-cell" data-hr-tickets="${esc(r.id)}">—</td>
            <td><button type="button" class="btn btn-ghost btn-sm" data-hr-view="${esc(r.id)}">عرض</button>
                <button type="button" class="btn btn-ghost btn-sm" data-hr-edit="${esc(r.id)}">تعديل</button>
                ${r.status === 'terminated'
                    ? `<button type="button" class="btn btn-ghost btn-sm" data-hr-reactivate="${esc(r.id)}">إعادة تفعيل</button>`
                    : `<button type="button" class="btn btn-ghost btn-sm" data-hr-archive="${esc(r.id)}">أرشفة</button>`}
            </td></tr>`).join('')}
        </tbody></table></div>
        <div class="pager" data-hr-pager>
            <button type="button" class="btn btn-ghost btn-sm" data-hr-prev ${view.hasPrev ? '' : 'disabled'}>السابقة</button>
            <span>صفحة ${esc(String(view.page))} من ${esc(String(view.totalPages))} — ${esc(String(view.total))} موظفًا</span>
            <button type="button" class="btn btn-ghost btn-sm" data-hr-next ${view.hasNext ? '' : 'disabled'}>التالية</button>
        </div>`;
    list.querySelector('[data-hr-prev]')?.addEventListener('click', () => { empState.page = view.page - 1; refreshEmployeesList(container); });
    list.querySelector('[data-hr-next]')?.addEventListener('click', () => { empState.page = view.page + 1; refreshEmployeesList(container); });
    list.querySelectorAll('[data-hr-view]').forEach(b => b.addEventListener('click', () => showEmployeeDetail(b.getAttribute('data-hr-view'), container)));
    list.querySelectorAll('[data-hr-edit]').forEach(b => b.addEventListener('click', () => openEmployeeForm(b.getAttribute('data-hr-edit'), container)));
    list.querySelectorAll('[data-hr-archive]').forEach(b => b.addEventListener('click', () => archiveEmployee(b.getAttribute('data-hr-archive'), container)));
    list.querySelectorAll('[data-hr-reactivate]').forEach(b => b.addEventListener('click', () => reactivateEmployee(b.getAttribute('data-hr-reactivate'), container)));
    fillEmployeeTicketCells(list, rows);
}

/** ملء عمود «التذاكر» بنداء ملخص واحد للصفحة؛ الفشل صامت (تبقى '—')
 *  حتى لا يحجب الملخصُ القائمةَ أبدًا. */
async function fillEmployeeTicketCells(list, rows) {
    if (!rows.length) return;
    const result = await fetchHrEmployeesTicketSummary(rows.map(r => r.id));
    if (!result.ok) return;
    const data = result.data || {};
    const byId = new Map((Array.isArray(data.rows) ? data.rows : []).map(s => [String(s.employee_id), s]));
    list.querySelectorAll('[data-hr-tickets]').forEach(cell => {
        const s = byId.get(String(cell.getAttribute('data-hr-tickets')));
        if (s) cell.textContent = employeeTicketSummaryText(s);
    });
}

async function showEmployeeDetail(employeeId, container) {
    const slot = document.getElementById('hrEmpFormSlot');
    if (!slot) return;
    slot.innerHTML = '<p class="muted">جارٍ تحميل التفاصيل…</p>';
    const [result, statsRes] = await Promise.all([
        fetchHrEmployeeDetail(employeeId),
        fetchHrEmployeeTicketStats(employeeId)
    ]);
    if (!result.ok) {
        slot.innerHTML = `<p class="error-text">${esc(blockReason(result))}</p>`;
        return;
    }
    const d = result.data || {};
    const row = employeeRowForDisplay(d);
    const history = Array.isArray(d.status_history) ? d.status_history : [];
    const stats = statsRes.ok ? (statsRes.data || {}) : null;
    const recent = Array.isArray(stats?.recent_tickets) ? stats.recent_tickets.map(ticketRowForDisplay) : [];
    const ticketsSection = !stats
        ? `<h4>التذاكر</h4><p class="muted">تعذّر تحميل إحصاءات التذاكر — ${esc(blockReason(statsRes))}</p>`
        : !stats.linked
            ? `<h4>التذاكر</h4><p class="muted">هذا الموظف غير مرتبط بحساب دخول — اربطه بحساب لعرض إحصاءات تذاكره (التذاكر تُسند للحساب، لا لملف الموظف).</p>`
            : `<h4>التذاكر (آخر 30 يومًا)</h4>
            <div class="kpi-grid hr-ticket-kpis">
                <div class="kpi"><p class="kpi-label">مفتوحة الآن</p><p class="kpi-value">${esc(String(stats.open_now ?? 0))}</p></div>
                <div class="kpi"><p class="kpi-label">أُسندت خلال 30 يومًا</p><p class="kpi-value">${esc(String(stats.assigned_in_window ?? 0))}</p></div>
                <div class="kpi"><p class="kpi-label">حُلّت خلال 30 يومًا</p><p class="kpi-value">${esc(String(stats.resolved_in_window ?? 0))}</p></div>
                <div class="kpi"><p class="kpi-label">متوسط أول استجابة</p><p class="kpi-value">${esc(formatHrDuration(stats.avg_first_response_seconds))}</p></div>
                <div class="kpi"><p class="kpi-label">متوسط زمن الحل</p><p class="kpi-value">${esc(formatHrDuration(stats.avg_resolution_seconds))}</p></div>
                <div class="kpi"><p class="kpi-label">نسبة الاستجابة</p><p class="kpi-value">${stats.first_response_rate == null ? '—' : esc(String(stats.first_response_rate)) + '٪'}</p></div>
            </div>
            <h4>أحدث التذاكر</h4>
            ${recent.length ? `<div class="table-scroll"><table class="report-table"><thead><tr>
                <th>رقم التذكرة</th><th>العنوان</th><th>الحالة</th><th>أُنشئت</th><th>أول استجابة</th><th>الحل</th>
            </tr></thead><tbody>
            ${recent.map(t => `<tr>
                <td dir="ltr">${esc(String(t.ticketNumber ?? '—'))}</td>
                <td>${esc(t.title)}</td><td>${pill(t.statusInfo)}</td>
                <td dir="ltr">${esc(String(t.createdAt || '').slice(0, 10))}</td>
                <td dir="ltr">${esc(t.firstResponseAt ? String(t.firstResponseAt).slice(0, 10) : '—')}</td>
                <td dir="ltr">${esc(t.resolvedAt ? String(t.resolvedAt).slice(0, 10) : '—')}</td>
            </tr>`).join('')}
            </tbody></table></div>` : '<p class="muted">لا توجد تذاكر مسندة لهذا الموظف بعد.</p>'}`;
    slot.innerHTML = `
        <div class="hr-detail-card">
            <h3>${esc(row.fullName)} <small dir="ltr">${esc(row.employeeNumber)}</small> ${pill(row.statusInfo)}</h3>
            <dl>
                <div><dt>الهاتف</dt><dd dir="ltr">${esc(row.phone)}</dd></div>
                <div><dt>البريد</dt><dd dir="ltr">${esc(row.email)}</dd></div>
                <div><dt>الرقم القومي</dt><dd dir="ltr">${esc(d.national_id || row.nationalId)}</dd></div>
                <div><dt>القسم / الفرع / المسمى</dt><dd>${esc(row.departmentName)} / ${esc(row.branchName)} / ${esc(row.positionName)}</dd></div>
                <div><dt>المدير</dt><dd>${esc(row.managerName)}</dd></div>
                <div><dt>المسمى الحر</dt><dd>${esc(row.jobTitle)}</dd></div>
                <div><dt>تاريخ التعيين</dt><dd>${esc(row.hireDate || '—')}</dd></div>
                <div><dt>نوع العقد</dt><dd>${esc(row.contractType || '—')}</dd></div>
                <div><dt>الحالة</dt><dd>${pill(row.statusInfo)}</dd></div>
                <div><dt>حساب مرتبط</dt><dd>${row.linked ? `مرتبط بحساب${row.linkedAccountName ? ` — ${esc(row.linkedAccountName)}` : ''}` : 'بلا حساب مرتبط'}</dd></div>
            </dl>
            <h4>سجل الحالات</h4>
            ${history.length ? `<ul>${history.map(h => `<li>${esc(h.created_at || '')} — ${esc(employeeStatusInfo(h.to_status).label)} — ${esc(h.reason || '')}</li>`).join('')}</ul>` : '<p class="muted">لا يوجد سجل حالات بعد.</p>'}
            ${ticketsSection}
            <div class="form-actions">
                ${!row.linked && !d.archived_at ? `<button type="button" class="btn btn-primary" data-hr-link-account>ربط بحساب</button>` : ''}
                ${row.linked ? `<button type="button" class="btn btn-ghost" data-hr-unlink-account>فك الربط</button>` : ''}
                <button type="button" class="btn btn-ghost" data-hr-close-detail>إغلاق</button>
            </div>
            ${row.linked ? '<p class="muted">فك الربط يحرّر الحساب ليربط موظفًا آخر، ولا يلغي عضوية الحساب في فريق الشركة — تُلغى من إدارة الفريق.</p>' : ''}
        </div>`;
    slot.querySelector('[data-hr-close-detail]')?.addEventListener('click', () => { slot.innerHTML = ''; });
    slot.querySelector('[data-hr-link-account]')?.addEventListener('click', () => openLinkAccountModal(employeeId, container));
    slot.querySelector('[data-hr-unlink-account]')?.addEventListener('click', () => unlinkEmployeeAccount(employeeId, container));
}

/** نافذة ربط الموظف بحساب: منتقٍ من أعضاء الشركة + سبب موثق (≥10 أحرف).
 *  الربط نفسه ينادي linkHrEmployeeAccount؛ الخادم يرفض غير الأعضاء
 *  والمربوطين أصلًا برسائل عربية تظهر هنا. */
async function openLinkAccountModal(employeeId, container) {
    const overlay = document.createElement('div');
    overlay.className = 'hr-modal-overlay';
    overlay.innerHTML = `<div class="hr-modal" role="dialog" aria-modal="true">
        <h3>ربط الموظف بحساب دخول</h3>
        <p class="muted">اختر حسابًا من أعضاء الشركة — يجب أن يكون الحساب عضوًا في الشركة أولًا (لإضافة شخص جديد للشركة، أضِفه كعضو أولًا من صفحة الأعضاء، ثم اربطه هنا). الربط يسجّل الحساب أيضًا في فريق الشركة فيظهر في شجرة الحسابات كموظف شركة.</p>
        <label>الحساب <select class="form-control" data-hr-link-account disabled><option value="">جارٍ تحميل أعضاء الشركة…</option></select></label>
        <label>السبب <textarea class="form-control" data-hr-link-reason rows="3"></textarea></label>
        <p class="muted">السبب مطلوب (10 أحرف على الأقل) — يُوثَّق في سجل التدقيق.</p>
        <p class="error-text" data-hr-link-error hidden></p>
        <div class="form-actions">
            <button type="button" class="btn btn-primary" data-hr-link-ok>ربط الحساب</button>
            <button type="button" class="btn btn-ghost" data-hr-link-cancel>إلغاء</button>
        </div></div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    const select = overlay.querySelector('[data-hr-link-account]');
    const errEl = overlay.querySelector('[data-hr-link-error]');
    const showError = (msg) => { errEl.textContent = msg; errEl.hidden = false; };
    overlay.querySelector('[data-hr-link-cancel]').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('[data-hr-link-ok]').addEventListener('click', async () => {
        const userId = select.value;
        const reason = String(overlay.querySelector('[data-hr-link-reason]').value || '').trim();
        if (!userId) { showError('اختر حسابًا أولًا.'); return; }
        if (reason.length < 10) { showError('السبب مطلوب (10 أحرف على الأقل).'); return; }
        const result = await linkHrEmployeeAccount(employeeId, userId, reason);
        if (!result.ok) { showError(blockReason(result)); return; }
        close();
        await showEmployeeDetail(employeeId, container);
        if (result.data && result.data.staff_registered === false) {
            window.alert('تم الربط بنجاح. ملاحظة: الحساب لم يُسجَّل في فريق الشركة (ليس تابعًا مباشرًا لمالكها)، فسيظهر في شجرة الحسابات كعميل لا كموظف — ويمكن تسجيله من إدارة الفريق.');
        }
    });
    const candidates = await fetchHrLinkCandidates();
    if (!candidates.ok) {
        select.innerHTML = '<option value="">تعذّر تحميل الأعضاء</option>';
        showError(blockReason(candidates));
        return;
    }
    const members = Array.isArray(candidates.data?.members) ? candidates.data.members : [];
    if (!members.length) {
        select.innerHTML = '<option value="">لا يوجد أعضاء متاحون</option>';
        showError('لا يوجد أعضاء متاحون للربط — أضِف عضوًا للشركة أولًا.');
        return;
    }
    select.innerHTML = members.map(m => `<option value="${esc(String(m.id))}">${esc(String(m.name || m.email || 'حساب'))}${m.email ? ` — ${esc(String(m.email))}` : ''}${m.is_owner ? ' (مالك الشركة)' : ''}</option>`).join('');
    select.disabled = false;
    select.focus();
}

/** فك ربط الموظف بحسابه (سبب موثق) — يحرّر الحساب ليربط موظفًا آخر،
 *  ولا يلغي عضوية الحساب في فريق الشركة (تُلغى من إدارة الفريق). */
async function unlinkEmployeeAccount(employeeId, container) {
    const reason = await askReason('فك ربط الحساب');
    if (!reason) return;
    const result = await unlinkHrEmployeeAccount(employeeId, reason);
    if (!result.ok) {
        window.alert(blockReason(result));
        return;
    }
    await showEmployeeDetail(employeeId, container);
}

function employeeFormHtml(values, orgs) {
    const v = values || {};
    return `
        <form class="hr-form" data-hr-emp-form>
            <h3>${v.id ? 'تعديل موظف' : 'إضافة موظف'}</h3>
            <div class="form-grid">
                <label>الاسم الكامل <input class="form-control" name="fullName" required value="${esc(v.fullName || '')}"></label>
                <label>الرقم الوظيفي (اختياري — يُولَّد تلقائيًا) <input class="form-control" name="employeeNumber" dir="ltr" value="${esc(v.employeeNumber || '')}" ${v.id ? 'disabled' : ''}></label>
                <label>الهاتف <input class="form-control" name="phone" dir="ltr" value="${esc(v.phone || '')}"></label>
                <label>البريد الإلكتروني <input class="form-control" name="email" type="email" dir="ltr" value="${esc(v.email || '')}"></label>
                <label>الرقم القومي <input class="form-control" name="nationalId" dir="ltr" value="${esc(v.nationalId || '')}"></label>
                <label>تاريخ التعيين <input class="form-control" name="hireDate" type="date" value="${esc(v.hireDate || '')}"></label>
                <label>نوع العقد <select class="form-control" name="contractType">
                    <option value="">—</option>
                    ${['full_time', 'part_time', 'contract', 'intern', 'temporary'].map(c => `<option value="${c}" ${v.contractType === c ? 'selected' : ''}>${esc({ full_time: 'دوام كامل', part_time: 'دوام جزئي', contract: 'عقد', intern: 'تدريب', temporary: 'مؤقت' }[c])}</option>`).join('')}
                </select></label>
                <label>القسم <select class="form-control" name="departmentId">${orgOptions(orgs.departments, v.departmentId, 'بلا قسم')}</select></label>
                <label>الفرع <select class="form-control" name="branchId">${orgOptions(orgs.branches, v.branchId, 'بلا فرع')}</select></label>
                <label>المسمى الوظيفي <select class="form-control" name="positionId">${orgOptions(orgs.positions, v.positionId, 'بلا مسمى')}</select></label>
                <label>المسمى الحر <input class="form-control" name="jobTitle" value="${esc(v.jobTitle || '')}"></label>
                <label>تاريخ الميلاد <input class="form-control" name="dateOfBirth" type="date" value="${esc(v.dateOfBirth || '')}"></label>
                <label>العنوان <input class="form-control" name="address" value="${esc(v.address || '')}"></label>
            </div>
            <p class="muted">الأرشفة وحالة الموظف وتعديل الرقم الوظيفي ليست هنا؛ الحالة من
            إجراءات القائمة، والرقم الوظيفي لا يتغير بعد الإنشاء.</p>
            <div class="form-actions">
                <button type="submit" class="btn btn-primary">${v.id ? 'حفظ التعديلات' : 'إضافة الموظف'}</button>
                <button type="button" class="btn btn-ghost" data-hr-cancel-form>إلغاء</button>
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
        <div class="hr-tree-row">
            <div class="hr-tree-main">
                <span class="hr-tree-name" title="${esc(node.name)}">${esc(node.name)}</span>
                <button type="button" class="btn btn-ghost btn-sm" data-hr-org-archive="${esc(node.id)}" data-hr-org-kind="${kind}">أرشفة</button>
            </div>
            <div class="hr-tree-meta">
                <span class="pill status-neutral">${esc(String(node.employees_count || 0))} موظفًا</span>
                <span class="muted">عمق ${esc(String(node.depth))}</span>
            </div>
        </div>
        ${node.children.length ? `<ul>${node.children.map(renderNode).join('')}</ul>` : ''}
    </li>`;
    listEl.innerHTML = `
        ${errors.length ? `<p class="error-text">${esc(errors.map(e => e.reason).join(' — '))}</p>` : ''}
        ${tree.length ? `<ul class="hr-tree">${tree.map(renderNode).join('')}</ul>`
            : `<p class="muted">لا توجد ${labels[kind]} بعد — أنشئ أول ${labels[kind].slice(0, -1)} من النموذج أدناه.</p>`}
        <form class="hr-inline-form" data-hr-org-form="${kind}">
            <input class="form-control" name="name" required placeholder="اسم جديد" aria-label="اسم جديد">
            <select class="form-control" name="parentId" aria-label="الأب">${orgOptions(rows, null, 'بلا أب (مستوى أول)')}</select>
            <button type="submit" class="btn btn-primary">إضافة</button>
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
        loadOrgSection('positions', container),
        loadHrSettings()
    ]);
}

/* ── الاستيراد ─────────────────────────────────────────────────────────── */

const importState = { rows: [], valid: [], invalid: [], fileName: null, key: null, ran: null };

export function loadHrImport() {
    const container = document.getElementById('hrImportBody');
    if (!container) return;
    container.innerHTML = `
        <div class="hr-import-intro">
            <h3>استيراد ملف CSV</h3>
            <ol class="hr-steps">
                <li>نزّل القالب واملأ الصفوف (حد أقصى ${HR_IMPORT_MAX_ROWS} صفًا).</li>
                <li>اختر ملف CSV لرؤية معاينة أولية صفًا صفًا.</li>
                <li>راجع الصفوف الجاهزة والمرفوضة ثم نفّذ الاستيراد بنداء واحد.</li>
            </ol>
            <p class="muted">ترتيب الأعمدة في القالب: الرقم الوظيفي، الاسم، الهاتف، البريد، الرقم القومي،
            القسم، الفرع، المسمى، رقم المدير، المسمى الحر، تاريخ التعيين، نوع العقد.
            الرقم الوظيفي الفارغ يُولَّد تلقائيًا، والصف بلا هاتف ولا بريد يُنشأ
            بحالة «بيانات ناقصة».</p>
            <p class="hr-import-note">الاستيراد لا ينشئ أي حساب دخول أبدًا — ملفات موظفين فقط،
            والربط بحساب قائم يتم لاحقًا من صفحة الموظفين بموافقة مدقَّقة.</p>
            <div class="form-actions">
                <button type="button" class="btn btn-ghost" id="hrImportTemplateBtn">تنزيل القالب</button>
                <label class="btn btn-primary">اختيار ملف CSV <input type="file" id="hrImportFile" accept=".csv,text/csv" hidden></label>
                <button type="button" class="btn btn-ghost" id="hrImportRunsBtn">سجل عمليات الاستيراد السابقة</button>
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
        <td>${ok ? '<span class="pill status-tone-success">جاهز</span>' : `<span class="pill status-tone-danger">مرفوض</span> <span class="muted">${esc(r.reason || '')}</span>`}</td></tr>`;
    preview.innerHTML = `
        <p class="muted"><strong>تحقق أولي</strong> — بناءً على آخر لقطة محملة؛ القرار النهائي
        لخادم الاستيراد، وقد يرفض صفًا بدا جاهزًا (مثلًا: رقم أُنشئ بعد تحميل الصفحة).</p>
        ${errors.length ? `<p class="error-text">${errors.map(e => `سطر ${e.line}: ${e.reason}`).join(' — ')}</p>` : ''}
        <p class="hr-import-summary"><span class="pill status-tone-success">${valid.length} صفًا جاهزًا</span><span class="pill status-tone-danger">${invalid.length} صفًا مرفوضًا</span><span>من ${rows.length} صفًا</span></p>
        <div class="table-scroll"><table class="report-table"><thead><tr>
            <th>السطر</th><th>الرقم الوظيفي</th><th>الاسم</th><th>الهاتف</th><th>البريد</th><th>الحالة</th>
        </tr></thead><tbody>
        ${valid.map(r => rowHtml(r, true)).join('')}
        ${invalid.map(r => rowHtml(r, false)).join('')}
        </tbody></table></div>
        <div class="form-actions">
            <button type="button" class="btn btn-primary" id="hrImportRunBtn" ${valid.length ? '' : 'disabled'}>
                استيراد ${valid.length} صفًا جاهزًا (نداء واحد)</button>
            <button type="button" class="btn btn-ghost" id="hrImportCancelBtn">إلغاء</button>
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
        <p class="hr-import-summary"><span class="pill status-tone-success">${summary.inserted} أُدخل</span><span class="pill status-tone-warning">${summary.duplicate} مكرر</span><span class="pill status-tone-danger">${summary.invalid} مرفوض</span><span>من ${summary.total} صفًا</span></p>
        <div class="table-scroll"><table class="report-table"><thead><tr>
            <th>السطر</th><th>الرقم الوظيفي</th><th>الحالة</th><th>السبب</th>
        </tr></thead><tbody>
        ${results.map(r => `<tr>
            <td>${esc(String(r.line))}</td><td dir="ltr">${esc(r.employee_number || '—')}</td>
            <td>${r.status === 'inserted' ? '<span class="pill status-tone-success">أُدخل</span>' : r.status === 'duplicate' ? '<span class="pill status-tone-warning">مكرر</span>' : '<span class="pill status-tone-danger">مرفوض</span>'}</td>
            <td>${esc(r.reason || '')}</td></tr>`).join('')}
        </tbody></table></div>
        <div class="form-actions">
            <button type="button" class="btn btn-ghost" id="hrImportReportBtn">تنزيل التقرير CSV</button>
            <button type="button" class="btn btn-ghost" id="hrImportAgainBtn">استيراد ملف آخر</button>
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
    box.innerHTML = `<div class="table-scroll"><table class="report-table"><thead><tr>
        <th>الملف</th><th>الحالة</th><th>الصفوف</th><th>أُدخل</th><th>مكرر</th><th>مرفوض</th><th>التاريخ</th><th></th>
    </tr></thead><tbody>
    ${rows.map(r => `<tr>
        <td>${esc(r.file_name || '—')}</td><td>${esc(r.status)}</td>
        <td>${esc(String(r.total_rows))}</td><td>${esc(String(r.inserted_count))}</td>
        <td>${esc(String(r.duplicate_count))}</td><td>${esc(String(r.invalid_count))}</td>
        <td>${esc(r.created_at || '')}</td>
        <td><button type="button" class="btn btn-ghost btn-sm" data-hr-run="${esc(r.id)}">التفاصيل</button></td>
    </tr>`).join('')}</tbody></table></div>`;
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
            <p class="hr-import-summary"><span class="pill status-tone-success">${summary.inserted} أُدخل</span><span class="pill status-tone-warning">${summary.duplicate} مكرر</span><span class="pill status-tone-danger">${summary.invalid} مرفوض</span><span>من ${summary.total} صفًا</span></p>
            <div class="table-scroll"><table class="report-table"><thead><tr>
                <th>السطر</th><th>الرقم الوظيفي</th><th>الحالة</th><th>السبب</th>
            </tr></thead><tbody>
            ${results.map(r => `<tr>
                <td>${esc(String(r.line))}</td><td dir="ltr">${esc(r.employee_number || '—')}</td>
                <td>${r.status === 'inserted' ? '<span class="pill status-tone-success">أُدخل</span>' : r.status === 'duplicate' ? '<span class="pill status-tone-warning">مكرر</span>' : '<span class="pill status-tone-danger">مرفوض</span>'}</td>
                <td>${esc(r.reason || '')}</td></tr>`).join('')}
            </tbody></table></div>`;
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
            <h3>إعدادات الترقيم</h3>
            <div class="form-grid">
                <label>بادئة الرقم الوظيفي <input class="form-control" name="prefix" dir="ltr" value="${esc(s.employee_number_prefix || 'EMP')}"></label>
                <label>يبدأ الترقيم من <input class="form-control" name="startFrom" type="number" min="1" value="${esc(String(s.employee_number_next ?? 1))}"></label>
            </div>
            <p class="muted">الرقم الوظيفي التالي يُولَّد من البادئة والعدّاد عند إضافة موظف بلا رقم؛
            تغيير العدّاد لا يمسّ الأرقام الصادرة من قبل.</p>
            <div class="form-actions">
                <button type="submit" class="btn btn-primary">حفظ الإعدادات</button>
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

/* ── الإجازات (الترحيل 154) ───────────────────────────────────────────── */

const leaveState = {
    page: 1, pageSize: 20, status: '', employeeId: '', typeId: '',
    year: new Date().getFullYear(), balanceEmployeeId: '', balanceYear: new Date().getFullYear(),
    types: [], employees: [], totalRequests: 0, pendingTotal: 0, approvedTotal: 0, loaded: false
};

function leaveEmployeeOptions(selectedId, placeholder = 'كل الموظفين') {
    const opts = leaveState.employees.map(e =>
        `<option value="${esc(e.id)}" ${String(e.id) === String(selectedId) ? 'selected' : ''}>${esc(e.full_name)} (${esc(e.employee_number)})</option>`).join('');
    return `<option value="">${esc(placeholder)}</option>${opts}`;
}

function leaveTypeOptions(selectedId, placeholder = 'كل الأنواع') {
    const opts = leaveState.types.map(t =>
        `<option value="${esc(t.id)}" ${String(t.id) === String(selectedId) ? 'selected' : ''}>${esc(t.name_ar)}</option>`).join('');
    return `<option value="">${esc(placeholder)}</option>${opts}`;
}

export async function loadHrLeave() {
    const container = document.getElementById('hrLeaveBody');
    if (!container) return;
    renderState(container, { variant: 'loading', title: 'جارٍ تحميل الإجازات…', text: '' });
    const [typesRes, empRes] = await Promise.all([
        fetchHrLeaveTypes(false),
        fetchHrEmployees({ page: 1, pageSize: HR_PAGE_SIZE_MAX })
    ]);
    if (!typesRes.ok) {
        renderState(container, {
            variant: 'error', title: 'قسم الإجازات غير مفعّل',
            text: blockReason(typesRes),
            action: { label: 'إعادة المحاولة', retry: 'hr-leave', variant: 'btn-primary' }
        });
        return;
    }
    const typesData = typesRes.data || {};
    leaveState.types = Array.isArray(typesData.rows) ? typesData.rows : [];
    // قائمة الموظفين للمحددات فقط — فشلها لا يحجب الطلبات (أسماؤها تأتي من الخادم).
    leaveState.employees = empRes.ok && Array.isArray(empRes.data?.rows) ? empRes.data.rows : [];
    if (!leaveState.balanceEmployeeId && leaveState.employees.length) {
        leaveState.balanceEmployeeId = leaveState.employees[0].id;
    }
    container.innerHTML = `
        <div class="kpi-grid" id="hrLeaveKpis"></div>
        <div class="hr-leave-grid">
            <section class="panel" aria-labelledby="hrLeaveFormHeading">
                <div class="panel-header"><div>
                    <h2 class="panel-title" id="hrLeaveFormHeading">طلب إجازة جديد</h2>
                    <p class="panel-subtitle">الأيام تُحسب تقويميًا شاملة الطرفين، والخصم من الرصيد عند الاعتماد فقط.</p>
                </div></div>
                <form class="hr-form" data-hr-leave-form>
                    <div class="form-grid">
                        <label>الموظف <select class="form-control" name="employeeId">${leaveEmployeeOptions('', 'حدّد الموظف')}</select></label>
                        <label>نوع الإجازة <select class="form-control" name="leaveTypeId">${leaveTypeOptions('', 'حدّد النوع')}</select></label>
                        <label>تاريخ البداية <input class="form-control" name="startDate" type="date"></label>
                        <label>تاريخ النهاية <input class="form-control" name="endDate" type="date"></label>
                        <label>ملاحظة (اختياري) <input class="form-control" name="note" maxlength="1000" placeholder="سبب الطلب…"></label>
                    </div>
                    <p class="muted" data-hr-leave-days></p>
                    <div class="form-actions">
                        <button type="submit" class="btn btn-primary">إرسال الطلب</button>
                    </div>
                    <p class="error-text" data-hr-leave-form-error hidden></p>
                    <p class="muted">الطلب يجب أن يكون داخل سنة ميلادية واحدة؛ والفترة المتداخلة
                    مع طلب معلق أو معتمَد تُرفض؛ وبلا فحص رصيد عند الطلب — الرصيد
                    يُفحص عند الاعتماد وقد يتغير والطلب معلق.</p>
                </form>
            </section>
            <section class="panel" aria-labelledby="hrLeaveTypesHeading">
                <div class="panel-header"><div>
                    <h2 class="panel-title" id="hrLeaveTypesHeading">أنواع الإجازات</h2>
                    <p class="panel-subtitle">الافتراضيات: سنوية 21 يومًا، مرضية 15 يومًا، بدون أجر بلا رصيد.</p>
                </div></div>
                <div id="hrLeaveTypesList"></div>
                <form class="hr-inline-form" data-hr-leave-type-form>
                    <input class="form-control" name="code" required placeholder="الرمز (annual)" dir="ltr" aria-label="رمز النوع">
                    <input class="form-control" name="nameAr" required placeholder="اسم النوع" aria-label="اسم النوع">
                    <input class="form-control" name="defaultDays" type="number" min="0" max="365" value="0" aria-label="الرصيد الافتراضي">
                    <label class="hr-check"><input type="checkbox" name="deductsBalance" checked> يخصم من الرصيد</label>
                    <button type="submit" class="btn btn-primary">إضافة نوع</button>
                    <span class="error-text" data-hr-leave-type-error hidden></span>
                </form>
            </section>
        </div>
        <section class="panel" aria-labelledby="hrLeaveBalancesHeading">
            <div class="panel-header"><div>
                <h2 class="panel-title" id="hrLeaveBalancesHeading">الأرصدة السنوية</h2>
                <p class="panel-subtitle">رصيد كل موظف من كل نوع يخصم؛ يُنشأ تلقائيًا من افتراضيات النوع، ويضبطه المدير هنا.</p>
            </div></div>
            <div class="toolbar hr-toolbar">
                <select class="form-control filter-select" id="hrLeaveBalanceEmp" aria-label="موظف الأرصدة">${leaveEmployeeOptions(leaveState.balanceEmployeeId, 'حدّد الموظف')}</select>
                <input class="form-control filter-select" id="hrLeaveBalanceYear" type="number" min="2000" max="2100" value="${esc(String(leaveState.balanceYear))}" aria-label="سنة الأرصدة">
                <button type="button" class="btn btn-ghost" id="hrLeaveBalanceLoadBtn">عرض الأرصدة</button>
            </div>
            <div id="hrLeaveBalancesList"></div>
            <form class="hr-inline-form" data-hr-leave-balance-form>
                <select class="form-control" name="leaveTypeId" aria-label="نوع الرصيد">${leaveTypeOptions('', 'حدّد النوع')}</select>
                <input class="form-control" name="totalDays" type="number" min="0" max="365" required placeholder="الرصيد الكلي (أيام)" aria-label="الرصيد الكلي">
                <button type="submit" class="btn btn-primary">ضبط الرصيد</button>
                <span class="error-text" data-hr-leave-balance-error hidden></span>
            </form>
            <p class="muted">الرصيد الجديد لا يقل عن المستخدم فعلًا؛ وتغيير افتراضي النوع
            لا يمسّ أرصدة السنوات القائمة.</p>
        </section>
        <section class="panel" aria-labelledby="hrLeaveRequestsHeading">
            <div class="panel-header"><div>
                <h2 class="panel-title" id="hrLeaveRequestsHeading">طلبات الإجازات</h2>
                <p class="panel-subtitle">الاعتماد يخصم من الرصيد فورًا؛ والرفض يتطلب سببًا موثقًا.</p>
            </div></div>
            <div class="toolbar hr-toolbar">
                <select class="form-control filter-select" id="hrLeaveStatusFilter" aria-label="تصفية بالحالة">
                    <option value="">كل الحالات</option>
                    <option value="pending">معلق</option>
                    <option value="approved">معتمَد</option>
                    <option value="rejected">مرفوض</option>
                </select>
                <select class="form-control filter-select" id="hrLeaveEmpFilter" aria-label="تصفية بالموظف">${leaveEmployeeOptions('', 'كل الموظفين')}</select>
                <select class="form-control filter-select" id="hrLeaveTypeFilter" aria-label="تصفية بالنوع">${leaveTypeOptions('', 'كل الأنواع')}</select>
            </div>
            <div id="hrLeaveRequestsList"></div>
            <div id="hrLeaveDetailSlot"></div>
        </section>`;
    renderLeaveTypes(container);
    wireLeavePage(container);
    await Promise.all([refreshLeaveKpis(container), refreshLeaveBalances(container), refreshLeaveRequests(container)]);
    leaveState.loaded = true;
}

function renderLeaveTypes(container) {
    const list = document.getElementById('hrLeaveTypesList');
    if (!list) return;
    const rows = leaveState.types;
    if (!rows.length) {
        list.innerHTML = '<p class="muted">لا توجد أنواع إجازات بعد.</p>';
        return;
    }
    list.innerHTML = `<div class="table-scroll"><table class="report-table"><thead><tr>
        <th>النوع</th><th>الرمز</th><th>الرصيد الافتراضي</th><th>يخصم؟</th><th>الحالة</th><th>إجراءات</th>
    </tr></thead><tbody>
    ${rows.map(t => `<tr>
        <td>${esc(t.name_ar)}</td><td dir="ltr">${esc(t.code)}</td>
        <td>${esc(String(t.default_days))} يومًا</td>
        <td>${t.deducts_balance ? 'نعم' : 'لا'}</td>
        <td>${t.is_active ? '<span class="pill status-tone-success">نشط</span>' : '<span class="pill status-neutral">مؤرشف</span>'}</td>
        <td>${t.is_active ? `<button type="button" class="btn btn-ghost btn-sm" data-hr-leave-type-archive="${esc(t.id)}">أرشفة</button>` : ''}</td>
    </tr>`).join('')}
    </tbody></table></div>`;
    list.querySelectorAll('[data-hr-leave-type-archive]').forEach(b => b.addEventListener('click', async () => {
        const reason = await askReason('أرشفة نوع الإجازة');
        if (!reason) return;
        const res = await archiveHrLeaveType(b.getAttribute('data-hr-leave-type-archive'), reason);
        if (!res.ok) { window.alert(blockReason(res)); return; }
        await reloadLeaveTypes(container);
    }));
}

async function reloadLeaveTypes(container) {
    const res = await fetchHrLeaveTypes(false);
    if (res.ok) {
        const d = res.data || {};
        leaveState.types = Array.isArray(d.rows) ? d.rows : [];
        renderLeaveTypes(container);
    }
}

function wireLeavePage(container) {
    const form = container.querySelector('[data-hr-leave-form]');
    const daysEl = container.querySelector('[data-hr-leave-days]');
    const updateDays = () => {
        const fd = new FormData(form);
        const days = leaveDaysBetween(String(fd.get('startDate') || ''), String(fd.get('endDate') || ''));
        daysEl.textContent = days == null ? '' : `عدد الأيام: ${days} يومًا (تقويميًا، شاملة الطرفين).`;
    };
    form.querySelector('[name="startDate"]').addEventListener('change', updateDays);
    form.querySelector('[name="endDate"]').addEventListener('change', updateDays);
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const fields = {
            employeeId: String(fd.get('employeeId') || '') || null,
            leaveTypeId: String(fd.get('leaveTypeId') || '') || null,
            startDate: String(fd.get('startDate') || '') || null,
            endDate: String(fd.get('endDate') || '') || null,
            note: String(fd.get('note') || '').trim() || null
        };
        const check = validateLeaveRequestForm(fields);
        const errEl = form.querySelector('[data-hr-leave-form-error]');
        if (!check.isValid) {
            errEl.textContent = Object.values(check.errors)[0];
            errEl.hidden = false;
            return;
        }
        errEl.hidden = true;
        const result = await createHrLeaveRequest(fields);
        if (!result.ok) {
            errEl.textContent = blockReason(result);
            errEl.hidden = false;
            return;
        }
        form.reset();
        daysEl.textContent = '';
        leaveState.page = 1;
        await Promise.all([refreshLeaveKpis(container), refreshLeaveRequests(container)]);
    });

    container.querySelector('[data-hr-leave-type-form]').addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const fields = {
            code: String(fd.get('code') || '').trim().toLowerCase(),
            nameAr: String(fd.get('nameAr') || '').trim(),
            defaultDays: Number(fd.get('defaultDays') || 0),
            deductsBalance: fd.get('deductsBalance') === 'on'
        };
        const check = validateLeaveTypeForm(fields);
        const errEl = container.querySelector('[data-hr-leave-type-error]');
        if (!check.isValid) {
            errEl.textContent = Object.values(check.errors)[0];
            errEl.hidden = false;
            return;
        }
        errEl.hidden = true;
        const res = await createHrLeaveType(fields);
        if (!res.ok) {
            errEl.textContent = blockReason(res);
            errEl.hidden = false;
            return;
        }
        e.target.reset();
        e.target.querySelector('[name="deductsBalance"]').checked = true;
        await reloadLeaveTypes(container);
    });

    container.querySelector('[data-hr-leave-balance-form]').addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const errEl = container.querySelector('[data-hr-leave-balance-error]');
        const empId = leaveState.balanceEmployeeId;
        const typeId = String(fd.get('leaveTypeId') || '');
        const total = Number(fd.get('totalDays') || 0);
        if (!empId || !typeId) {
            errEl.textContent = 'حدّد الموظف ونوع الإجازة أولًا.';
            errEl.hidden = false;
            return;
        }
        errEl.hidden = true;
        const res = await setHrLeaveBalance(empId, typeId, leaveState.balanceYear, total);
        if (!res.ok) {
            errEl.textContent = blockReason(res);
            errEl.hidden = false;
            return;
        }
        await refreshLeaveBalances(container);
    });

    document.getElementById('hrLeaveBalanceEmp').addEventListener('change', (e) => {
        leaveState.balanceEmployeeId = e.target.value || '';
        refreshLeaveBalances(container);
    });
    document.getElementById('hrLeaveBalanceYear').addEventListener('change', (e) => {
        leaveState.balanceYear = Number(e.target.value) || leaveState.year;
        refreshLeaveBalances(container);
    });
    document.getElementById('hrLeaveBalanceLoadBtn').addEventListener('click', () => refreshLeaveBalances(container));
    document.getElementById('hrLeaveStatusFilter').addEventListener('change', (e) => {
        leaveState.status = e.target.value || '';
        leaveState.page = 1;
        refreshLeaveRequests(container);
    });
    document.getElementById('hrLeaveEmpFilter').addEventListener('change', (e) => {
        leaveState.employeeId = e.target.value || '';
        leaveState.page = 1;
        refreshLeaveRequests(container);
    });
    document.getElementById('hrLeaveTypeFilter').addEventListener('change', (e) => {
        leaveState.typeId = e.target.value || '';
        leaveState.page = 1;
        refreshLeaveRequests(container);
    });
}

async function refreshLeaveKpis(container) {
    const kpis = document.getElementById('hrLeaveKpis');
    if (!kpis) return;
    const [pending, approved] = await Promise.all([
        fetchHrLeaveRequests({ page: 1, pageSize: 1, status: 'pending' }),
        fetchHrLeaveRequests({ page: 1, pageSize: 1, status: 'approved' })
    ]);
    leaveState.pendingTotal = pending.ok ? Number(pending.data?.total || 0) : 0;
    leaveState.approvedTotal = approved.ok ? Number(approved.data?.total || 0) : 0;
    kpis.innerHTML = `
        <div class="kpi kpi--warning">
            <p class="kpi-label">${icon('clock', 16)}طلبات معلقة</p>
            <p class="kpi-value">${esc(String(leaveState.pendingTotal))}</p>
            <p class="kpi-hint">بانتظار البتّ</p>
        </div>
        <div class="kpi kpi--success">
            <p class="kpi-label">${icon('check', 16)}طلبات معتمَدة</p>
            <p class="kpi-value">${esc(String(leaveState.approvedTotal))}</p>
            <p class="kpi-hint">الخصم تم عند الاعتماد</p>
        </div>
        <div class="kpi">
            <p class="kpi-label">${icon('briefcase', 16)}أنواع الإجازات</p>
            <p class="kpi-value">${esc(String(leaveState.types.length))}</p>
            <p class="kpi-hint">سنوية ومرضية وبدون أجر افتراضيًا</p>
        </div>`;
}

async function refreshLeaveBalances(container) {
    const list = document.getElementById('hrLeaveBalancesList');
    if (!list) return;
    if (!leaveState.balanceEmployeeId) {
        list.innerHTML = '<p class="muted">حدّد موظفًا لعرض أرصدته.</p>';
        return;
    }
    renderState(list, { variant: 'loading', title: 'جارٍ تحميل الأرصدة…', text: '' });
    const result = await fetchHrLeaveBalances({ employeeId: leaveState.balanceEmployeeId, year: leaveState.balanceYear });
    if (!result.ok) {
        renderState(list, { variant: 'error', title: 'تعذّر تحميل الأرصدة', text: blockReason(result) });
        return;
    }
    const data = result.data || {};
    const rows = Array.isArray(data.rows) ? data.rows.map(leaveBalanceRowForDisplay) : [];
    if (!rows.length) {
        renderState(list, { variant: 'empty', title: 'لا توجد أرصدة لهذا الموظف', text: 'الأنواع التي لا تخصم (بدون أجر) بلا رصيد.' });
        return;
    }
    list.innerHTML = `<div class="table-scroll"><table class="report-table"><thead><tr>
        <th>النوع</th><th>السنة</th><th>الرصيد الكلي</th><th>المستخدم</th><th>المتبقي</th><th></th>
    </tr></thead><tbody>
    ${rows.map(b => {
        const pct = b.totalDays > 0 ? Math.round((b.remainingDays / b.totalDays) * 100) : 0;
        return `<tr>
        <td>${esc(b.typeName)}</td><td>${esc(String(b.year))}</td>
        <td>${esc(String(b.totalDays))} يومًا</td><td>${esc(String(b.usedDays))} يومًا</td>
        <td>${esc(String(b.remainingDays))} يومًا</td>
        <td><div class="hr-balance-bar" role="img" aria-label="متبقٍ ${pct}%">
            <span style="width: ${pct}%"></span></div></td>
    </tr>`;
    }).join('')}
    </tbody></table></div>`;
}

async function refreshLeaveRequests(container) {
    const list = document.getElementById('hrLeaveRequestsList');
    if (!list) return;
    renderState(list, { variant: 'loading', title: 'جارٍ تحميل طلبات الإجازات…', text: '' });
    const { page, pageSize } = hrPageParams(leaveState.page, leaveState.pageSize);
    const result = await fetchHrLeaveRequests({
        page, pageSize, employeeId: leaveState.employeeId || null,
        status: leaveState.status || null, leaveTypeId: leaveState.typeId || null
    });
    if (!result.ok) {
        renderState(list, {
            variant: 'error', title: 'تعذّر تحميل طلبات الإجازات', text: blockReason(result),
            action: { label: 'إعادة المحاولة', retry: 'hr-leave', variant: 'btn-primary' }
        });
        return;
    }
    const data = result.data || {};
    const rows = Array.isArray(data.rows) ? data.rows.map(leaveRequestRowForDisplay) : [];
    leaveState.totalRequests = Number(data.total_count || data.total || 0);
    const view = hrPaginationView(leaveState.totalRequests, page, pageSize);
    if (!rows.length) {
        renderState(list, {
            variant: 'empty', title: 'لا توجد طلبات إجازات',
            text: leaveState.status || leaveState.employeeId ? 'لا تطابق الفلاتر أي طلب.' : 'أرسل أول طلب من النموذج أعلاه.'
        });
        return;
    }
    list.innerHTML = `
        <div class="table-scroll hr-table-sticky"><table class="report-table"><thead><tr>
            <th>الموظف</th><th>النوع</th><th>من</th><th>إلى</th><th>الأيام</th><th>الحالة</th><th>إجراءات</th>
        </tr></thead><tbody>
        ${rows.map(r => `<tr>
            <td>${esc(r.employeeName)} <small dir="ltr">${esc(r.employeeNumber)}</small></td>
            <td>${esc(r.typeName)}</td>
            <td>${esc(r.startDate || '—')}</td><td>${esc(r.endDate || '—')}</td>
            <td>${esc(String(r.days))}</td>
            <td>${pill(r.statusInfo)}</td>
            <td><button type="button" class="btn btn-ghost btn-sm" data-hr-leave-view="${esc(r.id)}">عرض</button>
                ${r.status === 'pending' ? `
                <button type="button" class="btn btn-ghost btn-sm" data-hr-leave-approve="${esc(r.id)}">اعتماد</button>
                <button type="button" class="btn btn-ghost btn-sm" data-hr-leave-reject="${esc(r.id)}">رفض</button>` : ''}
            </td></tr>`).join('')}
        </tbody></table></div>
        <div class="pager" data-hr-pager>
            <button type="button" class="btn btn-ghost btn-sm" data-hr-prev ${view.hasPrev ? '' : 'disabled'}>السابقة</button>
            <span>صفحة ${esc(String(view.page))} من ${esc(String(view.totalPages))} — ${esc(String(view.total))} طلبًا</span>
            <button type="button" class="btn btn-ghost btn-sm" data-hr-next ${view.hasNext ? '' : 'disabled'}>التالية</button>
        </div>`;
    list.querySelector('[data-hr-prev]')?.addEventListener('click', () => { leaveState.page = view.page - 1; refreshLeaveRequests(container); });
    list.querySelector('[data-hr-next]')?.addEventListener('click', () => { leaveState.page = view.page + 1; refreshLeaveRequests(container); });
    list.querySelectorAll('[data-hr-leave-view]').forEach(b => b.addEventListener('click', () => showLeaveRequestDetail(b.getAttribute('data-hr-leave-view'), container)));
    list.querySelectorAll('[data-hr-leave-approve]').forEach(b => b.addEventListener('click', () => decideLeaveRequest(b.getAttribute('data-hr-leave-approve'), true, container)));
    list.querySelectorAll('[data-hr-leave-reject]').forEach(b => b.addEventListener('click', () => decideLeaveRequest(b.getAttribute('data-hr-leave-reject'), false, container)));
}

async function showLeaveRequestDetail(requestId, container) {
    const slot = document.getElementById('hrLeaveDetailSlot');
    if (!slot) return;
    slot.innerHTML = '<p class="muted">جارٍ تحميل التفاصيل…</p>';
    const result = await fetchHrLeaveRequestDetail(requestId);
    if (!result.ok) {
        slot.innerHTML = `<p class="error-text">${esc(blockReason(result))}</p>`;
        return;
    }
    const d = result.data || {};
    const row = leaveRequestRowForDisplay(d);
    const bal = d.balance || null;
    slot.innerHTML = `
        <div class="hr-detail-card">
            <h3>طلب ${esc(row.typeName)} — ${esc(row.employeeName)} ${pill(row.statusInfo)}</h3>
            <dl>
                <div><dt>الفترة</dt><dd>${esc(row.startDate || '—')} → ${esc(row.endDate || '—')} (${esc(String(row.days))} أيام)</dd></div>
                <div><dt>ملاحظة الموظف</dt><dd>${esc(row.note || '—')}</dd></div>
                <div><dt>الرصيد عند الطلب</dt><dd>${bal ? `الكلي ${esc(String(bal.total_days))} — المستخدم ${esc(String(bal.used_days))} — المتبقي ${esc(String(bal.remaining_days))}` : 'بلا رصيد (نوع لا يخصم)'}</dd></div>
                <div><dt>سبب القرار</dt><dd>${esc(row.decisionReason || '—')}</dd></div>
            </dl>
            <div class="form-actions">
                ${row.status === 'pending' && d.can_decide ? `
                <button type="button" class="btn btn-primary" data-hr-leave-detail-approve>اعتماد (يخصم ${esc(String(row.days))} يومًا)</button>
                <button type="button" class="btn btn-ghost" data-hr-leave-detail-reject>رفض</button>` : ''}
                <button type="button" class="btn btn-ghost" data-hr-leave-close-detail>إغلاق</button>
            </div>
        </div>`;
    slot.querySelector('[data-hr-leave-close-detail]')?.addEventListener('click', () => { slot.innerHTML = ''; });
    slot.querySelector('[data-hr-leave-detail-approve]')?.addEventListener('click', () => decideLeaveRequest(requestId, true, container));
    slot.querySelector('[data-hr-leave-detail-reject]')?.addEventListener('click', () => decideLeaveRequest(requestId, false, container));
}

async function decideLeaveRequest(requestId, approve, container) {
    let reason = null;
    if (!approve) {
        reason = await askReason('رفض طلب الإجازة');
        if (!reason) return;
    }
    const result = await decideHrLeaveRequest(requestId, approve, reason);
    if (!result.ok) {
        window.alert(blockReason(result));
        return;
    }
    const slot = document.getElementById('hrLeaveDetailSlot');
    if (slot) slot.innerHTML = '';
    await Promise.all([refreshLeaveKpis(container), refreshLeaveBalances(container), refreshLeaveRequests(container)]);
}

/* ── الحضور والانصراف (الترحيل 155) ───────────────────────────────────── */

function attMonthStartIso() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
}

function attTodayIso() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

const attState = {
    page: 1, pageSize: 20, employeeId: '', status: '',
    startDate: attMonthStartIso(), endDate: attTodayIso(),
    summaryEmployeeId: '', summaryStart: attMonthStartIso(), summaryEnd: attTodayIso(),
    shifts: [], employees: [], today: null, totalRecords: 0, presentTotal: 0, lateTotal: 0,
    loaded: false
};

function attEmployeeOptions(selectedId, placeholder = 'كل الموظفين') {
    const opts = attState.employees.map(e =>
        `<option value="${esc(e.id)}" ${String(e.id) === String(selectedId) ? 'selected' : ''}>${esc(e.full_name)} (${esc(e.employee_number)})</option>`).join('');
    return `<option value="">${esc(placeholder)}</option>${opts}`;
}

function attShiftOptions(selectedId, placeholder = 'حدّد الوردية') {
    const opts = attState.shifts.filter(s => s.is_active).map(s =>
        `<option value="${esc(s.id)}" ${String(s.id) === String(selectedId) ? 'selected' : ''}>${esc(s.name)} (${esc(String(s.start_time).slice(0, 5))}–${esc(String(s.end_time).slice(0, 5))})</option>`).join('');
    return `<option value="">${esc(placeholder)}</option>${opts}`;
}

export async function loadHrAttendance() {
    const container = document.getElementById('hrAttendanceBody');
    if (!container) return;
    renderState(container, { variant: 'loading', title: 'جارٍ تحميل الحضور والانصراف…', text: '' });
    const [shiftsRes, empRes, todayRes] = await Promise.all([
        fetchHrShifts(false),
        fetchHrEmployees({ page: 1, pageSize: HR_PAGE_SIZE_MAX }),
        fetchHrAttendanceToday()
    ]);
    if (!shiftsRes.ok) {
        renderState(container, {
            variant: 'error', title: 'قسم الحضور والانصراف غير مفعّل',
            text: blockReason(shiftsRes),
            action: { label: 'إعادة المحاولة', retry: 'hr-attendance', variant: 'btn-primary' }
        });
        return;
    }
    const shiftsData = shiftsRes.data || {};
    attState.shifts = Array.isArray(shiftsData.rows) ? shiftsData.rows : [];
    // قائمة الموظفين للمحددات فقط — فشلها لا يحجب السجلات (أسماؤها تأتي من الخادم).
    attState.employees = empRes.ok && Array.isArray(empRes.data?.rows) ? empRes.data.rows : [];
    attState.today = todayRes.ok ? (todayRes.data || null) : null;
    if (!attState.summaryEmployeeId && attState.today?.employee_id) {
        attState.summaryEmployeeId = attState.today.employee_id;
    } else if (!attState.summaryEmployeeId && attState.employees.length) {
        attState.summaryEmployeeId = attState.employees[0].id;
    }
    container.innerHTML = `
        <div class="kpi-grid" id="hrAttendanceKpis"></div>
        <div class="hr-attendance-grid">
            <section class="panel" aria-labelledby="hrAttTodayHeading">
                <div class="panel-header"><div>
                    <h2 class="panel-title" id="hrAttTodayHeading">تسجيل اليوم</h2>
                    <p class="panel-subtitle">التاريخ والوقت من ساعة الخادم — لا يُقبل وقت من المتصفح.</p>
                </div></div>
                <div id="hrAttTodayBody"></div>
            </section>
            <section class="panel" aria-labelledby="hrAttShiftsHeading">
                <div class="panel-header"><div>
                    <h2 class="panel-title" id="hrAttShiftsHeading">الورديات</h2>
                    <p class="panel-subtitle">الدخول بعد البداية + فترة السماح يُحسب متأخرًا؛ والدخول المبكر حاضر.</p>
                </div></div>
                <div id="hrAttShiftsList"></div>
                <form class="hr-form" data-hr-shift-form>
                    <div class="form-grid">
                        <label>اسم الوردية <input class="form-control" name="name" required placeholder="الوردية الصباحية" aria-label="اسم الوردية"></label>
                        <label>وقت البداية <input class="form-control" name="startTime" type="time" required value="09:00" aria-label="وقت بداية الوردية"></label>
                        <label>وقت النهاية <input class="form-control" name="endTime" type="time" required value="17:00" aria-label="وقت نهاية الوردية"></label>
                        <label>فترة السماح (دقيقة) <input class="form-control" name="graceMinutes" type="number" min="0" max="120" value="15" aria-label="فترة سماح التأخير"></label>
                    </div>
                    <fieldset class="hr-check-group"><legend>أيام العمل</legend>
                        ${HR_WEEKDAYS.map(d => `<label class="hr-check"><input type="checkbox" name="workingDays" value="${d.value}" ${d.value <= 4 ? 'checked' : ''}> ${esc(d.label)}</label>`).join('')}
                    </fieldset>
                    <div class="form-actions">
                        <button type="submit" class="btn btn-primary">إضافة وردية</button>
                    </div>
                    <p class="error-text" data-hr-shift-form-error hidden></p>
                    <p class="muted">الافتراضي: الأحد–الخميس، سماح 15 دقيقة. لا ورديات ليلية
                    عابرة لمنتصف الليل في هذا القسم.</p>
                </form>
                <form class="hr-inline-form" data-hr-shift-assign-form>
                    <select class="form-control" name="employeeId" aria-label="موظف الإسناد">${attEmployeeOptions('', 'حدّد الموظف')}</select>
                    <select class="form-control" name="shiftId" aria-label="وردية الإسناد">${attShiftOptions('', 'حدّد الوردية')}</select>
                    <input class="form-control" name="effectiveFrom" type="date" value="${esc(attTodayIso())}" aria-label="تاريخ سريان الإسناد">
                    <button type="submit" class="btn btn-primary">إسناد الوردية</button>
                    <span class="error-text" data-hr-shift-assign-error hidden></span>
                </form>
            </section>
        </div>
        <section class="panel" aria-labelledby="hrAttSummaryHeading">
            <div class="panel-header"><div>
                <h2 class="panel-title" id="hrAttSummaryHeading">ملخص الحضور</h2>
                <p class="panel-subtitle">الغياب مشتق: يوم عمل بلا سجل وبلا إجازة معتمَدة؛ واليوم المعتمَد إجازة لا يُحسب غيابًا.</p>
            </div></div>
            <div class="toolbar hr-toolbar">
                <select class="form-control filter-select" id="hrAttSummaryEmp" aria-label="موظف الملخص">${attEmployeeOptions(attState.summaryEmployeeId, 'حدّد الموظف')}</select>
                <input class="form-control filter-select" id="hrAttSummaryStart" type="date" value="${esc(attState.summaryStart)}" aria-label="بداية الملخص">
                <input class="form-control filter-select" id="hrAttSummaryEnd" type="date" value="${esc(attState.summaryEnd)}" aria-label="نهاية الملخص">
                <button type="button" class="btn btn-ghost" id="hrAttSummaryLoadBtn">عرض الملخص</button>
            </div>
            <div id="hrAttSummaryBody"></div>
        </section>
        <section class="panel" aria-labelledby="hrAttRecordsHeading">
            <div class="panel-header"><div>
                <h2 class="panel-title" id="hrAttRecordsHeading">سجلات الحضور</h2>
                <p class="panel-subtitle">الافتراضي: الشهر الحالي حتى اليوم. التصحيح بسبب موثق ويُسجَّل في التدقيق.</p>
            </div></div>
            <div class="toolbar hr-toolbar">
                <select class="form-control filter-select" id="hrAttEmpFilter" aria-label="تصفية بالموظف">${attEmployeeOptions('', 'كل الموظفين')}</select>
                <select class="form-control filter-select" id="hrAttStatusFilter" aria-label="تصفية بالحالة">
                    <option value="">كل الحالات</option>
                    <option value="present">حاضر</option>
                    <option value="late">متأخر</option>
                </select>
                <input class="form-control filter-select" id="hrAttStartFilter" type="date" value="${esc(attState.startDate)}" aria-label="بداية السجلات">
                <input class="form-control filter-select" id="hrAttEndFilter" type="date" value="${esc(attState.endDate)}" aria-label="نهاية السجلات">
            </div>
            <div id="hrAttRecordsList"></div>
            <div id="hrAttCorrectSlot"></div>
        </section>`;
    renderAttShifts(container);
    wireAttendancePage(container);
    await Promise.all([
        refreshAttToday(container), refreshAttKpis(container),
        refreshAttSummary(container), refreshAttRecords(container)
    ]);
    attState.loaded = true;
}

function renderAttShifts(container) {
    const list = document.getElementById('hrAttShiftsList');
    if (!list) return;
    const rows = attState.shifts;
    if (!rows.length) {
        list.innerHTML = '<p class="muted">لا توجد ورديات بعد — أضف أول وردية من النموذج أدناه.</p>';
        return;
    }
    list.innerHTML = `<div class="table-scroll"><table class="report-table"><thead><tr>
        <th>الوردية</th><th>الوقت</th><th>أيام العمل</th><th>السماح</th><th>المسندون</th><th>الحالة</th><th>إجراءات</th>
    </tr></thead><tbody>
    ${rows.map(s => `<tr>
        <td>${esc(s.name)}</td>
        <td dir="ltr">${esc(String(s.start_time).slice(0, 5))} – ${esc(String(s.end_time).slice(0, 5))}</td>
        <td>${esc(attendanceWorkingDaysLabel(s.working_days))}</td>
        <td>${esc(String(s.grace_minutes))} دقيقة</td>
        <td>${esc(String(s.assignments_count ?? 0))}</td>
        <td>${s.is_active ? '<span class="pill status-tone-success">نشطة</span>' : '<span class="pill status-neutral">مؤرشفة</span>'}</td>
        <td>${s.is_active ? `<button type="button" class="btn btn-ghost btn-sm" data-hr-shift-archive="${esc(s.id)}">أرشفة</button>` : ''}</td>
    </tr>`).join('')}
    </tbody></table></div>`;
    list.querySelectorAll('[data-hr-shift-archive]').forEach(b => b.addEventListener('click', async () => {
        const res = await updateHrShift(b.getAttribute('data-hr-shift-archive'), { isActive: false });
        if (!res.ok) { window.alert(blockReason(res)); return; }
        await reloadAttShifts(container);
    }));
}

async function reloadAttShifts(container) {
    const res = await fetchHrShifts(false);
    if (res.ok) {
        const d = res.data || {};
        attState.shifts = Array.isArray(d.rows) ? d.rows : [];
        renderAttShifts(container);
    }
}

function wireAttendancePage(container) {
    container.querySelector('[data-hr-shift-form]').addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const fields = {
            name: String(fd.get('name') || '').trim(),
            startTime: String(fd.get('startTime') || ''),
            endTime: String(fd.get('endTime') || ''),
            workingDays: fd.getAll('workingDays').map(v => Number(v)),
            graceMinutes: Number(fd.get('graceMinutes') || 0)
        };
        const check = validateShiftForm(fields);
        const errEl = container.querySelector('[data-hr-shift-form-error]');
        if (!check.isValid) {
            errEl.textContent = Object.values(check.errors)[0];
            errEl.hidden = false;
            return;
        }
        errEl.hidden = true;
        const res = await createHrShift(fields);
        if (!res.ok) {
            errEl.textContent = blockReason(res);
            errEl.hidden = false;
            return;
        }
        e.target.reset();
        e.target.querySelector('[name="graceMinutes"]').value = '15';
        HR_WEEKDAYS.forEach(d => {
            const cb = e.target.querySelector(`[name="workingDays"][value="${d.value}"]`);
            if (cb) cb.checked = d.value <= 4;
        });
        await reloadAttShifts(container);
    });

    container.querySelector('[data-hr-shift-assign-form]').addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const errEl = container.querySelector('[data-hr-shift-assign-error]');
        const employeeId = String(fd.get('employeeId') || '');
        const shiftId = String(fd.get('shiftId') || '');
        const effectiveFrom = String(fd.get('effectiveFrom') || '') || null;
        if (!employeeId || !shiftId) {
            errEl.textContent = 'حدّد الموظف والوردية أولًا.';
            errEl.hidden = false;
            return;
        }
        errEl.hidden = true;
        const res = await assignHrShift(employeeId, shiftId, effectiveFrom);
        if (!res.ok) {
            errEl.textContent = blockReason(res);
            errEl.hidden = false;
            return;
        }
        await reloadAttShifts(container);
    });

    document.getElementById('hrAttSummaryEmp').addEventListener('change', (e) => {
        attState.summaryEmployeeId = e.target.value || '';
        refreshAttSummary(container);
    });
    document.getElementById('hrAttSummaryStart').addEventListener('change', (e) => {
        attState.summaryStart = e.target.value || attMonthStartIso();
        refreshAttSummary(container);
    });
    document.getElementById('hrAttSummaryEnd').addEventListener('change', (e) => {
        attState.summaryEnd = e.target.value || attTodayIso();
        refreshAttSummary(container);
    });
    document.getElementById('hrAttSummaryLoadBtn').addEventListener('click', () => refreshAttSummary(container));
    document.getElementById('hrAttEmpFilter').addEventListener('change', (e) => {
        attState.employeeId = e.target.value || '';
        attState.page = 1;
        refreshAttRecords(container);
    });
    document.getElementById('hrAttStatusFilter').addEventListener('change', (e) => {
        attState.status = e.target.value || '';
        attState.page = 1;
        refreshAttRecords(container);
    });
    document.getElementById('hrAttStartFilter').addEventListener('change', (e) => {
        attState.startDate = e.target.value || attMonthStartIso();
        attState.page = 1;
        refreshAttRecords(container);
    });
    document.getElementById('hrAttEndFilter').addEventListener('change', (e) => {
        attState.endDate = e.target.value || attTodayIso();
        attState.page = 1;
        refreshAttRecords(container);
    });
}

async function refreshAttToday(container) {
    const body = document.getElementById('hrAttTodayBody');
    if (!body) return;
    const res = await fetchHrAttendanceToday();
    if (!res.ok) {
        body.innerHTML = `<p class="error-text">${esc(blockReason(res))}</p>`;
        return;
    }
    const t = res.data || {};
    attState.today = t;
    const rec = t.record || null;
    const shift = t.shift || null;
    const statusInfo = rec ? attendanceStatusInfo(rec.status) : null;
    body.innerHTML = `
        <dl class="hr-detail-list">
            <div><dt>تاريخ الخادم</dt><dd>${esc(String(t.server_date || '—'))}</dd></div>
            <div><dt>وقت الخادم الآن</dt><dd dir="ltr">${esc(String(t.server_time || '—').slice(0, 5))}</dd></div>
            <div><dt>الموظف</dt><dd>${esc(t.employee_name || '—')} <small dir="ltr">${esc(t.employee_number || '')}</small></dd></div>
            <div><dt>وردية اليوم</dt><dd>${shift ? `${esc(shift.name)} (${esc(String(shift.start_time).slice(0, 5))}–${esc(String(shift.end_time).slice(0, 5))}، سماح ${esc(String(shift.grace_minutes))} دقيقة)` : 'بلا وردية مسندة — الدخول يُحسب حاضرًا'}</dd></div>
            ${rec ? `<div><dt>دخول اليوم</dt><dd>${esc(attendanceTimeLabel(rec.check_in_at))} ${pill(statusInfo)}</dd></div>
            <div><dt>خروج اليوم</dt><dd>${rec.check_out_at ? esc(attendanceTimeLabel(rec.check_out_at)) : 'لم يُسجَّل بعد'}</dd></div>
            <div><dt>دقائق العمل</dt><dd>${esc(formatWorkedMinutes(rec.worked_minutes))}</dd></div>` : '<div><dt>دخول اليوم</dt><dd>لم يُسجَّل بعد</dd></div>'}
        </dl>
        <div class="form-actions">
            <button type="button" class="btn btn-primary" id="hrAttCheckInBtn" ${t.can_check_in ? '' : 'disabled'}>تسجيل دخول</button>
            <button type="button" class="btn btn-ghost" id="hrAttCheckOutBtn" ${t.can_check_out ? '' : 'disabled'}>تسجيل خروج</button>
        </div>
        <p class="error-text" data-hr-att-today-error hidden></p>
        <p class="muted">تسجيل الدخول مرتين في اليوم نفسه مرفوض من القاعدة؛
        والخروج بلا دخول مرفوض أيضًا.</p>`;
    body.querySelector('#hrAttCheckInBtn').addEventListener('click', async () => {
        const errEl = body.querySelector('[data-hr-att-today-error]');
        const result = await checkInHrAttendance(null, null);
        if (!result.ok) {
            errEl.textContent = blockReason(result);
            errEl.hidden = false;
            return;
        }
        errEl.hidden = true;
        await Promise.all([refreshAttToday(container), refreshAttKpis(container), refreshAttRecords(container)]);
    });
    body.querySelector('#hrAttCheckOutBtn').addEventListener('click', async () => {
        const errEl = body.querySelector('[data-hr-att-today-error]');
        const result = await checkOutHrAttendance(null, null);
        if (!result.ok) {
            errEl.textContent = blockReason(result);
            errEl.hidden = false;
            return;
        }
        errEl.hidden = true;
        await Promise.all([refreshAttToday(container), refreshAttKpis(container), refreshAttRecords(container), refreshAttSummary(container)]);
    });
}

async function refreshAttKpis(container) {
    const kpis = document.getElementById('hrAttendanceKpis');
    if (!kpis) return;
    const [present, late] = await Promise.all([
        fetchHrAttendanceList({ page: 1, pageSize: 1, status: 'present', startDate: attState.startDate, endDate: attState.endDate }),
        fetchHrAttendanceList({ page: 1, pageSize: 1, status: 'late', startDate: attState.startDate, endDate: attState.endDate })
    ]);
    attState.presentTotal = present.ok ? Number(present.data?.total || 0) : 0;
    attState.lateTotal = late.ok ? Number(late.data?.total || 0) : 0;
    kpis.innerHTML = `
        <div class="kpi kpi--success">
            <p class="kpi-label">${icon('check', 16)}سجلات حضور</p>
            <p class="kpi-value">${esc(String(attState.presentTotal))}</p>
            <p class="kpi-hint">حاضر في الفترة</p>
        </div>
        <div class="kpi kpi--warning">
            <p class="kpi-label">${icon('clock', 16)}سجلات متأخرة</p>
            <p class="kpi-value">${esc(String(attState.lateTotal))}</p>
            <p class="kpi-hint">بعد البداية + السماح</p>
        </div>
        <div class="kpi">
            <p class="kpi-label">${icon('briefcase', 16)}الورديات</p>
            <p class="kpi-value">${esc(String(attState.shifts.filter(s => s.is_active).length))}</p>
            <p class="kpi-hint">وردية نشطة</p>
        </div>`;
}

async function refreshAttSummary(container) {
    const body = document.getElementById('hrAttSummaryBody');
    if (!body) return;
    if (!attState.summaryEmployeeId) {
        body.innerHTML = '<p class="muted">حدّد موظفًا لعرض ملخص حضوره.</p>';
        return;
    }
    renderState(body, { variant: 'loading', title: 'جارٍ تحميل ملخص الحضور…', text: '' });
    const result = await fetchHrAttendanceSummary({
        employeeId: attState.summaryEmployeeId,
        startDate: attState.summaryStart, endDate: attState.summaryEnd
    });
    if (!result.ok) {
        renderState(body, { variant: 'error', title: 'تعذّر تحميل ملخص الحضور', text: blockReason(result) });
        return;
    }
    const s = result.data || {};
    body.innerHTML = `
        <div class="kpi-grid">
            <div class="kpi"><p class="kpi-label">أيام متوقعة</p><p class="kpi-value">${esc(String(s.expected_days ?? 0))}</p></div>
            <div class="kpi kpi--success"><p class="kpi-label">حاضر</p><p class="kpi-value">${esc(String(s.present_days ?? 0))}</p></div>
            <div class="kpi kpi--warning"><p class="kpi-label">متأخر</p><p class="kpi-value">${esc(String(s.late_days ?? 0))}</p></div>
            <div class="kpi kpi--danger"><p class="kpi-label">غائب</p><p class="kpi-value">${esc(String(s.absent_days ?? 0))}</p></div>
            <div class="kpi"><p class="kpi-label">في إجازة معتمَدة</p><p class="kpi-value">${esc(String(s.on_leave_days ?? 0))}</p></div>
            <div class="kpi"><p class="kpi-label">دقائق العمل</p><p class="kpi-value">${esc(formatWorkedMinutes(s.total_worked_minutes))}</p></div>
        </div>
        <p class="muted">الفترة: ${esc(String(s.start_date || ''))} → ${esc(String(s.end_date || ''))} — الأيام المتوقعة من ورديات الموظف السارية وأيام عملها فقط.</p>`;
}

async function refreshAttRecords(container) {
    const list = document.getElementById('hrAttRecordsList');
    if (!list) return;
    renderState(list, { variant: 'loading', title: 'جارٍ تحميل سجلات الحضور…', text: '' });
    const { page, pageSize } = hrPageParams(attState.page, attState.pageSize);
    const result = await fetchHrAttendanceList({
        page, pageSize, employeeId: attState.employeeId || null,
        startDate: attState.startDate, endDate: attState.endDate,
        status: attState.status || null
    });
    if (!result.ok) {
        renderState(list, {
            variant: 'error', title: 'تعذّر تحميل سجلات الحضور', text: blockReason(result),
            action: { label: 'إعادة المحاولة', retry: 'hr-attendance', variant: 'btn-primary' }
        });
        return;
    }
    const data = result.data || {};
    const rows = Array.isArray(data.rows) ? data.rows.map(attendanceRowForDisplay) : [];
    attState.totalRecords = Number(data.total_count || data.total || 0);
    const view = hrPaginationView(attState.totalRecords, page, pageSize);
    if (!rows.length) {
        renderState(list, {
            variant: 'empty', title: 'لا توجد سجلات حضور',
            text: attState.status || attState.employeeId ? 'لا تطابق الفلاتر أي سجل.' : 'سجّل أول دخول من لوحة «تسجيل اليوم» أعلاه.'
        });
        return;
    }
    list.innerHTML = `
        <div class="table-scroll hr-table-sticky"><table class="report-table"><thead><tr>
            <th>الموظف</th><th>التاريخ</th><th>الدخول</th><th>الخروج</th><th>الحالة</th><th>الوردية</th><th>دقائق العمل</th><th>إجراءات</th>
        </tr></thead><tbody>
        ${rows.map(r => `<tr>
            <td>${esc(r.employeeName)} <small dir="ltr">${esc(r.employeeNumber)}</small></td>
            <td>${esc(r.workDate || '—')}</td>
            <td dir="ltr">${esc(r.checkInLabel)}</td><td dir="ltr">${esc(r.checkOutLabel)}</td>
            <td>${pill(r.statusInfo)}</td>
            <td>${esc(r.shiftName)}</td>
            <td>${esc(r.workedLabel)}</td>
            <td><button type="button" class="btn btn-ghost btn-sm" data-hr-att-correct="${esc(r.id)}">تصحيح</button></td>
        </tr>`).join('')}
        </tbody></table></div>
        <div class="pager" data-hr-pager>
            <button type="button" class="btn btn-ghost btn-sm" data-hr-prev ${view.hasPrev ? '' : 'disabled'}>السابقة</button>
            <span>صفحة ${esc(String(view.page))} من ${esc(String(view.totalPages))} — ${esc(String(view.total))} سجلًا</span>
            <button type="button" class="btn btn-ghost btn-sm" data-hr-next ${view.hasNext ? '' : 'disabled'}>التالية</button>
        </div>`;
    list.querySelector('[data-hr-prev]')?.addEventListener('click', () => { attState.page = view.page - 1; refreshAttRecords(container); });
    list.querySelector('[data-hr-next]')?.addEventListener('click', () => { attState.page = view.page + 1; refreshAttRecords(container); });
    list.querySelectorAll('[data-hr-att-correct]').forEach(b => b.addEventListener('click', () => {
        const row = rows.find(r => r.id === b.getAttribute('data-hr-att-correct'));
        if (row) showAttCorrectForm(row, container);
    }));
}

function showAttCorrectForm(row, container) {
    const slot = document.getElementById('hrAttCorrectSlot');
    if (!slot) return;
    const toLocalInput = (iso) => {
        if (!iso) return '';
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return '';
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };
    slot.innerHTML = `
        <div class="hr-detail-card">
            <h3>تصحيح سجل ${esc(row.employeeName)} — ${esc(row.workDate || '—')}</h3>
            <form class="hr-form" data-hr-att-correct-form>
                <div class="form-grid">
                    <label>وقت الدخول <input class="form-control" name="checkInAt" type="datetime-local" value="${esc(toLocalInput(row.checkInAt))}" dir="ltr"></label>
                    <label>وقت الخروج <input class="form-control" name="checkOutAt" type="datetime-local" value="${esc(toLocalInput(row.checkOutAt))}" dir="ltr"></label>
                    <label>ملاحظة <input class="form-control" name="note" maxlength="1000" value="${esc(row.note || '')}"></label>
                </div>
                <p class="muted">اترك وقت الخروج فارغًا لإبقائه كما هو. التصحيح يتطلب
                سببًا (10 أحرف على الأقل) ويُوثَّق في سجل التدقيق.</p>
                <div class="form-actions">
                    <button type="submit" class="btn btn-primary">حفظ التصحيح</button>
                    <button type="button" class="btn btn-ghost" data-hr-att-correct-cancel>إلغاء</button>
                </div>
                <p class="error-text" data-hr-att-correct-error hidden></p>
            </form>
        </div>`;
    slot.querySelector('[data-hr-att-correct-cancel]').addEventListener('click', () => { slot.innerHTML = ''; });
    slot.querySelector('[data-hr-att-correct-form]').addEventListener('submit', async (e) => {
        e.preventDefault();
        const reason = await askReason('تصحيح سجل الحضور');
        if (!reason) return;
        const fd = new FormData(e.target);
        const errEl = slot.querySelector('[data-hr-att-correct-error]');
        const checkInAt = String(fd.get('checkInAt') || '') || null;
        const checkOutAt = String(fd.get('checkOutAt') || '') || null;
        const note = String(fd.get('note') || '').trim();
        const res = await correctHrAttendance(row.id, {
            checkInAt: checkInAt ? new Date(checkInAt).toISOString() : null,
            checkOutAt: checkOutAt ? new Date(checkOutAt).toISOString() : null,
            note, reason
        });
        if (!res.ok) {
            errEl.textContent = blockReason(res);
            errEl.hidden = false;
            return;
        }
        slot.innerHTML = '';
        await Promise.all([refreshAttRecords(container), refreshAttSummary(container), refreshAttKpis(container)]);
    });
}

/** نقطة دخول واحدة من company-dashboard.js: ربط أزرار إعادة المحاولة. */
/* ── التقارير (الترحيل 157 — قراءة فقط) ─────────────────────────────────── */

const reportsState = { ...hrReportMonthDefaults(), loaded: false };

/** بلوك عدد: بطاقات إجمالي + جدول الأقسام. */
function renderReportsHeadcount(data) {
    const d = data || {};
    const totals = d.totals || {};
    const rows = (Array.isArray(d.rows) ? d.rows : []).map(headcountRowForDisplay).filter(Boolean);
    const statusCards = ['active', 'on_leave', 'suspended', 'terminated', 'pending_data'].map((status) => {
        const info = employeeStatusInfo(status);
        return `<div class="kpi">
            <p class="kpi-label">${esc(info.label)}</p>
            <p class="kpi-value">${esc(String(totals[status] ?? 0))}</p>
        </div>`;
    }).join('');
    const body = rows.length ? `<div class="table-scroll"><table class="report-table"><thead><tr>
        <th>القسم</th><th>الإجمالي</th><th>نشط</th><th>في إجازة</th><th>موقوف</th><th>منتهٍ</th><th>بيانات ناقصة</th>
        </tr></thead><tbody>${rows.map(r => `<tr>
            <td>${esc(r.departmentName)}</td><td>${esc(String(r.total))}</td>
            <td>${esc(String(r.active))}</td><td>${esc(String(r.onLeave))}</td>
            <td>${esc(String(r.suspended))}</td><td>${esc(String(r.terminated))}</td>
            <td>${esc(String(r.pendingData))}</td></tr>`).join('')}
        </tbody></table></div>`
        : '<p class="muted">لا موظفون في هذه الفترة.</p>';
    return `<section class="panel" aria-labelledby="hrRepHeadHeading">
        <div class="panel-header"><div>
            <h2 class="panel-title" id="hrRepHeadHeading">العدد حسب القسم والحالة</h2>
            <p class="panel-subtitle">لقطة بتاريخ ${esc(String(d.to || ''))}: موظف يُحسب إن كان معيّنًا في ذلك التاريخ أو قبله ولم يُؤرشف قبله.</p>
        </div></div>
        <div class="kpi-grid">
            <div class="kpi kpi--accent">
                <p class="kpi-label">${icon('users', 16)}إجمالي الموظفين</p>
                <p class="kpi-value">${esc(String(totals.total ?? 0))}</p>
            </div>
            ${statusCards}
        </div>
        ${body}
    </section>`;
}

/** بلوك حضور: بطاقات إجمالي + جدول الأقسام بالنسب؛ أو ملاحظة حين القسم غير مفعّل. */
function renderReportsAttendance(res) {
    if (!res?.ok) {
        return `<section class="panel" aria-labelledby="hrRepAttHeading">
            <div class="panel-header"><div>
                <h2 class="panel-title" id="hrRepAttHeading">الحضور والانصراف</h2>
            </div></div>
            <p class="error-text">${esc(blockReason(res))}</p>
        </section>`;
    }
    const d = res.data || {};
    if (d.available === false) {
        return `<section class="panel" aria-labelledby="hrRepAttHeading">
            <div class="panel-header"><div>
                <h2 class="panel-title" id="hrRepAttHeading">الحضور والانصراف</h2>
                <p class="panel-subtitle">هذا البلوك غير متاح — قسم الحضور والانصراف غير مفعّل لشركتك.</p>
            </div></div>
            <p class="muted">${esc(String(d.reason || 'قسم الحضور والانصراف غير مفعّل لشركتك'))}</p>
        </section>`;
    }
    const totals = d.totals || {};
    const rows = (Array.isArray(d.rows) ? d.rows : []).map(reportAttendanceRowForDisplay).filter(Boolean);
    const body = rows.length ? `<div class="table-scroll"><table class="report-table"><thead><tr>
        <th>القسم</th><th>موظفون</th><th>أيام متوقعة</th><th>حاضر</th><th>متأخر</th><th>غائب</th><th>في إجازة</th>
        <th>نسبة الحضور</th><th>نسبة الغياب</th><th>دقائق العمل</th>
        </tr></thead><tbody>${rows.map(r => `<tr>
            <td>${esc(r.departmentName)}</td><td>${esc(String(r.employeesCount))}</td>
            <td>${esc(String(r.expectedDays))}</td><td>${esc(String(r.presentDays))}</td>
            <td>${esc(String(r.lateDays))}</td><td>${esc(String(r.absentDays))}</td>
            <td>${esc(String(r.onLeaveDays))}</td>
            <td>${esc(hrReportShareLabel(r.presentRate))}</td>
            <td>${esc(hrReportShareLabel(r.absentRate))}</td>
            <td>${esc(formatWorkedMinutes(r.totalWorkedMinutes))}</td></tr>`).join('')}
        </tbody></table></div>`
        : '<p class="muted">لا حضور في هذه الفترة — تحقق من إسناد الورديات للموظفين.</p>';
    return `<section class="panel" aria-labelledby="hrRepAttHeading">
        <div class="panel-header"><div>
            <h2 class="panel-title" id="hrRepAttHeading">الحضور والانصراف</h2>
            <p class="panel-subtitle">النسب مقامها الأيام المتوقعة (أيام عمل الوردية السارية)؛ والغياب مشتق: يوم عمل بلا سجل وبلا إجازة معتمَدة.</p>
        </div></div>
        <div class="kpi-grid">
            <div class="kpi kpi--accent">
                <p class="kpi-label">${icon('clock', 16)}أيام متوقعة</p>
                <p class="kpi-value">${esc(String(totals.expected_days ?? 0))}</p>
                <p class="kpi-hint">${esc(String(totals.employees_count ?? 0))} موظف — منهم ${esc(String(totals.employees_no_expected_days ?? 0))} بلا أيام متوقعة</p>
            </div>
            <div class="kpi kpi--success">
                <p class="kpi-label">نسبة الحضور</p>
                <p class="kpi-value">${esc(hrReportShareLabel(totals.present_rate))}</p>
                <p class="kpi-hint">${esc(String(totals.present_days ?? 0))} يوم حاضر</p>
            </div>
            <div class="kpi kpi--warning">
                <p class="kpi-label">نسبة التأخير</p>
                <p class="kpi-value">${esc(hrReportShareLabel(totals.late_rate))}</p>
                <p class="kpi-hint">${esc(String(totals.late_days ?? 0))} يوم متأخر</p>
            </div>
            <div class="kpi kpi--danger">
                <p class="kpi-label">نسبة الغياب</p>
                <p class="kpi-value">${esc(hrReportShareLabel(totals.absent_rate))}</p>
                <p class="kpi-hint">${esc(String(totals.absent_days ?? 0))} يوم غائب · ${esc(String(totals.on_leave_days ?? 0))} يوم في إجازة</p>
            </div>
            <div class="kpi">
                <p class="kpi-label">دقائق العمل</p>
                <p class="kpi-value">${esc(formatWorkedMinutes(totals.total_worked_minutes))}</p>
            </div>
        </div>
        ${body}
    </section>`;
}

/** بلوك إجازات: بطاقات إجمالي + جدول (قسم × نوع)؛ أو ملاحظة حين القسم غير مفعّل. */
function renderReportsLeave(res) {
    if (!res?.ok) {
        return `<section class="panel" aria-labelledby="hrRepLeaveHeading">
            <div class="panel-header"><div>
                <h2 class="panel-title" id="hrRepLeaveHeading">الإجازات والأرصدة</h2>
            </div></div>
            <p class="error-text">${esc(blockReason(res))}</p>
        </section>`;
    }
    const d = res.data || {};
    if (d.available === false) {
        return `<section class="panel" aria-labelledby="hrRepLeaveHeading">
            <div class="panel-header"><div>
                <h2 class="panel-title" id="hrRepLeaveHeading">الإجازات والأرصدة</h2>
                <p class="panel-subtitle">هذا البلوك غير متاح — قسم الإجازات غير مفعّل لشركتك.</p>
            </div></div>
            <p class="muted">${esc(String(d.reason || 'قسم الإجازات غير مفعّل لشركتك'))}</p>
        </section>`;
    }
    const totals = d.totals || {};
    const rows = (Array.isArray(d.rows) ? d.rows : []).map(reportLeaveRowForDisplay).filter(Boolean);
    const days = (v) => (v == null ? '—' : String(v));
    const body = rows.length ? `<div class="table-scroll"><table class="report-table"><thead><tr>
        <th>القسم</th><th>النوع</th><th>موظفون</th><th>الرصيد الكلي</th><th>المستخدم (السنة)</th><th>المتبقي</th>
        <th>أيام معتمَدة (الفترة)</th><th>طلبات معتمَدة</th><th>طلبات معلقة</th>
        </tr></thead><tbody>${rows.map(r => `<tr>
            <td>${esc(r.departmentName)}</td><td>${esc(r.typeName)}</td>
            <td>${esc(String(r.employeesCount))}</td>
            <td>${esc(days(r.totalDays))}</td><td>${esc(days(r.usedDays))}</td><td>${esc(days(r.remainingDays))}</td>
            <td>${esc(String(r.approvedDaysInRange))}</td>
            <td>${esc(String(r.approvedRequestsInRange))}</td>
            <td>${esc(String(r.pendingRequestsInRange))}</td></tr>`).join('')}
        </tbody></table></div>`
        : '<p class="muted">لا أرصدة إجازات بعد — تُنشأ تلقائيًا من افتراضيات الأنواع عند أول قراءة.</p>';
    return `<section class="panel" aria-labelledby="hrRepLeaveHeading">
        <div class="panel-header"><div>
            <h2 class="panel-title" id="hrRepLeaveHeading">الإجازات والأرصدة</h2>
            <p class="panel-subtitle">الأرصدة لسنة ${esc(String(d.year ?? ''))}؛ والاستخدام داخل الفترة أيام تقويمية من الطلبات المعتمَدة المتداخلة معها. الأنواع بلا رصيد (بدون أجر) تظهر «—» لا صفرًا.</p>
        </div></div>
        <div class="kpi-grid">
            <div class="kpi kpi--accent">
                <p class="kpi-label">${icon('file', 16)}الرصيد الكلي (السنة)</p>
                <p class="kpi-value">${esc(days(totals.total_days))}</p>
                <p class="kpi-hint">يوم إجازة</p>
            </div>
            <div class="kpi">
                <p class="kpi-label">المستخدم (السنة)</p>
                <p class="kpi-value">${esc(days(totals.used_days))}</p>
                <p class="kpi-hint">يوم إجازة</p>
            </div>
            <div class="kpi kpi--success">
                <p class="kpi-label">المتبقي (السنة)</p>
                <p class="kpi-value">${esc(days(totals.remaining_days))}</p>
                <p class="kpi-hint">يوم إجازة</p>
            </div>
            <div class="kpi">
                <p class="kpi-label">أيام معتمَدة (الفترة)</p>
                <p class="kpi-value">${esc(String(totals.approved_days_in_range ?? 0))}</p>
                <p class="kpi-hint">${esc(String(totals.approved_requests_in_range ?? 0))} طلب معتمَد · ${esc(String(totals.pending_requests_in_range ?? 0))} طلب معلق</p>
            </div>
        </div>
        ${body}
    </section>`;
}

/** بلوك تذاكر: بطاقات إجمالي الشركة + جدول الموظفين + جدول الأقسام؛ أو ملاحظة حين القسم غير مفعّل. */
function renderReportsTickets(res) {
    if (!res?.ok) {
        return `<section class="panel" aria-labelledby="hrRepTickHeading">
            <div class="panel-header"><div>
                <h2 class="panel-title" id="hrRepTickHeading">أداء التذاكر</h2>
            </div></div>
            <p class="error-text">${esc(blockReason(res))}</p>
        </section>`;
    }
    const d = res.data || {};
    if (d.available === false) {
        return `<section class="panel" aria-labelledby="hrRepTickHeading">
            <div class="panel-header"><div>
                <h2 class="panel-title" id="hrRepTickHeading">أداء التذاكر</h2>
                <p class="panel-subtitle">هذا البلوك غير متاح — قسم الموظفين غير مفعّل لشركتك.</p>
            </div></div>
            <p class="muted">${esc(String(d.reason || 'قسم الموظفين غير مفعّل لشركتك'))}</p>
        </section>`;
    }
    const totals = d.totals || {};
    const unlinked = d.unlinked || {};
    const empRows = (Array.isArray(d.rows) ? d.rows : []).map(reportTicketEmployeeRowForDisplay).filter(Boolean);
    const deptRows = (Array.isArray(d.department_rows) ? d.department_rows : []).map(reportTicketDepartmentRowForDisplay).filter(Boolean);
    const empBody = empRows.length ? `<div class="table-scroll"><table class="report-table"><thead><tr>
        <th>الموظف</th><th>القسم</th><th>مرتبط</th><th>أُسندت (الفترة)</th><th>مفتوحة الآن</th>
        <th>أُغلقت (الفترة)</th><th>مرفوضة</th><th>معدل أول استجابة</th>
        <th>متوسط أول استجابة</th><th>وسيط أول استجابة</th><th>متوسط الحل</th><th>وسيط الحل</th>
        </tr></thead><tbody>${empRows.map(r => `<tr>
            <td>${esc(r.employeeName)} (${esc(r.employeeNumber)})</td>
            <td>${esc(r.departmentName)}</td>
            <td>${r.linked ? 'مرتبط' : 'بلا حساب مرتبط'}</td>
            <td>${esc(String(r.assignedInWindow))}</td><td>${esc(String(r.openNow))}</td>
            <td>${esc(String(r.resolvedInWindow))}</td><td>${esc(String(r.rejectedInWindow))}</td>
            <td>${esc(hrReportShareLabel(r.firstResponseRate))}</td>
            <td>${esc(formatHrDuration(r.avgFirstResponseSeconds))}</td>
            <td>${esc(formatHrDuration(r.medianFirstResponseSeconds))}</td>
            <td>${esc(formatHrDuration(r.avgResolutionSeconds))}</td>
            <td>${esc(formatHrDuration(r.medianResolutionSeconds))}</td></tr>`).join('')}
        </tbody></table></div>`
        : '<p class="muted">لا موظفون ظاهرون في هذا التقرير.</p>';
    const deptBody = deptRows.length ? `<div class="table-scroll"><table class="report-table"><thead><tr>
        <th>القسم</th><th>موظفون مرتبطون</th><th>أُسندت (الفترة)</th><th>مفتوحة الآن</th>
        <th>أُغلقت (الفترة)</th><th>مرفوضة</th><th>معدل أول استجابة</th>
        <th>متوسط أول استجابة</th><th>متوسط الحل</th>
        </tr></thead><tbody>${deptRows.map(r => `<tr>
            <td>${esc(r.departmentName)}</td><td>${esc(String(r.employeesLinked))}</td>
            <td>${esc(String(r.assignedInWindow))}</td><td>${esc(String(r.openNow))}</td>
            <td>${esc(String(r.resolvedInWindow))}</td><td>${esc(String(r.rejectedInWindow))}</td>
            <td>${esc(hrReportShareLabel(r.firstResponseRate))}</td>
            <td>${esc(formatHrDuration(r.avgFirstResponseSeconds))}</td>
            <td>${esc(formatHrDuration(r.avgResolutionSeconds))}</td></tr>`).join('')}
        </tbody></table></div>`
        : '<p class="muted">لا أقسام فيها موظفون مرتبطون بعد.</p>';
    return `<section class="panel" aria-labelledby="hrRepTickHeading">
        <div class="panel-header"><div>
            <h2 class="panel-title" id="hrRepTickHeading">أداء التذاكر</h2>
            <p class="panel-subtitle">إجماليات الشركة تشمل كل تذاكر الشركة (بما فيها غير المسندة والمسندة لحساب غير مرتبط بموظف)؛ والموظف بلا حساب مرتبط يظهر في الجدول بأصفار لا بإسقاط صامت.</p>
        </div></div>
        <div class="kpi-grid">
            <div class="kpi kpi--accent">
                <p class="kpi-label">${icon('inbox', 16)}أُسندت (الفترة)</p>
                <p class="kpi-value">${esc(String(totals.assigned_in_window ?? 0))}</p>
                <p class="kpi-hint">تذكرة في الشركة كلها</p>
            </div>
            <div class="kpi kpi--warning">
                <p class="kpi-label">مفتوحة الآن</p>
                <p class="kpi-value">${esc(String(totals.open_now ?? 0))}</p>
            </div>
            <div class="kpi kpi--success">
                <p class="kpi-label">أُغلقت (الفترة)</p>
                <p class="kpi-value">${esc(String(totals.resolved_in_window ?? 0))}</p>
            </div>
            <div class="kpi">
                <p class="kpi-label">غير مرتبطة بموظف</p>
                <p class="kpi-value">${esc(String(unlinked.unassigned_in_window ?? 0))}</p>
                <p class="kpi-hint">بلا إسناد في الفترة · ${esc(String(unlinked.assigned_to_unlinked_in_window ?? 0))} مسندة لحساب غير مرتبط بموظف</p>
            </div>
        </div>
        <h3 class="panel-title">حسب الموظف</h3>
        ${empBody}
        <h3 class="panel-title">حسب القسم</h3>
        ${deptBody}
    </section>`;
}

/** يعيد تحميل التقارير الأربعة للفترة الحالية ويرسم بلوكاتها.
 *  headRes اختياري: نتيجة عدد سبق جلبها (فحص البوابة في loadHrReports). */
async function refreshReports(container, headRes = null) {
    const blocks = document.getElementById('hrReportsBlocks');
    if (!blocks) return;
    blocks.innerHTML = '<p class="muted">جارٍ تحميل التقارير…</p>';
    const headPromise = headRes ? Promise.resolve(headRes)
        : fetchHrReportsHeadcount({ from: reportsState.from, to: reportsState.to });
    const [head, attRes, leaveRes, tickRes] = await Promise.all([
        headPromise,
        fetchHrReportsAttendance({ from: reportsState.from, to: reportsState.to }),
        fetchHrReportsLeave({ from: reportsState.from, to: reportsState.to }),
        fetchHrReportsTickets({ from: reportsState.from, to: reportsState.to })
    ]);
    if (!head.ok) {
        renderState(container, {
            variant: 'error', title: 'قسم التقارير غير مفعّل',
            text: blockReason(head),
            action: { label: 'إعادة المحاولة', retry: 'hr-reports', variant: 'btn-primary' }
        });
        return;
    }
    blocks.innerHTML = `
        ${renderReportsHeadcount(head.data)}
        ${renderReportsAttendance(attRes)}
        ${renderReportsLeave(leaveRes)}
        ${renderReportsTickets(tickRes)}`;
}

function wireReportsPage(container) {
    const btn = container.querySelector('#hrReportsLoadBtn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
        const fromEl = document.getElementById('hrReportsFrom');
        const toEl = document.getElementById('hrReportsTo');
        const errEl = document.getElementById('hrReportsPeriodError');
        const check = validateReportPeriod(fromEl?.value, toEl?.value);
        if (!check.isValid) {
            if (errEl) {
                errEl.textContent = Object.values(check.errors)[0] || 'فترة غير صالحة';
                errEl.hidden = false;
            }
            return;
        }
        if (errEl) errEl.hidden = true;
        reportsState.from = fromEl.value;
        reportsState.to = toEl.value;
        await refreshReports(container);
    });
}

export async function loadHrReports() {
    const container = document.getElementById('hrReportsBody');
    if (!container) return;
    renderState(container, { variant: 'loading', title: 'جارٍ تحميل تقارير الموارد البشرية…', text: '' });
    const headRes = await fetchHrReportsHeadcount({ from: reportsState.from, to: reportsState.to });
    if (!headRes.ok) {
        renderState(container, {
            variant: 'error', title: 'قسم التقارير غير مفعّل',
            text: blockReason(headRes),
            action: { label: 'إعادة المحاولة', retry: 'hr-reports', variant: 'btn-primary' }
        });
        return;
    }
    container.innerHTML = `
        <div class="toolbar hr-toolbar">
            <input class="form-control filter-select" id="hrReportsFrom" type="date" value="${esc(reportsState.from)}" aria-label="بداية الفترة">
            <input class="form-control filter-select" id="hrReportsTo" type="date" value="${esc(reportsState.to)}" aria-label="نهاية الفترة">
            <button type="button" class="btn btn-primary" id="hrReportsLoadBtn">عرض التقارير</button>
            <span class="error-text" id="hrReportsPeriodError" hidden></span>
        </div>
        <p class="muted">الافتراضي: الشهر الحالي حتى اليوم؛ والحد الأقصى للفترة 366 يومًا.
        كل رقم من قاعدة البيانات مباشرة، ومدير القسم يرى قسمه فقط.</p>
        <div id="hrReportsBlocks"></div>`;
    wireReportsPage(container);
    await refreshReports(container, headRes);
    reportsState.loaded = true;
}

export function initHrDashboard() {
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-retry]');
        if (!btn) return;
        const section = btn.getAttribute('data-retry');
        if (section === 'hr-overview') loadHrOverview();
        if (section === 'hr-employees') loadHrEmployees();
        if (section === 'hr-departments') loadHrDepartments();
        if (section === 'hr-import') loadHrImport();
        if (section === 'hr-leave') loadHrLeave();
        if (section === 'hr-attendance') loadHrAttendance();
        if (section === 'hr-reports') loadHrReports();
    });
}
