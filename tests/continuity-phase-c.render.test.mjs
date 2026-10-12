/**
 * Continuity المرحلة C في متصفح حقيقي: نافذة «اختيار الرسائل» ← «معاينة النوع» ←
 * التفاصيل من صندوق الرسائل (admin/inbox.html)، وصفحة Continuity (admin/continuity.html).
 *
 * الكود الحقيقي (inbox.js + continuity-composer.js + continuity-page.js) على بديل Supabase.
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
            continuity_my_access: access,
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
if (!chromiumPath) console.error('SKIP: لا يوجد متصفح Chromium متاح؛ اختبارات Continuity المرحلة C لم تُنفَّذ');

test.before(async () => {
    if (!chromiumPath) return;
    server = await startServer();
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: chromiumPath });
});
test.after(async () => { await browser?.close(); server?.close(); });

const rpcCalls = (page, name) => page.evaluate((n) => (window.__RPC_ARGS__ || []).filter(([k]) => k === n).map(([, a]) => a), name);

async function openPage(fx, { url, viewport, init = null, patchDouble = (d) => d, on = null } = {}) {
    const context = await (on || browser).newContext({ viewport: viewport || { width: 1400, height: 900 }, locale: 'ar-EG', timezoneId: 'Africa/Cairo' });
    // error-tracker.js يرسل كل خطأ مورد إلى site_errors في الإنتاج: لا اختبار يكتب هناك.
    await context.route('**/error-tracker.js', (r) => r.fulfill({ contentType: 'text/javascript', body: '' }));
    const page = await context.newPage();
    // أخطاء الخادم بشكل PostgREST الكامل (code + details) — البديل المشترك يرجّع رسالة فقط.
    const double = fs.readFileSync(path.join(ROOT, 'tests/fixtures/supabase-double.js'), 'utf8')
        .replace("if (failure) return { data: null, error: { message: failure, code: 'P0001' } };",
            "if (failure) return { data: null, error: typeof failure === 'object' ? failure : { message: failure, code: 'P0001' } };");
    assert.ok(double.includes("typeof failure === 'object'"), 'مقدرتش أعدّل البديل');
    const patched = patchDouble(double);
    const auth = fs.readFileSync(path.join(ROOT, 'tests/fixtures/auth-client-double.js'), 'utf8');
    await context.route('**/api-config.js', (r) => r.fulfill({ contentType: 'text/javascript; charset=utf-8', body: patched }));
    await context.route('**/auth-client.js', (r) => r.fulfill({ contentType: 'text/javascript; charset=utf-8', body: auth }));
    await context.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: '' }));
    await context.addInitScript((data) => { window.__FIXTURES__ = data; }, fx);
    if (init) await context.addInitScript(init);
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
    await r.page.locator('#continuityBtn').click();
    await r.page.waitForSelector('#continuityComposer[open] .ct-msg');
    return r;
}

const rowCheck = (page, id) => page.locator(`[data-pick="${id}"]`);

test('select → deselect → type preview → details → create: what is sent is exactly what the user confirmed', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openComposer(fixtures());
    const dlg = page.locator('#continuityComposer');
    assert.equal(await dlg.getAttribute('dir'), 'rtl');
    assert.equal(await page.locator('#ctTitle').innerText(), 'اختيار الرسائل');
    assert.equal(await page.locator('.ct-msg').count(), 7);
    assert.match(await page.locator('.ct-conv-head').innerText(), /أحمد محمد[\s\S]*\+20 100 123 4567[\s\S]*7 رسائل/);
    assert.equal(await page.locator('#ctAttach').isDisabled(), true, 'attach enabled with nothing selected');

    // اختيار بالضغط على الصف، وبالكيبورد (Space على مربع الاختيار)
    await page.locator('[data-msg="m6"]').click();
    await page.locator('[data-msg="m2"]').click();
    await rowCheck(page, 'm3').focus();
    await page.keyboard.press('Space');
    assert.match(await page.locator('#ctCount').innerText(), /تم اختيار 3 رسائل/);
    assert.equal(await page.locator('.ct-chip').count(), 3);
    assert.equal(await page.locator('.ct-msg.is-on').count(), 3);
    // إلغاء من الشريط ثم من الصف
    await page.locator('[data-unpick="m6"]').click();
    assert.match(await page.locator('#ctCount').innerText(), /تم اختيار 2 رسائل/);
    assert.equal(await rowCheck(page, 'm6').isChecked(), false);
    await rowCheck(page, 'm2').focus();
    await page.keyboard.press('Space');
    assert.equal(await page.locator('.ct-chip').count(), 1);
    await page.locator('[data-msg="m2"]').click();
    await page.locator('[data-msg="m6"]').click();
    assert.equal(await page.locator('.ct-chip').count(), 3);

    // البحث والفلاتر لا تمسح الاختيار
    await page.locator('#ctSearch').fill('تسليم');
    assert.equal(await page.locator('.ct-msg').count(), 2);
    assert.equal(await page.locator('#ctSearch').inputValue(), 'تسليم', 'focus/value lost while typing');
    await page.locator('#ctSearch').fill('');
    await page.locator('#ctParticipant').selectOption('agent');
    assert.equal(await page.locator('.ct-msg').count(), 3);
    await page.locator('#ctParticipant').selectOption('all');
    assert.equal(await page.locator('.ct-chip').count(), 3);

    // معاينة النوع
    await page.locator('#ctAttach').click();
    assert.equal(await page.locator('#ctTitle').innerText(), 'معاينة النوع');
    assert.match(await page.locator('.ct-card h3').innerText(), /الرسائل المختارة \(3\)/);
    assert.equal(await page.locator('.ct-bubble-row').count(), 3);
    assert.equal(await page.locator('#ctSuggested').innerText(), 'حالة طلب');
    assert.match(await page.locator('#ctSuggest').innerText(), /موصى به/);
    assert.equal(await page.locator('.ct-type').count(), 9);
    assert.equal(await page.locator('[data-category="order_status"]').getAttribute('aria-checked'), 'true');
    assert.equal(await page.locator('#ctWhy').isHidden(), true);
    await page.locator('[data-act="why"]').click();
    assert.match(await page.locator('#ctWhy').innerText(), /رقم الطلب/);
    // تغيير النوع والملاحظات
    await page.locator('[data-category="complaint"]').click();
    assert.equal(await page.locator('[data-category="complaint"]').getAttribute('aria-checked'), 'true');
    assert.equal(await page.locator('[data-category="order_status"]').getAttribute('aria-checked'), 'false');
    await page.locator('#ctNote').fill('العميل متضايق من التأخير');
    // رجوع يحفظ الاختيار، والرجوع للأمام يحفظ النوع المختار
    await page.locator('[data-act="back"]').click();
    assert.equal(await page.locator('.ct-chip').count(), 3);
    await page.locator('#ctAttach').click();
    assert.equal(await page.locator('[data-category="complaint"]').getAttribute('aria-checked'), 'true');
    assert.equal(await page.locator('#ctNote').inputValue(), 'العميل متضايق من التأخير');
    await page.locator('#ctConfirmType').click();

    // التفاصيل: شكوى ⇒ «مشكلة تحتاج حلًا» مقترحة، والوصف = الملاحظة (كلام المستخدم)
    assert.equal(await page.locator('#ctTitle').innerText(), 'تفاصيل السجل');
    assert.equal(await page.locator('[data-kind="issue"]').getAttribute('aria-checked'), 'true');
    assert.equal(await page.locator('#ctSummary').inputValue(), 'العميل متضايق من التأخير');
    assert.equal(await page.locator('#ctTitleInput').inputValue(), '', 'title must never be pre-filled (M5)');
    assert.match(await page.locator('#ctTitleInput').getAttribute('placeholder'), /^مثال:/);
    // بلا صلاحية إسناد: أنا أو بلا مالك، ولا فريق
    assert.deepEqual(await page.locator('#ctOwner option').evaluateAll((o) => o.map((x) => x.value)), ['', ME]);
    assert.equal(await page.locator('#ctTeam').count(), 0);
    assert.ok(await page.locator('#ctOwnerHint').isVisible());
    assert.match(await page.locator('#ctMissing').innerText(), /العنوان/);
    assert.equal(await page.locator('#ctSubmit').isDisabled(), true);

    await page.locator('[data-kind="follow_up"]').click();
    assert.match(await page.locator('#ctMissing').innerText(), /الخطوة التالية[\s\S]*الموعد/);
    await page.locator('#ctTitleInput').fill('متابعة تأخير الطلب');
    await page.locator('#ctNext').fill('أكلم شركة الشحن');
    await page.locator('#ctDue').fill('2030-01-15T11:00');
    await page.locator('#ctTz').selectOption('Africa/Cairo');
    assert.equal(await page.locator('#ctMissing').count(), 0, await page.locator('#ctMissing').allInnerTexts().then((x) => x.join()));
    assert.equal(await page.locator('#ctSubmit').isDisabled(), false);

    await page.locator('#ctSubmit').click();
    await page.waitForFunction(() => !document.querySelector('#continuityComposer')?.open);
    const [args] = await rpcCalls(page, 'continuity_create');
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
    assert.equal((await rpcCalls(page, 'continuity_create')).length, 1, 'created more than once');
    assert.match(await page.locator('#toast').innerText(), /سجل الاستمرارية/);
    assert.deepEqual(errors, []);
    await context.close();
});

test('Escape or Cancel closes without creating anything', { skip: !chromiumPath }, async () => {
    const { page, context } = await openComposer(fixtures());
    await page.locator('[data-msg="m3"]').click();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#continuityComposer')?.open);
    await page.locator('#continuityBtn').click();
    await page.waitForSelector('#continuityComposer[open] .ct-msg');
    assert.equal(await page.locator('.ct-chip').count(), 0, 'a reopened composer starts clean');
    await page.locator('.ct-actions [data-act="close"]').click();
    assert.deepEqual(await rpcCalls(page, 'continuity_create'), []);
    await context.close();
});

test('an assigner sees every eligible owner and teams; the choice is sent as is', { skip: !chromiumPath }, async () => {
    const { page, context } = await openComposer(fixtures({ access: { member: true, enabled: true, supervisor: false, can_assign: true } }));
    await page.locator('[data-msg="m3"]').click();
    await page.locator('#ctAttach').click();
    await page.locator('#ctConfirmType').click();
    assert.deepEqual(await page.locator('#ctOwner option').evaluateAll((o) => o.map((x) => x.value)), ['', ME, STAFF]);
    assert.equal(await page.locator('#ctOwnerHint').count(), 0);
    await page.locator('#ctOwner').selectOption(STAFF);
    await page.locator('#ctTeam').selectOption(TEAM);
    await page.locator('#ctTitleInput').fill('متابعة');
    await page.locator('#ctNext').fill('اتصال');
    await page.locator('#ctDue').fill('2030-01-15T11:00');
    await page.locator('#ctSubmit').click();
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'continuity_create'));
    const [{ p_request: req }] = await rpcCalls(page, 'continuity_create');
    assert.equal(req.owner_id, STAFF);
    assert.equal(req.team_id, TEAM);
    await context.close();
});

