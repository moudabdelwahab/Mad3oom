/**
 * owner/account-requests.html — «طلبات الحسابات» لمالك المنصة (migrations/105 + 106).
 *
 * نسخة المالك من الفرع المالكي في assets/js/admin/account-requests.js — بقشرة المالك
 * ونافذة المالك (openModal) بدل درج الإدارة، وبلا فرع مقدّم الطلبات (المالك يقرر فقط):
 *
 *   account_requests_overview()                 من أنت هنا وهل التنفيذ متاح — لا يمنح شيئًا
 *   owner_account_requests(p_filters jsonb)     الصندوق بفلاتر وصفحات على الخادم
 *   owner_account_request_details(p_request)    التفاصيل وملخص الأثر وإعادة التحقق الآن
 *   owner_decide_account_request(...)           القرار: المالك بخطوتين، ولا قرار على طلبك
 * زر الموافقة لا يظهر مفعّلًا إلا حين يقول الخادم إن التنفيذ متاح؛ والخادم يرفض على أي حال.
 * الموافقة من داخل نافذة القرار نفسها — نصها يصرّح بأن التنفيذ فوري — بلا window.confirm:
 * صفحات المالك لا تستخدمه، والتأكيد هو زر الموافقة نفسه بعد قراءة ملخص الأثر والتحقق.
 * لا إرسال طلب هنا (account_request_submit مسار مقدّم الطلب، لا المالك).
 */
import {
    supabase, bootOwnerPage, announce, esc, when, num, table, kpis, errorBlock, loadingBlock, openModal,
    friendlyError, renderPager, writeResult
} from '/assets/js/owner/owner-page.js';
import {
    REQUEST_TYPES, CHECK_LABELS, SWITCH_LABELS, ACCOUNT_TYPES,
    errorMessage, reasonError, approvalState, pageSummary, formatDate,
    impactLines, isFailedRecoverable, failureText, decisionResultText, requestStatusLabel
} from '/assets/js/admin/customers-model.js';

const $ = (id) => document.getElementById(id);
const say = (text, tone = 'info') => announce($('pageStatus'), text, tone);
const dash = (v) => (v === null || v === undefined || v === '' ? '<span class="cm-muted">—</span>' : esc(v));
const STATUS_TONE = { pending: 'cm-tone-warn', approved: 'cm-tone-ok', rejected: 'cm-tone-bad', cancelled: '' };
const PAGE_SIZE = 25;
const TABS = [
    { key: 'pending', label: 'بانتظار القرار' },
    { key: 'approved', label: 'الموافَق عليها' },
    { key: 'rejected', label: 'المرفوضة' },
    { key: 'cancelled', label: 'الملغاة' },
    { key: 'all', label: 'الكل' }
];

let overview = null;
let tab = 'pending';
let rows = [];
let total = 0;
let page = 0;
let seq = 0;

async function rpc(name, args) {
    try {
        const { data, error } = await supabase.rpc(name, args);
        return { data, error };
    } catch (err) {
        return { data: null, error: err };
    }
}

function buildTabs() {
    $('reqTabs').innerHTML = TABS.map(t => `<button type="button" class="view-tab" role="tab" data-tab="${esc(t.key)}" aria-selected="${t.key === tab}">${esc(t.label)}</button>`).join('');
    $('reqType').innerHTML = '<option value="">كل الأنواع</option>' + Object.entries(REQUEST_TYPES).map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join('');
}

function renderBanner() {
    const ex = overview.execution || {};
    const parts = [];
    // حال التنفيذ لكل نوع كما يقوله الخادم (106): متاح، أو غير متاح بعد مع المتطلبات الناقصة
    for (const [type, label] of Object.entries(REQUEST_TYPES)) {
        const e = ex[type] || {};
        const missing = (e.missing || []).map(k => SWITCH_LABELS[k] || k).join('، ');
        parts.push(e.available
            ? `<p class="cm-note cm-tone-ok">${esc(label)}: التنفيذ متاح بعد الموافقة.</p>`
            : `<p class="cm-note cm-tone-warn">${esc(label)}: <strong>التنفيذ غير متاح بعد</strong>${missing ? ` (يتطلب: ${esc(missing)})` : ''}. يمكن مراجعة الطلبات ورفضها، ولا موافقة بلا تنفيذ.</p>`);
    }
    if (!overview.owner_step_up) {
        parts.push('<p class="cm-note">القرار يتطلب تحققًا بخطوتين حديثًا: <a href="/owner-dashboard.html#authority">لوحة المالك ← التحقق</a>.</p>');
    }
    $('reqBanner').innerHTML = parts.join('');
}

