// ============================================================================
// 120 — «إدارة المتجر» في متصفح حقيقي: الأقسام والأزرار من حالة الإدارة (القاعدة)، النموذج ←
// التأكيد بمعاينة Shopify ← التنفيذ بالرمز نفسه، حالات التحميل والأخطاء، وصدق حالة الدفع.
//
// البيانات من بديل Supabase (tests/fixtures/supabase-double.js، byOp لكل عملية). الحارس الحقيقي في
// tests/sql/shopify-store-management.test.sql و tests/shopify-management.test.mjs.
// ============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';
import * as A from '../supabase/functions/_shared/integrations/shopify-admin.js';

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
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}
function resolveChromium() {
    try { const p = chromium.executablePath(); if (p && fs.existsSync(p)) return p; } catch { /* none */ }
    for (const c of ['/opt/pw-browsers/chromium']) if (fs.existsSync(c)) return c;
    return null;
}

const ME = '11111111-1111-4111-8111-111111111111';
const COMPANY_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CONN = '66666666-6666-4666-8666-666666666666';
const XSS = '<img src=x onerror="window.__XSS__=1">';
const PRODUCT = 'gid://shopify/Product/101';
const TOKEN = 't'.repeat(43);

const CONNECTION = { id: CONN, provider: 'shopify', status: 'active', account_label: 'متجر الورد', base_url: 'https://ward.myshopify.com', min_view_role: 'agent',
                     granted_scopes: ['write_products'], last_sync_status: 'succeeded', created_at: '2026-10-01T00:00:00Z' };

/** حالة الإدارة كما ترجعها القاعدة؛ permitted/missing لكل عملية. */
function manageStatus({ enabled = true, reason = null, permitted = () => true, missing = () => [] } = {}) {
    return { enabled, reason, entitled: enabled, role: 'admin', connection_id: CONN, status: 'active', granted_scopes: [],
             ops: A.OPERATION_KEYS.map((k) => ({ key: k, risk: A.OPERATIONS[k].risk, confirm: A.OPERATIONS[k].confirm, perm: A.OPERATIONS[k].perm,
                                                 permitted: permitted(k), missing_scopes: missing(k) })) };
}

function storeFx({ status = manageStatus(), role = 'admin', byOp = {} } = {}) {
    return {
        user: { id: ME, email: 'owner@ward.test' },
        authUser: { id: ME, email: 'owner@ward.test', profile: { id: ME, full_name: 'صاحب المتجر', role: 'company_admin' } },
        rpc: {
            get_my_company_dashboard: {
                company: { id: COMPANY_ID, name: 'متجر الورد', cr_number: '1010', cr_expiry: '2027-06-01', status: 'active', created_at: '2026-01-01T00:00:00Z', is_owner: role === 'admin' },
                registration: { expiry_date: '2027-06-01', is_expired: false, days_to_expiry: 200 },
                subscriptions: [{ id: 's1', plan: 'store', plan_name_ar: 'باقة المتاجر', status: 'active', billing_cycle: 'monthly', start_date: '2026-10-01T00:00:00Z',
                                  end_date: '2026-12-01T00:00:00Z', is_active: true, days_remaining: 30 }],
                entitlements: [{ feature_key: 'shopify_integration', name_ar: 'تكامل Shopify', granted_by: ['store'] }],
                access: { active_plans: ['store'], has_active_subscription: true }, viewer_role: role
            },
            current_company_id: COMPANY_ID,
            company_staff_role: role,
            my_account_type: { account_type: 'ecommerce_store', organization_kind: 'ecommerce_store', relation: role === 'admin' ? 'owner' : 'member' },
            store_overview: { company_id: COMPANY_ID, my_role: role, shopify_enabled: true, connection: CONNECTION,
                              entitlements: { store_support: true, shopify_integration: true, integrations_hub: true },
                              open_tickets: 0, active_conversations: 0, unresolved_requests: 0, overdue_requests: 0, order_linked_open_tickets: 0, recent_activity: [] },
            ihub_shopify_manage_status: status,
            ihub_shopify_ops_list: [{ id: 'op1', op: 'inventory.adjust', risk: 'write', confirmed: true, status: 'succeeded', error_code: null, resource_ref: 'InventoryItem/301',
                                      detail: { reason: 'damaged', changes: [{ delta: -2 }] }, actor_name: 'صاحب المتجر', created_at: '2026-10-28T09:00:00Z' }],
            fetch_inbox_summary: null
        },
        functions: { 'ihub-api': { byOp } },
        tables: { profiles: [{ id: ME, email: 'owner@ward.test', full_name: 'صاحب المتجر', role: 'company_admin' }], notifications: [], services: [],
                  whatsapp_subscriptions: [], subscription_plans: [] }
    };
}

