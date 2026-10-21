/**
 * invite-model.js — صفحة قبول دعوة الشركة من البريد (/portal/invite.html، 112). خالص، مُختبَر في
 * tests/portal-invite.render.test.mjs.
 *
 * الرابط: /portal/invite.html#token=<64 خانة سداسية>. الرمز في الجزء بعد # فلا يصل لأي خادم ولا
 * لسجلات الوصول ولا لترويسة Referer. يُحفظ في هذا المتصفح حتى يُربط (رحلة الدخول أو إنشاء الحساب
 * قد تمر بصفحات أخرى) ثم يُمحى، ولا يبقى أكثر من 7 أيام (عمر الدعوة).
 */
export const PENDING_INVITE_KEY = 'mad3oom.pendingInvite';
export const PENDING_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const INVITE_PAGE = '/portal/invite.html';
const TOKEN_RE = /^[0-9a-f]{64}$/;

/** الرمز من جزء الرابط، أو null. */
export function tokenFromHash(hash) {
    // الجزء بعد # وحده: الرمز في ?query يصل للخادم وسجلاته، فلا يُقبل
    if (!String(hash || '').startsWith('#')) return null;
    const value = new URLSearchParams(String(hash).slice(1)).get('token');
    return value && TOKEN_RE.test(value) ? value : null;
}

/** الرمز المحفوظ إن كان صالحًا وحديثًا، أو null. stored = النص المخزَّن. */
export function storedToken(stored, now = Date.now()) {
    try {
        const v = JSON.parse(stored || 'null');
        if (!v || !TOKEN_RE.test(String(v.token || '')) || !Number.isFinite(v.at)) return null;
        return now - v.at <= PENDING_INVITE_TTL_MS && v.at <= now ? v.token : null;
    } catch { return null; }
}

/** رابط الدخول الذي يعيد إلى هذه الصفحة (login.html يقبل redirect على نطاق mad3oom.com). */
export const loginUrl = () => `/login.html?redirect=${encodeURIComponent(INVITE_PAGE)}`;

/**
 * الحالة المعروضة. claim = { data, error } من company_invitation_claim، أو null بلا جلسة.
 * clearStored: يُمحى الرمز المحفوظ (رُبط أو لن يُربط بأي حساب).
 */
export function inviteState({ token, signedIn, claim }) {
    if (!token) return { kind: 'no-token', clearStored: true };
    if (!signedIn) return { kind: 'sign-in', clearStored: false };
    const err = claim?.error;
    if (err) {
        if (err.code === '42501') return { kind: 'ineligible', clearStored: true };
        if (err.code === '0A000') return { kind: 'disabled', clearStored: false };
        if (err.code === 'P0002') return { kind: 'not-found', clearStored: false };
        return { kind: 'error', clearStored: false };
    }
    const d = claim?.data || {};
    if (d.already_member) return { kind: 'already-member', companyName: d.company_name || '', clearStored: true };
    if (!d.invitation_id) return { kind: 'error', clearStored: false };
    return {
        kind: d.account_active ? 'ready' : 'inactive',
        invitationId: d.invitation_id,
        companyName: d.company_name || '',
        expiresAt: d.expires_at || null,
        clearStored: true
    };
}
