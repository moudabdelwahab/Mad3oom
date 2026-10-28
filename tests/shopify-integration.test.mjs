// ============================================================================
// Shopify — الموصل والمعالجات (node، بلا شبكة).
//
// fetch مزيّف يمثّل Shopify، و FakeShopHub يمثّل دوال ihub_svc_* بنفس العقد (السلوك الحقيقي في
// tests/sql/shopify-store-integration.test.sql).
//
// تنبيه صدق: اختبارات بمحاكيات. لا شيء هنا يثبت أن Shopify الحقيقي يقبل هذه الطلبات أو يرجع هذه
// الأشكال بالضبط — انظر docs/ecommerce/PROVIDER_SHOPIFY.md (ما تحقّقنا منه وما يُتحقق على متجر تطوير).
// ============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import * as C from '../supabase/functions/_shared/integrations/crypto.js';
import * as S from '../supabase/functions/_shared/integrations/shopify.js';
import { ensureAccessToken } from '../supabase/functions/_shared/integrations/shopify-session.js';
import { CONNECTORS } from '../supabase/functions/_shared/integrations/registry.js';
import { invoke } from '../supabase/functions/_shared/integrations/contract.js';
import { redactString } from '../supabase/functions/_shared/integrations/redact.js';
import { handleApi } from '../supabase/functions/_shared/integrations/api.js';
import { handleInbound } from '../supabase/functions/_shared/integrations/inbound.js';
import { runSyncJobs, retryDueEvents } from '../supabase/functions/_shared/integrations/worker.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const ENC_KEY = 'k'.repeat(48);
const SECRET = 'shpss_' + 'z'.repeat(32);
const enc = new TextEncoder();
const CONN = '66666666-6666-4666-8666-666666666666';
const CONN_X = '77777777-7777-4777-8777-777777777777';
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SHOP = 'shop-a.myshopify.com';
const NOW = Date.parse('2026-10-28T10:00:00Z');
const ENV = {
    IHUB_ENC_KEY: ENC_KEY, IHUB_PUBLIC_BASE: 'https://proj.supabase.co/functions/v1',
    IHUB_DASHBOARD_URL: 'https://mad3oom.com/company-dashboard/', IHUB_WORKER_SECRET: 'w'.repeat(40),
    SHOPIFY_CLIENT_ID: 'client-123', SHOPIFY_CLIENT_SECRET: SECRET,
    SHOPIFY_REDIRECT_URI: 'https://proj.supabase.co/functions/v1/integrations-inbound/shopify/callback'
};

/* ── أدوات ─────────────────────────────────────────────────────────────── */

function respond(status, body, headers = {}) {
    const text = body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
    return new Response(text, { status, headers: { 'content-type': 'application/json', ...headers } });
}
function fakeFetch(routes) {
    const calls = [];
    const fn = async (url, init = {}) => {
        calls.push({ url: String(url), init });
        for (const [match, reply] of routes) if (match(String(url), init)) return reply(String(url), init);
        return respond(599, { error: 'unrouted' });
    };
    fn.calls = calls;
    return fn;
}
const isGql = (u) => u === `https://${SHOP}/admin/api/2026-10/graphql.json`;
const gqlBody = (init) => JSON.parse(init.body);
const COST = { requestedQueryCost: 300, actualQueryCost: 120, throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 1800, restoreRate: 100 } };
const gqlOk = (data, extra = {}) => respond(200, { data, extensions: { cost: COST }, ...extra });

function orderNode(over = {}) {
    return {
        id: 'gid://shopify/Order/1001', legacyResourceId: '1001', name: '#1001',
        createdAt: '2026-10-20T09:00:00Z', updatedAt: '2026-10-21T09:00:00Z', processedAt: '2026-10-20T09:00:00Z',
        cancelledAt: null, cancelReason: null, closed: false,
        displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'FULFILLED', returnStatus: 'NO_RETURN', currencyCode: 'EGP',
        totalPriceSet: { shopMoney: { amount: '250.00', currencyCode: 'EGP' } },
        currentTotalPriceSet: { shopMoney: { amount: '250.00', currencyCode: 'EGP' } },
        totalRefundedSet: { shopMoney: { amount: '0.0', currencyCode: 'EGP' } },
        customer: { legacyResourceId: '555', displayName: '<b>Sara</b> Ali', defaultEmailAddress: { emailAddress: 'sara@example.com' } },
        shippingAddress: { city: 'Cairo', countryCodeV2: 'EG', address1: '1 Secret St', phone: '+20100' },
        lineItems: { nodes: [{ title: 'Shirt <script>x</script>', variantTitle: 'L', sku: 'SH-L', quantity: 2, currentQuantity: 2,
                               originalUnitPriceSet: { shopMoney: { amount: '125.00', currencyCode: 'EGP' } } }] },
        fulfillments: [{ status: 'SUCCESS', displayStatus: 'IN_TRANSIT', deliveredAt: null, estimatedDeliveryAt: '2026-10-25T00:00:00Z',
                         trackingInfo: [{ company: 'Aramex', number: 'TRK1', url: 'https://track.example/TRK1' },
                                        { company: 'Evil', number: 'X', url: 'javascript:alert(1)' }] }],
        ...over
    };
}

