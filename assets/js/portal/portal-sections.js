/**
 * portal-sections.js — بوابة عميل الشركة كتجربة مستقلة: تنقّل بين الأقسام، والإشعارات، وحسابي.
 *
 * قبلها كانت البوابة صفحة طويلة واحدة، وإعدادات الحساب والإشعارات خارجها (صفحات بوابة مدعوم
 * الشخصية). الآن داخلها، فوق المكوّنات المشتركة نفسها بلا نسخ:
 *   notifications-service.js            إشعارات المستخدم نفسه (RLS: user_id = auth.uid())
 *   assets/js/account/account-settings.js الملف الشخصي والأمان الموحّد (نفس لوحة الشركة والإدارة)
 *
 * منظور المالك (preview): لا إشعارات ولا حساب — المنظور قراءة لبيانات الشركة، لا حساب المالك.
 * لا شيء هنا يقرر صلاحية؛ كل قراءة وكتابة تمر بـRLS ودوال القاعدة.
 */
import { escapeHtml } from '/assets/js/customer/portal-ui.js';

const NOTIF_LIMIT = 20;
let wired = false;

/** تنسيق وقت مختصر بالعربية (بلا اعتماد على وحدة تجرّ استعلامات). */
function when(iso) {
    const ts = Date.parse(iso || '');
    if (!Number.isFinite(ts)) return '';
    const min = Math.round((Date.now() - ts) / 60000);
    if (min < 1) return 'الآن';
    if (min < 60) return `منذ ${min} د`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `منذ ${hr} س`;
    return new Date(ts).toLocaleDateString('ar-EG', { day: 'numeric', month: 'short' });
}

/**
 * وجهة الإشعار داخل البوابة. رابط البوابة نفسها ⇒ قسمها؛ رابط تذكرة ⇒ قسم التذاكر؛
 * غير ذلك لا تنقّل (لا نخرج العميل إلى لوحة ليست له). دالة خالصة.
 */
export function portalDestination(link) {
    if (!link || typeof link !== 'string') return null;
    let url;
    try { url = new URL(link, 'https://portal.invalid'); } catch { return null; }
    if (url.origin !== 'https://portal.invalid') return null;
    if (url.pathname === '/portal/' || url.pathname === '/portal/index.html') {
        if (url.searchParams.get('comm')) return '#messages';
        return url.hash && /^#[a-zA-Z][\w-]*$/.test(url.hash) ? url.hash : '#portalTicketsSection';
    }
    if (url.searchParams.get('ticket')) return '#portalTicketsSection';
    return null;
}

export async function initPortalSections({ preview = false } = {}) {
    const nav = document.getElementById('portalSectionNav');
    const notif = document.getElementById('portalNotifications');
    const account = document.getElementById('portalAccount');
    if (nav) nav.hidden = false;
    if (preview) {
        if (notif) notif.hidden = true;
        if (account) account.hidden = true;
        syncNav();
        return;
    }
    if (!wired) { wire(); wired = true; }
    if (notif) { notif.hidden = false; await loadNotifications(); }
    if (account) account.hidden = false;
    syncNav();
}

/** رابط لكل قسم ظاهر فقط («رسائلي» تختفي والميزة مطفأة). */
function syncNav() {
    document.querySelectorAll('#portalSectionNav [data-section]').forEach(a => {
        const target = document.getElementById(a.dataset.section);
        a.hidden = !target || target.hidden;
    });
}

function wire() {
    document.getElementById('portalNotifMarkAll')?.addEventListener('click', async (e) => {
        e.currentTarget.disabled = true;
        try {
            const { markAllAsRead } = await import('/notifications-service.js');
            await markAllAsRead();
        } catch (err) {
            console.error('[Portal] mark all read:', err?.message || err);
        }
        e.currentTarget.disabled = false;
        loadNotifications();
    });
    document.getElementById('portalNotifList')?.addEventListener('click', async (e) => {
        const item = e.target.closest('[data-notification]');
        if (!item) return;
        const id = item.dataset.notification;
        const target = item.dataset.target || null;
        if (item.dataset.unread === 'true') {
            try {
                const { markAsRead } = await import('/notifications-service.js');
                await markAsRead(id);
            } catch { /* القراءة لا تمنع التنقّل */ }
            item.dataset.unread = 'false';
            updateNotifBadge();
        }
        if (target) {
            const section = document.querySelector(target);
            if (section && !section.hidden) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    });
    document.querySelectorAll('[data-account-tab]').forEach(btn => btn.addEventListener('click', () => openAccount(btn.dataset.accountTab)));
}

async function loadNotifications() {
    const list = document.getElementById('portalNotifList');
    if (!list) return;
    list.setAttribute('aria-busy', 'true');
    let rows = [];
    try {
        const { fetchNotifications } = await import('/notifications-service.js');
        rows = (await fetchNotifications()) || [];
    } catch (err) {
        console.error('[Portal] notifications:', err?.message || err);
        list.removeAttribute('aria-busy');
        list.innerHTML = '<li class="state-block"><p class="state-text">تعذّر تحميل الإشعارات.</p></li>';
        return;
    }
    list.removeAttribute('aria-busy');
    rows = rows.slice(0, NOTIF_LIMIT);
    if (!rows.length) {
        list.innerHTML = '<li class="state-block"><p class="state-text">لا إشعارات بعد. ستصلك هنا ردود الشركة على تذاكرك ورسائلك.</p></li>';
        updateNotifBadge();
        return;
    }
    list.innerHTML = rows.map(n => {
        const target = portalDestination(n.link);
        return `<li>
            <button type="button" class="portal-notif-item" data-notification="${escapeHtml(n.id)}"
                    data-unread="${n.is_read ? 'false' : 'true'}"${target ? ` data-target="${escapeHtml(target)}"` : ''}>
                <span class="portal-notif-title">${escapeHtml(n.title || '')}</span>
                <span class="portal-notif-text">${escapeHtml(n.message || '')}</span>
                <time class="portal-notif-time" datetime="${escapeHtml(n.created_at || '')}">${escapeHtml(when(n.created_at))}</time>
            </button>
        </li>`;
    }).join('');
    updateNotifBadge();
}

function updateNotifBadge() {
    const n = document.querySelectorAll('#portalNotifList [data-unread="true"]').length;
    const badge = document.getElementById('portalNotifBadge');
    if (badge) { badge.textContent = String(n); badge.hidden = n === 0; }
    const markAll = document.getElementById('portalNotifMarkAll');
    if (markAll) markAll.hidden = n === 0;
}

let accountMounted = null;
async function openAccount(section) {
    const body = document.getElementById('portalAccountBody');
    if (!body) return;
    document.querySelectorAll('[data-account-tab]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.accountTab === section)));
    if (accountMounted === section) return;
    accountMounted = section;
    body.hidden = false;
    try {
        const [{ mountAccountSettings }, { ui }] = await Promise.all([
            import('/assets/js/account/account-settings.js'), import('/ui-service.js')]);
        await mountAccountSettings(body, { section, notify: (msg, type) => ui.showToast(msg, type) });
    } catch (err) {
        console.error('[Portal] account:', err?.message || err);
        body.innerHTML = '<p class="field-error">تعذّر تحميل إعدادات الحساب.</p>';
        accountMounted = null;
    }
}