async function loadFilterOptions() {
    const { data } = await rpc('admin_customer_filter_options');
    const companies = data?.companies || [];
    $('reqCompany').innerHTML = '<option value="">كل الشركات</option>' + companies.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
}

function ownerFilters() {
    const f = { limit: PAGE_SIZE, offset: page * PAGE_SIZE };
    if (tab !== 'all') f.status = tab;
    const pairs = [['request_type', $('reqType').value], ['requested_by', $('reqRequester').value],
                   ['customer_email', $('reqEmail').value.trim()], ['company_id', $('reqCompany').value]];
    for (const [k, v] of pairs) if (v) f[k] = v;
    if ($('reqFrom').value) f.from = new Date(`${$('reqFrom').value}T00:00:00`).toISOString();
    if ($('reqTo').value) {
        const to = new Date(`${$('reqTo').value}T00:00:00`);
        to.setDate(to.getDate() + 1);
        f.to = to.toISOString();
    }
    return f;
}

function selectTab(key) {
    tab = key;
    page = 0;
    $('reqTabs').querySelectorAll('[data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === key)));
    load();
}

async function load() {
    const mine = ++seq;
    $('reqTable').innerHTML = loadingBlock();
    const res = await rpc('owner_account_requests', { p_filters: ownerFilters() });
    if (mine !== seq) return;
    if (res.error) {
        $('reqTable').innerHTML = errorBlock(errorMessage(res.error));
        return;
    }
    rows = res.data?.rows || [];
    total = Number(res.data?.total) || 0;
    fillRequesters(res.data?.requesters || []);
    $('reqKpis').innerHTML = kpis([
        ['بانتظار قرارك', num(res.data?.pending_count ?? 0), (res.data?.pending_count || 0) ? 'kpi--info' : ''],
        ['طلبات مطابقة', num(total), '']
    ]);
    renderRows();
    renderPager($('reqPager'), { page, size: PAGE_SIZE, total, onPage: (n) => { page = n; load(); },
        text: `${pageSummary(total, page * PAGE_SIZE, rows.length)} طلب` });
}

function fillRequesters(list) {
    const sel = $('reqRequester');
    const current = sel.value;
    sel.innerHTML = '<option value="">كل مقدّمي الطلبات</option>' + list.map(r => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('');
    sel.value = list.some(r => r.id === current) ? current : '';
}

function renderRows() {
    $('reqTable').innerHTML = table(
        ['النوع', 'العميل', 'الشركة الوجهة', 'مقدّم الطلب', 'التاريخ', 'الحالة', ''],
        rows,
        (r) => `<tr>
            <td>${esc(REQUEST_TYPES[r.request_type] || r.request_type)}</td>
            <td>${dash(r.customer_name)}<div class="cm-muted cm-ltr">${esc(r.customer_email)}</div></td>
            <td>${dash(r.company_name)}</td>
            <td>${dash(r.requester_name)}</td>
            <td>${esc(formatDate(r.requested_at, true))}</td>
            <td><span class="cm-badge ${isFailedRecoverable(r) ? 'cm-tone-bad' : (STATUS_TONE[r.status] || '')}">${esc(requestStatusLabel(r))}</span></td>
            <td><button type="button" class="btn btn-secondary btn-sm" data-open="${esc(r.id)}">${r.status === 'pending' ? 'مراجعة' : 'عرض'}</button></td>
        </tr>`,
        { empty: tab === 'pending' ? 'لا طلبات بانتظار قرارك.' : 'لا طلبات مطابقة.' });
    $('reqTable').querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openRequest(b.dataset.open)));
}

/* ── نافذة التفاصيل والقرار ─────────────────────────────────────────────── */

