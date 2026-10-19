/**
 * account-requests.js — «طلبات الحسابات — Account Requests» (migrations/105).
 *
 *   account_requests_overview()                 من أنت هنا (مالك / مقدّم طلبات) وهل التنفيذ متاح — لا يمنح شيئًا
 *   my_account_requests(p_status)               «طلباتي» لمقدّم الطلب
 *   owner_account_requests(p_filters)           صندوق المالك بفلاتر وصفحات على الخادم
 *   owner_account_request_details(p_request)    التفاصيل وملخص الأثر وإعادة التحقق الآن
 *   owner_decide_account_request(...)           القرار: المالك بخطوتين، ولا قرار على طلبك
 *   account_request_cancel(...)                 مقدّم الطلب يلغي طلبه المعلّق
 * زر الموافقة لا يظهر مفعّلًا إلا حين يقول الخادم إن التنفيذ متاح؛ والخادم يرفض على أي حال.
 */
import { supabase } from '/api-config.js';
import { checkAdminAuth, updateAdminUI } from './auth.js';
import { initSidebar } from './sidebar.js';
import { debounce } from './admin-utils.js';
import {
    REQUEST_TYPES, REQUEST_STATUS, CHECK_LABELS, SWITCH_LABELS, ACCOUNT_TYPES,
    escapeText as esc, errorMessage, reasonError, approvalState, pageSummary, formatDate
} from './customers-model.js';

const $ = (id) => document.getElementById(id);
const dash = (v) => (v === null || v === undefined || v === '' ? '<span class="cm-muted">—</span>' : esc(v));
const STATUS_TONE = { pending: 'cm-tone-warn', approved: 'cm-tone-ok', rejected: 'cm-tone-bad', cancelled: '' };

let overview = null;
let tab = null;
let rows = [];
let total = 0;
const page = { limit: 25, offset: 0 };
let seq = 0;
let lastFocus = null;

async function init() {
    initSidebar();
    const user = await checkAdminAuth();
    if (!user) return;
    updateAdminUI(user);

    const { data, error } = await supabase.rpc('account_requests_overview');
    if (error || !data) {
        renderState('error', error ? errorMessage(error) : 'طلبات الحسابات غير متاحة لحسابك.');
        return;
    }
    overview = data;
    renderBanner();
    buildTabs();
    wire();
    if (overview.is_owner) await loadFilterOptions();
    const wanted = new URLSearchParams(location.search).get('view');
    selectTab(tabs().some(t => t.key === wanted) ? wanted : tabs()[0]?.key);
}

function tabs() {
    if (overview?.is_owner) {
        return [{ key: 'pending', label: 'بانتظار القرار' }, { key: 'approved', label: 'الموافَق عليها' },
                { key: 'rejected', label: 'المرفوضة' }, { key: 'cancelled', label: 'الملغاة' }, { key: 'all', label: 'الكل' }];
    }
    if (overview?.can_submit) {
        return [{ key: 'mine', label: 'طلباتي' }, { key: 'mine:pending', label: 'قيد القرار' },
                { key: 'mine:approved', label: 'الموافَق عليها' }, { key: 'mine:rejected', label: 'المرفوضة' }];
    }
    return [];
}

function renderBanner() {
    const ex = overview.execution || {};
    const add = ex.add_to_company || {};
    const missing = (add.missing || []).map(k => SWITCH_LABELS[k] || k).join('، ');
    const parts = [];
    parts.push(add.available
        ? '<p class="cm-note cm-tone-ok">إضافة عميل إلى شركة: التنفيذ متاح بعد الموافقة.</p>'
        : `<p class="cm-note cm-tone-warn">إضافة عميل إلى شركة: <strong>التنفيذ غير متاح بعد</strong>${missing ? ` (يتطلب: ${esc(missing)})` : ''}. يمكن إرسال الطلبات ومراجعتها ورفضها، ولا موافقة بلا تنفيذ.</p>`);
    parts.push('<p class="cm-note cm-tone-warn">نقل عميل مباشر إلى شركة: <strong>التنفيذ غير متاح بعد</strong> — مسار الطلب والمراجعة فقط.</p>');
    if (overview.is_owner && !overview.owner_step_up) {
        parts.push('<p class="cm-note">القرار يتطلب تحققًا بخطوتين حديثًا: <a href="/owner-dashboard.html#authority">لوحة المالك ← التحقق</a>.</p>');
    }
    if (!overview.is_owner && !overview.can_submit) {
        parts.push('<p class="cm-note">هذا الحساب لا يرسل طلبات ولا يقررها.</p>');
    }
    $('arBanner').innerHTML = parts.join('');
}

