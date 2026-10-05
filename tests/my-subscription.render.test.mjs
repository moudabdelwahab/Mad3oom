/**
 * اختبارات عرض صفحة «اشتراكي» وأيقونة محفظة التذاكر وصفحة الأسعار الجديدة.
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


const ME = 'user-1';
const day = 86400000;
const iso = (d) => new Date(Date.now() + d * day).toISOString();
const PLANS = [
    { key: 'support', name_ar: 'الخطة المتقدمة', price_monthly: 999, price_yearly: 9999, currency: 'EGP', is_active: true, sort_order: 10, requires_company: true },
    { key: 'ultimate', name_ar: 'الخطة الفائقة', price_monthly: 1999, price_yearly: 19999, currency: 'EGP', is_active: true, sort_order: 15, requires_company: true },
    { key: 'whatsapp', name_ar: 'واتساب بيزنس', price_monthly: 1299, price_yearly: 12999, currency: 'EGP', is_active: true, sort_order: 20, requires_company: true },
    { key: 'bundle', name_ar: 'الباقة الشاملة', price_monthly: 2099, price_yearly: 22999, currency: 'EGP', is_active: true, sort_order: 30, requires_company: true }
];
const wallet = (over) => ({
    plan_key: 'free', plan_name_ar: 'الخطة المجانية', is_free: true, subscription_id: null, subscription_end: null,
    billing_cycle: null, account_owner: ME, shared_account: false, unlimited: false, monthly_limit: 20, used: 17,
    remaining: 3, billing_used: 1, billing_limit: 5, period_start: iso(-4), resets_at: iso(26), ...over
});

function fixtures({ w = wallet(), subs = [] } = {}) {
    return {
        user: { id: ME, email: 'ahmed@test.local' },
        authUser: { id: ME, email: 'ahmed@test.local', profile: { id: ME, role: 'user', full_name: 'أحمد' } },
        tables: {
            profiles: [{ id: ME, full_name: 'أحمد', email: 'ahmed@test.local', role: 'user' }],
            subscription_plans: PLANS,
            whatsapp_subscriptions: subs,
            notifications: []
        },
        rpc: { my_ticket_wallet: w, current_company_id: null, my_account_gate: { status: 'active' } }
    };
}

let browser, server, baseUrl;
const chromiumPath = resolveChromium();
if (!chromiumPath) console.error('SKIP: لا يوجد متصفح Chromium متاح؛ اختبارات الاشتراك لم تُنفَّذ');

test.before(async () => {
    if (!chromiumPath) return;
    server = await startServer();
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: chromiumPath });
});
test.after(async () => { await browser?.close(); server?.close(); });

async function open(fx, url) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const doubleSupabase = fs.readFileSync(path.join(ROOT, 'tests/fixtures/supabase-double.js'), 'utf8');
    const doubleAuth = fs.readFileSync(path.join(ROOT, 'tests/fixtures/auth-client-double.js'), 'utf8');
    await page.route('**/api-config.js', r => r.fulfill({ contentType: 'text/javascript; charset=utf-8', body: doubleSupabase }));
    await page.route('**/auth-client.js', r => r.fulfill({ contentType: 'text/javascript; charset=utf-8', body: doubleAuth }));
    await page.route('https://fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
    await page.addInitScript(data => { window.__FIXTURES__ = data; }, fx);
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${baseUrl}${url}`, { waitUntil: 'networkidle' });
    return { page, context, errors };
}

test('اشتراكي — الخطة المجانية: الرصيد والقيود والترقية', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await open(fixtures(), '/my-subscription.html');
    await page.waitForSelector('.ms-plan-name');
    const text = await page.locator('#msContent').innerText();
    assert.match(text, /الخطة المجانية/);
    assert.match(text, /مجانًا/);
    assert.match(text, /3\s*تذكرة متبقية من 20/);
    assert.match(text, /ترقية إلى الخطة المتقدمة/);
    assert.match(text, /متاح 4 من 5 هذا الشهر/);
    // القيود ظاهرة: النطاق الفرعي غير مشمول
    assert.equal(await page.locator('.ms-features li.no', { hasText: 'نطاق فرعي مجاني' }).count(), 1);
    assert.match(text, /لا توجد اشتراكات أو طلبات/);
    assert.deepEqual(errors, []);
    await context.close();
});

test('اشتراكي — الخطة المتقدمة: السعر والمدة والسجل والترقية للفائقة', { skip: !chromiumPath }, async () => {
    const subs = [
        { id: 's1', user_id: ME, plan: 'support', status: 'active', billing_cycle: 'monthly', start_date: iso(-10), end_date: iso(20), created_at: iso(-10), is_renewal: false, payment_method: 'instapay' },
        { id: 's0', user_id: ME, plan: 'support', status: 'expired', billing_cycle: 'monthly', start_date: iso(-45), end_date: iso(-15), created_at: iso(-45), is_renewal: false, payment_method: 'bank_transfer' }
    ];
    const w = wallet({ plan_key: 'support', plan_name_ar: 'الخطة المتقدمة', is_free: false, subscription_id: 's1', subscription_end: iso(20), billing_cycle: 'monthly', monthly_limit: 300, used: 120, remaining: 180 });
    const { page, context } = await open(fixtures({ w, subs }), '/my-subscription.html');
    await page.waitForSelector('.ms-plan-name');
    const text = await page.locator('#msContent').innerText();
    assert.match(text, /الخطة المتقدمة/);
    assert.match(text, /999 ج\.م شهريًا/);
    assert.match(text, /نشط/);
    assert.match(text, /20 يوم/);
    assert.match(text, /180\s*تذكرة متبقية من 300/);
    assert.match(text, /ترقية إلى الخطة الفائقة/);
    assert.equal(await page.locator('.ms-table tbody tr').count(), 2);
    assert.match(await page.locator('.ms-table').innerText(), /إنستاباي/);
    await context.close();
});

test('اشتراكي — الفائقة: تذاكر غير محدودة ومفيش ترقية أعلى', { skip: !chromiumPath }, async () => {
    const subs = [{ id: 'u1', user_id: ME, plan: 'ultimate', status: 'active', billing_cycle: 'yearly', start_date: iso(-30), end_date: iso(335), created_at: iso(-30) }];
    const w = wallet({ plan_key: 'ultimate', plan_name_ar: 'الخطة الفائقة', is_free: false, subscription_id: 'u1', subscription_end: iso(335), billing_cycle: 'yearly', unlimited: true, monthly_limit: null, used: 640, remaining: null });
    const { page, context } = await open(fixtures({ w, subs }), '/my-subscription.html');
    await page.waitForSelector('.ms-plan-name');
    const text = await page.locator('#msContent').innerText();
    assert.match(text, /19,999 ج\.م سنويًا/);
    assert.match(text, /تذاكر غير محدودة/);
    assert.doesNotMatch(text, /ترقية إلى/);
    await context.close();
});

test('أيقونة المحفظة في بوابة العميل', { skip: !chromiumPath }, async () => {
    const { page, context } = await open(fixtures(), '/my-subscription.html');
    await page.waitForSelector('#ticketWallet:not([hidden])');
    assert.equal(await page.locator('#ticketWalletCount').innerText(), '3');
    assert.match(await page.getAttribute('#ticketWalletCount', 'class'), /is-warn/);
    await page.click('#ticketWalletBtn');
    await page.waitForSelector('#ticketWalletPanel:not([hidden])');
    const panel = await page.locator('#ticketWalletPanel').innerText();
    assert.match(panel, /رصيد التذاكر/);
    assert.match(panel, /الخطة المجانية/);
    assert.match(panel, /ترقية الخطة/);
    await page.keyboard.press('Escape');
    await page.waitForSelector('#ticketWalletPanel[hidden]', { state: 'attached' });
    await context.close();
});

test('صفحة الأسعار: 3 خطط بالجنيه والواتساب مخفي', { skip: !chromiumPath }, async () => {
    const fx = fixtures();
    fx.user = null; fx.authUser = null;
    const { page, context } = await open(fx, '/subscriptions.html');
    await page.waitForSelector('.pricing-card[data-plan="ultimate"]');
    const plans = await page.locator('#individuals .pricing-card').evaluateAll(els => els.map(e => e.dataset.plan));
    assert.deepEqual(plans, ['free', 'support', 'ultimate']);
    assert.equal(await page.locator('[data-plan="whatsapp"], [data-plan="bundle"]').count(), 0);
    const adv = page.locator('.pricing-card[data-plan="support"]');
    assert.equal(await adv.locator('.amount').innerText(), '999');
    assert.equal(await adv.locator('.currency').innerText(), 'ج.م');
    assert.match(await adv.locator('.discount-badge').innerText(), /خصم 46%/);
    await page.click('#billingToggle [data-period="yearly"]');
    assert.equal(await adv.locator('.amount').innerText(), '9,999');
    assert.equal(await page.locator('.pricing-card[data-plan="ultimate"] .amount').innerText(), '19,999');
    assert.equal(await page.locator('.comparison-table thead th').count(), 4);
    await context.close();
});