const PRODUCT_LIST = { data: { op: 'product.list', result: { items: [{ id: PRODUCT, title: XSS, status: 'ACTIVE', total_inventory: 10, variants_count: 1 }], page: { has_next: false } } } };
const PRODUCT_GET = { data: { op: 'product.get', result: { id: PRODUCT, title: 'قميص كتان', status: 'ACTIVE', vendor: 'مدعوم', tags: ['صيفي'], total_inventory: 10,
    collections: [], metafields: [], admin_url: 'https://admin.shopify.com/store/ward/products/101',
    variants: [{ id: 'gid://shopify/ProductVariant/201', title: 'M', sku: 'SH-M', price: '100.00', compare_at_price: null, inventory_quantity: 10 }] } } };

let browser, server, baseUrl;
const chromiumPath = resolveChromium();
if (!chromiumPath) console.error('SKIP: لا يوجد متصفح Chromium متاح؛ اختبارات إدارة المتجر لم تُنفَّذ');

test.before(async () => {
    if (!chromiumPath) return;
    server = await startServer();
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: chromiumPath });
});
test.after(async () => { await browser?.close(); server?.close(); });

async function openManage(fx, { viewport } = {}) {
    const context = await browser.newContext({ viewport: viewport || { width: 1440, height: 1000 } });
    await context.route('**/error-tracker.js', (r) => r.fulfill({ contentType: 'text/javascript', body: '' }));
    await context.route('**/chat-widget.js', (r) => r.fulfill({ contentType: 'text/javascript', body: 'export default {};' }));
    await context.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: '' }));
    const page = await context.newPage();
    await page.route('**/api-config.js', (r) => r.fulfill({ contentType: 'text/javascript; charset=utf-8', body: fs.readFileSync(path.join(ROOT, 'tests/fixtures/supabase-double.js'), 'utf8') }));
    await page.route('**/auth-client.js', (r) => r.fulfill({ contentType: 'text/javascript; charset=utf-8', body: fs.readFileSync(path.join(ROOT, 'tests/fixtures/auth-client-double.js'), 'utf8') }));
    await page.addInitScript((d) => { window.__FIXTURES__ = d; }, fx);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('dialog', (d) => d.dismiss());
    await page.goto(`${baseUrl}/company-dashboard/index.html#storeManage`, { waitUntil: 'networkidle' });
    await page.waitForSelector('#storeManageTabContent.active', { timeout: 10000 });
    return { page, context, errors };
}
const invocations = (page) => page.evaluate(() => (window.__INVOCATIONS__ || []).filter((i) => i.name === 'ihub-api').map((i) => i.body));
const setOp = (page, op, spec) => page.evaluate(([o, s]) => { window.__FIXTURES__.functions['ihub-api'].byOp[o] = s; }, [op, spec]);

test('management not enabled: the reason from the database, no Shopify call, read-only pages unaffected', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openManage(storeFx({ status: manageStatus({ enabled: false, reason: 'management_not_enabled' }) }));
    await page.waitForSelector('#storeManageBody .state-block, #storeManageBody [class*="state"]');
    assert.match(await page.textContent('#storeManageBody'), /غير مفعّلة لهذا الحساب بعد/);
    assert.deepEqual(await invocations(page), []);
    assert.equal(await page.isVisible('.sidebar-item[data-tab="storeOrders"]'), true, 'the read-only search page is still there');
    assert.deepEqual(errors, []);
    await context.close();
});

test('product delete: form → confirmation with Shopify’s current state and an explicit acknowledgement → executed with the same input and the token', { skip: !chromiumPath }, async () => {
    const fx = storeFx({ byOp: { 'product.list': PRODUCT_LIST, 'product.get': PRODUCT_GET,
        'publication.list': { data: { result: { items: [{ id: 'gid://shopify/Publication/701', title: 'Online Store', published: true }] } } },
        'product.delete': { withoutToken: { data: { confirmation_required: true, confirmation_token: TOKEN, expires_in: 300, op: 'product.delete',
                                                    preview: { title: 'قميص كتان', status: 'ACTIVE', variants: 1 } } },
                            withToken: { data: { op: 'product.delete', status: 'succeeded', op_id: 'op-9', result: { deleted_id: PRODUCT } } } } } });
    const { page, context, errors } = await openManage(fx);
    await page.waitForSelector('[data-open-product]');
    assert.equal(await page.evaluate(() => window.__XSS__), undefined, 'Shopify titles are escaped');
    await page.click('[data-open-product]');
    await page.waitForSelector('#smProdTitle');
    assert.match(await page.textContent('#smDetail'), /القنوات: Online Store ✓/);
    await page.click('#smDetail button:has-text("حذف المنتج")');
    const dlg = page.locator('[role="dialog"][data-op="product.delete"]');
    await dlg.waitFor();
    await dlg.locator('#smSubmit').click();
    await dlg.locator('#smConfirm:not([hidden])').waitFor();
    const confirmText = await dlg.locator('#smConfirm').innerText();
    assert.match(confirmText, /نهائيًا/);
    assert.match(confirmText, /قميص كتان/);
    assert.equal(await dlg.locator('#smConfirmBtn').isDisabled(), true, 'destructive: disabled until acknowledged');
    await dlg.locator('#smAck').check();
    await dlg.locator('#smConfirmBtn').click();
    await dlg.waitFor({ state: 'detached' });
    const calls = (await invocations(page)).filter((b) => b.op === 'product.delete');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].confirmation_token, undefined);
    assert.equal(calls[1].confirmation_token, TOKEN);
    assert.deepEqual(calls[0].input, calls[1].input, 'the confirmed input is exactly what is executed');
    assert.deepEqual(calls[1].input, { id: PRODUCT });
    assert.ok(!(await invocations(page)).some((b) => 'company_id' in b || 'store_id' in (b.input || {})), 'no tenant ids from the browser');
    assert.deepEqual(errors, []);
    await context.close();
});

