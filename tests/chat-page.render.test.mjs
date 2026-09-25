/**
 * chat-page.render.test.mjs
 * ------------------------------------------------------------
 * صفحة الشات الكاملة (chat-customer.html)
 * ولوحة خطة SIE في الإعدادات، في Chromium فعلي مقابل بديل لـ Supabase
 * ولعميل SIE — نفس نهج chat-widget.render.test.mjs.
 *
 * يثبت أن الوضع التقليدي لم يعد له أي طريق في هذه الأسطح: SIE هو المحرك
 * الوحيد، وعند تعذّره رسالة واضحة بالسبب بلا بوت بديل؛ وأن المرفقات (صورة،
 * صوت، ملف) تظهر للعميل من المسار الموقَّع (وللطاقم: admin-inbox.render.test.mjs).
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

// بديل Supabase: .single()/.maybeSingle() → صف، والانتظار المباشر → قائمة.
const FAKE_API = `
const cfg = window.__FAKE_CONFIG || {};
const state = window.__fake = { inserts: [], rpc: [], removed: [], sessionUpdates: [], listeners: [], sieCalls: [] };
let seq = 0;
const now = () => new Date(Date.now() + (seq++)).toISOString();
const SESSION = { id: 's-1', user_id: 'u-1', status: 'active', bot_state: {}, is_manual_mode: false, updated_at: now(),
  profiles: { full_name: 'عميل تجريبي', role: 'user' }, chat_messages: [] };
function emit(table, row, event = 'INSERT') { state.listeners.filter(l => l.table === table && (!l.event || l.event === '*' || l.event === event)).forEach(l => setTimeout(() => l.cb({ eventType: event, new: row }), 0)); }
state.emit = emit;
function query(table) {
  const one = () => {
    if (table === 'chat_sessions') return { data: SESSION, error: null };
    if (table === 'bot_settings') return { data: { welcome_message: 'أهلاً بيك' }, error: null };
    if (table === 'profiles') return { data: { role: cfg.role || 'user', full_name: 'x' }, error: null };
    return { data: null, error: null };
  };
  const many = () => {
    if (table === 'chat_sessions') return { data: [SESSION], error: null };
    if (table === 'chat_messages') return { data: (cfg.messages || []).slice(), error: null };
    return { data: [], error: null };
  };
  const api = {
    select() { return api; }, eq() { return api; }, order() { return api; }, limit() { return api; },
    single: async () => one(), maybeSingle: async () => one(),
    then(res, rej) { return Promise.resolve(many()).then(res, rej); },
    insert(row) {
      if (cfg.failInsert && table === 'chat_messages' && row.sender_id) return Promise.resolve({ error: { message: 'insert failed' } });
      const stored = { id: 'm-' + (seq++), created_at: now(), ...row };
      state.inserts.push({ table, row });
      if (table === 'chat_messages') emit('chat_messages', stored);
      const p = Promise.resolve({ error: null });
      p.select = () => ({ single: async () => ({ data: SESSION, error: null }) });
      return p;
    },
    update(patch) { state.sessionUpdates.push({ table, patch }); return { eq: async () => ({ error: null }) }; }
  };
  return api;
}
export const supabase = {
  auth: { getUser: async () => ({ data: { user: { id: 'u-1', email: 'staff@x.test', user_metadata: {} } } }) },
  from: query,
  async rpc(fn, args) {
    state.rpc.push({ fn, args });
    if (fn === 'sie_my_entitlement') {
      const e = typeof cfg.entitlement === 'function' ? cfg.entitlement(state) : cfg.entitlement;
      return { data: e ?? null, error: null };
    }
    if (fn === 'sie_customer_downgrade') return { data: cfg.downgradeResult || { ok: true, edition: args.p_target }, error: null };
    return { data: null, error: null };
  },
  channel() { const ch = { on(ev, filter, cb) { state.listeners.push({ table: filter.table, event: filter.event, cb }); return ch; }, subscribe() { return ch; } }; return ch; },
  removeChannel() {},
  storage: { from() { return {
    async createSignedUploadUrl(path) { return { data: { signedUrl: location.origin + '/__upload/' + path, path }, error: null }; },
    async upload(path) { return { data: { path }, error: null }; },
    async createSignedUrls(paths) { return { data: paths.map(p => ({ path: p, signedUrl: location.origin + '/__file/' + p })), error: null }; },
    async createSignedUrl(p) { return { data: { signedUrl: location.origin + '/__file/' + p }, error: null }; },
    async remove(paths) { state.removed.push(...paths); return { data: paths, error: null }; }
  }; } }
};
`;
const FAKE_GUARD = `export async function guardPage() { return { id: 'u-1', email: 'c@x.test', profile: { full_name: 'عميل تجريبي' }, isImpersonated: false }; }`;
const FAKE_SIE = `
export async function getSieReply(args) {
  window.__fake.sieCalls.push({ text: args.text });
  const r = window.__FAKE_CONFIG?.sieReply;
  if (r === null) return null;
  return r || { reply: 'رد من SIE', options: [], botState: {}, alreadyPersisted: false };
}`;
const PANEL_HOST = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"></head><body>
<div id="panel"></div><button id="opener">فتح</button>
<script type="module">
import { renderChatbotModeInto, openChatbotModeDialog } from '/assets/js/chatbot-mode-selector.js';
window.__panel = renderChatbotModeInto(document.getElementById('panel'), { userId: 'u-1', onPlanChanged: (e, d) => { window.__changed = d; } });
document.getElementById('opener').onclick = () => openChatbotModeDialog({ userId: 'u-1', returnFocus: document.getElementById('opener') });
</script></body></html>`;

const RESET = new Date(Date.now() + 3 * 3600e3).toISOString();
const ent = (edition, extra = {}) => ({
    signed_in: true, has_access: true, reason: null, edition,
    downgrade_to: { max: ['pro', 'free'], pro: ['free'], free: [] }[edition],
    primary: { kind: 'monthly', used: 40, limit: 100, remaining: 60, resets_at: RESET },
    ...extra
});

let server, browser, base;
test.before(async () => {
    server = await startServer();
    base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch();
});
test.after(async () => { await browser?.close(); server?.close(); });

async function openPage(url, config = {}, { viewport = { width: 1280, height: 820 } } = {}) {
    const context = await browser.newContext({ viewport, locale: 'ar-EG' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const uploads = [];
    await page.addInitScript((c) => { window.__FAKE_CONFIG = c; }, config);
    await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
    await page.route('**/__panel.html', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: PANEL_HOST }));
    await page.route('**/api-config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: FAKE_API }));
    await page.route('**/assets/js/page-guard.js', (r) => r.fulfill({ contentType: 'text/javascript', body: FAKE_GUARD }));
    await page.route('**/assets/js/sie-client.js', (r) => r.fulfill({ contentType: 'text/javascript', body: FAKE_SIE }));
    await page.route('**/__upload/**', async (r) => {
        uploads.push(decodeURIComponent(new URL(r.request().url()).pathname.replace('/__upload/', '')));
        await r.fulfill({ status: 200, body: '{}' });
    });
    await page.route('**/__file/**', (r) => r.fulfill({ contentType: /\.pdf$/.test(r.request().url()) ? 'application/pdf' : /\.webm$/.test(r.request().url()) ? 'audio/webm' : 'image/png', body: /\.webm$/.test(r.request().url()) ? Buffer.alloc(0) : PNG_1PX }));
    await page.goto(`${base}${url}`);
    return { page, context, errors, uploads };
}

