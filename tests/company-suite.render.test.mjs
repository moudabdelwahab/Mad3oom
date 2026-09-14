/**
 * اختبارات عرض في متصفح فعلي لأقسام: الاشتراكات، التقارير وتصديرها،
 * ومستخدمي الشركة بأدوارهم الجديدة.
 *
 * الحمولة هنا تحاكي **الحالة القائمة على الإنتاج** حرفيًا، ومنها اشتراك
 * bundle تبدأ مدّته في المستقبل وحالته 'active' — وهو ما كان يُعرض «منتهٍ».
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

const USER_ID = '11111111-1111-4111-8111-111111111111';
const COMPANY_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
const day = 86400000;
const iso = (offsetDays) => new Date(Date.now() + offsetDays * day).toISOString();

function companyPayload() {
    return {
        company: {
            id: COMPANY_ID, name: 'شركة النور التجارية', cr_number: '1010101010',
            cr_expiry: iso(400), status: 'active', email: null, phone: null, address: null,
            city: null, country: null, website: null, industry: null, tax_id: null,
            created_at: iso(-400), is_owner: true
        },
        registration: { expiry_date: iso(400), is_expired: false, days_to_expiry: 400 },
        subscriptions: [
            // الحالة الحقيقية: يبدأ بعد يومين، حالته active و is_active=false
            { id: 's-future', plan: 'bundle', plan_name_ar: 'الباقة الشاملة', status: 'active',
              billing_cycle: 'yearly', start_date: iso(2), end_date: iso(1500),
              is_active: false, days_remaining: 1500 },
            // اشتراك فعّال قارب على الانتهاء
            { id: 's-now', plan: 'support', plan_name_ar: 'باقة الدعم', status: 'active',
              billing_cycle: 'monthly', start_date: iso(-20), end_date: iso(7),
              is_active: true, days_remaining: 7 },
            // منتهٍ فعلًا
            { id: 's-old', plan: 'whatsapp', plan_name_ar: 'واتساب بيزنس', status: 'expired',
              billing_cycle: 'monthly', start_date: iso(-90), end_date: iso(-30),
              is_active: false, days_remaining: 0 }
        ],
        entitlements: [
            { feature_key: 'sub_users', name_ar: 'المستخدمون الفرعيون', description: '', limits: {}, granted_by: ['support'] },
            { feature_key: 'api_tokens', name_ar: 'مفاتيح API', description: '', limits: {}, granted_by: ['support'] }
        ],
        access: { active_plans: ['support'], has_active_subscription: true }
    };
}

function fixtures() {
    return {
        user: { id: USER_ID, email: 'owner@company.test' },
        authUser: { id: USER_ID, email: 'owner@company.test',
                    profile: { id: USER_ID, full_name: 'مدير الشركة', role: 'company_admin' } },
        rpc: {
            get_my_company_dashboard: companyPayload(),
            current_company_id: COMPANY_ID,
            company_has_feature: true,
            company_members: {
                company_id: COMPANY_ID, company_role: 'company_admin', is_owner: true, can_manage: true,
                members: [
                    { id: USER_ID, name: 'مدير الشركة', email: 'owner@company.test',
                      role: 'company_admin', is_owner: true, is_me: true, created_at: iso(-400) },
                    { id: MEMBER_ID, name: 'موظف الدعم', email: 'staff@company.test',
                      role: 'company_user', is_owner: false, is_me: false, created_at: iso(-30) }
                ]
            }
        },
        functions: {},
        tables: {
            profiles: [
                { id: USER_ID, email: 'owner@company.test', full_name: 'مدير الشركة', role: 'company_admin', super_user_id: null },
                { id: MEMBER_ID, email: 'staff@company.test', full_name: 'موظف الدعم', role: 'company_user', super_user_id: USER_ID }
            ],
            tickets: [
                { id: 'tk-1', user_id: USER_ID, ticket_number: 101, title: 'مشكلة فوترة',
                  status: 'open', priority: 'high', category: 'billing', created_at: iso(-10),
                  first_response_at: iso(-9), resolved_at: null, archived_by_customer: false },
                { id: 'tk-2', user_id: USER_ID, ticket_number: 102, title: 'استفسار',
                  status: 'resolved', priority: 'low', category: 'general', created_at: iso(-40),
                  first_response_at: iso(-39), resolved_at: iso(-38), archived_by_customer: false },
                { id: 'tk-3', user_id: MEMBER_ID, ticket_number: 201, title: 'طلب من عميلي',
                  status: 'open', priority: 'medium', category: 'technical', created_at: iso(-5),
                  first_response_at: iso(-4), resolved_at: null, archived_by_customer: false }
            ],
            ticket_replies: [], api_tokens: [], api_token_usage_logs: [],
            notifications: [], services: [], whatsapp_subscriptions: [], subscription_plans: [],
            activity_log: []
        }
    };
}

async function openDashboard(browser, baseUrl) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    const page = await context.newPage();

    const doubleSupabase = fs.readFileSync(path.join(ROOT, 'tests/fixtures/supabase-double.js'), 'utf8');
    const doubleAuth = fs.readFileSync(path.join(ROOT, 'tests/fixtures/auth-client-double.js'), 'utf8');
    await page.route('**/api-config.js', r => r.fulfill({ contentType: 'text/javascript; charset=utf-8', body: doubleSupabase }));
    await page.route('**/auth-client.js', r => r.fulfill({ contentType: 'text/javascript; charset=utf-8', body: doubleAuth }));
    await page.route('**/chat-widget.js', r => r.fulfill({ contentType: 'text/javascript', body: 'export default {};' }));
    await page.route('**/error-tracker.js', r => r.fulfill({ contentType: 'text/javascript', body: '' }));
    await page.route('https://fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));

    await page.addInitScript(data => { window.__FIXTURES__ = data; }, fixtures());

    const visited = [];
    page.on('framenavigated', f => { if (f === page.mainFrame()) visited.push(f.url()); });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto(`${baseUrl}/company-dashboard/index.html`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => !document.getElementById('companyContent')?.hidden
        || !!document.querySelector('#companyGateBody .state-block'), null, { timeout: 10000 });
    return { page, context, visited, errors };
}