test('role and scopes from the database: forbidden operations are absent; a missing Shopify scope disables the button and says so', { skip: !chromiumPath }, async () => {
    const status = manageStatus({ permitted: (k) => ['shop.info', 'order.list', 'order.get', 'order.update_notes', 'customer.list', 'customer.get'].includes(k),
                                  missing: (k) => (k === 'order.update_notes' ? ['write_orders'] : []) });
    const fx = storeFx({ role: 'agent', status, byOp: {
        'shop.info': { data: { result: { name: 'متجر الورد', domain: 'ward.myshopify.com', currency: 'EGP', development_store: true } } },
        'order.list': { data: { result: { items: [{ id: 'gid://shopify/Order/1001', name: '#1001', financial_status: 'PENDING', fulfillment_status: 'UNFULFILLED',
                                                    total: { amount: '200.00', currency: 'EGP' } }], page: { has_next: false } } } },
        'order.get': { data: { result: { id: 'gid://shopify/Order/1001', name: '#1001', financial_status: 'PAID', fulfillment_status: 'UNFULFILLED',
                                         payment: { financial_status: 'PAID', fully_paid: false, paid_confirmed: false, received: { amount: '50.00', currency: 'EGP' } },
                                         total: { amount: '200.00', currency: 'EGP' }, lines: [] } } } } });
    const { page, context, errors } = await openManage(fx);
    await page.waitForSelector('.sm-nav [data-section]');
    const sections = await page.locator('.sm-nav [data-section]').evaluateAll((els) => els.map((e) => e.dataset.section));
    assert.deepEqual(sections, ['shop', 'orders', 'customers'], 'only what the agent may read');
    assert.match(await page.textContent('#storeManageBody'), /إعادة تفويض التطبيق/);
    await page.click('[data-section="orders"]');
    await page.waitForSelector('[data-open-order]');
    assert.equal(await page.isVisible('button:has-text("طلب جديد")'), false, 'no create button without store.orders_manage');
    await page.click('[data-open-order]');
    await page.waitForSelector('#smOrdTitle');
    const detail = await page.textContent('#smDetail');
    assert.doesNotMatch(detail, /مدفوع \(أكّده Shopify\)/, 'PAID without fullyPaid is not presented as paid');
    assert.match(detail, /دون تأكيد اكتمال الدفع/);
    const notes = page.locator('#smDetail button:has-text("ملاحظات الطلب ووسومه")');
    assert.equal(await notes.isDisabled(), true);
    assert.match(await notes.getAttribute('title'), /write_orders/);
    assert.equal(await page.isVisible('#smDetail button:has-text("إلغاء الطلب")'), false);
    assert.deepEqual(errors, []);
    await context.close();
});

