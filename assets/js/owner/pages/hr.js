/**
 * owner/hr.html — الموارد البشرية تحت إشراف المالك (الترحيل 143).
 *
 *   • owner_hr_list_companies(text, integer): owner_capability('owner_only') في
 *     القاعدة — شركات واستحقاق وعدد موظفين فقط، بلا أي بيانات موظفين (لا أسماء
 *     ولا رواتب ولا أرقام قومية). 25 صفحة.
 *   • owner_hr_set_module(uuid, boolean, text) / owner_hr_set_section(uuid, text, boolean, text):
 *     owner_critical_ok() (سياق المالك + تحقق حديث خلال 10 دقائق) + سبب ≥10
 *     أحرف + مدقَّقة في privileged_audit و subscription_audit_log و hr_audit_logs.
 *     تفعيل/إيقاف = إدراج/حذف صف تجاوز؛ لا يوجد إيقاف مؤقت يُستأنف في هذه الخطوة.
 *   • owner_hr_operations_log(integer): سجل عمليات واحد من privileged_audit
 *     (hr.%) + subscription_audit_log (hr.%) + hr_audit_logs (entitlement.changed).
 *   • owner_set_feature_switch(text, boolean, text) (096): مفتاح المنصة العام
 *     hr_module_enabled — مالك المنصة + تحقق حديث، يُسجَّل في privileged_audit.
 *     بلا هذا المفتاح لا تعمل الوحدة لأي شركة.
 *   • owner_feature_switches (settings.js): قراءة حالة المفتاح العام الحالي.
 *   • لا window.prompt في هذه الصفحة إطلاقًا — الأسباب في نوافذ openModal.
 *   • الصفحة لا تعرض بيانات موظفين أبدًا — حالة استحقاق وعدد موظفين فقط.
 */

import {
    supabase, bootOwnerPage, announce, esc, when, num, table, kpis, errorBlock, loadingBlock, stateBlock, openModal,
    friendlyError, renderPager
} from '/assets/js/owner/owner-page.js';
import { searchTerm, storeReasonError } from '/assets/js/owner/owner-labels.js';
import { HR_SECTION_LABELS, hrCompanyStatusInfo, hrEntitlementSummary } from '/assets/js/company/hr-model.js';

const $ = (id) => document.getElementById(id);
const say = (text, tone = 'info') => announce($('pageStatus'), text, tone);
const PAGE_SIZE = 25;

const SECTION_KEYS = ['hr_leave', 'hr_payroll', 'hr_tasks', 'hr_attendance', 'hr_reports'];

let companiesPage = 1;
let companiesSearch = '';
let companiesTotal = 0;
let companiesRows = [];
let switchEnabled = null;

async function rpc(fnName, args) {
    const { data, error } = await supabase.rpc(fnName, args);
    if (error) throw error;
    return data;
}

/* ── مفتاح المنصة العام ────────────────────────────────────────────────── */

async function loadSwitch() {
    const box = $('hrSwitch');
    box.innerHTML = loadingBlock('جارٍ تحميل حالة مفتاح المنصة…');
    try {
        const rows = await rpc('owner_feature_switches', {});
        const row = (Array.isArray(rows) ? rows : []).find(r => r.key === 'hr_module_enabled');
        switchEnabled = row ? row.enabled === true : false;
        box.innerHTML = `
            <div class="owner-switch-row">
                <div>
                    <strong>${switchEnabled ? 'مفعَّل' : 'معطَّل'}</strong>
                    <p class="panel-subtitle">${switchEnabled
                        ? 'الوحدة متاحة منصةً كاملةً للشركات المستحقة (اشتراك أو تجاوز).'
                        : 'الوحدة معطَّلة منصةً كاملةً — لا تعمل لأي شركة حتى المستحقة.'}</p>
                </div>
                <button type="button" class="btn ${switchEnabled ? 'btn-danger' : 'btn-primary'} btn-sm"
                    id="hrSwitchToggle">${switchEnabled ? 'إيقاف الوحدة منصةً كاملةً' : 'تفعيل الوحدة منصةً كاملةً'}</button>
            </div>`;
        $('hrSwitchToggle').addEventListener('click', () => askSwitchToggle());
    } catch (err) {
        box.innerHTML = errorBlock(friendlyError(err), 'تعذّر تحميل مفتاح المنصة');
    }
}

