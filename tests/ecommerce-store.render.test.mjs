// ============================================================================
// حسابات المتاجر (118/119) في متصفح حقيقي: بطاقة الباقة، طلب حساب المتجر، صفحات المتجر في لوحة
// الشركة، تدفق ربط Shopify من جهة الواجهة، والبحث والعرض.
//
// البيانات من بديل Supabase (tests/fixtures/supabase-double.js). القاعدة هي الحارس الحقيقي —
// مختبرة في tests/sql/*; هنا: الواجهة ترسم ما ترجعه القاعدة وترسل ما يجب فقط.
// ============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';

const ROOT = path.resolve(import.meta.dirname, '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
               '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
function startServer() {
    const server = http.createServer((req, res) => {
        const urlPath = decodeURIComponent(req.url.split('?')[0]);
        const filePath = path.join(ROOT, urlPath === '/' ? '/index.html' : urlPath);
        if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
        fs.createReadStream(filePath).pipe(res);
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}
function resolveChromium() {
    try { const p = chromium.executablePath(); if (p && fs.existsSync(p)) return p; } catch { /* none */ }
    const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
    if (root && fs.existsSync(root)) {
        for (const dir of fs.readdirSync(root).filter(d => d.startsWith('chromium')).sort().reverse()) {
            for (const rel of ['chrome-linux/chrome', 'chrome-linux64/chrome', 'chrome-linux/headless_shell', 'chrome']) {
                const c = path.join(root, dir, rel);
                if (fs.existsSync(c)) return c;
            }
        }
    }
    return null;
}

const ME = '11111111-1111-4111-8111-111111111111';
const COMPANY_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CONN = '66666666-6666-4666-8666-666666666666';
const XSS = '<img src=x onerror="window.__XSS__=1">';
const PLANS = [
    { key: 'support', name_ar: 'الخطة المتقدمة', price_monthly: 999, price_yearly: 9999, currency: 'EGP', is_active: true, sort_order: 10 },
    { key: 'ultimate', name_ar: 'الخطة الفائقة', price_monthly: 1999, price_yearly: 19999, currency: 'EGP', is_active: true, sort_order: 15 },
    { key: 'store', name_ar: 'باقة المتاجر الإلكترونية', price_monthly: null, price_yearly: null, currency: 'EGP', is_active: false, sort_order: 40 }
];

function customerFx({ plans = PLANS } = {}) {
    return {
        user: { id: ME, email: 'ahmed@test.local' },
        authUser: { id: ME, email: 'ahmed@test.local', profile: { id: ME, role: 'user', full_name: 'أحمد' } },
        tables: { profiles: [{ id: ME, full_name: 'أحمد', email: 'ahmed@test.local', role: 'user' }], subscription_plans: plans,
                  whatsapp_subscriptions: [], notifications: [] },
        rpc: { current_company_id: null, my_company_account_request: null, my_ticket_wallet: null, my_account_gate: { status: 'active' },
               submit_store_account_request: { id: 'req-s', status: 'pending', account_kind: 'ecommerce_store' } }
    };
}

function dashboardPayload() {
    return {
        company: { id: COMPANY_ID, name: 'متجر الورد', cr_number: '1010', cr_expiry: '2027-06-01', status: 'active', created_at: '2026-01-01T00:00:00Z', is_owner: true },
        registration: { expiry_date: '2027-06-01', is_expired: false, days_to_expiry: 200 },
        subscriptions: [{ id: 's1', plan: 'store', plan_name_ar: 'باقة المتاجر', status: 'active', billing_cycle: 'monthly',
                          start_date: '2026-10-01T00:00:00Z', end_date: '2026-12-01T00:00:00Z', is_active: true, days_remaining: 30 }],
        entitlements: [{ feature_key: 'shopify_integration', name_ar: 'تكامل Shopify', granted_by: ['store'] }],
        access: { active_plans: ['store'], has_active_subscription: true },
        viewer_role: 'admin'
    };
}

const CONNECTION = {
    id: CONN, provider: 'shopify', status: 'active', account_label: 'متجر الورد', base_url: 'https://ward.myshopify.com', min_view_role: 'admin',
    last_success_at: '2026-10-28T09:00:00Z', last_error_code: null, granted_scopes: ['read_orders'], last_sync_at: '2026-10-28T08:00:00Z',
    last_sync_status: 'succeeded', created_at: '2026-10-01T00:00:00Z'
};

function storeFx({ store = true, connection = CONNECTION, overview = {} } = {}) {
    return {
        user: { id: ME, email: 'owner@ward.test' },
        authUser: { id: ME, email: 'owner@ward.test', profile: { id: ME, full_name: 'صاحب المتجر', role: 'company_admin' } },
        rpc: {
            get_my_company_dashboard: dashboardPayload(),
            current_company_id: COMPANY_ID,
            my_account_type: store ? { account_type: 'ecommerce_store', organization_kind: 'ecommerce_store', relation: 'owner' }
                                   : { account_type: 'company', organization_kind: 'company', relation: 'owner' },
            store_overview: { company_id: COMPANY_ID, my_role: 'admin', shopify_enabled: true, connection,
                              entitlements: { store_support: true, shopify_integration: true, integrations_hub: true },
                              open_tickets: 3, active_conversations: 1, unresolved_requests: 2, overdue_requests: 1, order_linked_open_tickets: 2,
                              recent_activity: [{ request_id: 'q1', action: 'request.created', to_status: 'recorded', kind: 'return', order_ref: '#1001',
                                                  created_at: '2026-10-28T07:00:00Z' }], ...overview },
            ihub_sync_status: { connection, jobs: [{ id: 1, kind: 'initial', status: 'succeeded', pages: 2, records: 40, attempts: 0,
                                                     created_at: '2026-10-28T07:00:00Z', finished_at: '2026-10-28T07:05:00Z' }],
                                events: { last_7_days: { processed: 12, dead: 1 }, recent_failures: [{ topic: 'orders/updated', status: 'dead', attempts: 6,
                                          last_error_code: 'provider_unavailable', received_at: '2026-10-27T00:00:00Z' }], last_received_at: '2026-10-28T09:30:00Z' },
                                compliance_pending: 0 },
            ihub_compliance_list: [],
            store_requests_list: { total: 1, items: [{ id: 'q1', kind: 'refund_inquiry', status: 'recorded', order_ref: XSS, assigned_to: null,
                                                       due_at: '2026-10-27T00:00:00Z', overdue: true, executes_in_shopify: false }] },
            company_staff_list: [{ user_id: '22222222-2222-4222-8222-222222222222', name: 'موظف', role: 'agent' }],
            store_categories: [{ key: 'shipping_delay', label_ar: 'تأخر الشحن', is_active: true, is_default: true, sort_order: 20 }],
            store_report: { days: 30, from: '2026-09-28T00:00:00Z', to: '2026-10-28T00:00:00Z', ticket_volume: 5, first_response_minutes_median: 42,
                            tickets_with_response: 4, resolution_hours_median: 6.5, tickets_resolved: 3, unresolved_tickets: 2, order_related_tickets: 3,
                            categories: { shipping_delay: 2, uncategorized: 3 }, requests_by_kind: { return: 1 }, requests_by_status: { recorded: 1 },
                            integration: { webhook_events: { processed: 12 }, sync_jobs: { succeeded: 2 } }, definitions: {} },
            ihub_prepare_connection: { id: CONN, provider: 'shopify', status: 'pending' },
            ihub_store_record_context: { record_id: 'rec-1', cached: true, tickets: [], requests: [], linked_customer: null, conversations: [] },
            fetch_inbox_summary: null
        },
        functions: {},
        tables: { profiles: [{ id: ME, email: 'owner@ward.test', full_name: 'صاحب المتجر', role: 'company_admin' }], notifications: [], services: [],
                  whatsapp_subscriptions: [], subscription_plans: [] }
    };
}

let browser, server, baseUrl;
const chromiumPath = resolveChromium();
if (!chromiumPath) console.error('SKIP: لا يوجد متصفح Chromium متاح؛ اختبارات عرض المتاجر لم تُنفَّذ');

test.before(async () => {
    if (!chromiumPath) return;
    server = await startServer();
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: chromiumPath });
});
test.after(async () => { await browser?.close(); server?.close(); });

async function open(fx, url, { viewport } = {}) {
    const context = await browser.newContext({ viewport: viewport || { width: 1440, height: 1000 } });
    await context.route('**/error-tracker.js', (r) => r.fulfill({ contentType: 'text/javascript', body: '' }));
    await context.route('**/chat-widget.js', (r) => r.fulfill({ contentType: 'text/javascript', body: 'export default {};' }));
    await context.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: '' }));
    await context.route('https://*.myshopify.com/**', (r) => r.fulfill({ contentType: 'text/html', body: '<p>shopify</p>' }));
    const page = await context.newPage();
    const dbl = fs.readFileSync(path.join(ROOT, 'tests/fixtures/supabase-double.js'), 'utf8');
    const auth = fs.readFileSync(path.join(ROOT, 'tests/fixtures/auth-client-double.js'), 'utf8');
    await page.route('**/api-config.js', (r) => r.fulfill({ contentType: 'text/javascript; charset=utf-8', body: dbl }));
    await page.route('**/auth-client.js', (r) => r.fulfill({ contentType: 'text/javascript; charset=utf-8', body: auth }));
    await page.addInitScript((d) => { window.__FIXTURES__ = d; }, fx);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('dialog', (d) => d.dismiss());
    await page.goto(`${baseUrl}${url}`, { waitUntil: 'networkidle' });
    return { page, context, errors };
}
const called = async (page, name) => (await page.evaluate(() => window.__RPC_ARGS__ || [])).filter(([n]) => n === name).map(([, a]) => a);
const invocations = (page) => page.evaluate(() => (window.__INVOCATIONS__ || []).filter((i) => i.name === 'ihub-api').map((i) => i.body));
const setFunction = (page, spec) => page.evaluate((s) => { window.__FIXTURES__.functions['ihub-api'] = s; }, spec);
const noHorizontalScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

