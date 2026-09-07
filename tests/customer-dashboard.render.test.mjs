/**
 * اختبارات عرض لوحة العميل — تشغّل الصفحة الحقيقية في متصفح Chromium فعلي
 * مقابل بديل اختباري لـ Supabase/auth، فتتنفّذ كل وحدات الرسم الحقيقية
 * (customer-dashboard.js وما تستورده) بدون أي اتصال بقاعدة بيانات.
 *
 * كل اختبار هنا يثبّت سلوكًا طلبه التكامل مع لوحة الإدارة، بحيث أي تعديل
 * لاحق يفصل اللوحتين عن بعض يفشل هنا.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = path.resolve(import.meta.dirname, '..');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon'
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
const TICKET_1 = 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa';
const TICKET_2 = 'bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb';
const TICKET_3 = 'cccccccc-3333-4ccc-8ccc-cccccccccccc';

/** إعدادات المنصة كما ترجّعها get_customer_platform_settings(). */
function platformSettings(overrides = {}) {
    return {
        customer_experience: {
            welcome_message: 'أهلاً بك في مدعوم، فريقنا معك.',
            enable_rewards_system: true,
            allow_ticket_attachments: true,
            allow_ticket_rating: true,
            show_support_online_status: true,
            support_whatsapp: '201234567890',
            ...(overrides.customer_experience || {})
        },
        sla: { enabled: true, high_hours: 1, medium_hours: 2, low_hours: 4, ...(overrides.sla || {}) },
        limits: { max_open_tickets: 5, prevent_duplicate_tickets: true, ticket_retention_days: 365, ...(overrides.limits || {}) },
        branding: { site_name: 'مدعوم', primary_color: '#0077CC' },
        support: {
            working_hours: Array.from({ length: 7 }, (_, d) => ({
                day_of_week: d, is_working_day: d !== 5, start_time: '09:00:00', end_time: '17:00:00'
            })),
            is_online_now: true,
            ...(overrides.support || {})
        }
    };
}

function fixtures(overrides = {}) {
    const settings = platformSettings(overrides.settings || {});
    return {
        user: { id: USER_ID, email: 'client@example.com' },
        authUser: {
            id: USER_ID,
            email: 'client@example.com',
            profile: { id: USER_ID, full_name: 'عميل تجريبي', role: 'user' }
        },
        rpc: {
            get_customer_platform_settings: settings,
            evaluate_customer_badges: null
        },
        tables: {
            profiles: [{
                id: USER_ID, email: 'client@example.com', full_name: 'عميل تجريبي', phone: '0100000000',
                role: 'user', created_at: '2026-01-01T00:00:00Z', is_verified: true, points: 120,
                ban_status: 'active', whatsapp_enabled: true, two_factor_enabled: false,
                telegram_otp_enabled: false, last_password_change: '2026-06-01T00:00:00Z'
            }],
            tickets: [
                {
                    id: TICKET_1, user_id: USER_ID, ticket_number: 101, title: 'مشكلة في تسجيل الدخول',
                    description: 'لا أستطيع الدخول من الموبايل', status: 'open', priority: 'high',
                    category: 'login', created_at: '2026-09-01T09:00:00Z',
                    last_updated_at: '2026-09-03T09:00:00Z',
                    last_updated_by: 'admin-id', archived_by_customer: false,
                    sla_response_due_at: '2026-09-04T09:00:00Z', first_response_at: null
                },
                {
                    id: TICKET_2, user_id: USER_ID, ticket_number: 102, title: 'استفسار عن الفاتورة',
                    description: 'أريد نسخة من فاتورة أغسطس', status: 'resolved', priority: 'medium',
                    category: 'subscription', created_at: '2026-08-01T09:00:00Z',
                    last_updated_at: '2026-08-02T09:00:00Z',
                    resolved_at: '2026-08-02T09:00:00Z', last_updated_by: USER_ID,
                    archived_by_customer: false, first_response_at: '2026-08-01T11:00:00Z'
                },
                {
                    id: TICKET_3, user_id: USER_ID, ticket_number: 103, title: 'طلب شراء باقة',
                    description: 'تم تأكيد الطلب', status: 'confirmed', priority: 'low',
                    category: 'subscription', created_at: '2026-07-01T09:00:00Z',
                    last_updated_at: '2026-07-02T09:00:00Z', last_updated_by: 'admin-id',
                    archived_by_customer: false, first_response_at: '2026-07-01T10:00:00Z'
                }
            ],
            ticket_replies: [{
                id: 'r1', ticket_id: TICKET_1, user_id: 'admin-id', message: 'راجعنا المشكلة ونحتاج رقم الجهاز',
                created_at: '2026-09-01T10:00:00Z', is_internal: false,
                profiles: { full_name: 'فريق الدعم', role: 'admin' }
            }],
            ticket_activity: [
                { id: 'a1', ticket_id: TICKET_1, action_type: 'create', created_at: '2026-09-01T09:00:00Z' },
                { id: 'a2', ticket_id: TICKET_1, action_type: 'status_change', to_value: 'open', created_at: '2026-09-01T09:05:00Z' }
            ],
            ticket_attachments: [],
            ticket_tag_links: [],
            ticket_ratings: [],
            notifications: [
                {
                    // الشكل الكامل بعد migrations/015: الإجراء بيانات على الصف
                    id: 'n1', user_id: USER_ID, title: 'رد جديد على تذكرتك',
                    message: 'فريق الدعم رد على التذكرة #101', is_read: false,
                    type: 'info', created_at: '2026-09-01T10:01:00Z', category: 'tickets',
                    // نفس شكل الرابط المخزَّن فعلاً في الإنتاج (بنية الروابط العميقة باقية)
                    link: `customer-dashboard.html?ticket=${TICKET_1}`,
                    reference_id: TICKET_1, action: 'open_ticket', action_target: TICKET_1,
                    action_label: null
                },
                {
                    // إشعار بلا وجهة: يفتح تفاصيله، ومن غير زر إجراء وهمي
                    id: 'n2', user_id: USER_ID, title: 'تم حل تذكرتك',
                    message: 'التذكرة #102 تم حلها', is_read: true, type: 'success',
                    created_at: '2026-08-02T09:00:00Z', category: 'tickets', link: null,
                    reference_id: null, action: 'none', action_target: null, action_label: null
                },
                {
                    // صف قديم بلا أعمدة إجراء: الاشتقاق من الرابط لازم يفضل شغّال
                    id: 'n3', user_id: USER_ID, title: 'رصيد الواتساب منخفض',
                    message: 'الرصيد الحالي 12 EGP', is_read: false, type: 'warning',
                    created_at: '2026-09-02T09:00:00Z', category: 'billing',
                    link: '/customer-dashboard.html#usage'
                }
            ],
            services: [
                { id: 's1', name: 'API الرئيسية', status: 'operational', response_time: 45 },
                { id: 's2', name: 'خدمة الإشعارات', status: 'degraded', response_time: 450 }
            ],
            incidents: [],
            activity_logs: [
                { id: 'l1', user_id: USER_ID, action: 'login', created_at: '2026-09-04T08:00:00Z', device_info: 'Chrome' },
                { id: 'l2', user_id: USER_ID, action: 'ticket_create', created_at: '2026-09-01T09:00:00Z' },
                // حدث إداري: لازم يتحجب حتى لو وصل في صفوف العميل
                { id: 'l3', user_id: USER_ID, action: 'impersonate', created_at: '2026-09-03T08:00:00Z', details: { admin: 'x' } }
            ],
            badge_definitions: [
                { id: 'b1', key: 'first_ticket', name: 'أول تذكرة', description: 'فتحت أول تذكرة', icon: '🎫', is_active: true, sort_order: 10 },
                { id: 'b2', key: 'active_user', name: 'المستخدم النشط', description: '10 تذاكر', icon: '⚡', is_active: true, sort_order: 20 }
            ],
            customer_badges: [{ id: 'cb1', user_id: USER_ID, badge_id: 'b1', earned_at: '2026-09-01T09:00:00Z' }],
            customer_subscriptions: [],
            subscription_plans: [],
            plan_features: [],
            feature_flags: [{ key: 'api_tokens', name: 'API Access', name_ar: 'مفاتيح API', description: '' }],
            whatsapp_subscriptions: [],
            whatsapp_wallets: [{ id: 'w1', user_id: USER_ID, balance: 12, currency: 'EGP', low_balance_threshold: 20, updated_at: '2026-09-01T00:00:00Z' }],
            whatsapp_wallet_transactions: [],
            customer_sie_access: [{ user_id: USER_ID, is_enabled: true, access_mode: 'quota', message_quota: 100, messages_used: 95, expires_at: null }],
            subdomain_requests: [],
            api_tokens: [],
            api_token_usage_logs: [],
            user_wallets: [{ user_id: USER_ID, total_points: 120, available_points: 100, pending_points: 20, membership_level: 'عضو نشط', is_pro: false }],
            user_reports: [],
            trusted_devices: []
        },
        ...(overrides.extra || {})
    };
}

