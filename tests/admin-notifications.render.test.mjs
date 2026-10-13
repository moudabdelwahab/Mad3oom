/**
 * قائمة الإشعارات في سايدبار الإدارة (assets/js/admin/sidebar.js) في متصفح حقيقي.
 *
 * محتوى notifications غير موثوق: أي موظف يُدرج إشعارًا لأي مستخدم، و inbox_assign
 * ينسخ اسم العميل في نص الإشعار. الاختبار يحمّل صفحة إدارة حقيقية بالسايدبار على
 * بديل Supabase، ويغذّيها بإشعارات خبيثة، ويتأكد من:
 *   - العنوان والنص يظهران كنص حرفي: لا عنصر HTML من المحتوى، ولا سكربت يشتغل.
 *   - رابط javascript: أو نطاق آخر لا يُتبع ولا يُنفَّذ، والإشعار يتعلَّم مقروءًا.
 *   - رابط على نفس الأصل ما زال يفتح وجهته (السلوك المشروع لم يتغير).
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

const ADMIN = 'admin-1';
const ago = (m) => new Date(Date.now() - m * 60000).toISOString();

// كل حمولة تضبط window.__XSS__ لو اشتغلت بأي شكل.
const PAYLOADS = {
    img: '<img src=x onerror="window.__XSS__=\'img\'">',
    script: '<script>window.__XSS__=\'script\'</script>',
    svg: '<svg onload="window.__XSS__=\'svg\'"></svg>',
    iframe: '<iframe srcdoc="<script>parent.__XSS__=\'iframe\'</script>"></iframe>',
    attr: '"><img src=x onerror="window.__XSS__=\'attr\'">',
    style: '<b style="color:red">bold</b><a href="javascript:window.__XSS__=\'anchor\'">click</a>',
};

function fixtures() {
    return {
        user: { id: ADMIN, email: 'admin@test.local' },
        authUser: { id: ADMIN, email: 'admin@test.local', profile: { id: ADMIN, role: 'admin' } },
        tables: {
            profiles: [{ id: ADMIN, full_name: 'الأدمن', email: 'admin@test.local', role: 'admin' }],
            tickets: [], ticket_replies: [], ticket_ratings: [], chat_messages: [],
            notifications: [
                { id: 'n-img', user_id: ADMIN, title: PAYLOADS.img, message: PAYLOADS.script, is_read: false, created_at: ago(1), link: null },
                { id: 'n-svg', user_id: ADMIN, title: PAYLOADS.svg, message: PAYLOADS.iframe, is_read: false, created_at: ago(2), link: null },
                { id: 'n-attr', user_id: ADMIN, title: PAYLOADS.attr, message: PAYLOADS.style, is_read: false, created_at: ago(3), link: null },
                { id: 'n-js', user_id: ADMIN, title: 'رابط javascript', message: 'محادثة مع <i>عميل</i>', is_read: false, created_at: ago(4), link: "javascript:window.__XSS__='link'" },
                { id: 'n-evil', user_id: ADMIN, title: 'رابط خارجي', message: 'x', is_read: false, created_at: ago(5), link: '//evil.example/steal' },
                { id: 'n-ok', user_id: ADMIN, title: 'اتسندت لك محادثة', message: 'محادثة مع عميل', is_read: false, created_at: ago(6), link: '/admin/inbox.html?session=s-1' },
            ]
        },
        rpc: { has_elevated_authority: true, is_platform_owner: false, active_context: null, my_account_gate: { status: 'active' } }
    };
}

let browser, server, baseUrl;
const chromiumPath = resolveChromium();
if (!chromiumPath) console.error('SKIP: لا يوجد متصفح Chromium متاح؛ اختبارات إشعارات الإدارة لم تُنفَّذ');

test.before(async () => {
    if (!chromiumPath) return;
    server = await startServer();
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: chromiumPath });
});
test.after(async () => { await browser?.close(); server?.close(); });

async function openSidebarNotifications() {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    // error-tracker.js يرسل كل خطأ مورد إلى site_errors في الإنتاج: لا اختبار يكتب هناك.
    await context.route('**/error-tracker.js', (r) => r.fulfill({ contentType: 'text/javascript', body: '' }));
    const page = await context.newPage();
    const doubleSupabase = fs.readFileSync(path.join(ROOT, 'tests/fixtures/supabase-double.js'), 'utf8');
    const doubleAuth = fs.readFileSync(path.join(ROOT, 'tests/fixtures/auth-client-double.js'), 'utf8');
    await page.route('**/api-config.js', r => r.fulfill({ contentType: 'text/javascript; charset=utf-8', body: doubleSupabase }));
    await page.route('**/auth-client.js', r => r.fulfill({ contentType: 'text/javascript; charset=utf-8', body: doubleAuth }));
    await page.route('https://fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
    // الصفحة نفسها تطلب خطوطًا وتبلّغ عن الأخطاء: الخارج كله يُقطع، والمرصود هو طلبات
    // الحمولة فقط: الصورة/الإطار (src=x ⇒ /admin/x محليًا) والتنقل لـ evil.example.
    const external = [];
    await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, r => r.abort());
    page.on('request', req => {
        const u = new URL(req.url());
        if (u.hostname === 'evil.example' || /\/x$/.test(u.pathname)) external.push(req.url());
    });
    // وجهة الرابط المشروع: صفحة بسيطة بدل الصندوق الحقيقي.
    await page.route('**/admin/inbox.html*', r => r.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>inbox stub</title>' }));
    await page.addInitScript(data => { window.__FIXTURES__ = data; try { localStorage.clear(); } catch {} }, fixtures());

    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const dialogs = [];
    page.on('dialog', d => { dialogs.push(d.message()); d.dismiss(); });

    await page.goto(`${baseUrl}/admin/team-performance.html`, { waitUntil: 'networkidle' });
    await page.waitForSelector('#notificationBtn');
    await page.click('#notificationBtn');
    await page.waitForSelector('#notificationList .notification-item');
    return { page, context, errors, external, dialogs };
}

