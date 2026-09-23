/**
 * «مركز سلطة المنصة» — تشغيل لوحة المالك الحقيقية في Chromium مقابل البديل
 * الاختباري لـ Supabase.
 *
 * ما يُقاس هنا الواجهة وحدها: أنها تعرض هوية المالك، وتربط كل عملية حرجة
 * بالتحقق بخطوتين، وتنادي نداء المالك الصحيح بالمعاملات الصحيحة. أما الرفض
 * الفعلي لغير المالك فمقيس في tests/sql/owner-authority.test.sql — الواجهة
 * لا تقرّر شيئًا.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = path.resolve(import.meta.dirname, '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };

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
const PADMIN = '22222222-2222-4222-8222-222222222222';
const ADMIN = '44444444-4444-4444-8444-444444444444';
const SUPPORT = '55555555-5555-4555-8555-555555555555';
const CUSTOMER = '66666666-6666-4666-8666-666666666666';

function fixtures({ security, isOwner = true } = {}) {
    return {
        user: { id: OWNER, email: 'owner@example.com' },
        authUser: { id: OWNER, email: 'owner@example.com', profile: { id: OWNER, full_name: 'مالك المنصة', role: 'platform_owner', ban_status: 'none' } },
        rpc: {
            owner_context_status: { is_platform_owner: isOwner, active_context: isOwner ? 'owner' : null, preview_mode: false, expires_at: '2099-01-01T00:00:00Z' },
            available_contexts: [{ key: 'owner' }],
            owner_security_status: security || { mfa_enrolled: false, step_up_fresh: false, step_up_expires_at: null, in_owner_context: true }
        },
        tables: {
            profiles: [
                { id: OWNER, email: 'owner@example.com', full_name: 'محمود', role: 'platform_owner', two_factor_enabled: true },
                { id: PADMIN, email: 'ops@example.com', full_name: 'مدير التشغيل', role: 'admin', two_factor_enabled: true },
                { id: ADMIN, email: 'admin@example.com', full_name: 'إداري', role: 'admin', two_factor_enabled: false },
                { id: SUPPORT, email: 'support@example.com', full_name: 'دعم', role: 'support', two_factor_enabled: false },
                { id: CUSTOMER, email: 'client@example.com', full_name: 'عميل', role: 'user' }
            ],
            platform_authority: [
                { user_id: OWNER, level: 'owner', granted_at: '2026-09-15T00:00:00Z' },
                { user_id: PADMIN, level: 'elevated_admin', granted_at: '2026-09-15T00:00:00Z' }
            ],
            platform_capability_grants: [{ user_id: ADMIN, capability: 'staff.support', granted_at: '2026-09-23T00:00:00Z' }],
            privileged_audit: [
                { at: '2026-09-23T10:00:00Z', actor_id: OWNER, actor_tier: 'owner', action: 'role.change', target_user_id: SUPPORT,
                  old_value: { role: 'user' }, new_value: { role: 'support' }, context: 'owner', step_up: true, source: 'session' },
                { at: '2026-09-23T09:00:00Z', actor_id: OWNER, actor_tier: 'owner', action: 'step_up.failed', target_user_id: OWNER,
                  old_value: null, new_value: { attempts: 1 }, context: 'owner', step_up: false, source: 'session' }
            ],
            owner_context_audit: [],
            companies: [{ id: 'c1' }],
            whatsapp_subscriptions: [],
            sie_settings: [{ key: 'engine_enabled', value: true, updated_at: '2026-09-23T00:00:00Z', updated_by: OWNER }],
            sie_admin_grants: [{ user_id: SUPPORT, granted_by: OWNER, granted_at: '2026-09-23T00:00:00Z', note: null }],
            sie_authority_audit: []
        }
    };
}

async function openOwner(browser, baseUrl, fx) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const dbl = fs.readFileSync(path.join(ROOT, 'tests/fixtures/supabase-double.js'), 'utf8');
    const auth = fs.readFileSync(path.join(ROOT, 'tests/fixtures/auth-client-double.js'), 'utf8');
    await page.route('**/api-config.js', r => r.fulfill({ contentType: 'text/javascript', body: dbl }));
    await page.route('**/auth-client.js', r => r.fulfill({ contentType: 'text/javascript', body: auth }));
    await page.route('**/error-tracker.js', r => r.fulfill({ contentType: 'text/javascript', body: '' }));
    await page.route('https://fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
    await page.addInitScript(d => { window.__FIXTURES__ = d; }, fx);
    page.on('dialog', d => d.accept());
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${baseUrl}/owner-dashboard.html#authority`, { waitUntil: 'networkidle' });
    return { page, context, errors };
}

const chromiumPath = resolveChromium();
let server, baseUrl, browser;

test.before(async () => {
    if (!chromiumPath) return;
    server = await startServer();
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: chromiumPath });
});
test.after(async () => { await browser?.close(); server?.close(); });

