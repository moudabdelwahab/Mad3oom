/**
 * owner/accounts.html — شجرة الحسابات لمالك المنصة.
 *
 * المرحلة 1 (قراءة فقط): المصدر owner_account_tree() (migrations/128):
 * الشجرة كاملة في نداء واحد — وحدات ≤6 وشركاتها وأعضاؤها، وفرع العملاء
 * المباشرين، وشركات بلا وحدة.
 *
 * المرحلة 2: النقل بين آباء الشجرة + التفاصيل الكاملة + تعديل الاسم والجوال.
 * نقل العميل بين شركتين عبر owner_account_transfer() (129، يعيد استخدام
 * _transfer_execute وcustomer_transfers من 101)؛ ونقل الشركة بين وحدتين عبر
 * owner_assign_company_unit() القائم (099)؛ والتفاصيل الكاملة عبر
 * owner_account_details() (129)؛ والتعديل عبر owner_update_account_profile()
 * (129: الاسم والجوال فقط — البريد والرتبة قراءة فقط بلا مسار معتمد).
 * كل كتابة بسبب ≥20 حرفًا للنقل (≥10 للتعديل) ومفتاح منع تكرار، وتتطلب
 * جلسة تحرير (تحقق بخطوتين) قبل الإرسال؛ الرفض الحقيقي في القاعدة.
 * لا إنشاء وحدة ولا تفويض ولا طلبات هنا — كلها في مساراتها القائمة.
 * لا مفاتيح feature تُلمس.
 *
 * لوحة التفاصيل: من ردّ الشجرة نفسه فورًا، ثم تُستكمل — عند النقر فقط — من
 * owner_account_details()؛ فإن رفضته القاعدة (42501) يُجرَّب
 * admin_customer_details() الموجود، ثم تُعرض بيانات الشجرة مع ملاحظة أن
 * التفاصيل الكاملة في دليل العملاء، لا رقم مخترع ولا صفحة فارغة.
 */
import {
    supabase, bootOwnerPage, announce, esc, when, day, num, kpis, errorBlock, loadingBlock, friendlyError, openModal
} from '/assets/js/owner/owner-page.js';
import {
    buildAccountTree, flattenTree, searchTree, applyFilters, defaultCollapsed,
    loadCollapsed, saveCollapsed, toggleCollapsed, TYPE_LABELS, ACCOUNT_TYPE_LABELS,
    PERSON_KIND_LABELS, statusInfo, subscriptionInfo, normalizeSearch,
    TRANSFER_MIN_REASON, validateTransferReason, newIdempotencyKey,
    canTransferPerson, transferTargets, buildTransferPayload, buildFullAccountDetails,
    validateProfileEdit, profileEditRequiresStepUp, READONLY_PROFILE_FIELDS,
    auditActionLabel, auditSourceLabel, usageEventLabel, usageCounterLabel, usageSourceLabel,
    transferStatusLabel, transferInitiatedLabel, accountRequestTypeLabel, accountRequestStatusLabel,
    joinedViaLabel, membershipStatusLabel, managerEndCauseLabel
} from '/assets/js/owner/accounts-tree-model.js';
import { TICKET_STATUS_LABELS, TICKET_STATUS_TONES } from '/assets/js/owner/owner-labels.js';
import { ensureStepUp } from '/assets/js/security/step-up-modal.js';

const $ = (id) => document.getElementById(id);
const MISSING = new Set(['PGRST202', '42883', 'PGRST404']);

