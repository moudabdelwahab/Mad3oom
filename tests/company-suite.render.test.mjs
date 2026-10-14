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

async function openDashboard(browser, baseUrl, { mutate = null, viewport = { width: 1440, height: 1100 }, hash = '' } = {}) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();

    const doubleSupabase = fs.readFileSync(path.join(ROOT, 'tests/fixtures/supabase-double.js'), 'utf8');
    const doubleAuth = fs.readFileSync(path.join(ROOT, 'tests/fixtures/auth-client-double.js'), 'utf8');
    await page.route('**/api-config.js', r => r.fulfill({ contentType: 'text/javascript; charset=utf-8', body: doubleSupabase }));
    await page.route('**/auth-client.js', r => r.fulfill({ contentType: 'text/javascript; charset=utf-8', body: doubleAuth }));
    await page.route('**/chat-widget.js', r => r.fulfill({ contentType: 'text/javascript', body: 'export default {};' }));
    await page.route('**/error-tracker.js', r => r.fulfill({ contentType: 'text/javascript', body: '' }));
    await page.route('https://fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));

    const data = fixtures();
    if (mutate) mutate(data);
    await page.addInitScript(fx => { window.__FIXTURES__ = fx; }, data);

    const visited = [];
    page.on('framenavigated', f => { if (f === page.mainFrame()) visited.push(f.url()); });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto(`${baseUrl}/company-dashboard/index.html${hash}`, { waitUntil: 'networkidle' });
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

/* ── النظرة العامة والتنقّل (صقل الواجهة) ─────────────────────────────── */

test('النظرة العامة تلخّص التذاكر بنفس عدّادات قسمَيها، والبطاقة تفتح القسم في مكانه', { skip: !chromiumPath }, async () => {
    const { page, context, visited, errors } = await openDashboard(browser, baseUrl);
    await page.waitForFunction(() => document.querySelectorAll('#companyOverviewTickets .company-stat').length === 3,
        null, { timeout: 10000 });

    const values = await page.locator('#companyOverviewTickets .company-stat-value').allInnerTexts();
    // tk-1 مفتوحة و tk-2 محلولة مع مدعوم؛ tk-3 مفتوحة من عميل
    assert.deepEqual(values.map(v => v.trim()), ['1', '0', '1']);
    assert.match(await page.locator('#companyOverviewTickets').innerText(), /من 2 تذكرة مع فريق مدعوم/);

    await page.locator('#companyOverviewTickets .company-stat[data-tab="tickets"]').first().click();
    await page.waitForSelector('#ticketsTabContent.active', { timeout: 10000 });
    // عدّاد «مفتوحة» في القسم هو نفسه رقم النظرة العامة
    const openTab = await page.locator('#ticketsTabContent .view-tab[data-stream-view="open"] .view-tab-count').innerText();
    assert.equal(openTab.trim(), values[0].trim());
    assert.deepEqual(visited.map(u => new URL(u).pathname)
        .filter(p => !p.startsWith('/company-dashboard/')), [], 'غادرت البطاقة اللوحة بدل تبديل القسم');
    assert.equal(errors.length, 0, errors.join(' | '));
    await context.close();
});

test('قراءة تذاكر فاشلة لا تُعرض صفرًا في النظرة العامة', { skip: !chromiumPath }, async () => {
    const { page, context } = await openDashboard(browser, baseUrl, {
        mutate: fx => { fx.tableErrors = { tickets: 'permission denied' }; }
    });
    await page.waitForFunction(() => document.querySelectorAll('#companyOverviewTickets .company-stat').length === 3,
        null, { timeout: 10000 });

    const values = await page.locator('#companyOverviewTickets .company-stat-value').allInnerTexts();
    assert.deepEqual(values.map(v => v.trim()), ['—', '—', '—'], 'ظهر رقم لقراءة فشلت');
    assert.match(await page.locator('#companyOverviewTickets').innerText(), /تعذّر التحميل/);

    // والتقارير لا تُبنى على قوائم لم تُقرأ
    await openSection(page, 'reports');
    await page.waitForSelector('#companyReports .state-block', { timeout: 10000 });
    assert.match(await page.locator('#companyReports').innerText(), /تعذّر بناء التقارير/);
    assert.equal(await page.locator('#companyReports .report-table').count(), 0);
    await context.close();
});

test('الإجراءات السريعة تشير لصفحات ظاهرة في القائمة ومتاحة لهذا الدور فقط', { skip: !chromiumPath }, async () => {
    const actionTabs = page => page.locator('#companyQuickActions .company-action').evaluateAll(
        links => links.map(a => a.getAttribute('data-tab')));
    // المدير: كل اختصار يطابق عنصرًا ظاهرًا في القائمة الجانبية، ولا صندوق رسائل بلا صندوق من القاعدة
    {
        const { page, context } = await openDashboard(browser, baseUrl);
        await page.waitForSelector('#companyQuickActions .company-action', { timeout: 10000 });
        const tabs = await actionTabs(page);
        assert.ok(tabs.length >= 3 && tabs.length <= 4, `عدد الاختصارات ${tabs.length}`);
        assert.ok(tabs.includes('support'));
        assert.ok(!tabs.includes('inbox'), 'اختصار صندوق رسائل بلا صندوق من القاعدة');
        for (const tab of tabs) {
            assert.equal(await page.locator(`.sidebar-item[data-tab="${tab}"]:visible`).count(), 1,
                `اختصار لصفحة غير ظاهرة في القائمة: ${tab}`);
        }
        await context.close();
    }
    // موظف الدعم: لا اختصار ولا رابط لصفحات المدير
    {
        const { page, context } = await openDashboard(browser, baseUrl, {
            mutate: fx => { fx.rpc.get_my_company_dashboard.viewer_role = 'agent'; }
        });
        await page.waitForSelector('#companyQuickActions .company-action', { timeout: 10000 });
        const tabs = await actionTabs(page);
        for (const adminPage of ['api', 'subscriptions', 'permissions', 'accessLog', 'customers']) {
            assert.ok(!tabs.includes(adminPage), `موظف الدعم يرى اختصار ${adminPage}`);
            assert.equal(await page.locator(`.sidebar-item[data-tab="${adminPage}"]:visible`).count(), 0,
                `موظف الدعم يرى رابط ${adminPage} في القائمة`);
        }
        await context.close();
    }
});

test('مسار التنقّل وعنوان التبويب يتبعان الصفحة، والعنصر النشط معلَن للقارئ الصوتي', { skip: !chromiumPath }, async () => {
    const { page, context } = await openDashboard(browser, baseUrl);
    const crumbs = () => page.locator('#companyCrumbs li').allInnerTexts();
    assert.deepEqual((await crumbs()).map(t => t.trim()), ['لوحة الشركة', 'نظرة عامة']);
    assert.equal(await page.locator('.sidebar-item[data-tab="overview"]').getAttribute('aria-current'), 'page');

    await openSection(page, 'members');
    assert.deepEqual((await crumbs()).map(t => t.trim()), ['لوحة الشركة', 'الفريق والصلاحيات', 'أعضاء الفريق']);
    assert.match(await page.title(), /^أعضاء الفريق · لوحة الشركة/);
    assert.equal(await page.locator('.sidebar-item[aria-current="page"]').count(), 1);
    assert.equal(await page.locator('.sidebar-item[data-tab="members"]').getAttribute('aria-current'), 'page');
    // علامة المستوى باقية: اللوحة تعلن أنها سياق شركة
    assert.match(await page.locator('.company-level-tag').innerText(), /لوحة الشركة/);
    await context.close();
});

test('لا تمرير أفقي في أقسام اللوحة على الجوال واللوحي والحاسوب', { skip: !chromiumPath }, async () => {
    const sections = ['overview', 'tickets', 'customerTickets', 'support', 'members', 'customers',
        'permissions', 'accessLog', 'subscriptions', 'entitlements', 'usage', 'integrations', 'api',
        'reports', 'activity', 'notifications', 'company', 'profile', 'security'];
    for (const width of [390, 768, 1440]) {
        const { page, context } = await openDashboard(browser, baseUrl, { viewport: { width, height: 900 } });
        for (const section of sections) {
            await page.evaluate(s => { window.location.hash = s; }, section);
            await page.waitForSelector(`#${section}TabContent.active`, { timeout: 10000 });
            await page.waitForTimeout(250);
            const overflow = await page.evaluate(() =>
                document.documentElement.scrollWidth - document.documentElement.clientWidth);
            assert.ok(overflow <= 0, `تمرير أفقي ${overflow}px في «${section}» على عرض ${width}`);
        }
        await context.close();
    }
});

/* ── صفحات مستقلة: التنقّل والتحميل عند الحاجة والقدرات المكشوفة ───────── */

const rpcCalls = page => page.evaluate(() => window.__RPC_CALLS__ || []);

test('كل صفحة حاوية مستقلة: صفحة واحدة نشطة، ورأس المجال يبدّل بين الشقيقات، والرجوع يعمل', { skip: !chromiumPath }, async () => {
    const { page, context, visited } = await openDashboard(browser, baseUrl);
    await openSection(page, 'members');
    assert.equal(await page.locator('#companyContent .tab-content.active').count(), 1);
    assert.equal(await page.locator('#companyPageHead').isHidden(), false);
    assert.match(await page.locator('.company-page-title').innerText(), /الفريق والصلاحيات/);

    // الشريط الشقيق ينقل إلى «عملاء الشركة» في مكانها
    await page.locator('.company-subnav a[data-tab="customers"]').click();
    await page.waitForSelector('#customersTabContent.active', { timeout: 10000 });
    assert.equal(await page.locator('.company-subnav a[aria-current="page"]').getAttribute('data-tab'), 'customers');
    assert.equal(await page.locator('#membersTabContent').isVisible(), false, 'صفحتان معروضتان معًا');

    // زر الرجوع في المتصفح يعيد الصفحة السابقة ثم النظرة العامة
    await page.goBack();
    await page.waitForSelector('#membersTabContent.active', { timeout: 10000 });
    await page.goBack();
    await page.waitForSelector('#overviewTabContent.active', { timeout: 10000 });
    await page.goForward();
    await page.waitForSelector('#membersTabContent.active', { timeout: 10000 });
    assert.deepEqual(visited.map(u => new URL(u).pathname).filter(p => !p.startsWith('/company-dashboard/')), []);
    await context.close();
});

test('النظرة العامة مختصرة ولا تجلب بيانات الصفحات الأخرى عند البدء', { skip: !chromiumPath }, async () => {
    const { page, context } = await openDashboard(browser, baseUrl);
    await page.waitForFunction(() => document.querySelectorAll('#companyOverviewTickets .company-stat').length === 3,
        null, { timeout: 10000 });
    // لا بيانات شركة كاملة ولا أعضاء ولا اشتراكات مفصّلة في النظرة العامة
    assert.equal(await page.locator('#overviewTabContent #companyProfileBody').count(), 0);
    assert.equal(await page.locator('#overviewTabContent .company-sub-list').count(), 0);
    const startup = await rpcCalls(page);
    // (my_ticket_wallet تقرؤه شارة الرصيد في الشريط العلوي المشترك منذ 065 — ليس من النظرة العامة)
    for (const rpc of ['company_members', 'company_staff_list', 'company_customers_list',
                       'company_permissions_matrix', 'company_access_log']) {
        assert.ok(!startup.includes(rpc), `النظرة العامة جلبت ${rpc} قبل فتح صفحته`);
    }
    // تُجلب عند فتح صفحتها
    await openSection(page, 'members');
    await page.waitForFunction(() => (window.__RPC_CALLS__ || []).includes('company_members'), null, { timeout: 10000 });
    await context.close();
});

test('رابط مباشر إلى «الاستخدام والحدود» يحمّل الرصيد من my_ticket_wallet كما هو', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openDashboard(browser, baseUrl, {
        hash: '#usage',
        mutate: fx => {
            fx.rpc.my_ticket_wallet = { plan_key: 'support', plan_name_ar: 'باقة الدعم', is_free: false,
                shared_account: true, unlimited: false, monthly_limit: 30, used: 7, remaining: 23,
                billing_used: 1, billing_limit: 5, resets_at: iso(12) };
        }
    });
    await page.waitForSelector('#usageTabContent.active .company-usage', { timeout: 10000 });
    const text = await page.locator('#companyUsage').innerText();
    assert.match(text, /23/);
    assert.match(text, /تذكرة متبقية من 30/);
    assert.match(text, /1 من 5 هذا الشهر/);
    assert.match(text, /مشترك لحساب الشركة كله/);
    assert.equal(await page.locator('#companyUsage [role="progressbar"]').getAttribute('aria-valuenow'), '7');
    assert.deepEqual((await page.locator('#companyCrumbs li').allInnerTexts()).map(t => t.trim()),
        ['لوحة الشركة', 'الاشتراك والفوترة', 'الاستخدام والحدود']);
    assert.equal(errors.length, 0, errors.join(' | '));
    await context.close();
});

