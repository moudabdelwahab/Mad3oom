/**
 * «المستخدمون» في لوحة الشركة (#users) في متصفح حقيقي على بديل Supabase.
 *
 * يتأكد من:
 *   - المدير يرى الأعضاء والدعوات المعلّقة (لا قائمة العملاء — قرار الخصوصية القائم)،
 *     والمشرف يرى الأعضاء والعملاء بلا إضافة ولا دعوة.
 *   - البحث والفلاتر، والنص غير الموثوق يُعرض حرفيًا.
 *   - إجراءات «خيارات» تنادي نفس دوال القاعدة التي تناديها صفحتا الأعضاء والعملاء.
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
        let urlPath = decodeURIComponent(req.url.split('?')[0]);
        if (urlPath.endsWith('/')) urlPath += 'index.html';
        const filePath = path.join(ROOT, urlPath);
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

const ME = '11111111-1111-1111-1111-111111111111';
const COMPANY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CUSTOMER = '22222222-2222-2222-2222-222222222222';
const AGENT = '33333333-3333-3333-3333-333333333333';

function fixtures(viewerRole = 'admin') {
    const isAdmin = viewerRole === 'admin';
    const dashboard = {
        company: { id: COMPANY, name: 'شركة النور', cr_number: '1', cr_expiry: '2027-06-01', status: 'active', is_owner: isAdmin, created_at: '2026-01-01T00:00:00Z' },
        registration: { expiry_date: '2027-06-01', is_expired: false, days_to_expiry: 200 },
        subscriptions: [{ id: 's1', plan: 'whatsapp', plan_name_ar: 'واتساب', status: 'active', billing_cycle: 'monthly', start_date: '2026-08-01T00:00:00Z', end_date: '2026-12-01T00:00:00Z', is_active: true, days_remaining: 85 }],
        entitlements: [], access: { active_plans: ['whatsapp'], has_active_subscription: true },
        viewer_role: viewerRole
    };
    const members = [
        { id: ME, name: 'مالك الشركة', email: 'owner@company.test', role: 'company_admin', is_owner: true, is_me: isAdmin, created_at: '2026-01-01T00:00:00Z' },
        { id: CUSTOMER, name: '<img src=x onerror="window.__XSS__=1">عميل', email: 'cust1@company.test', role: 'company_user', is_owner: false, is_me: false, created_at: '2026-02-01T00:00:00Z' },
        { id: AGENT, name: 'موظفة الدعم', email: 'agent@company.test', role: 'company_user', is_owner: false, is_me: !isAdmin, created_at: '2026-03-01T00:00:00Z' }
    ];
    return {
        user: { id: ME, email: 'owner@company.test' },
        authUser: { id: ME, email: 'owner@company.test', profile: { id: ME, full_name: 'مالك الشركة', role: 'super_user' } },
        rpc: {
            get_my_company_dashboard: dashboard,
            current_company_id: COMPANY,
            company_members: { company_id: COMPANY, is_owner: isAdmin, can_manage: isAdmin, company_role: isAdmin ? 'company_admin' : 'company_user', members },
            company_staff_list: { company_id: COMPANY, my_role: viewerRole, can_manage: isAdmin,
                staff: [{ user_id: ME, role: 'admin', is_owner: true }, { user_id: AGENT, role: 'agent', is_owner: false }] },
            company_customers_list: { can_manage: isAdmin, invitations_enabled: true,
                customers: [{ id: 'k1', name: 'عميلة خارجية', email: 'k1@client.test', phone: '0501234567' }] },
            company_invitations_list: [
                { id: 'i1', email: 'new@client.test', status: 'pending', email_status: 'failed', created_at: '2026-10-20T00:00:00Z' },
                { id: 'i2', email: 'old@client.test', status: 'accepted', created_at: '2026-09-01T00:00:00Z' }
            ],
            company_staff_set: { changed: true, staff: { user_id: CUSTOMER, role: 'agent' } },
            company_invitation_cancel: { cancelled: true }
        },
        tables: { profiles: [{ id: ME, email: 'owner@company.test', full_name: 'مالك الشركة', role: 'super_user' }], notifications: [], services: [], whatsapp_subscriptions: [], subscription_plans: [] }
    };
}

let browser, server, baseUrl;
const chromiumPath = resolveChromium();
if (!chromiumPath) console.error('SKIP: لا يوجد متصفح Chromium متاح؛ اختبارات «المستخدمون» في لوحة الشركة لم تُنفَّذ');

test.before(async () => {
    if (!chromiumPath) return;
    server = await startServer();
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: chromiumPath });
});
test.after(async () => { await browser?.close(); server?.close(); });

async function openUsers(fx, { width = 1440 } = {}) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    const doubleSupabase = fs.readFileSync(path.join(ROOT, 'tests/fixtures/supabase-double.js'), 'utf8');
    const doubleAuth = fs.readFileSync(path.join(ROOT, 'tests/fixtures/auth-client-double.js'), 'utf8');
    await page.route('**/api-config.js', r => r.fulfill({ contentType: 'text/javascript; charset=utf-8', body: doubleSupabase }));
    await page.route('**/auth-client.js', r => r.fulfill({ contentType: 'text/javascript; charset=utf-8', body: doubleAuth }));
    await page.route('**/chat-widget.js', r => r.fulfill({ contentType: 'text/javascript', body: 'export default {};' }));
    await page.route('**/error-tracker.js', r => r.fulfill({ contentType: 'text/javascript', body: '' }));
    await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, r => r.abort());
    await page.addInitScript(data => { window.__FIXTURES__ = data; }, fx);
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${baseUrl}/company-dashboard/#users`, { waitUntil: 'networkidle' });
    await page.waitForSelector('#usersTabContent.active #companyUsersDirectory tbody tr', { timeout: 10000 });
    return { page, context, errors };
}

