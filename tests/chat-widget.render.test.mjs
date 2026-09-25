/**
 * chat-widget.render.test.mjs
 * ------------------------------------------------------------
 * الويدجت العائم الحقيقي (chat-widget.js + CSS) في Chromium فعلي، مقابل
 * بديل لـ Supabase ولعميل SIE. ميكروفون Chromium الوهمي يشغّل MediaRecorder
 * الحقيقي. كل اختبار يثبت ما **وصل للخادم** (الإدراجات، نداءات RPC،
 * الرفع)، لا ما ظهر فقط.
 *
 * الفرض الحقيقي على الخادم ومغطّى باختبارات SQL (0011 في مستودع SIE،
 * و054 هنا)؛ هنا نثبت أن الواجهة تستخدمه ولا تخترع قواعد بديلة.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = path.resolve(import.meta.dirname, '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

function startServer() {
    const server = http.createServer((req, res) => {
        const urlPath = decodeURIComponent(req.url.split('?')[0]);
        const filePath = path.join(ROOT, urlPath);
        if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
        fs.createReadStream(filePath).pipe(res);
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const HOST_HTML = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/chat-widget.css"></head>
<body style="margin:0;min-height:100vh;background:#eef2f7;font-family:system-ui"><main style="padding:24px">صفحة العميل</main>
<script type="module" src="/chat-widget.js"></script></body></html>`;

// بديل Supabase داخل الصفحة. الحالة كلها في window.__fake ليقرأها الاختبار.
const FAKE_API = `
const cfg = window.__FAKE_CONFIG || {};
const state = window.__fake = { inserts: [], rpc: [], removed: [], sessionUpdates: [], listeners: [], sieCalls: [], uploadsFallback: [] };
let seq = 0;
const now = () => new Date(Date.now() + (seq++)).toISOString();
function emit(table, row) { state.listeners.filter(l => l.table === table).forEach(l => setTimeout(() => l.cb({ new: row }), 0)); }
function query(table) {
  const q = { table, filters: [] };
  const result = () => {
    if (table === 'chat_sessions') return { data: { id: 's-1', user_id: 'u-1', status: 'active', bot_state: {}, is_manual_mode: false }, error: null };
    if (table === 'chat_messages') return { data: (cfg.messages || []).slice(), error: null };
    if (table === 'bot_settings') return { data: { welcome_message: 'أهلاً بيك' }, error: null };
    if (table === 'profiles') return { data: { full_name: 'عميل تجريبي', email: 'c@x.test' }, error: null };
    return { data: null, error: null };
  };
  const api = {
    select() { return api; }, eq() { return api; }, order() { return api; }, limit() { return api; },
    single: async () => result(), maybeSingle: async () => result(),
    then(res, rej) { return Promise.resolve(result()).then(res, rej); },
    insert(row) {
      const failAt = cfg.failInsertWhen && cfg.failInsertWhen(row);
      if (failAt) return Promise.resolve({ error: { message: 'insert failed' } });
      const stored = { id: 'm-' + (seq++), created_at: now(), ...row };
      state.inserts.push({ table, row });
      if (table === 'chat_messages') emit('chat_messages', stored);
      const p = Promise.resolve({ error: null });
      p.select = () => ({ single: async () => ({ data: { id: 's-1', status: 'active', bot_state: {} }, error: null }) });
      return p;
    },
    update(patch) { state.sessionUpdates.push({ table, patch }); const u = { eq: async () => ({ error: null }) }; return u; }
  };
  return api;
}
export const supabase = {
  auth: { getUser: async () => ({ data: { user: { id: 'u-1', email: 'c@x.test' } } }) },
  from: query,
  async rpc(fn, args) {
    state.rpc.push({ fn, args });
    if (fn === 'sie_my_entitlement') {
      if (cfg.entitlementError) return { data: null, error: { message: 'function sie_my_entitlement() does not exist' } };
      const e = typeof cfg.entitlement === 'function' ? cfg.entitlement(state) : cfg.entitlement;
      return { data: e ?? null, error: null };
    }
    if (fn === 'sie_customer_downgrade') {
      const r = cfg.downgrade ? cfg.downgrade(args, state) : { ok: true, edition: args.p_target };
      return { data: r, error: null };
    }
    return { data: null, error: null };
  },
  channel() { const ch = { on(ev, filter, cb) { state.listeners.push({ table: filter.table, cb }); return ch; }, subscribe() { return ch; } }; return ch; },
  removeChannel() {},
  storage: { from(bucket) { return {
    async createSignedUploadUrl(path) {
      if (cfg.signedUploadUnavailable) return { data: null, error: { message: 'not supported' } };
      return { data: { signedUrl: location.origin + '/__upload/' + path, path }, error: null };
    },
    async upload(path, file, opts) {
      state.uploadsFallback.push({ path, type: opts?.contentType, size: file.size });
      return cfg.fallbackUploadFails ? { error: { message: 'upload 500: storage down' } } : { data: { path }, error: null };
    },
    async createSignedUrls(paths) { return { data: paths.map(p => ({ path: p, signedUrl: location.origin + '/__file/' + p })), error: null }; },
    async createSignedUrl(p) { return { data: { signedUrl: location.origin + '/__file/' + p }, error: null }; },
    async remove(paths) { state.removed.push(...paths); return { data: paths, error: null }; }
  }; } }
};
`;

const FAKE_AUTH = `export async function requireAuth() { return { id: 'u-1', email: 'c@x.test', profile: { full_name: 'عميل تجريبي', role: 'user' } }; }`;
const FAKE_SIE = `
export async function getSieReply(args) {
  window.__fake.sieCalls.push({ text: args.text });
  const r = window.__FAKE_CONFIG?.sieReply;
  if (r === null) return null;
  return r || { reply: 'رد من SIE', options: [], botState: {}, alreadyPersisted: false };
}`;

const RESET = new Date(Date.now() + (2 * 60 + 17) * 60000 + 30000).toISOString();
const ent = (edition, extra = {}) => ({
    signed_in: true, has_access: true, reason: null, edition,
    downgrade_to: { max: ['pro', 'free'], pro: ['free'], free: [] }[edition],
    primary: { kind: 'monthly', used: 800, limit: 1000, remaining: 200, resets_at: RESET },
    ...extra
});

let server, browser, base;
test.before(async () => {
    server = await startServer();
    base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
});
test.after(async () => { await browser?.close(); server?.close(); });

async function openWidget(config = {}, { viewport = { width: 1366, height: 860 }, uploadStatus = 200, initScript = null } = {}) {
    const context = await browser.newContext({ viewport, locale: 'ar-EG', permissions: ['microphone'] });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const uploads = [];
    await page.addInitScript((c) => {
        // دوال الإعداد لا تمر عبر JSON: تُعاد بناؤها من نصها
        const cfg = { ...c };
        for (const k of ['entitlement', 'downgrade', 'failInsertWhen']) if (typeof c[k] === 'string' && c[k].startsWith('fn:')) cfg[k] = new Function('return ' + c[k].slice(3))();
        window.__FAKE_CONFIG = cfg;
    }, serialize(config));
    if (initScript) await page.addInitScript(initScript);
    await page.route('**/__host.html', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: HOST_HTML }));
    await page.route('**/api-config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: FAKE_API }));
    await page.route('**/auth-client.js', (r) => r.fulfill({ contentType: 'text/javascript', body: FAKE_AUTH }));
    await page.route('**/assets/js/sie-client.js', (r) => r.fulfill({ contentType: 'text/javascript', body: FAKE_SIE }));
    await page.route('**/__upload/**', async (r) => {
        const req = r.request();
        uploads.push({ path: decodeURIComponent(new URL(req.url()).pathname.replace('/__upload/', '')), type: req.headers()['content-type'], size: req.postDataBuffer()?.length || 0 });
        await r.fulfill({ status: uploadStatus, body: uploadStatus < 300 ? '{}' : '{"error":"boom"}' });
    });
    await page.route('**/__file/**', (r) => {
        const p = r.request().url();
        if (/\.(webm|ogg|m4a|mp4)$/.test(p)) return r.fulfill({ contentType: 'audio/webm', body: Buffer.alloc(0) });
        return r.fulfill({ contentType: /\.pdf$/.test(p) ? 'application/pdf' : 'image/png', body: PNG_1PX });
    });
    await page.goto(`${base}/__host.html`);
    await page.click('#chatBubbleBtn');
    await page.waitForSelector('#cwModeChip');
    await page.waitForFunction(() => window.__fake?.rpc.some((c) => c.fn === 'sie_my_entitlement'));
    return { page, context, errors, uploads };
}