test('a server refusal (forbidden owner) is explained and nothing is lost', { skip: !chromiumPath }, async () => {
    const fx = fixtures({ access: { member: true, enabled: true, supervisor: false, can_assign: true } });
    fx.rpcErrors = { continuity_create: { code: '42501', message: 'غير مسموح', details: '{"code":"forbidden","field":"owner_id"}' } };
    const { page, context } = await openComposer(fx);
    await page.locator('[data-msg="m3"]').click();
    await page.locator('#ctAttach').click();
    await page.locator('#ctConfirmType').click();
    await page.locator('#ctOwner').selectOption(STAFF);
    await page.locator('#ctTitleInput').fill('متابعة');
    await page.locator('#ctNext').fill('اتصال');
    await page.locator('#ctDue').fill('2030-01-15T11:00');
    await page.locator('#ctSubmit').click();
    await page.waitForSelector('#ctError:not(:empty)');
    assert.match(await page.locator('#ctError').innerText(), /مش مسموح لك تسند السجل لموظف تاني/);
    assert.ok(await page.locator('#continuityComposer').evaluate((d) => d.open), 'dialog closed on error');
    assert.equal(await page.locator('#ctTitleInput').inputValue(), 'متابعة');
    assert.equal(await page.locator('#ctSubmit').isDisabled(), false);
    // نفس الطلب ⇒ نفس مفتاح التكرار (الخادم يرجع replayed لو الأول وصل)
    await page.locator('#ctSubmit').click();
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).filter(([n]) => n === 'continuity_create').length === 2);
    const calls = await rpcCalls(page, 'continuity_create');
    assert.equal(calls[0].p_request.idempotency_key, calls[1].p_request.idempotency_key);
    // تعديل الطلب ⇒ مفتاح جديد
    await page.locator('#ctOwner').selectOption(ME);
    await page.locator('#ctSubmit').click();
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).filter(([n]) => n === 'continuity_create').length === 3);
    const third = (await rpcCalls(page, 'continuity_create'))[2];
    assert.notEqual(third.p_request.idempotency_key, calls[0].p_request.idempotency_key);
    await context.close();
});

test('sensitive content needs an explicit acknowledgement before sending', { skip: !chromiumPath }, async () => {
    const fx = fixtures({ extraMessages: [msg('m8', 8, 5, 'رقم الكارت 4111 1111 1111 1111', 'customer')] });
    const { page, context } = await openComposer(fx);
    await page.locator('[data-msg="m8"]').click();
    await page.locator('#ctAttach').click();
    // لا كلمات تدل على نوع ⇒ لا اقتراح، والمتابعة مقفولة لحد ما المستخدم يختار بنفسه
    assert.equal(await page.locator('#ctSuggested').count(), 0);
    assert.match(await page.locator('#ctSuggest').innerText(), /مفيش نوع واضح/);
    assert.equal(await page.locator('.ct-type[aria-checked="true"]').count(), 0);
    assert.equal(await page.locator('#ctConfirmType').isDisabled(), true);
    await page.locator('[data-category="payment_billing"]').click();
    await page.locator('#ctConfirmType').click();
    await page.locator('#ctTitleInput').fill('متابعة الدفع');
    await page.locator('#ctNext').fill('مراجعة');
    await page.locator('#ctDue').fill('2030-01-15T11:00');
    assert.match(await page.locator('#ctSensitive').innerText(), /رقم كارت/);
    assert.equal(await page.locator('#ctSubmit').isDisabled(), true);
    await page.locator('#ctAck').check();
    assert.equal(await page.locator('#ctSubmit').isDisabled(), false);
    await page.locator('#ctSubmit').click();
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'continuity_create'));
    const [{ p_request: req }] = await rpcCalls(page, 'continuity_create');
    assert.equal(req.sensitive_ack, true);
    await context.close();
});

test('attach to an existing record calls continuity_attach_sources with its version', { skip: !chromiumPath }, async () => {
    const fx = fixtures();
    fx.rpc.continuity_list = [{ id: REC, kind: 'follow_up', title: 'متابعة الشحنة', status: 'open', category: 'order_status', version: 4, source_count: 1 }];
    fx.rpc.continuity_attach_sources = { record: { id: REC, version: 5 }, sources: [], added: 2 };
    const { page, context } = await openComposer(fx);
    await page.locator('[data-msg="m5"]').click();
    await page.locator('[data-msg="m6"]').click();
    await page.locator('#ctAttach').click();
    await page.locator('#ctConfirmType').click();
    await page.locator('[data-mode="existing"]').click();
    await page.waitForSelector(`[data-record="${REC}"]`);
    assert.equal(await page.locator('#ctSubmit').isDisabled(), true);
    await page.locator(`[data-record="${REC}"]`).click();
    await page.locator('#ctSubmit').click();
    await page.waitForFunction(() => !document.querySelector('#continuityComposer')?.open);
    const [args] = await rpcCalls(page, 'continuity_attach_sources');
    assert.equal(args.p_record, REC);
    assert.equal(args.p_expected_version, 4);
    assert.deepEqual(args.p_sources.map((s) => s.internal.chat_message_id), ['m5', 'm6']);
    const [listArgs] = await rpcCalls(page, 'continuity_list');
    assert.deepEqual(listArgs.p_filters.status, ['open', 'scheduled', 'in_progress', 'waiting']);
    assert.deepEqual(await rpcCalls(page, 'continuity_create'), []);
    await context.close();
});

test('no Continuity button when Continuity is off, the caller is not a member, or 074 is not deployed', { skip: !chromiumPath }, async () => {
    for (const access of [{ member: true, enabled: false, supervisor: false, can_assign: false },
        { member: false, enabled: false, supervisor: false, can_assign: false }, null]) {
        const fx = fixtures();
        fx.rpc.continuity_my_access = access;
        const { page, context } = await openPage(fx, { url: `/admin/inbox.html?session=${S}` });
        await page.waitForSelector('.ib-msg');
        assert.equal(await page.locator('#continuityBtn').isHidden(), true, JSON.stringify(access));
        await context.close();
    }
});

test('mobile 390px RTL: full-screen dialog, no horizontal overflow, 44px targets, two-column types', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openComposer(fixtures(), { viewport: { width: 390, height: 844 } });
    const box = await page.locator('#continuityComposer').boundingBox();
    assert.ok(box.width >= 389 && box.x <= 1, `dialog not full width: ${JSON.stringify(box)}`);
    const overflow = () => page.evaluate(() => {
        const d = document.querySelector('#continuityComposer');
        const bad = [...d.querySelectorAll('*')].filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && (r.right > window.innerWidth + 1 || r.left < -1) && !el.closest('.ct-chips');
        }).map((el) => el.className || el.tagName);
        return { bad, doc: document.documentElement.scrollWidth - window.innerWidth };
    });
    let o = await overflow();
    assert.deepEqual(o.bad, [], 'elements overflow the viewport');
    const row = await page.locator('[data-msg="m1"]').boundingBox();
    assert.ok(row.height >= 44, `row too short: ${row.height}`);
    const x = await page.locator('#continuityComposer [data-act="close"]').first().boundingBox();
    assert.ok(x.width >= 44 && x.height >= 44, 'close button under 44px');
    await page.locator('[data-msg="m3"]').click();
    const chipX = await page.locator('[data-unpick="m3"]').boundingBox();
    assert.ok(chipX.width >= 44 && chipX.height >= 44, 'chip remove under 44px');
    await page.locator('#ctAttach').click();
    o = await overflow();
    assert.deepEqual(o.bad, []);
    const cols = await page.locator('.ct-types').evaluate((g) => getComputedStyle(g).gridTemplateColumns.split(' ').length);
    assert.equal(cols, 2);
    // RTL: أول نوع في اليمين
    const first = await page.locator('.ct-type').first().boundingBox();
    const second = await page.locator('.ct-type').nth(1).boundingBox();
    assert.ok(first.x > second.x, 'grid is not right-to-left');
    await page.locator('#ctConfirmType').click();
    o = await overflow();
    assert.deepEqual(o.bad, []);
    assert.deepEqual(errors, []);
    await context.close();
});

test('desktop RTL: dialog centered, checkbox at the inline end, attach button at the inline start', { skip: !chromiumPath }, async () => {
    const { page, context } = await openComposer(fixtures());
    const d = await page.locator('#continuityComposer').boundingBox();
    assert.ok(Math.abs((d.x + d.width / 2) - 700) < 4, 'dialog not centered');
    const row = await page.locator('[data-msg="m1"]').boundingBox();
    const check = await rowCheck(page, 'm1').boundingBox();
    const text = await page.locator('[data-msg="m1"] .ct-msg-text').boundingBox();
    assert.ok(check.x < text.x, 'checkbox should sit on the left (inline end) in RTL');
    assert.ok(text.x + text.width > row.x + row.width / 2, 'text should start on the right');
    const primary = await page.locator('#ctAttach').boundingBox();
    const cancel = await page.locator('.ct-actions [data-act="close"]').boundingBox();
    assert.ok(primary.x > cancel.x, 'primary action should come first (right) in RTL');
    await context.close();
});

// ── صفحة Continuity ──────────────────────────────────────────────────────────────
function pageFixtures({ access = { member: true, enabled: true, supervisor: false, can_assign: false }, owner = ME } = {}) {
    const fx = fixtures({ access });
    const record = {
        id: REC, kind: 'follow_up', title: 'متابعة الشحنة', summary: 'مستني رد شركة الشحن', next_action: 'اتصال',
        status: 'open', waiting_on: null, priority: 3, category: 'order_status', owner_id: owner, team_id: null,
        due_at: '2030-01-15T09:00:00Z', due_tz: 'Africa/Cairo', overdue: false, problem: null, closed_at: null,
        created_by: STAFF, created_at: at(9, 0), updated_at: at(9, 0), version: 3, created_via: 'native',
    };
    fx.rpc.continuity_list = [{ ...record, source_count: 2 }];
    fx.rpc.continuity_get = {
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
    fx.rpc.continuity_events_for = [{ id: 1, kind: 'created', actor_id: STAFF, client: 'native', payload: {}, created_at: at(9, 0) }];
    fx.rpc.continuity_list_assigners = [{ user_id: STAFF, full_name: 'هبة سمير', email: 'heba@test.local', eligible: true, granted_at: at(9, 0) }];
    return fx;
}

test('record page: excerpt only where the server returned it; hidden sources say why and leak nothing', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openPage(pageFixtures(), { url: `/admin/continuity.html?record=${REC}` });
    await page.waitForSelector('#ctRecordTitle');
    assert.equal(await page.locator('#ctRecordTitle').innerText(), 'متابعة الشحنة');
    assert.match(await page.locator('[data-source="s1"]').innerText(), /رقم الطلب هو 45879/);
    const hidden = page.locator('[data-source="s2"]');
    assert.equal(await hidden.getAttribute('data-state'), 'hidden');
    assert.match(await hidden.innerText(), /محتوى من محادثة لا تملك صلاحية الوصول إليها/);
    assert.equal(await hidden.locator('a, [data-redact]').count(), 0, 'no conversation link or action on a hidden source');
    // المالك بلا صلاحية إسناد: نفسه أو بلا مالك فقط
    assert.deepEqual(await page.locator('#ctAssignOwner option').evaluateAll((o) => o.map((x) => x.value)), ['', ME]);
    assert.equal(await page.locator('#ctAssignTeam').count(), 0);
    assert.equal(await page.locator('#ctAssigners').isHidden(), true, 'assigner admin shown to a non-supervisor');
    // القائمة: من continuity_list بلا مقتطف
    assert.ok(!(await page.locator('#ctList').innerText()).includes('45879'));
    assert.match(await page.locator('#ctList').innerText(), /حالة طلب/);
    // تعديل: يرسل المتغير فقط، مع النسخة
    await page.locator('#ctEdit [name="category"]').selectOption('order_problem');
    await page.locator('#ctEdit [name="title"]').fill('متابعة الشحنة المتأخرة');
    await page.locator('#ctSave').click();
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'continuity_update'));
    const [upd] = await rpcCalls(page, 'continuity_update');
    assert.deepEqual(upd, { p_record: REC, p_patch: { title: 'متابعة الشحنة المتأخرة', category: 'order_problem' }, p_expected_version: 3 });
    assert.deepEqual(errors, []);
    await context.close();
});

