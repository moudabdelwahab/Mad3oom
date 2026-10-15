/**
 * company-access.js — «الأدوار والصلاحيات» و«سجل وصول مدعوم» (مجال الفريق والصلاحيات).
 *
 * الأدوار والصلاحيات (098):
 *   company_permissions_matrix() يقرؤها مدير الشركة حتى والمفتاح مطفأ، وتحمل enabled.
 *   التعديل company_set_role_permission ترفضه القاعدة ما دام المفتاح مطفأً — فالواجهة
 *   تعرض القيم للقراءة وتشرح السبب، ولا تقدّم مفاتيح تعديل لن تقبلها القاعدة.
 *
 * سجل وصول مدعوم (097):
 *   company_access_log() — منح الوصول المؤقت لطاقم مدعوم إلى تذاكر الشركة وعدد
 *   القراءات. قراءة فقط، لمدير الشركة وحده (null لغيره).
 *
 * لا معرّف شركة في أي نداء: الشركة من الجلسة داخل القاعدة.
 */
import {
    fetchCompanyPermissionsMatrix, setCompanyRolePermission, fetchCompanyAccessLog
} from '/assets/js/company/company-data.js';
import { escapeHtml, formatDate, renderState, renderSkeletonLines } from '/assets/js/customer/portal-ui.js';
import { ui } from '/ui-service.js';
import {
    PERMISSION_ROLES, permissionsView, REQUESTER_LABELS, grantState
} from '/assets/js/company/company-pages-model.js';

/* ── الأدوار والصلاحيات ──────────────────────────────────────────────────── */

let permissionsState = null;

export async function loadCompanyPermissions() {
    const box = document.getElementById('companyPermissions');
    if (!box) return;
    renderSkeletonLines(box, 5);

    const result = await fetchCompanyPermissionsMatrix();
    if (!result.ok) {
        renderPageError(box, 'تعذّر تحميل الصلاحيات', 'permissions');
        return;
    }
    const view = permissionsView(result.data);
    if (!view) {
        renderState(box, { variant: 'empty', title: 'الصلاحيات لمدير الشركة',
            text: 'هذه الصفحة تعرض أدوار الفريق لمدير الشركة وحده.' });
        return;
    }
    permissionsState = view;
    renderPermissions(box);
}

function renderPermissions(box) {
    const view = permissionsState;
    box.innerHTML = `
        <section class="panel" aria-labelledby="companyPermissionsHeading">
            <div class="panel-header">
                <div>
                    <h2 class="panel-title" id="companyPermissionsHeading">ما يستطيعه كل دور في فريق الشركة</h2>
                    <p class="panel-subtitle">المالك ومدير الشركة لهما كل الصلاحيات دائمًا. هنا ما يُمنح للمشرف وموظف الدعم.</p>
                </div>
                <span class="pill ${view.enabled ? 'status-tone-success' : 'status-neutral'}">
                    ${view.enabled ? 'التعديل متاح' : 'للقراءة فقط'}
                </span>
            </div>
            ${view.enabled ? '' : `
            <p class="company-notice">
                صلاحيات الفريق لم تُفعَّل لشركتك بعد، فهذه القيم المحفوظة لها وتُطبَّق عند التفعيل.
                التعديل يُتاح هنا تلقائيًا حين تفعّلها مدعوم.
            </p>`}
            <div class="table-scroll">
                <table class="report-table company-matrix">
                    <caption class="visually-hidden">صلاحيات المشرف وموظف الدعم</caption>
                    <thead>
                        <tr>
                            <th scope="col">الصلاحية</th>
                            ${PERMISSION_ROLES.map(r => `<th scope="col" class="is-center">${escapeHtml(r.label)}</th>`).join('')}
                        </tr>
                    </thead>
                    <tbody>
                        ${view.rows.map(row => `
                        <tr>
                            <th scope="row">
                                <span class="company-matrix-label">${escapeHtml(row.label)}</span>
                                ${row.description ? `<span class="company-matrix-desc">${escapeHtml(row.description)}</span>` : ''}
                            </th>
                            ${PERMISSION_ROLES.map(r => `<td class="is-center">${permissionCell(row, r, view.enabled)}</td>`).join('')}
                        </tr>`).join('')}
                    </tbody>
                </table>
            </div>
            ${view.overridesCount ? `
            <p class="field-hint">توجد ${view.overridesCount} صلاحية مخصّصة لـ ${view.overriddenUsers} عضو تتقدّم على قيمة دوره.</p>` : ''}
        </section>`;

    box.querySelectorAll('input[data-perm-key]').forEach(input => {
        input.addEventListener('change', () => onToggle(input));
    });
}

