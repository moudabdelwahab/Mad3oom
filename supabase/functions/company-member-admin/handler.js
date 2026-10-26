/**
 * handler.js — منطق دالة company-member-admin بلا Deno (التبعيات تُحقن؛ مُختبَر في
 * tests/company-member-admin-function.test.mjs وعبر HTTP حقيقي في tests/http/company-member-admin-http.test.mjs).
 *
 * update_account — تعديل الاسم والجوال والبريد لحساب أنشأته الشركة (113):
 *   1) company_member_account_check بهوية المدير (JWT): التفويض والأهلية والتحقق والتفرّد والحد، وطلب معلّق.
 *   2) نظام الدخول بمفتاح الخدمة (auth.admin.updateUserById): البريد (مؤكَّدًا) والاسم. بلا هذه الخطوة لا
 *      يتغير بريد الدخول، وحرّاس profiles تمنع أي جلسة من تغيير بريد غيرها وجواله، ولا تُضعَف.
 *   3) _company_member_account_apply بمفتاح الخدمة: يعيد الفحص ويكتب الملف ويُشعر العضو. إن رفض، يُعاد
 *      نظام الدخول لقيمه السابقة.
 *   4) إشعار أمني بالبريد للبريد القديم (والجديد إن تغيّر)، بلا القيم الجديدة. فشله لا يُفشل التعديل.
 *
 * password_reset — رابط إعادة كلمة المرور لبريد العضو نفسه:
 *   1) company_member_password_reset_check بهوية المدير: التفويض والمهلة والحد والسجل، ويعيد بريد الدخول.
 *   2) auth.admin.generateLink({ type: 'recovery' }) بمفتاح الخدمة، ثم Resend عبر _shared/email.js.
 *   الرابط لا يعود للمتصفح ولا يُسجَّل.
 *
 * الرد للمتصفح: status ورسالة عربية فقط. لا رابط ولا رد مزوّد ولا مفتاح ولا بريد العضو.
 */
import { passwordResetEmail, accountChangedEmail } from './template.js';

export const RESET_PATH = '/reset-password.html';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MESSAGES = Object.freeze({
    updated: 'حُفظت بيانات حساب العضو.',
    unchanged: 'لا تغيير في بيانات الحساب.',
    reset_sent: 'أُرسل رابط إعادة تعيين كلمة المرور إلى بريد العضو.',
    invalid_input: 'بيانات غير صالحة.',
    invalid_name: 'الاسم مطلوب (2 إلى 120 حرفًا).',
    invalid_phone: 'رقم الجوال غير صالح.',
    phone_required: 'رقم الجوال لا يُحذف لأنه يوثّق الحساب؛ أدخل الرقم الجديد بدلًا منه.',
    invalid_email: 'بريد إلكتروني غير صالح.',
    email_unavailable: 'لا يمكن استخدام هذا البريد لهذا الحساب.',
    phone_unavailable: 'لا يمكن استخدام هذا الرقم لهذا الحساب.',
    not_editable: 'بيانات دخول هذا العضو يعدّلها بنفسه: الحساب ليس من إنشاء شركتك أو مرتبط بجهات أخرى.',
    unauthorized: 'يجب تسجيل الدخول أولًا.',
    forbidden: 'إدارة الأعضاء متاحة لمدير الشركة فقط.',
    not_found: 'هذا الحساب ليس عضوًا في شركتك.',
    target_inactive: 'الحساب محظور على المنصة.',
    cooldown: 'أُرسل رابط لهذا العضو قبل قليل؛ انتظر 10 دقائق.',
    rate_limited: 'تجاوزت الحد اليومي لهذا الإجراء. حاول لاحقًا.',
    conflict: 'تغيّرت حالة هذا الحساب أثناء الحفظ. أعد فتح التفاصيل وحاول مجددًا.',
    send_failed: 'تعذّر إرسال البريد. يمكنك المحاولة مرة أخرى بعد 10 دقائق.',
    not_configured: 'إرسال البريد غير مهيأ حاليًا. حاول لاحقًا.',
    server: 'تعذّر تنفيذ الطلب. حاول مرة أخرى.'
});

const OK_CODES = new Set(['updated', 'unchanged', 'reset_sent']);
const reply = (status, code, extra = {}) => ({
    status,
    body: { status: code, ...(OK_CODES.has(code) ? { message: MESSAGES[code] } : { error: MESSAGES[code] || MESSAGES.server }), ...extra }
});