function buildTabs() {
    $('arTabs').innerHTML = tabs().map(t => `<button type="button" class="cm-view" data-tab="${esc(t.key)}" aria-pressed="false">${esc(t.label)}</button>`).join('');
    $('arFilters').hidden = !overview.is_owner;
    $('arPager').hidden = !overview.is_owner;
    $('arType').innerHTML = '<option value="">الكل</option>' + Object.entries(REQUEST_TYPES).map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join('');
}

function wire() {
    $('arTabs').addEventListener('click', (e) => {
        const b = e.target.closest('[data-tab]');
        if (b) selectTab(b.dataset.tab);
    });
    ['arType', 'arRequester', 'arCompany', 'arFrom', 'arTo'].forEach(id => $(id).addEventListener('change', () => { page.offset = 0; load(); }));
    $('arEmail').addEventListener('input', debounce(() => { page.offset = 0; load(); }, 350));
    $('arPrev').addEventListener('click', () => { page.offset = Math.max(0, page.offset - page.limit); load(); });
    $('arNext').addEventListener('click', () => { page.offset += page.limit; load(); });
    $('arBody').addEventListener('click', (e) => {
        const b = e.target.closest('[data-open]');
        if (b) openRequest(b.dataset.open);
        if (e.target.closest('[data-retry]')) load();
    });
    $('arDrawerClose').addEventListener('click', closeDrawer);
    $('arOverlay').addEventListener('click', closeDrawer);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('arDrawer').hidden) closeDrawer(); });
}

async function loadFilterOptions() {
    const { data } = await supabase.rpc('admin_customer_filter_options');
    const companies = data?.companies || [];
    $('arCompany').innerHTML = '<option value="">كل الشركات</option>' + companies.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
}

