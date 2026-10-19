/**
 * «إدارة العملاء» و«طلبات الحسابات» (105) — تشغيل حقيقي في Chromium مقابل البديل.
 *
 * الواجهة لا تقرر: كل نداء يرفضه الخادم لمن لا يحق له (مقيس في tests/sql/account-hierarchy-customers.test.sql).
 * هنا: الفلاتر والصفحات تُرسل للخادم ولا تُطبَّق في المتصفح، لا قراءة مباشرة لجدول، زر الموافقة لا يُفعَّل
 * بلا تنفيذ متاح، الرفض بسبب، الطلب يحمل مفتاح منع تكرار ومعرّف العميل الثابت، والصفحة سليمة على الجوال
 * وفي الوضع الداكن وبالاتجاه RTL.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = path.resolve(import.meta.dirname, '..');
const model = await import(new URL('../assets/js/admin/customers-model.js', import.meta.url));

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

const ADMIN = '44444444-4444-4444-8444-444444444444';
const OWNER = '11111111-1111-4111-8111-111111111111';
const C1 = 'c1000000-0000-4000-8000-000000000001';
const CA = 'ca000000-0000-4000-8000-00000000000a';
const R1 = 'r1000000-0000-4000-8000-000000000001';

function customerRow(i) {
    return { id: `c${String(i).padStart(7, '0')}-0000-4000-8000-000000000000`, full_name: `عميل ${i}`, email: `c${i}@example.test`,
             phone: i % 2 ? `0110000${i}` : null, whatsapp_phone: null, account_type: i % 3 ? 'direct' : 'company_customer',
             company: i % 3 ? null : { id: CA, name: 'شركة أ' }, companies_count: i % 3 ? 0 : 1,
             manager: i === 1 ? { id: ADMIN, name: 'إداري' } : null, status: i === 4 ? 'suspended' : 'active',
             pending_transfer: false, pending_request: i === 2, created_at: '2026-10-01T10:00:00Z' };
}

function adminFixtures({ canAssign = true, canSubmit = true, directoryError = null } = {}) {
    return {
        user: { id: ADMIN, email: 'admin@example.test' },
        authUser: { id: ADMIN, email: 'admin@example.test', profile: { id: ADMIN, full_name: 'إداري', role: 'admin', ban_status: 'none' } },
        rpcErrors: directoryError ? { admin_customer_directory: directoryError } : {},
        rpc: {
            has_elevated_authority: false, is_platform_owner: false, active_context: null,
            admin_customer_filter_options: { companies: [{ id: CA, name: 'شركة أ', status: 'active' }],
                                             managers: [{ id: ADMIN, name: 'إداري', role: 'admin' }],
                                             can_assign_manager: canAssign, can_submit_request: canSubmit, is_owner: false },
            // الدليل يُركَّب داخل الصفحة (الدوال لا تعبر addInitScript): انظر open()
            admin_customer_details: {
                profile: { id: C1, full_name: 'عميل <img src=x onerror="window.__XSS__=1">', email: 'c1@example.test', phone: '0110', whatsapp_phone: null,
                           status: 'active', created_at: '2026-10-01T10:00:00Z' },
                account_type: 'direct', direct: { since: '2026-09-01T00:00:00Z', source: 'backfill' },
                memberships: [], manager: null, manager_history: [], subscriptions: [], requests: [], history: [],
                history_note: 'السجل يبدأ من تفعيل كل نظام', can_assign_manager: canAssign, can_submit_request: canSubmit
            },
            customer_manager_assign: { changed: true },
            account_request_submit: { request_id: R1, status: 'pending', replayed: false }
        },
        directoryRows: Array.from({ length: 30 }, (_, i) => customerRow(i + 1)),
        tables: { profiles: [{ id: ADMIN, email: 'admin@example.test', role: 'admin', full_name: 'إداري' }] }
    };
}

function ownerFixtures({ execution = { available: false, code: 'prerequisite_not_enabled', missing: ['account_request_execution_enabled'] },
                         type = 'add_to_company', selfRequested = false, canDecide = true, checksOk = true,
                         legacyTransfer = true, decideResult = null, lastFailure = null, impact = null } = {}) {
    const row = { id: R1, request_type: type, status: 'pending', customer_id: C1, customer_name: 'عميل 1', customer_email: 'c1@example.test',
                  target_email: 'c1.work@example.test', company_id: CA, company_name: 'شركة أ', reason: 'إدارة الحساب حسب الاتفاق',
                  requested_by: ADMIN, requester_name: 'إداري', requested_at: '2026-10-19T09:00:00Z',
                  last_failure: lastFailure, attempts: lastFailure ? 1 : 0 };
    return {
        user: { id: OWNER, email: 'owner@example.test' },
        authUser: { id: OWNER, email: 'owner@example.test', activeContext: 'owner',
                    profile: { id: OWNER, full_name: 'المالك', role: 'platform_owner', ban_status: 'none' } },
        rpc: {
            has_elevated_authority: true, is_platform_owner: true, active_context: 'owner',
            owner_context_status: { is_platform_owner: true, active_context: 'owner', preview_mode: false, expires_at: '2099-01-01T00:00:00Z' },
            available_contexts: [{ key: 'owner' }],
            account_requests_overview: { can_submit: false, is_owner: true, owner_step_up: canDecide,
                                         execution: { add_to_company: execution, transfer_direct_to_company: { available: false, code: 'operation_not_available', missing: [] } } },
            admin_customer_filter_options: { companies: [{ id: CA, name: 'شركة أ', status: 'active' }], managers: [], can_assign_manager: true, can_submit_request: false, is_owner: true },
            owner_account_requests: { total: 1, limit: 25, offset: 0, rows: [row], pending_count: 1, requesters: [{ id: ADMIN, name: 'إداري' }] },
            owner_account_request_details: {
                ...row, snapshot: {}, self_requested: selfRequested, can_decide: canDecide && !selfRequested,
                customer_now: { account_type: 'direct', email: 'c1@example.test', status: 'active', is_direct: true, companies: [], open_tickets: 2, active_subscriptions: 0, has_primary_company: false },
                company: { id: CA, name: 'شركة أ', contact_email: 'contact@company-a.test', status: 'active', owner_name: 'مالك أ' },
                checks: [{ code: 'customer_exists', ok: true }, { code: 'email_matches', ok: checksOk }],
                // legacyTransfer: خادم 105 (النقل غير متاح). 106: النقل بنفس متطلبات الإضافة
                execution: type === 'transfer_direct_to_company' && legacyTransfer ? { available: false, code: 'operation_not_available', missing: [] } : execution,
                last_failure: lastFailure, attempts: lastFailure ? 1 : 0, impact
            },
            owner_decide_account_request: decideResult || { request_id: R1, status: 'rejected' }
        },
        tables: { profiles: [{ id: OWNER, email: 'owner@example.test', role: 'platform_owner', full_name: 'المالك' }] }
    };
}

async function open(browser, baseUrl, url, fx, { viewport = { width: 1440, height: 1000 }, theme = null, confirm = true } = {}) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const dbl = fs.readFileSync(path.join(ROOT, 'tests/fixtures/supabase-double.js'), 'utf8');
    const auth = fs.readFileSync(path.join(ROOT, 'tests/fixtures/auth-client-double.js'), 'utf8');
    await page.route('**/api-config.js', r => r.fulfill({ contentType: 'text/javascript', body: dbl }));
    await page.route('**/auth-client.js', r => r.fulfill({ contentType: 'text/javascript', body: auth }));
    await page.route('**/error-tracker.js', r => r.fulfill({ contentType: 'text/javascript', body: '' }));
    await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, r => r.abort());
    await page.addInitScript(([d, t]) => {
        window.__FIXTURES__ = d;
        // صفحة نتائج من الخادم بحسب offset/limit — كما تفعل admin_customer_directory
        if (d.directoryRows && d.rpc && !('admin_customer_directory' in d.rpc)) {
            d.rpc.admin_customer_directory = (a) => {
                const f = a?.p_filters || {};
                const off = f.offset || 0;
                return { total: d.directoryRows.length, limit: f.limit, offset: off, rows: d.directoryRows.slice(off, off + (f.limit || 25)) };
            };
        }
        try { localStorage.clear(); if (t) localStorage.setItem('theme-preference', t); } catch {}
    }, [fx, theme]);
    const dialogs = [];
    page.on('dialog', d => { dialogs.push(d.message()); confirm ? d.accept() : d.dismiss(); });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${baseUrl}${url}`, { waitUntil: 'networkidle' });
    return { page, context, errors, dialogs };
}
const calls = (page, name) => page.evaluate(n => (window.__RPC_ARGS__ || []).filter(([x]) => x === n).map(([, a]) => a), name);

const chromiumPath = resolveChromium();
let server, baseUrl, browser;
test.before(async () => {
    if (!chromiumPath) return;
    server = await startServer();
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: chromiumPath });
});
test.after(async () => { await browser?.close(); server?.close(); });

test('النموذج: الفلاتر، رسائل الرفض، حالة الموافقة، تحقق النموذج، التهريب', () => {
    assert.deepEqual(model.directoryFilters({ view: 'direct', q: '  x  ', sort: 'email:asc', limit: 50, offset: 50, company_id: '', manager_id: 'none' }),
        { view: 'direct', sort: 'email', dir: 'asc', limit: 50, offset: 50, q: 'x', manager_id: 'none' });
    assert.equal(model.errorMessage({ message: 'x', details: '{"code":"self_approval"}' }), 'لا يمكنك اتخاذ قرار في طلب قدّمته أنت.');
    assert.match(model.errorMessage({ message: 'x', details: '{"code":"revalidation_failed","check":"email_matches"}' }), /البريد المُدخل يطابق/);
    assert.match(model.errorMessage({ message: 'تعذّر إرسال الطلب: customer_active', details: '{"code":"customer_active"}' }), /غير موقوف/);
    assert.equal(model.errorMessage({ message: 'permission denied', code: '42501' }), 'هذه الصفحة أو العملية غير متاحة لحسابك.');
    assert.equal(model.pageSummary(30, 25, 5), '26–30 من 30');
    assert.equal(model.pageSummary(0, 0, 0), 'لا نتائج');
    const base = { status: 'pending', self_requested: false, can_decide: true, checks: [{ code: 'email_matches', ok: true }] };
    assert.deepEqual(model.approvalState({ ...base, execution: { available: true } }), { enabled: true, label: 'موافقة وتنفيذ' });
    assert.equal(model.approvalState({ ...base, execution: { available: false, code: 'operation_not_available' } }).label, 'التنفيذ غير متاح بعد');
    assert.match(model.approvalState({ ...base, execution: { available: false, code: 'prerequisite_not_enabled', missing: ['company_isolation_enforced'] } }).note, /عزل الشركات/);
    assert.equal(model.approvalState({ ...base, self_requested: true, execution: { available: true } }).enabled, false);
    assert.equal(model.approvalState({ ...base, can_decide: false, execution: { available: true } }).enabled, false);
    assert.equal(model.approvalState({ ...base, checks: [{ code: 'email_matches', ok: false }], execution: { available: true } }).enabled, false);
    assert.equal(model.approvalState({ ...base, status: 'approved' }).enabled, false);
    const ok = { type: 'add_to_company', customerEmail: 'a@b.co', targetEmail: '', companyId: CA, reason: 'سبب كافٍ للطلب' };
    assert.equal(model.requestFormError(ok), null);
    assert.ok(model.requestFormError({ ...ok, customerEmail: 'nope' }));
    assert.ok(model.requestFormError({ ...ok, targetEmail: 'bad' }));
    assert.ok(model.requestFormError({ ...ok, companyId: '' }));
    assert.ok(model.requestFormError({ ...ok, reason: 'قصير' }));
    assert.ok(model.requestFormError({ ...ok, type: 'x' }));
    assert.equal(model.escapeText(`<a href="x" onclick='y'>&`), '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;');
    assert.match(model.newIdempotencyKey(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('الدليل: الصفحات والفلاتر على الخادم، لا قراءة مباشرة لجدول، والأعمدة كاملة', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await open(browser, baseUrl, '/admin/customers.html', adminFixtures());
    await page.waitForSelector('#cmBody tr td[data-label="البريد الإلكتروني"]');
    assert.equal(await page.locator('#cmBody tr').count(), 25);
    assert.match(await page.textContent('#cmPageInfo'), /1–25 من 30/);
    const heads = await page.$$eval('.cm-table thead th', ths => ths.map(t => t.textContent.trim()));
    assert.deepEqual(heads, ['المعرّف', 'الاسم', 'البريد الإلكتروني', 'الجوال', 'واتساب', 'مدير الحساب', 'نوع الحساب', 'الشركة', 'الحالة', 'تاريخ الإنشاء', 'الإجراءات']);
    assert.ok(!heads.includes('اسم المندوب'));
    // واتساب غير مخزّن ⇒ «—» لا قيمة مخترعة
    assert.equal((await page.textContent('#cmBody tr:first-child td[data-label="واتساب"]')).trim(), '—');
    await page.click('#cmNext');
    await page.waitForFunction(() => document.querySelector('#cmPageInfo').textContent.includes('26–30'));
    await page.click('[data-view="direct"]');
    await page.fill('#cmSearch', 'c1@');
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n, a]) => n === 'admin_customer_directory' && a?.p_filters?.q === 'c1@'));
    await page.selectOption('#cmStatus', 'suspended');
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n, a]) => n === 'admin_customer_directory' && a?.p_filters?.status === 'suspended'));
    const args = await calls(page, 'admin_customer_directory');
    assert.equal(args[1].p_filters.offset, 25);
    assert.ok(args.some(a => a.p_filters.view === 'direct' && a.p_filters.offset === 0));
    const last = args.at(-1).p_filters;
    assert.deepEqual([last.view, last.q, last.status, last.limit], ['direct', 'c1@', 'suspended', 25]);
    // لا جدول يُقرأ مباشرةً لهذه الصفحة (profiles تُقرأ للشريط الجانبي وحده)
    const reads = await page.evaluate(() => (window.__RPC_CALLS__ || []));
    assert.ok(!reads.includes('admin_customer_details'));
    assert.deepEqual(errors, []);
    await context.close();
});

test('الدرج: النص حرفي، مدير الحساب بسبب، والطلب بمعرّف ثابت ومفتاح منع تكرار', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await open(browser, baseUrl, '/admin/customers.html', adminFixtures());
    await page.waitForSelector('[data-open]');
    await page.click('[data-open]');
    await page.waitForSelector('#cmManagerForm');
    assert.equal(await page.evaluate(() => window.__XSS__ ?? null), null);
    assert.match(await page.textContent('#cmDrawerTitle'), /<img/);
    assert.match(await page.textContent('#cmDrawerBody'), /لا صلاحية/);
    // السبب إلزامي قبل أي نداء
    await page.click('#cmManagerForm button[type=submit]');
    assert.match(await page.textContent('#cmManagerStatus'), /10 أحرف/);
    assert.deepEqual(await calls(page, 'customer_manager_assign'), []);
    await page.selectOption('#cmManagerSelect', ADMIN);
    await page.fill('#cmManagerReason', 'متابعة التجديد الشهري');
    await page.click('#cmManagerForm button[type=submit]');
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'customer_manager_assign'));
    assert.deepEqual(await calls(page, 'customer_manager_assign'), [{ p_customer: C1, p_manager: ADMIN, p_reason: 'متابعة التجديد الشهري' }]);
    await page.waitForSelector('#cmRequestForm');
    // النقل: تنبيه «غير متاح بعد»
    await page.selectOption('#cmReqType', 'transfer_direct_to_company');
    assert.equal(await page.isVisible('#cmReqTransferNote'), true);
    await page.selectOption('#cmReqType', 'add_to_company');
    await page.fill('#cmReqEmail', 'c1@example.test');
    await page.selectOption('#cmReqCompany', CA);
    await page.fill('#cmReqReason', 'إدارة الحساب حسب الاتفاق');
    await page.click('#cmRequestForm button[type=submit]');
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'account_request_submit'));
    const [sent] = await calls(page, 'account_request_submit');
    assert.equal(sent.p_customer, C1);
    assert.equal(sent.p_company, CA);
    assert.equal(sent.p_customer_email, 'c1@example.test');
    assert.equal(sent.p_target_email, null);
    assert.match(sent.p_idempotency_key, /^[0-9a-f-]{36}$/);
    assert.ok(!('p_requested_by' in sent) && !('p_status' in sent), 'الواجهة لا ترسل هوية مقدّم الطلب ولا الحالة');
    assert.match(await page.textContent('#cmReqStatus'), /لم يتغير شيء/);
    assert.deepEqual(errors, []);
    await context.close();
});

test('بلا صلاحية إسناد أو إرسال: لا نماذج، وخطأ الدليل يظهر برسالته مع إعادة المحاولة', { skip: !chromiumPath }, async () => {
    const { page, context } = await open(browser, baseUrl, '/admin/customers.html',
        adminFixtures({ canAssign: false, canSubmit: false, directoryError: { message: 'x', code: '42501', details: '{"code":"not_authorized"}' } }));
    await page.waitForSelector('#cmBody .cm-state[data-kind="error"]');
    assert.match(await page.textContent('#cmBody'), /غير متاحة لحسابك/);
    assert.equal(await page.locator('#cmBody [data-retry]').count(), 1);
    await context.close();
    const second = await open(browser, baseUrl, '/admin/customers.html', adminFixtures({ canAssign: false, canSubmit: false }));
    await second.page.waitForSelector('[data-open]');
    await second.page.click('[data-open]');
    await second.page.waitForSelector('#cmDrawerBody .cm-section');
    assert.equal(await second.page.locator('#cmManagerForm, #cmRequestForm').count(), 0);
    await second.context.close();
});

test('الجهاز اللوحي: الجدول كاملًا بلا تمرير أفقي للصفحة', { skip: !chromiumPath }, async () => {
    for (const url of ['/admin/customers.html', '/admin/account-requests.html']) {
        const fx = url.includes('customers') ? adminFixtures() : ownerFixtures();
        const { page, context, errors } = await open(browser, baseUrl, url, fx, { viewport: { width: 820, height: 1180 } });
        await page.waitForSelector('.cm-table tbody tr td[data-label]');
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        assert.ok(overflow <= 1, `${url} تمرير أفقي ${overflow}px`);
        assert.notEqual(await page.evaluate(() => getComputedStyle(document.querySelector('.cm-table thead')).display), 'none');
        assert.deepEqual(errors, []);
        await context.close();
    }
});

test('الجوال والوضع الداكن: بطاقات بلا تمرير أفقي للصفحة، وألوان من رموز الوضع الداكن', { skip: !chromiumPath }, async () => {
    for (const url of ['/admin/customers.html', '/admin/account-requests.html']) {
        const fx = url.includes('customers') ? adminFixtures() : ownerFixtures();
        const { page, context, errors } = await open(browser, baseUrl, url, fx, { viewport: { width: 390, height: 844 }, theme: 'dark' });
        await page.waitForSelector('.cm-table tbody tr td[data-label]');
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        assert.ok(overflow <= 1, `${url} تمرير أفقي ${overflow}px`);
        assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.cm-table thead')).display), 'none');
        assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-theme')), 'dark');
        assert.equal(await page.evaluate(() => document.documentElement.dir), 'rtl');
        const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
        assert.notEqual(bg, 'rgb(245, 245, 245)', 'خلفية الوضع الفاتح في الوضع الداكن');
        assert.deepEqual(errors, []);
        await context.close();
    }
});

test('صندوق المالك: التنفيذ غير متاح ⇒ لا موافقة، الرفض بسبب، وبريد الشركة منفصل', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await open(browser, baseUrl, '/admin/account-requests.html', ownerFixtures());
    await page.waitForSelector('[data-open]');
    assert.match(await page.textContent('#arBanner'), /التنفيذ غير متاح بعد/);
    assert.equal(await page.getAttribute('[data-tab="pending"]', 'aria-pressed'), 'true');
    const [filters] = await calls(page, 'owner_account_requests');
    assert.equal(filters.p_filters.status, 'pending');
    await page.click('[data-open]');
    await page.waitForSelector('#arDecideForm');
    assert.equal(await page.isDisabled('#arApprove'), true);
    assert.match(await page.textContent('#arApprove'), /التنفيذ غير متاح بعد/);
    assert.match(await page.textContent('#arDrawerBody'), /contact@company-a\.test/);
    assert.match(await page.textContent('#arDrawerBody'), /لا يغيّر بريد الدخول/);
    await page.click('#arReject');
    assert.match(await page.textContent('#arDecideStatus'), /10 أحرف/);
    assert.deepEqual(await calls(page, 'owner_decide_account_request'), []);
    await page.fill('#arDecisionReason', 'لا علاقة تعاقدية مع الشركة');
    await page.click('#arReject');
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'owner_decide_account_request'));
    assert.deepEqual(await calls(page, 'owner_decide_account_request'), [{ p_request: R1, p_approve: false, p_reason: 'لا علاقة تعاقدية مع الشركة' }]);
    // الفلاتر على الخادم
    await page.click('#arDrawerClose');
    await page.selectOption('#arType', 'add_to_company');
    await page.fill('#arFrom', '2026-10-01');
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).filter(([n]) => n === 'owner_account_requests').some(([, a]) => a?.p_filters?.from));
    const lastF = (await calls(page, 'owner_account_requests')).at(-1).p_filters;
    assert.equal(lastF.request_type, 'add_to_company');
    assert.ok(lastF.from);
    assert.deepEqual(errors, []);
    await context.close();
});

test('النقل الكامل وطلبك أنت والتحقق بخطوتين: الموافقة معطّلة دائمًا', { skip: !chromiumPath }, async () => {
    for (const [opts, label] of [[{ type: 'transfer_direct_to_company', execution: { available: true } }, /التنفيذ غير متاح بعد/],
                                 [{ selfRequested: true, execution: { available: true } }, /لا قرار على طلبك/],
                                 [{ canDecide: false, execution: { available: true } }, /تحققًا بخطوتين/],
                                 [{ checksOk: false, execution: { available: true } }, /شروط غير متحققة/]]) {
        const { page, context } = await open(browser, baseUrl, '/admin/account-requests.html', ownerFixtures(opts));
        await page.click('[data-open]');
        await page.waitForSelector('#arApprove');
        assert.equal(await page.isDisabled('#arApprove'), true, JSON.stringify(opts));
        assert.match(await page.textContent('#arApprove'), label);
        await context.close();
    }
});

test('التنفيذ متاح وكل الشروط متحققة: الموافقة بتأكيد صريح', { skip: !chromiumPath }, async () => {
    const { page, context, dialogs } = await open(browser, baseUrl, '/admin/account-requests.html', ownerFixtures({ execution: { available: true, missing: [] } }));
    await page.click('[data-open]');
    await page.waitForSelector('#arApprove:not([disabled])');
    await page.click('#arApprove');
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'owner_decide_account_request'));
    assert.ok(dialogs.some(m => /إعادة التحقق/.test(m)));
    assert.deepEqual(await calls(page, 'owner_decide_account_request'), [{ p_request: R1, p_approve: true, p_reason: null }]);
    await context.close();
});

test('مقدّم الطلب: «طلباتي» وإلغاء بسبب', { skip: !chromiumPath }, async () => {
    const fx = adminFixtures();
    fx.rpc.account_requests_overview = { can_submit: true, is_owner: false, owner_step_up: false,
        execution: { add_to_company: { available: false, code: 'prerequisite_not_enabled', missing: [] }, transfer_direct_to_company: { available: false, code: 'operation_not_available' } } };
    fx.rpc.my_account_requests = [{ id: R1, request_type: 'add_to_company', status: 'pending', customer_id: C1, customer_name: 'عميل 1',
                                    customer_email: 'c1@example.test', company_name: 'شركة أ', reason: 'سبب', requester_name: 'إداري', requested_at: '2026-10-19T09:00:00Z' }];
    fx.rpc.account_request_cancel = { status: 'cancelled' };
    const { page, context, errors } = await open(browser, baseUrl, '/admin/account-requests.html', fx);
    await page.waitForSelector('[data-open]');
    assert.equal(await page.getAttribute('[data-tab="mine"]', 'aria-pressed'), 'true');
    assert.equal(await page.isHidden('#arFilters'), true);
    assert.deepEqual(await calls(page, 'owner_account_requests'), []);
    await page.click('[data-tab="mine:rejected"]');
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n, a]) => n === 'my_account_requests' && a?.p_status === 'rejected'));
    await page.click('[data-tab="mine"]');
    await page.waitForSelector('[data-open]');
    await page.click('[data-open]');
    await page.waitForSelector('#arCancelForm');
    await page.click('#arCancelForm button[type=submit]');
    assert.deepEqual(await calls(page, 'account_request_cancel'), []);
    await page.fill('#arCancelReason', 'تم الاتفاق على التأجيل');
    await page.click('#arCancelForm button[type=submit]');
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'account_request_cancel'));
    assert.deepEqual(await calls(page, 'account_request_cancel'), [{ p_request: R1, p_reason: 'تم الاتفاق على التأجيل' }]);
    assert.deepEqual(errors, []);
    await context.close();
});

test('لا مالك ولا مقدّم طلبات: رسالة صريحة بلا بيانات', { skip: !chromiumPath }, async () => {
    const fx = adminFixtures();
    fx.rpc.account_requests_overview = null;
    const { page, context } = await open(browser, baseUrl, '/admin/account-requests.html', fx);
    await page.waitForSelector('#arBody .cm-state[data-kind="error"]');
    assert.match(await page.textContent('#arBody'), /غير متاحة لحسابك/);
    await context.close();
});

test('106 النموذج: الأثر، الفشل القابل للاستئناف، ونص النتيجة من رد الخادم وحده', () => {
    const lines = model.impactLines({ membership: 'primary', direct_relationship: 'ended', platform_account_manager: 'ended',
        ticket_quota_owner: 'company', historical_tickets: 'stay_private', subscriptions: 'stay_with_customer', login_identity: 'unchanged' });
    assert.ok(lines.some(l => /علاقته المباشرة/.test(l)) && lines.some(l => /خاصة به/.test(l)) && lines.some(l => /لا حساب جديد/.test(l)));
    assert.deepEqual(model.impactLines(null), []);
    const failed = { status: 'pending', last_failure: { code: 'revalidation_failed', check: 'no_active_personal_subscription' } };
    assert.equal(model.isFailedRecoverable(failed), true);
    assert.equal(model.requestStatusLabel(failed), 'فشل التنفيذ — قابل للإعادة');
    assert.equal(model.requestStatusLabel({ status: 'approved', last_failure: { code: 'x' } }), 'تمت الموافقة');
    assert.match(model.failureText(failed.last_failure), /اشتراك شخصي/);
    assert.match(model.failureText({ code: 'prerequisite_not_enabled', missing: ['company_isolation_enforced'] }), /عزل الشركات/);
    assert.match(model.decisionResultText({ status: 'approved', primary: true, direct_relationship_ended: true, platform_manager_ended: true }), /تم التنفيذ.*انتهت علاقته المباشرة.*مدير حسابه/);
    assert.doesNotMatch(model.decisionResultText({ status: 'pending', outcome: 'failed', code: 'execution_failed' }), /تم التنفيذ/);
    assert.equal(model.decisionResultText({ status: 'rejected' }), 'رُفض الطلب.');
    assert.equal(model.approvalState({ status: 'pending', can_decide: true, checks: [], execution: { available: true }, last_failure: { code: 'x' } }).label, 'إعادة المحاولة والتنفيذ');
});

test('106: نقل قابل للتنفيذ — الأثر من الخادم، والنجاح يُعرض فقط كما أكّده الخادم', { skip: !chromiumPath }, async () => {
    const impact = { membership: 'primary', direct_relationship: 'ended', platform_account_manager: 'ended', ticket_quota_owner: 'company',
                     historical_tickets: 'stay_private', conversations_and_attachments: 'stay_private', notifications: 'unchanged',
                     subscriptions: 'stay_with_customer', api_tokens_and_integrations: 'unchanged', login_identity: 'unchanged' };
    const { page, context, errors } = await open(browser, baseUrl, '/admin/account-requests.html', ownerFixtures({
        type: 'transfer_direct_to_company', legacyTransfer: false, execution: { available: true, missing: [] }, impact,
        decideResult: { request_id: R1, status: 'approved', primary: true, direct_relationship_ended: true, platform_manager_ended: false } }));
    await page.click('[data-open]');
    await page.waitForSelector('#arApprove:not([disabled])');
    const body = await page.textContent('#arDrawerBody');
    assert.match(body, /تنتهي علاقته المباشرة بالمنصة/);
    assert.match(body, /تذاكره السابقة تبقى خاصة به/);
    assert.match(body, /اشتراكاته تبقى باسمه/);
    assert.doesNotMatch(body, /غير متاح بعد/);
    await page.click('#arApprove');
    await page.waitForSelector('#arResult');
    assert.match(await page.textContent('#arResult'), /تم التنفيذ: أصبح العميل عضوًا أساسيًا في الشركة، وانتهت علاقته المباشرة/);
    assert.equal(await page.getAttribute('#arResult', 'data-kind'), 'success');
    assert.deepEqual(await calls(page, 'owner_decide_account_request'), [{ p_request: R1, p_approve: true, p_reason: null }]);
    assert.deepEqual(errors, []);
    await context.close();
});

test('106: فشل تنفيذ مسجَّل — لا رسالة نجاح، وشارة «قابل للإعادة»، وزر إعادة المحاولة', { skip: !chromiumPath }, async () => {
    const lastFailure = { code: 'revalidation_failed', check: 'no_active_personal_subscription', at: '2026-10-19T10:00:00Z' };
    const { page, context, errors } = await open(browser, baseUrl, '/admin/account-requests.html', ownerFixtures({
        execution: { available: true, missing: [] }, lastFailure,
        decideResult: { request_id: R1, status: 'pending', outcome: 'failed', recoverable: true, code: 'execution_failed' } }));
    await page.waitForSelector('[data-open]');
    assert.match(await page.textContent('#arBody'), /فشل التنفيذ — قابل للإعادة/);
    await page.click('[data-open]');
    await page.waitForSelector('#arApprove:not([disabled])');
    assert.match(await page.textContent('#arApprove'), /إعادة المحاولة والتنفيذ/);
    assert.match(await page.textContent('#arDrawerBody'), /اشتراك شخصي/);
    await page.click('#arApprove');
    await page.waitForSelector('#arResult');
    const result = await page.textContent('#arResult');
    assert.doesNotMatch(result, /تم التنفيذ/);
    assert.match(result, /لم يتغير شيء/);
    assert.equal(await page.getAttribute('#arResult', 'data-kind'), 'error');
    assert.deepEqual(errors, []);
    await context.close();
});

test('106: مقدّم الطلب يرى «فشل قابل للإعادة» ونتيجة التنفيذ الفعلية', { skip: !chromiumPath }, async () => {
    const fx = adminFixtures();
    fx.rpc.account_requests_overview = { can_submit: true, is_owner: false, owner_step_up: false,
        execution: { add_to_company: { available: true, missing: [] }, transfer_direct_to_company: { available: true, missing: [] } } };
    fx.rpc.my_account_requests = [
        { id: R1, request_type: 'transfer_direct_to_company', status: 'pending', customer_id: C1, customer_name: 'عميل 1', customer_email: 'c1@example.test',
          company_name: 'شركة أ', reason: 'سبب', requester_name: 'إداري', requested_at: '2026-10-19T09:00:00Z', attempts: 2,
          last_failure: { code: 'prerequisite_not_enabled', missing: ['company_isolation_enforced'], at: '2026-10-19T10:00:00Z' } },
        { id: 'r2000000-0000-4000-8000-000000000002', request_type: 'transfer_direct_to_company', status: 'approved', customer_id: C1, customer_name: 'عميل 2',
          customer_email: 'c2@example.test', company_name: 'شركة أ', reason: 'سبب', requester_name: 'إداري', requested_at: '2026-10-18T09:00:00Z',
          outcome: { primary: true, direct_relationship_ended: true, platform_manager_ended: true } }];
    const { page, context, errors } = await open(browser, baseUrl, '/admin/account-requests.html', fx);
    await page.waitForSelector('[data-open]');
    assert.match(await page.textContent('#arBody'), /فشل التنفيذ — قابل للإعادة/);
    assert.match(await page.textContent('#arBanner'), /نقل عميل مباشر إلى شركة: التنفيذ متاح/);
    await page.click(`[data-open="${R1}"]`);
    await page.waitForSelector('#arCancelForm');
    assert.match(await page.textContent('#arDrawerBody'), /عزل الشركات/);
    await page.click('#arDrawerClose');
    await page.click('[data-open="r2000000-0000-4000-8000-000000000002"]');
    await page.waitForFunction(() => /تم التنفيذ/.test(document.querySelector('#arDrawerBody').textContent));
    assert.match(await page.textContent('#arDrawerBody'), /انتهت علاقته المباشرة.*مدير حسابه/);
    assert.deepEqual(errors, []);
    await context.close();
});

test('create-sub-user يعلّم حساب الشركة بعلامة الخدمة وحده (لا علاقة مباشرة له)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'supabase/functions/create-sub-user/index.ts'), 'utf8');
    assert.match(src, /\.\.\.\(attachToCompany \? \{ app_metadata: \{ company_created: true \} \} : \{\}\)/);
    // العلامة في app_metadata (لا يكتبها المستخدم)، لا في user_metadata
    assert.doesNotMatch(src, /user_metadata:[^}]*company_created/);
    const mig = fs.readFileSync(path.join(ROOT, 'migrations/105_account_hierarchy_customers.sql'), 'utf8');
    assert.match(mig, /raw_app_meta_data ->> 'company_created'/);
});

test('الواجهة لا تحمل مفتاح خدمة ولا تكتب في جداول 105 مباشرةً', () => {
    for (const f of ['assets/js/admin/customers.js', 'assets/js/admin/account-requests.js', 'assets/js/admin/customers-model.js',
                     'admin/customers.html', 'admin/account-requests.html']) {
        const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
        assert.doesNotMatch(src, /service_role|SERVICE_ROLE|sb_secret_/, f);
        assert.doesNotMatch(src, /\.from\(['"](account_requests|customer_account_managers|platform_direct_customers|profiles)['"]\)/, f);
    }
});
