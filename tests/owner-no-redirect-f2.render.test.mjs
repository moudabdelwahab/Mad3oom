/**
 * مجموعة F2 من إزالة تحويلات المالك (owner-no-redirect): حالة النظام، قائمة
 * الانتظار، تفاصيل الاشتراك، شارة فاتورة Pi، معاينة المتجر — تشغيل حقيقي في
 * Chromium مقابل البديل الاختباري، بنفس حزام tests/owner-pages.render.test.mjs.
 *
 * يثبت:
 *   ① لا روابط من كود المالك المعدَّل هنا إلى /admin/ أو /company-dashboard/
 *      (باستثناءات موثّقة خارج نطاق F2: زر «مساحة عمل الدعم» في تفاصيل
 *      التذكرة، ورابط طلبات الشركات في المتاجر، ورابط إعدادات التشغيل اليومي)
 *   ② صفحة الحالة تقرأ من owner_service_status() وتكتب عبر owner_set_service_status()
 *      وحدها، وتظهر «غير متاح بعد» قبل الترحيل 147
 *   ③ قائمة الانتظار في الإعدادات: قراءة ورفض عبر الجدول، وموافقة عبر دالة الحافة
 *   ④ صفحة تفاصيل الاشتراك تعيد استخدام subscription-details-view.js بلا روابط إدارة
 *   ⑤ شارة Pi تفتح تذكرة المالك، وتفاصيل التذكرة تعرض شريحة الفاتورة
 *   ⑥ معاينة المتجر قراءة فقط من owner_company_store_overview()، و«غير متاح بعد» قبل 147
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = path.resolve(import.meta.dirname, '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
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
            for (const rel of ['chrome-linux/chrome', 'chrome-linux/headless_shell', 'chrome']) {
                const c = path.join(root, dir, rel);
                if (fs.existsSync(c)) return c;
            }
        }
    }
    return null;
}

const OWNER = '11111111-1111-4111-8111-111111111111';
const CUSTOMER = '66666666-6666-4666-8666-666666666666';
const XSS = '<img src=x onerror="window.__XSS__=1">';

function fixtures(overrides = {}) {
    const future = new Date(Date.now() + 20 * 864e5).toISOString();
    const fx = {
        returnUpdatedRows: true,
        user: { id: OWNER, email: 'owner@example.com' },
        authUser: { id: OWNER, email: 'owner@example.com', profile: { id: OWNER, full_name: 'مالك المنصة', role: 'platform_owner', ban_status: 'none' } },
        rpc: {
            owner_context_status: { is_platform_owner: true, active_context: 'owner', preview_mode: false, expires_at: '2099-01-01T00:00:00Z' },
            available_contexts: [{ key: 'owner', granted: true, destination: '/owner-dashboard.html' }],
            owner_security_status: { mfa_enrolled: true, step_up_fresh: false, step_up_expires_at: null, in_owner_context: true },
            get_public_registration_settings: { mode: 'waitlist', expected_launch_date: '2026-12-01' },
            owner_feature_switches: [],
            // A1: حالة الخدمات (147)
            owner_service_status: {
                services: [
                    { id: 'svc-1', name: 'خدمة الدعم', description: 'وصف الخدمة', status: 'operational', response_time: 120, status_changed_at: '2026-10-20T00:00:00Z' },
                    { id: 'svc-2', name: 'خدمة واتساب', description: 'وصف', status: 'degraded', response_time: 900, status_changed_at: '2026-10-26T00:00:00Z' }
                ],
                incidents: [
                    { id: 'inc-1', title: 'بطء واتساب', description: 'تفاصيل الحادث', status: 'investigating', created_at: '2026-10-26T00:00:00Z' }
                ],
                report_summary: [
                    { service_name: 'خدمة واتساب', report_count: 2, first_reported: '2026-10-26T08:00:00Z', last_reported: '2026-10-26T09:00:00Z',
                      reporters: [{ name: 'عميل أ', reported_at: '2026-10-26T08:00:00Z' }, { name: 'عميل ب', reported_at: '2026-10-26T09:00:00Z' }] }
                ]
            },
            owner_set_service_status: { ok: true },
            // A5: تفاصيل الاشتراك
            admin_list_subscriptions: [
                { id: 's-active', user_id: CUSTOMER, customer_name: 'عميل أ', customer_email: 'a@x.test', company_name: 'شركة أ', plan: 'support',
                  plan_name_ar: 'الدعم', status: 'active', billing_cycle: 'monthly', end_date: future, is_active: true, days_remaining: 5,
                  effective_features: ['support_tickets'] }
            ],
            admin_subscription_audit: [{ action: 'deactivate', actor_email: 'admin@example.com', old_values: { status: 'active' },
                                         new_values: { status: 'expired' }, reason: XSS, created_at: '2026-10-01T00:00:00Z' }],
            admin_set_subscription_status: { subscription_id: 's-active' },
            admin_update_subscription: { subscription_id: 's-active' },
            plan_feature_keys: ['support_tickets', 'whatsapp'],
            // A7: شريحة الفاتورة
            ticket_invoice_status: { state: 'attached', invoice_number: 'INV-42', total: 500, currency: 'EGP' },
            // A8: معاينة المتجر (147)
            owner_accounts_overview: { total: 1, counts: { company: 1 }, items: [
                { user_id: CUSTOMER, name: 'مالك المتجر', email: 'shop@x.test', created_at: '2026-01-01T00:00:00Z', account_type: 'ecommerce_store',
                  company_id: 'c9', company_name: 'متجر الورد', company_status: 'active', subscription: null, shopify: null }] },
            owner_company_store_overview: {
                company_id: 'c9', my_role: 'owner',
                entitlements: { store_support: true, shopify_integration: true, integrations_hub: false },
                connection: { id: 'cn1', provider: 'shopify', status: 'active', account_label: 'متجر الورد', base_url: 'https://ward.myshopify.com', last_error_code: null },
                shopify_enabled: true, open_tickets: 2, active_conversations: 1, unresolved_requests: 3, overdue_requests: 1,
                order_linked_open_tickets: 1,
                recent_activity: [{ request_id: 'rq1', action: 'created', to_status: 'pending', kind: 'order', order_ref: 'ORD-1', created_at: '2026-10-26T00:00:00Z' }]
            },
            // أقسام المتاجر الأخرى في الصفحة (حتى تُرسم قبل المعاينة)
            owner_store_alerts: { count: 0, critical: 0, alerts: [] },
            owner_store_requests: [],
            owner_store_integrations: { provider: { enabled: false }, required_scopes: [], compliance_unmatched_30d: 0, connections: [] },
            owner_entitlement_diagnostics: { store_plan: { key: 'store', is_active: false, price_monthly: null, price_yearly: null, currency: 'EGP', features: [], ticket_quota_defined: false },
                live_connection_without_entitlement: [], stores_without_subscription: 0, store_plan_on_non_store: 0, pending_store_requests: 0 },
            owner_store_events: { jobs: [], events: [], audit: [] },
            owner_store_test_status: { company_id: 'cw', company_name: 'شركة المالك', account_kind: 'company', has_company: true, is_test_store: false, entitlements: [] },
            owner_store_operations_log: []
        },
        functions: {
            'approve-waitlist-entry': { data: { user_id: 'u-new', email: 'w@x.test', temp_password: 'Temp1234!' } }
        },
        tables: {
            profiles: [
                { id: OWNER, email: 'owner@example.com', full_name: 'مالك المنصة', role: 'platform_owner', ban_status: 'none', created_at: '2026-01-01T00:00:00Z' },
                { id: CUSTOMER, email: 'customer@example.com', full_name: 'عميل أ', role: 'user', ban_status: 'none', created_at: '2026-04-01T00:00:00Z' }
            ],
            services: [],
            incidents: [],
            waitlist_entries: [
                { id: 'w1', name: 'منتظر أ', email: 'w@x.test', phone: '01000000001', source: 'form', status: 'pending', created_at: '2026-10-25T00:00:00Z', reviewed_at: null, reviewed_by: null, approved_user_id: null },
                { id: 'w2', name: 'منتظر ب', email: 'w2@x.test', phone: null, source: 'google', status: 'approved', created_at: '2026-10-24T00:00:00Z', reviewed_at: '2026-10-24T01:00:00Z', reviewed_by: OWNER, approved_user_id: 'u-old' }
            ],
            tickets: [
                { id: 't1', ticket_number: 101, title: 'مشكلة في الدفع', status: 'open', priority: 'high', scope: 'mad3oom_support', user_id: CUSTOMER,
                  assigned_to: null, created_at: '2026-10-20T10:00:00Z', description: 'وصف التذكرة', sla_resolution_due_at: '2026-10-21T10:00:00Z' }
            ],
            ticket_replies: [
                { id: 'r1', ticket_id: 't1', user_id: CUSTOMER, message: XSS, created_at: '2026-10-20T11:00:00Z', is_internal: false }
            ],
            activity_logs: [],
            notifications: [],
            owner_context_audit: []
        }
    };
    return { ...fx, ...overrides };
}

async function openPage(browser, baseUrl, file, fx, { width = 1440, query = '' } = {}) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    const page = await context.newPage();
    const dbl = fs.readFileSync(path.join(ROOT, 'tests/fixtures/supabase-double.js'), 'utf8');
    const auth = fs.readFileSync(path.join(ROOT, 'tests/fixtures/auth-client-double.js'), 'utf8');
    await page.route('**/api-config.js', r => r.fulfill({ contentType: 'text/javascript', body: dbl }));
    await page.route('**/auth-client.js', r => r.fulfill({ contentType: 'text/javascript', body: auth }));
    await page.route('**/error-tracker.js', r => r.fulfill({ contentType: 'text/javascript', body: '' }));
    await page.route('https://fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
    await page.addInitScript(d => { window.__FIXTURES__ = d; }, fx);
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${baseUrl}/owner/${file}.html${query}`, { waitUntil: 'networkidle' });
    return { page, context, errors };
}
const rpcCalls = (page, name) => page.evaluate(n => (window.__RPC_ARGS__ || []).filter(([x]) => x === n).map(([, a]) => a), name);
const writes = (page, table) => page.evaluate(t => (window.__WRITES__ || []).filter(w => w.table === t), table);
const invocations = (page, name) => page.evaluate(n => (window.__INVOCATIONS__ || []).filter(i => i.name === n), name);
const noHorizontalScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

const chromiumPath = resolveChromium();
let server, baseUrl, browser;
test.before(async () => {
    if (!chromiumPath) return;
    server = await startServer();
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: chromiumPath });
});
test.after(async () => { await browser?.close(); server?.close(); });

/* ── لا تحويلات خارج لوحة المالك في ملفات F2 ─────────────────────────── */

test('F2 ثابت: كود المالك المعدَّل لا يربط إلى /admin/ أو /company-dashboard/ (باستثناءات موثّقة)', () => {
    const files = [
        'assets/components/owner-sidebar.html',
        'assets/js/owner/pages/status.js', 'assets/js/owner/pages/settings.js',
        'assets/js/owner/pages/subscriptions.js', 'assets/js/owner/pages/subscription-details.js',
        'assets/js/owner/pi-integration.js', 'assets/js/owner/pages/tickets.js',
        'assets/js/owner/pages/stores.js',
        'owner/status.html', 'owner/settings.html', 'owner/subscriptions.html',
        'owner/subscription-details.html', 'owner/stores.html'
    ];
    // يُفحص الروابط لا التعليقات (التعليقات تذكر مصدر الإدارة توثيقًا).
    // الاستثناءات خارج نطاق F2، لمجموعة أخرى: زر «مساحة عمل الدعم» في تفاصيل
    // التذكرة (المرفقات والقوالب لم تُبنَ مالكًا بعد)، ورابط طلبات الشركات
    // العادية في المتاجر (JS + HTML)، ورابط إعدادات التشغيل اليومي في الإعدادات،
    // وعنصر «المستخدمون» في القائمة (data-tab يفتح القسم داخل اللوحة، والرابط
    // احتياط — نفس استثناء اختبار القائمة في owner-pages.render.test.mjs).
    const allowed = [
        'href="/admin/tickets.html?ticket_id=${esc(t.id)}"',
        'href="/admin/company-requests.html"',
        'href="/admin/settings.html"',
        'href="/admin/users.html"'
    ];
    for (const f of files) {
        const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
        const links = [...src.matchAll(/href="([^"]+)"/g)].map(m => m[1]);
        for (const href of links) {
            if (allowed.some(a => a.includes(href))) continue;
            assert.ok(!href.startsWith('/admin/'), `${f} يربط إلى ${href}`);
            assert.ok(!href.startsWith('/company-dashboard/'), `${f} يربط إلى ${href}`);
        }
    }
    // الوجهات الجديدة كما في العقد
    assert.match(fs.readFileSync(path.join(ROOT, 'assets/components/owner-sidebar.html'), 'utf8'), /href="\/owner\/status\.html"/);
    assert.match(fs.readFileSync(path.join(ROOT, 'assets/js/owner/pi-integration.js'), 'utf8'), /href="\/owner\/tickets\.html\?ticket=/);
    assert.match(fs.readFileSync(path.join(ROOT, 'assets/js/owner/pages/settings.js'), 'utf8'), /href="#waitlist"/);
    assert.match(fs.readFileSync(path.join(ROOT, 'assets/js/owner/pages/subscriptions.js'), 'utf8'), /href="\/owner\/subscription-details\.html\?id=/);
});

/* ── A1: حالة الخدمات ─────────────────────────────────────────────────── */

test('A1: صفحة الحالة تقرأ من owner_service_status() وتعرض الخدمات والبلاغات والحوادث', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openPage(browser, baseUrl, 'status', fixtures());
    await page.waitForSelector('#servicesList .service-status-card');
    const text = await page.textContent('#ownerContent');
    assert.match(text, /خدمة الدعم/);
    assert.match(text, /خدمة واتساب/);
    assert.match(text, /أداء منخفض/);
    assert.match(text, /بطء واتساب/);
    assert.match(text, /٢ عميل متأثر|2 عميل متأثر/);
    assert.match(text, /عميل أ/);
    assert.match(await page.textContent('#globalTitle'), /متأثر|مثالي/);
    assert.deepEqual(await rpcCalls(page, 'owner_service_status'), [null]);
    assert.deepEqual(await rpcCalls(page, 'get_service_report_summary'), []);
    assert.equal(await noHorizontalScroll(page), true);
    assert.deepEqual(errors, []);
    await context.close();
});

test('A1: تغيير حالة خدمة ينادي owner_set_service_status() بالمعرّف والحالة', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openPage(browser, baseUrl, 'status', fixtures());
    await page.waitForSelector('#servicesList .service-status-card');
    await page.selectOption('#svc-svc-2', 'down');
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'owner_set_service_status'));
    assert.deepEqual(await rpcCalls(page, 'owner_set_service_status'), [{ p_service: 'svc-2', p_status: 'down' }]);
    assert.deepEqual(errors, []);
    await context.close();
});

test('A1: قبل الترحيل 147 تظهر «غير متاح بعد» بدل تفريغ خطأ', { skip: !chromiumPath }, async () => {
    const fx = fixtures();
    fx.rpcErrors = { owner_service_status: { code: 'PGRST202', message: 'Could not find the function public.owner_service_status in the schema cache' } };
    const { page, context, errors } = await openPage(browser, baseUrl, 'status', fx);
    await page.waitForSelector('#servicesList .state-block');
    assert.match(await page.textContent('#servicesList'), /غير متاحة بعد/);
    assert.deepEqual(errors, []);
    await context.close();
});

/* ── A4: قائمة الانتظار ───────────────────────────────────────────────── */

test('A4: قائمة الانتظار في الإعدادات تعرض الطلبات مع المصدر والحالة', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openPage(browser, baseUrl, 'settings', fixtures());
    await page.waitForSelector('#waitlistTable table');
    const text = await page.textContent('#settingsWaitlist');
    assert.match(text, /منتظر أ/);
    assert.match(text, /نموذج قائمة الانتظار/);
    assert.match(text, /قيد المراجعة/);
    assert.match(text, /حساب Google/);
    assert.match(await page.getAttribute('a[href="#waitlist"]', 'href'), /#waitlist/);
    assert.deepEqual(errors, []);
    await context.close();
});

test('A4: رفض طلب يكتب status=rejected مع المراجع والتاريخ، والموافقة تنادي دالة الحافة', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openPage(browser, baseUrl, 'settings', fixtures());
    await page.waitForSelector('#waitlistTable table');
    // رفض الطلب الأول
    await page.click('[data-waitlist-entry="w1"]');
    await page.waitForSelector('#waitlistReject');
    await page.click('#waitlistReject');
    await page.waitForFunction(() => (window.__WRITES__ || []).some(w => w.table === 'waitlist_entries' && w.row.status === 'rejected'));
    const [reject] = await writes(page, 'waitlist_entries');
    assert.equal(reject.row.status, 'rejected');
    assert.equal(reject.row.reviewed_by, OWNER);
    assert.ok(reject.row.reviewed_at);
    // موافقة على نفس الطلب: دالة الحافة + كلمة مرور مؤقتة تُعرض مرة واحدة
    await page.click('[data-waitlist-entry="w1"]');
    await page.waitForSelector('#waitlistApprove');
    await page.click('#waitlistApprove');
    await page.waitForFunction(() => (window.__INVOCATIONS__ || []).some(i => i.name === 'approve-waitlist-entry'));
    assert.deepEqual(await invocations(page, 'approve-waitlist-entry'), [{ name: 'approve-waitlist-entry', body: { entry_id: 'w1' } }]);
    await page.waitForSelector('#waitlistCredPassword');
    assert.equal(await page.textContent('#waitlistCredPassword'), 'Temp1234!');
    assert.deepEqual(errors, []);
    await context.close();
});

/* ── A5: تفاصيل الاشتراك ─────────────────────────────────────────────── */

test('A5: صفحة تفاصيل الاشتراك تعرض العميل والباقة وسجل التغييرات بلا روابط إدارة', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openPage(browser, baseUrl, 'subscription-details', fixtures(), { query: '?id=s-active' });
    await page.waitForSelector('#root .subd-facts');
    const text = await page.textContent('#ownerContent');
    assert.match(text, /عميل أ/);
    assert.match(text, /الدعم/);
    assert.match(text, /تعطيل/);
    assert.match(text, /حفظ التعديل/);
    assert.match(text, /تعطيل الاشتراك/);
    assert.equal(await page.locator('#ownerContent a[href^="/admin/"]').count(), 0);
    assert.deepEqual(await rpcCalls(page, 'admin_list_subscriptions'), [null]);
    assert.deepEqual(await rpcCalls(page, 'admin_subscription_audit'), [{ p_subscription_id: 's-active' }]);
    assert.equal(await noHorizontalScroll(page), true);
    assert.deepEqual(errors, []);
    await context.close();
});

test('A5: زر «تفاصيل» في قائمة الاشتراكات يقود لصفحة المالك', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openPage(browser, baseUrl, 'subscriptions', fixtures());
    await page.waitForSelector('#subsTable table');
    assert.equal(await page.getAttribute('#subsTable a[href="/owner/subscription-details.html?id=s-active"]', 'href'),
        '/owner/subscription-details.html?id=s-active');
    assert.equal(await page.locator('#subsTable a[href^="/admin/"]').count(), 0);
    assert.deepEqual(errors, []);
    await context.close();
});

/* ── A7: شارة Pi + شريحة الفاتورة ────────────────────────────────────── */

test('A7: رابط ?ticket= يفتح التذكرة في لوحة المالك مع شريحة «فاتورة مرفقة»', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openPage(browser, baseUrl, 'tickets', fixtures(), { query: '?ticket=t1' });
    await page.waitForSelector('.owner-modal-body .owner-detail-grid');
    assert.match(await page.textContent('#ownerModalTitle'), /#101 — مشكلة في الدفع/);
    const text = await page.textContent('.owner-modal-body');
    assert.match(text, /فاتورة مرفقة/);
    assert.match(text, /INV-42/);
    assert.deepEqual(await rpcCalls(page, 'ticket_invoice_status'), [{ p_ticket_id: 't1' }]);
    assert.deepEqual(errors, []);
    await context.close();
});

/* ── A8: معاينة المتجر ───────────────────────────────────────────────── */

test('A8: معاينة المتجر تقرأ من owner_company_store_overview() وتعرض الأرقام والربط', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openPage(browser, baseUrl, 'stores', fixtures());
    // <option> لا يُرى أبدًا عند Playwright — الانتظار على وجوده لا على ظهوره.
    await page.waitForFunction(() => document.querySelector('#storePreviewCompany option[value="c9"]'));
    await page.selectOption('#storePreviewCompany', 'c9');
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'owner_company_store_overview'));
    assert.deepEqual(await rpcCalls(page, 'owner_company_store_overview'), [{ p_company: 'c9' }]);
    await page.waitForSelector('#storePreview .kpi-grid');
    const text = await page.textContent('#storePreview');
    assert.match(text, /متجر الورد/);
    assert.match(text, /متصل/);
    assert.match(text, /ORD-1/);
    assert.match(text, /دعم المتاجر/);
    assert.deepEqual(await rpcCalls(page, 'store_overview'), []);
    assert.equal(await noHorizontalScroll(page), true);
    assert.deepEqual(errors, []);
    await context.close();
});

test('A8: زر «معاينة المتجر» بجانب الحساب يملأ القائمة ويعرض المعاينة', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openPage(browser, baseUrl, 'stores', fixtures());
    await page.waitForSelector('[data-preview-store="c9"]');
    await page.click('[data-preview-store="c9"]');
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'owner_company_store_overview'));
    assert.equal(await page.inputValue('#storePreviewCompany'), 'c9');
    await page.waitForSelector('#storePreview .kpi-grid');
    assert.deepEqual(errors, []);
    await context.close();
});

test('A8: قبل الترحيل 147 تظهر «غير متاح بعد» بدل تفريغ خطأ', { skip: !chromiumPath }, async () => {
    const fx = fixtures();
    fx.rpcErrors = { owner_company_store_overview: { code: 'PGRST202', message: 'Could not find the function public.owner_company_store_overview in the schema cache' } };
    const { page, context, errors } = await openPage(browser, baseUrl, 'stores', fx);
    await page.waitForFunction(() => document.querySelector('#storePreviewCompany option[value="c9"]'));
    await page.selectOption('#storePreviewCompany', 'c9');
    await page.waitForSelector('#storePreview .state-block');
    assert.match(await page.textContent('#storePreview'), /غير متاحة بعد/);
    assert.deepEqual(errors, []);
    await context.close();
});
