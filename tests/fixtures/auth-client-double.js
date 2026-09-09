/**
 * بديل اختباري لـauth-client.js — يرجّع مستخدمًا ثابتًا بدون أي جلسة حقيقية.
 *
 * بيصدّر resolveAccess/ACCESS كمان عشان page-guard.js (حارس الصفحة الحقيقي)
 * يشتغل كما هو في الاختبارات: القرار بيتاخد بنفس الدالة الخالصة المستخدمة في
 * الإنتاج (assets/js/access-policy.js)، مش بمنطق مكرر هنا.
 */
import { ACCESS, classifyAccess } from '/assets/js/access-policy.js';

export { ACCESS };

export async function resolveAccess(requiredRole = null) {
    const user = window.__FIXTURES__?.authUser || null;
    if (!user) return { status: ACCESS.ANONYMOUS, user: null, reason: 'no-session' };

    const decision = classifyAccess({
        identity: { email: user.email, role: user.profile?.role },
        requiredRole,
        impersonating: !!user.isImpersonated,
        banned: user.banned === true
    });
    return { status: decision.status, user, reason: decision.reason };
}

export async function requireAuth(requiredRole = null) {
    const { status, user } = await resolveAccess(requiredRole);
    if (status === ACCESS.AUTHORIZED) return user;
    if (status === ACCESS.BANNED) return { banned: true };
    return null;
}
export async function logout() {}
export async function updateProfile(updates) {
    window.__CALLS__ = window.__CALLS__ || [];
    window.__CALLS__.push(['updateProfile', updates]);
    return { data: updates, error: null };
}
export async function updatePassword(pw) {
    window.__CALLS__ = window.__CALLS__ || [];
    window.__CALLS__.push(['updatePassword', pw.length]);
    return { data: {}, error: null };
}
export async function getCurrentUser() { return window.__FIXTURES__?.authUser || null; }
export async function autoRedirect() {}
export async function adminImpersonateUser() {}
