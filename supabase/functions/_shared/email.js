/**
 * email.js — إرسال البريد عبر Resend لكل دوال Edge (وحدة خالصة بلا Deno، مُختبَرة في tests/email-shared.test.mjs).
 *
 * إعداد واحد للجميع (أسرار دوال Edge في Supabase، لا في المستودع):
 *   RESEND_API_KEY       مفتاح Resend. تدويره = استبدال قيمته في مكانه؛ لا اسم ثانٍ.
 *   EMAIL_SENDER_DOMAIN  نطاق الإرسال الموثَّق في Resend (مثل mad3oom.com). اختياري.
 *   EMAIL_FROM           المرسل الافتراضي (مثل «info@mad3oom.com»). اختياري.
 *
 * نطاق الإرسال = EMAIL_SENDER_DOMAIN، وإلا نطاق EMAIL_FROM، وإلا mad3oom.online: النطاق الذي أثبت
 * سجل mailbox_emails أنه يُسلَّم (98 رسالة حتى 2026-10-09). لا يُفترض أن mad3oom.com موثَّق في Resend:
 * يُضبط EMAIL_SENDER_DOMAIN بعد توثيقه فقط.
 *
 * صناديق المرسل المعروفة (support، no-reply، info، tickets) على أيٍّ من النطاقين تُرسَل من النطاق
 * المضبوط؛ فقيم from المحفوظة في سير العمل وفي الواجهات القديمة (@mad3oom.online) تبقى صالحة.
 *
 * sendEmail لا يرمي ولا يعيد المفتاح ولا نص رد المزوّد كاملًا: { ok, id } أو { ok:false, code, status, detail }.
 * detail مختصر للسجلات الداخلية وحدها؛ لا يُعاد للمتصفح.
 */
export const RESEND_API_URL = 'https://api.resend.com/emails';
export const LEGACY_SENDER_DOMAIN = 'mad3oom.online';
export const KNOWN_SENDER_DOMAINS = Object.freeze(['mad3oom.online', 'mad3oom.com']);
export const SENDER_MAILBOXES = Object.freeze(['support', 'no-reply', 'info', 'tickets']);
export const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/** «الاسم <a@b>» أو «a@b» ⇒ { name, address } بأحرف صغيرة للعنوان، أو null. */
export function parseAddress(value) {
    const v = String(value || '').trim();
    const m = v.match(/^(.*)<([^<>]+)>$/);
    const name = m ? m[1].trim().replace(/^"|"$/g, '') : '';
    const address = (m ? m[2] : v).trim().toLowerCase();
    return EMAIL_RE.test(address) && address.length <= 320 ? { name, address } : null;
}

const domainOf = (value) => parseAddress(value)?.address.split('@')[1] || null;

/**
 * @typedef {{ apiKey: string, domain: string, defaultFrom: string, configured: boolean }} EmailConfig
 * @typedef {{ ok: true, id: string, status: number } | { ok: false, code: string, status: number, detail: string }} SendResult
 */

/**
 * الإعداد من متغيرات البيئة. get(name) ⇒ القيمة أو undefined (Deno.env.get في الدوال).
 * @param {(name: string) => (string | undefined)} get
 * @returns {EmailConfig}
 */
export function emailConfig(get) {
    const read = (k) => String((typeof get === 'function' ? get(k) : undefined) ?? '').trim();
    const explicit = read('EMAIL_SENDER_DOMAIN').toLowerCase();
    const domain = DOMAIN_RE.test(explicit) ? explicit : (domainOf(read('EMAIL_FROM')) || LEGACY_SENDER_DOMAIN);
    const fromEnv = parseAddress(read('EMAIL_FROM'));
    return Object.freeze({
        apiKey: read('RESEND_API_KEY'),
        domain,
        defaultFrom: fromEnv && fromEnv.address.endsWith(`@${domain}`) ? read('EMAIL_FROM') : `info@${domain}`,
        configured: read('RESEND_API_KEY').length > 0
    });
}

/**
 * عنوان مرسل مسموح على نطاق الإرسال المضبوط، أو null.
 * @param {unknown} value
 * @param {EmailConfig} config
 * @returns {string | null}
 * يقبل صندوقًا معروفًا على أي نطاق معروف أو النطاق المضبوط، ويحفظ اسم العرض.
 */
export function senderFor(value, config) {
    const parsed = parseAddress(value);
    if (!parsed) return null;
    const [local, domain] = parsed.address.split('@');
    if (!SENDER_MAILBOXES.includes(local)) return null;
    if (!KNOWN_SENDER_DOMAINS.includes(domain) && domain !== config.domain) return null;
    const address = `${local}@${config.domain}`;
    return parsed.name ? `${parsed.name} <${address}>` : address;
}

const CODE_BY_STATUS = { 400: 'rejected', 401: 'auth', 403: 'auth', 404: 'rejected', 409: 'idempotency_conflict',
                         422: 'rejected', 429: 'rate_limited' };

/** نص مختصر لرد المزوّد للسجل الداخلي (الاسم والرسالة، 300 حرف). */
function providerDetail(body, status) {
    const name = typeof body?.name === 'string' ? body.name : '';
    const message = typeof body?.message === 'string' ? body.message : '';
    return `${status}${name ? ` ${name}` : ''}${message ? `: ${message}` : ''}`.slice(0, 300);
}

/**
 * إرسال رسالة واحدة. لا يرمي أبدًا.
 * @param {{ from: string, to: string | string[], subject: string, html?: string, text?: string,
 *           replyTo?: string, attachments?: unknown[], idempotencyKey?: string }} message
 * @param {{ config?: EmailConfig, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<SendResult>}
 */
export async function sendEmail(message, { config, fetchImpl = globalThis.fetch } = {}) {
    if (!config?.configured) return { ok: false, code: 'not_configured', status: 0, detail: 'RESEND_API_KEY missing' };
    const recipients = [].concat(message?.to || []).map(parseAddress);
    if (!recipients.length || recipients.some(r => !r)) return { ok: false, code: 'invalid_recipient', status: 0, detail: 'invalid to' };
    if (!message.from || !String(message.subject || '').trim() || !(message.html || message.text)) {
        return { ok: false, code: 'invalid_message', status: 0, detail: 'from, subject and body are required' };
    }
    const body = {
        from: message.from,
        to: recipients.map(r => r.address),
        subject: String(message.subject).slice(0, 998),
        ...(message.html ? { html: message.html } : {}),
        ...(message.text ? { text: message.text } : {}),
        ...(message.replyTo ? { reply_to: message.replyTo } : {}),
        ...(Array.isArray(message.attachments) && message.attachments.length ? { attachments: message.attachments } : {})
    };
    const headers = { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' };
    if (message.idempotencyKey) headers['Idempotency-Key'] = String(message.idempotencyKey).slice(0, 256);

    let res;
    try {
        res = await fetchImpl(RESEND_API_URL, { method: 'POST', headers, body: JSON.stringify(body) });
    } catch (err) {
        return { ok: false, code: 'network', status: 0, detail: String(err?.name || 'fetch failed').slice(0, 100) };
    }
    let json = null;
    try { json = await res.json(); } catch { /* رد بلا JSON */ }
    if (res.ok && typeof json?.id === 'string' && json.id) return { ok: true, id: json.id, status: res.status };
    if (res.ok) return { ok: false, code: 'provider_error', status: res.status, detail: 'accepted without id' };
    return {
        ok: false,
        code: CODE_BY_STATUS[res.status] || (res.status >= 500 ? 'provider_error' : 'rejected'),
        status: res.status,
        detail: providerDetail(json, res.status)
    };
}
