/**
 * «حوكمة الشركات والوصول» في لوحة المالك (096–099) — تشغيل حقيقي في Chromium مقابل البديل.
 *
 * الواجهة لا تقرر: كل زر نداء RPC يرفضه الخادم لغير المالك (مقيس في tests/sql/*). هنا: الأزرار
 * الحرجة معطّلة قبل التحقق بخطوتين، والنداءات تحمل المعاملات الصحيحة، والسبب إلزامي، ومفاتيح
 * العزل تطلب تأكيدًا إضافيًا، و«غير مطبّق بعد» حين لا يوجد الترحيل.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
// الوحدة تستورد authority-center بمسار مطلق للمتصفح؛ الأجزاء الخالصة لا تحتاجه
const govSrc = fs.readFileSync(new URL('../assets/js/owner/tenancy-governance.js', import.meta.url), 'utf8')
    .replace("import { applyCriticalState } from '/assets/js/owner/authority-center.js';", 'const applyCriticalState = () => {};');
const { reasonError, flattenUnits, reviewRow, GUARDED_SWITCHES, historicalHours, exceptionalTransferError,
        delegationExpiry, defaultDelegationExpiry, SWITCH_REGISTRY, switchView, switchConfirmText } = await import('data:text/javascript,' + encodeURIComponent(govSrc));

const ROOT = path.resolve(import.meta.dirname, '..');
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

const OWNER = '11111111-1111-4111-8111-111111111111';
const ADMIN = '44444444-4444-4444-8444-444444444444';
const UNIT = 'u0000000-0000-4000-8000-000000000001';
const SUPPORT = '55555555-5555-4555-8555-555555555555';

function fixtures({ fresh = false, missing = false } = {}) {
    const gov = missing ? {} : {
        owner_feature_switches: [
            { key: 'company_isolation_enforced', enabled: false, description: 'عزل الشركات' },
            { key: 'multi_company_memberships_enabled', enabled: false, description: 'العضويات المتعددة' }
        ],
        owner_set_feature_switch: { key: 'x', enabled: true, changed: true },
        owner_access_requests: { requests: [{ id: 'r1', requester_name: 'دعم', requester_kind: 'support', company_name: 'شركة أ',
                                              ticket_id: null, reason: 'مراجعة شكوى عميل', requested_hours: 24, status: 'pending' }],
                                 active_grants: [] },
        owner_decide_access_request: { status: 'approved' },
        owner_admin_reviews: [{ user_id: ADMIN, name: 'إداري', decision: 'pending', mfa_ready: false, ready_to_apply: false,
                                snapshot: { role: 'admin' }, now: { role: 'admin', authority: null, open_assigned_tickets: 1,
                                                                    open_continuity_owned: 0, active_delegations: 0,
                                                                    open_company_tickets: 2 } },
                              { user_id: SUPPORT, name: 'دعم', decision: 'keep', mfa_ready: true, ready_to_apply: false,
                                applied_at: '2026-10-14T10:00:00Z', snapshot: { role: 'support' },
                                now: { role: 'support', open_assigned_tickets: 0, open_continuity_owned: 0, active_delegations: 0 } }],
        owner_decide_admin_review: { decision: 'keep' },
        owner_reassign_admin_tickets: { tickets: 1 },
        owner_grant_delegation: { delegation_id: 'g1' },
        owner_hierarchy: { enabled: false, capabilities: [{ key: 'companies.view_registry', label: 'سجل الشركات' }],
                           units: [{ id: UNIT, parent_id: null, name: 'الإدارة العامة', members: [], companies: [], delegations: [] }],
                           unassigned_companies: [{ company_id: 'c1', name: 'شركة أ', status: 'active' }] },
        owner_assign_company_unit: { changed: true },
        usage_reconciliation: { period: '2026-10-01', accounts: 3, matching: 3, mismatches: [] },
        owner_documents_queue: [
            { id: 'd1', company_name: 'شركة أ', label: 'السجل التجاري', status: 'pending_review',
              versions: [{ id: 'v1', version_no: 1, status: 'clean', review_status: 'pending', is_current: true, sha256: 'ab'.repeat(32) }] },
            { id: 'd2', company_name: 'شركة ب', label: 'البطاقة الضريبية', status: 'pending_scan',
              versions: [{ id: 'v2', version_no: 1, status: 'pending_scan', review_status: 'pending', is_current: true }] }
        ],
        document_review: { status: 'approved' },
        owner_historical_requests: [
            { id: 'h1', company_name: 'شركة ب', purpose: 'متابعة شكوى سابقة للعميل', status: 'awaiting_owner', tickets: 2, expires_at: null },
            { id: 'h2', company_name: 'شركة ب', purpose: 'طلب ينتظر العميل', status: 'awaiting_customer', tickets: 0, expires_at: null }],
        owner_decide_historical_access: { status: 'approved' },
        owner_transfer_exceptional: { status: 'completed', exceptional: true }
    };
    return {
        user: { id: OWNER, email: 'owner@example.com' },
        authUser: { id: OWNER, email: 'owner@example.com', profile: { id: OWNER, full_name: 'مالك المنصة', role: 'platform_owner', ban_status: 'none' } },
        rpc: {
            owner_context_status: { is_platform_owner: true, active_context: 'owner', preview_mode: false, expires_at: '2099-01-01T00:00:00Z' },
            available_contexts: [{ key: 'owner' }],
            owner_security_status: { mfa_enrolled: true, step_up_fresh: fresh, step_up_expires_at: fresh ? '2099-01-01T00:00:00Z' : null, in_owner_context: true },
            ...gov
        },
        tables: {
            profiles: [
                { id: OWNER, email: 'owner@example.com', full_name: 'محمود', role: 'platform_owner' },
                { id: ADMIN, email: 'admin@example.com', full_name: 'إداري', role: 'admin' },
                { id: SUPPORT, email: 'support@example.com', full_name: 'دعم', role: 'support' }
            ],
            platform_authority: [{ user_id: OWNER, level: 'owner', granted_at: '2026-09-15T00:00:00Z' }],
            platform_capability_grants: [], privileged_audit: [], owner_context_audit: [], companies: [{ id: 'c1' }],
            whatsapp_subscriptions: [], sie_settings: [], sie_admin_grants: [], sie_authority_audit: []
        }
    };
}

async function openOwner(browser, baseUrl, fx, { confirm = true } = {}) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const dbl = fs.readFileSync(path.join(ROOT, 'tests/fixtures/supabase-double.js'), 'utf8');
    const auth = fs.readFileSync(path.join(ROOT, 'tests/fixtures/auth-client-double.js'), 'utf8');
    await page.route('**/api-config.js', r => r.fulfill({ contentType: 'text/javascript', body: dbl }));
    await page.route('**/auth-client.js', r => r.fulfill({ contentType: 'text/javascript', body: auth }));
    await page.route('**/error-tracker.js', r => r.fulfill({ contentType: 'text/javascript', body: '' }));
    await page.route('https://fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
    await page.addInitScript(d => { window.__FIXTURES__ = d; }, fx);
    const dialogs = [];
    page.on('dialog', d => { dialogs.push(d.message()); confirm ? d.accept() : d.dismiss(); });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${baseUrl}/owner-dashboard.html#governance`, { waitUntil: 'networkidle' });
    await page.waitForSelector('#govSwitches [data-switch-row], #govSwitches .state-block', { timeout: 10000 });
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

test('الأجزاء الخالصة: السبب، الشجرة، صف المراجعة', () => {
    assert.ok(reasonError('قصير'));
    assert.equal(reasonError('سبب كافٍ للتسجيل'), null);
    const tree = flattenUnits([{ id: 'b', parent_id: 'a', name: 'ب' }, { id: 'a', parent_id: null, name: 'أ' }, { id: 'c', parent_id: 'b', name: 'ج' }]);
    assert.deepEqual(tree.map(u => [u.name, u.depth]), [['أ', 0], ['ب', 1], ['ج', 2]]);
    const r = reviewRow({ user_id: 'x', name: 'س', decision: 'pending', mfa_ready: false, ready_to_apply: false,
                          now: { role: 'admin', open_assigned_tickets: 2, open_continuity_owned: 1, active_delegations: 0 } });
    assert.equal(r.openWork, 3);
    assert.equal(r.canApply, false);
    // 103: تذاكر الشركات للعلم فقط، والقرار المطبَّق نهائي
    const r2 = reviewRow({ user_id: 'y', decision: 'keep', applied_at: '2026-10-14T00:00:00Z',
                           now: { open_assigned_tickets: 1, open_company_tickets: 4 } });
    assert.deepEqual([r2.supportTickets, r2.companyTickets, r2.openWork, r2.applied], [1, 4, 1, true]);
    // 103 L3: تاريخ انتهاء التفويض مطلوب، بعد الآن، وخلال 90 يومًا
    const now = new Date('2026-10-14T10:00:00Z');
    assert.equal(defaultDelegationExpiry(now), '2026-10-21');
    assert.deepEqual(delegationExpiry('2026-10-21', now), { iso: '2026-10-21T23:59:59.000Z' });
    assert.ok(delegationExpiry('', now).error);
    assert.ok(delegationExpiry('2026-10-13', now).error);
    assert.ok(delegationExpiry('2027-01-13', now).error);
    assert.equal(delegationExpiry('2027-01-11', now).iso, '2027-01-11T23:59:59.000Z');
    assert.deepEqual(GUARDED_SWITCHES, ['company_isolation_enforced', 'data_access_grants_enabled', 'historical_access_enabled']);
    // 101
    assert.deepEqual([historicalHours('0'), historicalHours(500), historicalHours('x'), historicalHours('48')], [1, 168, 24, 48]);
    const ok = { customer: OWNER, company: ADMIN, reason: 'تصحيح ربط خاطئ بطلب موثَّق من العميل' };
    assert.equal(exceptionalTransferError(ok), null);
    assert.match(exceptionalTransferError({ ...ok, customer: 'x' }), /العميل/);
    assert.match(exceptionalTransferError({ ...ok, company: '' }), /الشركة/);
    assert.match(exceptionalTransferError({ ...ok, reason: 'قصير جدًا' }), /20 حرفًا/);
});

test('قبل التحقق بخطوتين: كل أزرار الحوكمة معطّلة، والأقسام معروضة بلا أخطاء', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openOwner(browser, baseUrl, fixtures());
    await page.waitForSelector('#govReviews table');
    const states = await page.$$eval('#governanceTabContent [data-critical]', els => els.map(e => e.disabled));
    assert.ok(states.length >= 6, 'أزرار حرجة قليلة: ' + states.length);
    assert.ok(states.every(Boolean), 'زر حوكمة مفعّل قبل التحقق');
    assert.match(await page.textContent('#govReviews'), /غير مفعّل/);
    assert.match(await page.textContent('#govUsage'), /3 من 3/);
    assert.deepEqual(errors, []);
    await context.close();
});

