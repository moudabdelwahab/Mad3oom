// ============================================================================
// 120 — إدارة متجر Shopify: الموصل (shopify-admin.js) ومسار ihub-api (node، بلا شبكة).
//
// Shopify مزيّف (tests/fixtures/shopify/admin-fixtures.mjs) وتفويض مزيّف بنفس عقد دوال 120
// (السلوك الحقيقي للتفويض والعزل والتأكيد والحدود في tests/sql/shopify-store-management.test.sql).
//
// تنبيه صدق: لا شيء هنا يثبت أن Shopify الحقيقي يقبل هذه الطلبات. الوثائق والمتغيرات تُفحص على
// مخطط 2026-10 الحقيقي بـ integrations/shopify/schema-check.mjs (خارج npm test)، والتنفيذ الفعلي
// يُتحقق منه على متجر تطوير (docs/ecommerce/PROVIDER_SHOPIFY.md).
// ============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import * as C from '../supabase/functions/_shared/integrations/crypto.js';
import * as S from '../supabase/functions/_shared/integrations/shopify.js';
import * as A from '../supabase/functions/_shared/integrations/shopify-admin.js';
import { handleApi } from '../supabase/functions/_shared/integrations/api.js';
import { SHOP, G, VALID_INPUTS, shopState, answer } from './fixtures/shopify/admin-fixtures.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const ENC_KEY = 'k'.repeat(48);
const CONN = '66666666-6666-4666-8666-666666666666';
const CONN_B = '77777777-7777-4777-8777-777777777777';
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = Date.parse('2026-10-28T10:00:00Z');
const ACCESS = 'shpat_' + 'a'.repeat(32);
const ENV = {
    IHUB_ENC_KEY: ENC_KEY, IHUB_PUBLIC_BASE: 'https://proj.supabase.co/functions/v1',
    SHOPIFY_CLIENT_ID: 'client-123', SHOPIFY_CLIENT_SECRET: 'shpss_' + 'z'.repeat(32),
    SHOPIFY_REDIRECT_URI: 'https://proj.supabase.co/functions/v1/integrations-inbound/shopify/callback'
};

/* ── كتالوج 120 من ملف الترحيل (مصدر الحقيقة) ───────────────────────────── */
function sqlCatalog() {
    const sql = read('migrations/120_shopify_store_management.sql');
    const body = sql.slice(sql.indexOf('create or replace function public._ihub_shopify_op_catalog()'), sql.indexOf('-- النطاقات الناقصة'));
    const rows = [...body.matchAll(/\('([a-z_]+\.[a-z_]+)',\s*'([a-z_.]+)',\s*'(read|write|destructive)',\s*(true|false),\s*array\[([^\]]*)\]/g)];
    return Object.fromEntries(rows.map((m) => [m[1], { perm: m[2], risk: m[3], confirm: m[4] === 'true',
                                                       scopes: [...m[5].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]) }]));
}
const CATALOG = sqlCatalog();
const missingScopes = (granted, need) => need.filter((n) => !granted.includes(n) && !(n.startsWith('read_') && granted.includes('write_' + n.slice(5))));

/* ── تفويض مزيّف بعقد دوال 120 ─────────────────────────────────────────── */
class FakeAuthz {
    constructor({ scopes = S.REQUESTED_SCOPES, perms = null, company = 'co-a', entitled = true } = {}) {
        this.scopes = [...scopes]; this.perms = perms; this.company = company; this.entitled = entitled;
        this.confirmations = new Map(); this.ops = []; this.viewed = 0; this.calls = [];
        this.connections = { [CONN]: 'co-a', [CONN_B]: 'co-b' };
    }
    gate(conn, op) {
        const c = CATALOG[op];
        if (!c) throw { code: '22023', details: '{"code":"validation_failed"}' };
        if (!this.entitled) throw { code: '42501', message: 'إدارة المتجر من مدعوم غير مفعّلة', details: '{"code":"management_not_enabled"}' };
        if (this.connections[conn] !== this.company) throw { code: 'P0002', message: 'الربط غير موجود', details: '{"code":"not_found"}' };
        if (this.perms && !this.perms.includes(c.perm)) throw { code: '42501', message: 'لا تملك صلاحية هذه العملية', details: '{"code":"forbidden"}' };
        const miss = missingScopes(this.scopes, c.scopes);
        if (miss.length) throw { code: '42501', message: `صلاحية Shopify ناقصة: ${miss.join(', ')}`, details: '{"code":"missing_scope"}' };
        return c;
    }
    async rpc(name, a) {
        this.calls.push([name, a]);
        if (name === 'ihub_shopify_op_confirm_begin') {
            const c = this.gate(a.p_connection, a.p_op);
            if (!c.confirm) throw { code: '22023', details: '{"code":"validation_failed"}' };
            this.confirmations.set(a.p_token_hash, { op: a.p_op, hash: a.p_input_hash, conn: a.p_connection, user: USER });
            return { op: a.p_op, expires_in: 300, risk: c.risk };
        }
        if (name === 'ihub_shopify_op_authorize') {
            const c = this.gate(a.p_connection, a.p_op);
            if (c.risk === 'read') { this.viewed++; return { connection_id: a.p_connection, risk: 'read', op: a.p_op, actor_id: USER }; }
            if (c.confirm) {
                if (!a.p_token_hash) throw { code: '22023', details: '{"code":"confirmation_required"}' };
                const k = this.confirmations.get(a.p_token_hash);
                if (!k || k.op !== a.p_op || k.hash !== a.p_input_hash || k.conn !== a.p_connection) throw { code: '22023', details: '{"code":"confirmation_invalid"}' };
                this.confirmations.delete(a.p_token_hash);
            }
            const opId = `0000000${this.ops.length + 1}-0000-4000-8000-000000000000`.slice(-36);
            this.ops.push({ id: opId, op: a.p_op, risk: c.risk, hash: a.p_input_hash, status: 'requested' });
            return { op_id: opId, connection_id: a.p_connection, risk: c.risk, op: a.p_op, actor_id: USER, confirmed: !!a.p_token_hash };
        }
        if (name === 'ihub_shopify_begin') return { connection_id: a.p_connection, shop: a.p_shop, expires_in: 600 };
        if (name === 'ihub_shopify_manage_status') {
            if (this.statusThrows) throw { code: 'PGRST202', message: 'missing' };
            return { entitled: this.entitled, enabled: this.entitled };
        }
        throw new Error('unexpected user rpc ' + name);
    }
}

