/**
 * اختبارات مسار «إضافة مستخدم للشركة» في متصفح فعلي، ومعها الضمانة التي
 * تمنع رجوع حلقة التحويل.
 *
 * الخلل الأصلي: زر «إضافة مستخدم» في لوحة الشركة كان ينقل إلى
 * /admin/my-users.html، فيرفضه حارس الأدمن (مالك الشركة ليس طاقمًا)،
 * فيحوّله إلى login.html، فتجد الجلسة سليمة فتعيده إلى لوحة الشركة — بلا
 * نهاية. الاختبارات هنا تمرّن الوظيفة في مكانها الجديد وتثبّت أن أي تنقّل
 * إلى صفحة الدخول لم يعد يحدث لحساب جلسته قائمة.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = path.resolve(import.meta.dirname, '..');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon'
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

const USER_ID = '11111111-1111-1111-1111-111111111111';
const COMPANY_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

/** حمولة get_my_company_dashboard() المختصرة — يكفي منها ما ترسمه اللوحة. */
function companyPayload() {
    return {
        company: {
            id: COMPANY_ID, name: 'شركة النور التجارية', cr_number: '1010101010',
            cr_expiry: '2027-06-01', status: 'active', email: null, phone: null,
            address: null, city: null, country: null, website: null, industry: null,
            tax_id: null, created_at: '2026-01-01T00:00:00Z', is_owner: true
        },
        registration: { expiry_date: '2027-06-01', is_expired: false, days_to_expiry: 267 },
        subscriptions: [{
            id: 's1', plan: 'bundle', plan_name_ar: 'الباقة الشاملة', status: 'active',
            billing_cycle: 'yearly', start_date: '2026-01-01T00:00:00Z',
            end_date: '2026-12-01T00:00:00Z', is_active: true, days_remaining: 85
        }],
        entitlements: [{
            feature_key: 'sub_users', name_ar: 'المستخدمون الفرعيون',
            description: '', limits: {}, granted_by: ['bundle']
        }],
        access: { active_plans: ['bundle'], has_active_subscription: true }
    };
}

/** حمولة company_members() — can_manage تأتي محسوبة من القاعدة. */
function membersPayload({ canManage = true, members } = {}) {
    return {
        company_id: COMPANY_ID,
        is_owner: true,
        can_manage: canManage,
        members: members || [
            { id: USER_ID, name: 'مالك الشركة', email: 'owner@company.test', is_owner: true, is_me: true, created_at: '2026-01-01T00:00:00Z' }
        ]
    };
}

/**
 * الحساب المستخدَم في كل الاختبارات: رتبته super_user — وهي الرتبة الفعلية
 * لحساب الشركة الوحيد في الإنتاج، وهي بالظبط الرتبة التي كانت ترتد لصفحة
 * الدخول.
 */
function fixtures(overrides = {}) {
    return {
        user: { id: USER_ID, email: 'owner@company.test' },
        authUser: {
            id: USER_ID,
            email: 'owner@company.test',
            profile: { id: USER_ID, full_name: 'مالك الشركة', role: 'super_user' },
            ...(overrides.authUser || {})
        },
        rpc: {
            get_my_company_dashboard: companyPayload(),
            current_company_id: COMPANY_ID,
            company_members: membersPayload(overrides.members || {}),
            ...(overrides.rpc || {})
        },
        functions: overrides.functions || {},
        tables: {
            profiles: [{ id: USER_ID, email: 'owner@company.test', full_name: 'مالك الشركة', role: 'super_user' }],
            notifications: [], services: [], whatsapp_subscriptions: [], subscription_plans: [],
            ...(overrides.tables || {})
        }
    };
}