async function openSection(page, tab) {
    await page.locator(`.sidebar-item[data-tab="${tab}"]`).click();
    await page.waitForSelector(`#${tab}TabContent.active`, { timeout: 10000 });
}

function resolveChromium() {
    try { const p = chromium.executablePath(); if (p && fs.existsSync(p)) return p; } catch { /* no download */ }
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

let browser, server, baseUrl;
const chromiumPath = resolveChromium();
if (!chromiumPath) console.error('SKIP: لا يوجد متصفح Chromium؛ اختبارات حزمة لوحة الشركة لم تُنفَّذ');

test.before(async () => {
    if (!chromiumPath) return;
    server = await startServer();
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: chromiumPath });
});
test.after(async () => { await browser?.close(); server?.close(); });

/* ── الاشتراكات ─────────────────────────────────────────────────────────── */

test('اشتراك لم تبدأ مدّته يُعرض «لم يبدأ بعد» لا «منتهٍ»', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openDashboard(browser, baseUrl);
    await openSection(page, 'subscriptions');
    await page.waitForSelector('#companySubscriptions .company-sub', { timeout: 10000 });

    const rows = await page.locator('#companySubscriptions .company-sub').allInnerTexts();
    const future = rows.find(r => r.includes('الباقة الشاملة'));
    assert.ok(future, 'صفّ الباقة المستقبلية غائب');
    assert.match(future, /لم يبدأ بعد/, 'الاشتراك المستقبلي ما زال يُعرض منتهيًا');
    assert.ok(!/^(?!.*لم يبدأ).*منتهٍ/.test(future), 'ظهر «منتهٍ» على اشتراك لم يبدأ');
    assert.match(future, /يبدأ بعد \d+ يومًا/);

    // والمنتهي فعلًا ما زال يُعرض منتهيًا
    const old = rows.find(r => r.includes('واتساب بيزنس'));
    assert.match(old, /منتهٍ/);
    assert.equal(errors.length, 0, errors.join(' | '));
    await context.close();
});

