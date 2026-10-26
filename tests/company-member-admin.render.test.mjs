/**
 * إدارة عضو الشركة في لوحة الشركة (113) — الصفحة الحقيقية في Chromium فعلي مقابل بديل Supabase.
 * الحمولة بشكل ما تعيده company_member_details حرفيًا. القرار والعزل في القاعدة
 * (tests/sql/company-member-management.test.sql) وعبر HTTP (tests/http/company-member-admin-http.test.mjs)؛
 * هنا العرض: من يرى الأدوات، وأن كل فعل ينادي الدالة الصحيحة بمعاملاتها، ولا «نجاح» بلا نجاح.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import {
    historyLabel, accountEditView, transferView, validateAccountForm, validateTransferForm, validateProfileForm
} from '../assets/js/company/member-admin-model.js';

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
const M1 = '22222222-2222-4222-8222-222222222222';
const M2 = '33333333-3333-4333-8333-333333333333';
const SUS = '44444444-4444-4444-8444-444444444444';

function companyPayload() {
    return {
        company: { id: COMPANY_ID, name: 'شركة النور', cr_number: '1010101010', cr_expiry: '2027-06-01', status: 'active',
                   email: null, phone: null, address: null, city: null, country: null, website: null, industry: null,
                   tax_id: null, created_at: '2026-01-01T00:00:00Z', is_owner: true },
        registration: { expiry_date: '2027-06-01', is_expired: false, days_to_expiry: 267 },
        subscriptions: [{ id: 's1', plan: 'bundle', plan_name_ar: 'الباقة الشاملة', status: 'active', billing_cycle: 'yearly',
                          start_date: '2026-01-01T00:00:00Z', end_date: '2026-12-01T00:00:00Z', is_active: true, days_remaining: 85 }],
        entitlements: [{ feature_key: 'sub_users', name_ar: 'المستخدمون الفرعيون', description: '', limits: {}, granted_by: ['bundle'] }],
        access: { active_plans: ['bundle'], has_active_subscription: true }
    };
}

/** company_member_details() بشكلها حرفيًا. */
function details(over = {}) {
    return {
        user_id: M1, state: 'active',
        account: { name: 'عميل مُنشأ', full_name: 'عميل مُنشأ', email: 'm1@x.test', phone: '+201001112222',
                   created_at: '2026-09-01T00:00:00Z', created_by_company: true, editable: true, not_editable_reason: null },
        company_profile: { display_name: 'أبو أحمد', phone: null, job_title: 'مشتريات', notes: '<b>نوت</b>', updated_at: '2026-10-01T00:00:00Z' },
        membership: { joined_at: '2026-09-01T00:00:00Z', joined_via: 'legacy' },
        staff_role: null, suspension: null,
        transfer: { can_request: true, blocked_reason: null, pending: null },
        tickets: { total: 3, open: 1, assigned_open: null, last_activity_at: '2026-10-20T00:00:00Z',
                   recent: [{ id: 't1', ticket_number: 1001, title: 'طلبي <img src=x onerror=alert(1)>', status: 'open', created_at: '2026-10-20T00:00:00Z' }] },
        history: [{ kind: 'membership', action: 'member_profile_updated', at: '2026-10-01T00:00:00Z', cause: null, by_company: true },
                  { kind: 'staff', action: 'revoked', at: '2026-09-15T00:00:00Z', role_from: 'agent', role_to: null, cause: 'admin', by_company: true },
                  { kind: 'membership', action: 'joined', at: '2026-09-01T00:00:00Z', cause: null, by_company: false }],
        ...over
    };
}

