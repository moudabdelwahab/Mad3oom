/**
 * company-customer-history.js — سجل العميل داخل لوحة الشركة (migrations/146).
 *
 * نداء واحد فقط: company_customer_history(p_customer_id) — الحزمة كاملة
 * (عميل + تذاكر + ردود + محادثات الشركة + نقل + اشتراكات)، أو null حين لا
 * وصول / العميل ليس عميلًا نشطًا لشركتك. الربط بمعرّف العميل وحده: لا
 * مطابقة واتساب برقم الهاتف إطلاقًا (تتسرب عبر الشركات).
 *
 * هذا سجل داخلي للشركة، وليس طلب الاطلاع التاريخي (101) داخل قسم العملاء:
 * ذاك عبور بين الشركات بموافقة العميل، وهذا عرض لما هو في شركتك أصلًا.
 *
 * التركيب من الموجود: قائمة العملاء من fetchCompanyCustomers (096) مع
 * عدّادات تذاكر من مسار customerTickets عبر byCustomer، ووصف النقل من
 * transferRowInfo في company-moves.js. كل الروابط داخل اللوحة
 * (#customerTickets و #inbox عبر data-tab) — لا رابط لأي لوحة أخرى.
 */
import { fetchCompanyCustomers, fetchCustomerHistory } from '/assets/js/company/company-data.js';
import {
    summarizeCustomerHistory, groupRepliesByTicket, messagesOfConversation,
    customerHistorySections, subscriptionLabel
} from '/assets/js/company/company-customer-history-model.js';
import { byCustomer } from '/assets/js/company/report-model.js';
import { transferRowInfo } from '/assets/js/company/company-moves.js';
import { escapeHtml, formatDate, timeAgo, renderState, renderSkeletonLines } from '/assets/js/customer/portal-ui.js';
import { ui } from '/ui-service.js';

let deps = { getCustomerRows: () => [], onOpenTicket: null };
let wired = false;
let boxEl = null;
let bodyEl = null;

let customers = null; // قائمة عملاء الشركة (096) — null قبل القراءة
let customersQuery = '';
let selectedId = null;
let bundle = null;
let openConversationId = null;

export function initCompanyCustomerHistory(nextDeps) {
    deps = { ...deps, ...nextDeps };
}

/** يُحمَّل عند أول فتح لسجل العميل فقط (LOADERS)؛ يرجّع false حين يفشل فيُعاد تحميله. */
export async function loadCompanyCustomerHistory() {
    const box = document.getElementById('companyCustomerHistory');
    if (!box) return false;
    if (!wired) wired = wire(box);
    if (!wired) return false;

    if (customers === null) {
        renderSkeletonLines(bodyEl, 4);
        const res = await fetchCompanyCustomers();
        if (!res.ok) {
            renderState(bodyEl, {
                variant: 'error', title: 'تعذّر تحميل عملاء الشركة',
                text: res.error || 'تحقق من اتصالك ثم أعد المحاولة.',
                action: { label: 'إعادة المحاولة', retry: 'customerHistory', variant: 'btn-primary' }
            });
            return false;
        }
        customers = Array.isArray(res.data?.customers) ? res.data.customers : (Array.isArray(res.data) ? res.data : []);
        if (!res.data) {
            renderState(bodyEl, {
                variant: 'empty', title: 'قائمة العملاء غير متاحة لحسابك',
                text: 'سجل العميل يظهر لمدير الشركة والمشرف. إن كنت من الفريق وتحتاجه، اطلب صلاحية customers.view.'
            });
            return true;
        }
    }
    renderPicker();
    return true;
}

function wire(box) {
    boxEl = box;
    boxEl.innerHTML = `
        <p class="panel-subtitle">سجل داخلي لعملاء شركتك — تذاكرهم وردودهم ومحادثاتهم ونقلهم واشتراكاتهم.
            ليس طلب الاطلاع التاريخي بين الشركات (ذاك في قسم العملاء، بموافقة العميل).</p>
        <div class="form-field">
            <label class="visually-hidden" for="companyHistorySearch">ابحث عن عميل</label>
            <input type="search" id="companyHistorySearch" class="form-control"
                   placeholder="ابحث عن عميل بالاسم أو البريد…" value="${escapeHtml(customersQuery)}">
        </div>
        <div id="companyHistoryBody"></div>`;
    bodyEl = boxEl.querySelector('#companyHistoryBody');
    boxEl.querySelector('#companyHistorySearch').addEventListener('input', (event) => {
        customersQuery = event.target.value;
        renderPicker();
    });
    boxEl.addEventListener('click', onClick);
    return true;
}

function ticketCounts() {
    const map = new Map();
    for (const entry of byCustomer(deps.getCustomerRows?.() || [])) {
        map.set(entry.id, entry);
    }
    return map;
}