/** دوال الخادم بنفس العقد (القاعدة الحقيقية في اختبار SQL). */
class FakeShopHub {
    constructor() {
        this.conns = new Map(); this.creds = new Map(); this.calls = []; this.records = new Map();
        this.events = []; this.health = []; this.jobs = []; this.states = new Map(); this.held = new Map();
        this.lease = new Map(); this.compliance = []; this.audits = []; this.scopes = new Map(); this.forgotten = [];
    }
    add(id, extra = {}) {
        this.conns.set(id, { connection_id: id, company_id: extra.company_id || 'co-a', provider: 'shopify', status: extra.status || 'active',
                             base_url: `https://${extra.shop || SHOP}`, external_account_id: extra.shop || SHOP, provider_enabled: extra.enabled ?? true });
    }
    async putCreds(id, obj) {
        this.creds.set(id, { ciphertext: await C.encryptJson(ENC_KEY, obj, C.credentialAad(id, 'shopify')), token_expires_at: obj.expires_at || null });
    }
    async creds_of(id) { return C.decryptJson(ENC_KEY, this.creds.get(id).ciphertext, C.credentialAad(id, 'shopify')); }
    async svc(name, a) {
        this.calls.push(name);
        switch (name) {
            case 'ihub_svc_get_credentials': {
                const c = this.conns.get(a.p_connection);
                if (!c || c.status === 'disconnected') return null;
                const k = this.creds.get(a.p_connection);
                return { ...c, ciphertext: k?.ciphertext ?? null, key_version: 1, token_expires_at: k?.token_expires_at ?? null };
            }
            case 'ihub_svc_store_credentials':
                this.creds.set(a.p_connection, { ciphertext: a.p_ciphertext, token_expires_at: a.p_token_expires_at });
                return null;
            case 'ihub_svc_claim_token_refresh':
                if (this.lease.get(a.p_connection)) return false;
                this.lease.set(a.p_connection, true);
                return true;
            case 'ihub_svc_release_token_refresh': this.lease.delete(a.p_connection); return null;
            case 'ihub_svc_record_health': this.health.push([a.p_connection, a.p_ok, a.p_error_code]); return null;
            case 'ihub_svc_audit': this.audits.push(a.p_action); return null;
            case 'ihub_svc_find_connection': {
                const c = [...this.conns.values()].find((x) => x.external_account_id === a.p_external_account_id && x.status !== 'disconnected');
                return c ? { connection_id: c.connection_id, company_id: c.company_id, status: c.status } : null;
            }
            case 'ihub_svc_consume_shop_oauth_state': {
                const s = this.states.get(a.p_state_hash);
                if (!s || s.used) return null;
                s.used = true;
                if (s.shop !== a.p_shop) return { mismatch: true, connection_id: s.connection };
                return { connection_id: s.connection, user_id: s.user, provider: 'shopify', shop: s.shop };
            }
            case 'ihub_svc_hold_oauth_result':
                this.held.set(a.p_state_hash, { cipher: a.p_pending_cipher, completion: a.p_completion_hash });
                return true;
            case 'ihub_svc_take_oauth_result': {
                const h = [...this.held.values()].find((x) => x.completion === a.p_completion_hash);
                return h && this.bindingHash === a.p_binding_hash && a.p_user === USER ? h.cipher : null;
            }
            case 'ihub_svc_activate': {
                const c = this.conns.get(a.p_connection);
                Object.assign(c, { status: 'active', external_account_id: a.p_external_account_id, base_url: a.p_base_url });
                return { id: c.connection_id, provider: 'shopify', status: 'active', account_label: a.p_label };
            }
            case 'ihub_svc_set_shop_details': this.scopes.set(a.p_connection, a.p_scopes); return { granted_scopes: a.p_scopes };
            case 'ihub_svc_enqueue_sync': this.jobs.push({ id: this.jobs.length + 1, connection_id: a.p_connection, kind: a.p_kind }); return { job_id: this.jobs.length };
            case 'ihub_svc_enqueue_event': {
                if (this.events.some((e) => e.dedupe === a.p_dedupe_key)) return { duplicate: true };
                this.events.push({ id: this.events.length + 1, dedupe: a.p_dedupe_key, type: a.p_external_type, ext: a.p_external_id, topic: a.p_topic });
                return { duplicate: false, event_id: this.events.length };
            }
            case 'ihub_svc_forget_record': this.forgotten.push([a.p_record_type, a.p_external_id]); return { found: true, kept: false };
            case 'ihub_svc_compliance': this.compliance.push(a); return { status: 'completed' };
            case 'ihub_svc_revoked_by_provider': this.conns.get(a.p_connection).status = 'reauth_required'; this.creds.delete(a.p_connection); return null;
            case 'ihub_svc_apply_record': {
                const k = `${a.p_record_type}|${a.p_external_id}`;
                if (!this.records.has(k) && !a.p_create) return { applied: false, record_id: null };
                this.records.set(k, a);
                return { applied: true, record_id: 'rec-' + k };
            }
            case 'ihub_svc_event_failed': this.failedEvents = [...(this.failedEvents || []), a]; return { status: a.p_retry ? 'failed' : 'dead' };
            case 'ihub_svc_event_ignored': this.ignoredEvents = [...(this.ignoredEvents || []), a]; return null;
            case 'ihub_svc_claim_due_events': return this.due || [];
            case 'ihub_svc_schedule_reconciliation': return 0;
            case 'ihub_svc_claim_sync_jobs': { const j = this.claim || []; this.claim = []; return j; }
            case 'ihub_svc_sync_progress': this.progress = [...(this.progress || []), a]; return true;
            case 'ihub_svc_sync_finish': this.finish = [...(this.finish || []), a]; return { status: a.p_outcome };
        }
        throw new Error('unexpected rpc ' + name);
    }
}

function deps(hub, { fetch = fakeFetch([]), userRpc = null, env = {}, now = () => NOW } = {}) {
    const logs = [];
    return {
        env: { ...ENV, ...env }, fetch, now, sleep: async () => {},
        svcRpc: (n, a) => hub.svc(n, a),
        userRpc: userRpc || (async () => { throw { code: 'P0002', message: 'الربط غير موجود', details: '{"code":"not_found"}' }; }),
        logger: { log: (l) => logs.push(l) }, logs
    };
}

async function signedQuery(params, secret = SECRET) {
    const q = new URLSearchParams(params);
    q.set('hmac', C.bytesToHex(await C.hmacSha256(secret, S.queryHmacMessage(q))));
    return q;
}
async function webhook(topic, body, { secret = SECRET, shop = SHOP, id = 'wh-1', tamper = false } = {}) {
    const raw = enc.encode(JSON.stringify(body));
    const sig = C.bytesToB64(await C.hmacSha256(secret, raw));
    return {
        method: 'POST', path: '/shopify/webhooks', rawBody: tamper ? enc.encode(JSON.stringify({ ...body, x: 1 })) : raw,
        query: new URLSearchParams(),
        headers: new Headers({ 'x-shopify-hmac-sha256': sig, 'x-shopify-topic': topic, 'x-shopify-shop-domain': shop,
                               'x-shopify-webhook-id': id, 'x-shopify-triggered-at': '2026-10-28T09:59:00Z' })
    };
}

/* ══ النطاق والتفويض ══════════════════════════════════════════════════════ */

test('shop domain: only an anchored *.myshopify.com host, never a look-alike', () => {
    assert.equal(S.normalizeShopDomain('My-Store'), 'my-store.myshopify.com');
    assert.equal(S.normalizeShopDomain('https://my-store.myshopify.com/'), 'my-store.myshopify.com');
    for (const bad of ['evil.com', 'shop.myshopify.com.evil.io', 'shop.myshopify.com:443', '-x.myshopify.com', 'http://a.myshopify.com',
                       'a.myshopify.com/../x', '127.0.0.1', 'a b.myshopify.com', '', 'a.myshopify.com?x=1', 'x'.repeat(61) + '.myshopify.com']) {
        assert.throws(() => S.normalizeShopDomain(bad), (e) => e.code === 'invalid_input', bad);
    }
});

test('authorize URL: the shop host, the three read scopes, our redirect and state', () => {
    const u = new URL(S.authorizeUrl({ clientId: 'cid', redirectUri: ENV.SHOPIFY_REDIRECT_URI, state: 'st'.repeat(20), shop: 'shop-a' }));
    assert.equal(u.origin + u.pathname, 'https://shop-a.myshopify.com/admin/oauth/authorize');
    assert.equal(u.searchParams.get('scope'), 'read_customers,read_orders,read_products');
    assert.equal(u.searchParams.get('redirect_uri'), ENV.SHOPIFY_REDIRECT_URI);
    assert.equal(u.searchParams.get('state'), 'st'.repeat(20));
    assert.equal(u.searchParams.get('grant_options[]'), null, 'offline token (no per-user grant)');
    assert.doesNotMatch(u.search, /write_/);
});

