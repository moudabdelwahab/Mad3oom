/**
 * صفحة «المستخدمين» الموحّدة (admin/users.html) في متصفح حقيقي على بديل Supabase.
 *
 * يتأكد من:
 *   - كل دور يرى تبويبات روابطه القديمة فقط (Super User: «مستخدميني» وحده).
 *   - البحث والفلاتر تعمل، والنصوص غير الموثوقة تُعرض نصًا حرفيًا.
 *   - قائمة «خيارات» تحمل الإجراءات، والحظر يكتب نفس ما كانت تكتبه الصفحة.
 *   - «المحظورون» قائمة مُفلترة من نفس الصفحة، والتبويب المستضاف يُحمَّل في
 *     وضع التضمين بلا قائمة جانبية مكررة.
 *   - لا تمرير أفقي على الجوال.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = path.resolve(import.meta.dirname, '..');
const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon'
};

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
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function resolveChromium() {
    try {
        const p = chromium.executablePath();
        if (p && fs.existsSync(p)) return p;
    } catch { /* لا تنزيل افتراضي */ }
    const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
    if (root && fs.existsSync(root)) {
        for (const dir of fs.readdirSync(root).filter(d => d.startsWith('chromium')).sort().reverse()) {
            for (const rel of ['chrome-linux/chrome', 'chrome-linux/headless_shell', 'chrome']) {
                const candidate = path.join(root, dir, rel);
                if (fs.existsSync(candidate)) return candidate;
            }
        }
    }
    return null;
}

const ME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PEOPLE = [
    { id: ME, full_name: 'محمود', email: 'admin@test.local', role: 'admin', status: 'active', points: 120, phone: '966562633284', created_at: '2026-01-02T00:00:00Z' },
    { id: 'u2', full_name: 'تركي', email: 'turki@gmail.com', role: 'user', status: 'active', points: 40, phone: '966555438816', created_at: '2026-03-02T00:00:00Z' },
    { id: 'u3', full_name: 'Bank', email: 'bank@gmail.com', role: 'super_user', status: 'active', points: 900, created_at: '2026-04-02T00:00:00Z' },
    { id: 'u4', full_name: '<img src=x onerror="window.__XSS__=1">سارة', email: 'sara@example.com', role: 'user', status: 'banned', points: 0, created_at: '2026-05-10T00:00:00Z' }
];

function fixtures(role, rpc = {}) {
    return {
        user: { id: ME, email: 'admin@test.local' },
        authUser: { id: ME, email: 'admin@test.local', profile: { ...PEOPLE[0], role } },
        tables: {
            profiles: PEOPLE.map(p => (p.id === ME ? { ...p, role } : p)),
            user_wallets: [{ user_id: 'u2', is_frozen: true }],
            notifications: [], tickets: []
        },
        rpc: {
            has_elevated_authority: false, is_platform_owner: false, active_context: null,
            my_account_gate: { status: 'active' }, is_sie_admin: false,
            admin_customer_filter_options: { companies: [], managers: [] },
            admin_customer_directory: { total: 0, rows: [] },
            ...rpc
        }
    };
}

let browser, server, baseUrl;
const chromiumPath = resolveChromium();
if (!chromiumPath) console.error('SKIP: لا يوجد متصفح Chromium متاح؛ اختبارات صفحة المستخدمين لم تُنفَّذ');

test.before(async () => {
    if (!chromiumPath) return;
    server = await startServer();
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: chromiumPath });
});
test.after(async () => { await browser?.close(); server?.close(); });

/**
 * guardStub: admin/users.html محروسة بـ guardPage('admin'). البديل يتخطى الحارس
 * فقط ليصل Super User إلى الصفحة؛ صلاحيات التبويبات (getAdminAccess) تعمل كما هي.
 */
async function openHub(fx, { width = 1440, hash = '', guardStub = false } = {}) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.route('**/error-tracker.js', r => r.fulfill({ contentType: 'text/javascript', body: '' }));
    const page = await context.newPage();
    const doubleSupabase = fs.readFileSync(path.join(ROOT, 'tests/fixtures/supabase-double.js'), 'utf8');
    const doubleAuth = fs.readFileSync(path.join(ROOT, 'tests/fixtures/auth-client-double.js'), 'utf8');
    await page.route('**/api-config.js', r => r.fulfill({ contentType: 'text/javascript; charset=utf-8', body: doubleSupabase }));
    await page.route('**/auth-client.js', r => r.fulfill({ contentType: 'text/javascript; charset=utf-8', body: doubleAuth }));
    await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, r => r.abort());
    if (guardStub) {
        await page.route('**/assets/js/page-guard.js', r => r.fulfill({
            contentType: 'text/javascript',
            body: "export async function guardPage() { const m = await import('/auth-client.js'); return m.getCurrentUser(); }"
        }));
    }
    await page.addInitScript(data => { window.__FIXTURES__ = data; }, fx);
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${baseUrl}/admin/users.html${hash}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.uh-tab');
    return { page, context, errors };
}

