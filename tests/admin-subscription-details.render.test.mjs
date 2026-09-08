/**
 * اختبارات عرض تفاصيل الاشتراك في لوحة الإدارة — في صدفتيها:
 * النافذة المنبثقة فوق صفحة الاشتراكات، والصفحة المستقلة للروابط المباشرة.
 * الاثنتان تستخدمان assets/js/admin/subscription-details-view.js نفسه.
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
    await page.waitForSelector('#root .subd-section, #root .subd-notice--error', { timeout: 10000 });
    return { page, context, errors };
}

/**
 * صفحة الاشتراكات + فتح النافذة من زر "عرض التفاصيل".
 * الصفحة تنشئ عميلها من سكربت CDN كلاسيكي، فالبديل هنا يعترض ذلك السكربت.
 */
async function openListAndModal(fx, { viewport, open = true } = {}) {
    const context = await browser.newContext({ viewport: viewport || { width: 1280, height: 900 } });
    const page = await context.newPage();

    const cdnDouble = fs.readFileSync(path.join(ROOT, 'tests/fixtures/supabase-cdn-double.js'), 'utf8');
    await page.route('**/cdn.jsdelivr.net/**', r =>
        r.fulfill({ contentType: 'text/javascript; charset=utf-8', body: cdnDouble }));
    await page.route('https://fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));

    await page.addInitScript(data => { window.__FIXTURES__ = data; }, fx);

    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto(`${baseUrl}/admin/subscriptions.html`, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-details-id]', { timeout: 10000 });

    if (open) {
        await page.click('[data-details-id]');
        await page.waitForSelector('.subd-overlay.open .subd-section', { timeout: 10000 });
    }
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
    assert.equal(await page.locator('.subd-chips .subd-chip').count(), 2);
    await context.close();
});

test('أزرار الإجراءات تتبع حالة الاشتراك', async () => {
    const active = await openDetails(fixtures(subscription({ status: 'active', is_active: true })));
    assert.equal(await active.page.locator('#subdDeactivate').count(), 1, 'زر التعطيل غائب عن اشتراك فعّال');
    assert.equal(await active.page.locator('#subdReactivate').count(), 0, 'زر إعادة التفعيل ظهر لاشتراك فعّال');
    await active.context.close();

    const expired = await openDetails(fixtures(subscription({ status: 'expired', is_active: false, days_remaining: 0 })));
    assert.equal(await expired.page.locator('#subdReactivate').count(), 1, 'زر إعادة التفعيل غائب عن اشتراك منتهٍ');
    assert.equal(await expired.page.locator('#subdDeactivate').count(), 0, 'زر التعطيل ظهر لاشتراك منتهٍ');
    await expired.context.close();
});

