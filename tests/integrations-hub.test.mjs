// ============================================================================
// مركز التكاملات — طبقة الموصلات والمعالجات (node، بلا شبكة).
//
// كل نداء خارجي يمر بـ fetch مزيّف يسجّل الطلبات؛ والقاعدة تُمثّلها FakeHub
// بنفس عقد دوال ihub_svc_* (سلوكها الحقيقي مختبر في tests/sql/integrations-hub.test.sql).
//
// تنبيه صدق: هذه اختبارات بمحاكيات. لا شيء هنا يثبت أن ووكومرس أو سلة أو
// دفترة الحقيقية تقبل هذه الطلبات — انظر docs/integrations/PROVIDER_*.md.
// ============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import * as C from '../supabase/functions/_shared/integrations/crypto.js';
import { validateExternalUrl, safeFetch } from '../supabase/functions/_shared/integrations/http.js';
import { redactString, sanitizeLogFields, maskEmail } from '../supabase/functions/_shared/integrations/redact.js';
import { OPERATIONS, describe, invoke, supports, shortText } from '../supabase/functions/_shared/integrations/contract.js';
import { ConnectorError } from '../supabase/functions/_shared/integrations/errors.js';
import { CONNECTORS } from '../supabase/functions/_shared/integrations/registry.js';
import * as Woo from '../supabase/functions/_shared/integrations/woocommerce.js';
import * as Salla from '../supabase/functions/_shared/integrations/salla.js';
import * as Daftra from '../supabase/functions/_shared/integrations/daftra.js';
import * as WP from '../supabase/functions/_shared/integrations/wordpress.js';
import { handleApi } from '../supabase/functions/_shared/integrations/api.js';
import { handleInbound } from '../supabase/functions/_shared/integrations/inbound.js';
import { handleWorker } from '../supabase/functions/_shared/integrations/worker.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const ENC_KEY = 'k'.repeat(48);
const enc = new TextEncoder();

const CONN_A = '11111111-1111-4111-8111-111111111111';
const CONN_B = '22222222-2222-4222-8222-222222222222';
const CONN_S = '33333333-3333-4333-8333-333333333333';
const CONN_W = '44444444-4444-4444-8444-444444444444';
const CONN_D = '55555555-5555-4555-8555-555555555555';
const TICKET = '99999999-9999-4999-8999-999999999999';
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CK = 'ck_' + 'a'.repeat(40);
const CS = 'cs_' + 'b'.repeat(40);

/* ── أدوات ─────────────────────────────────────────────────────────────── */

