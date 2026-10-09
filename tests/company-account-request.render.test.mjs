/**
 * «فرد أم شركة؟» عند الاشتراك + مراجعة الإدارة لطلب حساب الشركة (068).
 *
 * الكود الحقيقي (subscriptions-script.js ← company-onboarding.js ← company-data.js،
 * وصفحة الإدارة) في متصفح فعلي، والقاعدة بديل اختباري يسجّل كل نداء RPC.
 * العقد اللي بنثبّته:
 *   • فرد  ⇒ نافذة الدفع، ولا طلب شركة.
 *   • شركة ⇒ طلب للإدارة بالباقة المختارة، ولا دفع ولا طلب اشتراك.
 *   • حساب شركة قائم ⇒ لا سؤال أصلًا.
 *   • الإدارة لا ترفض بلا سبب، والقرار نداء واحد للقاعدة.
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
const PLANS = [
    { key: 'support', name_ar: 'الخطة المتقدمة', price_monthly: 999, price_yearly: 9999, currency: 'EGP', is_active: true, sort_order: 10 },
    { key: 'ultimate', name_ar: 'الخطة الفائقة', price_monthly: 1999, price_yearly: 19999, currency: 'EGP', is_active: true, sort_order: 15 }
];

function customer({ companyId = null, lastRequest = null, rpcErrors = {} } = {}) {
    return {
        user: { id: ME, email: 'ahmed@test.local' },
        authUser: { id: ME, email: 'ahmed@test.local', profile: { id: ME, role: 'user', full_name: 'أحمد' } },
        tables: {
            profiles: [{ id: ME, full_name: 'أحمد', email: 'ahmed@test.local', role: 'user' }],
            subscription_plans: PLANS,
            whatsapp_subscriptions: [],
            notifications: []
        },
        rpc: {
            current_company_id: companyId,
            my_company_account_request: lastRequest,
            submit_company_account_request: { id: 'req-1', status: 'pending' },
            my_ticket_wallet: null,
            my_account_gate: { status: 'active' }
        },
        rpcErrors
    };
}

let browser, server, baseUrl;
const chromiumPath = resolveChromium();
if (!chromiumPath) console.error('SKIP: لا يوجد متصفح Chromium متاح؛ اختبارات طلب حساب الشركة لم تُنفَّذ');

test.before(async () => {
    if (!chromiumPath) return;
    server = await startServer();
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: chromiumPath });
});
test.after(async () => { await browser?.close(); server?.close(); });

async function open(fx, url, { viewport, dialogs = null } = {}) {
    const context = await browser.newContext({ viewport: viewport || { width: 1280, height: 900 } });
    const page = await context.newPage();
    const doubleSupabase = fs.readFileSync(path.join(ROOT, 'tests/fixtures/supabase-double.js'), 'utf8');
    const doubleAuth = fs.readFileSync(path.join(ROOT, 'tests/fixtures/auth-client-double.js'), 'utf8');
    await page.route('**/api-config.js', r => r.fulfill({ contentType: 'text/javascript; charset=utf-8', body: doubleSupabase }));
    await page.route('**/auth-client.js', r => r.fulfill({ contentType: 'text/javascript; charset=utf-8', body: doubleAuth }));
    await page.route('https://fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
    await page.addInitScript(data => { window.__FIXTURES__ = data; }, fx);
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', d => {
        if (dialogs) dialogs.push(d.message()); else errors.push(`unexpected dialog: ${d.message()}`);
        d.dismiss();
    });
    await page.goto(`${baseUrl}${url}`, { waitUntil: 'networkidle' });
    return { page, context, errors };
}

const rpcCalls = (page) => page.evaluate(() => window.__RPC_ARGS__ || []);
const called = async (page, name) => (await rpcCalls(page)).filter(([n]) => n === name);
const writes = (page) => page.evaluate(() => window.__WRITES__ || []);

async function clickSubscribe(page, plan = 'support') {
    const btn = page.locator(`[data-plan-btn="${plan}"]`);
    await btn.waitFor();
    await page.waitForFunction(p => {
        const b = document.querySelector(`[data-plan-btn="${p}"]`);
        return b && !b.disabled && b.textContent.trim() === 'اشترك الآن';
    }, plan);
    await btn.click();
}

