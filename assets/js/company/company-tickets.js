/**
 * company-tickets.js — قسم تذاكر الشركة داخل لوحة الشركة.
 *
 * لا منطق تذاكر جديد هنا إطلاقًا. القسم واجهة فوق نفس الوحدات المشتركة:
 *
 *   tickets-service.js                        القراءة والكتابة (RLS تفرض
 *                                             أن العميل لا يرى إلا تذاكره)
 *   assets/js/customer/ticket-view-model.js   المجموعات والعدّ والإجراءات
 *                                             — دوال خالصة مُختبَرة
 *   assets/js/customer/portal-ui.js           حالات التحميل/الفراغ/الخطأ
 *
 * ليه واجهة منفصلة عن بوابة العميل بدل رابط لها؟ قرار منتج: لوحة الشركة هي
 * اللوحة الرسمية للحساب المرتبط بشركة، فالتنقّل لا يغادرها. المنطق مشترك،
 * التجربة مستقلة.
 */

import { fetchUserTickets, fetchTicketReplies, addTicketReply } from '/tickets-service.js';
import {
    TICKET_VIEWS, statusInfo, applyTicketView, countByView, availableActions
} from '/assets/js/customer/ticket-view-model.js';
import { escapeHtml, formatDate, timeAgo, renderState, renderSkeletonLines }
    from '/assets/js/customer/portal-ui.js';

let userId = null;
let tickets = [];
let activeView = 'all';
let searchTerm = '';
let openTicketId = null;
let container = null;
let goToSupport = null;

/** يُنادى مرة واحدة عند تهيئة اللوحة. */
export function initCompanyTickets(currentUserId, { onNewTicket } = {}) {
    userId = currentUserId;
    container = document.getElementById('companyTickets');
    // «فتح تذكرة جديدة» ينقل إلى قسم الدعم داخل نفس اللوحة، لا إلى صفحة أخرى
    goToSupport = onNewTicket || null;
}

/** تحميل القسم (كسول: أول مرة يُفتح فيها، ثم عند إعادة التحميل صراحةً). */
export async function loadCompanyTickets({ focusTicketId = null, search = null } = {}) {
    if (!container) return;
    if (search !== null) searchTerm = search;
    renderSkeletonLines(container, 4);

    try {
        tickets = (await fetchUserTickets()) || [];
    } catch (err) {
        console.error('[CompanyTickets]', err?.message || err);
        renderState(container, {
            variant: 'error',
            title: 'تعذّر تحميل التذاكر',
            text: 'تحقق من اتصالك ثم أعد المحاولة.',
            action: { label: 'إعادة المحاولة', retry: 'tickets', variant: 'btn-primary' }
        });
        return;
    }

    if (focusTicketId) openTicketId = focusTicketId;
    render();
}

/** فتح تذكرة بعينها (يستدعيها موجّه الإشعارات). */
export async function openCompanyTicket(ticketId) {
    openTicketId = ticketId;
    if (!tickets.length) { await loadCompanyTickets({ focusTicketId: ticketId }); return; }
    render();
    await renderReplies(ticketId);
}

function render() {
    if (!container) return;

    const counts = countByView(tickets, userId);
    const visible = applyTicketView(tickets, { view: activeView, search: searchTerm, userId });

    container.innerHTML = `
        <section class="panel">
            <div class="panel-header">
                <div>
                    <h2 class="panel-title">تذاكر الشركة</h2>
                    <p class="panel-subtitle">كل تذاكر الدعم المفتوحة باسم هذا الحساب</p>
                </div>
                <button type="button" class="panel-link" data-company-action="new-ticket">فتح تذكرة جديدة</button>
            </div>

            <div class="view-tabs" role="tablist">
                ${TICKET_VIEWS.map(view => `
                    <button type="button" role="tab"
                            class="view-tab"
                            aria-selected="${view.key === activeView}"
                            data-company-view="${escapeHtml(view.key)}" title="${escapeHtml(view.hint)}">
                        ${escapeHtml(view.label)}
                        <span class="view-tab-count">${counts[view.key] || 0}</span>
                    </button>`).join('')}
            </div>

            <div class="form-field">
                <label class="visually-hidden" for="companyTicketSearch">ابحث في التذاكر</label>
                <input type="search" id="companyTicketSearch" class="form-control"
                       placeholder="ابحث بالعنوان أو رقم التذكرة…" value="${escapeHtml(searchTerm)}">
            </div>

            <div id="companyTicketList"></div>
        </section>

        <section class="panel" id="companyTicketDetail" ${openTicketId ? '' : 'hidden'}>
            <div id="companyTicketDetailBody"></div>
        </section>`;

    renderList(visible);
    wire();

    if (openTicketId) renderDetail(openTicketId);
}

