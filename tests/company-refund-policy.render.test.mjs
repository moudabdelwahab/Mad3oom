/**
 * اختبارات صفحة «سياسة الإلغاء والاسترداد» داخل لوحة الشركة في متصفح فعلي.
 *
 * ما تحرسه هذه الاختبارات:
 *   • الصفحة تفتح من القائمة الجانبية وتعرض النص الكامل للسياسة (11 قسمًا).
 *   • روابط التنبيه في الأعلى تبقى داخل اللوحة (الاشتراكات والدعم).
 *   • رابط السياسة في نافذة الإلغاء يغلق النافذة بلا إلغاء وينقل لقسم السياسة،
 *     ولا ينادي دالة الإلغاء إطلاقًا.
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

const USER_ID = '11111111-1111-1111-1111-111111111111';
const COMPANY_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

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
        entitlements: [
            { feature_key: 'api_tokens', name_ar: 'مفاتيح API', description: '', limits: {}, granted_by: ['bundle'] }
        ],
        access: { active_plans: ['bundle'], has_active_subscription: true }
    };
}

function fixtures() {
    return {
        user: { id: USER_ID, email: 'owner@company.test' },
        authUser: {
            id: USER_ID, email: 'owner@company.test',
            profile: { id: USER_ID, full_name: 'مالك الشركة', role: 'super_user' }
        },
        rpc: {
            get_my_company_dashboard: companyPayload(),
            current_company_id: COMPANY_ID,
            company_members: { company_id: COMPANY_ID, is_owner: true, can_manage: true, members: [] },
            company_has_feature: true
        },
        functions: {},
        tables: {
            profiles: [{ id: USER_ID, email: 'owner@company.test', full_name: 'مالك الشركة', role: 'super_user', super_user_id: null }],
            api_tokens: [], api_token_usage_logs: [],
            notifications: [], services: [], whatsapp_subscriptions: [], subscription_plans: [],
            tickets: [], ticket_replies: [], activity_log: []
        }
    };
}

async function openPage(browser, baseUrl, fx) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    const page = await context.newPage();

    const doubleSupabase = fs.readFileSync(path.join(ROOT, 'tests/fixtures/supabase-double.js'), 'utf8');
    const doubleAuth = fs.readFileSync(path.join(ROOT, 'tests/fixtures/auth-client-double.js'), 'utf8');

    await page.route('**/api-config.js', r => r.fulfill({ contentType: 'text/javascript; charset=utf-8', body: doubleSupabase }));
    await page.route('**/auth-client.js', r => r.fulfill({ contentType: 'text/javascript; charset=utf-8', body: doubleAuth }));
    await page.route('**/chat-widget.js', r => r.fulfill({ contentType: 'text/javascript', body: 'export default {};' }));
    await page.route('**/error-tracker.js', r => r.fulfill({ contentType: 'text/javascript', body: '' }));
    await page.route('https://fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));

    await page.addInitScript(data => { window.__FIXTURES__ = data; }, fx);

    const visited = [];
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) visited.push(frame.url()); });

    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto(`${baseUrl}/company-dashboard/index.html`, { waitUntil: 'networkidle' });
    await page.waitForFunction(
        () => !document.getElementById('companyContent')?.hidden
            || !!document.querySelector('#companyGateBody .state-block'),
        null, { timeout: 10000 });
    return { page, context, visited, errors };
}

function departures(visited, from = '/company-dashboard/') {
    return visited.map(u => new URL(u).pathname).filter(p => !p.startsWith(from));
}

async function openPolicySection(page) {
    await page.locator('.sidebar-item[data-tab="refundPolicy"]').click();
    await page.waitForSelector('#refundPolicyTabContent.active', { timeout: 10000 });
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
if (!chromiumPath) console.error('SKIP: لا يوجد متصفح Chromium؛ اختبارات صفحة سياسة الاسترداد لم تُنفَّذ');

test.before(async () => {
    if (!chromiumPath) return;
    server = await startServer();
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: chromiumPath });
});
test.after(async () => { await browser?.close(); server?.close(); });

/* ── الصفحة تفتح من القائمة وتعرض السياسة كاملة ────────────────────────── */

