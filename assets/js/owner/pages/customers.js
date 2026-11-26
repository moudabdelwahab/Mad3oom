/**
 * owner/customers.html — «دليل العملاء» لمالك المنصة (migrations/105 + 129).
 *
 * نسخة المالك من assets/js/admin/customers.js — بقشرة المالك ونافذة المالك (openModal)
 * بدل درج الإدارة، وبلا نموذج إرسال طلب حساب (account_request_submit مسار مقدّم
 * الطلب، لا المالك — طلباته تُراجَع في /owner/account-requests.html):
 *
 *   admin_customer_filter_options()   الشركات والمديرون + هل يُسند المالك مديرًا
 *   admin_customer_directory(p_filters) البحث والفلاتر والترتيب والصفحات على الخادم
 *   owner_account_details(p_user_id)  التفاصيل الغنية أولًا (129: اشتراكات/محفظة/استهلاك/تذاكر/نقل/تدقيق)
 *   admin_customer_details(p_customer) إكمال التفاصيل: المدير وطلبات الحساب والسجل (105)
 *   customer_manager_assign(...)      إسناد مدير الحساب بسبب مسجَّل (105)
 * التفاصيل من النداء الغني أولًا، فإن رفضته القاعدة يُجرَّب نداء الدليل الموجود —
 * نفس نمط الاحتياط في assets/js/owner/pages/accounts.js — فلا صفحة فارغة ولا رقم مخترع.
 * إخفاء زر هنا ليس ضابط صلاحية: كل دالة ترفض في القاعدة من لا يحق له.
 */
import {
    supabase, bootOwnerPage, announce, esc, when, day, num, table, kpis, errorBlock, loadingBlock, openModal,
    friendlyError, renderPager, writeResult
} from '/assets/js/owner/owner-page.js';
import {
    VIEWS, ACCOUNT_TYPES, STATUS_LABELS, SORTS, PAGE_SIZES, REQUEST_TYPES, REQUEST_STATUS, MEMBERSHIP_VIA, END_CAUSES,
    errorMessage, directoryFilters, pageSummary, shortId, reasonError, formatDate
} from '/assets/js/admin/customers-model.js';
import {
    buildFullAccountDetails, subscriptionInfo,
    auditActionLabel, auditSourceLabel, usageEventLabel, usageCounterLabel, usageSourceLabel,
    transferStatusLabel, transferInitiatedLabel, accountRequestTypeLabel, accountRequestStatusLabel,
    joinedViaLabel, membershipStatusLabel, managerEndCauseLabel
} from '/assets/js/owner/accounts-tree-model.js';
import { TICKET_STATUS_LABELS } from '/assets/js/owner/owner-labels.js';

const $ = (id) => document.getElementById(id);
const say = (text, tone = 'info') => announce($('pageStatus'), text, tone);
const dash = (v) => (v === null || v === undefined || v === '' ? '<span class="cm-muted">—</span>' : esc(v));

const state = { view: 'all', q: '', account_type: '', company_id: '', manager_id: '', status: '', sort: 'created_at:desc', limit: 25, offset: 0 };
let options = { companies: [], managers: [], can_assign_manager: false };
let lastPage = { total: 0, rows: [] };
let seq = 0;
let deepId = null;

const TYPE_TONE = { direct: 'cm-tone-info', company_customer: 'cm-tone-ok', direct_and_company: 'cm-tone-ok', company_owner: 'cm-tone-warn', company_staff: 'cm-tone-warn' };

async function rpc(name, args) {
    try {
        const { data, error } = await supabase.rpc(name, args);
        return { data, error };
    } catch (err) {
        return { data: null, error: err };
    }
}

