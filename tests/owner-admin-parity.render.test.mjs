/**
 * مالك المنصة داخل لوحة الإدارة (117) — صفحات الإدارة الحقيقية في Chromium مقابل البديل الاختباري.
 *
 * كانت الصفحات تقرر «هل هو إداري؟» بمقارنة profile.role بـ 'admin' (أو بالبريد support@)، فتعامل المالك —
 * رتبته platform_owner — كمستخدم عادي رغم أن الحارس فتح له اللوحة. الآن تسأل القاعدة (platform-authority.js):
 *   ① المالك في سياق الإدارة: مراجعة المكافآت، تجميد المحافظ حين تسمح can_manage_central_wallet، الدخول كعضو
 *   ② الأدمن كما هو، والمالك بلا is_admin() (خارج سياقه) لا يرى ما لا تعطيه القاعدة
 *   ③ الحظر من صفحة المستخدمين يكتب أعمدة الحظر الحقيقية (كان يكتب عمود status غير الموجود)
 *   ④ الأدمن الرئيسي (super-users) = has_elevated_authority لا بريد support@
 * والقرار نفسه في القاعدة — tests/sql/owner-admin-parity.test.sql.
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

/** who: 'owner' | 'admin'. authority: ما تعيده مُسنَدات القاعدة لهذه الجلسة. */
function fixtures(who, { isAdmin = true, isStaff = true, elevated = false, wallet = false, walletRpc = 'present', context = 'admin' } = {}) {
    const owner = who === 'owner';
    const id = owner ? OWNER : ADMIN;
    const role = owner ? 'platform_owner' : 'admin';
    const email = owner ? 'owner@example.com' : 'admin@example.com';
    const rpc = {
        is_admin: isAdmin, is_platform_staff: isStaff, has_elevated_authority: elevated,
        is_platform_owner: owner, active_context: owner ? context : null,
        owner_context_status: { is_platform_owner: owner, active_context: owner ? context : null },
        available_contexts: [], my_account_gate: { status: 'active' },
        can_manage_central_wallet: wallet,
        manage_user_points: { success: true, message: 'تم' }, is_sie_admin: false,
        admin_customer_filter_options: { companies: [], managers: [] }, admin_customer_directory: { total: 0, rows: [] }
    };
    const fx = {
        returnUpdatedRows: true,
        user: { id, email },
        authUser: { id, email, profile: { id, full_name: owner ? 'المالك' : 'الأدمن', role, ban_status: 'none' },
                    activeContext: owner ? context : null },
        rpc,
        tables: {
            profiles: [
                { id: OWNER, email: 'owner@example.com', full_name: 'المالك', role: 'platform_owner', ban_status: 'none', created_at: '2026-01-01T00:00:00Z' },
                { id: ADMIN, email: 'admin@example.com', full_name: 'الأدمن', role: 'admin', ban_status: 'none', created_at: '2026-01-02T00:00:00Z' },
                { id: CUSTOMER, email: 'customer@example.com', full_name: 'عميل', role: 'user', ban_status: 'none', created_at: '2026-01-03T00:00:00Z' },
                { id: 'b1', email: 'banned@example.com', full_name: 'محظور', role: 'user', ban_status: 'permanent', ban_until: null, created_at: '2026-01-04T00:00:00Z' }
            ],
            user_wallets: [{ user_id: CUSTOMER, is_frozen: false }],
            user_reports: [], reward_activity_logs: [], notifications: [], activity_logs: []
        }
    };
    if (walletRpc === 'missing') fx.rpcErrors = { can_manage_central_wallet: { code: 'PGRST202', message: 'not found' } };
    return fx;
}