class FakeHub {
    constructor() { this.creds = new Map(); this.results = []; this.health = []; this.audits = []; this.calls = []; }
    async put(id, obj) { this.creds.set(id, { ciphertext: await C.encryptJson(ENC_KEY, obj, C.credentialAad(id, 'shopify')), token_expires_at: obj.expires_at || null }); }
    async svc(name, a) {
        this.calls.push(name);
        switch (name) {
            case 'ihub_svc_get_credentials': {
                const k = this.creds.get(a.p_connection);
                return { connection_id: a.p_connection, company_id: 'co-a', provider: 'shopify', status: 'active', base_url: `https://${SHOP}`,
                         external_account_id: SHOP, provider_enabled: true, ciphertext: k?.ciphertext ?? null, key_version: 1, token_expires_at: k?.token_expires_at ?? null };
            }
            case 'ihub_svc_store_credentials': this.creds.set(a.p_connection, { ciphertext: a.p_ciphertext, token_expires_at: a.p_token_expires_at }); return null;
            case 'ihub_svc_claim_token_refresh': return true;
            case 'ihub_svc_release_token_refresh': return null;
            case 'ihub_svc_record_health': this.health.push([a.p_ok, a.p_error_code]); return null;
            case 'ihub_svc_audit': this.audits.push(a.p_action); return null;
            case 'ihub_svc_shopify_op_result': this.results.push(a); return { op_id: a.p_op_id, status: a.p_status };
        }
        throw new Error('unexpected svc ' + name);
    }
}

function shopifyFetch(st) {
    const calls = [];
    const fn = async (url, init = {}) => {
        if (String(url) === `https://${SHOP}/admin/oauth/access_token`) {
            calls.push({ url: String(url), refresh: true });
            if (st.refreshFails) return new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } });
            return new Response(JSON.stringify({ access_token: 'shpat_' + 'n'.repeat(32), expires_in: 3600, refresh_token: 'shprt_' + 'r'.repeat(32), refresh_token_expires_in: 7776000 }),
                                { status: 200, headers: { 'content-type': 'application/json' } });
        }
        assert.equal(String(url), `https://${SHOP}/admin/api/2026-10/graphql.json`);
        const body = JSON.parse(init.body);
        calls.push({ query: body.query, variables: body.variables, token: init.headers['X-Shopify-Access-Token'] });
        const a = answer(body.query, body.variables, st);
        if (a.throttled) {
            return new Response(JSON.stringify({ errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }],
                extensions: { cost: { requestedQueryCost: 500, throttleStatus: { currentlyAvailable: 100, restoreRate: 100, maximumAvailable: 2000 } } } }),
                { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({ data: a.data, ...(a.errors?.length ? { errors: a.errors } : {}),
                                             extensions: { cost: { requestedQueryCost: 50, throttleStatus: { currentlyAvailable: 1900, restoreRate: 100, maximumAvailable: 2000 } } } }),
                            { status: 200, headers: { 'content-type': 'application/json' } });
    };
    fn.calls = calls;
    return fn;
}

async function setup({ st = shopState(), authz = new FakeAuthz(), expired = false } = {}) {
    const hub = new FakeHub();
    await hub.put(CONN, { access_token: ACCESS, refresh_token: 'shprt_' + 'o'.repeat(32), scope: S.REQUESTED_SCOPES.join(','),
                          expires_at: new Date(NOW + (expired ? -60_000 : 3_600_000)).toISOString() });
    const fetch = shopifyFetch(st);
    const logs = [];
    const deps = { env: ENV, fetch, now: () => NOW, sleep: async () => {}, svcRpc: (n, a) => hub.svc(n, a), userRpc: (n, a) => authz.rpc(n, a),
                   logger: { log: (l) => logs.push(l), info: (l) => logs.push(l), warn: (l) => logs.push(l), error: (l) => logs.push(l) } };
    return { hub, fetch, authz, st, deps, logs };
}
const admin = (deps, op, input, extra = {}) => handleApi(deps, { action: 'shopify_admin', connection_id: CONN, op, input, ...extra });
const mutations = (fetch) => fetch.calls.filter((c) => c.query && /^\s*mutation/.test(c.query));
/** خطوتان كما تفعل الواجهة. */
async function confirmAndRun(env, op, input) {
    const first = await admin(env.deps, op, input);
    assert.equal(first.status, 200, `${op} confirm: ${JSON.stringify(first.body)}`);
    assert.equal(first.body.confirmation_required, true, op);
    assert.equal(mutations(env.fetch).length, 0, `${op}: لا طفرة قبل التأكيد`);
    return admin(env.deps, op, input, { confirmation_token: first.body.confirmation_token });
}

/* ══ الكتالوج ═══════════════════════════════════════════════════════════════ */

