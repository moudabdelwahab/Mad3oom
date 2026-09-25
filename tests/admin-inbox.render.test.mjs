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
 *   - المرحلة 2 (056): مرفق/تسجيل رد الدعم بيترفع في مجلد الموظف ويتبعت
 *     عبر inbox_send_reply، التفاعلات للفريق، وتعديل/حذف ردود الدعم بس.
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

const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const ADMIN = 'admin-1';
const S_BOT = 'aaaaaaaa-0000-4000-8000-000000000001';
const S_MANUAL = 'aaaaaaaa-0000-4000-8000-000000000002';
const S_CLOSED = 'aaaaaaaa-0000-4000-8000-000000000003';
const S_STAFF = 'aaaaaaaa-0000-4000-8000-000000000004';
const TEAM = 'team-0000-0000-0000-000000000001';
const TAG = 'tag-0000-0000-0000-000000000001';

const t = (min) => new Date(Date.UTC(2026, 8, 25, 9, min)).toISOString();
const msg = (id, session_id, min, text, kind, sender_id = null) => ({
    id, session_id, message_text: text, created_at: t(min), image_url: null,
    sender_id: kind === 'bot' ? null : sender_id,
    is_admin_reply: kind === 'agent', is_bot_reply: kind === 'bot'
});
const customer = (session_id, user_id, full_name, email, role = 'user') =>
    ({ session_id, user_id, full_name, email, role, phone: null, created_at: t(0) });

/**
 * شكل البيانات بعد 055: الجلسات من chat_sessions (برسايلها)، وحالة الـ
 * helpdesk من inbox_*، واسم العميل وقائمة الموظفين من RPC (مش embed على
 * profiles، لأن الأدمن غير المرتفع مالوش SELECT على ملفات الآخرين).
 */
function fixtures({ role = 'admin', elevated = true } = {}) {
    const sessions = [
        {
            id: S_BOT, user_id: 'u-sara', guest_id: null, status: 'active', is_manual_mode: false,
            created_at: t(0), updated_at: t(5),
            chat_messages: [
                msg('m2', S_BOT, 2, 'عندي مشكلة في الاشتراك', 'customer', 'u-sara'),
                msg('m1', S_BOT, 1, 'أهلاً بيك [[icon:inquiry]] اختار من الاختيارات', 'bot')
            ]
        },
        {
            id: S_MANUAL, user_id: 'u-karim', guest_id: null, status: 'active', is_manual_mode: true,
            created_at: t(10), updated_at: t(20),
            chat_messages: [
                msg('m3', S_MANUAL, 11, 'محتاج حد من الدعم', 'customer', 'u-karim'),
                msg('m4', S_MANUAL, 12, 'معاك هبة من الدعم', 'agent', 'staff-2'),
                msg('m5', S_MANUAL, 13, 'تمام شكراً', 'customer', 'u-karim')
            ]
        },
        {
            id: S_CLOSED, user_id: 'u-nour', guest_id: null, status: 'closed', is_manual_mode: true,
            created_at: t(1), updated_at: t(3),
            chat_messages: [msg('m6', S_CLOSED, 2, 'اتحلت', 'customer', 'u-nour')]
        },
        {
            id: S_STAFF, user_id: 'u-staff', guest_id: null, status: 'active', is_manual_mode: false,
            created_at: t(0), updated_at: t(0),
            chat_messages: [msg('m7', S_STAFF, 0, 'تجربة من حسابي', 'customer', 'u-staff')]
        }
    ];
    return {
        user: { id: ADMIN, email: 'admin@test.local' },
        authUser: { id: ADMIN, email: 'admin@test.local', profile: { id: ADMIN, role } },
        tables: {
            chat_sessions: sessions,
            chat_messages: [],
            inbox_conversations: [
                { session_id: S_MANUAL, assignee_id: 'staff-2', team_id: TEAM, archived_at: null, archived_by: null, updated_at: t(12) }
            ],
            inbox_conversation_tags: [{ session_id: S_MANUAL, tag_id: TAG }],
            inbox_notes: [
                { id: 'n1', session_id: S_MANUAL, author_id: 'staff-2', body: 'العميل ده عليه تذكرتين قبل كده', mentions: [],
                  created_at: t(12.5), edited_at: null, deleted_at: null }
            ],
            inbox_events: [
                { id: 1, session_id: S_MANUAL, actor_id: ADMIN, kind: 'assigned',
                  payload: { to_user: 'staff-2', to_team: TEAM }, created_at: t(11.5) }
            ],
            inbox_teams: [{ id: TEAM, name: 'الدعم الفني', description: null, archived_at: null }],
            inbox_team_members: [{ team_id: TEAM, user_id: 'staff-2', role: 'lead' }],
            ticket_tags: [{ id: TAG, name: 'فوترة', color: '#E0A800' }],
            customer_notes: [{ id: 'cn1', customer_id: 'u-karim', note: 'عميل مهم — باقة الشركات', created_at: t(0) }],
            tickets: [{ id: 'tk1', user_id: 'u-karim', ticket_number: 412, title: 'مشكلة ربط', status: 'open', created_at: t(0) }],
            canned_responses: [{ id: 'c1', title: 'ترحيب', shortcut: 'ترحيب', content: 'أهلاً {{الاسم}}، إزاي أساعدك؟' }]
        },
        rpc: {
            inbox_customer_profiles: [
                customer(S_BOT, 'u-sara', 'سارة إبراهيم', 'sara@test.local'),
                customer(S_MANUAL, 'u-karim', 'كريم مصطفى', 'karim@test.local'),
                customer(S_CLOSED, 'u-nour', 'نورهان علي', 'nour@test.local'),
                customer(S_STAFF, 'u-staff', 'موظف دعم', 'staff@test.local', 'support')
            ],
            inbox_list_agents: [
                { id: ADMIN, full_name: 'الأدمن', email: 'admin@test.local', role, is_elevated: elevated, team_ids: [] },
                { id: 'staff-2', full_name: 'هبة سمير', email: 'heba@test.local', role: 'support', is_elevated: false, team_ids: [TEAM] }
            ],
            inbox_send_reply: msg('sent-1', S_BOT, 30, 'أهلاً سارة، معاكي الدعم', 'agent', ADMIN),
            inbox_add_note: { id: 'n-new', session_id: S_BOT, author_id: ADMIN, body: 'ملاحظة @هبة سمير',
                              mentions: [], created_at: t(31), edited_at: null, deleted_at: null },
            inbox_assign: { session_id: S_BOT, assignee_id: 'staff-2', team_id: null, archived_at: null },
            inbox_transfer: { session_id: S_BOT, assignee_id: null, team_id: TEAM, archived_at: null },
            inbox_set_archived: { session_id: S_BOT, assignee_id: null, team_id: null, archived_at: t(40) }
        }
    };
}

