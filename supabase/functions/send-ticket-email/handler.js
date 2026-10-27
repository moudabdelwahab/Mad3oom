/**
 * handler.js — منطق send-ticket-email بلا Deno (التبعيات تُحقن؛ مُختبَر في tests/send-ticket-email-handler.test.mjs).
 *
 * المصادر:
 *   محفّزات القاعدة (internal_service_secrets.send_ticket_email_internal):
 *     INSERT  ← on_ticket_created  (notify_ticket_event)
 *     UPDATE  ← on_ticket_updated  (notify_ticket_event، عند تغيّر status فقط)
 *     REPLY   ← on_ticket_reply_created (notify_ticket_reply، رد غير داخلي من غير صاحب التذكرة)
 *   الأدمن/الدعم (JWT): CUSTOM من admin/send-email.html وadmin/mailbox.html.
 *
 * مصدر الحقيقة = صف التذكرة في القاعدة لا الحمولة. حمولة المحفّز تحمل ticket_id (و114 تضيف
 * previous_status وreply_id)، فيُقرأ هنا: الرقم والعنوان والحالة الحالية والتواريخ والشركة وبريد
 * صاحب التذكرة واسمه. ولذلك:
 *   - تذكرة غير موجودة (معاملة تراجعت أو حُذفت) ⇒ لا رسالة.
 *   - UPDATE وحالة التذكرة الآن غير الحالة في الحمولة ⇒ لا رسالة (تغيّرت بعده، ولتغييرها رسالته).
 *     pg_net لا يرسل الطلب إلا بعد نجاح المعاملة، وهذا الفحص يضمن أن الحالة المعروضة هي المسجَّلة.
 *   - الرد يُقرأ بمعرّفه ويُتحقق أنه لهذه التذكرة وغير داخلي ومن غير صاحبها.
 *   - المستلم = بريد صاحب التذكرة من profiles، لا customer_email من الحمولة.
 *
 * لا يرمي: { status, body } للمتصفح/المحفّز، وسجل mailbox_emails لكل محاولة كما كان.
 */
import { senderFor } from '../_shared/email.js';
import { ticketEmail, statusEventKind, normalizeLocale } from '../_shared/ticket-email.js';