function respond(status, body, headers = {}) {
    const text = body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
    return new Response(status === 204 || status === 304 ? null : text, { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** fetch مزيّف: routes = [[matcher(url, init), responder(url, init)]]. يسجّل كل نداء. */
function fakeFetch(routes) {
    const calls = [];
    const fn = async (url, init = {}) => {
        calls.push({ url: String(url), init });
        for (const [match, reply] of routes) {
            if (match(String(url), init)) return reply(String(url), init);
        }
        return respond(599, { error: 'unrouted' });
    };
    fn.calls = calls;
    return fn;
}

function hdrs(obj) { return new Headers(obj); }

/** محاكاة دوال الخادم بنفس العقد (السلوك الحقيقي في اختبار SQL). */
class FakeHub {
    constructor() {
        this.connections = new Map();
        this.creds = new Map();
        this.events = [];
        this.records = new Map();
        this.links = [];
        this.nonces = new Set();
        this.intake = [];
        this.health = [];
        this.audits = [];
        this.states = new Map();
        this.calls = [];
        this.failOn = null;
    }
    addConnection(id, provider, extra = {}) {
        this.connections.set(id, {
            connection_id: id, company_id: extra.company_id || 'company-a', provider, status: extra.status || 'active',
            base_url: extra.base_url ?? null, external_account_id: extra.external_account_id ?? null,
            provider_enabled: extra.provider_enabled ?? true
        });
    }
    async putCreds(id, provider, obj, tokenExpiresAt = null) {
        this.creds.set(id, { ciphertext: await C.encryptJson(ENC_KEY, obj, C.credentialAad(id, provider)), token_expires_at: tokenExpiresAt });
    }
    async svc(name, a) {
        this.calls.push(name);
        if (this.failOn === name) throw { code: 'XX000', message: 'boom' };
        switch (name) {
            case 'ihub_svc_get_credentials': {
                const c = this.connections.get(a.p_connection);
                if (!c || c.status === 'disconnected') return null;
                const k = this.creds.get(a.p_connection);
                return { ...c, ciphertext: k?.ciphertext ?? null, key_version: 1, token_expires_at: k?.token_expires_at ?? null };
            }
            case 'ihub_svc_store_credentials':
                this.creds.set(a.p_connection, { ciphertext: a.p_ciphertext, token_expires_at: a.p_token_expires_at });
                return null;
            case 'ihub_svc_activate': {
                for (const o of this.connections.values()) {
                    if (o.connection_id !== a.p_connection && o.provider === this.connections.get(a.p_connection).provider
                        && o.external_account_id === a.p_external_account_id && o.status !== 'disconnected') {
                        throw { code: '23505', message: 'هذا الحساب الخارجي مربوط بشركة أخرى في مدعوم', details: '{"code":"account_in_use"}' };
                    }
                }
                const c = this.connections.get(a.p_connection);
                Object.assign(c, { status: 'active', external_account_id: a.p_external_account_id, base_url: a.p_base_url ?? c.base_url });
                return { id: c.connection_id, provider: c.provider, status: 'active', account_label: a.p_label };
            }
            case 'ihub_svc_record_health':
                this.health.push([a.p_connection, a.p_ok, a.p_error_code]);
                return null;
            case 'ihub_svc_find_connection': {
                for (const c of this.connections.values()) {
                    if (c.provider === a.p_provider && c.external_account_id === a.p_external_account_id && c.status !== 'disconnected') {
                        return { connection_id: c.connection_id, company_id: c.company_id, status: c.status };
                    }
                }
                return null;
            }
            case 'ihub_svc_consume_oauth_state': {
                const s = this.states.get(a.p_state_hash);
                if (!s || s.used) return null;
                s.used = true;
                return s.row;
            }
            case 'ihub_svc_hold_oauth_result': {
                const s = this.states.get(a.p_state_hash);
                if (!s || !s.used || s.pending || s.completed || !/^[0-9a-f]{64}$/.test(a.p_completion_hash)) return false;
                Object.assign(s, { pending: a.p_pending_cipher, completion: a.p_completion_hash });
                return true;
            }
            case 'ihub_svc_take_oauth_result': {
                for (const s of this.states.values()) {
                    if (s.row.connection_id === a.p_connection && s.binding === a.p_binding_hash && s.completion === a.p_completion_hash
                        && s.row.user_id === a.p_user && s.pending && !s.completed) {
                        const c = s.pending;
                        Object.assign(s, { pending: null, completion: null, completed: true });
                        return c;
                    }
                }
                return null;
            }
            case 'ihub_svc_ingest_event': {
                if (this.events.some((e) => e.connection === a.p_connection && e.dedupe === a.p_dedupe_key)) {
                    return { duplicate: true, linked: true };
                }
                const linked = this.records.has(`${a.p_connection}|${a.p_external_type}|${a.p_external_id}`);
                const ev = { id: this.events.length + 1, connection: a.p_connection, dedupe: a.p_dedupe_key, status: linked ? 'received' : 'ignored' };
                this.events.push(ev);
                return { duplicate: false, event_id: ev.id, linked };
            }
            case 'ihub_svc_apply_record': {
                const key = `${a.p_connection}|${a.p_record_type}|${a.p_external_id}`;
                const cur = this.records.get(key);
                let applied = false;
                if (!cur && a.p_create) { this.records.set(key, { id: 'rec-' + this.records.size, ...a }); applied = true; }
                else if (cur && (!cur.p_source_updated_at || !a.p_source_updated_at || a.p_source_updated_at >= cur.p_source_updated_at)) {
                    this.records.set(key, { ...cur, ...a, p_source_updated_at: a.p_source_updated_at ?? cur.p_source_updated_at });
                    applied = true;
                }
                if (a.p_event_id) {
                    const ev = this.events.find((e) => e.id === a.p_event_id);
                    if (ev) ev.status = 'processed';
                }
                return { applied, record_id: this.records.get(key)?.id ?? null };
            }
            case 'ihub_svc_event_failed': {
                const ev = this.events.find((e) => e.id === a.p_event);
                if (ev) { ev.status = a.p_retry ? 'failed' : 'dead'; ev.code = a.p_error_code; }
                return { status: ev?.status };
            }
            case 'ihub_svc_claim_due_events':
                return this.due || [];
            case 'ihub_svc_link_ticket':
                this.links.push([a.p_ticket, a.p_record, a.p_actor]);
                return { link_id: 'link-1', created: true };
            case 'ihub_svc_use_nonce': {
                const k = `${a.p_connection}|${a.p_nonce}`;
                if (this.nonces.has(k)) return false;
                this.nonces.add(k);
                return true;
            }
            case 'ihub_svc_wp_intake':
                if (this.rateLimited) throw { code: 'P0001', message: 'تجاوز حد الطلبات', details: '{"code":"rate_limited"}' };
                this.intake.push(a);
                return { intake_id: 'intake-' + this.intake.length };
            case 'ihub_svc_revoked_by_provider':
                this.connections.get(a.p_connection).status = 'reauth_required';
                this.creds.delete(a.p_connection);
                return null;
            case 'ihub_svc_tokens_due':
                return this.tokensDue || [];
            // 119: مزامنة Shopify (سلوكها في tests/shopify-integration.test.mjs و tests/sql/shopify-store-integration.test.sql)
            case 'ihub_svc_schedule_reconciliation':
                return 0;
            case 'ihub_svc_claim_sync_jobs':
                return [];
            case 'ihub_svc_audit':
                this.audits.push(a);
                return null;
        }
        throw new Error('unexpected rpc ' + name);
    }
}

function deps(hub, { fetch = fakeFetch([]), userRpc = null, env = {}, now = () => Date.parse('2026-10-12T10:00:00Z'), logs = [] } = {}) {
    return {
        env: { IHUB_ENC_KEY: ENC_KEY, IHUB_PUBLIC_BASE: 'https://proj.supabase.co/functions/v1', IHUB_DASHBOARD_URL: 'https://mad3oom.com/company-dashboard/', ...env },
        fetch,
        now,
        svcRpc: (n, a) => hub.svc(n, a),
        userRpc: userRpc || (async () => { throw { code: 'P0002', message: 'الربط غير موجود', details: '{"code":"not_found"}' }; }),
        logger: { log: (l) => logs.push(l) }
    };
}

function wooOrder(over = {}) {
    return {
        id: 501, number: '501', status: 'processing', currency: 'SAR', total: '120.50',
        date_created_gmt: '2026-10-01T09:00:00', date_modified_gmt: '2026-10-02T09:00:00', date_paid_gmt: null,
        customer_id: 12, payment_method: 'cod', payment_method_title: 'الدفع عند الاستلام', transaction_id: 'TXN-SECRET-1',
        customer_ip_address: '203.0.113.9', customer_user_agent: 'Mozilla', customer_note: 'اتصل بي على 0500000000',
        billing: { first_name: 'سارة', last_name: 'أحمد', email: 'sara@example.com', phone: '0500000000', address_1: 'شارع 1', city: 'الرياض' },
        shipping: { address_1: 'شارع 1', city: 'الرياض' },
        meta_data: [{ key: '_secret', value: 'x' }],
        line_items: [{ name: 'قميص', quantity: 2, price: 10 }, { name: 'حذاء', quantity: 1 }],
        refunds: [],
        ...over
    };
}

/* ══ التشفير ═══════════════════════════════════════════════════════════════ */

test('crypto: AES-GCM round trip, and a ciphertext moved to another connection does not decrypt (AAD)', async () => {
    const aad = C.credentialAad(CONN_A, 'woocommerce');
    const ct = await C.encryptJson(ENC_KEY, { consumer_secret: CS }, aad);
    assert.match(ct, /^ihub1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.ok(!ct.includes(CS));
    assert.deepEqual(await C.decryptJson(ENC_KEY, ct, aad), { consumer_secret: CS });
    await assert.rejects(C.decryptJson(ENC_KEY, ct, C.credentialAad(CONN_B, 'woocommerce')));
    await assert.rejects(C.decryptJson(ENC_KEY, ct, C.credentialAad(CONN_A, 'salla')));
    await assert.rejects(C.decryptJson('z'.repeat(48), ct, aad));
    await assert.rejects(C.encryptJson('short', {}, aad), /32 characters/);
    await assert.rejects(C.encryptJson(ENC_KEY, {}, ''), /AAD/);
});

test('crypto: timing-safe compare and HMAC encodings', async () => {
    assert.ok(C.timingSafeEqual('abc', 'abc'));
    assert.ok(!C.timingSafeEqual('abc', 'abd'));
    assert.ok(!C.timingSafeEqual('abc', 'abcd'));
    assert.ok(!C.timingSafeEqual('', 'a'));
    // متجه الاختبار المعروف لـHMAC-SHA256
    const mac = await C.hmacSha256('key', 'The quick brown fox jumps over the lazy dog');
    assert.equal(C.bytesToHex(mac), 'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8');
    assert.equal(C.b64UrlToBytes(C.bytesToB64Url(mac)).length, 32);
});

/* ══ HTTP آمن ══════════════════════════════════════════════════════════════ */

test('http: user URLs — https only, no IPs, no internal names, no ports, no credentials, no query', () => {
    assert.equal(validateExternalUrl('https://Shop.Example.com/store/'), 'https://shop.example.com/store');
    assert.equal(validateExternalUrl('https://fax.de'), 'https://fax.de', 'hex-looking letters are a real host');
    for (const bad of [
        'http://shop.example.com', 'https://127.0.0.1', 'https://10.0.0.5', 'https://169.254.169.254', 'https://[::1]',
        'https://2130706433', 'https://0x7f.1', 'https://localhost', 'https://db.internal', 'https://printer.local',
        'https://intranet', 'https://shop.example.com:8443', 'https://user:pass@shop.example.com',
        'https://shop.example.com/?x=1', 'https://shop.example.com/#a',
        'ftp://shop.example.com', 'javascript:alert(1)', '', 'not a url', 'https://metadata.google.internal'
    ]) {
        assert.throws(() => validateExternalUrl(bad), (e) => e instanceof ConnectorError && e.code === 'invalid_url', bad);
    }
    // المحلّل يطوي ../ قبل أي فحص، فلا يبقى صعود في المسار المخزَّن
    assert.equal(validateExternalUrl('https://shop.example.com/../../etc'), 'https://shop.example.com/etc');
    assert.equal(validateExternalUrl('https://shop.example.com/%2e%2e/x'), 'https://shop.example.com/x');
    assert.throws(() => validateExternalUrl('https://evil.com', { allowedHostSuffixes: ['daftra.com'] }), /invalid_url/);
    assert.equal(validateExternalUrl('https://acme.daftra.com', { allowedHostSuffixes: ['daftra.com'] }), 'https://acme.daftra.com');
});

test('http: redirects are refused, timeouts and oversized bodies are bounded, network errors are opaque', async () => {
    const redirect = fakeFetch([[() => true, () => respond(302, '', { location: 'http://169.254.169.254/' })]]);
    await assert.rejects(safeFetch(redirect, 'https://a.example/x'), (e) => e.code === 'redirect_refused');
    assert.equal(redirect.calls[0].init.redirect, 'manual');

    const slow = async (_u, init) => new Promise((_r, reject) => init.signal.addEventListener('abort', () => {
        const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
    }));
    await assert.rejects(safeFetch(slow, 'https://a.example/x', { timeoutMs: 20 }), (e) => e.code === 'timeout');

    const big = fakeFetch([[() => true, () => new Response(new ReadableStream({
        start(c) { for (let i = 0; i < 20; i++) c.enqueue(new Uint8Array(1024)); c.close(); }
    }), { status: 200 })]]);
    await assert.rejects(safeFetch(big, 'https://a.example/x', { maxBytes: 4096 }), (e) => e.code === 'response_too_large');
    const declared = fakeFetch([[() => true, () => respond(200, 'x', { 'content-length': '999999999' })]]);
    await assert.rejects(safeFetch(declared, 'https://a.example/x'), (e) => e.code === 'response_too_large');

    const down = async () => { throw new TypeError('getaddrinfo ENOTFOUND secret-internal-host'); };
    await assert.rejects(safeFetch(down, 'https://a.example/x'), (e) => e.code === 'provider_unavailable' && !String(e.message).includes('secret'));
});

/* ══ الحجب ═════════════════════════════════════════════════════════════════ */

test('redaction: keys, tokens, ciphertexts, pairing codes and emails never reach a log line', () => {
    const s = redactString(`key ${CK} secret ${CS} Bearer abcdefghijkl Basic YWJjOmRlZmdoaWo= ihub1.aaa.bbb m3c1.${'x'.repeat(20)} mail sara@example.com`);
    for (const leaked of [CK, CS, 'abcdefghijkl', 'YWJjOmRlZmdoaWo', 'ihub1.aaa', 'sara@example.com']) assert.ok(!s.includes(leaked), leaked);
    const f = sanitizeLogFields({ provider: 'woocommerce', code: 'auth_failed', email: 'sara@example.com', payload: '{...}', body: 'x', connection_id: CONN_A });
    assert.deepEqual(Object.keys(f).sort(), ['code', 'connection_id', 'provider']);
    assert.equal(maskEmail('Sara@Example.com'), 'S***@example.com');
    assert.equal(maskEmail('nope'), null);
});

/* ══ العقد: لا قدرة مزيّفة ═══════════════════════════════════════════════ */

test('contract: every connector declares every operation; unsupported never runs and never "succeeds"', async () => {
    for (const c of Object.values(CONNECTORS)) {
        const d = describe(c);
        assert.deepEqual(Object.keys(d), OPERATIONS, c.key);
        for (const op of OPERATIONS) {
            if (!supports(c, op)) {
                await assert.rejects(invoke(c, op, {}), (e) => e.code === 'unsupported', `${c.key}.${op}`);
                assert.ok(c.operations[op].reason.length > 15, `${c.key}.${op} has a written reason`);
            }
        }
    }
});

test('contract: shortText leaves no tag or angle bracket, even from nested or unterminated tags', () => {
    for (const v of ['<scr<script>ipt>alert(1)</script>', '<<script>script>x', '<img src=x onerror=1', 'a > b < c', '<b>Ali</b>\u0000 Hassan']) {
        const out = shortText(v);
        assert.ok(out === null || !/[<>]/.test(out), `${v} → ${out}`);
    }
    assert.equal(shortText('<b>Ali</b>\u0000 Hassan'), 'Ali Hassan');
    assert.equal(shortText('<p></p>'), null);
    assert.equal(shortText('<scr<script>ipt>alert(1)</script>'), 'iptalert(1)');
    assert.equal(shortText('a > b < c'), 'a b');
    assert.equal(shortText('متجر <i>الورد</i>'), 'متجر الورد');
});

test('contract: connector capabilities match the provider catalog seeded by 088 and 119 (no misleading UI controls)', () => {
    const sql = read('migrations/088_integrations_hub.sql') + read('migrations/119_shopify_store_integration.sql');
    const catalog = {};
    for (const m of sql.matchAll(/\('(wordpress|woocommerce|salla|daftra|shopify)', '[^']+', '[^']+', '[a-z_0-9]+', jsonb_build_object\(([\s\S]*?)\)\)/g)) {
        catalog[m[1]] = Object.fromEntries([...m[2].matchAll(/'([a-z_]+)', '([a-z_]+)'/g)].map((x) => [x[1], x[2]]));
    }
    assert.deepEqual(Object.keys(catalog).sort(), ['daftra', 'salla', 'shopify', 'woocommerce', 'wordpress']);
    const MAP = { fetchOrder: 'fetch_order', fetchInvoice: 'fetch_invoice', fetchCustomer: 'fetch_customer', handleWebhook: 'webhooks',
                  syncRecords: 'incremental_sync', refreshCredentials: 'refresh_credentials' };
    // 119: القدرتان الجديدتان مسجّلتان في كتالوج Shopify وحده (البقية: الموصل يعلنها unsupported)
    for (const [key, c] of Object.entries(CONNECTORS)) {
        const live = new Set(['implemented_unverified', 'implemented_verified', 'partial']);
        assert.equal(supports(c, 'fetchProduct'), live.has(catalog[key].fetch_product), `${key}.fetchProduct`);
        assert.equal(supports(c, 'search'), live.has(catalog[key].search), `${key}.search`);
    }
    const live = new Set(['implemented_unverified', 'implemented_verified', 'partial']);
    for (const [key, c] of Object.entries(CONNECTORS)) {
        for (const [op, cap] of Object.entries(MAP)) {
            if (key === 'wordpress' && op === 'handleWebhook') continue; // signed plugin requests, catalog: not_applicable
            assert.equal(supports(c, op), live.has(catalog[key][cap]), `${key}.${op} vs catalog ${cap}=${catalog[key][cap]}`);
        }
        assert.ok(!Object.values(catalog[key]).includes('implemented_verified'), `${key}: nothing is verified against a live provider yet`);
    }
});

/* ══ ووكومرس ═══════════════════════════════════════════════════════════════ */

test('woocommerce: connect input — https store, ck_/cs_ keys, a fresh webhook secret', () => {
    const n = Woo.normalizeConnectInput({ store_url: 'https://Shop.example.com/', consumer_key: CK, consumer_secret: CS });
    assert.equal(n.baseUrl, 'https://shop.example.com');
    assert.equal(n.externalAccountId, 'https://shop.example.com/');
    assert.match(n.credentials.webhook_secret, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(Woo.normalizeConnectInput({ store_url: 'https://shop.example.com', consumer_key: CK, consumer_secret: CS }).credentials.webhook_secret,
                    n.credentials.webhook_secret);
    assert.throws(() => Woo.normalizeConnectInput({ store_url: 'http://shop.example.com', consumer_key: CK, consumer_secret: CS }), /invalid_url/);
    assert.throws(() => Woo.normalizeConnectInput({ store_url: 'https://shop.example.com', consumer_key: 'admin', consumer_secret: CS }), /invalid_input/);
});

test('woocommerce: verify uses Basic auth over https with no redirects, and maps provider errors to fixed codes', async () => {
    const ctx = (status, body) => ({ fetch: fakeFetch([[() => true, () => respond(status, body)]]), baseUrl: 'https://shop.example.com',
                                     credentials: { consumer_key: CK, consumer_secret: CS } });
    const good = ctx(200, []);
    assert.deepEqual(await invoke(Woo.woocommerce, 'verifyConnection', good), { ok: true });
    const call = good.fetch.calls[0];
    assert.equal(call.url, 'https://shop.example.com/wp-json/wc/v3/orders?per_page=1');
    assert.equal(call.init.headers.Authorization, 'Basic ' + btoa(`${CK}:${CS}`));
    assert.equal(call.init.redirect, 'manual');
    assert.equal(call.init.method, 'GET');
    await assert.rejects(invoke(Woo.woocommerce, 'verifyConnection', ctx(401, { message: `invalid ${CK}` })), (e) => e.code === 'auth_failed' && !e.message.includes('ck_'));
    await assert.rejects(invoke(Woo.woocommerce, 'verifyConnection', ctx(403, {})), (e) => e.code === 'forbidden_scope');
    await assert.rejects(invoke(Woo.woocommerce, 'verifyConnection', ctx(404, {})), (e) => e.code === 'api_not_found');
    await assert.rejects(invoke(Woo.woocommerce, 'verifyConnection', ctx(429, {})), (e) => e.code === 'rate_limited' && e.retryable);
    await assert.rejects(invoke(Woo.woocommerce, 'verifyConnection', ctx(503, {})), (e) => e.code === 'provider_unavailable' && e.retryable);
});

test('woocommerce: an order is reduced to the support allowlist (no address, phone, IP, transaction id, notes or meta)', () => {
    const r = Woo.mapOrder(wooOrder(), 'https://shop.example.com');
    assert.equal(r.record_type, 'order');
    assert.equal(r.external_id, '501');
    assert.equal(r.display_ref, '#501');
    assert.equal(r.summary.total, '120.50');
    assert.equal(r.summary.currency, 'SAR');
    assert.equal(r.summary.customer_email_masked, 's***@example.com');
    assert.equal(r.summary.item_count, 3);
    assert.equal(r.source_updated_at, '2026-10-02T09:00:00.000Z');
    const flat = JSON.stringify(r);
    for (const leaked of ['sara@example.com', '0500000000', '203.0.113.9', 'TXN-SECRET-1', 'شارع 1', 'Mozilla', '_secret', 'اتصل بي', 'cod"']) {
        assert.ok(!flat.includes(leaked), `leaked ${leaked}`);
    }
    assert.equal(Woo.mapOrder(wooOrder({ customer_id: 0 }), 'https://s.example').summary.guest, true);
    assert.throws(() => Woo.mapOrder({ id: 'x' }, 'https://s.example'), /invalid_response/);
    const huge = Woo.mapOrder(wooOrder({ line_items: Array.from({ length: 200 }, (_, i) => ({ name: 'منتج طويل '.repeat(20) + i, quantity: 1 })) }), 'https://s.example');
    assert.equal(huge.summary.items.length, 10);
    assert.ok(new TextEncoder().encode(JSON.stringify(huge.summary)).length < 3800);
});

test('woocommerce: fetchOrder tries the id, then matches the displayed number exactly (sequential-number plugins)', async () => {
    const f = fakeFetch([
        [(u) => u.endsWith('/orders/1007'), () => respond(404, { code: 'woocommerce_rest_shop_order_invalid_id' })],
        [(u) => u.includes('/orders?search=1007'), () => respond(200, [wooOrder({ id: 88, number: '10070' }), wooOrder({ id: 89, number: '1007' })])]
    ]);
    const r = await invoke(Woo.woocommerce, 'fetchOrder', { fetch: f, baseUrl: 'https://s.example', credentials: { consumer_key: CK, consumer_secret: CS } }, '#1007');
    assert.equal(r.external_id, '89');
    await assert.rejects(invoke(Woo.woocommerce, 'fetchOrder', { fetch: f, baseUrl: 'https://s.example', credentials: {} }, '1 OR 1=1'), /invalid_input/);
    const none = fakeFetch([[(u) => u.endsWith('/orders/5'), () => respond(404, {})], [() => true, () => respond(200, [])]]);
    await assert.rejects(invoke(Woo.woocommerce, 'fetchOrder', { fetch: none, baseUrl: 'https://s.example', credentials: {} }, '5'), (e) => e.code === 'not_found');
});

test('woocommerce webhook: ping is answered without effects; signatures are base64 HMAC-SHA256 of the raw body', async () => {
    const ctx = { credentials: { webhook_secret: 'whsec-test-123456' }, baseUrl: 'https://s.example' };
    assert.deepEqual(await invoke(Woo.woocommerce, 'handleWebhook', ctx, { headers: hdrs({}), rawBody: enc.encode('webhook_id=17') }), { ping: true });
    await assert.rejects(invoke(Woo.woocommerce, 'handleWebhook', ctx, { headers: hdrs({}), rawBody: enc.encode('{"id":1}') }), (e) => e.code === 'signature_invalid');

    const raw = enc.encode(JSON.stringify(wooOrder()));
    const sig = C.bytesToB64(await C.hmacSha256('whsec-test-123456', raw));
    const evt = await invoke(Woo.woocommerce, 'handleWebhook', ctx, { headers: hdrs({ 'x-wc-webhook-signature': sig, 'x-wc-webhook-topic': 'order.updated' }), rawBody: raw });
    assert.equal(evt.externalId, '501');
    assert.match(evt.dedupeKey, /^[0-9a-f]{64}$/);
    const again = await invoke(Woo.woocommerce, 'handleWebhook', ctx, { headers: hdrs({ 'x-wc-webhook-signature': sig, 'x-wc-webhook-topic': 'order.updated' }), rawBody: raw });
    assert.equal(again.dedupeKey, evt.dedupeKey, 'a redelivery has the same idempotency key');

    const tampered = enc.encode(JSON.stringify(wooOrder({ total: '1.00' })));
    await assert.rejects(invoke(Woo.woocommerce, 'handleWebhook', ctx, { headers: hdrs({ 'x-wc-webhook-signature': sig, 'x-wc-webhook-topic': 'order.updated' }), rawBody: tampered }),
                         (e) => e.code === 'signature_invalid');
    const hexSig = C.bytesToHex(await C.hmacSha256('whsec-test-123456', raw));
    await assert.rejects(invoke(Woo.woocommerce, 'handleWebhook', ctx, { headers: hdrs({ 'x-wc-webhook-signature': hexSig, 'x-wc-webhook-topic': 'order.updated' }), rawBody: raw }),
                         (e) => e.code === 'signature_invalid', 'hex is not what WooCommerce sends');
    const coupon = await invoke(Woo.woocommerce, 'handleWebhook', ctx, { headers: hdrs({ 'x-wc-webhook-signature': sig, 'x-wc-webhook-topic': 'coupon.created' }), rawBody: raw });
    assert.equal(coupon.ignored, true);
});

/* ══ سلة ═══════════════════════════════════════════════════════════════════ */

test('salla: authorize URL carries state and offline_access; code exchange is a form POST with the client secret', async () => {
    const u = new URL(Salla.authorizeUrl({ clientId: 'cid', redirectUri: 'https://proj.supabase.co/functions/v1/integrations-inbound/salla/callback', state: 'st'.repeat(20) }));
    assert.equal(u.origin + u.pathname, 'https://accounts.salla.sa/oauth2/auth');
    assert.equal(u.searchParams.get('scope'), 'offline_access');
    assert.equal(u.searchParams.get('state'), 'st'.repeat(20));
    assert.equal(u.searchParams.get('response_type'), 'code');

    const f = fakeFetch([[(url) => url === Salla.SALLA_TOKEN_URL, () => respond(200, { access_token: 'acc-1234567890', refresh_token: 'ref-1234567890', expires_in: 1209600 })]]);
    const env = { SALLA_CLIENT_ID: 'cid', SALLA_CLIENT_SECRET: 'csecret', SALLA_REDIRECT_URI: 'https://cb.example/cb' };
    const t = await Salla.exchangeCode({ fetch: f, env, now: () => Date.parse('2026-10-12T00:00:00Z') }, 'auth-code-123');
    assert.equal(t.expires_at, '2026-10-26T00:00:00.000Z');
    const body = new URLSearchParams(f.calls[0].init.body);
    assert.equal(body.get('grant_type'), 'authorization_code');
    assert.equal(body.get('client_secret'), 'csecret');
    assert.equal(f.calls[0].init.method, 'POST');
    await assert.rejects(Salla.exchangeCode({ fetch: f, env: {} }, 'auth-code-123'), (e) => e.code === 'not_configured');
    const bad = fakeFetch([[() => true, () => respond(400, { error: 'invalid_grant' })]]);
    await assert.rejects(Salla.exchangeCode({ fetch: bad, env }, 'auth-code-123'), (e) => e.code === 'auth_failed');
});

test('salla: merchant identity comes from data.merchant.id (official SallaUser shape)', async () => {
    const f = fakeFetch([[() => true, () => respond(200, { status: 200, data: { id: 1, name: 'x', merchant: { id: 1803665367, name: 'متجري' } } })]]);
    assert.deepEqual(await Salla.fetchMerchant({ fetch: f }, 'acc-1234567890'), { externalAccountId: '1803665367', label: 'متجري' });
    assert.equal(f.calls[0].init.headers.Authorization, 'Bearer acc-1234567890');
    const odd = fakeFetch([[() => true, () => respond(200, { data: { merchant: {} } })]]);
    await assert.rejects(Salla.fetchMerchant({ fetch: odd }, 'acc-1234567890'), /invalid_response/);
});

test('salla: an expired access token fails closed without a network call (the worker is the only refresher)', async () => {
    const f = fakeFetch([]);
    const ctx = { fetch: f, now: () => Date.parse('2026-10-12T00:00:00Z'), credentials: { access_token: 'acc', expires_at: '2026-10-11T00:00:00Z' } };
    await assert.rejects(invoke(Salla.salla, 'fetchOrder', ctx, '123'), (e) => e.code === 'token_expired');
    assert.equal(f.calls.length, 0);
});

test('salla webhook: Signature strategy only; hex or base64 of the same HMAC; merchant from the verified body', async () => {
    const env = { SALLA_WEBHOOK_SECRET: 'salla-app-webhook-secret' };
    const raw = enc.encode(JSON.stringify({ event: 'order.updated', merchant: 1803665367, created_at: '2026-10-02 10:00:00',
                                            data: { id: 77, reference_id: 1001, status: { name: 'تم التنفيذ', slug: 'completed' },
                                                    amounts: { total: { amount: 99.5, currency: 'SAR' } },
                                                    customer: { id: 5, first_name: 'علي', email: 'ali@example.com', mobile: '966500000000' } } }));
    const mac = await C.hmacSha256(env.SALLA_WEBHOOK_SECRET, raw);
    for (const sig of [C.bytesToHex(mac), C.bytesToB64(mac)]) {
        const v = await Salla.verifySallaWebhook({ env }, { headers: hdrs({ 'x-salla-security-strategy': 'Signature', 'x-salla-signature': sig }), rawBody: raw });
        assert.equal(v.merchant, '1803665367');
    }
    await assert.rejects(Salla.verifySallaWebhook({ env }, { headers: hdrs({ 'x-salla-security-strategy': 'Token', authorization: 'salla-app-webhook-secret' }), rawBody: raw }),
                         (e) => e.code === 'signature_invalid', 'the Token strategy is refused');
    await assert.rejects(Salla.verifySallaWebhook({ env }, { headers: hdrs({ 'x-salla-security-strategy': 'Signature', 'x-salla-signature': C.bytesToHex(await C.hmacSha256('wrong', raw)) }), rawBody: raw }),
                         (e) => e.code === 'signature_invalid');
    await assert.rejects(Salla.verifySallaWebhook({ env: {} }, { headers: hdrs({}), rawBody: raw }), (e) => e.code === 'not_configured');

    const envelope = await Salla.verifySallaWebhook({ env }, { headers: hdrs({ 'x-salla-security-strategy': 'signature', 'x-salla-signature': C.bytesToHex(mac) }), rawBody: raw });
    const evt = await invoke(Salla.salla, 'handleWebhook', {}, envelope);
    assert.equal(evt.externalId, '77');
    assert.equal(evt.record.display_ref, '#1001');
    assert.equal(evt.record.summary.total, '99.5');
    assert.equal(evt.record.summary.field_mapping, 'unverified');
    assert.ok(!JSON.stringify(evt.record).includes('966500000000') && !JSON.stringify(evt.record).includes('ali@example.com'));
    assert.deepEqual(await invoke(Salla.salla, 'handleWebhook', {}, { ...envelope, event: 'app.uninstalled' }), { revoke: true, topic: 'app.uninstalled' });
    assert.equal((await invoke(Salla.salla, 'handleWebhook', {}, { ...envelope, event: 'product.created' })).ignored, true);
});

/* ══ دفترة ═════════════════════════════════════════════════════════════════ */

test('daftra: only a subdomain is accepted, the host is fixed to daftra.com, the key goes in APIKEY (no Authorization)', async () => {
    assert.equal(Daftra.normalizeConnectInput({ subdomain: 'https://Acme.daftra.com/', api_key: 'k'.repeat(32) }).baseUrl, 'https://acme.daftra.com');
    for (const bad of ['evil.com', 'acme.evil.com', 'acme.daftra.com.evil.com', '127.0.0.1', 'www', '-x', 'a_b', '']) {
        assert.throws(() => Daftra.normalizeConnectInput({ subdomain: bad, api_key: 'k'.repeat(32) }), /invalid_input/, bad);
    }
    const f = fakeFetch([[() => true, () => respond(200, { code: 200, data: [] })]]);
    const ctx = { fetch: f, baseUrl: 'https://acme.daftra.com', credentials: { api_key: 'k'.repeat(32) } };
    await invoke(Daftra.daftra, 'verifyConnection', ctx);
    assert.equal(f.calls[0].url, 'https://acme.daftra.com/api2/clients.json?limit=1');
    assert.equal(f.calls[0].init.headers.APIKEY, 'k'.repeat(32));
    assert.ok(!('Authorization' in f.calls[0].init.headers));
});

test('daftra: invoice and client mapping keep only support fields; unexpected shapes are dropped, never guessed', async () => {
    const r = Daftra.mapInvoice({ code: 200, data: { Invoice: { id: '42', no: 'INV-0042', date: '2026-10-01', currency_code: 'SAR', summary_total: '115.00',
                                                                  summary_paid: '0', summary_unpaid: '115.00', payment_status: '0', client_id: '7',
                                                                  client_business_name: 'شركة النور', client_email: 'x@y.com', client_phone1: '0500' } } });
    assert.equal(r.display_ref, '#INV-0042');
    assert.equal(r.summary.unpaid, '115.00');
    assert.ok(!JSON.stringify(r).includes('x@y.com') && !JSON.stringify(r).includes('0500'));
    const odd = Daftra.mapInvoice({ data: { Invoice: { id: 9, summary_total: { weird: true }, currency_code: 'riyal' } } });
    assert.equal(odd.summary.total, undefined);
    assert.equal(odd.summary.currency, undefined);
    const c = Daftra.mapClient({ data: { Client: { id: 7, business_name: 'شركة النور', email: 'x@y.com', phone1: '0500', address1: 'جدة' } } });
    assert.deepEqual(Object.keys(c.summary).sort(), ['business_name', 'field_mapping']);
    await assert.rejects(invoke(Daftra.daftra, 'handleWebhook', {}), (e) => e.code === 'unsupported');
    await assert.rejects(invoke(Daftra.daftra, 'fetchOrder', {}), (e) => e.code === 'unsupported');
});

/* ══ ووردبريس ══════════════════════════════════════════════════════════════ */

test('wordpress: pairing code round-trips; signed requests reject tampering, other secrets, clock skew', async () => {
    const code = WP.pairingCode({ connectionId: CONN_W, secret: 'site-secret-abcdefghijklmnop', endpoint: 'https://proj.supabase.co/functions/v1/integrations-inbound' });
    assert.match(code, /^m3c1\./);
    assert.equal(WP.parsePairingCode(code).c, CONN_W);
    assert.equal(WP.parsePairingCode('m3c1.garbage'), null);
    assert.equal(WP.parsePairingCode('nope'), null);

    const now = Date.parse('2026-10-12T10:00:00Z');
    const ts = String(Math.floor(now / 1000));
    const body = enc.encode('{"a":1}');
    const sig = await WP.signRequest('site-secret', { timestamp: ts, nonce: 'n'.repeat(24), method: 'POST', path: '/wordpress/v1/ping', rawBody: body });
    const h = (over = {}) => hdrs({ 'x-mad3oom-connection': CONN_W, 'x-mad3oom-timestamp': ts, 'x-mad3oom-nonce': 'n'.repeat(24), 'x-mad3oom-signature': sig, ...over });
    await WP.verifySignedRequest({ secret: 'site-secret', nowMs: now }, { headers: h(), method: 'POST', path: '/wordpress/v1/ping', rawBody: body });
    const reject = (args, label) => assert.rejects(WP.verifySignedRequest(...args), (e) => e.code === 'signature_invalid', label);
    await reject([{ secret: 'other', nowMs: now }, { headers: h(), method: 'POST', path: '/wordpress/v1/ping', rawBody: body }], 'other secret');
    await reject([{ secret: 'site-secret', nowMs: now }, { headers: h(), method: 'POST', path: '/wordpress/v1/intake', rawBody: body }], 'other path');
    await reject([{ secret: 'site-secret', nowMs: now }, { headers: h(), method: 'POST', path: '/wordpress/v1/ping', rawBody: enc.encode('{"a":2}') }], 'other body');
    await reject([{ secret: 'site-secret', nowMs: now + 301_000 }, { headers: h(), method: 'POST', path: '/wordpress/v1/ping', rawBody: body }], 'clock skew');
    await reject([{ secret: 'site-secret', nowMs: now }, { headers: h({ 'x-mad3oom-nonce': 'short' }), method: 'POST', path: '/wordpress/v1/ping', rawBody: body }], 'bad nonce');
});

test('wordpress: the typed site URL is not a platform-unique claim; the signed site must match the registered host', () => {
    const n = WP.normalizeConnectInput({ site_url: 'https://Example.com/blog/' });
    assert.equal(n.externalAccountId, null, 'no global uniqueness: nobody can squat another company\'s domain');
    assert.equal(n.baseUrl, 'https://example.com/blog');
    assert.ok(WP.siteMatches('https://example.com/blog', 'https://www.example.com/'));
    assert.ok(!WP.siteMatches('https://example.com', 'https://example.com.evil.net/'));
    assert.ok(!WP.siteMatches('https://example.com', undefined));
    assert.ok(!WP.siteMatches(null, 'https://example.com/'));
});

test('wordpress: intake fields are validated like the table constraints', () => {
    const ok = WP.validateIntake({ name: ' <b>سارة</b> ', email: 'Sara@Example.com', subject: 'طلبي', message: 'نص', order_ref: '501' });
    assert.deepEqual(ok, { name: 'سارة', email: 'sara@example.com', subject: 'طلبي', message: 'نص', orderRef: '501', siteUserRef: null });
    for (const bad of [{ name: 'a', email: 'bad', subject: 's', message: 'm' }, { name: 'a', email: 'a@b.co', subject: 's', message: 'm', order_ref: '1;drop' },
                       { name: '', email: 'a@b.co', subject: 's', message: 'm' }, { name: 'a', email: 'a@b.co', subject: 's', message: 'x'.repeat(5001) },
                       { name: 'a', email: 'a@b.co', subject: 's', message: 'm', site_user_ref: '42' }]) {
        assert.throws(() => WP.validateIntake(bad), /invalid_payload/);
    }
});

/* ══ ihub-api ══════════════════════════════════════════════════════ */

function authorizeAs(connectionId, provider, status = 'pending', extra = {}) {
    return async (name, a) => {
        if (name === 'ihub_authorize' && a.p_connection === connectionId) {
            return { connection_id: connectionId, company_id: 'company-a', provider, status, base_url: extra.base_url ?? null, actor_id: USER };
        }
        if (name === 'ihub_oauth_begin' && a.p_connection === connectionId) {
            extra.onBegin?.(a);
            return { connection_id: connectionId };
        }
        if (name === 'ihub_authorize_ticket_link' && a.p_connection === connectionId && a.p_ticket === TICKET) {
            return { ticket_id: TICKET, connection_id: connectionId, company_id: 'company-a', provider, base_url: extra.base_url ?? null, actor_id: USER };
        }
        throw { code: 'P0002', message: 'الربط غير موجود', details: '{"code":"not_found"}' };
    };
}

test('api connect (WooCommerce): verifies first, activates, stores only ciphertext, returns the webhook secret once', async () => {
    const hub = new FakeHub();
    hub.addConnection(CONN_A, 'woocommerce', { status: 'pending' });
    const f = fakeFetch([[(u) => u === 'https://shop.example.com/wp-json/wc/v3/orders?per_page=1', () => respond(200, [])]]);
    const logs = [];
    const r = await handleApi(deps(hub, { fetch: f, userRpc: authorizeAs(CONN_A, 'woocommerce'), logs }),
                              { action: 'connect', connection_id: CONN_A, store_url: 'https://shop.example.com', consumer_key: CK, consumer_secret: CS });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.webhook.delivery_url, `https://proj.supabase.co/functions/v1/integrations-inbound/woocommerce/${CONN_A}`);
    assert.deepEqual(r.body.webhook.topics, ['order.created', 'order.updated']);
    const stored = hub.creds.get(CONN_A).ciphertext;
    assert.ok(!stored.includes(CS) && !stored.includes(CK));
    assert.deepEqual(await C.decryptJson(ENC_KEY, stored, C.credentialAad(CONN_A, 'woocommerce')),
                     { consumer_key: CK, consumer_secret: CS, webhook_secret: r.body.webhook.secret });
    assert.ok(hub.calls.indexOf('ihub_svc_activate') < hub.calls.indexOf('ihub_svc_store_credentials'), 'activate (uniqueness) before storing secrets');
    assert.ok(!logs.join('\n').includes(CS) && !logs.join('\n').includes(r.body.webhook.secret), 'no secret in logs');
});

test('api: a connection of another company is refused before any provider call or secret read', async () => {
    const hub = new FakeHub();
    hub.addConnection(CONN_B, 'woocommerce', { status: 'pending', company_id: 'company-b' });
    const f = fakeFetch([]);
    const r = await handleApi(deps(hub, { fetch: f, userRpc: authorizeAs(CONN_A, 'woocommerce') }),
                              { action: 'connect', connection_id: CONN_B, store_url: 'https://shop.example.com', consumer_key: CK, consumer_secret: CS });
    assert.equal(r.status, 404);
    assert.equal(r.body.error, 'not_found');
    assert.equal(f.calls.length, 0);
    assert.deepEqual(hub.calls, []);
    const link = await handleApi(deps(hub, { fetch: f, userRpc: authorizeAs(CONN_A, 'woocommerce') }),
                                 { action: 'link_record', connection_id: CONN_B, ticket_id: TICKET, record_type: 'order', reference: '501' });
    assert.equal(link.status, 404);
    assert.equal(f.calls.length, 0);
});

test('api connect: invalid credentials record a fixed error code and store nothing; a store already used by another company is 409', async () => {
    const hub = new FakeHub();
    hub.addConnection(CONN_A, 'woocommerce', { status: 'pending' });
    const denied = fakeFetch([[() => true, () => respond(401, { code: 'woocommerce_rest_cannot_view', message: `Sorry ${CK}` })]]);
    const r = await handleApi(deps(hub, { fetch: denied, userRpc: authorizeAs(CONN_A, 'woocommerce') }),
                              { action: 'connect', connection_id: CONN_A, store_url: 'https://shop.example.com', consumer_key: CK, consumer_secret: CS });
    assert.equal(r.status, 422);
    assert.deepEqual(r.body, { error: 'auth_failed' });
    assert.deepEqual(hub.health.at(-1), [CONN_A, false, 'auth_failed']);
    assert.equal(hub.creds.size, 0);

    hub.addConnection(CONN_B, 'woocommerce', { company_id: 'company-b', external_account_id: 'https://shop.example.com/' });
    const okFetch = fakeFetch([[() => true, () => respond(200, [])]]);
    const dup = await handleApi(deps(hub, { fetch: okFetch, userRpc: authorizeAs(CONN_A, 'woocommerce') }),
                                { action: 'connect', connection_id: CONN_A, store_url: 'https://shop.example.com', consumer_key: CK, consumer_secret: CS });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error, 'account_in_use');
    assert.equal(hub.creds.size, 0, 'no secret stored for a refused activation');
});

test('api: Salla cannot be connected with submitted credentials; oauth_start stores only the state hash', async () => {
    const hub = new FakeHub();
    const r = await handleApi(deps(hub, { userRpc: authorizeAs(CONN_S, 'salla') }), { action: 'connect', connection_id: CONN_S, access_token: 'x' });
    assert.equal(r.status, 400);
    let begun;
    const env = { SALLA_CLIENT_ID: 'cid', SALLA_CLIENT_SECRET: 'cs', SALLA_REDIRECT_URI: 'https://proj.supabase.co/functions/v1/integrations-inbound/salla/callback' };
    const s = await handleApi(deps(hub, { env, userRpc: authorizeAs(CONN_S, 'salla', 'pending', { onBegin: (a) => { begun = a; } }) }),
                              { action: 'oauth_start', connection_id: CONN_S });
    assert.equal(s.status, 200);
    const state = new URL(s.body.authorize_url).searchParams.get('state');
    assert.equal(begun.p_state_hash, await C.sha256Hex(state));
    assert.equal(begun.p_binding_hash, await C.sha256Hex(s.body.binding));
    assert.notEqual(s.body.binding, state);
    assert.ok(!s.body.authorize_url.includes(s.body.binding), 'the tab binding never goes to Salla');
    assert.ok(!JSON.stringify(begun).includes(state) && !JSON.stringify(begun).includes(s.body.binding), 'raw values are never stored');
    const nc = await handleApi(deps(hub, { userRpc: authorizeAs(CONN_S, 'salla') }), { action: 'oauth_start', connection_id: CONN_S });
    assert.equal(nc.status, 503);
});

test('api link_record: fetches through the connector, caches the allowlisted summary, links the ticket', async () => {
    const hub = new FakeHub();
    hub.addConnection(CONN_A, 'woocommerce', { base_url: 'https://shop.example.com' });
    await hub.putCreds(CONN_A, 'woocommerce', { consumer_key: CK, consumer_secret: CS, webhook_secret: 'w'.repeat(20) });
    const f = fakeFetch([[(u) => u.endsWith('/orders/501'), () => respond(200, wooOrder())]]);
    const r = await handleApi(deps(hub, { fetch: f, userRpc: authorizeAs(CONN_A, 'woocommerce', 'active', { base_url: 'https://shop.example.com' }) }),
                              { action: 'link_record', connection_id: CONN_A, ticket_id: TICKET, record_type: 'order', reference: '#501' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.record.summary.status, 'processing');
    assert.deepEqual(hub.links[0], [TICKET, 'rec-0', USER]);
    assert.ok(!JSON.stringify([...hub.records.values()]).includes('sara@example.com'));
    const wrongType = await handleApi(deps(hub, { fetch: f, userRpc: authorizeAs(CONN_A, 'woocommerce', 'active') }),
                                      { action: 'link_record', connection_id: CONN_A, ticket_id: TICKET, record_type: 'invoice', reference: '1' });
    assert.equal(wrongType.status, 400);
    assert.equal(wrongType.body.error, 'unsupported');
});

test('api test: health is recorded with a fixed code; WordPress has no outbound check and says so', async () => {
    const hub = new FakeHub();
    hub.addConnection(CONN_A, 'woocommerce', { base_url: 'https://shop.example.com' });
    await hub.putCreds(CONN_A, 'woocommerce', { consumer_key: CK, consumer_secret: CS, webhook_secret: 'w'.repeat(20) });
    const r = await handleApi(deps(hub, { fetch: fakeFetch([[() => true, () => respond(500, '<html>stack trace</html>')]]), userRpc: authorizeAs(CONN_A, 'woocommerce', 'active') }),
                              { action: 'test', connection_id: CONN_A });
    assert.deepEqual(r.body, { ok: false, error: 'provider_unavailable' });
    assert.deepEqual(hub.health.at(-1), [CONN_A, false, 'provider_unavailable']);
    const w = await handleApi(deps(hub, { userRpc: authorizeAs(CONN_W, 'wordpress', 'active') }), { action: 'test', connection_id: CONN_W });
    assert.deepEqual(w.body, { ok: null, reason: 'not_applicable' });
});

test('api: database refusals map to fixed HTTP codes, internal errors never leak their text', async () => {
    const forbidden = async () => { throw { code: '42501', message: 'إدارة التكاملات متاحة لمدير الشركة فقط' }; };
    const r = await handleApi(deps(new FakeHub(), { userRpc: forbidden }), { action: 'test', connection_id: CONN_A });
    assert.equal(r.status, 403);
    const internal = async () => { throw { code: 'XX000', message: 'relation ihub_credentials ciphertext ...' }; };
    const i = await handleApi(deps(new FakeHub(), { userRpc: internal }), { action: 'test', connection_id: CONN_A });
    assert.equal(i.status, 500);
    assert.equal(i.body.message, null);
    assert.equal((await handleApi(deps(new FakeHub()), { action: 'drop', connection_id: CONN_A })).status, 400);
    assert.equal((await handleApi(deps(new FakeHub()), { action: 'test', connection_id: 'x' })).status, 400);
});

/* ══ integrations-inbound ══════════════════════════════════════════════════ */

async function wooRequest(secret, order, topic = 'order.updated') {
    const rawBody = enc.encode(JSON.stringify(order));
    const sig = C.bytesToB64(await C.hmacSha256(secret, rawBody));
    return { method: 'POST', path: `/woocommerce/${CONN_A}`, headers: hdrs({ 'x-wc-webhook-signature': sig, 'x-wc-webhook-topic': topic }), rawBody, query: new URLSearchParams() };
}

async function wooHub() {
    const hub = new FakeHub();
    hub.addConnection(CONN_A, 'woocommerce', { base_url: 'https://shop.example.com', external_account_id: 'https://shop.example.com/' });
    await hub.putCreds(CONN_A, 'woocommerce', { consumer_key: CK, consumer_secret: CS, webhook_secret: 'whsec-a-1234567890' });
    return hub;
}

test('inbound WooCommerce: a bad signature is 401 with no database write; the setup ping is 200 with none either', async () => {
    const hub = await wooHub();
    const req = await wooRequest('wrong-secret', wooOrder());
    const r = await handleInbound(deps(hub), req);
    assert.equal(r.status, 401);
    assert.deepEqual(hub.calls, ['ihub_svc_get_credentials']);
    const ping = await handleInbound(deps(hub), { method: 'POST', path: `/woocommerce/${CONN_A}`, headers: hdrs({}), rawBody: enc.encode('webhook_id=3'), query: new URLSearchParams() });
    assert.deepEqual([ping.status, ping.body.ping], [200, true]);
    assert.equal(hub.events.length, 0);
    const unknown = await handleInbound(deps(hub), { ...req, path: '/woocommerce/not-a-uuid' });
    assert.equal(unknown.status, 404);
});

test('inbound WooCommerce: unlinked orders are acknowledged and not cached; linked ones update; redelivery is a no-op', async () => {
    const hub = await wooHub();
    let r = await handleInbound(deps(hub), await wooRequest('whsec-a-1234567890', wooOrder()));
    assert.deepEqual(r.body, { ok: true, ignored: 'not_linked' });
    assert.equal(hub.records.size, 0);

    hub.records.set(`${CONN_A}|order|501`, { id: 'rec-x', p_source_updated_at: '2026-10-01T00:00:00.000Z' });
    const newer = await wooRequest('whsec-a-1234567890', wooOrder({ status: 'completed', date_modified_gmt: '2026-10-03T00:00:00' }));
    r = await handleInbound(deps(hub), newer);
    assert.deepEqual(r.body, { ok: true, applied: true });
    r = await handleInbound(deps(hub), newer);
    assert.deepEqual(r.body, { ok: true, duplicate: true });
    assert.equal(hub.calls.filter((c) => c === 'ihub_svc_apply_record').length, 1, 'applied exactly once');

    const older = await wooRequest('whsec-a-1234567890', wooOrder({ status: 'processing', date_modified_gmt: '2026-10-02T00:00:00' }));
    r = await handleInbound(deps(hub), older);
    assert.deepEqual(r.body, { ok: true, applied: false }, 'out-of-order event does not roll the status back');
    assert.equal(hub.records.get(`${CONN_A}|order|501`).p_summary.status, 'completed');
});

test('inbound WooCommerce: a processing failure is acknowledged (200) and queued for the worker; a disabled provider drops events', async () => {
    const hub = await wooHub();
    hub.records.set(`${CONN_A}|order|501`, { id: 'rec-x' });
    hub.failOn = 'ihub_svc_apply_record';
    const r = await handleInbound(deps(hub), await wooRequest('whsec-a-1234567890', wooOrder()));
    assert.deepEqual(r.body, { ok: true, queued: true });
    assert.equal(hub.events[0].status, 'failed');

    const off = await wooHub();
    off.connections.get(CONN_A).provider_enabled = false;
    const d = await handleInbound(deps(off), await wooRequest('whsec-a-1234567890', wooOrder()));
    assert.deepEqual(d.body, { ok: true, ignored: 'disabled' });
    assert.equal(off.events.length, 0);
});

async function sallaRequest(secret, body) {
    const rawBody = enc.encode(JSON.stringify(body));
    const sig = C.bytesToHex(await C.hmacSha256(secret, rawBody));
    return { method: 'POST', path: '/salla', headers: hdrs({ 'x-salla-security-strategy': 'Signature', 'x-salla-signature': sig }), rawBody, query: new URLSearchParams() };
}

test('inbound Salla: unknown merchants are ignored without storage; app.uninstalled deletes the tokens; stores stay isolated', async () => {
    const env = { SALLA_WEBHOOK_SECRET: 'salla-secret-0123456789' };
    const hub = new FakeHub();
    hub.addConnection(CONN_S, 'salla', { external_account_id: '111' });
    hub.addConnection(CONN_B, 'salla', { external_account_id: '222', company_id: 'company-b' });
    await hub.putCreds(CONN_S, 'salla', { access_token: 'a'.repeat(20), refresh_token: 'r'.repeat(20) });
    await hub.putCreds(CONN_B, 'salla', { access_token: 'b'.repeat(20), refresh_token: 'r'.repeat(20) });

    let r = await handleInbound(deps(hub, { env }), await sallaRequest(env.SALLA_WEBHOOK_SECRET, { event: 'order.updated', merchant: 999, created_at: '2026-10-02 10:00:00', data: { id: 1 } }));
    assert.deepEqual(r.body, { ok: true, ignored: 'unknown_merchant' });
    assert.equal(hub.events.length, 0);

    r = await handleInbound(deps(hub, { env }), await sallaRequest('forged', { event: 'app.uninstalled', merchant: 222, created_at: '2026-10-02 10:00:00', data: {} }));
    assert.equal(r.status, 401);
    assert.ok(hub.creds.has(CONN_B), 'a forged uninstall cannot delete another store');

    r = await handleInbound(deps(hub, { env }), await sallaRequest(env.SALLA_WEBHOOK_SECRET, { event: 'app.uninstalled', merchant: 111, created_at: '2026-10-02 10:00:00', data: {} }));
    assert.deepEqual(r.body, { ok: true, revoked: true });
    assert.ok(!hub.creds.has(CONN_S) && hub.creds.has(CONN_B), 'only merchant 111 is revoked');

    hub.records.set(`${CONN_B}|order|5`, { id: 'rec-b' });
    r = await handleInbound(deps(hub, { env }), await sallaRequest(env.SALLA_WEBHOOK_SECRET, { event: 'order.status.updated', merchant: 222, created_at: '2026-10-02 11:00:00', data: { id: 5, status: { name: 'ملغي' } } }));
    assert.deepEqual(r.body, { ok: true, applied: true });
    assert.equal(hub.events.at(-1).connection, CONN_B, 'the event is routed to the merchant\'s own connection');
});

async function sallaOauthHub() {
    const hub = new FakeHub();
    hub.addConnection(CONN_S, 'salla', { status: 'pending' });
    const state = 's'.repeat(43);
    const binding = 'b'.repeat(43);
    hub.states.set(await C.sha256Hex(state), { row: { connection_id: CONN_S, company_id: 'company-a', user_id: USER, provider: 'salla' },
                                               binding: await C.sha256Hex(binding) });
    const f = fakeFetch([
        [(u) => u === Salla.SALLA_TOKEN_URL, () => respond(200, { access_token: 'access-token-xyz', refresh_token: 'refresh-token-xyz', expires_in: 1209600 })],
        [(u) => u === Salla.SALLA_USER_URL, () => respond(200, { data: { merchant: { id: 1803665367, name: 'متجري' } } })]
    ]);
    const env = { SALLA_CLIENT_ID: 'cid', SALLA_CLIENT_SECRET: 'cs', SALLA_REDIRECT_URI: 'https://cb.example/cb' };
    return { hub, state, binding, f, env };
}
const callback = (q) => ({ method: 'GET', path: '/salla/callback', headers: hdrs({}), rawBody: new Uint8Array(), query: new URLSearchParams(q) });

test('inbound Salla OAuth callback: state is single-use and the return only HOLDS the result (nothing is activated)', async () => {
    const { hub, state, f, env } = await sallaOauthHub();
    const r = await handleInbound(deps(hub, { fetch: f, env }), callback({ code: 'auth-code-123', state }));
    assert.equal(r.status, 302);
    const u = new URL(r.redirect);
    assert.equal(u.searchParams.get('ihub_result'), 'confirm');
    assert.equal(u.searchParams.get('ihub_connection'), CONN_S);
    assert.match(u.searchParams.get('ihub_completion'), /^[A-Za-z0-9_-]{43}$/);
    assert.ok(!r.redirect.includes('access-token') && !r.redirect.includes('auth-code'));
    assert.equal(hub.connections.get(CONN_S).status, 'pending', 'not activated by the provider redirect');
    assert.equal(hub.creds.size, 0, 'no credentials stored by the provider redirect');
    const held = [...hub.states.values()][0];
    assert.ok(held.pending && !held.pending.includes('access-token-xyz'), 'the held result is encrypted');
    assert.equal(held.completion, await C.sha256Hex(u.searchParams.get('ihub_completion')), 'only the completion hash is stored');

    const replay = await handleInbound(deps(hub, { fetch: f, env }), callback({ code: 'auth-code-123', state }));
    assert.match(replay.redirect, /ihub_code=state_invalid/);
    const forged = await handleInbound(deps(hub, { fetch: f, env }), callback({ code: 'x'.repeat(10), state: 'f'.repeat(43) }));
    assert.match(forged.redirect, /ihub_code=state_invalid/);
    assert.equal(f.calls.length, 2, 'no token exchange for a replayed or forged state');
});

test('OAuth completion: the initiating admin, in the initiating tab, with the code the consenting browser received — and nobody else', async () => {
    const { hub, state, binding, f, env } = await sallaOauthHub();
    const r = await handleInbound(deps(hub, { fetch: f, env }), callback({ code: 'auth-code-123', state }));
    const completion = new URL(r.redirect).searchParams.get('ihub_completion');
    const admin = authorizeAs(CONN_S, 'salla', 'pending');

    // الهجوم ①: المهاجم بدأ التدفق (يملك جلسته وبصمته) وأرسل الرابط للضحية — لكنه لا يرى رمز الإكمال
    let x = await handleApi(deps(hub, { env, userRpc: admin }), { action: 'oauth_complete', connection_id: CONN_S, binding, completion: 'z'.repeat(43) });
    assert.deepEqual([x.status, x.body.error], [409, 'state_invalid']);
    // الهجوم ②: متصفح الضحية يملك رمز الإكمال لكن لا جلسة مدير الشركة ولا بصمة التبويب
    const victim = async () => { throw { code: '42501', message: 'إدارة التكاملات متاحة لمدير الشركة فقط' }; };
    x = await handleApi(deps(hub, { env, userRpc: victim }), { action: 'oauth_complete', connection_id: CONN_S, binding: 'v'.repeat(43), completion });
    assert.equal(x.status, 403);
    // نفس المدير من تبويب آخر (بلا البصمة الصحيحة)
    x = await handleApi(deps(hub, { env, userRpc: admin }), { action: 'oauth_complete', connection_id: CONN_S, binding: 'w'.repeat(43), completion });
    assert.equal(x.status, 409);
    assert.equal(hub.connections.get(CONN_S).status, 'pending');
    assert.equal(hub.creds.size, 0);

    // المسار المشروع
    x = await handleApi(deps(hub, { env, userRpc: admin }), { action: 'oauth_complete', connection_id: CONN_S, binding, completion });
    assert.equal(x.status, 200, JSON.stringify(x.body));
    assert.equal(hub.connections.get(CONN_S).external_account_id, '1803665367');
    assert.ok(!hub.creds.get(CONN_S).ciphertext.includes('access-token-xyz'));
    assert.equal(hub.creds.get(CONN_S).token_expires_at, '2026-10-26T10:00:00.000Z');
    const creds = await C.decryptJson(ENC_KEY, hub.creds.get(CONN_S).ciphertext, C.credentialAad(CONN_S, 'salla'));
    assert.equal(creds.refresh_token, 'refresh-token-xyz');
    // مرة واحدة
    x = await handleApi(deps(hub, { env, userRpc: admin }), { action: 'oauth_complete', connection_id: CONN_S, binding, completion });
    assert.equal(x.status, 409);
});

async function wpRequest(secret, action, body, { connection = CONN_W, nonce = 'n'.repeat(24), now = Date.parse('2026-10-12T10:00:00Z') } = {}) {
    const rawBody = enc.encode(JSON.stringify(body));
    const ts = String(Math.floor(now / 1000));
    const sig = await WP.signRequest(secret, { timestamp: ts, nonce, method: 'POST', path: `/wordpress/v1/${action}`, rawBody });
    return { method: 'POST', path: `/wordpress/v1/${action}`, rawBody, query: new URLSearchParams(),
             headers: hdrs({ 'x-mad3oom-connection': connection, 'x-mad3oom-timestamp': ts, 'x-mad3oom-nonce': nonce, 'x-mad3oom-signature': sig }) };
}

test('inbound WordPress: signed ping and intake work; replays, foreign secrets and inactive connections are refused', async () => {
    const hub = new FakeHub();
    hub.addConnection(CONN_W, 'wordpress', { base_url: 'https://site.example' });
    hub.addConnection(CONN_B, 'wordpress', { base_url: 'https://site-b.example', company_id: 'company-b' });
    await hub.putCreds(CONN_W, 'wordpress', { site_secret: 'site-secret-a-0123456789' });
    await hub.putCreds(CONN_B, 'wordpress', { site_secret: 'site-secret-b-0123456789' });

    const ping = await wpRequest('site-secret-a-0123456789', 'ping', { site: 'https://www.site.example/' });
    let r = await handleInbound(deps(hub), ping);
    assert.equal(r.status, 200);
    r = await handleInbound(deps(hub), ping);
    assert.equal(r.status, 401, 'the same nonce is refused');

    r = await handleInbound(deps(hub), await wpRequest('site-secret-a-0123456789', 'ping', { site: 'https://site-b.example/' }, { connection: CONN_B, nonce: 'm'.repeat(24) }));
    assert.equal(r.status, 401, 'site A cannot speak for site B');

    r = await handleInbound(deps(hub), await wpRequest('site-secret-a-0123456789', 'ping', { site: 'https://elsewhere.example/' }, { nonce: 'o'.repeat(24) }));
    assert.deepEqual([r.status, r.body.error], [403, 'site_mismatch'], 'a pairing code copied to another site does not work');
    assert.deepEqual(hub.health.at(-1), [CONN_W, false, 'site_mismatch']);

    r = await handleInbound(deps(hub), await wpRequest('site-secret-a-0123456789', 'intake',
        { name: 'زائر', email: 'v@x.io', subject: 'تأخر الطلب', message: 'لم يصل', order_ref: '501', site: 'https://site.example/' }, { nonce: 'p'.repeat(24) }));
    assert.equal(r.status, 201);
    assert.equal(hub.intake[0].p_connection, CONN_W);
    assert.equal(hub.intake[0].p_order_ref, '501');

    r = await handleInbound(deps(hub), await wpRequest('site-secret-a-0123456789', 'intake', { name: 'x', email: 'bad', subject: 's', message: 'm', site: 'https://site.example/' }, { nonce: 'q'.repeat(24) }));
    assert.equal(r.status, 400);
    hub.rateLimited = true;
    r = await handleInbound(deps(hub), await wpRequest('site-secret-a-0123456789', 'intake', { name: 'x', email: 'v@x.io', subject: 's', message: 'm', site: 'https://site.example/' }, { nonce: 'r'.repeat(24) }));
    assert.equal(r.status, 429);

    hub.connections.get(CONN_W).status = 'reauth_required';
    r = await handleInbound(deps(hub), await wpRequest('site-secret-a-0123456789', 'ping', { site: 'https://site.example/' }, { nonce: 's'.repeat(24) }));
    assert.equal(r.status, 403);
    hub.connections.get(CONN_W).status = 'disconnected';
    r = await handleInbound(deps(hub), await wpRequest('site-secret-a-0123456789', 'ping', { site: 'https://site.example/' }, { nonce: 't'.repeat(24) }));
    assert.equal(r.status, 401, 'a disconnected site is unknown');
});

test('inbound: routing, methods and size limits', async () => {
    const hub = new FakeHub();
    assert.equal((await handleInbound(deps(hub), { method: 'GET', path: '/woocommerce/x', headers: hdrs({}), rawBody: new Uint8Array(), query: new URLSearchParams() })).status, 405);
    assert.equal((await handleInbound(deps(hub), { method: 'POST', path: '/shopify', headers: hdrs({}), rawBody: new Uint8Array(), query: new URLSearchParams() })).status, 404);
    assert.equal((await handleInbound(deps(hub), { method: 'POST', path: '/salla', headers: hdrs({}), rawBody: new Uint8Array(1100 * 1024), query: new URLSearchParams() })).status, 413);
    assert.equal((await handleInbound(deps(hub), { method: 'POST', path: '/salla', headers: hdrs({}), rawBody: enc.encode('{}'), query: new URLSearchParams() })).status, 503,
                 'no Salla webhook secret configured: fail closed');
});

/* ══ integrations-worker ═══════════════════════════════════════════════════ */

test('worker: fails closed without a secret; retries refetch from the provider; auth failures stop retrying', async () => {
    const hub = await wooHub();
    assert.equal((await handleWorker(deps(hub), hdrs({}))).status, 503);
    const env = { IHUB_WORKER_SECRET: 'w'.repeat(40) };
    assert.equal((await handleWorker(deps(hub, { env }), hdrs({ 'x-ihub-worker-secret': 'nope' }))).status, 401);

    hub.records.set(`${CONN_A}|order|501`, { id: 'rec-x' });
    hub.events.push({ id: 1, connection: CONN_A, dedupe: 'd', status: 'failed' }, { id: 2, connection: CONN_A, dedupe: 'e', status: 'failed' });
    hub.due = [{ id: 1, connection_id: CONN_A, provider: 'woocommerce', external_type: 'order', external_id: '501' }];
    let r = await handleWorker(deps(hub, { env, fetch: fakeFetch([[() => true, () => respond(200, wooOrder({ status: 'completed' }))]]) }),
                               hdrs({ 'x-ihub-worker-secret': 'w'.repeat(40) }));
    assert.equal(r.body.events.processed, 1);
    assert.equal(hub.events[0].status, 'processed');

    hub.due = [{ id: 2, connection_id: CONN_A, provider: 'woocommerce', external_type: 'order', external_id: '501' }];
    r = await handleWorker(deps(hub, { env, fetch: fakeFetch([[() => true, () => respond(401, {})]]) }), hdrs({ 'x-ihub-worker-secret': 'w'.repeat(40) }));
    assert.equal(r.body.events.failed, 1);
    assert.equal(hub.events[1].status, 'dead');
    assert.deepEqual(hub.health.at(-1), [CONN_A, false, 'auth_failed']);
});

test('worker: Salla tokens are refreshed by the worker only, stored encrypted with the new expiry', async () => {
    const hub = new FakeHub();
    hub.addConnection(CONN_S, 'salla', { external_account_id: '111' });
    await hub.putCreds(CONN_S, 'salla', { access_token: 'old-access-123', refresh_token: 'old-refresh-123', expires_at: '2026-10-13T00:00:00Z' }, '2026-10-13T00:00:00Z');
    hub.tokensDue = [{ connection_id: CONN_S, provider: 'salla' }];
    const f = fakeFetch([[(u) => u === Salla.SALLA_TOKEN_URL, () => respond(200, { access_token: 'new-access-123', refresh_token: 'new-refresh-123', expires_in: 1209600 })]]);
    const env = { IHUB_WORKER_SECRET: 'w'.repeat(40), SALLA_CLIENT_ID: 'cid', SALLA_CLIENT_SECRET: 'cs' };
    const r = await handleWorker(deps(hub, { env, fetch: f }), hdrs({ 'x-ihub-worker-secret': 'w'.repeat(40) }));
    assert.equal(r.body.tokens.refreshed, 1);
    assert.equal(new URLSearchParams(f.calls[0].init.body).get('refresh_token'), 'old-refresh-123');
    const creds = await C.decryptJson(ENC_KEY, hub.creds.get(CONN_S).ciphertext, C.credentialAad(CONN_S, 'salla'));
    assert.equal(creds.refresh_token, 'new-refresh-123');
    assert.equal(hub.creds.get(CONN_S).token_expires_at, '2026-10-26T10:00:00.000Z');

    hub.tokensDue = [{ connection_id: CONN_S, provider: 'salla' }];
    await handleWorker(deps(hub, { env, fetch: fakeFetch([[() => true, () => respond(400, { error: 'invalid_grant' })]]) }), hdrs({ 'x-ihub-worker-secret': 'w'.repeat(40) }));
    assert.deepEqual(hub.health.at(-1), [CONN_S, false, 'auth_failed']);
});

/* ══ حراسة ثابتة ═══════════════════════════════════════════════════════════ */

test('static: shared modules use no Deno or service-role key; entrypoints log no request bodies; the browser never calls ihub_svc_*', () => {
    const dir = 'supabase/functions/_shared/integrations';
    for (const f of fs.readdirSync(path.join(ROOT, dir)).filter((x) => x.endsWith('.js'))) {
        const src = read(`${dir}/${f}`);
        assert.doesNotMatch(src, /Deno\.|SERVICE_ROLE/, `${f} must stay runtime-neutral`);
        assert.doesNotMatch(src, /console\.(log|error|warn)\(/, `${f} logs only through safeLog`);
    }
    // production's `integrations-api` is the WhatsApp/Aqar Integration Platform API (deployed outside this
    // repo, documented in api-docs.html). Deploying under that slug would replace it.
    assert.ok(!fs.existsSync(path.join(ROOT, 'supabase/functions/integrations-api')),
              'the hub must not ship a function named integrations-api (production slug owned by the WhatsApp API)');
    assert.match(read('assets/js/company/integrations-data.js'), /functions\.invoke\('ihub-api'/);
    for (const fn of ['ihub-api', 'integrations-inbound', 'integrations-worker']) {
        const src = read(`supabase/functions/${fn}/index.ts`);
        assert.doesNotMatch(src, /console\.(log|error)\([^)]*(body|raw|req)/, `${fn} logs a request`);
    }
    const browser = ['assets/js/company/company-integrations.js', 'assets/js/company/integrations-model.js', 'assets/js/company/company-tickets.js']
        .filter((f) => fs.existsSync(path.join(ROOT, f))).map(read).join('\n');
    assert.doesNotMatch(browser, /ihub_svc_|service_role|SERVICE_ROLE/);
});