/** أدمن عادي عضو في فريق «الدعم الفني» — فيوصل لمحادثة كريم المسندة للفريق بس. */
function regularTeamMember() {
    const fx = fixtures({ elevated: false });
    fx.rpc.inbox_list_agents[0].team_ids = [TEAM];
    fx.tables.inbox_team_members.push({ team_id: TEAM, user_id: ADMIN, role: 'member' });
    return fx;
}

const rpcCalls = (page, name) => page.evaluate((n) => (window.__RPC_ARGS__ || []).filter(([k]) => k === n).map(([, a]) => a), name);

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

async function openInbox(fx, { query = '', viewport, init = null } = {}) {
    const context = await browser.newContext({ viewport: viewport || { width: 1400, height: 900 } });
    const page = await context.newPage();

    // التوقيع في البديل المشترك غير موجود؛ نضيفه بنفس شكل chat-page.render.test.mjs
    // (روابط /__file/… يخدمها الاختبار نفسه).
    const doubleSupabase = fs.readFileSync(path.join(ROOT, 'tests/fixtures/supabase-double.js'), 'utf8')
        .replace("getPublicUrl: (p) => ({ data: { publicUrl: `/uploads/${p}` } })",
            "getPublicUrl: (p) => ({ data: { publicUrl: `/uploads/${p}` } }),"
            + " createSignedUrls: async (paths, ttl) => { (window.__SIGNED__ = window.__SIGNED__ || []).push([paths, ttl]);"
            + " return { data: paths.map((p) => ({ path: p, signedUrl: location.origin + '/__file/' + p })), error: null }; },"
            + " createSignedUrl: async (p) => ({ data: { signedUrl: location.origin + '/__file/' + p }, error: null })");
    assert.ok(doubleSupabase.includes('createSignedUrls'), 'مقدرتش أضيف التوقيع للبديل');
    // الرفع بيتسجّل (المسار والنوع والحجم)، ونقدر نجبره يفشل؛ والحذف كمان.
    const withUploads = doubleSupabase.replace('upload: async () => ({ error: null }),',
        'upload: async (p, file, opts) => { (window.__UPLOADS__ = window.__UPLOADS__ || []).push({ path: p, type: opts?.contentType, size: file.size });'
        + ' return window.__UPLOAD_ERROR__ ? { error: { message: window.__UPLOAD_ERROR__ } } : { data: { path: p }, error: null }; },'
        + ' remove: async (paths) => { (window.__REMOVED__ = window.__REMOVED__ || []).push(...paths); return { data: paths, error: null }; },');
    assert.ok(withUploads.includes('__UPLOADS__'), 'مقدرتش أضيف تسجيل الرفع للبديل');
    const doubleAuth = fs.readFileSync(path.join(ROOT, 'tests/fixtures/auth-client-double.js'), 'utf8');
    await page.route('**/api-config.js', r => r.fulfill({ contentType: 'text/javascript; charset=utf-8', body: withUploads }));
    await page.route('**/auth-client.js', r => r.fulfill({ contentType: 'text/javascript; charset=utf-8', body: doubleAuth }));
    await page.route('https://fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
    await page.route('**/__file/**', r => r.fulfill({
        contentType: /\.pdf$/.test(r.request().url()) ? 'application/pdf' : /\.webm$/.test(r.request().url()) ? 'audio/webm' : 'image/png',
        body: /\.webm$/.test(r.request().url()) ? Buffer.alloc(0) : PNG_1PX }));
    await page.addInitScript(data => { window.__FIXTURES__ = data; }, fx);
    // الدوال مابتعديش JSON: اللي محتاج RPC بيحسب أو بيفشل بيضيفها هنا.
    if (init) await page.addInitScript(init);

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
    for (const tag of ['فريق العمل', 'الدعم ماسكها', 'البوت', 'مقفولة', 'بانتظار رد', 'هبة سمير', 'الدعم الفني', 'فوترة']) {
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

    // الملاحظة الداخلية والحدث في نفس الخط الزمني، بشكل مختلف عن الرسايل
    await page.waitForSelector('.ib-msg--note');
    assert.match(await page.locator('.ib-msg--note').innerText(), /ملاحظة داخلية — العميل مايشوفهاش · هبة سمير/);
    assert.match(await page.locator('.ib-event').first().innerText(), /أسند المحادثة لـ هبة سمير — فريق الدعم الفني/);
    // الإسناد الحالي في رأس المحادثة
    assert.equal(await page.locator('#assigneeSelect').inputValue(), 'staff-2');
    assert.equal(await page.locator('#teamSelect').inputValue(), TEAM);

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
    assert.equal(await page.locator('.ib-msg--bot .ib-bubble svg').count(), 1);
    await context.close();
});

test('رد الدعم بيتبعت عبر inbox_send_reply ومفيش كتابة مباشرة', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openInbox(fixtures(), { query: `?session=${S_BOT}` });
    await page.waitForSelector('.ib-msg');
    assert.match(await page.locator('#composerNote').innerText(), /البوت شغال/);

    await page.fill('#messageInput', 'أهلاً سارة، معاكي الدعم');
    await page.press('#messageInput', 'Enter');
    await page.waitForSelector('.ib-msg--mine');

    // الكتابة كلها عبر RPC واحد؛ العقد نفسه (is_manual_mode ثم is_admin_reply)
    // مثبّت في tests/sql/inbox-helpdesk-core.test.sql.
    assert.deepEqual(await rpcCalls(page, 'inbox_send_reply'), [{ p_session: S_BOT, p_body: 'أهلاً سارة، معاكي الدعم', p_attachment: null }]);
    assert.deepEqual(await page.evaluate(() => window.__WRITES__ || []), [], 'كتابة مباشرة على جدول');

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

test('المحادثة المقفولة مابتقبلش رد للعميل، بس بتقبل ملاحظة داخلية', { skip: !chromiumPath }, async () => {
    const { page, context } = await openInbox(fixtures(), { query: `?session=${S_CLOSED}` });
    await page.waitForSelector('.ib-msg');
    assert.equal(await page.locator('#closedNote').isVisible(), true);
    // الرد للعميل مقفول، والملاحظة الداخلية متاحة
    assert.equal(await page.locator('#modeToggle [data-mode="reply"]').isDisabled(), true);
    assert.equal(await page.locator('#composer').evaluate((el) => el.classList.contains('is-note')), true);
    assert.equal(await page.locator('#closeSessionBtn').isVisible(), false);
    await context.close();
});

test('إقفال المحادثة عبر inbox_close', { skip: !chromiumPath }, async () => {
    const { page, context } = await openInbox(fixtures(), { query: `?session=${S_MANUAL}` });
    await page.waitForSelector('.ib-msg');
    page.once('dialog', d => d.accept());
    await page.click('#closeSessionBtn');
    await page.waitForSelector('#closedNote:not([hidden])');
    assert.deepEqual(await rpcCalls(page, 'inbox_close'), [{ p_sessions: [S_MANUAL] }]);
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

test('الملاحظة الداخلية بتتبعت عبر inbox_add_note بالمنشن', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openInbox(fixtures(), { query: `?session=${S_BOT}` });
    await page.waitForSelector('.ib-msg');
    await page.click('#modeToggle [data-mode="note"]');
    assert.match(await page.locator('#composerNote').innerText(), /العميل مش هيشوفها/);

    await page.fill('#messageInput', 'ملاحظة @هب');
    await page.dispatchEvent('#messageInput', 'input');
    await page.waitForSelector('.ib-pop-item');
    await page.click('.ib-pop-item');
    assert.equal(await page.inputValue('#messageInput'), 'ملاحظة @هبة سمير ');
    await page.press('#messageInput', 'Enter');
    await page.waitForSelector('[data-note="n-new"]');

    assert.deepEqual(await rpcCalls(page, 'inbox_add_note'),
        [{ p_session: S_BOT, p_body: 'ملاحظة @هبة سمير', p_mentions: ['staff-2'] }]);
    assert.equal((await rpcCalls(page, 'inbox_send_reply')).length, 0, 'الملاحظة اتبعتت كرد للعميل');
    // القاعدة رجّعت منشن فاضي (هبة مش واصلة للمحادثة) ⇒ الواجهة بتنبّه
    assert.match(await page.locator('#toast').innerText(), /هبة سمير مش واصل للمحادثة/);
    assert.deepEqual(errors, []);
    await context.close();
});

test('الإسناد والتحويل والأرشفة والوسوم عبر الـ RPC بتاعها', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openInbox(fixtures(), { query: `?session=${S_BOT}` });
    await page.waitForSelector('.ib-msg');

    await page.selectOption('#assigneeSelect', 'staff-2');
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([k]) => k === 'inbox_assign'));
    assert.deepEqual(await rpcCalls(page, 'inbox_assign'), [{ p_session: S_BOT, p_assignee: 'staff-2', p_team: null }]);

    await page.click('#transferBtn');
    await page.selectOption('#transferTeam', TEAM);
    await page.click('#confirmTransfer');
    assert.match(await page.locator('#transferError').innerText(), /سبب/, 'التحويل مشي من غير سبب');
    await page.fill('#transferReason', 'محتاجة حد تقني');
    await page.click('#confirmTransfer');
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([k]) => k === 'inbox_transfer'));
    assert.deepEqual(await rpcCalls(page, 'inbox_transfer'),
        [{ p_session: S_BOT, p_to_user: null, p_to_team: TEAM, p_reason: 'محتاجة حد تقني' }]);

    await page.click('#archiveBtn');
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([k]) => k === 'inbox_set_archived'));
    assert.deepEqual(await rpcCalls(page, 'inbox_set_archived'), [{ p_session: S_BOT, p_archived: true }]);
    // المؤرشفة اختفت من «الكل» وظهرت في «الأرشيف»
    assert.ok(!(await page.locator('#convList').innerText()).includes('سارة إبراهيم'));
    await page.click('[data-view="archived"]');
    assert.ok((await page.locator('#convList').innerText()).includes('سارة إبراهيم'));

    await page.click('#detailsBtn');
    await page.click(`[data-tag="${TAG}"]`);
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([k]) => k === 'inbox_add_tag'));
    assert.deepEqual(await rpcCalls(page, 'inbox_add_tag'), [{ p_session: S_BOT, p_tag: TAG }]);

    assert.deepEqual(await page.evaluate(() => window.__WRITES__ || []), [], 'كتابة مباشرة على جدول');
    assert.deepEqual(errors, []);
    await context.close();
});

