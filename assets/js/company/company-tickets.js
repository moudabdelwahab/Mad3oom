/**
 * company-tickets.js — مسارا التذاكر في لوحة الشركة.
 *
 * مساران مستقلان لا يختلطان:
 *
 *   ① «تذاكري مع مدعوم»  الشركة ↔ مدعوم
 *      tickets.user_id = حساب الشركة نفسه. الشركة تفتح وتتابع وتردّ.
 *      لا يراها عملاء الشركة إطلاقًا.
 *
 *   ② «تذاكر العملاء»     العميل ↔ الشركة
 *      tickets.user_id ∈ المستخدمين التابعين لهذا الحساب. الشركة تقرأ وتردّ
 *      ولا تفتح (التذكرة يفتحها عميلها).
 *
 * الفصل ليس تصفية واجهة: كل صف في كل مسار مقيَّد في القاعدة بـ
 * tickets_select_policy (وتُثبّته tests/sql/company-customer-tickets.test.sql).
 * الواجهة ترسم ما تسمح به القاعدة، ولا تتّكل على إخفاء.
 *
 * المسارَان يشتركان في **نفس** كود العرض عبر المصنع أدناه — لا نسختين من
 * منطق التذاكر — والاختلاف بينهما بيانات: مصدر القراءة، والنصوص، وهل
 * يُسمح بفتح تذكرة جديدة.
 *
 * وكلاهما فوق الوحدات المشتركة القائمة:
 *   tickets-service.js                        القراءة والردّ
 *   assets/js/customer/ticket-view-model.js   المجموعات والعدّ والإجراءات
 *   assets/js/customer/portal-ui.js           حالات التحميل/الفراغ/الخطأ
 */

import { fetchUserTickets, fetchMemberTickets, fetchTicketReplies, addTicketReply }
    from '/tickets-service.js';
import {
    TICKET_VIEWS, statusInfo, applyTicketView, countByView, availableActions
} from '/assets/js/customer/ticket-view-model.js';
import { escapeHtml, formatDate, timeAgo, renderState, renderSkeletonLines }
    from '/assets/js/customer/portal-ui.js';

/**
 * تعريف كل مسار. الفارق الحقيقي بين المسارين هو `load` — مصدر الصفوف —
 * وباقي الحقول نصوص وسلوك عرض.
 */
export const TICKET_STREAMS = Object.freeze({
    platform: {
        key: 'platform',
        containerId: 'companyTickets',
        title: 'تذاكري مع مدعوم',
        subtitle: 'التذاكر التي فتحتها شركتك لدى فريق مدعوم',
        emptyTitle: 'لا توجد تذاكر مع مدعوم',
        emptyText: 'افتح تذكرة من مركز الدعم عند الحاجة.',
        canCreate: true,
        // ردّي هنا ردّ صاحب التذكرة: محفّز القاعدة يعيد فتحها إن كانت محلولة
        autoTransition: true,
        showsCustomer: false,
        load: fetchUserTickets
    },
    customers: {
        key: 'customers',
        containerId: 'companyCustomerTickets',
        title: 'تذاكر العملاء',
        subtitle: 'التذاكر التي فتحها مستخدمو شركتك — تقرؤها وتردّ عليها',
        emptyTitle: 'لا توجد تذاكر من عملائك',
        emptyText: 'ستظهر هنا التذاكر التي يفتحها المستخدمون التابعون لشركتك.',
        canCreate: false,
        // الشركة لا تملك UPDATE على تذكرة عميلها عمدًا (منحه كان سيسمح
        // بتغيير user_id وتحويل مسار التذكرة)، فلا نحاول تغيير الحالة.
        autoTransition: false,
        // اسم العميل يظهر في القائمة: بدونه المسار غير مفهوم
        showsCustomer: true,
        load: fetchMemberTickets
    }
});

/**
 * ينشئ قسم تذاكر لمسار واحد. الحالة محصورة داخل المصنع، فالمساران لا
 * يتشاركان أي متغيّر — وده اللي بيمنع اختلاطهما في الواجهة.
 */