test('catalog: the Edge operations are exactly the 120 SQL catalog (risk, confirmation, permission, scopes)', () => {
    assert.deepEqual(Object.keys(CATALOG).sort(), A.OPERATION_KEYS);
    assert.equal(A.OPERATION_KEYS.length, 61);
    for (const k of A.OPERATION_KEYS) {
        const o = A.OPERATIONS[k];
        assert.deepEqual({ perm: o.perm, risk: o.risk, confirm: o.confirm, scopes: o.scopes }, CATALOG[k], k);
        if (o.risk === 'destructive') assert.ok(o.confirm, `${k}: destructive ⇒ confirm`);
        if (o.confirm) assert.equal(typeof o.check, 'function', `${k}: confirmation shows Shopify's current state`);
    }
    // كل نطاق في الكتالوج مطلوب في التطبيق، ولا نطاق مطلوب بلا عملية
    const used = new Set(Object.values(CATALOG).flatMap((c) => c.scopes));
    for (const s of S.MANAGEMENT_SCOPES) assert.ok(used.has(s) || used.has(s.replace(/^read_/, 'write_')), `scope without an operation: ${s}`);
    for (const s of used) assert.ok(S.REQUESTED_SCOPES.includes(s), `operation needs an unrequested scope: ${s}`);
});

test('catalog: no financial operation exists (no refund, capture, mark-as-paid, draft completion, transactions)', () => {
    assert.ok(!A.OPERATION_KEYS.some((k) => /refund|capture|paid|complete|transaction|void|credit/.test(k)));
    const src = read('supabase/functions/_shared/integrations/shopify-admin.js');
    for (const m of ['refundCreate', 'orderCapture', 'orderMarkAsPaid', 'draftOrderComplete(', 'transactionVoid', 'returnProcess', 'storeCreditAccountCredit']) {
        assert.ok(!src.includes(m), `financial mutation present: ${m}`);
    }
    assert.match(src, /originalPaymentMethodsRefund: false/, 'order cancel never refunds');
    assert.match(src, /financialStatus: 'PENDING'/, 'created orders are never marked paid');
});

/* ══ التحقق من المدخلات ══════════════════════════════════════════════════════ */

test('validate: every fixture input is valid; unknown keys (company_id, store_id, price, permission) are refused, not ignored', () => {
    for (const k of A.OPERATION_KEYS) {
        assert.doesNotThrow(() => A.validateOperation(k, VALID_INPUTS[k], { nowMs: NOW }), k);
        for (const extra of ['company_id', 'connection_id', 'store_id', 'shop', 'permissions', 'price_override']) {
            assert.throws(() => A.validateOperation(k, { ...VALID_INPUTS[k], [extra]: 'x' }, { nowMs: NOW }),
                          (e) => e instanceof A.InputError && e.field === extra, `${k} + ${extra}`);
        }
    }
    assert.throws(() => A.validateOperation('order.create', { lines: [{ variant_id: G.variant, quantity: 1, price: '0.01' }] }), (e) => e.field === 'lines.0.price');
});

test('validate: ids must be numeric or a gid of the expected type (another type is refused)', () => {
    assert.equal(A.gidOf('Product', '101', 'id'), G.product);
    for (const bad of [G.order, 'gid://shopify/Product/abc', '-1', '1e3', 'gid://evil/Product/1', '', null, '1'.repeat(21)]) {
        assert.throws(() => A.validateOperation('product.get', { id: bad }), (e) => e.code === 'invalid_input', String(bad));
    }
    assert.throws(() => A.validateOperation('inventory.adjust', { ...VALID_INPUTS['inventory.adjust'],
        changes: [{ inventory_item_id: G.variant, location_id: G.location, delta: 1, expected_quantity: 1 }] }), (e) => e.field === 'changes.0.inventory_item_id');
});

test('validate: prices, compare-at, quantities and inventory rules', () => {
    const v = (variants) => A.validateOperation('variant.update', { product_id: G.product, variants });
    for (const p of ['-1', '1.12345', 'abc', '1e5', '99999999999', ' ', 5e20]) assert.throws(() => v([{ id: G.variant, price: p }]), (e) => e.field === 'variants.0.price', String(p));
    assert.throws(() => v([{ id: G.variant, price: '' }]), (e) => e.field === 'variants.0', 'empty = no change requested');
    assert.throws(() => v([{ id: G.variant, price: '10', compare_at_price: '10' }]), (e) => e.field === 'variants.0.compare_at_price');
    assert.equal(v([{ id: G.variant, price: '10', compare_at_price: '12.5' }]).variants[0].compareAtPrice, '12.5');
    assert.equal(v([{ id: G.variant, compare_at_price: null }]).variants[0].compareAtPrice, null, 'null clears');
    assert.throws(() => v([{ id: G.variant }]), (e) => e.field === 'variants.0', 'no change');
    assert.throws(() => v([{ id: G.variant, price: '1' }, { id: G.variant, price: '2' }]), (e) => e.field === 'variants');
    const adj = (c, extra = {}) => A.validateOperation('inventory.adjust', { name: 'available', reason: 'damaged', changes: [c], ...extra });
    const base = { inventory_item_id: G.item, location_id: G.location, delta: -1, expected_quantity: 3 };
    assert.throws(() => adj({ ...base, delta: 0 }), (e) => e.field === 'changes.0.delta');
    assert.throws(() => adj({ ...base, delta: 100_001 }), (e) => e.field === 'changes.0.delta');
    assert.throws(() => adj({ ...base, delta: 1.5 }), (e) => e.field === 'changes.0.delta');
    assert.throws(() => adj({ ...base, expected_quantity: undefined }), (e) => e.field === 'changes.0.expected_quantity', 'compare-and-swap is mandatory');
    assert.throws(() => adj(base, { reason: 'movement_created' }), (e) => e.field === 'reason');
    assert.throws(() => adj(base, { name: 'committed' }), (e) => e.field === 'name');
    assert.throws(() => A.validateOperation('inventory.adjust', { name: 'available', reason: 'damaged', changes: [base, base] }), (e) => e.field === 'changes');
    assert.throws(() => A.validateOperation('inventory.set', { name: 'available', reason: 'correction',
        quantities: [{ inventory_item_id: G.item, location_id: G.location, quantity: -1, expected_quantity: 0 }] }), (e) => e.field === 'quantities.0.quantity');
    assert.throws(() => A.validateOperation('order.create', { lines: [{ variant_id: G.variant, quantity: 0 }] }), (e) => e.field === 'lines.0.quantity');
    assert.throws(() => A.validateOperation('order.create', { lines: [] }), (e) => e.field === 'lines');
});

