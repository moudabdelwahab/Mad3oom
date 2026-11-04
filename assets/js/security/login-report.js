/**
 * login-report.js — إبلاغ دالة security-event بمحاولة دخول فاشلة (121).
 *
 * Supabase Auth لا يكتب المحاولات الفاشلة في جدول نقرؤه، فتبلغ عنها صفحة الدخول. الإبلاغ:
 *   • البريد وسبب من قائمة مغلقة فقط — لا كلمة مرور ولا أي حقل آخر
 *   • الـIP والمتصفح تقرؤهما الدالة من رؤوس الطلب نفسه
 *   • لا ينتظره الدخول ولا يكسره: أي فشل هنا يُتجاهل
 */
export const REASON_BY_MESSAGE = Object.freeze({
    'Invalid login credentials': 'invalid_credentials',
    'Email not confirmed': 'email_not_confirmed',
    'Too many requests': 'rate_limited'
});

export function failureReason(error) {
    const msg = String(error?.message || '');
    if (REASON_BY_MESSAGE[msg]) return REASON_BY_MESSAGE[msg];
    if (/rate limit|too many/i.test(msg) || error?.status === 429) return 'rate_limited';
    return 'other';
}

/** @param {{ functions?: { invoke: Function } }} client  عميل Supabase */
export function reportLoginFailure(client, email, error) {
    const normalized = String(email || '').trim().toLowerCase();
    if (!client?.functions?.invoke || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(normalized)) return;
    try {
        Promise.resolve(client.functions.invoke('security-event', {
            body: { action: 'login_failed', email: normalized, reason: failureReason(error) }
        })).catch(() => {});
    } catch { /* الإبلاغ لا يكسر الدخول */ }
}
