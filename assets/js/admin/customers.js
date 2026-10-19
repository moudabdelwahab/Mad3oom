/**
 * customers.js — «إدارة العملاء» (migrations/105).
 *
 * الصفحة لا تقرأ أي جدول مباشرةً ولا تفلتر في المتصفح: كل صفحة نتائج تأتي من
 *   admin_customer_directory(p_filters)   البحث والفلاتر والترتيب والصفحات على الخادم
 *   admin_customer_details(p_customer)    الدرج الجانبي (أعمدة مسمّاة، بلا أسرار)
 *   customer_manager_assign(...)          إسناد مدير الحساب (المالك أو مفوَّض بالقدرة)
 *   account_request_submit(...)           طلب حساب يقرره المالك (لا يغيّر شيئًا بنفسه)
 * إخفاء زر هنا ليس ضابط صلاحية: كل دالة ترفض في القاعدة من لا يحق له.
 */
import { supabase } from '/api-config.js';
import { checkAdminAuth, updateAdminUI } from './auth.js';
import { initSidebar } from './sidebar.js';
import { debounce } from './admin-utils.js';
import {
    VIEWS, ACCOUNT_TYPES, STATUS_LABELS, SORTS, PAGE_SIZES, REQUEST_TYPES, REQUEST_STATUS, MEMBERSHIP_VIA, END_CAUSES,
    escapeText, errorMessage, directoryFilters, pageSummary, shortId, requestFormError, reasonError, newIdempotencyKey, formatDate
} from './customers-model.js';

const $ = (id) => document.getElementById(id);
const esc = escapeText;
const dash = (v) => (v === null || v === undefined || v === '' ? '<span class="cm-muted">—</span>' : esc(v));

const state = { view: 'all', q: '', account_type: '', company_id: '', manager_id: '', status: '', sort: 'created_at:desc', limit: 25, offset: 0 };
let options = { companies: [], managers: [], can_assign_manager: false, can_submit_request: false };
let lastPage = { total: 0, rows: [] };
let seq = 0;
let activeCustomer = null;
let lastFocus = null;

const TYPE_TONE = { direct: 'cm-tone-info', company_customer: 'cm-tone-ok', direct_and_company: 'cm-tone-ok', company_owner: 'cm-tone-warn', company_staff: 'cm-tone-warn' };

async function init() {
    initSidebar();
    const user = await checkAdminAuth();
    if (!user) return;
    updateAdminUI(user);
    buildControls();

    const { data, error } = await supabase.rpc('admin_customer_filter_options');
    if (error) {
        renderState('error', errorMessage(error));
        return;
    }
    options = { ...options, ...(data || {}) };
    fillSelect($('cmCompany'), options.companies, 'كل الشركات', c => c.name);
    fillSelect($('cmManager'), options.managers, 'الكل', m => m.name, [{ id: 'none', name: 'بلا مدير حساب' }]);
    await load();
}