test('callback HMAC: hex of the sorted query without hmac; any tampering or another secret fails', async () => {
    const q = await signedQuery({ shop: SHOP, code: 'abc123def', state: 's'.repeat(43), timestamp: '1761645600', host: 'YWRtaW4' });
    assert.ok(await S.verifyQueryHmac(SECRET, q));
    const reordered = new URLSearchParams([...q.entries()].reverse());
    assert.ok(await S.verifyQueryHmac(SECRET, reordered), 'order of parameters does not matter');
    const t = new URLSearchParams(q); t.set('shop', 'shop-b.myshopify.com');
    assert.equal(await S.verifyQueryHmac(SECRET, t), false);
    assert.equal(await S.verifyQueryHmac('other-secret', q), false);
    const none = new URLSearchParams(q); none.delete('hmac');
    assert.equal(await S.verifyQueryHmac(SECRET, none), false);
    await assert.rejects(S.verifyQueryHmac('', q), (e) => e.code === 'not_configured');
});

test('token exchange: form POST to the shop with expiring=1; expiring tokens parsed; merchant-changed scopes are visible', async () => {
    const f = fakeFetch([[(u) => u === `https://${SHOP}/admin/oauth/access_token`, () => respond(200, {
        access_token: 'shpat_' + 'a'.repeat(32), scope: 'read_orders,write_products', expires_in: 3600,
        refresh_token: 'shprt_' + 'b'.repeat(32), refresh_token_expires_in: 7776000 })]]);
    const t = await S.exchangeCode({ fetch: f, env: ENV, now: () => NOW }, SHOP, 'code-abcdef12');
    const sent = new URLSearchParams(f.calls[0].init.body);
    assert.equal(f.calls[0].init.method, 'POST');
    assert.equal(f.calls[0].init.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.equal(sent.get('expiring'), '1');
    assert.equal(sent.get('client_secret'), SECRET);
    assert.equal(t.expires_at, '2026-10-28T11:00:00.000Z');
    assert.equal(t.refresh_expires_at, '2027-01-26T10:00:00.000Z');
    assert.deepEqual(S.missingScopes(S.parseScopes(t.scope)), ['read_customers'], 'write_products implies read_products');
    await assert.rejects(S.exchangeCode({ fetch: fakeFetch([[() => true, () => respond(401, {})]]), env: ENV }, SHOP, 'code-abcdef12'),
                         (e) => e.code === 'auth_failed');
    await assert.rejects(S.exchangeCode({ fetch: f, env: { ...ENV, SHOPIFY_CLIENT_SECRET: '' } }, SHOP, 'code-abcdef12'),
                         (e) => e.code === 'not_configured');
});

test('refresh: 401 means reauthorize (token_expired); 5xx is retryable; the rotated refresh token replaces the old one', async () => {
    const ctx = (fetch) => ({ fetch, env: ENV, now: () => NOW, externalAccountId: SHOP, credentials: { refresh_token: 'shprt_old_' + 'x'.repeat(20), scope: 'read_orders' } });
    const f = fakeFetch([[() => true, () => respond(200, { access_token: 'shpat_new_' + 'n'.repeat(20), refresh_token: 'shprt_new_' + 'r'.repeat(20), expires_in: 3600 })]]);
    const t = await invoke(CONNECTORS.shopify, 'refreshCredentials', ctx(f));
    assert.equal(new URLSearchParams(f.calls[0].init.body).get('grant_type'), 'refresh_token');
    assert.equal(t.refresh_token, 'shprt_new_' + 'r'.repeat(20));
    assert.equal(t.scope, 'read_orders', 'scope kept when the refresh response omits it');
    await assert.rejects(invoke(CONNECTORS.shopify, 'refreshCredentials', ctx(fakeFetch([[() => true, () => respond(401, { error: 'invalid_request' })]]))),
                         (e) => e.code === 'token_expired');
    await assert.rejects(invoke(CONNECTORS.shopify, 'refreshCredentials', ctx(fakeFetch([[() => true, () => respond(503, {})]]))),
                         (e) => e.code === 'provider_unavailable' && e.retryable);
});

/* ══ GraphQL والحدود ══════════════════════════════════════════════════════ */

const gctx = (fetch, credentials = { access_token: 'shpat_' + 'a'.repeat(32), expires_at: '2026-10-28T11:00:00Z', scope: 'read_orders,read_customers,read_products' }) =>
    ({ fetch, env: ENV, now: () => NOW, externalAccountId: SHOP, credentials });

test('graphql: token in X-Shopify-Access-Token to the shop host only; THROTTLED and 429 become rate_limited with a wait', async () => {
    const f = fakeFetch([[isGql, () => gqlOk({ shop: { id: 'gid://shopify/Shop/9', name: 'Shop A', myshopifyDomain: SHOP, currencyCode: 'EGP' } })]]);
    const shop = await S.fetchShop(gctx(f));
    assert.equal(shop.gid, 'gid://shopify/Shop/9');
    assert.equal(f.calls[0].init.headers['X-Shopify-Access-Token'], 'shpat_' + 'a'.repeat(32));
    assert.equal(f.calls[0].init.redirect, 'manual');
    const throttled = fakeFetch([[isGql, () => respond(200, { errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }],
        extensions: { cost: { requestedQueryCost: 500, throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 100, restoreRate: 50 } } } })]]);
    await assert.rejects(S.graphql(gctx(throttled), S.Q.shop), (e) => e.code === 'rate_limited' && e.retryAfter === 8);
    await assert.rejects(S.graphql(gctx(fakeFetch([[isGql, () => respond(429, {}, { 'retry-after': '4' })]])), S.Q.shop),
                         (e) => e.code === 'rate_limited' && e.retryAfter === 4);
    await assert.rejects(S.graphql(gctx(fakeFetch([[isGql, () => respond(401, {})]])), S.Q.shop), (e) => e.code === 'auth_failed');
    await assert.rejects(S.graphql(gctx(fakeFetch([[isGql, () => respond(402, {})]])), S.Q.shop), (e) => e.code === 'provider_unavailable');
    await assert.rejects(S.graphql(gctx(f, { access_token: 'shpat_x', expires_at: '2026-10-28T09:00:00Z' }), S.Q.shop), (e) => e.code === 'token_expired');
    await assert.rejects(S.graphql({ ...gctx(f), externalAccountId: 'evil.com' }, S.Q.shop), (e) => e.code === 'invalid_input');
});

test('protected customer data: unapproved fields come back null with an error and HTTP 200 — shown as restricted, not as a failure', async () => {
    const f = fakeFetch([[isGql, () => gqlOk({ order: orderNode({ customer: { legacyResourceId: '555', displayName: null, defaultEmailAddress: null } }) },
        { errors: [{ message: 'This app is not approved to access the Customer object.', extensions: { code: 'ACCESS_DENIED' } }] })]]);
    const r = await invoke(CONNECTORS.shopify, 'fetchOrder', gctx(f), '1001');
    assert.equal(r.summary.protected_fields_restricted, true);
    assert.equal(r.summary.customer_name, undefined);
    assert.equal(r.summary.customer_ref, '555');
});