const kv = (pairs) => `<dl class="cm-kv">${pairs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;

function requestInfo(r) {
    return kv([
        ['النوع', esc(REQUEST_TYPES[r.request_type] || r.request_type)],
        ['الحالة', `<span class="cm-badge ${isFailedRecoverable(r) ? 'cm-tone-bad' : (STATUS_TONE[r.status] || '')}">${esc(requestStatusLabel(r))}</span>`],
        ['آخر محاولة تنفيذ', r.last_failure ? `${esc(failureText(r.last_failure))} <span class="cm-muted">(${esc(formatDate(r.last_failure.at, true))} · محاولات: ${esc(r.attempts)})</span>` : dash(null)],
        ['نتيجة التنفيذ', r.status === 'approved' && r.outcome ? esc(decisionResultText({ status: 'approved', ...r.outcome })) : dash(null)],
        ['العميل', `${dash(r.customer_name)} <span class="cm-mono">${esc(String(r.customer_id || '').slice(0, 8))}</span>`],
        ['بريد العميل (للتحقق)', `<span class="cm-ltr">${dash(r.customer_email)}</span>`],
        ['بريد آخر ذُكر', r.target_email ? `<span class="cm-ltr">${esc(r.target_email)}</span> <span class="cm-muted">— للعلم فقط، لا يغيّر بريد الدخول</span>` : dash(null)],
        ['الشركة الوجهة', dash(r.company_name)],
        ['السبب', dash(r.reason)],
        ['مقدّم الطلب', `${dash(r.requester_name)} · ${esc(formatDate(r.requested_at, true))}`],
        ['القرار', r.decided_at ? `${dash(r.decided_by_name || 'النظام')} · ${esc(formatDate(r.decided_at, true))}` : dash(null)],
        ['سبب القرار', dash(r.decision_reason)]
    ]);
}

async function openRequest(id) {
    const modal = openModal({ title: 'تفاصيل الطلب', wide: true, html: loadingBlock() });
    const { data, error } = await rpc('owner_account_request_details', { p_request: id });
    if (error) { modal.body.innerHTML = errorBlock(errorMessage(error)); return; }
    renderOwnerDetails(modal, data);
}

function renderOwnerDetails(modal, d) {
    const now = d.customer_now;
    const company = d.company;
    // ملخص الأثر من الخادم: ما سيحدث لكل فئة بيانات (لا وعد بنقل ما لا يُنقل)
    const impact = impactLines(d.impact).map(esc);
    const checks = (d.checks || []).map(c => `<li data-ok="${c.ok}">${c.ok ? '✓' : '✗'} ${esc(CHECK_LABELS[c.code] || c.code)}</li>`).join('');
    const appr = approvalState(d);
    modal.body.innerHTML = `
        <section class="cm-section">${requestInfo(d)}</section>
        ${company ? `<section class="cm-section"><h3>الشركة الوجهة</h3>${kv([
            ['الاسم', esc(company.name)], ['بريد تواصل الشركة', `<span class="cm-ltr">${dash(company.contact_email)}</span>`],
            ['المالك', dash(company.owner_name)], ['الحالة', esc(company.status === 'active' ? 'نشطة' : 'موقوفة')]])}</section>` : ''}
        ${now ? `<section class="cm-section"><h3>العميل الآن</h3>${kv([
            ['نوع الحساب', esc(ACCOUNT_TYPES[now.account_type] || now.account_type)],
            ['الحالة', esc(now.status === 'active' ? 'نشط' : 'موقوف')],
            ['الشركات', now.companies?.length ? now.companies.map(c => esc(c.name) + (c.is_primary ? ' (أساسية)' : '')).join('، ') : 'لا شركات'],
            ['تذاكر مفتوحة', esc(now.open_tickets)], ['اشتراكات نشطة', esc(now.active_subscriptions)]])}</section>` : ''}
        ${d.status === 'pending' ? `
        <section class="cm-section"><h3>ملخص الأثر</h3><ul class="cm-list">${impact.map(t => `<li>${t}</li>`).join('')}</ul></section>
        <section class="cm-section"><h3>إعادة التحقق الآن</h3><ul class="cm-list cm-checks">${checks}</ul></section>
        <section class="cm-section"><h3>القرار</h3>
            <form class="cm-form" id="arDecideForm" novalidate>
                <p class="panel-subtitle">الموافقة تنفّذ الطلب فورًا بعد إعادة التحقق من كل شرط — لا خطوة أخرى بعدها.</p>
                <label>السبب (إلزامي للرفض)<textarea id="arDecisionReason" maxlength="500"></textarea></label>
                ${appr.note ? `<p class="cm-note cm-tone-warn">${esc(appr.note)}</p>` : ''}
                <div class="cm-actions">
                    <button type="button" class="btn btn-primary btn-sm" id="arApprove" ${appr.enabled ? '' : 'disabled'}>${esc(appr.label)}</button>
                    <button type="button" class="btn btn-danger btn-sm" id="arReject" ${d.self_requested || !d.can_decide ? 'disabled' : ''}>رفض</button>
                </div>
                <p class="cm-status" id="arDecideStatus" role="status" aria-live="polite"></p>
            </form>
        </section>` : ''}`;
    wireDecision(modal, d);
}

function wireDecision(modal, d) {
    const form = modal.body.querySelector('#arDecideForm');
    if (!form) return;
    const status = modal.body.querySelector('#arDecideStatus');
    const sayIn = (text, kind) => { status.textContent = text; status.dataset.kind = kind; };
    const decide = async (approve) => {
        const reason = modal.body.querySelector('#arDecisionReason').value.trim();
        if (!approve) {
            const problem = reasonError(reason);
            if (problem) { sayIn(problem, 'error'); return; }
        }
        form.querySelectorAll('button').forEach(b => { b.disabled = true; });
        const res = await rpc('owner_decide_account_request', { p_request: d.id, p_approve: approve, p_reason: reason || null });
        // حال الطلب على الخادم هو المرجع: نعيد التحميل ونعرض النتيجة كما أكّدها الخادم
        const fresh = await rpc('owner_account_request_details', { p_request: d.id });
        if (!fresh.error && fresh.data) renderOwnerDetails(modal, fresh.data);
        load();
        if (res.error) {
            const target = modal.body.querySelector('#arDecideStatus') || modal.body.querySelector('.cm-section');
            if (target) { target.textContent = errorMessage(res.error); target.dataset.kind = 'error'; }
            return;
        }
        // الرفض بـRLS يعود بلا صفوف وبلا خطأ — writeResult يثبت النجاح من صف العودة، لا «تم» على ما لم يحدث
        const checked = writeResult(res, { denied: 'لم يُحفظ القرار — القاعدة لم تسمح بالتنفيذ.' });
        if (!checked.ok) {
            const target = modal.body.querySelector('#arDecideStatus') || modal.body.querySelector('.cm-section');
            if (target) { target.textContent = checked.message; target.dataset.kind = 'error'; }
            return;
        }
        // فشل تنفيذ مسجَّل: الطلب ما زال قيد القرار ولم يتغير شيء — لا رسالة نجاح
        const target = modal.body.querySelector('#arDecideStatus') || modal.body.querySelector('.cm-section');
        if (target) {
            target.textContent = decisionResultText(res.data);
            target.dataset.kind = res.data?.outcome === 'failed' ? 'error' : 'success';
        }
        say(decisionResultText(res.data), res.data?.outcome === 'failed' ? 'error' : 'success');
    };
    modal.body.querySelector('#arApprove').addEventListener('click', () => decide(true));
    modal.body.querySelector('#arReject').addEventListener('click', () => decide(false));
}

(async function init() {
    if (!await bootOwnerPage()) return;
    const { data, error } = await rpc('account_requests_overview');
    if (error || !data) {
        $('reqTable').innerHTML = errorBlock(error ? errorMessage(error) : 'طلبات الحسابات غير متاحة لحسابك.');
        return;
    }
    overview = data;
    if (!overview.is_owner) {
        $('reqTable').innerHTML = errorBlock('هذه الصفحة لمالك المنصة وحده — صندوق قرار طلبات الحسابات.');
        return;
    }
    renderBanner();
    buildTabs();
    await loadFilterOptions();
    $('reqTabs').addEventListener('click', (e) => {
        const b = e.target.closest('[data-tab]');
        if (b) selectTab(b.dataset.tab);
    });
    let t = null;
    const reload = () => { page = 0; load(); };
    ['reqType', 'reqRequester', 'reqCompany', 'reqFrom', 'reqTo'].forEach(id => $(id).addEventListener('change', reload));
    $('reqEmail').addEventListener('input', () => { clearTimeout(t); t = setTimeout(reload, 350); });
    $('reqFilters').addEventListener('submit', (e) => { e.preventDefault(); reload(); });
    $('reqRefresh').addEventListener('click', () => load());
    const wanted = new URLSearchParams(location.search).get('view');
    selectTab(TABS.some(t => t.key === wanted) ? wanted : 'pending');
})();
