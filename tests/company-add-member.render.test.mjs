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
const CUSTOMER_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_CUSTOMER_ID = '99999999-9999-4999-8999-999999999999';

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
            // مالك الشركة + عميلان تابعان له + عميل شركة أخرى (لا يجب أن يُرى)
            profiles: [
                { id: USER_ID, email: 'owner@company.test', full_name: 'مالك الشركة', role: 'super_user', super_user_id: null },
                { id: CUSTOMER_ID, email: 'cust1@company.test', full_name: 'عميل الشركة', role: 'customer', super_user_id: USER_ID },
                { id: OTHER_CUSTOMER_ID, email: 'other@rival.test', full_name: 'عميل شركة أخرى', role: 'customer', super_user_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }
            ],
            tickets: [
                { id: 'tk-platform', user_id: USER_ID, ticket_number: 101, title: 'مشكلة في الفوترة', description: 'الشركة ← مدعوم', status: 'open', created_at: '2026-09-01T00:00:00Z', archived_by_customer: false },
                { id: 'tk-customer', user_id: CUSTOMER_ID, ticket_number: 202, title: 'طلب من عميلي', description: 'العميل ← الشركة', status: 'open', created_at: '2026-09-02T00:00:00Z', archived_by_customer: false }
            ],
            ticket_replies: [],
            api_tokens: [
                { id: 'key-1', user_id: USER_ID, name: 'مفتاح التكامل', api_key: 'pk_live_company', secret_last_four: '4821', is_active: true, created_at: '2026-08-01T00:00:00Z', last_used_at: '2026-09-08T00:00:00Z', usage_count: 42, revoked_at: null, expires_at: null, scopes: ['tickets:read'] },
                { id: 'key-2', user_id: CUSTOMER_ID, name: 'مفتاح العميل', api_key: 'pk_live_member', secret_last_four: '9930', is_active: false, created_at: '2026-08-05T00:00:00Z', last_used_at: null, usage_count: 0, revoked_at: null, expires_at: null, scopes: [] }
            ],
            api_token_usage_logs: [
                { id: 'u1', created_at: '2026-09-08T10:00:00Z', endpoint: '/v1/tickets', method: 'get', status_code: 200, token_id: 'key-1', user_id: USER_ID }
            ],
            activity_log: [
                { id: 'act1', action: 'login', created_at: '2026-09-08T09:00:00Z', user_id: USER_ID, metadata: {} }
            ],
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

/**
 * الصفحات التي غادرها المستخدم فعلًا.
 * تغيّر الـhash داخل /company-dashboard/ تنقّل بين أقسام، لا مغادرة —
 * والقاعدة المطلوبة هي ألا تغادر لوحة الشركة نفسها.
 */
function departures(visited, from = '/company-dashboard/') {
    return visited
        .map(u => new URL(u).pathname)
        .filter(pathname => !pathname.startsWith(from));
}

/** يفتح قسمًا من قائمة لوحة الشركة كما يفعل المستخدم تمامًا. */
async function openSection(page, tab) {
    await page.locator(`.sidebar-item[data-tab="${tab}"]`).click();
    await page.waitForSelector(`#${tab}TabContent.active`, { timeout: 10000 });
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

    await openSection(page, 'members');
    await page.waitForSelector('#addMemberBtn:not([hidden])', { timeout: 10000 });
    await page.locator('#addMemberBtn').click();

    assert.equal(await page.locator('#addMemberModal.active').count(), 1, 'النافذة لم تُفتح');
    // الوظيفة في مكانها: لا مغادرة للوحة الشركة إطلاقًا
    assert.deepEqual(departures(visited), [], `غادر المستخدم لوحة الشركة: ${visited.join(' → ')}`);
    await context.close();
});

test('الزر مخفي لمن لا تمنحه القاعدة can_manage', async (t) => {
    if (!chromiumPath) return t.skip('no chromium');
    const fx = fixtures({ members: { canManage: false } });
    const { page, context } = await openCompanyDashboard(browser, baseUrl, fx);

    await openSection(page, 'members');
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

    await openSection(page, 'members');
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

    await openSection(page, 'members');
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

    await openSection(page, 'members');
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

    await openSection(page, 'members');
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
    assert.deepEqual(departures(visited), [], `غادر المستخدم لوحة الشركة بعد الإنشاء: ${visited.join(' → ')}`);
    await context.close();
});

