/**
 * مركز التكاملات — منطق العرض الخالص (assets/js/company/integrations-model.js)
 * وضوابط ثابتة على نداءات الواجهة.
 *
 * التفويض كله في القاعدة (tests/sql/integrations-hub.test.sql). هنا:
 *   1) الواجهة لا تُظهر زرًا لقدرة غير مدعومة، ولا لمزوّد مقفل، ولا لغير المدير.
 *   2) رسائل الأخطاء من رموز ثابتة فقط.
 *   3) الملخص المعروض قائمة سماح.
 *   4) لا معرّف شركة ولا دالة خادم في أي نداء من المتصفح.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const M = await import('../assets/js/company/integrations-model.js');

const CAPS = {
    woocommerce: { fetch_order: 'implemented_unverified', link_ticket: 'implemented_unverified', webhooks: 'implemented_unverified',
                   fetch_invoice: 'not_applicable', write_operations: 'missing', incremental_sync: 'missing', fetch_customer: 'missing',
                   refresh_credentials: 'not_applicable', create_ticket: 'not_applicable' },
    daftra: { fetch_invoice: 'implemented_unverified', fetch_customer: 'implemented_unverified', webhooks: 'missing',
              fetch_order: 'not_applicable', write_operations: 'missing' }
};
const overview = (over = {}) => ({
    company_id: 'c', entitled: true, can_manage: true,
    providers: [
        { key: 'daftra', enabled: true, release_stage: 'beta', auth_kind: 'api_key', capabilities: CAPS.daftra },
        { key: 'woocommerce', enabled: true, release_stage: 'beta', auth_kind: 'api_key_pair', capabilities: CAPS.woocommerce },
        { key: 'salla', enabled: false, release_stage: 'beta', auth_kind: 'oauth2', capabilities: {} },
        { key: 'wordpress', enabled: true, release_stage: 'beta', auth_kind: 'site_pairing', capabilities: { create_ticket: 'partial' } }
    ],
    connections: [],
    ...over
});

test('cards follow the fixed provider order and show only what the catalog says', () => {
    const cards = M.buildProviderCards(overview());
    assert.deepEqual(cards.map((c) => c.key), ['wordpress', 'woocommerce', 'salla', 'daftra']);
    const woo = cards.find((c) => c.key === 'woocommerce');
    assert.ok(woo.capabilities.find((c) => c.key === 'webhooks').available);
    assert.ok(!woo.capabilities.find((c) => c.key === 'write_operations').available);
    assert.ok(!woo.capabilities.some((c) => c.key === 'fetch_invoice'), 'not_applicable is hidden, not shown as available');
    const daftra = cards.find((c) => c.key === 'daftra');
    assert.equal(daftra.capabilities.find((c) => c.key === 'webhooks').state, 'غير متاح');
    assert.equal(cards.find((c) => c.key === 'wordpress').capabilities.find((c) => c.key === 'create_ticket').state, 'جزئي');
});

test('actions: a disabled provider, a non-manager, and a missing connection get no misleading buttons', () => {
    const salla = M.buildProviderCards(overview()).find((c) => c.key === 'salla');
    assert.equal(salla.enabled, false);
    assert.ok(Object.values(salla.actions).every((v) => v === false));

    const readOnly = M.buildProviderCards(overview({ can_manage: false }));
    for (const c of readOnly) assert.ok(Object.values(c.actions).every((v) => v === false), c.key);

    const fresh = M.buildProviderCards(overview()).find((c) => c.key === 'woocommerce');
    assert.deepEqual(fresh.actions, { connect: true, reconnect: false, test: false, rotate: false, disconnect: false, viewRole: false });

    const live = M.buildProviderCards(overview({ connections: [{ id: 'x', provider: 'woocommerce', status: 'active', min_view_role: 'admin' }] }))
        .find((c) => c.key === 'woocommerce');
    assert.deepEqual(live.actions, { connect: false, reconnect: false, test: true, rotate: true, disconnect: true, viewRole: true });

    const wp = M.buildProviderCards(overview({ connections: [{ id: 'w', provider: 'wordpress', status: 'active' }] })).find((c) => c.key === 'wordpress');
    assert.equal(wp.actions.test, false, 'Mad3oom never calls the site');
    assert.equal(wp.actions.viewRole, false);

    assert.equal(M.buildProviderCards(null), null);
    assert.equal(M.buildProviderCards({}), null);
});

test('errors are fixed messages keyed by code; an unknown code never echoes provider text', () => {
    assert.match(M.errorMessage('auth_failed'), /بيانات الاعتماد/);
    assert.equal(M.errorMessage('<script>alert(1)</script>'), M.ERROR_MESSAGES.unknown_error);
    assert.equal(M.errorMessage(undefined), M.ERROR_MESSAGES.unknown_error);
    const card = M.buildProviderCards(overview({ connections: [{ id: 'x', provider: 'woocommerce', status: 'error', last_error_code: 'rate_limited' }] }))
        .find((c) => c.key === 'woocommerce');
    assert.match(card.lastError, /يحدّ عدد الطلبات/);
});

test('connect forms are checked before any call, and the server re-checks', () => {
    assert.equal(M.validateConnectForm('woocommerce', { store_url: 'http://s.example', consumer_key: 'ck_' + 'a'.repeat(40), consumer_secret: 'cs_' + 'b'.repeat(40) }).ok, false);
    assert.equal(M.validateConnectForm('woocommerce', { store_url: 'https://s.example', consumer_key: 'admin', consumer_secret: 'x' }).ok, false);
    const ok = M.validateConnectForm('woocommerce', { store_url: ' https://s.example ', consumer_key: 'ck_' + 'a'.repeat(40), consumer_secret: 'cs_' + 'b'.repeat(40) });
    assert.deepEqual(ok.payload, { store_url: 'https://s.example', consumer_key: 'ck_' + 'a'.repeat(40), consumer_secret: 'cs_' + 'b'.repeat(40) });
    assert.equal(M.validateConnectForm('daftra', { subdomain: 'https://Acme.daftra.com', api_key: 'k'.repeat(20) }).payload.subdomain, 'acme');
    assert.equal(M.validateConnectForm('daftra', { subdomain: 'evil.com', api_key: 'k'.repeat(20) }).ok, false);
    assert.equal(M.validateConnectForm('wordpress', { site_url: 'https://example.com' }).ok, true);
    assert.equal(M.validateConnectForm('salla', {}).ok, false, 'Salla has no credential form');
});

test('the Salla authorize URL is followed only on accounts.salla.sa', () => {
    assert.ok(M.isSallaAuthorizeUrl('https://accounts.salla.sa/oauth2/auth?client_id=x&state=y'));
    for (const bad of ['https://accounts.salla.sa.evil.com/oauth2/auth', 'http://accounts.salla.sa/oauth2/auth',
                       'https://evil.com/oauth2/auth', 'javascript:alert(1)', '', null]) {
        assert.equal(M.isSallaAuthorizeUrl(bad), false, String(bad));
    }
});

test('ticket context: null means no panel; summary rows are an allowlist', () => {
    assert.equal(M.ticketContextView(null), null);
    assert.equal(M.ticketContextView({ connections: [], links: [] }), null);
    const v = M.ticketContextView({
        connections: [{ id: 'c1', provider: 'woocommerce', link_types: ['order'] }],
        links: [{ link_id: 'l1', provider: 'woocommerce', record_type: 'order', external_id: '501', display_ref: '#501',
                  external_url: 'javascript:alert(1)', connection_status: 'active',
                  summary: { status: 'processing', total: '10.00', currency: 'SAR', billing_address: 'شارع 1', phone: '0500',
                             items: [{ name: 'قميص', quantity: 2 }], customer_email_masked: 's***@x.com' } }]
    });
    assert.equal(v.links[0].url, null, 'a non-https link is never rendered');
    assert.deepEqual(v.links[0].rows.map((r) => r.key), ['status', 'total', 'customer_email_masked']);
    assert.equal(v.links[0].rows[1].value, '10.00 SAR');
    assert.equal(v.links[0].items, 'قميص × 2');
    assert.ok(!JSON.stringify(v.links[0].rows).includes('0500') && !JSON.stringify(v.links[0].rows).includes('شارع'));
    assert.deepEqual(v.linkOptions, [{ value: 'c1|order', connectionId: 'c1', recordType: 'order', label: 'ووكومرس — طلب' }]);
});

test('the OAuth return parameters become a fixed message; "confirm" needs a well-formed connection and completion code', () => {
    const c = M.oauthResultFrom(`?ihub_result=confirm&ihub_provider=salla&ihub_connection=33333333-3333-4333-8333-333333333333&ihub_completion=${'k'.repeat(43)}`);
    assert.deepEqual(c, { confirm: true, connectionId: '33333333-3333-4333-8333-333333333333', completion: 'k'.repeat(43), provider: 'salla' });
    assert.equal(M.oauthResultFrom('?ihub_result=confirm&ihub_connection=x&ihub_completion=y').ok, false);
    assert.equal(M.oauthBindingKey('abc'), 'ihub_oauth_binding:abc');
    assert.equal(M.oauthResultFrom('?ihub_result=connected&ihub_provider=salla').ok, true);
    assert.match(M.oauthResultFrom('?ihub_result=error&ihub_code=account_in_use').message, /شركة أخرى/);
    assert.equal(M.oauthResultFrom('?ihub_result=error&ihub_code=<img>').message, M.ERROR_MESSAGES.unknown_error);
    assert.equal(M.oauthResultFrom(''), null);
});

test('static: browser calls carry no company id, no service-role function, and secrets never touch storage', () => {
    const files = ['assets/js/company/integrations-data.js', 'assets/js/company/company-integrations.js', 'assets/js/company/ticket-integrations.js'];
    const src = files.map(read).join('\n');
    assert.doesNotMatch(src, /p_company|company_id\s*:/, 'no company id is ever sent');
    assert.doesNotMatch(src, /ihub_svc_|service_role/i);
    assert.doesNotMatch(src, /localStorage|indexedDB|document\.cookie/);
    // sessionStorage فقط لبصمة تدفق OAuth (لهذا التبويب، ليست بيانات اعتماد)
    const uses = [...src.matchAll(/sessionStorage|store\??\.(setItem|getItem|removeItem)\(([^,)]*)/g)].map((m) => m[0]);
    assert.ok(uses.length > 0);
    for (const u of uses) assert.match(u, /sessionStorage|oauthBindingKey|\(key/, u);
    assert.doesNotMatch(src, /console\.(log|info)\(/);
    for (const m of read('assets/js/company/integrations-data.js').matchAll(/rpc\('([a-z_]+)'/g)) {
        assert.match(m[1], /^ihub_[a-z_]+$/);
        assert.match(read('migrations/087_integrations_hub.sql'), new RegExp(`'public\\.${m[1]}\\(`), `${m[1]} is granted to authenticated in 087`);
    }
    // حقول المفاتيح من نوع password وبلا إكمال تلقائي
    assert.match(read('assets/js/company/company-integrations.js'), /'consumer_secret', 'Consumer secret', \{ type: 'password'/);
    assert.match(read('assets/js/company/company-integrations.js'), /autocomplete="off"/);
});