/** يفتح اللوحة في متصفح حقيقي مع اعتراض وحدات Supabase/auth واستبدالها بالبدائل. */
async function openDashboard(browser, baseUrl, fx, { hash = '', search = '' } = {}) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();

    const doubleSupabase = fs.readFileSync(path.join(ROOT, 'tests/fixtures/supabase-double.js'), 'utf8');
    const doubleAuth = fs.readFileSync(path.join(ROOT, 'tests/fixtures/auth-client-double.js'), 'utf8');

    await page.route('**/api-config.js', route =>
        route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: doubleSupabase }));
    await page.route('**/auth-client.js', route =>
        route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: doubleAuth }));
    // وحدات ثقيلة وغير متعلقة بما نختبره
    await page.route('**/chat-widget.js', r => r.fulfill({ contentType: 'text/javascript', body: 'export default {};' }));
    await page.route('**/robot.js', r => r.fulfill({ contentType: 'text/javascript', body: 'export default {};' }));
    await page.route('**/ads-ticker.js', r => r.fulfill({ contentType: 'text/javascript', body: 'export default {};' }));
    await page.route('**/error-tracker.js', r => r.fulfill({ contentType: 'text/javascript', body: '' }));
    await page.route('**/chat-service.js', r => r.fulfill({ contentType: 'text/javascript', body: '' }));
    await page.route('https://fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));

    await page.addInitScript(data => { window.__FIXTURES__ = data; }, fx);

    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto(`${baseUrl}/customer-dashboard.html${search}${hash}`, { waitUntil: 'networkidle' });
    // القائمة الجانبية تُحقن بعد fetch، وبعدها بيبدأ الرسم — ننتظرها كإشارة
    // على اكتمال التهيئة، مش عنصرًا في قسم بعينه (الأقسام غير النشطة مخفية).
    await page.waitForSelector('.sidebar-item[data-tab="tickets"]', { timeout: 10000 });
    await page.waitForFunction(
        () => document.querySelector('#overviewKpis .kpi-value')?.textContent.trim() !== '',
        null,
        { timeout: 10000 }
    );
    await page.waitForFunction(
        () => (document.getElementById('healthHeadline')?.textContent || '').indexOf('جاري') === -1,
        null,
        { timeout: 10000 }
    );
    return { page, context, errors };
}

/**
 * يحدّد مسار Chromium: التنزيل الافتراضي لـPlaywright أولاً، ثم
 * PLAYWRIGHT_BROWSERS_PATH، وإلا نتخطى الاختبارات بصوت عالٍ (زي
 * run-sql-tests.sh) بدل ما ندّعي نجاحها على جهاز من غير متصفح.
 */
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

let server, baseUrl, browser;
const chromiumPath = resolveChromium();

if (!chromiumPath) {
    console.error('SKIP: لا يوجد متصفح Chromium متاح؛ اختبارات عرض لوحة العميل لم تُنفَّذ');
}

test.before(async (t) => {
    if (!chromiumPath) return;
    server = await startServer();
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: chromiumPath });
});

test.after(async () => {
    await browser?.close();
    server?.close();
});


/* ============================ التحميل الأساسي ============================ */

test('البوابة تُحمَّل بلا أخطاء وتعرض رسالة الترحيب التي يضبطها الأدمن', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openDashboard(browser, baseUrl, fixtures());
    assert.equal((await page.textContent('#overviewWelcomeMessage')).trim(), 'أهلاً بك في مدعوم، فريقنا معك.');
    assert.match(await page.textContent('#overviewHeading'), /عميل تجريبي/);
    assert.deepEqual(errors, [], `أخطاء في الصفحة: ${errors.join(' | ')}`);
    await context.close();
});

/* ==================== 1) القائمة الجانبية القابلة للطي ==================== */

test('القائمة تُطوى وتُفتح، وعرض المحتوى يتبعها', { skip: !chromiumPath }, async () => {
    const { page, context } = await openDashboard(browser, baseUrl, fixtures());

    const widths = async () => page.evaluate(() => ({
        sidebar: Math.round(document.getElementById('sidebar').getBoundingClientRect().width),
        mainMargin: getComputedStyle(document.querySelector('.admin-main')).marginRight,
        collapsed: document.documentElement.getAttribute('data-sidebar') === 'collapsed'
    }));

    const expanded = await widths();
    assert.equal(expanded.collapsed, false);
    assert.equal(expanded.sidebar, 290);
    assert.equal(expanded.mainMargin, '290px');

    await page.click('#sidebarCollapseBtn');
    await page.waitForFunction(() => document.documentElement.getAttribute('data-sidebar') === 'collapsed');
    await page.waitForTimeout(320);

    const collapsed = await widths();
    assert.equal(collapsed.collapsed, true);
    assert.equal(collapsed.sidebar, 74);
    assert.equal(collapsed.mainMargin, '74px');

    await page.click('#sidebarCollapseBtn');
    await page.waitForFunction(() => document.documentElement.getAttribute('data-sidebar') !== 'collapsed');
    await context.close();
});

test('في الوضع المطوي تختفي الأسماء وتبقى الأيقونات مع تلميح', { skip: !chromiumPath }, async () => {
    const { page, context } = await openDashboard(browser, baseUrl, fixtures());
    await page.click('#sidebarCollapseBtn');
    await page.waitForTimeout(320);

    const item = page.locator('.sidebar-item[data-tab="tickets"]');
    // الأيقونة ظاهرة
    assert.equal(await item.locator('svg').isVisible(), true);
    // الاسم مخفي بصرياً لكن باقٍ لقارئ الشاشة
    const labelBox = await item.locator('span:not(.nav-count)').first().boundingBox();
    assert.ok(!labelBox || labelBox.width <= 1, 'اسم القسم ما زال مرئياً في الوضع المطوي');
    assert.match(await item.textContent(), /تذاكري/, 'الاسم اختفى من DOM بدل ما يتخفى بصرياً');
    // التلميح جاهز من data-label
    assert.equal(await item.getAttribute('data-label'), 'تذاكري');
    await context.close();
});

test('حالة الطي تُحفظ وتُطبَّق قبل أول رسم بعد إعادة التحميل', { skip: !chromiumPath }, async () => {
    const { page, context } = await openDashboard(browser, baseUrl, fixtures());
    await page.click('#sidebarCollapseBtn');
    await page.waitForFunction(() => document.documentElement.getAttribute('data-sidebar') === 'collapsed');

    assert.equal(await page.evaluate(() => localStorage.getItem('mad3oom-sidebar-collapsed')), '1');

    await page.reload({ waitUntil: 'domcontentloaded' });
    // مطويّة فوراً — قبل ما القائمة نفسها تُجلب من الشبكة
    assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-sidebar')), 'collapsed');
    await context.close();
});

test('زر الطي لا يظهر على الموبايل ولا يؤثر على الدرج', { skip: !chromiumPath }, async () => {
    const { page, context } = await openDashboard(browser, baseUrl, fixtures());
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(150);

    assert.equal(await page.locator('#sidebarCollapseBtn').isVisible(), false);
    // الدرج ما زال مخفياً حتى مع تفعيل الطي
    assert.notEqual(await page.evaluate(() => getComputedStyle(document.getElementById('sidebar')).right), '0px');
    await context.close();
});

/* ==================== 2) الوضع الليلي والنهاري ==================== */