test('لوح التفاصيل: ملاحظات العميل وتذاكره من جداولها الموجودة', { skip: !chromiumPath }, async () => {
    const { page, context } = await openInbox(fixtures(), { query: `?session=${S_MANUAL}` });
    await page.waitForSelector('.ib-msg');
    await page.click('#detailsBtn');
    await page.waitForFunction(() => document.querySelector('#detailsPane')?.innerText.includes('#412'));
    const text = await page.locator('#detailsPane').innerText();
    assert.match(text, /عميل مهم — باقة الشركات/);
    assert.match(text, /#412 مشكلة ربط/);
    assert.match(text, /هبة سمير/);
    assert.equal(await page.locator('#detailsPane a[href="/customer-history.html?customer_id=u-karim"]').count(), 1);
    await context.close();
});

test('إدارة الفرق للمرتفع بس', { skip: !chromiumPath }, async () => {
    const elevated = await openInbox(fixtures({ elevated: true }));
    await elevated.page.waitForSelector('.ib-row');
    assert.equal(await elevated.page.locator('#manageTeamsBtn').count(), 1);
    await elevated.page.click('#manageTeamsBtn');
    assert.match(await elevated.page.locator('#teamsList').innerText(), /الدعم الفني/);
    await elevated.context.close();

    const regular = await openInbox(regularTeamMember());
    await regular.page.waitForSelector('.ib-row');
    assert.equal(await regular.page.locator('#manageTeamsBtn').count(), 0);
    await regular.context.close();
});

// منقول من chat-page.render.test.mjs («admin chat: …») بعد شيل chat-admin.html:
// نفس الضمانة، على واجهة الإدارة الوحيدة دلوقتي.
test('مرفقات العميل (صورة وصوت وملف) بتتعرض موقَّعة للطاقم، والنص التلقائي مخفي', { skip: !chromiumPath }, async () => {
    const fx = fixtures();
    const now = t(40);
    fx.tables.chat_sessions[0].chat_messages.push(
        { id: 'a', session_id: S_BOT, sender_id: 'u-sara', is_admin_reply: false, is_bot_reply: false, created_at: now,
          message_text: 'صورة مرفقة', image_url: 'u-sara/a.png', attachment: { kind: 'image', path: 'u-sara/a.png', name: 'a.png' } },
        { id: 'b', session_id: S_BOT, sender_id: 'u-sara', is_admin_reply: false, is_bot_reply: false, created_at: now,
          message_text: 'رسالة صوتية', audio_url: 'u-sara/v.webm', attachment: { kind: 'audio', path: 'u-sara/v.webm', name: 'v.webm', duration_ms: 2000 } },
        { id: 'c', session_id: S_BOT, sender_id: 'u-sara', is_admin_reply: false, is_bot_reply: false, created_at: now,
          message_text: 'الفاتورة دي', attachment: { kind: 'file', path: 'u-sara/f.pdf', name: 'f.pdf', size: 2048 } },
        // صف قديم قبل 054: image_url بس
        { id: 'd', session_id: S_BOT, sender_id: 'u-sara', is_admin_reply: false, is_bot_reply: false, created_at: now,
          message_text: 'قديمة', image_url: 'u-sara/old.png' });
    const { page, context, errors } = await openInbox(fx, { query: `?session=${S_BOT}` });
    await page.waitForFunction(() => document.querySelectorAll('#messageList .cw-att.is-ready').length === 4);

    const text = await page.locator('#messageList').innerText();
    assert.doesNotMatch(text, /صورة مرفقة|رسالة صوتية/, 'النص التلقائي ظاهر جنب المرفق');
    assert.match(text, /الفاتورة دي/);
    assert.match(text, /قديمة/);
    assert.equal(new URL(await page.getAttribute('#messageList a.cw-att-file', 'href')).pathname, '/__file/u-sara/f.pdf');
    const srcs = await page.$$eval('#messageList img, #messageList audio', (els) => els.map((e) => new URL(e.src).pathname));
    assert.deepEqual(srcs.sort(), ['/__file/u-sara/a.png', '/__file/u-sara/old.png', '/__file/u-sara/v.webm']);
    // الملف بمدة التحميل الأطول، والعرض بالقصيرة — نفس صفحة العميل
    const ttls = await page.evaluate(() => window.__SIGNED__.map(([paths, ttl]) => [paths.join(','), ttl]));
    assert.ok(ttls.some(([p, ttl]) => p === 'u-sara/f.pdf' && ttl === 900), `مدد التوقيع ${JSON.stringify(ttls)}`);
    assert.ok(ttls.some(([p, ttl]) => p.includes('u-sara/a.png') && ttl === 300));
    // عدّاد المرفقات في التفاصيل
    await page.click('#detailsBtn');
    assert.match(await page.locator('#detailsPane').innerText(), /مرفقات\s*4/);
    assert.deepEqual(errors, []);
    await context.close();
});

// ═════════════════════════════ المرحلة 2 (056) ═════════════════════════════

/** RPC الإرسال بيرجّع الصف زي القاعدة: بالمرفق اللي اتبعت. */
const echoReply = () => {
    window.__FIXTURES__.rpc.inbox_send_reply = (a) => ({
        id: 'sent-att', session_id: a.p_session, sender_id: 'admin-1', message_text: a.p_body,
        attachment: a.p_attachment, image_url: a.p_attachment?.kind === 'image' ? a.p_attachment.path : null,
        audio_url: a.p_attachment?.kind === 'audio' ? a.p_attachment.path : null,
        is_admin_reply: true, is_bot_reply: false, created_at: new Date(Date.UTC(2026, 8, 25, 10, 0)).toISOString(),
        edited_at: null, deleted_at: null
    });
};

test('مرفق الرد: بيترفع في مجلد الموظف وبيتبعت عبر inbox_send_reply بنص تلقائي', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openInbox(fixtures(), { query: `?session=${S_BOT}`, init: echoReply });
    await page.waitForSelector('.ib-msg');
    assert.equal(await page.locator('#attachBtn').isVisible(), true);

    await page.setInputFiles('#attachInput', { name: 'invoice.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 test') });
    await page.waitForSelector('#attachChip:not([hidden])');
    assert.match(await page.locator('#attachChip').innerText(), /invoice\.pdf/);
    await page.click('#sendBtn');
    await page.waitForSelector('[data-message="sent-att"] .cw-att-file');

    const uploads = await page.evaluate(() => window.__UPLOADS__ || []);
    assert.equal(uploads.length, 1);
    assert.match(uploads[0].path, new RegExp(`^admin-1/${S_BOT}-\\d+-[a-z0-9]{6}\\.pdf$`), 'المسار مش في مجلد الموظف');
    assert.equal(uploads[0].type, 'application/pdf');

    const [call] = await rpcCalls(page, 'inbox_send_reply');
    assert.equal(call.p_body, 'ملف مرفق: invoice.pdf', 'النص التلقائي');
    assert.deepEqual(call.p_attachment, { kind: 'file', path: uploads[0].path, name: 'invoice.pdf', mime: 'application/pdf', size: uploads[0].size });
    assert.equal(await page.locator('#attachChip').isHidden(), true, 'المرفق فضل بعد الإرسال');
    // النص التلقائي مخفي جوه الفقاعة زي رسالة العميل
    assert.doesNotMatch(await page.locator('[data-message="sent-att"] .ib-bubble').innerText(), /ملف مرفق/);
    assert.deepEqual(await page.evaluate(() => window.__WRITES__ || []), [], 'كتابة مباشرة على جدول');
    assert.deepEqual(errors, []);
    await context.close();
});