test('record page: no assignment tools on someone else\'s record without the privilege; supervisor manages assigners', { skip: !chromiumPath }, async () => {
    let r = await openPage(pageFixtures({ owner: STAFF }), { url: `/admin/continuity.html?record=${REC}` });
    await r.page.waitForSelector('#ctRecordTitle');
    assert.equal(await r.page.locator('#ctAssign').count(), 0);
    assert.equal(await r.page.locator('[data-to]').count(), 0, 'transitions are owner/supervisor only');
    await r.context.close();

    r = await openPage(pageFixtures({ owner: STAFF, access: { member: true, enabled: true, supervisor: true, can_assign: true } }),
        { url: `/admin/continuity.html?record=${REC}` });
    await r.page.waitForSelector('#ctRecordTitle');
    assert.deepEqual(await r.page.locator('#ctAssignOwner option').evaluateAll((o) => o.map((x) => x.value)), ['', ME, STAFF]);
    assert.equal(await r.page.locator('#ctAssignTeam').count(), 1);
    await r.page.waitForSelector('#ctAssigners:not([hidden]) .ct-assigners li');
    assert.match(await r.page.locator('#ctAssigners').innerText(), /هبة سمير/);
    const native = [];
    r.page.on('dialog', (d) => { native.push(d.type()); d.dismiss(); });
    await r.page.locator(`[data-revoke="${STAFF}"]`).click();
    await r.page.waitForSelector('#ctConfirm[open]');
    assert.match(await r.page.locator('#ctConfirmTitle').innerText(), /سحب صلاحية الإسناد/);
    await r.page.locator('#ctConfirmOk').click();
    assert.deepEqual(native, [], 'native browser dialog used');
    await r.page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'continuity_revoke_assigner'));
    assert.deepEqual(await rpcCalls(r.page, 'continuity_revoke_assigner'), [{ p_user: STAFF }]);
    await r.context.close();
});

test('record page: Continuity off or not a member shows a reason and calls nothing else', { skip: !chromiumPath }, async () => {
    const { page, context } = await openPage(pageFixtures({ access: { member: true, enabled: false, supervisor: false, can_assign: false } }),
        { url: '/admin/continuity.html' });
    await page.waitForSelector('#ctBanner:not([hidden])');
    assert.match(await page.locator('#ctBanner').innerText(), /مش مفعّل/);
    assert.deepEqual(await rpcCalls(page, 'continuity_list'), []);
    await context.close();
});

test('record page: granting to a staff member whose account is not active explains why (server refusal)', { skip: !chromiumPath }, async () => {
    const fx = pageFixtures({ access: { member: true, enabled: true, supervisor: true, can_assign: true } });
    fx.rpc.continuity_list_assigners = [];
    fx.rpcErrors = { continuity_grant_assigner: { code: '22023', message: 'بيانات غير صالحة: user_id',
        details: '{"code":"validation_failed","field":"user_id","reason":"not_eligible"}' } };
    const { page, context } = await openPage(fx, { url: '/admin/continuity.html' });
    await page.waitForSelector('#ctGrantUser');
    await page.locator('#ctGrantUser').selectOption(STAFF);
    await page.locator('#ctGrantBtn').click();
    await page.locator('#ctConfirm[open] #ctConfirmOk').click();
    await page.waitForFunction(() => /حسابه مش نشط/.test(document.querySelector('#toast')?.innerText || ''));
    assert.match(await page.locator('#toast').innerText(), /مينفعش ياخد صلاحية الإسناد/);
    assert.deepEqual(await rpcCalls(page, 'continuity_grant_assigner'), [{ p_user: STAFF }]);
    await context.close();
});

test('record page: confirmations use the in-page dialog (no browser confirm/prompt); cancel and Escape do nothing', { skip: !chromiumPath }, async () => {
    const native = [];
    const { page, context, errors } = await openPage(pageFixtures(), { url: `/admin/continuity.html?record=${REC}` });
    page.on('dialog', (d) => { native.push(d.type()); d.dismiss(); });
    await page.waitForSelector('#ctRecordTitle');
    // إلغاء من الزر ثم Escape: لا نداء للخادم، والتركيز يرجع للزر
    await page.locator('[data-redact="s1"]').click();
    const dlg = page.locator('#ctConfirm');
    await page.waitForSelector('#ctConfirm[open]');
    assert.equal(await dlg.getAttribute('dir'), 'rtl');
    assert.match(await page.locator('#ctConfirmTitle').innerText(), /حذف محتوى المصدر نهائيًا/);
    assert.match(await page.locator('#ctConfirmOk').getAttribute('class'), /btn-danger/);
    await page.locator('#ctConfirm .ct-actions [data-dlg="cancel"]').click();
    assert.equal(await dlg.count(), 0);
    assert.equal(await page.evaluate(() => document.activeElement?.dataset?.redact), 's1', 'focus not returned');
    await page.locator('[data-redact="s1"]').click();
    await page.waitForSelector('#ctConfirm[open]');
    await page.keyboard.press('Escape');
    assert.equal(await dlg.count(), 0);
    assert.deepEqual(await rpcCalls(page, 'continuity_redact_source'), []);
    // تأكيد ⇒ النداء مرة واحدة
    await page.locator('[data-redact="s1"]').click();
    await page.locator('#ctConfirm[open] #ctConfirmOk').click();
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'continuity_redact_source'));
    assert.equal((await rpcCalls(page, 'continuity_redact_source')).length, 1);
    // انتقال يحتاج نص: الزر مقفول لحد ما يتكتب، والنص المتقصوص هو اللي يتبعت
    await page.waitForSelector('[data-to="waiting"]');
    await page.locator('[data-to="waiting"]').click();
    await page.waitForSelector('#ctConfirm[open] #ctConfirmInput');
    assert.equal(await page.locator('#ctConfirmOk').isDisabled(), true);
    await page.locator('#ctConfirmInput').fill('   ');
    assert.equal(await page.locator('#ctConfirmOk').isDisabled(), true);
    await page.locator('#ctConfirmInput').fill('  رد شركة الشحن ');
    await page.locator('#ctConfirmOk').click();
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'continuity_transition'));
    const [tr] = await rpcCalls(page, 'continuity_transition');
    assert.equal(tr.p_to, 'waiting');
    assert.deepEqual(tr.p_details, { waiting_on: 'رد شركة الشحن' });
    assert.deepEqual(native, [], 'native browser dialog used');
    assert.deepEqual(errors, []);
    await context.close();
});

test('record page at 390px: the confirmation is a bottom sheet inside the viewport', { skip: !chromiumPath }, async () => {
    const { page, context } = await openPage(pageFixtures(), { url: `/admin/continuity.html?record=${REC}`, viewport: { width: 390, height: 844 } });
    await page.waitForSelector('#ctRecordTitle');
    await page.locator('[data-redact="s1"]').click();
    await page.waitForSelector('#ctConfirm[open]');
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState === 'finished')); // حركة الظهور
    const box = await page.locator('#ctConfirm').boundingBox();
    assert.ok(box.x >= -1 && box.x + box.width <= 391, `dialog overflows horizontally: ${JSON.stringify(box)}`);
    assert.ok(Math.abs(box.y + box.height - 844) <= 2, `not anchored to the bottom: ${JSON.stringify(box)}`);
    assert.ok(box.height < 844 * 0.5, `should be a compact sheet, not full screen: ${box.height}`);
    for (const sel of ['#ctConfirmOk', '#ctConfirm .ct-actions [data-dlg="cancel"]']) {
        const b = await page.locator(sel).boundingBox();
        assert.ok(b.height >= 44, `${sel} touch target ${b.height}`);
    }
    await context.close();
});

test('sidebar: the Continuity link appears only when Continuity is on and the caller is a member (hidden before 074)', { skip: !chromiumPath }, async () => {
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
            delete fx.rpc.continuity_my_access;
            fx.rpcErrors = { continuity_my_access: { code: 'PGRST202', message: 'Could not find the function public.continuity_my_access' } };
        }
        const { page, context } = await openPage(fx, { url: '/admin/continuity.html' });
        await page.waitForSelector('#inboxLink', { state: 'visible' }); // صلاحيات الشريط اتطبقت
        await page.waitForTimeout(150);
        assert.equal(await page.locator('#continuityLink').isVisible(), shown, `access=${JSON.stringify(access)}`);
        await context.close();
    }
});

test('database before 077 (production on 076): the same page works through the old relay_* names; after 077 they are never called', { skip: !chromiumPath }, async () => {
    // قاعدة 076: الدوال نفسها باسمها القديم فقط
    const fx = pageFixtures();
    fx.tables.profiles = [{ id: ME, email: 'admin@test.local', role: 'admin', whatsapp_enabled: false }];
    for (const name of Object.keys(fx.rpc).filter((n) => n.startsWith('continuity_'))) {
        fx.rpc[name.replace(/^continuity_/, 'relay_')] = fx.rpc[name];
        delete fx.rpc[name];
    }
    fx.rpcErrors = { continuity_my_access: { code: 'PGRST202', message: 'Could not find the function public.continuity_my_access' } };
    const { page, context } = await openPage(fx, { url: `/admin/continuity.html?record=${REC}` });
    await page.waitForSelector('#ctRecordTitle');
    assert.equal(await page.locator('#ctRecordTitle').innerText(), 'متابعة الشحنة');
    assert.match(await page.locator('[data-source="s1"]').innerText(), /رقم الطلب هو 45879/);
    await page.waitForSelector('[data-open]');
    await page.waitForSelector('#continuityLink', { state: 'visible' });
    const calls = await page.evaluate(() => window.__RPC_CALLS__);
    assert.deepEqual([...new Set(calls.filter((n) => n.startsWith('continuity_')))], ['continuity_my_access'], 'only the probe uses the new name');
    for (const n of ['relay_my_access', 'relay_get', 'relay_list']) assert.ok(calls.includes(n), n);
    await context.close();

    // بعد 077: لا نداء بالاسم القديم أبدًا
    const fx2 = pageFixtures();
    fx2.tables.profiles = [{ id: ME, email: 'admin@test.local', role: 'admin', whatsapp_enabled: false }];
    const second = await openPage(fx2, { url: `/admin/continuity.html?record=${REC}` });
    await second.page.waitForSelector('#ctRecordTitle');
    await second.page.waitForSelector('#continuityLink', { state: 'visible' });
    const calls2 = await second.page.evaluate(() => window.__RPC_CALLS__);
    assert.deepEqual(calls2.filter((n) => n.startsWith('relay_')), []);
    await second.context.close();
});

test('record page at 390px: list first, record replaces it, no horizontal overflow', { skip: !chromiumPath }, async () => {
    const { page, context } = await openPage(pageFixtures(), { url: '/admin/continuity.html', viewport: { width: 390, height: 844 } });
    await page.waitForSelector('[data-open]');
    assert.ok(await page.locator('.ct-panel--detail').isHidden());
    await page.locator(`[data-open="${REC}"]`).click();
    await page.waitForSelector('#ctRecordTitle');
    assert.ok(await page.locator('.ct-panel--list').isHidden());
    const wide = await page.evaluate(() => [...document.querySelectorAll('.ct-page *')]
        .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.right > window.innerWidth + 1; })
        .map((el) => el.className || el.tagName));
    assert.deepEqual(wide, []);
    await page.locator('#ctBackToList').click();
    assert.ok(await page.locator('.ct-panel--list').isVisible());
    await context.close();
});