/** يقرأ ألوان العناصر التي شكا منها التقرير في كلا الوضعين. */
async function themeProbe(page) {
    return page.evaluate(() => {
        const rgb = (el, prop) => el ? getComputedStyle(el)[prop] : null;
        const parse = (c) => {
            const v = String(c || '').trim();
            const hex = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
            if (hex) {
                const h = hex[1].length === 3 ? hex[1].split('').map(x => x + x).join('') : hex[1];
                return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
            }
            return v.match(/[\d.]+/g)?.map(Number) || [];
        };
        const lum = (c) => {
            const [r, g, b] = parse(c);
            if (r === undefined) return null;
            const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
            return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
        };
        const contrast = (a, b) => {
            const la = lum(a), lb = lum(b);
            if (la === null || lb === null) return null;
            return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
        };
        const bodyBg = rgb(document.body, 'backgroundColor');
        const pageBg = getComputedStyle(document.documentElement).getPropertyValue('--color-background').trim();
        return {
            theme: document.documentElement.getAttribute('data-theme'),
            pageBg,
            bodyText: rgb(document.body, 'color'),
            sidebarBg: rgb(document.getElementById('sidebar'), 'backgroundColor'),
            sidebarItemColor: rgb(document.querySelector('.sidebar-item'), 'color'),
            panelText: rgb(document.querySelector('.panel-title'), 'color'),
            inputBg: rgb(document.querySelector('.form-control, .search-input'), 'backgroundColor'),
            inputText: rgb(document.querySelector('.form-control, .search-input'), 'color'),
            kpiValue: rgb(document.querySelector('.kpi-value'), 'color'),
            secondaryText: rgb(document.querySelector('.panel-subtitle'), 'color'),
            // التباين الذي يقرر إن كان النص مقروءًا فوق خلفيته
            sidebarContrast: contrast(rgb(document.getElementById('sidebar'), 'backgroundColor'),
                                      rgb(document.querySelector('.sidebar-item'), 'color')),
            bodyContrast: contrast(bodyBg === 'rgba(0, 0, 0, 0)' ? pageBg : bodyBg, rgb(document.body, 'color'))
        };
    });
}

test('تبديل الثيم يغيّر الألوان فعلياً (كان الوضع الليلي مفروضاً دائماً)', { skip: !chromiumPath }, async () => {
    const { page, context } = await openDashboard(browser, baseUrl, fixtures());

    await page.evaluate(() => { document.documentElement.setAttribute('data-theme', 'dark'); });
    await page.waitForTimeout(450);   // أطول من مدة انتقال الثيم حتى تستقر الألوان
    const dark = await themeProbe(page);

    await page.evaluate(() => { document.documentElement.setAttribute('data-theme', 'light'); });
    await page.waitForTimeout(450);
    const light = await themeProbe(page);

    assert.notEqual(dark.pageBg, light.pageBg, 'خلفية الصفحة لم تتغيّر بين الوضعين');
    assert.notEqual(dark.bodyText, light.bodyText, 'لون النص لم يتغيّر');
    assert.notEqual(dark.sidebarBg, light.sidebarBg, 'خلفية القائمة الجانبية لم تتغيّر');
    assert.notEqual(dark.sidebarItemColor, light.sidebarItemColor, 'نص القائمة لم يتغيّر — كان أبيض ثابتاً');
    assert.notEqual(dark.inputBg, light.inputBg, 'خلفية الحقول لم تتغيّر');
    await context.close();
});

test('لا يوجد نص غير مقروء في أي من الوضعين', { skip: !chromiumPath }, async () => {
    const { page, context } = await openDashboard(browser, baseUrl, fixtures());

    for (const theme of ['dark', 'light']) {
        await page.evaluate((t) => { document.documentElement.setAttribute('data-theme', t); }, theme);
        await page.waitForTimeout(450);   // أطول من مدة انتقال الثيم
        const probe = await themeProbe(page);

        assert.ok(probe.bodyContrast >= 4.5,
            `تباين النص الأساسي ضعيف في ${theme}: ${probe.bodyContrast?.toFixed(2)}`);
        assert.ok(probe.sidebarContrast >= 4,
            `تباين نص القائمة ضعيف في ${theme}: ${probe.sidebarContrast?.toFixed(2)}`);
    }
    await context.close();
});

test('لا يبقى أي عنصر بلون الوضع الآخر بعد التبديل', { skip: !chromiumPath }, async () => {
    const { page, context } = await openDashboard(browser, baseUrl, fixtures());

    // في الوضع النهاري: ما ينفعش يفضل أي سطح أساسي بخلفية شبه سوداء
    await page.evaluate(() => { document.documentElement.setAttribute('data-theme', 'light'); });
    await page.waitForTimeout(450);

    const darkLeftovers = await page.evaluate(() => {
        const isDark = (c) => {
            const m = (c || '').match(/[\d.]+/g)?.map(Number);
            if (!m || m.length < 3) return false;
            if (m.length > 3 && m[3] < 0.5) return false;   // شفاف، يرث من الأب
            return (0.299 * m[0] + 0.587 * m[1] + 0.114 * m[2]) < 60;
        };
        const out = [];
        for (const sel of ['.panel', '.kpi', '.health-card', '.form-control', '.search-input',
                           '.ticket-card', '#sidebar', '.notif-item', '.action-card']) {
            for (const el of document.querySelectorAll(sel)) {
                const bg = getComputedStyle(el).backgroundColor;
                if (isDark(bg)) out.push(`${sel} => ${bg}`);
            }
        }
        return out.slice(0, 6);
    });
    assert.deepEqual(darkLeftovers, [], `عناصر محتفظة بخلفية داكنة في الوضع النهاري: ${darkLeftovers.join(', ')}`);
    await context.close();
});

test('تفضيل الثيم محفوظ ويُطبَّق قبل أول رسم بلا وميض', { skip: !chromiumPath }, async () => {
    const { page, context } = await openDashboard(browser, baseUrl, fixtures());
    await page.evaluate(() => localStorage.setItem('theme-preference', 'light'));

    // نلتقط حالة <html> عند أول فرصة ممكنة: كلاس منع الانتقال بيتشال في أول
    // إطار بعد DOMContentLoaded بحكم التصميم، فقراءته بعد التحميل سباق.
    await page.addInitScript(() => {
        document.addEventListener('readystatechange', () => {
            if (!window.__EARLY__) {
                window.__EARLY__ = {
                    theme: document.documentElement.getAttribute('data-theme'),
                    noTransition: document.documentElement.className.includes('no-transition')
                };
            }
        }, true);
    });

    await page.reload({ waitUntil: 'domcontentloaded' });
    const early = await page.evaluate(() => window.__EARLY__);
    assert.equal(early.theme, 'light', 'الثيم لم يُطبَّق قبل أول رسم');
    assert.equal(early.noTransition, true, 'منع وميض الانتقال غير مفعّل عند التحميل');

    // وبعد التحميل الانتقالات ترجع تشتغل
    await page.waitForFunction(() => !document.documentElement.className.includes('no-transition'));
    assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-theme')), 'light');
    await context.close();
});

/* ==================== 3) مركز التذاكر ==================== */

/* ============================ الشريط العلوي ============================ */

test('الشريط ثابت أثناء التمرير ولا يترك فجوة فوق القائمة', { skip: !chromiumPath }, async () => {
    const { page, context } = await openDashboard(browser, baseUrl, fixtures());

    const measure = () => page.evaluate(() => {
        const nav = document.querySelector('.admin-nav');
        const sb = document.getElementById('sidebar');
        const n = nav.getBoundingClientRect();
        const s = sb.getBoundingClientRect();
        return {
            navTop: Math.round(n.top), navBottom: Math.round(n.bottom),
            sbTop: Math.round(s.top), sbBottom: Math.round(s.bottom),
            vh: window.innerHeight, scrollY: Math.round(window.scrollY)
        };
    });

    const top = await measure();
    assert.equal(top.navTop, 0, 'الشريط لا يبدأ من أعلى النافذة');
    assert.equal(top.sbTop, top.navBottom, 'فجوة بين الشريط والقائمة');
    assert.equal(top.sbBottom, top.vh, 'القائمة لا تصل لأسفل النافذة');

    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(250);

    const bottom = await measure();
    assert.ok(bottom.scrollY > 0, 'الصفحة لم تتمرّر فالاختبار بلا معنى');
    // ده بالظبط العطل اللي كان: الشريط بيروح مع التمرير وتفضل شريحة فاضية
    assert.equal(bottom.navTop, 0, 'الشريط اختفى مع التمرير');
    assert.equal(bottom.sbTop, bottom.navBottom, 'فجوة فوق القائمة بعد التمرير');
    assert.equal(bottom.sbBottom, bottom.vh, 'فجوة أسفل القائمة بعد التمرير');
    await context.close();
});

