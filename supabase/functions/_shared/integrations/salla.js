// ============================================================================
// salla.js — موصل سلة (Merchant API v2 + OAuth 2.0).
//
// ما تحقّقنا منه من مصادر سلة الرسمية (2026-10):
//   • SallaApp/oauth2-merchant (Provider/Salla.php, SallaUser.php, README):
//       تفويض  https://accounts.salla.sa/oauth2/auth
//       الرمز   https://accounts.salla.sa/oauth2/token
//       المالك  https://accounts.salla.sa/oauth2/user/info  ← { data: { id, merchant: { id, name, ... } } }
//       النطاقات مفصولة بفاصلة؛ offline_access مطلوب للحصول على refresh token.
//       رمز الوصول ينتهي بعد 14 يومًا.  الـAPI: https://api.salla.dev/admin/v2/...
//   • SallaApp/laravel-starter-kit: جسم الويب هوك { event, merchant, created_at, data }.
//   • SallaApp/express-starter-kit: أسماء الأحداث (order.created, order.updated,
//     order.status.updated, ...)، ونمطا التفويض Easy و Custom.
//   • docs.salla.dev (عبر البحث فقط — النطاق محجوب في هذه البيئة): استراتيجية
//     «Signature» افتراضية، والترويسات X-Salla-Security-Strategy و X-Salla-Signature
//     وهي SHA256 للجسم بسر الويب هوك.
//
// غير مُتحقَّق (موثّق في PROVIDER_SALLA.md، ويُحسم على متجر تجريبي):
//   • ترميز X-Salla-Signature (hex أم base64) — نقبل الاثنين لنفس HMAC؛ كلاهما
//     يتطلب السر، فلا يُضعف ذلك التحقق.
//   • أسماء حقول الطلب في /admin/v2/orders/{id} — الربط متسامح بقائمة سماح.
//   • نقطة إلغاء الرمز — لا نستدعي شيئًا غير موثّق؛ الإلغاء = إزالة التطبيق من سلة.
//   • هل refresh token لمرة واحدة — نفترض ذلك: كاتب تجديد واحد فقط (العامل).
//
// نمط التفويض المستخدم: Custom (رابط عودة). نمط Easy يسلّم الرموز في ويب هوك
// app.store.authorize بلا state، فلا يمكن ربطه بشركة بعينها بأمان — نتجاهله.
// ============================================================================

import { defineConnector, unsupported, recordShape, shortText, amountText, isoUtc } from './contract.js';
import { ConnectorError, codeForStatus } from './errors.js';
import { safeFetch } from './http.js';
import { hmacSha256, bytesToB64, bytesToHex, timingSafeEqual, sha256Hex } from './crypto.js';
import { maskEmail } from './redact.js';

export const SALLA_AUTH_URL = 'https://accounts.salla.sa/oauth2/auth';
export const SALLA_TOKEN_URL = 'https://accounts.salla.sa/oauth2/token';
export const SALLA_USER_URL = 'https://accounts.salla.sa/oauth2/user/info';
export const SALLA_API = 'https://api.salla.dev/admin/v2';
export const ORDER_EVENTS = Object.freeze(['order.created', 'order.updated', 'order.status.updated']);
export const REVOKE_EVENTS = Object.freeze(['app.uninstalled']);

export function authorizeUrl({ clientId, redirectUri, state }) {
    if (!clientId || !redirectUri || !state) throw new ConnectorError('not_configured');
    const u = new URL(SALLA_AUTH_URL);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', clientId);
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('scope', 'offline_access');
    u.searchParams.set('state', state);
    return u.toString();
}

function tokenPayload(json, nowMs) {
    const access = json?.access_token;
    const refresh = json?.refresh_token;
    const expiresIn = Number(json?.expires_in);
    if (typeof access !== 'string' || access.length < 10) throw new ConnectorError('invalid_response', 'access_token');
    if (typeof refresh !== 'string' || refresh.length < 10) throw new ConnectorError('invalid_response', 'refresh_token');
    const ttl = Number.isFinite(expiresIn) && expiresIn > 60 ? expiresIn : 14 * 24 * 3600;
    return {
        access_token: access,
        refresh_token: refresh,
        expires_at: new Date(nowMs + ttl * 1000).toISOString(),
        scope: typeof json.scope === 'string' ? json.scope.slice(0, 500) : null
    };
}

async function tokenRequest(fetchImpl, params, nowMs) {
    const res = await safeFetch(fetchImpl, SALLA_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams(params).toString()
    });
    if (res.status === 400 || res.status === 401) throw new ConnectorError('auth_failed');
    if (res.status !== 200) throw new ConnectorError(codeForStatus(res.status));
    return tokenPayload(res.json, nowMs);
}

