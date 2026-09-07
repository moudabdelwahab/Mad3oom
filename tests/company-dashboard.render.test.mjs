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

test('مدخل لوحة الشركة في القائمة يظهر لصاحب الشركة فقط', async () => {
    const withCompany = await openCompanyDashboard(browser, baseUrl, fixtures(companyPayload()));
    await withCompany.page.waitForFunction(
        () => document.getElementById('companyDashboardLink')?.hidden === false,
        null, { timeout: 10000 }
    );
    assert.equal(await withCompany.page.locator('#companyDashboardLink').isHidden(), false);
    await withCompany.context.close();

    const without = await openCompanyDashboard(browser, baseUrl, fixtures(null));
    assert.equal(await without.page.locator('#companyDashboardLink').isHidden(), true,
        'مدخل لوحة الشركة ظهر لمن لا شركة له');
    await without.context.close();
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