test('القائمة الطويلة تمرَّر داخلياً بدل أن تمتد خارج الشاشة', { skip: !chromiumPath }, async () => {
    const { page, context } = await openDashboard(browser, baseUrl, fixtures());
    // شاشة قصيرة: عناصر القائمة أطول منها حتماً
    await page.setViewportSize({ width: 1440, height: 520 });
    await page.waitForTimeout(300);

    const r = await page.evaluate(() => {
        const sb = document.getElementById('sidebar');
        const menu = sb.querySelector('.sidebar-menu');
        return {
            sbBottom: Math.round(sb.getBoundingClientRect().bottom),
            vh: window.innerHeight,
            menuOverflow: getComputedStyle(menu).overflowY,
            menuScrollable: menu.scrollHeight > menu.clientHeight
        };
    });

    assert.equal(r.sbBottom, r.vh, 'القائمة تجاوزت أسفل الشاشة');
    assert.equal(r.menuOverflow, 'auto', 'محتوى القائمة بلا تمرير داخلي');
    assert.ok(r.menuScrollable, 'المحتوى ليس أطول من الشاشة فالاختبار بلا معنى');
    await context.close();
});

test('المحتوى يملأ المساحة جنب القائمة في الحالتين', { skip: !chromiumPath }, async () => {
    // الاتجاه المعاكس للتمرير الأفقي: محتوى أضيق من اللازم. حصل فعلاً لما
    // ضُبط width:auto مع margin:0 auto الموروث — الهوامش التلقائية بتعطّل
    // تمدّد عنصر الـflex فينكمش لعرض محتواه ويتوسّط.
    for (const collapsed of [false, true]) {
        const { page, context } = await openDashboard(browser, baseUrl, fixtures());
        await page.evaluate(c => {
            document.documentElement.setAttribute('data-sidebar', c ? 'collapsed' : 'expanded');
        }, collapsed);
        await page.waitForTimeout(400);

        const r = await page.evaluate(() => {
            const main = document.querySelector('.admin-main').getBoundingClientRect();
            const sb = document.getElementById('sidebar').getBoundingClientRect();
            return { mainW: main.width, sbW: sb.width, vw: window.innerWidth };
        });

        const available = r.vw - r.sbW;
        assert.ok(r.mainW >= available - 40,
            `المحتوى ${Math.round(r.mainW)}px بينما المتاح ${Math.round(available)}px (collapsed=${collapsed})`);
        assert.ok(r.mainW <= available + 1,
            `المحتوى تجاوز المساحة المتاحة (collapsed=${collapsed})`);
        await context.close();
    }
});

test('الشعار هو نفسه المستخدم في صفحة الدخول', { skip: !chromiumPath }, async () => {
    const { page, context } = await openDashboard(browser, baseUrl, fixtures());

    const src = await page.getAttribute('.portal-brand-logo', 'src');
    assert.equal(src, '/logo.png', 'شعار مختلف عن شعار صفحة الدخول');

    // نفس الملف اللي بتستعمله login.html فعلاً
    const loginLogo = fs.readFileSync(path.join(ROOT, 'login.html'), 'utf8')
        .match(/class="card-logo-img" src="([^"]+)"/)?.[1];
    assert.equal(src, loginLogo, 'الشعار لا يطابق ما تستخدمه صفحة الدخول');

    // وبيتحمّل فعلاً بأبعاد حقيقية (مش أيقونة مكسورة)
    const loaded = await page.evaluate(() => {
        const img = document.querySelector('.portal-brand-logo');
        return { w: img.naturalWidth, h: img.naturalHeight };
    });
    assert.ok(loaded.w > 0 && loaded.h > 0, 'الشعار لم يُحمَّل');
    await context.close();
});

test('حالة النظام في الشريط حقيقية لا نص ثابت', { skip: !chromiumPath }, async () => {
    // الحالة الافتراضية في الـfixtures فيها خدمة متدهورة
    const { page, context } = await openDashboard(browser, baseUrl, fixtures());
    await page.waitForSelector('#portalSystemStatus:not([hidden])');
    const text = await page.textContent('#portalSystemStatusText');
    assert.match(text, /أداء منخفض/, `النص "${text}" لا يعكس الحالة الفعلية`);
    assert.ok(!text.includes('النظام شغال'), 'ما زال النص الثابت القديم معروضاً');
    await context.close();

    // كل الخدمات تعمل → النص يتغيّر
    const fx = fixtures();
    fx.tables.services = fx.tables.services.map(s => ({ ...s, status: 'operational' }));
    const second = await openDashboard(browser, baseUrl, fx);
    await second.page.waitForSelector('#portalSystemStatus:not([hidden])');
    assert.match(await second.page.textContent('#portalSystemStatusText'), /كل الخدمات تعمل/);
    await second.context.close();
});

test('قائمة الحساب تفتح وتعرض الاسم والبريد وروابطها تعمل', { skip: !chromiumPath }, async () => {
    const { page, context } = await openDashboard(browser, baseUrl, fixtures());

    assert.ok(await page.isHidden('#customerAvatarMenu'), 'القائمة مفتوحة قبل الضغط');
    await page.click('#customerAvatarBtn');
    await page.waitForSelector('#customerAvatarMenu:not([hidden])');

    assert.equal(await page.getAttribute('#customerAvatarBtn', 'aria-expanded'), 'true');
    assert.match(await page.textContent('#customerMenuName'), /عميل تجريبي/);
    assert.match(await page.textContent('#customerMenuEmail'), /client@example.com/);

    const items = await page.$$eval('#customerAvatarMenu .portal-menu-item span',
        els => els.map(e => e.textContent.trim()));
    for (const expected of ['الملف الشخصي', 'الأمان', 'تسجيل الخروج']) {
        assert.ok(items.includes(expected), `عنصر "${expected}" غير موجود في قائمة الحساب`);
    }

    await page.click('#customerProfile');
    await page.waitForSelector('#profileTabContent.active');
    assert.ok(await page.isHidden('#customerAvatarMenu'), 'القائمة ظلّت مفتوحة بعد الاختيار');
    await context.close();
});

test('Escape يغلق القائمة المفتوحة، والضغط خارجها يغلقها', { skip: !chromiumPath }, async () => {
    const { page, context } = await openDashboard(browser, baseUrl, fixtures());

    await page.click('#customerAvatarBtn');
    await page.waitForSelector('#customerAvatarMenu:not([hidden])');
    await page.keyboard.press('Escape');
    assert.ok(await page.isHidden('#customerAvatarMenu'), 'Escape لم يغلق القائمة');

    await page.click('#customerAvatarBtn');
    await page.waitForSelector('#customerAvatarMenu:not([hidden])');
    await page.click('#overviewHeading');
    assert.ok(await page.isHidden('#customerAvatarMenu'), 'الضغط خارج القائمة لم يغلقها');
    await context.close();
});

test('القوائم المنسدلة تبقى داخل الشاشة في الاتجاهين وكل المقاسات', { skip: !chromiumPath }, async () => {
    // الاتجاه مش مضمون: language-manager بيضبطه من لغة المتصفح، فصفحة عربية
    // ممكن تترسم ltr على متصفح إنجليزي. القائمة لازم تفضل داخل الشاشة في
    // الحالتين — وده بالظبط اللي كان مكسورًا (كانت بتفتح لبرّه الشاشة).
    for (const dir of ['rtl', 'ltr']) {
        for (const width of [1440, 1024, 768, 414, 360]) {
            const { page, context } = await openDashboard(browser, baseUrl, fixtures());
            await page.setViewportSize({ width, height: 900 });
            await page.evaluate(d => {
                document.documentElement.setAttribute('dir', d);
                document.body.setAttribute('dir', d);
            }, dir);
            await page.waitForTimeout(200);

            await page.click('#customerAvatarBtn');
            await page.waitForSelector('#customerAvatarMenu:not([hidden])');

            const r = await page.evaluate(() => {
                const m = document.getElementById('customerAvatarMenu').getBoundingClientRect();
                return { left: m.left, right: m.right, vw: window.innerWidth };
            });
            assert.ok(r.right <= r.vw + 1, `القائمة تخرج يميناً عند ${width}px/${dir} (right=${r.right})`);
            assert.ok(r.left >= -1, `القائمة تخرج يساراً عند ${width}px/${dir} (left=${r.left})`);
            await context.close();
        }
    }
});