test('order summary: support allowlist only — no street, no phone, masked email, safe tracking links, stable numeric id', async () => {
    const r = S.mapOrder(orderNode(), SHOP);
    assert.equal(r.external_id, '1001');
    assert.equal(r.display_ref, '#1001');
    assert.equal(r.external_url, 'https://admin.shopify.com/store/shop-a/orders/1001');
    assert.equal(r.source_updated_at, '2026-10-21T09:00:00.000Z');
    const s = r.summary;
    assert.equal(s.financial_status, 'paid');
    assert.equal(s.fulfillment_status, 'fulfilled');
    assert.equal(s.customer_email_masked, 's***@example.com');
    assert.equal(s.customer_name, 'Sara Ali');
    assert.equal(s.shipping_city, 'Cairo');
    assert.equal(s.refunded_total, undefined, 'zero refunds are omitted');
    assert.equal(s.items[0].title, 'Shirt x');
    assert.deepEqual(s.fulfillments[0].tracking, [{ company: 'Aramex', number: 'TRK1', url: 'https://track.example/TRK1' }, { company: 'Evil', number: 'X' }]);
    const json = JSON.stringify(r);
    for (const leak of ['Secret St', '+20100', 'sara@example.com', 'javascript:', '<script', 'gid://']) assert.ok(!json.includes(leak), leak);
    assert.ok(new TextEncoder().encode(JSON.stringify(s)).length < 3800);
    assert.throws(() => S.mapOrder({ ...orderNode(), legacyResourceId: '10; drop' }, SHOP), (e) => e.code === 'invalid_response');
});

test('fetchOrder: by id, then by the exact displayed name; a near match is not accepted', async () => {
    const f = fakeFetch([[(u, i) => isGql(u) && gqlBody(i).variables.id, () => gqlOk({ order: null })],
                         [(u, i) => isGql(u) && gqlBody(i).variables.query, () => gqlOk({ orders: { nodes: [orderNode({ name: '#10010' })] } })]]);
    await assert.rejects(invoke(CONNECTORS.shopify, 'fetchOrder', gctx(f), '#1001'), (e) => e.code === 'not_found');
    assert.equal(gqlBody(f.calls.at(-1).init).variables.query, 'name:"#1001"');
    await assert.rejects(invoke(CONNECTORS.shopify, 'fetchOrder', gctx(f), 'x" OR status:any'), (e) => e.code === 'invalid_input');
});

test('search: user text cannot inject search operators; results are allowlisted summaries with a cursor', async () => {
    assert.equal(S.searchQuery('order', '1001'), 'name:"#1001"');
    assert.equal(S.searchQuery('order', 'sara@example.com'), 'email:"sara@example.com"');
    assert.equal(S.searchQuery('customer', 'سارة علي'), '"سارة علي"');
    assert.equal(S.searchQuery('product', 'blue shirt'), 'title:"blue shirt"');
    for (const bad of ['a" OR tag:x', 'x:(y)', 'a\\b', 'a'.repeat(81), 'x*', 'a AND b:c']) {
        assert.throws(() => S.searchQuery('customer', bad), (e) => e.code === 'invalid_input', bad);
    }
    const f = fakeFetch([[isGql, () => gqlOk({ customers: { pageInfo: { hasNextPage: true, endCursor: 'abc=' },
        nodes: [{ legacyResourceId: '555', displayName: 'Sara', updatedAt: '2026-10-01T00:00:00Z', numberOfOrders: '3',
                  defaultEmailAddress: { emailAddress: 'sara@example.com' }, amountSpent: { amount: '99.5', currencyCode: 'EGP' } }] } })]]);
    const r = await invoke(CONNECTORS.shopify, 'search', gctx(f), 'customer', 'Sara');
    assert.deepEqual(r.page, { has_next: true, cursor: 'abc=' });
    assert.equal(r.items[0].summary.email_masked, 's***@example.com');
    assert.equal(r.items[0].summary.orders_count, 3);
    assert.equal(gqlBody(f.calls[0].init).variables.first, 10);
});

test('customer profile: live contact for the agent (never cached) plus recent orders', async () => {
    const f = fakeFetch([[isGql, () => gqlOk({ customer: { legacyResourceId: '555', displayName: 'Sara', createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2026-10-01T00:00:00Z', numberOfOrders: '2', tags: ['vip'], amountSpent: { amount: '500', currencyCode: 'EGP' },
        defaultEmailAddress: { emailAddress: 'sara@example.com' }, defaultPhoneNumber: { phoneNumber: '+201000000000' },
        orders: { nodes: [orderNode()] } } })]]);
    const p = await S.customerProfile(gctx(f), '555');
    assert.equal(p.contact.email, 'sara@example.com');
    assert.equal(p.contact.phone, '+201000000000');
    assert.ok(!JSON.stringify(p.record).includes('sara@example.com'), 'the cacheable record holds only the masked e-mail');
    assert.equal(p.orders[0].external_id, '1001');
});

test('sync page: updated_at window, UPDATED_AT order, cursor handed back, high-water mark, bucket-aware wait', async () => {
    const f = fakeFetch([[isGql, () => respond(200, { data: { orders: { pageInfo: { hasNextPage: true, endCursor: 'cur2' },
        nodes: [orderNode(), orderNode({ legacyResourceId: '1002', name: '#1002', updatedAt: '2026-10-22T09:00:00Z' })] } },
        extensions: { cost: { requestedQueryCost: 400, throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 200, restoreRate: 50 } } } })]]);
    const page = await invoke(CONNECTORS.shopify, 'syncRecords', gctx(f), { since: '2026-09-28T10:00:00Z', cursor: 'cur1' });
    const v = gqlBody(f.calls[0].init).variables;
    assert.equal(v.query, "updated_at:>='2026-09-28T10:00:00.000Z'");
    assert.equal(v.after, 'cur1');
    assert.equal(v.first, 25);
    assert.match(gqlBody(f.calls[0].init).query, /sortKey: UPDATED_AT/);
    assert.equal(page.records.length, 2);
    assert.equal(page.highWater, '2026-10-22T09:00:00.000Z');
    assert.equal(page.cursor, 'cur2');
    assert.equal(page.wait, 4, '(400 - 200) / 50');
});

test('verifyConnection: the shop must still be the connected shop and the required scopes must be granted', async () => {
    const shopResp = (domain) => fakeFetch([[isGql, () => gqlOk({ shop: { id: 'gid://shopify/Shop/9', name: 'A', myshopifyDomain: domain, currencyCode: 'EGP' } })]]);
    assert.deepEqual(await invoke(CONNECTORS.shopify, 'verifyConnection', gctx(shopResp(SHOP))), { ok: true });
    await assert.rejects(invoke(CONNECTORS.shopify, 'verifyConnection', gctx(shopResp('other.myshopify.com'))), (e) => e.code === 'auth_failed');
    await assert.rejects(invoke(CONNECTORS.shopify, 'verifyConnection', gctx(shopResp(SHOP), { access_token: 'shpat_x' + 'a'.repeat(20), scope: 'read_orders' })),
                         (e) => e.code === 'forbidden_scope');
});

/* ══ جلسة الرمز ═══════════════════════════════════════════════════════════ */