function serialize(config) {
    const out = {};
    for (const [k, v] of Object.entries(config)) out[k] = typeof v === 'function' ? 'fn:' + v.toString() : v;
    return out;
}

const fake = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.__fake)));
const inserts = async (page, pred = () => true) => (await fake(page)).inserts.filter((i) => i.table === 'chat_messages').map((i) => i.row).filter(pred);

async function attach(page, files) {
    await page.setInputFiles('#cwFileInput', files);
}

// ════════════════════════════ composer + mode ════════════════════════════

test('composer: attach · input · mode · mic/send in one row; no mode panel above the messages; no Traditional anywhere', async () => {
    const { page, context, errors } = await openWidget({ entitlement: ent('pro') });
    const order = await page.$$eval('#chatWidgetFooter .chat-widget-input-row > :not([hidden])', (els) => els.map((e) => e.id || e.className));
    assert.deepEqual(order, ['cwAttachBtn', 'chatWidgetTextInput', 'cwModeChip', 'cwActionBtn']);
    assert.equal(await page.$('#chatModeItem'), null, 'the old header menu entry is gone');
    const bodyTop = await page.$eval('#chatWidgetBody', (b) => b.getBoundingClientRect().top);
    const chipTop = await page.$eval('#cwModeChip', (b) => b.getBoundingClientRect().top);
    assert.ok(chipTop > bodyTop + 200, 'the mode chip lives in the composer, below the conversation');
    const text = await page.$eval('#floatingChatWidget', (w) => w.innerText);
    assert.doesNotMatch(text, /تقليدي|Traditional/i);
    assert.match(await page.textContent('#cwModeChip'), /SIE\s*برو/);
    assert.equal(await page.$eval('#floatingChatWidget', (w) => getComputedStyle(w).direction), 'rtl');
    assert.deepEqual(errors, []);
    await context.close();
});

