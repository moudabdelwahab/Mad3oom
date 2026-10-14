/**
 * بوابة عملاء الشركة (/portal/، D8، الترحيل 095) — عرض حقيقي في Chromium مقابل
 * بديل Supabase/auth (نفس بدائل اختبارات لوحة الشركة).
 *
 * العزل نفسه مُختبَر في القاعدة (tests/sql/account-boundaries.test.sql: my_company_portal
 * تعيد الاسم فقط لعميل الشركة و null لغيره). هنا: ما تعرضه الصفحة في كل حالة.
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
        let urlPath = decodeURIComponent(req.url.split('?')[0]);
        if (urlPath.endsWith('/')) urlPath += 'index.html';
        const filePath = path.join(ROOT, urlPath);
        if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
            res.writeHead(404); res.end('not found'); return;
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
        fs.createReadStream(filePath).pipe(res);
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const USER_ID = '22222222-2222-4222-8222-222222222222';

function fixtures({ portal, tickets = [] } = {}) {
    return {
        user: { id: USER_ID, email: 'customer@example.com' },
        authUser: { id: USER_ID, email: 'customer@example.com',
                    profile: { id: USER_ID, full_name: 'عميل', role: 'company_user' } },
        rpc: { my_company_portal: portal ?? null, my_account_kind: 'company_customer' },
        tables: {
            profiles: [{ id: USER_ID, email: 'customer@example.com', full_name: 'عميل', role: 'company_user' }],
            tickets,
            ticket_replies: [],
            notifications: []
        }
    };
}

async function openPortal(browser, baseUrl, fx) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const doubleSupabase = fs.readFileSync(path.join(ROOT, 'tests/fixtures/supabase-double.js'), 'utf8');
    const doubleAuth = fs.readFileSync(path.join(ROOT, 'tests/fixtures/auth-client-double.js'), 'utf8');
    await page.route('**/api-config.js', r => r.fulfill({ contentType: 'text/javascript; charset=utf-8', body: doubleSupabase }));
    await page.route('**/auth-client.js', r => r.fulfill({ contentType: 'text/javascript; charset=utf-8', body: doubleAuth }));
    await page.route('**/error-tracker.js', r => r.fulfill({ contentType: 'text/javascript', body: '' }));
    await page.route('https://fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
    await page.addInitScript(data => { window.__FIXTURES__ = data; }, fx);
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${baseUrl}/portal/`, { waitUntil: 'networkidle' });
    await page.waitForFunction(
        () => !document.getElementById('portalContent')?.hidden
            || !!document.querySelector('#portalGateBody .state-block'),
        null, { timeout: 10000 });
    // المحتوى ظاهر: ننتظر اكتمال قائمة التذاكر (صفوف أو حالة فارغة نهائية)
    await page.waitForFunction(
        () => document.getElementById('portalContent')?.hidden
            || !!document.querySelector('#portalTickets [data-stream-ticket], #portalTickets .state-block'),
        null, { timeout: 10000 });
    return { page, context, errors };
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
if (!chromiumPath) console.error('SKIP: لا يوجد متصفح Chromium متاح؛ اختبارات عرض بوابة العملاء لم تُنفَّذ');

test.before(async () => {
    if (!chromiumPath) return;
    server = await startServer();
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: chromiumPath });
});
test.after(async () => { await browser?.close(); server?.close(); });

test('عميل الشركة يرى اسم شركته وتذاكره فقط', { skip: !chromiumPath }, async () => {
    const fx = fixtures({
        portal: { company: { id: 'c1', name: 'شركة النور' }, preview: false },
        tickets: [{ id: 't1', ticket_number: 41, title: 'طلبي لم يصل', description: 'تفاصيل', status: 'open',
                    user_id: USER_ID, archived_by_customer: false, created_at: '2026-10-01T10:00:00Z', last_updated_at: '2026-10-02T10:00:00Z' }]
    });
    const { page, context, errors } = await openPortal(browser, baseUrl, fx);
    assert.equal(await page.locator('#portalContent').isHidden(), false);
    assert.equal(await page.locator('#portalCompanyName').textContent(), 'شركة النور');
    assert.match(await page.locator('#portalTickets').textContent(), /طلبي لم يصل/);
    assert.equal(await page.locator('#portalPreviewStrip').isHidden(), true);
    // الحساب الشخصي (واشتراكه) في بوابة مدعوم الرسمية، منفصل عن الشركة
    assert.equal(await page.locator('#portalPersonalAccount').getAttribute('href'), '/customer-dashboard.html');
    // لا روابط شراء ولا أقسام داخلية للشركة
    for (const href of ['/subscriptions.html', '/payment.html', '/company-dashboard/']) {
        assert.equal(await page.locator(`a[href="${href}"]`).count(), 0, `رابط ${href} في البوابة`);
    }
    assert.equal(errors.length, 0, errors.join(' | '));
    await context.close();
});

test('غير عميل الشركة يرى رسالة لا بوابة', { skip: !chromiumPath }, async () => {
    const { page, context } = await openPortal(browser, baseUrl, fixtures({ portal: null }));
    assert.equal(await page.locator('#portalContent').isHidden(), true);
    assert.match(await page.locator('#portalGateBody').textContent(), /هذه البوابة لعملاء الشركات/);
    await context.close();
});

test('فتح تذكرة جديدة: التحقق قبل الإرسال ثم الإرسال', { skip: !chromiumPath }, async () => {
    const fx = fixtures({ portal: { company: { id: 'c1', name: 'شركة النور' }, preview: false } });
    const { page, context } = await openPortal(browser, baseUrl, fx);
    await page.locator('#portalNewTicketBtn').click();
    assert.equal(await page.locator('#portalNewTicket').isHidden(), false);
    await page.locator('#portalTicketTitle').fill('ab');
    await page.locator('#portalTicketSubmit').click();
    assert.equal(await page.locator('#portalTicketError').isHidden(), false, 'لا رسالة لعنوان قصير');
    await page.locator('#portalTicketTitle').fill('مشكلة في الفاتورة');
    await page.locator('#portalTicketDescription').fill('الفاتورة الأخيرة فيها مبلغ مكرر');
    await page.locator('#portalTicketSubmit').click();
    await page.waitForFunction(() => document.getElementById('portalNewTicket').hidden, null, { timeout: 5000 });
    const inserted = await page.evaluate(() => (window.__WRITES__ || [])
        .filter(c => c.op === 'insert' && c.table === 'tickets').map(c => c.row));
    assert.equal(inserted.length, 1, 'لم تُنشأ تذكرة');
    assert.equal(inserted[0].title, 'مشكلة في الفاتورة');
    await context.close();
});

test('منظور العضو لمالك المنصة: شريط القراءة فقط والإرسال معطّل', { skip: !chromiumPath }, async () => {
    const fx = fixtures({ portal: { company: { id: 'c1', name: 'شركة المالك' }, preview: true } });
    const { page, context } = await openPortal(browser, baseUrl, fx);
    assert.equal(await page.locator('#portalPreviewStrip').isHidden(), false);
    assert.equal(await page.locator('#portalTicketSubmit').isDisabled(), true);
    await context.close();
});

/* ── 096: الدعوات ومحوّل الشركات ───────────────────────────────────────── */

/**
 * كل إجراء ناجح يعيد تحميل الصفحة من القاعدة، فيضيع سجل النداءات في window.
 * نحفظه في sessionStorage قبل المغادرة ونقرؤه بعد التحميل.
 */
async function rpcArgsAcrossReload(page, name, action) {
    await page.evaluate(() => addEventListener('beforeunload', () =>
        sessionStorage.setItem('__rpc', JSON.stringify(window.__RPC_ARGS__ || []))));
    await Promise.all([page.waitForEvent('load', { timeout: 10000 }), action()]);
    return page.evaluate(n => JSON.parse(sessionStorage.getItem('__rpc') || '[]')
        .filter(([x]) => x === n).map(([, a]) => a), name);
}

test('096: دعوة معلّقة تظهر حتى لمن ليس عميلًا بعد، والقبول يمر بالقاعدة', { skip: !chromiumPath }, async () => {
    const fx = fixtures({ portal: null });
    fx.rpc.my_company_invitations = [{ id: 'inv-1', company_name: 'شركة ب', expires_at: '2026-10-20T00:00:00Z' }];
    fx.rpc.company_invitation_respond = { accepted: true };
    const { page, context, errors } = await openPortal(browser, baseUrl, fx);
    assert.equal(await page.locator('#invitations').isHidden(), false);
    assert.match(await page.locator('#portalInvitationList').textContent(), /شركة ب/);
    const args = await rpcArgsAcrossReload(page, 'company_invitation_respond',
        () => page.locator('[data-invitation="inv-1"][data-accept="true"]').click());
    assert.deepEqual(args, [{ p_invitation: 'inv-1', p_accept: true }]);
    assert.equal(errors.length, 0, errors.join(' | '));
    await context.close();
});

test('096: بلا دعوات ولا ميزة: لا لوحة دعوات ولا محوّل (كما قبل 096)', { skip: !chromiumPath }, async () => {
    const fx = fixtures({ portal: { company: { id: 'c1', name: 'شركة النور' }, preview: false } });
    const { page, context } = await openPortal(browser, baseUrl, fx);
    assert.equal(await page.locator('#invitations').isHidden(), true);
    assert.equal(await page.locator('#portalCompanies').isHidden(), true);
    await context.close();
});

test('096: عميل في شركتين: المحوّل يبدّل عبر القاعدة، والأساسية معلَّمة', { skip: !chromiumPath }, async () => {
    const fx = fixtures({ portal: {
        company: { id: 'c1', name: 'شركة النور' }, preview: false, multi_company: true, pending_invitations: 0,
        memberships: [{ company_id: 'c1', name: 'شركة النور', is_primary: true, is_current: true },
                      { company_id: 'c2', name: 'شركة الأفق', is_primary: false, is_current: false }] } });
    fx.rpc.my_company_invitations = [];
    fx.rpc.enter_customer_company = { company_id: 'c2' };
    const { page, context } = await openPortal(browser, baseUrl, fx);
    assert.equal(await page.locator('#portalCompanies').isHidden(), false);
    assert.equal(await page.locator('#portalPrimaryTag').isHidden(), false);
    assert.equal(await page.locator('#portalSetPrimary').isHidden(), true, 'تعيين أساسية مع وجود أساسية');
    assert.equal(await page.locator('#portalCompanySwitch option').count(), 2);
    const args = await rpcArgsAcrossReload(page, 'enter_customer_company',
        () => page.locator('#portalCompanySwitch').selectOption('c2'));
    assert.deepEqual(args, [{ p_company: 'c2' }]);
    await context.close();
});

test('096: بلا أساسية بعد المغادرة: زر تعيين الحالية أساسية', { skip: !chromiumPath }, async () => {
    const fx = fixtures({ portal: {
        company: { id: 'c2', name: 'شركة الأفق' }, preview: false, multi_company: true, pending_invitations: 0,
        memberships: [{ company_id: 'c2', name: 'شركة الأفق', is_primary: false, is_current: true }] } });
    fx.rpc.my_company_invitations = [];
    const { page, context } = await openPortal(browser, baseUrl, fx);
    assert.equal(await page.locator('#portalSetPrimary').isHidden(), false);
    assert.equal(await page.locator('#portalCompanySwitch').isDisabled(), true, 'شركة واحدة: لا تبديل');
    await context.close();
});

test('097: البوابة لا تعرض تذاكر العميل مع مدعوم ولا مع شركاته الأخرى', { skip: !chromiumPath }, async () => {
    const base = { user_id: USER_ID, archived_by_customer: false, status: 'open', description: 'تفاصيل',
                   created_at: '2026-10-01T10:00:00Z', last_updated_at: '2026-10-02T10:00:00Z' };
    const fx = fixtures({
        portal: { company: { id: 'c1', name: 'شركة النور' }, preview: false },
        tickets: [
            { ...base, id: 't1', ticket_number: 1, title: 'تذكرة النور', scope: 'company', company_id: 'c1' },
            { ...base, id: 't2', ticket_number: 2, title: 'تجديد اشتراكي الشخصي', scope: 'mad3oom_support', company_id: null },
            { ...base, id: 't3', ticket_number: 3, title: 'تذكرة الأفق', scope: 'company', company_id: 'c2' }
        ]
    });
    const { page, context } = await openPortal(browser, baseUrl, fx);
    const text = await page.locator('#portalTickets').textContent();
    assert.match(text, /تذكرة النور/);
    assert.doesNotMatch(text, /تجديد اشتراكي الشخصي|تذكرة الأفق/);
    await context.close();
});