function askSwitchToggle() {
    const enabling = !switchEnabled;
    const modal = openModal({
        title: enabling ? 'تفعيل وحدة الموارد البشرية منصةً كاملةً' : 'إيقاف وحدة الموارد البشرية منصةً كاملةً',
        html: `<form class="owner-action-form" id="hrSwitchForm" novalidate>
            <p class="panel-subtitle">${enabling
                ? 'بعد التفعيل تعمل الوحدة للشركات المستحقة فقط (اشتراك يشملها أو تجاوز مالك). الشركات بلا استحقاق تبقى بلا وحدة.'
                : 'الإيقاف يوقف الوحدة فورًا لكل الشركات — بلا استثناء. يتطلب تحققًا حديثًا (خطوتان خلال 10 دقائق).'}</p>
            <div class="form-field">
                <label for="hrSwitchReason">السبب (10 أحرف على الأقل، يُسجَّل في تدقيق المالك)</label>
                <input type="text" class="form-control" id="hrSwitchReason" maxlength="300" autocomplete="off" required
                    value="${enabling ? 'تفعيل وحدة الموارد البشرية بعد اكتمال البناء والمراجعة' : 'إيقاف وحدة الموارد البشرية منصةً كاملةً'}">
            </div>
            <div class="form-actions">
                <button type="submit" class="btn ${enabling ? 'btn-primary' : 'btn-danger'} btn-sm" data-critical>${enabling ? 'تفعيل الوحدة' : 'إيقاف الوحدة'}</button>
            </div>
            <p class="owner-sie-status" id="hrSwitchStatus" role="status" aria-live="polite" hidden></p>
        </form>`
    });
    const form = modal.body.querySelector('#hrSwitchForm');
    const status = (t, tone) => announce(form.querySelector('#hrSwitchStatus'), t, tone);
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const reason = form.querySelector('#hrSwitchReason').value;
        const err = storeReasonError(reason);
        if (err) { status(err, 'error'); return; }
        const btn = form.querySelector('button[type=submit]');
        btn.disabled = true;
        try {
            await rpc('owner_set_feature_switch', { p_key: 'hr_module_enabled', p_enabled: enabling, p_reason: reason.trim() });
            modal.close();
            say(enabling ? 'فُعِّلت وحدة الموارد البشرية منصةً كاملةً.' : 'أُوقفت وحدة الموارد البشرية منصةً كاملةً.', 'success');
            await loadSwitch();
            await loadCompanies();
            await loadLog();
        } catch (rpcErr) {
            status(friendlyError(rpcErr), 'error');
            btn.disabled = false;
        }
    });
}

/* ── الشركات واستحقاقها ────────────────────────────────────────────────── */

async function loadCompanies() {
    const box = $('hrCompaniesTable');
    box.innerHTML = loadingBlock('جارٍ تحميل الشركات…');
    try {
        const data = await rpc('owner_hr_list_companies', { p_search: companiesSearch || null, p_page: companiesPage });
        const rows = Array.isArray(data?.rows) ? data.rows : [];
        companiesRows = rows;
        companiesTotal = Number(data?.total || 0);
        const enabledCount = rows.filter(r => r.hr_enabled === true).length;
        $('hrKpis').innerHTML = kpis([
            { label: 'شركات بهذه الصفحة', value: num(rows.length) },
            { label: 'مفعَّلة في الصفحة', value: num(enabledCount) },
            { label: 'إجمالي الشركات', value: num(companiesTotal) },
            { label: 'مفتاح المنصة', value: switchEnabled === null ? '—' : (switchEnabled ? 'مفعَّل' : 'معطَّل') }
        ]);
        if (!rows.length) {
            box.innerHTML = stateBlock({ title: 'لا توجد شركات مطابقة', text: companiesSearch ? 'جرّب بحثًا آخر.' : 'لا توجد شركات بعد.' });
            renderPager($('hrCompaniesPager'), { page: companiesPage, size: PAGE_SIZE, total: 0, onPage: (p) => { companiesPage = p; loadCompanies(); } });
            return;
        }
        box.innerHTML = table(
            ['الشركة', 'المالك', 'الحالة', 'الأقسام المفعَّلة', 'الموظفون', 'إجراءات'],
            rows,
            (r) => {
                const info = hrCompanyStatusInfo(r);
                const summary = hrEntitlementSummary(r.sections || {});
                const sections = SECTION_KEYS.map(k => {
                    const on = r.sections?.[k] === true;
                    const label = HR_SECTION_LABELS[k]?.label || k;
                    return `<span class="hr-section-chip ${on ? 'on' : 'off'}" title="${esc(label)}">${esc(label)}: ${on ? '✓' : '—'}</span>`;
                }).join(' ');
                const overrides = Array.isArray(r.overrides) ? r.overrides : [];
                const suspended = overrides.filter(o => o.status === 'suspended').map(o => HR_SECTION_LABELS[o.feature_key]?.label || o.feature_key).join('، ');
                return `<tr>
                    <td><strong>${esc(r.company_name || '—')}</strong><br><small class="muted">${esc(r.company_id || '')}</small></td>
                    <td dir="ltr">${esc(r.owner_email || '—')}</td>
                    <td><span class="status-pill ${esc(info.pill)}">${esc(info.label)}</span>${suspended ? `<br><small class="muted">موقوف: ${esc(suspended)}</small>` : ''}</td>
                    <td>${sections}<br><small class="muted">${summary.enabled} من ${summary.total} أقسام</small></td>
                    <td>${num(r.employee_count || 0)}</td>
                    <td>
                        <button type="button" class="btn btn-outline btn-sm" data-hr-module="${esc(r.company_id)}"
                            data-hr-enabled="${r.hr_enabled === true ? '1' : '0'}" data-hr-name="${esc(r.company_name || '')}">
                            ${r.hr_enabled === true ? 'إيقاف الوحدة' : 'تفعيل الوحدة'}</button>
                        <button type="button" class="btn btn-outline btn-sm" data-hr-sections="${esc(r.company_id)}"
                            data-hr-name="${esc(r.company_name || '')}">الأقسام…</button>
                    </td>
                </tr>`;
            },
            { empty: 'لا توجد شركات مطابقة.' }
        );
        renderPager($('hrCompaniesPager'), {
            page: companiesPage, size: PAGE_SIZE, total: companiesTotal,
            onPage: (p) => { companiesPage = p; loadCompanies(); }
        });
        box.querySelectorAll('[data-hr-module]').forEach(b => b.addEventListener('click', () => {
            askSetModule(b.getAttribute('data-hr-module'), b.getAttribute('data-hr-enabled') === '1',
                b.getAttribute('data-hr-name'));
        }));
        box.querySelectorAll('[data-hr-sections]').forEach(b => b.addEventListener('click', () => {
            askSetSections(b.getAttribute('data-hr-sections'), b.getAttribute('data-hr-name'));
        }));
    } catch (err) {
        box.innerHTML = errorBlock(friendlyError(err), 'تعذّر تحميل الشركات');
    }
}