test('فشل الإنشاء يعرض رسالة الخادم كما هي، وبلا أي تحويل', async (t) => {
    if (!chromiumPath) return t.skip('no chromium');
    const fx = fixtures({
        functions: { 'create-sub-user': { error: 'A user with this email address has already been registered', status: 400 } }
    });
    const { page, context, visited } = await openCompanyDashboard(browser, baseUrl, fx);

    await openSection(page, 'members');
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

    await openSection(page, 'members');
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

/* ── التنقّل الكامل داخل لوحة الشركة ─────────────────────────────────────── */

test('حساب الشركة يتنقّل بين كل الأقسام دون مغادرة لوحة الشركة ولا حلقة', async (t) => {
    if (!chromiumPath) return t.skip('no chromium');
    const { page, context, visited } = await openCompanyDashboard(browser, baseUrl, fixtures());

    // كل عنصر في القائمة، بالترتيب، كما يضغطه المستخدم
    const tabs = await page.evaluate(() =>
        [...document.querySelectorAll('#sidebar .sidebar-item[data-tab]')].map(a => a.getAttribute('data-tab')));

    assert.ok(tabs.length >= 8, `عدد أقسام القائمة أقل من المتوقع: ${tabs.length}`);

    for (const tab of tabs) {
        await openSection(page, tab);
        // القسم ظهر فعلاً، ولم يُترك فارغًا
        const text = await page.locator(`#${tab}TabContent`).innerText();
        assert.ok(text.trim().length > 0, `القسم ${tab} فتح فارغًا`);
    }

    // الزيارة الثانية لكل قسم تنتهي لنفس الحالة — كشف الحلقة
    for (const tab of tabs) {
        await openSection(page, tab);
        assert.equal(await page.locator(`#${tab}TabContent.active`).count(), 1);
    }

    assert.deepEqual(departures(visited), [],
        `غادر المستخدم لوحة الشركة أثناء التنقّل: ${visited.join(' → ')}`);
    assert.equal(visited.filter(u => u.includes('login.html')).length, 0);
    await context.close();
});

test('كل قسم يعرض وظيفته الفعلية لا عنوانًا فارغًا', async (t) => {
    if (!chromiumPath) return t.skip('no chromium');
    const { page, context } = await openCompanyDashboard(browser, baseUrl, fixtures());

    // العلامة الدالة على أن الوظيفة نُقلت فعلاً، لا مجرد حاوية باسمها
    const marks = {
        members:       '#addMemberBtn',
        subscriptions: '#companySubscriptions',
        tickets:         '#platformTicketList',
        customerTickets: '#customersTicketList',
        support:       '#companyTicketForm',        // فتح تذكرة داخل اللوحة
        notifications: '#companyNotificationList',
        profile:       '#companyAccountForm',       // تعديل الملف الشخصي
        security:      '#companyPasswordForm'       // تغيير كلمة المرور
    };

    for (const [tab, selector] of Object.entries(marks)) {
        await openSection(page, tab);
        await page.waitForSelector(selector, { state: 'attached', timeout: 10000 });
        assert.equal(await page.locator(selector).count(), 1, `القسم ${tab} بلا ${selector}`);
    }
    await context.close();
});

test('مركز الدعم يحمل حالة الخدمات ومقالات المساعدة داخل اللوحة', async (t) => {
    if (!chromiumPath) return t.skip('no chromium');
    const fx = fixtures({
        rpc: {
            search_help_articles: [],
            get_my_company_dashboard: companyPayload(),
            current_company_id: COMPANY_ID,
            company_members: membersPayload()
        },
        tables: {
            services: [{ id: 'sv1', key: 'api', name: 'API', name_ar: 'واجهة البرمجة', status: 'operational' }],
            knowledge_base: [{ id: 'a1', title: 'كيف أضيف مستخدمًا؟', excerpt: 'من قسم مستخدمي الشركة', category: 'general', view_count: 3 }]
        }
    });
    const { page, context, visited } = await openCompanyDashboard(browser, baseUrl, fx);

    await openSection(page, 'support');
    await page.waitForFunction(
        () => !document.querySelector('#companyServiceStatus .skeleton')
            && !document.querySelector('#companyHelpArticles .skeleton'),
        null, { timeout: 10000 });

    // المساعدة لم تعد صفحة أخرى — صارت هنا
    assert.match(await page.locator('#companyHelpArticles').innerText(), /كيف أضيف مستخدمًا/);
    assert.deepEqual(departures(visited), [], `غادر المستخدم اللوحة: ${visited.join(' → ')}`);
    await context.close();
});

test('تسجيل الخروج ينهي الجلسة فعلًا قبل الانتقال لصفحة الدخول', async (t) => {
    if (!chromiumPath) return t.skip('no chromium');
    // المسار كان '../auth-client.js' فيفشل الاستيراد دائمًا، فيُنفَّذ فرع
    // الـcatch: انتقال لصفحة الدخول بدون signOut — والجلسة الحيّة تعيد
    // المستخدم للوحته فورًا. حلقة تحويل من باب تسجيل الخروج.
    const { page, context } = await openCompanyDashboard(browser, baseUrl, fixtures());

    const logoutCalls = await page.evaluate(async () => {
        const mod = await import('/auth-client.js');
        return typeof mod.logout === 'function';
    });
    assert.equal(logoutCalls, true, 'auth-client غير قابل للاستيراد من مسار الصفحة');

    const shellSrc = await page.evaluate(() =>
        fetch('/assets/js/customer-sidebar.js').then(r => r.text()));
    assert.doesNotMatch(shellSrc, /import\('\.\.\/auth-client\.js'\)/,
        'القشرة ما زالت تستورد auth-client بمسار نسبي مكسور');
    await context.close();
});

/* ── مسارا التذاكر: الشركة ↔ مدعوم  و  العميل ↔ الشركة ─────────────────── */

test('«تذاكري مع مدعوم» يعرض تذاكر الشركة وحدها، لا تذاكر عملائها', async (t) => {
    if (!chromiumPath) return t.skip('no chromium');
    const { page, context } = await openCompanyDashboard(browser, baseUrl, fixtures());

    await openSection(page, 'tickets');
    await page.waitForSelector('#platformTicketList', { timeout: 10000 });
    const text = await page.locator('#ticketsTabContent').innerText();

    assert.match(text, /مشكلة في الفوترة/, 'تذكرة الشركة مع مدعوم غير معروضة');
    assert.doesNotMatch(text, /طلب من عميلي/, 'تذكرة عميل تسرّبت إلى مسار «مع مدعوم»');
    assert.match(text, /تذاكري مع مدعوم/);
    await context.close();
});

test('«تذاكر العملاء» يعرض تذاكر عملاء هذه الشركة وحدهم', async (t) => {
    if (!chromiumPath) return t.skip('no chromium');
    const { page, context } = await openCompanyDashboard(browser, baseUrl, fixtures());

    await openSection(page, 'customerTickets');
    await page.waitForSelector('#customersTicketList', { timeout: 10000 });
    const text = await page.locator('#customerTicketsTabContent').innerText();

    assert.match(text, /طلب من عميلي/, 'تذكرة العميل غير معروضة');
    assert.doesNotMatch(text, /مشكلة في الفوترة/, 'تذكرة الشركة مع مدعوم تسرّبت إلى مسار العملاء');
    await context.close();
});

test('المساران لا يختلطان: لكلٍّ حاويته وقائمته وحالته', async (t) => {
    if (!chromiumPath) return t.skip('no chromium');
    const { page, context } = await openCompanyDashboard(browser, baseUrl, fixtures());

    await openSection(page, 'tickets');
    await page.waitForSelector('#platformTicketList', { timeout: 10000 });
    await openSection(page, 'customerTickets');
    await page.waitForSelector('#customersTicketList', { timeout: 10000 });

    // بحث في مسار لا يغيّر المسار الآخر — دليل أن الحالتين منفصلتان
    await page.fill('#customersTicketSearch', 'لا يوجد شيء بهذا الاسم');
    await page.waitForFunction(
        () => document.querySelector('#customersTicketList')?.textContent.includes('لا توجد تذاكر مطابقة'),
        null, { timeout: 10000 });

    await openSection(page, 'tickets');
    assert.match(await page.locator('#platformTicketList').innerText(), /مشكلة في الفوترة/,
        'بحث مسار العملاء أثّر على مسار «مع مدعوم»');
    await context.close();
});

test('الشركة تفتح تذكرة إلى مدعوم من مركز الدعم فتظهر في مسارها الصحيح', async (t) => {
    if (!chromiumPath) return t.skip('no chromium');
    const { page, context, visited } = await openCompanyDashboard(browser, baseUrl, fixtures());

    await openSection(page, 'support');
    await page.fill('#fTicketTitle', 'انقطاع في خدمة الواتساب');
    await page.fill('#fTicketBody', 'الخدمة متوقفة منذ ساعة ونحتاج متابعة عاجلة من فريق مدعوم.');
    await page.locator('#companyTicketSubmit').click();

    // بعد الإنشاء ينتقل تلقائيًا إلى «تذاكري مع مدعوم» — بلا مغادرة اللوحة
    await page.waitForSelector('#ticketsTabContent.active', { timeout: 10000 });
    await page.waitForFunction(
        () => document.querySelector('#platformTicketList')?.textContent.includes('انقطاع في خدمة الواتساب'),
        null, { timeout: 10000 });

    // ولا تظهر في مسار العملاء
    await openSection(page, 'customerTickets');
    assert.doesNotMatch(await page.locator('#customerTicketsTabContent').innerText(), /انقطاع في خدمة الواتساب/,
        'تذكرة الشركة مع مدعوم ظهرت في مسار العملاء');

    assert.deepEqual(departures(visited), [], `غادر المستخدم اللوحة: ${visited.join(' → ')}`);
    await context.close();
});

test('الشركة تفتح تذكرة عميل وتردّ عليه دون مغادرة اللوحة', async (t) => {
    if (!chromiumPath) return t.skip('no chromium');
    const { page, context, visited } = await openCompanyDashboard(browser, baseUrl, fixtures());

    await openSection(page, 'customerTickets');
    await page.waitForSelector('#customersTicketList', { timeout: 10000 });
    await page.locator('[data-stream-ticket="tk-customer"]').click();

    await page.waitForSelector('#customersTicketReplyForm', { timeout: 10000 });
    // نصّ الزرّ يوضّح أن الشركة هي الجهة المجيبة في هذا المسار
    assert.match(await page.locator('#customersTicketDetailBody').innerText(), /الردّ على العميل/);

    await page.fill('#customersTicketReplyText', 'استلمنا طلبك وسنعالجه اليوم.');
    await page.locator('#customersTicketReplyBtn').click();

    await page.waitForFunction(
        () => (window.__WRITES__ || []).some(w => w.table === 'ticket_replies'),
        null, { timeout: 10000 });

    const writes = await page.evaluate(() => window.__WRITES__ || []);
    const reply = writes.find(w => w.table === 'ticket_replies');
    assert.equal(reply.row.ticket_id, 'tk-customer');
    assert.equal(reply.row.user_id, '11111111-1111-1111-1111-111111111111');
    assert.equal(reply.row.is_internal, false);

    // لا محاولة لتغيير حالة التذكرة: الشركة لا تملك UPDATE على تذكرة عميلها
    assert.equal(writes.some(w => w.table === 'tickets' && w.op === 'update'), false,
        'حاولت الواجهة تعديل تذكرة العميل — الصلاحية غير ممنوحة عمدًا');

    assert.deepEqual(departures(visited), [], `غادر المستخدم اللوحة: ${visited.join(' → ')}`);
    await context.close();
});

/* ── إعادة الفتح والإغلاق كإجراءين صريحين ──────────────────────────────── */

test('الردّ على تذكرة مغلقة لا يعيد فتحها، وزرّ «إعادة الفتح» وحده يفعل', async (t) => {
    if (!chromiumPath) return t.skip('no chromium');
    const fx = fixtures({
        tables: {
            tickets: [
                { id: 'tk-resolved', user_id: '11111111-1111-1111-1111-111111111111', ticket_number: 303, title: 'تذكرة محلولة', description: 'وصف', status: 'resolved', created_at: '2026-09-01T00:00:00Z', archived_by_customer: false }
            ]
        }
    });
    const { page, context, visited } = await openCompanyDashboard(browser, baseUrl, fx);

    await openSection(page, 'tickets');
    await page.waitForSelector('#platformTicketList', { timeout: 10000 });
    await page.locator('[data-stream-ticket="tk-resolved"]').click();
    await page.waitForSelector('#platformTicketReplyForm', { timeout: 10000 });

    // الأثر موضَّح للمستخدم قبل أن يكتب
    assert.match(await page.locator('#platformTicketDetailBody').innerText(),
        /الردّ يُسجَّل ولا يعيد فتحها/);

    await page.fill('#platformTicketReplyText', 'معلومة إضافية على التذكرة المغلقة');
    await page.locator('#platformTicketReplyBtn').click();
    await page.waitForFunction(
        () => (window.__WRITES__ || []).some(w => w.table === 'ticket_replies'),
        null, { timeout: 10000 });

    const rpcAfterReply = await page.evaluate(() => window.__RPC_CALLS__ || []);
    assert.equal(rpcAfterReply.includes('reopen_ticket_in_my_scope'), false,
        'الردّ استدعى إعادة الفتح');

    // زرّ إعادة الفتح موجود ومنفصل
    assert.equal(await page.locator('#platformTicketReopenBtn').count(), 1, 'زرّ إعادة الفتح غائب');
    assert.equal(await page.locator('#platformTicketReopenBtn').innerText(), 'إعادة الفتح');

    assert.deepEqual(departures(visited), [], `غادر المستخدم اللوحة: ${visited.join(' → ')}`);
    await context.close();
});

test('زرّ «إعادة الفتح» يطلب تأكيدًا ثم يستدعي دالة القاعدة', async (t) => {
    if (!chromiumPath) return t.skip('no chromium');
    const fx = fixtures({
        tables: {
            tickets: [
                { id: 'tk-resolved', user_id: '11111111-1111-1111-1111-111111111111', ticket_number: 303, title: 'تذكرة محلولة', description: 'وصف', status: 'resolved', created_at: '2026-09-01T00:00:00Z', archived_by_customer: false }
            ]
        }
    });
    const { page, context } = await openCompanyDashboard(browser, baseUrl, fx);

    await openSection(page, 'tickets');
    await page.locator('[data-stream-ticket="tk-resolved"]').click();
    await page.waitForSelector('#platformTicketReopenBtn', { timeout: 10000 });
    await page.locator('#platformTicketReopenBtn').click();

    await page.waitForSelector('.ui-dialog', { timeout: 10000 });
    assert.match(await page.locator('.ui-dialog').innerText(), /إعادة فتح التذكرة/);
    await page.locator('.ui-dialog button:has-text("إعادة الفتح")').click();

    await page.waitForFunction(
        () => (window.__RPC_CALLS__ || []).includes('reopen_ticket_in_my_scope'),
        null, { timeout: 10000 });
    await context.close();
});

test('تذكرة عميل مفتوحة تعرض «إغلاق التذكرة» ولا تعرض «إعادة الفتح»', async (t) => {
    if (!chromiumPath) return t.skip('no chromium');
    const { page, context } = await openCompanyDashboard(browser, baseUrl, fixtures());

    await openSection(page, 'customerTickets');
    await page.waitForSelector('#customersTicketList', { timeout: 10000 });
    await page.locator('[data-stream-ticket="tk-customer"]').click();
    await page.waitForSelector('#customersTicketReplyForm', { timeout: 10000 });

    assert.equal(await page.locator('#customersTicketCloseBtn').count(), 1, 'زرّ الإغلاق غائب');
    assert.equal(await page.locator('#customersTicketReopenBtn').count(), 0,
        'تذكرة مفتوحة عُرض لها زرّ إعادة فتح');
    await context.close();
});

/* ── الأقسام المستوحاة من لوحة الإدارة ─────────────────────────────────── */

test('قسم API يعرض مفاتيح الشركة وأعضائها بلا أي سرّ', async (t) => {
    if (!chromiumPath) return t.skip('no chromium');
    const { page, context } = await openCompanyDashboard(browser, baseUrl, fixtures());

    await openSection(page, 'api');
    await page.waitForSelector('#companyKeysList', { timeout: 10000 });
    const text = await page.locator('#apiTabContent').innerText();

    assert.match(text, /مفتاح التكامل/, 'مفتاح الشركة غير معروض');
    assert.match(text, /مفتاح العميل/, 'مفتاح العضو غير معروض');
    assert.match(text, /••••4821/, 'آخر أربع خانات غير معروضة');
    assert.match(text, /حساب الشركة/, 'مالك المفتاح غير مبيَّن');

    // ولا أثر لأي سرّ في الصفحة كلها
    const html = await page.content();
    for (const secret of ['secret_hash', 'bearer_token_hash', 'credentials_encrypted']) {
        assert.ok(!html.includes(secret), `تسرّب اسم عمود سرّي إلى الصفحة: ${secret}`);
    }
    await context.close();
});

test('بلا استحقاق api_tokens لا يظهر زر إنشاء مفتاح، ولا كتابة من العميل', async (t) => {
    if (!chromiumPath) return t.skip('no chromium');
    // حمولة هذا الملف تمنح sub_users وحدها — فحساب الشركة هنا غير مستحق
    // للمفاتيح، والقسم لازم يقول السبب بدل زر معطّل بلا تفسير.
    const { page, context, visited } = await openCompanyDashboard(browser, baseUrl, fixtures());

    await openSection(page, 'api');
    await page.waitForSelector('#companyKeysList .company-sub, #companyKeysList .state-block',
        { timeout: 10000 });

    assert.equal(await page.locator('#companyCreateKey').count(), 0,
        'ظهر زر إنشاء مفتاح لحساب غير مستحق');
    assert.match(await page.locator('#companyApi .company-notice').first().textContent(), /api_tokens/);

    const writes = await page.evaluate(() => window.__WRITES__ || []);
    assert.equal(writes.some(w => w.table === 'api_tokens' && w.op === 'insert'), false,
        'الواجهة حاولت إنشاء مفتاح بكتابة مباشرة');
    assert.deepEqual(departures(visited), [], `غادر المستخدم اللوحة: ${visited.join(' → ')}`);
    await context.close();
});

test('قسم التقارير يبني أرقامه من المسارين معًا', async (t) => {
    if (!chromiumPath) return t.skip('no chromium');
    const { page, context } = await openCompanyDashboard(browser, baseUrl, fixtures());

    await openSection(page, 'reports');
    await page.waitForSelector('#companyReports .kpi', { timeout: 10000 });
    const text = await page.locator('#reportsTabContent').innerText();

    assert.match(text, /تذاكر مفتوحة مع مدعوم/);
    assert.match(text, /تذاكر عملاء مفتوحة/);
    assert.match(text, /مستخدمو الشركة/);
    // شفافية النطاق معلنة
    assert.match(text, /لا بيانات شركة أخرى/);
    await context.close();
});

test('قسم النشاط يعرض سجل هذا الحساب', async (t) => {
    if (!chromiumPath) return t.skip('no chromium');
    const { page, context } = await openCompanyDashboard(browser, baseUrl, fixtures());

    await openSection(page, 'activity');
    await page.waitForSelector('#companyActivityList', { timeout: 10000 });
    assert.match(await page.locator('#activityTabContent').innerText(), /نشاط الحساب/);
    await context.close();
});

/* ── جرس الإشعارات ─────────────────────────────────────────────────────── */

test('الجرس يفتح نافذة منبثقة ولا يبدّل القسم', async (t) => {
    if (!chromiumPath) return t.skip('no chromium');
    const fx = fixtures({
        tables: {
            notifications: [
                { id: 'n1', user_id: '11111111-1111-1111-1111-111111111111', title: 'ردّ جديد على تذكرتك', message: 'من فريق الدعم', is_read: false, created_at: '2026-09-08T00:00:00Z', category: 'tickets', action: 'none' },
                { id: 'n2', user_id: '11111111-1111-1111-1111-111111111111', title: 'تم تجديد اشتراكك', message: 'الباقة الشاملة', is_read: true, created_at: '2026-09-07T00:00:00Z', category: 'subscription', action: 'none' }
            ]
        }
    });
    const { page, context, visited } = await openCompanyDashboard(browser, baseUrl, fx);

    // القسم النشط قبل الضغط
    assert.equal(await page.locator('#overviewTabContent.active').count(), 1);

    await page.locator('#notificationBtn').click();
    // ظهور العنصر ليس اكتمال التحميل: ننتظر امتلاء الجسم (عناصر أو حالة فراغ)
    await page.waitForSelector('.portal-notif-item, .portal-notif-empty', { timeout: 10000 });

    const popover = await page.locator('#portalNotificationPopover').innerText();
    assert.match(popover, /ردّ جديد على تذكرتك/);
    assert.match(popover, /تم تجديد اشتراكك/);
    assert.match(popover, /عرض الكل/);

    // حالة مقروء/غير مقروء ظاهرة
    assert.equal(await page.locator('.portal-notif-item.is-unread').count(), 1);

    // ولم يتغيّر القسم ولم تُغادَر الصفحة
    assert.equal(await page.locator('#overviewTabContent.active').count(), 1,
        'الجرس بدّل القسم');
    assert.equal(await page.locator('#notificationsTabContent.active').count(), 0);
    assert.deepEqual(departures(visited), [], `غادر المستخدم اللوحة: ${visited.join(' → ')}`);
    await context.close();
});

test('«عرض الكل» وحده هو الذي ينقل إلى قسم الإشعارات', async (t) => {
    if (!chromiumPath) return t.skip('no chromium');
    const { page, context } = await openCompanyDashboard(browser, baseUrl, fixtures());

    await page.locator('#notificationBtn').click();
    await page.waitForSelector('#portalNotifSeeAll', { timeout: 10000 });
    await page.locator('#portalNotifSeeAll').click();

    await page.waitForSelector('#notificationsTabContent.active', { timeout: 10000 });
    assert.equal(await page.locator('#portalNotificationPopover').count(), 0,
        'النافذة لم تُغلق بعد الانتقال');
    await context.close();
});

test('النافذة تُغلق بالضغط خارجها وبمفتاح Escape', async (t) => {
    if (!chromiumPath) return t.skip('no chromium');
    const { page, context } = await openCompanyDashboard(browser, baseUrl, fixtures());

    await page.locator('#notificationBtn').click();
    await page.waitForSelector('#portalNotificationPopover', { timeout: 10000 });
    await page.locator('#companyMain').click({ position: { x: 5, y: 5 } });
    await page.waitForFunction(() => !document.getElementById('portalNotificationPopover'),
        null, { timeout: 10000 });

    await page.locator('#notificationBtn').click();
    await page.waitForSelector('#portalNotificationPopover', { timeout: 10000 });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('portalNotificationPopover'),
        null, { timeout: 10000 });

    // التركيز يعود للجرس — شرط وصولية أساسي
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'notificationBtn');
    await context.close();
});

