// ============================================================================
// wordpress.js — اقتران إضافة «مدعوم» لووردبريس.
//
// الاتجاه معكوس: الإضافة هي من تنادي مدعوم (لا نستدعي الموقع أبدًا، فلا SSRF).
//
// الاقتران: مدير الشركة ينشئ ربط ووردبريس في مدعوم ⇒ رمز اقتران يُعرض مرة
// واحدة:  m3c1.<base64url(JSON {v, c: connection_id, s: secret, e: endpoint})>
// يلصقه في إعدادات الإضافة. السر يُخزَّن مشفّرًا عندنا، وفي خيار ووردبريس غير
// محمَّل تلقائيًا عند الموقع، ولا يصل للمتصفح في أي طرف.
//
// كل طلب من الإضافة موقَّع:
//   canonical = ts \n nonce \n METHOD \n path \n sha256hex(body)
//   X-Mad3oom-Signature = base64(HMAC-SHA256(secret, canonical))
// مع X-Mad3oom-Connection و X-Mad3oom-Timestamp (ثوانٍ) و X-Mad3oom-Nonce.
// نافذة الزمن ±300 ثانية، والـnonce لمرة واحدة (ihub_svc_use_nonce).
// ============================================================================

import { defineConnector, unsupported, shortText } from './contract.js';
import { ConnectorError } from './errors.js';
import { validateExternalUrl } from './http.js';
import { hmacSha256, bytesToB64, timingSafeEqual, sha256Hex, randomToken, bytesToB64Url, b64UrlToBytes } from './crypto.js';

export const CLOCK_SKEW_SECONDS = 300;
export const PAIRING_PREFIX = 'm3c1.';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizeConnectInput(input = {}) {
    const baseUrl = validateExternalUrl(input.site_url);
    return {
        baseUrl,
        externalAccountId: baseUrl.toLowerCase() + '/',
        label: shortText(input.label, 120) || new URL(baseUrl).hostname,
        credentials: { site_secret: randomToken(32) }
    };
}

export function pairingCode({ connectionId, secret, endpoint }) {
    const json = JSON.stringify({ v: 1, c: connectionId, s: secret, e: endpoint });
    return PAIRING_PREFIX + bytesToB64Url(new TextEncoder().encode(json));
}

export function parsePairingCode(code) {
    const s = String(code || '').trim();
    if (!s.startsWith(PAIRING_PREFIX)) return null;
    try {
        const obj = JSON.parse(new TextDecoder().decode(b64UrlToBytes(s.slice(PAIRING_PREFIX.length))));
        return obj && obj.v === 1 && UUID_RE.test(obj.c) && typeof obj.s === 'string' ? obj : null;
    } catch {
        return null;
    }
}

export async function canonicalString({ timestamp, nonce, method, path, rawBody }) {
    return `${timestamp}\n${nonce}\n${String(method).toUpperCase()}\n${path}\n${await sha256Hex(rawBody)}`;
}

export async function signRequest(secret, parts) {
    return bytesToB64(await hmacSha256(secret, await canonicalString(parts)));
}

/** يقرأ ترويسات الإضافة دون تحقق (لتحديد الربط وقراءة سرّه). */
export function readSignedHeaders(headers) {
    const connectionId = String(headers.get('x-mad3oom-connection') || '').trim();
    const timestamp = String(headers.get('x-mad3oom-timestamp') || '').trim();
    const nonce = String(headers.get('x-mad3oom-nonce') || '').trim();
    const signature = String(headers.get('x-mad3oom-signature') || '').trim();
    if (!UUID_RE.test(connectionId) || !/^[0-9]{9,11}$/.test(timestamp)
        || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce) || !signature) {
        throw new ConnectorError('signature_invalid', 'headers');
    }
    return { connectionId, timestamp, nonce, signature };
}

/** التحقق من التوقيع والزمن. الـnonce يُستهلك بعده في القاعدة. */
export async function verifySignedRequest({ secret, nowMs }, { headers, method, path, rawBody }) {
    const h = readSignedHeaders(headers);
    const skew = Math.abs(Math.floor(nowMs / 1000) - Number(h.timestamp));
    if (skew > CLOCK_SKEW_SECONDS) throw new ConnectorError('signature_invalid', 'clock');
    const expected = await signRequest(secret, { timestamp: h.timestamp, nonce: h.nonce, method, path, rawBody });
    if (!timingSafeEqual(h.signature, expected)) throw new ConnectorError('signature_invalid');
    return h;
}

/** حقول طلب الدعم من الإضافة — نفس قيود ihub_intake_requests. */
export function validateIntake(body) {
    const name = shortText(body?.name, 120);
    const email = String(body?.email || '').trim().toLowerCase();
    const subject = shortText(body?.subject, 200);
    const message = String(body?.message || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
    const orderRef = body?.order_ref === undefined || body?.order_ref === null || body?.order_ref === ''
        ? null : String(body.order_ref).trim();
    const siteUserRef = body?.site_user_ref ? String(body.site_user_ref).trim().toLowerCase() : null;
    if (!name || !subject || !message || message.length > 5000) throw new ConnectorError('invalid_payload', 'fields');
    if (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ConnectorError('invalid_payload', 'email');
    if (orderRef !== null && !/^[0-9]{1,20}$/.test(orderRef)) throw new ConnectorError('invalid_payload', 'order_ref');
    if (siteUserRef !== null && !/^[0-9a-f]{64}$/.test(siteUserRef)) throw new ConnectorError('invalid_payload', 'site_user_ref');
    return { name, email, subject, message, orderRef, siteUserRef };
}

export const wordpress = defineConnector({
    key: 'wordpress',
    authKind: 'site_pairing',
    linkTypes: [],
    normalizeConnectInput,
    operations: {
        // الاقتران لا يحتاج نداءً للموقع: الرمز يُعرض مرة واحدة ويُلصق في الإضافة
        connect: async () => ({ ok: true }),
        verifyConnection: unsupported('Mad3oom never calls the site; health is the last signed request received from the plugin'),
        refreshCredentials: unsupported('rotate the pairing secret instead (rotate_secret)'),
        disconnect: unsupported('disconnecting deletes the server-side secret, which invalidates the plugin immediately; no site call is made'),
        fetchCustomer: unsupported('WordPress users are not Mad3oom customers and are never merged'),
        fetchOrder: unsupported('orders come from the WooCommerce connection'),
        fetchInvoice: unsupported('WordPress has no invoice resource; invoices come from Daftra'),
        handleWebhook: unsupported('the plugin uses signed requests (ping, intake), not webhooks'),
        syncRecords: unsupported('nothing is synchronised from the site; the plugin only sends signed requests'),
        getHealthStatus: unsupported('health is the timestamp of the last verified plugin request')
    }
});