function askSetModule(companyId, currentlyEnabled, companyName) {
    const enabling = !currentlyEnabled;
    const modal = openModal({
        title: `${enabling ? 'تفعيل' : 'إيقاف'} وحدة الموارد البشرية — ${companyName}`,
        html: `<form class="owner-action-form" id="hrModuleForm" novalidate>
            <p class="panel-subtitle">${enabling
                ? 'يُمنح تجاوز استثناء للشركة على مفتاح «hr» (الوحدة كاملةً). بلا اشتراك يشملها يبقى التجاوز هو مصدر الاستحقاق.'
                : 'يُسحب تجاوز «hr» — فإن كانت الباقة لا تشمل الوحدة تفقدها الشركة فورًا.'}</p>
            <div class="form-field">
                <label for="hrModuleReason">السبب (10 أحرف على الأقل، يُسجَّل في تدقيق المالك)</label>
                <input type="text" class="form-control" id="hrModuleReason" maxlength="300" autocomplete="off" required
                    value="${enabling ? 'تفعيل وحدة الموارد البشرية للشركة بعد مراجعة الطلب' : 'إيقاف وحدة الموارد البشرية للشركة بعد مراجعة الطلب'}">
            </div>
            <div class="form-actions">
                <button type="submit" class="btn ${enabling ? 'btn-primary' : 'btn-danger'} btn-sm" data-critical>${enabling ? 'تفعيل الوحدة' : 'إيقاف الوحدة'}</button>
            </div>
            <p class="owner-sie-status" id="hrModuleStatus" role="status" aria-live="polite" hidden></p>
        </form>`
    });
    const form = modal.body.querySelector('#hrModuleForm');
    const status = (t, tone) => announce(form.querySelector('#hrModuleStatus'), t, tone);
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const reason = form.querySelector('#hrModuleReason').value;
        const err = storeReasonError(reason);
        if (err) { status(err, 'error'); return; }
        const btn = form.querySelector('button[type=submit]');
        btn.disabled = true;
        try {
            await rpc('owner_hr_set_module', { p_company_id: companyId, p_enabled: enabling, p_reason: reason.trim() });
            modal.close();
            say(enabling ? `فُعِّلت وحدة الموارد البشرية لشركة «${companyName}».` : `أُوقفت وحدة الموارد البشرية لشركة «${companyName}».`, 'success');
            await loadCompanies();
            await loadLog();
        } catch (rpcErr) {
            status(friendlyError(rpcErr), 'error');
            btn.disabled = false;
        }
    });
}