/* ── 076: المحذوفات والتحكم الأكبر للمالك ───────────────────────────────── */
const ACCESS_076 = { member: true, enabled: true, supervisor: true, can_assign: true, owner: false };
function trashFixtures({ access = ACCESS_076, status = 'open' } = {}) {
    const fx = pageFixtures({ access });
    fx.rpc.continuity_get.record.status = status;
    fx.rpc.continuity_get.removed = [
        { id: 's3', position: 3, source_type: 'mad3oom_message', provider: 'mad3oom', captured_at: at(9, 0),
          chat_session_id: S, chat_message_id: 'm1', excerpt: 'مرحبًا، أريد الاستفسار', sender_label: 'العميل',
          original_created_at: at(7, 24), truncated: false, source_deleted: false, edited_after_capture: false,
          removed_at: at(10, 0), removed_by: STAFF },
    ];
    fx.rpc.continuity_list_removed = [{ record: { id: REC, title: 'متابعة الشحنة', status, version: 3 }, source: fx.rpc.continuity_get.removed[0] }];
    fx.rpc.continuity_remove_source = fx.rpc.continuity_get;
    fx.rpc.continuity_restore_source = fx.rpc.continuity_get;
    fx.rpc.continuity_redact_source = fx.rpc.continuity_get;
    fx.rpc.continuity_purge_removed = { purged: 1 };
    return fx;
}

test('trash (076): «إزالة» moves a source to المحذوفات and «استرجاع» brings it back; no erase for a non-owner', { skip: !chromiumPath }, async () => {
    const native = [];
    const { page, context, errors } = await openPage(trashFixtures(), { url: `/admin/continuity.html?record=${REC}` });
    page.on('dialog', (d) => { native.push(d.type()); d.dismiss(); });
    await page.waitForSelector('#ctRemoved');
    // المصادر: «إزالة» على كل مصدر (حتى المخفي)، ولا حذف نهائي قديم
    assert.equal(await page.locator('#ctDetail [data-redact]').count(), 0);
    assert.equal(await page.locator('[data-remove][data-source="s2"]').count(), 1);
    await page.locator('[data-remove][data-source="s1"]').click();
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'continuity_remove_source'));
    assert.deepEqual(await rpcCalls(page, 'continuity_remove_source'), [{ p_source: 's1', p_expected_version: 3 }]);
    await page.waitForFunction(() => /المحذوفات/.test(document.querySelector('#toast')?.innerText || ''));
    // المحذوفات في السجل: النص (الخادم رجّعه)، مين شالها، واسترجاع بس
    const removed = page.locator('#ctRemoved');
    assert.match(await removed.locator('h3').innerText(), /المحذوفات \(1\)/);
    assert.match(await removed.innerText(), /مرحبًا، أريد الاستفسار/);
    assert.match(await removed.innerText(), /شالها هبة سمير/);
    assert.equal(await removed.locator('[data-purge]').count(), 0, 'erase shown to a non-owner');
    assert.equal(await page.locator('#ctPurgeRecord').count(), 0);
    await removed.locator('[data-restore][data-source="s3"]').click();
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'continuity_restore_source'));
    assert.deepEqual(await rpcCalls(page, 'continuity_restore_source'), [{ p_source: 's3', p_expected_version: 3 }]);
    // لوحة المحذوفات عبر السجلات: اسم السجل يفتحه، بلا «تفريغ الكل» لغير المالك
    await page.waitForSelector('#ctTrash:not([hidden]) .ct-trash-item');
    assert.match(await page.locator('#ctTrash').innerText(), /متابعة الشحنة/);
    assert.equal(await page.locator('#ctPurgeAll').isHidden(), true);
    assert.equal(await page.locator('#ctTrash [data-purge]').count(), 0);
    // صلاحية الإسناد بعد 076 للمالك بس، حتى لو المتصل مشرف
    assert.equal(await page.locator('#ctAssigners').isHidden(), true, 'assigner admin shown to a supervisor after 076');
    assert.deepEqual(await rpcCalls(page, 'continuity_list_assigners'), []);
    assert.deepEqual(await rpcCalls(page, 'continuity_redact_source'), []);
    assert.deepEqual(native, []);
    assert.deepEqual(errors, []);
    await context.close();
});

test('trash (076): the platform owner erases one, empties a record, empties all, each behind a danger dialog', { skip: !chromiumPath }, async () => {
    const native = [];
    const { page, context, errors } = await openPage(trashFixtures({ access: { ...ACCESS_076, owner: true } }), { url: `/admin/continuity.html?record=${REC}` });
    page.on('dialog', (d) => { native.push(d.type()); d.dismiss(); });
    await page.waitForSelector('#ctRemoved [data-purge]');
    await page.waitForSelector('#ctAssigners:not([hidden]) .ct-assigners li');
    // مسح واحد: إلغاء لا يرسل شيئًا، والتأكيد يرسل manual
    await page.locator('#ctRemoved [data-purge][data-source="s3"]').click();
    await page.waitForSelector('#ctConfirm[open]');
    assert.match(await page.locator('#ctConfirmTitle').innerText(), /مسح الرسالة نهائيًا/);
    assert.match(await page.locator('#ctConfirmOk').getAttribute('class'), /btn-danger/);
    await page.keyboard.press('Escape');
    assert.deepEqual(await rpcCalls(page, 'continuity_redact_source'), []);
    await page.locator('#ctRemoved [data-purge][data-source="s3"]').click();
    await page.locator('#ctConfirm[open] #ctConfirmOk').click();
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'continuity_redact_source'));
    assert.deepEqual(await rpcCalls(page, 'continuity_redact_source'), [{ p_source: 's3', p_reason: 'manual' }]);
    // تفريغ محذوفات السجل
    await page.waitForSelector('#ctPurgeRecord');
    await page.locator('#ctPurgeRecord').click();
    await page.waitForSelector('#ctConfirm[open]');
    assert.match(await page.locator('#ctConfirmMsg').innerText(), /1 رسالة/);
    await page.locator('#ctConfirmOk').click();
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'continuity_purge_removed'));
    assert.deepEqual(await rpcCalls(page, 'continuity_purge_removed'), [{ p_record: REC }]);
    // تفريغ الكل
    await page.waitForSelector('#ctPurgeAll:not([hidden])');
    await page.locator('#ctPurgeAll').click();
    await page.waitForSelector('#ctConfirm[open]');
    assert.match(await page.locator('#ctConfirmTitle').innerText(), /تفريغ كل المحذوفات/);
    await page.locator('#ctConfirmOk').click();
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).filter(([n]) => n === 'continuity_purge_removed').length === 2);
    assert.deepEqual((await rpcCalls(page, 'continuity_purge_removed'))[1], { p_record: null });
    assert.deepEqual(native, []);
    assert.deepEqual(errors, []);
    await context.close();
});

test('trash (076): a closed record has no remove or restore; the server refusal for erase is explained', { skip: !chromiumPath }, async () => {
    const fx = trashFixtures({ access: { ...ACCESS_076, owner: true }, status: 'resolved' });
    fx.rpcErrors = { continuity_redact_source: { code: '42501', message: 'غير مسموح', details: '{"code":"forbidden","field":"owner"}' } };
    const { page, context } = await openPage(fx, { url: `/admin/continuity.html?record=${REC}` });
    await page.waitForSelector('#ctRemoved');
    assert.equal(await page.locator('#ctDetail [data-remove]').count(), 0);
    assert.equal(await page.locator('#ctDetail [data-restore]').count(), 0);
    assert.match(await page.locator('#ctRemoved').innerText(), /أعد فتحه/);
    await page.waitForSelector('#ctTrash:not([hidden]) .ct-trash-item');
    assert.equal(await page.locator('#ctTrash [data-restore]').count(), 0);
    await page.locator('#ctRemoved [data-purge]').click();
    await page.locator('#ctConfirm[open] #ctConfirmOk').click();
    await page.waitForFunction(() => /مالك المنصة/.test(document.querySelector('#toast')?.innerText || ''));
    assert.match(await page.locator('#toast').innerText(), /لحساب مالك المنصة بس/);
    await context.close();
});

test('trash (076) at 390px: actions are 44px, nothing overflows', { skip: !chromiumPath }, async () => {
    const { page, context } = await openPage(trashFixtures({ access: { ...ACCESS_076, owner: true } }),
        { url: `/admin/continuity.html?record=${REC}`, viewport: { width: 390, height: 844 } });
    await page.waitForSelector('#ctRemoved [data-purge]');
    await page.waitForSelector('#ctTrash:not([hidden]) .ct-trash-item');
    for (const sel of ['[data-remove][data-source="s1"]', '#ctRemoved [data-restore]', '#ctRemoved [data-purge]', '#ctPurgeRecord', '#ctPurgeAll', '.ct-trash-record']) {
        const b = await page.locator(sel).first().boundingBox();
        assert.ok(b && b.height >= 44, `${sel} touch target ${b?.height}`);
    }
    const wide = await page.evaluate(() => [...document.querySelectorAll('main *')]
        .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.right > window.innerWidth + 1; })
        .map((el) => el.className || el.tagName));
    assert.deepEqual(wide, []);
    await context.close();
});

test('before 076 (continuity_my_access without owner): the page keeps the 074 behavior', { skip: !chromiumPath }, async () => {
    const fx = pageFixtures({ access: { member: true, enabled: true, supervisor: true, can_assign: true } });
    fx.rpcErrors = { continuity_list_removed: { code: 'PGRST202', message: 'Could not find the function public.continuity_list_removed' } };
    const { page, context, errors } = await openPage(fx, { url: `/admin/continuity.html?record=${REC}` });
    await page.waitForSelector('#ctRecordTitle');
    assert.equal(await page.locator('[data-redact="s1"]').count(), 1);
    assert.equal(await page.locator('[data-remove]').count(), 0);
    assert.equal(await page.locator('#ctTrash').isHidden(), true);
    await page.waitForSelector('#ctAssigners:not([hidden])');
    assert.deepEqual(await rpcCalls(page, 'continuity_list_removed'), []);
    assert.deepEqual(errors, []);
    await context.close();
});

/* ── المرحلة 0 (078): الهوية ولوحة الإعدادات للمالك ────────────────────────── */
const POLICY_RES = {
    policy: { handovers_enabled: false, reminders_enabled: false, escalation_enabled: false, monitor_enabled: false,
        attachments_enabled: false, ai_enabled: false, reminder_offsets_minutes: [60], due_alert: true,
        overdue_repeat_minutes: null, overdue_repeat_max: 3, escalate_after_minutes: 240, escalation_recipients: 'supervisors',
        respect_working_hours: true, handover_remind_after_minutes: 60, handover_escalate_after_minutes: 240,
        stale_after_days: 7, postpone_flag_count: 3 },
    version: 1, updated_by: null, updated_at: at(9, 0),
    capabilities_installed: { handovers: false, reminders: false, escalation: false, monitor: false, attachments: false, ai: false },
    capabilities: { handovers: false, reminders: false, escalation: false, monitor: false, attachments: false, ai: false },
};
const OFF_CAPS = POLICY_RES.capabilities;

test('branding: «الاستمرارية» and Mad3oom Continuity with the logo; the sidebar link keeps the page route', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openPage(pageFixtures(), { url: '/admin/continuity.html' });
    await page.waitForSelector('#ctList');
    assert.equal(await page.title(), 'الاستمرارية - لوحة الإدارة');
    assert.equal((await page.locator('.page-header h1').innerText()).trim(), 'الاستمرارية');
    assert.equal((await page.locator('.ct-brand-name').innerText()).trim(), 'Mad3oom Continuity');
    const logo = page.locator('.ct-brand-logo');
    assert.equal(await logo.getAttribute('alt'), 'Mad3oom Continuity');
    assert.ok(await logo.evaluate((img) => img.complete && img.naturalWidth > 0), 'logo did not load');
    // الرابط نفسه (ظهوره يقرره السايدبار حسب الصلاحيات، خارج هذا التغيير)
    await page.waitForSelector('#continuityLink', { state: 'attached' });
    assert.equal(await page.getAttribute('#continuityLink', 'href'), '/admin/continuity.html');
    assert.equal((await page.locator('#continuityLink span').textContent()).trim(), 'الاستمرارية');
    assert.match(await page.locator('#continuityLink svg path').getAttribute('d'), /^M12 12c-2-2\.67/, 'infinity icon');
    assert.deepEqual(errors, []);
    await context.close();
});

