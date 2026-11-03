/**
 * 121 — مركز الأمان والصلاحيات والتحقق حسب السياق، في Chromium مقابل بديل Supabase.
 *
 *   ① نافذة التحقق تظهر لحظة الإجراء المحمي (لا نموذج ثابت)، ترفض الرمز القصير، وبعد التحقق يكتمل الإجراء نفسه؛
 *      Escape يلغي ولا يُنفَّذ شيء
 *   ② مركز الأمان: المؤشرات والتنبيهات من القاعدة، النص غير الموثوق مهرَّب، التبويبات تحمّل عند فتحها، والسياسة
 *      بحدود القاعدة
 *   ③ مصفوفة الصلاحيات: الخانة ترسل قرارًا واحدًا، ورفض القاعدة يعيد الخانة لحالتها الحقيقية
 *   ④ صفحة الموافقة: الرمز من الجزء بعد # يُمسح من العنوان، والرفض يرسله كما هو
 *   ⑤ الرد على التذكرة من لوحة المالك بنفس addTicketReply، وتعديل وضع التسجيل من إعدادات المالك
 *   ⑥ شارة جلسة التحرير في قشرة المالك
 * القرار نفسه في القاعدة — tests/sql/owner-security-center.test.sql.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

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
const CUSTOMER = '66666666-6666-4666-8666-666666666666';
const REQ = '6f1d2c3b-4a59-4b6c-8d7e-9f0a1b2c3d4e';
const XSS = '<img src=x onerror="window.__XSS__=1">';

function fixtures({ fresh = false } = {}) {
    const status = {
        mfa_enrolled: true, step_up_fresh: fresh, step_up_expires_at: fresh ? '2099-01-01T00:10:00Z' : null, step_up_minutes: 15,
        recovery_codes_left: 6, in_owner_context: true,
        policy: { step_up_minutes: 15, password_change_locked: true, email_change_locked: true, login_alerts: true,
                  shared_ip_window_days: 30, failed_login_threshold: 5, updated_at: '2026-11-01T00:00:00Z' }
    };
    return {
        user: { id: OWNER, email: 'owner@example.com' },
        authUser: { id: OWNER, email: 'owner@example.com', activeContext: 'owner',
                    profile: { id: OWNER, full_name: 'مالك المنصة', role: 'platform_owner', ban_status: 'none' } },
        rpc: {
            owner_context_status: { is_platform_owner: true, active_context: 'owner', preview_mode: false, expires_at: '2099-01-01T00:00:00Z' },
            available_contexts: [{ key: 'owner', granted: true, destination: '/owner-dashboard.html' }],
            is_platform_owner: true, my_account_gate: { status: 'active' },
            owner_security_status: status,
            owner_security_overview: { days: 7, logins: 12, failed_logins: 2, unique_ips: 5, shared_ips: 1, denied: 3, warnings: 1,
                pending_account_changes: 1, active_sessions: 9, owner_sessions: 2,
                recent_alerts: [{ id: 1, at: '2026-11-02T00:00:00Z', event_type: 'auth.failed_burst', severity: 'critical', target_email: XSS,
                                  details: { failures: 5, window_minutes: 15 } }] },
            owner_account_change_list: [{ id: REQ, kind: 'password', status: 'pending', requested_at: '2026-11-02T00:00:00Z',
                expires_at: '2099-01-01T00:00:00Z', ip: '192.0.2.66', user_agent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0', alert_sent: true }],
            owner_security_log: { total: 2, items: [
                { id: 10, at: '2026-11-02T10:00:00Z', event_type: 'auth.login', severity: 'info', target_email: 'pu@example.com', ip: '198.51.100.7',
                  user_agent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Version/17.5 Mobile Safari/604.1', details: { new_ip: true }, source: 'db', city: 'Cairo', country: 'Egypt' },
                { id: 11, at: '2026-11-02T09:00:00Z', event_type: 'auth.login_failed', severity: 'notice', target_email: XSS, ip: '203.0.113.5',
                  user_agent: null, details: { reason: 'invalid_credentials' }, source: 'client_report' }] },
            owner_ip_correlation: { days: 30, items: [{ ip: '198.51.100.7', accounts: 2, logins: 3, first_seen: '2026-11-01T00:00:00Z', last_seen: '2026-11-02T00:00:00Z',
                account_list: [{ user_id: CUSTOMER, email: 'pu@example.com' }, { user_id: ADMIN, email: XSS }],
                timeline: [{ at: '2026-11-02T00:00:00Z', email: 'pu@example.com', user_agent: 'Firefox/131' }] }] },
            owner_list_sessions: { ok: true, items: [
                { id: 'aaaaaaaa-0000-4000-8000-000000000001', current: true, ip: '192.0.2.10', user_agent: 'Mozilla/5.0 (Macintosh) Firefox/131.0', created_at: '2026-11-02T00:00:00Z' },
                { id: 'aaaaaaaa-0000-4000-8000-000000000002', current: false, ip: '192.0.2.99', user_agent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0', created_at: '2026-11-01T00:00:00Z' }] },
            owner_step_up_history: [{ id: 3, method: 'totp', started_at: '2026-11-02T00:00:00Z', expires_at: '2026-11-02T00:15:00Z', ended_at: null,
                end_reason: 'expired', active: false, ip: '192.0.2.10', user_agent: 'Firefox/131', operations: 1,
                audit_actions: [{ at: '2026-11-02T00:01:00Z', action: 'security_policy.set' }], security_actions: [] }],
            owner_change_history: { total: 1, items: [{ id: 7, at: '2026-11-02T00:01:00Z', actor_email: 'owner@example.com', table_name: 'advanced_settings',
                row_key: 'x', op: 'UPDATE', old_row: { value: 'a' }, new_row: { value: 'b' }, reversible: true }] },
            owner_permission_matrix: { ok: true, permissions: [
                { key: 'settings.manage', category: 'platform', label: 'تعديل إعدادات التشغيل', description: XSS, enforced_on: 'RLS: advanced_settings',
                  owner_step_up: true, admin: true, support: true },
                { key: 'tickets.reply', category: 'support', label: 'الرد على التذاكر', description: 'رد', enforced_on: 'RLS: ticket_replies',
                  owner_step_up: false, admin: true, support: false }] },
            owner_set_role_permission: { ok: true },
            owner_set_security_policy: { ok: true },
            owner_global_logout: { ok: true, revoked: 1 },
            owner_rollback_change: { ok: true },
            owner_reject_account_change: { ok: true, sessions_revoked: 2 },
            get_public_registration_settings: { mode: 'waitlist', expected_launch_date: '2026-12-01' },
            owner_feature_switches: [],
            admin_customer_filter_options: { companies: [] }
        },
        tables: {
            profiles: [
                { id: OWNER, email: 'owner@example.com', full_name: 'مالك المنصة', role: 'platform_owner' },
                { id: ADMIN, email: 'admin@example.com', full_name: 'إداري', role: 'admin' },
                { id: CUSTOMER, email: 'pu@example.com', full_name: 'عميل', role: 'user' }
            ],
            advanced_settings: [{ id: 'adv1', key: 'registration_mode', value: { mode: 'waitlist', waitlist_message: 'قريبًا', expected_launch_date: '2026-12-01' } }],
            tickets: [{ id: 't1', ticket_number: 101, title: 'مشكلة', status: 'open', priority: 'high', scope: 'mad3oom_support', user_id: CUSTOMER,
                        created_at: '2026-10-20T10:00:00Z', description: 'وصف' }],
            ticket_replies: [], notifications: [], owner_context_audit: [], activity_logs: []
        }
    };
}

async function open(browser, baseUrl, url, fx, { width = 1440, confirm = true } = {}) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    const page = await context.newPage();
    const dbl = fs.readFileSync(path.join(ROOT, 'tests/fixtures/supabase-double.js'), 'utf8');
    const auth = fs.readFileSync(path.join(ROOT, 'tests/fixtures/auth-client-double.js'), 'utf8');
    await page.route('**/api-config.js', r => r.fulfill({ contentType: 'text/javascript', body: dbl }));
    await page.route('**/auth-client.js', r => r.fulfill({ contentType: 'text/javascript', body: auth }));
    await page.route('**/error-tracker.js', r => r.fulfill({ contentType: 'text/javascript', body: '' }));
    await page.route('https://**/*', r => r.fulfill({ contentType: 'text/css', body: '' }));
    await page.addInitScript(d => { window.__FIXTURES__ = d; }, fx);
    const dialogs = [];
    page.on('dialog', d => { dialogs.push(d.message()); confirm ? d.accept() : d.dismiss(); });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${baseUrl}${url}`, { waitUntil: 'networkidle' });
    return { page, context, errors, dialogs };
}
const rpcArgs = (page, name) => page.evaluate(n => (window.__RPC_ARGS__ || []).filter(([x]) => x === n).map(([, a]) => a), name);
const writes = (page, table) => page.evaluate(t => (window.__WRITES__ || []).filter(w => w.table === t), table);
const tab = (page, name) => page.click(`#secTab-${name}`);

