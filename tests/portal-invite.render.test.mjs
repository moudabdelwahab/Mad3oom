/**
 * صفحة قبول دعوة الشركة من البريد (/portal/invite.html، 112) — النموذج الخالص، ثم الصفحة في Chromium
 * مقابل بديل Supabase. القرار في القاعدة (tests/sql/company-invitation-email.test.sql ④ وtests/http/
 * company-invite-http.test.mjs)؛ هنا: الرمز لا يبقى في العنوان، ولا يُفقد في رحلة الدخول، وكل حالة تُعرض صح.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import {
    tokenFromHash, storedToken, inviteState, loginUrl, PENDING_INVITE_KEY, PENDING_INVITE_TTL_MS
} from '../assets/js/portal/invite-model.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const TOKEN = 'cd'.repeat(32);
const INV = '33333333-3333-4333-8333-333333333333';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' };

test('النموذج: الرمز من الرابط والمخزَّن، ورابط الدخول، والحالات', () => {
    assert.equal(tokenFromHash(`#token=${TOKEN}`), TOKEN);
    for (const bad of ['', '#', '#token=abc', `#token=${TOKEN.toUpperCase()}`, `?token=${TOKEN}`]) assert.equal(tokenFromHash(bad), null, bad);
    const now = 1_000_000_000_000;
    assert.equal(storedToken(JSON.stringify({ token: TOKEN, at: now - 1000 }), now), TOKEN);
    assert.equal(storedToken(JSON.stringify({ token: TOKEN, at: now - PENDING_INVITE_TTL_MS - 1 }), now), null, 'قديم');
    assert.equal(storedToken(JSON.stringify({ token: TOKEN, at: now + 60000 }), now), null, 'من المستقبل');
    assert.equal(storedToken('not json', now), null);
    assert.equal(loginUrl(), '/login.html?redirect=%2Fportal%2Finvite.html');

    assert.deepEqual(inviteState({ token: null }), { kind: 'no-token', clearStored: true });
    assert.deepEqual(inviteState({ token: TOKEN, signedIn: false }), { kind: 'sign-in', clearStored: false });
    assert.equal(inviteState({ token: TOKEN, signedIn: true, claim: { error: { code: 'P0002' } } }).kind, 'not-found');
    assert.equal(inviteState({ token: TOKEN, signedIn: true, claim: { error: { code: 'P0002' } } }).clearStored, false, 'يبقى للدخول بالحساب الصحيح');
    assert.deepEqual(inviteState({ token: TOKEN, signedIn: true, claim: { error: { code: '42501' } } }), { kind: 'ineligible', clearStored: true });
    assert.equal(inviteState({ token: TOKEN, signedIn: true, claim: { error: { code: '0A000' } } }).kind, 'disabled');
    assert.equal(inviteState({ token: TOKEN, signedIn: true, claim: { error: { code: 'network' } } }).kind, 'error');
    const ready = inviteState({ token: TOKEN, signedIn: true, claim: { data: { invitation_id: INV, company_name: 'شركة أ', account_active: true } } });
    assert.deepEqual([ready.kind, ready.invitationId, ready.clearStored], ['ready', INV, true]);
    assert.equal(inviteState({ token: TOKEN, signedIn: true, claim: { data: { invitation_id: INV, account_active: false } } }).kind, 'inactive');
    assert.equal(inviteState({ token: TOKEN, signedIn: true, claim: { data: { already_member: true, company_name: 'أ' } } }).kind, 'already-member');
});

function startServer() {
    const server = http.createServer((req, res) => {
        let urlPath = decodeURIComponent(req.url.split('?')[0]);
        if (urlPath.endsWith('/')) urlPath += 'index.html';
        const filePath = path.join(ROOT, urlPath);
        if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) { res.writeHead(404); res.end(); return; }
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

const USER = { id: '44444444-4444-4444-8444-444444444444', email: 'late@example.test' };
async function openInvite(browser, baseUrl, fx, { hash = `#token=${TOKEN}`, stored = null } = {}) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.route('**/api-config.js', r => r.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(path.join(ROOT, 'tests/fixtures/supabase-double.js'), 'utf8') }));
    await page.route('**/auth-client.js', r => r.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(path.join(ROOT, 'tests/fixtures/auth-client-double.js'), 'utf8') }));
    await page.route('**/error-tracker.js', r => r.fulfill({ contentType: 'text/javascript', body: '' }));
    await page.route('https://fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
    await page.addInitScript(({ data, key, stored }) => {
        window.__FIXTURES__ = data;
        if (stored) localStorage.setItem(key, stored);
    }, { data: fx, key: PENDING_INVITE_KEY, stored });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${baseUrl}/portal/invite.html${hash}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('#inviteBody .state-block, #inviteBody .invite-card', { timeout: 10000 });
    return { page, context, errors };
}
const stored = (page) => page.evaluate(k => localStorage.getItem(k), PENDING_INVITE_KEY);