test('فتح قائمة يغلق الأخرى فلا تتراكب قائمتان', { skip: !chromiumPath }, async () => {
    const { page, context } = await openDashboard(browser, baseUrl, fixtures());

    await page.click('#languageToggleBtn');
    await page.waitForSelector('#languageMenu:not([hidden])');
    await page.click('#customerAvatarBtn');
    await page.waitForSelector('#customerAvatarMenu:not([hidden])');

    assert.ok(await page.isHidden('#languageMenu'), 'قائمتان مفتوحتان في نفس الوقت');
    assert.equal(await page.getAttribute('#languageToggleBtn', 'aria-expanded'), 'false');
    await context.close();
});

test('عناصر الشريط كلها لها تسمية للقارئ الصوتي', { skip: !chromiumPath }, async () => {
    const { page, context } = await openDashboard(browser, baseUrl, fixtures());

    const missing = await page.evaluate(() =>
        [...document.querySelectorAll('.admin-nav button')]
            .filter(b => !b.getAttribute('aria-label') && !b.textContent.trim())
            .map(b => b.id || b.className));

    assert.deepEqual(missing, [], `أزرار بلا تسمية: ${missing.join(', ')}`);
    await context.close();
});

test('شارة الإشعارات تعرض العدد وتنعكس في التسمية', { skip: !chromiumPath }, async () => {
    const { page, context } = await openDashboard(browser, baseUrl, fixtures());
    await page.waitForSelector('#notificationBadge:not([hidden])');

    assert.equal((await page.textContent('#notificationBadge')).trim(), '2');
    assert.match(await page.getAttribute('#notificationBtn', 'aria-label'), /2 غير مقروء/);
    await context.close();
});

test('على الموبايل: أيقونة بحث تفتح طبقة، ولا يظهر مربع البحث في الشريط', { skip: !chromiumPath }, async () => {
    const { page, context } = await openDashboard(browser, baseUrl, fixtures());
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);

    assert.ok(await page.isVisible('#portalSearchTrigger'), 'أيقونة البحث غير ظاهرة على الموبايل');
    assert.ok(await page.isHidden('#globalSearchInput'), 'مربع البحث ظاهر ويزاحم الشريط');

    await page.click('#portalSearchTrigger');
    await page.waitForSelector('#globalSearchInput:visible');
    await page.click('#portalSearchClose');
    assert.ok(await page.isHidden('#globalSearchInput'), 'طبقة البحث لم تُغلق');
    await context.close();
});

test('على الديسكتوب: مربع البحث ظاهر بلا أيقونة مكرّرة', { skip: !chromiumPath }, async () => {
    const { page, context } = await openDashboard(browser, baseUrl, fixtures());
    assert.ok(await page.isVisible('#globalSearchInput'));
    assert.ok(await page.isHidden('#portalSearchTrigger'), 'أيقونة البحث مكرّرة بجوار المربع');
    await context.close();
});

test('مجموعات التذاكر تعرض الأعداد الصحيحة وتصفّي فعلياً', { skip: !chromiumPath }, async () => {
    const { page, context } = await openDashboard(browser, baseUrl, fixtures(), { hash: '#tickets' });
    await page.waitForSelector('.view-tab');

    const counts = await page.$$eval('.view-tab', els => els.map(e => ({
        view: e.dataset.view,
        count: Number(e.querySelector('.view-tab-count').textContent)
    })));
    const by = Object.fromEntries(counts.map(c => [c.view, c.count]));
    assert.equal(by.all, 3);
    assert.equal(by.open, 1);       // t1 فقط
    assert.equal(by.awaiting, 1);   // t1 آخر تحديث من الأدمن
    assert.equal(by.closed, 2);     // resolved + confirmed

    await page.click('.view-tab[data-view="closed"]');
    await page.waitForFunction(() => document.querySelectorAll('.ticket-card').length === 2);
    await context.close();
});

test('حالة confirmed تظهر للعميل بتسمية مفهومة (كانت غير محسوبة)', { skip: !chromiumPath }, async () => {
    const { page, context } = await openDashboard(browser, baseUrl, fixtures(), { hash: '#tickets' });
    await page.click('.view-tab[data-view="closed"]');
    await page.waitForSelector('.ticket-card');
    const text = await page.textContent('#userTicketsList');
    assert.match(text, /مكتملة/);
    assert.ok(!text.includes('confirmed'), 'ظهرت الحالة الداخلية الخام');
    await context.close();
});

test('البحث والترتيب داخل التذاكر يعملان', { skip: !chromiumPath }, async () => {
    const { page, context } = await openDashboard(browser, baseUrl, fixtures(), { hash: '#tickets' });
    await page.waitForSelector('.ticket-card');

    await page.fill('#ticketSearchInput', 'الفاتورة');
    await page.waitForFunction(() => document.querySelectorAll('.ticket-card').length === 1);
    assert.match(await page.textContent('#userTicketsList'), /استفسار عن الفاتورة/);

    await page.fill('#ticketSearchInput', '');
    await page.waitForFunction(() => document.querySelectorAll('.ticket-card').length === 3);

    await page.selectOption('#ticketSortSelect', 'oldest');
    await page.waitForTimeout(150);
    const firstNumber = await page.locator('.ticket-card .ticket-num').first().textContent();
    assert.equal(firstNumber.trim(), '#103', 'الترتيب بالأقدم لم يُطبَّق');
    await context.close();
});

test('تفاصيل التذكرة تعرض كل ما يحتاجه العميل', { skip: !chromiumPath }, async () => {
    const { page, context } = await openDashboard(browser, baseUrl, fixtures(), { hash: '#tickets' });
    await page.click(`.ticket-card[data-id="${TICKET_1}"]`);
    await page.waitForSelector('.ticket-detail-title');

    const detail = await page.textContent('.ticket-details-scroll');
    assert.match(detail, /مشكلة في تسجيل الدخول/);   // العنوان
    assert.match(detail, /مفتوحة/);                   // الحالة
    assert.match(detail, /تسجيل دخول/);               // التصنيف
    assert.match(detail, /رقم التذكرة/);
    assert.match(detail, /آخر تحديث/);
    assert.match(detail, /هدف أول رد/);               // معلومات SLA
    assert.match(detail, /بانتظار ردّك/);
    assert.match(detail, /سجل التذكرة/);
    assert.match(detail, /راجعنا المشكلة/);           // الردود
    assert.equal(await page.locator('#panelReplyText').count(), 1);
    await context.close();
});

test('التذكرة المحلولة تعرض إعادة الفتح، والمرفوضة لا تعرض ردًا', { skip: !chromiumPath }, async () => {
    const fx = fixtures();
    const { page, context } = await openDashboard(browser, baseUrl, fx, { hash: '#tickets' });

    await page.click('.view-tab[data-view="closed"]');
    await page.waitForSelector('.ticket-card');
    await page.click(`.ticket-card[data-id="${TICKET_2}"]`);   // resolved
    await page.waitForSelector('.ticket-detail-title');
    assert.match(await page.textContent('#panelSendReply'), /إعادة فتح/);

    await page.click(`.ticket-card[data-id="${TICKET_3}"]`);   // confirmed
    await page.waitForSelector('.ticket-detail-title');
    assert.equal(await page.locator('#panelSendReply').count(), 0, 'التذكرة المكتملة عرضت مُنشئ ردّ');
    assert.match(await page.textContent('.ticket-details-scroll'), /هذه التذكرة مغلقة/);
    await context.close();
});

