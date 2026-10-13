/**
 * مركز التكاملات في لوحة الشركة — اختبار عرض في Chromium حقيقي مقابل بديل
 * Supabase الاختباري (tests/fixtures/supabase-double.js). العزل والتفويض
 * مختبَران في tests/sql/integrations-hub.test.sql؛ هنا العرض والتفاعل:
 * من يرى ماذا، أن الأسرار تُعرض مرة واحدة ولا تبقى في النموذج، وأن الفصل
 * يحتاج تأكيدًا، وأن لوحة سياق التذكرة تعرض قائمة السماح فقط.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = path.resolve(import.meta.dirname, '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
               '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function startServer() {
    const server = http.createServer((req, res) => {
        const urlPath = decodeURIComponent(req.url.split('?')[0]);
        const filePath = path.join(ROOT, urlPath === '/' ? '/index.html' : urlPath);
        if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
            res.writeHead(404); res.end('not found'); return;
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
        fs.createReadStream(filePath).pipe(res);
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const USER_ID = '11111111-1111-1111-1111-111111111111';
const CUSTOMER_ID = '22222222-2222-4222-8222-222222222222';
const COMPANY_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TICKET_ID = 'tttttttt-0000-4000-8000-000000000001';
const WEBHOOK_SECRET = 'WHSEC_ONE_TIME_abcdefghijklmnopqrstuvwxyz';

const CAPS = {
    wordpress: { create_ticket: 'partial', webhooks: 'not_applicable', write_operations: 'missing' },
    woocommerce: { fetch_order: 'implemented_unverified', link_ticket: 'implemented_unverified', webhooks: 'implemented_unverified',
                   write_operations: 'missing', incremental_sync: 'missing', fetch_customer: 'missing' },
    salla: { fetch_order: 'implemented_unverified', webhooks: 'implemented_unverified', refresh_credentials: 'implemented_unverified' },
    daftra: { fetch_invoice: 'implemented_unverified', fetch_customer: 'implemented_unverified', webhooks: 'missing', write_operations: 'missing' }
};

function overview(over = {}) {
    return {
        company_id: COMPANY_ID, entitled: true, can_manage: true, intake_new: 0,
        providers: ['wordpress', 'woocommerce', 'salla', 'daftra'].map((key) => ({
            key, name_ar: key, enabled: key !== 'salla', release_stage: 'beta', auth_kind: 'x', capabilities: CAPS[key]
        })),
        connections: [],
        ...over
    };
}

function companyPayload() {
    return {
        company: { id: COMPANY_ID, name: 'شركة النور', cr_number: '1010', cr_expiry: '2027-06-01', status: 'active', is_owner: true,
                   created_at: '2026-01-01T00:00:00Z' },
        registration: { expiry_date: '2027-06-01', is_expired: false, days_to_expiry: 200 },
        subscriptions: [], entitlements: []
    };
}

function fixtures({ rpc = {}, functions = {}, tables = {} } = {}) {
    return {
        user: { id: USER_ID, email: 'owner@example.com' },
        authUser: { id: USER_ID, email: 'owner@example.com', profile: { id: USER_ID, full_name: 'مالك', role: 'company_admin' } },
        rpc: {
            get_my_company_dashboard: companyPayload(),
            current_company_id: COMPANY_ID,
            company_members: { company_id: COMPANY_ID, scope: 'full', can_manage: true, is_owner: true,
                               members: [{ id: USER_ID, name: 'مالك', is_owner: true }, { id: CUSTOMER_ID, name: 'سارة', email: 'sara@example.com', is_owner: false }] },
            ihub_overview: overview(),
            ihub_intake_list: [],
            ...rpc
        },
        functions,
        tables: {
            profiles: [{ id: USER_ID, email: 'owner@example.com', full_name: 'مالك', role: 'company_admin' },
                       { id: CUSTOMER_ID, email: 'sara@example.com', full_name: 'سارة', role: 'company_user', super_user_id: USER_ID }],
            notifications: [], services: [], whatsapp_subscriptions: [], subscription_plans: [],
            ...tables
        }
    };
}

async function open(browser, baseUrl, fx, { hash = 'integrations', query = '', viewport } = {}) {
    const context = await browser.newContext({ viewport: viewport || { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const doubleSupabase = fs.readFileSync(path.join(ROOT, 'tests/fixtures/supabase-double.js'), 'utf8');
    const doubleAuth = fs.readFileSync(path.join(ROOT, 'tests/fixtures/auth-client-double.js'), 'utf8');
    await page.route('**/api-config.js', (r) => r.fulfill({ contentType: 'text/javascript; charset=utf-8', body: doubleSupabase }));
    await page.route('**/auth-client.js', (r) => r.fulfill({ contentType: 'text/javascript; charset=utf-8', body: doubleAuth }));
    await page.route('**/chat-widget.js', (r) => r.fulfill({ contentType: 'text/javascript', body: 'export default {};' }));
    await page.route('**/error-tracker.js', (r) => r.fulfill({ contentType: 'text/javascript', body: '' }));
    await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: '' }));
    await page.addInitScript((data) => { window.__FIXTURES__ = data; }, fx);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(`${baseUrl}/company-dashboard/index.html${query}#${hash}`, { waitUntil: 'networkidle' });
    try {
        await page.waitForSelector('.sidebar-item[data-tab="integrations"]', { timeout: 10000 });
    } catch (err) {
        const at = page.url();
        await context.close();
        throw new Error(`dashboard did not initialise at ${at}: ${errors.join(' | ') || err.message}`);
    }
    return { page, context, errors };
}