const chromiumPath = resolveChromium();
let browser, server, baseUrl;
test.before(async () => {
    if (!chromiumPath) return;
    server = await startServer();
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: chromiumPath });
});
test.after(async () => { await browser?.close(); server?.close(); });
const opts = { skip: !chromiumPath };

test('بلا جلسة: الرمز يُحفظ ويُمحى من العنوان، وزر الدخول يعود إلى الصفحة', opts, async () => {
    const { page, context, errors } = await openInvite(browser, baseUrl, { user: null, rpc: {} });
    assert.equal(new URL(page.url()).hash, '', 'الرمز بقي في شريط العنوان');
    assert.match(await stored(page), new RegExp(TOKEN));
    assert.match(await page.textContent('#inviteBody'), /ادخل بنفس البريد/);
    assert.equal(await page.getAttribute('#inviteBody [data-goto]', 'data-goto'), '/login.html?redirect=%2Fportal%2Finvite.html');
    const calls = await page.evaluate(() => window.__RPC_CALLS__ || []);
    assert.deepEqual(calls, [], 'نداء بلا جلسة');
    assert.equal(await page.getAttribute('meta[name="referrer"]', 'content'), 'no-referrer');
    assert.deepEqual(errors, []);
    await context.close();
});

test('بعد الدخول (الرمز المحفوظ): الربط ثم القبول، ويُمحى الرمز', opts, async () => {
    const fx = { user: USER, rpc: {
        company_invitation_claim: { invitation_id: INV, company_name: 'شركة <أ>', expires_at: '2026-10-28T00:00:00Z', account_active: true },
        company_invitation_respond: { accepted: true }
    } };
    const { page, context, errors } = await openInvite(browser, baseUrl, fx, { hash: '', stored: JSON.stringify({ token: TOKEN, at: Date.now() }) });
    assert.match(await page.textContent('#inviteBody .invite-card'), /دعوة من شركة <أ>/, 'اسم الشركة نصًّا لا HTML');
    assert.equal(await page.locator('#inviteBody .invite-card img, #inviteBody .invite-card b').count(), 0);
    assert.equal(await stored(page), null);
    await page.click('[data-accept="true"]');
    await page.waitForSelector('#inviteBody .state-block');
    assert.match(await page.textContent('#inviteBody'), /انضممت إلى شركة <أ>/);
    const args = await page.evaluate(() => window.__RPC_ARGS__);
    assert.deepEqual(args.find(([n]) => n === 'company_invitation_claim')[1], { p_token: TOKEN });
    assert.deepEqual(args.find(([n]) => n === 'company_invitation_respond')[1], { p_invitation: INV, p_accept: true });
    assert.deepEqual(errors, []);
    await context.close();
});

test('حساب غير البريد المدعو: «غير موجودة» بلا كاشف، والرمز يبقى للدخول بالحساب الصحيح', opts, async () => {
    const fx = { user: USER, rpc: {}, rpcErrors: { company_invitation_claim: { code: 'P0002', message: 'الدعوة غير موجودة أو انتهت' } } };
    const { page, context } = await openInvite(browser, baseUrl, fx);
    assert.match(await page.textContent('#inviteBody'), /غير موجودة أو انتهت/);
    assert.match(await stored(page), new RegExp(TOKEN));
    assert.equal(await page.locator('[data-action="switch"]').count(), 1);
    await context.close();
});

test('حساب بانتظار التفعيل: تُربط الدعوة ولا زر قبول', opts, async () => {
    const fx = { user: USER, rpc: { company_invitation_claim: { invitation_id: INV, company_name: 'شركة أ', account_active: false } } };
    const { page, context } = await openInvite(browser, baseUrl, fx);
    assert.match(await page.textContent('#inviteBody'), /بانتظار التفعيل/);
    assert.equal(await page.locator('[data-accept]').count(), 0);
    assert.equal(await stored(page), null);
    await context.close();
});

test('رابط بلا رمز: رسالة واضحة بلا نداء', opts, async () => {
    const { page, context } = await openInvite(browser, baseUrl, { user: USER, rpc: {} }, { hash: '' });
    assert.match(await page.textContent('#inviteBody'), /لا توجد دعوة/);
    assert.deepEqual(await page.evaluate(() => window.__RPC_CALLS__ || []), []);
    await context.close();
});