export async function exchangeCode({ fetch, env, now = Date.now }, code) {
    if (!/^[A-Za-z0-9._~+/=-]{8,2048}$/.test(String(code || ''))) throw new ConnectorError('invalid_input', 'code');
    if (!env.SALLA_CLIENT_ID || !env.SALLA_CLIENT_SECRET || !env.SALLA_REDIRECT_URI) throw new ConnectorError('not_configured');
    return tokenRequest(fetch, {
        grant_type: 'authorization_code', code, client_id: env.SALLA_CLIENT_ID,
        client_secret: env.SALLA_CLIENT_SECRET, redirect_uri: env.SALLA_REDIRECT_URI
    }, now());
}

async function refreshCredentials(ctx) {
    const { env } = ctx;
    if (!env.SALLA_CLIENT_ID || !env.SALLA_CLIENT_SECRET) throw new ConnectorError('not_configured');
    if (!ctx.credentials?.refresh_token) throw new ConnectorError('token_expired');
    return tokenRequest(ctx.fetch, {
        grant_type: 'refresh_token', refresh_token: ctx.credentials.refresh_token,
        client_id: env.SALLA_CLIENT_ID, client_secret: env.SALLA_CLIENT_SECRET
    }, (ctx.now || Date.now)());
}

export async function fetchMerchant({ fetch }, accessToken) {
    const res = await safeFetch(fetch, SALLA_USER_URL, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
    });
    if (res.status !== 200) throw new ConnectorError(codeForStatus(res.status));
    const merchantId = res.json?.data?.merchant?.id;
    if (!(Number.isInteger(merchantId) || /^[0-9]{1,20}$/.test(String(merchantId ?? '')))) {
        throw new ConnectorError('invalid_response', 'merchant');
    }
    return {
        externalAccountId: String(merchantId),
        label: shortText(res.json.data.merchant.name, 120) || `Salla ${merchantId}`
    };
}

function bearer(ctx) {
    const c = ctx.credentials || {};
    if (!c.access_token) throw new ConnectorError('token_expired');
    if (c.expires_at && Date.parse(c.expires_at) <= (ctx.now || Date.now)()) throw new ConnectorError('token_expired');
    return `Bearer ${c.access_token}`;
}

async function verifyConnection(ctx) {
    const res = await safeFetch(ctx.fetch, SALLA_USER_URL, { headers: { Authorization: bearer(ctx), Accept: 'application/json' } });
    if (res.status === 200 && res.json?.data?.merchant?.id !== undefined) {
        if (ctx.externalAccountId && String(res.json.data.merchant.id) !== String(ctx.externalAccountId)) {
            throw new ConnectorError('auth_failed', 'merchant_changed');
        }
        return { ok: true };
    }
    throw new ConnectorError(codeForStatus(res.status));
}

/**
 * ربط متسامح بقائمة سماح. أسماء الحقول غير مُتحقَّقة من وثيقة رسمية (انظر
 * الرأس): كل حقل يُقرأ فقط إن كان بالشكل المتوقع، وإلا يُهمَل — لا نعرض
 * قيمة مخمَّنة.
 */