test('فشل قراءة الرصيد يُعرض خطأً لا رقمًا، وإعادة المحاولة تقرأ من جديد', { skip: !chromiumPath }, async () => {
    const { page, context } = await openDashboard(browser, baseUrl, {
        hash: '#usage',
        mutate: fx => { fx.rpcErrors = { my_ticket_wallet: 'boom' }; }
    });
    await page.waitForSelector('#companyUsage .state-block--error', { timeout: 10000 });
    assert.doesNotMatch(await page.locator('#companyUsage').innerText(), /متبقية|\b0\b/);
    await page.evaluate(() => { window.__FIXTURES__.rpcErrors = {};
        window.__FIXTURES__.rpc.my_ticket_wallet = { plan_key: 'support', unlimited: true, used: 4, resets_at: null }; });
    await page.locator('#companyUsageRetry').click();
    await page.waitForSelector('#companyUsage .company-usage', { timeout: 10000 });
    assert.match(await page.locator('#companyUsage').innerText(), /غير محدود/);
    await context.close();
});

test('الأدوار والصلاحيات: للقراءة فقط والميزة مطفأة، والتعديل عبر RPC حين تُفعَّل، والرفض يعيد القيمة', { skip: !chromiumPath }, async () => {
    const matrix = (enabled) => ({ enabled, catalog: [
        { key: 'tickets.assign', label: 'إسناد التذاكر', description: 'توزيع التذاكر', supervisor: true, agent: false }
    ], overrides: [] });

    // مطفأة: شارات نصية بلا أي مفتاح تعديل
    {
        const { page, context } = await openDashboard(browser, baseUrl, {
            hash: '#permissions', mutate: fx => { fx.rpc.company_permissions_matrix = matrix(false); }
        });
        await page.waitForSelector('#companyPermissions .company-matrix', { timeout: 10000 });
        assert.equal(await page.locator('#companyPermissions input[type="checkbox"]').count(), 0);
        assert.match(await page.locator('#companyPermissions').innerText(), /للقراءة فقط/);
        await context.close();
    }
    // مفعّلة: المفتاح يرسل الدور والصلاحية والقيمة فقط
    {
        const { page, context } = await openDashboard(browser, baseUrl, {
            hash: '#permissions', mutate: fx => {
                fx.rpc.company_permissions_matrix = matrix(true);
                fx.rpc.company_set_role_permission = { role: 'agent', permission: 'tickets.assign', allowed: true };
            }
        });
        const agentSwitch = page.locator('input[data-perm-role="agent"][data-perm-key="tickets.assign"]');
        await agentSwitch.waitFor({ timeout: 10000 });
        assert.equal(await agentSwitch.isChecked(), false);
        await agentSwitch.check();
        await page.waitForFunction(() => (window.__RPC_CALLS__ || []).includes('company_set_role_permission'));
        const args = await page.evaluate(() => window.__RPC_ARGS__.filter(([n]) => n === 'company_set_role_permission').map(([, a]) => a));
        assert.deepEqual(args, [{ p_role: 'agent', p_key: 'tickets.assign', p_allowed: true }]);

        // القاعدة ترفض: القيمة تعود كما كانت
        await page.evaluate(() => { window.__FIXTURES__.rpcErrors = { company_set_role_permission: 'disabled' }; });
        const supervisorSwitch = page.locator('input[data-perm-role="supervisor"][data-perm-key="tickets.assign"]');
        // click لا uncheck: الواجهة تعيد القيمة فور رفض القاعدة، وهذا المطلوب إثباته
        await supervisorSwitch.click();
        await page.waitForFunction(() => window.__RPC_CALLS__.filter(n => n === 'company_set_role_permission').length === 2);
        await page.waitForFunction(() => !document.querySelector('input[data-perm-role="supervisor"]').disabled);
        assert.equal(await supervisorSwitch.isChecked(), true, 'بقيت قيمة رفضتها القاعدة');
        await context.close();
    }
});