test('حالة عدم وجود إشعارات معالَجة في النافذة', async (t) => {
    if (!chromiumPath) return t.skip('no chromium');
    const fx = fixtures({ tables: { notifications: [] } });
    const { page, context } = await openCompanyDashboard(browser, baseUrl, fx);

    await page.locator('#notificationBtn').click();
    await page.waitForSelector('.portal-notif-empty', { timeout: 10000 });
    assert.match(await page.locator('#portalNotificationPopover').innerText(), /لا توجد إشعارات/);
    await context.close();
});

test('لا تمرير أفقي في أي قسم، على الموبايل وسطح المكتب', async (t) => {
    if (!chromiumPath) return t.skip('no chromium');
    // الاختبار القائم يفحص القسم الافتراضي وحده. الأقسام الجديدة تحمل جداول
    // ومفاتيح وأكوادًا — وهي بالضبط ما يكسر العرض الضيّق لو أُهمل.
    for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 1000 }]) {
        const context = await browser.newContext({ viewport });
        const page = await context.newPage();
        await page.close();
        await context.close();
    }

    const { page, context } = await openCompanyDashboard(browser, baseUrl, fixtures());
    await page.setViewportSize({ width: 390, height: 844 });

    const tabs = await page.evaluate(() =>
        [...document.querySelectorAll('#sidebar .sidebar-item[data-tab]')].map(a => a.getAttribute('data-tab')));

    for (const tab of tabs) {
        await page.evaluate((t2) => { window.location.hash = `#${t2}`; }, tab);
        await page.waitForSelector(`#${tab}TabContent.active`, { timeout: 10000 });
        // ننتظر انتهاء أي هيكل تحميل قبل القياس
        await page.waitForFunction(
            (t3) => !document.querySelector(`#${t3}TabContent .skeleton`),
            tab, { timeout: 10000 }
        ).catch(() => {});

        const overflows = await page.evaluate(() =>
            document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
        assert.equal(overflows, false, `تمرير أفقي في القسم ${tab} على عرض 390`);
    }
    await context.close();
});
