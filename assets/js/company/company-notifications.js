/**
 * company-notifications.js — إشعارات الحساب داخل لوحة الشركة.
 *
 * فوق نفس الوحدات المشتركة:
 *   notifications-service.js                    القراءة والتعليم كمقروء
 *   assets/js/customer/notification-router.js   تصنيف الإشعار ووجهته (خالصة)
 *
 * نقطة مهمة: موجّه الإشعارات بيرجّع **وجهة مجرّدة** ({kind:'section'|'ticket'|
 * 'url'}) وسايب لكل بوابة تترجمها لنفسها. فبوابة العميل بتفتح أقسامها،
 * ولوحة الشركة بتفتح أقسامها هي. والوجهة من نوع 'url' اللي بتشاور على بوابة
 * العميل بتتحوّل هنا لأقرب قسم مكافئ داخل لوحة الشركة بدل ما تخرج بالمستخدم
 * منها — وده بالظبط اللي بيمنع المسار القديم من العودة عبر إشعار.
 */

import {
    fetchNotifications, markAsRead, markAllAsRead
} from '/notifications-service.js';
import {
    resolveNotification, actionLabelFor, categoriesPresentIn, NOTIFICATION_CATEGORIES
} from '/assets/js/customer/notification-router.js';
import { escapeHtml, timeAgo, renderState, renderSkeletonLines }
    from '/assets/js/customer/portal-ui.js';

/** الأقسام الموجودة فعلًا في لوحة الشركة. أي وجهة خارجها تُهمَل بأمان. */
const COMPANY_SECTIONS = new Set([
    'overview', 'members', 'subscriptions', 'tickets', 'customerTickets',
    'support', 'notifications', 'api', 'reports', 'activity', 'profile', 'security'
]);

/**
 * ترجمة أقسام بوابة العميل إلى ما يكافئها في لوحة الشركة.
 * ما لا مكافئ له (المكافآت، الشارات، الاستهلاك…) يسقط إلى النظرة العامة —
 * لا يخرج بالمستخدم إلى بوابة أخرى.
 */
const SECTION_ALIASES = {
    usage: 'subscriptions',
    rewards: 'overview',
    badges: 'overview'
    // activity لها الآن قسم مستقل في لوحة الشركة، فلا تحتاج ترجمة
};

let container = null;
let notifications = [];
let activeCategory = null;
let navigate = null;   // (section) => void
let openTicket = null; // (ticketId) => void

export function initCompanyNotifications({ onNavigate, onOpenTicket } = {}) {
    container = document.getElementById('companyNotifications');
    navigate = onNavigate || null;
    openTicket = onOpenTicket || null;
}

/** الوجهة كما تفهمها لوحة الشركة. تُصدَّر لأنها قابلة للاختبار بمعزل. */
export function companyDestinationFor(notification) {
    const { destination } = resolveNotification(notification);

    if (destination?.kind === 'ticket') return { kind: 'ticket', ticketId: destination.ticketId };

    if (destination?.kind === 'section') {
        const section = SECTION_ALIASES[destination.section] || destination.section;
        return COMPANY_SECTIONS.has(section) ? { kind: 'section', section } : { kind: 'none' };
    }

    // وجهة من نوع 'url' معناها صفحة في بوابة أخرى. لوحة الشركة لا تغادر
    // نفسها، فنُسقطها بدل أن نتبعها.
    return { kind: 'none' };
}

export async function loadCompanyNotifications() {
    if (!container) return;
    renderSkeletonLines(container, 4);

    // fetchNotifications ترمي عند الفشل ولا ترجّع { error } — نلتقطها هنا
    try {
        notifications = (await fetchNotifications()) || [];
    } catch (err) {
        console.error('[CompanyNotifications]', err?.message || err);
        renderState(container, {
            variant: 'error',
            title: 'تعذّر تحميل الإشعارات',
            text: 'تحقق من اتصالك ثم أعد المحاولة.',
            action: { label: 'إعادة المحاولة', retry: 'notifications', variant: 'btn-primary' }
        });
        return;
    }

    render();
}

