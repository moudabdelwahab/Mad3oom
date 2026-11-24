/**
 * owner/accounts.html — شجرة الحسابات لمالك المنصة (المرحلة 1: قراءة فقط).
 *
 * المصدر الوحيد owner_account_tree() (مigrations/128): الشجرة كاملة في نداء
 * واحد — وحدات ≤6 وشركاتها وأعضاؤها، وفرع العملاء المباشرين، وشركات بلا
 * وحدة. لا إجراءات كتابة هنا إطلاقًا: لا إنشاء وحدة ولا إسناد ولا تفويض
 * ولا طلبات — كلها في مساراتها القائمة (حوكمة الشركات)، وهذه الصفحة تعرض
 * فقط وتربط إليها. المفاتيح delegation_enabled و
 * account_request_execution_enabled و company_suspension_enforced لا تُلمس.
 *
 * لوحة التفاصيل: من ردّ الشجرة نفسه. ولعميلٍ تُستكمل — عند النقر فقط — من
 * admin_customer_details() الموجود (سجل العضويات والامتيازات والطلبات)؛
 * فإن رفضته القاعدة في سياق المالك (42501) عُرضت بيانات الشجرة مع ملاحظة
 * أن التفاصيل الكاملة في دليل العملاء، لا رقم مخترع ولا صفحة فارغة.
 */
import {
    supabase, bootOwnerPage, announce, esc, when, day, num, kpis, errorBlock, loadingBlock, friendlyError
} from '/assets/js/owner/owner-page.js';
import {
    buildAccountTree, flattenTree, searchTree, applyFilters, defaultCollapsed,
    loadCollapsed, saveCollapsed, toggleCollapsed, TYPE_LABELS, ACCOUNT_TYPE_LABELS,
    PERSON_KIND_LABELS, statusInfo, subscriptionInfo, normalizeSearch
} from '/assets/js/owner/accounts-tree-model.js';

const $ = (id) => document.getElementById(id);
const MISSING = new Set(['PGRST202', '42883', 'PGRST404']);

let tree = null;
let view = null;
let collapsed = new Set();
let selectedKey = 'root';
let searchTerm = '';
let searchMatches = new Set();
let detailsCache = new Map();

const say = (text, tone = 'info') => announce($('pageStatus'), text, tone);

const ICONS = {
    root: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l7 3v6c0 4.5-3 7.7-7 9-4-1.3-7-4.5-7-9V6z"/><path d="m9 12 2 2 4-4"/></svg>',
    unit: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
    company: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 21h18"/><path d="M5 21V10l7-5 7 5v11"/><path d="M9 21v-6h6v6"/></svg>',
    person: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
    direct: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    unassigned: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.5v.5"/></svg>'
};

/** تمييز نص البحث داخل الاسم: التقسيم على النص الخام ثم الهروب لكل جزء. */
function hi(text, term) {
    const raw = String(text || '');
    const t = normalizeSearch(term);
    if (!t) return esc(raw);
    const lower = raw.toLowerCase();
    let out = '';
    let from = 0;
    let at = lower.indexOf(t, from);
    while (at !== -1) {
        out += esc(raw.slice(from, at)) + '<mark>' + esc(raw.slice(at, at + t.length)) + '</mark>';
        from = at + t.length;
        at = lower.indexOf(t, from);
    }
    return out + esc(raw.slice(from));
}

const pill = (label, tone) => label ? `<span class="pill ${tone || 'status-neutral'}">${esc(label)}</span>` : '';
const countsText = (c) => {
    const parts = [];
    if (c.members) parts.push(`${num(c.members)} عضو`);
    if (c.customers) parts.push(`${num(c.customers)} عميل`);
    if (c.openTickets) parts.push(`${num(c.openTickets)} تذكرة مفتوحة`);
    return parts.join(' · ');
};