test('mode menu: SIE is the only (selected) mode; plan and real usage numbers come from the entitlement', async () => {
    const { page, context } = await openWidget({ entitlement: ent('pro') });
    await page.click('#cwModeChip');
    assert.equal(await page.getAttribute('#cwModeChip', 'aria-expanded'), 'true');
    assert.equal(await page.$$eval('#cwModeMenu .cw-mode-option', (o) => o.length), 1);
    assert.match(await page.textContent('#cwModeMenu .cw-mode-option'), /SIE/);
    assert.equal(await page.textContent('#cwModeMenu .cw-plan-badge'), 'SIE برو');
    const usage = await page.textContent('#cwModeMenu .cw-usage');
    assert.match(usage, /800 \/ 1,000/);
    assert.match(usage, /200 متبقي/);
    assert.match(usage, /80%/);
    assert.match(usage, /يتجدد بعد 2س 1[78]د/);
    assert.equal(await page.getAttribute('#cwModeMenu .cw-usage-bar', 'aria-valuenow'), '80');
    await context.close();
});

test('mode menu: keyboard — focus moves in, Tab stays inside, Escape closes and returns focus to the chip', async () => {
    const { page, context } = await openWidget({ entitlement: ent('max') });
    await page.focus('#cwModeChip');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#cwModeMenu');
    assert.ok(await page.evaluate(() => document.getElementById('cwModeMenu').contains(document.activeElement)));
    for (let i = 0; i < 6; i++) await page.keyboard.press('Tab');
    assert.ok(await page.evaluate(() => document.getElementById('cwModeMenu').contains(document.activeElement)), 'Tab is trapped in the menu');
    await page.keyboard.press('Escape');
    assert.equal(await page.$('#cwModeMenu'), null);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'cwModeChip');
    await context.close();
});

test('plan-aware: Max offers Pro and Free, Pro offers Free, Free offers nothing — exactly what the server sent', async () => {
    for (const [edition, expected] of [['max', ['النزول إلى برو', 'النزول إلى المجاني']], ['pro', ['النزول إلى المجاني']], ['free', []]]) {
        const { page, context } = await openWidget({ entitlement: ent(edition) });
        await page.click('#cwModeChip');
        await page.waitForSelector('#cwModeMenu .cw-plan-badge');
        const buttons = await page.$$eval('#cwModeMenu .cw-downgrade-btn', (b) => b.map((x) => x.textContent.trim()));
        assert.deepEqual(buttons, expected, edition);
        await context.close();
    }
});

