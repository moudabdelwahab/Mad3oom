// ============================================================================
// shopify.js — موصل Shopify (Admin GraphQL API 2026-10 + OAuth authorization code grant).
//
// ما تحقّقنا منه من shopify.dev (2026-10-28):
//   • تطبيق غير مضمَّن (Mad3oom لوحة مستقلة) ⇒ authorization code grant.
//       تفويض  https://{shop}/admin/oauth/authorize?client_id&scope&redirect_uri&state
//       الرجوع  ?code&hmac&shop&state&timestamp — hmac = hex(HMAC-SHA256(client_secret,
//               المعاملات بلا hmac مرتبة أبجديًا ومجموعة key=value بـ &))، مقارنة ثابتة الزمن.
//       shop    ^[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com$ — مثبّت الطرفين (وإلا مضيف مهاجم).
//       الرمز   POST https://{shop}/admin/oauth/access_token (form) + expiring=1.
//   • «التطبيقات العامة الجديدة يجب أن تستعمل رموز offline منتهية»: access ~ ساعة، refresh 90 يومًا،
//     ورمز التجديد **يتبدّل** عند كل تجديد ⇒ كاتب تجديد واحد (قفل في القاعدة، shopify-session.js).
//   • التاجر قد يغيّر النطاقات أثناء التفويض ⇒ نتحقق من scope المرجَع قبل التخزين.
//   • بيانات العملاء المحمية: الحقول غير المعتمدة ترجع null مع خطأ في errors بحالة 200 — لا نفشل،
//     نعرض الحقل غائبًا ونعلّم الملخص protected_fields_restricted.
//   • الويب هوك: X-Shopify-Hmac-Sha256 = base64(HMAC-SHA256(client_secret, الجسم الخام))؛ التكرار بـ
//     X-Shopify-Webhook-Id؛ لا ترتيب مضمون ⇒ updated_at؛ 401 عند فشل التوقيع؛ 2xx خلال 5 ثوان.
//   • الحدود: سطل تكلفة (extensions.cost.throttleStatus)، 1000 نقطة أقصى للاستعلام، تأخير ~ ثانية.
//   • read_orders يتيح آخر 60 يومًا فقط؛ read_all_orders غير مطلوب.
//
// النطاقات: read_orders, read_customers, read_products — المطلوبة لصحة الربط والقراءة والمزامنة.
// نطاقات الإدارة (120، shopify-admin.js) تُطلب فقط لمتجر يملك امتياز shopify_management، وكل عملية
// إدارة تفحص نطاقها في القاعدة. لا عملية كتابة في هذا الموصل؛ عمليات الإدارة في shopify-admin.js.
// ============================================================================

import { defineConnector, unsupported, recordShape, shortText, amountText, isoUtc } from './contract.js';
import { ConnectorError, codeForStatus } from './errors.js';
import { safeFetch } from './http.js';
import { hmacSha256, bytesToB64, bytesToHex, timingSafeEqual, sha256Hex } from './crypto.js';
import { maskEmail } from './redact.js';

export const SHOPIFY_API_VERSION = '2026-10';
export const SHOPIFY_SCOPES = Object.freeze(['read_customers', 'read_orders', 'read_products']);
/** 120: نطاقات عمليات الإدارة المنفّذة فقط (docs/ecommerce/SHOPIFY_MANAGEMENT_MATRIX.md §3). */
export const MANAGEMENT_SCOPES = Object.freeze([
    'read_discounts', 'read_draft_orders', 'read_inventory', 'read_locations',
    'read_merchant_managed_fulfillment_orders', 'read_publications', 'read_returns',
    'write_customers', 'write_discounts', 'write_draft_orders', 'write_inventory',
    'write_merchant_managed_fulfillment_orders', 'write_orders', 'write_products', 'write_publications', 'write_returns'
]);
/** كل ما قد يطلبه التطبيق — shopify.app.toml يطابقه. */
export const REQUESTED_SCOPES = Object.freeze([...SHOPIFY_SCOPES, ...MANAGEMENT_SCOPES].sort());
export const SHOP_RE = /^[a-z0-9][a-z0-9-]{0,59}\.myshopify\.com$/;
const DIGITS = /^[0-9]{1,20}$/;