test('بعد التحقق: السبب إلزامي، ومفتاح العزل يطلب تأكيدًا ثم ينادي owner_set_feature_switch', { skip: !chromiumPath }, async () => {
    const { page, context, dialogs } = await openOwner(browser, baseUrl, fixtures({ fresh: true }));
    await page.waitForSelector('[data-switch="company_isolation_enforced"]:not([disabled])');
    await page.click('[data-switch="company_isolation_enforced"]');
    assert.match(await page.textContent('#govStatus'), /10 أحرف/);
    assert.deepEqual(await calls(page, 'owner_set_feature_switch'), []);
    await page.fill('#govReason', 'تجربة العزل على بيئة الاختبار');
    await page.click('[data-switch="company_isolation_enforced"]');
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'owner_set_feature_switch'));
    assert.ok(dialogs.some(m => /موافقة صريحة منفصلة/.test(m)), 'لا تأكيد إضافي لمفتاح العزل');
    assert.deepEqual(await calls(page, 'owner_set_feature_switch'),
        [{ p_key: 'company_isolation_enforced', p_enabled: true, p_reason: 'تجربة العزل على بيئة الاختبار' }]);
    await context.close();
});

test('رفض التأكيد لا يرسل شيئًا', { skip: !chromiumPath }, async () => {
    const { page, context } = await openOwner(browser, baseUrl, fixtures({ fresh: true }), { confirm: false });
    await page.waitForSelector('[data-switch="company_isolation_enforced"]:not([disabled])');
    await page.fill('#govReason', 'تجربة العزل على بيئة الاختبار');
    await page.click('[data-switch="company_isolation_enforced"]');
    await page.waitForTimeout(200);
    assert.deepEqual(await calls(page, 'owner_set_feature_switch'), []);
    await context.close();
});