test('downgrade: needs a confirming second press, calls the server RPC with the target, then shows the new plan', async () => {
    const { page, context } = await openWidget({
        entitlement: (s) => ({ signed_in: true, has_access: true, edition: s.rpc.some((c) => c.fn === 'sie_customer_downgrade') ? 'pro' : 'max',
            downgrade_to: s.rpc.some((c) => c.fn === 'sie_customer_downgrade') ? ['free'] : ['pro', 'free'],
            primary: { kind: 'monthly', used: 12, limit: 10, remaining: 0, resets_at: new Date(Date.now() + 86400000 * 5).toISOString() } })
    });
    await page.click('#cwModeChip');
    const btn = page.locator('#cwModeMenu .cw-downgrade-btn[data-plan="pro"]');
    await btn.click();
    assert.match(await btn.textContent(), /تأكيد النزول إلى برو/);
    assert.equal((await fake(page)).rpc.filter((c) => c.fn === 'sie_customer_downgrade').length, 0, 'one press does nothing on the server');
    await btn.click();
    await page.waitForFunction(() => document.querySelector('#cwModeMenu .cw-plan-badge')?.textContent === 'SIE برو');
    const calls = (await fake(page)).rpc.filter((c) => c.fn === 'sie_customer_downgrade');
    assert.deepEqual(calls, [{ fn: 'sie_customer_downgrade', args: { p_target: 'pro' } }]);
    // the SAME usage against the NEW, smaller limit — shown as the server reports it
    assert.match(await page.textContent('#cwModeMenu .cw-usage'), /12 \/ 10/);
    assert.match(await page.textContent('#chatWidgetBody'), /تم تغيير خطة SIE إلى برو/);
    await context.close();
});

test('downgrade: a server refusal is shown, the plan does not change in the UI', async () => {
    const { page, context } = await openWidget({ entitlement: ent('max'), downgrade: () => ({ ok: false, error: 'edition_unavailable' }) });
    await page.click('#cwModeChip');
    const btn = page.locator('#cwModeMenu .cw-downgrade-btn[data-plan="pro"]');
    await btn.click();
    await btn.click();
    await page.waitForSelector('#cwModeMenu .cw-mode-error:not([hidden])');
    assert.match(await page.textContent('#cwModeMenu .cw-mode-error'), /متوقفة/);
    assert.equal(await page.textContent('#cwModeMenu .cw-plan-badge'), 'SIE ماكس');
    await context.close();
});

test('entitlement unavailable (RPC not deployed / network): the chat still works and SIE is still asked', async () => {
    const { page, context, errors } = await openWidget({ entitlementError: true });
    await page.fill('#chatWidgetTextInput', 'الموقع مش بيفتح');
    await page.click('#cwActionBtn');
    await page.waitForFunction(() => window.__fake.sieCalls.length === 1);
    await page.click('#cwModeChip');
    assert.match(await page.textContent('#cwModeMenu'), /تعذّر تحميل بيانات الاستخدام/);
    assert.deepEqual(errors, []);
    await context.close();
});

// ════════════════════════════ SIE on every plan ════════════════════════════

test('SIE answers on Free, Pro and Max: the text goes to SIE and the reply is stored', async () => {
    for (const edition of ['free', 'pro', 'max']) {
        const { page, context } = await openWidget({ entitlement: ent(edition) });
        await page.fill('#chatWidgetTextInput', 'مش عارف ادخل على حسابي');
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => window.__fake.inserts.some((i) => i.row.is_bot_reply && i.row.message_text === 'رد من SIE'));
        const f = await fake(page);
        assert.deepEqual(f.sieCalls, [{ text: 'مش عارف ادخل على حسابي' }], edition);
        const own = f.inserts.filter((i) => i.row.sender_id === 'u-1');
        assert.equal(own.length, 1);
        await context.close();
    }
});