export const ORDER_TOPICS = Object.freeze(['orders/create', 'orders/updated', 'orders/cancelled', 'refunds/create']);
export const CUSTOMER_TOPICS = Object.freeze(['customers/create', 'customers/update']);
export const PRODUCT_TOPICS = Object.freeze(['products/create', 'products/update']);
export const DELETE_TOPICS = Object.freeze({ 'customers/delete': 'customer', 'products/delete': 'product' });
export const COMPLIANCE_TOPICS = Object.freeze(['customers/data_request', 'customers/redact', 'shop/redact']);
/** كل ما تشترك فيه shopify.app.toml — اختبار يطابق الملفين. */
export const SUBSCRIBED_TOPICS = Object.freeze([
    ...ORDER_TOPICS, ...CUSTOMER_TOPICS, 'customers/delete', ...PRODUCT_TOPICS, 'products/delete',
    'app/uninstalled', 'app/scopes_update'
]);

/** نطاق متجر مطبَّع أو خطأ. يقبل «my-store» أو «my-store.myshopify.com» أو https://my-store.myshopify.com/. */
export function normalizeShopDomain(input) {
    let s = String(input ?? '').trim().toLowerCase();
    s = s.replace(/^https:\/\//, '').replace(/\/+$/, '');
    if (s && !s.includes('.')) s = `${s}.myshopify.com`;
    if (!SHOP_RE.test(s)) throw new ConnectorError('invalid_input', 'shop');
    return s;
}

export function shopHandle(shop) {
    return normalizeShopDomain(shop).replace(/\.myshopify\.com$/, '');
}

export function apiVersion(env = {}) {
    const v = String(env.SHOPIFY_API_VERSION || SHOPIFY_API_VERSION);
    return /^20[2-9][0-9]-(01|04|07|10)$/.test(v) ? v : SHOPIFY_API_VERSION;
}

/** scopes: نطاقات القراءة وحدها افتراضيًا؛ نطاقات الإدارة لمتجر مستحق فقط (api.js يقرر من القاعدة). */
export function authorizeUrl({ clientId, redirectUri, state, shop, scopes = SHOPIFY_SCOPES }) {
    if (!clientId || !redirectUri || !state) throw new ConnectorError('not_configured');
    if (!Array.isArray(scopes) || !SHOPIFY_SCOPES.every((s) => scopes.includes(s))
        || !scopes.every((s) => REQUESTED_SCOPES.includes(s))) throw new ConnectorError('invalid_input', 'scopes');
    const u = new URL(`https://${normalizeShopDomain(shop)}/admin/oauth/authorize`);
    u.searchParams.set('client_id', clientId);
    u.searchParams.set('scope', [...new Set(scopes)].join(','));
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('state', state);
    return u.toString();
}

/** رسالة HMAC لمعاملات الرجوع/التثبيت: بلا hmac (ولا signature القديمة)، مرتبة، key=value و &. */
export function queryHmacMessage(query) {
    const pairs = [];
    for (const [k, v] of query.entries()) {
        if (k === 'hmac' || k === 'signature') continue;
        pairs.push([k, v]);
    }
    pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

export async function verifyQueryHmac(secret, query) {
    if (!secret) throw new ConnectorError('not_configured');
    const given = String(query.get('hmac') || '').trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(given)) return false;
    const mac = bytesToHex(await hmacSha256(secret, queryHmacMessage(query)));
    return timingSafeEqual(given, mac);
}

/** طابع زمني بالثواني لا يبعد أكثر من نافذته عن الآن (تثبيت من Shopify). */
export function freshTimestamp(value, nowMs, windowSec = 600) {
    const t = Number(value);
    return Number.isInteger(t) && Math.abs(nowMs / 1000 - t) <= windowSec;
}

/* ── الرموز ────────────────────────────────────────────────────────────── */

export function parseScopes(scope) {
    return String(scope || '').split(',').map((s) => s.trim()).filter((s) => /^(unauthenticated_)?(read|write)_[a-z_]{2,60}$/.test(s));
}

/** write_x يتضمن read_x (shopify.dev). */
export function missingScopes(granted) {
    const set = new Set(granted);
    return SHOPIFY_SCOPES.filter((s) => !set.has(s) && !set.has(s.replace(/^read_/, 'write_')));
}

function tokenPayload(json, nowMs) {
    const access = json?.access_token;
    if (typeof access !== 'string' || access.length < 10 || access.length > 512) throw new ConnectorError('invalid_response', 'access_token');
    const expiresIn = Number(json.expires_in);
    const refresh = typeof json.refresh_token === 'string' && json.refresh_token.length >= 10 ? json.refresh_token : null;
    const refreshIn = Number(json.refresh_token_expires_in);
    return {
        access_token: access,
        refresh_token: refresh,
        // بلا expires_in = رمز offline غير منتهٍ (تطبيق قديم) — نقبله ولا نجدّده
        expires_at: Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(nowMs + expiresIn * 1000).toISOString() : null,
        refresh_expires_at: refresh && Number.isFinite(refreshIn) && refreshIn > 0 ? new Date(nowMs + refreshIn * 1000).toISOString() : null,
        scope: parseScopes(json.scope).join(',')
    };
}

async function tokenRequest(fetchImpl, shop, params, nowMs) {
    const res = await safeFetch(fetchImpl, `https://${normalizeShopDomain(shop)}/admin/oauth/access_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams(params).toString()
    });
    // 401 على التجديد = رمز تجديد غير صالح ⇒ إعادة تفويض (shopify.dev)
    if (res.status === 400 || res.status === 401) throw new ConnectorError(params.grant_type === 'refresh_token' ? 'token_expired' : 'auth_failed');
    if (res.status !== 200) throw new ConnectorError(codeForStatus(res.status));
    return tokenPayload(res.json, nowMs);
}

export async function exchangeCode({ fetch, env, now = Date.now }, shop, code) {
    if (!/^[A-Za-z0-9._~-]{8,256}$/.test(String(code || ''))) throw new ConnectorError('invalid_input', 'code');
    if (!env.SHOPIFY_CLIENT_ID || !env.SHOPIFY_CLIENT_SECRET) throw new ConnectorError('not_configured');
    return tokenRequest(fetch, shop, {
        client_id: env.SHOPIFY_CLIENT_ID, client_secret: env.SHOPIFY_CLIENT_SECRET, code, expiring: '1'
    }, now());
}

async function refreshCredentials(ctx) {
    const { env } = ctx;
    if (!env.SHOPIFY_CLIENT_ID || !env.SHOPIFY_CLIENT_SECRET) throw new ConnectorError('not_configured');
    if (!ctx.credentials?.refresh_token) throw new ConnectorError('token_expired');
    const t = await tokenRequest(ctx.fetch, ctx.externalAccountId, {
        client_id: env.SHOPIFY_CLIENT_ID, client_secret: env.SHOPIFY_CLIENT_SECRET,
        grant_type: 'refresh_token', refresh_token: ctx.credentials.refresh_token
    }, (ctx.now || Date.now)());
    // التجديد قد لا يرجع scope: يبقى المعروف
    return { ...t, scope: t.scope || ctx.credentials.scope || '' };
}

/* ── GraphQL ───────────────────────────────────────────────────────────── */

async function accessToken(ctx) {
    if (typeof ctx.accessToken === 'function') return ctx.accessToken();
    const c = ctx.credentials || {};
    if (!c.access_token) throw new ConnectorError('token_expired');
    if (c.expires_at && Date.parse(c.expires_at) <= (ctx.now || Date.now)()) throw new ConnectorError('token_expired');
    return c.access_token;
}

/** الانتظار المقترح (ثوانٍ) من حالة السطل قبل طلب تكلفته requested. */
export function throttleWait(cost, requested = 0) {
    const st = cost?.throttleStatus;
    if (!st) return 0;
    const need = Math.max(Number(requested) || 0, 0) - Number(st.currentlyAvailable || 0);
    const rate = Number(st.restoreRate) || 50;
    return need > 0 ? Math.min(Math.ceil(need / rate), 60) : 0;
}

/**
 * نداء GraphQL واحد. يرجع { data, cost, restricted, errorCodes } — restricted = حقول محمية لم تُعتمد،
 * errorCodes = رموز extensions.code فقط (لا نص من المزوّد).
 * الخنق يرمي rate_limited ومعه retryAfter (ثوانٍ).
 */
export async function graphql(ctx, query, variables = {}) {
    const shop = normalizeShopDomain(ctx.externalAccountId);
    const token = await accessToken(ctx);
    const res = await safeFetch(ctx.fetch, `https://${shop}/admin/api/${apiVersion(ctx.env)}/graphql.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Shopify-Access-Token': token },
        body: JSON.stringify({ query, variables }),
        maxBytes: 1024 * 1024
    });
    if (res.status === 429) {
        const err = new ConnectorError('rate_limited');
        err.retryAfter = Math.min(Math.max(Number(res.headers?.get?.('retry-after')) || 2, 1), 60);
        throw err;
    }
    if (res.status === 402 || res.status === 423) throw new ConnectorError('provider_unavailable', 'shop_unavailable');
    if (res.status !== 200) throw new ConnectorError(codeForStatus(res.status));
    const errors = Array.isArray(res.json?.errors) ? res.json.errors : [];
    const cost = res.json?.extensions?.cost || null;
    if (errors.some((e) => e?.extensions?.code === 'THROTTLED')) {
        const err = new ConnectorError('rate_limited');
        err.retryAfter = Math.max(throttleWait(cost, cost?.requestedQueryCost), 1);
        throw err;
    }
    if (errors.some((e) => e?.extensions?.code === 'ACCESS_DENIED') && !res.json?.data) throw new ConnectorError('forbidden_scope');
    if (!res.json?.data) throw new ConnectorError('invalid_response', 'no_data');
    // حقول محمية غير معتمدة: null + خطأ، والطلب ناجح
    const restricted = errors.some((e) => /protected customer data|not approved to access|ACCESS_DENIED/i.test(
        `${e?.message || ''} ${e?.extensions?.code || ''}`));
    const errorCodes = [...new Set(errors.map((e) => String(e?.extensions?.code || '')).filter((c) => /^[A-Z_]{1,60}$/.test(c)))];
    return { data: res.json.data, cost, restricted, errorCodes };
}