function resolveChromium() {
    try {
        const p = chromium.executablePath();
        if (p && fs.existsSync(p)) return p;
    } catch { /* no download */ }
    const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
    if (root && fs.existsSync(root)) {
        for (const dir of fs.readdirSync(root).filter((d) => d.startsWith('chromium')).sort().reverse()) {
            for (const rel of ['chrome-linux/chrome', 'chrome-linux/headless_shell', 'chrome']) {
                const candidate = path.join(root, dir, rel);
                if (fs.existsSync(candidate)) return candidate;
            }
        }
    }
    return null;
}

let browser, server, baseUrl;
const chromiumPath = resolveChromium();
if (!chromiumPath) console.error('SKIP: no Chromium available; company integrations render tests NOT executed');

test.before(async () => {
    if (!chromiumPath) return;
    server = await startServer();
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: chromiumPath });
});
test.after(async () => { await browser?.close(); server?.close(); });

const run = (name, fn) => test(name, { skip: !chromiumPath && 'no Chromium' }, fn);

run('admin sees four provider cards in order; a disabled provider and unsupported capabilities are visibly unavailable', async () => {
    const { page, context, errors } = await open(browser, baseUrl, fixtures());
    await page.waitForSelector('.ihub-card');
    assert.deepEqual(await page.$$eval('.ihub-card', (els) => els.map((e) => e.dataset.provider)), ['wordpress', 'woocommerce', 'salla', 'daftra']);
    const salla = page.locator('.ihub-card[data-provider="salla"]');
    assert.match(await salla.innerText(), /غير متاح حاليًا على المنصة/);
    assert.equal(await salla.locator('[data-ihub-action]').count(), 0, 'no button for a disabled provider');
    const daftraWebhooks = page.locator('.ihub-card[data-provider="daftra"] [data-cap="webhooks"]');
    assert.equal(await daftraWebhooks.getAttribute('class'), 'is-off');
    assert.match(await daftraWebhooks.innerText(), /غير متاح/);
    assert.equal(await page.locator('.ihub-card[data-provider="woocommerce"] [data-ihub-action="open-form"]').count(), 1);
    assert.equal(await page.locator('.ihub-card[data-provider="woocommerce"] [data-ihub-action="test"]').count(), 0, 'no test before connecting');
    assert.deepEqual(errors, []);
    await context.close();
});