const fake = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.__fake)));
const msgInserts = async (page) => (await fake(page)).inserts.filter((i) => i.table === 'chat_messages').map((i) => i.row);

async function openCustomer(config, opts) {
    const r = await openPage('/chat-customer.html', config, opts);
    await r.page.waitForFunction(() => window.__fake?.rpc.some((c) => c.fn === 'sie_my_entitlement'));
    await r.page.waitForFunction(() => document.getElementById('chatPlanLabel')?.textContent !== '' || document.getElementById('chatModeInlineBtn')?.dataset.tone === 'unknown');
    return r;
}

async function sendText(page, text) {
    await page.fill('#chatInput', text);
    await page.click('#sendBtn');
}

// ════════════════════════════ صفحة شات العميل ════════════════════════════

test('customer page: composer is [attach][input][SIE · plan][send]; no Traditional anywhere; starters are SIE starters', async () => {
    const { page, context, errors } = await openCustomer({ entitlement: ent('pro') });
    const order = await page.$$eval('.chat-footer > :not([hidden])', (els) => els.map((e) => e.id));
    assert.deepEqual(order, ['chatAttachBtn', 'chatInput', 'chatModeInlineBtn', 'sendBtn']);
    assert.equal(await page.textContent('#chatPlanLabel'), 'برو');
    assert.equal(await page.getAttribute('#chatModeInlineBtn', 'data-tone'), 'ok');
    assert.equal(await page.$('#chatModeBtn'), null, 'the old header mode button is gone');
    await page.waitForSelector('.bot-quick-option-btn');
    const starters = await page.$$eval('.bot-quick-option-btn', (b) => b.map((x) => x.textContent.trim()));
    assert.deepEqual(starters, ['عندي استفسار', 'عندي مشكلة']);
    assert.doesNotMatch(await page.textContent('body'), /تقليدي|Traditional/i);
    const greet = (await fake(page)).sessionUpdates.find((u) => u.patch.bot_state);
    assert.deepEqual(greet.patch.bot_state, { greeted: true }, 'no traditional flow state is written');
    assert.deepEqual(errors, []);
    await context.close();
});

