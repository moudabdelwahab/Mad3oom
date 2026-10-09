/**
 * اختبارات عرض مساحة العمل (admin/workspace.html) في متصفح حقيقي.
 *
 * تشغّل الكود الحقيقي كله — مساحة العمل نفسها والصفحات المضمّنة فيها
 * (inbox.js، tickets.js، customer-history.js) — على بديل Supabase، وتتأكد من:
 *   - التبويبات حقيقية: كل تبويب صفحة قائمة في وضع التضمين، بلا شريطها وقائمتها.
 *   - السحب للحواف والتقسيم المتداخل وتغيير الحجم، في RTL وLTR.
 *   - نقل التبويب لا يعيد تحميل إطاره: نفس الصفحة ونفس الرد المكتوب.
 *   - لا إغلاق فوق كلام لم يُرسل بلا تأكيد، ولا إرسال من مساحة العمل إطلاقًا.
 *   - الاستعادة بعد التحديث، ورفض الترتيب المعطوب، وإعادة التحقق من الوصول.
 *   - الروابط بين اللوحات، ورسائل الإطارات المزيفة تُتجاهل.
 *   - لوحة المفاتيح، والشاشة الصغيرة، والأدوار غير المسموحة.
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
const KEY = `mad3oom.workspace.v1.${ADMIN}`;
const KARIM = 'cccccccc-0000-4000-8000-000000000001';
const SARA = 'cccccccc-0000-4000-8000-000000000002';
const S_KARIM = 'aaaaaaaa-0000-4000-8000-000000000001';
const S_SARA = 'aaaaaaaa-0000-4000-8000-000000000002';
const S_GONE = 'aaaaaaaa-0000-4000-8000-0000000000ff';
const T_KARIM = 'bbbbbbbb-0000-4000-8000-000000000001';
const t = (min) => new Date(Date.UTC(2026, 8, 25, 9, min)).toISOString();

function fixtures({ role = 'admin' } = {}) {
    const msg = (id, session_id, min, text, kind, sender_id) => ({
        id, session_id, message_text: text, created_at: t(min), image_url: null,
        sender_id: kind === 'bot' ? null : sender_id, is_admin_reply: kind === 'agent', is_bot_reply: kind === 'bot'
    });
    return {
        user: { id: ADMIN, email: 'admin@test.local' },
        authUser: { id: ADMIN, email: 'admin@test.local', profile: { id: ADMIN, role, full_name: 'الأدمن' } },
        tables: {
            chat_sessions: [
                { id: S_KARIM, user_id: KARIM, guest_id: null, status: 'active', is_manual_mode: true, created_at: t(0), updated_at: t(20),
                  chat_messages: [msg('m1', S_KARIM, 11, 'محتاج حد من الدعم', 'customer', KARIM)] },
                { id: S_SARA, user_id: SARA, guest_id: null, status: 'active', is_manual_mode: false, created_at: t(0), updated_at: t(5),
                  chat_messages: [msg('m2', S_SARA, 2, 'عندي مشكلة في الاشتراك', 'customer', SARA)] }
            ],
            chat_messages: [],
            tickets: [{
                id: T_KARIM, user_id: KARIM, ticket_number: 412, title: 'مشكلة ربط', description: 'الربط بيفصل',
                status: 'open', priority: 'medium', category: 'other', created_at: t(0),
                profiles: { full_name: 'كريم مصطفى', email: 'karim@test.local', id: KARIM }
            }],
            profiles: [
                { id: KARIM, full_name: 'كريم مصطفى', email: 'karim@test.local', role: 'user', phone: null, created_at: t(0) },
                { id: SARA, full_name: 'سارة إبراهيم', email: 'sara@test.local', role: 'user', phone: null, created_at: t(0) }
            ]
        },
        rpc: {
            inbox_customer_profiles: [
                { session_id: S_KARIM, user_id: KARIM, full_name: 'كريم مصطفى', email: 'karim@test.local', role: 'user', phone: null, created_at: t(0) },
                { session_id: S_SARA, user_id: SARA, full_name: 'سارة إبراهيم', email: 'sara@test.local', role: 'user', phone: null, created_at: t(0) }
            ],
            inbox_list_agents: [{ id: ADMIN, full_name: 'الأدمن', email: 'admin@test.local', role, is_elevated: true, team_ids: [] }]
        }
    };
}

/** ترتيب محفوظ بنفس شكل serializeLayout(). */
function savedLayout(root, panels, { activeGroup = null, seq = 50 } = {}) {
    return { version: 1, root, panels, activeGroup, seq };
}
const group = (id, tabs, active = tabs[0]) => ({ kind: 'group', id, tabs, active });
const panel = (id, type, params = {}) => ({ id, type, params });

let browser, server, baseUrl;
const chromiumPath = resolveChromium();
if (!chromiumPath) console.error('SKIP: لا يوجد متصفح Chromium متاح؛ اختبارات مساحة العمل لم تُنفَّذ');

test.before(async () => {
    if (!chromiumPath) return;
    server = await startServer();
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: chromiumPath });
});
test.after(async () => { await browser?.close(); server?.close(); });

/**
 * @param {object} fx
 * @param {{viewport?, local?: object, lang?: string, init?: Function}} options
 *        local: ترتيب يُزرع في localStorage مرة واحدة قبل أول تحميل (لا عند التحديث).
 */