test('policies panel: the platform owner sees the policy read-only after 078; hidden before 078 and for everyone else', { skip: !chromiumPath }, async () => {
    const ownerAccess = { member: true, enabled: true, supervisor: true, can_assign: true, owner: true, capabilities: OFF_CAPS };
    let fx = pageFixtures({ access: ownerAccess });
    fx.rpc.continuity_get_policies = POLICY_RES;
    let r = await openPage(fx, { url: '/admin/continuity.html' });
    await r.page.waitForSelector('#ctPolicyCaps li');
    const caps = await r.page.locator('#ctPolicyCaps').innerText();
    assert.equal((caps.match(/مطفأة · غير مثبتة بعد/g) || []).length, 6);
    const timings = await r.page.locator('#ctPolicyTimings').innerText();
    assert.match(timings, /تذكير قبل الموعد\s*ساعة/);
    assert.match(timings, /تصعيد بعد التأخير\s*بعد 4 ساعات للمشرفين/);
    assert.match(timings, /تسليم معلّق: تذكير\s*بعد ساعة/);
    assert.match(timings, /تسليم معلّق: تصعيد\s*بعد 4 ساعات/);
    // قراءة فقط: لا أي أداة تعديل، ولا نداء continuity_set_policies
    assert.equal(await r.page.locator('#ctPolicies button, #ctPolicies input, #ctPolicies select').count(), 0);
    assert.deepEqual(await rpcCalls(r.page, 'continuity_set_policies'), []);
    await r.context.close();

    // قبل 078: لا مفتاح capabilities ⇒ اللوحة مخفية ولا نداء للسياسات
    fx = pageFixtures({ access: { member: true, enabled: true, supervisor: true, can_assign: true, owner: true } });
    r = await openPage(fx, { url: '/admin/continuity.html' });
    await r.page.waitForSelector('#ctList');
    assert.equal(await r.page.locator('#ctPolicies').isHidden(), true);
    assert.deepEqual(await rpcCalls(r.page, 'continuity_get_policies'), []);
    await r.context.close();

    // غير المالك (مشرف): مخفية
    fx = pageFixtures({ access: { member: true, enabled: true, supervisor: true, can_assign: true, owner: false, capabilities: OFF_CAPS } });
    fx.rpc.continuity_get_policies = POLICY_RES;
    r = await openPage(fx, { url: '/admin/continuity.html' });
    await r.page.waitForSelector('#ctList');
    assert.equal(await r.page.locator('#ctPolicies').isHidden(), true);
    assert.deepEqual(await rpcCalls(r.page, 'continuity_get_policies'), []);
    await r.context.close();
});

// ─────────────────────────────────────────────────────────────
// 079: تاريخ الإغلاق وإعادة الفتح
// ─────────────────────────────────────────────────────────────
const INJECT = '<img src=x onerror="window.__XSS__=1">';
function closedFixtures({ due = '2026-01-15T09:00:00Z', kind = 'follow_up', closures = true } = {}) {
    const fx = pageFixtures();
    const record = { ...fx.rpc.continuity_get.record, kind, status: 'resolved', due_at: due, closed_at: at(10, 0),
        resolution_note: `اتشحنت ${INJECT}`, version: 7 };
    fx.rpc.continuity_list = [{ ...record, source_count: 2 }];
    fx.rpc.continuity_get = { ...fx.rpc.continuity_get, record };
    if (closures) {
        fx.rpc.continuity_get.closures = [
            { seq: 2, closed_status: 'resolved', closed_at: at(10, 0), closed_by: STAFF, resolution_note: `اتشحنت ${INJECT}`,
              cancel_reason: null, reopened_at: null, reopened_by: null, reopen_reason: null, backfilled: false },
            { seq: 1, closed_status: 'cancelled', closed_at: at(8, 0), closed_by: null, resolution_note: null, cancel_reason: null,
              reopened_at: at(9, 0), reopened_by: ME, reopen_reason: null, backfilled: true },
        ];
    }
    return fx;
}

test('reopen (079): closure history renders as text; an expired follow-up needs a reason and a new due before reopening', { skip: !chromiumPath }, async () => {
    const native = [];
    const { page, context, errors } = await openPage(closedFixtures(), { url: `/admin/continuity.html?record=${REC}` });
    page.on('dialog', (d) => { native.push(d.type()); d.dismiss(); });
    await page.waitForSelector('#ctClosures');
    const items = page.locator('#ctClosures .ct-closure');
    assert.equal(await items.count(), 2);
    assert.deepEqual(await items.evaluateAll((li) => li.map((x) => x.dataset.seq)), ['2', '1'], 'newest first');
    assert.equal(await items.nth(0).locator('.ct-closure-note').innerText(), `اتشحنت ${INJECT}`, 'note shown as text');
    assert.equal(await page.locator('#ctClosures img').count(), 0, 'no markup from a note');
    assert.match(await items.nth(1).innerText(), /اتلغى/);
    assert.match(await items.nth(1).innerText(), /سبب الإلغاء مش محفوظ/);
    assert.match(await items.nth(1).innerText(), /اتفتح تاني/);
    assert.match(await items.nth(1).innerText(), /السبب مش محفوظ/);
    assert.match(await items.nth(1).innerText(), /النظام/, 'a closure without an actor is not «بدون مالك»');
    // الحالات المعروضة: إعادة فتح فقط
    assert.deepEqual(await page.locator('[data-to]').evaluateAll((b) => b.map((x) => x.dataset.to)), ['open']);
    await page.locator('[data-to="open"]').click();
    await page.waitForSelector('#ctConfirm[open] #ctConfirmDue');
    assert.equal(await page.locator('#ctConfirmDue').getAttribute('aria-required'), 'true');
    assert.match(await page.locator('#ctConfirmDueNote').innerText(), /عدّى، فلازم موعد جديد/);
    const ok = page.locator('#ctConfirmOk');
    await page.locator('#ctConfirmInput').fill('العميل رجع اشتكى');
    assert.equal(await ok.isDisabled(), true, 'a reason alone is not enough for an expired follow-up');
    await page.locator('#ctConfirmDue').fill('2030-02-01T11:30');
    await page.locator('#ctConfirmTz').selectOption('Asia/Riyadh');
    assert.equal(await ok.isDisabled(), false);
    await page.locator('#ctConfirmDue').fill('');
    assert.equal(await ok.isDisabled(), true);
    // Escape لا يرسل شيئًا
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#ctConfirm').count(), 0);
    assert.deepEqual(await rpcCalls(page, 'continuity_transition'), []);
    await page.locator('[data-to="open"]').click();
    await page.locator('#ctConfirm[open] #ctConfirmInput').fill('  العميل رجع اشتكى ');
    await page.locator('#ctConfirmDue').fill('2030-02-01T11:30');
    await page.locator('#ctConfirmTz').selectOption('Asia/Riyadh');
    await ok.click();
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'continuity_transition'));
    const calls = await rpcCalls(page, 'continuity_transition');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { p_record: REC, p_to: 'open', p_expected_version: 7,
        p_details: { reason: 'العميل رجع اشتكى', due: { at: '2030-02-01T11:30:00', tz: 'Asia/Riyadh' } } });
    assert.equal(await page.evaluate(() => window.__XSS__), undefined);
    assert.deepEqual(native, []);
    assert.deepEqual(errors, []);
    await context.close();
});

test('reopen (079): a future due stays unless changed; a server refusal (due_required_on_reopen) is explained', { skip: !chromiumPath }, async () => {
    const fx = closedFixtures({ due: '2030-01-15T09:00:00Z' });
    fx.rpcErrors = { continuity_transition: { code: '22023', message: 'بيانات غير صالحة: details.due',
        details: '{"code":"validation_failed","field":"details.due","reason":"due_required_on_reopen"}' } };
    const { page, context, errors } = await openPage(fx, { url: `/admin/continuity.html?record=${REC}` });
    await page.waitForSelector('[data-to="open"]');
    await page.locator('[data-to="open"]').click();
    await page.waitForSelector('#ctConfirm[open] #ctConfirmDue');
    assert.equal(await page.locator('#ctConfirmDue').getAttribute('aria-required'), null);
    assert.match(await page.locator('#ctConfirmDueNote').innerText(), /الموعد الحالي يفضل/);
    await page.locator('#ctConfirmInput').fill('رجعت');
    assert.equal(await page.locator('#ctConfirmOk').isDisabled(), false);
    await page.locator('#ctConfirmOk').click();
    await page.waitForFunction(() => !document.getElementById('toast').hidden);
    const [call] = await rpcCalls(page, 'continuity_transition');
    assert.deepEqual(call.p_details, { reason: 'رجعت' }, 'no due sent when left empty');
    assert.match(await page.locator('#toast').innerText(), /حدد موعد جديد/);
    assert.deepEqual(errors, []);
    await context.close();
});

test('reopen (079): before 079 (no closures) the history is absent and reopening still works; 390px fits', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openPage(closedFixtures({ kind: 'issue', closures: false }),
        { url: `/admin/continuity.html?record=${REC}`, viewport: { width: 390, height: 844 } });
    await page.waitForSelector('[data-to="open"]');
    assert.equal(await page.locator('#ctClosures').count(), 0);
    await page.locator('[data-to="open"]').click();
    await page.waitForSelector('#ctConfirm[open] #ctConfirmDue');
    const fit = await page.evaluate(() => {
        const r = document.querySelector('#ctConfirm .ct-sheet').getBoundingClientRect();
        return { inside: r.left >= 0 && r.right <= window.innerWidth + 0.5, doc: document.documentElement.scrollWidth - window.innerWidth };
    });
    assert.ok(fit.inside && fit.doc <= 0, `dialog overflows: ${JSON.stringify(fit)}`);
    await page.locator('#ctConfirmInput').fill('ظهرت تاني');
    assert.equal(await page.locator('#ctConfirmOk').isDisabled(), false, 'an issue reopens without a due');
    await page.locator('#ctConfirmOk').click();
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'continuity_transition'));
    assert.deepEqual((await rpcCalls(page, 'continuity_transition'))[0].p_details, { reason: 'ظهرت تاني' });
    assert.deepEqual(errors, []);
    await context.close();
});

// ─────────────────────────────────────────────────────────────
// نافذة السجل المستقلة (admin/continuity-record.html?id=)
// ─────────────────────────────────────────────────────────────
const STANDALONE_URL = (id) => `/admin/continuity-record.html?id=${id}`;

test('standalone: «فتح السجل في نافذة مستقلة» opens the same record in a new window, safely', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openPage(pageFixtures(), { url: `/admin/continuity.html?record=${REC}` });
    await page.waitForSelector('#ctRecordTitle');
    const link = page.locator('#ctOpenStandalone');
    assert.equal(await link.innerText(), 'فتح السجل في نافذة مستقلة');
    assert.equal(await link.getAttribute('href'), STANDALONE_URL(REC));
    assert.equal(await link.getAttribute('target'), '_blank');
    assert.deepEqual((await link.getAttribute('rel')).split(/\s+/).sort(), ['noopener', 'noreferrer']);
    // البديل يُحقن في كل صفحة جديدة من نفس السياق
    const [popup] = await Promise.all([context.waitForEvent('page'), link.click()]);
    popup.on('pageerror', (e) => errors.push(e.message));
    await popup.waitForSelector('#ctRecordTitle');
    assert.equal(await popup.evaluate(() => window.opener), null, 'no opener handle');
    assert.equal(await popup.locator('#ctRecordTitle').innerText(), 'متابعة الشحنة');
    assert.equal(await popup.title(), 'سجل الاستمرارية - لوحة الإدارة', 'the record title stays out of the tab/history title');
    assert.equal(await popup.locator('#ctList, #ctTrash, #ctAssigners, #ctPolicies, #sidebar-container').count(), 0);
    assert.equal(await popup.locator('#ctOpenStandalone').count(), 0, 'no window-in-window link');
    assert.equal(await popup.locator('#ctOpenInPage').getAttribute('href'), `/admin/continuity.html?record=${REC}`);
    const gets = await rpcCalls(popup, 'continuity_get');
    assert.deepEqual(gets, [{ p_record: REC }]);
    assert.deepEqual(await rpcCalls(popup, 'continuity_list'), [], 'no list in the standalone window');
    // نفس الأدوات ونفس الـRPC: انتقال يحتاج نص
    await popup.locator('[data-to="waiting"]').click();
    await popup.locator('#ctConfirm[open] #ctConfirmInput').fill('رد المورد');
    await popup.locator('#ctConfirmOk').click();
    await popup.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'continuity_transition'));
    assert.deepEqual((await rpcCalls(popup, 'continuity_transition'))[0],
        { p_record: REC, p_to: 'waiting', p_details: { waiting_on: 'رد المورد' }, p_expected_version: 3 });
    assert.equal(new URL(popup.url()).searchParams.get('id'), REC, 'the window keeps its own URL');
    assert.deepEqual(errors, []);
    await context.close();
});