test('مرفق الرد: صورة بتعليق، ومخفي في الملاحظة الداخلية، والنوع المرفوض مابيترفعش', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openInbox(fixtures(), { query: `?session=${S_BOT}`, init: echoReply });
    await page.waitForSelector('.ib-msg');

    await page.setInputFiles('#attachInput', { name: 'tool.exe', mimeType: 'application/x-msdownload', buffer: Buffer.from('MZ') });
    await page.waitForFunction(() => !document.getElementById('toast').hidden);
    assert.match(await page.locator('#toast').innerText(), /نوع الملف غير مدعوم/);
    assert.equal(await page.locator('#attachChip').isHidden(), true);

    await page.setInputFiles('#attachInput', { name: 'screen.png', mimeType: 'image/png', buffer: PNG_1PX });
    await page.waitForSelector('#attachChip:not([hidden]) img');
    await page.click('#modeToggle [data-mode="note"]');
    assert.equal(await page.locator('#attachBtn').isVisible(), false, 'زرار المرفق ظاهر في الملاحظة');
    assert.equal(await page.locator('#attachChip').isVisible(), false, 'المرفق ظاهر في الملاحظة');
    await page.click('#modeToggle [data-mode="reply"]');
    await page.fill('#messageInput', 'دي الشاشة الصح');
    await page.press('#messageInput', 'Enter');
    await page.waitForSelector('[data-message="sent-att"] .cw-att-image');

    const [call] = await rpcCalls(page, 'inbox_send_reply');
    assert.equal(call.p_body, 'دي الشاشة الصح');
    assert.equal(call.p_attachment.kind, 'image');
    assert.match(call.p_attachment.path, /^admin-1\/.+\.png$/);
    assert.equal((await page.evaluate(() => window.__UPLOADS__)).length, 1, 'الملف المرفوض اترفع');
    assert.deepEqual(errors, []);
    await context.close();
});