async function openPage(browser, baseUrl, fx, urlPath) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();

    const doubleSupabase = fs.readFileSync(path.join(ROOT, 'tests/fixtures/supabase-double.js'), 'utf8');
    const doubleAuth = fs.readFileSync(path.join(ROOT, 'tests/fixtures/auth-client-double.js'), 'utf8');

    await page.route('**/api-config.js', route =>
        route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: doubleSupabase }));
    await page.route('**/auth-client.js', route =>
        route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: doubleAuth }));
    await page.route('**/chat-widget.js', r => r.fulfill({ contentType: 'text/javascript', body: 'export default {};' }));
    await page.route('**/robot.js', r => r.fulfill({ contentType: 'text/javascript', body: 'export default {};' }));
    await page.route('**/ads-ticker.js', r => r.fulfill({ contentType: 'text/javascript', body: 'export default {};' }));
    await page.route('**/error-tracker.js', r => r.fulfill({ contentType: 'text/javascript', body: '' }));
    await page.route('**/chat-service.js', r => r.fulfill({ contentType: 'text/javascript', body: '' }));
    await page.route('https://fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));

    await page.addInitScript(data => { window.__FIXTURES__ = data; }, fx);

    // كل تنقّل يُسجَّل: هو الدليل المباشر على وجود/غياب حلقة التحويل
    const visited = [];
    page.on('framenavigated', frame => {
        if (frame === page.mainFrame()) visited.push(frame.url());
    });

    await page.goto(`${baseUrl}${urlPath}`, { waitUntil: 'networkidle' });
    return { page, context, visited };
}

async function openCompanyDashboard(browser, baseUrl, fx) {
    const opened = await openPage(browser, baseUrl, fx, '/company-dashboard/index.html');
    await opened.page.waitForFunction(
        () => !document.getElementById('companyContent')?.hidden
            || !!document.querySelector('#companyGateBody .state-block'),
        null, { timeout: 10000 }
    );
    return opened;
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

let browser, server, baseUrl;
const chromiumPath = resolveChromium();

if (!chromiumPath) {
    console.error('SKIP: لا يوجد متصفح Chromium متاح؛ اختبارات إضافة مستخدم الشركة لم تُنفَّذ');
}

test.before(async () => {
    if (!chromiumPath) return;
    server = await startServer();
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: chromiumPath });
});

test.after(async () => {
    await browser?.close();
    server?.close();
});

/* ── حلقة التحويل ───────────────────────────────────────────────────────── */

test('حساب الشركة يفتح لوحة شركته ولا يُرسَل لصفحة الدخول', async (t) => {
    if (!chromiumPath) return t.skip('no chromium');
    const { page, context, visited } = await openCompanyDashboard(browser, baseUrl, fixtures());

    assert.equal(await page.locator('#companyContent').isHidden(), false);
    assert.equal(visited.filter(u => u.includes('login.html')).length, 0,
        `حدث تحويل لصفحة الدخول: ${visited.join(' → ')}`);
    await context.close();
});

test('كل روابط قائمة لوحة الشركة لا تؤدي إلى /admin/ ولا إلى صفحة الدخول', async (t) => {
    if (!chromiumPath) return t.skip('no chromium');
    const { page, context } = await openCompanyDashboard(browser, baseUrl, fixtures());

    // الفحص الكامل للـSidebar: كل رابط ظاهر، لا الرابط الذي ظهر فيه الخطأ فقط
    const hrefs = await page.evaluate(() =>
        [...document.querySelectorAll('#sidebar a[href], .portal-nav a[href]')]
            .map(a => a.getAttribute('href')));

    assert.ok(hrefs.length >= 10, `عدد روابط القائمة أقل من المتوقع: ${hrefs.length}`);
    for (const href of hrefs) {
        assert.ok(!href.startsWith('/admin/'), `رابط في القائمة يؤدي للوحة الإدارة: ${href}`);
        assert.ok(!href.includes('login.html'), `رابط في القائمة يؤدي لصفحة الدخول: ${href}`);
    }
    await context.close();
});