test('سجل وصول مدعوم: صفوف المنح كما رجّعتها القاعدة، وفراغ صريح بلا منح', { skip: !chromiumPath }, async () => {
    {
        const { page, context } = await openDashboard(browser, baseUrl, {
            hash: '#accessLog', mutate: fx => {
                fx.rpc.company_access_log = [{ grant_id: 'g1', requester_kind: 'support', ticket_id: 'tk-3',
                    starts_at: iso(-6), expires_at: iso(-5), revoked_at: null, reads: 3 }];
            }
        });
        await page.waitForSelector('#companyAccessLog table', { timeout: 10000 });
        const row = await page.locator('#companyAccessLog tbody tr').first().innerText();
        assert.match(row, /فريق دعم مدعوم/);
        assert.match(row, /تذكرة محددة/);
        assert.match(row, /انتهى/);
        assert.match(row, /3/);
        await context.close();
    }
    {
        const { page, context } = await openDashboard(browser, baseUrl, {
            hash: '#accessLog', mutate: fx => { fx.rpc.company_access_log = []; }
        });
        await page.waitForSelector('#companyAccessLog .state-block', { timeout: 10000 });
        assert.match(await page.locator('#companyAccessLog').innerText(), /لا يوجد أي وصول مسجّل/);
        await context.close();
    }
});