test('validate: discounts — dates, limits, values and eligibility rules', () => {
    const d = (over) => A.validateOperation('discount.code_create', { ...VALID_INPUTS['discount.code_create'], ...over }, { nowMs: NOW });
    const ok = d({});
    assert.deepEqual(ok.input.context, { all: 'ALL' });
    assert.equal(ok.input.customerGets.value.percentage, 0.1, 'percent → 0..1');
    assert.equal(ok.input.code, 'WINTER10');
    assert.throws(() => d({ ends_at: '2026-10-31T00:00:00Z' }), (e) => e.field === 'ends_at', 'ends before start');
    assert.throws(() => d({ ends_at: '2026-10-01T00:00:00Z', starts_at: '2026-09-01T00:00:00Z' }), (e) => e.field === 'ends_at', 'ends in the past');
    assert.throws(() => d({ starts_at: '2024-01-01T00:00:00Z' }), (e) => e.field === 'starts_at', 'too far back');
    assert.throws(() => d({ starts_at: 'tomorrow' }), (e) => e.field === 'starts_at');
    assert.throws(() => d({ starts_at: undefined }), (e) => e.field === 'starts_at', 'start required on create');
    assert.throws(() => d({ usage_limit: 0 }), (e) => e.field === 'usage_limit');
    assert.throws(() => d({ code: 'a b' }), (e) => e.field === 'code');
    assert.throws(() => d({ code: 'ab' }), (e) => e.field === 'code');
    assert.throws(() => d({ value: { type: 'percentage', amount: '101' } }), (e) => e.field === 'value.amount');
    assert.throws(() => d({ value: { type: 'percentage', amount: '0' } }), (e) => e.field === 'value.amount');
    assert.throws(() => d({ value: { type: 'bogo', amount: '1' } }), (e) => e.field === 'value.type');
    assert.throws(() => d({ items: { all: true, product_ids: [G.product] } }), (e) => e.field === 'items', 'one eligibility rule');
    assert.throws(() => d({ items: { product_ids: [G.collection] } }), (e) => e.field === 'items.product_ids.0');
    assert.throws(() => d({ minimum: { subtotal: '10', quantity: 2 } }), (e) => e.field === 'minimum');
    assert.equal(d({ minimum: { quantity: 2 } }).input.minimumRequirement.quantity.greaterThanOrEqualToQuantity, '2');
    assert.deepEqual(d({ items: { collection_ids: ['601'] } }).input.customerGets.items, { collections: { add: [G.collection] } });
    assert.throws(() => A.validateOperation('discount.automatic_create', { ...VALID_INPUTS['discount.automatic_create'], code: 'X1Y' }, { nowMs: NOW }),
                  (e) => e.field === 'code', 'automatic discounts have no code');
    assert.throws(() => A.validateOperation('discount.code_update', { id: G.codeDiscount }, { nowMs: NOW }), (e) => e.field === 'input');
    assert.throws(() => A.validateOperation('discount.code_update', { id: G.codeDiscount, value: { type: 'percentage', amount: '5' }, items: { product_ids: [G.product] } }, { nowMs: NOW }),
                  (e) => e.field === 'items', 'changing product scope needs a new discount');
});

test('validate: content safety (HTML, tags, e-mail, phone, address, metafields, search text)', () => {
    for (const h of ['<script>x</script>', '<img src=x onerror=alert(1)>', '<a href="javascript:x">', '<iframe src=x>', '<svg onload=1>', '<style>*{}</style>']) {
        assert.throws(() => A.validateOperation('product.create', { title: 'x', description_html: h }), (e) => e.field === 'description_html', h);
    }
    assert.throws(() => A.validateOperation('product.create', { title: 'x', tags: ['a,b'] }), (e) => e.field === 'tags.0');
    // يتسع لحد جسم ihub-api (32 KB): 10 آلاف حرف عربي
    assert.ok(Buffer.byteLength(JSON.stringify({ action: 'shopify_admin', input: { title: 'x', description_html: 'م'.repeat(10000) } })) < 32 * 1024);
    assert.throws(() => A.validateOperation('product.create', { title: 'x', description_html: 'م'.repeat(10001) }), (e) => e.field === 'description_html');
    assert.throws(() => A.validateOperation('product.create', { title: '<b>x</b>' }), (e) => e.field === 'title');
    assert.throws(() => A.validateOperation('product.create', { title: ' ' }), (e) => e.field === 'title');
    assert.throws(() => A.validateOperation('customer.create', { email: 'not-an-email' }), (e) => e.field === 'email');
    assert.throws(() => A.validateOperation('customer.create', { phone: '01001234567' }), (e) => e.field === 'phone', 'E.164 only');
    assert.throws(() => A.validateOperation('customer.create', { note: 'x' }), (e) => e.field === 'input', 'name, e-mail or phone required');
    assert.throws(() => A.validateOperation('customer.create', { first_name: 'S', email_marketing_consent: true }), (e) => e.field === 'email_marketing_consent');
    assert.throws(() => A.validateOperation('order.update_contact', { id: G.order, shipping_address: { address1: 'x', city: 'y', country_code: 'Egypt' } }),
                  (e) => e.field === 'shipping_address.country_code');
    assert.throws(() => A.validateOperation('metafield.set', { ...VALID_INPUTS['metafield.set'], type: 'json' }), (e) => e.field === 'type');
    assert.throws(() => A.validateOperation('metafield.set', { ...VALID_INPUTS['metafield.set'], type: 'number_integer', value: '1.5' }), (e) => e.field === 'value');
    assert.throws(() => A.validateOperation('metafield.set', { ...VALID_INPUTS['metafield.set'], owner_id: G.order }), (e) => e.field === 'owner_id');
    assert.throws(() => A.validateOperation('product.list', { query: 'x" OR status:archived' }), (e) => e.field === 'query');
    assert.throws(() => A.validateOperation('fulfillment.create', { ...VALID_INPUTS['fulfillment.create'], tracking: { number: 'T1', url: 'http://plain.example' } }),
                  (e) => e.field === 'tracking.url', 'https only');
});