function nodeRow(node) {
    const hasChildren = node.children.length > 0;
    const isCollapsed = collapsed.has(node.key);
    const isSelected = node.key === selectedKey;
    const isMatch = searchMatches.has(node.key);
    const sub = node.type === 'person' && node.data.subscription
        ? `<span class="acct-sub">${esc(node.data.subscriptionLabel)}${node.data.subscription?.end_date ? ` · ينتهي ${esc(day(node.data.subscription.end_date))}` : ''}</span>` : '';
    return `<li class="acct-node${isSelected ? ' is-selected' : ''}${isMatch ? ' is-match' : ''}" data-node="${esc(node.key)}">
        <div class="acct-row">
            ${hasChildren
                ? `<button type="button" class="acct-toggle" data-toggle="${esc(node.key)}" aria-expanded="${!isCollapsed}" aria-label="${isCollapsed ? 'فتح' : 'طي'} «${esc(node.name)}»"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg></button>`
                : '<span class="acct-toggle acct-toggle--leaf" aria-hidden="true"></span>'}
            <button type="button" class="acct-name" data-select="${esc(node.key)}" aria-current="${isSelected}">
                <span class="acct-icon" aria-hidden="true">${ICONS[node.type] || ICONS.person}</span>
                <span class="acct-label">
                    <span class="acct-title">${hi(node.name, searchTerm)}</span>
                    ${node.subtitle ? `<span class="acct-kind">${esc(node.subtitle)}</span>` : ''}
                </span>
                ${node.statusLabel ? pill(node.statusLabel, node.statusTone) : ''}
                ${node.data?.wallet?.is_frozen ? pill('رصيد مجمّد', 'status-pending') : ''}
                ${countsText(node.counts) ? `<span class="acct-counts">${esc(countsText(node.counts))}</span>` : ''}
                ${sub}
                ${node.data?.orphan ? '<span class="acct-flag">بلا وحدة أمّ</span>' : ''}
                ${node.data?.depthCapped ? '<span class="acct-flag">عمق مثبَّت عند 6</span>' : ''}
            </button>
        </div>
        ${hasChildren && !isCollapsed ? `<ul class="acct-children">${node.children.map(nodeRow).join('')}</ul>` : ''}
    </li>`;
}

function renderTree() {
    const box = $('acctTree');
    if (!view) { box.innerHTML = ''; return; }
    const total = flattenTree(view).length - 1;
    $('acctTreeCount').textContent = total ? `${num(total)} عقدة` : '';
    if (!view.children.length) {
        box.innerHTML = '<div class="state-block state-block--compact"><p class="state-text">لا نتائج مطابقة للبحث أو الفلاتر.</p></div>';
        return;
    }
    box.innerHTML = `<ul class="acct-tree">${view.children.map(nodeRow).join('')}</ul>`;
}

function currentFilters() {
    return {
        type: $('acctType').value,
        status: $('acctStatus').value,
        unit: $('acctUnit').value,
        noManager: $('acctNoManager').checked
    };
}

function applyView() {
    if (!tree) return;
    view = applyFilters(tree, currentFilters());
    renderTree();
}

function applySearch() {
    searchTerm = $('acctSearch').value;
    if (!normalizeSearch(searchTerm)) {
        searchMatches = new Set();
        collapsed = loadCollapsed(window.localStorage) ?? defaultCollapsed(tree);
        applyView();
        return;
    }
    const { matches, expand } = searchTree(tree, searchTerm);
    searchMatches = new Set(matches);
    // فتح مسار كل نتيجة تلقائيًا؛ الطي المحفوظ يعود عند مسح البحث.
    for (const key of expand) collapsed.delete(key);
    view = applyFilters(tree, currentFilters());
    renderTree();
    say(matches.length ? `${num(matches.length)} نتيجة مطابقة.` : 'لا نتائج مطابقة.', matches.length ? 'success' : 'info');
}

function findNode(key) {
    return flattenTree(tree).find(({ node }) => node.key === key)?.node || null;
}

function detailSection(title, inner) {
    return `<section class="owner-detail-section"><h3>${esc(title)}</h3>${inner}</section>`;
}

function kv(pairs) {
    return `<dl class="owner-detail-grid">${pairs.filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('')}</dl>`;
}

function eventsList(events) {
    if (!events?.length) return '<p class="panel-subtitle">لا أحداث مسجّلة على هذه العقدة.</p>';
    return `<ul class="owner-thread">${events.map(e => `<li>
        <div class="owner-thread-head"><span>${esc(e.action || '')}</span><span>${esc(when(e.at))}</span></div>
        <p class="state-text">الفاعل: ${esc(e.actor_name || '—')}</p>
    </li>`).join('')}</ul>`;
}

