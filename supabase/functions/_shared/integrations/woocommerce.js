// ============================================================================
// woocommerce.js — موصل ووكومرس (REST API v3).
//
// المصدر الرسمي (مقروء من مستودع woocommerce/woocommerce-rest-api-docs ومن
// class-wc-webhook.php في woocommerce/woocommerce، 2026-10):
//   • المتطلبات: WooCommerce 3.5+ و WordPress 4.4+.
//   • المصادقة عبر HTTPS: Basic auth، المستخدم = Consumer Key، كلمة المرور =
//     Consumer Secret. المفاتيح ck_/cs_ + 40 محرف hex (wc_rand_hash).
//   • GET /wp-json/wc/v3/orders/<id> ، GET /wp-json/wc/v3/orders?search=&per_page=
//   • الويب هوك: X-WC-Webhook-Signature = base64(HMAC-SHA256(الجسم الخام، السر)).
//     X-WC-Webhook-Topic مثل order.updated. عند إنشاء الويب هوك يُرسل ping
//     بجسم «webhook_id=<n>» ويجب أن يرجع 200 وإلا يفشل الحفظ.
//     ووكومرس يعطّل الويب هوك بعد أكثر من 5 إخفاقات متتالية.
//
// ما نأخذه من الطلب: قائمة سماح ضيقة. لا عناوين، ولا هاتف، ولا IP، ولا
// معرّف معاملة، ولا meta_data، ولا ملاحظات. البريد مقنّع فقط.
// ============================================================================

import { defineConnector, unsupported, recordShape, shortText, amountText, isoUtc } from './contract.js';
import { ConnectorError, codeForStatus } from './errors.js';
import { safeFetch, validateExternalUrl } from './http.js';
import { hmacSha256, bytesToB64, timingSafeEqual, randomToken, sha256Hex } from './crypto.js';
import { maskEmail } from './redact.js';

const KEY_RE = /^ck_[a-f0-9]{32,64}$/i;
const SECRET_RE = /^cs_[a-f0-9]{32,64}$/i;
export const WEBHOOK_TOPICS = Object.freeze(['order.created', 'order.updated']);
const ORDER_STATUSES = new Set(['pending', 'processing', 'on-hold', 'completed', 'cancelled', 'refunded', 'failed', 'trash',
                                'checkout-draft']);

function authHeader(credentials) {
    return 'Basic ' + btoa(`${credentials.consumer_key}:${credentials.consumer_secret}`);
}

function api(base, path) {
    return `${base}/wp-json/wc/v3${path}`;
}

export function normalizeConnectInput(input = {}) {
    const baseUrl = validateExternalUrl(input.store_url);
    const key = String(input.consumer_key || '').trim();
    const secret = String(input.consumer_secret || '').trim();
    if (!KEY_RE.test(key) || !SECRET_RE.test(secret)) throw new ConnectorError('invalid_input', 'key_format');
    return {
        baseUrl,
        externalAccountId: baseUrl.toLowerCase() + '/',
        label: shortText(input.label, 120) || new URL(baseUrl).hostname,
        credentials: { consumer_key: key, consumer_secret: secret, webhook_secret: randomToken(32) }
    };
}

async function getJson(ctx, path) {
    const res = await safeFetch(ctx.fetch, api(ctx.baseUrl, path), {
        headers: { Authorization: authHeader(ctx.credentials), Accept: 'application/json' }
    });
    return res;
}

async function verifyConnection(ctx) {
    const res = await getJson(ctx, '/orders?per_page=1');
    if (res.status === 200 && Array.isArray(res.json)) return { ok: true };
    if (res.status === 404) throw new ConnectorError('api_not_found');
    throw new ConnectorError(codeForStatus(res.status));
}