const chromiumPath = resolveChromium();
let server, baseUrl, browser;
test.before(async () => {
    if (!chromiumPath) return;
    server = await startServer();
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: chromiumPath });
});
test.after(async () => { await browser?.close(); server?.close(); });

test('① النافذة تظهر لحظة الإجراء المحمي، وبعد التحقق يكتمل الإجراء نفسه', { skip: !chromiumPath }, async () => {
    const { page, context, errors, dialogs } = await open(browser, baseUrl, '/owner/security.html#sessions', fixtures());
    await page.waitForSelector('#secMySessions table');
    assert.equal(await page.locator('.stepup-dialog').count(), 0, 'لا نافذة قبل الإجراء');
    assert.equal(await page.locator('form#stepUpForm, #stepUpCode').count(), 0, 'لا نموذج تحقق ثابت');

    await page.click('#secLogoutOthers');
    await page.waitForSelector('.stepup-dialog');
    assert.match(await page.textContent('#stepUpReason'), /إخراج كل أجهزتي الأخرى/);
    await page.waitForFunction(() => /15 دقيقة/.test(document.querySelector('#stepUpDesc').textContent), null, { timeout: 5000 });
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'stepUpModalCode', 'التركيز في حقل الرمز');

    await page.fill('#stepUpModalCode', '12');
    await page.click('#stepUpModalSubmit');
    assert.match(await page.textContent('#stepUpModalError'), /ستة أرقام/);
    assert.deepEqual(await rpcArgs(page, 'owner_step_up'), [], 'الرمز القصير لا يُرسل');

    // القاعدة تقبل الرمز وتفتح الجلسة
    await page.evaluate(() => {
        window.__FIXTURES__.rpc.owner_step_up = { verified: true, method: 'totp', expires_at: '2099-01-01T00:15:00Z', minutes: 15 };
        Object.assign(window.__FIXTURES__.rpc.owner_security_status, { step_up_fresh: true, step_up_expires_at: '2099-01-01T00:15:00Z' });
    });
    await page.fill('#stepUpModalCode', '123456');
    await page.click('#stepUpModalSubmit');
    await page.waitForSelector('.stepup-dialog', { state: 'detached' });
    assert.deepEqual(await rpcArgs(page, 'owner_step_up'), [{ p_code: '123456' }]);
    assert.equal(await page.inputValue('#stepUpModalCode').catch(() => ''), '', 'الرمز لا يبقى في الصفحة');
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'owner_global_logout'));
    assert.deepEqual(await rpcArgs(page, 'owner_global_logout'), [{ p_user: OWNER }], 'الإجراء الأصلي اكتمل بعد التحقق');
    assert.ok(dialogs.some(m => /أجهزتك الأخرى/.test(m)));
    assert.deepEqual(errors, []);
    await context.close();
});