test('التناقض بين الحالة والتاريخ يُعلَن للأدمن', async () => {
    // status=active لكن is_active=false: المنصة تعتبره منتهيًا
    const { page, context } = await openDetails(
        fixtures(subscription({ status: 'active', is_active: false, days_remaining: 0 })));
    assert.equal(await page.locator('.subd-notice--warn').count(), 1, 'لا تحذير رغم تناقض الحالة مع التاريخ');
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

/* ===========================================================================
   النافذة المنبثقة فوق صفحة الاشتراكات — المسار الذي يستخدمه الأدمن فعلًا
   =========================================================================== */

test('زر عرض التفاصيل يفتح نافذة ولا يغادر صفحة الاشتراكات', async () => {
    const { page, context, errors } = await openListAndModal(fixtures(subscription()));

    assert.match(page.url(), /subscriptions\.html/, 'الصفحة انتقلت بدل أن تفتح نافذة');
    assert.equal(await page.locator('.subd-overlay.open').count(), 1);
    assert.equal(errors.length, 0, `أخطاء في الصفحة: ${errors.join(' | ')}`);
    await context.close();
});

test('محتوى النافذة مرئي فعلًا لا مبنيًا فقط', async () => {
    // نفس درس الصفحة الفاضية: وجود العناصر في الـDOM لا يعني ظهورها
    const { page, context } = await openListAndModal(fixtures(subscription()));

    const dialog = page.locator('.subd-overlay.open .subd-dialog');
    await dialog.waitFor({ state: 'visible' });
    const box = await dialog.boundingBox();
    assert.ok(box && box.height > 150, `ارتفاع الحوار ${box?.height ?? 0}px — النافذة مخفية`);

    const text = await page.locator('.subd-overlay.open').innerText();
    for (const expected of ['عميل تجريبي', 'client@test.local', 'شركة النور', 'الباقة الشاملة']) {
        assert.ok(text.includes(expected), `"${expected}" غير معروض في النافذة`);
    }
    await context.close();
});

test('النافذة تحمل modal-overlay فتحصل على إتاحة لوحة المفاتيح', async () => {
    // assets/js/admin/modal-a11y.js يراقب .modal-overlay.open وحدها. لو تغيّر
    // الاسم فقدت النافذة حبس التركيز وقفل التمرير بلا أي خطأ ظاهر.
    const { page, context } = await openListAndModal(fixtures(subscription()));
    const classes = await page.locator('.subd-overlay').getAttribute('class');
    assert.ok(classes.includes('modal-overlay'), `أصناف النافذة: ${classes}`);

    assert.equal(await page.evaluate(() => document.body.style.overflow), 'hidden',
        'تمرير الخلفية لم يُقفل خلف النافذة');

    // التركيز داخل الحوار لا على الصفحة خلفه
    const inside = await page.evaluate(() =>
        !!document.querySelector('.subd-overlay')?.contains(document.activeElement));
    assert.equal(inside, true, 'التركيز بقي خارج النافذة');
    await context.close();
});

test('Escape يغلق النافذة ويفكّ قفل التمرير', async () => {
    const { page, context } = await openListAndModal(fixtures(subscription()));

    await page.keyboard.press('Escape');
    await page.waitForSelector('.subd-overlay', { state: 'detached', timeout: 5000 });

    // الحذف المباشر بلا إزالة الصنف open كان سيترك الصفحة مقفولة إلى الأبد
    assert.equal(await page.evaluate(() => document.body.style.overflow), '',
        'قفل تمرير الصفحة بقي بعد إغلاق النافذة');
    await context.close();
});

test('النقر خارج الحوار يغلق النافذة', async () => {
    const { page, context } = await openListAndModal(fixtures(subscription()));
    await page.mouse.click(8, 8);           // زاوية الطبقة المعتمة
    await page.waitForSelector('.subd-overlay', { state: 'detached', timeout: 5000 });
    await context.close();
});

test('النقر داخل الحوار لا يغلقه', async () => {
    const { page, context } = await openListAndModal(fixtures(subscription()));
    await page.locator('.subd-overlay.open .subd-dialog .subd-title').click();
    assert.equal(await page.locator('.subd-overlay.open').count(), 1, 'النافذة أُغلقت بنقرة داخلها');
    await context.close();
});

test('الإجراء داخل النافذة يذهب إلى دالة القاعدة', async () => {
    const { page, context } = await openListAndModal(
        fixtures(subscription({ status: 'active', is_active: true })));

    await page.locator('#subdDeactivate').click();
    await page.locator('.subd-confirm [data-yes]').click();   // تأكيد داخل الحوار لا confirm() المتصفح

    await page.waitForFunction(() =>
        (window.__RPC_CALLS__ || []).some(([name]) => name === 'admin_set_subscription_status'),
        null, { timeout: 5000 });

    const call = await page.evaluate(() =>
        (window.__RPC_CALLS__ || []).find(([name]) => name === 'admin_set_subscription_status'));
    assert.equal(call[1].p_status, 'expired');
    assert.equal(call[1].p_subscription_id, '55555555-5555-4555-8555-555555555555');
    await context.close();
});

test('الزر يظل رابطًا حقيقيًا لو تعطّلت الوحدة', async () => {
    // خطة بديلة مقصودة: فشل تحميل وحدة النافذة يجب ألا يترك الزر بلا أثر
    const { page, context } = await openListAndModal(fixtures(subscription()), { open: false });
    const href = await page.locator('[data-details-id]').first().getAttribute('href');
    assert.match(href, /subscription-details\.html\?id=/);
    await context.close();
});

test('النافذة لا تسبب تمريرًا أفقيًا على الموبايل', async () => {
    const { page, context } = await openListAndModal(
        fixtures(subscription()), { viewport: { width: 390, height: 844 } });
    const overflows = await page.evaluate(() =>
        document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    assert.equal(overflows, false, 'تمرير أفقي على عرض 390 والنافذة مفتوحة');
    await context.close();
});

test('النافذة تفتح من أعلى محتواها لا ممرَّرة لأسفل', async () => {
    // التركيز التلقائي على أول حقل كان يمرّر الحوار فيفتح وقد تجاوز الملخّص
    // والأرقام — واضح على الجوال. زر الإغلاق يحمل data-modal-initial-focus.
    const { page, context } = await openListAndModal(
        fixtures(subscription()), { viewport: { width: 390, height: 844 } });

    await page.waitForFunction(() =>
        document.activeElement?.hasAttribute?.('data-modal-initial-focus') === true,
        null, { timeout: 5000 });

    const scrolled = await page.evaluate(() =>
        document.querySelector('.subd-overlay .subd-body')?.scrollTop ?? 0);
    assert.equal(scrolled, 0, `النافذة فُتحت ممرَّرة ${scrolled}px لأسفل`);
    await context.close();
});

test('أزرار التذييل لا تنكسر كلماتها على الجوال', async () => {
    const { page, context } = await openListAndModal(
        fixtures(subscription()), { viewport: { width: 390, height: 844 } });

    // عدّ صناديق الأسطر لا الارتفاع: قياس مباشر لا يحتاج عتبة تُخمَّن
    // (بلا الإصلاح كان زرّان بسطرين، والعتبة الرخوة كانت تمرّرهما).
    const wrapped = await page.evaluate(() =>
        [...document.querySelectorAll('.subd-foot .subd-btn')].map((el) => {
            const range = document.createRange();
            range.selectNodeContents(el);
            return { text: el.textContent.trim(), lines: range.getClientRects().length };
        }).filter(b => b.lines > 1));

    assert.deepEqual(wrapped, [], `أزرار انكسر نصها: ${wrapped.map(b => b.text).join('، ')}`);
    await context.close();
});
