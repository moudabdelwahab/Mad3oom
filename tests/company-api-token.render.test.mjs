/**
 * اختبارات نافذة إنشاء مفتاح API في متصفح فعلي.
 *
 * ما تحرسه هذه الاختبارات:
 *   • الزر يفتح نافذة داخل اللوحة، ولا ينقل لأي صفحة أخرى (ولا لمركز الدعم).
 *   • الحمولة المرسلة للدالة المنشورة مطابقة لعقدها، وبلا أي معرّف هوية.
 *   • السرّ يُعرض مرة واحدة، ولا يمكن إغلاق النافذة بالخطأ بعد ظهوره.
 *   • بلا استحقاق api_tokens لا يظهر زر الإنشاء أصلًا، ولا يحدث أي نداء.
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

/** الرد الحقيقي للدالة لنوع api_key_secret، بنفس أسماء الحقول. */
const KEY_SECRET_RESPONSE = {
    token: {
        id: 'new-token-1', name: 'تكامل المبيعات', description: null,
        api_key: 'mad3oom_pk_0123456789abcdef0123456789abcdef',
        is_active: true, created_at: '2026-09-09T12:00:00Z',
        scopes: ['tickets:read'], expires_at: '2026-12-08T12:00:00Z',
        credential_type: 'api_key_secret'
    },
    secret: 'mad3oom_sk_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn'
};

function companyPayload({ entitlements } = {}) {
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
        entitlements: entitlements || [
            { feature_key: 'api_tokens', name_ar: 'مفاتيح API', description: '', limits: {}, granted_by: ['bundle'] }
        ],
        access: { active_plans: ['bundle'], has_active_subscription: true }
    };
}

