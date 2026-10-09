/**
 * Relay المرحلة C في متصفح حقيقي: نافذة «اختيار الرسائل» ← «معاينة النوع» ←
 * التفاصيل من صندوق الرسائل (admin/inbox.html)، وصفحة Relay (admin/relay.html).
 *
 * الكود الحقيقي (inbox.js + relay-composer.js + relay-page.js) على بديل Supabase.
 * الصلاحيات نفسها مقيسة على الخادم في tests/sql/relay-phase-c.test.sql؛ هنا:
 * ما يظهر لكل صلاحية، وما يُرسل للـRPC بالظبط، وRTL، والموبايل (390px).
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
    '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
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
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function resolveChromium() {
    try {
        const p = chromium.executablePath();
        if (p && fs.existsSync(p)) return p;
    } catch { /* لا تنزيل افتراضي */ }
    const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
    if (root && fs.existsSync(root)) {
        for (const dir of fs.readdirSync(root).filter((d) => d.startsWith('chromium')).sort().reverse()) {
            for (const rel of ['chrome-linux/chrome', 'chrome-linux/headless_shell', 'chrome']) {
                const candidate = path.join(root, dir, rel);
                if (fs.existsSync(candidate)) return candidate;
            }
        }
    }
    return null;
}

const ME = 'admin-1';
const STAFF = 'staff-2';
const TEAM = 'team-0000-0000-0000-000000000001';
const S = 'bbbbbbbb-0000-4000-8000-000000000001';
const REC = 'cccccccc-0000-4000-8000-000000000001';
const REC_OTHER = 'cccccccc-0000-4000-8000-000000000002';
const at = (h, mi) => new Date(Date.UTC(2026, 9, 7, h, mi)).toISOString();
const msg = (id, h, mi, text, kind) => ({
    id, session_id: S, message_text: text, created_at: at(h, mi), image_url: null,
    sender_id: kind === 'bot' ? null : kind === 'agent' ? STAFF : 'u-ahmed',
    is_admin_reply: kind === 'agent', is_bot_reply: kind === 'bot',
});
// نفس محادثة شاشة المرجع الأولى
const MESSAGES = [
    msg('m1', 7, 24, 'مرحبًا، أريد الاستفسار عن حالة طلبي', 'customer'),
    msg('m2', 7, 25, 'أهلاً بك، من فضلك أرسل رقم الطلب وسنقوم بالمراجعة', 'agent'),
    msg('m3', 7, 27, 'رقم الطلب هو 45879', 'customer'),
    msg('m4', 7, 30, 'شكرًا، جاري التحقق من حالة الطلب ...', 'agent'),
    msg('m5', 7, 32, 'هل هناك موعد متوقع للتسليم؟', 'customer'),
    msg('m6', 7, 35, 'من المتوقع أن يتم التسليم خلال 2-3 أيام عمل', 'agent'),
    msg('m7', 8, 2, 'شكرًا لكم', 'customer'),
];

function fixtures({ access = { member: true, enabled: true, supervisor: false, can_assign: false }, extraMessages = [] } = {}) {
    return {
        user: { id: ME, email: 'admin@test.local' },
        authUser: { id: ME, email: 'admin@test.local', profile: { id: ME, role: 'admin' } },
        tables: {
            chat_sessions: [{ id: S, user_id: 'u-ahmed', guest_id: null, status: 'active', is_manual_mode: true,
                created_at: at(7, 24), updated_at: at(8, 2), chat_messages: [...MESSAGES, ...extraMessages] }],
            chat_messages: [],
            inbox_conversations: [{ session_id: S, assignee_id: ME, team_id: null, archived_at: null, archived_by: null, updated_at: at(8, 2) }],
            inbox_conversation_tags: [], inbox_notes: [], inbox_events: [],
            inbox_teams: [{ id: TEAM, name: 'الدعم الفني', description: null, archived_at: null }],
            inbox_team_members: [{ team_id: TEAM, user_id: STAFF, role: 'lead' }],
            ticket_tags: [], customer_notes: [], tickets: [], canned_responses: [],
        },
        rpc: {
            inbox_my_access: { agent: true, supervisor: Boolean(access.supervisor) },
            relay_my_access: access,
            inbox_customer_profiles: [{ session_id: S, user_id: 'u-ahmed', full_name: 'أحمد محمد', email: 'ahmed@test.local',
                phone: '+20 100 123 4567', role: 'user', created_at: at(0, 0) }],
            inbox_list_agents: [
                { id: ME, full_name: 'الأدمن', email: 'admin@test.local', role: 'admin', is_elevated: Boolean(access.supervisor), team_ids: [] },
                { id: STAFF, full_name: 'هبة سمير', email: 'heba@test.local', role: 'support', is_elevated: false, team_ids: [TEAM] },
            ],
        },
    };
}

let browser; let server; let baseUrl;
const chromiumPath = resolveChromium();
if (!chromiumPath) console.error('SKIP: لا يوجد متصفح Chromium متاح؛ اختبارات Relay المرحلة C لم تُنفَّذ');