run('connect WooCommerce: invalid input makes no call; valid input shows the webhook secret once and clears the key fields', async () => {
    const fx = fixtures({
        rpc: { ihub_prepare_connection: { id: 'conn-woo', provider: 'woocommerce', status: 'pending' } },
        functions: { 'integrations-api': { data: { connection: { id: 'conn-woo', status: 'active' },
                                                   webhook: { delivery_url: 'https://p.supabase.co/functions/v1/integrations-inbound/woocommerce/conn-woo',
                                                              secret: WEBHOOK_SECRET, topics: ['order.created', 'order.updated'], shown_once: true } } } }
    });
    const { page, context, errors } = await open(browser, baseUrl, fx);
    await page.click('.ihub-card[data-provider="woocommerce"] [data-ihub-action="open-form"]');
    await page.fill('[data-ihub-form="woocommerce"] [name="store_url"]', 'http://shop.example.com');
    await page.fill('[data-ihub-form="woocommerce"] [name="consumer_key"]', 'ck_' + 'a'.repeat(40));
    await page.fill('[data-ihub-form="woocommerce"] [name="consumer_secret"]', 'cs_' + 'b'.repeat(40));
    assert.equal(await page.getAttribute('[data-ihub-form="woocommerce"] [name="consumer_secret"]', 'type'), 'password');
    await page.click('[data-ihub-form="woocommerce"] button[type="submit"]');
    assert.match(await page.innerText('[data-field-error="store_url"]'), /https/);
    assert.equal(await page.evaluate(() => (window.__INVOCATIONS__ || []).length), 0);
    assert.ok(!(await page.evaluate(() => window.__RPC_CALLS__ || [])).includes('ihub_prepare_connection'));

    await page.fill('[data-ihub-form="woocommerce"] [name="store_url"]', 'https://shop.example.com');
    await page.click('[data-ihub-form="woocommerce"] button[type="submit"]');
    await page.waitForSelector('.ihub-reveal');
    const inv = await page.evaluate(() => window.__INVOCATIONS__);
    assert.equal(inv.length, 1);
    assert.equal(inv[0].name, 'integrations-api');
    assert.deepEqual(Object.keys(inv[0].body).sort(), ['action', 'connection_id', 'consumer_key', 'consumer_secret', 'store_url']);
    assert.equal(inv[0].body.connection_id, 'conn-woo');
    assert.equal(await page.inputValue('#ihubRevealValue'), WEBHOOK_SECRET);
    assert.equal(await page.locator('[data-ihub-form="woocommerce"]').count(), 0, 'the form with the keys is gone');
    assert.ok(!(await page.content()).includes('cs_' + 'b'.repeat(40)), 'the consumer secret is not left in the page');

    await page.click('[data-ihub-action="dismiss-reveal"]');
    assert.ok(!(await page.content()).includes(WEBHOOK_SECRET), 'the one-time secret is gone after dismissal');
    assert.deepEqual(errors, []);
    await context.close();
});

run('a non-admin (overview null) gets an explanation and no controls; an unentitled company gets read-only cards', async () => {
    let { page, context } = await open(browser, baseUrl, fixtures({ rpc: { ihub_overview: null } }));
    await page.waitForSelector('#companyIntegrations .state-block');
    assert.match(await page.innerText('#companyIntegrations'), /لمدير الشركة/);
    assert.equal(await page.locator('[data-ihub-action]').count(), 0);
    await context.close();

    ({ page, context } = await open(browser, baseUrl, fixtures({ rpc: { ihub_overview: overview({ entitled: false, can_manage: false }) } })));
    await page.waitForSelector('.ihub-card');
    assert.match(await page.innerText('#companyIntegrations'), /لا يشمل مركز التكاملات/);
    assert.equal(await page.locator('[data-ihub-action]').count(), 0);
    await context.close();
});

run('disconnect asks first: cancelling calls nothing; confirming calls ihub_disconnect once', async () => {
    const fx = fixtures({ rpc: {
        ihub_overview: overview({ connections: [{ id: 'conn-woo', provider: 'woocommerce', status: 'active', account_label: 'متجر النور',
                                                  min_view_role: 'admin', last_success_at: '2026-10-12T08:00:00Z' }] }),
        ihub_disconnect: { disconnected: true }
    } });
    const { page, context, errors } = await open(browser, baseUrl, fx);
    await page.waitForSelector('.ihub-card[data-provider="woocommerce"] [data-ihub-action="disconnect"]');
    assert.match(await page.innerText('.ihub-card[data-provider="woocommerce"]'), /متجر النور/);
    await page.click('.ihub-card[data-provider="woocommerce"] [data-ihub-action="disconnect"]');
    await page.waitForSelector('.ui-dialog');
    assert.match(await page.innerText('.ui-dialog'), /REST API/);
    await page.click('.ui-dialog button:has-text("تراجع")');
    assert.ok(!(await page.evaluate(() => window.__RPC_CALLS__)).includes('ihub_disconnect'));
    await page.click('.ihub-card[data-provider="woocommerce"] [data-ihub-action="disconnect"]');
    await page.click('.ui-dialog button:has-text("فصل")');
    await page.waitForFunction(() => (window.__RPC_CALLS__ || []).includes('ihub_disconnect'));
    const args = await page.evaluate(() => window.__RPC_ARGS__.filter(([n]) => n === 'ihub_disconnect'));
    assert.deepEqual(args, [['ihub_disconnect', { p_connection: 'conn-woo' }]]);
    assert.deepEqual(errors, []);
    await context.close();
});

run('the Salla OAuth return shows a message and removes the parameters from the address bar', async () => {
    const { page, context } = await open(browser, baseUrl, fixtures(), { query: '?ihub_result=error&ihub_code=account_in_use' });
    await page.waitForSelector('#ui-toast-container');
    assert.match(await page.innerText('#ui-toast-container'), /شركة أخرى/);
    assert.ok(!page.url().includes('ihub_result'));
    await context.close();
});