async function openWorkspace(fx, { viewport = { width: 1500, height: 900 }, local = null, lang = null, init = null } = {}) {
    const context = await browser.newContext({ viewport });
    const doubleSupabase = fs.readFileSync(path.join(ROOT, 'tests/fixtures/supabase-double.js'), 'utf8');
    const doubleAuth = fs.readFileSync(path.join(ROOT, 'tests/fixtures/auth-client-double.js'), 'utf8');
    await context.route('**/api-config.js', r => r.fulfill({ contentType: 'text/javascript; charset=utf-8', body: doubleSupabase }));
    await context.route('**/auth-client.js', r => r.fulfill({ contentType: 'text/javascript; charset=utf-8', body: doubleAuth }));
    await context.route('https://fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
    // tickets.js يستورد خدمة شحن المحفظة من نطاق واتساب — بديل بنفس الأسماء.
    await context.route('https://wa.mad3oom.com/**', r => r.fulfill({ contentType: 'text/javascript',
        body: 'export async function confirmWalletTopupTicket() {} export async function rejectWalletTopupTicket() {}' }));
    await context.addInitScript(data => { window.__FIXTURES__ = data; }, fx);
    await context.addInitScript(({ key, local, lang }) => {
        if (window !== window.top || sessionStorage.getItem('__seeded')) return;
        sessionStorage.setItem('__seeded', '1');
        if (local) localStorage.setItem(key, JSON.stringify({ savedAt: 1, layout: local }));
        if (lang) localStorage.setItem('mad3oom-language', lang);
    }, { key: KEY, local, lang });
    if (init) await context.addInitScript(init);

    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(`${baseUrl}/admin/workspace.html`, { waitUntil: 'networkidle' });
    await page.waitForSelector('html[data-workspace-ready="true"]');
    return { page, context, errors };
}

const stored = (page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k))?.layout ?? null, KEY);
const tabTitles = (page) => page.locator('.ws-tab .ws-tab-title').allInnerTexts();

async function frameFor(page, part) {
    for (let i = 0; i < 100; i++) {
        const frame = page.frames().find(f => f.url().includes(part));
        if (frame) return frame;
        await page.waitForTimeout(50);
    }
    throw new Error(`لا إطار يحتوي ${part}`);
}

/** يسحب تبويبًا بالفأرة ويفلته عند نسبة (fx, fy) من جسم المجموعة الهدف. */
async function dragTab(page, tabText, targetGroup, fx, fy) {
    const tab = await page.locator('.ws-tab', { hasText: tabText }).boundingBox();
    const body = await targetGroup.locator('.ws-group-body').boundingBox();
    await page.mouse.move(tab.x + tab.width / 2, tab.y + tab.height / 2);
    await page.mouse.down();
    await page.mouse.move(tab.x + tab.width / 2 + 12, tab.y + tab.height / 2 + 12, { steps: 3 });
    await page.mouse.move(body.x + body.width * fx, body.y + body.height * fy, { steps: 8 });
    await page.mouse.up();
}

async function quickOpen(page, query, pick, { side = false } = {}) {
    await page.keyboard.press('Control+KeyK');
    await page.locator('.ws-quick-input').fill(query);
    const item = page.locator('.ws-quick-item', { hasText: pick }).first();
    await item.waitFor();
    if (side) await item.click({ modifiers: ['Control'] }); else await item.click();
}

/* ====================  الأساس  ==================== */

test('أول زيارة: الصندوق والتذاكر جنبًا إلى جنب، صفحات حقيقية بلا شريطها وقائمتها', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openWorkspace(fixtures());
    assert.deepEqual(await tabTitles(page), ['صندوق الرسائل', 'التذاكر']);
    assert.equal(await page.locator('.ws-group').count(), 2);
    assert.equal(await page.locator('.ws-divider[role="separator"]').count(), 1);

    // RTL: المجموعة الأولى (البداية) على اليمين
    const [first, second] = await page.locator('.ws-group').evaluateAll(gs => gs.map(g => g.getBoundingClientRect().left));
    assert.ok(first > second, 'البداية ليست يمينًا في RTL');

    const inbox = await frameFor(page, '/admin/inbox.html?embed=1');
    await inbox.waitForSelector('.ib-row');
    assert.deepEqual(await inbox.evaluate(() => [
        document.documentElement.classList.contains('ws-embedded'),
        !!document.querySelector('.admin-nav'),
        getComputedStyle(document.querySelector('.page-header')).display
    ]), [true, false, 'none'], 'الصفحة المضمّنة ما زالت تعرض إطارها العام');
    const tickets = await frameFor(page, '/admin/tickets.html?embed=1');
    await tickets.waitForSelector('.ticket-card');

    // الإطارات فوق أجسام مجموعاتها بالضبط
    for (const g of await page.locator('.ws-group').all()) {
        const body = await g.locator('.ws-group-body').boundingBox();
        const panelId = await g.locator('.ws-tab.is-active').getAttribute('data-panel');
        const frame = await page.locator(`.ws-frame[data-panel="${panelId}"]`).boundingBox();
        assert.ok(Math.abs(frame.x - body.x) < 1 && Math.abs(frame.width - body.width) < 1 && Math.abs(frame.height - body.height) < 1);
    }

    const saved = await stored(page);
    assert.equal(saved.root.kind, 'split');
    assert.deepEqual(Object.values(saved.panels).map(p => p.type).sort(), ['inbox', 'tickets']);
    assert.deepEqual(errors, []);
    await context.close();
});

