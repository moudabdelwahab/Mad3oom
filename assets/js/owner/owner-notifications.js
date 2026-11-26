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

/** مفتاح التنبيه المحفوظ بين التنقل وقسم الإشعارات (يُقرأ مرة واحدة ثم يُمسح). */
export const OWNER_NOTICE_KEY = 'mad3oom-owner-notice';

/** روابط /admin/* التي لها مقابل أصلي في لوحة المالك — المسار فقط، بلا استعلام. */
export const ADMIN_TO_OWNER = Object.freeze({
    '/admin/tickets.html': '/owner/tickets.html',
    '/admin/account-requests.html': '/owner/account-requests.html',
    '/admin/settings.html': '/owner/settings.html'
});

/** أقسام إعدادات الإدارة (#hash) وما يقابلها من تبويبات في /owner/settings.html. */
export const ADMIN_SETTINGS_SECTIONS = Object.freeze({
    'platform-control': 'platform',
    'ticket-rules': 'rules',
    'communication-control': 'platform',
    'emergency-mode': 'platform',
    'security-policies': 'platform',
    'working-hours': 'hours',
    'bot-settings': 'bot',
    'ads-settings': 'ads',
    'customer-settings': 'platform',
    'branding': 'branding',
    'ticket-distribution': 'distribution',
    'sla-settings': 'sla',
    'telegram-alerts': 'telegram',
    'data-retention': 'retention',
    'webhooks': 'webhooks'
});

/** روابط /admin/* معروفة بلا مقابل أصلي بعد — والرسالة التي تفسّر ذلك للمالك. */
export const UNMAPPED_ADMIN_PAGES = Object.freeze({
    '/admin/continuity.html': 'تذكير استمرارية بلا صفحة أصيلة في لوحة المالك بعد — بقيت في الإشعارات.',
    '/admin/suggestions.html': 'صفحة الاقتراحات ليس لها مقابل أصيل في لوحة المالك بعد — بقيت في الإشعارات.'
});

/** يحفظ تنبيه وجهة غير منقولة ليظهر في قسم الإشعارات بعد التنقل (قد يكون التخزين محظورًا). */
export function storeOwnerNotice(notice) {
    try { sessionStorage.setItem(OWNER_NOTICE_KEY, notice); } catch { /* بلا تنبيه */ }
}

/** يقرأ التنبيه المحفوظ مرة واحدة ويمسحه. */
export function takeOwnerNotice() {
    try {
        const value = sessionStorage.getItem(OWNER_NOTICE_KEY);
        if (value) sessionStorage.removeItem(OWNER_NOTICE_KEY);
        return value || null;
    } catch {
        return null;
    }
}

/** أقسام اللوحة نفسها (#hash) — الصفحات المستقلة في /owner/ تنقل إليها بدل أن تعرضها. */
export const OWNER_SECTIONS = Object.freeze(['overview', 'authority', 'governance', 'audit', 'users', 'pi', 'notifications']);

/**
 * إلى أين يقود الإشعار؟ خالصة.
 *   { kind: 'section', section }  رابط إلى قسم في لوحة المالك (/owner-dashboard.html#governance)
 *   { kind: 'href', href }        صفحة أخرى على نفس الأصل
 *   { kind: 'none' }              بلا رابط صالح
 * روابط /admin/* لا تُتبَع أبدًا من لوحة المالك: ما له مقابل أصيل يُعاد توجيهه إليه
 * (التذاكر والإعدادات، مع ترجمة ?ticket_id= إلى ?ticket= و#hash الإعدادات إلى تبويب المالك)،
 * وما بلا مقابل — الاستمرارية والاقتراحات وأي رابط إدارة غير معروف —
 * يعود لقسم الإشعارات مع notice يفسّر للمالك لماذا لم يُفتح الرابط.
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
    if (url.pathname.startsWith('/admin/')) {
        const mapped = ADMIN_TO_OWNER[url.pathname];
        if (mapped) {
            let out = mapped;
            if (url.pathname === '/admin/tickets.html') {
                const id = url.searchParams.get('ticket_id') || url.searchParams.get('ticket');
                if (id) out += `?ticket=${encodeURIComponent(id)}`;
            }
            if (url.pathname === '/admin/settings.html' && url.hash) {
                const tab = ADMIN_SETTINGS_SECTIONS[url.hash.slice(1)];
                if (tab) out += `#${tab}`;
            }
            return { kind: 'href', href: out };
        }
        const notice = UNMAPPED_ADMIN_PAGES[url.pathname]
            || 'هذه الصفحة من لوحة الإدارة وليس لها مقابل في لوحة المالك بعد.';
        const section = sections.includes('notifications') ? 'notifications' : 'overview';
        return { kind: 'section', section, notice };
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
        // تنبيه وجهة غير منقولة (رابط إدارة بلا مقابل أصيل): يُعرض مرة واحدة ثم يُمسح.
        const notice = takeOwnerNotice();
        const noticeHtml = notice
            ? `<div class="state-block state-block--compact"><p class="state-text">${esc(notice)}</p></div>` : '';
        if (!items.length) {
            container.innerHTML = `${noticeHtml}<div class="state-block state-block--compact"><p class="state-text">لا توجد إشعارات بعد.</p></div>`;
            return;
        }
        container.innerHTML = `${noticeHtml}<ul class="owner-notif-list">${items.map(n => `
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
                // تعليم المقروء محاولة لطيفة: فشلها لا يمنع فتح الإشعار نفسه.
                try {
                    await service.markAsRead(n.id);
                } catch (err) {
                    console.error('[OwnerNotifications] markAsRead:', err?.message || err);
                }
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
            // كان الخطأ نصًا بلا إعادة محاولة: الآن زر يعيد التحميل بنفس النمط.
            container.innerHTML = `<div class="state-block state-block--compact state-block--error"><p class="state-text">تعذّر تحميل الإشعارات.</p>
                <p><button type="button" class="btn btn-outline btn-sm" data-owner-notif-retry>إعادة المحاولة</button></p></div>`;
            container.querySelector('[data-owner-notif-retry]').addEventListener('click', load);
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