test('input hash: canonical (key order does not matter) and bound to the operation and every value', async () => {
    const a = A.validateOperation('order.cancel', { id: '1001', reason: 'CUSTOMER', restock: true });
    const b = A.validateOperation('order.cancel', { restock: true, reason: 'CUSTOMER', id: G.order });
    assert.equal(await A.inputHash('order.cancel', a), await A.inputHash('order.cancel', b));
    assert.notEqual(await A.inputHash('order.cancel', a), await A.inputHash('order.cancel', { ...a, restock: false }));
    assert.notEqual(await A.inputHash('order.cancel', a), await A.inputHash('product.delete', a));
    assert.match(await A.inputHash('order.cancel', a), /^[0-9a-f]{64}$/);
});

/* ══ النجاح: كل عملية من البداية للنهاية ═════════════════════════════════════ */

test('every operation succeeds end to end: reads directly; writes with confirmation where required; results journaled from the server', async () => {
    for (const op of A.OPERATION_KEYS) {
        const env = await setup({ st: shopState({ returnStatus: op === 'return.close' || op === 'return.cancel' ? 'OPEN' : 'REQUESTED' }) });
        const def = A.OPERATIONS[op];
        const res = def.confirm ? await confirmAndRun(env, op, VALID_INPUTS[op]) : await admin(env.deps, op, VALID_INPUTS[op]);
        assert.equal(res.status, 200, `${op}: ${JSON.stringify(res.body)}`);
        assert.ok(res.body.result && typeof res.body.result === 'object', op);
        const sent = mutations(env.fetch);
        if (def.risk === 'read') {
            assert.equal(sent.length, 0, `${op}: a read sends no mutation`);
            assert.equal(env.hub.results.length, 0, op);
            assert.equal(env.authz.viewed, 1, `${op}: authorized + audited as data.viewed`);
        } else {
            assert.equal(sent.length, 1, `${op}: exactly one mutation`);
            assert.equal(env.hub.results.length, 1, op);
            const r = env.hub.results[0];
            assert.equal(r.p_op_id, res.body.op_id);
            assert.ok(['succeeded', 'submitted'].includes(r.p_status), op);
            assert.ok(r.p_resource === null || /^[A-Za-z]{2,40}\/[0-9]{1,20}$/.test(r.p_resource), `${op}: resource ${r.p_resource}`);
            assert.ok(JSON.stringify(r.p_detail).length <= 3500, op);
            assert.doesNotMatch(JSON.stringify(r.p_detail), /sara@|\+2010|Nile|Hand wash|TRK123/, `${op}: no customer data or free text in the journal`);
        }
        const all = JSON.stringify(res.body) + JSON.stringify(env.logs) + JSON.stringify(env.hub.results);
        assert.ok(!all.includes(ACCESS) && !all.includes('shpss_'), `${op}: no token or secret in responses, logs or journal`);
        assert.ok(env.fetch.calls.filter((c) => c.query).every((c) => c.token === ACCESS), op);
    }
});

/* ══ التأكيد ══════════════════════════════════════════════════════════════ */

test('confirmation: shown from Shopify’s current state; bound to the exact input; one use; the token is never stored, only its hash', async () => {
    const env = await setup();
    const input = VALID_INPUTS['variant.update'];
    const first = await admin(env.deps, 'variant.update', input);
    assert.equal(first.body.confirmation_required, true);
    assert.deepEqual(first.body.preview.changes[0], { id: G.variant, title: 'M', price_from: '100.00', price_to: '110.00', compare_from: null, compare_to: null,
                                                     fields: ['price', 'compareAtPrice', 'inventoryItem'] });
    const begin = env.authz.calls.find(([n]) => n === 'ihub_shopify_op_confirm_begin')[1];
    assert.equal(begin.p_token_hash, await C.sha256Hex(first.body.confirmation_token));
    assert.ok(!JSON.stringify(env.authz.calls).includes(first.body.confirmation_token), 'raw token never leaves to the database');
    // مدخلات تغيّرت بعد التأكيد
    const changed = await admin(env.deps, 'variant.update', { ...input, variants: [{ ...input.variants[0], price: '1.00' }] }, { confirmation_token: first.body.confirmation_token });
    assert.equal(changed.status, 400);
    assert.equal(changed.body.error, 'confirmation_invalid');
    assert.equal(mutations(env.fetch).length, 0);
    const ok = await admin(env.deps, 'variant.update', input, { confirmation_token: first.body.confirmation_token });
    assert.equal(ok.status, 200);
    const again = await admin(env.deps, 'variant.update', input, { confirmation_token: first.body.confirmation_token });
    assert.equal(again.body.error, 'confirmation_invalid', 'one use');
    assert.equal(mutations(env.fetch).length, 1);
    assert.equal((await admin(env.deps, 'variant.update', input, { confirmation_token: 'short' })).body.error, 'confirmation_invalid');
});