function buildControls() {
    $('cmViews').innerHTML = VIEWS.map(v =>
        `<button type="button" class="view-tab" role="tab" data-view="${esc(v.key)}" aria-selected="${v.key === state.view}">${esc(v.label)}</button>`).join('');
    $('cmType').innerHTML = '<option value="">كل الأنواع</option>' +
        Object.entries(ACCOUNT_TYPES).map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join('');
    $('cmSort').innerHTML = SORTS.map(s => `<option value="${esc(s.key)}">${esc(s.label)}</option>`).join('');
    $('cmPageSize').innerHTML = PAGE_SIZES.map(n => `<option value="${n}">${n}</option>`).join('');

    $('cmViews').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-view]');
        if (!btn) return;
        state.view = btn.dataset.view;
        $('cmViews').querySelectorAll('[data-view]').forEach(b => b.setAttribute('aria-selected', String(b === btn)));
        // «حسب مدير الحساب» يحتاج مديرًا: الافتراضي «بلا مدير» إلى أن يُختار
        if (state.view === 'by_manager' && !state.manager_id) {
            state.manager_id = 'none';
            $('cmManager').value = 'none';
        }
        resetAndLoad();
    });
    let t = null;
    $('cmSearch').addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { state.q = $('cmSearch').value; resetAndLoad(); }, 350); });
    [['cmType', 'account_type'], ['cmCompany', 'company_id'], ['cmManager', 'manager_id'], ['cmStatus', 'status'], ['cmSort', 'sort']]
        .forEach(([id, key]) => $(id).addEventListener('change', () => { state[key] = $(id).value; resetAndLoad(); }));
    $('cmPageSize').addEventListener('change', () => { state.limit = Number($('cmPageSize').value) || 25; resetAndLoad(); });
    $('cmFilters').addEventListener('submit', (e) => { e.preventDefault(); resetAndLoad(); });
}

function fillSelect(select, items, allLabel, label, extra = []) {
    select.innerHTML = `<option value="">${esc(allLabel)}</option>` + [...extra, ...(items || [])].map(i => `<option value="${esc(i.id)}">${esc(label(i))}</option>`).join('');
}

function resetAndLoad() {
    state.offset = 0;
    load();
}

async function load() {
    const mine = ++seq;
    $('cmTable').innerHTML = loadingBlock();
    const { data, error } = await rpc('admin_customer_directory', { p_filters: directoryFilters(state) });
    if (mine !== seq) return;
    if (error) {
        $('cmTable').innerHTML = errorBlock(errorMessage(error));
        $('cmKpis').innerHTML = '';
        return;
    }
    lastPage = { total: Number(data?.total) || 0, rows: Array.isArray(data?.rows) ? data.rows : [] };
    $('cmKpis').innerHTML = kpis([
        ['عملاء مطابقون', num(lastPage.total), ''],
        ['موقوفون في الصفحة', num(lastPage.rows.filter(r => r.status === 'suspended').length), lastPage.rows.some(r => r.status === 'suspended') ? 'kpi--warning' : ''],
        ['بلا مدير حساب في الصفحة', num(lastPage.rows.filter(r => !r.manager).length), '']
    ]);
    renderRows();
    renderPager($('cmPager'), { page: Math.floor(state.offset / state.limit), size: state.limit, total: lastPage.total,
        onPage: (n) => { state.offset = n * state.limit; load(); },
        text: `${pageSummary(lastPage.total, state.offset, lastPage.rows.length)} عميل` });
    if (deepId) {
        const id = deepId;
        deepId = null;
        if (lastPage.rows.some(r => r.id === id)) openDetails(id);
    }
}