function renderDetail() {
    const box = $('acctDetail');
    const node = findNode(selectedKey) || tree;
    if (!node) { box.innerHTML = ''; return; }
    $('acctDetailTitle').textContent = node.name;
    const d = node.data || {};
    let html = '';

    if (node.type === 'root') {
        const c = d.counts || {};
        html += kv([
            ['الوحدات', num(c.units)], ['الشركات', num(c.companies)],
            ['عملاء مباشرون', num(c.direct_customers)], ['أعضاء', num(c.members)],
            ['عملاء', num(c.customers)], ['تذاكر مفتوحة', num(c.open_tickets)],
            ['التفويض', d.delegationEnabled ? 'مفعّل' : 'مطفأ (يبقى مطفأ في هذه المرحلة)']
        ]);
        html += '<p class="panel-subtitle">الجذر «مالك المنصة». اختر عقدة من الشجرة لعرض تفاصيلها. كل ما هنا قراءة فقط؛ الإجراءات في حوكمة الشركات ومساراتها القائمة.</p>';
    } else if (node.type === 'unit') {
        html += kv([
            ['الوصف', d.description ? esc(d.description) : null],
            ['العمق', num((d.depth ?? 0) + 1)],
            ['الأعضاء', num(d.members.length)], ['الشركات', num(node.children.filter(c => c.type === 'company').length)],
            ['التذاكر المفتوحة', num(node.counts.openTickets)],
            ['التفويضات السارية', num(d.delegations.length)]
        ]);
        if (d.members.length) {
            html += detailSection('أعضاء الوحدة', `<ul class="owner-thread">${d.members.map(m => `<li>
                <div class="owner-thread-head"><span>${esc(m.name || '—')}</span><span>${esc(m.role || '')}</span></div>
                <p class="state-text">منذ ${esc(day(m.since))} · ${num(m.open_tickets)} تذكرة مفتوحة مسندة</p>
            </li>`).join('')}</ul>`);
        }
        if (d.delegations.length) {
            html += detailSection('التفويضات السارية', `<ul class="owner-thread">${d.delegations.map(g => `<li>
                <div class="owner-thread-head"><span>${esc(g.name || '—')}</span><span>ينتهي ${esc(day(g.expires_at))}</span></div>
                <p class="state-text">${esc((g.capabilities || []).join('، '))}</p>
            </li>`).join('')}</ul>`);
        }
        html += detailSection('سجل تدقيق الوحدة', eventsList(d.events));
        html += '<p class="panel-subtitle">إنشاء وحدة أو إسناد شركة أو منح تفويض: في حوكمة الشركات بلوحة المالك، لا من هذه الصفحة.</p>';
    } else if (node.type === 'company') {
        html += kv([
            ['الحالة', pill(node.statusLabel, node.statusTone)],
            ['الأعضاء', num(d.membersCount)], ['العملاء', num(d.customersCount)],
            ['التذاكر المفتوحة', num(node.counts.openTickets)]
        ]);
        html += detailSection('الأعضاء والعملاء', node.children.length
            ? `<ul class="owner-thread">${node.children.map(p => `<li>
                <div class="owner-thread-head"><span>${esc(p.name)}</span><span>${esc(p.subtitle || '')}</span></div>
                <p class="state-text">${p.statusLabel ? `${esc(p.statusLabel)} · ` : ''}${esc(p.data.subscriptionLabel || '')}${p.data.manager ? ` · مدير الحساب: ${esc(p.data.manager.name || '')}` : ''} · ${num(p.counts.openTickets)} تذكرة مفتوحة</p>
            </li>`).join('')}</ul>`
            : '<p class="panel-subtitle">لا أعضاء ولا عملاء في هذه الشركة.</p>');
        html += detailSection('سجل تدقيق الشركة', eventsList(d.events));
        html += '<p class="panel-subtitle"><a href="/admin/customers.html">دليل العملاء في مساحة الإدارة</a> · <a href="/owner/subscriptions.html">اشتراكات المنصة</a></p>';
    } else if (node.type === 'person') {
        const sub = node.data.subscription;
        html += kv([
            ['الدور', d.accountTypeLabel ? esc(d.accountTypeLabel) : null],
            ['البريد', d.email ? `<span dir="ltr">${esc(d.email)}</span>` : null],
            ['الجوال', d.phone ? `<span dir="ltr">${esc(d.phone)}</span>` : null],
            ['رتبة الحساب', d.role ? esc(d.role) : null],
            ['الحالة', node.statusLabel ? pill(node.statusLabel, node.statusTone) : null],
            ['الاشتراك', sub ? `${esc(subscriptionInfo(sub).label)} — ${esc(sub.plan_name_ar || sub.plan)} · ينتهي ${esc(day(sub.end_date))}` : 'بلا اشتراك'],
            ['النقاط', num(d.points)],
            ['الرصيد المتاح', d.wallet ? `${num(d.wallet.available_points)} نقطة` : '—'],
            ['الرصيد', d.wallet?.is_frozen ? 'مجمّد' : 'غير مجمّد'],
            ['مدير الحساب', d.manager ? esc(d.manager.name || '') : 'بلا مدير حساب'],
            ['التذاكر المفتوحة', num(node.counts.openTickets)],
            ['عميل مباشر منذ', d.directSince ? esc(day(d.directSince)) : null]
        ]);
        if (d.memberships.length) {
            html += detailSection('عضويات الشركات', `<ul class="owner-thread">${d.memberships.map(m => `<li>
                <div class="owner-thread-head"><span>${esc(m.company_name || '')}</span><span>${esc(m.status || '')}${m.is_primary ? ' · أساسية' : ''}</span></div>
                <p class="state-text">انضم ${esc(day(m.joined_at))}${m.joined_via ? ` · عبر ${esc(m.joined_via)}` : ''}${m.ended_at ? ` · انتهت ${esc(day(m.ended_at))}` : ''}</p>
            </li>`).join('')}</ul>`);
        }
        if (d.managerHistory.length) {
            html += detailSection('سجل مديري الحساب', `<ul class="owner-thread">${d.managerHistory.map(h => `<li>
                <div class="owner-thread-head"><span>${esc(h.manager_name || '')}</span><span>${esc(day(h.assigned_at))}</span></div>
                <p class="state-text">أسندها ${esc(h.assigned_by_name || '—')}${h.reason ? ` · ${esc(h.reason)}` : ''}${h.ended_at ? ` · انتهت (${esc(h.end_cause || '')})` : ''}</p>
            </li>`).join('')}</ul>`);
        }
        html += '<div id="acctExtraDetail"><p class="panel-subtitle">جارٍ إكمال السجل من دليل العملاء…</p></div>';
        html += '<p class="panel-subtitle"><a href="/admin/customers.html">دليل العملاء في مساحة الإدارة</a></p>';
        box.innerHTML = html;
        loadExtraDetail(node);
        return;
    } else {
        // فرعا «عملاء مباشرون» و«شركات بلا وحدة»: عدّادات فقط.
        html += kv([
            ['العدد', num(node.counts.children)],
            ['الأعضاء', num(node.counts.members)], ['العملاء', num(node.counts.customers)],
            ['التذاكر المفتوحة', num(node.counts.openTickets)]
        ]);
    }
    box.innerHTML = html;
}