const tabIds = (page) => page.$$eval('.uh-tab', els => els.map(e => e.dataset.tab));
const rowNames = (page) => page.$$eval('#usersBody tr', rows => rows.map(r => r.children[0]?.textContent));

test('الأدمن الرئيسي: كل القوائم تبويبات في صفحة واحدة، و«كل المستخدمين» أولها', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openHub(fixtures('admin', { has_elevated_authority: true }));
    assert.deepEqual(await tabIds(page),
        ['all', 'customers', 'superUsers', 'myUsers', 'banned', 'accountRequests', 'companyRequests', 'waitlist']);
    assert.equal(await page.getAttribute('#uhTab-all', 'aria-selected'), 'true');
    await page.waitForSelector('#usersBody .uh-options-btn');
    assert.equal((await rowNames(page)).length, 4);
    assert.deepEqual(errors, []);
    await context.close();
});

test('الأدوار: الدعم بلا عملاء ولا طلبات، وSuper User يرى «مستخدميني» وحده', { skip: !chromiumPath }, async () => {
    const support = await openHub(fixtures('support'));
    assert.deepEqual(await tabIds(support.page), ['all', 'banned']);
    await support.context.close();

    const su = await openHub(fixtures('super_user'), { guardStub: true });
    assert.deepEqual(await tabIds(su.page), ['myUsers']);
    assert.equal(await su.page.locator('#uhListPanel').isVisible(), false, 'قائمة المنصة لا تُعرض لـ Super User');
    assert.ok(await su.page.locator('#usersLink').isVisible(), 'رابط «المستخدمين» ظاهر لأن له تبويبًا');
    await su.context.close();

    // تبويب غير متاح في الرابط المباشر يعود لأول تبويب
    const admin = await openHub(fixtures('admin'), { hash: '#superUsers' });
    assert.equal(await admin.page.getAttribute('#uhTab-all', 'aria-selected'), 'true');
    assert.equal(await admin.page.locator('#uhTab-superUsers').count(), 0);
    await admin.context.close();
});

test('البحث والفلاتر، والنص غير الموثوق يُعرض حرفيًا', { skip: !chromiumPath }, async () => {
    const { page, context } = await openHub(fixtures('admin', { has_elevated_authority: true }));
    await page.waitForSelector('#usersBody .uh-options-btn');

    await page.fill('#uhQuery', 'GMAIL');
    await page.waitForFunction(() => document.querySelectorAll('#usersBody tr').length === 2);
    assert.deepEqual(await rowNames(page), ['Bank', 'تركي']);

    await page.click('#uhReset');
    await page.selectOption('#uhStatus', 'frozen');
    assert.deepEqual(await rowNames(page), ['تركي']);

    await page.click('#uhReset');
    await page.selectOption('#uhRole', 'super_user');
    assert.deepEqual(await rowNames(page), ['Bank']);

    await page.click('#uhReset');
    assert.equal(await page.locator('#usersBody img').count(), 0, 'لا عنصر HTML من الاسم');
    assert.equal(await page.evaluate(() => window.__XSS__ ?? null), null);
    await context.close();
});

test('قائمة «خيارات»: الإجراءات كلها، والحظر يكتب ما كان يكتبه', { skip: !chromiumPath }, async () => {
    const { page, context } = await openHub(fixtures('admin', { has_elevated_authority: true }));
    await page.waitForSelector('#usersBody .uh-options-btn');
    await page.click('.uh-options-btn[data-user-id="u2"]');
    await page.waitForSelector('#uhMenu:not([hidden])');
    const items = await page.$$eval('#uhMenu .uh-menu-item', els => els.map(e => e.firstChild.textContent.trim()));
    assert.deepEqual(items, ['عرض الحساب (الدخول كمستخدم)', 'تعديل النقاط', 'عضو', 'Super User', 'Admin', 'نسخ البريد الإلكتروني', 'حظر المستخدم']);
    assert.equal(await page.getAttribute('#uhMenu .uh-menu-item.is-current', 'aria-current'), 'true');
    assert.equal(await page.getAttribute('.uh-options-btn[data-user-id="u2"]', 'aria-expanded'), 'true');

    // Escape يغلق ويعيد التركيز للزر
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#uhMenu').isVisible(), false);
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.userId), 'u2');

    page.on('dialog', d => d.accept());
    await page.click('.uh-options-btn[data-user-id="u2"]');
    await page.click('#uhMenu .uh-menu-item.is-danger');
    await page.waitForFunction(() => (window.__WRITES__ || []).length > 0);
    assert.deepEqual(await page.evaluate(() => window.__WRITES__), [{ op: 'update', table: 'profiles', row: { status: 'banned' } }]);

    // المحظور: «إلغاء الحظر» بدل «حظر»
    await page.click('.uh-options-btn[data-user-id="u4"]');
    const labels = await page.$$eval('#uhMenu .uh-menu-item', els => els.map(e => e.textContent.trim()));
    assert.ok(labels.includes('إلغاء الحظر') && !labels.includes('حظر المستخدم'));
    await context.close();
});

