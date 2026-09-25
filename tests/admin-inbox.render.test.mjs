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
 * شكل البيانات بعد 054: الجلسات من chat_sessions (برسايلها)، وحالة الـ
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
    assert.deepEqual(await rpcCalls(page, 'inbox_send_reply'), [{ p_session: S_BOT, p_body: 'أهلاً سارة، معاكي الدعم' }]);
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

    const regular = await openInbox(fixtures({ elevated: false }));
    await regular.page.waitForSelector('.ib-row');
    assert.equal(await regular.page.locator('#manageTeamsBtn').count(), 0);
    await regular.context.close();
});

test('الصفحة مقفولة على الطاقم — السوبر يوزر مابيشوفش محادثات', { skip: !chromiumPath }, async () => {
    const { page, context } = await openInbox(fixtures({ role: 'super_user' }));
    await page.waitForSelector('#accessDeniedPanel', { timeout: 10000 });
    assert.equal(await page.locator('.ib-row').count(), 0);
    await context.close();
});
