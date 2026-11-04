/**
 * html.js — أدوات HTML مشتركة لرسائل البريد (خالصة). ticket-email.js يعيد تصديرها، وsecurity-alert يستوردها
 * وحدها فلا يحمل قالب التذاكر كاملًا.
 */
export const DEFAULT_SITE_ORIGIN = 'https://mad3oom.com';

/** تهريب HTML لكل نص من خارج القالب. */
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** أصل الموقع: https وبلا مسار، وإلا الافتراضي. */
export function siteOriginFrom(value) {
    try {
        const u = new URL(String(value || ''));
        return u.protocol === 'https:' ? u.origin : DEFAULT_SITE_ORIGIN;
    } catch { return DEFAULT_SITE_ORIGIN; }
}