test('إعادة الفتح تطلب تأكيداً وتشرح الأثر', { skip: !chromiumPath }, async () => {
    const { page, context } = await openDashboard(browser, baseUrl, fixtures(), { hash: '#tickets' });
    await page.click('.view-tab[data-view="closed"]');
    await page.waitForSelector('.ticket-card');
    await page.click(`.ticket-card[data-id="${TICKET_2}"]`);
    await page.waitForSelector('#panelReplyText');

    await page.fill('#panelReplyText', 'المشكلة رجعت تاني');
    await page.click('#panelSendReply');
    await page.waitForSelector('.ui-dialog');
    assert.match(await page.textContent('.ui-dialog'), /سيعيدها لفريق الدعم/);
    await context.close();
});

/* ==================== 4) الإشعارات القابلة للتنفيذ ==================== */

test('الضغط على أيقونة الإشعارات يفتح الصفحة الكاملة (لا قائمة منسدلة)', { skip: !chromiumPath }, async () => {
    const { page, context } = await openDashboard(browser, baseUrl, fixtures());
    assert.equal(await page.locator('#notificationMenu').count(), 0, 'القائمة المنسدلة ما زالت موجودة');

    await page.click('#notificationBtn');
    await page.waitForSelector('#notificationsTabContent.active');
    await page.waitForSelector('.notif-item');
    await context.close();
});

test('الضغط على إشعار يفتح تفاصيله ولا ينقل تلقائياً', { skip: !chromiumPath }, async () => {
    const { page, context } = await openDashboard(browser, baseUrl, fixtures(), { hash: '#notifications' });
    await page.waitForSelector('.notif-item');

    await page.click('.notif-item[data-id="n1"]');
    await page.waitForSelector('#notificationModal.active');

    // التفاصيل كاملة داخل النافذة: العنوان والنص والتصنيف والوقت وحالة القراءة
    assert.match(await page.textContent('#notificationModalTitle'), /رد جديد على تذكرتك/);
    assert.match(await page.textContent('#notificationModalMessage'), /التذكرة #101/);
    assert.match(await page.textContent('#notificationModalCategory'), /التذاكر/);
    assert.ok((await page.textContent('#notificationModalTime')).trim().length > 4);

    // ولا انتقال تلقائي: العميل ما زال في قسم الإشعارات
    assert.ok(await page.isVisible('#notificationsTabContent.active'), 'حدث انتقال تلقائي غير مطلوب');
    assert.ok(!(await page.isVisible('#ticketsTabContent.active')), 'انتقل لقسم التذاكر بدون ضغط زر');
    await context.close();
});

test('زر الإجراء داخل النافذة هو وحده ما ينقل لوجهة الإشعار', { skip: !chromiumPath }, async () => {
    const { page, context } = await openDashboard(browser, baseUrl, fixtures(), { hash: '#notifications' });
    await page.waitForSelector('.notif-item');

    await page.click('.notif-item[data-id="n1"]');
    await page.waitForSelector('#notificationModal.active');

    const label = await page.textContent('#notificationModalAction');
    assert.match(label, /فتح التذكرة/);

    await page.click('#notificationModalAction');
    await page.waitForSelector('#ticketsTabContent.active');
    await page.waitForSelector('.ticket-detail-title');
    assert.match(await page.textContent('.ticket-detail-title'), /مشكلة في تسجيل الدخول/);

    // النافذة تُغلق بعد التنفيذ فلا تحجب الوجهة
    assert.ok(!(await page.isVisible('#notificationModal.active')), 'النافذة ظلت مفتوحة فوق الوجهة');
    await context.close();
});

test('إغلاق النافذة يعيد العميل لنفس المكان بلا انتقال', { skip: !chromiumPath }, async () => {
    const { page, context } = await openDashboard(browser, baseUrl, fixtures(), { hash: '#notifications' });
    await page.waitForSelector('.notif-item');

    await page.click('.notif-item[data-id="n1"]');
    await page.waitForSelector('#notificationModal.active');
    await page.click('#notificationModal .modal-close');

    assert.ok(!(await page.isVisible('#notificationModal.active')));
    assert.ok(await page.isVisible('#notificationsTabContent.active'), 'الإغلاق نقل العميل من مكانه');
    await context.close();
});

test('إشعار مرتبط بقسم: نافذة ثم زر ينقل للقسم', { skip: !chromiumPath }, async () => {
    const { page, context } = await openDashboard(browser, baseUrl, fixtures(), { hash: '#notifications' });
    await page.waitForSelector('.notif-item');

    // n3 صف قديم بلا أعمدة إجراء — الاشتقاق من الرابط لازم يفضل شغّال
    await page.click('.notif-item[data-id="n3"]');
    await page.waitForSelector('#notificationModal.active');
    assert.match(await page.textContent('#notificationModalAction'), /الاشتراك|الاستهلاك/);

    await page.click('#notificationModalAction');
    await page.waitForSelector('#usageTabContent.active');
    await context.close();
});

test('الإشعار بلا وجهة يعرض تفاصيله بدون زر إجراء وهمي', { skip: !chromiumPath }, async () => {
    const { page, context } = await openDashboard(browser, baseUrl, fixtures(), { hash: '#notifications' });
    await page.waitForSelector('.notif-item');

    // بلا وجهة لا يعني بلا محتوى: العميل لسه محتاج يقرا النص والتاريخ
    await page.click('.notif-item[data-id="n2"]');
    await page.waitForSelector('#notificationModal.active');
    assert.match(await page.textContent('#notificationModalMessage'), /التذكرة #102/);

    const actionVisible = await page.isVisible('#notificationModalAction');
    assert.ok(!actionVisible, 'ظهر زر إجراء لإشعار بلا وجهة');

    // ولا تلميح إجراء في القائمة نفسها
    const cta = await page.$('.notif-item[data-id="n2"] .notif-cta');
    assert.equal(cta, null, 'عُرض تلميح إجراء لإشعار بلا وجهة');
    await context.close();
});

test('كل إشعار يعرض التصنيف والوقت وحالة القراءة', { skip: !chromiumPath }, async () => {
    const { page, context } = await openDashboard(browser, baseUrl, fixtures(), { hash: '#notifications' });
    await page.waitForSelector('.notif-item');

    const first = page.locator('.notif-item[data-id="n1"]');
    assert.match(await first.textContent(), /التذاكر/);      // تسمية التصنيف
    assert.match(await first.textContent(), /فتح التذكرة/);   // نص الإجراء
    assert.match(await first.textContent(), /جديد/);          // غير مقروء
    assert.equal(await first.locator('.notif-icon').count(), 1);

    const billing = page.locator('.notif-item[data-id="n3"]');
    assert.match(await billing.textContent(), /الرصيد والفوترة/);
    await context.close();
});

test('التصفية حسب غير المقروء وحسب التصنيف تعمل', { skip: !chromiumPath }, async () => {
    const { page, context } = await openDashboard(browser, baseUrl, fixtures(), { hash: '#notifications' });
    await page.waitForSelector('.filter-chip');

    await page.click('.filter-chip[data-filter="unread"]');
    await page.waitForFunction(() => document.querySelectorAll('.notif-item').length === 2);

    await page.click('.filter-chip[data-filter="billing"]');
    await page.waitForFunction(() => document.querySelectorAll('.notif-item').length === 1);
    assert.match(await page.textContent('#notificationsList'), /رصيد الواتساب منخفض/);
    await context.close();
});

test('تحديد إشعار كمقروء لا يفتح وجهته', { skip: !chromiumPath }, async () => {
    const { page, context } = await openDashboard(browser, baseUrl, fixtures(), { hash: '#notifications' });
    await page.waitForSelector('.notif-item');
    await page.click('.notif-item[data-id="n1"] .notif-mark');
    await page.waitForFunction(() =>
        document.querySelector('.notif-item[data-id="n1"]')?.className.includes('is-unread') === false);
    assert.equal(await page.locator('#notificationsTabContent.active').count(), 1, 'انتقل لقسم آخر بدل ما يحدّد كمقروء فقط');
    await context.close();
});

/* ==================== 5) الرابط المباشر للتذكرة ==================== */

test('?ticket=<uuid> يفتح التذكرة مباشرة (كان يُتجاهل تماماً)', { skip: !chromiumPath }, async () => {
    const { page, context } = await openDashboard(browser, baseUrl, fixtures(), { search: `?ticket=${TICKET_2}` });
    await page.waitForSelector('#ticketsTabContent.active');
    await page.waitForSelector('.ticket-detail-title');
    assert.match(await page.textContent('.ticket-detail-title'), /استفسار عن الفاتورة/);
    await context.close();
});

/* ==================== 6) لوحة موجّهة للإجراء ==================== */

test('الحساب السليم يعرض حكماً واضحاً بدل قائمة بيانات', { skip: !chromiumPath }, async () => {
    const fx = fixtures();
    fx.tables.tickets = [];
    fx.tables.whatsapp_wallets = [];
    fx.tables.customer_sie_access = [];
    fx.tables.services = [{ id: 's1', name: 'API', status: 'operational' }];
    const { page, context } = await openDashboard(browser, baseUrl, fx);
    assert.equal(await page.getAttribute('#accountHealthCard', 'data-status'), 'healthy');
    assert.match(await page.textContent('#healthHeadline'), /بحالة جيدة/);
    await context.close();
});

test('وجود مشاكل يعرض عدد البنود وإجراء لكل بند', { skip: !chromiumPath }, async () => {
    const { page, context } = await openDashboard(browser, baseUrl, fixtures());
    assert.equal(await page.getAttribute('#accountHealthCard', 'data-status'), 'attention');
    assert.match(await page.textContent('#healthHeadline'), /تحتاج انتباهك|يحتاج انتباهك/);

    const actions = await page.locator('#healthItems .alert-action').count();
    assert.ok(actions >= 1, 'مفيش أي إجراء على بنود الحالة');

    await page.click('#healthItems .alert-action[data-goto="tickets"]');
    await page.waitForSelector('#ticketsTabContent.active');
    await context.close();
});

/* ==================== 7) الأقسام الجديدة ==================== */

test('مركز الدعم يجمع نقاط الدخول وحالة النظام وتوفّر الفريق', { skip: !chromiumPath }, async () => {
    const { page, context } = await openDashboard(browser, baseUrl, fixtures(), { hash: '#support' });
    await page.waitForSelector('#supportTabContent.active');
    await page.waitForSelector('#systemStatusBody .data-row');

    assert.ok(await page.locator('.action-card').count() >= 4);
    assert.match(await page.textContent('#supportAvailabilityBody'), /متاح الآن/);
    assert.match(await page.textContent('#supportAvailabilityBody'), /عالية: 1 س/);
    assert.match(await page.textContent('#systemStatusBody'), /خدمة الإشعارات/);
    await context.close();
});

test('قسم الاستهلاك يعرض الباقة والرصيد والحصة بمؤشرات', { skip: !chromiumPath }, async () => {
    const { page, context } = await openDashboard(browser, baseUrl, fixtures(), { hash: '#usage' });
    await page.waitForSelector('#usageTabContent.active');
    await page.waitForSelector('#usageBody .panel');

    const text = await page.textContent('#usageBody');
    assert.match(text, /رصيد الواتساب/);
    assert.match(text, /المحرك الذكي/);
    assert.match(text, /95 \/ 100/);
    assert.ok(await page.locator('#usageBody .meter-fill').count() >= 1, 'مفيش مؤشر استهلاك');
    await context.close();
});

test('قسم النشاط يخفي الأحداث الإدارية تماماً', { skip: !chromiumPath }, async () => {
    const { page, context } = await openDashboard(browser, baseUrl, fixtures(), { hash: '#activity' });
    await page.waitForSelector('#activityTabContent.active');
    await page.waitForSelector('#activityBody .activity-item');

    const text = await page.textContent('#activityBody');
    assert.match(text, /تسجيل دخول إلى حسابك/);
    assert.ok(!text.includes('impersonate'), 'حدث إداري ظهر للعميل');
    assert.ok(!/الدخول كعضو/.test(text), 'حدث انتحال ظهر للعميل');
    await context.close();
});

test('قسم الأمان يعرض الحماية وآخر الدخول ولا يكشف أسرار المفاتيح', { skip: !chromiumPath }, async () => {
    const fx = fixtures();
    fx.tables.api_tokens = [{
        id: 'k1', user_id: USER_ID, name: 'مفتاح التكامل', api_key: 'pk_live_FULLKEY',
        secret_hash: 'SECRETHASH', secret_last_four: '4821', is_active: true,
        created_at: '2026-05-01T00:00:00Z', last_used_at: '2026-09-01T00:00:00Z', usage_count: 12
    }];
    const { page, context } = await openDashboard(browser, baseUrl, fx, { hash: '#security' });
    await page.waitForSelector('#securityTabContent.active');
    await page.waitForSelector('#securityBody .panel');

    const text = await page.textContent('#securityBody');
    assert.match(text, /التحقق بخطوتين/);
    assert.match(text, /آخر عمليات الدخول/);
    assert.match(text, /••••4821/);
    assert.ok(!text.includes('SECRETHASH'), 'هاش السر ظهر في الواجهة');
    assert.ok(!text.includes('pk_live_FULLKEY'), 'المفتاح الكامل ظهر في الواجهة');
    await context.close();
});

/* ==================== 8) البحث الشامل ==================== */

test('البحث الشامل يرجع نتائج من التذاكر والأقسام ويفتحها', { skip: !chromiumPath }, async () => {
    const { page, context } = await openDashboard(browser, baseUrl, fixtures());

    await page.fill('#globalSearchInput', 'الفاتورة');
    await page.waitForSelector('#globalSearchResults .search-result');
    assert.match(await page.textContent('#globalSearchResults'), /استفسار عن الفاتورة/);

    await page.click('#globalSearchResults .search-result[data-kind="ticket"]');
    await page.waitForSelector('#ticketsTabContent.active');
    assert.match(await page.textContent('.ticket-detail-title'), /الفاتورة/);
    await context.close();
});

test('اختصار / يفتح البحث، وEscape يغلقه', { skip: !chromiumPath }, async () => {
    const { page, context } = await openDashboard(browser, baseUrl, fixtures());
    await page.keyboard.press('/');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'globalSearchInput');

    await page.fill('#globalSearchInput', 'تذاكر');
    await page.waitForSelector('#globalSearchResults .search-result');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('globalSearchResults').hidden === true);
    await context.close();
});