test('التضارب في التواريخ مشروح بأثره لا برمز تقني', { skip: !chromiumPath }, async () => {
    const { page, context } = await openDashboard(browser, baseUrl);
    await openSection(page, 'subscriptions');
    await page.waitForSelector('#companySubIssuesHeading', { timeout: 10000 });

    const text = await page.locator('#subscriptionsTabContent').innerText();
    assert.match(text, /ملاحظات على التواريخ/);
    assert.match(text, /لم تبدأ مدّته بعد/);
    assert.ok(!text.includes('future_start'), 'ظهر رمز تقني بدل شرح');
    await context.close();
});

test('اشتراك قارب على الانتهاء يُميَّز، والأيام من حساب القاعدة', { skip: !chromiumPath }, async () => {
    const { page, context } = await openDashboard(browser, baseUrl);
    await openSection(page, 'subscriptions');
    await page.waitForSelector('#companySubscriptions .company-sub', { timeout: 10000 });

    const rows = await page.locator('#companySubscriptions .company-sub').allInnerTexts();
    const soon = rows.find(r => r.includes('باقة الدعم'));
    assert.match(soon, /ينتهي قريبًا/);
    assert.match(soon, /7 يوم متبقٍ/, 'الأيام لا تطابق days_remaining القادم من القاعدة');
    await context.close();
});

test('بطاقات النظرة العامة والاشتراكات تقرآن من مصدر واحد', { skip: !chromiumPath }, async () => {
    const { page, context } = await openDashboard(browser, baseUrl);
    const overview = await page.locator('#companyKpis').innerText();
    await openSection(page, 'subscriptions');
    await page.waitForSelector('#companySubscriptions .kpi', { timeout: 10000 });
    const subs = await page.locator('#companySubscriptions .kpi-grid').innerText();

    // اشتراك فعّال واحد فقط (الآخر لم يبدأ، والثالث منتهٍ)
    assert.match(overview, /اشتراكات فعّالة\s*\n?\s*1/);
    assert.match(subs, /اشتراكات نشطة\s*\n?\s*1/);
    await context.close();
});

/* ── التقارير والتصدير ──────────────────────────────────────────────────── */

test('التقارير تفصل المسارين ولا تجمعهما', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openDashboard(browser, baseUrl);
    await openSection(page, 'reports');
    await page.waitForSelector('#companyReports .report-table', { timeout: 10000 });

    const text = await page.locator('#reportsTabContent').innerText();
    assert.match(text, /تذاكري مع مدعوم/);
    assert.match(text, /تذاكر عملائي/);
    assert.match(text, /التوزيع حسب الحالة/);
    assert.match(text, /التوزيع حسب الأولوية/);
    assert.match(text, /التوزيع حسب الفترة/);
    assert.match(text, /التذاكر حسب العميل/);
    assert.match(text, /متوسط زمن الإغلاق/);
    assert.match(text, /لا بيانات شركة أخرى/);
    assert.equal(errors.length, 0, errors.join(' | '));
    await context.close();
});

test('تصفية الفترة تغيّر الأرقام في مكانها بلا مغادرة', { skip: !chromiumPath }, async () => {
    const { page, context, visited } = await openDashboard(browser, baseUrl);
    await openSection(page, 'reports');
    await page.waitForSelector('#reportFrom', { timeout: 10000 });

    const before = await page.locator('#companyReports .report-table').first().innerText();
    // نطاق لا يشمل إلا تذكرة واحدة (آخر 7 أيام)
    await page.locator('#reportFrom').fill(new Date(Date.now() - 7 * day).toISOString().slice(0, 10));
    await page.locator('#reportFrom').dispatchEvent('change');
    await page.waitForFunction(
        prev => document.querySelector('#companyReports .report-table')?.innerText !== prev,
        before, { timeout: 10000 });

    const after = await page.locator('#companyReports .report-table').first().innerText();
    assert.notEqual(after, before, 'التصفية لم تغيّر شيئًا');
    assert.deepEqual(visited.map(u => new URL(u).pathname)
        .filter(p => !p.startsWith('/company-dashboard/')), [], 'غادرت اللوحة عند التصفية');
    await context.close();
});