function renderRows() {
    const { total, rows } = lastPage;
    if (!rows.length) {
        $('cmTable').innerHTML = state.offset > 0
            ? errorBlock('لا نتائج في هذه الصفحة.')
            : `<div class="state-block state-block--compact"><p class="state-text">لا يوجد عملاء مطابقون للفلاتر.</p></div>`;
        return;
    }
    $('cmTable').innerHTML = table(
        ['المعرّف', 'الاسم', 'البريد', 'الجوال', 'مدير الحساب', 'نوع الحساب', 'الشركة', 'الحالة', 'أُنشئ', ''],
        rows,
        (r) => `<tr>
            <td><span class="cm-mono" title="${esc(r.id)}">${esc(shortId(r.id))}</span></td>
            <td>${dash(r.full_name)}</td>
            <td><span class="cm-ltr">${dash(r.email)}</span></td>
            <td><span class="cm-ltr">${dash(r.phone)}</span></td>
            <td>${r.manager ? esc(r.manager.name) : '<span class="cm-muted">بلا مدير</span>'}</td>
            <td><span class="cm-badge ${TYPE_TONE[r.account_type] || ''}">${esc(ACCOUNT_TYPES[r.account_type] || r.account_type)}</span></td>
            <td>${r.company ? esc(r.company.name) : '<span class="cm-muted">—</span>'}${r.companies_count > 1 ? ` <span class="cm-muted cm-ltr">(+${r.companies_count - 1})</span>` : ''}</td>
            <td><span class="cm-badge ${r.status === 'suspended' ? 'cm-tone-bad' : 'cm-tone-ok'}">${esc(STATUS_LABELS[r.status] || r.status)}</span>${
                r.pending_transfer || r.pending_request ? ' <span class="cm-badge cm-tone-warn">طلب معلّق</span>' : ''}</td>
            <td>${esc(formatDate(r.created_at))}</td>
            <td><button type="button" class="btn btn-secondary btn-sm" data-open="${esc(r.id)}">التفاصيل</button></td>
        </tr>`,
        { empty: 'لا يوجد عملاء مطابقون للفلاتر.' });
    $('cmTable').querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openDetails(b.dataset.open)));
}

/* ── نافذة التفاصيل ─────────────────────────────────────────────────────── */

function detailSection(title, inner) {
    return `<section class="owner-detail-section"><h3>${esc(title)}</h3>${inner}</section>`;
}

function kv(pairs) {
    return `<dl class="owner-detail-grid">${pairs.filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('')}</dl>`;
}