test('هوية المالك ظاهرة، وحماياته معروضة، بلا أخطاء', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openOwner(browser, baseUrl, fixtures());
    await page.waitForSelector('#ownerIdentity:not([hidden])');
    assert.match(await page.textContent('#ownerIdentity'), /مالك المنصة/);
    assert.match(await page.textContent('#ownerIdentity'), /Platform Owner/);
    assert.match(await page.textContent('.owner-protections'), /لا يحظر أحدٌ حسابك/);
    assert.deepEqual(errors, []);
    await context.close();
});

test('بلا 2FA: رابط التفعيل ظاهر وكل عملية حرجة معطّلة', { skip: !chromiumPath }, async () => {
    const { page, context } = await openOwner(browser, baseUrl, fixtures());
    await page.waitForSelector('#stepUpBox a[href="/admin-security-settings.html"]');
    await page.waitForSelector('#staffBody [data-act]');
    const states = await page.$$eval('[data-critical]', els => els.map(e => e.disabled));
    assert.ok(states.length >= 5, 'لم تُعرض أزرار العمليات الحرجة');
    assert.ok(states.every(Boolean), 'زر عملية حرجة مفعّل بلا تحقق بخطوتين');
    await context.close();
});

test('التحقق بخطوتين يفتح العمليات الحرجة، والرمز يذهب إلى owner_step_up', { skip: !chromiumPath }, async () => {
    const fx = fixtures({ security: { mfa_enrolled: true, step_up_fresh: false, step_up_expires_at: null, in_owner_context: true } });
    const { page, context } = await openOwner(browser, baseUrl, fx);
    await page.waitForSelector('#stepUpForm');

    await page.fill('#stepUpCode', '12345');
    await page.click('#stepUpForm button[type=submit]');
    assert.match(await page.textContent('#stepUpError'), /ستة أرقام/);

    // بعد التحقق تُرجع القاعدة نافذة سارية
    await page.evaluate(() => {
        window.__FIXTURES__.rpc.owner_step_up = { verified: true, expires_at: '2099-01-01T00:10:00Z' };
        window.__FIXTURES__.rpc.owner_security_status = {
            mfa_enrolled: true, step_up_fresh: true, step_up_expires_at: '2099-01-01T00:10:00Z', in_owner_context: true
        };
    });
    await page.fill('#stepUpCode', '654321');
    await page.click('#stepUpForm button[type=submit]');
    await page.waitForSelector('.owner-stepup-state--ok');

    const args = await page.evaluate(() => window.__RPC_ARGS__.filter(([n]) => n === 'owner_step_up'));
    assert.deepEqual(args.at(-1), ['owner_step_up', { p_code: '654321' }]);
    await page.waitForFunction(() => [...document.querySelectorAll('[data-critical]')].every(b => !b.disabled || b.id === 'sieGrantBtn'));
    await context.close();
});

test('الطبقات صحيحة، والمالك محمي بلا أزرار، والإجراءات تنادي نداء المالك', { skip: !chromiumPath }, async () => {
    const fx = fixtures({ security: { mfa_enrolled: true, step_up_fresh: true, step_up_expires_at: '2099-01-01T00:10:00Z', in_owner_context: true } });
    const { page, context } = await openOwner(browser, baseUrl, fx);
    await page.waitForSelector('#staffBody [data-act]');

    const rowOf = (name) => page.locator('#staffBody tr', { hasText: name });
    assert.match(await rowOf('محمود').textContent(), /مالك المنصة/);
    assert.match(await rowOf('محمود').textContent(), /محمي/);
    assert.equal(await rowOf('محمود').locator('[data-act]').count(), 0, 'زر إجراء على صف المالك');
    assert.match(await rowOf('مدير التشغيل').textContent(), /مدير منصة/);
    assert.match(await rowOf('إداري').first().textContent(), /إدارة فريق الدعم/);

    await rowOf('إداري').first().locator('[data-act="elevate"]').click();
    await page.waitForFunction(() => (window.__RPC_ARGS__ || []).some(([n]) => n === 'owner_set_platform_admin'));
    const call = await page.evaluate(() => window.__RPC_ARGS__.find(([n]) => n === 'owner_set_platform_admin'));
    assert.deepEqual(call[1], { p_user_id: ADMIN, p_enabled: true, p_note: null });
    await context.close();
});

test('سجل الامتيازات بتسميات مفهومة وعلامة التحقق', { skip: !chromiumPath }, async () => {
    const { page, context } = await openOwner(browser, baseUrl, fixtures());
    await page.waitForSelector('#privAuditBody tr');
    const text = await page.textContent('#privAuditBody');
    assert.match(text, /تغيير رتبة/);
    assert.match(text, /محاولة تحقق فاشلة/);
    assert.match(text, /2FA/);
    await context.close();
});

test('غير المالك يرى البوابة لا المركز', { skip: !chromiumPath }, async () => {
    const { page, context } = await openOwner(browser, baseUrl, fixtures({ isOwner: false }));
    await page.waitForSelector('#ownerGate:not([hidden])');
    assert.equal(await page.isHidden('#ownerContent'), true);
    await context.close();
});