test('① Escape يلغي النافذة ولا يُنفَّذ الإجراء، ورمز الاسترداد بديل', { skip: !chromiumPath }, async () => {
    const { page, context } = await open(browser, baseUrl, '/owner/security.html#sessions', fixtures());
    await page.waitForSelector('#secMySessions table');
    await page.click('#secLogoutOthers');
    await page.waitForSelector('.stepup-dialog');
    await page.click('#stepUpModalMode');
    assert.match(await page.textContent('#stepUpModalLabel'), /رمز استرداد/);
    assert.equal(await page.getAttribute('#stepUpModalCode', 'maxlength'), '20');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.stepup-dialog', { state: 'detached' });
    await page.waitForTimeout(200);
    assert.deepEqual(await rpcArgs(page, 'owner_global_logout'), []);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'secLogoutOthers', 'التركيز يعود للزر');
    await context.close();
});

test('② مركز الأمان: مؤشرات من القاعدة، نص مهرَّب، تبويبات تحمّل عند فتحها، وسياسة بحدود القاعدة', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await open(browser, baseUrl, '/owner/security.html', fixtures());
    await page.waitForSelector('#secKpis .kpi');
    assert.match(await page.textContent('#secKpis'), /[1١][2٢]/);
    assert.match(await page.textContent('#secAlerts'), /تكرار محاولات فاشلة/);
    assert.match(await page.textContent('#secAlerts'), /<img src=x/, 'البريد غير الموثوق نصّ');
    assert.match(await page.textContent('#secAccountChanges'), /بانتظار قرارك/);
    assert.deepEqual(await rpcArgs(page, 'owner_security_log'), [], 'سجل الدخول لا يُحمَّل قبل فتح تبويبه');

    await tab(page, 'activity');
    await page.waitForSelector('#secLog table');
    const log = await page.textContent('#secLog');
    assert.match(log, /Safari 17 · iOS 17.5/); assert.match(log, /Cairo/); assert.match(log, /أبلغ عنه المتصفح/);
    await page.fill('#secEmail', 'pu@example.com');
    await page.click('#secFilters button[type=submit]');
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).filter(([n]) => n === 'owner_security_log').length >= 2);
    const last = (await rpcArgs(page, 'owner_security_log')).at(-1);
    assert.equal(last.p_email, 'pu@example.com'); assert.equal(last.p_offset, 0);

    await tab(page, 'shared');
    await page.waitForSelector('.owner-sec-ip');
    assert.match(await page.textContent('#secShared'), /2 حسابات|٢ حسابات/);
    assert.match(await page.textContent('#secShared'), /<img src=x/);

    await tab(page, 'changes');
    await page.waitForSelector('[data-rollback="7"]');
    await page.evaluate(() => { window.__FIXTURES__.rpc.owner_security_status.step_up_fresh = true; window.__FIXTURES__.rpc.owner_security_status.step_up_expires_at = '2099-01-01T00:00:00Z'; });
    await page.click('[data-rollback="7"]');
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'owner_rollback_change'));
    assert.deepEqual(await rpcArgs(page, 'owner_rollback_change'), [{ p_change: 7 }]);

    await tab(page, 'policy');
    await page.waitForFunction(() => document.querySelector('input[name="minutes"][value="15"]')?.checked);
    await page.check('input[name="minutes"][value="custom"]');
    await page.fill('#secCustomMinutes', '0');
    await page.click('#secPolicySave');
    assert.match(await page.textContent('#secPolicyError'), /1 و240/);
    assert.deepEqual(await rpcArgs(page, 'owner_set_security_policy'), []);
    await page.fill('#secCustomMinutes', '20');
    await page.click('#secPolicySave');
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'owner_set_security_policy'));
    assert.deepEqual((await rpcArgs(page, 'owner_set_security_policy'))[0], { p_policy: {
        step_up_minutes: 20, password_change_locked: true, email_change_locked: true, login_alerts: true, shared_ip_window_days: 30, failed_login_threshold: 5 } });
    assert.equal(await page.evaluate(() => window.__XSS__), undefined);
    assert.deepEqual(errors, []);
    await context.close();
});