function askSetSections(companyId, companyName) {
    const row = companiesRows.find(r => r.company_id === companyId);
    const sections = row?.sections || {};
    const checks = SECTION_KEYS.map(k => {
        const label = HR_SECTION_LABELS[k]?.label || k;
        const hint = HR_SECTION_LABELS[k]?.hint || '';
        return `<label class="hr-section-check"><input type="checkbox" data-hr-section-key="${k}" ${sections[k] === true ? 'checked' : ''}>
            <span><strong>${esc(label)}</strong><br><small class="muted">${esc(hint)}</small></span></label>`;
    }).join('');
    const modal = openModal({
        title: `أقسام الموارد البشرية — ${companyName}`,
        html: `<form class="owner-action-form" id="hrSectionsForm" novalidate>
            <p class="panel-subtitle">كل قسم يُفعَّل أو يُوقف مستقلًا (تجاوز استثناء على مفتاح القسم).
            إيقاف قسم يسحب تجاوزه — لا يوجد إيقاف مؤقت يُستأنف في هذه الخطوة.</p>
            ${checks}
            <div class="form-field">
                <label for="hrSectionsReason">السبب (10 أحرف على الأقل، يُسجَّل في تدقيق المالك)</label>
                <input type="text" class="form-control" id="hrSectionsReason" maxlength="300" autocomplete="off" required
                    value="تعديل أقسام الموارد البشرية للشركة بعد مراجعة الطلب">
            </div>
            <div class="form-actions">
                <button type="submit" class="btn btn-primary btn-sm" data-critical>حفظ الأقسام</button>
            </div>
            <p class="owner-sie-status" id="hrSectionsStatus" role="status" aria-live="polite" hidden></p>
        </form>`
    });
    const form = modal.body.querySelector('#hrSectionsForm');
    const status = (t, tone) => announce(form.querySelector('#hrSectionsStatus'), t, tone);
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const reason = form.querySelector('#hrSectionsReason').value;
        const err = storeReasonError(reason);
        if (err) { status(err, 'error'); return; }
        const btn = form.querySelector('button[type=submit]');
        btn.disabled = true;
        try {
            for (const k of SECTION_KEYS) {
                const checked = form.querySelector(`[data-hr-section-key="${k}"]`).checked;
                if ((sections[k] === true) !== checked) {
                    await rpc('owner_hr_set_section', { p_company_id: companyId, p_feature_key: k, p_enabled: checked, p_reason: reason.trim() });
                }
            }
            modal.close();
            say(`حُفظت أقسام الموارد البشرية لشركة «${companyName}».`, 'success');
            await loadCompanies();
            await loadLog();
        } catch (rpcErr) {
            status(friendlyError(rpcErr), 'error');
            btn.disabled = false;
        }
    });
}

/* ── سجل العمليات ─────────────────────────────────────────────────────── */

async function loadLog() {
    const box = $('hrLog');
    box.innerHTML = loadingBlock('جارٍ تحميل سجل العمليات…');
    try {
        const rows = await rpc('owner_hr_operations_log', { p_limit: 50 });
        const list = Array.isArray(rows) ? rows : [];
        if (!list.length) {
            box.innerHTML = stateBlock({ title: 'لا توجد عمليات بعد', text: 'يظهر هنا كل قرار مالك على الوحدة أو أقسامها.' });
            return;
        }
        box.innerHTML = table(
            ['الوقت', 'الشركة', 'الإجراء', 'المصدر'],
            list,
            (r) => `<tr>
                <td>${esc(when(r.created_at))}</td>
                <td>${esc(r.company_name || '—')}</td>
                <td>${esc(r.summary || r.action || '—')}</td>
                <td>${esc(r.source === 'privileged' ? 'تدقيق المالك' : r.source === 'subscription' ? 'تدقيق الاشتراكات' : 'تدقيق الوحدة')}</td>
            </tr>`,
            { empty: 'لا توجد عمليات بعد.' }
        );
    } catch (err) {
        box.innerHTML = errorBlock(friendlyError(err), 'تعذّر تحميل سجل العمليات');
    }
}

/* ── الإقلاع ─────────────────────────────────────────────────────────── */

async function refreshAll() {
    await loadSwitch();
    await loadCompanies();
    await loadLog();
}

document.addEventListener('DOMContentLoaded', async () => {
    const booted = await bootOwnerPage();
    if (!booted) return;
    $('hrRefresh').addEventListener('click', refreshAll);
    $('hrCompaniesSearch').addEventListener('input', (e) => {
        companiesSearch = searchTerm(e.target.value);
        companiesPage = 1;
        loadCompanies();
    });
    await refreshAll();
});