run('customer ticket: the external-context panel shows the allowlisted order summary and links with a ticket-scoped call', async () => {
    const ctx = {
        ticket_id: TICKET_ID, my_role: 'admin',
        connections: [{ id: 'conn-woo', provider: 'woocommerce', status: 'active', account_label: 'متجر', link_types: ['order'] }],
        links: [{ link_id: 'link-1', provider: 'woocommerce', record_type: 'order', external_id: '501', display_ref: '#501',
                  external_url: 'https://shop.example.com/wp-admin/post.php?post=501&action=edit', connection_status: 'active',
                  fetched_at: '2026-10-12T09:00:00Z',
                  summary: { status: 'processing', total: '120.50', currency: 'SAR', customer_email_masked: 's***@example.com',
                             items: [{ name: 'قميص', quantity: 2 }], secret_note: 'SHOULD_NOT_RENDER' } }],
        customer_refs: []
    };
    const fx = fixtures({
        rpc: { ihub_ticket_context: ctx },
        functions: { 'integrations-api': { data: { link_id: 'link-2', created: true } } },
        tables: { tickets: [{ id: TICKET_ID, user_id: CUSTOMER_ID, title: 'طلبي متأخر', description: 'لم يصل', status: 'open', ticket_number: 77,
                              created_at: '2026-10-11T09:00:00Z', profiles: { full_name: 'سارة', email: 'sara@example.com' } }] }
    });
    const { page, context, errors } = await open(browser, baseUrl, fx, { hash: 'customerTickets' });
    await page.waitForSelector('[data-stream-ticket]');
    await page.click('[data-stream-ticket]');
    await page.waitForSelector('.ihub-ticket');
    const text = await page.innerText('.ihub-ticket');
    assert.match(text, /ووكومرس · طلب #501/);
    assert.match(text, /120\.50 SAR/);
    assert.match(text, /قميص × 2/);
    assert.ok(!text.includes('SHOULD_NOT_RENDER'));
    const a = page.locator('.ihub-record a');
    assert.equal(await a.getAttribute('rel'), 'noopener noreferrer');
    assert.equal(await a.getAttribute('target'), '_blank');

    await page.fill('.ihub-ticket input[name="reference"]', '1007');
    await page.click('.ihub-ticket button[type="submit"]');
    await page.waitForFunction(() => (window.__INVOCATIONS__ || []).length === 1);
    const inv = await page.evaluate(() => window.__INVOCATIONS__[0]);
    assert.deepEqual(inv.body, { action: 'link_record', connection_id: 'conn-woo', ticket_id: TICKET_ID, record_type: 'order', reference: '1007' });
    assert.deepEqual(errors, []);
    await context.close();
});

run('customer ticket: no context (not authorised, or before 087) means no panel at all', async () => {
    const fx = fixtures({
        rpc: { ihub_ticket_context: null },
        tables: { tickets: [{ id: TICKET_ID, user_id: CUSTOMER_ID, title: 'سؤال', description: 'x', status: 'open', ticket_number: 78,
                              created_at: '2026-10-11T09:00:00Z', profiles: { full_name: 'سارة' } }] }
    });
    const { page, context } = await open(browser, baseUrl, fx, { hash: 'customerTickets' });
    await page.waitForSelector('[data-stream-ticket]');
    await page.click('[data-stream-ticket]');
    await page.waitForFunction(() => (window.__RPC_CALLS__ || []).includes('ihub_ticket_context'));
    await page.waitForTimeout(100);
    assert.equal(await page.locator('.ihub-ticket').count(), 0);
    await context.close();
});

run('mobile 390px: the integrations section has no horizontal overflow and buttons are touch-sized', async () => {
    const fx = fixtures({ rpc: { ihub_overview: overview({ connections: [{ id: 'c', provider: 'woocommerce', status: 'active', account_label: 'متجر بعنوان طويل جدًا جدًا', min_view_role: 'admin' }] }) } });
    const { page, context } = await open(browser, baseUrl, fx, { viewport: { width: 390, height: 844 } });
    await page.waitForSelector('.ihub-card');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `horizontal overflow ${overflow}px`);
    const heights = await page.$$eval('.ihub-card .company-form-actions .btn', (bs) => bs.map((b) => b.getBoundingClientRect().height));
    assert.ok(heights.length > 0 && heights.every((h) => h >= 43), JSON.stringify(heights));
    await context.close();
});