test('الفتح السريع: محادثة كتبويب بعنوان العميل، والمحادثة نفسها مرة ثانية لا تكرر التبويب', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openWorkspace(fixtures());
    await quickOpen(page, 'كريم', 'كريم مصطفى');
    const conv = await frameFor(page, 'view=thread');
    assert.ok(conv.url().endsWith(`/admin/inbox.html?embed=1&view=thread&session=${S_KARIM}`));
    await conv.waitForSelector('.ib-msg');
    // عرض محادثة واحدة: لا رف ولا قائمة
    assert.deepEqual(await conv.evaluate(() => ['.ib-rail', '.ib-list-pane'].map(s => getComputedStyle(document.querySelector(s)).display)),
        ['none', 'none']);
    await page.waitForFunction(() => [...document.querySelectorAll('.ws-tab-title')].some(t => t.textContent === 'كريم مصطفى'));

    await quickOpen(page, 'كريم', 'كريم مصطفى');
    await page.waitForTimeout(150);
    assert.equal(await page.locator('.ws-tab', { hasText: 'كريم مصطفى' }).count(), 1, 'تبويب مكرر');
    assert.equal(await page.locator('.ws-frame').count(), 3);
    assert.deepEqual(errors, []);
    await context.close();
});

/* ====================  السحب والإرساء وسلامة المسودة  ==================== */

test('سحب التبويب لحافة لوحة يقسّمها، والإطار لا يُعاد تحميله: نفس الصفحة ونفس الرد المكتوب', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openWorkspace(fixtures());
    await quickOpen(page, 'كريم', 'كريم مصطفى');
    const conv = await frameFor(page, 'view=thread');
    await conv.waitForSelector('#messageInput');
    await conv.evaluate(() => { window.__sameDocument = 'yes'; });
    await conv.fill('#messageInput', 'رد لم يُرسل بعد');
    await page.waitForSelector('.ws-tab-dirty');

    // أسفل لوحة التذاكر ⇒ تقسيم رأسي داخل التقسيم الأفقي
    const tickets = page.locator('.ws-group', { hasText: 'التذاكر' });
    await dragTab(page, 'كريم مصطفى', tickets, 0.5, 0.92);
    await page.waitForFunction(() => document.querySelectorAll('.ws-group').length === 3);
    let saved = await stored(page);
    const column = saved.root.children.find(c => c.kind === 'split');
    assert.equal(column?.dir, 'column', 'لا تقسيم رأسي');
    assert.equal(saved.panels[column.children[1].tabs[0]].type, 'conversation');

    // يمين لوحة الصندوق في RTL = بدايتها ⇒ مجموعة جديدة أول التقسيم الأفقي
    const inbox = page.locator('.ws-group', { hasText: 'صندوق الرسائل' });
    await dragTab(page, 'كريم مصطفى', inbox, 0.95, 0.5);
    await page.waitForFunction(() => document.querySelectorAll('.ws-group').length === 3 && !document.querySelector('.ws-split--column'));
    saved = await stored(page);
    assert.equal(saved.panels[saved.root.children[0].tabs[0]].type, 'conversation', 'اليمين في RTL ليس البداية');

    // ثم للمنتصف ⇒ داخل مجموعة التذاكر كتبويب
    await dragTab(page, 'كريم مصطفى', page.locator('.ws-group', { hasText: 'التذاكر' }), 0.5, 0.5);
    await page.waitForFunction(() => document.querySelectorAll('.ws-group').length === 2);
    assert.equal(await page.locator('.ws-group', { hasText: 'التذاكر' }).locator('.ws-tab').count(), 2);

    const after = await frameFor(page, 'view=thread');
    assert.equal(await after.evaluate(() => window.__sameDocument), 'yes', 'الإطار أعيد تحميله');
    assert.equal(await after.inputValue('#messageInput'), 'رد لم يُرسل بعد', 'الرد المكتوب ضاع');
    const rpc = await after.evaluate(() => window.__RPC_CALLS__ || []);
    assert.ok(!rpc.includes('inbox_send_reply'), 'السحب أرسل رسالة');
    assert.deepEqual(errors, []);
    await context.close();
});

test('إغلاق تبويب فيه رد لم يُرسل يطلب تأكيدًا؛ الإلغاء يبقيه، والتأكيد يغلقه بلا أي إرسال', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openWorkspace(fixtures());
    await quickOpen(page, 'كريم', 'كريم مصطفى');
    const conv = await frameFor(page, 'view=thread');
    await conv.waitForSelector('#messageInput');
    // الكتابة مباشرةً ثم الإغلاق فورًا: السؤال يذهب للصفحة لحظة الإغلاق لا لآخر رسالة وصلت
    await conv.evaluate(() => { document.getElementById('messageInput').value = 'مسودة'; });
    const tab = page.locator('.ws-tab', { hasText: 'كريم مصطفى' });
    await tab.locator('.ws-tab-close').click();
    const dialog = page.locator('#wsConfirm');
    await dialog.waitFor({ state: 'visible' });
    assert.match(await dialog.innerText(), /كريم مصطفى/);
    await dialog.locator('[data-cancel]').click();
    assert.equal(await tab.count(), 1);
    assert.equal(await conv.inputValue('#messageInput'), 'مسودة');

    // Delete على التبويب من لوحة المفاتيح ⇒ نفس السؤال
    await tab.focus();
    await page.keyboard.press('Delete');
    await dialog.waitFor({ state: 'visible' });
    await dialog.locator('[data-confirm]').click();
    await page.waitForFunction(() => ![...document.querySelectorAll('.ws-tab-title')].some(t => t.textContent === 'كريم مصطفى'));
    assert.equal(await page.locator('.ws-frame[src*="view=thread"]').count(), 0, 'الإطار لم يُزل');
    assert.ok(!Object.values((await stored(page)).panels).some(p => p.type === 'conversation'));

    // تبويب نظيف يُغلق بلا سؤال، ويعود من «إعادة فتح آخر تبويب مغلق»
    await page.locator('.ws-tab', { hasText: 'التذاكر' }).locator('.ws-tab-close').click();
    await page.waitForFunction(() => document.querySelectorAll('.ws-tab').length === 1);
    assert.equal(await dialog.evaluate(d => d.open), false);
    await page.locator('#wsLayoutBtn').click();
    await page.locator('.ws-menu-item', { hasText: 'إعادة فتح آخر تبويب مغلق' }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('.ws-tab-title')].some(t => t.textContent === 'التذاكر'));
    assert.deepEqual(errors, []);
    await context.close();
});