test('مرفق الرد: فشل الرفع مابيبعتش رد، وفشل الإرسال بيشيل الملف اليتيم', { skip: !chromiumPath }, async () => {
    const failing = () => {
        window.__UPLOAD_ERROR__ = 'upload 413: Payload too large';
        window.__FIXTURES__.rpc.inbox_send_reply = () => { throw new Error('المحادثة مقفولة — العميل مش هيشوف الرد'); };
    };
    const { page, context } = await openInbox(fixtures(), { query: `?session=${S_BOT}`, init: failing });
    await page.waitForSelector('.ib-msg');
    await page.setInputFiles('#attachInput', { name: 'report.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF') });
    await page.click('#sendBtn');
    await page.waitForFunction(() => /الحد المسموح/.test(document.getElementById('toast').textContent));
    assert.equal((await rpcCalls(page, 'inbox_send_reply')).length, 0, 'الرد اتبعت رغم فشل الرفع');
    assert.equal(await page.locator('#attachChip').isVisible(), true, 'المرفق ضاع بعد الفشل');

    await page.evaluate(() => { window.__UPLOAD_ERROR__ = null; });
    await page.click('#sendBtn');
    await page.waitForFunction(() => /مقفولة/.test(document.getElementById('toast').textContent));
    const uploads = await page.evaluate(() => window.__UPLOADS__);
    assert.deepEqual(await page.evaluate(() => window.__REMOVED__), [uploads[uploads.length - 1].path], 'الملف اليتيم ماتشالش');
    assert.equal(await page.locator('#attachChip').isVisible(), true);
    await context.close();
});

test('تعديل وحذف: ردي بس (والمرتفع يحذف رد غيره)، ورسايل العميل والبوت مالهاش', { skip: !chromiumPath }, async () => {
    const fx = fixtures();
    fx.tables.chat_sessions[1].chat_messages.push(
        { ...msg('m8', S_MANUAL, 14, 'الفاتورة هتوصلك', 'agent', ADMIN), edited_at: null, deleted_at: null });
    const init = () => {
        const base = { session_id: 'aaaaaaaa-0000-4000-8000-000000000002', sender_id: 'admin-1', is_admin_reply: true, is_bot_reply: false,
                       created_at: new Date(Date.UTC(2026, 8, 25, 9, 14)).toISOString(), image_url: null, attachment: null };
        window.__FIXTURES__.rpc.inbox_edit_message = (a) => ({ ...base, id: a.p_message, message_text: a.p_body, edited_at: new Date().toISOString(), deleted_at: null });
        window.__FIXTURES__.rpc.inbox_delete_message = (a) => ({ ...base, id: a.p_message, message_text: '', edited_at: new Date().toISOString(), deleted_at: new Date().toISOString() });
    };
    const { page, context, errors } = await openInbox(fx, { query: `?session=${S_MANUAL}`, init });
    await page.waitForSelector('[data-message="m8"]');

    // الأدوات: ردي = تعديل + حذف؛ رد هبة = حذف بس (أنا مرتفع)؛ العميل = مفيش
    const tools = (id) => page.$$eval(`[data-message="${id}"] .ib-tools [data-act]`, (bs) => bs.map((b) => b.dataset.act));
    assert.deepEqual(await tools('m8'), ['react', 'forward', 'edit-message', 'delete-message']);
    assert.deepEqual(await tools('m4'), ['react', 'forward', 'delete-message']);
    assert.deepEqual(await tools('m3'), ['react', 'forward']);

    await page.hover('[data-message="m8"]');
    await page.click('[data-message="m8"] [data-act="edit-message"]');
    assert.equal(await page.locator('#editingLabel').innerText(), 'تعديل رد للعميل');
    assert.equal(await page.inputValue('#messageInput'), 'الفاتورة هتوصلك');
    assert.equal(await page.locator('#attachBtn').isVisible(), false, 'المرفق متاح أثناء التعديل');
    await page.fill('#messageInput', 'الفاتورة هتوصلك على الإيميل');
    await page.press('#messageInput', 'Enter');
    await page.waitForFunction(() => document.querySelector('[data-message="m8"]')?.textContent.includes('على الإيميل'));
    assert.deepEqual(await rpcCalls(page, 'inbox_edit_message'), [{ p_message: 'm8', p_body: 'الفاتورة هتوصلك على الإيميل' }]);
    assert.equal((await rpcCalls(page, 'inbox_send_reply')).length, 0, 'التعديل اتبعت رد جديد');
    assert.match(await page.locator('[data-message="m8"] .ib-msg-meta').innerText(), /معدّلة/);
    assert.equal(await page.locator('#editingBar').isHidden(), true);

    page.once('dialog', (d) => d.accept());
    await page.hover('[data-message="m8"]');
    await page.click('[data-message="m8"] [data-act="delete-message"]');
    await page.waitForSelector('[data-message="m8"].is-deleted');
    assert.deepEqual(await rpcCalls(page, 'inbox_delete_message'), [{ p_message: 'm8' }]);
    assert.match(await page.locator('[data-message="m8"]').innerText(), /تم حذف هذه الرسالة/);
    assert.equal(await page.locator('[data-message="m8"] .ib-tools').count(), 0, 'أدوات على رد محذوف');
    assert.deepEqual(await page.evaluate(() => window.__WRITES__ || []), [], 'كتابة مباشرة على جدول');
    assert.deepEqual(errors, []);
    await context.close();

    // غير المرتفع: رد زميله مالوش حذف
    const regular = await openInbox(regularTeamMember(), { query: `?session=${S_MANUAL}` });
    await regular.page.waitForSelector('[data-message="m4"]');
    assert.deepEqual(await regular.page.$$eval('[data-message="m4"] .ib-tools [data-act]', (bs) => bs.map((b) => b.dataset.act)), ['react', 'forward']);
    await regular.context.close();
});