function render() {
    const categories = categoriesPresentIn(notifications);
    const visible = activeCategory
        ? notifications.filter(n => (NOTIFICATION_CATEGORIES[n?.category] ? n.category : 'other') === activeCategory)
        : notifications;
    const unread = notifications.filter(n => !n.is_read).length;

    container.innerHTML = `
        <section class="panel">
            <div class="panel-header">
                <div>
                    <h2 class="panel-title">الإشعارات</h2>
                    <p class="panel-subtitle">${unread ? `${unread} غير مقروء` : 'كل الإشعارات مقروءة'}</p>
                </div>
                ${unread ? '<button type="button" class="panel-link" id="companyMarkAllRead">تعليم الكل كمقروء</button>' : ''}
            </div>

            ${categories.length > 1 ? `
            <div class="view-tabs" role="tablist">
                <button type="button" role="tab" class="view-tab"
                        aria-selected="${!activeCategory}" data-company-category="">كل الإشعارات</button>
                ${categories.map(key => `
                    <button type="button" role="tab" class="view-tab"
                            aria-selected="${activeCategory === key}" data-company-category="${escapeHtml(key)}">
                        ${escapeHtml(NOTIFICATION_CATEGORIES[key]?.label || key)}
                    </button>`).join('')}
            </div>` : ''}

            <div id="companyNotificationList"></div>
        </section>`;

    const list = document.getElementById('companyNotificationList');

    if (!visible.length) {
        renderState(list, { variant: 'empty', title: 'لا توجد إشعارات', text: 'ستظهر هنا تحديثات تذاكرك واشتراكات شركتك.' });
    } else {
        list.innerHTML = `
            <ul class="company-sub-list">
                ${visible.map(n => {
                    const destination = companyDestinationFor(n);
                    const label = destination.kind === 'none' ? '' : actionLabelFor(n, destination);
                    return `
                    <li class="company-sub ${n.is_read ? '' : 'is-unread'}" data-company-notification="${escapeHtml(n.id)}">
                        <div class="company-sub-main">
                            <p class="company-sub-plan">${escapeHtml(n.title || '')}</p>
                            <p class="company-sub-dates">${escapeHtml(n.message || '')}</p>
                            <p class="company-sub-dates">${escapeHtml(timeAgo(n.created_at))}</p>
                        </div>
                        <div class="company-sub-side">
                            ${n.is_read ? '' : '<span class="pill status-tone-accent">جديد</span>'}
                            ${label ? `<button type="button" class="panel-link" data-company-open="${escapeHtml(n.id)}">${escapeHtml(label)}</button>` : ''}
                        </div>
                    </li>`;
                }).join('')}
            </ul>`;
    }

    wire();
}

function wire() {
    document.querySelectorAll('[data-company-category]').forEach(btn => {
        btn.addEventListener('click', () => {
            activeCategory = btn.getAttribute('data-company-category') || null;
            render();
        });
    });

    document.getElementById('companyMarkAllRead')?.addEventListener('click', async () => {
        await markAllAsRead();
        notifications = notifications.map(n => ({ ...n, is_read: true }));
        document.dispatchEvent(new CustomEvent('customer:notifications-read'));
        render();
    });

    document.querySelectorAll('[data-company-open]').forEach(btn => {
        btn.addEventListener('click', async (event) => {
            event.stopPropagation();
            const id = btn.getAttribute('data-company-open');
            const notification = notifications.find(n => String(n.id) === String(id));
            if (!notification) return;

            if (!notification.is_read) {
                await markAsRead(notification.id);
                notification.is_read = true;
                document.dispatchEvent(new CustomEvent('customer:notifications-read'));
            }

            const destination = companyDestinationFor(notification);
            if (destination.kind === 'ticket' && openTicket) openTicket(destination.ticketId);
            else if (destination.kind === 'section' && navigate) navigate(destination.section);
        });
    });
}