test('الترتيبات الجاهزة وإعادة الضبط لا تعيد استخدام معرّفات قديمة: لا عنوان ولا إطار يلتصق بلوحة أخرى', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openWorkspace(fixtures());
    await quickOpen(page, 'كريم', 'كريم مصطفى');
    await page.waitForFunction(() => [...document.querySelectorAll('.ws-tab-title')].some(t => t.textContent === 'كريم مصطفى'));
    const before = Object.keys((await stored(page)).panels);

    await page.locator('#wsLayoutBtn').click();
    await page.locator('.ws-menu-item', { hasText: 'الصندوق وحده' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.ws-tab').length === 1);
    assert.deepEqual(await tabTitles(page), ['صندوق الرسائل']);
    const after = Object.keys((await stored(page)).panels);
    assert.deepEqual(after.filter(id => before.includes(id)), [], 'معرّف قديم أُعيد استخدامه');
    const srcs = await page.locator('.ws-frame').evaluateAll(fs => fs.map(f => new URL(f.src).search));
    assert.deepEqual(srcs, ['?embed=1']);
    assert.deepEqual(errors, []);
    await context.close();
});

/* ====================  لوحة المفاتيح وإمكانية الوصول  ==================== */

test('لوحة المفاتيح: أسهم بحسب الاتجاه، Enter، قائمة التبويب (Shift+F10)، وتغيير الحجم بالفاصل', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openWorkspace(fixtures());
    await quickOpen(page, 'كريم', 'كريم مصطفى');
    await page.waitForFunction(() => document.querySelectorAll('.ws-tab').length === 3);

    const inboxGroup = page.locator('.ws-group').first();
    const tablist = inboxGroup.locator('[role="tablist"]');
    assert.equal(await tablist.locator('[role="tab"][aria-selected="true"]').innerText(), 'كريم مصطفى');
    assert.equal(await tablist.locator('[role="tab"][tabindex="0"]').count(), 1, 'roving tabindex');
    const body = inboxGroup.locator('[role="tabpanel"]');
    assert.equal(await body.getAttribute('aria-labelledby'), await tablist.locator('[aria-selected="true"]').getAttribute('id'));

    // في RTL السهم الأيسر = التبويب التالي بصريًا؛ من الأخير يرجع للأول
    await tablist.locator('[aria-selected="true"]').focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), 'صندوق الرسائل');
    await page.keyboard.press('Enter');
    assert.equal(await tablist.locator('[aria-selected="true"]').innerText(), 'صندوق الرسائل');

    // Alt+Shift+سهم يعيد الترتيب
    await page.keyboard.press('Alt+Shift+ArrowLeft');
    assert.deepEqual(await tablist.locator('.ws-tab-title').allInnerTexts(), ['كريم مصطفى', 'صندوق الرسائل']);

    // قائمة التبويب بلا فأرة ⇒ «انقل لمجموعة جديدة بالأسفل»
    await page.keyboard.press('Shift+F10');
    const menu = page.locator('.ws-menu[role="menu"]');
    await menu.waitFor();
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('role')), 'menuitem');
    await menu.locator('[role="menuitem"]', { hasText: 'بالأسفل' }).click();
    await page.waitForFunction(() => document.querySelector('.ws-split--column'));
    assert.equal(await page.locator('.ws-group').count(), 3);

    // الفاصل الأفقي: سهم يسار في RTL يكبّر البداية (اليمين)
    const divider = page.locator('.ws-divider--row');
    const before = Number(await divider.getAttribute('aria-valuenow'));
    await divider.focus();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction((b) => Number(document.querySelector('.ws-divider--row').getAttribute('aria-valuenow')) === b + 10, before);
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('ws-divider')), true, 'التركيز ضاع بعد إعادة الرسم');
    const saved = await stored(page);
    assert.ok(Math.abs(saved.root.sizes[0] - (before + 10) / 100) < 0.011);

    // الفتح السريع بالكيبورد بالكامل
    await page.keyboard.press('Control+KeyK');
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('role')), 'combobox');
    await page.keyboard.type('سارة');
    await page.waitForSelector('.ws-quick-item >> text=سارة إبراهيم');
    while (!(await page.locator('.ws-quick-item.is-selected').innerText()).includes('سارة')) await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => [...document.querySelectorAll('.ws-tab-title')].some(t => t.textContent === 'سارة إبراهيم'));
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('ws-tab')), true, 'التركيز لم ينتقل للتبويب الجديد');
    assert.deepEqual(errors, []);
    await context.close();
});