/* ── العميل ─────────────────────────────────────────────────────────────── */

test('«اشترك الآن» يسأل أولًا: فرد أم شركة؟ — والفرد يكمل لنافذة الدفع', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await open(customer(), '/subscriptions.html');
    await clickSubscribe(page);

    const modal = page.locator('[role="dialog"][aria-label="نوع الحساب"]');
    await modal.waitFor();
    assert.match(await modal.innerText(), /هل تشترك كفرد أم كشركة؟/);
    assert.equal(await modal.locator('[data-account-type]').count(), 2);
    // لا شيء اتبعت لمجرد فتح السؤال
    assert.deepEqual(await called(page, 'submit_company_account_request'), []);

    await modal.locator('[data-account-type="individual"]').click();
    await page.getByText('اختر وسيلة الدفع').waitFor();
    assert.equal(await modal.count(), 0, 'نافذة السؤال لازم تتقفل');
    assert.deepEqual(await called(page, 'submit_company_account_request'), []);
    assert.deepEqual(errors, []);
    await context.close();
});

test('شركة ⇒ البيانات تُرسَل كطلب بالباقة المختارة، بلا دفع ولا طلب اشتراك', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await open(customer(), '/subscriptions.html');
    await page.click('#billingToggle [data-period="yearly"]');
    await clickSubscribe(page, 'ultimate');
    await page.locator('[data-account-type="company"]').click();

    const form = page.locator('[role="dialog"][aria-label="بيانات الشركة"]');
    await form.waitFor();

    // الحقول الإلزامية تُفحص قبل أي نداء
    await form.locator('#cmSubmit').click();
    assert.equal(await form.locator('[data-error-for="cmCompanyName"]').innerText(), 'اسم الشركة مطلوب');
    assert.equal(await form.locator('[data-error-for="cmCrNumber"]').innerText(), 'رقم السجل التجاري مطلوب');
    assert.deepEqual(await called(page, 'submit_company_account_request'), []);

    await form.locator('#cmCompanyName').fill('شركة النور للتجارة');
    await form.locator('#cmCrNumber').fill('1010101010');
    await form.locator('#cmCrExpiry').fill('2030-06-30');
    await form.locator('#cmCompanyEmail').fill('info@alnoor.co');
    await form.locator('#cmSubmit').click();

    await form.locator('[data-company-done]').waitFor({ state: 'visible' });
    assert.match(await form.innerText(), /تم إرسال طلب حساب الشركة/);

    const calls = await called(page, 'submit_company_account_request');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0][1], {
        p_company_name: 'شركة النور للتجارة',
        p_commercial_registration_number: '1010101010',
        p_commercial_registration_expiry: '2030-06-30',
        p_company_email: 'info@alnoor.co',
        p_company_phone: null,
        p_requested_plan: 'ultimate',
        p_requested_billing_cycle: 'yearly'
    });
    // لا شركة تُنشأ من الواجهة، ولا دفع، ولا طلب اشتراك
    assert.deepEqual(await called(page, 'upsert_my_company'), []);
    assert.equal(await page.getByText('اختر وسيلة الدفع').count(), 0);
    assert.deepEqual((await writes(page)).filter(w => ['whatsapp_subscriptions', 'tickets'].includes(w.table)), []);

    await form.locator('#cmDone').click();
    assert.equal(await form.count(), 0);
    assert.deepEqual(errors, []);
    await context.close();
});

test('رفض القاعدة يظهر داخل النموذج والبيانات باقية فيه', { skip: !chromiumPath }, async () => {
    const fx = customer({ rpcErrors: { submit_company_account_request: 'رقم السجل التجاري مسجل بالفعل' } });
    const { page, context, errors } = await open(fx, '/subscriptions.html');
    await clickSubscribe(page);
    await page.locator('[data-account-type="company"]').click();

    const form = page.locator('[role="dialog"][aria-label="بيانات الشركة"]');
    await form.locator('#cmCompanyName').fill('شركة مكررة');
    await form.locator('#cmCrNumber').fill('CR-EXIST');
    await form.locator('#cmCrExpiry').fill('2030-01-01');
    await form.locator('#cmSubmit').click();

    await form.locator('#cmFormError').waitFor({ state: 'visible' });
    assert.equal(await form.locator('#cmFormError').innerText(), 'رقم السجل التجاري مسجل بالفعل');
    assert.equal(await form.locator('#cmCompanyName').inputValue(), 'شركة مكررة');
    assert.equal(await form.locator('[data-company-done]').isVisible(), false);
    assert.equal(await form.locator('#cmSubmit').isEnabled(), true);
    assert.deepEqual(errors, []);
    await context.close();
});

