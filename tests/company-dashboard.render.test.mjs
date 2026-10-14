/**
 * اختبارات عرض لوحة الشركة — تشغّل الصفحة الحقيقية في Chromium فعلي مقابل
 * بديل اختباري لـSupabase/auth، فتتنفّذ وحدات الرسم الحقيقية كلها بدون أي
 * اتصال بقاعدة بيانات.
 *
 * الحمولة في الـfixtures هي بالضبط شكل ما ترجّعه
 * get_my_company_dashboard() في migrations/016_company_dashboard.sql،
 * فأي تغيير في عقد الدالة يفشل هنا.
 *
 * ملاحظة مهمة: العزل بين الشركات **مش** مُختبَر هنا — هو قرار قاعدة بيانات
 * ومُختبَر في tests/sql/company-dashboard.test.sql. اللي بيتّختبر هنا هو
 * العرض: مين يشوف اللوحة، وإيه اللي بتعرضه في كل حالة اشتراك.
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

/** نفس شكل حمولة get_my_company_dashboard() حرفيًا. */
function companyPayload(overrides = {}) {
    return {
        company: {
            id: COMPANY_ID,
            name: 'شركة النور التجارية',
            cr_number: '1010101010',
            cr_expiry: '2027-06-01',
            status: 'active',
            email: 'info@alnoor.test',
            phone: '0500000000',
            address: 'شارع الملك',
            city: 'الرياض',
            country: 'السعودية',
            website: null,
            industry: null,
            tax_id: null,
            created_at: '2026-01-01T00:00:00Z',
            is_owner: true,
            ...(overrides.company || {})
        },
        registration: {
            expiry_date: '2027-06-01',
            is_expired: false,
            days_to_expiry: 267,
            ...(overrides.registration || {})
        },
        subscriptions: overrides.subscriptions || [{
            id: 's1', plan: 'whatsapp', plan_name_ar: 'واتساب بيزنس',
            status: 'active', billing_cycle: 'monthly',
            start_date: '2026-08-01T00:00:00Z', end_date: '2026-12-01T00:00:00Z',
            is_active: true, days_remaining: 85
        }],
        entitlements: overrides.entitlements || [
            { feature_key: 'whatsapp_sender', name_ar: 'إرسال رسائل واتساب', description: 'إرسال الرسائل والقوالب', limits: {}, granted_by: ['whatsapp'] },
            { feature_key: 'whatsapp_campaigns', name_ar: 'الحملات الجماعية', description: 'حملات الإرسال الجماعي', limits: {}, granted_by: ['whatsapp'] }
        ],
        access: overrides.access || { active_plans: ['whatsapp'], has_active_subscription: true }
    };
}

function fixtures(payload, overrides = {}) {
    return {
        user: { id: USER_ID, email: 'owner@example.com' },
        authUser: {
            id: USER_ID,
            email: 'owner@example.com',
            profile: { id: USER_ID, full_name: 'مالك الشركة', role: 'user' }
        },
        // قيم صريحة لا دوال: الـfixtures بتتنقل للمتصفح عبر addInitScript
        // اللي بيسلسلها JSON، فأي دالة هنا كانت هتتلاشى بصمت.
        // البديل الاختباري بيقبل القيمة الجاهزة مباشرةً.
        rpc: {
            get_my_company_dashboard: payload,
            current_company_id: payload ? COMPANY_ID : null,
            ...(overrides.rpc || {})
        },
        tables: {
            profiles: [{ id: USER_ID, email: 'owner@example.com', full_name: 'مالك الشركة', role: 'user' }],
            notifications: [],
            services: [],
            whatsapp_subscriptions: [],
            subscription_plans: [],
            ...(overrides.tables || {})
        }
    };
}

/** يفتح لوحة الشركة في متصفح حقيقي مع اعتراض وحدات Supabase/auth. */
async function openCompanyDashboard(browser, baseUrl, fx, { viewport } = {}) {
    const context = await browser.newContext({ viewport: viewport || { width: 1440, height: 1000 } });
    const page = await context.newPage();

    const doubleSupabase = fs.readFileSync(path.join(ROOT, 'tests/fixtures/supabase-double.js'), 'utf8');
    const doubleAuth = fs.readFileSync(path.join(ROOT, 'tests/fixtures/auth-client-double.js'), 'utf8');

    await page.route('**/api-config.js', route =>
        route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: doubleSupabase }));
    await page.route('**/auth-client.js', route =>
        route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: doubleAuth }));
    await page.route('**/chat-widget.js', r => r.fulfill({ contentType: 'text/javascript', body: 'export default {};' }));
    await page.route('**/error-tracker.js', r => r.fulfill({ contentType: 'text/javascript', body: '' }));
    await page.route('https://fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));

    await page.addInitScript(data => { window.__FIXTURES__ = data; }, fx);

    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto(`${baseUrl}/company-dashboard/index.html`, { waitUntil: 'networkidle' });
    // القائمة الجانبية تُحقن بعد fetch — نستخدمها كإشارة اكتمال التهيئة
    await page.waitForSelector('.sidebar-item[data-tab="tickets"]', { timeout: 10000 });
    // البوابة بتظهر أولًا وفيها هيكل تحميل، فمجرد ظهورها مش إشارة اكتمال.
    // الانتظار الصحيح: إما المحتوى اتعرض، أو البوابة رسمت حالة نهائية فعلية.
    await page.waitForFunction(
        () => !document.getElementById('companyContent')?.hidden
            || !!document.querySelector('#companyGateBody .state-block'),
        null,
        { timeout: 10000 }
    );
    return { page, context, errors };
}

