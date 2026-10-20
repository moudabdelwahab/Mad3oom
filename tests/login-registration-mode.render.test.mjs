/**
 * login.html في Chromium فعلي: النموذج الذي يراه الزائر يتبع وضع التسجيل في القاعدة،
 * وفشل التحقق لا يفتح التسجيل أبدًا (migrations/109 + assets/js/registration-mode.js).
 *
 * مكتبة Supabase من CDN تُستبدل ببديل يسجّل كل نداء، فيُثبت الاختبار أن لا
 * signUp ولا إدراج في waitlist_entries يحدث إلا بوضع مؤكد. لا اتصال خارجي.
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
    '.png': 'image/png', '.svg': 'image/svg+xml'
};

function startServer() {
    const server = http.createServer((req, res) => {
        const filePath = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
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
    } catch { /* no default download */ }
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

/**
 * بديل @supabase/supabase-js: كل نداء يُسجَّل في window.__CALLS__، ورد
 * get_public_registration_settings يأتي من window.__REG__ (يمكن تغييره أثناء الاختبار).
 */
const SUPABASE_DOUBLE = `
const log = (e) => { (window.__CALLS__ ||= []).push(e); };
const ok = (data) => Promise.resolve({ data, error: null });
class Q {
  constructor(t) { this.t = t; this.op = 'select'; log(['from', t]); }
  select() { return this; } eq() { return this; } maybeSingle() { return this._r(); } single() { return this._r(); }
  insert(p) { this.op = 'insert'; log(['insert', this.t, p]); return this; }
  upsert(p) { this.op = 'upsert'; log(['upsert', this.t]); return this; }
  update() { this.op = 'update'; return this; }
  _r() { return ok(null); }
  then(a, b) { return ok(null).then(a, b); }
}
export function createClient() {
  return {
    from: (t) => new Q(t),
    rpc: async (name, args) => {
      log(['rpc', name]);
      if (name === 'get_public_registration_settings') {
        const r = window.__REG__ || {};
        if (r.throws) throw new Error('network down');
        return { data: r.data ?? null, error: r.error ?? null };
      }
      if (name === 'is_reserved_username') return { data: false, error: null };
      return { data: [], error: null };
    },
    auth: {
      getSession: async () => ({ data: { session: null }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signUp: async (p) => { log(['signUp', p.email]); return { data: { user: null }, error: null }; },
      signInWithPassword: async () => ({ data: null, error: { message: 'Invalid login credentials' } }),
      signInWithOAuth: async () => { log(['oauth']); return { error: null }; },
      signOut: async () => ({ error: null })
    },
    functions: { invoke: async () => ({ data: null, error: null }) }
  };
}`;

const WAITLIST = { data: { mode: 'waitlist', waitlist_message: 'شكرًا لتسجيلك.\n\nموعد الإطلاق المتوقع: {{launch_date}}', expected_launch_date: 'يناير 2027' } };
const OPEN = { data: { mode: 'open', waitlist_message: null, expected_launch_date: null } };
const DENIED = { error: { code: '42501', message: 'permission denied for function has_elevated_authority' } };

let server, baseUrl, browser;

test.before(async () => {
    server = await startServer();
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    const executablePath = resolveChromium();
    browser = await chromium.launch(executablePath ? { executablePath } : {});
});
test.after(async () => { await browser?.close(); server?.close(); });

async function openRegister(reg) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route(u => u.href.includes('cdn.jsdelivr.net/npm/@supabase/supabase-js'),
        r => r.fulfill({ contentType: 'text/javascript', body: SUPABASE_DOUBLE }));
    await page.route(u => !u.href.startsWith(baseUrl) && !u.href.includes('cdn.jsdelivr.net/npm/@supabase'), r => r.abort());
    await page.addInitScript((r) => { window.__REG__ = r; window.__CALLS__ = []; }, reg);
    await page.goto(`${baseUrl}/login.html`);
    await page.waitForFunction(() => (window.__CALLS__ || []).some(c => c[1] === 'get_public_registration_settings'));
    await page.click('#go-register');
    await page.waitForSelector('#register-panel', { state: 'visible' });
    await page.waitForTimeout(450);
    return { page, context, errors };
}

const calls = (page) => page.evaluate(() => window.__CALLS__);
const ui = (page) => page.evaluate(() => {
    const vis = (id) => { const el = document.getElementById(id); return !!el && getComputedStyle(el).display !== 'none' && el.offsetParent !== null; };
    const btn = document.querySelector('#register-form .btn-primary');
    return {
        title: document.getElementById('register-title').textContent.trim(),
        submit: btn.textContent.trim(), submitDisabled: btn.disabled,
        formVisible: vis('register-form'), unavailableVisible: vis('register-unavailable-panel'),
        oauthVisible: vis('pi-register-btn')
    };
});