test('طلب قيد المراجعة ⇒ خيار الشركة مقفول بحالته، والفرد متاح', { skip: !chromiumPath }, async () => {
    const fx = customer({ lastRequest: { id: 'req-0', status: 'pending', company_name: 'شركة <b>الأمل</b>' } });
    const { page, context, errors } = await open(fx, '/subscriptions.html');
    await clickSubscribe(page);

    const company = page.locator('[data-account-type="company"]');
    await company.waitFor();
    assert.equal(await company.isDisabled(), true);
    const text = await company.innerText();
    assert.match(text, /قيد المراجعة/);
    // اسم الشركة نص لا HTML
    assert.match(text, /شركة <b>الأمل<\/b>/);
    assert.equal(await page.locator('[data-account-type="individual"]').isEnabled(), true);
    assert.deepEqual(errors, []);
    await context.close();
});

test('طلب مرفوض ⇒ السبب ظاهر، والنموذج يبدأ باسم الشركة السابق', { skip: !chromiumPath }, async () => {
    const fx = customer({ lastRequest: { id: 'req-0', status: 'rejected', company_name: 'شركة الأمل', review_note: 'صورة السجل غير واضحة' } });
    const { page, context, errors } = await open(fx, '/subscriptions.html');
    await clickSubscribe(page);

    assert.match(await page.locator('[data-rejected-note]').innerText(), /صورة السجل غير واضحة/);
    await page.locator('[data-account-type="company"]').click();
    assert.equal(await page.locator('#cmCompanyName').inputValue(), 'شركة الأمل');
    assert.deepEqual(errors, []);
    await context.close();
});

test('حساب شركة قائم ⇒ لا سؤال، مباشرة لنافذة الدفع', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await open(customer({ companyId: 'company-1' }), '/subscriptions.html');
    await clickSubscribe(page);
    await page.getByText('اختر وسيلة الدفع').waitFor();
    assert.equal(await page.locator('[aria-label="نوع الحساب"]').count(), 0);
    assert.deepEqual(await called(page, 'my_company_account_request'), []);
    assert.deepEqual(errors, []);
    await context.close();
});

test('صفحة «الاشتراكات» داخل البوابة تسأل نفس السؤال (صفحة لقطة الشاشة)', { skip: !chromiumPath }, async () => {
    const { page, context } = await open(customer(), '/customer-subscriptions.html', { viewport: { width: 390, height: 844 } });
    await clickSubscribe(page);
    const modal = page.locator('[role="dialog"][aria-label="نوع الحساب"]');
    await modal.waitFor();
    // على عرض الجوال الخياران تحت بعض ولا تمرير أفقي
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, `تمرير أفقي ${overflow}px`);
    await context.close();
});