test('صفحة بوابة العميل تفتح لحساب الشركة — الرابط الذي كان يبدأ الحلقة', async (t) => {
    if (!chromiumPath) return t.skip('no chromium');
    // ده الرابط اللي في قائمة لوحة الشركة: /customer-dashboard.html
    const { page, context, visited } = await openPage(
        browser, baseUrl, fixtures(), '/customer-dashboard.html#overview');

    await page.waitForSelector('.sidebar-item[data-tab="overview"]', { timeout: 10000 });
    assert.equal(visited.filter(u => u.includes('login.html')).length, 0,
        `حساب الشركة ارتد لصفحة الدخول: ${visited.join(' → ')}`);
    assert.equal(await page.locator('#accessDeniedPanel').count(), 0,
        'ظهرت لوحة الرفض لحساب من حقه دخول بوابته');
    await context.close();
});

test('الحساب غير المخوَّل يرى رسالة صريحة، ولا يُحوَّل لصفحة الدخول ولا يدخل حلقة', async (t) => {
    if (!chromiumPath) return t.skip('no chromium');
    // حساب طاقم على صفحة بوابة العميل: مصرَّح لكن غير مخوَّل (403 لا 401)
    const fx = fixtures({ authUser: { profile: { id: USER_ID, full_name: 'موظف', role: 'admin' } } });
    const { page, context, visited } = await openPage(browser, baseUrl, fx, '/customer-dashboard.html');

    await page.waitForSelector('#accessDeniedPanel', { timeout: 10000 });
    assert.match(await page.locator('#accessDeniedPanel').textContent(), /حسابك مسجّل دخوله بشكل صحيح/);
    assert.equal(visited.filter(u => u.includes('login.html')).length, 0,
        `الرفض تحوّل لصفحة الدخول: ${visited.join(' → ')}`);
    // المخرج موجود لكنه بفعل المستخدم فقط
    assert.equal(await page.locator('#accessDeniedHome').count(), 1);
    assert.equal(await page.locator('#accessDeniedSignOut').count(), 1);
    await context.close();
});

/* ── مسار الإضافة ───────────────────────────────────────────────────────── */

test('المخوَّل يفتح نافذة الإضافة من داخل لوحة الشركة', async (t) => {
    if (!chromiumPath) return t.skip('no chromium');
    const { page, context, visited } = await openCompanyDashboard(browser, baseUrl, fixtures());

    await page.waitForSelector('#addMemberBtn:not([hidden])', { timeout: 10000 });
    await page.locator('#addMemberBtn').click();

    assert.equal(await page.locator('#addMemberModal.active').count(), 1, 'النافذة لم تُفتح');
    // ولا تنقّل واحد: الوظيفة في مكانها
    assert.equal(visited.length, 1, `حدث تنقّل غير متوقع: ${visited.join(' → ')}`);
    await context.close();
});

test('الزر مخفي لمن لا تمنحه القاعدة can_manage', async (t) => {
    if (!chromiumPath) return t.skip('no chromium');
    const fx = fixtures({ members: { canManage: false } });
    const { page, context } = await openCompanyDashboard(browser, baseUrl, fx);

    await page.waitForSelector('#companyMembersPanel:not([hidden])', { timeout: 10000 });
    assert.equal(await page.locator('#addMemberBtn').isHidden(), true, 'زر الإضافة ظهر بلا صلاحية');
    await context.close();
});

test('غياب can_manage يمنع الإنشاء فعليًا — لا مجرد إخفاء الزر', async (t) => {
    if (!chromiumPath) return t.skip('no chromium');
    // الواجهة ليست مصدر الثقة: بنفتح النافذة برمجيًا (زي ما يقدر أي أحد يعمل
    // من الـconsole) ونتأكد إن الطلب أصلًا ما اتبعتش.
    const fx = fixtures({ members: { canManage: false } });
    const { page, context } = await openCompanyDashboard(browser, baseUrl, fx);

    await page.waitForSelector('#companyMembersPanel:not([hidden])', { timeout: 10000 });
    await page.evaluate(() => {
        document.getElementById('addMemberModal').classList.add('active');
        document.getElementById('addMemberBtn').hidden = false;
    });

    await page.fill('#fMemberName', 'مستخدم جديد');
    await page.fill('#fMemberEmail', 'new@company.test');
    await page.fill('#fMemberPassword', 'Passw0rdX');
    await page.fill('#fMemberPasswordConfirm', 'Passw0rdX');
    await page.locator('#submitMemberBtn').click();

    await page.waitForSelector('#addMemberError:not([hidden])', { timeout: 10000 });
    assert.match(await page.locator('#addMemberError').textContent(), /غير مخوَّل/);

    const invocations = await page.evaluate(() => window.__INVOCATIONS__ || []);
    assert.deepEqual(invocations, [], 'الطلب أُرسل رغم غياب الصلاحية');
    await context.close();
});

