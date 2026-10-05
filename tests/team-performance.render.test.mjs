/**
 * اختبارات عرض «أداء الفريق» (admin/team-performance.html) في متصفح حقيقي.
 *
 * بتشغّل الكود الحقيقي (team-performance.js + الموديل + page-guard + السايدبار)
 * على بديل Supabase، وبتتأكد من:
 *   - أرقام الفريق وصف كل موظف (المحلولة، المتأخرة، الالتزام، التقييم).
 *   - الفرز، ولوحة تفاصيل الموظف بتذاكره الحالية.
 *   - تغيير الفترة، وقراءة أكتر من 1000 صف (ترقيم PostgREST).
 *   - التحديث اللحظي بيعيد الحساب.
 *   - الصفحة مقفولة على الطاقم، ورابطها في السايدبار.
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

const ADMIN = 'admin-1';
const h = (hoursAgo) => new Date(Date.now() - hoursAgo * 3600000).toISOString();

function fixtures({ role = 'admin', extraReplies = 0 } = {}) {
    const tickets = [
        { id: 't1', ticket_number: 101, title: 'مشكلة في الدفع', assigned_to: 'agent-heba', status: 'resolved', created_at: h(50), first_response_at: h(49.5), resolved_at: h(46), sla_resolution_due_at: h(40) },
        { id: 't2', ticket_number: 102, title: 'ربط واتساب', assigned_to: 'agent-heba', status: 'resolved', created_at: h(30), first_response_at: h(29), resolved_at: h(20), sla_resolution_due_at: h(25) },
        { id: 't3', ticket_number: 103, title: 'كود التحقق مش بيوصل', assigned_to: 'agent-heba', status: 'in-progress', created_at: h(10), first_response_at: h(9.75), sla_resolution_due_at: h(1) },
        { id: 't4', ticket_number: 104, title: 'تغيير الإيميل', assigned_to: 'agent-omar', status: 'open', created_at: h(2), first_response_at: null, sla_resolution_due_at: h(-5) },
        { id: 't5', ticket_number: 105, title: 'تقرير شهري', assigned_to: 'agent-omar', status: 'resolved', created_at: h(8), first_response_at: h(7.9), resolved_at: h(6), sla_resolution_due_at: h(1) },
        { id: 't6', ticket_number: 106, title: 'بدون مسؤول', assigned_to: null, status: 'open', created_at: h(3) }
    ];
    const replies = [
        { user_id: 'agent-heba', is_internal: false, created_at: h(9) },
        { user_id: 'agent-heba', is_internal: true, created_at: h(9) },
        { user_id: 'customer-1', is_internal: false, created_at: h(9) },
        ...Array.from({ length: extraReplies }, (_, i) => ({ user_id: 'agent-omar', is_internal: false, created_at: h(1 + i / 1000) }))
    ];
    return {
        user: { id: ADMIN, email: 'admin@test.local' },
        authUser: { id: ADMIN, email: 'admin@test.local', profile: { id: ADMIN, role } },
        tables: {
            profiles: [
                { id: ADMIN, full_name: 'الأدمن', email: 'admin@test.local', role: 'admin' },
                { id: 'agent-heba', full_name: 'هبة سمير', email: 'heba@test.local', role: 'support' },
                { id: 'agent-omar', full_name: 'عمر خالد', email: 'omar@test.local', role: 'support' },
                { id: 'customer-1', full_name: 'عميل', email: 'c@test.local', role: 'user' }
            ],
            tickets,
            ticket_replies: replies,
            ticket_ratings: [{ ticket_id: 't1', rating: 5, created_at: h(45) }, { ticket_id: 't2', rating: 4, created_at: h(19) }],
            chat_messages: [
                { sender_id: 'agent-omar', is_admin_reply: true, created_at: h(1) },
                { sender_id: 'customer-1', is_admin_reply: false, created_at: h(1) }
            ],
            notifications: []
        },
        rpc: { has_elevated_authority: true, is_platform_owner: false, active_context: null, my_account_gate: { status: 'active' } }
    };
}

let browser, server, baseUrl;
const chromiumPath = resolveChromium();
if (!chromiumPath) console.error('SKIP: لا يوجد متصفح Chromium متاح؛ اختبارات أداء الفريق لم تُنفَّذ');

test.before(async () => {
    if (!chromiumPath) return;
    server = await startServer();
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: chromiumPath });
});
test.after(async () => { await browser?.close(); server?.close(); });

async function openPage(fx, { query = '' } = {}) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    // القنوات اللحظية: نسجّل المعالجات ونبلّغ بالاشتراك، عشان الاختبار يقدر يطلق تغيير.
    const doubleSupabase = fs.readFileSync(path.join(ROOT, 'tests/fixtures/supabase-double.js'), 'utf8')
        .replace("const chan = { on: () => chan, subscribe: () => chan, unsubscribe: () => {} };",
            "const chan = { on: (type, opts, cb) => { (window.__RT__ = window.__RT__ || []).push({ table: opts?.table, cb }); return chan; },"
            + " subscribe: (cb) => { setTimeout(() => cb && cb('SUBSCRIBED'), 0); return chan; }, unsubscribe: () => {} };");
    assert.ok(doubleSupabase.includes('__RT__'), 'مقدرتش أضيف القنوات اللحظية للبديل');
    const doubleAuth = fs.readFileSync(path.join(ROOT, 'tests/fixtures/auth-client-double.js'), 'utf8');
    await page.route('**/api-config.js', r => r.fulfill({ contentType: 'text/javascript; charset=utf-8', body: doubleSupabase }));
    await page.route('**/auth-client.js', r => r.fulfill({ contentType: 'text/javascript; charset=utf-8', body: doubleAuth }));
    await page.route('https://fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
    await page.addInitScript(data => { window.__FIXTURES__ = data; try { localStorage.clear(); } catch {} }, fx);

    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(`${baseUrl}/admin/team-performance.html${query}`, { waitUntil: 'networkidle' });
    return { page, context, errors };
}

