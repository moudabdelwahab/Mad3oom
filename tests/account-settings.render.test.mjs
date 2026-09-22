/**
 * اختبارات عرض الوحدة الموحّدة «الملف الشخصي والأمان» (assets/js/account).
 *
 * تُركَّب الوحدة الحقيقية في متصفح Chromium فعلي فوق البديلين الاختباريين
 * نفسيهما المستخدمين في اختبارات لوحة العميل، وكل اختبار يثبّت واحدًا من
 * إصلاحات التدقيق بحيث يفشل هنا لو عاد السلوك القديم.
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
    '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8'
};

const SELF_ID = '11111111-1111-1111-1111-111111111111';
const TARGET_ID = '22222222-2222-2222-2222-222222222222';

function startServer() {
    const server = http.createServer((req, res) => {
        const urlPath = decodeURIComponent(req.url.split('?')[0]);
        if (urlPath === '/__account-test.html') {
            res.writeHead(200, { 'Content-Type': MIME['.html'] });
            res.end(`<!DOCTYPE html><html lang="ar" dir="rtl"><head>
                <link rel="stylesheet" href="/assets/css/account-settings.css"></head>
                <body><div id="mount"></div>
                <script type="module">
                    import { mountAccountSettings } from '/assets/js/account/account-settings.js';
                    await mountAccountSettings(document.getElementById('mount'), window.__MOUNT__);
                    window.__MOUNTED__ = true;
                </script></body></html>`);
            return;
        }
        const filePath = path.join(ROOT, urlPath);
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
 * البديل الاختباري لـ Supabase + ما تحتاجه هذه الوحدة ولا يوفّره: تسجيل
 * الدخول بكلمة مرور، وإنهاء الجلسات، وتسجيل وسائط RPC وupdateUser.
 */
const SUPABASE_DOUBLE = fs.readFileSync(path.join(ROOT, 'tests/fixtures/supabase-double.js'), 'utf8') + `
const __log = (entry) => { (window.__CALLS__ = window.__CALLS__ || []).push(entry); };
const __rpc = supabase.rpc;
supabase.rpc = async (name, args) => { __log(['rpc', name, args]); return __rpc(name, args); };
supabase.auth.signInWithPassword = async ({ email, password }) => {
    __log(['signInWithPassword', email]);
    return password === 'Current1pass' ? { data: {}, error: null } : { data: null, error: { message: 'Invalid login credentials' } };
};
supabase.auth.signOut = async (opts) => { __log(['signOut', opts?.scope]); return { error: null }; };
supabase.auth.updateUser = async (attrs) => { __log(['updateUser', attrs]); return { data: {}, error: null }; };
`;
const AUTH_DOUBLE = fs.readFileSync(path.join(ROOT, 'tests/fixtures/auth-client-double.js'), 'utf8');

function profile(over = {}) {
    return {
        id: SELF_ID, email: 'me@example.com', full_name: 'صاحب الحساب', phone: '+201000000001',
        whatsapp_phone: '+201000000001', bio: '', role: 'user', created_at: '2026-01-01T00:00:00Z',
        last_password_change: '2026-01-01T00:00:00Z', two_factor_enabled: false,
        telegram_otp_enabled: false, ...over
    };
}