/**
 * نفس اكتشاف المتصفح المستخدم في باقي اختبارات العرض: بنعتمد على المتصفح
 * المتاح في البيئة بدل أي تنزيل وقت التشغيل، وبنتخطّى الاختبارات بصوت عالٍ
 * لو مفيش متصفح — من غير ما ندّعي إنها نجحت.
 */
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
    console.error('SKIP: لا يوجد متصفح Chromium متاح؛ اختبارات عرض لوحة الشركة لم تُنفَّذ');
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

/* ── من يرى اللوحة ──────────────────────────────────────────────────────── */

test('المستخدم المؤهل يرى لوحة الشركة ببياناتها', async () => {
    const { page, context, errors } = await openCompanyDashboard(browser, baseUrl, fixtures(companyPayload()));

    assert.equal(await page.locator('#companyContent').isHidden(), false, 'محتوى اللوحة مخفي');
    assert.equal(await page.locator('#companyName').textContent(), 'شركة النور التجارية');
    // علامة المستوى: اللوحة لازم تعلن إنها سياق شركة مش سياق مستخدم
    assert.match(await page.locator('.company-level-tag').textContent(), /لوحة الشركة/);
    assert.match(await page.locator('#companyAccessPill').textContent(), /اشتراك فعّال/);
    assert.equal(errors.length, 0, `أخطاء في الصفحة: ${errors.join(' | ')}`);
    await context.close();
});

test('من لا شركة له يرى بوابة توضّح الخطوة الجاية لا صفحة فاضية', async () => {
    const { page, context } = await openCompanyDashboard(browser, baseUrl, fixtures(null));

    assert.equal(await page.locator('#companyContent').isHidden(), true, 'ظهر محتوى اللوحة لمن لا شركة له');
    assert.equal(await page.locator('#companyGate').isHidden(), false);
    const gate = await page.locator('#companyGateBody').textContent();
    assert.match(gate, /لا توجد شركة مرتبطة بحسابك/);
    // حالة الفراغ لازم تقول الخطوة الجاية (قاعدة المنتج في باقي البوابة)
    assert.equal(await page.locator('#companyGateBody [data-goto]').count(), 1);
    await context.close();
});

test('قائمة لوحة الشركة لا تحمل مدخلًا لبوابة العميل إطلاقًا', async () => {
    // مدخل «لوحة الشركة» عنصر في قائمة **العميل** (يظهر لمن له شركة)، ولا
    // معنى له داخل لوحة الشركة نفسها. الأهم: قائمة الشركة يجب ألا تحمل أي
    // رابط لبوابة العميل — وهذا ما يمنع دورة التحويل من الوجود.
    const { page, context } = await openCompanyDashboard(browser, baseUrl, fixtures(companyPayload()));

    assert.equal(await page.locator('#companyDashboardLink').count(), 0,
        'قائمة الشركة تحمل مدخل لوحة الشركة — عنصر يخصّ قائمة العميل');

    const hrefs = await page.evaluate(() =>
        [...document.querySelectorAll('#sidebar a[href], .portal-nav a[href]')]
            .map(a => a.getAttribute('href')));
    assert.ok(hrefs.length >= 8, `عدد روابط القائمة أقل من المتوقع: ${hrefs.length}`);
    for (const href of hrefs) {
        assert.ok(!/customer-dashboard|customer-subscriptions|customer-security|knowledge-base|chat-customer|community\.html|roadmap\.html/.test(href),
            `رابط في قائمة الشركة يؤدي إلى بوابة العميل: ${href}`);
    }
    await context.close();
});

/* ── الامتيازات تتبع الباقة ─────────────────────────────────────────────── */

test('امتيازات باقة واتساب وحدها لا تتضمّن امتيازات الدعم الفني', async () => {
    const { page, context } = await openCompanyDashboard(browser, baseUrl, fixtures(companyPayload()));

    const text = await page.locator('#companyEntitlements').textContent();
    assert.match(text, /إرسال رسائل واتساب/);
    assert.match(text, /واتساب بيزنس/, 'الامتيازات غير مجمّعة تحت الباقة التي منحتها');
    assert.doesNotMatch(text, /تذاكر الدعم/);
    await context.close();
});