test('confirmation is enforced by the database: an Edge build that skips step one still cannot delete', async () => {
    const env = await setup();
    const def = A.OPERATIONS['product.delete'];
    def.confirm = false;                                   // نسخة Edge معطوبة/معدّلة تظن الحذف بلا تأكيد
    try {
        const res = await admin(env.deps, 'product.delete', VALID_INPUTS['product.delete']);
        assert.equal(res.status, 400);
        assert.equal(res.body.error, 'confirmation_required');
        assert.equal(mutations(env.fetch).length, 0, 'never sent to Shopify');
        assert.equal(env.hub.results.length, 0);
    } finally {
        def.confirm = true;
    }
});

/* ══ الرفض ════════════════════════════════════════════════════════════════ */

test('rejection: Shopify userErrors → provider_rejected with field and code only (no provider text), journaled as failed', async () => {
    const env = await setup({ st: shopState({ userErrors: [{ field: ['product', 'title'], message: 'Title <b>has already</b> been taken by sara@example.com' }] }) });
    const res = await admin(env.deps, 'product.create', VALID_INPUTS['product.create']);
    assert.equal(res.status, 422);
    assert.deepEqual(res.body, { error: 'provider_rejected', user_errors: [{ field: 'product.title', code: null }], op_id: env.authz.ops[0].id });
    assert.equal(env.hub.results[0].p_status, 'failed');
    assert.equal(env.hub.results[0].p_error_code, 'provider_rejected');
    assert.deepEqual(env.hub.health, [], 'a rejected input is not a broken connection');
    const coded = await setup({ st: shopState({ userErrors: [{ field: ['input', 'changes', '0', 'changeFromQuantity'], code: 'CHANGE_FROM_QUANTITY_STALE', message: 'stale' }] }) });
    const inv = await confirmAndRun(coded, 'inventory.adjust', VALID_INPUTS['inventory.adjust']);
    assert.deepEqual(inv.body.user_errors, [{ field: 'input.changes.0.changeFromQuantity', code: 'CHANGE_FROM_QUANTITY_STALE' }]);
});

test('rejection: throttling → 429 with retry_after; ACCESS_DENIED with no payload → forbidden_scope; protected response field after a write ≠ failure', async () => {
    const t = await setup({ st: shopState({ throttled: true }) });
    const r1 = await admin(t.deps, 'product.update', VALID_INPUTS['product.update']);
    assert.equal(r1.status, 429);
    assert.ok(r1.body.retry_after >= 1);
    assert.equal(t.hub.results[0].p_error_code, 'rate_limited');
    const d = await setup({ st: shopState({ accessDenied: true }) });
    const r2 = await admin(d.deps, 'product.update', VALID_INPUTS['product.update']);
    assert.equal(r2.status, 422);
    assert.equal(r2.body.error, 'forbidden_scope');
    assert.deepEqual(d.hub.health, [[false, 'forbidden_scope']]);
    const p = await setup({ st: shopState({ protectedField: true }) });
    const r3 = await admin(p.deps, 'customer.update', VALID_INPUTS['customer.update']);
    assert.equal(r3.status, 200, 'customerUpdate ran; a restricted field in the reply does not turn it into a failure');
});

test('rejection: expired token is refreshed once; a dead refresh token → token_expired, health recorded, nothing sent', async () => {
    const env = await setup({ expired: true });
    const ok = await admin(env.deps, 'product.update', VALID_INPUTS['product.update']);
    assert.equal(ok.status, 200);
    assert.equal(env.fetch.calls.filter((c) => c.refresh).length, 1);
    const dead = await setup({ expired: true, st: shopState({ refreshFails: true }) });
    const res = await admin(dead.deps, 'product.update', VALID_INPUTS['product.update']);
    assert.equal(res.status, 422);
    assert.equal(res.body.error, 'token_expired');
    assert.equal(mutations(dead.fetch).length, 0);
    assert.ok(dead.hub.health.some(([okFlag, code]) => !okFlag && code === 'token_expired'));
});

test('rejection: missing scope, missing permission, management not enabled, or another store’s connection — refused by the database before Shopify', async () => {
    const cases = [
        [new FakeAuthz({ scopes: S.SHOPIFY_SCOPES }), 403, 'missing_scope'],
        [new FakeAuthz({ perms: ['store.orders'] }), 403, 'forbidden'],
        [new FakeAuthz({ entitled: false }), 403, 'management_not_enabled'],
        [new FakeAuthz({ company: 'co-b' }), 404, 'not_found']
    ];
    for (const [authz, status, code] of cases) {
        const env = await setup({ authz });
        for (const op of ['product.update', 'product.delete', 'inventory.levels']) {
            const res = await admin(env.deps, op, VALID_INPUTS[op]);
            assert.equal(res.status, status, `${code} ${op}`);
            assert.equal(res.body.error, code, `${code} ${op}`);
        }
        assert.equal(env.fetch.calls.length, 0, `${code}: Shopify never called`);
        assert.equal(env.hub.results.length, 0);
    }
    // ربط متجر ب من جلسة متجر أ
    const env = await setup();
    const res = await handleApi(env.deps, { action: 'shopify_admin', connection_id: CONN_B, op: 'product.update', input: VALID_INPUTS['product.update'] });
    assert.equal(res.status, 404);
    assert.equal(env.fetch.calls.length, 0);
    // مدخلات غير صالحة: لا تفويض ولا Shopify
    const before = env.authz.calls.length;
    const bad = await admin(env.deps, 'product.update', { id: G.product });
    assert.deepEqual(bad.body, { error: 'invalid_input', field: 'input' });
    assert.equal(env.authz.calls.length, before, 'invalid input never reaches the database');
    assert.equal((await admin(env.deps, 'order.refund', {})).body.error, 'unsupported');
});