test.before(async () => {
    if (!chromiumPath) return;
    server = await startServer();
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: chromiumPath });
});
test.after(async () => { await browser?.close(); server?.close(); });

const rpcCalls = (page, name) => page.evaluate((n) => (window.__RPC_ARGS__ || []).filter(([k]) => k === n).map(([, a]) => a), name);

async function openPage(fx, { url, viewport, init = null } = {}) {
    const context = await browser.newContext({ viewport: viewport || { width: 1400, height: 900 }, locale: 'ar-EG', timezoneId: 'Africa/Cairo' });
    const page = await context.newPage();
    // أخطاء الخادم بشكل PostgREST الكامل (code + details) — البديل المشترك يرجّع رسالة فقط.
    const double = fs.readFileSync(path.join(ROOT, 'tests/fixtures/supabase-double.js'), 'utf8')
        .replace("if (failure) return { data: null, error: { message: failure, code: 'P0001' } };",
            "if (failure) return { data: null, error: typeof failure === 'object' ? failure : { message: failure, code: 'P0001' } };");
    assert.ok(double.includes("typeof failure === 'object'"), 'مقدرتش أعدّل البديل');
    const auth = fs.readFileSync(path.join(ROOT, 'tests/fixtures/auth-client-double.js'), 'utf8');
    await page.route('**/api-config.js', (r) => r.fulfill({ contentType: 'text/javascript; charset=utf-8', body: double }));
    await page.route('**/auth-client.js', (r) => r.fulfill({ contentType: 'text/javascript; charset=utf-8', body: auth }));
    await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: '' }));
    await page.addInitScript((data) => { window.__FIXTURES__ = data; }, fx);
    if (init) await page.addInitScript(init);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // فشل تحميل موارد خارجية (خطوط/CDN) من بيئة الاختبار المعزولة ليس خطأ في الكود
    page.on('console', (m) => { if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) errors.push(m.text()); });
    await page.goto(`${baseUrl}${url}`, { waitUntil: 'networkidle' });
    return { page, context, errors };
}

async function openComposer(fx, opts = {}) {
    const r = await openPage(fx, { url: `/admin/inbox.html?session=${S}`, ...opts });
    await r.page.waitForSelector('.ib-msg');
    await r.page.locator('#relayBtn').click();
    await r.page.waitForSelector('#relayComposer[open] .rl-msg');
    return r;
}

const rowCheck = (page, id) => page.locator(`[data-pick="${id}"]`);