test('الرد المحذوف بيبان محذوف، والنص الأصلي للفريق بس من chat_message_revisions', { skip: !chromiumPath }, async () => {
    const fx = fixtures();
    fx.tables.chat_sessions[1].chat_messages.push(
        { ...msg('m9', S_MANUAL, 14, '', 'agent', 'staff-2'), edited_at: t(15), deleted_at: t(15) });
    fx.tables.chat_message_revisions = [
        { id: 'rv1', message_id: 'm9', session_id: S_MANUAL, action: 'delete', previous_text: 'رقم الكارت 4111', previous_attachment: null, actor_id: 'staff-2', created_at: t(15) }
    ];
    const { page, context, errors } = await openInbox(fx, { query: `?session=${S_MANUAL}` });
    await page.waitForSelector('[data-message="m9"] [data-act="revisions"]');
    assert.match(await page.locator('[data-message="m9"]').innerText(), /تم حذف هذه الرسالة — هبة سمير/);
    assert.doesNotMatch(await page.locator('[data-message="m9"]').innerText(), /4111/, 'النص الأصلي ظاهر من غير طلب');
    await page.click('[data-message="m9"] [data-act="revisions"]');
    assert.match(await page.locator('[data-message="m9"] .ib-revisions').innerText(), /قبل الحذف · هبة سمير[\s\S]*رقم الكارت 4111/);
    // المعاينة في القايمة مابتسرّبش النص
    assert.match(await page.locator(`[data-conversation="${S_MANUAL}"] .ib-row-preview`).innerText(), /تم حذف هذه الرسالة/);
    assert.deepEqual(errors, []);
    await context.close();
});

test('التفاعلات: بتتعرض بأسماء الفريق، وبتتسجل عبر inbox_toggle_reaction على رسالة أو ملاحظة', { skip: !chromiumPath }, async () => {
    const fx = fixtures();
    fx.tables.inbox_reactions = [
        { id: 'rx1', session_id: S_MANUAL, message_id: 'm3', note_id: null, user_id: 'staff-2', emoji: '👀', created_at: t(12) },
        { id: 'rx2', session_id: S_MANUAL, message_id: 'm3', note_id: null, user_id: ADMIN, emoji: '👀', created_at: t(12) }
    ];
    fx.rpc.inbox_toggle_reaction = true;
    const { page, context, errors } = await openInbox(fx, { query: `?session=${S_MANUAL}` });
    await page.waitForSelector('[data-message="m3"] .ib-reaction');
    const chip = page.locator('[data-message="m3"] .ib-reaction');
    assert.match(await chip.innerText(), /👀\s*2/);
    assert.equal(await chip.getAttribute('title'), 'هبة سمير، أنت');
    assert.equal(await chip.evaluate((b) => b.classList.contains('is-mine')), true);

    await page.hover('[data-message="m5"]');
    await page.click('[data-message="m5"] [data-act="react"]');
    assert.equal(await page.locator('[data-message="m5"] .ib-react-pick button').count(), 8);
    await page.click('[data-message="m5"] .ib-react-pick [data-emoji="✅"]');
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([k]) => k === 'inbox_toggle_reaction'));

    await page.hover('[data-note="n1"]');
    await page.click('[data-note="n1"] [data-act="react-note"]');
    await page.click('[data-note="n1"] .ib-react-pick [data-emoji="👍"]');
    await chip.click();
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).filter(([k]) => k === 'inbox_toggle_reaction').length === 3);
    assert.deepEqual(await rpcCalls(page, 'inbox_toggle_reaction'), [
        { p_message: 'm5', p_note: null, p_emoji: '✅' },
        { p_message: null, p_note: 'n1', p_emoji: '👍' },
        { p_message: 'm3', p_note: null, p_emoji: '👀' }
    ]);
    assert.deepEqual(await page.evaluate(() => window.__WRITES__ || []), [], 'كتابة مباشرة على جدول');
    assert.deepEqual(errors, []);
    await context.close();
});

test('الصفحة مقفولة على الطاقم — السوبر يوزر مابيشوفش محادثات', { skip: !chromiumPath }, async () => {
    const { page, context } = await openInbox(fixtures({ role: 'super_user' }));
    await page.waitForSelector('#accessDeniedPanel', { timeout: 10000 });
    assert.equal(await page.locator('.ib-row').count(), 0);
    await context.close();
});

// ═════════════════════ 057: الإشراف من الخادم حسب السياق ═════════════════════

test('مش مشرف (inbox_my_access): المسندة لي بس، ومحادثتي كعميل مش في الصندوق، ومفيش أزرار إشراف', { skip: !chromiumPath }, async () => {
    const fx = fixtures({ elevated: true });            // الصفوف بتقول مرتفع…
    fx.rpc.inbox_my_access = { agent: true, supervisor: false };   // …والجلسة بتقول لأ (زي المالك قبل 057)
    fx.tables.inbox_conversations.push({ session_id: S_BOT, assignee_id: ADMIN, team_id: null, archived_at: null, archived_by: null, updated_at: t(5) });
    // محادثة من حساب الموظف نفسه كعميل — سياسة «جلساتي» بترجّعها، والصندوق مايقدرش يتصرف فيها
    fx.tables.chat_sessions.push({ id: 'own-1', user_id: ADMIN, guest_id: null, status: 'active', is_manual_mode: false,
        created_at: t(50), updated_at: t(50), chat_messages: [msg('own-m', 'own-1', 50, 'تجربة من حسابي', 'customer', ADMIN)] });
    fx.tables.chat_sessions[1].chat_messages.push({ ...msg('m8', S_MANUAL, 14, 'رد هبة', 'agent', 'staff-2'), edited_at: null, deleted_at: null });

    const { page, context, errors } = await openInbox(fx);
    await page.waitForSelector('.ib-row');
    assert.deepEqual(await page.locator('.ib-row-title').allInnerTexts(), ['سارة إبراهيم'], 'غير المسندة ظاهرة');
    assert.equal(await page.locator('#manageTeamsBtn').count(), 0, 'إدارة الفرق ظاهرة لغير المشرف');

    // رابط مباشر لمحادثة مش مسندة له: رفض واضح بدل 403 على كل ضغطة
    await page.goto(`${baseUrl}/admin/inbox.html?session=own-1`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => /مش مسموحلك/.test(document.getElementById('toast').textContent));
    assert.equal(await page.locator('#threadBody').isVisible(), false);
    assert.deepEqual(errors, []);
    await context.close();
});