test('standalone: an invalid link calls nothing; not found and load errors say why; retry works', { skip: !chromiumPath }, async () => {
    for (const bad of ['', 'not-a-uuid', `${REC}x`, '../continuity.html']) {
        const { page, context, errors } = await openPage(pageFixtures(), { url: STANDALONE_URL(encodeURIComponent(bad)) });
        await page.waitForSelector('#ctInvalidLink');
        // فقط فحص الجلسة (owner_context_status من حارس الصفحة)؛ ولا أي نداء للاستمرارية
        const called = await page.evaluate(() => (window.__RPC_ARGS__ || []).map(([n]) => n));
        assert.deepEqual(called.filter((n) => n.startsWith('continuity_')), [], `Continuity RPC called for ${bad}`);
        assert.deepEqual(errors, []);
        await context.close();
    }
    const missing = pageFixtures();
    missing.rpcErrors = { continuity_get: { code: 'P0002', message: 'غير موجود', details: '{"code":"not_found"}' } };
    let r = await openPage(missing, { url: STANDALONE_URL(REC) });
    await r.page.waitForSelector('#ctNotFound');
    assert.match(await r.page.locator('#ctNotFound').innerText(), /غير موجود أو مش مسموح لك تشوفه/);
    assert.equal(await r.page.locator('#ctRetry').count(), 0, 'no retry for a record you cannot see');
    assert.deepEqual(r.errors, []);
    await r.context.close();
    const broken = pageFixtures();
    broken.rpcErrors = { continuity_get: { code: 'XX000', message: 'network down' } };
    r = await openPage(broken, { url: STANDALONE_URL(REC) });
    await r.page.waitForSelector('#ctLoadError');
    assert.ok(!(await r.page.locator('#ctLoadError').innerText()).includes('network down'), 'raw server text is not shown');
    await r.page.evaluate(() => { delete window.__FIXTURES__.rpcErrors; });
    await r.page.locator('#ctRetry').click();
    await r.page.waitForSelector('#ctRecordTitle');
    assert.equal((await rpcCalls(r.page, 'continuity_get')).length, 2);
    assert.deepEqual(r.errors, []);
    await r.context.close();
});

test('standalone: Continuity off or not a member shows the reason and never asks for the record', { skip: !chromiumPath }, async () => {
    for (const access of [{ member: true, enabled: false }, { member: false, enabled: true }]) {
        const { page, context, errors } = await openPage(pageFixtures({ access }), { url: STANDALONE_URL(REC) });
        await page.waitForSelector('#ctBanner:not([hidden])');
        assert.equal(await page.locator('#ctPage').isHidden(), true);
        assert.deepEqual(await rpcCalls(page, 'continuity_get'), []);
        assert.deepEqual(errors, []);
        await context.close();
    }
});

test('standalone at 390px: one column, no horizontal overflow, 44px actions', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openPage(pageFixtures(), { url: STANDALONE_URL(REC), viewport: { width: 390, height: 844 } });
    await page.waitForSelector('#ctRecordTitle');
    const m = await page.evaluate(() => ({
        doc: document.documentElement.scrollWidth - window.innerWidth,
        small: [...document.querySelectorAll('#ctDetail .ct-inline .btn')].filter((b) => b.getBoundingClientRect().height < 44).length,
    }));
    assert.ok(m.doc <= 0, `horizontal overflow ${m.doc}px`);
    assert.equal(m.small, 0, 'an action is smaller than 44px');
    assert.deepEqual(errors, []);
    await context.close();
});

// ─────────────────────────────────────────────────────────────
// المرفقات (080)
// ─────────────────────────────────────────────────────────────
const WS = 'aaaaaaaa-0000-4000-8000-000000000001';
const att = (id, kind, mime, name, extra = {}) => ({ id, kind, mime, size: 2048, name, path: `${WS}/${REC}/${id}`, status: 'active',
    created_by: STAFF, created_at: at(9, 30), ...extra });
const A_IMG = 'a1a1a1a1-0000-4000-8000-000000000001';
const A_VID = 'a1a1a1a1-0000-4000-8000-000000000002';
const A_AUD = 'a1a1a1a1-0000-4000-8000-000000000003';
const A_DEL = 'a1a1a1a1-0000-4000-8000-000000000004';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(120)]);
function attFixtures({ on = true, owner = false, status = 'open' } = {}) {
    const fx = pageFixtures();
    fx.rpc.continuity_my_access = { ...fx.rpc.continuity_my_access, owner, capabilities: { attachments: on } };
    const record = { ...fx.rpc.continuity_get.record, status, closed_at: status === 'open' ? null : at(10, 0) };
    fx.rpc.continuity_get = { ...fx.rpc.continuity_get, record,
        attachments: [att(A_IMG, 'image', 'image/png', `لقطة ${INJECT}.png`), att(A_VID, 'video', 'video/mp4', 'شرح.mp4'),
            att(A_AUD, 'audio', 'audio/webm', 'تسجيل.webm')],
        removed_attachments: [att(A_DEL, 'image', 'image/jpeg', 'قديمة.jpg', { status: 'removed', removed_by: ME, removed_at: at(9, 40) })] };
    return fx;
}
async function routeUpload(context, responses) {
    const seen = [];
    await context.route('**/functions/v1/continuity-attachment-upload', async (route) => {
        const req = route.request();
        seen.push({ headers: req.headers(), size: req.postDataBuffer()?.length ?? 0 });
        const next = responses[Math.min(seen.length - 1, responses.length - 1)];
        await route.fulfill({ status: next.status, contentType: 'application/json', body: JSON.stringify(next.body) });
    });
    return seen;
}

test('attachments (080): media signed, names as text; a PNG goes to the upload function with exactly the declared headers', { skip: !chromiumPath }, async () => {
    const fx = attFixtures();
    const { page, context, errors } = await openPage(fx, { url: `/admin/continuity.html?record=${REC}` });
    const seen = await routeUpload(context, [{ status: 200, body: fx.rpc.continuity_get }]);
    await page.waitForSelector('#ctAttachments');
    assert.match(await page.locator('#ctAttH').innerText(), /المرفقات \(3\)/);
    await page.waitForFunction(() => document.querySelector('[data-attachment] img')?.getAttribute('src'));
    assert.equal(await page.locator(`[data-attachment="${A_IMG}"] img`).getAttribute('src'), `/signed/${WS}/${REC}/${A_IMG}`);
    assert.equal(await page.locator(`[data-attachment="${A_VID}"] video`).getAttribute('src'), `/signed/${WS}/${REC}/${A_VID}`);
    assert.equal(await page.locator(`[data-attachment="${A_AUD}"] audio`).getAttribute('preload'), 'none');
    assert.equal(await page.locator(`[data-attachment="${A_IMG}"] .ct-att-name`).innerText(), `لقطة ${INJECT}.png`);
    assert.equal(await page.locator('#ctAttachments img:not(.ct-att-media)').count(), 0, 'no markup from a name');
    assert.equal(await page.locator(`[data-attachment="${A_DEL}"] [data-sign]`).count(), 0, 'removed: no media, no URL');
    assert.equal(await page.locator('[data-att-purge]').count(), 0, 'no erase for a non-owner');
    assert.match(await page.locator('#ctAttachInput').getAttribute('accept'), /^image\/png,image\/jpeg,image\/webp,image\/gif,video\/mp4/);
    await page.setInputFiles('#ctAttachInput', { name: 'صورة العميل.png', mimeType: 'image/png', buffer: PNG });
    await page.waitForFunction(() => !document.getElementById('toast').hidden);
    assert.equal(seen.length, 1);
    const h = seen[0].headers;
    assert.equal(h.authorization, 'Bearer test');
    assert.equal(h['content-type'], 'image/png');
    assert.equal(h['x-continuity-record'], REC);
    assert.equal(h['x-continuity-kind'], 'image');
    assert.match(h['x-idempotency-key'], /^[0-9a-f-]{36}$/);
    assert.equal(decodeURIComponent(h['x-continuity-name']), 'صورة العميل.png');
    assert.equal(seen[0].size, PNG.length);
    assert.match(await page.locator('#toast').innerText(), /اترفع المرفق/);
    assert.equal(await page.evaluate(() => window.__XSS__), undefined);
    assert.deepEqual(errors, []);
    await context.close();
});

test('attachments (080): refused in the browser before any request — type, size, and a PNG that is not a PNG', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openPage(attFixtures(), { url: `/admin/continuity.html?record=${REC}` });
    const seen = await routeUpload(context, [{ status: 200, body: {} }]);
    await page.waitForSelector('#ctAttachPick');
    const cases = [
        [{ name: 'x.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') }, /النوع ده مش مسموح/],
        [{ name: 'x.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7') }, /النوع ده مش مسموح/],
        [{ name: 'big.png', mimeType: 'image/png', buffer: Buffer.concat([PNG, Buffer.alloc(3145729 - PNG.length)]) }, /أكبر من الحد \(3 ميجا\)/],
        [{ name: 'fake.png', mimeType: 'image/png', buffer: Buffer.from('<!doctype html><script>alert(1)</script>') }, /محتوى الملف مش من النوع/],
    ];
    for (const [file, msg] of cases) {
        // كل حالة تمسح ما قبلها: بلا ذلك يجد الانتظار رسالة الحالة السابقة فورًا
        if (await page.locator('#ctAttachDismiss').count()) await page.locator('#ctAttachDismiss').click();
        await page.evaluate(() => { const e = document.getElementById('ctAttachError'); if (e) e.textContent = ''; });
        await page.setInputFiles('#ctAttachInput', file);
        await page.waitForFunction((src) => new RegExp(src).test(document.getElementById('ctAttachError')?.textContent || ''), msg.source);
        assert.match(await page.locator('#ctAttachError').innerText(), msg, file.name);
        assert.equal(await page.locator('#ctAttachRetry').count(), 0, 'nothing to retry');
    }
    assert.equal(seen.length, 0, 'no request');
    assert.deepEqual(errors, []);
    await context.close();
});