test('قسم سياسة الإلغاء والاسترداد يفتح من القائمة ويعرض نص السياسة كاملًا', { skip: !chromiumPath }, async () => {
    const { page, context, visited, errors } = await openPage(browser, baseUrl, fixtures());
    await openPolicySection(page);

    assert.ok((await page.locator('#companyRefundPolicyHeading').textContent()).includes('سياسة الإلغاء والاسترداد'));
    // السياسة 11 قسمًا فرعيًا
    assert.equal(await page.locator('#companyRefundPolicy h3').count(), 11);
    const text = await page.locator('#companyRefundPolicy').textContent();
    for (const phrase of [
        '666.33', '5,479.18', 'أول 7 أيام', '10%', '30 تذكرة', 'تذكرتان',
        '48 ساعة', '14 يوم عمل', '3 أيام عمل', 'الأحد–الخميس',
        'لا يوجد في مدعوم أي استرداد آلي', 'Pi Network مخفي مؤقتًا',
        'SIE', 'مرة واحدة لكل مدة اشتراك', 'نقاط ما زالت مفتوحة'
    ]) assert.ok(text.includes(phrase), `عبارة مفقودة في صفحة السياسة: ${phrase}`);

    assert.deepEqual(departures(visited), [], 'غادرت اللوحة');
    assert.equal(errors.length, 0, errors.join(' | '));
    await context.close();
});

test('روابط التنبيه في الأعلى تبقى داخل اللوحة: الاشتراكات والدعم', { skip: !chromiumPath }, async () => {
    const { page, context, visited, errors } = await openPage(browser, baseUrl, fixtures());
    await openPolicySection(page);

    const subsLink = page.locator('#companyRefundPolicy a[href="#subscriptions"]');
    const supportLink = page.locator('#companyRefundPolicy a[href="#support"]');
    assert.equal(await subsLink.count(), 1);
    assert.equal(await supportLink.count(), 1);
    assert.equal(await subsLink.getAttribute('data-tab'), 'subscriptions');
    assert.equal(await supportLink.getAttribute('data-tab'), 'support');

    // النقر على رابط الاشتراكات ينقل لقسم الاشتراكات داخل اللوحة نفسها
    await subsLink.click();
    await page.waitForSelector('#subscriptionsTabContent.active', { timeout: 10000 });
    assert.deepEqual(departures(visited), [], 'غادرت اللوحة');
    assert.equal(errors.length, 0, errors.join(' | '));
    await context.close();
});

/* ── رابط السياسة في نافذة الإلغاء ─────────────────────────────────────── */

test('رابط السياسة في نافذة الإلغاء يغلق النافذة بلا إلغاء وينقل لقسم السياسة', { skip: !chromiumPath }, async () => {
    const { page, context, visited, errors } = await openPage(browser, baseUrl, fixtures());

    await page.locator('.sidebar-item[data-tab="subscriptions"]').click();
    await page.waitForSelector('#subscriptionsTabContent.active', { timeout: 10000 });
    await page.locator('[data-sub-cancel]').first().click();
    await page.waitForSelector('[data-policy-link]', { timeout: 5000 });

    assert.ok((await page.locator('[data-policy-link]').getAttribute('href')).endsWith('#refundPolicy'));

    await page.locator('[data-policy-link]').click();
    await page.waitForSelector('[data-policy-link]', { state: 'detached', timeout: 5000 });
    await page.waitForSelector('#refundPolicyTabContent.active', { timeout: 10000 });
    assert.equal(await page.evaluate(() => location.hash), '#refundPolicy');

    // لم يُنادَ الإلغاء إطلاقًا: الرابط أغلق النافذة بقيمة null
    const invocations = await page.evaluate(() => window.__INVOCATIONS__ || []);
    assert.equal(invocations.filter(i => i.name === 'cancel_my_active_subscription').length, 0,
        'نُودي الإلغاء رغم أن الرابط لا يلغي');

    assert.deepEqual(departures(visited), [], 'غادرت اللوحة');
    assert.equal(errors.length, 0, errors.join(' | '));
    await context.close();
});