async function openDashboard(fx, hash = '', opts) {
    const r = await open(fx, `/company-dashboard/index.html${hash}`, opts);
    await r.page.waitForSelector('.sidebar-item[data-tab="tickets"]', { timeout: 10000 });
    await r.page.waitForFunction(() => !document.getElementById('companyContent')?.hidden, null, { timeout: 10000 });
    return r;
}

/* ── الاشتراكات ─────────────────────────────────────────────────────────── */

test('بطاقة باقة المتاجر بلا سعر: «قريبًا»، زر معطّل، ولا «0» في السعر — بالشهري والسنوي', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await open(customerFx(), '/subscriptions.html');
    const btn = page.locator('[data-plan-btn="store"]');
    await btn.waitFor();
    assert.equal(await btn.isDisabled(), true);
    assert.equal((await btn.textContent()).trim(), 'قريبًا');
    assert.equal((await page.textContent('.pricing-card[data-plan="store"] .amount')).trim(), '—');
    await page.click('#billingToggle [data-period="yearly"]');
    assert.equal((await page.textContent('.pricing-card[data-plan="store"] .amount')).trim(), '—');
    assert.deepEqual(errors, []);
    await context.close();
});

test('باقة المتاجر مسعّرة ومفعّلة: «اشترك كمتجر» يعرض خيار المتجر وحده، والطلب يحمل النطاق المطبَّع والباقة', { skip: !chromiumPath }, async () => {
    const plans = PLANS.map((p) => (p.key === 'store' ? { ...p, is_active: true, price_monthly: 500, price_yearly: 5000 } : p));
    const { page, context, errors } = await open(customerFx({ plans }), '/subscriptions.html');
    const btn = page.locator('[data-plan-btn="store"]');
    await page.waitForFunction(() => !document.querySelector('[data-plan-btn="store"]').disabled);
    assert.equal((await btn.textContent()).trim(), 'اشترك كمتجر');
    await btn.click();
    const modal = page.locator('[role="dialog"][aria-label="نوع الحساب"]');
    await modal.waitFor();
    assert.deepEqual(await modal.locator('[data-account-type]').evaluateAll((els) => els.map((e) => e.dataset.accountType)), ['ecommerce_store']);
    await modal.locator('[data-account-type="ecommerce_store"]').click();
    const form = page.locator('[role="dialog"][aria-label="بيانات المتجر"]');
    await form.waitFor();
    await form.locator('#cmCompanyName').fill('متجر الورد');
    await form.locator('#cmCrNumber').fill('2020202020');
    await form.locator('#cmCrExpiry').fill('2030-06-30');
    await form.locator('#cmStoreDomain').fill('evil.com');
    await form.locator('#cmSubmit').click();
    assert.match(await form.locator('[data-error-for="cmStoreDomain"]').innerText(), /myshopify/);
    assert.deepEqual(await called(page, 'submit_store_account_request'), []);
    await form.locator('#cmStoreDomain').fill('Ward-Shop');
    await form.locator('#cmSubmit').click();
    await form.locator('[data-company-done]').waitFor({ state: 'visible' });
    assert.match(await form.innerText(), /تم إرسال طلب حساب المتجر/);
    const [args] = await called(page, 'submit_store_account_request');
    assert.equal(args.p_store_domain, 'ward-shop.myshopify.com');
    assert.equal(args.p_requested_plan, 'store');
    assert.deepEqual(await called(page, 'submit_company_account_request'), [], 'not the company path');
    assert.deepEqual(await called(page, 'request_subscription_purchase'), [], 'no payment before the store account exists');
    assert.deepEqual(errors, []);
    await context.close();
});