test('سحب الفاصل بالفأرة يغيّر الحجم ويُحفظ، والإطارات تتبعه', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openWorkspace(fixtures());
    const divider = await page.locator('.ws-divider--row').boundingBox();
    const x = divider.x + divider.width / 2;
    const y = divider.y + divider.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 200, y, { steps: 6 });   // يسارًا في RTL ⇒ البداية (اليمين) تكبر
    await page.mouse.up();
    await page.waitForFunction(() => Number(document.querySelector('.ws-divider--row').getAttribute('aria-valuenow')) > 55);
    const saved = await stored(page);
    assert.ok(saved.root.sizes[0] > 0.55, `الحجم لم يُحفظ: ${saved.root.sizes}`);
    const body = await page.locator('.ws-group').first().locator('.ws-group-body').boundingBox();
    const panelId = await page.locator('.ws-group').first().locator('.ws-tab.is-active').getAttribute('data-panel');
    const frame = await page.locator(`.ws-frame[data-panel="${panelId}"]`).boundingBox();
    assert.ok(Math.abs(frame.width - body.width) < 1, 'الإطار لم يتبع الحجم الجديد');
    assert.deepEqual(errors, []);
    await context.close();
});

/* ====================  الحفظ والاستعادة  ==================== */

test('التحديث يستعيد نفس الترتيب المتداخل والتبويبات النشطة', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openWorkspace(fixtures());
    await quickOpen(page, '412', '#412 مشكلة ربط');
    await page.waitForFunction(() => document.querySelectorAll('.ws-tab').length === 3);
    await page.locator('.ws-tab', { hasText: '#412' }).click({ button: 'right' });
    await page.locator('.ws-menu-item', { hasText: 'بالأعلى' }).click();
    await page.waitForFunction(() => document.querySelector('.ws-split--column'));
    const before = await stored(page);

    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('html[data-workspace-ready="true"]');
    assert.deepEqual(await stored(page), before);
    assert.equal(await page.locator('.ws-group').count(), 3);
    assert.equal(await page.locator('.ws-split--column').count(), 1);
    // العنوان يأتي حيًا بعد التحقق من الوصول، ولا يُحفظ
    await page.waitForFunction(() => [...document.querySelectorAll('.ws-tab-title')].some(t => t.textContent === '#412 مشكلة ربط'));
    assert.ok(!JSON.stringify(before).includes('مشكلة'), 'العنوان حُفظ مع الترتيب');
    assert.deepEqual(errors, []);
    await context.close();
});

test('ترتيب محفوظ مُتلاعَب به: اللوحات غير الصالحة تسقط، والروابط لا تحمل إلا معاملات معروفة', { skip: !chromiumPath }, async () => {
    const local = savedLayout(
        { kind: 'split', id: 's1', dir: 'row', sizes: [0.5, 0.5], children: [
            group('g2', ['p3', 'p4', 'p5']), group('g6', ['p7', 'p8'], 'p8')] },
        {
            p3: panel('p3', 'inbox', { impersonate: 'victim-id' }),
            p4: panel('p4', 'ticket', { ticketId: `${T_KARIM}&impersonate=victim` }),
            p5: panel('p5', 'evilModule', { url: 'javascript:alert(1)' }),
            p7: panel('p7', 'customer', { customerId: KARIM }),
            p8: panel('p8', 'conversation', { sessionId: S_SARA, __proto__: { x: 1 } })
        }, { activeGroup: 'g6' });
    const { page, context, errors } = await openWorkspace(fixtures(), { local });
    await page.waitForSelector('.ws-toast');
    assert.match(await page.locator('.ws-toast').innerText(), /لم تُستعد بعض التبويبات/);
    assert.equal(await page.locator('.ws-tab').count(), 3);

    const urls = await page.locator('.ws-frame').evaluateAll(fs => fs.map(f => new URL(f.src).search));
    for (const search of urls) {
        const keys = [...new URLSearchParams(search).keys()].sort();
        assert.ok(keys.every(k => ['embed', 'view', 'session', 'ticket_id', 'customer_id'].includes(k)), `معامل غير متوقع: ${search}`);
        assert.ok(!search.includes('impersonate'));
    }
    assert.deepEqual(errors, []);
    await context.close();
});

test('ترتيب محفوظ معطوب البنية ⇒ ترتيب افتراضي مع تنبيه، ولا تعطل', { skip: !chromiumPath }, async () => {
    const local = { version: 1, panels: {}, root: { kind: 'split', id: 's1', dir: 'diagonal', children: [], sizes: [] } };
    const { page, context, errors } = await openWorkspace(fixtures(), { local });
    await page.waitForSelector('.ws-toast');
    assert.match(await page.locator('.ws-toast').innerText(), /تعذّرت استعادة الترتيب/);
    assert.deepEqual(await tabTitles(page), ['صندوق الرسائل', 'التذاكر']);
    assert.equal((await stored(page)).root.dir, 'row', 'الافتراضي لم يحل محل المعطوب');
    assert.deepEqual(errors, []);
    await context.close();
});

test('الاستعادة تعيد التحقق من الوصول: محادثة لم تعد مرئية ⇒ تبويب «غير متاح» بلا إطار', { skip: !chromiumPath }, async () => {
    const local = savedLayout(group('g2', ['p3', 'p4'], 'p4'), {
        p3: panel('p3', 'inbox'),
        p4: panel('p4', 'conversation', { sessionId: S_GONE })
    }, { activeGroup: 'g2' });
    const { page, context, errors } = await openWorkspace(fixtures(), { local });
    await page.waitForSelector('.ws-tab.is-unavailable');
    assert.equal(await page.locator('.ws-frame[data-panel="p4"]').count(), 0, 'إطار أُنشئ لسجل غير مرئي');
    assert.match(await page.locator('.ws-group-body').innerText(), /هذا العنصر غير متاح/);

    // «إغلاق التبويب» من حالة غير المتاح
    await page.locator('.ws-state .ws-btn--primary').click();
    await page.waitForFunction(() => document.querySelectorAll('.ws-tab').length === 1);
    assert.deepEqual(errors, []);
    await context.close();
});