test('المالك في سياق مش إداري: الصندوق بيقول السبب ومايبعتش حاجة', { skip: !chromiumPath }, async () => {
    const fx = fixtures();
    fx.rpc.inbox_my_access = { agent: false, supervisor: false };
    const { page, context } = await openInbox(fx, { query: `?session=${S_BOT}` });
    await page.waitForSelector('#noInboxAccess');
    assert.match(await page.locator('#noInboxAccess').innerText(), /سياق مش إداري/);
    assert.equal(await page.locator('.ib-row').count(), 0);
    assert.equal(await page.locator('#threadBody').isVisible(), false, 'المحادثة اتفتحت رغم إن مفيش صلاحية');
    assert.equal((await rpcCalls(page, 'inbox_send_reply')).length, 0);
    await context.close();
});

test('مشرف (المالك في سياق الإدارة بعد 057): كل المحادثات، وإدارة الفرق، وحذف رد زميل', { skip: !chromiumPath }, async () => {
    const fx = fixtures({ elevated: false });           // حتى لو الصفوف مش مرتفعة، الجلسة مشرفة
    fx.rpc.inbox_my_access = { agent: true, supervisor: true };
    fx.tables.chat_sessions[1].chat_messages.push({ ...msg('m8', S_MANUAL, 14, 'رد هبة', 'agent', 'staff-2'), edited_at: null, deleted_at: null });
    const { page, context, errors } = await openInbox(fx, { query: `?session=${S_MANUAL}` });
    await page.waitForSelector('[data-message="m8"]');
    assert.equal(await page.locator('.ib-row').count(), 4);
    assert.equal(await page.locator('#manageTeamsBtn').count(), 1);
    assert.deepEqual(await page.$$eval('[data-message="m8"] .ib-tools [data-act]', (bs) => bs.map((b) => b.dataset.act)),
        ['react', 'forward', 'delete-message']);
    await page.fill('#messageInput', 'رد من المالك');
    await page.press('#messageInput', 'Enter');
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([k]) => k === 'inbox_send_reply'));
    assert.deepEqual(errors, []);
    await context.close();
});

test('قبل 057 (مفيش inbox_my_access): الصندوق بيشتغل بالسلوك القديم', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openInbox(fixtures({ elevated: true }));
    await page.waitForSelector('.ib-row');
    assert.equal(await page.locator('.ib-row').count(), 4);
    assert.equal(await page.locator('#manageTeamsBtn').count(), 1);
    assert.deepEqual(errors, []);
    await context.close();
});

// ═════════════════════════════ المرحلة 3 (058): الجدولة ═════════════════════════════

/** RPC الجدولة بيرجّع الصف زي القاعدة، والإلغاء بيرجّعه ملغي. */
const echoSchedule = () => {
    window.__FIXTURES__.rpc.inbox_schedule_reply = (a) => ({
        id: 'sch-new', session_id: a.p_session, author_id: 'admin-1', body: a.p_body, attachment: a.p_attachment,
        send_at: a.p_send_at, status: 'pending', message_id: null, failure_reason: null,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    });
    window.__FIXTURES__.rpc.inbox_cancel_scheduled = (a) => ({ id: a.p_id, status: 'cancelled' });
};

test('الجدولة: الرد اللي في الخانة بيتجدول عبر inbox_schedule_reply ويظهر كرد مستني', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openInbox(fixtures(), { query: `?session=${S_BOT}`, init: echoSchedule });
    await page.waitForSelector('.ib-msg');

    // من غير نص ولا مرفق: مفيش حاجة تتجدول
    await page.click('#scheduleBtn');
    assert.equal(await page.locator('#scheduleDialog').isVisible(), false);
    assert.match(await page.locator('#toast').innerText(), /اكتب الرد/);

    await page.fill('#messageInput', 'هنبعتلك الفاتورة الصبح');
    await page.click('#scheduleBtn');
    await page.waitForSelector('#scheduleDialog[open]');
    // ميعاد فات: رفض من الواجهة قبل القاعدة
    await page.fill('#scheduleAt', '2020-01-01T09:00');
    await page.click('#confirmSchedule');
    assert.match(await page.locator('#scheduleError').innerText(), /بعد دقيقة/);
    assert.equal((await rpcCalls(page, 'inbox_schedule_reply')).length, 0);

    await page.click('#scheduleQuick [data-quick]:has-text("بكرة 9 الصبح")');
    await page.click('#confirmSchedule');
    await page.waitForSelector('[data-scheduled="sch-new"]');

    const [call] = await rpcCalls(page, 'inbox_schedule_reply');
    assert.equal(call.p_session, S_BOT);
    assert.equal(call.p_body, 'هنبعتلك الفاتورة الصبح');
    assert.equal(call.p_attachment, null);
    const at = new Date(call.p_send_at);
    assert.equal(at.getHours(), 9, 'مش 9 الصبح بتوقيت الجهاز');
    assert.ok(at > new Date(), 'الميعاد في الماضي');
    assert.match(call.p_send_at, /Z$/, 'الميعاد مش متبعت UTC');

    assert.equal((await rpcCalls(page, 'inbox_send_reply')).length, 0, 'اتبعت فورًا بدل ما يتجدول');
    assert.equal(await page.inputValue('#messageInput'), '');
    assert.match(await page.locator('[data-scheduled="sch-new"]').innerText(), /مجدول لـ[\s\S]*العميل مش شايفه لسه/);
    assert.deepEqual(await page.evaluate(() => window.__WRITES__ || []), [], 'كتابة مباشرة على جدول');
    assert.deepEqual(errors, []);
    await context.close();
});