/* ── لوحة الشركة ────────────────────────────────────────────────────────── */

test('شركة عادية: لا مجموعة متجر في القائمة، ورابط #shopify يعود للنظرة العامة بلا نداءات متجر', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openDashboard(storeFx({ store: false }), '#shopify');
    await page.waitForFunction(() => location.hash === '#overview' || location.hash === '');
    assert.equal(await page.isVisible('.sidebar-group[data-group="store"]'), false);
    assert.equal(await page.isVisible('.sidebar-item[data-tab="storeOverview"]'), false);
    assert.deepEqual(await called(page, 'store_overview'), []);
    assert.deepEqual(errors, []);
    await context.close();
});

test('حساب متجر: مجموعة المتجر ظاهرة، ونظرة المتجر ترسم أرقام القاعدة، والطلبات تذكّر أن لا تنفيذ في Shopify', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openDashboard(storeFx(), '#storeOverview');
    await page.waitForSelector('#storeOverviewBody .kpi');
    assert.equal(await page.isVisible('.sidebar-item[data-tab="shopify"]'), true);
    const text = await page.textContent('#storeOverviewBody');
    assert.match(text, /صلاحيات ناقصة في Shopify/, 'missing scopes surface as health');
    assert.match(text, /طلبات متأخرة/);
    await page.click('.sidebar-item[data-tab="storeRequests"]');
    await page.waitForSelector('#storeRequestsBody table');
    assert.match(await page.textContent('#storeRequestsBody'), /لا يُنفَّذ به شيء في Shopify ولا يُسترد أي مبلغ/);
    assert.match(await page.textContent('#storeRequestsBody'), /متأخر/);
    assert.equal(await page.evaluate(() => window.__XSS__), undefined, 'order_ref is escaped');
    assert.deepEqual(errors, []);
    await context.close();
});