test('select → deselect → type preview → details → create: what is sent is exactly what the user confirmed', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openComposer(fixtures());
    const dlg = page.locator('#relayComposer');
    assert.equal(await dlg.getAttribute('dir'), 'rtl');
    assert.equal(await page.locator('#rlTitle').innerText(), 'اختيار الرسائل');
    assert.equal(await page.locator('.rl-msg').count(), 7);
    assert.match(await page.locator('.rl-conv-head').innerText(), /أحمد محمد[\s\S]*\+20 100 123 4567[\s\S]*7 رسائل/);
    assert.equal(await page.locator('#rlAttach').isDisabled(), true, 'attach enabled with nothing selected');

    // اختيار بالضغط على الصف، وبالكيبورد (Space على مربع الاختيار)
    await page.locator('[data-msg="m6"]').click();
    await page.locator('[data-msg="m2"]').click();
    await rowCheck(page, 'm3').focus();
    await page.keyboard.press('Space');
    assert.match(await page.locator('#rlCount').innerText(), /تم اختيار 3 رسائل/);
    assert.equal(await page.locator('.rl-chip').count(), 3);
    assert.equal(await page.locator('.rl-msg.is-on').count(), 3);
    // إلغاء من الشريط ثم من الصف
    await page.locator('[data-unpick="m6"]').click();
    assert.match(await page.locator('#rlCount').innerText(), /تم اختيار 2 رسائل/);
    assert.equal(await rowCheck(page, 'm6').isChecked(), false);
    await rowCheck(page, 'm2').focus();
    await page.keyboard.press('Space');
    assert.equal(await page.locator('.rl-chip').count(), 1);
    await page.locator('[data-msg="m2"]').click();
    await page.locator('[data-msg="m6"]').click();
    assert.equal(await page.locator('.rl-chip').count(), 3);

    // البحث والفلاتر لا تمسح الاختيار
    await page.locator('#rlSearch').fill('تسليم');
    assert.equal(await page.locator('.rl-msg').count(), 2);
    assert.equal(await page.locator('#rlSearch').inputValue(), 'تسليم', 'focus/value lost while typing');
    await page.locator('#rlSearch').fill('');
    await page.locator('#rlParticipant').selectOption('agent');
    assert.equal(await page.locator('.rl-msg').count(), 3);
    await page.locator('#rlParticipant').selectOption('all');
    assert.equal(await page.locator('.rl-chip').count(), 3);

    // معاينة النوع
    await page.locator('#rlAttach').click();
    assert.equal(await page.locator('#rlTitle').innerText(), 'معاينة النوع');
    assert.match(await page.locator('.rl-card h3').innerText(), /الرسائل المختارة \(3\)/);
    assert.equal(await page.locator('.rl-bubble-row').count(), 3);
    assert.equal(await page.locator('#rlSuggested').innerText(), 'حالة طلب');
    assert.match(await page.locator('#rlSuggest').innerText(), /موصى به/);
    assert.equal(await page.locator('.rl-type').count(), 9);
    assert.equal(await page.locator('[data-category="order_status"]').getAttribute('aria-checked'), 'true');
    assert.equal(await page.locator('#rlWhy').isHidden(), true);
    await page.locator('[data-act="why"]').click();
    assert.match(await page.locator('#rlWhy').innerText(), /رقم الطلب/);
    // تغيير النوع والملاحظات
    await page.locator('[data-category="complaint"]').click();
    assert.equal(await page.locator('[data-category="complaint"]').getAttribute('aria-checked'), 'true');
    assert.equal(await page.locator('[data-category="order_status"]').getAttribute('aria-checked'), 'false');
    await page.locator('#rlNote').fill('العميل متضايق من التأخير');
    // رجوع يحفظ الاختيار، والرجوع للأمام يحفظ النوع المختار
    await page.locator('[data-act="back"]').click();
    assert.equal(await page.locator('.rl-chip').count(), 3);
    await page.locator('#rlAttach').click();
    assert.equal(await page.locator('[data-category="complaint"]').getAttribute('aria-checked'), 'true');
    assert.equal(await page.locator('#rlNote').inputValue(), 'العميل متضايق من التأخير');
    await page.locator('#rlConfirmType').click();

    // التفاصيل: شكوى ⇒ «مشكلة تحتاج حلًا» مقترحة، والوصف = الملاحظة (كلام المستخدم)
    assert.equal(await page.locator('#rlTitle').innerText(), 'تفاصيل السجل');
    assert.equal(await page.locator('[data-kind="issue"]').getAttribute('aria-checked'), 'true');
    assert.equal(await page.locator('#rlSummary').inputValue(), 'العميل متضايق من التأخير');
    assert.equal(await page.locator('#rlTitleInput').inputValue(), '', 'title must never be pre-filled (M5)');
    assert.match(await page.locator('#rlTitleInput').getAttribute('placeholder'), /^مثال:/);
    // بلا صلاحية إسناد: أنا أو بلا مالك، ولا فريق
    assert.deepEqual(await page.locator('#rlOwner option').evaluateAll((o) => o.map((x) => x.value)), ['', ME]);
    assert.equal(await page.locator('#rlTeam').count(), 0);
    assert.ok(await page.locator('#rlOwnerHint').isVisible());
    assert.match(await page.locator('#rlMissing').innerText(), /العنوان/);
    assert.equal(await page.locator('#rlSubmit').isDisabled(), true);

    await page.locator('[data-kind="follow_up"]').click();
    assert.match(await page.locator('#rlMissing').innerText(), /الخطوة التالية[\s\S]*الموعد/);
    await page.locator('#rlTitleInput').fill('متابعة تأخير الطلب');
    await page.locator('#rlNext').fill('أكلم شركة الشحن');
    await page.locator('#rlDue').fill('2030-01-15T11:00');
    await page.locator('#rlTz').selectOption('Africa/Cairo');
    assert.equal(await page.locator('#rlMissing').count(), 0, await page.locator('#rlMissing').allInnerTexts().then((x) => x.join()));
    assert.equal(await page.locator('#rlSubmit').isDisabled(), false);

    await page.locator('#rlSubmit').click();
    await page.waitForFunction(() => !document.querySelector('#relayComposer')?.open);
    const [args] = await rpcCalls(page, 'relay_create');
    const req = args.p_request;
    assert.equal(req.kind, 'follow_up');
    assert.equal(req.category, 'complaint');
    assert.equal(req.title, 'متابعة تأخير الطلب');
    assert.equal(req.summary, 'العميل متضايق من التأخير');
    assert.equal(req.next_action, 'أكلم شركة الشحن');
    assert.deepEqual(req.due, { at: '2030-01-15T11:00:00', tz: 'Africa/Cairo' });
    assert.equal(req.owner_id, ME);
    assert.equal(req.team_id, null);
    assert.deepEqual(req.sources.map((s) => s.internal.chat_message_id), ['m2', 'm3', 'm6'], 'chronological source order');
    assert.ok(req.sources.every((s) => Object.keys(s).sort().join() === 'adapter,adapter_version,internal,provider,type'), 'only ids are sent');
    assert.ok(!JSON.stringify(req).includes('45879'), 'message text sent to the server by the client');
    assert.match(req.idempotency_key, /^[0-9a-f-]{36}$/);
    assert.equal((await rpcCalls(page, 'relay_create')).length, 1, 'created more than once');
    assert.match(await page.locator('#toast').innerText(), /سجل الاستمرارية/);
    assert.deepEqual(errors, []);
    await context.close();
});