test('الاشتراك في أكثر من باقة يعرض امتيازات الاثنتين مجمّعة', async () => {
    const payload = companyPayload({
        subscriptions: [
            { id: 's1', plan: 'whatsapp', plan_name_ar: 'واتساب بيزنس', status: 'active', billing_cycle: 'monthly', start_date: '2026-08-01T00:00:00Z', end_date: '2026-12-01T00:00:00Z', is_active: true, days_remaining: 85 },
            { id: 's2', plan: 'support', plan_name_ar: 'الدعم الفني', status: 'active', billing_cycle: 'yearly', start_date: '2026-08-01T00:00:00Z', end_date: '2026-10-01T00:00:00Z', is_active: true, days_remaining: 24 }
        ],
        entitlements: [
            { feature_key: 'whatsapp_sender', name_ar: 'إرسال رسائل واتساب', description: '', limits: {}, granted_by: ['whatsapp'] },
            { feature_key: 'support_tickets', name_ar: 'تذاكر الدعم الفني', description: '', limits: {}, granted_by: ['support'] }
        ],
        access: { active_plans: ['whatsapp', 'support'], has_active_subscription: true }
    });
    const { page, context } = await openCompanyDashboard(browser, baseUrl, fixtures(payload));

    const groups = await page.locator('.company-plan-group').count();
    assert.equal(groups, 2, 'الامتيازات لم تُجمَّع تحت الباقتين');
    const text = await page.locator('#companyEntitlements').textContent();
    assert.match(text, /إرسال رسائل واتساب/);
    assert.match(text, /تذاكر الدعم الفني/);
    // أقرب انتهاء لازم يكون الاشتراك الأقصر مدة
    assert.match(await page.locator('#companyKpis').textContent(), /24 يوم/);
    await context.close();
});

test('انتهاء الاشتراك يسحب الامتيازات ويغيّر حالة الوصول', async () => {
    const payload = companyPayload({
        subscriptions: [{
            id: 's1', plan: 'whatsapp', plan_name_ar: 'واتساب بيزنس',
            status: 'expired', billing_cycle: 'monthly',
            start_date: '2026-01-01T00:00:00Z', end_date: '2026-02-01T00:00:00Z',
            is_active: false, days_remaining: 0
        }],
        entitlements: [],
        access: { active_plans: [], has_active_subscription: false }
    });
    const { page, context } = await openCompanyDashboard(browser, baseUrl, fixtures(payload));

    // الشركة تفضل ظاهرة، لكن من غير امتيازات
    assert.equal(await page.locator('#companyContent').isHidden(), false);
    assert.match(await page.locator('#companyAccessPill').textContent(), /لا يوجد اشتراك فعّال/);
    assert.equal(await page.locator('.company-plan-group').count(), 0);
    assert.match(await page.locator('#companyEntitlements').textContent(), /لا توجد خدمات مفعّلة/);
    // سجل الاشتراك نفسه يفضل معروضًا بحالته
    assert.match(await page.locator('#companySubscriptions').textContent(), /منتهٍ/);
    await context.close();
});

/* ── بيانات الشركة ──────────────────────────────────────────────────────── */

test('السجل التجاري المنتهي يُعلَن بوضوح', async () => {
    const payload = companyPayload({
        company: { cr_expiry: '2025-01-01' },
        registration: { expiry_date: '2025-01-01', is_expired: true, days_to_expiry: -250 }
    });
    const { page, context } = await openCompanyDashboard(browser, baseUrl, fixtures(payload));

    assert.match(await page.locator('#companyKpis').textContent(), /منتهي الصلاحية/);
    assert.equal(await page.locator('.company-notice--danger').count(), 1);
    await context.close();
});

test('العضو الفرعي يرى البيانات ولا يرى زر التعديل', async () => {
    const payload = companyPayload({ company: { is_owner: false } });
    const { page, context } = await openCompanyDashboard(browser, baseUrl, fixtures(payload));

    assert.equal(await page.locator('#editCompanyBtn').isHidden(), true, 'زر التعديل ظهر لعضو فرعي');
    assert.match(await page.locator('#companyMeta').textContent(), /عضو في هذه الشركة/);
    // ومع ذلك بيانات الشركة معروضة له
    assert.match(await page.locator('#companyProfileBody').textContent(), /1010101010/);
    await context.close();
});

test('المالك يفتح نموذج التعديل ببيانات الشركة الحالية', async () => {
    const { page, context } = await openCompanyDashboard(browser, baseUrl, fixtures(companyPayload()));

    await page.locator('#editCompanyBtn').click();
    assert.equal(await page.locator('#companyForm').isHidden(), false);
    assert.equal(await page.locator('#fCompanyName').inputValue(), 'شركة النور التجارية');
    assert.equal(await page.locator('#fCrNumber').inputValue(), '1010101010');
    assert.equal(await page.locator('#fCrExpiry').inputValue(), '2027-06-01');
    await context.close();
});