function buildControls() {
    $('cmViews').innerHTML = VIEWS.map(v =>
        `<button type="button" class="cm-view" data-view="${esc(v.key)}" aria-pressed="${v.key === state.view}">${esc(v.label)}</button>`).join('');
    $('cmViews').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-view]');
        if (!btn) return;
        state.view = btn.dataset.view;
        $('cmViews').querySelectorAll('[data-view]').forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
        // «حسب مدير الحساب» يحتاج مديرًا: الافتراضي «بلا مدير» إلى أن يُختار
        if (state.view === 'by_manager' && !state.manager_id) {
            state.manager_id = 'none';
            $('cmManager').value = 'none';
        }
        resetAndLoad();
    });
    $('cmType').innerHTML = '<option value="">الكل</option>' +
        Object.entries(ACCOUNT_TYPES).map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join('');
    $('cmSort').innerHTML = SORTS.map(s => `<option value="${esc(s.key)}">${esc(s.label)}</option>`).join('');
    $('cmPageSize').innerHTML = PAGE_SIZES.map(n => `<option value="${n}">${n}</option>`).join('');

    $('cmSearch').addEventListener('input', debounce(() => { state.q = $('cmSearch').value; resetAndLoad(); }, 350));
    [['cmType', 'account_type'], ['cmCompany', 'company_id'], ['cmManager', 'manager_id'], ['cmStatus', 'status'], ['cmSort', 'sort']]
        .forEach(([id, key]) => $(id).addEventListener('change', () => { state[key] = $(id).value; resetAndLoad(); }));
    $('cmPageSize').addEventListener('change', () => { state.limit = Number($('cmPageSize').value) || 25; resetAndLoad(); });
    $('cmPrev').addEventListener('click', () => { state.offset = Math.max(0, state.offset - state.limit); load(); });
    $('cmNext').addEventListener('click', () => { state.offset += state.limit; load(); });

    $('cmBody').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-open]');
        if (btn) openDetails(btn.dataset.open);
        const retry = e.target.closest('[data-retry]');
        if (retry) load();
    });
    $('cmDrawerClose').addEventListener('click', closeDrawer);
    $('cmOverlay').addEventListener('click', closeDrawer);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('cmDrawer').hidden) closeDrawer(); });
}

function fillSelect(select, items, allLabel, label, extra = []) {
    const keep = select.querySelector('option[value=""]') ? `<option value="">${esc(allLabel)}</option>` : '';
    select.innerHTML = keep + [...extra, ...(items || [])].map(i => `<option value="${esc(i.id)}">${esc(label(i))}</option>`).join('');
}

function resetAndLoad() {
    state.offset = 0;
    load();
}

function renderState(kind, message) {
    const retry = kind === 'error' ? ' <button type="button" class="btn btn-secondary btn-sm" data-retry>إعادة المحاولة</button>' : '';
    $('cmBody').innerHTML = `<tr><td colspan="11" class="cm-state" data-kind="${esc(kind)}" ${kind === 'loading' ? 'aria-busy="true"' : ''}>${
        kind === 'loading' ? '<div class="cm-skeleton"></div>' : esc(message) + retry}</td></tr>`;
}

async function load() {
    const mine = ++seq;
    renderState('loading');
    $('cmPrev').disabled = true;
    $('cmNext').disabled = true;
    const { data, error } = await supabase.rpc('admin_customer_directory', { p_filters: directoryFilters(state) });
    if (mine !== seq) return; // نتيجة طلب أقدم وصلت متأخرة
    if (error) {
        $('cmPageInfo').textContent = '—';
        renderState('error', `تعذّر تحميل العملاء: ${errorMessage(error)}`);
        return;
    }
    lastPage = { total: Number(data?.total) || 0, rows: Array.isArray(data?.rows) ? data.rows : [] };
    renderRows();
}