test('attachments (080): a failed upload is explained and retried with the same idempotency key; cancel sends nothing more', { skip: !chromiumPath }, async () => {
    const fx = attFixtures();
    const { page, context, errors } = await openPage(fx, { url: `/admin/continuity.html?record=${REC}` });
    const seen = await routeUpload(context, [
        { status: 502, body: { error: { code: 'upload_failed' } } },
        { status: 200, body: fx.rpc.continuity_get },
    ]);
    await page.waitForSelector('#ctAttachPick');
    await page.setInputFiles('#ctAttachInput', { name: 'a.png', mimeType: 'image/png', buffer: PNG });
    await page.waitForSelector('#ctAttachError');
    assert.match(await page.locator('#ctAttachError').innerText(), /مشكلة في الرفع/);
    await page.locator('#ctAttachRetry').click();
    await page.waitForFunction(() => !document.getElementById('toast').hidden);
    assert.equal(seen.length, 2);
    assert.equal(seen[0].headers['x-idempotency-key'], seen[1].headers['x-idempotency-key'], 'same key on retry');
    // رفض توقيع من الخادم ⇒ رسالة واضحة
    const r2 = await openPage(attFixtures(), { url: `/admin/continuity.html?record=${REC}` });
    await routeUpload(r2.context, [{ status: 415, body: { error: { code: 'validation_failed', field: 'file', reason: 'signature_mismatch' } } }]);
    await r2.page.waitForSelector('#ctAttachPick');
    await r2.page.setInputFiles('#ctAttachInput', { name: 'a.png', mimeType: 'image/png', buffer: PNG });
    await r2.page.waitForSelector('#ctAttachError');
    assert.match(await r2.page.locator('#ctAttachError').innerText(), /محتوى الملف مش من النوع/);
    await r2.page.locator('#ctAttachDismiss').click();
    assert.equal(await r2.page.locator('#ctAttachStatus').count(), 0);
    assert.deepEqual([...errors, ...r2.errors], []);
    await r2.context.close();
    await context.close();
});

test('attachments (080): remove / restore send the version; erase is owner-only behind a danger dialog', { skip: !chromiumPath }, async () => {
    let { page, context, errors } = await openPage(attFixtures(), { url: `/admin/continuity.html?record=${REC}` });
    await page.waitForSelector(`[data-att-remove="${A_VID}"]`);
    await page.locator(`[data-att-remove="${A_VID}"]`).click();
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'continuity_attachment_remove'));
    assert.deepEqual((await rpcCalls(page, 'continuity_attachment_remove'))[0], { p_attachment: A_VID, p_expected_version: 3 });
    await page.waitForSelector(`[data-att-restore="${A_DEL}"]`);
    await page.locator(`[data-att-restore="${A_DEL}"]`).click();
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'continuity_attachment_restore'));
    assert.deepEqual((await rpcCalls(page, 'continuity_attachment_restore'))[0], { p_attachment: A_DEL, p_expected_version: 3 });
    assert.deepEqual(errors, []);
    await context.close();
    ({ page, context, errors } = await openPage(attFixtures({ owner: true }), { url: `/admin/continuity.html?record=${REC}` }));
    await page.waitForSelector(`[data-att-purge="${A_IMG}"]`);
    await page.locator(`[data-att-purge="${A_IMG}"]`).click();
    await page.waitForSelector('#ctConfirm[open]');
    assert.match(await page.locator('#ctConfirmOk').getAttribute('class'), /btn-danger/);
    await page.keyboard.press('Escape');
    assert.deepEqual(await rpcCalls(page, 'continuity_attachment_purge'), []);
    await page.locator(`[data-att-purge="${A_IMG}"]`).click();
    await page.locator('#ctConfirm[open] #ctConfirmOk').click();
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'continuity_attachment_purge'));
    assert.deepEqual((await rpcCalls(page, 'continuity_attachment_purge'))[0], { p_attachment: A_IMG, p_expected_version: 3 });
    assert.deepEqual(errors, []);
    await context.close();
});

test('attachments (080): off ⇒ no section; closed ⇒ view only; a refused signature shows a note instead of the media', { skip: !chromiumPath }, async () => {
    let { page, context, errors } = await openPage(attFixtures({ on: false }), { url: `/admin/continuity.html?record=${REC}` });
    await page.waitForSelector('#ctRecordTitle');
    assert.equal(await page.locator('#ctAttachments').count(), 0);
    await context.close();
    ({ page, context, errors } = await openPage(attFixtures({ status: 'resolved' }), { url: `/admin/continuity.html?record=${REC}` }));
    await page.waitForSelector('#ctAttachments');
    assert.equal(await page.locator('#ctAttachPick, #ctAttachInput, [data-att-remove], [data-att-restore]').count(), 0);
    assert.match(await page.locator('#ctAttachments').innerText(), /السجل مقفول/);
    assert.equal(await page.locator('#ctAttachments [data-sign]').count(), 3, 'still viewable');
    await context.close();
    ({ page, context, errors } = await openPage(attFixtures(), { url: `/admin/continuity.html?record=${REC}`,
        patchDouble: (d) => d.replace("createSignedUrl: async (p) => ({ data: { signedUrl: `/signed/${p}` }, error: null }),",
            "createSignedUrl: async (p) => (p.endsWith('0002') ? { data: null, error: { message: 'denied' } } : { data: { signedUrl: `/signed/${p}` }, error: null }),") }));
    await page.waitForSelector(`[data-attachment="${A_VID}"] p.ct-muted`);
    assert.match(await page.locator(`[data-attachment="${A_VID}"]`).innerText(), /المرفق مش متاح دلوقتي/);
    assert.equal(await page.locator(`[data-attachment="${A_VID}"] video`).count(), 0);
    assert.deepEqual(errors, []);
    await context.close();
});

test('attachments (080) at 390px: the grid fits, actions are 44px', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openPage(attFixtures({ owner: true }), { url: `/admin/continuity.html?record=${REC}`, viewport: { width: 390, height: 844 } });
    await page.waitForSelector('#ctAttachments [data-attachment]');
    const m = await page.evaluate(() => ({
        doc: document.documentElement.scrollWidth - window.innerWidth,
        small: [...document.querySelectorAll('#ctAttachments .btn')].filter((b) => b.getBoundingClientRect().height < 44).length,
        wide: [...document.querySelectorAll('#ctAttachments .ct-att')].filter((x) => x.getBoundingClientRect().right > window.innerWidth + 0.5).length,
    }));
    assert.ok(m.doc <= 0 && m.wide === 0, JSON.stringify(m));
    assert.equal(m.small, 0);
    assert.deepEqual(errors, []);
    await context.close();
});

// ─────────────────────────────────────────────────────────────
// تسجيل صوتي (§15.4) — ميكروفون ومسجّل مزيفان وحتميان
// ─────────────────────────────────────────────────────────────
function fakeMic({ chunk = 1000, deny = null, supported = true } = {}) {
    return `(() => {
      window.__TRACKS__ = { opened: 0, stopped: 0 };
      if (!${supported}) { try { delete window.MediaRecorder; } catch {} window.MediaRecorder = undefined; return; }
      const EBML = [0x1a, 0x45, 0xdf, 0xa3];
      class FakeRecorder {
        static isTypeSupported(t) { return t === 'audio/webm;codecs=opus'; }
        constructor(stream, opts) { this.mimeType = opts?.mimeType || 'audio/webm'; this.state = 'inactive'; this.n = 0; }
        start() {
          this.state = 'recording';
          this.iv = setInterval(() => {
            const b = new Uint8Array(${chunk}); if (this.n++ === 0) b.set(EBML);
            this.ondataavailable?.({ data: new Blob([b], { type: this.mimeType }) });
          }, 100);
        }
        stop() { clearInterval(this.iv); if (this.state === 'inactive') return; this.state = 'inactive'; setTimeout(() => this.onstop?.(), 0); }
      }
      window.MediaRecorder = FakeRecorder;
      const md = navigator.mediaDevices || {};
      md.getUserMedia = async () => {
        if (${JSON.stringify(deny)}) { const e = new Error('no'); e.name = ${JSON.stringify(deny)}; throw e; }
        window.__TRACKS__.opened++;
        const t = { stop() { window.__TRACKS__.stopped++; } };
        return { getTracks: () => [t] };
      };
      try { Object.defineProperty(navigator, 'mediaDevices', { value: md, configurable: true }); } catch {}
    })();`;
}
const tracks = (page) => page.evaluate(() => window.__TRACKS__);

test('audio (§15.4): record → stop → review → upload as audio/webm; the microphone is released', { skip: !chromiumPath }, async () => {
    const fx = attFixtures();
    const { page, context, errors } = await openPage(fx, { url: `/admin/continuity.html?record=${REC}`, init: fakeMic() });
    const seen = [];
    await context.route('**/functions/v1/continuity-attachment-upload', async (route) => {
        const req = route.request();
        seen.push({ headers: req.headers(), body: req.postDataBuffer() });
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fx.rpc.continuity_get) });
    });
    await page.waitForSelector('#ctRecStart');
    assert.deepEqual(await tracks(page), { opened: 0, stopped: 0 }, 'no microphone before the click');
    await page.locator('#ctRecStart').click();
    await page.waitForSelector('#ctRecPanel.is-recording');
    await page.waitForFunction(() => /^[1-9]/.test(document.getElementById('ctRecSize')?.textContent || ''));
    assert.match(await page.locator('#ctRecSize').innerText(), /من 8 ميجا/);
    await page.locator('#ctRecStop').click();
    await page.waitForSelector('#ctRecPreview');
    assert.match(await page.locator('#ctRecPreview').getAttribute('src'), /^blob:/);
    assert.deepEqual(await tracks(page), { opened: 1, stopped: 1 }, 'released on stop');
    await page.locator('#ctRecUpload').click();
    await page.waitForFunction(() => !document.getElementById('toast').hidden);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].headers['content-type'], 'audio/webm');
    assert.equal(seen[0].headers['x-continuity-kind'], 'audio');
    assert.match(decodeURIComponent(seen[0].headers['x-continuity-name']), /^تسجيل صوتي .+\.webm$/);
    assert.deepEqual([...seen[0].body.subarray(0, 4)], [0x1a, 0x45, 0xdf, 0xa3], 'a real WebM header reaches the server');
    assert.equal(await page.locator('#ctRecPanel').count(), 0);
    assert.deepEqual(errors, []);
    await context.close();
});

test('audio (§15.4): past 8 MiB the take is stopped and rejected whole — nothing uploaded, mic released, file fallback offered', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openPage(attFixtures(), { url: `/admin/continuity.html?record=${REC}`, init: fakeMic({ chunk: 3 * 1048576 }) });
    let uploads = 0;
    await context.route('**/functions/v1/continuity-attachment-upload', (route) => { uploads++; return route.abort(); });
    await page.waitForSelector('#ctRecStart');
    await page.locator('#ctRecStart').click();
    await page.waitForSelector('#ctRecError', { timeout: 10000 });
    assert.match(await page.locator('#ctRecError').innerText(), /وصل لحد 8 ميجا فاتلغى كله \(مش هيتقص\)/);
    assert.deepEqual(await tracks(page), { opened: 1, stopped: 1 });
    assert.equal(await page.locator('#ctRecPreview, #ctRecUpload').count(), 0, 'no partial take to upload');
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#ctRecFallback').click()]);
    assert.ok(chooser, 'upload an audio file instead');
    assert.equal(uploads, 0);
    assert.deepEqual(errors, []);
    await context.close();
});

test('audio (§15.4): denied, unsupported, cancel and leaving the page — explained, and the microphone never stays on', { skip: !chromiumPath }, async () => {
    let r = await openPage(attFixtures(), { url: `/admin/continuity.html?record=${REC}`, init: fakeMic({ deny: 'NotAllowedError' }) });
    await r.page.waitForSelector('#ctRecStart');
    await r.page.locator('#ctRecStart').click();
    await r.page.waitForSelector('#ctRecError');
    assert.match(await r.page.locator('#ctRecError').innerText(), /الوصول للميكروفون مرفوض/);
    assert.equal(await r.page.locator('#ctRecFallback').count(), 1);
    await r.page.locator('#ctRecClose').click();
    assert.equal(await r.page.locator('#ctRecPanel').count(), 0);
    assert.deepEqual(r.errors, []);
    await r.context.close();

    r = await openPage(attFixtures(), { url: `/admin/continuity.html?record=${REC}`, init: fakeMic({ supported: false }) });
    await r.page.waitForSelector('#ctRecStart');
    await r.page.locator('#ctRecStart').click();
    await r.page.waitForSelector('#ctRecError');
    assert.match(await r.page.locator('#ctRecError').innerText(), /مش بيدعم تسجيل الصوت/);
    assert.deepEqual(r.errors, []);
    await r.context.close();

    r = await openPage(attFixtures(), { url: `/admin/continuity.html?record=${REC}`, init: fakeMic() });
    await r.page.waitForSelector('#ctRecStart');
    await r.page.locator('#ctRecStart').click();
    await r.page.waitForSelector('#ctRecPanel.is-recording');
    await r.page.locator('#ctRecCancel').click();
    assert.equal(await r.page.locator('#ctRecPanel').count(), 0);
    assert.deepEqual(await tracks(r.page), { opened: 1, stopped: 1 }, 'cancel releases');
    await r.page.locator('#ctRecStart').click();
    await r.page.waitForSelector('#ctRecPanel.is-recording');
    await r.page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    assert.deepEqual(await tracks(r.page), { opened: 2, stopped: 2 }, 'pagehide releases');
    assert.deepEqual(r.errors, []);
    await r.context.close();
});