test('النموذج يرفض الحفظ بدون البيانات القانونية الأساسية', async () => {
    const { page, context } = await openCompanyDashboard(browser, baseUrl, fixtures(companyPayload()));

    await page.locator('#editCompanyBtn').click();
    await page.locator('#fCompanyName').fill('');
    await page.locator('#fCrNumber').fill('');
    await page.locator('#saveCompanyBtn').click();

    assert.equal(await page.locator('[data-error-for="companyName"]').isHidden(), false);
    assert.equal(await page.locator('[data-error-for="crNumber"]').isHidden(), false);
    // ولا يُغلق النموذج ما دام غير صالح
    assert.equal(await page.locator('#companyForm').isHidden(), false);
    await context.close();
});

/* ── الاستجابة ──────────────────────────────────────────────────────────── */

test('لا تمرير أفقي على الموبايل ولا على سطح المكتب', async () => {
    for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 1000 }]) {
        const { page, context } = await openCompanyDashboard(
            browser, baseUrl, fixtures(companyPayload()), { viewport });
        const overflows = await page.evaluate(() =>
            document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
        assert.equal(overflows, false, `تمرير أفقي عند عرض ${viewport.width}`);
        await context.close();
    }
});

/* ── 095 (D8): لوحة الشركة لفريقها فقط ─────────────────────────────────── */

test('095: عميل الشركة يرى رسالة وزرًا لبوابة العملاء، لا بيانات الشركة', async () => {
    // الخادم بعد 095 يعيد null لحمولة العميل، ونوع حسابه company_customer
    const fx = fixtures(null, { rpc: { my_account_kind: 'company_customer', current_company_id: COMPANY_ID } });
    const { page, context } = await openCompanyDashboard(browser, baseUrl, fx);

    assert.equal(await page.locator('#companyContent').isHidden(), true, 'محتوى الشركة ظهر لعميلها');
    const gate = await page.locator('#companyGateBody').textContent();
    assert.match(gate, /هذه اللوحة لفريق الشركة/);
    assert.equal(await page.locator('#companyGateBody [data-goto="/portal/"]').count(), 1, 'لا زر لبوابة العملاء');
    await context.close();
});

test('095: موظف الدعم يرى لوحة مختصرة بلا الاشتراكات ولا مفاتيح API', async () => {
    const payload = companyPayload({ company: { is_owner: false, cr_number: null, tax_id: null } });
    payload.viewer_role = 'agent';
    payload.registration = null;
    payload.subscriptions = [];
    payload.access = { active_plans: [], has_active_subscription: true };
    const fx = fixtures(payload, { rpc: { my_account_kind: 'company_employee' } });
    const { page, context } = await openCompanyDashboard(browser, baseUrl, fx);

    assert.equal(await page.locator('#companyContent').isHidden(), false);
    assert.equal(await page.locator('.sidebar-item[data-tab="subscriptions"]').isHidden(), true, 'قسم الاشتراكات ظاهر للموظف');
    assert.equal(await page.locator('.sidebar-item[data-tab="api"]').isHidden(), true, 'قسم API ظاهر للموظف');
    assert.match(await page.locator('#companyMeta').textContent(), /موظف دعم في فريق الشركة/);
    assert.doesNotMatch(await page.locator('#companyKpis').textContent(), /اشتراكات فعّالة|السجل التجاري/);
    // الرابط المباشر لقسم المدير يعود للنظرة العامة
    await page.evaluate(() => { window.location.hash = '#subscriptions'; });
    await page.waitForTimeout(150);
    assert.equal(await page.locator('#subscriptionsTabContent').evaluate(el => el.classList.contains('active')), false);
    await context.close();
});

test('095: المدير يرى اللوحة كاملة كما كانت (viewer_role = admin)', async () => {
    const payload = companyPayload();
    payload.viewer_role = 'admin';
    const fx = fixtures(payload, { rpc: { my_account_kind: 'company_admin' } });
    const { page, context } = await openCompanyDashboard(browser, baseUrl, fx);

    assert.equal(await page.locator('.sidebar-item[data-tab="subscriptions"]').isHidden(), false);
    assert.equal(await page.locator('.sidebar-item[data-tab="api"]').isHidden(), false);
    assert.match(await page.locator('#companyKpis').textContent(), /اشتراكات فعّالة/);
    await context.close();
});

/* ── 096: عملاء الشركة ودعواتهم ─────────────────────────────────────────── */

/** اللوحة في قسم «المستخدمون»: نفتحه كما يفعل المستخدم. */
async function openMembersSection(page) {
    await page.evaluate(() => { window.location.hash = '#members'; });
    await page.waitForSelector('#membersTabContent.active', { timeout: 5000 });
}