let tree = null;
let view = null;
let collapsed = new Set();
let selectedKey = 'root';
let searchTerm = '';
let searchMatches = new Set();
let detailsCache = new Map();
let legacyCache = new Map();

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
        <div class="owner-thread-head"><span title="${esc(e.action || '')}">${esc(auditActionLabel(e.action))}</span><span>${esc(when(e.at))}</span></div>
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
        html += '<p class="panel-subtitle">الجذر «مالك المنصة». اختر عقدة من الشجرة لعرض تفاصيلها. النقل والتعديل متاحان من أزرار تفاصيل العقدة؛ باقي الإجراءات في حوكمة الشركات ومساراتها القائمة.</p>';
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
        html += '<p class="panel-subtitle">إنشاء وحدة أو منح تفويض: في حوكمة الشركات بلوحة المالك، لا من هذه الصفحة. أما نقل شركة إلى وحدة أخرى فمن زر «نقل» في تفاصيل الشركة هنا.</p>';
    } else if (node.type === 'company') {
        html += detailActions(node);
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
        html += detailActions(node);
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
                <div class="owner-thread-head"><span>${esc(m.company_name || '')}</span><span>${esc(membershipStatusLabel(m.status))}${m.is_primary ? ' · أساسية' : ''}</span></div>
                <p class="state-text">انضم ${esc(day(m.joined_at))}${m.joined_via ? ` · ${esc(joinedViaLabel(m.joined_via))}` : ''}${m.ended_at ? ` · انتهت ${esc(day(m.ended_at))}` : ''}</p>
            </li>`).join('')}</ul>`);
        }
        if (d.managerHistory.length) {
            html += detailSection('سجل مديري الحساب', `<ul class="owner-thread">${d.managerHistory.map(h => `<li>
                <div class="owner-thread-head"><span>${esc(h.manager_name || '')}</span><span>${esc(day(h.assigned_at))}</span></div>
                <p class="state-text">أسندها ${esc(h.assigned_by_name || '—')}${h.reason ? ` · ${esc(h.reason)}` : ''}${h.ended_at ? ` · انتهت (${esc(managerEndCauseLabel(h.end_cause))})` : ''}</p>
            </li>`).join('')}</ul>`);
        }
        html += '<div id="acctFullDetail"><p class="panel-subtitle">جارٍ إكمال التفاصيل الكاملة…</p></div>';
        html += '<p class="panel-subtitle"><a href="/admin/customers.html">دليل العملاء في مساحة الإدارة</a></p>';
        box.innerHTML = html;
        loadFullDetail(node);
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

/** أزرار إجراءات العقدة في لوحة التفاصيل: نقل (عميل/شركة) وتعديل (شخص). */
function detailActions(node) {
    const acts = [];
    if (node.type === 'company') {
        acts.push('<button type="button" class="btn btn-outline btn-sm" data-action="transfer">نقل إلى وحدة أخرى</button>');
    }
    if (node.type === 'person') {
        if (canTransferPerson(node)) {
            acts.push('<button type="button" class="btn btn-outline btn-sm" data-action="transfer">نقل إلى شركة أخرى</button>');
        }
        acts.push('<button type="button" class="btn btn-outline btn-sm" data-action="edit-profile">تعديل الاسم والجوال</button>');
    }
    return acts.length ? `<div class="owner-row-actions" style="margin-bottom:12px">${acts.join('')}</div>` : '';
}

/** التفاصيل الكاملة من owner_account_details() (129) عند النقر فقط، مع تخزين مؤقت. */
async function loadFullDetail(node) {
    const slot = $('acctFullDetail');
    if (!slot) return;
    if (detailsCache.has(node.id)) {
        renderFullDetail(slot, detailsCache.get(node.id));
        return;
    }
    let data, error = null;
    try {
        ({ data, error } = await supabase.rpc('owner_account_details', { p_user_id: node.id }));
    } catch (err) {
        error = err;
    }
    if (!error && data) {
        detailsCache.set(node.id, data);
        renderFullDetail(slot, data);
        return;
    }
    loadLegacyDetail(node, slot);
}