async function mount(browser, baseUrl, { mountOpts, tables = {}, functions = {}, rpc = {} }) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const external = [];
    page.on('request', r => { if (!r.url().startsWith(baseUrl)) external.push(r.url()); });
    await page.route('**/api-config.js', r => r.fulfill({ contentType: 'text/javascript', body: SUPABASE_DOUBLE }));
    await page.route('**/auth-client.js', r => r.fulfill({ contentType: 'text/javascript', body: AUTH_DOUBLE }));
    await page.route(u => !u.href.startsWith(baseUrl), r => r.abort());
    await page.addInitScript(({ fx, opts }) => {
        window.__FIXTURES__ = fx;
        window.__MOUNT__ = opts;
        window.confirm = () => true;
    }, {
        fx: { user: { id: SELF_ID, email: 'me@example.com' }, tables: { profiles: [profile()], trusted_devices: [], ...tables }, functions, rpc },
        opts: mountOpts
    });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${baseUrl}/__account-test.html`);
    await page.waitForFunction(() => window.__MOUNTED__ === true, null, { timeout: 10000 });
    return { page, context, external, errors };
}

const calls = (page) => page.evaluate(() => window.__CALLS__ || []);
const writes = (page) => page.evaluate(() => window.__WRITES__ || []);

let server, baseUrl, browser;
const chromiumPath = resolveChromium();
if (!chromiumPath) console.error('SKIP: لا يوجد Chromium؛ اختبارات عرض وحدة الحساب لم تُنفَّذ');

test.before(async () => {
    if (!chromiumPath) return;
    server = await startServer();
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: chromiumPath });
});
test.after(async () => { await browser?.close(); server?.close(); });

test('PS-17: في التقمّص يُعرض الحساب المستهدف للقراءة فقط، بلا أي نموذج كتابة', { skip: !chromiumPath }, async () => {
    const tables = { profiles: [profile(), profile({ id: TARGET_ID, full_name: 'العميل المستهدف', email: 'target@example.com' })] };
    for (const section of ['profile', 'security']) {
        const { page, context, errors } = await mount(browser, baseUrl, {
            tables, mountOpts: { section, userId: TARGET_ID, readOnly: true, readOnlyReason: 'impersonation' }
        });
        const text = await page.textContent('#mount');
        assert.match(text, /للقراءة فقط/);
        if (section === 'profile') {
            assert.match(text, /العميل المستهدف/, 'must show the TARGET account, not the admin');
            assert.ok(!text.includes('صاحب الحساب'));
        }
        assert.equal(await page.locator('#mount form, #mount input, #mount button').count(), 0,
            `${section}: a writable control exists in impersonation`);
        assert.deepEqual(errors, []);
        await context.close();
    }
});

test('PS-03 / الصدق في العرض: تيليجرام غير متاح حتى لو كان مسجّلًا، و2FA «عند تسجيل الدخول»', { skip: !chromiumPath }, async () => {
    const { page, context } = await mount(browser, baseUrl, {
        tables: { profiles: [profile({ two_factor_enabled: true, telegram_otp_enabled: true })] },
        mountOpts: { section: 'security' }
    });
    const tg = await page.textContent('[data-fact="telegram_otp"]');
    assert.match(tg, /غير متاح حاليًا/);
    assert.ok(!/مفعّل/.test(tg), 'Telegram OTP shown as enabled');
    assert.match(await page.textContent('[data-fact="two_factor"]'), /مفعّل عند تسجيل الدخول/);
    assert.match(await page.textContent('[data-fact="password"]'), /غير مسجَّل/,
        'creation time must not be shown as a password change');
    assert.match(await page.textContent('[data-fact="phone"]'), /غير موثّق/);
    await context.close();
});

test('PS-14: الهاتف يُحفظ عبر submit_my_phone وحده، ولا يُمسح', { skip: !chromiumPath }, async () => {
    const { page, context } = await mount(browser, baseUrl, { mountOpts: { section: 'profile' } });

    await page.fill('#profilePhone', '');
    await page.click('#acctPhoneSaveBtn');
    await page.waitForSelector('#profilePhoneError:not(.u-hidden)');

    await page.fill('#profilePhone', '12');
    await page.click('#acctPhoneSaveBtn');
    assert.match(await page.textContent('#profilePhoneError'), /رقم هاتف صحيح/);
    assert.equal((await calls(page)).filter(c => c[0] === 'rpc').length, 0, 'invalid phone reached the server');

    await page.fill('#profilePhone', '01012345678');
    await page.click('#acctPhoneSaveBtn');
    await page.waitForFunction(() => (window.__CALLS__ || []).some(c => c[0] === 'rpc' && c[1] === 'submit_my_phone'));
    const rpcCall = (await calls(page)).find(c => c[1] === 'submit_my_phone');
    assert.deepEqual(rpcCall[2], { p_phone: '+201012345678', p_has_whatsapp: true, p_whatsapp_phone: null });
    assert.ok(!(await calls(page)).some(c => c[0] === 'updateProfile' && 'phone' in c[1]),
        'phone must not be PATCHed directly any more');
    await context.close();
});

test('PS-14: رقم واتساب مختلف عن الهاتف يبقى كما هو عند تغيير الهاتف', { skip: !chromiumPath }, async () => {
    const { page, context } = await mount(browser, baseUrl, {
        tables: { profiles: [profile({ whatsapp_phone: '+201099999999' })] },
        mountOpts: { section: 'profile' }
    });
    await page.fill('#profilePhone', '01012345678');
    await page.click('#acctPhoneSaveBtn');
    await page.waitForFunction(() => (window.__CALLS__ || []).some(c => c[1] === 'submit_my_phone'));
    const rpcCall = (await calls(page)).find(c => c[1] === 'submit_my_phone');
    assert.deepEqual(rpcCall[2], { p_phone: '+201012345678', p_has_whatsapp: false, p_whatsapp_phone: '+201099999999' });
    await context.close();
});

test('PS-06: تغيير كلمة المرور يتطلب الحالية، ثم يُنهي الجلسات الأخرى', { skip: !chromiumPath }, async () => {
    const { page, context } = await mount(browser, baseUrl, { mountOpts: { section: 'security', email: 'me@example.com' } });

    await page.fill('#newPassword', 'NewPass1word');
    await page.fill('#confirmPassword', 'NewPass1word');
    await page.click('#passwordSaveBtn');
    await page.waitForSelector('#acctCurrentPasswordError:not(.u-hidden)');
    assert.equal((await calls(page)).filter(c => c[0] === 'updatePassword').length, 0);

    await page.fill('#acctCurrentPassword', 'wrong');
    await page.click('#passwordSaveBtn');
    await page.waitForFunction(() => /غير صحيحة/.test(document.getElementById('acctCurrentPasswordError')?.textContent || ''));
    assert.equal((await calls(page)).filter(c => c[0] === 'updatePassword').length, 0, 'wrong current password still changed it');

    await page.fill('#newPassword', 'weakpass1');
    await page.fill('#confirmPassword', 'weakpass1');
    await page.fill('#acctCurrentPassword', 'Current1pass');
    await page.click('#passwordSaveBtn');
    assert.match(await page.textContent('#newPasswordError'), /حرف كبير/, 'one password rule across panels');

    await page.fill('#newPassword', 'NewPass1word');
    await page.fill('#confirmPassword', 'NewPass1word');
    await page.click('#passwordSaveBtn');
    await page.waitForFunction(() => (window.__CALLS__ || []).some(c => c[0] === 'signOut'));
    const log = await calls(page);
    assert.ok(log.some(c => c[0] === 'updatePassword'));
    assert.deepEqual(log.find(c => c[0] === 'signOut'), ['signOut', 'others']);
    await context.close();
});

test('PS-05: رمز QR يُرسم محليًا — سرّ 2FA لا يغادر المتصفح — والتفعيل يمرّ بالتحقق', { skip: !chromiumPath }, async () => {
    const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
    const { page, context, external } = await mount(browser, baseUrl, {
        mountOpts: { section: 'security' },
        functions: {
            'generate-2fa-secret': { data: { base32: secret, otpauth_url: `otpauth://totp/Mad3oom.online:2FA?secret=${secret}&issuer=Mad3oom.online` } },
            'verify-2fa': { data: { verified: true, enrollment: true } }
        }
    });
    await page.click('#acctTfaStartBtn');
    await page.waitForSelector('#acctTfaQr svg');
    assert.equal(await page.textContent('#acctTfaSecret'), secret);
    assert.deepEqual(external, [], `a request left the page: ${external.join(', ')}`);

    await page.fill('#acctTfaCode', '12345');
    await page.click('#acctTfaConfirmBtn');
    await page.waitForSelector('#acctTfaCodeError:not(.u-hidden)');

    await page.fill('#acctTfaCode', '123456');
    await page.click('#acctTfaConfirmBtn');
    await page.waitForSelector('#acctRecoveryCodes');
    assert.equal(await page.locator('#acctRecoveryCodes code').count(), 8);

    const invocations = await page.evaluate(() => window.__INVOCATIONS__);
    const verify = invocations.find(i => i.name === 'verify-2fa');
    assert.deepEqual(verify.body, { code: '123456', tempSecret: secret });
    const write = (await writes(page)).find(w => w.table === 'profiles');
    assert.equal(write.row.two_factor_enabled, true);
    assert.equal(write.row.recovery_codes.length, 8);
    assert.deepEqual(external, []);
    await context.close();
});