test('فرد + تحويل بنكي + PDF ⇒ الطلب يتسجّل والإثبات يتحفظ (file_url NOT NULL)', { skip: !chromiumPath }, async () => {
    // المسار اللي كان بيفشل في الإنتاج من 2026-09-09: الرفع للتخزين ينجح، ثم
    // إدراج ticket_attachments يترفض (23502 على file_url) فيُلغى الطلب كله.
    // البديل الاختباري بقى يفرض نفس NOT NULL، فالاختبار ده كان هيفشل قبل الإصلاح.
    const fx = customer();
    fx.tables.tickets = [];
    fx.tables.ticket_attachments = [];
    fx.rpc.subscription_purchase_check = { allowed: true };
    fx.rpc.submit_subscription_request = {
        subscription_id: 'sub-1', status: 'pending',
        ticket: { id: 'tk-1', ticket_number: 1121, category: 'subscription', status: 'open' }
    };
    fx.rpc.cancel_my_subscription_request = true;
    const dialogs = [];
    const { page, context, errors } = await open(fx, '/subscriptions.html', { dialogs });

    await clickSubscribe(page);
    await page.locator('[data-account-type="individual"]').click();
    await page.getByText('اختر وسيلة الدفع').waitFor();
    await page.check('input[name="pm_method"][value="bank_transfer"]');
    await page.setInputFiles('#pmProofInput', {
        name: 'إثبات تحويل.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 test')
    });
    await page.click('#pmConfirmBtn');
    await page.waitForFunction(() => (window.__WRITES__ || []).some(w => w.table === 'ticket_attachments'));
    await page.waitForTimeout(300);

    const attach = (await writes(page)).filter(w => w.table === 'ticket_attachments');
    assert.deepEqual(attach.map(w => w.op), ['insert'], `الإدراج اترفض: ${JSON.stringify(attach)}`);
    const row = attach[0].row;
    assert.match(row.file_path, /^tk-1\/\d+_[a-z0-9]+_.+\.pdf$/);
    assert.equal(row.file_url, `/uploads/${row.file_path}`, 'file_url = الرابط العام للمسار نفسه (وسيلة الرجوع في 030)');
    assert.equal(row.mime_type, 'application/pdf');
    assert.equal(row.file_name, 'إثبات تحويل.pdf');

    assert.deepEqual(await called(page, 'cancel_my_subscription_request'), [], 'الطلب اتلغى بعد الرفع');

    // التذكرة والطلب نداء واحد على الخادم (069): المتصفح مابيدرجش تذكرة ولا
    // بيبعت تصنيف/أولوية/صاحب — دول بيفرضهم الخادم.
    assert.deepEqual((await writes(page)).filter(w => w.table === 'tickets'), []);
    assert.deepEqual(await called(page, 'request_subscription_purchase'), []);
    const submit = await called(page, 'submit_subscription_request');
    assert.equal(submit.length, 1);
    const args = submit[0][1];
    assert.deepEqual(Object.keys(args).sort(), ['p_billing_cycle', 'p_is_renewal', 'p_payment_method',
        'p_payment_reference', 'p_plan', 'p_ticket_description', 'p_ticket_title']);
    assert.equal(args.p_plan, 'support');
    assert.equal(args.p_payment_method, 'bank_transfer');
    assert.equal(args.p_is_renewal, false);
    assert.match(args.p_ticket_title, /^طلب اشتراك - /);
    assert.match(args.p_ticket_description, /طلب تحويل خارجي/);
    assert.equal(dialogs.length, 1);
    assert.match(dialogs[0], /تم إرسال طلب الاشتراك بنجاح/);
    assert.match(dialogs[0], /#1121/);
    assert.match(dialogs[0], /سيتم مراجعة إثبات التحويل/);
    assert.deepEqual(errors, []);
    await context.close();
});

/* ── الإدارة ────────────────────────────────────────────────────────────── */

const REQUESTS = [
    {
        id: 'req-p', user_id: 'u1', customer_name: 'عميل أول', customer_email: 'u1@test.local', customer_phone: '0100',
        company_name: 'شركة النور', commercial_registration_number: '1010', commercial_registration_expiry: '2030-01-01',
        company_email: 'info@noor.co', company_phone: null, requested_plan: 'support',
        requested_plan_name_ar: 'الخطة المتقدمة', requested_billing_cycle: 'monthly', status: 'pending',
        review_note: null, reviewed_at: null, reviewer_name: null, company_id: null, created_at: '2026-10-08T10:00:00Z'
    },
    {
        id: 'req-r', user_id: 'u2', customer_name: 'عميل تاني', customer_email: 'u2@test.local', customer_phone: null,
        company_name: 'شركة قديمة', commercial_registration_number: '2020', commercial_registration_expiry: '2020-01-01',
        company_email: null, company_phone: null, requested_plan: null, requested_plan_name_ar: null,
        requested_billing_cycle: null, status: 'rejected', review_note: 'السجل منتهٍ', reviewed_at: '2026-10-07T10:00:00Z',
        reviewer_name: 'أدمن', company_id: null, created_at: '2026-10-06T10:00:00Z'
    }
];