function renderPicker() {
    const q = customersQuery.trim().toLowerCase();
    const counts = ticketCounts();
    const list = (customers || []).filter(c => {
        if (!q) return true;
        return String(c.name || '').toLowerCase().includes(q)
            || String(c.email || '').toLowerCase().includes(q);
    });
    const picker = list.length ? `
        <ul class="company-sub-list">${list.slice(0, 50).map(c => {
            const count = counts.get(c.id);
            return `
            <li class="company-sub is-clickable" data-history-customer="${escapeHtml(c.id)}" tabindex="0" role="button">
                <div class="company-sub-main">
                    <p class="company-sub-plan">${escapeHtml(c.name || c.email || 'عميل')}</p>
                    <p class="company-sub-dates">${escapeHtml(c.email || '')}${c.phone ? ` · ${escapeHtml(c.phone)}` : ''}${c.joined_at || c.created_at ? ` · انضم ${escapeHtml(formatDate(c.joined_at || c.created_at))}` : ''}</p>
                </div>
                <div class="company-sub-side">
                    ${count ? `<span class="pill">${escapeHtml(String(count.total))} تذكرة · ${escapeHtml(String(count.open))} مفتوحة</span>` : ''}
                </div>
            </li>`;
        }).join('')}</ul>
        ${list.length > 50 ? `<p class="panel-subtitle">أول 50 نتيجة — ضيّق البحث لترى الباقي.</p>` : ''}`
        : `<p class="panel-subtitle">${(customers || []).length ? 'لا عملاء يطابقون هذا البحث.' : 'لا يوجد عملاء في شركتك بعد.'}</p>`;
    // إبقاء الحزمة المعروضة تحت المنتقي عند إعادة الرسم من البحث
    bodyEl.innerHTML = picker + (bundle ? `<hr>${bundleHtml()}` : '');
}

async function openCustomer(id) {
    selectedId = id;
    openConversationId = null;
    renderSkeletonLines(bodyEl, 4);
    const res = await fetchCustomerHistory(id);
    if (!res.ok) {
        renderState(bodyEl, {
            variant: 'error', title: 'تعذّر تحميل سجل العميل',
            text: res.error || 'تحقق من اتصالك ثم أعد المحاولة.',
            action: { label: 'إعادة المحاولة', retry: 'customerHistory', variant: 'btn-primary' }
        });
        return;
    }
    if (!res.data) {
        bundle = null;
        renderState(bodyEl, {
            variant: 'empty', title: 'لا يمكن عرض سجل هذا العميل',
            text: 'إما أنه ليس عميلًا نشطًا في شركتك، أو لا تملك صلاحية عرض سجلات العملاء.'
        });
        return;
    }
    bundle = res.data;
    renderPicker();
    bodyEl.querySelector('[data-history-bundle]')?.scrollIntoView?.();
}

function ticketNumber(t) {
    return t?.ticket_number != null ? `#${t.ticket_number}` : '';
}