test('Escape or Cancel closes without creating anything', { skip: !chromiumPath }, async () => {
    const { page, context } = await openComposer(fixtures());
    await page.locator('[data-msg="m3"]').click();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#relayComposer')?.open);
    await page.locator('#relayBtn').click();
    await page.waitForSelector('#relayComposer[open] .rl-msg');
    assert.equal(await page.locator('.rl-chip').count(), 0, 'a reopened composer starts clean');
    await page.locator('.rl-actions [data-act="close"]').click();
    assert.deepEqual(await rpcCalls(page, 'relay_create'), []);
    await context.close();
});

test('an assigner sees every eligible owner and teams; the choice is sent as is', { skip: !chromiumPath }, async () => {
    const { page, context } = await openComposer(fixtures({ access: { member: true, enabled: true, supervisor: false, can_assign: true } }));
    await page.locator('[data-msg="m3"]').click();
    await page.locator('#rlAttach').click();
    await page.locator('#rlConfirmType').click();
    assert.deepEqual(await page.locator('#rlOwner option').evaluateAll((o) => o.map((x) => x.value)), ['', ME, STAFF]);
    assert.equal(await page.locator('#rlOwnerHint').count(), 0);
    await page.locator('#rlOwner').selectOption(STAFF);
    await page.locator('#rlTeam').selectOption(TEAM);
    await page.locator('#rlTitleInput').fill('متابعة');
    await page.locator('#rlNext').fill('اتصال');
    await page.locator('#rlDue').fill('2030-01-15T11:00');
    await page.locator('#rlSubmit').click();
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'relay_create'));
    const [{ p_request: req }] = await rpcCalls(page, 'relay_create');
    assert.equal(req.owner_id, STAFF);
    assert.equal(req.team_id, TEAM);
    await context.close();
});

test('a server refusal (forbidden owner) is explained and nothing is lost', { skip: !chromiumPath }, async () => {
    const fx = fixtures({ access: { member: true, enabled: true, supervisor: false, can_assign: true } });
    fx.rpcErrors = { relay_create: { code: '42501', message: 'غير مسموح', details: '{"code":"forbidden","field":"owner_id"}' } };
    const { page, context } = await openComposer(fx);
    await page.locator('[data-msg="m3"]').click();
    await page.locator('#rlAttach').click();
    await page.locator('#rlConfirmType').click();
    await page.locator('#rlOwner').selectOption(STAFF);
    await page.locator('#rlTitleInput').fill('متابعة');
    await page.locator('#rlNext').fill('اتصال');
    await page.locator('#rlDue').fill('2030-01-15T11:00');
    await page.locator('#rlSubmit').click();
    await page.waitForSelector('#rlError:not(:empty)');
    assert.match(await page.locator('#rlError').innerText(), /مش مسموح لك تسند السجل لموظف تاني/);
    assert.ok(await page.locator('#relayComposer').evaluate((d) => d.open), 'dialog closed on error');
    assert.equal(await page.locator('#rlTitleInput').inputValue(), 'متابعة');
    assert.equal(await page.locator('#rlSubmit').isDisabled(), false);
    // نفس الطلب ⇒ نفس مفتاح التكرار (الخادم يرجع replayed لو الأول وصل)
    await page.locator('#rlSubmit').click();
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).filter(([n]) => n === 'relay_create').length === 2);
    const calls = await rpcCalls(page, 'relay_create');
    assert.equal(calls[0].p_request.idempotency_key, calls[1].p_request.idempotency_key);
    // تعديل الطلب ⇒ مفتاح جديد
    await page.locator('#rlOwner').selectOption(ME);
    await page.locator('#rlSubmit').click();
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).filter(([n]) => n === 'relay_create').length === 3);
    const third = (await rpcCalls(page, 'relay_create'))[2];
    assert.notEqual(third.p_request.idempotency_key, calls[0].p_request.idempotency_key);
    await context.close();
});

test('sensitive content needs an explicit acknowledgement before sending', { skip: !chromiumPath }, async () => {
    const fx = fixtures({ extraMessages: [msg('m8', 8, 5, 'رقم الكارت 4111 1111 1111 1111', 'customer')] });
    const { page, context } = await openComposer(fx);
    await page.locator('[data-msg="m8"]').click();
    await page.locator('#rlAttach').click();
    // لا كلمات تدل على نوع ⇒ لا اقتراح، والمتابعة مقفولة لحد ما المستخدم يختار بنفسه
    assert.equal(await page.locator('#rlSuggested').count(), 0);
    assert.match(await page.locator('#rlSuggest').innerText(), /مفيش نوع واضح/);
    assert.equal(await page.locator('.rl-type[aria-checked="true"]').count(), 0);
    assert.equal(await page.locator('#rlConfirmType').isDisabled(), true);
    await page.locator('[data-category="payment_billing"]').click();
    await page.locator('#rlConfirmType').click();
    await page.locator('#rlTitleInput').fill('متابعة الدفع');
    await page.locator('#rlNext').fill('مراجعة');
    await page.locator('#rlDue').fill('2030-01-15T11:00');
    assert.match(await page.locator('#rlSensitive').innerText(), /رقم كارت/);
    assert.equal(await page.locator('#rlSubmit').isDisabled(), true);
    await page.locator('#rlAck').check();
    assert.equal(await page.locator('#rlSubmit').isDisabled(), false);
    await page.locator('#rlSubmit').click();
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'relay_create'));
    const [{ p_request: req }] = await rpcCalls(page, 'relay_create');
    assert.equal(req.sensitive_ack, true);
    await context.close();
});