function renderRows() {
    const { total, rows } = lastPage;
    $('cmPageInfo').textContent = pageSummary(total, state.offset, rows.length);
    $('cmPrev').disabled = state.offset === 0;
    $('cmNext').disabled = state.offset + rows.length >= total;
    if (!rows.length) {
        renderState('empty', state.offset > 0 ? 'لا نتائج في هذه الصفحة.' : 'لا يوجد عملاء مطابقون للفلاتر.');
        return;
    }
    $('cmBody').innerHTML = rows.map(r => `
        <tr>
            <td data-label="المعرّف"><span class="cm-mono" title="${esc(r.id)}">${esc(shortId(r.id))}</span></td>
            <td data-label="الاسم">${dash(r.full_name)}</td>
            <td data-label="البريد الإلكتروني"><span class="cm-ltr">${dash(r.email)}</span></td>
            <td data-label="الجوال"><span class="cm-ltr">${dash(r.phone)}</span></td>
            <td data-label="واتساب"><span class="cm-ltr">${dash(r.whatsapp_phone)}</span></td>
            <td data-label="مدير الحساب">${r.manager ? esc(r.manager.name) : '<span class="cm-muted">بلا مدير</span>'}</td>
            <td data-label="نوع الحساب"><span class="cm-badge ${TYPE_TONE[r.account_type] || ''}">${esc(ACCOUNT_TYPES[r.account_type] || r.account_type)}</span></td>
            <td data-label="الشركة">${r.company ? esc(r.company.name) : '<span class="cm-muted">—</span>'}${r.companies_count > 1 ? ` <span class="cm-muted cm-ltr">(+${r.companies_count - 1})</span>` : ''}</td>
            <td data-label="الحالة"><span class="cm-badge ${r.status === 'suspended' ? 'cm-tone-bad' : 'cm-tone-ok'}">${esc(STATUS_LABELS[r.status] || r.status)}</span>${
                r.pending_transfer || r.pending_request ? ' <span class="cm-badge cm-tone-warn">طلب معلّق</span>' : ''}</td>
            <td data-label="تاريخ الإنشاء">${esc(formatDate(r.created_at))}</td>
            <td data-label=""><button type="button" class="btn btn-secondary btn-sm" data-open="${esc(r.id)}">التفاصيل</button></td>
        </tr>`).join('');
}

/* ── الدرج ─────────────────────────────────────────────────────────────── */

function openDrawer() {
    lastFocus = document.activeElement;
    $('cmOverlay').hidden = false;
    $('cmDrawer').hidden = false;
    $('cmDrawerClose').focus();
}

function closeDrawer() {
    $('cmOverlay').hidden = true;
    $('cmDrawer').hidden = true;
    activeCustomer = null;
    lastFocus?.focus?.();
}

async function openDetails(id) {
    $('cmDrawerTitle').textContent = 'تفاصيل العميل';
    $('cmDrawerSub').textContent = '';
    $('cmDrawerBody').innerHTML = '<div class="cm-skeleton"></div>';
    openDrawer();
    const { data, error } = await supabase.rpc('admin_customer_details', { p_customer: id });
    if (error) {
        $('cmDrawerBody').innerHTML = `<p class="cm-state" data-kind="error">${esc(errorMessage(error))}</p>`;
        return;
    }
    activeCustomer = data;
    renderDetails(data);
}