test('token session: an expiring token is refreshed once under the lease, stored encrypted, and the lease is released', async () => {
    const hub = new FakeShopHub();
    hub.add(CONN);
    await hub.putCreds(CONN, { access_token: 'shpat_old' + 'a'.repeat(20), refresh_token: 'shprt_old' + 'b'.repeat(20), expires_at: '2026-10-28T10:01:00Z', scope: 'read_orders' });
    const f = fakeFetch([[() => true, () => respond(200, { access_token: 'shpat_new' + 'c'.repeat(20), refresh_token: 'shprt_new' + 'd'.repeat(20), expires_in: 3600 })]]);
    const tok = await ensureAccessToken(deps(hub, { fetch: f }), CONN);
    assert.equal(tok, 'shpat_new' + 'c'.repeat(20));
    assert.equal(f.calls.length, 1);
    const stored = await hub.creds_of(CONN);
    assert.equal(stored.refresh_token, 'shprt_new' + 'd'.repeat(20));
    assert.equal(stored.scope, 'read_orders');
    assert.equal(hub.creds.get(CONN).token_expires_at, '2026-10-28T11:00:00.000Z');
    assert.equal(hub.lease.size, 0, 'lease released');
    // صالح: لا تجديد
    assert.equal(await ensureAccessToken(deps(hub, { fetch: f }), CONN), 'shpat_new' + 'c'.repeat(20));
    assert.equal(f.calls.length, 1);
});

test('token session: a second caller waits for the holder instead of refreshing with the same rotating token', async () => {
    const hub = new FakeShopHub();
    hub.add(CONN);
    await hub.putCreds(CONN, { access_token: 'shpat_old' + 'a'.repeat(20), refresh_token: 'shprt_old' + 'b'.repeat(20), expires_at: '2026-10-28T09:00:00Z' });
    hub.lease.set(CONN, true);                                 // غيرنا يجدّد الآن
    const f = fakeFetch([]);
    const d = deps(hub, { fetch: f });
    let waited = 0;
    d.sleep = async () => {
        if (++waited === 2) await hub.putCreds(CONN, { access_token: 'shpat_fresh' + 'e'.repeat(20), refresh_token: 'shprt_2' + 'f'.repeat(20), expires_at: '2026-10-28T11:00:00Z' });
    };
    assert.equal(await ensureAccessToken(d, CONN), 'shpat_fresh' + 'e'.repeat(20));
    assert.equal(f.calls.length, 0, 'no second refresh');
    d.sleep = async () => {};
    await hub.putCreds(CONN, { access_token: 'shpat_old' + 'a'.repeat(20), refresh_token: 'shprt_old' + 'b'.repeat(20), expires_at: '2026-10-28T09:00:00Z' });
    await assert.rejects(ensureAccessToken(d, CONN), (e) => e.code === 'provider_unavailable' && e.retryable);
});

test('token session: a revoked refresh token marks the connection for reauthorization', async () => {
    const hub = new FakeShopHub();
    hub.add(CONN);
    await hub.putCreds(CONN, { access_token: 'shpat_old' + 'a'.repeat(20), refresh_token: 'shprt_old' + 'b'.repeat(20), expires_at: '2026-10-28T09:00:00Z' });
    await assert.rejects(ensureAccessToken(deps(hub, { fetch: fakeFetch([[() => true, () => respond(401, { error: 'invalid_request' })]]) }), CONN),
                         (e) => e.code === 'token_expired');
    assert.deepEqual(hub.health.at(-1), [CONN, false, 'token_expired']);
    assert.equal(hub.lease.size, 0);
});

/* ══ الرجوع والتثبيت ══════════════════════════════════════════════════════ */

function callbackHub() {
    const hub = new FakeShopHub();
    hub.add(CONN, { status: 'pending' });
    return hub;
}
const shopifyRoutes = (scope = 'read_orders,read_customers,read_products', domain = SHOP) => fakeFetch([
    [(u) => u === `https://${SHOP}/admin/oauth/access_token`, () => respond(200, { access_token: 'shpat_' + 'a'.repeat(32), scope, expires_in: 3600, refresh_token: 'shprt_' + 'b'.repeat(32) })],
    [isGql, () => gqlOk({ shop: { id: 'gid://shopify/Shop/9', name: 'Shop A', myshopifyDomain: domain, currencyCode: 'EGP' } })]
]);

test('OAuth callback: bad HMAC or look-alike shop is refused before the state is touched; success only HOLDS the result', async () => {
    const hub = callbackHub();
    const state = 's'.repeat(43);
    hub.states.set(await C.sha256Hex(state), { connection: CONN, user: USER, shop: SHOP });
    const req = async (params, secret) => ({ method: 'GET', path: '/shopify/callback', headers: new Headers(), rawBody: new Uint8Array(),
                                              query: await signedQuery(params, secret) });
    let r = await handleInbound(deps(hub, { fetch: shopifyRoutes() }), await req({ shop: SHOP, code: 'code-abc123', state, timestamp: '1761645600' }, 'wrong'));
    assert.equal(r.status, 302);
    assert.match(r.redirect, /ihub_code=signature_invalid/);
    assert.ok(!hub.calls.includes('ihub_svc_consume_shop_oauth_state'));
    r = await handleInbound(deps(hub), await req({ shop: 'shop-a.myshopify.com.evil.io', code: 'code-abc123', state, timestamp: '1' }));
    assert.match(r.redirect, /signature_invalid/);

    const f = shopifyRoutes();
    r = await handleInbound(deps(hub, { fetch: f }), await req({ shop: SHOP, code: 'code-abc123', state, timestamp: '1761645600' }));
    const u = new URL(r.redirect);
    assert.equal(u.origin + u.pathname, 'https://mad3oom.com/company-dashboard/');
    assert.equal(u.searchParams.get('ihub_result'), 'confirm');
    assert.equal(u.searchParams.get('ihub_provider'), 'shopify');
    assert.equal(u.hash, '#shopify', 'Shopify returns to the Shopify page (completion runs from any page)');
    assert.ok(u.searchParams.get('ihub_completion').length >= 40);
    assert.ok(!hub.calls.includes('ihub_svc_activate') && !hub.calls.includes('ihub_svc_store_credentials'), 'nothing activated by the callback');
    assert.ok(f.calls.every((c) => c.url.startsWith(`https://${SHOP}/`)), 'tokens only travel to the signed shop');
    const held = [...hub.held.values()][0];
    assert.match(held.cipher, /^ihub1\./);
    assert.ok(!held.cipher.includes('shpat_'));

    // state مستعمل
    r = await handleInbound(deps(hub, { fetch: shopifyRoutes() }), await req({ shop: SHOP, code: 'code-abc123', state, timestamp: '1761645600' }));
    assert.match(r.redirect, /state_invalid/);
});