test('البحث بلا نتائج يشرح الخطوة التالية', { skip: !chromiumPath }, async () => {
    const { page, context } = await openDashboard(browser, baseUrl, fixtures());
    await page.fill('#globalSearchInput', 'كلمةلاتوجدابدا');
    await page.waitForSelector('#globalSearchResults .state-block');
    assert.match(await page.textContent('#globalSearchResults'), /افتح تذكرة جديدة/);
    await context.close();
});

/* ==================== 9) المساعدة الاستباقية ==================== */

test('العطل المعلن يظهر قبل إنشاء التذكرة', { skip: !chromiumPath }, async () => {
    const fx = fixtures();
    fx.tables.incidents = [{
        id: 'i1', title: 'انقطاع في خدمة الإشعارات', description: 'نعمل على إصلاحه',
        status: 'investigating', created_at: '2026-09-04T08:00:00Z', resolved_at: null
    }];
    const { page, context } = await openDashboard(browser, baseUrl, fx);
    await page.click('[data-action="open-create-ticket"]');
    await page.waitForSelector('#createTicketModal.active');
    await page.waitForSelector('#createTicketSelfHelp:not(.u-hidden)');
    assert.match(await page.textContent('#createTicketSelfHelp'), /انقطاع في خدمة الإشعارات/);
    await context.close();
});

test('كتابة عنوان مشابه لتذكرة مفتوحة تقترح فتحها بدل تذكرة جديدة', { skip: !chromiumPath }, async () => {
    const { page, context } = await openDashboard(browser, baseUrl, fixtures());
    await page.click('[data-action="open-create-ticket"]');
    await page.waitForSelector('#createTicketModal.active');
    await page.fill('#userTicketTitle', 'مشكلة في تسجيل الدخول');
    await page.waitForSelector('#createTicketSelfHelp [data-open-ticket]');
    assert.match(await page.textContent('#createTicketSelfHelp'), /تذكرة مفتوحة مشابهة/);

    await page.click('#createTicketSelfHelp [data-open-ticket]');
    await page.waitForSelector('#ticketsTabContent.active');
    assert.match(await page.textContent('.ticket-detail-title'), /مشكلة في تسجيل الدخول/);
    await context.close();
});