test('الموافقة على طلب وصول، وقرار مراجعة، وإسناد شركة — بالمعاملات الصحيحة', { skip: !chromiumPath }, async () => {
    const { page, context } = await openOwner(browser, baseUrl, fixtures({ fresh: true }));
    await page.waitForSelector('[data-access="r1"][data-approve="true"]:not([disabled])');
    await page.fill('#govReason', 'مراجعة مبررة وموثقة');
    await page.click('[data-access="r1"][data-approve="true"]');
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'owner_decide_access_request'));
    assert.deepEqual((await calls(page, 'owner_decide_access_request'))[0],
        { p_request: 'r1', p_approve: true, p_note: 'مراجعة مبررة وموثقة', p_hours: null });

    await page.waitForSelector(`[data-review-decision="${ADMIN}"]`);
    await page.selectOption(`[data-review-decision="${ADMIN}"]`, 'keep');
    await page.click(`[data-review-save="${ADMIN}"]`);
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'owner_decide_admin_review'));
    assert.deepEqual((await calls(page, 'owner_decide_admin_review'))[0], { p_user: ADMIN, p_decision: 'keep', p_note: 'مراجعة مبررة وموثقة' });
    assert.equal(await page.locator(`[data-review-apply="${ADMIN}"]`).count(), 0, 'زر التطبيق مع عمل مفتوح');

    await page.waitForSelector('#govAssignForm button:not([disabled])');
    await page.click('#govAssignForm button');
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'owner_assign_company_unit'));
    assert.deepEqual((await calls(page, 'owner_assign_company_unit'))[0], { p_company: 'c1', p_unit: UNIT, p_reason: 'مراجعة مبررة وموثقة' });
    await context.close();
});