test('صفحة Shopify: الصلاحيات الناقصة تطلب إعادة التفويض للمتجر نفسه؛ الأحداث والمزامنة تُعرض بلا رموز خام', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openDashboard(storeFx(), '#shopify');
    await page.waitForSelector('#storeShopifyBody .ihub-card');
    const body = await page.textContent('#storeShopifyBody');
    assert.match(body, /ناقصة — أعد التفويض/);
    assert.match(body, /قراءة العملاء/);
    assert.equal(await page.getAttribute('#shopifyShopInput', 'readonly'), '', 'reconnect is locked to the same shop');
    assert.equal(await page.inputValue('#shopifyShopInput'), 'ward.myshopify.com');
    assert.match(body, /إعادة الأحداث الفاشلة/);
    assert.doesNotMatch(body, /shpat_|access_token/);
    await page.click('#shopifySync');
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'ihub_sync_request'));
    assert.deepEqual(errors, []);
    await context.close();
});

test('ربط Shopify: النطاق يُفحص قبل أي نداء، والتحويل إلى المتجر نفسه فقط، والبصمة في تبويب البداية', { skip: !chromiumPath }, async () => {
    const fx = storeFx({ connection: null });
    const { page, context, errors } = await openDashboard(fx, '#shopify');
    await page.waitForSelector('#shopifyConnectForm');
    await page.fill('#shopifyShopInput', 'shop.myshopify.com.evil.io');
    await page.click('#shopifyConnectForm button[type="submit"]');
    assert.match(await page.textContent('#shopifyConnectError'), /myshopify/);
    assert.deepEqual(await invocations(page), []);

    // رد يحوّل إلى مضيف آخر: مرفوض بلا تنقّل
    await setFunction(page, { data: { authorize_url: 'https://evil.example/admin/oauth/authorize?state=x', binding: 'b'.repeat(43) } });
    await page.fill('#shopifyShopInput', 'ward');
    await page.click('#shopifyConnectForm button[type="submit"]');
    await page.waitForFunction(() => (window.__INVOCATIONS__ || []).length === 1);
    assert.match(page.url(), /company-dashboard/);
    const [first] = await invocations(page);
    assert.deepEqual([first.action, first.connection_id, first.shop], ['shopify_start', CONN, 'ward.myshopify.com']);

    await setFunction(page, { data: { authorize_url: 'https://ward.myshopify.com/admin/oauth/authorize?client_id=x&state=abc', binding: 'b'.repeat(43) } });
    const nav = page.waitForURL(/ward\.myshopify\.com\/admin\/oauth\/authorize/);
    await page.click('#shopifyConnectForm button[type="submit"]');
    await nav;
    assert.deepEqual(errors, []);
    await context.close();
});