const MONEY = 'shopMoney { amount currencyCode }';
const ORDER_FIELDS = (lines, fulfillments, tracking) => `
  id legacyResourceId name createdAt updatedAt processedAt cancelledAt cancelReason closed
  displayFinancialStatus displayFulfillmentStatus returnStatus currencyCode
  totalPriceSet { ${MONEY} } currentTotalPriceSet { ${MONEY} } totalRefundedSet { ${MONEY} }
  customer { legacyResourceId displayName defaultEmailAddress { emailAddress } }
  shippingAddress { city countryCodeV2 }
  lineItems(first: ${lines}) { nodes { title variantTitle sku quantity currentQuantity originalUnitPriceSet { ${MONEY} } } }
  fulfillments(first: ${fulfillments}) { status displayStatus createdAt updatedAt deliveredAt estimatedDeliveryAt
    trackingInfo(first: ${tracking}) { company number url } }`;

export const Q = Object.freeze({
    shop: 'query { shop { id name myshopifyDomain currencyCode } }',
    order: `query ($id: ID!) { order(id: $id) { ${ORDER_FIELDS(20, 5, 3)} } }`,
    orders: `query ($first: Int!, $after: String, $query: String) {
      orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
        pageInfo { hasNextPage endCursor } nodes { ${ORDER_FIELDS(5, 3, 2)} } } }`,
    customer: `query ($id: ID!) { customer(id: $id) {
      legacyResourceId displayName createdAt updatedAt numberOfOrders tags
      amountSpent { amount currencyCode } defaultEmailAddress { emailAddress } defaultPhoneNumber { phoneNumber }
      orders(first: 10, sortKey: CREATED_AT, reverse: true) { nodes { ${ORDER_FIELDS(3, 2, 1)} } } } }`,
    customers: `query ($first: Int!, $after: String, $query: String) {
      customers(first: $first, after: $after, query: $query) { pageInfo { hasNextPage endCursor }
        nodes { legacyResourceId displayName updatedAt numberOfOrders defaultEmailAddress { emailAddress }
                amountSpent { amount currencyCode } } } }`,
    product: `query ($id: ID!) { shop { currencyCode } product(id: $id) {
      legacyResourceId title handle status updatedAt onlineStoreUrl totalInventory
      variants(first: 20) { nodes { legacyResourceId title sku price inventoryQuantity } } } }`,
    products: `query ($first: Int!, $after: String, $query: String) { shop { currencyCode }
      products(first: $first, after: $after, query: $query) { pageInfo { hasNextPage endCursor }
        nodes { legacyResourceId title handle status updatedAt totalInventory } } }`
});