test('② مركز الأمان بلا تمرير أفقي على الجوال', { skip: !chromiumPath }, async () => {
    const { page, context } = await open(browser, baseUrl, '/owner/security.html', fixtures(), { width: 390 });
    await page.waitForSelector('#secKpis .kpi');
    for (const name of ['activity', 'shared', 'sessions', 'policy']) {
        await tab(page, name);
        await page.waitForTimeout(250);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), name);
    }
    await context.close();
});

test('③ المصفوفة: قرار واحد لكل خانة، ورفض القاعدة يعيد الخانة لحالتها', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await open(browser, baseUrl, '/owner/permissions.html', fixtures());
    await page.waitForSelector('#permMatrix table');
    assert.match(await page.textContent('#permMatrix'), /<img src=x/);
    const supportReply = 'input[data-perm="tickets.reply"][data-role="support"]';
    assert.equal(await page.isChecked(supportReply), false);
    await page.click(supportReply);   // الصفحة تعيد الرسم من القاعدة بعد الحفظ (هنا من البديل الثابت)
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'owner_set_role_permission'));
    assert.deepEqual((await rpcArgs(page, 'owner_set_role_permission'))[0],
        { p_role: 'support', p_permission: 'tickets.reply', p_field: 'allowed', p_value: true });

    await page.evaluate(() => { window.__FIXTURES__.rpc.owner_set_role_permission = { ok: false, error: 'step_up_required' }; });
    const ownerSettings = 'input[data-perm="settings.manage"][data-role="platform_owner"]';
    await page.waitForSelector(ownerSettings);
    assert.equal(await page.isChecked(ownerSettings), true);
    await page.click(ownerSettings);
    await page.waitForFunction((sel) => document.querySelector(sel)?.checked === true && !document.querySelector(sel).disabled, ownerSettings);
    assert.match(await page.textContent('#pageToast'), /لم يكتمل التحقق/);
    assert.deepEqual(errors, []);
    await context.close();
});