test('096: المدير والمفتاح مفعّل يرى نموذج الدعوة ويرسلها بلا كشف لوجود الحساب', async () => {
    const payload = companyPayload();
    payload.viewer_role = 'admin';
    const fx = fixtures(payload, { rpc: {
        my_account_kind: 'company_admin',
        company_customers_list: { company_id: COMPANY_ID, can_manage: true, invitations_enabled: true, customers: [] },
        company_invitations_list: [{ id: 'i1', email: 'old@x.test', status: 'expired', created_at: '2026-10-01T10:00:00Z' },
                                   { id: 'i2', email: 'wait@x.test', status: 'pending', created_at: '2026-10-10T10:00:00Z' }],
        company_invite_customer: { status: 'pending' }
    } });
    const { page, context, errors } = await openCompanyDashboard(browser, baseUrl, fx);
    await openMembersSection(page);
    await page.waitForSelector('#companyCustomersPanel:not([hidden])', { timeout: 5000 });
    assert.equal(await page.locator('#companyInviteForm').isHidden(), false);
    const invText = await page.locator('#companyInvitations').textContent();
    assert.match(invText, /منتهية/);
    assert.match(invText, /بانتظار الرد/);
    assert.equal(await page.locator('[data-cancel-invitation]').count(), 1, 'الإلغاء للمعلّقة فقط');
    await page.locator('#companyInviteEmail').fill('غير صالح');
    await page.locator('#companyInviteSubmit').click();
    assert.equal(await page.locator('#companyInviteError').isHidden(), false);
    await page.locator('#companyInviteEmail').fill('new@x.test');
    await page.locator('#companyInviteSubmit').click();
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'company_invite_customer'));
    const args = await page.evaluate(() => window.__RPC_ARGS__.filter(([n]) => n === 'company_invite_customer').map(([, a]) => a));
    assert.deepEqual(args, [{ p_email: 'new@x.test' }]);
    assert.equal(errors.length, 0, errors.join(' | '));
    await context.close();
});

test('096: المفتاح مطفأ: لا نموذج دعوة ولا لوحة عملاء للمدير', async () => {
    const payload = companyPayload();
    payload.viewer_role = 'admin';
    const fx = fixtures(payload, { rpc: {
        my_account_kind: 'company_admin',
        company_customers_list: { company_id: COMPANY_ID, can_manage: true, invitations_enabled: false, customers: [] }
    } });
    const { page, context } = await openCompanyDashboard(browser, baseUrl, fx);
    await page.waitForTimeout(200);
    assert.equal(await page.locator('#companyCustomersPanel').isHidden(), true);
    const calls = await page.evaluate(() => window.__RPC_CALLS__ || []);
    assert.equal(calls.includes('company_invitations_list'), false);
    await context.close();
});

test('096: المشرف يرى قائمة العملاء للقراءة، بلا دعوة', async () => {
    const payload = companyPayload({ company: { is_owner: false, cr_number: null, tax_id: null } });
    payload.viewer_role = 'supervisor';
    payload.registration = null;
    payload.subscriptions = [];
    const fx = fixtures(payload, { rpc: {
        my_account_kind: 'company_employee',
        company_customers_list: { company_id: COMPANY_ID, can_manage: false, invitations_enabled: true,
                                  customers: [{ id: 'u1', name: 'عميل أول', email: 'c1@x.test', phone: null }] }
    } });
    const { page, context } = await openCompanyDashboard(browser, baseUrl, fx);
    await openMembersSection(page);
    await page.waitForSelector('#companyCustomersPanel:not([hidden])', { timeout: 5000 });
    assert.equal(await page.locator('#companyInviteForm').isHidden(), true);
    assert.match(await page.locator('#companyCustomers').textContent(), /عميل أول/);
    await context.close();
});

/* ── 100: مستندات الشركة ────────────────────────────────────────────────── */

function documentsFixture(enabled = true) {
    const payload = companyPayload();
    payload.viewer_role = 'admin';
    return fixtures(payload, { rpc: {
        my_account_kind: 'company_admin',
        company_documents_mine: {
            enabled, kind: 'company',
            requirements: [
                { doc_type: 'commercial_registration', label: 'السجل التجاري', required: true, status: 'approved', allowed_mime: ['application/pdf'] },
                { doc_type: 'tax_card', label: 'البطاقة الضريبية', required: true, status: 'pending_scan', allowed_mime: ['application/pdf'] },
                { doc_type: 'contract_proof', label: 'إثبات التعاقد', required: false, status: 'missing', allowed_mime: ['application/pdf'] }
            ],
            documents: [
                { doc_type: 'commercial_registration', expires_on: '2030-01-01',
                  versions: [{ id: 'v-cr', version_no: 1, status: 'clean', is_current: true, created_at: '2026-10-01T00:00:00Z', review_status: 'approved' }] },
                { doc_type: 'tax_card',
                  versions: [{ id: 'v-tax', version_no: 1, status: 'pending_scan', is_current: true, created_at: '2026-10-02T00:00:00Z', review_status: 'pending' }] }
            ]
        }
    } });
}

test('100: المستندات مخفية والميزة مطفأة', async () => {
    const { page, context } = await openCompanyDashboard(browser, baseUrl, documentsFixture(false));
    await page.waitForTimeout(200);
    assert.equal(await page.locator('#companyDocumentsPanel').isHidden(), true);
    await context.close();
});