test('order.cancel: only an unpaid, unfulfilled order; never a refund; result is "submitted" (async job), not "cancelled"', async () => {
    for (const over of [{ financial: 'PAID', fullyPaid: true, received: '200.00' }, { financial: 'PARTIALLY_PAID', received: '50.00' },
                        { financial: 'AUTHORIZED', capturable: true }, { financial: 'PENDING', received: '10.00' }]) {
        const env = await setup({ st: shopState(over) });
        const res = await admin(env.deps, 'order.cancel', VALID_INPUTS['order.cancel']);
        assert.equal(res.status, 409, JSON.stringify(over));
        assert.deepEqual(res.body, { error: 'not_eligible', reason: 'cancel_requires_refund_review' });
        assert.equal(mutations(env.fetch).length, 0);
    }
    const fulfilled = await setup({ st: shopState({ fulfillment: 'FULFILLED' }) });
    assert.equal((await admin(fulfilled.deps, 'order.cancel', VALID_INPUTS['order.cancel'])).body.reason, 'order_fulfilled');
    const done = await setup({ st: shopState({ cancelledAt: '2026-10-27T00:00:00Z' }) });
    assert.equal((await admin(done.deps, 'order.cancel', VALID_INPUTS['order.cancel'])).body.reason, 'already_cancelled');
    // أهلية تتغير بين التأكيد والتنفيذ: يُعاد الفحص قبل الإرسال
    const env = await setup();
    const first = await admin(env.deps, 'order.cancel', VALID_INPUTS['order.cancel']);
    assert.deepEqual(first.body.preview, { name: '#1001', financial_status: 'PENDING', total: { amount: '200.00', currency: 'EGP' }, restock: true, notify_customer: false, refund: false });
    env.st.financial = 'PAID'; env.st.fullyPaid = true; env.st.received = '200.00';
    const late = await admin(env.deps, 'order.cancel', VALID_INPUTS['order.cancel'], { confirmation_token: first.body.confirmation_token });
    assert.equal(late.body.reason, 'cancel_requires_refund_review');
    assert.equal(mutations(env.fetch).length, 0);
    assert.equal(env.hub.results[0].p_error_code, 'not_eligible');
    const okEnv = await setup();
    const ok = await confirmAndRun(okEnv, 'order.cancel', VALID_INPUTS['order.cancel']);
    assert.equal(ok.body.status, 'submitted');
    const m = mutations(okEnv.fetch)[0];
    assert.deepEqual(m.variables.refundMethod, { originalPaymentMethodsRefund: false });
    assert.equal(m.variables.notifyCustomer, false, 'no customer message unless asked');
});

test('order.create: prices and currency come from Shopify, not the browser; financialStatus PENDING; no receipt unless asked', async () => {
    const env = await setup({ st: shopState({ variantPrice: '123.45' }) });
    const res = await confirmAndRun(env, 'order.create', VALID_INPUTS['order.create']);
    assert.equal(res.status, 200);
    const m = mutations(env.fetch)[0];
    assert.deepEqual(m.variables.order.lineItems, [{ variantId: G.variant, quantity: 2, priceSet: { shopMoney: { amount: '123.45', currencyCode: 'EGP' } } }]);
    assert.equal(m.variables.order.financialStatus, 'PENDING');
    assert.equal(m.variables.order.transactions, undefined);
    assert.deepEqual(m.variables.options, { inventoryBehaviour: 'DECREMENT_OBEYING_POLICY', sendReceipt: false, sendFulfillmentReceipt: false });
    assert.equal(res.body.result.financial_status, 'PENDING');
    const unavailable = await setup({ st: shopState({ availableForSale: false }) });
    assert.equal((await admin(unavailable.deps, 'order.create', VALID_INPUTS['order.create'])).body.reason, 'lines.0.not_available');
});

test('inventory: item/location validated against Shopify, compare-and-swap + idempotency key sent, every adjustment journaled', async () => {
    const env = await setup();
    const first = await admin(env.deps, 'inventory.adjust', VALID_INPUTS['inventory.adjust']);
    assert.deepEqual(first.body.preview.changes[0], { inventory_item_id: G.item, location_id: G.location, location_name: 'Main', current: 10, expected: 10,
                                                     stale: false, delta: -2, after: 8, tracked: true });
    const res = await admin(env.deps, 'inventory.adjust', VALID_INPUTS['inventory.adjust'], { confirmation_token: first.body.confirmation_token });
    assert.equal(res.status, 200);
    const m = mutations(env.fetch)[0];
    assert.match(m.query, /@idempotent\(key: \$idempotencyKey\)/);
    assert.equal(m.variables.idempotencyKey, res.body.op_id);
    assert.equal(m.variables.input.changes[0].changeFromQuantity, 10);
    assert.equal(m.variables.input.referenceDocumentUri, `gid://mad3oom/StoreOperation/${res.body.op_id}`);
    assert.deepEqual(env.hub.results[0].p_detail, { name: 'available', reason: 'damaged',
        changes: [{ item: 'InventoryItem/301', location: 'Location/401', delta: -2, from: 10, after: 8 }] });
    // موقع غير مربوط بالصنف
    const other = await setup();
    const bad = await admin(other.deps, 'inventory.adjust', { ...VALID_INPUTS['inventory.adjust'],
        changes: [{ inventory_item_id: G.item, location_id: G.location2, delta: 1, expected_quantity: 0 }] });
    assert.deepEqual(bad.body, { error: 'not_eligible', reason: 'changes.0.location_id' });
    // تغيّر في Shopify بعد ما رآه المستخدم: يظهر في التأكيد
    const stale = await setup({ st: shopState({ available: 7 }) });
    assert.equal((await admin(stale.deps, 'inventory.adjust', VALID_INPUTS['inventory.adjust'])).body.preview.changes[0].stale, true);
    const act = await setup();
    assert.equal((await admin(act.deps, 'inventory.activate', { ...VALID_INPUTS['inventory.activate'], location_id: G.location })).body.reason, 'already_stocked');
});