const xss = (page) => page.evaluate(() => window.__XSS__ ?? null);

test('العنوان والنص يظهران كنص حرفي ولا يُنفَّذ أي محتوى', { skip: !chromiumPath }, async () => {
    const { page, context, errors, external, dialogs } = await openSidebarNotifications();
    assert.equal(await page.locator('#notificationList .notification-item').count(), 6);

    // لا عنصر واحد من المحتوى: كل أبناء العنصر divs من sidebar.js فقط.
    const injected = await page.evaluate(() =>
        [...document.querySelectorAll('#notificationList *')]
            .filter(el => !el.classList.contains('notification-item') && el.tagName !== 'DIV')
            .map(el => el.tagName));
    assert.deepEqual(injected, [], 'عناصر HTML من محتوى الإشعار اتحقنت');

    const text = await page.locator('#notificationList').innerText();
    for (const p of Object.values(PAYLOADS)) {
        assert.ok(text.includes(p), `الحمولة لازم تظهر كنص حرفي: ${p}`);
    }
    assert.ok(text.includes('محادثة مع <i>عميل</i>'));

    await page.waitForTimeout(300); // مهلة لأي onerror/onload متأخر
    assert.equal(await xss(page), null, 'سكربت من محتوى الإشعار اشتغل');
    assert.deepEqual(dialogs, []);
    assert.deepEqual(external, [], 'طلب خارجي من محتوى الإشعار');
    assert.deepEqual(errors, []);
    await context.close();
});

test('رابط javascript: أو نطاق آخر لا يُتبع، والإشعار يتعلَّم مقروءًا', { skip: !chromiumPath }, async () => {
    const { page, context, external } = await openSidebarNotifications();
    const before = page.url();

    for (const title of ['رابط javascript', 'رابط خارجي']) {
        // بعد إعادة الرسم القائمة بتتقفل (سلوك السايدبار قبل الإصلاح)، فنفتحها من جديد.
        if (!(await page.locator('#notificationMenu').isVisible())) {
            await page.click('#notificationBtn');
            await page.waitForSelector('#notificationList .notification-item');
        }
        await page.evaluate(() => { window.__WRITES__ = []; });
        await page.locator('#notificationList .notification-item', { hasText: title }).click();
        await page.waitForFunction(() => (window.__WRITES__ || []).some(w => w.table === 'notifications' && w.op === 'update'));
        await page.waitForTimeout(300);
        assert.equal(page.url(), before, `${title}: الصفحة اتنقلت`);
        assert.equal(await xss(page), null, `${title}: الرابط اتنفّذ`);
    }
    assert.deepEqual(external, [], 'تنقل أو طلب لنطاق خارجي');
    await context.close();
});

test('رابط على نفس الأصل ما زال يفتح وجهته', { skip: !chromiumPath }, async () => {
    const { page, context } = await openSidebarNotifications();
    await Promise.all([
        page.waitForURL('**/admin/inbox.html?session=s-1'),
        page.locator('#notificationList .notification-item', { hasText: 'اتسندت لك محادثة' }).click(),
    ]);
    assert.equal(new URL(page.url()).pathname + new URL(page.url()).search, '/admin/inbox.html?session=s-1');
    await context.close();
});
