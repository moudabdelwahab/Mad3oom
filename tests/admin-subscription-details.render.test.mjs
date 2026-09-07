/**
 * اختبارات عرض شاشة تفاصيل الاشتراك في لوحة الإدارة.
 *
 * سبب وجود هذه الحزمة: الصفحة ظهرت فاضية تمامًا في الإنتاج **بلا أي خطأ في
 * الكونسول**. السبب كان تصادم أسماء أصناف CSS — الغلاف كان class="page"،
 * و admin/styles.css يعرّف `.page { display: none }` كأداة تبديل تبويبات.
 * فالـHTML كان يُبنى صحيحًا في الـDOM لكنه غير مرئي.
 *
 * الدرس الذي تفرضه هذه الاختبارات: لا يكفي التأكد أن العناصر موجودة في الـDOM
 * (كل تأكيد كهذا كان سينجح أثناء العطل). لازم نقيس أنها **مرئية فعلًا**:
 * نص ظاهر وارتفاع أكبر من صفر.
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

const SID = '55555555-5555-4555-8555-555555555555';

function subscription(over = {}) {
    return {
        id: SID, user_id: 'u1',
        customer_name: 'عميل تجريبي', customer_email: 'client@test.local', customer_phone: '0100000000',
        company_id: 'c1', company_name: 'شركة النور',
        plan: 'bundle', plan_name_ar: 'الباقة الشاملة',
        status: 'active', billing_cycle: 'monthly',
        start_date: '2026-08-01T00:00:00Z', end_date: '2026-10-01T00:00:00Z',
        is_active: true, days_remaining: 24, ticket_number: 12,
        payment_method: 'gateway', created_at: '2026-08-01T00:00:00Z',
        effective_features: ['whatsapp_sender', 'support_tickets'],
        ...over
    };
}

function fixtures(row, audit = []) {
    return {
        user: { id: 'admin-1', email: 'admin@test.local' },
        authUser: { id: 'admin-1', email: 'admin@test.local', profile: { id: 'admin-1', role: 'admin' } },
        // قيم صريحة لا دوال: addInitScript يسلسل الوسيط بـJSON
        rpc: { admin_list_subscriptions: [row], admin_subscription_audit: audit },
        tables: { profiles: [{ id: 'admin-1', email: 'admin@test.local', role: 'admin' }] }
    };
}

let browser, server, baseUrl;
const chromiumPath = resolveChromium();
if (!chromiumPath) {
    console.error('SKIP: لا يوجد متصفح Chromium متاح؛ اختبارات شاشة تفاصيل الاشتراك لم تُنفَّذ');
}

test.before(async () => {
    if (!chromiumPath) return;
    server = await startServer();
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: chromiumPath });
});
test.after(async () => { await browser?.close(); server?.close(); });

async function openDetails(fx, { viewport } = {}) {
    const context = await browser.newContext({ viewport: viewport || { width: 1280, height: 900 } });
    const page = await context.newPage();

    const doubleSupabase = fs.readFileSync(path.join(ROOT, 'tests/fixtures/supabase-double.js'), 'utf8');
    const doubleAuth = fs.readFileSync(path.join(ROOT, 'tests/fixtures/auth-client-double.js'), 'utf8');
    await page.route('**/api-config.js', r =>
        r.fulfill({ contentType: 'text/javascript; charset=utf-8', body: doubleSupabase }));
    await page.route('**/auth-client.js', r =>
        r.fulfill({ contentType: 'text/javascript; charset=utf-8', body: doubleAuth }));
    await page.route('https://fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));

    await page.addInitScript(data => { window.__FIXTURES__ = data; }, fx);

    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto(`${baseUrl}/admin/subscription-details.html?id=${SID}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('#root .card', { timeout: 10000 });
    return { page, context, errors };
}

test('الصفحة تُعرض فعلًا — لا HTML مبني وغير مرئي', async () => {
    const { page, context, errors } = await openDetails(fixtures(subscription()));

    // العطل الأصلي: الـDOM كان مكتملًا والصفحة فاضية. النص الظاهر هو ما يكشفه.
    const text = (await page.evaluate(() => document.body.innerText)).trim();
    assert.notEqual(text, '', 'الصفحة بلا نص ظاهر — على الأرجح غلافها مخفي بـCSS');
    assert.match(text, /عميل تجريبي/);
    assert.match(text, /الباقة الشاملة/);

    // وارتفاع الغلاف: صفر يعني display:none في مكان ما
    const height = await page.evaluate(() =>
        document.querySelector('#root')?.getBoundingClientRect().height ?? 0);
    assert.ok(height > 100, `ارتفاع المحتوى ${height}px — الغلاف مخفي`);

    assert.equal(errors.length, 0, `أخطاء في الصفحة: ${errors.join(' | ')}`);
    await context.close();
});

test('غلاف الصفحة لا يستخدم اسم صنف تبديل التبويبات', async () => {
    // admin/styles.css يعرّف .page { display:none } إلا مع .active — أي غلاف
    // بهذا الاسم يختفي بصمت. هذا التأكيد يمنع عودة نفس التصادم.
    const html = fs.readFileSync(path.join(ROOT, 'admin/subscription-details.html'), 'utf8');
    assert.ok(!/<div class="page">/.test(html),
        'الغلاف يستخدم class="page" التي يخفيها admin/styles.css');
});

test('بيانات العميل والشركة والاشتراك كلها معروضة', async () => {
    const { page, context } = await openDetails(fixtures(subscription()));
    const text = await page.evaluate(() => document.body.innerText);
    for (const expected of ['client@test.local', 'شركة النور', 'فعّال', '24']) {
        assert.ok(text.includes(expected), `"${expected}" غير معروض`);
    }
    // الخدمات الفعلية للعميل
    assert.equal(await page.locator('.chips .chip').count(), 2);
    await context.close();
});

test('أزرار الإجراءات تتبع حالة الاشتراك', async () => {
    const active = await openDetails(fixtures(subscription({ status: 'active', is_active: true })));
    assert.equal(await active.page.locator('#deactivateBtn').count(), 1, 'زر التعطيل غائب عن اشتراك فعّال');
    assert.equal(await active.page.locator('#reactivateBtn').count(), 0, 'زر إعادة التفعيل ظهر لاشتراك فعّال');
    await active.context.close();

    const expired = await openDetails(fixtures(subscription({ status: 'expired', is_active: false, days_remaining: 0 })));
    assert.equal(await expired.page.locator('#reactivateBtn').count(), 1, 'زر إعادة التفعيل غائب عن اشتراك منتهٍ');
    assert.equal(await expired.page.locator('#deactivateBtn').count(), 0, 'زر التعطيل ظهر لاشتراك منتهٍ');
    await expired.context.close();
});

test('التناقض بين الحالة والتاريخ يُعلَن للأدمن', async () => {
    // status=active لكن is_active=false: المنصة تعتبره منتهيًا
    const { page, context } = await openDetails(
        fixtures(subscription({ status: 'active', is_active: false, days_remaining: 0 })));
    assert.equal(await page.locator('.notice-warn').count(), 1, 'لا تحذير رغم تناقض الحالة مع التاريخ');
    await context.close();
});

test('سجل التغييرات يظهر حين يوجد', async () => {
    const audit = [{
        action: 'update', actor_email: 'admin@test.local',
        old_values: { plan: 'whatsapp' }, new_values: { plan: 'bundle' },
        reason: 'ترقية بطلب العميل', created_at: '2026-09-01T10:00:00Z'
    }];
    const { page, context } = await openDetails(fixtures(subscription(), audit));
    const text = await page.evaluate(() => document.body.innerText);
    assert.match(text, /admin@test\.local/);
    assert.match(text, /ترقية بطلب العميل/);
    await context.close();
});

test('لا تمرير أفقي على الموبايل', async () => {
    const { page, context } = await openDetails(fixtures(subscription()), { viewport: { width: 390, height: 844 } });
    const overflows = await page.evaluate(() =>
        document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    assert.equal(overflows, false, 'تمرير أفقي على عرض 390');
    await context.close();
});
