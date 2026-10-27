/**
 * صفحات لوحة المالك المستقلة (/owner/*.html) — تشغيل حقيقي في Chromium مقابل البديل الاختباري.
 *
 * يثبت:
 *   ① القائمة: عناصر «الإدارة» و«التشغيل» تقود إلى /owner/ لا /admin/، والعنصر النشط من اسم الملف
 *   ② البوابة: غير المالك، أو المالك خارج سياقه، يرى السبب ولا تُنادى أي دالة بيانات
 *   ③ كل صفحة تُرسم بلا أخطاء وبلا تمرير أفقي على الجوال
 *   ④ العمليات تنادي القاعدة بالمعاملات الصحيحة، ورفض القاعدة (صفر صفوف أو 42501) يظهر خطأً لا «تم»
 *   ⑤ ما يكتبه غير المالك (ردود، حمولة السجل) يُعرض نصًا لا HTML
 * والقرار نفسه في القاعدة — مقيس في tests/sql/owner-pages-authority.test.sql.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import {
    banPatch, subscriptionActions, subscriptionChangeError, accountActions, searchTerm, pageRange, pagerText,
    SUBSCRIPTION_TRANSITIONS, UNBAN_PATCH
} from '../assets/js/owner/owner-labels.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
function startServer() {
    const server = http.createServer((req, res) => {
        const urlPath = decodeURIComponent(req.url.split('?')[0]);
        const filePath = path.join(ROOT, urlPath === '/' ? '/index.html' : urlPath);
        if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
        fs.createReadStream(filePath).pipe(res);
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}
function resolveChromium() {
    try { const p = chromium.executablePath(); if (p && fs.existsSync(p)) return p; } catch { /* none */ }
    const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
    if (root && fs.existsSync(root)) {
        for (const dir of fs.readdirSync(root).filter(d => d.startsWith('chromium')).sort().reverse()) {
            for (const rel of ['chrome-linux/chrome', 'chrome-linux/headless_shell', 'chrome']) {
                const c = path.join(root, dir, rel);
                if (fs.existsSync(c)) return c;
            }
        }
    }
    return null;
}

const OWNER = '11111111-1111-4111-8111-111111111111';
const ADMIN = '44444444-4444-4444-8444-444444444444';
const SUPPORT = '55555555-5555-4555-8555-555555555555';
const CUSTOMER = '66666666-6666-4666-8666-666666666666';
const XSS = '<img src=x onerror="window.__XSS__=1">';