/** detail في خطأ RPC: نص JSON من الدالة ({"code","reason"}) — يُقرأ ولا يُعاد كما هو. */
function rpcDetail(error) {
    try { return JSON.parse(error?.details || error?.detail || 'null') || {}; } catch { return {}; }
}

/** خطأ RPC ⇒ [حالة HTTP، رمز]. */
export function mapRpcError(error) {
    const d = rpcDetail(error);
    switch (error?.code) {
        case '42501': return d.code === 'not_editable' ? [403, 'not_editable'] : [403, 'forbidden'];
        case 'P0002': return [404, 'not_found'];
        case '22023':
            return [400, { name: 'invalid_name', phone: 'invalid_phone', phone_required: 'phone_required', email: 'invalid_email', target_inactive: 'target_inactive' }[d.reason] || 'invalid_input'];
        case '23505': return [409, d.code === 'phone_unavailable' ? 'phone_unavailable' : 'email_unavailable'];
        case '54000': return [429, d.code === 'cooldown' ? 'cooldown' : 'rate_limited'];
        default: return null;
    }
}

/** أصل الموقع للرابط: https فقط، بلا مسار. */
export function siteOrigin(value) {
    try {
        const u = new URL(String(value || ''));
        return u.protocol === 'https:' ? u.origin : null;
    } catch { return null; }
}

/** خطأ نظام الدخول ⇒ رمز داخلي قصير (^[a-z_]{1,40}$). البريد المستعمل له رسالته. */
export function authErrorCode(error) {
    const code = String(error?.code || '').toLowerCase();
    const msg = String(error?.message || '').toLowerCase();
    if (code === 'email_exists' || /already (been )?registered|already exists/.test(msg)) return 'email_exists';
    if (code === 'email_address_invalid' || /invalid.*email|email.*invalid/.test(msg)) return 'email_invalid';
    return 'auth_update_failed';
}

async function rpcCall(fn, name, args, log) {
    try {
        return await fn(name, args);
    } catch (err) {
        log({ event: 'rpc_threw', rpc: name, name: err?.name || 'Error' });
        return { data: null, error: { code: 'network' } };
    }
}

async function sendSafe(deps, message) {
    try { return await deps.send(message); } catch { return { ok: false, code: 'network', status: 0, detail: 'send threw' }; }
}

async function updateAccount(input, deps, log) {
    const userId = input.user_id;
    const check = await rpcCall(deps.userRpc, 'company_member_account_check', {
        p_user: userId,
        p_full_name: String(input.full_name ?? ''),
        p_phone: input.phone == null ? null : String(input.phone),
        p_email: String(input.email ?? '')
    }, log);
    if (check?.error) {
        const mapped = mapRpcError(check.error);
        if (mapped) return reply(mapped[0], mapped[1]);
        log({ event: 'account_check_failed', code: check.error.code || null });
        return reply(500, 'server');
    }
    const c = check?.data || {};
    if (c.changed === false) return reply(200, 'unchanged');
    if (typeof c.change_id !== 'string' || !UUID_RE.test(c.change_id)) {
        log({ event: 'account_check_failed', code: 'no_change_id' }); // 113 غير مطبَّق
        return reply(500, 'server');
    }

    // 2) نظام الدخول
    const attrs = {};
    if (c.email_changed === true) { attrs.email = c.email; attrs.email_confirm = true; }
    if (c.name_changed === true) attrs.user_metadata = { full_name: c.full_name };
    const authTouched = Object.keys(attrs).length > 0;
    if (authTouched) {
        let res;
        try { res = await deps.updateAuthUser(userId, attrs); } catch (err) { res = { error: { message: err?.message || 'threw' } }; }
        if (res?.error) {
            const code = authErrorCode(res.error);
            await rpcCall(deps.serviceRpc, '_company_member_account_apply', { p_change: c.change_id, p_ok: false, p_error: code }, log);
            log({ event: 'account_auth_failed', change_id: c.change_id, code, auth_status: res.error.status ?? null });
            return code === 'email_exists' ? reply(409, 'email_unavailable')
                 : code === 'email_invalid' ? reply(400, 'invalid_email') : reply(502, 'server');
        }
    }

    // 3) الملف
    const applied = await rpcCall(deps.serviceRpc, '_company_member_account_apply', { p_change: c.change_id, p_ok: true, p_error: null }, log);
    if (applied?.error || applied?.data?.status !== 'applied') {
        log({ event: 'account_apply_failed', change_id: c.change_id, code: applied?.error?.code || applied?.data?.error || applied?.data?.status || null });
        if (authTouched) {
            // إعادة نظام الدخول لما كان: لا بريد دخول جديد بلا ملف مطابق
            const revert = {};
            if (attrs.email) { revert.email = c.old_email; revert.email_confirm = true; }
            if (attrs.user_metadata) revert.user_metadata = { full_name: c.old_full_name ?? null };
            let r;
            try { r = await deps.updateAuthUser(userId, revert); } catch { r = { error: { message: 'threw' } }; }
            if (r?.error) log({ event: 'account_auth_revert_failed', change_id: c.change_id });
        }
        return reply(409, 'conflict');
    }

    // 4) الإشعار الأمني (أفضل جهد)
    const fields = Array.isArray(applied.data.fields) ? applied.data.fields : [];
    const recipients = [...new Set([c.old_email, c.email_changed === true ? c.email : null].filter(Boolean))];
    let notice = 'skipped';
    if (recipients.length && deps.mail?.domain) {
        const content = accountChangedEmail({ companyName: applied.data.company_name, fields });
        const results = [];
        for (const [i, to] of recipients.entries()) {
            results.push(await sendSafe(deps, {
                from: `مدعوم <no-reply@${deps.mail.domain}>`, to,
                subject: content.subject, html: content.html, text: content.text,
                idempotencyKey: `member-account/${c.change_id}/${i}`
            }));
        }
        notice = results.every(r => r?.ok === true) ? 'sent' : 'failed';
        if (notice === 'failed') log({ event: 'account_notice_failed', change_id: c.change_id, codes: results.map(r => r?.code || null) });
    }
    return reply(200, 'updated', { fields, notice });
}