test('attach to an existing record calls relay_attach_sources with its version', { skip: !chromiumPath }, async () => {
    const fx = fixtures();
    fx.rpc.relay_list = [{ id: REC, kind: 'follow_up', title: 'متابعة الشحنة', status: 'open', category: 'order_status', version: 4, source_count: 1 }];
    fx.rpc.relay_attach_sources = { record: { id: REC, version: 5 }, sources: [], added: 2 };
    const { page, context } = await openComposer(fx);
    await page.locator('[data-msg="m5"]').click();
    await page.locator('[data-msg="m6"]').click();
    await page.locator('#rlAttach').click();
    await page.locator('#rlConfirmType').click();
    await page.locator('[data-mode="existing"]').click();
    await page.waitForSelector(`[data-record="${REC}"]`);
    assert.equal(await page.locator('#rlSubmit').isDisabled(), true);
    await page.locator(`[data-record="${REC}"]`).click();
    await page.locator('#rlSubmit').click();
    await page.waitForFunction(() => !document.querySelector('#relayComposer')?.open);
    const [args] = await rpcCalls(page, 'relay_attach_sources');
    assert.equal(args.p_record, REC);
    assert.equal(args.p_expected_version, 4);
    assert.deepEqual(args.p_sources.map((s) => s.internal.chat_message_id), ['m5', 'm6']);
    const [listArgs] = await rpcCalls(page, 'relay_list');
    assert.deepEqual(listArgs.p_filters.status, ['open', 'scheduled', 'in_progress', 'waiting']);
    assert.deepEqual(await rpcCalls(page, 'relay_create'), []);
    await context.close();
});

test('no Relay button when Relay is off, the caller is not a member, or 074 is not deployed', { skip: !chromiumPath }, async () => {
    for (const access of [{ member: true, enabled: false, supervisor: false, can_assign: false },
        { member: false, enabled: false, supervisor: false, can_assign: false }, null]) {
        const fx = fixtures();
        fx.rpc.relay_my_access = access;
        const { page, context } = await openPage(fx, { url: `/admin/inbox.html?session=${S}` });
        await page.waitForSelector('.ib-msg');
        assert.equal(await page.locator('#relayBtn').isHidden(), true, JSON.stringify(access));
        await context.close();
    }
});

test('mobile 390px RTL: full-screen dialog, no horizontal overflow, 44px targets, two-column types', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openComposer(fixtures(), { viewport: { width: 390, height: 844 } });
    const box = await page.locator('#relayComposer').boundingBox();
    assert.ok(box.width >= 389 && box.x <= 1, `dialog not full width: ${JSON.stringify(box)}`);
    const overflow = () => page.evaluate(() => {
        const d = document.querySelector('#relayComposer');
        const bad = [...d.querySelectorAll('*')].filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && (r.right > window.innerWidth + 1 || r.left < -1) && !el.closest('.rl-chips');
        }).map((el) => el.className || el.tagName);
        return { bad, doc: document.documentElement.scrollWidth - window.innerWidth };
    });
    let o = await overflow();
    assert.deepEqual(o.bad, [], 'elements overflow the viewport');
    const row = await page.locator('[data-msg="m1"]').boundingBox();
    assert.ok(row.height >= 44, `row too short: ${row.height}`);
    const x = await page.locator('#relayComposer [data-act="close"]').first().boundingBox();
    assert.ok(x.width >= 44 && x.height >= 44, 'close button under 44px');
    await page.locator('[data-msg="m3"]').click();
    const chipX = await page.locator('[data-unpick="m3"]').boundingBox();
    assert.ok(chipX.width >= 44 && chipX.height >= 44, 'chip remove under 44px');
    await page.locator('#rlAttach').click();
    o = await overflow();
    assert.deepEqual(o.bad, []);
    const cols = await page.locator('.rl-types').evaluate((g) => getComputedStyle(g).gridTemplateColumns.split(' ').length);
    assert.equal(cols, 2);
    // RTL: أول نوع في اليمين
    const first = await page.locator('.rl-type').first().boundingBox();
    const second = await page.locator('.rl-type').nth(1).boundingBox();
    assert.ok(first.x > second.x, 'grid is not right-to-left');
    await page.locator('#rlConfirmType').click();
    o = await overflow();
    assert.deepEqual(o.bad, []);
    assert.deepEqual(errors, []);
    await context.close();
});