function selectTab(key) {
    if (!key) {
        renderState('empty', 'لا طلبات لعرضها.');
        return;
    }
    tab = key;
    page.offset = 0;
    $('arTabs').querySelectorAll('[data-tab]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tab === key)));
    load();
}

function renderState(kind, message) {
    const retry = kind === 'error' && overview ? ' <button type="button" class="btn btn-secondary btn-sm" data-retry>إعادة المحاولة</button>' : '';
    $('arBody').innerHTML = `<tr><td colspan="7" class="cm-state" data-kind="${esc(kind)}">${
        kind === 'loading' ? '<div class="cm-skeleton"></div>' : esc(message) + retry}</td></tr>`;
}

function ownerFilters() {
    const f = { limit: page.limit, offset: page.offset };
    if (tab !== 'all') f.status = tab;
    const pairs = [['request_type', $('arType').value], ['requested_by', $('arRequester').value],
                   ['customer_email', $('arEmail').value.trim()], ['company_id', $('arCompany').value]];
    for (const [k, v] of pairs) if (v) f[k] = v;
    if ($('arFrom').value) f.from = new Date(`${$('arFrom').value}T00:00:00`).toISOString();
    if ($('arTo').value) {
        const to = new Date(`${$('arTo').value}T00:00:00`);
        to.setDate(to.getDate() + 1);
        f.to = to.toISOString();
    }
    return f;
}

async function load() {
    const mine = ++seq;
    renderState('loading');
    let res;
    if (overview.is_owner) {
        res = await supabase.rpc('owner_account_requests', { p_filters: ownerFilters() });
    } else {
        const status = tab.includes(':') ? tab.split(':')[1] : null;
        res = await supabase.rpc('my_account_requests', { p_status: status });
    }
    if (mine !== seq) return;
    if (res.error) {
        renderState('error', `تعذّر تحميل الطلبات: ${errorMessage(res.error)}`);
        return;
    }
    if (overview.is_owner) {
        rows = res.data?.rows || [];
        total = Number(res.data?.total) || 0;
        fillRequesters(res.data?.requesters || []);
        $('arPageInfo').textContent = pageSummary(total, page.offset, rows.length);
        $('arPrev').disabled = page.offset === 0;
        $('arNext').disabled = page.offset + rows.length >= total;
    } else {
        rows = Array.isArray(res.data) ? res.data : [];
        total = rows.length;
    }
    renderRows();
}

function fillRequesters(list) {
    const sel = $('arRequester');
    const current = sel.value;
    sel.innerHTML = '<option value="">الكل</option>' + list.map(r => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('');
    sel.value = list.some(r => r.id === current) ? current : '';
}

function renderRows() {
    if (!rows.length) {
        renderState('empty', tab === 'pending' ? 'لا طلبات بانتظار قرارك.' : 'لا طلبات مطابقة.');
        return;
    }
    $('arBody').innerHTML = rows.map(r => `
        <tr>
            <td data-label="النوع">${esc(REQUEST_TYPES[r.request_type] || r.request_type)}${
                r.request_type === 'transfer_direct_to_company' ? '<div class="cm-muted">التنفيذ غير متاح بعد</div>' : ''}</td>
            <td data-label="العميل">${dash(r.customer_name)}<div class="cm-muted cm-ltr">${esc(r.customer_email)}</div></td>
            <td data-label="الشركة الوجهة">${dash(r.company_name)}</td>
            <td data-label="مقدّم الطلب">${dash(r.requester_name)}</td>
            <td data-label="التاريخ">${esc(formatDate(r.requested_at, true))}</td>
            <td data-label="الحالة"><span class="cm-badge ${STATUS_TONE[r.status] || ''}">${esc(REQUEST_STATUS[r.status] || r.status)}</span></td>
            <td data-label=""><button type="button" class="btn btn-secondary btn-sm" data-open="${esc(r.id)}">${r.status === 'pending' && overview.is_owner ? 'مراجعة' : 'عرض'}</button></td>
        </tr>`).join('');
}

/* ── الدرج ─────────────────────────────────────────────────────────────── */

function openDrawer() {
    lastFocus = document.activeElement;
    $('arOverlay').hidden = false;
    $('arDrawer').hidden = false;
    $('arDrawerClose').focus();
}

function closeDrawer() {
    $('arOverlay').hidden = true;
    $('arDrawer').hidden = true;
    lastFocus?.focus?.();
}

const kv = (pairs) => `<dl class="cm-kv">${pairs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;

function requestInfo(r) {
    return kv([
        ['النوع', esc(REQUEST_TYPES[r.request_type] || r.request_type)],
        ['الحالة', `<span class="cm-badge ${STATUS_TONE[r.status] || ''}">${esc(REQUEST_STATUS[r.status] || r.status)}</span>`],
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
    $('arDrawerTitle').textContent = 'تفاصيل الطلب';
    $('arDrawerBody').innerHTML = '<div class="cm-skeleton"></div>';
    openDrawer();
    if (!overview.is_owner) {
        const r = rows.find(x => x.id === id);
        if (!r) { $('arDrawerBody').innerHTML = '<p class="cm-state">الطلب غير موجود.</p>'; return; }
        $('arDrawerSub').textContent = REQUEST_TYPES[r.request_type] || '';
        $('arDrawerBody').innerHTML = `<section class="cm-section">${requestInfo(r)}</section>${r.status === 'pending' ? cancelForm() : ''}`;
        wireCancel(r);
        return;
    }
    const { data, error } = await supabase.rpc('owner_account_request_details', { p_request: id });
    if (error) { $('arDrawerBody').innerHTML = `<p class="cm-state" data-kind="error">${esc(errorMessage(error))}</p>`; return; }
    renderOwnerDetails(data);
}

function renderOwnerDetails(d) {
    $('arDrawerSub').textContent = REQUEST_TYPES[d.request_type] || '';
    const now = d.customer_now;
    const company = d.company;
    const impact = [];
    if (d.request_type === 'add_to_company') {
        impact.push(`يصبح العميل عضوًا في «${esc(company?.name || d.company_name)}» ${now?.has_primary_company ? 'كشركة إضافية (شركته الأساسية لا تتغير)' : 'كشركة أساسية'}.`);
        impact.push('تذاكر العميل السابقة تبقى خاصة به ولا تنكشف للشركة.');
        impact.push('الاشتراكات وبريد الدخول لا يتغيران.');
    } else {
        impact.push('النقل الكامل (الملكية والفوترة والتاريخ) غير متاح بعد — لا شيء يُنفَّذ بالموافقة.');
    }
    const checks = (d.checks || []).map(c => `<li data-ok="${c.ok}">${c.ok ? '✓' : '✗'} ${esc(CHECK_LABELS[c.code] || c.code)}</li>`).join('');
    const appr = approvalState(d);
    $('arDrawerBody').innerHTML = `
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
                <label>السبب (إلزامي للرفض)<textarea id="arDecisionReason" maxlength="500"></textarea></label>
                ${appr.note ? `<p class="cm-note cm-tone-warn">${esc(appr.note)}</p>` : ''}
                <div class="cm-actions">
                    <button type="button" class="btn btn-primary btn-sm" id="arApprove" ${appr.enabled ? '' : 'disabled'}>${esc(appr.label)}</button>
                    <button type="button" class="btn btn-danger btn-sm" id="arReject" ${d.self_requested || !d.can_decide ? 'disabled' : ''}>رفض</button>
                </div>
                <p class="cm-status" id="arDecideStatus" role="status" aria-live="polite"></p>
            </form>
        </section>` : ''}`;
    wireDecision(d);
}

function wireDecision(d) {
    const form = $('arDecideForm');
    if (!form) return;
    const status = $('arDecideStatus');
    const decide = async (approve) => {
        const reason = $('arDecisionReason').value.trim();
        if (!approve) {
            const problem = reasonError(reason);
            if (problem) { say(status, problem, 'error'); return; }
        } else if (!window.confirm('الموافقة تنفّذ الطلب فورًا بعد إعادة التحقق من كل شرط. متابعة؟')) {
            return;
        }
        form.querySelectorAll('button').forEach(b => { b.disabled = true; });
        const { data, error } = await supabase.rpc('owner_decide_account_request', { p_request: d.id, p_approve: approve, p_reason: reason || null });
        if (error) {
            say(status, errorMessage(error), 'error');
            // حال الطلب على الخادم هو المرجع: نعيد التحميل لعرضه كما هو
            const fresh = await supabase.rpc('owner_account_request_details', { p_request: d.id });
            if (!fresh.error && fresh.data) { renderOwnerDetails(fresh.data); say($('arDecideStatus') || status, errorMessage(error), 'error'); }
            return;
        }
        say(status, data?.status === 'approved' ? 'تمت الموافقة والتنفيذ.' : 'رُفض الطلب.', 'success');
        load();
        const fresh = await supabase.rpc('owner_account_request_details', { p_request: d.id });
        if (!fresh.error && fresh.data) renderOwnerDetails(fresh.data);
    };
    $('arApprove').addEventListener('click', () => decide(true));
    $('arReject').addEventListener('click', () => decide(false));
}

function cancelForm() {
    return `<section class="cm-section"><form class="cm-form" id="arCancelForm" novalidate>
        <label>سبب الإلغاء<textarea id="arCancelReason" maxlength="500"></textarea></label>
        <div class="cm-actions"><button type="submit" class="btn btn-secondary btn-sm">إلغاء الطلب</button></div>
        <p class="cm-status" id="arCancelStatus" role="status" aria-live="polite"></p>
    </form></section>`;
}

function wireCancel(r) {
    const form = $('arCancelForm');
    if (!form) return;
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const reason = $('arCancelReason').value.trim();
        const status = $('arCancelStatus');
        const problem = reasonError(reason);
        if (problem) { say(status, problem, 'error'); return; }
        const { error } = await supabase.rpc('account_request_cancel', { p_request: r.id, p_reason: reason });
        if (error) { say(status, errorMessage(error), 'error'); return; }
        say(status, 'أُلغي الطلب.', 'success');
        form.querySelectorAll('textarea, button').forEach(el => { el.disabled = true; });
        load();
    });
}

function say(el, text, kind) {
    if (!el) return;
    el.textContent = text;
    el.dataset.kind = kind;
}

init();