function renderList(visible) {
    const list = document.getElementById('companyTicketList');
    if (!list) return;

    if (!visible.length) {
        renderState(list, {
            variant: 'empty',
            title: searchTerm ? 'لا توجد تذاكر مطابقة' : 'لا توجد تذاكر في هذه المجموعة',
            text: searchTerm ? 'جرّب كلمة أخرى أو رقم التذكرة.' : 'افتح تذكرة من مركز الدعم عند الحاجة.',
            action: searchTerm ? null : { label: 'فتح تذكرة', act: 'new-ticket', variant: 'btn-primary' }
        });
        return;
    }

    list.innerHTML = `
        <ul class="company-sub-list">
            ${visible.map(ticket => {
                const info = statusInfo(ticket.status);
                const actions = availableActions(ticket, { userId });
                return `
                <li class="company-sub is-clickable" data-company-ticket="${escapeHtml(ticket.id)}" tabindex="0" role="button">
                    <div class="company-sub-main">
                        <p class="company-sub-plan">#${escapeHtml(String(ticket.ticket_number ?? '—'))} — ${escapeHtml(ticket.title || 'بلا عنوان')}</p>
                        <p class="company-sub-dates">${escapeHtml(formatDate(ticket.created_at))} · آخر تحديث ${escapeHtml(timeAgo(ticket.updated_at || ticket.created_at))}</p>
                    </div>
                    <div class="company-sub-side">
                        ${actions.needsReply ? '<span class="pill status-tone-warning">بانتظار ردّك</span>' : ''}
                        <span class="pill ${escapeHtml(info.pill)}">${escapeHtml(info.label)}</span>
                    </div>
                </li>`;
            }).join('')}
        </ul>`;
}