const rowText = (page, name) => page.locator('#perfBody tr', { hasText: name }).innerText();

test('أرقام الفريق وصف كل موظف', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openPage(fixtures());
    await page.waitForSelector('#perfBody tr[data-agent]');

    const stats = await page.locator('#teamStats').innerText();
    assert.match(stats, /التذاكر المحلولة\s*3/);
    assert.match(stats, /الالتزام بالـ SLA\s*67%/, 'تذكرتين من 3 في الموعد');
    assert.match(stats, /رضا العملاء\s*4\.5/);
    assert.match(stats, /مفتوحة بدون مسؤول\s*1/);

    const names = await page.locator('#perfBody .agent-name').allInnerTexts();
    assert.deepEqual(names.slice(0, 2), ['هبة سمير', 'عمر خالد'], 'الترتيب الافتراضي بالأكثر حلًا');

    const heba = await rowText(page, 'هبة سمير');
    assert.match(heba, /1 متأخرة/);
    assert.match(heba, /50%/);
    assert.match(heba, /4\.5/);
    const omar = await rowText(page, 'عمر خالد');
    assert.match(omar, /100%/);
    assert.doesNotMatch(omar, /متأخرة/);

    assert.match(await page.locator('#liveText').innerText(), /تحديث لحظي/);
    assert.deepEqual(errors, []);
    await context.close();
});

test('الفرز بمتوسط أول رد: الأسرع أولًا', { skip: !chromiumPath }, async () => {
    const { page, context } = await openPage(fixtures());
    await page.waitForSelector('#perfBody tr[data-agent]');
    await page.click('th[data-sort="firstResponse"]');
    const names = await page.locator('#perfBody .agent-name').allInnerTexts();
    assert.equal(names[0], 'عمر خالد');
    await page.click('th[data-sort="firstResponse"]');
    const reversed = await page.locator('#perfBody .agent-name').allInnerTexts();
    assert.notEqual(reversed[0], 'عمر خالد');
    await context.close();
});

test('لوحة الموظف: أرقامه وتذاكره المسندة الآن، والمتأخرة أولًا', { skip: !chromiumPath }, async () => {
    const { page, context } = await openPage(fixtures());
    await page.waitForSelector('#perfBody tr[data-agent]');
    await page.locator('#perfBody tr', { hasText: 'هبة سمير' }).click();
    await page.waitForSelector('#agentDrawer.open');
    const drawer = await page.locator('#agentDrawer').innerText();
    assert.match(drawer, /هبة سمير/);
    assert.match(drawer, /التذاكر المسندة الآن \(1\)/);
    assert.match(drawer, /#103 كود التحقق مش بيوصل/);
    assert.match(drawer, /تجاوز SLA/);
    assert.match(drawer, /قيد المعالجة/);
    await page.keyboard.press('Escape');
    await page.waitForSelector('#agentDrawer:not(.open)');
    await context.close();
});

test('الفترة: من الرابط، ومن الأزرار، وبتتحفظ', { skip: !chromiumPath }, async () => {
    const { page, context } = await openPage(fixtures(), { query: '?period=today' });
    await page.waitForSelector('#perfBody tr[data-agent]');
    assert.equal(await page.locator('#periodPicker button.active').innerText(), 'اليوم');
    await page.click('#periodPicker [data-period="90d"]');
    await page.waitForFunction(() => document.querySelector('#periodPicker button.active')?.dataset.period === '90d');
    assert.equal(await page.evaluate(() => localStorage.getItem('mad3oom_team_perf_period')), '90d');
    await context.close();
});

test('أكتر من 1000 رد بيتقروا كلهم (ترقيم)', { skip: !chromiumPath }, async () => {
    const { page, context } = await openPage(fixtures({ extraReplies: 1500 }));
    await page.waitForSelector('#perfBody tr[data-agent]');
    assert.match(await rowText(page, 'عمر خالد'), /1500/);
    await context.close();
});

test('التحديث اللحظي بيعيد الحساب', { skip: !chromiumPath }, async () => {
    const { page, context } = await openPage(fixtures());
    await page.waitForSelector('#perfBody tr[data-agent]');
    await page.evaluate(() => {
        const t = window.__FIXTURES__.tables.tickets.find(x => x.id === 't4');
        Object.assign(t, { status: 'resolved', resolved_at: new Date().toISOString() });
        for (const l of window.__RT__.filter(x => x.table === 'tickets')) l.cb({ eventType: 'UPDATE', new: t });
    });
    await page.waitForFunction(() => /التذاكر المحلولة\s*4/.test(document.getElementById('teamStats').innerText), null, { timeout: 5000 });
    await context.close();
});

test('مقفولة على الطاقم، ورابطها في السايدبار', { skip: !chromiumPath }, async () => {
    const denied = await openPage(fixtures({ role: 'user' }));
    await denied.page.waitForSelector('#accessDeniedPanel');
    assert.equal(await denied.page.locator('#perfBody tr[data-agent]').count(), 0);
    await denied.context.close();

    const { page, context } = await openPage(fixtures());
    await page.waitForSelector('#teamPerformanceLink');
    assert.equal(await page.getAttribute('#teamPerformanceLink', 'href'), '/admin/team-performance.html');
    assert.match(await page.locator('#teamPerformanceLink').innerText(), /أداء الفريق/);
    await context.close();
});