function fixtures({ canManage = true, memberDetails = details(), functions = {}, rpc = {} } = {}) {
    return {
        user: { id: USER_ID, email: 'owner@company.test' },
        authUser: { id: USER_ID, email: 'owner@company.test', profile: { id: USER_ID, full_name: 'مالك الشركة', role: 'company_admin' } },
        rpc: {
            get_my_company_dashboard: companyPayload(),
            current_company_id: COMPANY_ID,
            my_account_kind: 'company_admin',
            company_members: { company_id: COMPANY_ID, is_owner: true, can_manage: canManage, scope: canManage ? 'full' : 'self', members: [
                { id: USER_ID, name: 'مالك الشركة', email: 'owner@company.test', role: 'company_admin', is_owner: true, is_me: true, created_at: '2026-01-01T00:00:00Z' },
                { id: M1, name: 'عميل مُنشأ', email: 'm1@x.test', role: 'company_user', is_owner: false, is_me: false, created_at: '2026-09-01T00:00:00Z' },
                { id: M2, name: 'عميل مدعو', email: 'm2@x.test', role: 'company_user', is_owner: false, is_me: false, created_at: '2026-09-02T00:00:00Z' }] },
            company_member_details: memberDetails,
            company_member_suspensions_list: canManage ? [{ user_id: SUS, name: 'موقوف', email: 'sus@x.test', suspended_at: '2026-10-10T00:00:00Z', reason: 'إجازة طويلة', was_staff: false }] : null,
            company_member_transfer_requests: canManage ? [
                { id: 'x1', user_id: M2, name: 'عميل مدعو', dest_ref: 'CR-9', reason: 'انتقل لفرع آخر', status: 'pending', created_at: '2026-10-11T00:00:00Z', expires_at: '2026-10-25T00:00:00Z' },
                { id: 'x2', user_id: M2, name: 'عميل مدعو', dest_ref: 'CR-8', reason: 'محاولة سابقة', status: 'rejected', decision_reason: 'الوجهة غير معروفة', created_at: '2026-10-01T00:00:00Z' }] : null,
            company_member_profile_save: { changed: true, fields: ['display_name'] },
            company_member_suspend: { suspended: true },
            company_member_reactivate: { reactivated: true },
            company_member_transfer_request: { request_id: 'x3', status: 'pending' },
            company_member_transfer_cancel: { request_id: 'x1', status: 'cancelled' },
            ...rpc
        },
        functions,
        tables: { profiles: [{ id: USER_ID, email: 'owner@company.test', full_name: 'مالك الشركة', role: 'company_admin' }],
                  notifications: [], services: [], whatsapp_subscriptions: [], subscription_plans: [], tickets: [], ticket_replies: [] }
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

async function openMembers(fx, opts) {
    const opened = await openPage(browser, baseUrl, fx, '/company-dashboard/index.html#members');
    const { page } = opened;
    if (opts?.viewport) await page.setViewportSize(opts.viewport);
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.waitForSelector('#membersTabContent.active', { timeout: 10000 });
    await page.waitForSelector('#companyMembers .company-sub-list', { timeout: 10000 });
    return { ...opened, errors };
}
const rpcArgs = (page, name) => page.evaluate(n => (window.__RPC_ARGS__ || []).filter(([x]) => x === n).map(([, a]) => a), name);
const invocations = (page) => page.evaluate(() => (window.__INVOCATIONS__ || []).filter(i => i.name === 'company-member-admin').map(i => i.body));
const toasts = (page) => page.evaluate(() => document.getElementById('ui-toast-container')?.textContent || '');
async function openDetails(page, id = M1) {
    await page.click(`[data-member-details="${id}"]`);
    await page.waitForSelector('#memberDetailsModal.active #mdProfileForm', { timeout: 5000 });
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
if (!chromiumPath) console.error('SKIP: لا يوجد متصفح Chromium متاح؛ اختبارات إدارة عضو الشركة لم تُنفَّذ');
const opts = { skip: !chromiumPath };
test.before(async () => {
    if (!chromiumPath) return;
    server = await startServer();
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: chromiumPath });
});
test.after(async () => { await browser?.close(); server?.close(); });

test('النموذج: السجل والحساب والنقل والتحقق', () => {
    assert.equal(historyLabel({ kind: 'staff', action: 'granted', role_to: 'supervisor' }), 'مُنح دور مشرف');
    assert.equal(historyLabel({ kind: 'membership', action: 'ended', cause: 'suspended' }), 'انتهت العضوية (إيقاف مؤقت)');
    assert.equal(historyLabel({ kind: 'membership', action: 'unknown' }), 'حدث');
    assert.equal(accountEditView({ account: { editable: true } }).editable, true);
    assert.match(accountEditView({ account: { editable: false, not_editable_reason: 'not_company_created' } }).note, /انضم بدعوة/);
    assert.match(accountEditView({ account: { editable: false, not_editable_reason: 'not_exclusive' } }).note, /جهات أخرى/);
    assert.match(transferView({ transfer: { can_request: false, blocked_reason: 'staff' } }).note, /أزل دوره/);
    assert.equal(transferView({ transfer: { can_request: true } }).note, null);
    assert.equal(validateAccountForm({ fullName: 'اسم', phone: '', email: 'a@b.co' }, { hadPhone: true }).errors.phone.includes('لا يُحذف'), true);
    assert.equal(validateAccountForm({ fullName: 'اسم', phone: '0100 111 2222', email: 'a@b.co' }).ok, true);
    assert.equal(validateAccountForm({ fullName: 'ا', phone: '', email: 'bad' }).ok, false);
    assert.equal(validateTransferForm({ destRef: 'CR-1', reason: 'قصير' }).ok, false);
    assert.equal(validateTransferForm({ destRef: 'CR-1', reason: 'سبب نقل واضح' }).ok, true);
    assert.equal(validateProfileForm({ phone: 'abc' }).ok, false);
});

test('المدير: زر التفاصيل لكل عضو غيره، والنافذة ترسم الأقسام بنصوص مهرَّبة، والقائمتان ظاهرتان', opts, async () => {
    const { page, context, errors } = await openMembers(fixtures());
    assert.equal(await page.locator(`[data-member-details="${USER_ID}"]`).count(), 0, 'زر لمالك الشركة');
    assert.equal(await page.locator('#companyMembers [data-member-details]').count(), 2);
    await page.waitForSelector('#companySuspendedMembers:not([hidden]) [data-suspended]');
    assert.match(await page.textContent('#companySuspendedMembers'), /موقوفون مؤقتًا[\s\S]*إجازة طويلة/);
    const xfers = await page.textContent('#companyMemberTransfers');
    assert.match(xfers, /بانتظار المنصة/);
    assert.match(xfers, /سبب الرفض: الوجهة غير معروفة/);
    assert.equal(await page.locator('[data-cancel-transfer="x1"]').count(), 1);
    assert.equal(await page.locator('[data-cancel-transfer="x2"]').count(), 0);

    await openDetails(page);
    assert.equal(await page.textContent('#memberDetailsTitle'), 'أبو أحمد');
    const body = await page.textContent('#memberDetailsBody');
    assert.match(body, /3 تذكرة · 1 مفتوحة/);
    assert.match(body, /حُدّث ملفه لدى الشركة/);
    assert.match(body, /أُلغي دوره في الفريق/);
    assert.equal(await page.locator('#memberDetailsBody img').count(), 0, 'عنوان التذكرة غير مهرَّب');
    assert.equal(await page.inputValue('#mdNotes'), '<b>نوت</b>');
    assert.equal(await page.locator('#mdAccountForm').count(), 1);
    assert.equal(await page.inputValue('#mdAccountEmail'), 'm1@x.test');
    assert.equal(await page.locator('#mdSuspendForm').count(), 1);
    assert.equal(await page.locator('#mdReactivateBtn').count(), 0);
    assert.equal(await page.locator('#mdTransferForm').count(), 1);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#memberDetailsModal.active').count(), 0);
    assert.deepEqual(errors, []);
    await context.close();
});

test('ملف الشركة، وبيانات الدخول بتأكيد تغيير البريد، والخطأ يبقى في النموذج', opts, async () => {
    const fx = fixtures({ functions: { 'company-member-admin': { status: 409, body: { status: 'email_unavailable', error: 'لا يمكن استخدام هذا البريد لهذا الحساب.' } } } });
    const { page, context } = await openMembers(fx);
    await openDetails(page);
    await page.fill('#mdProfilePhone', 'abc');
    await page.click('#mdProfileSave');
    assert.match(await page.textContent('#mdProfileForm'), /رقم الجوال غير صالح/);
    assert.deepEqual(await rpcArgs(page, 'company_member_profile_save'), []);
    await page.fill('#mdProfilePhone', '0100 555 6666');
    await page.fill('#mdDisplayName', 'أبو محمد');
    await page.click('#mdProfileSave');
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'company_member_profile_save'));
    assert.deepEqual((await rpcArgs(page, 'company_member_profile_save'))[0],
        { p_user: M1, p_display_name: 'أبو محمد', p_phone: '0100 555 6666', p_job_title: 'مشتريات', p_notes: '<b>نوت</b>' });
    await page.waitForSelector('#memberDetailsModal.active #mdAccountForm');

    // حذف الجوال يُرفض في المتصفح قبل أي نداء (بوابة الحساب تعدّه توثيقًا)
    await page.fill('#mdAccountPhone', '');
    await page.click('#mdAccountSave');
    assert.match(await page.textContent('#mdAccountForm'), /لا يُحذف/);
    assert.deepEqual(await invocations(page), []);
    await page.fill('#mdAccountPhone', '+201001112222');
    await page.fill('#mdAccountEmail', 'New.M1@X.test');
    await page.click('#mdAccountSave');
    await page.getByRole('button', { name: 'تغيير البريد' }).click();
    await page.waitForFunction(() => (window.__INVOCATIONS__ || []).some(i => i.name === 'company-member-admin'));
    assert.deepEqual((await invocations(page))[0], { action: 'update_account', user_id: M1, full_name: 'عميل مُنشأ', phone: '+201001112222', email: 'new.m1@x.test' });
    await page.waitForFunction(() => /لا يمكن استخدام هذا البريد/.test(document.querySelector('#mdAccountForm [data-md-form-error]')?.textContent || ''));
    assert.doesNotMatch(await toasts(page), /حُفظت/);
    await context.close();
});