async function renderDetail(ticketId) {
    const ticket = tickets.find(t => t.id === ticketId);
    const panel = document.getElementById('companyTicketDetail');
    const body = document.getElementById('companyTicketDetailBody');
    if (!ticket || !panel || !body) return;

    panel.hidden = false;
    const info = statusInfo(ticket.status);
    const actions = availableActions(ticket, { userId });

    body.innerHTML = `
        <div class="panel-header">
            <div>
                <h2 class="panel-title">#${escapeHtml(String(ticket.ticket_number ?? '—'))} — ${escapeHtml(ticket.title || '')}</h2>
                <p class="panel-subtitle">
                    <span class="pill ${escapeHtml(info.pill)}">${escapeHtml(info.label)}</span>
                    · فُتحت ${escapeHtml(formatDate(ticket.created_at))}
                </p>
            </div>
            <button type="button" class="panel-link" data-company-action="close-ticket">إغلاق التفاصيل</button>
        </div>

        <p class="company-notice">${escapeHtml(ticket.description || '')}</p>

        <div id="companyTicketReplies"></div>

        ${actions.canReply ? `
        <form id="companyReplyForm" class="company-form">
            <div class="form-field is-full">
                <label for="companyReplyText">${actions.canReopen ? 'ردّك (سيعيد فتح التذكرة)' : 'إضافة ردّ'}</label>
                <textarea id="companyReplyText" class="form-control" rows="3" required></textarea>
                <p class="field-error" id="companyReplyError" hidden></p>
            </div>
            <div class="company-form-actions">
                <button type="submit" class="btn btn-primary" id="companyReplyBtn">
                    ${actions.canReopen ? 'إرسال وإعادة الفتح' : 'إرسال الردّ'}
                </button>
            </div>
        </form>` : `
        <p class="panel-subtitle">هذه التذكرة مغلقة ولا تقبل ردودًا جديدة.</p>`}`;

    await renderReplies(ticketId);
    document.getElementById('companyReplyForm')?.addEventListener('submit', (e) => onReply(e, ticketId));
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function renderReplies(ticketId) {
    const box = document.getElementById('companyTicketReplies');
    if (!box) return;
    renderSkeletonLines(box, 2);

    let replies = [];
    try {
        replies = (await fetchTicketReplies(ticketId)) || [];
    } catch (err) {
        console.error('[CompanyTickets] replies:', err?.message || err);
        renderState(box, { variant: 'error', title: 'تعذّر تحميل الردود', text: '' });
        return;
    }

    // الردود الداخلية للفريق محجوبة في القاعدة؛ الفلترة هنا للعرض فقط
    const visible = replies.filter(r => !r.is_internal);

    if (!visible.length) {
        renderState(box, { variant: 'empty', title: 'لا توجد ردود بعد', text: '' });
        return;
    }

    box.innerHTML = `
        <div class="activity-timeline">
            ${visible.map(reply => `
                <div class="activity-item">
                    <div>
                        <div class="activity-text">
                            <strong>${escapeHtml(reply.user_id === userId ? 'أنت' : 'فريق الدعم')}</strong>
                            — ${escapeHtml(reply.message || '')}
                        </div>
                        <div class="activity-time">${escapeHtml(timeAgo(reply.created_at))}</div>
                    </div>
                </div>`).join('')}
        </div>`;
}

async function onReply(event, ticketId) {
    event.preventDefault();
    const input = document.getElementById('companyReplyText');
    const error = document.getElementById('companyReplyError');
    const btn = document.getElementById('companyReplyBtn');
    const message = input.value.trim();

    error.hidden = true;
    if (message.length < 2) {
        error.textContent = 'اكتب ردًّا أولًا';
        error.hidden = false;
        return;
    }

    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'جارٍ الإرسال…';

    try {
        await addTicketReply(ticketId, message);
        input.value = '';
        // الحالة قد تتغيّر بالردّ (إعادة فتح)، فنعيد القراءة من المصدر
        tickets = (await fetchUserTickets()) || [];
        render();
    } catch (err) {
        // الفشل يظل هنا كرسالة — بلا أي تحويل
        error.textContent = err?.message || 'تعذّر إرسال الردّ. حاول مرة أخرى.';
        error.hidden = false;
    } finally {
        btn.disabled = false;
        btn.textContent = original;
    }
}

function wire() {
    document.querySelectorAll('[data-company-view]').forEach(btn => {
        btn.addEventListener('click', () => {
            activeView = btn.getAttribute('data-company-view');
            render();
        });
    });

    const search = document.getElementById('companyTicketSearch');
    search?.addEventListener('input', () => {
        searchTerm = search.value;
        renderList(applyTicketView(tickets, { view: activeView, search: searchTerm, userId }));
        bindRows();
    });

    document.querySelector('[data-company-action="close-ticket"]')?.addEventListener('click', () => {
        openTicketId = null;
        render();
    });

    // الزر في الترويسة وزر حالة الفراغ (data-action من renderState) — كلاهما
    // ينقل إلى قسم الدعم داخل اللوحة
    document.querySelectorAll('[data-company-action="new-ticket"], [data-action="new-ticket"]').forEach(btn => {
        btn.addEventListener('click', () => goToSupport?.());
    });

    bindRows();
}

function bindRows() {
    document.querySelectorAll('[data-company-ticket]').forEach(row => {
        const open = () => {
            openTicketId = row.getAttribute('data-company-ticket');
            render();
        };
        row.addEventListener('click', open);
        row.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
        });
    });
}
