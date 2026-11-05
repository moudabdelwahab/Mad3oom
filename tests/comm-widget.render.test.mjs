/**
 * ودجت التواصل الموحّد (assets/js/comm/comm-widget.js) — عرض حقيقي في Chromium مقابل بديل Supabase.
 *
 * العزل والصلاحيات مُختبَرة في القاعدة (tests/sql/communication-engine.test.sql). هنا ما تعرضه الواجهة:
 * لا شيء لمن لا نطاق له، النطاقات حسب اللوحة، القائمة والبحث والفلاتر، المحادثة كنص لا HTML، الرد
 * والمرفقات، الأدوات حسب ما يعيده الخادم، روابط الإشعارات، العربية والإنجليزية، والهاتف.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = path.resolve(import.meta.dirname, '..');
const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png'
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

const HOST = (lang) => `<!doctype html><html lang="${lang}" dir="${lang === 'en' ? 'ltr' : 'rtl'}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>host</title></head>
<body><main id="hostMain">لوحة</main>
<script type="module">
import { mountCommWidget } from '/assets/js/comm/comm-widget.js';
window.__MOUNTED__ = await mountCommWidget({ surface: new URLSearchParams(location.search).get('surface') });
</script></body></html>`;

const USER_ID = '33333333-3333-4333-8333-333333333333';
const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';

function threadRow(over = {}) {
    return { id: T1, scope: 'company_platform', subject: 'الواتساب لا يرسل', category: 'technical', status: 'open', priority: 'normal',
             side: 'requester', company_name: 'شركة أ', counterpart_name: null, assigned_to: null, assignee_name: null,
             last_message_at: new Date().toISOString(), last_sender_side: 'responder', created_at: new Date().toISOString(),
             ticket: null, unread: true, ...over };
}

function threadDetail(over = {}) {
    return {
        ...threadRow({ unread: false }), viewer: 'requester', can_reply: true, can_internal: false, can_assign: false,
        can_close: true, can_link_ticket: true, can_attach: true,
        messages: [
            { id: 'm1', body: 'متوقف منذ الصباح', created_at: new Date().toISOString(), side: 'requester', is_internal: false, mine: true, sender_name: 'أنت', attachments: [] },
            { id: 'm2', body: '<img src=x onerror="window.__XSS__=1">نراجع الربط', created_at: new Date().toISOString(), side: 'responder', is_internal: false, mine: false, sender_name: null,
              attachments: [{ id: 'a1', name: 'log.txt', mime: 'text/plain', size: 2048, path: 'company_platform/x/a1', bucket: 'comm-attachments' }] }
        ],
        ...over
    };
}

function fixtures({ overview, threads = [], thread = null, extra = {} } = {}) {
    return {
        user: { id: USER_ID, email: 'u@example.com' },
        authUser: { id: USER_ID, email: 'u@example.com', profile: { id: USER_ID, role: 'user' } },
        rpc: {
            comm_overview: overview ?? null,
            comm_threads_list: { side: 'requester', can_start: true, permissions: {}, assignees: [], threads },
            comm_thread: thread,
            comm_post: { message_id: 'm3', thread_id: T1 },
            comm_thread_start: { thread_id: T2, scope: 'company_platform', status: 'open' },
            comm_attachment_begin: { attachment_id: 'att-1', bucket: 'comm-attachments', path: `company_platform/${T1}/att-1`, max_bytes: 10 },
            ...extra
        },
        tables: { notifications: [], profiles: [] }
    };
}

async function openHost(browser, baseUrl, fx, { surface = 'company', lang = 'ar', query = '', viewport = { width: 1280, height: 900 } } = {}) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const doubleSupabase = fs.readFileSync(path.join(ROOT, 'tests/fixtures/supabase-double.js'), 'utf8');
    await page.route('**/api-config.js', r => r.fulfill({ contentType: 'text/javascript; charset=utf-8', body: doubleSupabase }));
    await page.route('**/__comm_host.html*', r => r.fulfill({ contentType: 'text/html; charset=utf-8', body: HOST(lang) }));
    await page.route('https://fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
    await page.addInitScript(data => { window.__FIXTURES__ = data; }, fx);
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${baseUrl}/__comm_host.html?surface=${surface}${query}`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__MOUNTED__ !== undefined, null, { timeout: 10000 });
    return { page, context, errors };
}

const rpcArgs = (page, name) => page.evaluate(n => (window.__RPC_ARGS__ || []).filter(([k]) => k === n).map(([, a]) => a), name);

let browser, server, baseUrl;
const chromiumPath = resolveChromium();
if (!chromiumPath) console.error('SKIP: لا يوجد متصفح Chromium متاح؛ اختبارات عرض ودجت التواصل لم تُنفَّذ');

test.before(async () => {
    if (!chromiumPath) return;
    server = await startServer();
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: chromiumPath });
});
test.after(async () => { await browser?.close(); server?.close(); });

const OVERVIEW = {
    scopes: { company_platform: { side: 'requester', can_start: true, open: 1, unread: 2 },
              customer_company: { side: 'responder', can_start: false, open: 0, unread: 1 },
              admin_owner: { side: 'requester', can_start: true, open: 0, unread: 5 } },
    attachments: true
};

test('لا نطاق متاح ⇒ لا ودجت إطلاقًا', { skip: !chromiumPath }, async () => {
    for (const overview of [null, { scopes: {}, attachments: false }]) {
        const { page, context, errors } = await openHost(browser, baseUrl, fixtures({ overview }));
        assert.equal(await page.evaluate(() => window.__MOUNTED__), false);
        assert.equal(await page.locator('#commWidget').count(), 0);
        assert.deepEqual(errors, []);
        await context.close();
    }
});

test('البوابة لا تعرض التواصل الداخلي حتى لو أعطاه الخادم؛ لوحة الشركة تعرض نطاقيها', { skip: !chromiumPath }, async () => {
    let { page, context } = await openHost(browser, baseUrl, fixtures({ overview: OVERVIEW }), { surface: 'portal' });
    assert.equal(await page.locator('#commWidget').count(), 1);
    await page.locator('#commLauncher').click();
    assert.equal(await page.locator('.mcw-tab').count(), 1);
    assert.equal(await page.locator('#commTabs').isHidden(), true, 'نطاق واحد: لا شريط تبويبات');
    assert.equal(await page.locator('#commBadge, .mcw-launcher .mcw-badge').count(), 0, 'اللوحة مفتوحة: الزر مخفي');
    await context.close();

    ({ page, context } = await openHost(browser, baseUrl, fixtures({ overview: OVERVIEW }), { surface: 'company' }));
    // الشارة: غير المقروء في نطاقي هذه اللوحة فقط (2 + 1)، لا الخمسة الداخلية
    assert.equal(await page.locator('.mcw-launcher .mcw-badge').textContent(), '3');
    await page.locator('#commLauncher').click();
    const tabs = await page.locator('.mcw-tab').evaluateAll(els => els.map(e => e.dataset.scope));
    assert.deepEqual(tabs, ['company_platform', 'customer_company']);
    await context.close();
});

test('القائمة، والمحادثة نصًا لا HTML، والرد بالمرفق', { skip: !chromiumPath }, async () => {
    const fx = fixtures({ overview: OVERVIEW, threads: [threadRow()], thread: threadDetail() });
    const { page, context, errors } = await openHost(browser, baseUrl, fx);
    await page.locator('#commLauncher').click();
    await page.waitForSelector('.mcw-item');
    assert.equal(await page.locator('.mcw-item').getAttribute('data-unread'), 'true');
    assert.match(await page.locator('.mcw-item').textContent(), /الواتساب لا يرسل/);
    assert.equal(await page.locator('#commNewBtn').count(), 1, 'الطالب يبدأ محادثة');

    await page.locator('.mcw-item').click();
    await page.waitForSelector('.mcw-msg');
    assert.equal(await page.locator('.mcw-msg').count(), 2);
    // محتوى المستخدم نص: لا عنصر img ولا تنفيذ
    assert.equal(await page.locator('.mcw-msg img').count(), 0);
    assert.equal(await page.evaluate(() => window.__XSS__), undefined);
    assert.match(await page.locator('.mcw-msg').nth(1).textContent(), /<img src=x/);
    // الطرف الآخر بصوت واحد للطالب
    assert.match(await page.locator('.mcw-msg').nth(1).locator('.mcw-msg-who').textContent(), /إدارة مدعوم/);
    assert.match(await page.locator('.mcw-file').textContent(), /log\.txt.*2\.0 KB/);
    // الأدوات حسب ما أعاده الخادم: لا ملاحظة داخلية ولا إسناد للطالب، والتحويل إلى تذكرة متاح
    assert.equal(await page.locator('#commInternal').count(), 0);
    assert.equal(await page.locator('#commActions select').count(), 0);
    assert.equal(await page.locator('#commToTicket').count(), 1);

    // رسالة فارغة بلا مرفق: خطأ واضح بلا نداء
    await page.locator('#commComposerForm button[type="submit"]').click();
    assert.equal(await page.locator('#commComposerForm .mcw-form-error').isHidden(), false);
    assert.equal((await rpcArgs(page, 'comm_post')).length, 0);

    // ملف غير مسموح يُرفض في الواجهة؛ المسموح يُحجز ويُرسل معرّفه
    await page.setInputFiles('#commFile', { name: 'virus.exe', mimeType: 'application/x-msdownload', buffer: Buffer.from('MZ') });
    assert.equal(await page.locator('.mcw-pending-item').count(), 0);
    await page.setInputFiles('#commFile', { name: 'screen.png', mimeType: 'image/png', buffer: Buffer.from('png') });
    assert.equal(await page.locator('.mcw-pending-item').count(), 1);
    await page.locator('#commReply').fill('هذه لقطة الشاشة');
    await page.locator('#commComposerForm button[type="submit"]').click();
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'comm_post'));
    const [begin] = await rpcArgs(page, 'comm_attachment_begin');
    assert.deepEqual([begin.p_scope, begin.p_thread, begin.p_name, begin.p_mime], ['company_platform', T1, 'screen.png', 'image/png']);
    const [post] = await rpcArgs(page, 'comm_post');
    assert.deepEqual([post.p_scope, post.p_thread, post.p_body, post.p_internal, post.p_attachments],
        ['company_platform', T1, 'هذه لقطة الشاشة', false, ['att-1']]);
    assert.deepEqual(errors, []);
    await context.close();
});

test('المجيب: ملاحظة داخلية وإسناد وإغلاق — والمحادثة المغلقة بلا محرّر', { skip: !chromiumPath }, async () => {
    const overview = { scopes: { company_platform: { side: 'responder', can_start: false, open: 1, unread: 0 } }, attachments: false };
    const fx = fixtures({
        overview,
        threads: [threadRow({ side: 'responder', counterpart_name: 'مالك أ', unread: false })],
        thread: threadDetail({ side: 'responder', viewer: 'responder', counterpart_name: 'مالك أ', can_internal: true, can_assign: true,
                               can_link_ticket: false, can_attach: true }),
        extra: { comm_threads_list: { side: 'responder', can_start: false, permissions: { assign: true },
                                      assignees: [{ id: 'staff-1', name: 'دعم' }], threads: [threadRow({ side: 'responder', unread: false })] } }
    });
    const { page, context } = await openHost(browser, baseUrl, fx, { surface: 'admin' });
    await page.locator('#commLauncher').click();
    assert.equal(await page.locator('#commNewBtn').count(), 0, 'المجيب لا يبدأ');
    assert.deepEqual(await page.locator('.mcw-chip').allTextContents(), ['المفتوحة', 'المسندة إليّ', 'غير المسندة', 'المغلقة', 'الكل']);
    await page.locator('.mcw-chip', { hasText: 'غير المسندة' }).click();
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n, a]) => n === 'comm_threads_list' && a.p_filter === 'unassigned'));
    await page.waitForSelector('.mcw-item');
    await page.locator('.mcw-item').click();
    await page.waitForSelector('.mcw-msg');
    assert.equal(await page.locator('#commInternal').count(), 1);
    assert.equal(await page.locator('#commToTicket').count(), 0);
    // المرفقات مطفأة في الخادم: لا زر إرفاق رغم can_attach
    assert.equal(await page.locator('#commComposerForm .mcw-iconbtn').count(), 0);
    await page.locator('#commActions select').selectOption('staff-1');
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'comm_thread_assign'));
    assert.deepEqual((await rpcArgs(page, 'comm_thread_assign'))[0], { p_scope: 'company_platform', p_thread: T1, p_assignee: 'staff-1' });
    await page.locator('#commReply').fill('ملاحظة للفريق');
    await page.locator('#commInternal').check();
    await page.locator('#commComposerForm button[type="submit"]').click();
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'comm_post'));
    assert.equal((await rpcArgs(page, 'comm_post'))[0].p_internal, true);
    await context.close();

    // مغلقة للمجيب: تلميح بدل المحرّر
    const fx2 = fixtures({ overview, threads: [threadRow({ side: 'responder', status: 'closed' })],
                           thread: threadDetail({ side: 'responder', status: 'closed', can_reply: false }) });
    const second = await openHost(browser, baseUrl, fx2, { surface: 'admin' });
    await second.page.locator('#commLauncher').click();
    await second.page.waitForSelector('.mcw-item');
    await second.page.locator('.mcw-item').click();
    await second.page.waitForSelector('.mcw-hint');
    assert.match(await second.page.locator('.mcw-hint').textContent(), /مغلقة/);
    assert.equal(await second.page.locator('#commComposerForm').count(), 0);
    assert.match(await second.page.locator('#commActions').textContent(), /إعادة الفتح/);
    await second.context.close();
});

test('محادثة جديدة: التحقق قبل الإرسال ثم فتحها', { skip: !chromiumPath }, async () => {
    const fx = fixtures({ overview: OVERVIEW, threads: [], thread: threadDetail({ id: T2, subject: 'فاتورة مكررة', messages: [] }) });
    const { page, context } = await openHost(browser, baseUrl, fx);
    await page.locator('#commLauncher').click();
    await page.waitForSelector('.mcw-state');
    assert.match(await page.locator('.mcw-state').textContent(), /لا توجد محادثات/);
    await page.locator('#commNewBtn').click();
    await page.locator('#commSubject').fill('ab');
    await page.locator('#commStartSubmit').click();
    assert.equal(await page.locator('[data-error-for="subject"]').isHidden(), false);
    assert.equal(await page.locator('[data-error-for="category"]').isHidden(), false);
    assert.equal((await rpcArgs(page, 'comm_thread_start')).length, 0);
    await page.locator('#commSubject').fill('فاتورة مكررة');
    await page.locator('#commCategory').selectOption('billing');
    await page.locator('#commPriority').selectOption('high');
    await page.locator('#commMessage').fill('خُصم المبلغ مرتين');
    await page.locator('#commStartSubmit').click();
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'comm_thread_start'));
    const [start] = await rpcArgs(page, 'comm_thread_start');
    assert.deepEqual([start.p_scope, start.p_category, start.p_subject, start.p_body, start.p_priority],
        ['company_platform', 'billing', 'فاتورة مكررة', 'خُصم المبلغ مرتين', 'high']);
    assert.match(start.p_idempotency_key, /^[0-9a-f-]{36}$/);
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n, a]) => n === 'comm_thread' && a.p_thread === '22222222-2222-4222-8222-222222222222'));
    await context.close();
});

test('رفض الخادم يظهر رسالة مفهومة، والقائمة الفاشلة تعرض إعادة المحاولة', { skip: !chromiumPath }, async () => {
    const fx = fixtures({ overview: OVERVIEW, extra: {} });
    fx.rpcErrors = { comm_threads_list: { message: 'هذا النوع من التواصل غير مفعّل', code: '0A000' } };
    const { page, context } = await openHost(browser, baseUrl, fx);
    await page.locator('#commLauncher').click();
    await page.waitForSelector('.mcw-state-error');
    assert.match(await page.locator('.mcw-state-error').textContent(), /غير مفعّلة بعد/);
    assert.equal(await page.locator('.mcw-state-error button').count(), 1);
    await context.close();
});

test('رابط الإشعار ?comm= يفتح النطاق، والإنجليزية LTR', { skip: !chromiumPath }, async () => {
    const { page, context } = await openHost(browser, baseUrl, fixtures({ overview: OVERVIEW, threads: [threadRow()] }),
        { surface: 'company', lang: 'en', query: '&comm=customer_company' });
    assert.equal(await page.locator('#commWidget').getAttribute('data-open'), 'true');
    assert.equal(await page.locator('#commWidget').getAttribute('dir'), 'ltr');
    assert.equal(await page.locator('.mcw-tab[aria-selected="true"]').getAttribute('data-scope'), 'customer_company');
    assert.equal(await page.locator('.mcw-title').textContent(), 'Customer messages');
    // تبديل اللغة يعيد الرسم
    await page.evaluate(() => { document.documentElement.lang = 'ar'; document.documentElement.dir = 'rtl'; });
    await page.waitForFunction(() => document.querySelector('.mcw-title')?.textContent === 'رسائل العملاء');
    assert.equal(await page.locator('#commWidget').getAttribute('dir'), 'rtl');
    // Escape يغلق ويعيد التركيز للزر
    await page.locator('#commPanel').press('Escape');
    assert.equal(await page.locator('#commWidget').getAttribute('data-open'), 'false');
    await context.close();
});

test('الهاتف: اللوحة بكامل الشاشة بلا تمرير أفقي', { skip: !chromiumPath }, async () => {
    const { page, context } = await openHost(browser, baseUrl, fixtures({ overview: OVERVIEW, threads: [threadRow()] }),
        { viewport: { width: 375, height: 740 } });
    const launcher = await page.locator('#commLauncher').boundingBox();
    assert.ok(launcher.width >= 44 && launcher.height >= 44, 'هدف لمس ≥ 44px');
    await page.locator('#commLauncher').click();
    await page.waitForSelector('.mcw-item');
    const box = await page.locator('#commPanel').boundingBox();
    assert.equal(Math.round(box.width), 375);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await context.close();
});