/* ==================== 10) الحالات والتجاوب ==================== */

test('كل قسم له حالة فراغ مفيدة بإجراء واضح', { skip: !chromiumPath }, async () => {
    const fx = fixtures();
    fx.tables.tickets = [];
    fx.tables.notifications = [];
    fx.tables.activity_logs = [];

    const { page, context } = await openDashboard(browser, baseUrl, fx, { hash: '#tickets' });
    await page.waitForSelector('#userTicketsList .state-block');
    const ticketsEmpty = await page.textContent('#userTicketsList');
    assert.match(ticketsEmpty, /لا توجد تذاكر حتى الآن/);
    assert.match(ticketsEmpty, /إنشاء تذكرة/);   // إجراء، مش "لا توجد بيانات" وبس

    await page.click('.sidebar-item[data-tab="notifications"]');
    await page.waitForSelector('#notificationsList .state-block');
    assert.match(await page.textContent('#notificationsList'), /ستصلك هنا تحديثات/);

    await page.click('.sidebar-item[data-tab="activity"]');
    await page.waitForSelector('#activityBody .state-block');
    assert.match(await page.textContent('#activityBody'), /ستظهر هنا عملياتك/);
    await context.close();
});

test('لا تمرير أفقي على أي مقاس، والقائمة تتحوّل لدرج', { skip: !chromiumPath }, async () => {
    const { page, context } = await openDashboard(browser, baseUrl, fixtures());

    for (const width of [320, 360, 390, 414, 480, 520, 600, 768, 992, 1024, 1100, 1280, 1440, 1920]) {
        await page.setViewportSize({ width, height: 900 });
        await page.waitForTimeout(120);
        const metrics = await page.evaluate(() => ({
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            sidebarRight: getComputedStyle(document.getElementById('sidebar')).right
        }));
        assert.ok(metrics.overflow <= 1, `تمرير أفقي بمقدار ${metrics.overflow}px عند عرض ${width}px`);
        if (width < 1100) {
            assert.notEqual(metrics.sidebarRight, '0px', `القائمة يجب أن تكون درجًا عند ${width}px`);
        } else {
            assert.equal(metrics.sidebarRight, '0px', `القائمة يجب أن تكون ثابتة عند ${width}px`);
        }
    }
    await context.close();
});

test('لا تمرير أفقي في الوضع النهاري ولا مع القائمة المطوية', { skip: !chromiumPath }, async () => {
    const { page, context } = await openDashboard(browser, baseUrl, fixtures());
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await page.click('#sidebarCollapseBtn');
    await page.waitForTimeout(320);

    for (const width of [360, 768, 1100, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await page.waitForTimeout(150);
        const overflow = await page.evaluate(() =>
            document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert.ok(overflow <= 1, `تمرير أفقي ${overflow}px عند ${width}px (نهاري + مطوي)`);
    }
    await context.close();
});

test('على الموبايل اختيار تذكرة يعرض التفاصيل وحدها مع زر رجوع', { skip: !chromiumPath }, async () => {
    const { page, context } = await openDashboard(browser, baseUrl, fixtures(), { hash: '#tickets' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(150);

    await page.click(`.ticket-card[data-id="${TICKET_1}"]`);
    await page.waitForSelector('.tickets-layout.detail-open');
    assert.equal(await page.locator('.tickets-list-panel').isVisible(), false);
    assert.equal(await page.locator('#ticketBackBtn').isVisible(), true);

    await page.click('#ticketBackBtn');
    await page.waitForFunction(() => !document.getElementById('ticketsLayout').classList.contains('detail-open'));
    assert.equal(await page.locator('.tickets-list-panel').isVisible(), true);
    await context.close();
});

/* ==================== 11) تكامل لوحة الإدارة (لم ينكسر) ==================== */

test('إعدادات الأدمن ما زالت تتحكم في الواجهة بعد إعادة الهيكلة', { skip: !chromiumPath }, async () => {
    // المكافآت مطفأة ⇒ القسم ورابطه يختفيان
    const noRewards = await openDashboard(browser, baseUrl,
        fixtures({ settings: { customer_experience: { enable_rewards_system: false } } }));
    assert.equal(await noRewards.page.locator('#rewardsTabContent').count(), 0);
    assert.equal(await noRewards.page.locator('.sidebar-item[data-tab="rewards"]').count(), 0);
    await noRewards.context.close();

    // المرفقات مطفأة ⇒ الحقل مخفي
    const noAttach = await openDashboard(browser, baseUrl,
        fixtures({ settings: { customer_experience: { allow_ticket_attachments: false } } }));
    await noAttach.page.click('[data-action="open-create-ticket"]');
    await noAttach.page.waitForSelector('#createTicketModal.active');
    assert.equal(await noAttach.page.locator('#ticketAttachmentsField').isVisible(), false);
    await noAttach.context.close();

    // حد التذاكر المفتوحة يمنع الإرسال
    const atLimit = await openDashboard(browser, baseUrl, fixtures({ settings: { limits: { max_open_tickets: 1 } } }));
    await atLimit.page.click('[data-action="open-create-ticket"]');
    await atLimit.page.waitForSelector('#createTicketModal.active');
    assert.equal(await atLimit.page.locator('#submitTicketBtn').isDisabled(), true);
    await atLimit.context.close();
});

test('التقييم ما زال محكوماً بإعداد الأدمن', { skip: !chromiumPath }, async () => {
    const off = await openDashboard(browser, baseUrl,
        fixtures({ settings: { customer_experience: { allow_ticket_rating: false } } }), { hash: '#tickets' });
    await off.page.click('.view-tab[data-view="closed"]');
    await off.page.waitForSelector('.ticket-card');
    await off.page.click(`.ticket-card[data-id="${TICKET_2}"]`);
    await off.page.waitForSelector('.ticket-detail-title');
    assert.equal(await off.page.locator('#panelStarRating').count(), 0);
    await off.context.close();

    const on = await openDashboard(browser, baseUrl, fixtures(), { hash: '#tickets' });
    await on.page.click('.view-tab[data-view="closed"]');
    await on.page.waitForSelector('.ticket-card');
    await on.page.click(`.ticket-card[data-id="${TICKET_2}"]`);
    await on.page.waitForSelector('#panelStarRating');
    assert.equal(await on.page.locator('#panelStarRating .star').count(), 5);
    await on.context.close();
});

test('سجل التذكرة ما زال يظهر بدون تسريب الأحداث الداخلية', { skip: !chromiumPath }, async () => {
    const fx = fixtures();
    fx.tables.ticket_activity.push(
        { id: 'a3', ticket_id: TICKET_1, action_type: 'internal_note', created_at: '2026-09-01T09:10:00Z' },
        { id: 'a4', ticket_id: TICKET_1, action_type: 'assignee_change', created_at: '2026-09-01T09:11:00Z' }
    );
    const { page, context } = await openDashboard(browser, baseUrl, fx, { hash: '#tickets' });
    await page.click(`.ticket-card[data-id="${TICKET_1}"]`);
    await page.waitForSelector('.ticket-details-scroll .activity-timeline');
    const text = await page.textContent('.ticket-details-scroll');
    assert.match(text, /تم إنشاء التذكرة/);
    assert.ok(!text.includes('internal_note'));
    assert.ok(!text.includes('assignee_change'));
    await context.close();
});

test('نموذج الملف الشخصي ما زال يحفظ ويتحقق', { skip: !chromiumPath }, async () => {
    const { page, context } = await openDashboard(browser, baseUrl, fixtures(), { hash: '#profile' });
    await page.waitForSelector('#profileFullName');

    await page.fill('#profileFullName', 'ا');
    await page.click('#profileSaveBtn');
    await page.waitForSelector('#profileFullNameError:not(.u-hidden)');
    assert.equal((await page.evaluate(() => window.__CALLS__ || [])).length, 0);

    await page.fill('#profileFullName', 'الاسم المحدَّث');
    await page.click('#profileSaveBtn');
    await page.waitForFunction(() => (window.__CALLS__ || []).some(c => c[0] === 'updateProfile'));
    const call = (await page.evaluate(() => window.__CALLS__)).find(c => c[0] === 'updateProfile');
    assert.equal(call[1].full_name, 'الاسم المحدَّث');
    await context.close();
});
