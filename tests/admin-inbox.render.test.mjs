/**
 * اختبارات عرض صندوق الرسائل (admin/inbox.html) في متصفح حقيقي.
 *
 * الصندوق بقى واجهة الإدارة الوحيدة لشات العملاء بعد شيل chat-admin.html،
 * فالاختبارات دي بتشغّل الكود الحقيقي (inbox.js + inbox-data.js +
 * page-guard) على بديل Supabase بصفوف بنفس شكل chat_sessions / chat_messages،
 * وبتتأكد من:
 *   - المحادثات والرسايل الحقيقية بتتعرض (العميل / البوت / الدعم).
 *   - الرابط المباشر ?session= (اللي إشعارات القاعدة بتكتبه) بيفتح المحادثة.
 *   - رد الدعم بيتكتب بنفس عقد الويدجت: is_manual_mode ثم is_admin_reply.
 *   - المحادثة المقفولة مابتقبلش رد.
 *   - الصفحة مقفولة على الطاقم.
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
const S_BOT = 'aaaaaaaa-0000-4000-8000-000000000001';
const S_MANUAL = 'aaaaaaaa-0000-4000-8000-000000000002';
const S_CLOSED = 'aaaaaaaa-0000-4000-8000-000000000003';
const S_STAFF = 'aaaaaaaa-0000-4000-8000-000000000004';

const t = (min) => new Date(Date.UTC(2026, 8, 25, 9, min)).toISOString();
const msg = (id, session_id, min, text, kind, sender_id = null) => ({
    id, session_id, message_text: text, created_at: t(min), image_url: null,
    sender_id: kind === 'bot' ? null : sender_id,
    is_admin_reply: kind === 'agent', is_bot_reply: kind === 'bot'
});

function fixtures({ role = 'admin' } = {}) {
    const sessions = [
        {
            id: S_BOT, user_id: 'u-sara', guest_id: null, status: 'active', is_manual_mode: false,
            created_at: t(0), updated_at: t(5),
            profiles: { full_name: 'سارة إبراهيم', email: 'sara@test.local', role: 'customer', phone: null, created_at: t(0) },
            chat_messages: [
                msg('m2', S_BOT, 2, 'عندي مشكلة في الاشتراك', 'customer', 'u-sara'),
                msg('m1', S_BOT, 1, 'أهلاً بيك [[icon:inquiry]] اختار من الاختيارات', 'bot')
            ]
        },
        {
            id: S_MANUAL, user_id: 'u-karim', guest_id: null, status: 'active', is_manual_mode: true,
            created_at: t(10), updated_at: t(20),
            profiles: { full_name: 'كريم مصطفى', email: 'karim@test.local', role: 'customer', phone: '0100', created_at: t(0) },
            chat_messages: [
                msg('m3', S_MANUAL, 11, 'محتاج حد من الدعم', 'customer', 'u-karim'),
                msg('m4', S_MANUAL, 12, 'معاك هبة من الدعم', 'agent', 'staff-2'),
                msg('m5', S_MANUAL, 13, 'تمام شكراً', 'customer', 'u-karim')
            ]
        },
        {
            id: S_CLOSED, user_id: 'u-nour', guest_id: null, status: 'closed', is_manual_mode: true,
            created_at: t(1), updated_at: t(3),
            profiles: { full_name: 'نورهان علي', email: 'nour@test.local', role: 'customer', phone: null, created_at: t(0) },
            chat_messages: [msg('m6', S_CLOSED, 2, 'اتحلت', 'customer', 'u-nour')]
        },
        {
            id: S_STAFF, user_id: 'u-staff', guest_id: null, status: 'active', is_manual_mode: false,
            created_at: t(0), updated_at: t(0),
            profiles: { full_name: 'موظف دعم', email: 'staff@test.local', role: 'support', phone: null, created_at: t(0) },
            chat_messages: [msg('m7', S_STAFF, 0, 'تجربة من حسابي', 'customer', 'u-staff')]
        }
    ];
    return {
        user: { id: ADMIN, email: 'admin@test.local' },
        authUser: { id: ADMIN, email: 'admin@test.local', profile: { id: ADMIN, role } },
        tables: {
            chat_sessions: sessions,
            chat_messages: [],
            profiles: [
                { id: ADMIN, email: 'admin@test.local', role, full_name: 'الأدمن' },
                { id: 'staff-2', email: 'heba@test.local', role: 'support', full_name: 'هبة سمير' }
            ],
            canned_responses: [{ id: 'c1', title: 'ترحيب', shortcut: 'ترحيب', content: 'أهلاً {{الاسم}}، إزاي أساعدك؟' }]
        }
    };
}

let browser, server, baseUrl;
const chromiumPath = resolveChromium();
if (!chromiumPath) console.error('SKIP: لا يوجد متصفح Chromium متاح؛ اختبارات صندوق الرسائل لم تُنفَّذ');

test.before(async () => {
    if (!chromiumPath) return;
    server = await startServer();
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: chromiumPath });
});
test.after(async () => { await browser?.close(); server?.close(); });

async function openInbox(fx, { query = '', viewport } = {}) {
    const context = await browser.newContext({ viewport: viewport || { width: 1400, height: 900 } });
    const page = await context.newPage();

    const doubleSupabase = fs.readFileSync(path.join(ROOT, 'tests/fixtures/supabase-double.js'), 'utf8');
    const doubleAuth = fs.readFileSync(path.join(ROOT, 'tests/fixtures/auth-client-double.js'), 'utf8');
    await page.route('**/api-config.js', r => r.fulfill({ contentType: 'text/javascript; charset=utf-8', body: doubleSupabase }));
    await page.route('**/auth-client.js', r => r.fulfill({ contentType: 'text/javascript; charset=utf-8', body: doubleAuth }));
    await page.route('https://fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
    await page.addInitScript(data => { window.__FIXTURES__ = data; }, fx);

    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto(`${baseUrl}/admin/inbox.html${query}`, { waitUntil: 'networkidle' });
    return { page, context, errors };
}