/** احتياط المرحلة 1: admin_customer_details() الموجود (105) إن رفضت القاعدة الجديد. */
async function loadLegacyDetail(node, slot) {
    if (node.data.kind === 'unit_member' || node.data.accountType === 'platform_staff') {
        slot.innerHTML = '<p class="panel-subtitle">عضو طاقم: تفاصيله الكاملة في إدارة المستخدمين، لا في دليل العملاء.</p>';
        return;
    }
    if (legacyCache.has(node.id)) {
        renderExtraDetail(slot, legacyCache.get(node.id));
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
    legacyCache.set(node.id, data);
    renderExtraDetail(slot, data);
}

function renderFullDetail(slot, raw) {
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
    slot.innerHTML = html;
}

function renderExtraDetail(slot, data) {
    const history = Array.isArray(data.history) ? data.history : [];
    const requests = Array.isArray(data.requests) ? data.requests : [];
    slot.innerHTML = detailSection('سجل تدقيق الحساب', history.length
        ? `<ul class="owner-thread">${history.slice(0, 20).map(h => `<li>
            <div class="owner-thread-head"><span title="${esc(h.action || '')}">${esc(auditActionLabel(h.action))}${h.company_name ? ` · ${esc(h.company_name)}` : ''}</span><span>${esc(when(h.at))}</span></div>
            <p class="state-text">الفاعل: ${esc(h.actor_name || '—')}${h.source ? ` · المصدر: ${esc(auditSourceLabel(h.source))}` : ''}</p>
        </li>`).join('')}</ul><p class="panel-subtitle">${esc(data.history_note || '')}</p>`
        : '<p class="panel-subtitle">لا أحداث مسجّلة على هذا الحساب.</p>')
        + (requests.length ? detailSection('طلبات الحساب', `<ul class="owner-thread">${requests.map(r => `<li>
            <div class="owner-thread-head"><span>${esc(accountRequestTypeLabel(r.request_type))}</span><span>${esc(accountRequestStatusLabel(r.status))}</span></div>
            <p class="state-text">${esc(r.company_name || '')} · ${esc(when(r.requested_at))}</p>
        </li>`).join('')}</ul>`) : '');
}

/** حوار النقل: وجهة + سبب ≥20 حرفًا + مفتاح منع تكرار يولَّد للحوارة؛ ثم جلسة تحرير، ثم النداء. */
function openTransferDialog(node) {
    const isPerson = node.type === 'person';
    const targets = transferTargets(tree, node);
    const key = newIdempotencyKey();
    const { body, close } = openModal({
        title: isPerson ? `نقل «${node.name}» إلى شركة أخرى` : `نقل «${node.name}» إلى وحدة أخرى`,
        wide: true
    });
    const options = isPerson
        ? targets.options.map(o => `<option value="${esc(o.id)}">${esc(o.name)} — ${esc(o.unitName)}</option>`).join('')
        : targets.options.map(o => `<option value="${esc(o.id)}">${esc('— '.repeat(o.depth || 0) + o.name)}</option>`).join('')
            + (targets.canUnassign ? '<option value="">بلا وحدة (إنهاء الإسناد)</option>' : '');
    body.innerHTML = `
        <form id="acctTransferForm" novalidate>
            <p class="state-text">${isPerson
                ? `ينقل عضوية «${esc(node.name)}» الأساسية من شركته الحالية إلى شركة الوجهة.`
                : `ينقل الشركة إلى وحدة أخرى؛ إسنادها الحالي يُنهى ويبقى في السجل. لا يمنح النقل أي وصول لبيانات الشركة.`}</p>
            <label for="acctTransferTarget">${isPerson ? 'شركة الوجهة' : 'الوحدة الوجهة'}</label>
            <select class="form-control" id="acctTransferTarget" required>${options}</select>
            ${isPerson ? '<label class="acct-check"><input type="checkbox" id="acctTransferKeep"> إبقاء الشركة الحالية عضوية إضافية بعد النقل</label>' : ''}
            <label for="acctTransferReason">سبب النقل (إجباري، ${TRANSFER_MIN_REASON} حرفًا على الأقل — يُسجَّل في التدقيق)</label>
            <textarea class="form-control" id="acctTransferReason" rows="3" maxlength="500" required></textarea>
            <p class="panel-subtitle"><span id="acctTransferCount">0</span> / ${TRANSFER_MIN_REASON} حرفًا على الأقل.</p>
            <p class="panel-subtitle">يتطلب النقل جلسة تحرير (تحقق بخطوتين) — تُفتح نافذته عند التأكيد إن لم تكن سارية. مفتاح منع التكرار لهذا الحوار: <span dir="ltr">${esc(key)}</span>.</p>
            <p class="state-text" id="acctTransferError" role="alert" style="color: var(--color-danger, #c0392b)" hidden></p>
            <div class="owner-row-actions">
                <button type="submit" class="btn btn-primary" id="acctTransferSubmit">تأكيد النقل</button>
                <button type="button" class="btn btn-outline" data-transfer-cancel>إلغاء</button>
            </div>
        </form>`;
    const form = body.querySelector('#acctTransferForm');
    const reasonEl = body.querySelector('#acctTransferReason');
    const countEl = body.querySelector('#acctTransferCount');
    const errorEl = body.querySelector('#acctTransferError');
    const showError = (msg) => { errorEl.textContent = msg; errorEl.hidden = false; };
    reasonEl.addEventListener('input', () => { countEl.textContent = String(reasonEl.value.trim().length); });
    body.querySelector('[data-transfer-cancel]').addEventListener('click', close);
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        errorEl.hidden = true;
        const reasonCheck = validateTransferReason(reasonEl.value);
        if (!reasonCheck.ok) { showError(reasonCheck.error); return; }
        const payload = buildTransferPayload({
            node, tree,
            targetId: body.querySelector('#acctTransferTarget').value || null,
            reason: reasonCheck.reason,
            keepSourceSecondary: body.querySelector('#acctTransferKeep')?.checked === true,
            idempotencyKey: key
        });
        if (!payload.ok) { showError(payload.error); return; }
        const submit = body.querySelector('#acctTransferSubmit');
        submit.disabled = true;
        try {
            const ok = await ensureStepUp({ reason: 'نقل حساب — عملية حرجة تتطلب تحققًا بخطوتين.' });
            if (!ok) { showError('أُلغي التحقق بخطوتين — لم يُنفَّذ النقل.'); return; }
            const { data, error } = await supabase.rpc(payload.rpc, payload.args);
            if (error) { showError(friendlyError(error)); return; }
            close();
            say(data?.replayed ? 'هذا النقل نُفّذ سابقًا بهذا المفتاح — لم يتكرر.' : 'تم النقل وسُجِّل في التدقيق.', 'success');
            await load();
        } catch (err) {
            showError(friendlyError(err));
        } finally {
            submit.disabled = false;
        }
    });
}