test('customer page: every text goes to SIE (Free) and the reply is stored — no other engine', async () => {
    const { page, context, errors } = await openCustomer({ entitlement: ent('free', { downgrade_to: [] }) });
    await sendText(page, 'عندي مشكلة في الدفع');
    await page.waitForFunction(() => window.__fake.inserts.some((i) => i.row.message_text === 'رد من SIE'));
    const f = await fake(page);
    assert.deepEqual(f.sieCalls.map((c) => c.text), ['عندي مشكلة في الدفع']);
    assert.equal(await page.inputValue('#chatInput'), '');
    assert.deepEqual(errors, []);
    await context.close();
});

test('customer page: SIE blocked (limit reached) → a clear reason in the chat, SIE not called, message kept', async () => {
    const { page, context } = await openCustomer({ entitlement: ent('free', { has_access: false, reason: 'edition_monthly_limit', downgrade_to: [] }) });
    assert.equal(await page.getAttribute('#chatModeInlineBtn', 'data-tone'), 'blocked');
    await sendText(page, 'محتاج مساعدة');
    await page.waitForFunction(() => window.__fake.inserts.some((i) => /وصلت لفريق الدعم/.test(i.row.message_text || '')));
    const rows = await msgInserts(page);
    assert.ok(rows.some((r) => r.sender_id === 'u-1' && r.message_text === 'محتاج مساعدة'), 'customer message is stored for support');
    assert.equal((await fake(page)).sieCalls.length, 0);
    assert.doesNotMatch(rows.map((r) => r.message_text).join('\n'), /تقليدي|وضع تاني/);
    await context.close();
});

test('customer page: SIE null reply → asks the server why; a temporary problem is said as such', async () => {
    const { page, context } = await openCustomer({ entitlement: ent('max'), sieReply: null });
    await sendText(page, 'سؤال');
    await page.waitForFunction(() => window.__fake.inserts.some((i) => /مشكلة مؤقتة/.test(i.row.message_text || '')));
    const calls = (await fake(page)).rpc.filter((c) => c.fn === 'sie_my_entitlement').length;
    assert.ok(calls >= 2, 'the entitlement is re-read after the refusal');
    await context.close();
});

test('customer page: a failed send keeps the typed text and says so', async () => {
    const { page, context } = await openCustomer({ entitlement: ent('pro'), failInsert: true });
    await sendText(page, 'نص مهم');
    await page.waitForSelector('#chatComposerStatus:not([hidden])');
    assert.match(await page.textContent('#chatComposerStatus'), /فشل إرسال/);
    assert.equal(await page.inputValue('#chatInput'), 'نص مهم');
    assert.equal((await fake(page)).sieCalls.length, 0);
    await context.close();
});