test('رابط مباشر لصفحة مدير يعيد موظف الدعم إلى النظرة العامة بلا نداء لبياناتها', { skip: !chromiumPath }, async () => {
    for (const hash of ['#permissions', '#accessLog', '#subscriptions', '#api']) {
        const { page, context } = await openDashboard(browser, baseUrl, {
            hash, mutate: fx => { fx.rpc.get_my_company_dashboard.viewer_role = 'agent'; }
        });
        await page.waitForSelector('#overviewTabContent.active', { timeout: 10000 });
        assert.equal(new URL(page.url()).hash, '#overview', `${hash} لم يُصحَّح`);
        const calls = await rpcCalls(page);
        assert.ok(!calls.includes('company_permissions_matrix') && !calls.includes('company_access_log'),
            `${hash}: نداء لبيانات صفحة مدير`);
        await context.close();
    }
});

test('إلغاء طلب اشتراك قيد المراجعة: بعد التأكيد فقط، والفشل لا يُعرض نجاحًا', { skip: !chromiumPath }, async () => {
    const withPending = fx => {
        fx.rpc.get_my_company_dashboard.subscriptions.push({ id: 's-pend', plan: 'whatsapp', plan_name_ar: 'واتساب بيزنس',
            status: 'pending', billing_cycle: 'monthly', start_date: null, end_date: null, is_active: false, days_remaining: null });
    };
    // رفض القاعدة (false): لا نجاح، والزر يعود متاحًا
    const { page, context } = await openDashboard(browser, baseUrl, {
        hash: '#subscriptions', mutate: fx => { withPending(fx); fx.rpc.cancel_my_subscription_request = false; }
    });
    const btn = page.locator('[data-cancel-subscription="s-pend"]');
    await btn.waitFor({ timeout: 10000 });
    // لا زر إلغاء لاشتراك ليس قيد المراجعة
    assert.equal(await page.locator('[data-cancel-subscription]').count(), 1);

    // التراجع في الحوار لا يرسل شيئًا
    await btn.click();
    await page.locator('.ui-dialog button', { hasText: 'رجوع' }).click();
    assert.ok(!(await rpcCalls(page)).includes('cancel_my_subscription_request'));

    await btn.click();
    await page.locator('.ui-dialog button', { hasText: 'إلغاء الطلب' }).click();
    await page.waitForFunction(() => (window.__RPC_CALLS__ || []).includes('cancel_my_subscription_request'));
    const args = await page.evaluate(() => window.__RPC_ARGS__.filter(([n]) => n === 'cancel_my_subscription_request').map(([, a]) => a));
    assert.deepEqual(args, [{ p_subscription_id: 's-pend' }]);
    await page.waitForFunction(() => !document.querySelector('[data-cancel-subscription="s-pend"]')?.disabled);
    assert.doesNotMatch(await page.locator('#ui-toast-container').innerText(), /أُلغي طلب الاشتراك/);
    assert.match(await page.locator('#ui-toast-container').innerText(), /تعذّر إلغاء الطلب/);
    await context.close();
});

test('تنبيه اشتراك قارب على الانتهاء في النظرة العامة يشير إلى صفحة الاشتراكات', { skip: !chromiumPath }, async () => {
    const { page, context } = await openDashboard(browser, baseUrl);
    await page.waitForSelector('#companyAlerts .company-alert', { timeout: 10000 });
    const alert = page.locator('#companyAlerts .company-alert', { hasText: 'باقة الدعم ينتهي قريبًا' });
    assert.equal(await alert.count(), 1);
    await alert.locator('a[data-tab="subscriptions"]').click();
    await page.waitForSelector('#subscriptionsTabContent.active', { timeout: 10000 });
    await context.close();
});