test('audio (§15.4): closed record or attachments off ⇒ no record button', { skip: !chromiumPath }, async () => {
    for (const opts of [{ status: 'resolved' }, { on: false }]) {
        const { page, context, errors } = await openPage(attFixtures(opts), { url: `/admin/continuity.html?record=${REC}`, init: fakeMic() });
        await page.waitForSelector('#ctRecordTitle');
        assert.equal(await page.locator('#ctRecStart').count(), 0, JSON.stringify(opts));
        assert.deepEqual(errors, []);
        await context.close();
    }
});

test('audio (§15.4): real Chromium MediaRecorder with the fake microphone produces a WebM the server accepts', { skip: !chromiumPath }, async () => {
    const mic = await chromium.launch({ executablePath: chromiumPath,
        args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
    try {
        const fx = attFixtures();
        const { page, context, errors } = await openPage(fx, { url: `/admin/continuity.html?record=${REC}`, on: mic });
        await context.grantPermissions(['microphone']);
        const seen = [];
        await context.route('**/functions/v1/continuity-attachment-upload', async (route) => {
            seen.push({ headers: route.request().headers(), body: route.request().postDataBuffer() });
            await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fx.rpc.continuity_get) });
        });
        await page.waitForSelector('#ctRecStart');
        await page.locator('#ctRecStart').click();
        await page.waitForSelector('#ctRecPanel.is-recording');
        await page.waitForTimeout(1200);
        await page.locator('#ctRecStop').click();
        await page.waitForSelector('#ctRecUpload');
        await page.locator('#ctRecUpload').click();
        await page.waitForFunction(() => !document.getElementById('toast').hidden);
        assert.equal(seen.length, 1);
        assert.match(seen[0].headers['content-type'], /^audio\/(webm|ogg|mp4)$/);
        assert.ok(seen[0].body.length > 100 && seen[0].body.length <= 8388608);
        const { signatureMatches } = await import('../assets/js/continuity/continuity-media.js');
        assert.ok(signatureMatches(seen[0].headers['content-type'], new Uint8Array(seen[0].body.subarray(0, 64))), 'server-side signature check passes');
        assert.deepEqual(errors, []);
        await context.close();
    } finally {
        await mic.close();
    }
});

// ─────────────────────────────────────────────────────────────
// التسليم (081)
// ─────────────────────────────────────────────────────────────
const HO = 'b0b0b0b0-0000-4000-8000-000000000001';
const REC2 = 'cccccccc-0000-4000-8000-000000000009';
function hoFixtures({ on = true, owner = ME, pending = false, incoming = false, canAssign = false } = {}) {
    const fx = pageFixtures({ owner, access: { member: true, enabled: true, supervisor: false, can_assign: canAssign } });
    fx.rpc.continuity_my_access = { ...fx.rpc.continuity_my_access, owner: false, capabilities: { handovers: on } };
    fx.rpc.continuity_handovers_for_record = pending ? [
        { id: HO, record_id: REC, from_owner: ME, to_owner: STAFF, reason: `مسافر ${INJECT}`, context_note: null, state: 'pending',
          created_by: ME, created_at: at(9, 40), decided_at: null, decided_by: null, decision_note: null, cancel_cause: null },
        { id: 'b0b0b0b0-0000-4000-8000-000000000002', record_id: REC, from_owner: ME, to_owner: STAFF, reason: 'قديم', state: 'cancelled',
          cancel_cause: 'reassigned', created_by: ME, created_at: at(8, 0), decided_at: at(8, 30) },
    ] : [];
    fx.rpc.continuity_handovers_mine = { outgoing: [], incoming: incoming ? [{
        id: HO, record_id: REC2, from_owner: STAFF, to_owner: ME, reason: `تغطية ${INJECT}`, context_note: 'العميل مستعجل', state: 'pending',
        created_by: STAFF, created_at: at(9, 45),
        package: { id: REC2, kind: 'follow_up', title: `متابعة ${INJECT}`, next_action: 'اتصال', priority: 2, status: 'open',
                   due_at: '2030-01-15T09:00:00Z', due_tz: 'Africa/Cairo', overdue: false, version: 7, source_count: 3, attachment_count: 1 } }] : [] };
    return fx;
}

test('handover (081): the owner requests through a dialog — target and reason required; exactly what was chosen is sent', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openPage(hoFixtures(), { url: `/admin/continuity.html?record=${REC}` });
    await page.waitForSelector('#ctHandoverRequest');
    await page.locator('#ctHandoverRequest').click();
    await page.waitForSelector('#ctConfirm[open] #ctConfirmSelect');
    assert.deepEqual(await page.locator('#ctConfirmSelect option').evaluateAll((o) => o.map((x) => x.value)), ['', STAFF], 'the current owner is not a target');
    const ok = page.locator('#ctConfirmOk');
    await page.locator('#ctConfirmInput').fill('إجازة');
    assert.equal(await ok.isDisabled(), true, 'target required');
    await page.locator('#ctConfirmSelect').selectOption(STAFF);
    assert.equal(await ok.isDisabled(), false);
    await page.keyboard.press('Escape');
    assert.deepEqual(await rpcCalls(page, 'continuity_handover_request'), []);
    await page.locator('#ctHandoverRequest').click();
    await page.locator('#ctConfirm[open] #ctConfirmSelect').selectOption(STAFF);
    await page.locator('#ctConfirmInput').fill('  إجازة  ');
    await page.locator('#ctConfirmNote').fill('العميل مستني مكالمة');
    await ok.click();
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'continuity_handover_request'));
    const [call] = await rpcCalls(page, 'continuity_handover_request');
    assert.match(call.p_idempotency_key, /^[0-9a-f-]{36}$/);
    delete call.p_idempotency_key;
    assert.deepEqual(call, { p_record: REC, p_to_owner: STAFF, p_reason: 'إجازة', p_context_note: 'العميل مستني مكالمة', p_expected_version: 3 });
    assert.deepEqual(errors, []);
    await context.close();
});

test('handover (081): a pending request is shown as text, the owner stays responsible, and only the requester can cancel', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openPage(hoFixtures({ pending: true }), { url: `/admin/continuity.html?record=${REC}` });
    await page.waitForSelector('#ctHandoverPending');
    const banner = page.locator('#ctHandoverPending');
    assert.match(await banner.innerText(), /طلب تسليم لـ هبة سمير/);
    assert.match(await banner.innerText(), new RegExp(`مسافر ${INJECT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(await banner.innerText(), /لسه مسؤول عن السجل/);
    assert.equal(await page.locator('#ctHandover img').count(), 0);
    assert.equal(await page.locator('#ctHandoverRequest').count(), 0, 'no second request while pending');
    assert.match(await page.locator('.ct-handover-history').textContent(), /اتلغى لأن السجل اتسند مباشرة/);
    await page.locator('#ctHandoverCancel').click();
    await page.locator('#ctConfirm[open] #ctConfirmOk').click();
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'continuity_handover_cancel'));
    assert.deepEqual((await rpcCalls(page, 'continuity_handover_cancel'))[0], { p_handover: HO, p_note: null });
    assert.equal(await page.evaluate(() => window.__XSS__), undefined);
    assert.deepEqual(errors, []);
    await context.close();
});

test('handover (081): incoming requests — a package without messages; accept sends the version seen; decline needs a reason', { skip: !chromiumPath }, async () => {
    const fx = hoFixtures({ incoming: true });
    fx.rpc.continuity_handover_decide = { handover: { id: HO, state: 'accepted' }, accepted: true, replayed: false };
    const { page, context, errors } = await openPage(fx, { url: '/admin/continuity.html' });
    await page.waitForSelector('#ctHandovers:not([hidden]) [data-incoming]');
    const item = page.locator(`[data-incoming="${HO}"]`);
    assert.match(await item.innerText(), /3 رسالة مرفقة · 1 مرفق — تظهر بعد القبول/);
    assert.equal(await item.locator('h4').innerText(), `متابعة ${INJECT}`);
    assert.equal(await page.locator('#ctHandovers img').count(), 0);
    await item.locator('[data-decline]').click();
    await page.waitForSelector('#ctConfirm[open] #ctConfirmInput');
    assert.equal(await page.locator('#ctConfirmOk').isDisabled(), true, 'reason required');
    await page.keyboard.press('Escape');
    assert.deepEqual(await rpcCalls(page, 'continuity_handover_decide'), []);
    await item.locator('[data-accept]').click();
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'continuity_handover_decide'));
    assert.deepEqual((await rpcCalls(page, 'continuity_handover_decide'))[0], { p_handover: HO, p_decision: 'accept', p_note: null, p_expected_version: 7 });
    await page.waitForFunction(() => /اتقبل التسليم/.test(document.getElementById('toast').textContent));
    assert.equal(await page.evaluate(() => window.__XSS__), undefined);
    assert.deepEqual(errors, []);
    await context.close();
});

test('handover (081): off ⇒ no UI and no handover call; a non-manager viewer cannot request', { skip: !chromiumPath }, async () => {
    let { page, context, errors } = await openPage(hoFixtures({ on: false, incoming: true }), { url: `/admin/continuity.html?record=${REC}` });
    await page.waitForSelector('#ctRecordTitle');
    assert.equal(await page.locator('#ctHandover, #ctHandoverRequest').count(), 0);
    assert.equal(await page.locator('#ctHandovers').isHidden(), true);
    const called = await page.evaluate(() => (window.__RPC_ARGS__ || []).map(([n]) => n));
    assert.deepEqual(called.filter((n) => n.includes('handover')), []);
    await context.close();
    ({ page, context, errors } = await openPage(hoFixtures({ owner: STAFF }), { url: `/admin/continuity.html?record=${REC}` }));
    await page.waitForSelector('#ctRecordTitle');
    assert.equal(await page.locator('#ctHandoverRequest').count(), 0, 'someone else’s record without the assign privilege');
    await context.close();
    ({ page, context, errors } = await openPage(hoFixtures({ owner: STAFF, canAssign: true }), { url: `/admin/continuity.html?record=${REC}` }));
    await page.waitForSelector('#ctHandoverRequest');
    assert.deepEqual(errors, []);
    await context.close();
});

test('handover (081) at 390px: banner and incoming list fit', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openPage(hoFixtures({ pending: true, incoming: true }),
        { url: `/admin/continuity.html?record=${REC}`, viewport: { width: 390, height: 844 } });
    await page.waitForSelector('#ctHandoverPending');
    const m = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth - window.innerWidth,
        small: [...document.querySelectorAll('#ctHandover .btn, #ctHandovers .btn')].filter((b) => b.getBoundingClientRect().height < 44).length }));
    assert.ok(m.doc <= 0, JSON.stringify(m));
    assert.equal(m.small, 0);
    assert.deepEqual(errors, []);
    await context.close();
});