test('تراجع عن تأكيد تغيير البريد: لا نداء', opts, async () => {
    const { page, context } = await openMembers(fixtures());
    await openDetails(page);
    await page.fill('#mdAccountEmail', 'other@x.test');
    await page.click('#mdAccountSave');
    await page.getByRole('button', { name: 'تراجع' }).click();
    assert.deepEqual(await invocations(page), []);
    await context.close();
});

test('رابط إعادة كلمة المرور، والإيقاف بسبب وتأكيد، وطلب النقل بمفتاح منع تكرار', opts, async () => {
    const fx = fixtures({ functions: { 'company-member-admin': { data: { status: 'reset_sent', message: 'أُرسل رابط إعادة تعيين كلمة المرور إلى بريد العضو.' } } } });
    const { page, context } = await openMembers(fx);
    await openDetails(page);
    await page.click('#mdResetBtn');
    await page.waitForFunction(() => /أُرسل رابط إعادة تعيين/.test(document.getElementById('ui-toast-container')?.textContent || ''));
    assert.deepEqual((await invocations(page))[0], { action: 'password_reset', user_id: M1 });

    await page.waitForSelector('#memberDetailsModal.active #mdSuspendForm');
    await page.fill('#mdSuspendReason', 'قصير');
    await page.click('#mdSuspendBtn');
    assert.match(await page.textContent('#mdSuspendForm'), /10 أحرف/);
    assert.deepEqual(await rpcArgs(page, 'company_member_suspend'), []);
    await page.fill('#mdSuspendReason', 'إجازة حتى نهاية الشهر');
    await page.click('#mdSuspendBtn');
    await page.getByRole('button', { name: 'إيقاف', exact: true }).click();
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'company_member_suspend'));
    assert.deepEqual((await rpcArgs(page, 'company_member_suspend'))[0], { p_user: M1, p_reason: 'إجازة حتى نهاية الشهر' });

    await page.waitForSelector('#memberDetailsModal.active #mdTransferForm');
    await page.fill('#mdDestRef', 'CR-555');
    await page.fill('#mdTransferReason', 'انتقل العميل لفرع آخر');
    await page.click('#mdTransferSubmit');
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'company_member_transfer_request'));
    const [args] = await rpcArgs(page, 'company_member_transfer_request');
    assert.equal(args.p_user, M1);
    assert.equal(args.p_dest_ref, 'CR-555');
    assert.equal(args.p_reason, 'انتقل العميل لفرع آخر');
    assert.match(args.p_idempotency_key, /^[0-9a-f-]{36}$/);
    await context.close();
});