test('لو أُظهر الزر يدويًا بلا صلاحية، النافذة تفتح بتحذير ظاهر لا برسالة ممسوحة', async (t) => {
    if (!chromiumPath) return t.skip('no chromium');
    const fx = fixtures({ members: { canManage: false } });
    const { page, context } = await openCompanyDashboard(browser, baseUrl, fx);

    await page.waitForSelector('#companyMembersPanel:not([hidden])', { timeout: 10000 });
    await page.evaluate(() => { document.getElementById('addMemberBtn').hidden = false; });
    await page.locator('#addMemberBtn').click();

    // openMemberModal بيمسح الأخطاء، فترتيب الفتح/التحذير مهم — لو اتعكس
    // المستخدم هيشوف نموذجًا عاديًا ثم يُرفض عند الإرسال بلا سبب مسبق.
    assert.equal(await page.locator('#addMemberModal.active').count(), 1);
    assert.equal(await page.locator('#addMemberError').isHidden(), false, 'التحذير اتمسح بعد الفتح');
    assert.match(await page.locator('#addMemberError').textContent(), /غير مخوَّل/);
    await context.close();
});

test('التحقق يمنع الإرسال ويشرح كل حقل', async (t) => {
    if (!chromiumPath) return t.skip('no chromium');
    const { page, context } = await openCompanyDashboard(browser, baseUrl, fixtures());

    await page.waitForSelector('#addMemberBtn:not([hidden])', { timeout: 10000 });
    await page.locator('#addMemberBtn').click();
    await page.fill('#fMemberEmail', 'not-an-email');
    await page.fill('#fMemberPassword', 'weak');
    await page.locator('#submitMemberBtn').click();

    assert.equal(await page.locator('[data-member-error-for="fullName"]').isHidden(), false);
    assert.equal(await page.locator('[data-member-error-for="email"]').isHidden(), false);
    assert.equal(await page.locator('[data-member-error-for="password"]').isHidden(), false);
    assert.equal(await page.locator('#addMemberModal.active').count(), 1, 'النافذة أُغلقت رغم الخطأ');
    assert.deepEqual(await page.evaluate(() => window.__INVOCATIONS__ || []), [],
        'أُرسل طلب رغم فشل التحقق');
    await context.close();
});

test('الإنشاء الناجح: الطلب بعقد create-sub-user، ثم القائمة تتحدّث', async (t) => {
    if (!chromiumPath) return t.skip('no chromium');
    const fx = fixtures({
        functions: { 'create-sub-user': { data: { success: true, user: { id: 'new-1', email: 'new@company.test', full_name: 'مستخدم جديد' } } } }
    });
    const { page, context, visited } = await openCompanyDashboard(browser, baseUrl, fx);

    await page.waitForSelector('#addMemberBtn:not([hidden])', { timeout: 10000 });
    await page.locator('#addMemberBtn').click();
    await page.fill('#fMemberName', 'مستخدم جديد');
    await page.fill('#fMemberEmail', '  New@Company.TEST  ');
    await page.fill('#fMemberPassword', 'Passw0rdX');
    await page.fill('#fMemberPasswordConfirm', 'Passw0rdX');

    // بعد النجاح القائمة تُقرأ من جديد، فنجهّز القاعدة بالعضو الجديد
    await page.evaluate(() => {
        window.__FIXTURES__.rpc.company_members = {
            ...window.__FIXTURES__.rpc.company_members,
            members: [
                ...window.__FIXTURES__.rpc.company_members.members,
                { id: 'new-1', name: 'مستخدم جديد', email: 'new@company.test', is_owner: false, is_me: false, created_at: '2026-09-09T00:00:00Z' }
            ]
        };
    });

    await page.locator('#submitMemberBtn').click();
    await page.waitForFunction(
        () => !document.getElementById('addMemberModal').classList.contains('active'),
        null, { timeout: 10000 }
    );

    const calls = await page.evaluate(() => window.__INVOCATIONS__ || []);
    assert.equal(calls.length, 1, 'عدد الطلبات غير متوقع');
    assert.equal(calls[0].name, 'create-sub-user');
    // العقد الفعلي للدالة: full_name (snake_case) وبريد منظّف
    assert.deepEqual(Object.keys(calls[0].body).sort(), ['email', 'full_name', 'password']);
    assert.equal(calls[0].body.email, 'new@company.test');
    assert.equal(calls[0].body.full_name, 'مستخدم جديد');

    // النتيجة ظاهرة في اللوحة
    await page.waitForFunction(
        () => document.getElementById('companyMembers')?.textContent.includes('new@company.test'),
        null, { timeout: 10000 }
    );
    assert.match(await page.locator('#companyMembers').textContent(), /مستخدم جديد/);
    assert.equal(visited.length, 1, `حدث تنقّل بعد الإنشاء: ${visited.join(' → ')}`);
    await context.close();
});