test('الجدولة: المستني بيتلغي، والفاشل بسببه، والمرفق بيترفع في مجلد الكاتب', { skip: !chromiumPath }, async () => {
    const fx = fixtures();
    fx.tables.inbox_scheduled_replies = [
        { id: 'sch-1', session_id: S_BOT, author_id: ADMIN, body: 'تذكير بالدفع', attachment: null, status: 'pending',
          send_at: new Date(Date.now() + 3600e3).toISOString(), failure_reason: null, updated_at: t(20) },
        { id: 'sch-2', session_id: S_BOT, author_id: 'staff-2', body: 'رد هبة المجدول', attachment: null, status: 'failed',
          send_at: t(8), failure_reason: 'الكاتب مابقاش يوصل للمحادثة (اتنقلت أو اتشال من الفريق)', updated_at: t(8) }
    ];
    const { page, context, errors } = await openInbox(fx, { query: `?session=${S_BOT}`, init: echoSchedule });
    await page.waitForSelector('[data-scheduled="sch-2"]');
    assert.match(await page.locator('[data-scheduled="sch-2"]').innerText(), /رد مجدول ماتبعتش[\s\S]*مابقاش يوصل للمحادثة/);
    assert.equal(await page.locator('[data-scheduled="sch-2"] [data-act="cancel-scheduled"]').count(), 0, 'إلغاء لرد فاشل');

    page.once('dialog', (d) => d.accept());
    await page.click('[data-scheduled="sch-1"] [data-act="cancel-scheduled"]');
    await page.waitForFunction(() => !document.querySelector('[data-scheduled="sch-1"]'));
    assert.deepEqual(await rpcCalls(page, 'inbox_cancel_scheduled'), [{ p_id: 'sch-1' }]);

    // مرفق مجدول: بيترفع دلوقتي في مجلد الكاتب، والقاعدة بتتحقق منه وقت الجدولة
    await page.setInputFiles('#attachInput', { name: 'invoice.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') });
    await page.waitForSelector('#attachChip:not([hidden])');
    await page.click('#scheduleBtn');
    await page.click('#confirmSchedule');
    await page.waitForSelector('[data-scheduled="sch-new"] .cw-att-file');
    const [call] = await rpcCalls(page, 'inbox_schedule_reply');
    assert.equal(call.p_body, 'ملف مرفق: invoice.pdf');
    assert.match(call.p_attachment.path, new RegExp(`^admin-1/${S_BOT}-`));
    assert.equal(await page.locator('#attachChip').isHidden(), true);
    await page.click('#detailsBtn');
    assert.match(await page.locator('#detailsPane').innerText(), /ردود مجدولة\s*1/);
    assert.deepEqual(errors, []);
    await context.close();
});

// لقطات للمراجعة البصرية: INBOX_SHOTS=<dir> node --test tests/admin-inbox.render.test.mjs
test('visual: المرحلة 2 — مرفق، تفاعلات، رد معدّل ومحذوف، تعديل', { skip: !chromiumPath || !process.env.INBOX_SHOTS }, async () => {
    const dir = process.env.INBOX_SHOTS;
    fs.mkdirSync(dir, { recursive: true });
    const fx = fixtures();
    fx.tables.chat_sessions[1].chat_messages.push(
        { ...msg('m8', S_MANUAL, 14, 'الفاتورة اتبعتت على الإيميل', 'agent', ADMIN), edited_at: t(15), deleted_at: null },
        { ...msg('m9', S_MANUAL, 16, '', 'agent', 'staff-2'), edited_at: t(17), deleted_at: t(17) },
        { ...msg('m10', S_MANUAL, 18, 'دي صورة الإعدادات', 'agent', ADMIN), image_url: `${ADMIN}/s.png`,
          attachment: { kind: 'image', path: `${ADMIN}/s.png`, name: 's.png' }, edited_at: null, deleted_at: null });
    fx.tables.chat_message_revisions = [
        { id: 'rv0', message_id: 'm8', session_id: S_MANUAL, action: 'edit', previous_text: 'الفاتورة اتبعتت', previous_attachment: null, actor_id: ADMIN, created_at: t(15) },
        { id: 'rv1', message_id: 'm9', session_id: S_MANUAL, action: 'delete', previous_text: 'رد غلط', previous_attachment: null, actor_id: 'staff-2', created_at: t(17) }
    ];
    fx.tables.inbox_reactions = [
        { id: 'rx1', session_id: S_MANUAL, message_id: 'm3', note_id: null, user_id: 'staff-2', emoji: '👀', created_at: t(12) },
        { id: 'rx2', session_id: S_MANUAL, message_id: null, note_id: 'n1', user_id: ADMIN, emoji: '👍', created_at: t(12) }
    ];
    fx.tables.inbox_scheduled_replies = [
        { id: 'sch-f', session_id: S_MANUAL, author_id: 'staff-2', body: 'تذكير بميعاد التجديد', attachment: null, status: 'failed',
          send_at: t(19), failure_reason: 'المحادثة مقفولة — العميل مش هيشوف الرد', updated_at: t(19) },
        { id: 'sch-p', session_id: S_MANUAL, author_id: ADMIN, body: 'صباح الخير يا كريم، الفاتورة وصلتك؟', attachment: null, status: 'pending',
          send_at: new Date(Date.now() + 20 * 3600e3).toISOString(), failure_reason: null, updated_at: t(20) }
    ];
    for (const [name, viewport] of [['desktop', { width: 1400, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
        for (const theme of ['light', 'dark']) {
            const { page, context } = await openInbox(fx, { query: `?session=${S_MANUAL}`, viewport });
            await page.waitForSelector('[data-message="m10"] .cw-att-image.is-ready');
            if (theme === 'dark') await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
            await page.click('[data-message="m8"] [data-act="revisions"]');
            await page.hover('[data-message="m5"]');
            await page.click('[data-message="m5"] [data-act="react"]');
            await page.setInputFiles('#attachInput', { name: 'invoice-sept.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') });
            await page.waitForSelector('#attachChip:not([hidden])');
            await page.waitForTimeout(250);
            await page.screenshot({ path: path.join(dir, `${name}-${theme}-thread.png`) });
            await page.click('#scheduleBtn');
            await page.waitForSelector('#scheduleDialog[open]');
            await page.screenshot({ path: path.join(dir, `${name}-${theme}-schedule.png`) });
            await page.click('#cancelSchedule');
            await page.hover('[data-message="m10"]');
            await page.click('[data-message="m10"] [data-act="edit-message"]');
            await page.waitForTimeout(150);
            await page.screenshot({ path: path.join(dir, `${name}-${theme}-editing.png`) });
            await context.close();
        }
    }
});