function permissionCell(row, role, enabled) {
    const allowed = row[role.key];
    if (!enabled) {
        return `<span class="pill ${allowed ? 'status-tone-success' : 'status-neutral'}">${allowed ? 'مسموح' : 'غير مسموح'}</span>`;
    }
    const id = `perm-${role.key}-${row.key.replace(/[^a-z0-9]/gi, '-')}`;
    return `
        <label class="company-switch" for="${escapeHtml(id)}">
            <input type="checkbox" id="${escapeHtml(id)}" data-perm-key="${escapeHtml(row.key)}"
                   data-perm-role="${escapeHtml(role.key)}" ${allowed ? 'checked' : ''}>
            <span class="visually-hidden">${escapeHtml(`${row.label} — ${role.label}`)}</span>
        </label>`;
}

async function onToggle(input) {
    const key = input.getAttribute('data-perm-key');
    const role = input.getAttribute('data-perm-role');
    const next = input.checked;
    input.disabled = true;
    const result = await setCompanyRolePermission(role, key, next);
    input.disabled = false;
    if (!result.ok) {
        // القاعدة رفضت: نعيد القيمة كما كانت ولا نعلن نجاحًا
        input.checked = !next;
        ui?.showToast?.('تعذّر حفظ الصلاحية. لم يتغيّر شيء.', 'error');
        return;
    }
    const row = permissionsState.rows.find(r => r.key === key);
    if (row) row[role] = next;
    ui?.showToast?.('حُفظت الصلاحية', 'success');
}

/* ── سجل وصول مدعوم ──────────────────────────────────────────────────────── */

export async function loadCompanyAccessLog() {
    const box = document.getElementById('companyAccessLog');
    if (!box) return;
    renderSkeletonLines(box, 4);

    const result = await fetchCompanyAccessLog();
    if (!result.ok) {
        renderPageError(box, 'تعذّر تحميل سجل الوصول', 'accessLog');
        return;
    }
    if (result.data === null || !Array.isArray(result.data)) {
        renderState(box, { variant: 'empty', title: 'السجل لمدير الشركة',
            text: 'يعرض هذا السجل لمدير الشركة وحده من وصل من مدعوم إلى تذاكر الشركة.' });
        return;
    }

    const grants = result.data;
    box.innerHTML = `
        <section class="panel" aria-labelledby="companyAccessLogHeading">
            <div class="panel-header">
                <div>
                    <h2 class="panel-title" id="companyAccessLogHeading">من وصل من مدعوم إلى تذاكر شركتك</h2>
                    <p class="panel-subtitle">كل وصول مؤقت مُنح لطاقم مدعوم، ومدّته، وعدد مرات القراءة الفعلية.</p>
                </div>
            </div>
            <div id="companyAccessLogBody"></div>
        </section>`;
    const body = document.getElementById('companyAccessLogBody');

    if (!grants.length) {
        renderState(body, { variant: 'empty', title: 'لا يوجد أي وصول مسجّل',
            text: 'لم يُمنح أي من طاقم مدعوم وصولًا إلى تذاكر شركتك.' });
        return;
    }
    body.innerHTML = `
        <div class="table-scroll">
            <table class="report-table">
                <caption class="visually-hidden">سجل وصول مدعوم</caption>
                <thead>
                    <tr>
                        <th scope="col">الجهة</th>
                        <th scope="col">النطاق</th>
                        <th scope="col">من</th>
                        <th scope="col">حتى</th>
                        <th scope="col">الحالة</th>
                        <th scope="col">مرات القراءة</th>
                    </tr>
                </thead>
                <tbody>
                    ${grants.map(g => {
                        const state = grantState(g);
                        return `
                    <tr>
                        <th scope="row">${escapeHtml(REQUESTER_LABELS[g.requester_kind] || 'طاقم مدعوم')}</th>
                        <td>${g.ticket_id ? 'تذكرة محددة' : 'كل تذاكر الشركة'}</td>
                        <td>${escapeHtml(g.starts_at ? formatDate(g.starts_at) : '—')}</td>
                        <td>${escapeHtml(g.revoked_at ? formatDate(g.revoked_at) : (g.expires_at ? formatDate(g.expires_at) : '—'))}</td>
                        <td><span class="pill ${escapeHtml(state.pill)}">${escapeHtml(state.label)}</span></td>
                        <td>${escapeHtml(String(Number(g.reads) || 0))}</td>
                    </tr>`;
                    }).join('')}
                </tbody>
            </table>
        </div>`;
}

/* ── مشترك ─────────────────────────────────────────────────────────────── */

/** خطأ قراءة بزر يعيد تحميل الصفحة نفسها فقط (لا اللوحة كلها). */
function renderPageError(box, title, page) {
    box.innerHTML = `
        <div class="state-block state-block--error">
            <p class="state-title">${escapeHtml(title)}</p>
            <p class="state-text">تحقق من اتصالك ثم أعد المحاولة.</p>
            <button type="button" class="btn btn-primary" data-page-retry="${escapeHtml(page)}">إعادة المحاولة</button>
        </div>`;
    box.querySelector('[data-page-retry]')?.addEventListener('click', () => {
        if (page === 'permissions') loadCompanyPermissions();
        else loadCompanyAccessLog();
    });
}