test('desktop RTL: dialog centered, checkbox at the inline end, attach button at the inline start', { skip: !chromiumPath }, async () => {
    const { page, context } = await openComposer(fixtures());
    const d = await page.locator('#relayComposer').boundingBox();
    assert.ok(Math.abs((d.x + d.width / 2) - 700) < 4, 'dialog not centered');
    const row = await page.locator('[data-msg="m1"]').boundingBox();
    const check = await rowCheck(page, 'm1').boundingBox();
    const text = await page.locator('[data-msg="m1"] .rl-msg-text').boundingBox();
    assert.ok(check.x < text.x, 'checkbox should sit on the left (inline end) in RTL');
    assert.ok(text.x + text.width > row.x + row.width / 2, 'text should start on the right');
    const primary = await page.locator('#rlAttach').boundingBox();
    const cancel = await page.locator('.rl-actions [data-act="close"]').boundingBox();
    assert.ok(primary.x > cancel.x, 'primary action should come first (right) in RTL');
    await context.close();
});

// ── صفحة Relay ──────────────────────────────────────────────────────────────
function pageFixtures({ access = { member: true, enabled: true, supervisor: false, can_assign: false }, owner = ME } = {}) {
    const fx = fixtures({ access });
    const record = {
        id: REC, kind: 'follow_up', title: 'متابعة الشحنة', summary: 'مستني رد شركة الشحن', next_action: 'اتصال',
        status: 'open', waiting_on: null, priority: 3, category: 'order_status', owner_id: owner, team_id: null,
        due_at: '2030-01-15T09:00:00Z', due_tz: 'Africa/Cairo', overdue: false, problem: null, closed_at: null,
        created_by: STAFF, created_at: at(9, 0), updated_at: at(9, 0), version: 3, created_via: 'native',
    };
    fx.rpc.relay_list = [{ ...record, source_count: 2 }];
    fx.rpc.relay_get = {
        record,
        sources: [
            { id: 's1', position: 1, source_type: 'mad3oom_message', provider: 'mad3oom', captured_at: at(9, 0),
              chat_session_id: S, chat_message_id: 'm3', excerpt: 'رقم الطلب هو 45879', sender_label: 'العميل',
              original_created_at: at(7, 27), truncated: false, source_deleted: false, edited_after_capture: false },
            { id: 's2', position: 2, source_type: 'mad3oom_message', provider: 'mad3oom', captured_at: at(9, 0),
              excerpt: null, excerpt_hidden: 'no_conversation_access' },
        ],
        replayed: false,
    };
    fx.rpc.relay_events_for = [{ id: 1, kind: 'created', actor_id: STAFF, client: 'native', payload: {}, created_at: at(9, 0) }];
    fx.rpc.relay_list_assigners = [{ user_id: STAFF, full_name: 'هبة سمير', email: 'heba@test.local', eligible: true, granted_at: at(9, 0) }];
    return fx;
}

test('record page: excerpt only where the server returned it; hidden sources say why and leak nothing', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openPage(pageFixtures(), { url: `/admin/relay.html?record=${REC}` });
    await page.waitForSelector('#rlRecordTitle');
    assert.equal(await page.locator('#rlRecordTitle').innerText(), 'متابعة الشحنة');
    assert.match(await page.locator('[data-source="s1"]').innerText(), /رقم الطلب هو 45879/);
    const hidden = page.locator('[data-source="s2"]');
    assert.equal(await hidden.getAttribute('data-state'), 'hidden');
    assert.match(await hidden.innerText(), /محتوى من محادثة لا تملك صلاحية الوصول إليها/);
    assert.equal(await hidden.locator('a, [data-redact]').count(), 0, 'no conversation link or action on a hidden source');
    // المالك بلا صلاحية إسناد: نفسه أو بلا مالك فقط
    assert.deepEqual(await page.locator('#rlAssignOwner option').evaluateAll((o) => o.map((x) => x.value)), ['', ME]);
    assert.equal(await page.locator('#rlAssignTeam').count(), 0);
    assert.equal(await page.locator('#rlAssigners').isHidden(), true, 'assigner admin shown to a non-supervisor');
    // القائمة: من relay_list بلا مقتطف
    assert.ok(!(await page.locator('#rlList').innerText()).includes('45879'));
    assert.match(await page.locator('#rlList').innerText(), /حالة طلب/);
    // تعديل: يرسل المتغير فقط، مع النسخة
    await page.locator('#rlEdit [name="category"]').selectOption('order_problem');
    await page.locator('#rlEdit [name="title"]').fill('متابعة الشحنة المتأخرة');
    await page.locator('#rlSave').click();
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'relay_update'));
    const [upd] = await rpcCalls(page, 'relay_update');
    assert.deepEqual(upd, { p_record: REC, p_patch: { title: 'متابعة الشحنة المتأخرة', category: 'order_problem' }, p_expected_version: 3 });
    assert.deepEqual(errors, []);
    await context.close();
});