test('البحث في Shopify: نص غير صالح لا يُرسل؛ النتائج والعرض من الخادم ومُهرَّبة؛ طلب متابعة متاح للطلب المخزّن', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openDashboard(storeFx({ connection: { ...CONNECTION, granted_scopes: ['read_orders', 'read_customers', 'read_products'] } }), '#storeOrders');
    await page.waitForSelector('#storeSearchForm');
    await page.fill('#storeSearchText', 'a" OR status:any');
    await page.click('#storeSearchForm button[type="submit"]');
    assert.deepEqual(await invocations(page), []);
    const order = { record_type: 'order', external_id: '1001', display_ref: '#1001', external_url: 'https://admin.shopify.com/store/ward/orders/1001',
                    summary: { financial_status: 'paid', fulfillment_status: 'fulfilled', total: '250.00', currency: 'EGP', customer_name: XSS,
                               items: [{ title: 'قميص', quantity: 2, sku: 'SH-L', unit_price: '125.00' }],
                               fulfillments: [{ status: 'in_transit', tracking: [{ company: 'Aramex', number: 'TRK1', url: 'https://track.example/TRK1' }] }] } };
    await setFunction(page, { data: { items: [order], page: { has_next: false, cursor: null }, restricted: false } });
    await page.fill('#storeSearchText', '1001');
    await page.click('#storeSearchForm button[type="submit"]');
    await page.waitForSelector('[data-open="1001"]');
    await setFunction(page, { data: { record: order } });
    await page.click('[data-open="1001"]');
    await page.waitForSelector('#storeRecDetail, #storeRecHeading');
    const detail = await page.textContent('#storeRecordDetail');
    assert.match(detail, /مدفوع/);
    assert.match(detail, /تم|في الطريق/);
    assert.match(detail, /TRK1/);
    assert.equal(await page.evaluate(() => window.__XSS__), undefined);
    assert.equal(await page.getAttribute('#storeRecordDetail a[href^="https://track.example"]', 'rel'), 'noopener noreferrer');
    assert.equal(await page.isVisible('#storeNewRequest'), true);
    const kinds = (await invocations(page)).map((b) => b.action);
    assert.deepEqual(kinds, ['shopify_search', 'shopify_get']);
    assert.ok(!(await invocations(page)).some((b) => 'company_id' in b), 'no company id from the browser');
    assert.deepEqual(errors, []);
    await context.close();
});

test('صفحات المتجر على الجوال: بلا تمرير أفقي', { skip: !chromiumPath }, async () => {
    for (const hash of ['#storeOverview', '#shopify', '#storeRequests', '#storeReports']) {
        const { page, context, errors } = await openDashboard(storeFx(), hash, { viewport: { width: 390, height: 900 } });
        await page.waitForFunction((h) => document.querySelector(`#${h.slice(1)}TabContent.active`), hash);
        await page.waitForTimeout(150);
        assert.ok(await noHorizontalScroll(page), `${hash} @390: تمرير أفقي`);
        assert.deepEqual(errors, [], hash);
        await context.close();
    }
});