test('100: الحالة لكل مستند، والتنزيل للنظيف وحده، والرفع إلى الدالة الطرفية بالرؤوس الصحيحة', async () => {
    const { page, context, errors } = await openCompanyDashboard(browser, baseUrl, documentsFixture(true));
    await page.waitForSelector('#companyDocumentsPanel:not([hidden])', { timeout: 5000 });
    const text = await page.locator('#companyDocuments').innerText();
    assert.match(text, /معتمد/);
    assert.match(text, /بانتظار الفحص الأمني/);
    assert.match(text, /غير مرفوع/);
    assert.equal(await page.locator('[data-document-download="v-cr"]').count(), 1);
    assert.equal(await page.locator('[data-document-download="v-tax"]').count(), 0, 'تنزيل ملف معزول');

    const seen = [];
    await page.route('**/functions/v1/company-document-upload', async (route) => {
        const h = route.request().headers();
        seen.push({ type: h['x-document-type'], mime: h['content-type'], key: h['x-idempotency-key'] });
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"pending_scan"}' });
    });
    await page.setInputFiles('[data-document-upload="contract_proof"]',
        { name: 'contract.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7 test') });
    await page.waitForFunction(() => true);
    await page.waitForTimeout(300);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].type, 'contract_proof');
    assert.equal(seen[0].mime, 'application/pdf');
    assert.match(seen[0].key, /^[0-9a-f-]{36}$/);

    // ملف مرفوض قبل الإرسال
    await page.setInputFiles('[data-document-upload="contract_proof"]',
        { name: 'x.zip', mimeType: 'application/zip', buffer: Buffer.from('PK') });
    await page.waitForSelector('#companyDocumentsError:not([hidden])');
    assert.equal(seen.length, 1, 'أُرسل ملف بنوع مرفوض');
    assert.equal(errors.filter(e => !/favicon|404/.test(e)).length, 0, errors.join(' | '));
    await context.close();
});

/* ── 101: نقل العملاء والاطلاع التاريخي ──────────────────────────────────── */

function movesFixture(features, extra = {}) {
    const payload = companyPayload();
    payload.viewer_role = 'admin';
    return fixtures(payload, { rpc: {
        my_account_kind: 'company_admin',
        company_customers_list: { company_id: COMPANY_ID, can_manage: true, invitations_enabled: false,
                                  customers: [{ id: 'u1', name: 'عميل أول', email: 'c1@x.test', phone: null }] },
        h2_features: { transfers: false, carry: false, historical: false, ...features },
        ...extra
    } });
}

test('101: المفتاحان مطفآن: لا لوحة نقل ولا اطلاع، ولا نداء لقوائمهما', async () => {
    const { page, context } = await openCompanyDashboard(browser, baseUrl, movesFixture({}));
    await page.waitForFunction(() => (window.__RPC_CALLS__ || []).includes('h2_features'));
    await page.waitForTimeout(150);
    assert.equal(await page.locator('#companyMovesPanel').isHidden(), true);
    const calls = await page.evaluate(() => window.__RPC_CALLS__);
    assert.ok(!calls.includes('company_transfer_requests') && !calls.includes('company_historical_requests'));
    await context.close();
});

test('101: قرار نقل صادر يعرض رغبة العميل في البقاء إضافيًا ويرسلها مع الموافقة، بلا اسم الشركة الأخرى', async () => {
    const fx = movesFixture({ transfers: true }, {
        company_transfer_requests: [
            { id: 'x1', customer_name: 'عميل أول', direction: 'outgoing', status: 'pending', my_decision: null,
              customer_wants_secondary: true, created_at: '2026-10-10T10:00:00Z' },
            { id: 'x2', customer_name: 'عميل ثان', direction: 'incoming', status: 'pending', my_decision: 'approved',
              customer_wants_secondary: null, created_at: '2026-10-09T10:00:00Z' }],
        transfer_decide: { transfer_id: 'x1', status: 'pending', waiting_for: 'destination' }
    });
    const { page, context, errors } = await openCompanyDashboard(browser, baseUrl, fx);
    await openMembersSection(page);
    await page.waitForSelector('#companyMovesPanel:not([hidden])', { timeout: 5000 });
    assert.equal(await page.locator('#companyHistoryBox').isHidden(), true, 'الاطلاع بمفتاحه');
    const text = await page.locator('#companyTransfers').innerText();
    assert.match(text, /يطلب نقل شركته الأساسية إلى شركة أخرى/);
    assert.match(text, /بانتظار الشركة الأخرى/);
    assert.equal(await page.locator('[data-transfer="x2"] [data-decide]').count(), 0, 'لا قرار مرتين');
    await page.locator('[data-transfer="x1"] [data-allow-secondary]').check();
    await page.locator('[data-transfer="x1"] [data-decide="true"]').click();
    await page.waitForFunction(() => (window.__RPC_CALLS__ || []).includes('transfer_decide'));
    const args = await page.evaluate(() => window.__RPC_ARGS__.filter(([n]) => n === 'transfer_decide').map(([, a]) => a));
    assert.deepEqual(args, [{ p_transfer: 'x1', p_approve: true, p_allow_secondary: true }]);
    assert.equal(errors.length, 0, errors.join(' | '));
    await context.close();
});

