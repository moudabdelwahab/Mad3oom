/**
 * تخطيط اللوحات الثلاث (الإدارة، المالك، الشركة) في متصفح حقيقي.
 *
 * dashboard-layout.css + dashboard-nav.js: قائمة جانبية ثابتة يمين الشاشة
 * بمجموعات قابلة للطي، وشريط علوي كبطاقة. الاختبار يحمّل الصفحات الحقيقية على
 * بديل Supabase ويتأكد من:
 *   - تقسيم القائمة لمجموعات لم يغيّر الصلاحيات: Super User لا يرى روابط
 *     الطاقم، والمجموعة التي تُخفى كل عناصرها تختفي بعنوانها.
 *   - المجموعة تُطوى وتُحفظ حالتها، والصفحة الحالية تُكشف دائمًا ولو كانت
 *     مجموعتها محفوظة مطوية.
 *   - طي القائمة لأيقونات يوسّع المحتوى ويُحفظ، والدرج على الجوال يعمل.
 *   - لوحة المالك: القسم المختار من الـhash يفتح مجموعته.
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

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function staffFixtures(role, rpc = {}) {
    return {
        user: { id: USER, email: 'staff@test.local' },
        authUser: { id: USER, email: 'staff@test.local', profile: { id: USER, full_name: 'Staff Tester', role } },
        tables: {
            profiles: [{ id: USER, full_name: 'Staff Tester', email: 'staff@test.local', role }],
            notifications: [], tickets: []
        },
        rpc: { has_elevated_authority: false, is_platform_owner: false, active_context: null, my_account_gate: { status: 'active' }, ...rpc }
    };
}

const ownerFixtures = {
    user: { id: USER, email: 'owner@example.com' },
    authUser: { id: USER, email: 'owner@example.com', profile: { id: USER, full_name: 'مالك المنصة', role: 'platform_owner', ban_status: 'none' } },
    rpc: {
        owner_context_status: { is_platform_owner: true, active_context: 'owner', preview_mode: false, expires_at: '2099-01-01T00:00:00Z' },
        available_contexts: [{ key: 'owner' }],
        owner_security_status: { mfa_enrolled: true, step_up_fresh: true, step_up_expires_at: '2099-01-01T00:00:00Z', in_owner_context: true }
    },
    tables: {
        profiles: [{ id: USER, email: 'owner@example.com', full_name: 'مالك المنصة', role: 'platform_owner' }],
        platform_authority: [], platform_capability_grants: [], privileged_audit: [], owner_context_audit: [],
        companies: [], notifications: [], whatsapp_subscriptions: [], sie_settings: [], sie_admin_grants: [], sie_authority_audit: []
    }
};

let browser, server, baseUrl;
const chromiumPath = resolveChromium();
if (!chromiumPath) console.error('SKIP: لا يوجد متصفح Chromium متاح؛ اختبارات تخطيط اللوحات لم تُنفَّذ');

test.before(async () => {
    if (!chromiumPath) return;
    server = await startServer();
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: chromiumPath });
});
test.after(async () => { await browser?.close(); server?.close(); });

/**
 * guardStub: صفحات الإدارة محروسة بـguardPage('admin') التي ترفض Super User في
 * بعض الصفحات. البديل يتخطى الحارس **فقط** ليصل الاختبار إلى القائمة؛
 * applySidebarPermissions() نفسها تعمل بلا تعديل — وهي موضوع الاختبار.
 */
async function openPage(url, fx, { width = 1440, storage = {}, guardStub = false } = {}) {
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
    // التخزين يُبذر مرة واحدة لكل سياق، فإعادة التحميل تقرأ ما حفظته الصفحة نفسها.
    await page.addInitScript(([data, seed]) => {
        window.__FIXTURES__ = data;
        try {
            if (!sessionStorage.getItem('__seeded')) {
                localStorage.clear();
                for (const [k, v] of Object.entries(seed)) localStorage.setItem(k, v);
                sessionStorage.setItem('__seeded', '1');
            }
        } catch { /* لا تخزين */ }
    }, [fx, storage]);

    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(baseUrl + url, { waitUntil: 'networkidle' });
    await page.waitForSelector('#sidebar .sidebar-item');
    return { page, context, errors };
}

const sidebarWidth = (page) => page.evaluate(() => Math.round(document.getElementById('sidebar').getBoundingClientRect().width));

test('الإدارة: القائمة ثابتة يمينًا والمحتوى يسارها، والصفحة الحالية نشطة داخل مجموعتها', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openPage('/admin/users.html', staffFixtures('admin', { has_elevated_authority: true }));

    const geo = await page.evaluate(() => {
        const s = document.getElementById('sidebar').getBoundingClientRect();
        const m = document.querySelector('.admin-main').getBoundingClientRect();
        return { sideRight: Math.round(s.right), sideLeft: Math.round(s.left), mainRight: Math.round(m.right), vw: innerWidth,
                 overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });
    assert.equal(geo.sideRight, geo.vw, 'القائمة ملاصقة لليمين');
    assert.ok(geo.mainRight <= geo.sideLeft, 'المحتوى لا يتداخل مع القائمة');
    assert.equal(geo.overflow, 0);

    assert.equal(await page.locator('#usersLink.active').count(), 1);
    assert.equal(await page.locator('#usersLink').evaluate(el => el.closest('.sidebar-group').dataset.group), 'people');
    assert.equal(await page.locator('#adminUserName').textContent(), 'Staff Tester');
    assert.deepEqual(errors, []);
    await context.close();
});