test('الحفظ على الخادم: الأحدث من الخادم يغلب المحلي، والحفظ يرسل البنية فقط', { skip: !chromiumPath }, async () => {
    const fx = fixtures();
    const server = savedLayout(group('g2', ['p3']), { p3: panel('p3', 'customers') });
    fx.rpc.workspace_get_layout = [{ layout: { ...server, savedAt: 9e12 }, revision: 7, updated_at: t(0) }];
    fx.rpc.workspace_save_layout = [{ revision: 8, updated_at: t(1), conflict: false }];
    const local = savedLayout(group('g2', ['p3']), { p3: panel('p3', 'tickets') });
    const { page, context, errors } = await openWorkspace(fx, { local });
    assert.deepEqual(await tabTitles(page), ['سجل العملاء']);

    await quickOpen(page, 'كريم', 'كريم مصطفى');
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'workspace_save_layout'), null, { timeout: 5000 });
    const [, args] = (await page.evaluate(() => window.__RPC_ARGS__)).find(([n]) => n === 'workspace_save_layout');
    assert.equal(args.p_base_revision, 7);
    assert.equal(args.p_layout.version, 1);
    assert.ok(Object.values(args.p_layout.panels).some(p => p.type === 'conversation' && p.params.sessionId === S_KARIM));
    assert.ok(!JSON.stringify(args).includes('كريم'), 'اسم العميل أُرسل مع الترتيب');
    await page.waitForFunction(() => document.getElementById('wsSaveStatus').dataset.state === 'saved');
    assert.deepEqual(errors, []);
    await context.close();
});

/* ====================  بين اللوحات  ==================== */

test('رابط «سجل العميل» داخل التذكرة يفتح العميل بجانبها، ورابط التذكرة داخل سجل العميل ينشّط تبويبها', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openWorkspace(fixtures());
    await quickOpen(page, '412', '#412 مشكلة ربط');
    const ticket = await frameFor(page, 'view=ticket');
    await ticket.waitForSelector('a[href*="customer-history.html?customer_id="]');
    // عرض تذكرة واحدة: لا قائمة ولا إحصاءات
    assert.equal(await ticket.evaluate(() => getComputedStyle(document.querySelector('.tickets-panel')).display), 'none');
    await page.waitForFunction(() => [...document.querySelectorAll('.ws-tab-title')].some(t => t.textContent === '#412 مشكلة ربط'));

    await ticket.click('a[href*="customer-history.html?customer_id="]');
    const customer = await frameFor(page, 'view=customer');
    assert.ok(customer.url().includes(`customer_id=${KARIM}`));
    const groupOf = (text) => page.locator('.ws-group', { has: page.locator('.ws-tab-title', { hasText: text }) }).getAttribute('data-group');
    await page.waitForFunction(() => [...document.querySelectorAll('.ws-tab-title')].some(t => t.textContent === 'كريم مصطفى'));
    assert.notEqual(await groupOf('كريم مصطفى'), await groupOf('#412'), 'العميل غطّى التذكرة');
    assert.ok(ticket.url().includes('view=ticket'), 'التذكرة تنقلت بدل أن تبقى');

    // داخل سجل العميل: رابط نفس التذكرة ⇒ لا تبويب جديد
    await customer.waitForSelector(`a[href*="ticket_id=${T_KARIM}"]`);
    const count = await page.locator('.ws-tab').count();
    await customer.evaluate((id) => document.querySelector(`a[href*="ticket_id=${id}"]`).click(), T_KARIM);
    await page.waitForTimeout(200);
    assert.equal(await page.locator('.ws-tab').count(), count, 'تبويب تذكرة مكرر');
    assert.equal(await page.locator('.ws-tab.is-active', { hasText: '#412' }).count(), 1);
    assert.deepEqual(errors, []);
    await context.close();
});