test('customer page: attaching a PDF uploads to the sender folder and stores attachment (no SIE call without text)', async () => {
    const { page, context, uploads } = await openCustomer({ entitlement: ent('pro') });
    await page.setInputFiles('#chatFileInput', { name: 'invoice.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 test') });
    await page.waitForFunction(() => window.__fake.inserts.some((i) => i.row.attachment));
    const row = (await msgInserts(page)).find((r) => r.attachment);
    assert.equal(row.attachment.kind, 'file');
    assert.equal(row.image_url, undefined);
    assert.match(row.attachment.path, /^u-1\/s-1-\d+-[a-z0-9]{6}\.pdf$/);
    assert.deepEqual(uploads, [row.attachment.path]);
    assert.equal(row.message_text, 'ملف مرفق: invoice.pdf');
    assert.equal((await fake(page)).sieCalls.length, 0);
    await page.waitForSelector('#chatMessages .cw-att-file.is-ready');
    assert.equal(await page.$eval('#chatMessages .msg.sent', (el) => el.textContent.includes('ملف مرفق:')), false, 'the auto label is hidden, the chip is shown');
    await context.close();
});

test('customer page: an unsupported file is refused before any upload', async () => {
    const { page, context, uploads } = await openCustomer({ entitlement: ent('pro') });
    await page.setInputFiles('#chatFileInput', { name: 'run.exe', mimeType: 'application/x-msdownload', buffer: Buffer.from('MZ') });
    await page.waitForSelector('#chatComposerStatus:not([hidden])');
    assert.match(await page.textContent('#chatComposerStatus'), /نوع الملف غير مدعوم/);
    assert.equal(uploads.length, 0);
    assert.equal((await msgInserts(page)).filter((r) => r.sender_id).length, 0);
    await context.close();
});

test('customer page: an image, a voice note and a legacy image_url all render signed', async () => {
    const messages = [
        { id: 'a', session_id: 's-1', sender_id: 'u-1', created_at: new Date().toISOString(), message_text: 'صورة مرفقة', image_url: 'u-1/a.png', attachment: { kind: 'image', path: 'u-1/a.png', name: 'a.png', mime: 'image/png', size: 70 } },
        { id: 'b', session_id: 's-1', sender_id: 'u-1', created_at: new Date().toISOString(), message_text: 'رسالة صوتية', audio_url: 'u-1/v.webm', attachment: { kind: 'audio', path: 'u-1/v.webm', name: 'voice.webm', mime: 'audio/webm', size: 900, duration_ms: 4000 } },
        { id: 'c', session_id: 's-1', sender_id: 'u-1', created_at: new Date().toISOString(), message_text: 'قديمة', image_url: 'u-1/old.png' }
    ];
    const { page, context, errors } = await openCustomer({ entitlement: ent('pro'), messages });
    await page.waitForFunction(() => document.querySelectorAll('#chatMessages .cw-att.is-ready').length === 3);
    const srcs = await page.$$eval('#chatMessages img, #chatMessages audio', (els) => els.map((e) => new URL(e.src).pathname));
    assert.deepEqual(srcs, ['/__file/u-1/a.png', '/__file/u-1/v.webm', '/__file/u-1/old.png']);
    assert.match(await page.textContent('#chatMessages .cw-att-audio'), /0:04/);
    assert.deepEqual(errors, []);
    await context.close();
});

test('customer page: a support reply edited then deleted in the inbox updates in place', async () => {
    const reply = { id: 'r1', session_id: 's-1', sender_id: 'staff-1', is_admin_reply: true, created_at: new Date().toISOString(), message_text: 'الرد الأول' };
    const { page, context, errors } = await openCustomer({ entitlement: ent('pro'), messages: [reply] });
    await page.waitForSelector('#chatMessages [data-msg-id="r1"]');
    const count = () => page.locator('#chatMessages [data-msg-id]').count();
    const before = await count();

    await page.evaluate((r) => window.__fake.emit('chat_messages', { ...r, message_text: 'الرد بعد التعديل', edited_at: new Date().toISOString() }, 'UPDATE'), reply);
    await page.waitForFunction(() => document.querySelector('#chatMessages [data-msg-id="r1"]')?.textContent.includes('بعد التعديل'));
    assert.match(await page.textContent('#chatMessages [data-msg-id="r1"]'), /معدّلة/);

    await page.evaluate((r) => window.__fake.emit('chat_messages', { ...r, message_text: '', deleted_at: new Date().toISOString() }, 'UPDATE'), reply);
    await page.waitForFunction(() => document.querySelector('#chatMessages [data-msg-id="r1"]')?.textContent.includes('تم حذف هذه الرسالة'));
    assert.doesNotMatch(await page.textContent('#chatMessages [data-msg-id="r1"]'), /الرد|معدّلة/);
    assert.equal(await count(), before, 'an UPDATE must not append a message');
    assert.deepEqual(errors, []);
    await context.close();
});