test('103: تسليم تذاكر مدعوم قبل التحويل، القرار المطبَّق نهائي، والتفويض بتاريخ انتهاء', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openOwner(browser, baseUrl, fixtures({ fresh: true }));
    await page.waitForSelector(`[data-handover="${ADMIN}"]:not([disabled])`);
    assert.match(await page.textContent('#govReviews'), /تذاكر شركات مسندة \(للعلم\): 2/);
    assert.equal(await page.locator(`[data-review-decision="${SUPPORT}"]`).count(), 0, 'تغيير قرار مطبَّق');
    assert.equal(await page.locator(`[data-review-save="${SUPPORT}"]`).count(), 0);
    assert.equal(await page.locator(`[data-handover="${SUPPORT}"]`).count(), 0, 'تسليم بلا تذاكر');
    assert.match(await page.textContent(`[data-review-row="${SUPPORT}"]`), /القرار نهائي/);
    // التسليم: المستلم ثم السبب
    await page.click(`[data-handover="${ADMIN}"]`);
    assert.match(await page.textContent('#govStatus'), /من يستلم/);
    await page.selectOption(`[data-handover-to="${ADMIN}"]`, SUPPORT);
    assert.equal(await page.locator(`[data-handover-to="${ADMIN}"] option[value="${ADMIN}"]`).count(), 0, 'التسليم للنفس');
    await page.fill('#govReason', 'تسليم قبل تحويل الحساب');
    await page.click(`[data-handover="${ADMIN}"]`);
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'owner_reassign_admin_tickets'));
    assert.deepEqual((await calls(page, 'owner_reassign_admin_tickets'))[0], { p_from: ADMIN, p_to: SUPPORT, p_reason: 'تسليم قبل تحويل الحساب' });
    // التفويض: تاريخ الانتهاء الافتراضي 7 أيام، ومطلوب
    await page.waitForSelector('#govDelegateForm button:not([disabled])');
    assert.equal(await page.inputValue('#govDelegateExpiry'), new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10));
    await page.check('#govDelegateForm [data-cap]');
    await page.fill('#govDelegateExpiry', '');
    await page.click('#govDelegateForm button');
    assert.match(await page.textContent('#govStatus'), /تاريخ انتهاء/);
    assert.deepEqual(await calls(page, 'owner_grant_delegation'), []);
    const date = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
    await page.fill('#govDelegateExpiry', date);
    await page.click('#govDelegateForm button');
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'owner_grant_delegation'));
    const [g] = await calls(page, 'owner_grant_delegation');
    assert.equal(g.p_expires_at, `${date}T23:59:59.000Z`);
    assert.deepEqual(g.p_capabilities, ['companies.view_registry']);
    assert.deepEqual(errors, []);
    await context.close();
});