test('OAuth callback: a state started for another shop, missing scopes, or a different shop identity are refused', async () => {
    const hub = callbackHub();
    const st = (n) => n.repeat(43);
    hub.states.set(await C.sha256Hex(st('a')), { connection: CONN, user: USER, shop: 'shop-z.myshopify.com' });
    hub.states.set(await C.sha256Hex(st('b')), { connection: CONN, user: USER, shop: SHOP });
    hub.states.set(await C.sha256Hex(st('c')), { connection: CONN, user: USER, shop: SHOP });
    const req = async (state) => ({ method: 'GET', path: '/shopify/callback', headers: new Headers(), rawBody: new Uint8Array(),
                                    query: await signedQuery({ shop: SHOP, code: 'code-abc123', state, timestamp: '1761645600' }) });
    let r = await handleInbound(deps(hub, { fetch: shopifyRoutes() }), await req(st('a')));
    assert.match(r.redirect, /state_invalid/, 'state bound to shop-z');
    r = await handleInbound(deps(hub, { fetch: shopifyRoutes('read_orders') }), await req(st('b')));
    assert.match(r.redirect, /forbidden_scope/);
    assert.equal(hub.held.size, 0);
    r = await handleInbound(deps(hub, { fetch: shopifyRoutes(undefined, 'other.myshopify.com') }), await req(st('c')));
    assert.match(r.redirect, /auth_failed/);
    assert.equal(hub.held.size, 0);
});

test('install link from Shopify: signed and fresh → dashboard with the shop prefilled; nothing stored; stale or unsigned → error', async () => {
    const hub = new FakeShopHub();
    const ts = String(Math.floor(NOW / 1000));
    let r = await handleInbound(deps(hub), { method: 'GET', path: '/shopify/install', headers: new Headers(), rawBody: new Uint8Array(),
                                             query: await signedQuery({ shop: SHOP, timestamp: ts, host: 'abc' }) });
    assert.equal(new URL(r.redirect).searchParams.get('ihub_shop'), SHOP);
    assert.equal(new URL(r.redirect).hash, '#shopify', 'lands on the Shopify page, where the shop is prefilled');
    assert.equal(hub.calls.length, 0);
    r = await handleInbound(deps(hub), { method: 'GET', path: '/shopify/install', headers: new Headers(), rawBody: new Uint8Array(),
                                         query: await signedQuery({ shop: SHOP, timestamp: String(Math.floor(NOW / 1000) - 3600) }) });
    assert.match(r.redirect, /signature_invalid/);
});

/* ══ الويب هوك ════════════════════════════════════════════════════════════ */

test('webhooks: base64 HMAC of the raw body with the app secret; a bad signature is 401 and writes nothing; no secret is 503', async () => {
    const hub = new FakeShopHub();
    hub.add(CONN);
    let r = await handleInbound(deps(hub), await webhook('orders/updated', { id: 1001, updated_at: '2026-10-28T09:00:00Z' }, { tamper: true }));
    assert.equal(r.status, 401);
    r = await handleInbound(deps(hub), await webhook('orders/updated', { id: 1001 }, { secret: 'other' }));
    assert.equal(r.status, 401);
    assert.equal(hub.calls.length, 0);
    r = await handleInbound(deps(hub, { env: { SHOPIFY_CLIENT_SECRET: '' } }), await webhook('orders/updated', { id: 1001 }));
    assert.equal(r.status, 503);
    const bad = await webhook('orders/updated', { id: 1001 });
    bad.headers.set('x-shopify-shop-domain', 'evil.com');
    // التوقيع صحيح لكن النطاق ليس myshopify: لا يُصدَّق
    r = await handleInbound(deps(hub), bad);
    assert.equal(r.status, 400);
});

test('webhooks: order events are queued once per webhook id (the worker refetches); unknown shops store nothing', async () => {
    const hub = new FakeShopHub();
    hub.add(CONN);
    let r = await handleInbound(deps(hub), await webhook('orders/updated', { id: 1001, updated_at: '2026-10-28T09:00:00Z', email: 'sara@example.com' }));
    assert.equal(r.status, 200);
    assert.deepEqual([hub.events[0].type, hub.events[0].ext, hub.events[0].topic], ['order', '1001', 'orders/updated']);
    r = await handleInbound(deps(hub), await webhook('orders/updated', { id: 1001, updated_at: '2026-10-28T09:00:00Z' }));
    assert.equal(r.body.duplicate, true);
    assert.equal(hub.events.length, 1);
    await handleInbound(deps(hub), await webhook('refunds/create', { id: 9, order_id: 1001, created_at: '2026-10-28T09:30:00Z' }, { id: 'wh-2' }));
    assert.equal(hub.events[1].ext, '1001', 'a refund refreshes its order');
    r = await handleInbound(deps(hub), await webhook('orders/updated', { id: 1001 }, { shop: 'nobody.myshopify.com', id: 'wh-3' }));
    assert.equal(r.body.ignored, 'unknown_shop');
    assert.equal(hub.events.length, 2);
    assert.ok(!JSON.stringify(hub.events).includes('sara@'), 'no payload is stored');
});

test('webhooks: deletes forget the record; app/uninstalled revokes even when the provider is switched off; scope loss is a health error', async () => {
    const hub = new FakeShopHub();
    hub.add(CONN, { enabled: false });
    await handleInbound(deps(hub), await webhook('products/delete', { id: 77 }, { id: 'd1' }));
    assert.deepEqual(hub.forgotten, [], 'disabled provider: data events are dropped');
    const r = await handleInbound(deps(hub), await webhook('app/uninstalled', { id: 9 }, { id: 'u1' }));
    assert.equal(r.body.revoked, true);
    assert.equal(hub.conns.get(CONN).status, 'reauth_required');

    const hub2 = new FakeShopHub();
    hub2.add(CONN);
    await handleInbound(deps(hub2), await webhook('products/delete', { id: 77 }, { id: 'd2' }));
    await handleInbound(deps(hub2), await webhook('customers/delete', { id: 555 }, { id: 'd3' }));
    assert.deepEqual(hub2.forgotten, [['product', '77'], ['customer', '555']]);
    await handleInbound(deps(hub2), await webhook('app/scopes_update', { previous: ['read_orders', 'read_customers', 'read_products'], current: ['read_orders'] }, { id: 's1' }));
    assert.deepEqual(hub2.scopes.get(CONN), ['read_orders']);
    assert.deepEqual(hub2.health.at(-1), [CONN, false, 'forbidden_scope']);
});

test('compliance webhooks: processed for any verified shop (even unknown or switched off), with ids only', async () => {
    const hub = new FakeShopHub();
    await handleInbound(deps(hub), await webhook('customers/redact', { shop_id: 9, shop_domain: SHOP,
        customer: { id: 555, email: 'sara@example.com', phone: '+20' }, orders_to_redact: [1001, 1002, 'x'] }, { id: 'c1' }));
    await handleInbound(deps(hub), await webhook('customers/data_request', { shop_id: 9, shop_domain: SHOP,
        customer: { id: 555, email: 'sara@example.com' }, orders_requested: [1001], data_request: { id: 9001 } }, { id: 'c2' }));
    const r = await handleInbound(deps(hub), await webhook('shop/redact', { shop_id: 9, shop_domain: SHOP }, { id: 'c3' }));
    assert.equal(r.status, 200);
    assert.deepEqual(hub.compliance.map((c) => [c.p_topic, c.p_customer_id, c.p_order_ids, c.p_request_ref]), [
        ['customers/redact', '555', ['1001', '1002'], null],
        ['customers/data_request', '555', ['1001'], '9001'],
        ['shop/redact', null, [], null]
    ]);
    assert.ok(!JSON.stringify(hub.compliance).includes('sara@'), 'e-mail and phone are not passed on');
});