test('customer page: the plan chip opens the plan dialog (keyboard, Escape returns focus), downgrade calls the server', async () => {
    const { page, context } = await openCustomer({ entitlement: ent('max') });
    await page.focus('#chatModeInlineBtn');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.cms-dialog .cms-downgrade-btn');
    assert.deepEqual(await page.$$eval('.cms-downgrade-btn', (b) => b.map((x) => x.dataset.plan)), ['pro', 'free']);
    assert.match(await page.textContent('.cms-dialog'), /SIE ماكس/);
    assert.match(await page.textContent('.cms-dialog'), /40%/);
    assert.doesNotMatch(await page.textContent('.cms-dialog'), /تقليدي|نموذج ذكاء|تلقائي/);
    await page.click('.cms-downgrade-btn[data-plan="pro"]');
    assert.equal((await fake(page)).rpc.filter((c) => c.fn === 'sie_customer_downgrade').length, 0, 'the first press only asks to confirm');
    await page.click('.cms-downgrade-btn[data-plan="pro"]');
    await page.waitForFunction(() => window.__fake.rpc.some((c) => c.fn === 'sie_customer_downgrade'));
    assert.deepEqual((await fake(page)).rpc.find((c) => c.fn === 'sie_customer_downgrade').args, { p_target: 'pro' });
    await page.waitForFunction(() => window.__fake.inserts.some((i) => /تم تغيير خطة SIE إلى برو/.test(i.row.message_text || '')));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.cms-overlay'));
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'chatModeInlineBtn');
    await context.close();
});

test('customer page: mobile — no horizontal overflow, the plan name collapses, dialog fits', async () => {
    const { page, context } = await openCustomer({ entitlement: ent('pro') }, { viewport: { width: 360, height: 740 } });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, `page overflows by ${overflow}px`);
    const footer = await page.$eval('.chat-footer', (el) => el.scrollWidth - el.clientWidth);
    assert.ok(footer <= 0, `composer overflows by ${footer}px`);
    await page.click('#chatModeInlineBtn');
    await page.waitForSelector('.cms-dialog .cms-usage');
    const box = await page.$eval('.cms-dialog', (el) => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right }; });
    assert.ok(box.l >= 0 && box.r <= 360);
    await context.close();
});

// ════════════════════════════ لوحة الإعدادات ════════════════════════════

test('settings panel: shows SIE plan and usage from the server; Free offers no downgrade; failure is fail-safe', async () => {
    let r = await openPage('/__panel.html', { entitlement: ent('free', { downgrade_to: [] }) });
    await r.page.waitForSelector('#panel .cms-usage');
    const text = await r.page.textContent('#panel');
    assert.match(text, /SIE المجاني/);
    assert.match(text, /40 \/ 100/);
    assert.match(text, /60 متبقي/);
    assert.match(text, /يتجدد بعد/);
    assert.equal(await r.page.$('#panel .cms-downgrade-btn'), null);
    assert.doesNotMatch(text, /تقليدي/);
    await r.context.close();

    r = await openPage('/__panel.html', { entitlement: null });
    await r.page.waitForSelector('#panel .cms-retry-btn');
    assert.match(await r.page.textContent('#panel'), /تعذّر تحميل خطة SIE/);
    assert.deepEqual(r.errors, []);
    await r.context.close();
});

test('settings panel: a server refusal of a downgrade is shown and nothing else changes', async () => {
    const { page, context } = await openPage('/__panel.html', { entitlement: ent('pro'), downgradeResult: { ok: false, error: 'not_a_downgrade' } });
    await page.waitForSelector('#panel .cms-downgrade-btn');
    await page.click('#panel .cms-downgrade-btn');
    await page.click('#panel .cms-downgrade-btn');
    await page.waitForSelector('#panel .cms-error:not([hidden])');
    assert.ok((await page.textContent('#panel .cms-error')).length > 0);
    assert.equal(await page.evaluate(() => window.__changed ?? null), null);
    await context.close();
});

// شات الأدمن: chat-admin.html اتشالت؛ admin/inbox.html هي واجهة الإدارة
// الوحيدة، وضمانة «مرفقات العميل موقَّعة للطاقم والنص التلقائي مخفي» اتنقلت
// لـ tests/admin-inbox.render.test.mjs.