function bundleHtml() {
    const s = summarizeCustomerHistory(bundle);
    if (!s || !s.customer) return '';
    const c = s.customer;
    const groups = groupRepliesByTicket(bundle);
    const sections = customerHistorySections(bundle);
    return `
    <div data-history-bundle>
        <h3 class="panel-title">${escapeHtml(c.name || 'عميل')}</h3>
        <p class="panel-subtitle">${escapeHtml(c.email || '')}${c.phone ? ` · ${escapeHtml(c.phone)}` : ''}
            ${c.joined_at ? ` · عميل منذ ${escapeHtml(formatDate(c.joined_at))}` : ''}</p>
        <p class="panel-subtitle">${sections.map(x => `${escapeHtml(x.label)}: ${escapeHtml(String(x.count))}`).join(' · ')}</p>

        <h4 class="panel-title">التذاكر</h4>
        ${(bundle.tickets || []).length ? `<ul class="company-sub-list">${bundle.tickets.map(t => `
            <li class="company-sub is-clickable" data-history-ticket="${escapeHtml(t.id)}" tabindex="0" role="button">
                <div class="company-sub-main">
                    <p class="company-sub-plan">${escapeHtml(ticketNumber(t))} — ${escapeHtml(t.title || '—')}</p>
                    <p class="company-sub-dates">${escapeHtml(t.status || '')} · أولوية ${escapeHtml(String(t.priority ?? '—'))}
                        ${t.category ? ` · ${escapeHtml(t.category)}` : ''} · ${escapeHtml(timeAgo(t.created_at))}</p>
                </div>
                <div class="company-sub-side"><span class="panel-link">فتح في تذاكر العملاء</span></div>
            </li>`).join('')}</ul>`
            : '<p class="panel-subtitle">لا تذاكر لهذا العميل داخل الشركة.</p>'}
        <p><a class="panel-link" href="/company-dashboard/#customerTickets" data-tab="customerTickets">كل تذاكر العملاء</a></p>

        <h4 class="panel-title">الردود</h4>
        ${groups.length ? groups.map(g => `
            <p class="panel-subtitle">${g.ticket ? `${escapeHtml(ticketNumber(g.ticket))} — ${escapeHtml(g.ticket.title || '')}` : 'تذاكر أقدم'}</p>
            <ul class="company-sub-list">${g.replies.map(r => `
                <li class="company-sub"><div class="company-sub-main">
                    <p class="company-sub-plan">${escapeHtml(r.message || '')}</p>
                    <p class="company-sub-dates">${r.is_internal ? 'ملاحظة داخلية' : 'رد'} · ${escapeHtml(formatDate(r.created_at))}</p>
                </div></li>`).join('')}</ul>`).join('')
            : '<p class="panel-subtitle">لا ردود بعد.</p>'}

        <h4 class="panel-title">المحادثات</h4>
        ${(bundle.conversations || []).length ? `<ul class="company-sub-list">${bundle.conversations.map(conv => {
            const open = openConversationId === conv.id;
            const msgs = open ? messagesOfConversation(bundle, conv.id) : [];
            return `
            <li class="company-sub">
                <div class="company-sub-main">
                    <p class="company-sub-plan">${escapeHtml(conv.subject || 'محادثة')}</p>
                    <p class="company-sub-dates">${escapeHtml(conv.status || '')} · آخر رسالة ${escapeHtml(timeAgo(conv.last_message_at))}</p>
                    ${open ? `<ul class="company-sub-list">${msgs.map(m => `
                        <li class="company-sub"><div class="company-sub-main">
                            <p class="company-sub-plan">${escapeHtml(m.body || '')}</p>
                            <p class="company-sub-dates">${m.sender_kind === 'customer' ? 'العميل' : 'الفريق'}${m.is_internal ? ' · داخلية' : ''} · ${escapeHtml(formatDate(m.created_at))}</p>
                        </div></li>`).join('')}</ul>` : ''}
                </div>
                <div class="company-sub-side">
                    <button type="button" class="btn btn-secondary btn-sm" data-history-conversation="${escapeHtml(conv.id)}">${open ? 'إخفاء الرسائل' : 'عرض الرسائل'}</button>
                    <a class="panel-link" href="/company-dashboard/#inbox" data-tab="inbox">فتح في الصندوق</a>
                </div>
            </li>`;
        }).join('')}</ul>`
            : '<p class="panel-subtitle">لا محادثات صندوق لهذا العميل.</p>'}

        <h4 class="panel-title">النقل بين الشركات</h4>
        ${(bundle.moves || []).length ? `<ul class="company-sub-list">${bundle.moves.map(m => {
            const info = transferRowInfo(m);
            return `
            <li class="company-sub"><div class="company-sub-main">
                <p class="company-sub-plan">${escapeHtml(info.text)}</p>
                <p class="company-sub-dates">${escapeHtml(info.status)} · ${escapeHtml(formatDate(m.created_at))}</p>
            </div></li>`;
        }).join('')}</ul>`
            : '<p class="panel-subtitle">لا طلبات نقل لهذا العميل.</p>'}

        <h4 class="panel-title">الاشتراكات</h4>
        ${(bundle.subscriptions || []).length ? `<ul class="company-sub-list">${bundle.subscriptions.map(sub => `
            <li class="company-sub"><div class="company-sub-main">
                <p class="company-sub-plan">${escapeHtml(subscriptionLabel(sub))}</p>
                <p class="company-sub-dates">${escapeHtml(sub.status || '')}
                    ${sub.start_date ? ` · من ${escapeHtml(formatDate(sub.start_date))}` : ''}
                    ${sub.end_date ? ` · إلى ${escapeHtml(formatDate(sub.end_date))}` : ''}</p>
            </div></li>`).join('')}</ul>`
            : '<p class="panel-subtitle">لا اشتراكات لهذا العميل.</p>'}
    </div>`;
}

function onClick(event) {
    const customer = event.target.closest('[data-history-customer]');
    if (customer) { openCustomer(customer.getAttribute('data-history-customer')); return; }
    const ticket = event.target.closest('[data-history-ticket]');
    if (ticket) {
        const id = ticket.getAttribute('data-history-ticket');
        if (deps.onOpenTicket) deps.onOpenTicket(id);
        return;
    }
    const conv = event.target.closest('[data-history-conversation]');
    if (conv) {
        openConversationId = openConversationId === conv.getAttribute('data-history-conversation')
            ? null : conv.getAttribute('data-history-conversation');
        renderPicker();
    }
}