function admin(rpcErrors = {}) {
    return {
        user: { id: 'admin-1', email: 'admin@test.local' },
        authUser: { id: 'admin-1', email: 'admin@test.local', profile: { id: 'admin-1', role: 'admin' } },
        tables: { profiles: [{ id: 'admin-1', email: 'admin@test.local', role: 'admin' }], notifications: [] },
        rpc: { admin_list_company_account_requests: REQUESTS, admin_review_company_account_request: { status: 'approved' } },
        rpcErrors
    };
}

test('الإدارة: القائمة تبدأ بقيد المراجعة، والرفض بلا سبب لا يصل للقاعدة', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await open(admin(), '/admin/company-requests.html');
    await page.locator('[data-request-row]').first().waitFor();
    assert.deepEqual(await page.locator('[data-request-row]').evaluateAll(rows => rows.map(r => r.dataset.requestRow)), ['req-p']);
    assert.match(await page.locator('#crBody').innerText(), /الخطة المتقدمة \(شهري\)/);

    await page.locator('[data-view-request="req-p"]').click();
    await page.locator('#crModal').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#crCompanyName').innerText(), 'شركة النور');
    assert.equal(await page.locator('#crCompanyPhone').innerText(), '—');

    await page.click('#crRejectBtn');
    assert.match(await page.locator('#crError').innerText(), /اكتب سبب الرفض/);
    assert.deepEqual(await called(page, 'admin_review_company_account_request'), []);

    await page.fill('#crNote', 'بيانات ناقصة');
    await page.click('#crRejectBtn');
    await page.locator('#crModal').waitFor({ state: 'hidden' });
    const calls = await called(page, 'admin_review_company_account_request');
    assert.deepEqual(calls.map(c => c[1]), [{ p_request_id: 'req-p', p_decision: 'reject', p_note: 'بيانات ناقصة' }]);
    assert.deepEqual(errors.filter(e => !e.includes('activity')), []);
    await context.close();
});

test('الإدارة: الموافقة نداء واحد، ورسالة القاعدة تظهر في النافذة لو رفضت', { skip: !chromiumPath }, async () => {
    const ok = await open(admin(), '/admin/company-requests.html');
    await ok.page.locator('[data-view-request="req-p"]').click();
    await ok.page.click('#crApproveBtn');
    await ok.page.locator('#crModal').waitFor({ state: 'hidden' });
    assert.deepEqual((await called(ok.page, 'admin_review_company_account_request')).map(c => c[1]),
        [{ p_request_id: 'req-p', p_decision: 'approve', p_note: null }]);
    await ok.context.close();

    const fail = await open(admin({ admin_review_company_account_request: 'رقم السجل التجاري مسجل لشركة أخرى' }),
        '/admin/company-requests.html');
    await fail.page.locator('[data-view-request="req-p"]').click();
    await fail.page.click('#crApproveBtn');
    await fail.page.locator('#crError').waitFor({ state: 'visible' });
    assert.equal(await fail.page.locator('#crError').innerText(), 'رقم السجل التجاري مسجل لشركة أخرى');
    assert.equal(await fail.page.locator('#crModal').isVisible(), true);
    await fail.context.close();
});

test('الإدارة: الطلب المُراجَع يُعرض بقراره بلا أزرار قرار', { skip: !chromiumPath }, async () => {
    const { page, context } = await open(admin(), '/admin/company-requests.html');
    await page.locator('[data-request-row]').first().waitFor();
    await page.selectOption('#crStatusFilter', '');
    await page.locator('[data-view-request="req-r"]').click();
    assert.equal(await page.locator('#crReviewNote').innerText(), 'السجل منتهٍ');
    assert.match(await page.locator('#crCrExpiry').innerText(), /منتهٍ/);
    assert.equal(await page.locator('#crApproveBtn').isVisible(), false);
    assert.equal(await page.locator('#crRejectBtn').isVisible(), false);
    assert.equal(await page.locator('#crNoteField').isVisible(), false);
    await context.close();
});