test('حساب انضم بدعوة وعضو في الفريق: لا نموذج دخول، والنقل يشرح السبب؛ والموقوف يُعاد تفعيله', opts, async () => {
    const fx = fixtures({ memberDetails: details({
        user_id: M2, state: 'suspended', staff_role: null,
        account: { name: 'عميل مدعو', full_name: 'عميل مدعو', email: 'm2@x.test', phone: null, editable: false, not_editable_reason: 'not_company_created' },
        membership: null, suspension: { id: 's1', suspended_at: '2026-10-10T00:00:00Z', reason: 'مراجعة الحساب', was_staff: true },
        transfer: { can_request: false, blocked_reason: 'suspended', pending: null } }) });
    const { page, context } = await openMembers(fx);
    await openDetails(page, M2);
    assert.equal(await page.locator('#mdAccountForm').count(), 0);
    const body = await page.textContent('#memberDetailsBody');
    assert.match(body, /انضم بدعوة/);
    assert.match(body, /موقوف مؤقتًا/);
    assert.match(body, /مراجعة الحساب/);
    assert.match(body, /ودوره في الفريق/);
    assert.equal(await page.locator('#mdResetBtn').count(), 0);
    assert.equal(await page.locator('#mdSuspendForm').count(), 0);
    await page.click('#mdReactivateBtn');
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'company_member_reactivate'));
    assert.deepEqual((await rpcArgs(page, 'company_member_reactivate'))[0], { p_user: M2 });
    await context.close();
});

test('غير المدير: لا زر تفاصيل ولا قوائم، ولا نداء لدوال الإدارة', opts, async () => {
    const { page, context } = await openMembers(fixtures({ canManage: false }));
    assert.equal(await page.locator('[data-member-details]').count(), 0);
    assert.equal(await page.locator('#companySuspendedMembers').isHidden(), true);
    assert.equal(await page.locator('#companyMemberTransfers').isHidden(), true);
    const called = await page.evaluate(() => (window.__RPC_CALLS__ || []).filter(n => n.startsWith('company_member_')));
    assert.deepEqual(called, []);
    await context.close();
});

test('390px: النافذة داخل الشاشة بلا تمرير أفقي', opts, async () => {
    const { page, context } = await openMembers(fixtures(), { viewport: { width: 390, height: 844 } });
    await openDetails(page);
    const box = await page.locator('#memberDetailsModal .modal-content').boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 390 + 1, JSON.stringify(box));
    const overflow = await page.evaluate(() => document.querySelector('#memberDetailsModal .modal-content').scrollWidth
        - document.querySelector('#memberDetailsModal .modal-content').clientWidth);
    assert.ok(overflow <= 1, `تمرير أفقي ${overflow}px`);
    await context.close();
});