async function passwordReset(input, deps, log) {
    const userId = input.user_id;
    const origin = siteOrigin(deps.siteOrigin);
    if (!origin) { log({ event: 'reset_misconfigured', reason: 'site_origin' }); return reply(500, 'server'); }

    const check = await rpcCall(deps.userRpc, 'company_member_password_reset_check', { p_user: userId }, log);
    if (check?.error) {
        const mapped = mapRpcError(check.error);
        if (mapped) return reply(mapped[0], mapped[1]);
        log({ event: 'reset_check_failed', code: check.error.code || null });
        return reply(500, 'server');
    }
    const email = check?.data?.email;
    if (typeof email !== 'string' || !email.includes('@')) {
        log({ event: 'reset_check_failed', code: 'no_email' });
        return reply(500, 'server');
    }

    let link = null;
    try {
        const r = await deps.recoveryLink(email, `${origin}${RESET_PATH}`);
        link = r?.error ? null : r?.link;
        if (r?.error) log({ event: 'reset_link_failed', auth_status: r.error.status ?? null });
    } catch {
        log({ event: 'reset_link_failed', auth_status: null });
    }
    if (typeof link !== 'string' || siteOrigin(link) === null) return reply(502, 'send_failed');

    const content = passwordResetEmail({ companyName: check.data.company_name, link });
    const now = typeof deps.now === 'function' ? deps.now() : Date.now();
    const sent = await sendSafe(deps, {
        from: `مدعوم <no-reply@${deps.mail.domain}>`, to: email,
        subject: content.subject, html: content.html, text: content.text,
        idempotencyKey: `member-reset/${userId}/${Math.floor(now / 600000)}`
    });
    if (sent.ok === true) return reply(200, 'reset_sent');
    log({ event: 'reset_email_failed', code: sent.code, provider_status: sent.status, detail: sent.detail });
    return sent.code === 'not_configured' ? reply(503, 'not_configured') : reply(502, 'send_failed');
}

/**
 * @param {{ action?: unknown, user_id?: unknown, full_name?: unknown, phone?: unknown, email?: unknown } | null} input
 * @param {{ userRpc: Function, serviceRpc: Function, updateAuthUser: Function, recoveryLink: Function,
 *           send: Function, mail: { domain: string }, siteOrigin: string, now?: Function, log?: Function }} deps
 * @returns {Promise<{ status: number, body: Record<string, unknown> }>}
 */
export async function handleMemberAdmin(input, deps) {
    const log = deps.log || (() => {});
    const userId = String(input?.user_id ?? '');
    if (!UUID_RE.test(userId)) return reply(400, 'invalid_input');
    const body = { ...input, user_id: userId.toLowerCase() };
    if (input?.action === 'update_account') return updateAccount(body, deps, log);
    if (input?.action === 'password_reset') return passwordReset(body, deps, log);
    return reply(400, 'invalid_input');
}