test('record page: no assignment tools on someone else\'s record without the privilege; supervisor manages assigners', { skip: !chromiumPath }, async () => {
    let r = await openPage(pageFixtures({ owner: STAFF }), { url: `/admin/relay.html?record=${REC}` });
    await r.page.waitForSelector('#rlRecordTitle');
    assert.equal(await r.page.locator('#rlAssign').count(), 0);
    assert.equal(await r.page.locator('[data-to]').count(), 0, 'transitions are owner/supervisor only');
    await r.context.close();

    r = await openPage(pageFixtures({ owner: STAFF, access: { member: true, enabled: true, supervisor: true, can_assign: true } }),
        { url: `/admin/relay.html?record=${REC}` });
    await r.page.waitForSelector('#rlRecordTitle');
    assert.deepEqual(await r.page.locator('#rlAssignOwner option').evaluateAll((o) => o.map((x) => x.value)), ['', ME, STAFF]);
    assert.equal(await r.page.locator('#rlAssignTeam').count(), 1);
    await r.page.waitForSelector('#rlAssigners:not([hidden]) .rl-assigners li');
    assert.match(await r.page.locator('#rlAssigners').innerText(), /هبة سمير/);
    const native = [];
    r.page.on('dialog', (d) => { native.push(d.type()); d.dismiss(); });
    await r.page.locator(`[data-revoke="${STAFF}"]`).click();
    await r.page.waitForSelector('#rlConfirm[open]');
    assert.match(await r.page.locator('#rlConfirmTitle').innerText(), /سحب صلاحية الإسناد/);
    await r.page.locator('#rlConfirmOk').click();
    assert.deepEqual(native, [], 'native browser dialog used');
    await r.page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'relay_revoke_assigner'));
    assert.deepEqual(await rpcCalls(r.page, 'relay_revoke_assigner'), [{ p_user: STAFF }]);
    await r.context.close();
});

test('record page: Relay off or not a member shows a reason and calls nothing else', { skip: !chromiumPath }, async () => {
    const { page, context } = await openPage(pageFixtures({ access: { member: true, enabled: false, supervisor: false, can_assign: false } }),
        { url: '/admin/relay.html' });
    await page.waitForSelector('#rlBanner:not([hidden])');
    assert.match(await page.locator('#rlBanner').innerText(), /مش مفعّل/);
    assert.deepEqual(await rpcCalls(page, 'relay_list'), []);
    await context.close();
});

test('record page: granting to a staff member whose account is not active explains why (server refusal)', { skip: !chromiumPath }, async () => {
    const fx = pageFixtures({ access: { member: true, enabled: true, supervisor: true, can_assign: true } });
    fx.rpc.relay_list_assigners = [];
    fx.rpcErrors = { relay_grant_assigner: { code: '22023', message: 'بيانات غير صالحة: user_id',
        details: '{"code":"validation_failed","field":"user_id","reason":"not_eligible"}' } };
    const { page, context } = await openPage(fx, { url: '/admin/relay.html' });
    await page.waitForSelector('#rlGrantUser');
    await page.locator('#rlGrantUser').selectOption(STAFF);
    await page.locator('#rlGrantBtn').click();
    await page.locator('#rlConfirm[open] #rlConfirmOk').click();
    await page.waitForFunction(() => /حسابه مش نشط/.test(document.querySelector('#toast')?.innerText || ''));
    assert.match(await page.locator('#toast').innerText(), /مينفعش ياخد صلاحية الإسناد/);
    assert.deepEqual(await rpcCalls(page, 'relay_grant_assigner'), [{ p_user: STAFF }]);
    await context.close();
});