test('تغيّر تذكرة يحدّث سجل العميل المفتوح — إلا لو فيه ملاحظة لم تُحفظ', { skip: !chromiumPath }, async () => {
    const local = savedLayout(
        { kind: 'split', id: 's1', dir: 'row', sizes: [0.5, 0.5], children: [group('g2', ['p3']), group('g4', ['p5'])] },
        { p3: panel('p3', 'ticket', { ticketId: T_KARIM }), p5: panel('p5', 'customer', { customerId: KARIM }) });
    const { page, context, errors } = await openWorkspace(fixtures(), { local });
    const ticket = await frameFor(page, 'view=ticket');
    const customer = await frameFor(page, 'view=customer');
    await customer.waitForFunction(() => document.getElementById('custName')?.textContent === 'كريم مصطفى');
    await ticket.waitForSelector('#adminTicketDetailsContent h2');

    const changed = (id, customerId) => ticket.evaluate(({ id, customerId }) => window.parent.postMessage(
        { ns: 'mad3oom-ws', v: 1, type: 'changed', entity: 'ticket', id, customerId }, location.origin), { id, customerId });

    await customer.evaluate(() => { document.getElementById('custName').textContent = 'قديم'; });
    await changed(T_KARIM, KARIM);
    await customer.waitForFunction(() => document.getElementById('custName')?.textContent === 'كريم مصطفى', null, { timeout: 4000 });

    await customer.evaluate(() => { document.getElementById('custName').textContent = 'قديم'; });
    // خانة الملاحظات في تبويب داخلي غير ظاهر؛ نكتب فيها كما يكتب المتصفح
    await customer.evaluate(() => {
        const box = document.getElementById('newNoteText');
        box.value = 'ملاحظة لم تُحفظ';
        box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await changed(T_KARIM, KARIM);
    await page.waitForTimeout(1200);
    assert.equal(await customer.evaluate(() => document.getElementById('custName').textContent), 'قديم', 'أعيد التحميل فوق ملاحظة مكتوبة');
    assert.equal(await customer.inputValue('#newNoteText'), 'ملاحظة لم تُحفظ');
    assert.deepEqual(errors, []);
    await context.close();
});

test('رسائل مزيفة تُتجاهل: من خارج الإطارات، ومن إطار يطلب نوعًا غير معروف أو معاملًا غريبًا', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openWorkspace(fixtures());
    const tabs = await page.locator('.ws-tab').count();
    // الصفحة نفسها ليست إطار لوحة
    await page.evaluate((id) => window.postMessage({ ns: 'mad3oom-ws', v: 1, type: 'open', panel: { type: 'ticket', params: { ticketId: id } } }, '*'), T_KARIM);
    await page.waitForTimeout(150);
    assert.equal(await page.locator('.ws-tab').count(), tabs);

    const inbox = await frameFor(page, '/admin/inbox.html?embed=1');
    await inbox.evaluate(() => {
        const send = (panel) => window.parent.postMessage({ ns: 'mad3oom-ws', v: 1, type: 'open', panel }, location.origin);
        send({ type: 'evilModule', params: {} });
        send({ type: 'ticket', params: { ticketId: '../../admin/users.html' } });
        window.parent.postMessage({ ns: 'mad3oom-ws', v: 1, type: 'title', title: '<img src=x onerror=alert(1)>' }, location.origin);
    });
    await page.waitForTimeout(200);
    assert.equal(await page.locator('.ws-tab').count(), tabs, 'نوع غير معروف فُتح');
    // العنوان نص لا HTML
    assert.equal(await page.locator('.ws-tab img').count(), 0);
    assert.equal(await page.locator('.ws-tab-title', { hasText: '<img' }).count(), 1);
    assert.deepEqual(errors, []);
    await context.close();
});

/* ====================  الأداء  ==================== */

test('الإطارات كسولة ومحدودة: لا تُنشأ قبل ظهور تبويبها، ولا تزيد عن 6، والمكتوب فيه لا يُفرَّغ أبدًا', { skip: !chromiumPath }, async () => {
    const fx = fixtures();
    const ids = Array.from({ length: 9 }, (_, i) => `dddddddd-0000-4000-8000-00000000000${i}`);
    fx.tables.profiles.push(...ids.map((id, i) => ({ id, full_name: `عميل ${i}`, email: `c${i}@test.local`, role: 'user', phone: null, created_at: t(0) })));
    const panels = Object.fromEntries(ids.map((id, i) => [`p${i + 10}`, panel(`p${i + 10}`, 'customer', { customerId: id })]));
    const tabs = Object.keys(panels);
    const { page, context, errors } = await openWorkspace(fx, { local: savedLayout(group('g2', tabs), panels) });
    assert.equal(await page.locator('.ws-frame').count(), 1, 'إطارات أُنشئت لتبويبات لم تظهر');
    await page.waitForFunction(() => document.querySelectorAll('.ws-tab-title')[8]?.textContent === 'عميل 8');

    const first = await frameFor(page, ids[0]);
    await first.waitForFunction(() => document.getElementById('custName')?.textContent === 'عميل 0');
    await first.evaluate(() => { const b = document.getElementById('newNoteText'); b.value = 'ملاحظة'; b.dispatchEvent(new Event('input', { bubbles: true })); });

    for (const id of tabs.slice(1)) {
        await page.locator(`.ws-tab[data-panel="${id}"]`).click();
        await page.waitForSelector(`.ws-frame[data-panel="${id}"]`);
        assert.ok(await page.locator('.ws-frame').count() <= 6, 'تجاوز حد الإطارات الحية');
    }
    assert.equal(await page.locator(`.ws-frame[data-panel="${tabs[0]}"]`).count(), 1, 'الإطار الذي فيه ملاحظة فُرِّغ');
    assert.equal(await (await frameFor(page, ids[0])).inputValue('#newNoteText'), 'ملاحظة');

    // تبويب فُرِّغ إطاره يُحمَّل من جديد عند عرضه
    await page.locator(`.ws-tab[data-panel="${tabs[1]}"]`).click();
    const again = await frameFor(page, ids[1]);
    await again.waitForFunction(() => document.getElementById('custName')?.textContent === 'عميل 1');
    assert.deepEqual(errors, []);
    await context.close();
});

/* ====================  الاتجاه والشاشة والأدوار  ==================== */

test('LTR (الإنجليزية): يمين اللوحة = نهايتها، والنصوص بالإنجليزية', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openWorkspace(fixtures(), { lang: 'en' });
    assert.equal(await page.evaluate(() => document.documentElement.dir), 'ltr');
    assert.deepEqual(await tabTitles(page), ['Inbox', 'Tickets']);
    const [first, second] = await page.locator('.ws-group').evaluateAll(gs => gs.map(g => g.getBoundingClientRect().left));
    assert.ok(first < second, 'البداية ليست يسارًا في LTR');

    await page.locator('.ws-tab', { hasText: 'Tickets' }).click({ button: 'right' });
    assert.ok(await page.locator('.ws-menu-item', { hasText: 'Move to new group on the right' }).count());
    await page.keyboard.press('Escape');

    // اسحب Inbox لحافة Tickets اليمنى ⇒ نهاية التقسيم
    await dragTab(page, 'Inbox', page.locator('.ws-group', { hasText: 'Tickets' }), 0.95, 0.5);
    await page.waitForFunction(() => document.querySelectorAll('.ws-tab').length === 2);
    const saved = await stored(page);
    assert.equal(saved.panels[saved.root.children.at(-1).tabs[0]].type, 'inbox');
    assert.deepEqual(errors, []);
    await context.close();
});