test('101: طلب اطلاع بغرض واضح لعميل الشركة، والعرض للتذاكر المسموحة وحدها', async () => {
    const fx = movesFixture({ historical: true }, {
        company_historical_requests: [
            { id: 'h1', customer_name: 'عميل أول', purpose: 'متابعة شكوى سابقة للعميل بخصوص طلبه', status: 'approved',
              ticket_ids: ['tA'], expires_at: '2026-10-15T10:00:00Z', created_at: '2026-10-14T10:00:00Z' },
            { id: 'h2', customer_name: 'عميل أول', purpose: 'طلب آخر بانتظار العميل للمراجعة', status: 'awaiting_customer',
              ticket_ids: null, expires_at: null, created_at: '2026-10-14T11:00:00Z' }],
        historical_access_request: { request_id: 'h3', status: 'awaiting_customer' },
        historical_ticket_view: { ticket: { title: 'طلبي لم يصل', description: 'تفاصيل العميل' },
                                  customer_messages: [{ message: 'رسالتي الثانية', created_at: '2026-09-01T00:00:00Z' }],
                                  expires_at: '2026-10-15T10:00:00Z' }
    });
    const { page, context, errors } = await openCompanyDashboard(browser, baseUrl, fx);
    await openMembersSection(page);
    await page.waitForSelector('#companyHistoryBox:not([hidden])', { timeout: 5000 });
    assert.equal(await page.locator('#companyTransfersBox').isHidden(), true);
    assert.equal(await page.locator('[data-history="h2"] [data-history-ticket]').count(), 0, 'لا عرض قبل الموافقتين');
    // الغرض القصير مرفوض قبل الإرسال
    await page.locator('#companyHistoryCustomer').selectOption('u1');
    await page.locator('#companyHistoryPurpose').fill('قصير');
    await page.locator('#companyHistorySubmit').click();
    assert.equal(await page.locator('#companyHistoryError').isHidden(), false);
    await page.locator('#companyHistoryPurpose').fill('متابعة شكوى سابقة للعميل بخصوص طلبه');
    await page.locator('#companyHistorySubmit').click();
    await page.waitForFunction(() => (window.__RPC_CALLS__ || []).includes('historical_access_request'));
    const req = await page.evaluate(() => window.__RPC_ARGS__.filter(([n]) => n === 'historical_access_request').map(([, a]) => a));
    assert.deepEqual(req, [{ p_customer: 'u1', p_purpose: 'متابعة شكوى سابقة للعميل بخصوص طلبه' }]);
    await page.locator('[data-history="h1"] [data-history-ticket="tA"]').click();
    await page.waitForSelector('#companyHistoryView:not([hidden])');
    const view = await page.locator('#companyHistoryView').innerText();
    assert.match(view, /طلبي لم يصل/);
    assert.match(view, /رسالتي الثانية/);
    assert.match(view, /عرضك مسجَّل/);
    const viewArgs = await page.evaluate(() => window.__RPC_ARGS__.filter(([n]) => n === 'historical_ticket_view').map(([, a]) => a));
    assert.deepEqual(viewArgs, [{ p_request: 'h1', p_ticket: 'tA' }]);
    assert.equal(errors.length, 0, errors.join(' | '));
    await context.close();
});

/* ── 102: صندوق الرسائل ─────────────────────────────────────────────────── */

function inboxFixture(extra = {}) {
    const payload = companyPayload();
    payload.viewer_role = 'admin';
    return fixtures(payload, { rpc: { my_account_kind: 'company_admin', ...extra } });
}

const INBOX_LIST = {
    permissions: { assign: true, close: true },
    assignees: [{ id: 'ag1', name: 'موظف أ' }],
    conversations: [
        { id: 'cv1', subject: 'طلبي لم يصل', status: 'open', customer_name: 'عميل أول', assigned_to: null, assignee_name: null,
          last_sender_kind: 'customer', unread: true, last_message_at: '2026-10-14T10:00:00Z' }]
};
const INBOX_THREAD = {
    id: 'cv1', subject: 'طلبي لم يصل', status: 'open', customer_name: 'عميل أول', assigned_to: null, viewer: 'staff',
    can_reply: true, can_internal: true, can_assign: true, can_close: true,
    messages: [
        { id: 'm1', body: 'رقم الطلب 1234', sender_kind: 'customer', is_internal: false, created_at: '2026-10-14T09:00:00Z' },
        { id: 'm2', body: 'تحقق من الشحن', sender_kind: 'staff', sender_name: 'مشرف أ', is_internal: true, created_at: '2026-10-14T09:30:00Z' }]
};

test('102: بلا صندوق (المفتاح مطفأ أو بلا صلاحية): لا رابط في القائمة', async () => {
    const { page, context } = await openCompanyDashboard(browser, baseUrl, inboxFixture());
    await page.waitForFunction(() => (window.__RPC_CALLS__ || []).includes('company_inbox_summary'));
    await page.waitForTimeout(200);
    assert.equal(await page.locator('.sidebar-item[data-tab="inbox"]').isVisible(), false);
    await context.close();
});