export function mapOrder(order) {
    if (!order || typeof order !== 'object') throw new ConnectorError('invalid_response', 'order');
    const id = order.id;
    if (!(Number.isInteger(id) || /^[0-9]{1,20}$/.test(String(id ?? '')))) throw new ConnectorError('invalid_response', 'order_id');
    const status = typeof order.status === 'object' && order.status
        ? shortText(order.status.name || order.status.slug, 40)
        : shortText(order.status, 40);
    const total = order.amounts?.total ?? order.total;
    const currency = (typeof total === 'object' && total?.currency) || order.currency;
    const items = Array.isArray(order.items) ? order.items : [];
    const adminUrl = typeof order.urls?.admin === 'string' && /^https:\/\/([a-z0-9-]+\.)*salla\.sa\//.test(order.urls.admin)
        ? order.urls.admin : null;
    const reference = order.reference_id ?? order.reference;
    return recordShape({
        recordType: 'order',
        externalId: String(id),
        displayRef: `#${shortText(reference, 40) || id}`,
        summary: {
            number: shortText(reference, 40),
            status,
            currency: /^[A-Z]{3}$/.test(String(currency || '')) ? currency : null,
            total: amountText(total),
            created_local: shortText(order.date?.date ?? order.created_at, 30),
            payment_method_title: shortText(order.payment_method, 60),
            customer_name: shortText([order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(' '), 80),
            customer_email_masked: maskEmail(order.customer?.email),
            customer_ref: order.customer?.id !== undefined && /^[0-9]{1,20}$/.test(String(order.customer.id)) ? String(order.customer.id) : null,
            item_count: items.reduce((n, i) => n + (Number.isInteger(i?.quantity) ? i.quantity : 0), 0) || null,
            items: items.slice(0, 10).map((i) => ({ name: shortText(i?.name, 80), quantity: Number.isInteger(i?.quantity) ? i.quantity : null }))
                        .filter((i) => i.name),
            field_mapping: 'unverified'
        },
        externalUrl: adminUrl,
        sourceUpdatedAt: null
    });
}

async function fetchOrder(ctx, reference) {
    const ref = String(reference ?? '').trim().replace(/^#/, '');
    if (!/^[0-9]{1,20}$/.test(ref)) throw new ConnectorError('invalid_input', 'order_id');
    const res = await safeFetch(ctx.fetch, `${SALLA_API}/orders/${ref}`, {
        headers: { Authorization: bearer(ctx), Accept: 'application/json' }
    });
    if (res.status === 200 && res.json?.data) return mapOrder(res.json.data);
    throw new ConnectorError(res.status === 200 ? 'invalid_response' : codeForStatus(res.status));
}

/**
 * التحقق من ويب هوك سلة. السر على مستوى التطبيق (SALLA_WEBHOOK_SECRET)،
 * والربط يُحدَّد من حقل merchant بعد التحقق — لا قبله.
 */
export async function verifySallaWebhook({ env }, { headers, rawBody }) {
    const secret = env.SALLA_WEBHOOK_SECRET;
    if (!secret) throw new ConnectorError('not_configured');
    const strategy = String(headers.get('x-salla-security-strategy') || '').trim().toLowerCase();
    if (strategy !== 'signature') throw new ConnectorError('signature_invalid', 'strategy');
    const sig = String(headers.get('x-salla-signature') || '').trim();
    if (!sig) throw new ConnectorError('signature_invalid', 'missing');
    const mac = await hmacSha256(secret, rawBody);
    const ok = timingSafeEqual(sig.toLowerCase(), bytesToHex(mac)) || timingSafeEqual(sig, bytesToB64(mac));
    if (!ok) throw new ConnectorError('signature_invalid');

    let body;
    try { body = JSON.parse(new TextDecoder().decode(rawBody)); } catch { throw new ConnectorError('invalid_payload', 'json'); }
    const event = typeof body?.event === 'string' ? body.event.slice(0, 80) : '';
    const merchant = body?.merchant;
    if (!event || !(Number.isInteger(merchant) || /^[0-9]{1,20}$/.test(String(merchant ?? '')))) {
        throw new ConnectorError('invalid_payload', 'envelope');
    }
    return { event, merchant: String(merchant), createdAt: isoUtc(body.created_at), data: body.data, bodyHash: await sha256Hex(rawBody) };
}

/** حدث موحّد بعد التحقق (handleWebhook في الواجهة المشتركة). */
async function handleWebhook(ctx, envelope) {
    const { event, merchant, createdAt, data, bodyHash } = envelope;
    if (REVOKE_EVENTS.includes(event)) return { revoke: true, topic: event };
    if (!ORDER_EVENTS.includes(event)) return { ignored: true, topic: event };
    const record = mapOrder(data);
    // ترتيب الأحداث بزمن الحدث في الغلاف (نفس التحويل لكل أحداث المتجر)
    record.source_updated_at = createdAt;
    return {
        topic: event,
        externalType: 'order',
        externalId: record.external_id,
        sourceUpdatedAt: createdAt,
        dedupeKey: await sha256Hex(`salla|${merchant}|${event}|${record.external_id}|${createdAt}|${bodyHash}`),
        record
    };
}

export const salla = defineConnector({
    key: 'salla',
    authKind: 'oauth2',
    linkTypes: ['order'],
    operations: {
        connect: unsupported('Salla connects through OAuth (oauth_start + callback), not through submitted credentials'),
        verifyConnection,
        refreshCredentials,
        disconnect: unsupported('no Salla token-revocation endpoint was verified; the merchant removes the app from the Salla dashboard (app.uninstalled is honoured)'),
        fetchCustomer: unsupported('not implemented in the first release'),
        fetchOrder,
        fetchInvoice: unsupported('Salla invoices are not part of this release'),
        handleWebhook,
        syncRecords: unsupported('by design: only orders linked to a ticket are cached'),
        getHealthStatus: verifyConnection
    }
});