test('فشل الإنشاء يعرض رسالة الخادم كما هي، وبلا أي تحويل', async (t) => {
    if (!chromiumPath) return t.skip('no chromium');
    const fx = fixtures({
        functions: { 'create-sub-user': { error: 'A user with this email address has already been registered', status: 400 } }
    });
    const { page, context, visited } = await openCompanyDashboard(browser, baseUrl, fx);

    await page.waitForSelector('#addMemberBtn:not([hidden])', { timeout: 10000 });
    await page.locator('#addMemberBtn').click();
    await page.fill('#fMemberName', 'مستخدم مكرر');
    await page.fill('#fMemberEmail', 'owner@company.test');
    await page.fill('#fMemberPassword', 'Passw0rdX');
    await page.fill('#fMemberPasswordConfirm', 'Passw0rdX');
    await page.locator('#submitMemberBtn').click();

    await page.waitForSelector('#addMemberError:not([hidden])', { timeout: 10000 });
    assert.match(await page.locator('#addMemberError').textContent(), /already been registered/);

    // النافذة تفضل مفتوحة عشان يصحّح، والزر رجع لحالته
    assert.equal(await page.locator('#addMemberModal.active').count(), 1);
    assert.equal(await page.locator('#submitMemberBtn').isDisabled(), false);
    assert.equal(await page.locator('#submitMemberBtn').textContent(), 'إنشاء المستخدم');
    assert.equal(visited.filter(u => u.includes('login.html')).length, 0,
        `فشل الإنشاء حوّل المستخدم لصفحة الدخول: ${visited.join(' → ')}`);
    await context.close();
});

test('رفض 403 من الدالة يظهر كخطأ مفهوم لا كصفحة دخول', async (t) => {
    if (!chromiumPath) return t.skip('no chromium');
    const fx = fixtures({
        functions: { 'create-sub-user': { error: 'Insufficient permissions', status: 403 } }
    });
    const { page, context, visited } = await openCompanyDashboard(browser, baseUrl, fx);

    await page.waitForSelector('#addMemberBtn:not([hidden])', { timeout: 10000 });
    await page.locator('#addMemberBtn').click();
    await page.fill('#fMemberName', 'مستخدم جديد');
    await page.fill('#fMemberEmail', 'new@company.test');
    await page.fill('#fMemberPassword', 'Passw0rdX');
    await page.fill('#fMemberPasswordConfirm', 'Passw0rdX');
    await page.locator('#submitMemberBtn').click();

    await page.waitForSelector('#addMemberError:not([hidden])', { timeout: 10000 });
    assert.match(await page.locator('#addMemberError').textContent(), /Insufficient permissions/);
    assert.equal(visited.filter(u => u.includes('login.html')).length, 0);
    await context.close();
});