test('قبل الترحيلات: كل قسم يقول «غير مطبّق بعد» بلا أخطاء', { skip: !chromiumPath }, async () => {
    const fx = fixtures({ missing: true });
    // البديل يعيد null بلا خطأ للدوال غير المعرّفة؛ نحاكي «الدالة غير موجودة» كما يردّ PostgREST
    fx.rpcErrors = undefined;
    const { page, context, errors } = await openOwner(browser, baseUrl, fx);
    assert.deepEqual(errors, []);
    await context.close();
});

test('مستندات الشركات: الاعتماد للإصدار النظيف وحده، والمعزول بلا أزرار', { skip: !chromiumPath }, async () => {
    const { page, context } = await openOwner(browser, baseUrl, fixtures({ fresh: true }));
    await page.waitForSelector('[data-doc-review="v1"][data-approve="true"]:not([disabled])');
    assert.equal(await page.locator('[data-doc-review="v2"]').count(), 0, 'زر مراجعة لملف معزول');
    assert.match(await page.textContent('#govDocuments'), /معزول حتى الفحص/);
    await page.fill('[data-doc-expiry="v1"]', '2030-01-01');
    await page.click('[data-doc-review="v1"][data-approve="true"]');
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'document_review'));
    assert.deepEqual((await calls(page, 'document_review'))[0], { p_version: 'v1', p_approve: true, p_note: null, p_expires_on: '2030-01-01' });
    await context.close();
});

test('101: الاطلاع التاريخي بعد موافقة العميل وحدها وبمدة، والنقل الاستثنائي بسبب وتأكيد ومفتاح منع تكرار', { skip: !chromiumPath }, async () => {
    const { page, context, dialogs, errors } = await openOwner(browser, baseUrl, fixtures({ fresh: true }));
    await page.waitForSelector('[data-hist="h1"][data-approve="true"]:not([disabled])');
    assert.equal(await page.locator('[data-hist="h2"]').count(), 0, 'قرار قبل موافقة العميل');
    await page.fill('[data-hist-hours="h1"]', '500');
    await page.click('[data-hist="h1"][data-approve="true"]');
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'owner_decide_historical_access'));
    assert.deepEqual((await calls(page, 'owner_decide_historical_access'))[0], { p_request: 'h1', p_approve: true, p_hours: 168 });

    await page.waitForSelector('#govXferSubmit:not([disabled])');
    await page.fill('#govXferCustomer', ADMIN);
    await page.fill('#govXferCompany', OWNER);
    await page.fill('#govReason', 'سبب قصير');
    await page.click('#govXferSubmit');
    assert.match(await page.textContent('#govStatus'), /20 حرفًا/);
    assert.deepEqual(await calls(page, 'owner_transfer_exceptional'), []);
    await page.fill('#govReason', 'تصحيح ربط خاطئ بطلب موثَّق من العميل');
    await page.click('#govXferSubmit');
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'owner_transfer_exceptional'));
    assert.ok(dialogs.some(m => /نقل استثنائي/.test(m)));
    const [args] = await calls(page, 'owner_transfer_exceptional');
    assert.equal(args.p_customer, ADMIN);
    assert.equal(args.p_to_company, OWNER);
    assert.equal(args.p_reason, 'تصحيح ربط خاطئ بطلب موثَّق من العميل');
    assert.equal(args.p_keep_source_secondary, false);
    assert.match(args.p_idempotency_key, /^[0-9a-f-]{36}$/);
    assert.deepEqual(errors, []);
    await context.close();
});