export const TRIGGER_EVENTS = Object.freeze(['INSERT', 'UPDATE', 'REPLY']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** مقارنة سرّين بزمن ثابت (L-02 في FULL_PROJECT_AUDIT.md). */
export function safeEqual(a, b) {
    const x = String(a ?? ''), y = String(b ?? '');
    let diff = x.length ^ y.length;
    const n = Math.max(x.length, y.length);
    for (let i = 0; i < n; i++) diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
    return diff === 0 && x.length > 0;
}

/** اسم المخاطبة: الاسم الكامل، وإلا الأول والأخير، وإلا لا اسم (لا «عميلنا العزيز» مع بريد حقيقي). */
export function recipientName(profile) {
    const full = String(profile?.full_name || '').trim();
    if (full) return full;
    return [profile?.first_name, profile?.last_name].map(v => String(v || '').trim()).filter(Boolean).join(' ');
}

const ok = (body) => ({ status: 200, body: { success: true, ...body } });
const skipped = (reason) => ({ status: 200, body: { success: true, skipped: reason } });
const fail = (status, error) => ({ status, body: { error } });

/**
 * @typedef {{
 *   getTicket: (id: string) => Promise<object|null>,
 *   getProfile: (id: string) => Promise<{ email?: string, full_name?: string, first_name?: string, last_name?: string }|null>,
 *   getCompanyName: (ticket: object) => Promise<string|null>,
 *   getReply: (id: string) => Promise<{ id: string, ticket_id: string, user_id: string, message: string, is_internal: boolean }|null>,
 * }} TicketData
 *
 * @param {Record<string, any>} payload
 * @param {{ data: TicketData, send: Function, mail: { defaultFrom: string, configured: boolean, domain: string },
 *           logMailbox?: Function, siteOrigin?: string, logoUrl?: string, timeZone?: string, log?: Function, now?: Date }} deps
 * @returns {Promise<{ status: number, body: Record<string, unknown> }>}
 */
export async function handleTicketEmail(payload, deps) {
    const log = deps.log || (() => {});
    const event = String(payload?.event || '');
    if (event !== 'CUSTOM' && !TRIGGER_EVENTS.includes(event)) return fail(400, 'نوع الحدث غير معروف');
    if (!deps.mail?.configured) return fail(400, 'RESEND_API_KEY is not configured in environment variables');

    let from = deps.mail.defaultFrom;
    if (payload?.from_email) {
        // صناديق المنصة المعروفة على نطاق الإرسال المضبوط (القيم القديمة @mad3oom.online تُقبل)
        const allowed = senderFor(payload.from_email, deps.mail);
        if (!allowed) return fail(400, 'عنوان المرسل غير مسموح به');
        from = allowed;
    }

    const common = { locale: normalizeLocale(payload?.locale), siteOrigin: deps.siteOrigin, logoUrl: deps.logoUrl,
                     timeZone: deps.timeZone, now: deps.now };
    let to, content, relatedUserId = null, textBody = null, idempotencyKey;

    if (event === 'CUSTOM') {
        // رسالة يكتبها الأدمن/الدعم بنفسه (المسار القديم كما هو) داخل قالب الهوية الموحّد
        to = String(payload?.customer_email || '').trim();
        if (!to) return fail(400, 'Customer email is missing');
        content = ticketEmail({ ...common, event: 'custom', subject: payload?.subject,
                                recipientName: payload?.customer_name && payload.customer_name !== to ? payload.customer_name : '',
                                messageHtml: payload?.message || '' });
        relatedUserId = payload?.related_user_id || null;
        textBody = payload?.message || null;
    } else {
        const ticketId = String(payload?.ticket_id || '');
        if (!UUID_RE.test(ticketId)) return fail(400, 'ticket_id is missing');

        const ticket = await deps.data.getTicket(ticketId);
        if (!ticket) {
            log({ event: 'ticket_email_skipped', reason: 'ticket_not_found', ticket_id: ticketId, trigger: event });
            return skipped('ticket_not_found');
        }
        if (event === 'UPDATE' && payload?.status && ticket.status !== payload.status) {
            log({ event: 'ticket_email_skipped', reason: 'stale_status', ticket_id: ticketId });
            return skipped('stale_status');
        }

        const owner = await deps.data.getProfile(ticket.user_id);
        to = String(owner?.email || '').trim();
        if (!to) {
            log({ event: 'ticket_email_skipped', reason: 'no_recipient', ticket_id: ticketId });
            return skipped('no_recipient');
        }
        relatedUserId = ticket.user_id;

        let kind = 'created', replyText = null;
        if (event === 'UPDATE') {
            kind = statusEventKind(payload?.previous_status || null, ticket.status);
        } else if (event === 'REPLY') {
            kind = 'reply';
            if (payload?.reply_id) {
                const reply = UUID_RE.test(String(payload.reply_id)) ? await deps.data.getReply(String(payload.reply_id)) : null;
                if (!reply || reply.ticket_id !== ticket.id || reply.is_internal === true || reply.user_id === ticket.user_id) {
                    log({ event: 'ticket_email_skipped', reason: 'reply_not_public', ticket_id: ticketId });
                    return skipped('reply_not_public');
                }
                replyText = reply.message;
                idempotencyKey = `ticket-reply/${reply.id}`;
            } else {
                // محفّز ما قبل 114: نص الرد في الحمولة (يُهرَّب في القالب)
                replyText = payload?.message || '';
            }
            textBody = replyText || null;
        } else {
            idempotencyKey = `ticket-created/${ticket.id}`;
        }

        let companyName = null;
        try { companyName = await deps.data.getCompanyName(ticket); } catch { companyName = null; }

        content = ticketEmail({ ...common, event: kind, ticket, companyName, recipientName: recipientName(owner), replyText });
    }

    const attachments = Array.isArray(payload?.attachments)
        ? payload.attachments.filter(a => a && a.filename && a.content) : [];
    let sent;
    try {
        sent = await deps.send({
            from, to, subject: content.subject, html: content.html, text: content.text,
            ...(attachments.length ? { attachments: attachments.map(a => ({ filename: a.filename, content: a.content })) } : {}),
            ...(idempotencyKey ? { idempotencyKey } : {})
        });
    } catch {
        sent = { ok: false, code: 'network', status: 0, detail: 'send threw' };
    }
    const result = sent.ok ? { id: sent.id } : { code: sent.code, status: sent.status, detail: sent.detail };

    if (deps.logMailbox) {
        await deps.logMailbox({
            direction: 'outbound', from_email: from, to_email: to, subject: content.subject, html_body: content.html,
            text_body: textBody, status: sent.ok ? 'sent' : 'failed',
            provider_message_id: sent.ok ? sent.id : null,
            attachments: attachments.map(a => ({ filename: a.filename, content_type: a.type || null })),
            related_user_id: relatedUserId,
            ...(sent.ok ? { is_read: true } : { error_message: JSON.stringify(result) })
        });
    }

    if (!sent.ok) {
        log({ event: 'ticket_email_failed', trigger: event, ticket_id: payload?.ticket_id || null, code: sent.code, provider_status: sent.status });
        return fail(400, `Resend API error: ${sent.code}`);
    }
    return ok({ data: result });
}
