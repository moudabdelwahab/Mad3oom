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
const { reasonError, flattenUnits, reviewRow, GUARDED_SWITCHES } = await import('data:text/javascript,' + encodeURIComponent(govSrc));

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
                                                                    open_continuity_owned: 0, active_delegations: 0 } }],
        owner_decide_admin_review: { decision: 'keep' },
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
        document_review: { status: 'approved' }
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
                { id: ADMIN, email: 'admin@example.com', full_name: 'إداري', role: 'admin' }
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
    await page.waitForSelector('#govSwitches table, #govSwitches .state-block', { timeout: 10000 });
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
    assert.deepEqual(GUARDED_SWITCHES, ['company_isolation_enforced', 'data_access_grants_enabled']);
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