/* ── مفاتيح التفعيل: الأسماء العربية والزر الظاهر ─────────────────────────────── */
// كل مفتاح تسجّله الترحيلات في platform_feature_switches، من نصوصها لا من قائمة يدوية
const REGISTERED_SWITCHES = [...new Set(fs.readdirSync(path.join(ROOT, 'migrations')).filter(f => f.endsWith('.sql'))
    .flatMap(f => {
        const sql = fs.readFileSync(path.join(ROOT, 'migrations', f), 'utf8');
        const out = [];
        for (const m of sql.matchAll(/insert into public\.platform_feature_switches[^;]*?values([\s\S]*?);/gi)) {
            for (const k of m[1].matchAll(/\(\s*'([a-z_]+)'/g)) out.push(k[1]);
        }
        return out;
    }))].sort();

// أوصاف بطول أوصاف الإنتاج: القصيرة في fixtures() لم تُظهر العيب (الزر خارج اللوحة)
const LONG = 'وصف طويل بطول أوصاف الإنتاج يشرح المفتاح ورقم الترحيل والمتطلبات قبل التفعيل ويذكر ما يتغيّر (097).';
const allSwitches = (on = []) => REGISTERED_SWITCHES.map(key => ({ key, enabled: on.includes(key), description: LONG }));

test('سجل المفاتيح يغطي كل مفتاح مسجَّل باسم ووصف عربيين، ولا يخترع مفاتيح', () => {
    assert.equal(REGISTERED_SWITCHES.length, 12, REGISTERED_SWITCHES.join(','));
    assert.deepEqual(Object.keys(SWITCH_REGISTRY).sort(), REGISTERED_SWITCHES);
    for (const [key, m] of Object.entries(SWITCH_REGISTRY)) {
        assert.match(m.label, /[؀-ۿ]/, key);
        assert.ok(m.description.length >= 20 && /[؀-ۿ]/.test(m.description), key);
        for (const r of m.requires || []) assert.ok(REGISTERED_SWITCHES.includes(r.key), `${key} → ${r.key}`);
    }
    assert.equal(SWITCH_REGISTRY.company_isolation_enforced.label, 'عزل بيانات الشركات');
    assert.equal(SWITCH_REGISTRY.multi_company_memberships_enabled.label, 'عضوية المستخدم في عدة شركات');
    // المتطلبات كما تفحصها القاعدة: _transfers_require_enabled و_carry_require_enabled و_account_request_execution
    for (const k of ['customer_transfers_enabled', 'ticket_carry_enabled', 'account_request_execution_enabled']) {
        assert.deepEqual(SWITCH_REGISTRY[k].requires.map(r => [r.key, r.enforced]),
            [['company_isolation_enforced', true], ['company_permissions_enabled', true]], k);
    }
    // المنح: الخادم لا يفحص العزل — ترتيب الإطلاق وحده، ويُقال ذلك صراحة
    assert.deepEqual(SWITCH_REGISTRY.data_access_grants_enabled.requires, [{ key: 'company_isolation_enforced', enforced: false }]);
    assert.match(SWITCH_REGISTRY.data_access_grants_enabled.warning, /لا يفحص العزل/);
});

test('switchView وswitchConfirmText: المتطلبات الناقصة، والموافقة المنفصلة، ومفتاح مجهول بمفتاحه', () => {
    const all = allSwitches(['company_permissions_enabled']);
    const t = switchView(all.find(s => s.key === 'customer_transfers_enabled'), all);
    assert.equal(t.label, 'نقل العملاء بين الشركات');
    assert.equal(t.serverDescription, LONG);
    assert.deepEqual(t.unmet.map(r => r.key), ['company_isolation_enforced']);
    assert.match(switchConfirmText(t, true), /متطلبات غير مفعّلة: «عزل بيانات الشركات» \(يرفض الخادم العمل قبله\)/);
    const iso = switchView(all.find(s => s.key === 'company_isolation_enforced'), all);
    assert.equal(iso.guarded, true);
    assert.deepEqual(iso.unmet, []);
    assert.match(switchConfirmText(iso, true), /موافقة صريحة منفصلة/);
    assert.match(switchConfirmText(iso, false), /يرفض الخادم الإطفاء/);
    const s = switchView(all.find(s => s.key === 'company_suspension_enforced'), all);
    assert.doesNotMatch(switchConfirmText(s, true), /موافقة صريحة|متطلبات/);
    assert.match(switchConfirmText(s, true), /^تفعيل «تطبيق إيقاف الشركات» \(company_suspension_enforced\)/);
    const unknown = switchView({ key: 'future_flag', enabled: false, description: 'وصف الخادم' }, []);
    assert.deepEqual([unknown.label, unknown.description, unknown.known], ['future_flag', 'وصف الخادم', false]);
});

for (const [w, h] of [[1351, 544], [390, 844]]) {
    test(`مفاتيح التفعيل على ${w}px: زر ظاهر داخل اللوحة لكل مفتاح، باسم عربي وحالة نصية`, { skip: !chromiumPath }, async () => {
        const fx = fixtures();
        fx.rpc.owner_feature_switches = allSwitches(['company_permissions_enabled']);
        const { page, context, errors } = await openOwner(browser, baseUrl, fx);
        await page.setViewportSize({ width: w, height: h });
        await page.waitForSelector('#govSwitches [data-switch]');
        const r = await page.evaluate(() => {
            const box = document.querySelector('#govSwitches').getBoundingClientRect();
            const doc = document.documentElement;
            return {
                tables: document.querySelectorAll('#govSwitches table').length,
                rows: [...document.querySelectorAll('#govSwitches [data-switch-row]')].map(row => {
                    const b = row.querySelector('[data-switch]');
                    const rb = b.getBoundingClientRect();
                    return { key: row.dataset.switchRow, title: row.querySelector('.owner-switch-title').textContent.trim(),
                             state: row.querySelector('.owner-switch-state').textContent.replace(/\s+/g, ' ').trim(),
                             text: b.textContent.trim(), name: b.getAttribute('aria-label'), disabled: b.disabled,
                             inside: rb.left >= box.left - 1 && rb.right <= box.right + 1 && rb.width >= 40 && rb.height >= 24,
                             code: row.querySelector('.owner-switch-tech code').textContent };
                }),
                pageHScroll: doc.scrollWidth > doc.clientWidth
            };
        });
        assert.equal(r.tables, 0, 'المفاتيح ما زالت جدولًا');
        assert.equal(r.pageHScroll, false, 'تمرير أفقي للصفحة');
        assert.deepEqual(r.rows.map(x => x.key), REGISTERED_SWITCHES);
        for (const x of r.rows) {
            assert.ok(x.inside, `زر ${x.key} خارج اللوحة`);
            assert.equal(x.title, SWITCH_REGISTRY[x.key].label);
            assert.equal(x.code, x.key, 'المفتاح التقني في التفاصيل');
            assert.equal(x.disabled, true, 'زر مفعّل قبل التحقق');
            const on = x.key === 'company_permissions_enabled';
            assert.equal(x.text, on ? 'إيقاف' : 'تفعيل');
            assert.equal(x.name, `${on ? 'إيقاف' : 'تفعيل'} «${SWITCH_REGISTRY[x.key].label}»`);
            assert.match(x.state, on ? /مفعّل/ : /مطفأ/, 'الحالة نصًّا لا لونًا وحده');
        }
        // قبل التحقق: سبب التعطيل مكتوب بجانب الزر
        assert.equal(await page.locator('[data-switch-row="company_suspension_enforced"] .owner-switch-hint').isVisible(), true);
        // تنبيه المفتاح الحساس والمتطلبات بحالتها
        const t = await page.textContent('[data-switch-row="customer_transfers_enabled"]');
        assert.match(t, /يتطلب «عزل بيانات الشركات» — مطفأ/);
        assert.match(t, /يتطلب «صلاحيات الشركات» — مفعّل/);
        assert.match(await page.textContent('[data-switch-row="data_access_grants_enabled"] .owner-switch-warning'), /لا يفحص العزل/);
        assert.deepEqual(errors, []);
        await context.close();
    });
}

test('لوحة المفاتيح: Enter على زر مفتاح عادي يطلب تأكيدًا، والرفض لا يرسل، والقبول يرسل ويعيد التركيز', { skip: !chromiumPath }, async () => {
    const fx = fixtures({ fresh: true });
    fx.rpc.owner_feature_switches = allSwitches();
    let accept = false;
    const { page, context, dialogs } = await openOwner(browser, baseUrl, fx);
    page.removeAllListeners('dialog');
    page.on('dialog', d => { dialogs.push(d.message()); accept ? d.accept() : d.dismiss(); });
    const sel = '[data-switch="company_suspension_enforced"]';
    await page.waitForSelector(`${sel}:not([disabled])`);
    assert.equal(await page.locator('[data-switch-row="company_suspension_enforced"] .owner-switch-hint').isVisible(), false);
    // بلا سبب: لا تأكيد ولا نداء
    await page.focus(sel);
    await page.keyboard.press('Enter');
    assert.match(await page.textContent('#govStatus'), /10 أحرف/);
    assert.equal(dialogs.length, 0);
    await page.fill('#govReason', 'تفعيل الإيقاف بعد مراجعة الشركات');
    await page.focus(sel);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
    assert.equal(dialogs.length, 1);
    assert.match(dialogs[0], /تفعيل «تطبيق إيقاف الشركات» \(company_suspension_enforced\)/);
    assert.deepEqual(await calls(page, 'owner_set_feature_switch'), [], 'الرفض أرسل نداء');
    accept = true;
    await page.focus(sel);
    await page.keyboard.press(' ');
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'owner_set_feature_switch'));
    assert.deepEqual(await calls(page, 'owner_set_feature_switch'),
        [{ p_key: 'company_suspension_enforced', p_enabled: true, p_reason: 'تفعيل الإيقاف بعد مراجعة الشركات' }]);
    await page.waitForFunction(() => /وسُجّل/.test(document.getElementById('govStatus').textContent));
    assert.match(await page.textContent('#govStatus'), /تم تفعيل «تطبيق إيقاف الشركات» وسُجّل/);
    await page.waitForFunction(s => document.activeElement?.matches(s), sel);
    await context.close();
});