function fixtures({ context = 'owner', owner = true } = {}) {
    const future = new Date(Date.now() + 20 * 864e5).toISOString();
    return {
        returnUpdatedRows: true,
        user: { id: OWNER, email: 'owner@example.com' },
        authUser: { id: OWNER, email: 'owner@example.com', profile: { id: OWNER, full_name: 'مالك المنصة', role: 'platform_owner', ban_status: 'none' } },
        rpc: {
            owner_context_status: { is_platform_owner: owner, active_context: context, preview_mode: false, expires_at: '2099-01-01T00:00:00Z' },
            available_contexts: [{ key: 'owner', granted: true, destination: '/owner-dashboard.html' }],
            owner_security_status: { mfa_enrolled: true, step_up_fresh: false, step_up_expires_at: null, in_owner_context: true },
            admin_list_subscriptions: [
                { id: 's-active', user_id: CUSTOMER, customer_name: 'عميل أ', customer_email: 'a@x.test', company_name: 'شركة أ', plan: 'support',
                  plan_name_ar: 'الدعم', status: 'active', billing_cycle: 'monthly', end_date: future, is_active: true, days_remaining: 5 },
                { id: 's-pending', user_id: ADMIN, customer_name: 'عميل ب', customer_email: 'b@x.test', plan: 'whatsapp',
                  plan_name_ar: 'واتساب', status: 'pending', billing_cycle: 'monthly', end_date: null, is_active: false, days_remaining: 0 },
                { id: 's-expired', user_id: SUPPORT, customer_name: 'عميل ج', plan: 'support', plan_name_ar: 'الدعم', status: 'expired',
                  billing_cycle: 'yearly', end_date: '2026-01-01T00:00:00Z', is_active: false, days_remaining: 0 }
            ],
            admin_subscription_audit: [{ action: 'deactivate', actor_email: 'admin@example.com', old_values: { status: 'active' },
                                         new_values: { status: 'expired' }, reason: XSS, created_at: '2026-10-01T00:00:00Z' }],
            admin_set_subscription_status: { subscription_id: 's-active' },
            admin_customer_filter_options: { companies: [{ id: 'c1', name: 'شركة أ' }, { id: 'c2', name: 'شركة ب' }] },
            get_public_registration_settings: { mode: 'waitlist', expected_launch_date: '2026-12-01' },
            owner_feature_switches: [{ key: 'company_isolation_enforced', enabled: false }, { key: 'company_documents_enabled', enabled: true }],
            owner_set_passcode: { ok: true },
            owner_set_passcode_active: { ok: true }
        },
        tables: {
            profiles: [
                { id: OWNER, email: 'owner@example.com', full_name: 'مالك المنصة', role: 'platform_owner', ban_status: 'none', created_at: '2026-01-01T00:00:00Z' },
                { id: ADMIN, email: 'admin@example.com', full_name: 'إداري', role: 'admin', ban_status: 'none', created_at: '2026-02-01T00:00:00Z' },
                { id: SUPPORT, email: 'support@example.com', full_name: 'دعم', role: 'support', ban_status: 'none', is_locked: true, created_at: '2026-03-01T00:00:00Z' },
                { id: CUSTOMER, email: 'customer@example.com', full_name: 'عميل أ', role: 'user', ban_status: 'none', phone: '01000000000', created_at: '2026-04-01T00:00:00Z' }
            ],
            tickets: [
                { id: 't1', ticket_number: 101, title: 'مشكلة في الدفع', status: 'open', priority: 'high', scope: 'mad3oom_support', user_id: CUSTOMER,
                  assigned_to: null, created_at: '2026-10-20T10:00:00Z', description: 'وصف', sla_resolution_due_at: '2026-10-21T10:00:00Z' },
                { id: 't2', ticket_number: 102, title: 'استفسار شركة', status: 'in-progress', priority: 'medium', scope: 'company', company_id: 'c1',
                  user_id: CUSTOMER, assigned_to: SUPPORT, created_at: '2026-10-21T10:00:00Z', description: 'وصف 2' }
            ],
            ticket_replies: [
                { id: 'r1', ticket_id: 't1', user_id: CUSTOMER, message: XSS, created_at: '2026-10-20T11:00:00Z', is_internal: false },
                { id: 'r2', ticket_id: 't1', user_id: SUPPORT, message: 'ملاحظة للفريق', created_at: '2026-10-20T12:00:00Z', is_internal: true }
            ],
            activity_logs: [
                { id: 'a1', user_id: CUSTOMER, user_role: 'user', action: 'login', details: { note: XSS }, created_at: '2026-10-22T10:00:00Z', device_info: 'Chrome' },
                { id: 'a2', user_id: ADMIN, user_role: 'admin', action: 'ban_user', details: {}, created_at: '2026-10-22T09:00:00Z' }
            ],
            whatsapp_subscriptions: [{ id: 's-active', user_id: CUSTOMER, plan: 'support', status: 'active', billing_cycle: 'monthly', end_date: future }],
            api_tokens: [
                { id: 'k1', user_id: CUSTOMER, name: 'مفتاح الموقع', is_active: true, revoked_at: null, usage_count: 12, credential_type: 'api_key',
                  secret_last_four: 'abcd', created_at: '2026-09-01T00:00:00Z', last_used_at: '2026-10-25T00:00:00Z' },
                { id: 'k2', user_id: ADMIN, name: 'مفتاح موقوف', is_active: false, revoked_at: '2026-10-01T00:00:00Z', usage_count: 0, created_at: '2026-09-01T00:00:00Z' }
            ],
            external_integrations: [
                { id: 'i1', owner_scope: 'platform', provider: 'openai', display_name: 'OpenAI', protocol: 'openai', is_active: true,
                  last_tested_at: '2026-10-20T00:00:00Z', last_test_status: 'failed', priority: 1 }
            ],
            api_token_usage_logs: [{ id: 'u1', token_id: 'k1', user_id: CUSTOMER, endpoint: '/mcp', method: 'POST', status_code: 200, created_at: '2026-10-25T00:00:00Z' }],
            access_passcodes: [{ id: 'p1', label: 'فريق الدعم', is_active: true, created_at: '2026-09-01T00:00:00Z', passcode_redemptions: [{ user_id: CUSTOMER }] }],
            blog_posts: [{ id: 'b1', slug: 'hello', title: 'مقال أول', status: 'published', tags: [], view_count: 3, author_name: 'مدعوم',
                           published_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', created_at: '2026-10-01T00:00:00Z' }],
            blog_categories: [],
            notifications: [],
            owner_context_audit: []
        }
    };
}

async function openPage(browser, baseUrl, file, fx, { width = 1440, confirm = true, query = '' } = {}) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    const page = await context.newPage();
    const dbl = fs.readFileSync(path.join(ROOT, 'tests/fixtures/supabase-double.js'), 'utf8');
    const auth = fs.readFileSync(path.join(ROOT, 'tests/fixtures/auth-client-double.js'), 'utf8');
    await page.route('**/api-config.js', r => r.fulfill({ contentType: 'text/javascript', body: dbl }));
    await page.route('**/auth-client.js', r => r.fulfill({ contentType: 'text/javascript', body: auth }));
    await page.route('**/error-tracker.js', r => r.fulfill({ contentType: 'text/javascript', body: '' }));
    await page.route('https://fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
    await page.addInitScript(d => { window.__FIXTURES__ = d; }, fx);
    const dialogs = [];
    page.on('dialog', d => { dialogs.push(d.message()); confirm ? d.accept() : d.dismiss(); });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${baseUrl}/owner/${file}.html${query}`, { waitUntil: 'networkidle' });
    return { page, context, errors, dialogs };
}
const rpcCalls = (page, name) => page.evaluate(n => (window.__RPC_ARGS__ || []).filter(([x]) => x === n).map(([, a]) => a), name);
const writes = (page, table) => page.evaluate(t => (window.__WRITES__ || []).filter(w => w.table === t), table);
const noHorizontalScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

const PAGES = {
    stats: '#statsKpis .kpi',
    users: '#usersTable table',
    tickets: '#ticketsTable table',
    subscriptions: '#subsTable table',
    blog: '#blogRows tr',
    activity: '#activityTable table',
    integrations: '#tokensTable table',
    passcodes: '#passcodesTable table',
    settings: '#settingsSwitches table'
};

const chromiumPath = resolveChromium();
let server, baseUrl, browser;
test.before(async () => {
    if (!chromiumPath) return;
    server = await startServer();
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: chromiumPath });
});
test.after(async () => { await browser?.close(); server?.close(); });

/* ── الأجزاء الخالصة ─────────────────────────────────────────────────────── */

test('انتقالات الاشتراك نسخة من شرط admin_set_subscription_status()', () => {
    assert.deepEqual(subscriptionActions('active').map(a => a.to), ['expired']);
    assert.deepEqual(subscriptionActions('expired').map(a => a.to), ['active']);
    assert.deepEqual(subscriptionActions('pending').map(a => a.to), ['active', 'rejected']);
    assert.deepEqual(subscriptionActions('rejected'), []);
    assert.deepEqual(subscriptionActions('superseded'), []);
    assert.deepEqual(Object.keys(SUBSCRIPTION_TRANSITIONS).sort(), ['active', 'expired', 'pending']);
    const now = new Date('2026-10-27T00:00:00Z');
    assert.match(subscriptionChangeError({ to: 'expired', reason: 'قص' }, now), /سببًا/);
    assert.equal(subscriptionChangeError({ to: 'expired', reason: 'انتهى الدفع' }, now), null);
    assert.match(subscriptionChangeError({ to: 'active', reason: 'تم الدفع', endDate: '2026-10-01' }, now), /المستقبل/);
    assert.equal(subscriptionChangeError({ to: 'active', reason: 'تم الدفع', endDate: '2026-11-30' }, now), null);
});

test('قرار الحظر: السبب إلزامي، والمؤقت بتاريخ مستقبلي، ورفعه يعيد none', () => {
    const now = new Date('2026-10-27T00:00:00Z');
    assert.ok(banPatch({ kind: 'temporary', until: '2026-11-01', reason: 'قص' }, now).error);
    assert.ok(banPatch({ kind: 'temporary', until: '2026-10-01', reason: 'إساءة استخدام' }, now).error);
    assert.deepEqual(banPatch({ kind: 'temporary', until: '2026-11-01T00:00:00Z', reason: 'إساءة استخدام' }, now).patch,
        { ban_status: 'temporary', ban_until: '2026-11-01T00:00:00.000Z', ban_reason: 'إساءة استخدام' });
    assert.deepEqual(banPatch({ kind: 'permanent', reason: 'احتيال مثبت' }, now).patch,
        { ban_status: 'permanent', ban_until: null, ban_reason: 'احتيال مثبت' });
    assert.ok(banPatch({ kind: 'x', reason: 'سبب كافٍ' }, now).error);
    assert.deepEqual({ ...UNBAN_PATCH }, { ban_status: 'none', ban_until: null, ban_reason: null });
});

test('ما يستطيعه المالك على حساب: لا نفسه ولا مالك المنصة، والطاقم بتحقق بخطوتين', () => {
    assert.equal(accountActions({ id: OWNER, role: 'platform_owner' }, { selfId: OWNER }).canRestrict, false);
    assert.equal(accountActions({ id: 'x', role: 'platform_owner' }, { selfId: OWNER }).canRestrict, false);
    assert.deepEqual(accountActions({ id: 'x', role: 'admin' }, { selfId: OWNER }), { canRestrict: true, needsStepUp: true });
    assert.deepEqual(accountActions({ id: 'x', role: 'support' }, { selfId: OWNER }), { canRestrict: true, needsStepUp: true });
    assert.deepEqual(accountActions({ id: 'x', role: 'user' }, { selfId: OWNER }), { canRestrict: true, needsStepUp: false });
});

test('البحث لا يكسر مرشّح PostgREST، والترقيم شامل الحدّين', () => {
    assert.equal(searchTerm('a,b(c)*%d'), 'a b c d');
    assert.equal(searchTerm('name:"x" or'), 'name x or');
    assert.equal(searchTerm('a.b@x.com'), 'a.b@x.com');
    assert.equal(searchTerm('x'.repeat(300)).length, 100);
    assert.deepEqual(pageRange(0, 25), [0, 24]);
    assert.deepEqual(pageRange(2, 25), [50, 74]);
    assert.match(pagerText(1, 25, 60), /٢٦–٥٠ من ٦٠|26–50 من 60/);
});

/* ── القائمة ───────────────────────────────────────────────────────────── */

test('قائمة المالك: «الإدارة» و«التشغيل» صفحات /owner/ بقشرة المالك، لا روابط /admin/', () => {
    const html = fs.readFileSync(path.join(ROOT, 'assets/components/owner-sidebar.html'), 'utf8');
    const items = [...html.matchAll(/<a href="([^"]+)" class="sidebar-item"([^>]*)>/g)].map(m => [m[1], m[2]]);
    assert.ok(!items.some(([href]) => href.startsWith('/admin/')), 'عنصر في قائمة المالك يقود إلى /admin/');
    const pages = items.filter(([href]) => href.startsWith('/owner/')).map(([href, attrs]) => [href, /data-page="([^"]+)"/.exec(attrs)?.[1]]);
    assert.deepEqual(pages.map(([h]) => h), Object.keys(PAGES).map(p => `/owner/${p}.html`).sort((a, b) =>
        ['stats', 'users', 'tickets', 'subscriptions', 'blog', 'activity', 'integrations', 'passcodes', 'settings']
            .indexOf(a.slice(7, -5)) - ['stats', 'users', 'tickets', 'subscriptions', 'blog', 'activity', 'integrations', 'passcodes', 'settings'].indexOf(b.slice(7, -5))));
    for (const [href, dataPage] of pages) {
        assert.equal(`/owner/${dataPage}.html`, href, `data-page لا يطابق الملف: ${href}`);
        assert.ok(fs.existsSync(path.join(ROOT, href)), `الصفحة غير موجودة: ${href}`);
        assert.ok(fs.existsSync(path.join(ROOT, `assets/js/owner/pages/${dataPage}.js`)), `وحدة الصفحة غير موجودة: ${dataPage}`);
    }
});

/* ── البوابة ───────────────────────────────────────────────────────────── */

test('غير المالك والمالك خارج سياقه: رسالة السبب ولا نداء بيانات', { skip: !chromiumPath }, async () => {
    for (const [fx, reason] of [[fixtures({ owner: false, context: null }), /لمالك المنصة وحده/],
                                [fixtures({ context: 'admin' }), /خارج واجهة مالك المنصة/]]) {
        const { page, context, errors } = await openPage(browser, baseUrl, 'subscriptions', fx);
        await page.waitForSelector('#ownerGate:not([hidden])');
        assert.match(await page.textContent('#ownerGate'), reason);
        assert.equal(await page.isHidden('#ownerContent'), true);
        assert.deepEqual(await rpcCalls(page, 'admin_list_subscriptions'), []);
        assert.deepEqual(errors, []);
        await context.close();
    }
});

/* ── كل صفحة ───────────────────────────────────────────────────────────── */

for (const [file, ready] of Object.entries(PAGES)) {
    test(`${file}: تُرسم بلا أخطاء، والعنصر النشط في القائمة، وبلا تمرير أفقي على الجوال`, { skip: !chromiumPath }, async () => {
        for (const width of [1440, 390]) {
            const { page, context, errors } = await openPage(browser, baseUrl, file, fixtures(), { width });
            await page.waitForSelector(ready, { timeout: 10000 });
            await page.waitForSelector(`.sidebar-item.active[data-page="${file}"]`, { state: 'attached' });
            assert.equal(await page.getAttribute(`.sidebar-item[data-page="${file}"]`, 'aria-current'), 'page');
            assert.equal(await page.isHidden('#ownerGate'), true);
            assert.ok(await noHorizontalScroll(page), `${file} @${width}: تمرير أفقي`);
            assert.deepEqual(errors, [], `${file} @${width}`);
            await context.close();
        }
    });
}

/* ── العمليات ──────────────────────────────────────────────────────────── */

test('المستخدمون: حظر عميل مؤقتًا يكتب أعمدة الحظر الحقيقية وأثرًا في السجل', { skip: !chromiumPath }, async () => {
    const { page, context, dialogs } = await openPage(browser, baseUrl, 'users', fixtures());
    await page.waitForSelector(`[data-user="${CUSTOMER}"]`);
    await page.click(`[data-user="${CUSTOMER}"]`);
    await page.waitForSelector('#banForm');
    await page.fill('#banReason', 'قص');
    await page.click('#banForm button[type=submit]');
    assert.match(await page.textContent('#accountStatus'), /5 أحرف/);
    assert.deepEqual(await writes(page, 'profiles'), []);

    const until = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 16);
    await page.fill('#banUntil', until);
    await page.fill('#banReason', 'إساءة استخدام متكررة');
    await page.click('#banForm button[type=submit]');
    await page.waitForSelector('.owner-modal', { state: 'detached' });
    const [w] = await writes(page, 'profiles');
    assert.equal(w.op, 'update');
    assert.equal(w.row.ban_status, 'temporary');
    assert.equal(w.row.ban_reason, 'إساءة استخدام متكررة');
    assert.ok(new Date(w.row.ban_until) > new Date());
    assert.ok(!('status' in w.row), 'العمود status غير موجود في profiles');
    const [log] = await writes(page, 'activity_logs');
    assert.equal(log.row.action, 'ban_user');
    assert.equal(log.row.details.target_user_id, CUSTOMER);
    assert.ok(dialogs.some(m => /حظر/.test(m)));
    assert.match(await page.textContent('#pageStatus'), /تم حظر الحساب/);
    await context.close();
});

test('المستخدمون: حساب المالك بلا إجراءات، وحساب الطاقم مقفل حتى التحقق بخطوتين', { skip: !chromiumPath }, async () => {
    const { page, context } = await openPage(browser, baseUrl, 'users', fixtures());
    await page.waitForSelector(`[data-user="${OWNER}"]`);
    await page.click(`[data-user="${OWNER}"]`);
    await page.waitForSelector('#accountActions .state-block');
    assert.match(await page.textContent('#accountActions'), /حسابك بنفسك/);
    assert.equal(await page.locator('#banForm').count(), 0);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.owner-modal', { state: 'detached' });

    await page.click(`[data-user="${SUPPORT}"]`);
    await page.waitForSelector('#banForm');
    assert.equal(await page.isDisabled('#banForm button[type=submit]'), true);
    assert.equal(await page.isDisabled('[data-act="unlock"]'), true);
    assert.match(await page.textContent('#accountActions'), /تحققًا بخطوتين/);
    await context.close();
});

test('المستخدمون: رفض حارس القاعدة (42501) يظهر برسالته، والنافذة تبقى', { skip: !chromiumPath }, async () => {
    const fx = fixtures();
    fx.rpc.owner_security_status = { mfa_enrolled: true, step_up_fresh: true, step_up_expires_at: '2099-01-01T00:00:00Z' };
    fx.writeErrors = { profiles: 'حظر حسابات فريق المنصة وقفلها لمالك المنصة وحده بعد التحقق بخطوتين' };
    const { page, context } = await openPage(browser, baseUrl, 'users', fx);
    await page.waitForSelector(`[data-user="${SUPPORT}"]`);
    await page.click(`[data-user="${SUPPORT}"]`);
    await page.waitForSelector('[data-act="unlock"]:not([disabled])');
    await page.click('[data-act="unlock"]');
    await page.waitForSelector('#accountStatus:not([hidden])');
    assert.match(await page.textContent('#accountStatus'), /لمالك المنصة وحده بعد التحقق بخطوتين/);
    assert.equal(await page.locator('.owner-modal').count(), 1);
    assert.deepEqual(await writes(page, 'activity_logs'), []);
    await context.close();
});

test('التذاكر: المحادثة نصّ لا HTML، وتغيير الحالة والمسؤول يُرسل الحقول المتغيرة مع الفاعل', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openPage(browser, baseUrl, 'tickets', fixtures());
    await page.waitForSelector('[data-ticket="t1"]');
    assert.match(await page.textContent('#ticketsTable'), /شركة: شركة أ/);
    await page.click('[data-ticket="t1"]');
    await page.waitForSelector('#ticketForm');
    assert.equal(await page.evaluate(() => window.__XSS__), undefined);
    assert.match(await page.textContent('.owner-thread'), /<img src=x/);
    assert.match(await page.textContent('.owner-thread'), /ملاحظة داخلية/);

    await page.click('#ticketForm button[type=submit]');
    assert.match(await page.textContent('#ticketStatus'), /لا تغيير/);
    await page.selectOption('#tStatus', 'in-progress');
    await page.selectOption('#tAssignee', SUPPORT);
    await page.click('#ticketForm button[type=submit]');
    await page.waitForSelector('.owner-modal', { state: 'detached' });
    const [w] = await writes(page, 'tickets');
    assert.deepEqual(Object.keys(w.row).sort(), ['assigned_to', 'last_updated_at', 'last_updated_by', 'status']);
    assert.equal(w.row.status, 'in-progress');
    assert.equal(w.row.assigned_to, SUPPORT);
    assert.equal(w.row.last_updated_by, OWNER);
    assert.deepEqual(errors, []);
    await context.close();
});

test('التذاكر: رفض RLS بصفر صفوف لا يقول «تم»', { skip: !chromiumPath }, async () => {
    const fx = fixtures();
    fx.updateDenied = ['tickets'];
    const { page, context } = await openPage(browser, baseUrl, 'tickets', fx, { query: '?ticket=t1' });
    await page.waitForSelector('#ticketForm');
    await page.selectOption('#tPriority', 'low');
    await page.click('#ticketForm button[type=submit]');
    await page.waitForSelector('#ticketStatus:not([hidden])');
    await page.waitForFunction(() => !/جارٍ/.test(document.querySelector('#ticketStatus').textContent));
    assert.match(await page.textContent('#ticketStatus'), /لم يُحفظ/);
    assert.equal(await page.locator('.owner-modal').count(), 1);
    await context.close();
});

test('الاشتراكات: أزرار الانتقالات المسموحة وحدها، والسبب إلزامي، والنداء بمعاملات الدالة', { skip: !chromiumPath }, async () => {
    const { page, context } = await openPage(browser, baseUrl, 'subscriptions', fixtures());
    await page.waitForSelector('[data-sub="s-active"]');
    assert.deepEqual(await page.$$eval('[data-sub="s-active"]', b => b.map(x => x.dataset.to)), ['expired']);
    assert.deepEqual(await page.$$eval('[data-sub="s-pending"]', b => b.map(x => x.dataset.to)), ['active', 'rejected']);
    assert.deepEqual(await page.$$eval('[data-sub="s-expired"]', b => b.map(x => x.dataset.to)), ['active']);

    await page.click('[data-sub="s-active"][data-to="expired"]');
    await page.waitForSelector('#subForm');
    await page.click('#subForm button[type=submit]');
    assert.match(await page.textContent('#subStatus'), /سببًا/);
    assert.deepEqual(await rpcCalls(page, 'admin_set_subscription_status'), []);
    await page.fill('#subReason', 'لم يُستكمل الدفع');
    await page.click('#subForm button[type=submit]');
    await page.waitForSelector('.owner-modal', { state: 'detached' });
    assert.deepEqual(await rpcCalls(page, 'admin_set_subscription_status'),
        [{ p_subscription_id: 's-active', p_status: 'expired', p_reason: 'لم يُستكمل الدفع', p_end_date: null }]);

    // التصفية «تنتهي خلال 7 أيام»
    await page.selectOption('#subsStatus', 'expiring');
    assert.equal(await page.locator('#subsTable tbody tr').count(), 1);

    // السجل: السبب الذي كتبه غيره نصّ
    await page.selectOption('#subsStatus', '');
    await page.click('[data-audit="s-active"]');
    await page.waitForSelector('.owner-modal table');
    assert.equal(await page.evaluate(() => window.__XSS__), undefined);
    await context.close();
});

test('الاشتراكات: رفض الدالة يظهر برسالتها', { skip: !chromiumPath }, async () => {
    const fx = fixtures();
    fx.rpcErrors = { admin_set_subscription_status: { code: '42501', message: 'هذه العملية متاحة للإدارة فقط' } };
    const { page, context } = await openPage(browser, baseUrl, 'subscriptions', fx);
    await page.waitForSelector('[data-sub="s-pending"][data-to="rejected"]');
    await page.click('[data-sub="s-pending"][data-to="rejected"]');
    await page.fill('#subReason', 'بيانات الدفع ناقصة');
    await page.click('#subForm button[type=submit]');
    await page.waitForFunction(() => /للإدارة فقط/.test(document.querySelector('#subStatus')?.textContent || ''));
    assert.equal(await page.locator('.owner-modal').count(), 1);
    await context.close();
});

test('سجل النشاط: الحمولة نصّ لا HTML، والتصفية بالحدث تُرسل للخادم', { skip: !chromiumPath }, async () => {
    const { page, context } = await openPage(browser, baseUrl, 'activity', fixtures());
    await page.waitForSelector('#activityTable table');
    await page.click('#activityTable details summary');
    assert.equal(await page.evaluate(() => window.__XSS__), undefined);
    assert.match(await page.textContent('#activityTable .owner-json'), /<img src=x/);
    assert.deepEqual(await page.$$eval('#activityAction option', o => o.map(x => x.value)), ['', 'ban_user', 'login']);
    await page.selectOption('#activityAction', 'login');
    await page.waitForFunction(() => document.querySelectorAll('#activityTable tbody tr').length === 1);
    await context.close();
});

test('التكاملات: إيقاف مفتاح يكتب is_active و revoked_at وحدهما، وتعطيل تكامل المنصة', { skip: !chromiumPath }, async () => {
    const { page, context, dialogs } = await openPage(browser, baseUrl, 'integrations', fixtures());
    await page.waitForSelector('[data-token="k1"]');
    assert.match(await page.textContent('#integrationsKpis'), /آخر اختبار فاشل\s*[1١]/);
    await page.click('[data-token="k1"]');
    await page.waitForFunction(() => (window.__WRITES__ || []).some(w => w.table === 'api_tokens'));
    const [w] = await writes(page, 'api_tokens');
    assert.deepEqual(Object.keys(w.row).sort(), ['is_active', 'revoked_at']);
    assert.equal(w.row.is_active, false);
    assert.ok(dialogs.some(m => /يفقد الوصول فورًا/.test(m)));

    await page.click('[data-integration="i1"]');
    await page.waitForFunction(() => (window.__WRITES__ || []).some(w => w.table === 'external_integrations'));
    assert.deepEqual((await writes(page, 'external_integrations'))[0].row, { is_active: false });
    await context.close();
});

test('أكواد المرور: الكود القصير لا يُرسل، والإنشاء والتعطيل عبر دوال المالك', { skip: !chromiumPath }, async () => {
    const { page, context } = await openPage(browser, baseUrl, 'passcodes', fixtures());
    await page.waitForSelector('[data-code="p1"]');
    await page.fill('#passcodeCode', '123');
    await page.click('#passcodeCreate');
    assert.deepEqual(await rpcCalls(page, 'owner_set_passcode'), []);
    await page.fill('#passcodeCode', 'MAD3OOM-2026');
    await page.fill('#passcodeLabel', 'فريق المبيعات');
    await page.click('#passcodeCreate');
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'owner_set_passcode'));
    assert.deepEqual(await rpcCalls(page, 'owner_set_passcode'), [{ p_code: 'MAD3OOM-2026', p_label: 'فريق المبيعات' }]);
    await page.click('[data-code="p1"]');
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'owner_set_passcode_active'));
    assert.deepEqual(await rpcCalls(page, 'owner_set_passcode_active'), [{ p_id: 'p1', p_active: false }]);
    await context.close();
});

test('الإعدادات: وضع التسجيل والمفاتيح والأمان من القاعدة، وإعدادات الإدارة مسمّاة بسببها', { skip: !chromiumPath }, async () => {
    const { page, context } = await openPage(browser, baseUrl, 'settings', fixtures());
    await page.waitForSelector('#settingsSecurity dl');
    assert.match(await page.textContent('#settingsRegistration'), /قائمة انتظار/);
    assert.match(await page.textContent('#settingsSwitches'), /عزل بيانات الشركات/);
    assert.match(await page.textContent('#settingsAdminOnly'), /advanced_settings/);
    assert.match(await page.textContent('#settingsSecurity'), /مفعّل/);
    await context.close();
});

test('المدوّنة: نفس مساحة التحرير المشتركة تعمل بقشرة المالك', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openPage(browser, baseUrl, 'blog', fixtures());
    await page.waitForSelector('#blogWorkspace:not([hidden])');
    await page.waitForSelector('#blogRows tr');
    assert.match(await page.textContent('#blogRows'), /مقال أول/);
    await page.click('#newPostBtn');
    await page.waitForSelector('#postModal.active');
    assert.equal(await page.inputValue('#fAuthorName'), 'مالك المنصة');
    assert.deepEqual(errors, []);
    await context.close();
});