/* ══ ihub-api ═════════════════════════════════════════════════════════════ */

test('api shopify_start: needs the app configured; the shop is validated server-side; only hashes reach the database', async () => {
    const hub = new FakeShopHub();
    const seen = [];
    const userRpc = async (n, a) => { seen.push([n, a]); return { connection_id: CONN }; };
    let r = await handleApi(deps(hub, { userRpc, env: { SHOPIFY_CLIENT_SECRET: '' } }), { action: 'shopify_start', connection_id: CONN, shop: 'shop-a' });
    assert.equal(r.status, 503);
    r = await handleApi(deps(hub, { userRpc }), { action: 'shopify_start', connection_id: CONN, shop: 'evil.com' });
    assert.equal(r.status, 400);
    assert.equal(seen.length, 0, 'no database call for an invalid shop');
    r = await handleApi(deps(hub, { userRpc }), { action: 'shopify_start', connection_id: CONN, shop: 'Shop-A' });
    assert.equal(r.status, 200);
    const u = new URL(r.body.authorize_url);
    assert.equal(u.host, SHOP);
    const [name, args] = seen[0];
    assert.equal(name, 'ihub_shopify_begin');
    assert.equal(args.p_shop, SHOP);
    assert.equal(args.p_state_hash, await C.sha256Hex(u.searchParams.get('state')));
    assert.equal(args.p_binding_hash, await C.sha256Hex(r.body.binding));
    assert.notEqual(r.body.binding, u.searchParams.get('state'));
});

test('api oauth_complete (Shopify): the initiating admin, tab and completion code → activate, store encrypted, scopes, initial sync', async () => {
    const hub = new FakeShopHub();
    hub.add(CONN, { status: 'pending' });
    const binding = 'b'.repeat(43);
    const completion = 'c'.repeat(43);
    hub.bindingHash = await C.sha256Hex(binding);
    const tokens = { access_token: 'shpat_' + 'a'.repeat(32), refresh_token: 'shprt_' + 'b'.repeat(32), expires_at: '2026-10-28T11:00:00Z',
                     scope: 'read_customers,read_orders,read_products' };
    hub.held.set('x', { cipher: await C.encryptJson(ENC_KEY, { tokens, shop: { domain: SHOP, name: 'Shop A', gid: 'gid://shopify/Shop/9' } }, C.oauthPendingAad(CONN)),
                        completion: await C.sha256Hex(completion) });
    const userRpc = async (n) => (n === 'ihub_authorize' ? { connection_id: CONN, provider: 'shopify', actor_id: USER }
                                                         : { connection_id: CONN, provider: 'shopify', actor_id: USER });
    let r = await handleApi(deps(hub, { userRpc }), { action: 'oauth_complete', connection_id: CONN, binding: 'x'.repeat(43), completion });
    assert.equal(r.status, 409, 'another tab');
    r = await handleApi(deps(hub, { userRpc }), { action: 'oauth_complete', connection_id: CONN, binding, completion });
    assert.equal(r.status, 200);
    assert.equal(hub.conns.get(CONN).external_account_id, SHOP);
    assert.equal(hub.conns.get(CONN).base_url, `https://${SHOP}`);
    assert.equal((await hub.creds_of(CONN)).refresh_token, tokens.refresh_token);
    assert.equal(hub.creds.get(CONN).token_expires_at, '2026-10-28T11:00:00Z');
    assert.deepEqual(hub.scopes.get(CONN), ['read_customers', 'read_orders', 'read_products']);
    assert.deepEqual(hub.jobs.map((j) => j.kind), ['initial']);
    assert.ok(!JSON.stringify(r.body).includes('shpat_'), 'no token in the response');
});

test('api search/get: database authorization first (no provider call when refused); results allowlisted; cache refreshed, never created', async () => {
    const hub = new FakeShopHub();
    hub.add(CONN);
    await hub.putCreds(CONN, { access_token: 'shpat_' + 'a'.repeat(32), expires_at: '2026-10-28T11:00:00Z', scope: 'read_orders,read_customers,read_products' });
    const f = fakeFetch([[isGql, () => gqlOk({ order: orderNode() })]]);
    let r = await handleApi(deps(hub, { fetch: f }), { action: 'shopify_get', connection_id: CONN, kind: 'order', id: '1001' });
    assert.equal(r.status, 404);
    assert.equal(f.calls.length, 0, 'refused before Shopify is called');
    const userRpc = async (n, a) => { assert.equal(n, 'ihub_authorize_lookup'); assert.equal(a.p_mode, 'record'); return { connection_id: CONN }; };
    r = await handleApi(deps(hub, { fetch: f, userRpc }), { action: 'shopify_get', connection_id: CONN, kind: 'order', id: '1001' });
    assert.equal(r.status, 200);
    assert.equal(r.body.record.summary.financial_status, 'paid');
    assert.equal(hub.records.size, 0, 'an uncached order is not stored by viewing it');
    r = await handleApi(deps(hub, { fetch: f, userRpc }), { action: 'shopify_get', connection_id: CONN, kind: 'invoice', id: '1' });
    assert.equal(r.status, 400);
    const limited = async () => { throw { code: 'P0001', message: 'طلبات كثيرة', details: '{"code":"rate_limited"}' }; };
    r = await handleApi(deps(hub, { fetch: f, userRpc: limited }), { action: 'shopify_search', connection_id: CONN, kind: 'order', query: '1001' });
    assert.equal(r.status, 429);
    assert.equal(r.body.error, 'rate_limited');
});

test('api shopify_config: owner-only; reports presence of settings, never their values', async () => {
    const hub = new FakeShopHub();
    let r = await handleApi(deps(hub), { action: 'shopify_config' });
    assert.equal(r.status, 404);
    r = await handleApi(deps(hub, { userRpc: async () => true }), { action: 'shopify_config' });
    assert.equal(r.status, 200);
    assert.equal(r.body.configured.SHOPIFY_CLIENT_SECRET, true);
    assert.equal(r.body.redirect_matches_callback, true);
    assert.equal(r.body.urls.webhooks, 'https://proj.supabase.co/functions/v1/integrations-inbound/shopify/webhooks');
    const text = JSON.stringify(r.body);
    for (const v of [SECRET, 'client-123', ENC_KEY, 'w'.repeat(40)]) assert.ok(!text.includes(v));
});

/* ══ العامل ═══════════════════════════════════════════════════════════════ */

test('worker sync: pages until done, caches each order, records the high-water mark and finishes', async () => {
    const hub = new FakeShopHub();
    hub.add(CONN);
    await hub.putCreds(CONN, { access_token: 'shpat_' + 'a'.repeat(32), expires_at: '2026-10-28T11:00:00Z', scope: 'read_orders' });
    hub.claim = [{ id: 7, connection_id: CONN, provider: 'shopify', kind: 'initial', since_at: '2026-09-28T10:00:00Z', cursor: null }];
    let n = 0;
    const f = fakeFetch([[isGql, () => {
        n++;
        return gqlOk({ orders: { pageInfo: { hasNextPage: n < 2, endCursor: `c${n}` }, nodes: [orderNode({ legacyResourceId: String(1000 + n), name: `#${1000 + n}` })] } });
    }]]);
    const out = await runSyncJobs(deps(hub, { fetch: f }));
    assert.deepEqual([out.pages, out.records, out.finished], [2, 2, 1]);
    assert.equal(gqlBody(f.calls[1].init).variables.after, 'c1');
    assert.deepEqual([...hub.records.keys()].sort(), ['order|1001', 'order|1002']);
    assert.ok([...hub.records.values()].every((a) => a.p_create === true && a.p_event_id === null));
    assert.deepEqual(hub.progress.map((p) => p.p_cursor), ['c1', null]);
    assert.deepEqual(hub.finish.map((x) => x.p_outcome), ['succeeded']);
});