const cmKv = (pairs) => `<dl class="cm-kv">${pairs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
const list = (items, empty) => items.length ? `<ul class="cm-list">${items.join('')}</ul>` : `<p class="cm-muted">${esc(empty)}</p>`;

async function openDetails(id) {
    const row = lastPage.rows.find(r => r.id === id);
    const modal = openModal({ title: row?.full_name || row?.email || 'تفاصيل العميل', wide: true, html: loadingBlock() });
    const [rich, legacy] = await Promise.all([
        rpc('owner_account_details', { p_user_id: id }),
        rpc('admin_customer_details', { p_customer: id })
    ]);
    if ((rich.error || !rich.data) && (legacy.error || !legacy.data)) {
        modal.body.innerHTML = errorBlock(legacy.error ? errorMessage(legacy.error) : friendlyError(rich.error));
        return;
    }
    renderDetails(modal, id, row, rich.error ? null : rich.data, legacy.error ? null : legacy.data);
}

function renderDetails(modal, id, row, richRaw, d) {
    const p = d?.profile || {};
    modal.body.innerHTML = `
        ${d ? `<section class="cm-section"><h3>الحساب</h3>${cmKv([
            ['المعرّف', `<span class="cm-mono">${esc(p.id)}</span>`],
            ['نوع الحساب', esc(ACCOUNT_TYPES[d.account_type] || d.account_type)],
            ['الحالة', esc(STATUS_LABELS[p.status] || p.status)],
            ['الجوال', `<span class="cm-ltr">${dash(p.phone)}</span>`],
            ['واتساب', `<span class="cm-ltr">${dash(p.whatsapp_phone)}</span>`],
            ['تاريخ الإنشاء', esc(formatDate(p.created_at, true))],
            ['عميل مباشر للمنصة', d.direct ? `منذ ${esc(formatDate(d.direct.since))} (${d.direct.source === 'signup' ? 'تسجيل' : 'ملء أولي'})` : 'لا']
        ])}</section>
        ${d.owned_company ? `<section class="cm-section"><h3>الشركة المملوكة</h3>${cmKv([
            ['الشركة', esc(d.owned_company.name)], ['الحالة', esc(d.owned_company.status === 'suspended' ? 'موقوفة' : 'نشطة')]])}</section>` : ''}
        ${d.staff ? `<section class="cm-section"><h3>موظف شركة</h3>${cmKv([['الشركة', esc(d.staff.company_name)], ['الدور', esc(d.staff.role)]])}</section>` : ''}
        <section class="cm-section"><h3>الشركات (عميل)</h3>${list((d.memberships || []).map(m => `<li>${esc(m.company_name)} ${m.is_primary ? '<span class="cm-badge cm-tone-info">أساسية</span>' : ''}
            <span class="cm-badge ${m.status === 'active' ? 'cm-tone-ok' : ''}">${m.status === 'active' ? 'نشطة' : 'منتهية'}</span>
            <div class="cm-muted">منذ ${esc(formatDate(m.joined_at))} · ${esc(MEMBERSHIP_VIA[m.joined_via] || m.joined_via)}${
                m.ended_at ? ` · انتهت ${esc(formatDate(m.ended_at))} (${esc(END_CAUSES[m.end_cause] || m.end_cause)})` : ''}</div></li>`), 'لا عضويات في شركات.')}</section>` : ''}
        ${richRaw ? renderRichSections(richRaw) : ''}
        ${d ? `
        <section class="cm-section"><h3>مدير الحساب</h3>
            <p>${d.manager ? esc(d.manager.name) : '<span class="cm-muted">بلا مدير حساب</span>'}</p>
            <p class="cm-note cm-muted">مدير الحساب مسؤولية متابعة، لا صلاحية: لا يمنحه الإسناد أي اطلاع على بيانات العميل أو محادثاته.</p>
            ${d.can_assign_manager ? managerForm(d) : ''}
            ${list((d.manager_history || []).map(h => `<li>${esc(h.manager_name)}
                <div class="cm-muted">أسنده ${esc(h.assigned_by_name)} في ${esc(formatDate(h.assigned_at, true))} — ${esc(h.reason)}${
                    h.ended_at ? ` · انتهى ${esc(formatDate(h.ended_at))} (${esc(END_CAUSES[h.end_cause] || h.end_cause)})` : ''}</div></li>`), 'لا سجل إسناد بعد.')}
        </section>
        <section class="cm-section"><h3>الاشتراكات</h3>${list((d.subscriptions || []).map(s => `<li>${esc(s.plan)} <span class="cm-badge">${esc(s.status)}</span>
            <div class="cm-muted">${esc(formatDate(s.start_date))} ← ${esc(formatDate(s.end_date))}${s.company_name ? ` · ${esc(s.company_name)}` : ''}</div></li>`), 'لا اشتراكات.')}</section>
        <section class="cm-section"><h3>طلبات الحسابات</h3>${list((d.requests || []).map(r => `<li>${esc(REQUEST_TYPES[r.request_type] || r.request_type)} — ${esc(r.company_name)}
            <span class="cm-badge">${esc(REQUEST_STATUS[r.status] || r.status)}</span><div class="cm-muted">${esc(formatDate(r.requested_at, true))}</div></li>`), 'لا طلبات.')}
            <p class="panel-subtitle">القرار على الطلبات في <a href="/owner/account-requests.html">صفحة طلبات الحسابات</a> — لا تُرسَل طلبات جديدة من الدليل.</p></section>
        <section class="cm-section"><h3>السجل</h3><p class="cm-muted">${esc(d.history_note)}</p>${list((d.history || []).map(h => `<li><span class="cm-mono">${esc(h.action)}</span>${h.company_name ? ` — ${esc(h.company_name)}` : ''}
            <div class="cm-muted">${esc(h.actor_name || 'النظام')} · ${esc(formatDate(h.at, true))}</div></li>`), 'لا أحداث مسجّلة.')}</section>` : ''}`;
    wireManagerForm(modal, id, d);
}

/** الأقسام الغنية من owner_account_details() (129) — نفس بناء شجرة الحسابات. */
function renderRichSections(raw) {
    const full = buildFullAccountDetails(raw);
    let html = '';
    html += detailSection('كل الاشتراكات', full.subscriptions.length
        ? `<ul class="owner-thread">${full.subscriptions.map(su => `<li>
            <div class="owner-thread-head"><span>${esc(su.plan_name_ar || su.plan || '')}</span><span>${esc(subscriptionInfo(su).label)}${su.end_date ? ` · ينتهي ${esc(day(su.end_date))}` : ''}</span></div>
            <p class="state-text">${su.company_name ? `الشركة: ${esc(su.company_name)} · ` : ''}الدورة: ${esc(su.billing_cycle || '—')} · بدأ ${esc(day(su.start_date))}${su.days_remaining !== null && su.days_remaining !== undefined ? ` · متبقٍ ${num(su.days_remaining)} يوم` : ''}</p>
        </li>`).join('')}</ul>`
        : '<p class="panel-subtitle">بلا اشتراكات.</p>');
    const w = full.wallet;
    html += detailSection('المحفظة والاستهلاك', kv([
        ['إجمالي النقاط', w ? num(w.total_points) : '—'],
        ['النقاط المتاحة', w ? num(w.available_points) : '—'],
        ['التجميد', w ? (w.is_frozen ? 'مجمّد' : 'غير مجمّد') : '—']
    ]) + (full.usage.length
        ? `<ul class="owner-thread">${full.usage.map(u => `<li>
            <div class="owner-thread-head"><span>${esc(usageEventLabel(u.event))} · ${esc(usageCounterLabel(u.counter))} · ${num(u.units)}</span><span>${esc(when(u.recorded_at))}</span></div>
            <p class="state-text">الفترة: ${esc(day(u.period))}${u.source ? ` · المصدر: ${esc(usageSourceLabel(u.source))}` : ''}</p>
        </li>`).join('')}</ul>`
        : '<p class="panel-subtitle">لا قيود استهلاك مسجّلة.</p>'));
    const counts = Object.entries(full.tickets.counts)
        .map(([st, n]) => `${esc(TICKET_STATUS_LABELS[st] || st)}: ${num(n)}`).join(' · ');
    html += detailSection('التذاكر', (counts ? `<p class="state-text">${counts}</p>` : '<p class="panel-subtitle">بلا تذاكر.</p>')
        + (full.tickets.latest.length
            ? `<ul class="owner-thread">${full.tickets.latest.map(t => `<li>
                <div class="owner-thread-head"><span>${t.ticket_number ? `#${esc(t.ticket_number)} · ` : ''}${esc(t.title || 'تذكرة بلا عنوان')}</span><span>${esc(TICKET_STATUS_LABELS[t.status] || t.status || '')}</span></div>
                <p class="state-text">${t.company_name ? `${esc(t.company_name)} · ` : ''}${esc(when(t.created_at))}</p>
            </li>`).join('')}</ul>` : ''));
    if (full.transfers.pending || full.transfers.latest.length) {
        html += detailSection('النقل بين الشركات', (full.transfers.pending
            ? `<p class="state-text">طلبات معلّقة: ${num(full.transfers.pending)}</p>` : '')
            + `<ul class="owner-thread">${full.transfers.latest.map(tr => `<li>
                <div class="owner-thread-head"><span>${esc(tr.from_company || '')} ← ${esc(tr.to_company || '')}</span><span>${esc(transferStatusLabel(tr.status))}</span></div>
                <p class="state-text">بادر به: ${esc(transferInitiatedLabel(tr.initiated_as) || '—')} · ${esc(when(tr.created_at))}${tr.completed_at ? ` · اكتمل ${esc(when(tr.completed_at))}` : ''}</p>
            </li>`).join('')}</ul>`);
    }
    html += detailSection('سجل التدقيق الكامل', full.audit.length
        ? `<ul class="owner-thread">${full.audit.slice(0, 20).map(a => `<li>
            <div class="owner-thread-head"><span title="${esc(a.action || '')}">${esc(auditActionLabel(a.action))}</span><span>${esc(when(a.at))}</span></div>
            <p class="state-text">الفاعل: ${esc(a.actor_name || '—')}${a.source ? ` · المصدر: ${esc(auditSourceLabel(a.source))}` : ''}${a.company_name ? ` · ${esc(a.company_name)}` : ''}</p>
        </li>`).join('')}</ul><p class="panel-subtitle">${esc(full.historyNote || '')}</p>`
        : '<p class="panel-subtitle">لا أحداث مسجّلة على هذا الحساب.</p>');
    return html;
}