test('Super User: روابط الطاقم مخفية كما كانت، والمجموعات الفارغة تختفي بعنوانها', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openPage('/admin/my-users.html', staffFixtures('super_user'), { guardStub: true });
    await page.waitForFunction(() => getComputedStyle(document.getElementById('myUsersLink')).display !== 'none');

    for (const id of ['ticketsLink', 'teamPerformanceLink', 'usersLink', 'customerHistoryLink', 'bannedLink',
        'statsLink', 'activityLogLink', 'settingsLink', 'mcpLink', 'subscriptionsLink', 'passcodesLink']) {
        assert.equal(await page.locator('#' + id).isVisible(), false, `${id} يجب أن يبقى مخفيًا`);
    }
    assert.ok(await page.locator('#myUsersLink').isVisible());
    assert.ok(await page.locator('#agentsLink').isVisible());
    assert.equal(await page.locator('.sidebar-group[data-group="support"]').isVisible(), false);
    assert.equal(await page.locator('.sidebar-group[data-group="monitoring"]').isVisible(), false);
    assert.ok(await page.locator('.sidebar-group[data-group="people"]').isVisible());
    assert.equal(await page.locator('#adminSidebarContext').textContent(), 'لوحة المسؤول');
    assert.deepEqual(errors, []);
    await context.close();
});

test('المجموعة تُطوى وتُحفظ، والصفحة الحالية تُكشف ولو كانت مجموعتها محفوظة مطوية', { skip: !chromiumPath }, async () => {
    const { page, context } = await openPage('/admin/users.html', staffFixtures('admin', { has_elevated_authority: true }),
        { storage: { 'mad3oom-nav-groups': JSON.stringify({ admin: ['people'] }) } });

    assert.ok(await page.locator('#usersLink').isVisible(), 'مجموعة الصفحة الحالية مفتوحة');

    const toggle = '.sidebar-group[data-group="content"] > .sidebar-group-toggle';
    await page.click(toggle);
    assert.equal(await page.getAttribute(toggle, 'aria-expanded'), 'false');
    assert.equal(await page.locator('#blogAdminLink').isVisible(), false);

    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('#sidebar .sidebar-item');
    assert.equal(await page.locator('#blogAdminLink').isVisible(), false, 'حالة الطي محفوظة');
    await page.click(toggle);
    assert.ok(await page.locator('#blogAdminLink').isVisible());
    await context.close();
});

test('طي القائمة لأيقونات يوسّع المحتوى ويُحفظ، وتحت 1100px تعود درجًا', { skip: !chromiumPath }, async () => {
    const { page, context } = await openPage('/admin/users.html', staffFixtures('admin', { has_elevated_authority: true }));
    const mainWidth = () => page.evaluate(() => document.querySelector('.admin-main').getBoundingClientRect().width);

    const before = await mainWidth();
    await page.click('#sidebarCollapseBtn');
    // العرض يتحرك بانتقال: ننتظر استقراره عند عرض الوضع المطوي
    await page.waitForFunction(() => Math.round(document.getElementById('sidebar').getBoundingClientRect().width) === 76);
    assert.equal(await sidebarWidth(page), 76);
    assert.ok(await mainWidth() > before);
    assert.equal(await page.getAttribute('#ticketsLink', 'data-label'), 'إدارة التذاكر', 'تلميح الأيقونة');

    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-sidebar')), 'collapsed');
    await context.close();

    const mobile = await openPage('/admin/users.html', staffFixtures('admin', { has_elevated_authority: true }), { width: 390 });
    assert.equal(await mobile.page.locator('#sidebarCollapseBtn').isVisible(), false);
    await mobile.page.click('#menuToggle');
    await mobile.page.waitForFunction(() => Math.round(document.getElementById('sidebar').getBoundingClientRect().right) === innerWidth);
    assert.equal(await mobile.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0);
    await mobile.context.close();
});

test('المالك: القسم المختار يفتح مجموعته المطوية، والاسم يظهر في الشريط', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openPage('/owner-dashboard.html#overview', ownerFixtures,
        { storage: { 'mad3oom-nav-groups': JSON.stringify({ owner: ['authority'] }) } });

    const audit = '.sidebar-item[data-tab="audit"]';
    assert.equal(await page.locator(audit).isVisible(), false, 'المجموعة تبدأ مطوية كما حُفظت');
    await page.evaluate(() => { location.hash = '#audit'; });
    await page.waitForSelector(`${audit}.active`);
    assert.ok(await page.locator(audit).isVisible(), 'القسم الحالي يُكشف');
    assert.equal(await page.locator('#customerNavName').textContent(), 'مالك المنصة');
    assert.equal(await page.locator('.dash-brand-context').textContent(), 'لوحة المالك');
    assert.deepEqual(errors, []);
    await context.close();
});