/** حوار تعديل الاسم والجوال: البريد والرتبة قراءة فقط مع سبب المنع. */
function openEditDialog(node) {
    const d = node.data || {};
    const current = { full_name: node.name, phone: d.phone || null };
    const needsStepUp = profileEditRequiresStepUp(d.role);
    const { body, close } = openModal({ title: `تعديل بيانات «${node.name}»`, wide: true });
    body.innerHTML = `
        <form id="acctEditForm" novalidate>
            <p class="state-text">الحقول الآمنة فقط: الاسم الكامل والجوال. يُسجَّل التعديل بسبب في التدقيق.</p>
            <label for="acctEditName">الاسم الكامل</label>
            <input class="form-control" id="acctEditName" type="text" maxlength="120" value="${esc(current.full_name || '')}" dir="auto">
            <label for="acctEditPhone">الجوال (اتركه فارغًا لمسحه)</label>
            <input class="form-control" id="acctEditPhone" type="tel" maxlength="30" value="${esc(current.phone || '')}" dir="ltr">
            <dl class="owner-detail-grid">
                <div><dt>البريد</dt><dd><span dir="ltr">${esc(d.email || '—')}</span><br><span class="panel-subtitle">${esc(READONLY_PROFILE_FIELDS.email)}</span></dd></div>
                ${d.kind !== 'unit_member' ? `<div><dt>الرتبة</dt><dd>${esc(d.role || '—')}<br><span class="panel-subtitle">${esc(READONLY_PROFILE_FIELDS.role)}</span></dd></div>` : ''}
            </dl>
            <label for="acctEditReason">سبب التعديل (إجباري، 10 أحرف على الأقل — يُسجَّل في التدقيق)</label>
            <textarea class="form-control" id="acctEditReason" rows="2" maxlength="500" required></textarea>
            ${needsStepUp ? '<p class="panel-subtitle">حساب حسّاس (طاقم المنصة): يتطلب جلسة تحرير (تحقق بخطوتين) عند التأكيد.</p>' : ''}
            <p class="state-text" id="acctEditError" role="alert" style="color: var(--color-danger, #c0392b)" hidden></p>
            <div class="owner-row-actions">
                <button type="submit" class="btn btn-primary" id="acctEditSubmit">حفظ التعديل</button>
                <button type="button" class="btn btn-outline" data-edit-cancel>إلغاء</button>
            </div>
        </form>`;
    const form = body.querySelector('#acctEditForm');
    const errorEl = body.querySelector('#acctEditError');
    const showError = (msg) => { errorEl.textContent = msg; errorEl.hidden = false; };
    body.querySelector('[data-edit-cancel]').addEventListener('click', close);
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        errorEl.hidden = true;
        const check = validateProfileEdit({
            fullName: body.querySelector('#acctEditName').value,
            phone: body.querySelector('#acctEditPhone').value,
            current
        });
        if (!check.ok) { showError(check.errors.join(' ')); return; }
        if (check.noop) { close(); say('لا تغيير للحفظ — القيم كما هي.', 'info'); return; }
        const reason = body.querySelector('#acctEditReason').value.trim();
        if (reason.length < 10) { showError('سبب التعديل مطلوب (10 أحرف على الأقل).'); return; }
        const submit = body.querySelector('#acctEditSubmit');
        submit.disabled = true;
        try {
            const ok = await ensureStepUp({ reason: 'تعديل بيانات حساب — عملية تتطلب تحققًا بخطوتين.' });
            if (!ok) { showError('أُلغي التحقق بخطوتين — لم يُحفظ التعديل.'); return; }
            const { data, error } = await supabase.rpc('owner_update_account_profile', {
                p_user_id: node.id,
                p_full_name: 'full_name' in check.changes ? check.changes.full_name : null,
                p_phone: 'phone' in check.changes ? (check.changes.phone ?? '') : null,
                p_reason: reason
            });
            if (error) { showError(friendlyError(error)); return; }
            close();
            if (data?.changed === false) say('لا تغيير للحفظ — القيم كما هي.', 'info');
            else { say('تم حفظ التعديل وسُجِّل في التدقيق.', 'success'); await load(); }
        } catch (err) {
            showError(friendlyError(err));
        } finally {
            submit.disabled = false;
        }
    });
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
    legacyCache = new Map();
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
    // رابط عميق من صفحة المتاجر: ?id=<company_id|user_id> — يوسّع أسلاف العقدة ويختارها.
    // flattenTree يعيد path كمفاتيح (strings) تشمل العقدة نفسها.
    const deepId = new URLSearchParams(location.search).get('id');
    if (deepId) {
        const entry = flattenTree(tree).find(({ node }) => node.key === `company:${deepId}` || node.key === `person:${deepId}`);
        if (entry) {
            for (const key of entry.path || []) collapsed.delete(key);
            selectNode(entry.node.key);
        }
    }
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
    $('acctDetail').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const node = findNode(selectedKey);
        if (!node) return;
        if (btn.dataset.action === 'transfer') openTransferDialog(node);
        if (btn.dataset.action === 'edit-profile') openEditDialog(node);
    });
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