test('102: الصندوق: الشارة، القائمة، الملاحظة الداخلية مميزة، الرد والإسناد والإغلاق عبر الدوال', async () => {
    const fx = inboxFixture({
        company_inbox_summary: { scope: 'all', open: 1, unread: 1 },
        company_inbox_list: INBOX_LIST,
        company_conversation_thread: INBOX_THREAD,
        company_conversation_post: { message_id: 'm3' },
        company_conversation_assign: { changed: true },
        company_conversation_set_status: { status: 'closed', changed: true }
    });
    const { page, context, errors } = await openCompanyDashboard(browser, baseUrl, fx);
    await page.locator('.sidebar-item[data-tab="inbox"]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.sidebar-item[data-tab="inbox"] .sidebar-badge').textContent(), '1');
    await page.evaluate(() => { window.location.hash = '#inbox'; });
    await page.waitForSelector('#inboxTabContent.active [data-inbox="cv1"]', { timeout: 5000 });
    assert.match(await page.locator('#companyInboxList').innerText(), /بانتظار الرد/);
    await page.locator('[data-inbox="cv1"]').click();
    await page.locator('#companyInboxThread').waitFor({ state: 'visible' });
    const thread = await page.locator('#companyInboxMessages').innerText();
    assert.match(thread, /ملاحظة داخلية لا يراها العميل/);
    // رد علني ثم ملاحظة داخلية
    await page.locator('#companyInboxReplyBody').fill('وصلنا طلبك');
    await page.locator('#companyInboxReplySubmit').click();
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).filter(([n]) => n === 'company_conversation_post').length === 1);
    await page.locator('#companyInboxReplyBody').fill('اتصلت بشركة الشحن');
    await page.locator('#companyInboxInternal').check();
    await page.locator('#companyInboxReplySubmit').click();
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).filter(([n]) => n === 'company_conversation_post').length === 2);
    const posts = await page.evaluate(() => window.__RPC_ARGS__.filter(([n]) => n === 'company_conversation_post').map(([, a]) => a));
    assert.deepEqual(posts, [{ p_conversation: 'cv1', p_body: 'وصلنا طلبك', p_internal: false },
                             { p_conversation: 'cv1', p_body: 'اتصلت بشركة الشحن', p_internal: true }]);
    await page.locator('#companyInboxAssign').selectOption('ag1');
    await page.waitForFunction(() => (window.__RPC_CALLS__ || []).includes('company_conversation_assign'));
    const assign = await page.evaluate(() => window.__RPC_ARGS__.filter(([n]) => n === 'company_conversation_assign').map(([, a]) => a));
    assert.deepEqual(assign, [{ p_conversation: 'cv1', p_assignee: 'ag1' }]);
    await page.locator('#companyInboxStatus').click();
    await page.waitForFunction(() => (window.__RPC_CALLS__ || []).includes('company_conversation_set_status'));
    const status = await page.evaluate(() => window.__RPC_ARGS__.filter(([n]) => n === 'company_conversation_set_status').map(([, a]) => a));
    assert.deepEqual(status, [{ p_conversation: 'cv1', p_status: 'closed' }]);
    assert.equal(errors.length, 0, errors.join(' | '));
    await context.close();
});

test('102: محادثة مغلقة بلا صلاحية ملاحظات: لا نموذج رد؛ ومعها: ملاحظة داخلية فقط', async () => {
    const closed = { ...INBOX_THREAD, status: 'closed', can_internal: false, can_assign: false, can_close: false };
    const fx = inboxFixture({
        company_inbox_summary: { scope: 'assigned', open: 0, unread: 0 },
        company_inbox_list: { ...INBOX_LIST, permissions: { assign: false, close: false }, assignees: [] },
        company_conversation_thread: closed
    });
    const { page, context } = await openCompanyDashboard(browser, baseUrl, fx);
    await page.evaluate(() => { window.location.hash = '#inbox'; });
    await page.waitForSelector('#inboxTabContent.active [data-inbox="cv1"]', { timeout: 5000 });
    await page.locator('[data-inbox="cv1"]').click();
    await page.locator('#companyInboxThread').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#companyInboxReply').isHidden(), true);
    assert.equal(await page.locator('#companyInboxAssign').count(), 0);
    assert.equal(await page.locator('#companyInboxStatus').count(), 0);
    await page.evaluate(() => { window.__FIXTURES__.rpc.company_conversation_thread = { ...window.__FIXTURES__.rpc.company_conversation_thread, can_internal: true }; });
    await page.locator('[data-inbox="cv1"]').click();
    await page.waitForFunction(() => !document.getElementById('companyInboxReply').hidden);
    assert.equal(await page.locator('#companyInboxInternal').isChecked(), true);
    assert.equal(await page.locator('#companyInboxInternal').isDisabled(), true);
    assert.equal((await page.locator('#companyInboxReplySubmit').textContent()).trim(), 'إضافة ملاحظة');
    await context.close();
});