/** ملخص الطلب بقائمة السماح. */
export function mapOrder(order, baseUrl) {
    if (!order || typeof order !== 'object' || !Number.isInteger(order.id) || order.id <= 0) {
        throw new ConnectorError('invalid_response', 'order');
    }
    const items = Array.isArray(order.line_items) ? order.line_items : [];
    const status = ORDER_STATUSES.has(order.status) ? order.status : shortText(order.status, 30);
    const customerName = shortText([order.billing?.first_name, order.billing?.last_name].filter(Boolean).join(' '), 80);
    return recordShape({
        recordType: 'order',
        externalId: String(order.id),
        displayRef: `#${shortText(order.number, 40) || order.id}`,
        summary: {
            number: shortText(order.number, 40),
            status,
            currency: /^[A-Z]{3}$/.test(order.currency || '') ? order.currency : null,
            total: amountText(order.total),
            created_at: isoUtc(order.date_created_gmt),
            paid_at: isoUtc(order.date_paid_gmt),
            completed_at: isoUtc(order.date_completed_gmt),
            payment_method_title: shortText(order.payment_method_title, 60),
            customer_name: customerName,
            customer_email_masked: maskEmail(order.billing?.email),
            customer_ref: Number.isInteger(order.customer_id) && order.customer_id > 0 ? String(order.customer_id) : null,
            guest: order.customer_id === 0 ? true : null,
            item_count: items.reduce((n, i) => n + (Number.isInteger(i?.quantity) ? i.quantity : 0), 0) || null,
            items: items.slice(0, 10).map((i) => ({ name: shortText(i?.name, 80), quantity: Number.isInteger(i?.quantity) ? i.quantity : null }))
                        .filter((i) => i.name),
            refunded: Array.isArray(order.refunds) && order.refunds.length > 0 ? true : null
        },
        externalUrl: `${baseUrl}/wp-admin/post.php?post=${order.id}&action=edit`,
        sourceUpdatedAt: isoUtc(order.date_modified_gmt)
    });
}

/** المرجع رقم الطلب كما يراه العميل؛ يُجرّب كمعرّف ثم يُبحث برقمه المعروض. */
async function fetchOrder(ctx, reference) {
    const ref = String(reference ?? '').trim().replace(/^#/, '');
    if (!/^[0-9]{1,20}$/.test(ref)) throw new ConnectorError('invalid_input', 'order_ref');

    const direct = await getJson(ctx, `/orders/${ref}`);
    if (direct.status === 200) return mapOrder(direct.json, ctx.baseUrl);
    if (direct.status !== 404) throw new ConnectorError(codeForStatus(direct.status));

    // إضافات الترقيم المتسلسل تجعل «رقم الطلب» غير المعرّف: نطابق number حرفيًا
    const search = await getJson(ctx, `/orders?search=${encodeURIComponent(ref)}&per_page=10`);
    if (search.status !== 200) throw new ConnectorError(codeForStatus(search.status));
    const match = (Array.isArray(search.json) ? search.json : []).filter((o) => String(o?.number) === ref);
    if (match.length !== 1) throw new ConnectorError('not_found');
    return mapOrder(match[0], ctx.baseUrl);
}

/**
 * يتحقق من ويب هوك ووكومرس ويرجع حدثًا موحّدًا، أو { ping: true }.
 * rawBody: Uint8Array كما وصل. لا يُقرأ JSON قبل التحقق من التوقيع.
 */
async function handleWebhook(ctx, { headers, rawBody }) {
    const signature = headers.get('x-wc-webhook-signature');
    const text = new TextDecoder().decode(rawBody);
    if (!signature) {
        // ping الإنشاء: بلا توقيع، بجسم ثابت الشكل، ولا أثر له إطلاقًا
        if (/^webhook_id=\d{1,12}$/.test(text)) return { ping: true };
        throw new ConnectorError('signature_invalid', 'missing');
    }
    const expected = bytesToB64(await hmacSha256(ctx.credentials.webhook_secret, rawBody));
    if (!timingSafeEqual(signature.trim(), expected)) throw new ConnectorError('signature_invalid');

    const topic = String(headers.get('x-wc-webhook-topic') || '');
    if (!WEBHOOK_TOPICS.includes(topic)) return { ignored: true, topic: topic.slice(0, 80) || 'unknown' };

    let order;
    try { order = JSON.parse(text); } catch { throw new ConnectorError('invalid_payload', 'json'); }
    const record = mapOrder(order, ctx.baseUrl);
    return {
        topic,
        externalType: 'order',
        externalId: record.external_id,
        sourceUpdatedAt: record.source_updated_at,
        dedupeKey: await sha256Hex(`woocommerce|${topic}|${record.external_id}|${record.source_updated_at}|${await sha256Hex(rawBody)}`),
        record
    };
}

export const woocommerce = defineConnector({
    key: 'woocommerce',
    authKind: 'api_key_pair',
    linkTypes: ['order'],
    normalizeConnectInput,
    operations: {
        connect: async (ctx) => verifyConnection(ctx),
        verifyConnection,
        refreshCredentials: unsupported('WooCommerce REST keys do not expire; rotate them in WooCommerce and reconnect'),
        disconnect: unsupported('WooCommerce has no REST endpoint to revoke a key; the merchant revokes it under WooCommerce > Settings > Advanced > REST API'),
        fetchCustomer: unsupported('not needed for the first release; customers are linked explicitly by id'),
        fetchOrder,
        fetchInvoice: unsupported('WooCommerce core has no invoice resource'),
        handleWebhook,
        syncRecords: unsupported('by design: only orders linked to a ticket are cached; no store-wide sync'),
        getHealthStatus: verifyConnection
    }
});