export function createTicketStream(stream, { userId, onNewTicket } = {}) {
    const spec = TICKET_STREAMS[stream];
    if (!spec) throw new Error(`مسار تذاكر غير معروف: ${stream}`);

    let tickets = [];
    let activeView = 'all';
    let searchTerm = '';
    let openTicketId = null;

    const el = (id) => document.getElementById(id);
    const container = () => el(spec.containerId);
    const uid = (suffix) => `${spec.key}Ticket${suffix}`;

    async function load({ focusTicketId = null, search = null } = {}) {
        const box = container();
        if (!box) return;
        if (search !== null) searchTerm = search;
        renderSkeletonLines(box, 4);

        try {
            tickets = (await spec.load()) || [];
        } catch (err) {
            console.error(`[CompanyTickets:${spec.key}]`, err?.message || err);
            renderState(box, {
                variant: 'error',
                title: 'تعذّر تحميل التذاكر',
                text: 'تحقق من اتصالك ثم أعد المحاولة.',
                action: { label: 'إعادة المحاولة', retry: spec.key, variant: 'btn-primary' }
            });
            return;
        }

        if (focusTicketId) openTicketId = focusTicketId;
        render();
    }

    /** فتح تذكرة بعينها — يستدعيها موجّه الإشعارات. */
    async function open(ticketId) {
        openTicketId = ticketId;
        if (!tickets.length) { await load({ focusTicketId: ticketId }); return; }
        render();
    }

    /** هل هذه التذكرة ضمن هذا المسار؟ يمنع فتح تذكرة مسار في قسم الآخر. */
    function has(ticketId) {
        return tickets.some(t => String(t.id) === String(ticketId));
    }

    function render() {
        const box = container();
        if (!box) return;

        const counts = countByView(tickets, userId);
        const visible = applyTicketView(tickets, { view: activeView, search: searchTerm, userId });

        box.innerHTML = `
            <section class="panel">
                <div class="panel-header">
                    <div>
                        <h2 class="panel-title">${escapeHtml(spec.title)}</h2>
                        <p class="panel-subtitle">${escapeHtml(spec.subtitle)}</p>
                    </div>
                    ${spec.canCreate
                        ? '<button type="button" class="panel-link" data-stream-action="new">فتح تذكرة جديدة</button>'
                        : ''}
                </div>

                <div class="view-tabs" role="tablist">
                    ${TICKET_VIEWS.map(view => `
                        <button type="button" role="tab" class="view-tab"
                                aria-selected="${view.key === activeView}"
                                data-stream-view="${escapeHtml(view.key)}" title="${escapeHtml(view.hint)}">
                            ${escapeHtml(view.label)}
                            <span class="view-tab-count">${counts[view.key] || 0}</span>
                        </button>`).join('')}
                </div>

                <div class="form-field">
                    <label class="visually-hidden" for="${uid('Search')}">ابحث في التذاكر</label>
                    <input type="search" id="${uid('Search')}" class="form-control"
                           placeholder="ابحث بالعنوان أو رقم التذكرة…" value="${escapeHtml(searchTerm)}">
                </div>

                <div id="${uid('List')}"></div>
            </section>

            <section class="panel" id="${uid('Detail')}" ${openTicketId ? '' : 'hidden'}>
                <div id="${uid('DetailBody')}"></div>
            </section>`;

        renderList(visible);
        wire();
        if (openTicketId) renderDetail(openTicketId);
    }

    function renderList(visible) {
        const list = el(uid('List'));
        if (!list) return;

        if (!visible.length) {
            renderState(list, {
                variant: 'empty',
                title: searchTerm ? 'لا توجد تذاكر مطابقة' : spec.emptyTitle,
                text: searchTerm ? 'جرّب كلمة أخرى أو رقم التذكرة.' : spec.emptyText,
                action: (!searchTerm && spec.canCreate)
                    ? { label: 'فتح تذكرة', act: 'new-ticket', variant: 'btn-primary' }
                    : null
            });
            return;
        }

        list.innerHTML = `
            <ul class="company-sub-list">
                ${visible.map(ticket => {
                    const info = statusInfo(ticket.status);
                    const actions = availableActions(ticket, { userId });
                    const customer = spec.showsCustomer
                        ? (ticket.profiles?.full_name || ticket.profiles?.email || 'عميل')
                        : null;
                    return `
                    <li class="company-sub is-clickable" data-stream-ticket="${escapeHtml(ticket.id)}" tabindex="0" role="button">
                        <div class="company-sub-main">
                            <p class="company-sub-plan">#${escapeHtml(String(ticket.ticket_number ?? '—'))} — ${escapeHtml(ticket.title || 'بلا عنوان')}</p>
                            <p class="company-sub-dates">
                                ${customer ? `${escapeHtml(customer)} · ` : ''}${escapeHtml(formatDate(ticket.created_at))}
                                · آخر تحديث ${escapeHtml(timeAgo(ticket.last_updated_at || ticket.created_at))}
                            </p>
                        </div>
                        <div class="company-sub-side">
                            ${(spec.canCreate && actions.needsReply)
                                ? '<span class="pill status-tone-warning">بانتظار ردّك</span>' : ''}
                            <span class="pill ${escapeHtml(info.pill)}">${escapeHtml(info.label)}</span>
                        </div>
                    </li>`;
                }).join('')}
            </ul>`;
    }

    async function renderDetail(ticketId) {
        const ticket = tickets.find(t => String(t.id) === String(ticketId));
        const panel = el(uid('Detail'));
        const body = el(uid('DetailBody'));
        if (!ticket || !panel || !body) return;

        panel.hidden = false;
        const info = statusInfo(ticket.status);
        const actions = availableActions(ticket, { userId });

        // في مسار العملاء الشركة هي الجهة المجيبة، فالردّ متاح ما دامت
        // التذكرة غير مغلقة — ولا يوجد «إعادة فتح» لأن ذلك حقّ صاحب التذكرة.
        const canReply = spec.canCreate ? actions.canReply : !info.closed;
        const customer = spec.showsCustomer
            ? (ticket.profiles?.full_name || ticket.profiles?.email || 'عميل')
            : null;

        body.innerHTML = `
            <div class="panel-header">
                <div>
                    <h2 class="panel-title">#${escapeHtml(String(ticket.ticket_number ?? '—'))} — ${escapeHtml(ticket.title || '')}</h2>
                    <p class="panel-subtitle">
                        <span class="pill ${escapeHtml(info.pill)}">${escapeHtml(info.label)}</span>
                        ${customer ? ` · العميل: ${escapeHtml(customer)}` : ''}
                        · فُتحت ${escapeHtml(formatDate(ticket.created_at))}
                    </p>
                </div>
                <button type="button" class="panel-link" data-stream-action="close">إغلاق التفاصيل</button>
            </div>

            <p class="company-notice">${escapeHtml(ticket.description || '')}</p>

            <div id="${uid('Replies')}"></div>

            ${canReply ? `
            <form id="${uid('ReplyForm')}" class="company-form">
                <div class="form-field is-full">
                    <label for="${uid('ReplyText')}">${
                        spec.canCreate
                            ? (actions.canReopen ? 'ردّك (سيعيد فتح التذكرة)' : 'إضافة ردّ')
                            : 'الردّ على العميل'
                    }</label>
                    <textarea id="${uid('ReplyText')}" class="form-control" rows="3" required></textarea>
                    <p class="field-error" id="${uid('ReplyError')}" hidden></p>
                </div>
                <div class="company-form-actions">
                    <button type="submit" class="btn btn-primary" id="${uid('ReplyBtn')}">${
                        spec.canCreate && actions.canReopen ? 'إرسال وإعادة الفتح' : 'إرسال الردّ'
                    }</button>
                </div>
            </form>` : `
            <p class="panel-subtitle">هذه التذكرة مغلقة ولا تقبل ردودًا جديدة.</p>`}`;

        await renderReplies(ticketId);
        el(uid('ReplyForm'))?.addEventListener('submit', (e) => onReply(e, ticketId));
        panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    async function renderReplies(ticketId) {
        const box = el(uid('Replies'));
        if (!box) return;
        renderSkeletonLines(box, 2);

        let replies = [];
        try {
            replies = (await fetchTicketReplies(ticketId)) || [];
        } catch (err) {
            console.error(`[CompanyTickets:${spec.key}] replies:`, err?.message || err);
            renderState(box, { variant: 'error', title: 'تعذّر تحميل الردود', text: '' });
            return;
        }

        // الردود الداخلية محجوبة في القاعدة (الترحيل 033) — الفلترة هنا
        // احتياط عرض لا حماية.
        const visible = replies.filter(r => !r.is_internal);

        if (!visible.length) {
            renderState(box, { variant: 'empty', title: 'لا توجد ردود بعد', text: '' });
            return;
        }

        const ticket = tickets.find(t => String(t.id) === String(ticketId));
        box.innerHTML = `
            <div class="activity-timeline">
                ${visible.map(reply => `
                    <div class="activity-item">
                        <div>
                            <div class="activity-text">
                                <strong>${escapeHtml(authorLabel(reply, ticket))}</strong>
                                — ${escapeHtml(reply.message || '')}
                            </div>
                            <div class="activity-time">${escapeHtml(timeAgo(reply.created_at))}</div>
                        </div>
                    </div>`).join('')}
            </div>`;
    }

    /** من كتب الردّ، بمنطق المسار: في مسار العملاء «أنت» تعني الشركة. */
    function authorLabel(reply, ticket) {
        if (reply.user_id === userId) return 'أنت';
        if (spec.showsCustomer && ticket && reply.user_id === ticket.user_id) return 'العميل';
        return 'فريق مدعوم';
    }

    async function onReply(event, ticketId) {
        event.preventDefault();
        const input = el(uid('ReplyText'));
        const error = el(uid('ReplyError'));
        const btn = el(uid('ReplyBtn'));
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
            await addTicketReply(ticketId, message, false, { autoTransition: spec.autoTransition });
            input.value = '';
            // الحالة قد تتغيّر بالردّ (إعادة فتح)، فنعيد القراءة من المصدر
            tickets = (await spec.load()) || [];
            render();
        } catch (err) {
            // الفشل يظل رسالة في مكانه — بلا أي تحويل
            error.textContent = err?.message || 'تعذّر إرسال الردّ. حاول مرة أخرى.';
            error.hidden = false;
        } finally {
            btn.disabled = false;
            btn.textContent = original;
        }
    }

    function wire() {
        const box = container();
        if (!box) return;

        box.querySelectorAll('[data-stream-view]').forEach(btn => {
            btn.addEventListener('click', () => {
                activeView = btn.getAttribute('data-stream-view');
                render();
            });
        });

        const search = el(uid('Search'));
        search?.addEventListener('input', () => {
            searchTerm = search.value;
            renderList(applyTicketView(tickets, { view: activeView, search: searchTerm, userId }));
            bindRows();
        });

        box.querySelector('[data-stream-action="close"]')?.addEventListener('click', () => {
            openTicketId = null;
            render();
        });

        box.querySelectorAll('[data-stream-action="new"], [data-action="new-ticket"]').forEach(btn => {
            btn.addEventListener('click', () => onNewTicket?.());
        });

        bindRows();
    }

    function bindRows() {
        const box = container();
        box?.querySelectorAll('[data-stream-ticket]').forEach(row => {
            const openRow = () => {
                openTicketId = row.getAttribute('data-stream-ticket');
                render();
            };
            row.addEventListener('click', openRow);
            row.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openRow(); }
            });
        });
    }

    return { key: spec.key, load, open, has };
}