async function fillValidForm(page) {
    await page.fill('#reg-name', 'زائر تجريبي');
    await page.fill('#reg-username', 'demo_visitor1');
    await page.fill('#reg-phone', '+200000000000');
    await page.fill('#reg-email', 'visitor@example.com');
    await page.fill('#reg-password', 'Demo#2026x');
    await page.fill('#reg-confirm', 'Demo#2026x');
}

test('waitlist mode: visitor sees the waitlist form, submit inserts a waitlist entry and never signs up', async () => {
    const { page, context, errors } = await openRegister(WAITLIST);
    const s = await ui(page);
    assert.equal(s.title, 'الانضمام لقائمة الانتظار');
    assert.equal(s.submit, 'الانضمام لقائمة الانتظار');
    assert.equal(s.submitDisabled, false);
    assert.equal(s.formVisible, true);
    assert.equal(s.unavailableVisible, false);
    await fillValidForm(page);
    await page.click('#register-form .btn-primary');
    await page.waitForSelector('#register-success-panel', { state: 'visible' });
    const text = await page.textContent('#register-success-text');
    assert.match(text, /موعد الإطلاق المتوقع: يناير 2027/);
    const c = await calls(page);
    assert.ok(c.some(x => x[0] === 'insert' && x[1] === 'waitlist_entries'), 'waitlist insert');
    assert.ok(!c.some(x => x[0] === 'signUp'), 'no account created in waitlist mode');
    assert.ok(!c.some(x => x[0] === 'from' && x[1] === 'advanced_settings'), 'settings are read via the RPC, not the table');
    assert.deepEqual(errors, []);
    await context.close();
});

test('open mode: visitor sees normal signup, submit signs up and writes no waitlist entry', async () => {
    const { page, context, errors } = await openRegister(OPEN);
    const s = await ui(page);
    assert.equal(s.title, 'إنشاء حساب جديد');
    assert.equal(s.submit, 'إنشاء الحساب');
    assert.equal(s.submitDisabled, false);
    await fillValidForm(page);
    await page.click('#register-form .btn-primary');
    await page.waitForFunction(() => (window.__CALLS__ || []).some(c => c[0] === 'signUp'));
    const c = await calls(page);
    assert.ok(!c.some(x => x[0] === 'insert' && x[1] === 'waitlist_entries'));
    assert.deepEqual(errors, []);
    await context.close();
});

for (const [label, reg] of [
    ['permission denied (the production defect)', DENIED],
    ['network failure', { throws: true }],
    ['row missing (null)', { data: null }],
    ['invalid mode value', { data: { mode: null } }],
    ['unknown mode string', { data: { mode: 'closed' } }]
]) {
    test(`fails securely on ${label}: no signup form, no submission`, async () => {
        const { page, context, errors } = await openRegister(reg);
        const s = await ui(page);
        assert.equal(s.title, 'التسجيل غير متاح مؤقتًا');
        assert.equal(s.formVisible, false, 'form hidden');
        assert.equal(s.oauthVisible, false, 'register OAuth buttons hidden');
        assert.equal(s.unavailableVisible, true, 'retry panel shown');
        assert.equal(s.submitDisabled, true, 'submit disabled');
        // even a forced submit of a valid form (bypassing the hidden UI) must not reach the backend
        await page.evaluate(() => {
            const set = (id, v) => { document.getElementById(id).value = v; };
            set('reg-name', 'زائر تجريبي'); set('reg-username', 'demo_visitor1'); set('reg-phone', '+200000000000');
            set('reg-email', 'visitor@example.com'); set('reg-password', 'Demo#2026x'); set('reg-confirm', 'Demo#2026x');
            window.__CALLS__.length = 0;
            document.getElementById('register-form').requestSubmit();
        });
        await page.waitForTimeout(400);
        const c = await calls(page);
        assert.ok(!c.some(x => x[0] === 'signUp'), 'no signUp');
        assert.ok(!c.some(x => x[0] === 'insert'), 'no insert');
        assert.ok(!c.some(x => x[0] === 'rpc' && /get_email_by|is_reserved/.test(x[1])), 'submit made no lookups');
        assert.deepEqual(errors, []);
        await context.close();
    });
}

test('retry re-checks the setting and shows the verified mode', async () => {
    const { page, context, errors } = await openRegister(DENIED);
    assert.equal((await ui(page)).title, 'التسجيل غير متاح مؤقتًا');
    await page.evaluate((r) => { window.__REG__ = r; }, WAITLIST);
    await page.click('#register-retry-btn');
    await page.waitForFunction(() => document.getElementById('register-title').textContent.includes('قائمة الانتظار'));
    const s = await ui(page);
    assert.equal(s.formVisible, true);
    assert.equal(s.unavailableVisible, false);
    assert.equal(s.submitDisabled, false);
    assert.equal((await calls(page)).filter(x => x[1] === 'get_public_registration_settings').length, 2);
    assert.deepEqual(errors, []);
    await context.close();
});