test('شاشة صغيرة: شريط تبويبات واحد ولوحة واحدة، والترتيب المقسّم محفوظ كما هو', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openWorkspace(fixtures(), { viewport: { width: 700, height: 800 } });
    assert.equal(await page.locator('.ws-group').count(), 1);
    assert.equal(await page.locator('.ws-divider').count(), 0);
    assert.deepEqual(await tabTitles(page), ['صندوق الرسائل', 'التذاكر']);
    assert.equal(await page.locator('.ws-tab[draggable="true"]').count(), 0);
    await page.locator('.ws-tab', { hasText: 'التذاكر' }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('.ws-frame')].filter(f => !f.classList.contains('is-hidden')).length === 1
        && document.querySelector('.ws-frame:not(.is-hidden)').src.includes('tickets.html'));
    assert.equal((await stored(page)).root.kind, 'split', 'الوضع المضغوط غيّر الترتيب المحفوظ');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `تمرير أفقي: ${overflow}`);

    await page.setViewportSize({ width: 1400, height: 800 });
    await page.waitForFunction(() => document.querySelectorAll('.ws-group').length === 2);
    assert.deepEqual(errors, []);
    await context.close();
});

test('مساحة العمل لطاقم المنصة: حساب ليس منه يرفضه الحارس المشترك ولا تُحمَّل أي لوحة', { skip: !chromiumPath }, async () => {
    const context = await browser.newContext();
    const fx = fixtures({ role: 'super_user' });
    const doubleSupabase = fs.readFileSync(path.join(ROOT, 'tests/fixtures/supabase-double.js'), 'utf8');
    const doubleAuth = fs.readFileSync(path.join(ROOT, 'tests/fixtures/auth-client-double.js'), 'utf8');
    await context.route('**/api-config.js', r => r.fulfill({ contentType: 'text/javascript; charset=utf-8', body: doubleSupabase }));
    await context.route('**/auth-client.js', r => r.fulfill({ contentType: 'text/javascript; charset=utf-8', body: doubleAuth }));
    await context.route('https://fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
    await context.addInitScript(data => { window.__FIXTURES__ = data; }, fx);
    const page = await context.newPage();
    await page.goto(`${baseUrl}/admin/workspace.html`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(300);
    assert.equal(await page.locator('.ws-frame').count(), 0);
    assert.equal(await page.locator('.ws-tab').count(), 0);
    // الحارس المشترك (guardPage('admin')) يرفضه قبل أي رسم، بلوحته المعتادة
    assert.equal(await page.locator('#accessDeniedPanel').count(), 1);
    await context.close();
});

/* ====================  الصفحات المضمّنة خارج مساحة العمل  ==================== */

test('embed=1 على صفحة مفتوحة مباشرةً (ليست داخل مساحة العمل) لا يغيّر شيئًا', { skip: !chromiumPath }, async () => {
    const { page, context } = await openWorkspace(fixtures());
    const direct = await context.newPage();
    await direct.goto(`${baseUrl}/admin/inbox.html?embed=1&view=thread&session=${S_KARIM}`, { waitUntil: 'networkidle' });
    await direct.waitForSelector('.admin-nav');
    assert.equal(await direct.evaluate(() => document.documentElement.classList.contains('ws-embedded')), false);
    assert.notEqual(await direct.evaluate(() => getComputedStyle(document.querySelector('.ib-list-pane')).display), 'none');
    assert.equal(await direct.evaluate(() => typeof window.__mad3oomEmbed), 'undefined');
    await direct.close();
    await page.close();
    await context.close();
});

test('صفحة التذاكر العادية تفتح ?ticket_id= مباشرةً (رابط سجل العميل كان يُتجاهل)', { skip: !chromiumPath }, async () => {
    const { page, context } = await openWorkspace(fixtures());
    const direct = await context.newPage();
    const errors = [];
    direct.on('pageerror', e => errors.push(e.message));
    await direct.goto(`${baseUrl}/admin/tickets.html?ticket_id=${T_KARIM}`, { waitUntil: 'networkidle' });
    await direct.waitForSelector('#adminTicketDetailsContent h2');
    assert.equal(await direct.locator('#adminTicketDetailsContent h2').innerText(), 'مشكلة ربط');
    assert.equal(await direct.locator('.ticket-card.selected').count(), 1);
    assert.equal(await direct.locator('#wsOpenTicketTab').isVisible(), false, 'زر مساحة العمل ظاهر خارجها');
    await direct.waitForSelector('.admin-nav');
    assert.deepEqual(errors, []);
    await direct.close();
    await page.close();
    await context.close();
});