test('«المحظورون» قائمة مُفلترة، والتبويب المستضاف في وضع التضمين بلا قائمة جانبية', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openHub(fixtures('admin', { has_elevated_authority: true }));
    await page.waitForSelector('#usersBody .uh-options-btn');

    await page.click('#uhTab-banned');
    assert.equal(await page.evaluate(() => location.hash), '#banned');
    assert.equal((await rowNames(page)).length, 1);
    assert.equal(await page.locator('#uhStatusField').isVisible(), false);

    await page.click('#uhTab-customers');
    const frame = page.locator('.uh-frame[data-tab="customers"]');
    await frame.waitFor();
    assert.equal(await frame.getAttribute('src'), '/admin/customers.html?embed=1');
    assert.equal(await page.locator('#uhListPanel').isVisible(), false);
    await page.waitForFunction(() => {
        const doc = document.querySelector('.uh-frame[data-tab="customers"]')?.contentDocument;
        return doc?.documentElement.classList.contains('ws-embedded') && doc.getElementById('sidebar-container');
    });
    assert.equal(await page.evaluate(() => getComputedStyle(
        document.querySelector('.uh-frame[data-tab="customers"]').contentDocument.getElementById('sidebar-container')).display), 'none');
    assert.deepEqual(errors, []);
    await context.close();
});

test('لا تمرير أفقي على الجوال', { skip: !chromiumPath }, async () => {
    const { page, context } = await openHub(fixtures('admin', { has_elevated_authority: true }), { width: 390 });
    await page.waitForSelector('#usersBody .uh-options-btn');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0);
    await context.close();
});

test('لوحة المالك: «المستخدمون» قسم داخل اللوحة يستضيف الصفحة الموحّدة بكل تبويباتها', { skip: !chromiumPath }, async () => {
    const OWNER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const fx = {
        user: { id: OWNER, email: 'owner@example.com' },
        // activeContext: المالك داخل سياقه يُسمح له بصفحات الإدارة كما في الإنتاج (040)
        authUser: { id: OWNER, email: 'owner@example.com', activeContext: 'owner',
            profile: { id: OWNER, full_name: 'مالك المنصة', role: 'platform_owner', ban_status: 'none' } },
        rpc: {
            owner_context_status: { is_platform_owner: true, active_context: 'owner', preview_mode: false, expires_at: '2099-01-01T00:00:00Z' },
            available_contexts: [{ key: 'owner' }],
            owner_security_status: { mfa_enrolled: true, step_up_fresh: true, in_owner_context: true },
            is_platform_owner: true, has_elevated_authority: true, active_context: 'owner',
            my_account_gate: { status: 'active' }, is_sie_admin: false
        },
        tables: {
            profiles: [{ id: OWNER, email: 'owner@example.com', full_name: 'مالك المنصة', role: 'platform_owner', created_at: '2026-01-01T00:00:00Z' },
                       { id: 'u2', email: 'turki@gmail.com', full_name: 'تركي', role: 'user', status: 'active', created_at: '2026-02-01T00:00:00Z' }],
            platform_authority: [], platform_capability_grants: [], privileged_audit: [], owner_context_audit: [], companies: [],
            notifications: [], whatsapp_subscriptions: [], sie_settings: [], sie_admin_grants: [], sie_authority_audit: [], user_wallets: []
        }
    };
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const doubleSupabase = fs.readFileSync(path.join(ROOT, 'tests/fixtures/supabase-double.js'), 'utf8');
    const doubleAuth = fs.readFileSync(path.join(ROOT, 'tests/fixtures/auth-client-double.js'), 'utf8');
    // على مستوى السياق: الإطار المستضاف يحمّل نفس البدائل
    await context.route('**/api-config.js', r => r.fulfill({ contentType: 'text/javascript; charset=utf-8', body: doubleSupabase }));
    await context.route('**/auth-client.js', r => r.fulfill({ contentType: 'text/javascript; charset=utf-8', body: doubleAuth }));
    await context.route('**/error-tracker.js', r => r.fulfill({ contentType: 'text/javascript', body: '' }));
    await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, r => r.abort());
    await context.addInitScript(data => { window.__FIXTURES__ = data; }, fx);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));

    await page.goto(`${baseUrl}/owner-dashboard.html#users`, { waitUntil: 'networkidle' });
    await page.waitForSelector('#usersTabContent.active .owner-users-frame');
    assert.equal(await page.getAttribute('.sidebar-item.active', 'data-tab'), 'users');
    const frame = page.frameLocator('.owner-users-frame');
    await frame.locator('#usersBody .uh-options-btn').first().waitFor();
    assert.deepEqual(await frame.locator('.uh-tab').evaluateAll(els => els.map(e => e.dataset.tab)),
        ['all', 'customers', 'superUsers', 'myUsers', 'banned', 'accountRequests', 'companyRequests', 'waitlist']);
    assert.equal(await frame.locator('#sidebar-container').evaluate(el => getComputedStyle(el).display), 'none', 'لا قائمة جانبية مكررة داخل القسم');
    assert.deepEqual(errors, []);
    await context.close();
});