test('خطأ الخادم (رفض التحقق أو الإطفاء بعد النقل) يظهر في الحالة ولا يُعرض نجاحًا', { skip: !chromiumPath }, async () => {
    const fx = fixtures({ fresh: true });
    fx.rpc.owner_feature_switches = allSwitches(['company_isolation_enforced', 'company_permissions_enabled']);
    fx.rpcErrors = { owner_set_feature_switch: { code: '55000', message: 'لا يُطفأ company_isolation_enforced بعد نقل عملاء أو نسخ تذاكر' } };
    const { page, context, dialogs } = await openOwner(browser, baseUrl, fx);
    const sel = '[data-switch="company_isolation_enforced"]';
    await page.waitForSelector(`${sel}:not([disabled])`);
    assert.equal(await page.textContent(sel), 'إيقاف');
    await page.fill('#govReason', 'تجربة إطفاء العزل للمراجعة');
    await page.click(sel);
    await page.waitForFunction(() => document.getElementById('govStatus').dataset.tone === 'error');
    assert.match(await page.textContent('#govStatus'), /لا يُطفأ/);
    assert.ok(dialogs.some(m => /يرفض الخادم الإطفاء/.test(m)));
    await context.close();
});

test('بقية جداول الحوكمة: سبب طويل لا يدفع زرّي الموافقة والرفض خارج اللوحة (1351px)', { skip: !chromiumPath }, async () => {
    const fx = fixtures({ fresh: true });
    fx.rpc.owner_access_requests.requests[0].reason = `${LONG} ${LONG}`;
    const { page, context } = await openOwner(browser, baseUrl, fx);
    await page.setViewportSize({ width: 1351, height: 544 });
    await page.waitForSelector('#govAccess [data-access]');
    const out = await page.evaluate(() => {
        const box = document.querySelector('#govAccess').getBoundingClientRect();
        return [...document.querySelectorAll('#govAccess [data-access]')]
            .filter(b => { const r = b.getBoundingClientRect(); return r.left < box.left - 1 || r.right > box.right + 1; })
            .map(b => b.textContent.trim());
    });
    assert.deepEqual(out, [], 'أزرار خارج اللوحة');
    await context.close();
});