test('SIE unavailable (limit reached): no SIE call, a clear reason in the chat, the message stays for support', async () => {
    const { page, context } = await openWidget({ entitlement: ent('pro', { has_access: false, reason: 'edition_monthly_limit',
        primary: { kind: 'monthly', used: 12, limit: 10, remaining: 0, resets_at: RESET } }) });
    assert.equal(await page.getAttribute('#cwModeChip', 'data-tone'), 'full');
    await page.fill('#chatWidgetTextInput', 'عندي مشكلة');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__fake.inserts.some((i) => i.row.is_bot_reply && /حد رسائل الشهر/.test(i.row.message_text)));
    const f = await fake(page);
    assert.equal(f.sieCalls.length, 0);
    assert.ok(f.inserts.some((i) => i.row.sender_id === 'u-1' && i.row.message_text === 'عندي مشكلة'), 'the customer message is stored');
    assert.match(f.inserts.find((i) => i.row.is_bot_reply && /حد/.test(i.row.message_text)).row.message_text, /فريق الدعم/);
    await context.close();
});

test('SIE refused on the server (null reply): the widget asks the server why and explains it', async () => {
    let calls = 0;
    const { page, context } = await openWidget({ sieReply: null,
        entitlement: (s) => (s.rpc.filter((c) => c.fn === 'sie_my_entitlement').length > 1
            ? { signed_in: true, has_access: false, reason: 'quota_exceeded', edition: 'free', downgrade_to: [], primary: { kind: 'lifetime', used: 40, limit: 40, remaining: 0 } }
            : { signed_in: true, has_access: true, reason: null, edition: 'free', downgrade_to: [], primary: { kind: 'lifetime', used: 39, limit: 40, remaining: 1 } }) });
    calls++;
    await page.fill('#chatWidgetTextInput', 'سؤال');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__fake.inserts.some((i) => i.row.is_bot_reply && /استهلكت كل رسائل/.test(i.row.message_text)));
    assert.ok(calls);
    await context.close();
});

// ════════════════════════════ attachments ════════════════════════════

test('image: preview in the composer, removable before sending', async () => {
    const { page, context } = await openWidget({ entitlement: ent('free') });
    await attach(page, [{ name: 'shot.png', mimeType: 'image/png', buffer: PNG_1PX }, { name: 'second.png', mimeType: 'image/png', buffer: PNG_1PX }]);
    assert.equal(await page.$$eval('#cwAttachTray .cw-chip', (c) => c.length), 2);
    assert.ok(await page.$eval('#cwAttachTray .cw-chip-thumb', (i) => i.src.startsWith('blob:')), 'a local preview, nothing uploaded yet');
    assert.equal(await page.getAttribute('#cwActionBtn', 'data-action'), 'send', 'an attachment turns mic into send');
    await page.click('#cwAttachTray .cw-chip:nth-child(2) .cw-chip-remove');
    assert.equal(await page.$$eval('#cwAttachTray .cw-chip', (c) => c.length), 1);
    await context.close();
});

test('image: uploads to the sender\'s folder, sends image_url + attachment, renders signed and opens larger', async () => {
    const { page, context, uploads } = await openWidget({ entitlement: ent('free') });
    await attach(page, [{ name: 'shot.png', mimeType: 'image/png', buffer: PNG_1PX }]);
    await page.fill('#chatWidgetTextInput', 'دي الشاشة');
    await page.click('#cwActionBtn');
    await page.waitForFunction(() => window.__fake.inserts.some((i) => i.row.image_url));
    assert.equal(uploads.length, 1);
    assert.match(uploads[0].path, /^u-1\/s-1-\d+-[0-9a-z]{6}\.png$/);
    assert.equal(uploads[0].type, 'image/png');
    const [row] = await inserts(page, (r) => r.image_url);
    assert.equal(row.image_url, uploads[0].path);
    assert.deepEqual({ ...row.attachment, size: undefined }, { kind: 'image', path: uploads[0].path, name: 'shot.png', mime: 'image/png', size: undefined });
    assert.equal(row.message_text, 'دي الشاشة', 'the caption travels with the image');
    assert.equal((await fake(page)).sieCalls.length, 1, 'the caption is still answered by SIE');
    await page.waitForSelector('#chatWidgetBody .cw-att-image.is-ready img:not([hidden])');
    assert.ok((await page.getAttribute('#chatWidgetBody .cw-att-image img', 'src')).includes('/__file/'), 'shown through a signed URL');
    await page.click('#chatWidgetBody .cw-att-image');
    await page.waitForSelector('#cwImageViewer img');
    await page.keyboard.press('Escape');
    assert.equal(await page.$('#cwImageViewer'), null);
    assert.equal(await page.$('#cwAttachTray .cw-chip'), null, 'the tray is emptied after sending');
    await context.close();
});