test('record page: confirmations use the in-page dialog (no browser confirm/prompt); cancel and Escape do nothing', { skip: !chromiumPath }, async () => {
    const native = [];
    const { page, context, errors } = await openPage(pageFixtures(), { url: `/admin/relay.html?record=${REC}` });
    page.on('dialog', (d) => { native.push(d.type()); d.dismiss(); });
    await page.waitForSelector('#rlRecordTitle');
    // إلغاء من الزر ثم Escape: لا نداء للخادم، والتركيز يرجع للزر
    await page.locator('[data-redact="s1"]').click();
    const dlg = page.locator('#rlConfirm');
    await page.waitForSelector('#rlConfirm[open]');
    assert.equal(await dlg.getAttribute('dir'), 'rtl');
    assert.match(await page.locator('#rlConfirmTitle').innerText(), /حذف محتوى المصدر نهائيًا/);
    assert.match(await page.locator('#rlConfirmOk').getAttribute('class'), /btn-danger/);
    await page.locator('#rlConfirm .rl-actions [data-dlg="cancel"]').click();
    assert.equal(await dlg.count(), 0);
    assert.equal(await page.evaluate(() => document.activeElement?.dataset?.redact), 's1', 'focus not returned');
    await page.locator('[data-redact="s1"]').click();
    await page.waitForSelector('#rlConfirm[open]');
    await page.keyboard.press('Escape');
    assert.equal(await dlg.count(), 0);
    assert.deepEqual(await rpcCalls(page, 'relay_redact_source'), []);
    // تأكيد ⇒ النداء مرة واحدة
    await page.locator('[data-redact="s1"]').click();
    await page.locator('#rlConfirm[open] #rlConfirmOk').click();
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'relay_redact_source'));
    assert.equal((await rpcCalls(page, 'relay_redact_source')).length, 1);
    // انتقال يحتاج نص: الزر مقفول لحد ما يتكتب، والنص المتقصوص هو اللي يتبعت
    await page.waitForSelector('[data-to="waiting"]');
    await page.locator('[data-to="waiting"]').click();
    await page.waitForSelector('#rlConfirm[open] #rlConfirmInput');
    assert.equal(await page.locator('#rlConfirmOk').isDisabled(), true);
    await page.locator('#rlConfirmInput').fill('   ');
    assert.equal(await page.locator('#rlConfirmOk').isDisabled(), true);
    await page.locator('#rlConfirmInput').fill('  رد شركة الشحن ');
    await page.locator('#rlConfirmOk').click();
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'relay_transition'));
    const [tr] = await rpcCalls(page, 'relay_transition');
    assert.equal(tr.p_to, 'waiting');
    assert.deepEqual(tr.p_details, { waiting_on: 'رد شركة الشحن' });
    assert.deepEqual(native, [], 'native browser dialog used');
    assert.deepEqual(errors, []);
    await context.close();
});

test('record page at 390px: the confirmation is a bottom sheet inside the viewport', { skip: !chromiumPath }, async () => {
    const { page, context } = await openPage(pageFixtures(), { url: `/admin/relay.html?record=${REC}`, viewport: { width: 390, height: 844 } });
    await page.waitForSelector('#rlRecordTitle');
    await page.locator('[data-redact="s1"]').click();
    await page.waitForSelector('#rlConfirm[open]');
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState === 'finished')); // حركة الظهور
    const box = await page.locator('#rlConfirm').boundingBox();
    assert.ok(box.x >= -1 && box.x + box.width <= 391, `dialog overflows horizontally: ${JSON.stringify(box)}`);
    assert.ok(Math.abs(box.y + box.height - 844) <= 2, `not anchored to the bottom: ${JSON.stringify(box)}`);
    assert.ok(box.height < 844 * 0.5, `should be a compact sheet, not full screen: ${box.height}`);
    for (const sel of ['#rlConfirmOk', '#rlConfirm .rl-actions [data-dlg="cancel"]']) {
        const b = await page.locator(sel).boundingBox();
        assert.ok(b.height >= 44, `${sel} touch target ${b.height}`);
    }
    await context.close();
});

test('sidebar: the Relay link appears only when Relay is on and the caller is a member (hidden before 074)', { skip: !chromiumPath }, async () => {
    const cases = [
        [{ member: true, enabled: true, supervisor: false, can_assign: false }, true],
        [{ member: true, enabled: false, supervisor: false, can_assign: false }, false],
        [{ member: false, enabled: true, supervisor: false, can_assign: false }, false],
        [null, false], // 074 غير مطبّق: الدالة غير موجودة
    ];
    for (const [access, shown] of cases) {
        const fx = pageFixtures({ access: access || {} });
        fx.tables.profiles = [{ id: ME, email: 'admin@test.local', role: 'admin', whatsapp_enabled: false }];
        if (access === null) {
            delete fx.rpc.relay_my_access;
            fx.rpcErrors = { relay_my_access: { code: 'PGRST202', message: 'Could not find the function public.relay_my_access' } };
        }
        const { page, context } = await openPage(fx, { url: '/admin/relay.html' });
        await page.waitForSelector('#inboxLink', { state: 'visible' }); // صلاحيات الشريط اتطبقت
        await page.waitForTimeout(150);
        assert.equal(await page.locator('#relayLink').isVisible(), shown, `access=${JSON.stringify(access)}`);
        await context.close();
    }
});

test('record page at 390px: list first, record replaces it, no horizontal overflow', { skip: !chromiumPath }, async () => {
    const { page, context } = await openPage(pageFixtures(), { url: '/admin/relay.html', viewport: { width: 390, height: 844 } });
    await page.waitForSelector('[data-open]');
    assert.ok(await page.locator('.rl-panel--detail').isHidden());
    await page.locator(`[data-open="${REC}"]`).click();
    await page.waitForSelector('#rlRecordTitle');
    assert.ok(await page.locator('.rl-panel--list').isHidden());
    const wide = await page.evaluate(() => [...document.querySelectorAll('.rl-page *')]
        .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.right > window.innerWidth + 1; })
        .map((el) => el.className || el.tagName));
    assert.deepEqual(wide, []);
    await page.locator('#rlBackToList').click();
    assert.ok(await page.locator('.rl-panel--list').isVisible());
    await context.close();
});
