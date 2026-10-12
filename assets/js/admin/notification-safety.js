/**
 * عرض الإشعارات في لوحة الإدارة بأمان (منطق نقي، بلا DOM).
 *
 * محتوى صف notifications ليس موثوقًا: أي موظف يقدر يُدرج إشعارًا لأي مستخدم
 * (سياسة "Staff can create notifications for any user")، وبعض الإشعارات تنسخ
 * نصًا يتحكم فيه العميل (اسمه في inbox_assign). لذلك:
 *   - العنوان والنص يُعرضان كنص فقط (textContent) في sidebar.js، لا HTML.
 *   - الرابط لا يُتبع إلا لو كان على نفس أصل الصفحة (http/https). أي مخطط آخر
 *     (javascript:، data:، …) أو نطاق آخر يُتجاهل.
 */

/**
 * يرجع مسارًا آمنًا للتنقل (pathname + search + hash) أو null.
 * @param {unknown} link قيمة notifications.link كما هي
 * @param {string} origin أصل الصفحة الحالية (location.origin)
 */
export function safeNotificationHref(link, origin) {
    if (typeof link !== 'string' || typeof origin !== 'string') return null;
    const raw = link.trim();
    // محارف تحكم أو مسافات داخلية: ليست روابط مشروعة، وتُستخدم لتمويه المخطط.
    if (!raw || /[\u0000-\u001F\u007F\s]/.test(raw)) return null;
    let base;
    let url;
    try {
        base = new URL(origin);
        url = new URL(raw, base);
    } catch {
        return null;
    }
    if (base.protocol !== 'http:' && base.protocol !== 'https:') return null;
    if (url.protocol !== base.protocol || url.origin !== base.origin) return null;
    return `${url.pathname}${url.search}${url.hash}`;
}