test('file: a PDF is sent as an attachment (no image_url) and rendered as a download chip', async () => {
    const { page, context, uploads } = await openWidget({ entitlement: ent('free') });
    await attach(page, [{ name: 'report.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 test') }]);
    await page.click('#cwActionBtn');
    await page.waitForFunction(() => window.__fake.inserts.some((i) => i.row.attachment?.kind === 'file'));
    const [row] = await inserts(page, (r) => r.attachment);
    assert.equal(row.image_url, undefined);
    assert.equal(row.attachment.name, 'report.pdf');
    assert.equal(row.message_text, 'ملف مرفق: report.pdf', 'a readable label for lists and the admin inbox');
    assert.equal(uploads[0].type, 'application/pdf');
    assert.equal((await fake(page)).sieCalls.length, 0, 'an attachment alone does not spend SIE');
    await page.waitForSelector('#chatWidgetBody a.cw-att-file.is-ready');
    assert.match(await page.getAttribute('#chatWidgetBody a.cw-att-file', 'href'), /\/__file\//);
    assert.doesNotMatch(await page.textContent('#chatWidgetBody .chat-widget-message.user'), /ملف مرفق: report.pdf/, 'the label is not repeated under the chip');
    assert.match(await page.textContent('#chatWidgetBody'), /وصل المرفق/);
    await context.close();
});

test('file: an invalid type and an oversized image are refused before any upload', async () => {
    const { page, context, uploads } = await openWidget({ entitlement: ent('free') });
    await attach(page, [{ name: 'setup.exe', mimeType: 'application/x-msdownload', buffer: Buffer.from('MZ') }]);
    await page.waitForSelector('.chat-widget-inline-error');
    assert.match(await page.textContent('.chat-widget-inline-error'), /غير مدعوم/);
    await attach(page, [{ name: 'huge.png', mimeType: 'image/png', buffer: Buffer.alloc(5 * 1024 * 1024 + 10, 1) }]);
    assert.match(await page.textContent('.chat-widget-inline-error'), /أكبر من الحد/);
    assert.equal(await page.$('#cwAttachTray .cw-chip'), null);
    assert.equal(uploads.length, 0);
    await context.close();
});

test('file: an upload failure keeps text and attachment, sends nothing, and offers a retry', async () => {
    const { page, context } = await openWidget({ entitlement: ent('free'), fallbackUploadFails: true }, { uploadStatus: 500 });
    await attach(page, [{ name: 'report.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF') }]);
    await page.fill('#chatWidgetTextInput', 'مرفق التقرير');
    await page.click('#cwActionBtn');
    await page.waitForSelector('#cwAttachTray .cw-chip[data-state="error"]');
    assert.match(await page.textContent('.chat-widget-inline-error'), /تعذّر رفع «report.pdf»/);
    assert.ok(await page.$('.chat-widget-inline-error .chat-widget-link-btn'), 'retry offered');
    assert.equal(await page.inputValue('#chatWidgetTextInput'), 'مرفق التقرير');
    assert.equal((await inserts(page, (r) => r.sender_id === 'u-1')).length, 0);
    assert.equal((await fake(page)).sieCalls.length, 0);
    await context.close();
});

test('file: when the message insert fails after upload, the orphan upload is cleaned up', async () => {
    const { page, context, uploads } = await openWidget({ entitlement: ent('free'), failInsertWhen: (row) => !!row.attachment });
    await attach(page, [{ name: 'report.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF') }]);
    await page.click('#cwActionBtn');
    await page.waitForSelector('.chat-widget-inline-error');
    const f = await fake(page);
    assert.deepEqual(f.removed, [uploads[0].path]);
    assert.equal(await page.$$eval('#cwAttachTray .cw-chip', (c) => c.length), 1, 'the attachment is kept for a retry');
    await context.close();
});

// ════════════════════════════ voice ════════════════════════════