test('PS-16: إيقاف 2FA بحقل صريح (رمز أو رمز استعادة) عبر disable-2fa', { skip: !chromiumPath }, async () => {
    const { page, context } = await mount(browser, baseUrl, {
        tables: { profiles: [profile({ two_factor_enabled: true })] },
        mountOpts: { section: 'security' },
        functions: { 'disable-2fa': { data: { disabled: true } } }
    });
    await page.fill('#acctTfaProof', 'ABCD2345EF');
    await page.click('#acctTfaDisableBtn');
    await page.waitForSelector('#acctTfaStartBtn');
    const inv = (await page.evaluate(() => window.__INVOCATIONS__)).find(i => i.name === 'disable-2fa');
    assert.deepEqual(inv.body, { recoveryCode: 'ABCD2345EF' });
    assert.equal((await writes(page)).filter(w => w.table === 'profiles').length, 0,
        'disable must never write profiles from the browser');
    await context.close();
});

test('PS-18: الأجهزة الموثوقة ليست جلسات، والمنتهية تُعرض منتهية', { skip: !chromiumPath }, async () => {
    const future = new Date(Date.now() + 5 * 86400000).toISOString();
    const { page, context } = await mount(browser, baseUrl, {
        tables: {
            trusted_devices: [
                { id: 'd1', user_id: SELF_ID, device_name: 'Chrome على Windows', last_login: '2026-09-01T00:00:00Z', trusted_until: future },
                { id: 'd2', user_id: SELF_ID, device_name: '<img src=x onerror=alert(1)>', last_login: '2026-08-01T00:00:00Z', trusted_until: null }
            ]
        },
        mountOpts: { section: 'security' }
    });
    await page.waitForSelector('.acct-device');
    const list = await page.textContent('#acctDevicesBody');
    assert.match(list, /يتخطّى رمز 2FA حتى/);
    assert.match(list, /منتهي/);
    assert.equal(await page.locator('#acctDevicesBody img').count(), 0, 'device_name must be escaped');
    const section = await page.textContent('#mount');
    assert.match(section, /ليس جلسة دخول/);

    await page.click('#acctSignOutOthersBtn');
    await page.waitForFunction(() => (window.__CALLS__ || []).some(c => c[0] === 'signOut'));
    assert.deepEqual((await calls(page)).find(c => c[0] === 'signOut'), ['signOut', 'others']);
    await context.close();
});