const rowsOf = (page) => page.$$eval('#companyUsersDirectory tbody tr', trs => trs.map(t => [t.dataset.kind, t.children[0].textContent]));
const rpcArgs = (page, name) => page.evaluate(n => (window.__RPC_ARGS__ || []).filter(([x]) => x === n).map(([, a]) => a), name);
const menuIds = (page) => page.$$eval('#cuMenu .opt-menu-item', els => els.map(e => e.dataset.action));

test('المدير: الأعضاء والدعوات المعلّقة في مكان واحد، بلا قائمة العملاء', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openUsers(fixtures('admin'));
    assert.equal(await page.getAttribute('.sidebar-item.active', 'data-tab'), 'users');
    assert.deepEqual((await rowsOf(page)).map(r => r[0]), ['member', 'member', 'member', 'invitation']);
    assert.ok(await page.locator('#usersAddMemberBtn').isVisible());
    assert.ok(await page.locator('#usersInviteLink').isVisible());
    // النص غير الموثوق نصٌّ حرفي
    assert.equal(await page.locator('#companyUsersDirectory img').count(), 0);
    assert.equal(await page.evaluate(() => window.__XSS__ ?? null), null);
    assert.deepEqual(errors, []);
    await context.close();
});

test('المشرف: الأعضاء والعملاء، بلا إضافة ولا دعوة ولا إدارة', { skip: !chromiumPath }, async () => {
    const { page, context } = await openUsers(fixtures('supervisor'));
    assert.deepEqual((await rowsOf(page)).map(r => r[0]), ['member', 'member', 'member', 'customer']);
    assert.equal(await page.locator('#usersAddMemberBtn').isVisible(), false);
    assert.equal(await page.locator('#usersInviteLink').isVisible(), false);
    await page.click(`.cu-options-btn[data-key="member:${CUSTOMER}"]`);
    assert.deepEqual(await menuIds(page), ['copyEmail']);
    await context.close();
});

test('البحث والفلاتر', { skip: !chromiumPath }, async () => {
    const { page, context } = await openUsers(fixtures('admin'));
    await page.fill('#cuQuery', 'CLIENT');
    assert.deepEqual(await rowsOf(page), [['invitation', 'new@client.test']]);
    await page.click('#cuReset');
    await page.selectOption('#cuStaff', 'staff');
    assert.deepEqual((await rowsOf(page)).map(r => r[1]), ['مالك الشركة', 'موظفة الدعم']);
    await page.click('#cuReset');
    await page.selectOption('#cuKind', 'invitation');
    assert.deepEqual((await rowsOf(page)).map(r => r[0]), ['invitation']);
    // نوع لا يملكه هذا الناظر لا يُعرض في الفلتر
    assert.equal(await page.locator('#cuKind option[value="customer"]').evaluate(o => o.hidden), true);
    await context.close();
});

test('«خيارات» تنادي دوال القاعدة نفسها: تغيير الدور وإلغاء الدعوة', { skip: !chromiumPath }, async () => {
    const { page, context } = await openUsers(fixtures('admin'));
    await page.click(`.cu-options-btn[data-key="member:${CUSTOMER}"]`);
    assert.deepEqual(await menuIds(page),
        ['details', 'staff:customer', 'staff:agent', 'staff:supervisor', 'copyEmail', 'remove']);
    await page.click('#cuMenu .opt-menu-item[data-action="staff:agent"]');
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'company_staff_set'));
    assert.deepEqual(await rpcArgs(page, 'company_staff_set'), [{ p_user: CUSTOMER, p_role: 'agent' }]);

    await page.click('.cu-options-btn[data-key="invitation:i1"]');
    assert.deepEqual(await menuIds(page), ['invite:retry', 'copyEmail', 'cancelInvite']);
    await page.click('#cuMenu .opt-menu-item[data-action="cancelInvite"]');
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'company_invitation_cancel'));
    assert.deepEqual(await rpcArgs(page, 'company_invitation_cancel'), [{ p_invitation: 'i1' }]);

    // الحساب نفسه: ملفه الشخصي، بلا إدارة ولا إزالة
    await page.click(`.cu-options-btn[data-key="member:${ME}"]`);
    assert.deepEqual(await menuIds(page), ['myProfile', 'copyEmail']);
    await page.click('#cuMenu .opt-menu-item[data-action="myProfile"]');
    await page.waitForSelector('#profileTabContent.active');
    await context.close();
});

test('لا تمرير أفقي على الجوال', { skip: !chromiumPath }, async () => {
    const { page, context } = await openUsers(fixtures('admin'), { width: 390 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0);
    await context.close();
});