test('voice: mic → recording with a timer → stop → preview → send uploads audio and stores audio_url', async () => {
    const { page, context, uploads, errors } = await openWidget({ entitlement: ent('free') });
    assert.equal(await page.getAttribute('#cwActionBtn', 'data-action'), 'mic', 'empty composer shows the mic');
    await page.click('#cwActionBtn');
    await page.waitForSelector('#cwRecorder .cw-rec-status');
    await page.waitForFunction(() => document.getElementById('cwRecTime')?.textContent !== '0:00', null, { timeout: 5000 });
    await page.click('#cwRecStop');
    await page.waitForSelector('#cwRecorder audio');
    assert.ok(await page.$eval('#cwRecorder audio', (a) => a.src.startsWith('blob:')), 'a local preview before sending');
    await page.click('#cwRecSend');
    await page.waitForFunction(() => window.__fake.inserts.some((i) => i.row.audio_url));
    const [row] = await inserts(page, (r) => r.audio_url);
    assert.equal(row.attachment.kind, 'audio');
    assert.ok(row.attachment.duration_ms > 0);
    assert.equal(row.message_text, 'رسالة صوتية');
    assert.match(uploads[0].type, /^audio\/(webm|ogg|mp4)$/, 'sent without codec parameters');
    assert.equal((await fake(page)).sieCalls.length, 0);
    assert.equal(await page.$eval('#cwRecorder', (r) => r.hidden), true, 'back to the text row');
    assert.deepEqual(errors, []);
    await context.close();
});

test('voice: cancelling a recording uploads nothing', async () => {
    const { page, context, uploads } = await openWidget({ entitlement: ent('free') });
    await page.click('#cwActionBtn');
    await page.waitForSelector('#cwRecCancel');
    await page.click('#cwRecCancel');
    assert.equal(await page.$eval('#cwRecorder', (r) => r.hidden), true);
    assert.equal(uploads.length, 0);
    await page.click('#cwActionBtn');
    await page.waitForSelector('#cwRecStop');
    await page.waitForFunction(() => document.getElementById('cwRecTime')?.textContent !== '0:00', null, { timeout: 5000 });
    await page.click('#cwRecStop');
    await page.waitForSelector('#cwRecDiscard');
    await page.click('#cwRecDiscard');
    assert.equal(uploads.length, 0, 'discarding the preview uploads nothing either');
    await context.close();
});

test('voice: a denied microphone is explained and the text composer keeps working', async () => {
    const { page, context } = await openWidget({ entitlement: ent('free') }, {
        initScript: () => { navigator.mediaDevices.getUserMedia = async () => { const e = new Error('denied'); e.name = 'NotAllowedError'; throw e; }; }
    });
    await page.click('#cwActionBtn');
    await page.waitForSelector('.chat-widget-inline-error');
    assert.match(await page.textContent('.chat-widget-inline-error'), /للميكروفون مرفوض/);
    assert.equal(await page.$eval('.chat-widget-input-row', (r) => r.hidden), false);
    await page.fill('#chatWidgetTextInput', 'نص عادي');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__fake.sieCalls.length === 1);
    await context.close();
});

test('voice: a browser without recording support shows send, never a dead mic', async () => {
    const { page, context } = await openWidget({ entitlement: ent('free') }, { initScript: () => { delete window.MediaRecorder; } });
    assert.equal(await page.getAttribute('#cwActionBtn', 'data-action'), 'send');
    assert.equal(await page.$eval('#cwActionBtn', (b) => b.disabled), true);
    await page.fill('#chatWidgetTextInput', 'x');
    assert.equal(await page.$eval('#cwActionBtn', (b) => b.disabled), false);
    await context.close();
});

// ════════════════════════════ layout ════════════════════════════

test('mobile: full-screen sheet, no horizontal overflow, the menu stays on screen', async () => {
    const { page, context, errors } = await openWidget({ entitlement: ent('max') }, { viewport: { width: 390, height: 844 } });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.equal(overflow, 0);
    const row = await page.$eval('.chat-widget-input-row', (r) => ({ w: r.scrollWidth, cw: r.clientWidth }));
    assert.ok(row.w <= row.cw + 1, 'the composer row fits');
    await page.click('#cwModeChip');
    const box = await page.$eval('#cwModeMenu', (m) => m.getBoundingClientRect().toJSON());
    assert.ok(box.left >= 0 && box.right <= 390 && box.top >= 0, JSON.stringify(box));
    assert.deepEqual(errors, []);
    await context.close();
});