test('المحادثات الحقيقية بتتعرض، ومحادثة الفريق فوق', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openInbox(fixtures());
    await page.waitForSelector('.ib-row');

    const titles = await page.locator('.ib-row-title').allInnerTexts();
    assert.equal(titles.length, 4);
    assert.equal(titles[0], 'موظف دعم', 'محادثة الفريق مش فوق');
    assert.deepEqual(titles.slice(1), ['كريم مصطفى', 'سارة إبراهيم', 'نورهان علي'], 'الترتيب مش بالأحدث');

    const text = await page.locator('#convList').innerText();
    for (const tag of ['فريق العمل', 'الدعم ماسكها', 'البوت', 'مقفولة', 'بانتظار رد']) {
        assert.ok(text.includes(tag), `الوسم «${tag}» مش ظاهر`);
    }
    // مفيش بيانات المعاينة القديمة
    assert.ok(!/محمود عبدالوهاب|example\.com|تجريبية/.test(await page.evaluate(() => document.body.innerText)));

    // عدّاد «بانتظار رد»: سارة (البوت مارديش) + كريم (الدعم ماسكها والعميل آخر واحد) + موظف الدعم
    const awaiting = await page.locator('[data-view="awaiting"] .ib-view-count').innerText();
    assert.equal(awaiting, '3');

    assert.deepEqual(errors, []);
    await context.close();
});

test('رابط الإشعار ?session= بيفتح المحادثة برسايلها ومين كاتبها', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openInbox(fixtures(), { query: `?session=${S_MANUAL}` });
    await page.waitForSelector('.ib-msg');

    assert.equal(await page.locator('#threadTitle').innerText(), 'كريم مصطفى');
    assert.equal(await page.locator('.ib-msg--theirs').count(), 2, 'رسايل العميل');
    assert.equal(await page.locator('.ib-msg--mine').count(), 1, 'رد الدعم');
    // اسم الموظف اللي رد جاي من profiles، مش مكتوب في الكود
    await page.waitForFunction(() => document.querySelector('.ib-msg--mine .ib-sender')?.textContent === 'هبة سمير');
    assert.match(await page.locator('#composerNote').innerText(), /البوت واقف/);

    assert.deepEqual(errors, []);
    await context.close();
});

test('الرابط القديم ?session_id= (سجل العميل) بيفتح نفس المحادثة', { skip: !chromiumPath }, async () => {
    const { page, context } = await openInbox(fixtures(), { query: `?session_id=${S_BOT}` });
    await page.waitForSelector('.ib-msg');
    assert.equal(await page.locator('#threadTitle').innerText(), 'سارة إبراهيم');
    // رد البوت بيتعرض كبوت، ورموز [[icon:…]] بتتحول لأيقونة مش نص خام
    assert.equal(await page.locator('.ib-msg--bot').count(), 1);
    assert.ok(!(await page.locator('.ib-msg--bot').innerText()).includes('[[icon:'));
    assert.equal(await page.locator('.ib-msg--bot svg').count(), 1);
    await context.close();
});