/** تفصيل العميل الإضافي من admin_customer_details() عند النقر فقط، مع تخزين مؤقت. */
async function loadExtraDetail(node) {
    const slot = $('acctExtraDetail');
    if (!slot) return;
    if (node.data.kind === 'unit_member' || node.data.accountType === 'platform_staff') {
        slot.innerHTML = '<p class="panel-subtitle">عضو طاقم: تفاصيله الكاملة في إدارة المستخدمين، لا في دليل العملاء.</p>';
        return;
    }
    if (detailsCache.has(node.id)) {
        renderExtraDetail(slot, detailsCache.get(node.id));
        return;
    }
    let data, error = null;
    try {
        ({ data, error } = await supabase.rpc('admin_customer_details', { p_customer: node.id }));
    } catch (err) {
        error = err;
    }
    if (error || !data) {
        slot.innerHTML = '<p class="panel-subtitle">تعذّر إكمال السجل من دليل العملاء في هذا السياق — البيانات أعلاه من شجرة الحسابات، والتفاصيل الكاملة (السجل والطلبات) في <a href="/admin/customers.html">دليل العملاء</a>.</p>';
        return;
    }
    detailsCache.set(node.id, data);
    renderExtraDetail(slot, data);
}

function renderExtraDetail(slot, data) {
    const history = Array.isArray(data.history) ? data.history : [];
    const requests = Array.isArray(data.requests) ? data.requests : [];
    slot.innerHTML = detailSection('سجل تدقيق الحساب', history.length
        ? `<ul class="owner-thread">${history.slice(0, 20).map(h => `<li>
            <div class="owner-thread-head"><span>${esc(h.action || '')}${h.company_name ? ` · ${esc(h.company_name)}` : ''}</span><span>${esc(when(h.at))}</span></div>
            <p class="state-text">الفاعل: ${esc(h.actor_name || '—')}${h.source ? ` · المصدر: ${esc(h.source)}` : ''}</p>
        </li>`).join('')}</ul><p class="panel-subtitle">${esc(data.history_note || '')}</p>`
        : '<p class="panel-subtitle">لا أحداث مسجّلة على هذا الحساب.</p>')
        + (requests.length ? detailSection('طلبات الحساب', `<ul class="owner-thread">${requests.map(r => `<li>
            <div class="owner-thread-head"><span>${esc(r.request_type || '')}</span><span>${esc(r.status || '')}</span></div>
            <p class="state-text">${esc(r.company_name || '')} · ${esc(when(r.requested_at))}</p>
        </li>`).join('')}</ul>`) : '');
}