// لقطات للمراجعة البصرية: WIDGET_SHOTS=<dir> node --test tests/chat-widget.render.test.mjs
test('visual: desktop / mobile, light / dark — composer, menu, attachments, recording', { skip: !process.env.WIDGET_SHOTS }, async () => {
    const dir = process.env.WIDGET_SHOTS;
    fs.mkdirSync(dir, { recursive: true });
    const messages = [
        { id: 'x1', created_at: new Date(Date.now() - 60000).toISOString(), sender_id: null, is_bot_reply: true, message_text: 'أهلاً بيك! اكتبلي مشكلتك.' },
        { id: 'x2', created_at: new Date(Date.now() - 50000).toISOString(), sender_id: 'u-1', message_text: 'دي الشاشة', image_url: 'u-1/s-1-a.png', attachment: { kind: 'image', path: 'u-1/s-1-a.png', name: 'shot.png' } },
        { id: 'x3', created_at: new Date(Date.now() - 40000).toISOString(), sender_id: 'u-1', message_text: 'ملف مرفق: invoice-sept.pdf', attachment: { kind: 'file', path: 'u-1/s-1-b.pdf', name: 'invoice-sept.pdf', size: 184320 } },
        { id: 'x4', created_at: new Date(Date.now() - 30000).toISOString(), sender_id: 'u-1', message_text: 'رسالة صوتية', audio_url: 'u-1/s-1-c.webm', attachment: { kind: 'audio', path: 'u-1/s-1-c.webm', duration_ms: 7400 } },
        { id: 'x5', created_at: new Date(Date.now() - 20000).toISOString(), sender_id: null, is_bot_reply: true, message_text: 'وصلتني الصورة والفاتورة. هل المشكلة بتظهر عند الدفع ولا بعده؟' }
    ];
    for (const [name, viewport] of [['desktop', { width: 1366, height: 860 }], ['mobile', { width: 390, height: 844 }]]) {
        for (const theme of ['light', 'dark']) {
            const { page, context } = await openWidget({ entitlement: ent('pro'), messages }, { viewport });
            await page.evaluate((t) => { if (t === 'dark') document.documentElement.dataset.theme = 'dark'; document.body.style.background = t === 'dark' ? '#0b1522' : '#eef2f7'; }, theme);
            await page.waitForTimeout(400);
            await page.screenshot({ path: path.join(dir, `${name}-${theme}-chat.png`) });
            await page.click('#cwModeChip');
            await page.waitForSelector('#cwModeMenu .cw-usage');
            await page.waitForTimeout(350);
            await page.screenshot({ path: path.join(dir, `${name}-${theme}-menu.png`) });
            await page.keyboard.press('Escape');
            await attach(page, [{ name: 'screenshot-error.png', mimeType: 'image/png', buffer: PNG_1PX }, { name: 'تقرير الأعطال الشهري.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF') }]);
            await page.fill('#chatWidgetTextInput', 'مرفق الصورة والتقرير');
            assert.equal(await page.$eval('#cwActionBtn', (b) => [b.dataset.action, b.disabled].join()), 'send,false', 'send is enabled');
            await page.screenshot({ path: path.join(dir, `${name}-${theme}-attachments.png`) });
            await context.close();
        }
    }
    const { page, context } = await openWidget({ entitlement: ent('max') });
    await page.click('#cwActionBtn');
    await page.waitForFunction(() => document.getElementById('cwRecTime')?.textContent !== '0:00');
    await page.screenshot({ path: path.join(dir, 'desktop-light-recording.png') });
    await page.click('#cwRecStop');
    await page.waitForSelector('#cwRecDiscard');
    await page.screenshot({ path: path.join(dir, 'desktop-light-preview.png') });
    await page.click('#cwRecDiscard');
    await page.click('#cwModeChip');
    await page.waitForSelector('#cwModeMenu .cw-downgrade-btn');
    await page.waitForTimeout(350);
    await page.screenshot({ path: path.join(dir, 'desktop-light-menu-max.png') });
    await context.close();
});