function managerForm(d) {
    const opts = (options.managers || []).map(m =>
        `<option value="${esc(m.id)}" ${d.manager?.id === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('');
    return `<form class="cm-form" id="cmManagerForm" novalidate>
        <label>مدير الحساب<select id="cmManagerSelect"><option value="">— بلا مدير —</option>${opts}</select></label>
        <label>السبب (يُسجَّل)<input id="cmManagerReason" maxlength="500" autocomplete="off" placeholder="مثال: متابعة تجديد الاشتراك"></label>
        <div class="cm-actions"><button type="submit" class="btn btn-primary btn-sm">حفظ الإسناد</button></div>
        <p class="cm-status" id="cmManagerStatus" role="status" aria-live="polite"></p>
    </form>`;
}

function wireManagerForm(modal, customerId, d) {
    const form = modal.body.querySelector('#cmManagerForm');
    if (!form || !d) return;
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const status = modal.body.querySelector('#cmManagerStatus');
        const sayIn = (text, kind) => { status.textContent = text; status.dataset.kind = kind; };
        const reason = modal.body.querySelector('#cmManagerReason').value.trim();
        const problem = reasonError(reason);
        if (problem) { sayIn(problem, 'error'); return; }
        const btn = form.querySelector('button[type=submit]');
        btn.disabled = true;
        const res = await rpc('customer_manager_assign', {
            p_customer: customerId, p_manager: modal.body.querySelector('#cmManagerSelect').value || null, p_reason: reason
        });
        btn.disabled = false;
        if (res.error) { sayIn(errorMessage(res.error), 'error'); return; }
        // الرفض بـRLS يعود بلا صفوف وبلا خطأ — writeResult يثبت النجاح من صف العودة، لا «تم» على ما لم يحدث
        const checked = writeResult(res, { denied: 'لم يُحفظ الإسناد — القاعدة لم تسمح بالتعديل.' });
        if (!checked.ok) { sayIn(checked.message, 'error'); return; }
        if (res.data.changed === false) { sayIn('الإسناد كما هو — لم يتغير شيء.', 'info'); return; }
        sayIn('تم حفظ الإسناد.', 'success');
        say('تم حفظ إسناد مدير الحساب.', 'success');
        modal.close();
        openDetails(customerId);
        load();
    });
}

(async function init() {
    if (!await bootOwnerPage()) return;
    buildControls();
    const { data, error } = await rpc('admin_customer_filter_options');
    if (error) {
        $('cmTable').innerHTML = errorBlock(errorMessage(error));
        return;
    }
    options = { ...options, ...(data || {}) };
    fillSelect($('cmCompany'), options.companies, 'كل الشركات', c => c.name);
    fillSelect($('cmManager'), options.managers, 'كل مديري الحساب', m => m.name, [{ id: 'none', name: 'بلا مدير حساب' }]);
    deepId = new URLSearchParams(location.search).get('id');
    $('cmRefresh').addEventListener('click', () => load());
    await load();
})();
