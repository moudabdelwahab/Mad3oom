/**
 * handler.js — منطق دالة company-invite-customer بلا Deno (التبعيات تُحقن؛ مُختبَر في
 * tests/company-invite-function.test.mjs بقاعدة ومزوّد بديلين).
 *
 * المسار:
 *   1) company_invite_customer بهوية المستخدم (JWT): التحقق من البريد، ومدير الشركة وحده، والمفتاح،
 *      وصف الدعوة (أو المعلّقة نفسها للبريد نفسه). الرفض هنا = لا شيء بعده.
 *   2) _company_invitation_prepare_email بمفتاح الخدمة: منع التكرار والتزامن والمهلة والحدود، ورمز جديد
 *      يُخزَّن تجزئته وحدها.
 *   3) Resend عبر _shared/email.js بمفتاح منع تكرار لكل محاولة.
 *   4) _company_invitation_email_result: sent فقط إن قَبِل المزوّد الرسالة؛ وإلا failed برمز داخلي.
 *
 * الرد للمتصفح: status ورسالة عربية فقط. لا رمز ولا رد مزوّد ولا مفتاح. «sent» = قَبِل المزوّد الإرسال.
 */
import { inviteEmail } from './template.js';

export const INVITE_PATH = '/portal/invite.html';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const MESSAGES = Object.freeze({
    sent: 'أُرسلت الدعوة إلى بريد العميل.',
    already_sent: 'أُرسلت دعوة لهذا البريد من قبل وما زالت سارية.',
    invalid_email: 'بريد إلكتروني غير صالح',
    unauthorized: 'يجب تسجيل الدخول أولًا',
    forbidden: 'دعوة العملاء متاحة لمدير الشركة فقط.',
    feature_disabled: 'دعوات العملاء غير مفعّلة حاليًا.',
    too_many_pending: 'دعوات معلّقة كثيرة — ألغِ بعضها أولًا.',
    cooldown: 'أُرسلت محاولة لهذه الدعوة للتو. انتظر دقيقة ثم أعد المحاولة.',
    in_flight: 'إرسال هذه الدعوة جارٍ الآن.',
    too_many_attempts: 'بلغت هذه الدعوة حد محاولات الإرسال. ألغِها ثم أنشئ دعوة جديدة.',
    company_daily_cap: 'بلغت الشركة الحد اليومي لرسائل الدعوة. حاول غدًا.',
    not_pending: 'هذه الدعوة لم تعد معلّقة.',
    send_failed: 'سُجّلت الدعوة لكن تعذّر إرسال البريد. أعد المحاولة بعد دقيقة.',
    not_configured: 'سُجّلت الدعوة لكن إرسال البريد غير مهيأ حاليًا. أعد المحاولة لاحقًا.',
    server: 'تعذّر تنفيذ الطلب. حاول مرة أخرى.'
});

const reply = (status, code, extra = {}) => ({ status, body: { status: code, ...(code === 'sent' || code === 'already_sent' ? { message: MESSAGES[code] } : { error: MESSAGES[code] || MESSAGES.server }), ...extra } });

const RPC_ERRORS = { '42501': [403, 'forbidden'], '0A000': [409, 'feature_disabled'], '54000': [429, 'too_many_pending'], '22023': [400, 'invalid_email'] };
const SKIP = { already_sent: 200, cooldown: 429, in_flight: 409, too_many_attempts: 429, company_daily_cap: 429, not_pending: 409 };

/** أصل الموقع للرابط: https فقط، بلا مسار. */
export function inviteOrigin(value) {
    try {
        const u = new URL(String(value || ''));
        return u.protocol === 'https:' ? u.origin : null;
    } catch { return null; }
}

/**
 * @param {{ email?: unknown, resend?: unknown } | null} input
 * @param {{ userRpc: Function, serviceRpc: Function, send: Function, mail: { domain: string },
 *           siteOrigin: string, log?: Function }} deps
 * @returns {Promise<{ status: number, body: Record<string, unknown> }>}
 */
export async function handleInvite(input, deps) {
    const log = deps.log || (() => {});
    const email = String(input?.email ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 320) return reply(400, 'invalid_email');
    const origin = inviteOrigin(deps.siteOrigin);
    if (!origin) { log({ event: 'invite_misconfigured', reason: 'site_origin' }); return reply(500, 'server'); }

    // 1) التفويض والصف بهوية المستخدم
    const inv = await deps.userRpc('company_invite_customer', { p_email: email });
    if (inv?.error) {
        const mapped = RPC_ERRORS[inv.error.code];
        if (mapped) return reply(mapped[0], mapped[1]);
        log({ event: 'invite_rpc_failed', code: inv.error.code || null });
        return reply(500, 'server');
    }
    const invitationId = inv?.data?.invitation_id;
    if (typeof invitationId !== 'string' || !invitationId) {
        log({ event: 'invite_rpc_failed', code: 'no_invitation_id' }); // 112 غير مطبَّق
        return reply(500, 'server');
    }

    // 2) التحضير بمفتاح الخدمة
    const prep = await deps.serviceRpc('_company_invitation_prepare_email', { p_invitation: invitationId, p_resend: input?.resend === true });
    if (prep?.error || !prep?.data) {
        log({ event: 'invite_prepare_failed', invitation_id: invitationId, code: prep?.error?.code || null });
        return reply(500, 'server', { invitation_id: invitationId });
    }
    if (prep.data.send !== true) {
        const reason = SKIP[prep.data.reason] !== undefined ? prep.data.reason : 'server';
        return reply(SKIP[reason] ?? 500, reason, { invitation_id: invitationId });
    }
    const { token, email: to, company_name: companyName, expires_at: expiresAt, attempt } = prep.data;
    if (!/^[0-9a-f]{64}$/.test(String(token || ''))) {
        log({ event: 'invite_prepare_failed', invitation_id: invitationId, code: 'bad_token' });
        await deps.serviceRpc('_company_invitation_email_result', { p_invitation: invitationId, p_ok: false, p_message_id: null, p_error: 'provider_error' });
        return reply(500, 'server', { invitation_id: invitationId });
    }

    // 3) الإرسال
    const link = `${origin}${INVITE_PATH}#token=${token}`;
    const content = inviteEmail({ companyName, link, expiresAt });
    let sent;
    try {
        sent = await deps.send({
            from: `مدعوم <no-reply@${deps.mail.domain}>`,
            to,
            subject: content.subject,
            html: content.html,
            text: content.text,
            idempotencyKey: `company-invite/${invitationId}/${attempt}`
        });
    } catch {
        sent = { ok: false, code: 'network', status: 0, detail: 'send threw' };
    }

    // 4) النتيجة
    const recorded = await deps.serviceRpc('_company_invitation_email_result', {
        p_invitation: invitationId, p_ok: sent.ok === true,
        p_message_id: sent.ok ? sent.id : null, p_error: sent.ok ? null : sent.code
    });
    if (recorded?.error) log({ event: 'invite_result_not_recorded', invitation_id: invitationId, code: recorded.error.code || null });

    if (sent.ok === true) return reply(200, 'sent', { invitation_id: invitationId });
    // للسجل الداخلي فقط: المعرّف ورمز الفشل ورد مختصر — لا البريد ولا الرمز ولا المفتاح
    log({ event: 'invite_email_failed', invitation_id: invitationId, code: sent.code, provider_status: sent.status, detail: sent.detail });
    return sent.code === 'not_configured'
        ? reply(503, 'not_configured', { invitation_id: invitationId })
        : reply(502, 'send_failed', { invitation_id: invitationId });
}