/* ── قوائم السماح ──────────────────────────────────────────────────────── */

function money(set) {
    const m = set?.shopMoney;
    return { amount: amountText(m?.amount), currency: /^[A-Z]{3}$/.test(String(m?.currencyCode || '')) ? m.currencyCode : null };
}

/** يحذف الحقول الفارغة من الكائنات المتداخلة (recordShape ينظّف المستوى الأول فقط). */
const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== ''
                                                                    && !(Array.isArray(v) && !v.length)));
const ENUM = (v, max = 40) => (typeof v === 'string' && /^[A-Z_]{1,40}$/.test(v) ? v.toLowerCase() : shortText(v, max));
const httpsUrl = (u) => (typeof u === 'string' && /^https:\/\/[^\s"<>]{3,400}$/.test(u) ? u : null);

function legacyId(v) {
    const s = String(v ?? '');
    if (!DIGITS.test(s)) throw new ConnectorError('invalid_response', 'id');
    return s;
}

export function mapOrder(node, shop, { restricted = false } = {}) {
    if (!node || typeof node !== 'object') throw new ConnectorError('invalid_response', 'order');
    const id = legacyId(node.legacyResourceId);
    const total = money(node.totalPriceSet);
    const current = money(node.currentTotalPriceSet);
    const refunded = money(node.totalRefundedSet);
    const lines = Array.isArray(node.lineItems?.nodes) ? node.lineItems.nodes : [];
    const fulfillments = Array.isArray(node.fulfillments) ? node.fulfillments : [];
    const customerRef = node.customer?.legacyResourceId !== undefined && DIGITS.test(String(node.customer.legacyResourceId))
        ? String(node.customer.legacyResourceId) : null;
    return recordShape({
        recordType: 'order',
        externalId: id,
        displayRef: shortText(node.name, 40) || `#${id}`,
        summary: {
            number: shortText(node.name, 40),
            financial_status: ENUM(node.displayFinancialStatus),
            fulfillment_status: ENUM(node.displayFulfillmentStatus),
            return_status: ENUM(node.returnStatus),
            cancelled_at: isoUtc(node.cancelledAt, { assumeUtc: false }),
            cancel_reason: ENUM(node.cancelReason),
            closed: node.closed === true ? true : null,
            created_at: isoUtc(node.createdAt, { assumeUtc: false }),
            currency: total.currency || (/^[A-Z]{3}$/.test(String(node.currencyCode || '')) ? node.currencyCode : null),
            total: total.amount,
            current_total: current.amount !== total.amount ? current.amount : null,
            refunded_total: refunded.amount && Number(refunded.amount) > 0 ? refunded.amount : null,
            customer_ref: customerRef,
            customer_name: shortText(node.customer?.displayName, 80),
            customer_email_masked: maskEmail(node.customer?.defaultEmailAddress?.emailAddress),
            shipping_city: shortText(node.shippingAddress?.city, 60),
            shipping_country: /^[A-Z]{2}$/.test(String(node.shippingAddress?.countryCodeV2 || '')) ? node.shippingAddress.countryCodeV2 : null,
            item_count: lines.reduce((n, l) => n + (Number.isInteger(l?.quantity) ? l.quantity : 0), 0) || null,
            items: lines.slice(0, 10).map((l) => compact({
                title: shortText(l?.title, 60), variant: shortText(l?.variantTitle, 40), sku: shortText(l?.sku, 40),
                quantity: Number.isInteger(l?.quantity) ? l.quantity : null,
                current_quantity: Number.isInteger(l?.currentQuantity) && l.currentQuantity !== l.quantity ? l.currentQuantity : null,
                unit_price: money(l?.originalUnitPriceSet).amount
            })).filter((l) => l.title),
            fulfillments: fulfillments.slice(0, 3).map((f) => compact({
                status: ENUM(f?.displayStatus || f?.status),
                delivered_at: isoUtc(f?.deliveredAt, { assumeUtc: false }),
                estimated_delivery_at: isoUtc(f?.estimatedDeliveryAt, { assumeUtc: false }),
                tracking: (Array.isArray(f?.trackingInfo) ? f.trackingInfo : []).slice(0, 2).map((t) => compact({
                    company: shortText(t?.company, 40), number: shortText(t?.number, 60), url: httpsUrl(t?.url)
                })).filter((t) => t.company || t.number)
            })),
            protected_fields_restricted: restricted || null,
            source: 'shopify'
        },
        externalUrl: `https://admin.shopify.com/store/${shopHandle(shop)}/orders/${id}`,
        sourceUpdatedAt: isoUtc(node.updatedAt, { assumeUtc: false })
    });
}

export function mapCustomer(node, shop, { restricted = false } = {}) {
    if (!node || typeof node !== 'object') throw new ConnectorError('invalid_response', 'customer');
    const id = legacyId(node.legacyResourceId);
    const spent = node.amountSpent || {};
    return recordShape({
        recordType: 'customer',
        externalId: id,
        displayRef: shortText(node.displayName, 80) || `Customer ${id}`,
        summary: {
            name: shortText(node.displayName, 80),
            email_masked: maskEmail(node.defaultEmailAddress?.emailAddress),
            orders_count: /^[0-9]{1,12}$/.test(String(node.numberOfOrders ?? '')) ? Number(node.numberOfOrders) : null,
            amount_spent: amountText(spent.amount),
            currency: /^[A-Z]{3}$/.test(String(spent.currencyCode || '')) ? spent.currencyCode : null,
            created_at: isoUtc(node.createdAt, { assumeUtc: false }),
            tags: (Array.isArray(node.tags) ? node.tags : []).slice(0, 5).map((t) => shortText(t, 30)).filter(Boolean),
            protected_fields_restricted: restricted || null,
            source: 'shopify'
        },
        externalUrl: `https://admin.shopify.com/store/${shopHandle(shop)}/customers/${id}`,
        sourceUpdatedAt: isoUtc(node.updatedAt, { assumeUtc: false })
    });
}

export function mapProduct(node, shop, currency = null) {
    if (!node || typeof node !== 'object') throw new ConnectorError('invalid_response', 'product');
    const id = legacyId(node.legacyResourceId);
    const variants = Array.isArray(node.variants?.nodes) ? node.variants.nodes : [];
    return recordShape({
        recordType: 'product',
        externalId: id,
        displayRef: shortText(node.title, 80) || `Product ${id}`,
        summary: {
            title: shortText(node.title, 80),
            status: ENUM(node.status, 20),
            handle: shortText(node.handle, 80),
            total_inventory: Number.isInteger(node.totalInventory) ? node.totalInventory : null,
            currency: /^[A-Z]{3}$/.test(String(currency || '')) ? currency : null,
            store_url: httpsUrl(node.onlineStoreUrl),
            variants: variants.slice(0, 10).map((v) => compact({
                title: shortText(v?.title, 40), sku: shortText(v?.sku, 40), price: amountText(v?.price),
                inventory: Number.isInteger(v?.inventoryQuantity) ? v.inventoryQuantity : null
            })),
            source: 'shopify'
        },
        externalUrl: `https://admin.shopify.com/store/${shopHandle(shop)}/products/${id}`,
        sourceUpdatedAt: isoUtc(node.updatedAt, { assumeUtc: false })
    });
}

/* ── العمليات ──────────────────────────────────────────────────────────── */

const gid = (type, ref) => {
    const id = String(ref ?? '').trim().replace(/^#/, '');
    if (!DIGITS.test(id)) throw new ConnectorError('invalid_input', `${type}_id`);
    return `gid://shopify/${type}/${id}`;
};

export async function fetchShop(ctx) {
    const { data } = await graphql(ctx, Q.shop);
    const s = data?.shop;
    const domain = String(s?.myshopifyDomain || '').toLowerCase();
    if (!SHOP_RE.test(domain) || !/^gid:\/\/shopify\/Shop\/[0-9]{1,20}$/.test(String(s?.id || ''))) {
        throw new ConnectorError('invalid_response', 'shop');
    }
    return { domain, gid: s.id, name: shortText(s.name, 120) || domain, currency: /^[A-Z]{3}$/.test(String(s.currencyCode || '')) ? s.currencyCode : null };
}

async function verifyConnection(ctx) {
    const shop = await fetchShop(ctx);
    if (shop.domain !== normalizeShopDomain(ctx.externalAccountId)) throw new ConnectorError('auth_failed', 'shop_changed');
    const missing = missingScopes(parseScopes(ctx.credentials?.scope));
    if (missing.length) throw new ConnectorError('forbidden_scope', missing.join(','));
    return { ok: true };
}

async function fetchOrder(ctx, reference) {
    const ref = String(reference ?? '').trim();
    let node;
    let restricted = false;
    if (DIGITS.test(ref)) {
        const r = await graphql(ctx, Q.order, { id: gid('Order', ref) });
        node = r.data?.order;
        restricted = r.restricted;
    }
    if (!node) {
        // رقم الطلب الظاهر (#1001): مطابقة تامة للاسم فقط
        const name = ref.replace(/^#?/, '#');
        if (!/^#[A-Za-z0-9_-]{1,30}$/.test(name)) throw new ConnectorError(DIGITS.test(ref) ? 'not_found' : 'invalid_input', 'order');
        const r = await graphql(ctx, Q.orders, { first: 2, query: `name:${JSON.stringify(name)}` });
        node = (r.data?.orders?.nodes || []).find((o) => o?.name === name);
        restricted = r.restricted;
    }
    if (!node) throw new ConnectorError('not_found');
    return mapOrder(node, ctx.externalAccountId, { restricted });
}

async function fetchCustomer(ctx, reference) {
    const r = await graphql(ctx, Q.customer, { id: gid('Customer', reference) });
    if (!r.data?.customer) throw new ConnectorError('not_found');
    return mapCustomer(r.data.customer, ctx.externalAccountId, { restricted: r.restricted });
}

async function fetchProduct(ctx, reference) {
    const r = await graphql(ctx, Q.product, { id: gid('Product', reference) });
    if (!r.data?.product) throw new ConnectorError('not_found');
    return mapProduct(r.data.product, ctx.externalAccountId, r.data?.shop?.currencyCode);
}

/** عرض حي لعميل: الملخص + التواصل (غير مخزَّن) + آخر الطلبات. */
export async function customerProfile(ctx, reference) {
    const r = await graphql(ctx, Q.customer, { id: gid('Customer', reference) });
    const c = r.data?.customer;
    if (!c) throw new ConnectorError('not_found');
    return {
        record: mapCustomer(c, ctx.externalAccountId, { restricted: r.restricted }),
        contact: {
            email: shortText(c.defaultEmailAddress?.emailAddress, 254),
            phone: shortText(c.defaultPhoneNumber?.phoneNumber, 40)
        },
        orders: (c.orders?.nodes || []).slice(0, 10).map((o) => mapOrder(o, ctx.externalAccountId, { restricted: r.restricted })),
        restricted: r.restricted
    };
}

/**
 * نص بحث آمن لصيغة بحث Shopify: أحرف محدودة، داخل علامات تنصيص. لا مشغّلات من المستخدم.
 * kind: order → name أو email · customer → email/الاسم · product → title
 */
export function searchQuery(kind, text) {
    const t = String(text ?? '').trim();
    if (!t) return null;
    if (t.length > 80 || !/^[\p{L}\p{N} #@._+'-]+$/u.test(t)) throw new ConnectorError('invalid_input', 'query');
    const q = JSON.stringify(t.replace(/'/g, ''));
    if (kind === 'order') return /@/.test(t) ? `email:${q}` : `name:${JSON.stringify(t.replace(/^#?/, '#'))}`;
    if (kind === 'customer') return /@/.test(t) ? `email:${q}` : q;
    if (kind === 'product') return `title:${q}`;
    throw new ConnectorError('unsupported', 'kind');
}

async function search(ctx, kind, text, after = null) {
    const query = searchQuery(kind, text);
    const cursor = after && /^[A-Za-z0-9+/=_-]{1,500}$/.test(String(after)) ? String(after) : null;
    const vars = { first: 10, after: cursor, query };
    if (kind === 'order') {
        const r = await graphql(ctx, Q.orders, vars);
        const c = r.data?.orders;
        return { items: (c?.nodes || []).map((o) => mapOrder(o, ctx.externalAccountId, { restricted: r.restricted })),
                 page: { has_next: !!c?.pageInfo?.hasNextPage, cursor: c?.pageInfo?.endCursor || null }, restricted: r.restricted };
    }
    if (kind === 'customer') {
        const r = await graphql(ctx, Q.customers, vars);
        const c = r.data?.customers;
        return { items: (c?.nodes || []).map((x) => mapCustomer(x, ctx.externalAccountId, { restricted: r.restricted })),
                 page: { has_next: !!c?.pageInfo?.hasNextPage, cursor: c?.pageInfo?.endCursor || null }, restricted: r.restricted };
    }
    if (kind === 'product') {
        const r = await graphql(ctx, Q.products, vars);
        const c = r.data?.products;
        return { items: (c?.nodes || []).map((x) => mapProduct(x, ctx.externalAccountId, r.data?.shop?.currencyCode)),
                 page: { has_next: !!c?.pageInfo?.hasNextPage, cursor: c?.pageInfo?.endCursor || null }, restricted: false };
    }
    throw new ConnectorError('unsupported', 'kind');
}

/**
 * صفحة مزامنة واحدة: طلبات حُدّثت منذ since (UPDATED_AT تصاعديًا). 25 طلبًا × حقول محدودة ≈ 400 نقطة.
 * يرجع { records, hasNext, cursor, highWater, wait } — wait = ثوانٍ يقترحها السطل قبل الصفحة التالية.
 */
async function syncRecords(ctx, { since, cursor = null } = {}) {
    const sinceIso = isoUtc(since, { assumeUtc: false });
    if (!sinceIso) throw new ConnectorError('invalid_input', 'since');
    const r = await graphql(ctx, Q.orders, { first: 25, after: cursor, query: `updated_at:>='${sinceIso}'` });
    const conn = r.data?.orders;
    if (!conn || !Array.isArray(conn.nodes)) throw new ConnectorError('invalid_response', 'orders');
    const records = conn.nodes.map((o) => mapOrder(o, ctx.externalAccountId, { restricted: r.restricted }));
    const highWater = records.reduce((m, x) => (x.source_updated_at && (!m || x.source_updated_at > m) ? x.source_updated_at : m), null);
    const requested = Number(r.cost?.requestedQueryCost) || 400;
    return {
        records,
        hasNext: !!conn.pageInfo?.hasNextPage,
        cursor: conn.pageInfo?.endCursor || null,
        highWater,
        wait: throttleWait(r.cost, requested)
    };
}

/* ── الويب هوك ─────────────────────────────────────────────────────────── */

/** يتحقق من التوقيع قبل أي شيء، ثم يقرأ الترويسات والجسم. */
export async function verifyShopifyWebhook({ env }, { headers, rawBody }) {
    const secret = env.SHOPIFY_CLIENT_SECRET;
    if (!secret) throw new ConnectorError('not_configured');
    const sig = String(headers.get('x-shopify-hmac-sha256') || '').trim();
    if (!sig) throw new ConnectorError('signature_invalid', 'missing');
    const mac = bytesToB64(await hmacSha256(secret, rawBody));
    if (!timingSafeEqual(sig, mac)) throw new ConnectorError('signature_invalid');

    const topic = String(headers.get('x-shopify-topic') || '').trim().toLowerCase();
    const shop = String(headers.get('x-shopify-shop-domain') || '').trim().toLowerCase();
    const webhookId = String(headers.get('x-shopify-webhook-id') || '').trim();
    if (!/^[a-z_]+\/[a-z_]+$/.test(topic) || !SHOP_RE.test(shop) || !/^[A-Za-z0-9._:-]{1,200}$/.test(webhookId)) {
        throw new ConnectorError('invalid_payload', 'headers');
    }
    let body;
    try { body = JSON.parse(new TextDecoder().decode(rawBody)); } catch { throw new ConnectorError('invalid_payload', 'json'); }
    if (!body || typeof body !== 'object') throw new ConnectorError('invalid_payload', 'body');
    return {
        topic, shop, webhookId, body,
        triggeredAt: isoUtc(headers.get('x-shopify-triggered-at'), { assumeUtc: false }),
        dedupeKey: await sha256Hex(`shopify|${shop}|${webhookId}`)
    };
}

const numId = (v) => (v !== undefined && v !== null && DIGITS.test(String(v)) ? String(v) : null);

/** تصنيف حدث موثَّق. لا شيء من الحمولة يُخزَّن: معرّف السجل وزمنه فقط، والعامل يجلب السجل. */
async function handleWebhook(ctx, envelope) {
    const { topic, body, triggeredAt, dedupeKey } = envelope;
    if (topic === 'app/uninstalled') return { revoke: true, topic };
    if (topic === 'app/scopes_update') {
        const current = Array.isArray(body.current) ? body.current.map(String) : [];
        return { scopes: parseScopes(current.join(',')), topic };
    }
    if (COMPLIANCE_TOPICS.includes(topic)) {
        const orders = Array.isArray(body.orders_to_redact) ? body.orders_to_redact
            : Array.isArray(body.orders_requested) ? body.orders_requested : [];
        return {
            compliance: {
                topic,
                customerId: numId(body.customer?.id),
                orderIds: orders.map(numId).filter(Boolean).slice(0, 1000),
                requestRef: numId(body.data_request?.id)
            }
        };
    }
    if (DELETE_TOPICS[topic]) {
        const id = numId(body.id);
        if (!id) throw new ConnectorError('invalid_payload', 'id');
        return { forget: { type: DELETE_TOPICS[topic], id }, topic };
    }
    let type = null;
    let id = null;
    let updatedAt = null;
    if (ORDER_TOPICS.includes(topic)) {
        type = 'order';
        id = numId(topic === 'refunds/create' ? body.order_id : body.id);
        updatedAt = topic === 'refunds/create' ? (isoUtc(body.created_at, { assumeUtc: false }) || triggeredAt)
                                               : (isoUtc(body.updated_at, { assumeUtc: false }) || triggeredAt);
    } else if (CUSTOMER_TOPICS.includes(topic)) {
        type = 'customer'; id = numId(body.id); updatedAt = isoUtc(body.updated_at, { assumeUtc: false }) || triggeredAt;
    } else if (PRODUCT_TOPICS.includes(topic)) {
        type = 'product'; id = numId(body.id); updatedAt = isoUtc(body.updated_at, { assumeUtc: false }) || triggeredAt;
    } else {
        return { ignored: true, topic };
    }
    if (!id) throw new ConnectorError('invalid_payload', 'id');
    return { queue: true, topic, externalType: type, externalId: id, sourceUpdatedAt: updatedAt, dedupeKey };
}

export const shopify = defineConnector({
    key: 'shopify',
    authKind: 'oauth2',
    linkTypes: ['order', 'customer', 'product'],
    operations: {
        connect: unsupported('Shopify connects through OAuth (shopify_start + signed callback), not through submitted credentials'),
        verifyConnection,
        refreshCredentials,
        disconnect: unsupported('the merchant uninstalls the app in Shopify admin; app/uninstalled and shop/redact are honoured'),
        fetchCustomer,
        fetchOrder,
        fetchInvoice: unsupported('Shopify has no invoice object in this integration'),
        fetchProduct,
        search,
        handleWebhook,
        syncRecords,
        getHealthStatus: verifyConnection
    }
});