function fixtures(overrides = {}) {
    return {
        user: { id: USER_ID, email: 'owner@company.test' },
        authUser: {
            id: USER_ID, email: 'owner@company.test',
            profile: { id: USER_ID, full_name: 'مالك الشركة', role: 'super_user' }
        },
        rpc: {
            get_my_company_dashboard: companyPayload(overrides.payload || {}),
            current_company_id: COMPANY_ID,
            company_members: { company_id: COMPANY_ID, is_owner: true, can_manage: true, members: [] },
            company_has_feature: overrides.hasFeature !== undefined ? overrides.hasFeature : true,
            ...(overrides.rpc || {})
        },
        functions: overrides.functions || { 'create-api-token': { data: KEY_SECRET_RESPONSE } },
        tables: {
            profiles: [{ id: USER_ID, email: 'owner@company.test', full_name: 'مالك الشركة', role: 'super_user', super_user_id: null }],
            api_tokens: overrides.tokens || [],
            api_token_usage_logs: [],
            notifications: [], services: [], whatsapp_subscriptions: [], subscription_plans: [],
            tickets: [], ticket_replies: [], activity_log: [],
            ...(overrides.tables || {})
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

/** الرقاقة تُنقَر من تسميتها: زر الاختيار مخفي بصريًا كما يراه المستخدم. */
async function checkChip(page, value) {
    await page.locator(`#apiTokenExpiryPresets label:has(input[value="${value}"])`).click();
    await page.waitForFunction(
        v => document.querySelector('#apiTokenExpiryPresets input:checked')?.value === v, value);
}

/** الانتظار على إغلاق النافذة: بلا .active هي display:none فلا تكون "مرئية". */
async function waitClosed(page, id) {
    await page.waitForFunction(
        modalId => !document.getElementById(modalId)?.classList.contains('active'), id);
}

async function openApiSection(page) {
    await page.locator('.sidebar-item[data-tab="api"]').click();
    await page.waitForSelector('#apiTabContent.active', { timeout: 10000 });
    await page.waitForSelector('#companyKeysList .state-block, #companyKeysList .company-sub', { timeout: 10000 });
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
if (!chromiumPath) console.error('SKIP: لا يوجد متصفح Chromium؛ اختبارات نافذة مفاتيح API لم تُنفَّذ');

test.before(async () => {
    if (!chromiumPath) return;
    server = await startServer();
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: chromiumPath });
});
test.after(async () => { await browser?.close(); server?.close(); });

/* ── الزر يفتح نافذة، لا يحوّل لمركز الدعم ──────────────────────────────── */

test('زر إنشاء المفتاح يفتح نافذة داخل اللوحة ولا يغادرها', { skip: !chromiumPath }, async () => {
    const { page, context, visited, errors } = await openPage(browser, baseUrl, fixtures());
    await openApiSection(page);

    await page.locator('#companyCreateKey').click();
    await page.waitForSelector('#createApiTokenModal.active', { timeout: 5000 });

    assert.equal(await page.locator('#createApiTokenForm').isHidden(), false);
    // القسم لم يتبدّل: الزر السابق كان بيوديك لمركز الدعم
    assert.equal(await page.locator('#apiTabContent').getAttribute('class'), 'tab-content active');
    assert.deepEqual(departures(visited), [], 'غادرت اللوحة');
    assert.equal(errors.length, 0, errors.join(' | '));
    await context.close();
});

test('النافذة تُرسم من الكتالوج: مجموعات صلاحيات وأنواع اعتماد ومُدد', { skip: !chromiumPath }, async () => {
    const { page, context } = await openPage(browser, baseUrl, fixtures());
    await openApiSection(page);
    await page.locator('#companyCreateKey').click();
    await page.waitForSelector('#createApiTokenModal.active');

    assert.ok(await page.locator('#apiTokenScopes .scope-group').count() >= 5);
    assert.equal(await page.locator('#apiTokenCredentialTypes input[name="credentialType"]').count(), 3);
    assert.ok(await page.locator('#apiTokenExpiryPresets input[name="expiryPreset"]').count() >= 5);

    // أقلّ امتياز: لا صلاحية مشغّل منصة معروضة إطلاقًا
    for (const scope of ['admin:full', 'settings:manage', 'oauth:manage']) {
        assert.equal(await page.locator(`#apiTokenScopes input[value="${scope}"]`).count(), 0, scope);
    }
    await context.close();
});

test('الافتراضيات محدَّدة مسبقًا: مدّة محدودة لا «بلا انتهاء»', { skip: !chromiumPath }, async () => {
    const { page, context } = await openPage(browser, baseUrl, fixtures());
    await openApiSection(page);
    await page.locator('#companyCreateKey').click();
    await page.waitForSelector('#createApiTokenModal.active');

    assert.equal(await page.locator('#apiTokenExpiryPresets input:checked').inputValue(), '90');
    assert.equal(await page.locator('#apiTokenCredentialTypes input:checked').inputValue(), 'api_key_secret');
    assert.equal(await page.locator('#apiTokenScopes input:checked').count(), 5);
    await context.close();
});

/* ── التحقّق قبل أي نداء ────────────────────────────────────────────────── */

test('الإرسال بلا اسم يُوقَف في النافذة ولا يصل للخادم', { skip: !chromiumPath }, async () => {
    const { page, context } = await openPage(browser, baseUrl, fixtures());
    await openApiSection(page);
    await page.locator('#companyCreateKey').click();
    await page.waitForSelector('#createApiTokenModal.active');

    await page.locator('#submitApiTokenBtn').click();
    await page.waitForSelector('[data-token-error-for="name"]:not([hidden])');

    const invocations = await page.evaluate(() => window.__INVOCATIONS__ || []);
    assert.equal(invocations.filter(i => i.name === 'create-api-token').length, 0, 'نُودي الخادم رغم بطلان النموذج');
    await context.close();
});

test('إلغاء كل الصلاحيات يمنع إنشاء مفتاح ميت', { skip: !chromiumPath }, async () => {
    const { page, context } = await openPage(browser, baseUrl, fixtures());
    await openApiSection(page);
    await page.locator('#companyCreateKey').click();
    await page.waitForSelector('#createApiTokenModal.active');

    await page.locator('#fTokenName').fill('مفتاح بلا صلاحيات');
    await page.evaluate(() => {
        document.querySelectorAll('#apiTokenScopes input:checked').forEach(i => { i.checked = false; });
    });
    await page.locator('#submitApiTokenBtn').click();
    await page.waitForSelector('[data-token-error-for="scopes"]:not([hidden])');

    const invocations = await page.evaluate(() => window.__INVOCATIONS__ || []);
    assert.equal(invocations.filter(i => i.name === 'create-api-token').length, 0);
    await context.close();
});

/* ── الحمولة المرسلة ────────────────────────────────────────────────────── */

test('الحمولة مطابقة لعقد الدالة: صلاحيات مختارة وتاريخ انتهاء صريح', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openPage(browser, baseUrl, fixtures());
    await openApiSection(page);
    await page.locator('#companyCreateKey').click();
    await page.waitForSelector('#createApiTokenModal.active');

    await page.locator('#fTokenName').fill('تكامل المبيعات');
    await page.locator('#fTokenDescription').fill('ربط نظام المبيعات');
    await page.locator('#apiTokenCredentialTypes input[value="bearer"]').check();
    await page.evaluate(() => {
        document.querySelectorAll('#apiTokenScopes input:checked').forEach(i => { i.checked = false; });
    });
    await page.locator('#apiTokenScopes input[value="tickets:read"]').check();
    await page.locator('#apiTokenScopes input[value="whatsapp:send"]').check();
    await checkChip(page, '30');

    await page.locator('#submitApiTokenBtn').click();
    await page.waitForSelector('#createApiTokenResult:not([hidden])', { timeout: 10000 });

    const call = await page.evaluate(() =>
        (window.__INVOCATIONS__ || []).find(i => i.name === 'create-api-token'));
    assert.ok(call, 'لم يُنادَ create-api-token');
    assert.equal(call.body.name, 'تكامل المبيعات');
    assert.equal(call.body.description, 'ربط نظام المبيعات');
    assert.equal(call.body.credential_type, 'bearer');
    assert.deepEqual(call.body.scopes.sort(), ['tickets:read', 'whatsapp:send']);
    assert.ok(call.body.expires_at, 'لم يُرسَل تاريخ انتهاء');
    assert.ok(new Date(call.body.expires_at).getTime() > Date.now());

    // الهوية من الجلسة وحدها — أي معرّف في الحمولة ثغرة انتحال
    assert.ok(!('user_id' in call.body), 'أُرسل user_id في الحمولة');
    assert.equal(errors.length, 0, errors.join(' | '));
    await context.close();
});

test('«بلا انتهاء» تُرسل expires_at = null صراحةً', { skip: !chromiumPath }, async () => {
    const { page, context } = await openPage(browser, baseUrl, fixtures());
    await openApiSection(page);
    await page.locator('#companyCreateKey').click();
    await page.waitForSelector('#createApiTokenModal.active');

    await page.locator('#fTokenName').fill('مفتاح دائم');
    await checkChip(page, 'never');
    await page.locator('#submitApiTokenBtn').click();
    await page.waitForSelector('#createApiTokenResult:not([hidden])', { timeout: 10000 });

    const call = await page.evaluate(() =>
        (window.__INVOCATIONS__ || []).find(i => i.name === 'create-api-token'));
    assert.equal(call.body.expires_at, null);
    await context.close();
});

test('تاريخ مخصَّص: الحقل يظهر عند اختياره ويُرسَل كما اختير', { skip: !chromiumPath }, async () => {
    const { page, context } = await openPage(browser, baseUrl, fixtures());
    await openApiSection(page);
    await page.locator('#companyCreateKey').click();
    await page.waitForSelector('#createApiTokenModal.active');

    assert.equal(await page.locator('#apiTokenCustomExpiryField').isHidden(), true);
    await checkChip(page, 'custom');
    assert.equal(await page.locator('#apiTokenCustomExpiryField').isHidden(), false);

    const target = new Date(Date.now() + 45 * 86400000).toISOString().slice(0, 10);
    await page.locator('#fTokenName').fill('مفتاح مؤقّت');
    await page.locator('#fTokenExpiry').fill(target);
    await page.locator('#submitApiTokenBtn').click();
    await page.waitForSelector('#createApiTokenResult:not([hidden])', { timeout: 10000 });

    const call = await page.evaluate(() =>
        (window.__INVOCATIONS__ || []).find(i => i.name === 'create-api-token'));
    assert.equal(new Date(call.body.expires_at).toISOString().slice(0, 10) >= target, true);
    await context.close();
});

/* ── لحظة عرض السرّ ─────────────────────────────────────────────────────── */

test('السرّ يظهر مرة واحدة مع تحذير صريح، ولا تُغلق النافذة بالخطأ', { skip: !chromiumPath }, async () => {
    const { page, context } = await openPage(browser, baseUrl, fixtures());
    await openApiSection(page);
    await page.locator('#companyCreateKey').click();
    await page.waitForSelector('#createApiTokenModal.active');

    await page.locator('#fTokenName').fill('تكامل المبيعات');
    await page.locator('#submitApiTokenBtn').click();
    await page.waitForSelector('#createApiTokenResult:not([hidden])', { timeout: 10000 });

    const shown = await page.locator('#createApiTokenSecrets').textContent();
    const values = await page.locator('#createApiTokenSecrets .secret-input').evaluateAll(
        els => els.map(e => e.value));
    assert.ok(values.includes(KEY_SECRET_RESPONSE.secret), 'السرّ لم يُعرض في لحظته الوحيدة');
    assert.ok(values.includes(KEY_SECRET_RESPONSE.token.api_key));
    assert.ok(values.some(v => v === `Bearer ${KEY_SECRET_RESPONSE.token.api_key}.${KEY_SECRET_RESPONSE.secret}`),
        'الرأس الجاهز غير معروض');
    assert.match(await page.locator('#createApiTokenResult .company-notice').textContent(), /مرة تانية/);
    assert.ok(!shown.includes('secret_hash'));

    // Escape والنقر على الخلفية لا يُغلقان بعد ظهور السرّ
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#createApiTokenModal.active').count(), 1, 'أُغلقت بـEscape رغم عرض السرّ');
    await page.mouse.click(8, 8);
    assert.equal(await page.locator('#createApiTokenModal.active').count(), 1, 'أُغلقت بالنقر على الخلفية');

    // الزر الصريح وحده يُغلق، والسرّ يُمسح من الصفحة بعده
    await page.locator('#doneApiTokenBtn').click();
    await waitClosed(page, 'createApiTokenModal');
    assert.equal((await page.locator('#createApiTokenSecrets').textContent()).trim(), '');
    await context.close();
});

test('نموذج الإنشاء يظهر فارغًا عند إعادة الفتح — لا بقايا سرّ سابق', { skip: !chromiumPath }, async () => {
    const { page, context } = await openPage(browser, baseUrl, fixtures());
    await openApiSection(page);
    await page.locator('#companyCreateKey').click();
    await page.waitForSelector('#createApiTokenModal.active');
    await page.locator('#fTokenName').fill('الأول');
    await page.locator('#submitApiTokenBtn').click();
    await page.waitForSelector('#createApiTokenResult:not([hidden])', { timeout: 10000 });
    await page.locator('#doneApiTokenBtn').click();
    await waitClosed(page, 'createApiTokenModal');

    await page.locator('#companyCreateKey').click();
    await page.waitForSelector('#createApiTokenModal.active');
    assert.equal(await page.locator('#createApiTokenResult').isHidden(), true);
    assert.equal(await page.locator('#createApiTokenForm').isHidden(), false);
    assert.equal(await page.locator('#fTokenName').inputValue(), '');
    await context.close();
});

test('رد both يعرض اعتمادين مرتبطين لا واحدًا', { skip: !chromiumPath }, async () => {
    const fx = fixtures({
        functions: {
            'create-api-token': {
                data: {
                    credential_group_id: 'grp-1',
                    api_key_secret: { token: { id: 'a', api_key: 'mad3oom_pk_aaa' }, secret: 'mad3oom_sk_bbb' },
                    bearer: { token: { id: 'b' }, bearer_token: 'mad3oom_bt_ccc' }
                }
            }
        }
    });
    const { page, context } = await openPage(browser, baseUrl, fx);
    await openApiSection(page);
    await page.locator('#companyCreateKey').click();
    await page.waitForSelector('#createApiTokenModal.active');
    await page.locator('#fTokenName').fill('اعتماد مزدوج');
    await page.locator('#apiTokenCredentialTypes input[value="both"]').check();
    await page.locator('#submitApiTokenBtn').click();
    await page.waitForSelector('#createApiTokenResult:not([hidden])', { timeout: 10000 });

    assert.equal(await page.locator('#createApiTokenSecrets .secret-card').count(), 2);
    await context.close();
});

/* ── الفشل ──────────────────────────────────────────────────────────────── */

test('رفض الخادم يظهر برسالته داخل النافذة بلا أي تحويل', { skip: !chromiumPath }, async () => {
    const fx = fixtures({
        functions: { 'create-api-token': { error: 'الاسم طويل جدًا (الحد الأقصى 80 حرفًا)', status: 400 } }
    });
    const { page, context, visited } = await openPage(browser, baseUrl, fx);
    await openApiSection(page);
    await page.locator('#companyCreateKey').click();
    await page.waitForSelector('#createApiTokenModal.active');
    await page.locator('#fTokenName').fill('اسم صالح هنا');
    await page.locator('#submitApiTokenBtn').click();
    await page.waitForSelector('#createApiTokenError:not([hidden])', { timeout: 10000 });

    assert.match(await page.locator('#createApiTokenError').textContent(), /الحد الأقصى 80/);
    assert.equal(await page.locator('#createApiTokenResult').isHidden(), true);
    assert.deepEqual(departures(visited), [], 'غادرت الصفحة عند الفشل');
    // الزر يعود قابلًا للضغط بدل ما يفضل معطّلًا
    assert.equal(await page.locator('#submitApiTokenBtn').isDisabled(), false);
    await context.close();
});

/* ── الاستحقاق ──────────────────────────────────────────────────────────── */

test('بلا استحقاق api_tokens: لا زر إنشاء، وتفسير بدل زر معطّل', { skip: !chromiumPath }, async () => {
    const fx = fixtures({
        payload: { entitlements: [] },
        hasFeature: false
    });
    const { page, context } = await openPage(browser, baseUrl, fx);
    await openApiSection(page);

    assert.equal(await page.locator('#companyCreateKey').count(), 0, 'ظهر زر الإنشاء بلا استحقاق');
    assert.match(await page.locator('#companyApi .company-notice').first().textContent(), /api_tokens/);
    await context.close();
});

test('الاستحقاق يُعاد سؤال القاعدة عنه عند الإرسال لا وقت الرسم', { skip: !chromiumPath }, async () => {
    // الحمولة تقول «مستحق» فيظهر الزر، لكن القاعدة ترفض لحظة الإرسال.
    // ده بالظبط ما يحدث لو انتهى الاشتراك والصفحة مفتوحة.
    const fx = fixtures({ hasFeature: false });
    const { page, context } = await openPage(browser, baseUrl, fx);
    await openApiSection(page);

    await page.locator('#companyCreateKey').click();
    await page.waitForSelector('#createApiTokenModal.active');
    await page.locator('#fTokenName').fill('مفتاح بعد انتهاء الاشتراك');
    await page.locator('#submitApiTokenBtn').click();
    await page.waitForSelector('#createApiTokenError:not([hidden])', { timeout: 10000 });

    assert.match(await page.locator('#createApiTokenError').textContent(), /api_tokens/);
    const invocations = await page.evaluate(() => window.__INVOCATIONS__ || []);
    assert.equal(invocations.filter(i => i.name === 'create-api-token').length, 0,
        'نُودي الخادم رغم رفض القاعدة');
    await context.close();
});

/* ── القائمة بعد الإنشاء ────────────────────────────────────────────────── */

test('القائمة تُعاد قراءتها بعد الإنشاء — لا سطر مُخترَع في الواجهة', { skip: !chromiumPath }, async () => {
    const { page, context } = await openPage(browser, baseUrl, fixtures());
    await openApiSection(page);
    await page.locator('#companyCreateKey').click();
    await page.waitForSelector('#createApiTokenModal.active');
    await page.locator('#fTokenName').fill('تكامل');
    await page.locator('#submitApiTokenBtn').click();
    await page.waitForSelector('#createApiTokenResult:not([hidden])', { timeout: 10000 });

    // البديل الاختباري لا يكتب في الجدول، فالقائمة تظل فارغة — والمهم أن
    // اللوحة أعادت القراءة من القاعدة بدل حقن صف من الرد.
    await page.waitForSelector('#companyKeysList .state-block', { timeout: 10000 });
    const list = await page.locator('#companyKeysList').textContent();
    assert.ok(!list.includes(KEY_SECRET_RESPONSE.secret), 'السرّ تسرّب إلى قائمة المفاتيح');
    await context.close();
});

test('مفتاح قارب على الانتهاء يُنبَّه عليه قبل أن يتوقف الإنتاج', { skip: !chromiumPath }, async () => {
    const soon = new Date(Date.now() + 5 * 86400000).toISOString();
    const fx = fixtures({
        tokens: [{
            id: 'key-soon', user_id: USER_ID, name: 'مفتاح قارب على الانتهاء',
            api_key: 'mad3oom_pk_soon', secret_last_four: '1234', bearer_last_four: null,
            is_active: true, created_at: '2026-08-01T00:00:00Z', last_used_at: null,
            revoked_at: null, usage_count: 3, expires_at: soon, scopes: ['tickets:read']
        }]
    });
    const { page, context } = await openPage(browser, baseUrl, fx);
    await openApiSection(page);

    const notice = await page.locator('#companyApi .company-notice--warning').textContent();
    assert.match(notice, /خلال 14 يومًا/);
    await context.close();
});
