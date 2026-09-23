/**
 * «تعذّر التحقق» ≠ «الصلاحية اتسحبت».
 *
 * الخطأ اللي بيتقاس هنا حصل فعلاً على حساب المالك: sie-api رجّع 546
 * (تجاوز وقت المعالج) مرتين، الـ circuit breaker اتفتح، وفحص الصلاحية
 * اللي بعده رجّع null - فالواجهة قرتها "صلاحيتك اتسحبت"، حوّلت العميل
 * للوضع التقليدي، وحفظت ده في profiles.chatbot_mode. عميل مفعّل له SIE
 * بلا حدود خسر اختياره بسبب عطل مؤقت.
 *
 * بيتشغّل الكود الحقيقي (sie-client.js ← chatbot-mode-service.js ←
 * chatbot-mode-selector.js) في Chromium، والـ HTTP لـ SIE مُعترَض.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = path.resolve(import.meta.dirname, '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css' };
const SIE = 'https://sie.test';
const USER = '11111111-1111-4111-8111-111111111111';

function startServer() {
    const server = http.createServer((req, res) => {
        const urlPath = decodeURIComponent(req.url.split('?')[0]);
        if (urlPath === '/__blank.html') {
            res.writeHead(200, { 'Content-Type': MIME['.html'] });
            res.end('<!doctype html><html lang="ar" dir="rtl"><body></body></html>');
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

/** @param {(route) => Promise<void>} sieHandler يرد على كل طلب لـ SIE */
async function openPage(browser, baseUrl, sieHandler, { chatbotMode = 'sie' } = {}) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const dbl = fs.readFileSync(path.join(ROOT, 'tests/fixtures/supabase-double.js'), 'utf8');
    await page.route('**/api-config.js', r => r.fulfill({ contentType: 'text/javascript', body: dbl }));
    await page.route('**/sie-config.js', r => r.fulfill({
        contentType: 'text/javascript',
        body: `export const getSieBaseUrl = () => '${SIE}'; export const isSieDebugMode = () => false;`
    }));
    await page.route(`${SIE}/**`, sieHandler);
    await page.addInitScript(fx => { window.__FIXTURES__ = fx; }, {
        user: { id: USER, email: 'owner@example.com' },
        tables: {
            profiles: [{ id: USER, role: 'platform_owner', whatsapp_enabled: true, chatbot_mode: chatbotMode,
                         chatbot_selected_integration_id: null, chatbot_selected_model_id: null }]
        }
    });
    await page.goto(`${baseUrl}/__blank.html`);
    return { page, context };
}

const status546 = r => r.fulfill({ status: 546, contentType: 'application/json', body: '{"code":"WORKER_LIMIT"}' });
const accessRow = access => r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ access }) });
const ENABLED = { user_id: USER, is_enabled: true, access_mode: 'unlimited', message_quota: null, messages_used: 2, expires_at: null };

const accessInfo = page => page.evaluate(async (id) => {
    const m = await import('/assets/js/chatbot-mode-service.js');
    return m.getSieAccessInfo(id);
}, USER);

const chromiumPath = resolveChromium();
let server, baseUrl, browser;

test.before(async () => {
    if (!chromiumPath) return;
    server = await startServer();
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: chromiumPath });
});
test.after(async () => { await browser?.close(); server?.close(); });

test('عطل SIE (546) = تعذّر التحقق، مش سحب صلاحية', { skip: !chromiumPath }, async () => {
    const { page, context } = await openPage(browser, baseUrl, status546);
    const info = await accessInfo(page);
    assert.equal(info.available, false, 'SIE لازم ميتستخدمش والتحقق فاشل (fail closed)');
    assert.equal(info.checkFailed, true);
    await context.close();
});

test('الـ circuit مفتوح بعد عطلين = برضه تعذّر التحقق', { skip: !chromiumPath }, async () => {
    let calls = 0;
    const { page, context } = await openPage(browser, baseUrl, r => { calls++; return status546(r); });
    await accessInfo(page);                  // محاولة + retry → الدائرة تتفتح
    const callsBefore = calls;
    const info = await accessInfo(page);     // من غير أي طلب شبكة
    assert.equal(calls, callsBefore, 'الدائرة المفتوحة المفروض متبعتش طلب');
    assert.equal(info.checkFailed, true);
    await context.close();
});

test('ردّ صريح من السيرفر يفضل له معناه', { skip: !chromiumPath }, async () => {
    let { page, context } = await openPage(browser, baseUrl, accessRow(null));
    let info = await accessInfo(page);
    assert.deepEqual([info.available, info.checkFailed], [false, false], 'مفيش صف = مش متاح فعلاً');
    await context.close();

    ({ page, context } = await openPage(browser, baseUrl, accessRow({ ...ENABLED, is_enabled: false })));
    info = await accessInfo(page);
    assert.deepEqual([info.available, info.checkFailed, info.statusLabel], [false, false, 'غير مفعّل']);
    await context.close();

    ({ page, context } = await openPage(browser, baseUrl, accessRow(ENABLED)));
    info = await accessInfo(page);
    assert.deepEqual([info.available, info.checkFailed], [true, false]);
    await context.close();
});

test('نافذة الوضع: عطل مؤقت لا يحفظ "تقليدي" ويُبقي SIE مختارًا', { skip: !chromiumPath }, async () => {
    const { page, context } = await openPage(browser, baseUrl, status546);
    await page.evaluate(async (id) => {
        const m = await import('/assets/js/chatbot-mode-selector.js');
        m.openChatbotModeDialog({ userId: id, onModeChanged: () => {} });
    }, USER);
    await page.waitForSelector('.cms-mode-card[data-mode="sie"]');
    assert.equal(await page.locator('.cms-revoked-note').count(), 0, 'بانر "اتحوّلت للتقليدي" ظهر بسبب عطل مؤقت');
    assert.match(await page.getAttribute('.cms-mode-card[data-mode="sie"]', 'class'), /cms-mode-card-active/);
    await page.waitForTimeout(200);
    const writes = await page.evaluate(() => (window.__WRITES__ || []).filter(w => w.table === 'profiles'));
    assert.deepEqual(writes, [], 'اتكتب في profiles بسبب عطل مؤقت');
    await context.close();
});

test('نافذة الوضع: سحب صلاحية حقيقي ما زال يحوّل ويحفظ', { skip: !chromiumPath }, async () => {
    const { page, context } = await openPage(browser, baseUrl, accessRow({ ...ENABLED, is_enabled: false }));
    await page.evaluate(async (id) => {
        const m = await import('/assets/js/chatbot-mode-selector.js');
        m.openChatbotModeDialog({ userId: id, onModeChanged: () => {} });
    }, USER);
    await page.waitForSelector('.cms-revoked-note');
    await page.waitForFunction(() => (window.__WRITES__ || []).some(w => w.table === 'profiles'));
    const writes = await page.evaluate(() => window.__WRITES__.filter(w => w.table === 'profiles'));
    assert.equal(writes[0].row.chatbot_mode, 'traditional');
    await context.close();
});