test('PS-13: تغيير البريد عبر نظام الدخول، لا كتابة على profiles.email', { skip: !chromiumPath }, async () => {
    const { page, context } = await mount(browser, baseUrl, { mountOpts: { section: 'profile', email: 'me@example.com' } });
    await page.fill('#acctNewEmail', 'me@example.com');
    await page.click('#acctEmailSaveBtn');
    await page.waitForSelector('#acctNewEmailError:not(.u-hidden)');

    await page.fill('#acctNewEmail', 'New@Example.com');
    await page.click('#acctEmailSaveBtn');
    await page.waitForFunction(() => (window.__CALLS__ || []).some(c => c[0] === 'updateUser'));
    assert.deepEqual((await calls(page)).find(c => c[0] === 'updateUser')[1], { email: 'new@example.com' });
    assert.ok(!(await writes(page)).some(w => w.table === 'profiles' && 'email' in (w.row || {})));
    assert.match(await page.textContent('#acctEmailStatus'), /حتى تضغط الرابط/);
    await context.close();
});

test('الاسم والنبذة يُحفظان عبر updateProfile ولا يلمسان الهاتف', { skip: !chromiumPath }, async () => {
    const { page, context } = await mount(browser, baseUrl, { mountOpts: { section: 'profile' } });
    await page.fill('#profileFullName', 'اسم جديد');
    await page.fill('#profileBio', 'نبذة');
    await page.click('#profileSaveBtn');
    await page.waitForFunction(() => (window.__CALLS__ || []).some(c => c[0] === 'updateProfile'));
    assert.deepEqual((await calls(page)).find(c => c[0] === 'updateProfile')[1], { full_name: 'اسم جديد', bio: 'نبذة' });
    await context.close();
});