test('رد الدعم بيوقّف البوت الأول، وبعدين بيتكتب كرد أدمن', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openInbox(fixtures(), { query: `?session=${S_BOT}` });
    await page.waitForSelector('.ib-msg');
    assert.match(await page.locator('#composerNote').innerText(), /البوت شغال/);

    await page.fill('#messageInput', 'أهلاً سارة، معاكي الدعم');
    await page.press('#messageInput', 'Enter');
    await page.waitForSelector('.ib-msg--mine');

    const writes = await page.evaluate(() => window.__WRITES__);
    assert.deepEqual(writes.map(w => `${w.op}:${w.table}`), ['update:chat_sessions', 'insert:chat_messages']);
    assert.deepEqual(writes[0].row, { is_manual_mode: true });
    assert.deepEqual(writes[1].row, {
        session_id: S_BOT, sender_id: ADMIN, message_text: 'أهلاً سارة، معاكي الدعم', is_admin_reply: true
    });

    assert.equal(await page.locator('.ib-msg--mine .ib-sender').innerText(), 'أنت');
    assert.equal(await page.inputValue('#messageInput'), '');
    assert.match(await page.locator('#composerNote').innerText(), /البوت واقف/);
    assert.deepEqual(errors, []);
    await context.close();
});

test('الرد الجاهز من canned_responses بيتملي باسم العميل', { skip: !chromiumPath }, async () => {
    const { page, context } = await openInbox(fixtures(), { query: `?session=${S_BOT}` });
    await page.waitForSelector('.ib-msg');
    await page.fill('#messageInput', '/تر');
    await page.dispatchEvent('#messageInput', 'input');
    await page.waitForSelector('.ib-pop-item');
    await page.click('.ib-pop-item');
    assert.equal(await page.inputValue('#messageInput'), 'أهلاً سارة إبراهيم، إزاي أساعدك؟');
    await context.close();
});

test('المحادثة المقفولة مابتقبلش رد', { skip: !chromiumPath }, async () => {
    const { page, context } = await openInbox(fixtures(), { query: `?session=${S_CLOSED}` });
    await page.waitForSelector('.ib-msg');
    assert.equal(await page.locator('#composer').isVisible(), false, 'شريط الكتابة ظاهر في محادثة مقفولة');
    assert.equal(await page.locator('#closedNote').isVisible(), true);
    assert.equal(await page.locator('#closeSessionBtn').isVisible(), false);
    await context.close();
});

test('إقفال المحادثة بيكتب status = closed', { skip: !chromiumPath }, async () => {
    const { page, context } = await openInbox(fixtures(), { query: `?session=${S_MANUAL}` });
    await page.waitForSelector('.ib-msg');
    page.once('dialog', d => d.accept());
    await page.click('#closeSessionBtn');
    await page.waitForSelector('#closedNote:not([hidden])');
    const writes = await page.evaluate(() => window.__WRITES__);
    assert.deepEqual(writes.at(-1), { op: 'update', table: 'chat_sessions', row: { status: 'closed' } });
    await context.close();
});

test('الموبايل: القايمة الأول، والمحادثة مكانها، وزرار الرجوع بيرجّع', { skip: !chromiumPath }, async () => {
    const { page, context } = await openInbox(fixtures(), { viewport: { width: 390, height: 800 } });
    await page.waitForSelector('.ib-row');
    assert.equal(await page.locator('.ib-thread-pane').isVisible(), false);

    await page.locator('.ib-row').nth(1).click();
    await page.waitForSelector('.ib-msg');
    assert.equal(await page.locator('.ib-list-pane').isVisible(), false);
    assert.equal(await page.locator('.ib-thread-pane').isVisible(), true);

    await page.click('#backBtn');
    assert.equal(await page.locator('.ib-list-pane').isVisible(), true);
    await context.close();
});

test('الصفحة مقفولة على الطاقم — السوبر يوزر مابيشوفش محادثات', { skip: !chromiumPath }, async () => {
    const { page, context } = await openInbox(fixtures({ role: 'super_user' }));
    await page.waitForSelector('#accessDeniedPanel', { timeout: 10000 });
    assert.equal(await page.locator('.ib-row').count(), 0);
    await context.close();
});
