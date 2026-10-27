/**
 * owner-notifications.js — إشعارات مالك المنصة داخل لوحة المالك.
 *
 * الجرس في قشرة المالك كان ينادي onTabChange('notifications') ولا قسم بهذا الاسم في اللوحة، فيعود
 * showSection إلى «نظرة عامة» ويبدو الزر معطّلًا. صفحة admin/notifications.html لا تصلح بديلًا: حارسها
 * يطلب سياق الإدارة، والمالك هنا في سياق «مالك المنصة». فالإشعارات قسم في اللوحة نفسها، والجرس يفتح
 * آخرها في نافذة منبثقة (كلوحة الشركة)، و«عرض الكل» ينقل للقسم.
 *
 * محتوى صف الإشعار غير موثوق (نصوص يكتبها غير المالك): العنوان والنص يُعرضان مهرَّبين، والرابط لا يُتبع
 * إلا على نفس الأصل (safeNotificationHref).
 */
import { safeNotificationHref } from '/assets/js/admin/notification-safety.js';

export const OWNER_HOME = '/owner-dashboard.html';

/** أقسام اللوحة نفسها (#hash) — الصفحات المستقلة في /owner/ تنقل إليها بدل أن تعرضها. */
export const OWNER_SECTIONS = Object.freeze(['overview', 'authority', 'governance', 'audit', 'notifications']);

/**
 * إلى أين يقود الإشعار؟ خالصة.
 *   { kind: 'section', section }  رابط إلى قسم في لوحة المالك (/owner-dashboard.html#governance)
 *   { kind: 'href', href }        صفحة أخرى على نفس الأصل
 *   { kind: 'none' }              بلا رابط صالح
 * @param {{ link?: unknown }} notification
 * @param {string} origin location.origin
 * @param {readonly string[]} sections أقسام اللوحة المعروفة
 */
export function ownerDestinationFor(notification, origin, sections) {
    const href = safeNotificationHref(notification?.link, origin);
    if (!href) return { kind: 'none' };
    const url = new URL(href, origin);
    if (url.pathname === OWNER_HOME || url.pathname === '/owner-dashboard') {
        const section = url.hash.slice(1);
        return sections.includes(section) ? { kind: 'section', section } : { kind: 'section', section: 'overview' };
    }
    return { kind: 'href', href };
}

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * قسم الإشعارات. deps: { service: notifications-service.js، open(notification)، when(date) }.
 * يُرسم عند فتح القسم ويُعاد رسمه بعد كل تغيير.
 */
export function createOwnerNotifications({ container, markAllButton, service, open, when }) {
    let items = [];

    function render() {
        markAllButton.hidden = !items.some(n => !n.is_read);
        if (!items.length) {
            container.innerHTML = `<div class="state-block state-block--compact"><p class="state-text">لا توجد إشعارات بعد.</p></div>`;
            return;
        }
        container.innerHTML = `<ul class="owner-notif-list">${items.map(n => `
            <li class="owner-notif ${n.is_read ? '' : 'is-unread'}">
                <button type="button" class="owner-notif-open" data-owner-notif="${esc(n.id)}">
                    <span class="owner-notif-title">${esc(n.title)}</span>
                    <span class="owner-notif-msg">${esc(n.message)}</span>
                    <span class="owner-notif-time">${esc(when(n.created_at))}</span>
                </button>
                ${n.is_read ? '' : '<span class="pill status-tone-accent">جديد</span>'}
            </li>`).join('')}</ul>`;
        container.querySelectorAll('[data-owner-notif]').forEach(btn => btn.addEventListener('click', async () => {
            const n = items.find(x => String(x.id) === btn.dataset.ownerNotif);
            if (!n) return;
            if (!n.is_read) {
                await service.markAsRead(n.id);
                n.is_read = true;
                document.dispatchEvent(new CustomEvent('customer:notifications-read'));
                render();
            }
            open(n);
        }));
    }

    async function load() {
        container.innerHTML = '<div class="skeleton skeleton-card"></div>';
        try {
            items = (await service.fetchNotifications()) || [];
        } catch (err) {
            console.error('[OwnerNotifications] load:', err?.message || err);
            container.innerHTML = `<div class="state-block state-block--compact state-block--error"><p class="state-text">تعذّر تحميل الإشعارات. حاول مرة أخرى.</p></div>`;
            markAllButton.hidden = true;
            return;
        }
        render();
    }

    markAllButton.addEventListener('click', async () => {
        markAllButton.disabled = true;
        try {
            await service.markAllAsRead();
            items = items.map(n => ({ ...n, is_read: true }));
            document.dispatchEvent(new CustomEvent('customer:notifications-read'));
            render();
        } finally {
            markAllButton.disabled = false;
        }
    });

    return { load };
}