function renderUnitOptions() {
    const sel = $('acctUnit');
    const current = sel.value;
    const units = flattenTree(tree).filter(({ node }) => node.type === 'unit')
        .map(({ node }) => node)
        .sort((a, b) => String(a.name).localeCompare(String(b.name), 'ar'));
    sel.innerHTML = '<option value="">كل الوحدات</option>' + units.map(u =>
        `<option value="${esc(u.id)}" ${u.id === current ? 'selected' : ''}>${esc('— '.repeat(u.data?.depth || 0) + u.name)}</option>`).join('');
}

async function load() {
    $('acctTree').innerHTML = loadingBlock();
    $('acctDetail').innerHTML = loadingBlock();
    let data, error = null;
    try {
        ({ data, error } = await supabase.rpc('owner_account_tree'));
    } catch (err) {
        error = err;
    }
    if (error) {
        const missing = MISSING.has(error.code) || error.status === 404;
        $('acctTree').innerHTML = errorBlock(missing
            ? 'دالة شجرة الحسابات غير مطبّقة بعد (الترحيل 128).'
            : friendlyError(error));
        $('acctDetail').innerHTML = '';
        $('acctKpis').innerHTML = '';
        return;
    }
    tree = buildAccountTree(data || {});
    const saved = loadCollapsed(window.localStorage);
    collapsed = saved ?? defaultCollapsed(tree);
    selectedKey = 'root';
    detailsCache = new Map();
    searchTerm = '';
    $('acctSearch').value = '';
    searchMatches = new Set();
    const c = tree.data.counts || {};
    $('acctKpis').innerHTML = kpis([
        ['الوحدات', num(c.units), ''],
        ['الشركات', num(c.companies), ''],
        ['عملاء مباشرون', num(c.direct_customers), ''],
        ['تذاكر مفتوحة', num(c.open_tickets), (c.open_tickets || 0) ? 'kpi--warning' : '']
    ]);
    renderUnitOptions();
    applyView();
    renderDetail();
}

function selectNode(key) {
    if (!findNode(key)) return;
    selectedKey = key;
    renderTree();
    renderDetail();
    const el = document.querySelector(`[data-select="${CSS.escape(key)}"]`);
    el?.focus({ preventScroll: true });
}

(async function init() {
    if (!await bootOwnerPage()) return;
    $('acctFilters').addEventListener('submit', (e) => { e.preventDefault(); applyView(); });
    $('acctSearch').addEventListener('input', applySearch);
    ['acctType', 'acctStatus', 'acctUnit'].forEach(id => $(id).addEventListener('change', applyView));
    $('acctNoManager').addEventListener('change', applyView);
    $('acctRefresh').addEventListener('click', load);
    $('acctExpandAll').addEventListener('click', () => { collapsed = new Set(); saveCollapsed(window.localStorage, collapsed); renderTree(); });
    $('acctCollapseAll').addEventListener('click', () => {
        collapsed = new Set(flattenTree(view).filter(({ node }) => node.children.length).map(({ node }) => node.key));
        saveCollapsed(window.localStorage, collapsed);
        renderTree();
    });
    $('acctTree').addEventListener('click', (e) => {
        const toggle = e.target.closest('[data-toggle]');
        if (toggle) {
            collapsed = toggleCollapsed(collapsed, toggle.dataset.toggle);
            saveCollapsed(window.localStorage, collapsed);
            renderTree();
            return;
        }
        const sel = e.target.closest('[data-select]');
        if (sel) selectNode(sel.dataset.select);
    });
    load();
})();