const kv = (pairs) => `<dl class="cm-kv">${pairs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
const list = (items, empty) => items.length ? `<ul class="cm-list">${items.join('')}</ul>` : `<p class="cm-muted">${esc(empty)}</p>`;

function renderDetails(d) {
    const p = d.profile || {};
    $('cmDrawerTitle').textContent = p.full_name || p.email || 'تفاصيل العميل';
    $('cmDrawerSub').textContent = p.email || '';

    const memberships = (d.memberships || []).map(m => `<li>${esc(m.company_name)} ${m.is_primary ? '<span class="cm-badge cm-tone-info">أساسية</span>' : ''}
        <span class="cm-badge ${m.status === 'active' ? 'cm-tone-ok' : ''}">${m.status === 'active' ? 'نشطة' : 'منتهية'}</span>
        <div class="cm-muted">منذ ${esc(formatDate(m.joined_at))} · ${esc(MEMBERSHIP_VIA[m.joined_via] || m.joined_via)}${
            m.ended_at ? ` · انتهت ${esc(formatDate(m.ended_at))} (${esc(END_CAUSES[m.end_cause] || m.end_cause)})` : ''}</div></li>`);
    const managerHistory = (d.manager_history || []).map(h => `<li>${esc(h.manager_name)}
        <div class="cm-muted">أسنده ${esc(h.assigned_by_name)} في ${esc(formatDate(h.assigned_at, true))} — ${esc(h.reason)}${
            h.ended_at ? ` · انتهى ${esc(formatDate(h.ended_at))} (${esc(END_CAUSES[h.end_cause] || h.end_cause)})` : ''}</div></li>`);
    const subs = (d.subscriptions || []).map(s => `<li>${esc(s.plan)} <span class="cm-badge">${esc(s.status)}</span>
        <div class="cm-muted">${esc(formatDate(s.start_date))} ← ${esc(formatDate(s.end_date))}${s.company_name ? ` · ${esc(s.company_name)}` : ''}</div></li>`);
    const requests = (d.requests || []).map(r => `<li>${esc(REQUEST_TYPES[r.request_type] || r.request_type)} — ${esc(r.company_name)}
        <span class="cm-badge">${esc(REQUEST_STATUS[r.status] || r.status)}</span><div class="cm-muted">${esc(formatDate(r.requested_at, true))}</div></li>`);
    const history = (d.history || []).map(h => `<li><span class="cm-mono">${esc(h.action)}</span>${h.company_name ? ` — ${esc(h.company_name)}` : ''}
        <div class="cm-muted">${esc(h.actor_name || 'النظام')} · ${esc(formatDate(h.at, true))}</div></li>`);

    $('cmDrawerBody').innerHTML = `
        <section class="cm-section"><h3>الحساب</h3>${kv([
            ['المعرّف', `<span class="cm-mono">${esc(p.id)}</span>`],
            ['نوع الحساب', esc(ACCOUNT_TYPES[d.account_type] || d.account_type)],
            ['الحالة', esc(STATUS_LABELS[p.status] || p.status)],
            ['الجوال', `<span class="cm-ltr">${dash(p.phone)}</span>`],
            ['واتساب', `<span class="cm-ltr">${dash(p.whatsapp_phone)}</span>`],
            ['تاريخ الإنشاء', esc(formatDate(p.created_at, true))],
            ['عميل مباشر للمنصة', d.direct ? `منذ ${esc(formatDate(d.direct.since))} (${d.direct.source === 'signup' ? 'تسجيل' : 'ملء أولي'})` : 'لا']
        ])}</section>
        ${d.owned_company ? `<section class="cm-section"><h3>الشركة المملوكة</h3>${kv([
            ['الشركة', esc(d.owned_company.name)], ['الحالة', esc(d.owned_company.status === 'suspended' ? 'موقوفة' : 'نشطة')]])}</section>` : ''}
        ${d.staff ? `<section class="cm-section"><h3>موظف شركة</h3>${kv([['الشركة', esc(d.staff.company_name)], ['الدور', esc(d.staff.role)]])}</section>` : ''}
        <section class="cm-section"><h3>الشركات (عميل)</h3>${list(memberships, 'لا عضويات في شركات.')}</section>
        <section class="cm-section"><h3>مدير الحساب</h3>
            <p>${d.manager ? esc(d.manager.name) : '<span class="cm-muted">بلا مدير حساب</span>'}</p>
            <p class="cm-note cm-muted">مدير الحساب مسؤولية متابعة، لا صلاحية: لا يمنحه الإسناد أي اطلاع على بيانات العميل أو محادثاته.</p>
            ${d.can_assign_manager ? managerForm(d) : ''}
            ${list(managerHistory, 'لا سجل إسناد بعد.')}
        </section>
        <section class="cm-section"><h3>الاشتراكات</h3>${list(subs, 'لا اشتراكات.')}</section>
        <section class="cm-section"><h3>طلبات الحسابات</h3>${list(requests, 'لا طلبات.')}
            ${d.can_submit_request ? requestForm(d) : ''}</section>
        <section class="cm-section"><h3>السجل</h3><p class="cm-muted">${esc(d.history_note)}</p>${list(history, 'لا أحداث مسجّلة.')}</section>`;

    wireManagerForm(d);
    wireRequestForm(d);
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

function wireManagerForm(d) {
    const form = $('cmManagerForm');
    if (!form) return;
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const status = $('cmManagerStatus');
        const reason = $('cmManagerReason').value.trim();
        const problem = reasonError(reason);
        if (problem) { say(status, problem, 'error'); return; }
        const btn = form.querySelector('button[type=submit]');
        btn.disabled = true;
        const { error } = await supabase.rpc('customer_manager_assign', {
            p_customer: d.profile.id, p_manager: $('cmManagerSelect').value || null, p_reason: reason
        });
        btn.disabled = false;
        if (error) { say(status, errorMessage(error), 'error'); return; }
        say(status, 'تم حفظ الإسناد.', 'success');
        await openDetails(d.profile.id);
        load();
    });
}

function requestForm(d) {
    const companies = (options.companies || []).filter(c => c.status !== 'suspended')
        .map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
    const types = Object.entries(REQUEST_TYPES).map(([k, v]) =>
        `<option value="${esc(k)}">${esc(v)}${k === 'transfer_direct_to_company' ? ' — التنفيذ غير متاح بعد' : ''}</option>`).join('');
    return `<form class="cm-form" id="cmRequestForm" novalidate data-key="${esc(newIdempotencyKey())}">
        <strong>طلب حساب (يقرره مالك المنصة)</strong>
        <p class="cm-note cm-muted">إرسال الطلب لا يغيّر ارتباط العميل ولا ملكيته. العميل يُحدَّد بمعرّفه الثابت، والبريد للتحقق فقط.</p>
        <label>نوع الطلب<select id="cmReqType">${types}</select></label>
        <label>بريد العميل (اكتبه كما في حسابه للتحقق)<input id="cmReqEmail" type="email" class="cm-ltr" maxlength="320" autocomplete="off"></label>
        <label>بريد آخر للتواصل (اختياري — لن يتغير بريد الدخول)<input id="cmReqTarget" type="email" class="cm-ltr" maxlength="320" autocomplete="off"></label>
        <label>الشركة الوجهة<select id="cmReqCompany"><option value="">اختر شركة…</option>${companies}</select></label>
        <label>السبب<textarea id="cmReqReason" maxlength="500"></textarea></label>
        <p class="cm-note cm-tone-warn" id="cmReqTransferNote" hidden>النقل الكامل غير متاح بعد: يمكن إرسال الطلب ومراجعته، لكن لا يمكن الموافقة عليه وتنفيذه حتى يكتمل تصميم النقل.</p>
        <div class="cm-actions"><button type="submit" class="btn btn-primary btn-sm">إرسال الطلب</button></div>
        <p class="cm-status" id="cmReqStatus" role="status" aria-live="polite"></p>
    </form>`;
}

function wireRequestForm(d) {
    const form = $('cmRequestForm');
    if (!form) return;
    const syncNote = () => { $('cmReqTransferNote').hidden = $('cmReqType').value !== 'transfer_direct_to_company'; };
    $('cmReqType').addEventListener('change', syncNote);
    syncNote();
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const status = $('cmReqStatus');
        const input = {
            type: $('cmReqType').value, customerEmail: $('cmReqEmail').value.trim(), targetEmail: $('cmReqTarget').value.trim(),
            companyId: $('cmReqCompany').value, reason: $('cmReqReason').value.trim()
        };
        const problem = requestFormError(input);
        if (problem) { say(status, problem, 'error'); return; }
        const btn = form.querySelector('button[type=submit]');
        btn.disabled = true;
        const { data, error } = await supabase.rpc('account_request_submit', {
            p_type: input.type, p_customer: d.profile.id, p_customer_email: input.customerEmail,
            p_target_email: input.targetEmail || null, p_company: input.companyId, p_reason: input.reason,
            p_idempotency_key: form.dataset.key
        });
        btn.disabled = false;
        if (error) { say(status, errorMessage(error), 'error'); return; }
        say(status, data?.replayed ? 'الطلب مُرسل بالفعل.' : 'أُرسل الطلب إلى مالك المنصة. لم يتغير شيء في حساب العميل.', 'success');
        form.querySelectorAll('input, select, textarea, button').forEach(el => { el.disabled = true; });
        load();
    });
}

function say(el, text, kind) {
    el.textContent = text;
    el.dataset.kind = kind;
}

init();