test('order cancel refused by the server (paid order): the dialog explains why; nothing executed', { skip: !chromiumPath }, async () => {
    const fx = storeFx({ byOp: {
        'product.list': PRODUCT_LIST,
        'order.list': { data: { result: { items: [{ id: 'gid://shopify/Order/1001', name: '#1001', financial_status: 'PAID', fully_paid: true, fulfillment_status: 'UNFULFILLED',
                                                    total: { amount: '200.00', currency: 'EGP' } }], page: { has_next: false } } } },
        'order.get': { data: { result: { id: 'gid://shopify/Order/1001', name: '#1001', financial_status: 'PAID', payment: { financial_status: 'PAID', fully_paid: true, paid_confirmed: true },
                                         total: { amount: '200.00', currency: 'EGP' }, lines: [] } } },
        'fulfillment_order.list': { data: { result: { fulfillment_orders: [], fulfillments: [] } } },
        'return.list': { data: { result: { items: [] } } }, 'returnable.list': { data: { result: { items: [] } } },
        'order.cancel': { withoutToken: { status: 409, body: { error: 'not_eligible', reason: 'cancel_requires_refund_review' } } } } });
    const { page, context, errors } = await openManage(fx);
    await page.click('[data-section="orders"]');
    await page.waitForSelector('[data-open-order]');
    assert.match(await page.textContent('#smList'), /مدفوع \(أكّده Shopify\)/, 'confirmed paid is labelled as confirmed by Shopify');
    await page.click('[data-open-order]');
    await page.waitForSelector('#smOrdTitle');
    await page.click('#smDetail button:has-text("إلغاء الطلب")');
    const dlg = page.locator('[role="dialog"][data-op="order.cancel"]');
    await dlg.waitFor();
    assert.match(await dlg.innerText(), /دون أي استرداد/);
    await dlg.locator('#smSubmit').click();
    await dlg.locator('#smFormError:not([hidden])').waitFor();
    assert.match(await dlg.locator('#smFormError').innerText(), /لا يرد المال/);
    const calls = (await invocations(page)).filter((b) => b.op === 'order.cancel');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].input.notify_customer, false, 'no customer message unless ticked');
    assert.deepEqual(errors, []);
    await context.close();
});

test('inventory: client-side required fields block sending; a server field error lands on its input; busy state while sending', { skip: !chromiumPath }, async () => {
    const fx = storeFx({ byOp: {
        'product.list': PRODUCT_LIST,
        'location.list': { data: { result: { items: [{ id: 'gid://shopify/Location/401', name: 'المخزن الرئيسي', active: true }] } } },
        'inventory.levels': { data: { result: { variant_id: 'gid://shopify/ProductVariant/201', title: 'M', product_title: 'قميص', inventory_item_id: 'gid://shopify/InventoryItem/301',
            tracked: true, levels: [{ location_id: 'gid://shopify/Location/401', location_name: 'المخزن الرئيسي', active: true, quantities: { available: 10, on_hand: 11 } }] } } },
        'inventory.adjust': { withoutToken: { status: 400, body: { error: 'invalid_input', field: 'changes.0.delta' } } } } });
    const { page, context, errors } = await openManage(fx);
    await page.click('[data-section="inventory"]');
    await page.fill('#smInvVariant', '201');
    await page.click('#smInvForm button[type="submit"]');
    await page.waitForSelector('#smLevelsBox button:has-text("+/−")');
    await page.click('#smLevelsBox button:has-text("+/−")');
    const dlg = page.locator('[role="dialog"][data-op="inventory.adjust"]');
    await dlg.waitFor();
    assert.equal(await dlg.locator('#smf_expected_quantity').inputValue(), '10', 'prefilled with what Shopify returned');
    await dlg.locator('#smf_expected_quantity').fill('');
    const before = (await invocations(page)).length;
    await dlg.locator('#smSubmit').click();
    assert.equal(await dlg.locator('[data-error-for="delta"]').innerText(), 'مطلوب');
    assert.equal(await dlg.locator('[data-error-for="expected_quantity"]').innerText(), 'مطلوب');
    assert.equal((await invocations(page)).length, before, 'nothing sent');
    await dlg.locator('#smf_delta').fill('5');
    await dlg.locator('#smf_expected_quantity').fill('10');
    await dlg.locator('#smSubmit').click();
    await dlg.locator('[data-error-for="delta"]:not([hidden])').waitFor();
    assert.match(await dlg.locator('[data-error-for="delta"]').innerText(), /قيمة غير صالحة: الفرق/);
    const sent = (await invocations(page)).filter((b) => b.op === 'inventory.adjust');
    assert.deepEqual(sent[0].input.changes[0], { inventory_item_id: 'gid://shopify/InventoryItem/301', location_id: 'gid://shopify/Location/401', delta: 5, expected_quantity: 10 });
    assert.equal(await dlg.locator('#smSubmit').getAttribute('aria-busy'), 'false');
    assert.deepEqual(errors, []);
    await context.close();
});

test('operations log (store admin) and mobile layout without horizontal scroll', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openManage(storeFx({ byOp: { 'product.list': PRODUCT_LIST } }), { viewport: { width: 390, height: 900 } });
    await page.waitForSelector('[data-section="log"]');
    await page.click('[data-section="log"]');
    await page.waitForSelector('#smSection table');
    const text = await page.textContent('#smSection');
    assert.match(text, /تعديل الكمية/);
    assert.match(text, /نُفّذت/);
    assert.match(text, /تالف/);
    await page.waitForTimeout(150);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no horizontal scroll at 390px');
    assert.deepEqual(errors, []);
    await context.close();
});