test('④ صفحة الموافقة: الرمز يُمسح من العنوان، والرفض يرسله كما هو', { skip: !chromiumPath }, async () => {
    const bad = await open(browser, baseUrl, '/owner/security-approval.html?r=nope&a=reject#t=x', fixtures());
    await bad.page.waitForSelector('.owner-stepup-state');
    assert.match(await bad.page.textContent('#approvalBody'), /رابط غير صالح/);
    await bad.context.close();

    const { page, context, errors } = await open(browser, baseUrl, `/owner/security-approval.html?r=${REQ}&a=reject#t=tok-123`, fixtures());
    await page.waitForSelector('#approvalReject');
    assert.equal(await page.evaluate(() => location.hash), '', 'الرمز لا يبقى في شريط العنوان');
    await page.click('#approvalReject');
    await page.waitForSelector('.owner-stepup-state--ok');
    assert.deepEqual(await rpcArgs(page, 'owner_reject_account_change'), [{ p_request: REQ, p_token: 'tok-123' }]);
    assert.match(await page.textContent('#approvalBody'), /رُفض التغيير/);
    assert.deepEqual(errors, []);
    await context.close();

    const fx = fixtures();
    fx.user = null;
    const anon = await open(browser, baseUrl, `/owner/security-approval.html?r=${REQ}&a=approve#t=tok-9`, fx);
    await anon.page.waitForSelector('#approvalBody a[href^="/login.html"]');
    assert.equal(await anon.page.evaluate(() => sessionStorage.getItem(`owner-approval:${'6f1d2c3b-4a59-4b6c-8d7e-9f0a1b2c3d4e'}:approve`)), 'tok-9',
        'الرمز محفوظ لهذه النافذة حتى تسجيل الدخول');
    await anon.context.close();
});

test('⑤ الرد على التذكرة من لوحة المالك، وتعديل وضع التسجيل من إعداداته', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await open(browser, baseUrl, '/owner/tickets.html?ticket=t1', fixtures());
    await page.waitForSelector('#replyForm');
    await page.click('#replyForm button[type=submit]');
    assert.match(await page.textContent('#replyStatus'), /اكتب نص الرد/);
    await page.fill('#replyText', 'تمت معالجة طلبك');
    await page.click('#replyForm button[type=submit]');
    await page.waitForFunction(() => (window.__WRITES__ || []).some(w => w.table === 'ticket_replies'));
    const [reply] = await writes(page, 'ticket_replies');
    assert.deepEqual({ ...reply.row }, { ticket_id: 't1', user_id: OWNER, message: 'تمت معالجة طلبك', is_internal: false });
    assert.deepEqual(errors, []);
    await context.close();

    const s = await open(browser, baseUrl, '/owner/settings.html', fixtures());
    await s.page.waitForSelector('#regForm');
    await s.page.selectOption('#regMode', 'open');
    await s.page.click('#regForm button[type=submit]');
    await s.page.waitForFunction(() => (window.__WRITES__ || []).some(w => w.table === 'advanced_settings'));
    const [w] = await writes(s.page, 'advanced_settings');
    assert.equal(w.op, 'update');
    assert.equal(w.row.value.mode, 'open');
    assert.equal(w.row.value.waitlist_message, 'قريبًا', 'بقية القيمة محفوظة');
    assert.deepEqual(s.errors, []);
    await s.context.close();
});

test('⑥ شارة جلسة التحرير: مقفلة، ومفتوحة بعدّ تنازلي', { skip: !chromiumPath }, async () => {
    const locked = await open(browser, baseUrl, '/owner/permissions.html', fixtures());
    await locked.page.waitForSelector('.stepup-chip[data-state="locked"]');
    assert.match(await locked.page.textContent('.stepup-chip'), /مقفلة/);
    await locked.context.close();
    const fresh = await open(browser, baseUrl, '/owner/permissions.html', fixtures({ fresh: true }));
    await fresh.page.waitForSelector('.stepup-chip[data-state="open"]');
    assert.match(await fresh.page.textContent('.stepup-chip-time'), /^\d{2,}:\d{2}$/);
    await fresh.context.close();
});