test('fulfillment and returns: fulfillment orders and returnable quantities are checked against the order in Shopify', async () => {
    const env = await setup();
    const foreign = await admin(env.deps, 'fulfillment.create', { ...VALID_INPUTS['fulfillment.create'], fulfillment_orders: [{ id: 'gid://shopify/FulfillmentOrder/9999' }] });
    assert.deepEqual(foreign.body, { error: 'not_eligible', reason: 'fulfillment_orders.0.id' });
    const tooMany = await admin(env.deps, 'fulfillment.create', { ...VALID_INPUTS['fulfillment.create'], fulfillment_orders: [{ id: G.fo, lines: [{ id: G.foLine, quantity: 3 }] }] });
    assert.equal(tooMany.body.reason, 'fulfillment_orders.0.lines.0.quantity');
    const closed = await setup({ st: shopState({ foStatus: 'CLOSED' }) });
    assert.equal((await admin(closed.deps, 'fulfillment.create', VALID_INPUTS['fulfillment.create'])).body.reason, 'fulfillment_orders.0.not_fulfillable');
    const ok = await confirmAndRun(await setup(), 'fulfillment.create', VALID_INPUTS['fulfillment.create']);
    assert.equal(ok.status, 200);
    const ret = await setup({ st: shopState({ returnable: 0 }) });
    assert.equal((await admin(ret.deps, 'return.create', VALID_INPUTS['return.create'])).body.reason, 'lines.0.quantity');
    const closeReq = await setup({ st: shopState({ returnStatus: 'REQUESTED' }) });
    assert.equal((await admin(closeReq.deps, 'return.close', VALID_INPUTS['return.close'])).body.reason, 'return_status');
    const pub = await setup();
    assert.equal((await admin(pub.deps, 'product.publish', { id: G.product, publication_ids: ['gid://shopify/Publication/999'] })).body.reason, 'publication_ids.0');
});

test('order payment state: "paid" only when Shopify says PAID and fullyPaid', () => {
    assert.equal(A.paymentState({ displayFinancialStatus: 'PAID', fullyPaid: true }).paid_confirmed, true);
    assert.equal(A.paymentState({ displayFinancialStatus: 'PAID', fullyPaid: false }).paid_confirmed, false);
    assert.equal(A.paymentState({ displayFinancialStatus: 'PARTIALLY_PAID', fullyPaid: true }).paid_confirmed, false);
    assert.equal(A.paymentState({ displayFinancialStatus: 'AUTHORIZED' }).paid_confirmed, false);
    assert.equal(A.paymentState({}).financial_status, null);
});

test('a lost reply is reported as outcome unknown (may have run in Shopify), never as a clean failure', async () => {
    const env = await setup();
    env.deps.fetch = async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); };
    const res = await admin(env.deps, 'product.update', VALID_INPUTS['product.update']);
    assert.equal(res.body.outcome, 'unknown');
    assert.equal(env.hub.results[0].p_status, 'failed');
});

/* ══ OAuth: نطاقات الإدارة لمتجر مستحق فقط ═══════════════════════════════════ */

test('shopify_start requests management scopes only when the database says the store is entitled; otherwise (or on error) the read scopes', async () => {
    for (const [authz, expect] of [[new FakeAuthz({ entitled: true }), S.REQUESTED_SCOPES], [new FakeAuthz({ entitled: false }), S.SHOPIFY_SCOPES],
                                   [Object.assign(new FakeAuthz(), { statusThrows: true }), S.SHOPIFY_SCOPES]]) {
        const env = await setup({ authz });
        const res = await handleApi(env.deps, { action: 'shopify_start', connection_id: CONN, shop: 'shop-a' });
        assert.equal(res.status, 200);
        assert.deepEqual(new URL(res.body.authorize_url).searchParams.get('scope').split(','), [...expect]);
        assert.deepEqual(res.body.scopes, [...expect]);
    }
    assert.throws(() => S.authorizeUrl({ clientId: 'c', redirectUri: ENV.SHOPIFY_REDIRECT_URI, state: 's'.repeat(40), shop: SHOP, scopes: ['write_orders'] }),
                  (e) => e.code === 'invalid_input', 'the read scopes are always included');
    assert.throws(() => S.authorizeUrl({ clientId: 'c', redirectUri: ENV.SHOPIFY_REDIRECT_URI, state: 's'.repeat(40), shop: SHOP,
                                         scopes: [...S.SHOPIFY_SCOPES, 'read_all_orders'] }), (e) => e.code === 'invalid_input', 'never an unlisted scope');
});

test('static: the management module never logs, never reads env secrets, and keeps the read-only connector free of mutations', () => {
    const src = read('supabase/functions/_shared/integrations/shopify-admin.js');
    assert.doesNotMatch(src, /console\.|\.env\b|SHOPIFY_CLIENT_SECRET|access_token/);
    assert.doesNotMatch(read('supabase/functions/_shared/integrations/shopify.js'), /\bmutation\b/);
    const api = read('supabase/functions/_shared/integrations/api.js');
    assert.match(api, /ihub_shopify_op_authorize/);
    assert.doesNotMatch(api.slice(api.indexOf('async function actionShopifyAdmin')), /company_id:\s*body|body\.company|body\.store/);
});