test('worker sync: throttling yields the job with the suggested wait; auth failures stop retrying and mark health', async () => {
    const hub = new FakeShopHub();
    hub.add(CONN);
    await hub.putCreds(CONN, { access_token: 'shpat_' + 'a'.repeat(32), expires_at: '2026-10-28T11:00:00Z', scope: 'read_orders' });
    const job = { id: 8, connection_id: CONN, provider: 'shopify', kind: 'incremental', since_at: '2026-10-27T10:00:00Z', cursor: 'c5' };
    hub.claim = [job];
    await runSyncJobs(deps(hub, { fetch: fakeFetch([[isGql, () => respond(200, { errors: [{ extensions: { code: 'THROTTLED' } }],
        extensions: { cost: { requestedQueryCost: 400, throttleStatus: { currentlyAvailable: 0, restoreRate: 50 } } } })]]) }));
    assert.deepEqual(hub.finish.at(-1), { p_job: 8, p_outcome: 'yield', p_delay_seconds: 8 });
    hub.claim = [job];
    await runSyncJobs(deps(hub, { fetch: fakeFetch([[isGql, () => respond(401, {})]]) }));
    assert.deepEqual(hub.finish.at(-1), { p_job: 8, p_outcome: 'failed', p_error_code: 'auth_failed', p_retry: false });
    assert.deepEqual(hub.health.at(-1), [CONN, false, 'auth_failed']);
    hub.claim = [job];
    await runSyncJobs(deps(hub, { fetch: fakeFetch([[isGql, () => respond(503, {})]]) }));
    assert.deepEqual(hub.finish.at(-1), { p_job: 8, p_outcome: 'failed', p_error_code: 'provider_unavailable', p_retry: true });
});

test('worker events: Shopify orders are created from events, customers/products only refreshed; vanished records are ignored, not dead', async () => {
    const hub = new FakeShopHub();
    hub.add(CONN);
    await hub.putCreds(CONN, { access_token: 'shpat_' + 'a'.repeat(32), expires_at: '2026-10-28T11:00:00Z', scope: 'read_orders,read_customers,read_products' });
    hub.due = [{ id: 1, connection_id: CONN, provider: 'shopify', external_type: 'order', external_id: '1001', topic: 'orders/updated' },
               { id: 2, connection_id: CONN, provider: 'shopify', external_type: 'product', external_id: '77', topic: 'products/update' },
               { id: 3, connection_id: CONN, provider: 'shopify', external_type: 'order', external_id: '404', topic: 'orders/updated' }];
    const f = fakeFetch([
        [(u, i) => isGql(u) && gqlBody(i).variables.id === 'gid://shopify/Order/1001', () => gqlOk({ order: orderNode() })],
        [(u, i) => isGql(u) && gqlBody(i).variables.id === 'gid://shopify/Product/77', () => gqlOk({ shop: { currencyCode: 'EGP' },
            product: { legacyResourceId: '77', title: 'Shirt', handle: 'shirt', status: 'ACTIVE', updatedAt: '2026-10-28T09:00:00Z', totalInventory: 5,
                       variants: { nodes: [{ legacyResourceId: '1', title: 'L', sku: 'SH-L', price: '125.00', inventoryQuantity: 5 }] } } })],
        [(u, i) => isGql(u) && gqlBody(i).variables.id === 'gid://shopify/Order/404', () => gqlOk({ order: null })],
        [isGql, () => gqlOk({ orders: { nodes: [] } })]
    ]);
    const out = await retryDueEvents(deps(hub, { fetch: f }));
    assert.equal(out.processed, 2);
    assert.ok(hub.records.has('order|1001'), 'order created from the event');
    assert.ok(!hub.records.has('product|77'), 'uncached product is not created');
    assert.deepEqual(hub.ignoredEvents.map((e) => e.p_event), [3]);
    assert.equal(hub.failedEvents, undefined);
});

/* ══ حراسة ثابتة ═══════════════════════════════════════════════════════════ */

test('static: shopify.app.toml subscribes exactly the handled topics + the three compliance topics, and lists exactly the requested scopes', () => {
    const toml = read('integrations/shopify/shopify.app.toml');
    const scopes = toml.match(/^scopes\s*=\s*"([^"]+)"/m)[1].split(',').map((s) => s.trim()).sort();
    assert.deepEqual(scopes, [...S.REQUESTED_SCOPES].sort());
    assert.match(toml, /^api_version\s*=\s*"2026-10"/m);
    const topics = [...toml.matchAll(/^\s*topics\s*=\s*\[([^\]]+)\]/gm)].flatMap((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
    assert.deepEqual(topics.sort(), [...S.SUBSCRIBED_TOPICS].sort());
    const compliance = [...toml.matchAll(/^\s*compliance_topics\s*=\s*\[([^\]]+)\]/gm)].flatMap((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
    assert.deepEqual(compliance.sort(), [...S.COMPLIANCE_TOPICS].sort());
    // 120: نطاقات الكتابة = نطاقات عمليات الإدارة المنفّذة فقط، ولا أسرار
    assert.deepEqual(scopes.filter((x) => x.startsWith('write_')), S.MANAGEMENT_SCOPES.filter((x) => x.startsWith('write_')).sort());
    assert.doesNotMatch(scopes.join(','), /read_all_orders|write_fulfillments|assigned_fulfillment|third_party_fulfillment/);
    assert.doesNotMatch(toml, /client_secret\s*=|shpss_/);
    assert.match(toml, /embedded\s*=\s*false/);
    // App URL = المعالج الموقَّع للتثبيت على نفس مضيف رابط الرجوع والويب هوك
    const redirect = toml.match(/^redirect_urls\s*=\s*\[\s*"([^"]+)"/m)[1];
    const appUrl = toml.match(/^application_url\s*=\s*"([^"]+)"/m)[1];
    assert.equal(appUrl, redirect.replace(/\/shopify\/callback$/, '/shopify/install'));
    assert.match(toml, /^use_legacy_install_flow\s*=\s*true/m, 'OAuth started by Mad3oom with per-store scopes in the URL');
});

test('static: Shopify tokens never reach a log line; no write mutation exists in the connector', () => {
    assert.equal(redactString('token shpat_' + 'a'.repeat(32) + ' and shprt_' + 'b'.repeat(32)), 'token [REDACTED] and [REDACTED]');
    const src = read('supabase/functions/_shared/integrations/shopify.js');
    assert.doesNotMatch(src, /\bmutation\b/, 'read-only connector: no GraphQL mutation');
    assert.doesNotMatch(src, /console\./);
});