test('تصدير CSV ينزّل ملفًا يبدأ بـBOM وتُقرأ عربيته', { skip: !chromiumPath }, async () => {
    const { page, context } = await openDashboard(browser, baseUrl);
    await openSection(page, 'reports');
    await page.waitForSelector('[data-export="csv"]', { timeout: 10000 });

    const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 15000 }),
        page.locator('[data-export="csv"]').click()
    ]);
    assert.match(download.suggestedFilename(), /^tickets-report-\d{4}-\d{2}-\d{2}\.csv$/);

    const stream = await download.createReadStream();
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    const text = Buffer.concat(chunks).toString('utf8');

    assert.ok(text.startsWith('﻿'), 'الملف بلا BOM فتظهر العربية مشوّهة في Excel');
    assert.match(text, /## الملخّص/);
    assert.match(text, /إجمالي التذاكر/);
    assert.match(text, /تذاكري مع مدعوم/);
    // نطاق البيانات محصور بالشركة: لا أثر لأي جدول أو معرّف خارجها
    assert.ok(!text.includes('secret'), 'تسرّب محتوى غير متوقع إلى التصدير');
    await context.close();
});

test('أزرار التصدير الثلاثة معروضة', { skip: !chromiumPath }, async () => {
    const { page, context } = await openDashboard(browser, baseUrl);
    await openSection(page, 'reports');
    await page.waitForSelector('[data-export="csv"]', { timeout: 10000 });
    for (const format of ['csv', 'xlsx', 'pdf']) {
        assert.equal(await page.locator(`[data-export="${format}"]`).count(), 1, `زر ${format} غائب`);
    }
    await context.close();
});

/* ── المستخدمون وأدوارهم ────────────────────────────────────────────────── */

test('قائمة المستخدمين تعرض الدور الفعلي لكل عضو', { skip: !chromiumPath }, async () => {
    const { page, context } = await openDashboard(browser, baseUrl);
    await openSection(page, 'members');
    await page.waitForSelector('#companyMembers .company-sub', { timeout: 10000 });

    const text = await page.locator('#companyMembers').innerText();
    assert.match(text, /مدير الشركة/);
    assert.match(text, /مستخدم الشركة/);
    // شارة دور الحساب الحالي
    assert.equal(await page.locator('#companyRoleBadge').isHidden(), false);
    assert.match(await page.locator('#companyRoleBadge').textContent(), /مدير الشركة/);
    await context.close();
});

test('زر الإزالة يظهر للعضو وحده — لا للمدير ولا لصاحب الحساب', { skip: !chromiumPath }, async () => {
    const { page, context } = await openDashboard(browser, baseUrl);
    await openSection(page, 'members');
    await page.waitForSelector('#companyMembers .company-sub', { timeout: 10000 });

    assert.equal(await page.locator('[data-remove-member]').count(), 1,
        'عدد أزرار الإزالة لا يطابق عدد الأعضاء القابلين للإزالة');
    assert.equal(await page.locator(`[data-remove-member="${MEMBER_ID}"]`).count(), 1);
    assert.equal(await page.locator(`[data-remove-member="${USER_ID}"]`).count(), 0,
        'ظهر زر إزالة لمدير الشركة نفسه');
    await context.close();
});

test('لا رابط يغادر لوحة الشركة إلى بوابة العميل أو لوحة الإدارة', { skip: !chromiumPath }, async () => {
    const { page, context } = await openDashboard(browser, baseUrl);
    for (const tab of ['subscriptions', 'reports', 'members']) await openSection(page, tab);

    const hrefs = await page.locator('#companyMain a[href], #sidebar-container a[href]')
        .evaluateAll(els => els.map(e => e.getAttribute('href')));
    for (const href of hrefs) {
        assert.ok(!/customer-dashboard/.test(href || ''), `رابط إلى بوابة العميل: ${href}`);
        assert.ok(!/^\/admin\//.test(href || ''), `رابط إلى لوحة الإدارة: ${href}`);
    }
    await context.close();
});
