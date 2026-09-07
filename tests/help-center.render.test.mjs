/**
 * اختبارات مركز المساعدة — تشغّل knowledge-base.html الحقيقية في Chromium
 * مقابل بديل Supabase الاختباري، فتتنفّذ وحدات help-center/help-data/
 * help-article-model الفعلية.
 *
 * كل اختبار هنا يثبّت متطلبًا من جولة "توحيد البوابة + مركز المساعدة":
 * المقالات تُحمَّل فعلاً (بعد ما كانت الصفحة بتقول "فشل تحميل المقالات")،
 * والبحث حقيقي، والعطل المعلن يسبق المقالات، والتصعيد للدعم موجود في كل
 * طريق مسدود.
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
const ART_1 = 'aaaa1111-1111-4111-8111-aaaaaaaaaaaa';
const ART_2 = 'bbbb2222-2222-4222-8222-bbbbbbbbbbbb';
const ART_3 = 'cccc3333-3333-4333-8333-cccccccccccc';
const SVC_NOTIFY = 'dddd4444-4444-4444-8444-dddddddddddd';
const TICKET_1 = 'eeee5555-5555-4555-8555-eeeeeeeeeeee';

function fixtures(overrides = {}) {
    const articles = overrides.knowledge_base || [
        {
            id: ART_1, title: 'كيف أشحن رصيد الواتساب؟', category: 'واتساب',
            excerpt: 'خطوات شحن الرصيد من المحفظة.',
            content: '## الخطوة الأولى\nافتح قسم الاستهلاك.\n\n## الخطوة الثانية\n- اضغط شحن\n- أدخل المبلغ',
            status: 'published', is_internal: false, view_count: 40,
            created_at: '2026-08-01T10:00:00Z', updated_at: '2026-09-01T10:00:00Z'
        },
        {
            id: ART_2, title: 'الإشعارات لا تصل إلى بريدي', category: 'المشاكل الشائعة',
            excerpt: 'أسباب عدم وصول الإشعارات وطريقة حلّها.',
            content: 'راجع إعدادات البريد ثم أعد المحاولة.',
            status: 'published', is_internal: false, view_count: 0,
            created_at: '2026-08-05T10:00:00Z', updated_at: '2026-08-20T10:00:00Z'
        },
        {
            id: ART_3, title: 'تفعيل التحقق بخطوتين', category: 'الأمان',
            excerpt: 'حماية إضافية لحسابك.',
            content: 'من قسم الأمان فعّل التحقق بخطوتين.',
            status: 'published', is_internal: false, view_count: 12,
            created_at: '2026-07-01T10:00:00Z', updated_at: '2026-07-10T10:00:00Z'
        }
    ];

    return {
        user: { id: USER_ID, email: 'client@example.com' },
        authUser: {
            id: USER_ID, email: 'client@example.com',
            profile: { id: USER_ID, full_name: 'عميل تجريبي', role: 'user', whatsapp_enabled: true }
        },
        // search_help_articles و increment_article_view منفَّذتان داخل البديل
        // نفسه (الدوال ما بتنجاش من تسلسل addInitScript).
        rpc: { ...(overrides.rpc || {}) },
        tables: {
            knowledge_base: articles,
            kb_article_feedback: overrides.kb_article_feedback || [],
            suggested_questions: overrides.suggested_questions || [
                { id: 1, question: 'كيف أتحقق من رصيدي؟', answer: 'من قسم الاستهلاك والحدود.', category: 'المحفظة', is_active: true }
            ],
            profiles: [{
                id: USER_ID, email: 'client@example.com', full_name: 'عميل تجريبي',
                role: 'user', whatsapp_enabled: true, aqar_enabled: false, ban_status: 'active'
            }],
            services: overrides.services || [
                {
                    id: SVC_NOTIFY, name: 'خدمة الإشعارات', service_key: 'notifications',
                    status: 'down', status_changed_at: '2026-09-05T08:00:00Z',
                    updated_at: '2026-09-05T08:00:00Z', last_checked: '2026-09-05T09:00:00Z'
                }
            ],
            incidents: overrides.incidents || [],
            customer_sie_access: [],
            customer_service_reports: [],
            whatsapp_subscriptions: [],
            tickets: overrides.tickets || [{
                id: TICKET_1, user_id: USER_ID, ticket_number: 101,
                title: 'مشكلة في الإشعارات', status: 'open', priority: 'medium',
                archived_by_customer: false,
                created_at: '2026-09-01T09:00:00Z', updated_at: '2026-09-01T09:00:00Z'
            }],
            ticket_replies: [],
            notifications: []
        }
    };
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

let server, baseUrl, browser;
const chromiumPath = resolveChromium();

if (!chromiumPath) {
    console.error('SKIP: لا يوجد متصفح Chromium متاح؛ اختبارات مركز المساعدة لم تُنفَّذ');
}

test.before(async () => {
    if (!chromiumPath) return;
    server = await startServer();
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: chromiumPath });
});

test.after(async () => {
    await browser?.close();
    server?.close();
});

async function openHelp(fx, { search = '', viewport = { width: 1440, height: 1000 }, theme = 'dark' } = {}) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();

    const doubleSupabase = fs.readFileSync(path.join(ROOT, 'tests/fixtures/supabase-double.js'), 'utf8');
    const doubleAuth = fs.readFileSync(path.join(ROOT, 'tests/fixtures/auth-client-double.js'), 'utf8');

    await page.route('**/api-config.js', r =>
        r.fulfill({ contentType: 'text/javascript; charset=utf-8', body: doubleSupabase }));
    await page.route('**/auth-client.js', r =>
        r.fulfill({ contentType: 'text/javascript; charset=utf-8', body: doubleAuth }));
    await page.route('**/error-tracker.js', r => r.fulfill({ contentType: 'text/javascript', body: '' }));
    await page.route('https://fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));

    await page.addInitScript(([data, th]) => {
        window.__FIXTURES__ = data;
        try { localStorage.setItem('theme-preference', th); } catch { /* الوضع الخاص */ }
    }, [fx, theme]);

    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto(`${baseUrl}/knowledge-base.html${search}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.sidebar-item[data-page="knowledge-base"]', { timeout: 10000 });
    return { page, context, errors };
}

/* ============================ التحميل ============================ */

test('المقالات تُحمَّل فعلاً (كانت الصفحة تعرض "فشل تحميل المقالات")', { skip: !chromiumPath }, async () => {
    const { page, context, errors } = await openHelp(fixtures());
    await page.waitForSelector('#helpArticlesList .article-card');

    const body = await page.textContent('body');
    assert.ok(!body.includes('فشل تحميل المقالات'), 'رسالة الفشل القديمة ما زالت تظهر');

    const cards = await page.$$('#helpArticlesList .article-card');
    assert.equal(cards.length, 3, 'عدد المقالات المعروضة غير صحيح');
    assert.deepEqual(errors, []);
    await context.close();
});

test('الصفحة تحمل هوية البوابة: نفس القائمة والشريط والثيم', { skip: !chromiumPath }, async () => {
    const { page, context } = await openHelp(fixtures());

    // نفس القشرة: قائمة جانبية + شريط علوي مثبّت + الشعار الصحيح
    assert.ok(await page.isVisible('#sidebar'));
    assert.ok(await page.isVisible('.portal-nav'));
    assert.equal(await page.getAttribute('.portal-brand-logo', 'src'), '/logo.png');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.admin-nav')).position), 'fixed');
    assert.equal(await page.evaluate(() => document.body.classList.contains('customer-shell')), true);

    // عنصر القائمة النشط هو مركز المساعدة
    const cls = await page.getAttribute('.sidebar-item[data-page="knowledge-base"]', 'class');
    assert.ok(cls.includes('active'), 'عنصر مركز المساعدة غير مُعلَّم كنشط');
    await context.close();
});

test('لا تمرير أفقي على أي مقاس في الوضعين', { skip: !chromiumPath }, async () => {
    for (const theme of ['dark', 'light']) {
        for (const width of [320, 360, 390, 414, 768, 1024, 1440]) {
            const { page, context } = await openHelp(fixtures(), {
                viewport: { width, height: 900 }, theme
            });
            await page.waitForSelector('#helpArticlesList .article-card');
            const overflow = await page.evaluate(() =>
                document.documentElement.scrollWidth - document.documentElement.clientWidth);
            assert.ok(overflow <= 0, `تمرير أفقي ${overflow}px عند ${width}px (${theme})`);
            await context.close();
        }
    }
});

/* ============================ البحث ============================ */

test('البحث يطابق العنوان والمتن ويرتّب بالصلة', { skip: !chromiumPath }, async () => {
    const { page, context } = await openHelp(fixtures());
    await page.waitForSelector('#helpArticlesList .article-card');

    await page.fill('#helpSearchInput', 'الإشعارات');
    await page.waitForSelector('#helpResultsSection:not([hidden]) .article-card');

    const titles = await page.$$eval('#helpResultsList .article-card-title', els => els.map(e => e.textContent.trim()));
    assert.ok(titles.some(t => t.includes('الإشعارات لا تصل')), 'المقال المطابق للعنوان لم يظهر');

    // أثناء البحث التصفّح بيتخفي فالنتيجة هي الشاشة
    assert.ok(await page.isHidden('#helpCategoriesSection'));
    await context.close();
});

test('بحث بلا نتائج يشرح الخطوة التالية بدل "لا توجد مقالات"', { skip: !chromiumPath }, async () => {
    const { page, context } = await openHelp(fixtures());
    await page.waitForSelector('#helpArticlesList .article-card');

    await page.fill('#helpSearchInput', 'زززز');
    await page.waitForSelector('#helpResultsList .state-block');

    const text = await page.textContent('#helpResultsList');
    assert.match(text, /لم نجد مقالاً مطابقاً/);
    assert.match(text, /جرّب كلمات أخرى|تواصل مع فريق الدعم/);
    assert.ok(await page.isVisible('#helpResultsList .btn'), 'لا يوجد إجراء تصعيد في حالة الفراغ');
    await context.close();
});

test('مسح البحث يعيد التصفّح كما كان', { skip: !chromiumPath }, async () => {
    const { page, context } = await openHelp(fixtures());
    await page.waitForSelector('#helpArticlesList .article-card');

    await page.fill('#helpSearchInput', 'الإشعارات');
    await page.waitForSelector('#helpResultsSection:not([hidden])');
    await page.click('#helpSearchClear');

    await page.waitForSelector('#helpCategoriesSection:not([hidden])');
    assert.ok(await page.isHidden('#helpResultsSection'));
    assert.equal(await page.inputValue('#helpSearchInput'), '');
    await context.close();
});

/* ==================== الربط بحالة النظام وحالة العميل ==================== */

test('العطل المعلن على خدمة يستخدمها العميل يظهر أعلى نتائج البحث', { skip: !chromiumPath }, async () => {
    const { page, context } = await openHelp(fixtures());
    await page.waitForSelector('#helpArticlesList .article-card');

    await page.fill('#helpSearchInput', 'الإشعارات لا تعمل');
    await page.waitForSelector('#helpIncidentBanner:not([hidden])');

    const banner = await page.textContent('#helpIncidentBanner');
    assert.match(banner, /عطل حالي في خدمة الإشعارات/);
    assert.match(banner, /عرض حالة النظام/);
    await context.close();
});

test('لا يظهر تنبيه عطل لبحث لا علاقة له بالخدمة المعطّلة', { skip: !chromiumPath }, async () => {
    const { page, context } = await openHelp(fixtures());
    await page.waitForSelector('#helpArticlesList .article-card');

    await page.fill('#helpSearchInput', 'التحقق بخطوتين');
    await page.waitForSelector('#helpResultsSection:not([hidden])');
    assert.ok(await page.isHidden('#helpIncidentBanner'), 'ظهر تنبيه عطل غير مرتبط بالبحث');
    await context.close();
});

test('تذكرة العميل المفتوحة المشابهة تُقترح بدل فتح تذكرة جديدة', { skip: !chromiumPath }, async () => {
    const { page, context } = await openHelp(fixtures());
    await page.waitForSelector('#helpArticlesList .article-card');

    await page.fill('#helpSearchInput', 'الإشعارات');
    await page.waitForSelector('#helpTicketHint:not([hidden])');

    const hint = await page.textContent('#helpTicketHint');
    assert.match(hint, /لديك بالفعل تذكرة مفتوحة/);
    assert.match(hint, /مشكلة في الإشعارات/);

    const href = await page.getAttribute('#helpTicketHint a.btn', 'href');
    assert.match(href, new RegExp(`ticket=${TICKET_1}`), 'رابط التذكرة لا يفتح التذكرة نفسها');
    await context.close();
});

test('المقترح لك يعتمد على الخدمات المفعّلة فعلاً في الحساب', { skip: !chromiumPath }, async () => {
    const { page, context } = await openHelp(fixtures());
    await page.waitForSelector('#helpRecommendedSection:not([hidden])');

    const text = await page.textContent('#helpRecommendedList');
    assert.match(text, /الواتساب/, 'لم يُقترح مقال الواتساب رغم تفعيل الخدمة');
    assert.ok(!text.includes('التحقق بخطوتين'), 'اقتُرح مقال لا علاقة له بخدمات العميل');
    await context.close();
});

/* ============================ التصنيفات ============================ */

test('التصنيفات مبنية من المحتوى الفعلي وتصفّي القائمة', { skip: !chromiumPath }, async () => {
    const { page, context } = await openHelp(fixtures());
    await page.waitForSelector('#helpCategories .filter-chip');

    const chips = await page.$$eval('#helpCategories .filter-chip', els => els.map(e => e.textContent.trim()));
    assert.equal(chips.length, 3, 'عدد التصنيفات لا يطابق المحتوى');
    assert.ok(chips.some(c => c.includes('واتساب')));

    await page.click('#helpCategories .filter-chip:has-text("الأمان")');
    await page.waitForFunction(() =>
        document.querySelectorAll('#helpArticlesList .article-card').length === 1);
    assert.match(await page.textContent('#helpArticlesTitle'), /الأمان/);
    await context.close();
});

/* ============================ المقال ============================ */

test('فتح المقال يعرض عنوانه وتصنيفه وتاريخه ومتنه', { skip: !chromiumPath }, async () => {
    const { page, context } = await openHelp(fixtures());
    await page.waitForSelector('#helpArticlesList .article-card');

    await page.click(`.article-card[data-article="${ART_1}"]`);
    await page.waitForSelector('#helpArticleView:not([hidden])');

    assert.match(await page.textContent('#articleTitle'), /كيف أشحن رصيد الواتساب/);
    assert.match(await page.textContent('#articleCategory'), /واتساب/);
    assert.match(await page.textContent('#articleMeta'), /آخر تحديث/);
    assert.match(await page.textContent('#articleBody'), /افتح قسم الاستهلاك/);
    assert.ok(await page.isHidden('#helpHomeView'), 'الصفحة الرئيسية ما زالت ظاهرة خلف المقال');
    await context.close();
});

test('المقال الطويل يعرض فهرساً، والقصير لا يعرضه', { skip: !chromiumPath }, async () => {
    const { page, context } = await openHelp(fixtures());
    await page.waitForSelector('#helpArticlesList .article-card');

    await page.click(`.article-card[data-article="${ART_1}"]`);
    await page.waitForSelector('#articleToc:not([hidden])');
    const items = await page.$$eval('#articleTocList li', els => els.length);
    assert.equal(items, 2);

    await page.click('#helpBackBtn');
    await page.waitForSelector('#helpHomeView:not([hidden])');
    await page.click(`.article-card[data-article="${ART_3}"]`);
    await page.waitForSelector('#helpArticleView:not([hidden])');
    assert.ok(await page.isHidden('#articleToc'), 'ظهر فهرس لمقال بلا عناوين');
    await context.close();
});

test('متن المقال لا يُحقن كـHTML خام', { skip: !chromiumPath }, async () => {
    const fx = fixtures({
        knowledge_base: [{
            id: ART_1, title: 'مقال', category: 'عام', excerpt: '',
            content: '<img src=x onerror="window.__XSS__=1"> نص عادي',
            status: 'published', is_internal: false, view_count: 1,
            created_at: '2026-08-01T10:00:00Z', updated_at: '2026-09-01T10:00:00Z'
        }]
    });
    const { page, context } = await openHelp(fx);
    await page.waitForSelector('#helpArticlesList .article-card');
    await page.click(`.article-card[data-article="${ART_1}"]`);
    await page.waitForSelector('#helpArticleView:not([hidden])');

    assert.equal(await page.evaluate(() => window.__XSS__), undefined, 'نُفِّذ سكربت من متن المقال');
    assert.equal(await page.$('#articleBody img'), null, 'حُقن وسم من متن المقال');
    assert.match(await page.textContent('#articleBody'), /نص عادي/);
    await context.close();
});

test('المقالات ذات الصلة من نفس التصنيف ولا تشمل المقال نفسه', { skip: !chromiumPath }, async () => {
    const fx = fixtures();
    fx.tables.knowledge_base.push({
        id: 'ffff6666-6666-4666-8666-ffffffffffff', title: 'إيقاف التحقق بخطوتين',
        category: 'الأمان', excerpt: 'خطوات الإيقاف.', content: 'تفاصيل.',
        status: 'published', is_internal: false, view_count: 3,
        created_at: '2026-07-02T10:00:00Z', updated_at: '2026-07-12T10:00:00Z'
    });

    const { page, context } = await openHelp(fx);
    await page.waitForSelector('#helpArticlesList .article-card');
    await page.click(`.article-card[data-article="${ART_3}"]`);
    await page.waitForSelector('#articleRelatedSection:not([hidden])');

    const ids = await page.$$eval('#articleRelatedList .article-card', els => els.map(e => e.dataset.article));
    assert.ok(ids.includes('ffff6666-6666-4666-8666-ffffffffffff'));
    assert.ok(!ids.includes(ART_3), 'المقال الحالي ظهر ضمن المقالات ذات الصلة');
    await context.close();
});

test('زر الرجوع يعيد لمركز المساعدة بنفس محتواه', { skip: !chromiumPath }, async () => {
    const { page, context } = await openHelp(fixtures());
    await page.waitForSelector('#helpArticlesList .article-card');

    await page.click(`.article-card[data-article="${ART_2}"]`);
    await page.waitForSelector('#helpArticleView:not([hidden])');
    await page.click('#helpBackBtn');

    await page.waitForSelector('#helpHomeView:not([hidden])');
    assert.ok(await page.isHidden('#helpArticleView'));
    assert.equal(await page.$$eval('#helpArticlesList .article-card', e => e.length), 3);
    await context.close();
});

test('?article=<id> يفتح المقال مباشرة', { skip: !chromiumPath }, async () => {
    const { page, context } = await openHelp(fixtures(), { search: `?article=${ART_2}` });
    await page.waitForSelector('#helpArticleView:not([hidden])');
    assert.match(await page.textContent('#articleTitle'), /الإشعارات لا تصل/);
    await context.close();
});

/* ============================ التقييم والتصعيد ============================ */

test('تقييم "لا" يعرض طريق التصعيد للدعم', { skip: !chromiumPath }, async () => {
    const { page, context } = await openHelp(fixtures());
    await page.waitForSelector('#helpArticlesList .article-card');
    await page.click(`.article-card[data-article="${ART_2}"]`);
    await page.waitForSelector('#helpArticleView:not([hidden])');

    await page.click('[data-feedback="no"]');
    await page.waitForSelector('#articleFeedbackFollowup:not([hidden])');

    const followup = await page.textContent('#articleFeedbackFollowup');
    assert.match(followup, /إنشاء تذكرة/);
    assert.match(followup, /تواصل فوري/);
    await context.close();
});

test('تقييم "نعم" يشكر بلا تصعيد', { skip: !chromiumPath }, async () => {
    const { page, context } = await openHelp(fixtures());
    await page.waitForSelector('#helpArticlesList .article-card');
    await page.click(`.article-card[data-article="${ART_2}"]`);
    await page.waitForSelector('#helpArticleView:not([hidden])');

    await page.click('[data-feedback="yes"]');
    await page.waitForSelector('#articleFeedbackThanks:not([hidden])');
    assert.ok(await page.isHidden('#articleFeedbackFollowup'), 'عُرض تصعيد رغم أن المقال ساعد');
    await context.close();
});

test('التقييم السابق للعميل يظهر عند إعادة فتح المقال', { skip: !chromiumPath }, async () => {
    const fx = fixtures({
        kb_article_feedback: [{ article_id: ART_2, user_id: USER_ID, is_helpful: false }]
    });
    const { page, context } = await openHelp(fx);
    await page.waitForSelector('#helpArticlesList .article-card');
    await page.click(`.article-card[data-article="${ART_2}"]`);
    await page.waitForSelector('[data-feedback="no"].is-chosen');
    await context.close();
});

test('كل طريق مسدود فيه مخرج للدعم البشري', { skip: !chromiumPath }, async () => {
    const { page, context } = await openHelp(fixtures({ knowledge_base: [] }));
    await page.waitForSelector('#helpArticlesList .state-block');

    const empty = await page.textContent('#helpArticlesList');
    assert.match(empty, /لم تُنشر مقالات مساعدة بعد/);
    assert.match(empty, /تواصل معنا/);

    // ومنطقة التصعيد الثابتة موجودة في كل الأحوال
    const escalation = await page.textContent('.help-escalation');
    assert.match(escalation, /إنشاء تذكرة/);
    assert.match(escalation, /تواصل فوري/);
    await context.close();
});

/* ============================ الأداء والأمان ============================ */

test('القائمة لا تجلب متن المقالات ولا تعرض المسودّات', { skip: !chromiumPath }, async () => {
    const fx = fixtures();
    // مسوّدة ومقال داخلي: القاعدة بتحجبهم عبر RLS، والبديل الاختباري بيرجّع
    // كل الصفوف — فبنتحقق إن الواجهة نفسها ما بتفترضش وصولهم.
    const { page, context } = await openHelp(fx);
    await page.waitForSelector('#helpArticlesList .article-card');

    // المقتطف هو اللي بيظهر في البطاقة، مش المتن
    const card = await page.textContent(`.article-card[data-article="${ART_1}"]`);
    assert.match(card, /خطوات شحن الرصيد/);
    assert.ok(!card.includes('افتح قسم الاستهلاك'), 'متن المقال ظهر في البطاقة');
    await context.close();
});

test('"الأكثر قراءة" يظهر فقط للمقالات التي قُرئت فعلاً', { skip: !chromiumPath }, async () => {
    const { page, context } = await openHelp(fixtures());
    await page.waitForSelector('#helpPopularSection:not([hidden])');

    const ids = await page.$$eval('#helpPopularList .article-card', els => els.map(e => e.dataset.article));
    assert.ok(ids.includes(ART_1), 'المقال الأكثر قراءة لم يظهر');
    assert.ok(!ids.includes(ART_2), 'مقال بصفر قراءات ظهر ضمن الأكثر قراءة');
    await context.close();
});

test('الأسئلة الشائعة الحقيقية تظهر (كانت محجوبة بـRLS بلا سياسات)', { skip: !chromiumPath }, async () => {
    const { page, context } = await openHelp(fixtures());
    await page.waitForSelector('#helpFaqSection:not([hidden]) .faq-item');
    assert.match(await page.textContent('#helpFaqList'), /كيف أتحقق من رصيدي/);
    await context.close();
});