async function openAdmin(browser, baseUrl, file, fx, { confirm = true, prompt = null } = {}) {
    const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    const page = await context.newPage();
    const dbl = fs.readFileSync(path.join(ROOT, 'tests/fixtures/supabase-double.js'), 'utf8');
    const auth = fs.readFileSync(path.join(ROOT, 'tests/fixtures/auth-client-double.js'), 'utf8');
    await page.route('**/api-config.js', r => r.fulfill({ contentType: 'text/javascript', body: dbl }));
    await page.route('**/auth-client.js', r => r.fulfill({ contentType: 'text/javascript', body: auth }));
    await page.route('**/error-tracker.js', r => r.fulfill({ contentType: 'text/javascript', body: '' }));
    await page.route('https://**/*', r => r.fulfill({ contentType: 'text/css', body: '' }));
    await page.addInitScript(d => { window.__FIXTURES__ = d; }, fx);
    const dialogs = [];
    page.on('dialog', d => {
        dialogs.push(d.message());
        if (d.type() === 'prompt') return prompt === null ? d.dismiss() : d.accept(prompt);
        return confirm ? d.accept() : d.dismiss();
    });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${baseUrl}/admin/${file}`, { waitUntil: 'networkidle' });
    return { page, context, dialogs, errors };
}
const writes = (page, table) => page.evaluate(t => (window.__WRITES__ || []).filter(w => w.table === t), table);

const chromiumPath = resolveChromium();
let server, baseUrl, browser;
test.before(async () => {
    if (!chromiumPath) return;
    server = await startServer();
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: chromiumPath });
});
test.after(async () => { await browser?.close(); server?.close(); });

test('① المكافآت: المالك في سياق الإدارة يراجع البلاغات (is_admin) — كانت الصفحة ترفضه لرتبته', { skip: !chromiumPath }, async () => {
    const { page, context } = await openAdmin(browser, baseUrl, 'rewards.html', fixtures('owner'));
    await page.waitForTimeout(800);
    assert.doesNotMatch(await page.textContent('#rewardsMainArea'), /متاحة للأدمن فقط/);
    await context.close();

    // المالك بلا is_admin() (مثلًا سياق انتهى قبل إعادة التحميل): الصفحة لا تعرض ما سترفضه القاعدة
    const denied = await openAdmin(browser, baseUrl, 'rewards.html', fixtures('owner', { isAdmin: false }));
    await denied.page.waitForTimeout(800);
    assert.match(await denied.page.textContent('#rewardsMainArea'), /متاحة للأدمن فقط/);
    await denied.context.close();
});

/** مركز المستخدمين: يفتح قائمة «خيارات» للعضو ويعيد أسماء إجراءاتها (data-action). */
async function menuActions(page, userId) {
    await page.waitForSelector(`.uh-options-btn[data-user-id="${userId}"]`);
    await page.click(`.uh-options-btn[data-user-id="${userId}"]`);
    await page.waitForSelector('#uhMenu:not([hidden])');
    return page.$$eval('#uhMenu .opt-menu-item', els => els.map(e => e.dataset.action));
}

test('① المستخدمون: تجميد المحفظة يتبع can_manage_central_wallet لا بريد support@', { skip: !chromiumPath }, async () => {
    for (const [fx, expected, label] of [
        [fixtures('owner', { wallet: true, context: 'owner' }), true, 'المالك في سياق owner'],
        [fixtures('owner', { wallet: false }), false, 'المالك في سياق admin'],
        [fixtures('admin', { wallet: false }), false, 'أدمن عادي'],
        [fixtures('admin', { walletRpc: 'missing' }), false, 'قبل 117: أدمن ليس support@']
    ]) {
        const { page, context, errors } = await openAdmin(browser, baseUrl, 'users.html', fx);
        assert.equal((await menuActions(page, CUSTOMER)).includes('freeze'), expected, label);
        assert.deepEqual(errors, [], label);
        await context.close();
    }
});

test('③ المستخدمون: الحظر ورفعه يكتبان أعمدة الحظر الحقيقية، والرتب بلا super_user', { skip: !chromiumPath }, async () => {
    const { page, context, dialogs } = await openAdmin(browser, baseUrl, 'users.html', fixtures('owner'), { prompt: 'إساءة استخدام متكررة' });
    const actions = await menuActions(page, CUSTOMER);
    assert.ok(!actions.some(a => /super/i.test(a)), 'super_user ليست رتبة في القاعدة: ' + actions);
    await page.click('#uhMenu .opt-menu-item[data-action="ban"]');
    await page.waitForFunction(() => (window.__WRITES__ || []).some(w => w.table === 'profiles'));
    const [ban] = await writes(page, 'profiles');
    assert.deepEqual(ban.row, { ban_status: 'permanent', ban_until: null, ban_reason: 'إساءة استخدام متكررة' });
    assert.ok(dialogs.some(m => /سبب الحظر/.test(m)));

    await menuActions(page, 'b1');
    await page.click('#uhMenu .opt-menu-item[data-action="unban"]');
    await page.waitForFunction(() => (window.__WRITES__ || []).filter(w => w.table === 'profiles').length >= 2);
    const unban = (await writes(page, 'profiles'))[1];
    assert.deepEqual(unban.row, { ban_status: 'none', ban_until: null, ban_reason: null });
    await context.close();
});

test('① الدخول كعضو: المالك في سياق الإدارة يُسمح له (نفس canImpersonate في auth-client)', { skip: !chromiumPath }, async () => {
    for (const fx of [fixtures('owner', { context: 'admin' }), fixtures('admin')]) {
        const { page, context } = await openAdmin(browser, baseUrl, 'users.html', fx);
        await menuActions(page, CUSTOMER);
        await page.click('#uhMenu .opt-menu-item[data-action="view"]');
        await page.waitForFunction(() => (window.__IMPERSONATED__ || []).length > 0);
        assert.equal((await page.evaluate(() => window.__IMPERSONATED__))[0].userId, CUSTOMER);
        await context.close();
    }
});

test('④ الأدمن الرئيسي: has_elevated_authority لا بريد support@', { skip: !chromiumPath }, async () => {
    const ok = await openAdmin(browser, baseUrl, 'super-users.html', fixtures('owner', { elevated: true, context: 'owner' }));
    await ok.page.waitForTimeout(600);
    assert.ok(!ok.dialogs.some(m => /للأدمن الرئيسي فقط/.test(m)), 'المالك المرتفع رُفض');
    assert.match(ok.page.url(), /super-users\.html/);
    await ok.context.close();

    const no = await openAdmin(browser, baseUrl, 'super-users.html', fixtures('admin', { elevated: false }));
    await no.page.waitForFunction(() => !/super-users/.test(location.pathname)).catch(() => {});
    assert.ok(no.dialogs.some(m => /للأدمن الرئيسي فقط/.test(m)), 'أدمن غير مرتفع لم يُرفض: '+ JSON.stringify(no.dialogs));
    await no.context.close();
});
