/**
 * اختبارات عرض المدوّنة — تُشغّل blog/index.html و blog/post.html
 * **الحقيقيتين** في Chromium مقابل بديل Supabase الاختباري، فتتنفّذ وحدات
 * blog-index / blog-article / blog-data / blog-model الفعلية.
 *
 * لماذا في متصفح لا في Node؟ لأن ما يُختبَر هنا لا يظهر إلا هناك: أن
 * المتن لا يُنفَّذ كسكربت، وأن حالة الصفحة في الرابط فعلًا، وأن شريط
 * المحرّر لا يظهر لمن لا تُعيد له القاعدة مسودّة.
 *
 * وقرار الصلاحية نفسه ليس هنا ولا يمكن أن يكون: هو في
 * tests/sql/blog.test.sql لأن القاعدة تتّخذه.
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
        let filePath = path.join(ROOT, urlPath === '/' ? '/index.html' : urlPath);
        if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
            filePath = path.join(filePath, 'index.html');
        }
        if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath)) {
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

/* ══════════════════════════════════════════════════════════════════════════
   بيانات الاختبار
   ═════════════════════════════════════════════════════════════════════════ */

const HOUR = 3600000;
const ago = (days) => new Date(Date.now() - days * 24 * HOUR).toISOString();
const ahead = (days) => new Date(Date.now() + days * 24 * HOUR).toISOString();

function post(over = {}) {
    return {
        id: `id-${over.slug || 'x'}`,
        slug: 'دليل-قوالب-واتساب',
        title: 'دليل قوالب واتساب',
        subtitle: 'من الإنشاء إلى الاعتماد',
        excerpt: 'كل ما تحتاجه لاعتماد قالب من أول مرة.',
        content: '## الخطوة الأولى\nافتح مدير القوالب.\n\n## الخطوة الثانية\n- اختر التصنيف\n- أرسل للمراجعة',
        cover_url: null,
        cover_alt: null,
        category_slug: 'whatsapp-api',
        category_name: 'واتساب والـAPI',
        category: { slug: 'whatsapp-api', name: 'واتساب والـAPI' },
        tags: ['واتساب', 'قوالب'],
        status: 'published',
        is_featured: false,
        reading_minutes: 4,
        word_count: 700,
        view_count: 120,
        author_name: 'فريق مدعوم',
        author_title: 'فريق المنتج',
        published_at: ago(3),
        updated_at: ago(3),
        created_at: ago(5),
        ...over
    };
}

/**
 * الـfixtures تُمرَّر عبر addInitScript فتتسلسل — فالدوال تضيع. لذلك نقلّد
 * عقد blog_feed هنا بدل أن نمرّر دالة: نفس ما يفعله supabase-double.js
 * مع search_help_articles، وللسبب ذاته.
 */
function fixtures(rows, over = {}) {
    return {
        user: null,
        tables: { blog_posts: rows },
        rpc: {
            blog_feed: rows.map((r, index) => ({ ...r, relevance: 0, total_count: rows.length, __i: index })),
            blog_related: [],
            blog_categories_with_counts: [
                { slug: 'whatsapp-api', name: 'واتساب والـAPI', description: 'قوالب وجودة', sort_order: 10, post_count: rows.length },
                { slug: 'growth-playbooks', name: 'أدلّة النمو', description: '', sort_order: 60, post_count: 0 }
            ],
            blog_tags: [{ tag: 'واتساب', post_count: 2 }, { tag: 'قوالب', post_count: 1 }],
            increment_blog_view: null
        },
        ...over
    };
}

/* ══════════════════════════════════════════════════════════════════════════
   الإعداد
   ═════════════════════════════════════════════════════════════════════════ */

let server, baseUrl, browser;
const chromiumPath = resolveChromium();

if (!chromiumPath) {
    console.error('SKIP: لا يوجد متصفح Chromium متاح؛ اختبارات عرض المدوّنة لم تُنفَّذ');
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

async function open(route, fx, { viewport = { width: 1440, height: 1000 } } = {}) {
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

    await page.addInitScript((data) => { window.__FIXTURES__ = data; }, fx);

    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto(`${baseUrl}${route}`, { waitUntil: 'networkidle' });
    return { page, context, errors };
}

const skip = { skip: !chromiumPath };

/* ══════════════════════════════════════════════════════════════════════════
   الفهرس
   ═════════════════════════════════════════════════════════════════════════ */

test('الفهرس: يعرض المقالات بلا خطأ في الصفحة', skip, async () => {
    const { page, context, errors } = await open('/blog/', fixtures([
        post({ slug: 'أ', title: 'مقال أ' }),
        post({ slug: 'ب', title: 'مقال ب' }),
        post({ slug: 'ج', title: 'مقال ج' })
    ]));

    await page.waitForSelector('.blog-card, .blog-featured');

    // المميّز يأخذ أول مقال في الحالة الافتراضية، والبقيّة في الشبكة.
    assert.equal(await page.locator('.blog-featured').count(), 1);
    assert.equal(await page.locator('.blog-card').count(), 2);
    assert.deepEqual(errors, []);

    await context.close();
});

test('الفهرس: حالة الفراغ تقول الخطوة التالية لا «لا بيانات»', skip, async () => {
    const { page, context } = await open('/blog/', fixtures([]));

    await page.waitForSelector('.state-block');
    const text = await page.locator('.state-block').innerText();
    assert.ok(text.includes('على وشك أن تبدأ'), text);
    assert.ok(await page.locator('.state-block a[href="/knowledge-base.html"]').count() === 1);

    await context.close();
});

test('الفهرس: البحث يكتب حالته في الرابط فتصلح المشاركة والرجوع', skip, async () => {
    const { page, context } = await open('/blog/', fixtures([post({ slug: 'أ', title: 'مقال أ' })]));

    await page.waitForSelector('.blog-featured');
    await page.fill('#blogSearchInput', 'قوالب');
    await page.waitForFunction(() => window.location.search.includes('q='));

    assert.ok(decodeURIComponent(page.url()).includes('q=قوالب'));
    await page.waitForFunction(() =>
        document.getElementById('blogListHeading')?.textContent.includes('قوالب'));

    await context.close();
});

test('الفهرس: التصفية بالتصنيف تنتقل ولا تُظهر تصنيفًا بلا مقالات', skip, async () => {
    const { page, context } = await open('/blog/', fixtures([post({ slug: 'أ' }), post({ slug: 'ب' })]));

    await page.waitForSelector('#blogCategories .blog-chip');

    // «أدلّة النمو» عددها صفر — طريق مسدود مضمون، فلا تُعرض.
    const labels = await page.locator('#blogCategories .blog-chip').allInnerTexts();
    assert.ok(labels.some(l => l.includes('واتساب')), labels.join('|'));
    assert.ok(!labels.some(l => l.includes('أدلّة النمو')), labels.join('|'));

    await page.locator('#blogCategories .blog-chip', { hasText: 'واتساب' }).first().click();
    await page.waitForFunction(() => window.location.search.includes('category='));
    assert.ok(page.url().includes('category=whatsapp-api'));

    await context.close();
});

test('الفهرس: شريط المحرّر يظهر حين تُعيد القاعدة مسودّة — ولا يظهر بدونها', skip, async () => {
    const live = await open('/blog/', fixtures([post({ slug: 'أ' })]));
    await live.page.waitForSelector('.blog-featured');
    assert.equal(await live.page.locator('#blogEditorBar').isVisible(), false);
    await live.context.close();

    const staff = await open('/blog/', fixtures([
        post({ slug: 'أ' }),
        post({ slug: 'ب', title: 'مسودّة', status: 'draft', published_at: null })
    ]));
    await staff.page.waitForSelector('.blog-card');
    assert.equal(await staff.page.locator('#blogEditorBar').isVisible(), true);

    const text = await staff.page.locator('#blogEditorBarText').innerText();
    assert.ok(text.includes('مسودّة'), text);
    await staff.context.close();
});

test('الفهرس: المقال المجدول يُعلَّم مجدولًا لا منشورًا', skip, async () => {
    const { page, context } = await open('/blog/', fixtures([
        post({ slug: 'أ' }),
        post({ slug: 'ب', title: 'إعلان قادم', published_at: ahead(7) })
    ]));

    await page.waitForSelector('.blog-card');
    const pills = await page.locator('.blog-card .pill').allInnerTexts();
    assert.ok(pills.includes('مجدول'), pills.join('|'));

    await context.close();
});

/* ══════════════════════════════════════════════════════════════════════════
   المقال
   ═════════════════════════════════════════════════════════════════════════ */

test('المقال: يعرض المتن والفهرس والوسوم والمشاركة', skip, async () => {
    const { page, context, errors } = await open(
        '/blog/post.html?slug=' + encodeURIComponent('دليل-قوالب-واتساب'),
        fixtures([post()])
    );

    await page.waitForSelector('#postTitle');

    assert.equal(await page.locator('#postTitle').innerText(), 'دليل قوالب واتساب');
    assert.equal(await page.locator('#postBody .blog-heading').count(), 2);
    assert.equal(await page.locator('#postBody .blog-list li').count(), 2);
    assert.equal(await page.locator('#postTocList li').count(), 2);
    assert.equal(await page.locator('#postTags .blog-tag').count(), 2);
    assert.ok(await page.locator('#postShare .blog-share-btn').count() >= 3);
    assert.deepEqual(errors, []);

    await context.close();
});

test('المقال: العنوان والوصف والبيانات المنظَّمة تُكتب في الرأس', skip, async () => {
    const { page, context } = await open(
        '/blog/post.html?slug=' + encodeURIComponent('دليل-قوالب-واتساب'),
        fixtures([post()])
    );

    await page.waitForSelector('#postTitle');

    assert.equal(await page.title(), 'دليل قوالب واتساب | مدوّنة مدعوم');
    assert.equal(
        await page.getAttribute('meta[name="description"]', 'content'),
        'كل ما تحتاجه لاعتماد قالب من أول مرة.'
    );
    assert.equal(await page.getAttribute('meta[name="robots"]', 'content'), 'index, follow');

    const ld = await page.locator('script[type="application/ld+json"]').innerText();
    const parsed = JSON.parse(ld);
    assert.equal(parsed['@type'], 'BlogPosting');
    assert.equal(parsed.author.name, 'فريق مدعوم');

    await context.close();
});

test('المقال: المتن لا يُنفَّذ — الوسم المُلصَق يُعرض نصًّا', skip, async () => {
    const malicious = '<img src=x onerror="window.__PWNED__=true"> نص عادي\n\n[اضغط](javascript:window.__PWNED__=true)';
    const { page, context } = await open(
        '/blog/post.html?slug=' + encodeURIComponent('دليل-قوالب-واتساب'),
        fixtures([post({ content: malicious })])
    );

    await page.waitForSelector('#postBody');

    assert.equal(await page.evaluate(() => window.__PWNED__), undefined);
    assert.equal(await page.locator('#postBody img').count(), 0);
    assert.equal(await page.locator('#postBody a[href^="javascript:"]').count(), 0);
    assert.ok((await page.locator('#postBody').innerText()).includes('<img src=x'));

    await context.close();
});

test('المقال: المسودّة تحمل noindex وشريط محرّر يشير إلى اللوحة', skip, async () => {
    const { page, context } = await open(
        '/blog/post.html?slug=' + encodeURIComponent('دليل-قوالب-واتساب'),
        fixtures([post({ status: 'draft', published_at: null, id: 'draft-1' })])
    );

    await page.waitForSelector('#postTitle');

    assert.equal(await page.getAttribute('meta[name="robots"]', 'content'), 'noindex, nofollow');
    assert.equal(await page.locator('script[type="application/ld+json"]').count(), 0,
        'المسودّة لا تُصدِّر بيانات منظَّمة لمحرّكات البحث');
    assert.equal(await page.locator('#blogEditorBar').isVisible(), true);
    assert.ok((await page.locator('#blogEditorBarLink').getAttribute('href')).includes('edit=draft-1'));

    await context.close();
});

test('المقال: «غير متاح» حين لا يُعيد الخادم صفًّا', skip, async () => {
    const { page, context } = await open(
        '/blog/post.html?slug=' + encodeURIComponent('لا-يوجد'),
        fixtures([])
    );

    await page.waitForSelector('.state-block');
    assert.ok((await page.locator('.state-block').innerText()).includes('غير متاح'));
    assert.equal(await page.locator('#blogArticleLayout').isVisible(), false);

    await context.close();
});

test('المقال: عدّاد المشاهدة يُنادى مرة واحدة لكل مقال في الجلسة', skip, async () => {
    const url = '/blog/post.html?slug=' + encodeURIComponent('دليل-قوالب-واتساب');
    const { page, context } = await open(url, fixtures([post()]));

    await page.waitForSelector('#postTitle');
    const first = await page.evaluate(() =>
        (window.__RPC_CALLS__ || []).filter(n => n === 'increment_blog_view').length);
    assert.equal(first, 1);

    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('#postTitle');
    const second = await page.evaluate(() =>
        (window.__RPC_CALLS__ || []).filter(n => n === 'increment_blog_view').length);
    assert.equal(second, 0, 'إعادة التحميل ليست قراءة ثانية');

    await context.close();
});

/* ══════════════════════════════════════════════════════════════════════════
   لوحة التحرير
   ═════════════════════════════════════════════════════════════════════════ */

const ADMIN_ID = '33333333-3333-3333-3333-333333333333';

/** حساب طاقم كما يراه حارس الصفحة — التفويض الفعلي في القاعدة لا هنا. */
function staffFixtures(rows, over = {}) {
    const base = fixtures(rows, over);
    return {
        ...base,
        user: { id: ADMIN_ID, email: 'admin@mad3oom.com' },
        authUser: {
            id: ADMIN_ID,
            email: 'admin@mad3oom.com',
            profile: { id: ADMIN_ID, full_name: 'مدير المنصة', role: 'admin' }
        },
        tables: {
            ...base.tables,
            blog_categories: [
                { id: 'cat-1', slug: 'whatsapp-api', name: 'واتساب والـAPI', description: '', sort_order: 10, is_active: true }
            ],
            profiles: [{ id: ADMIN_ID, email: 'admin@mad3oom.com', role: 'admin', full_name: 'مدير المنصة' }]
        }
    };
}

test('اللوحة: تعرض المقالات وإحصاءها لحساب الطاقم', skip, async () => {
    const { page, context, errors } = await open('/admin/blog.html', staffFixtures([
        post({ id: 'p1', slug: 'أ', title: 'مقال منشور' }),
        post({ id: 'p2', slug: 'ب', title: 'مسودّة', status: 'draft', published_at: null }),
        post({ id: 'p3', slug: 'ج', title: 'إعلان قادم', published_at: ahead(5) })
    ]));

    await page.waitForSelector('#blogRows tr[data-id]');

    assert.equal(await page.locator('#blogRows tr[data-id]').count(), 3);
    assert.equal(await page.locator('.stat-card').count(), 5);

    const badges = await page.locator('#blogRows .status-badge').allInnerTexts();
    assert.ok(badges.includes('منشور'), badges.join('|'));
    assert.ok(badges.includes('مسودّة'), badges.join('|'));
    assert.ok(badges.includes('مجدول'), badges.join('|'));
    assert.deepEqual(errors, []);

    await context.close();
});

test('اللوحة: التصفية بـ«مجدول» تعمل على الحالة المشتقّة لا على العمود', skip, async () => {
    const { page, context } = await open('/admin/blog.html', staffFixtures([
        post({ id: 'p1', slug: 'أ', title: 'مقال منشور' }),
        post({ id: 'p3', slug: 'ج', title: 'إعلان قادم', published_at: ahead(5) })
    ]));

    await page.waitForSelector('#blogRows tr[data-id]');
    await page.selectOption('#blogStatusFilter', 'scheduled');

    const rows = page.locator('#blogRows tr[data-id]');
    assert.equal(await rows.count(), 1);
    assert.ok((await rows.first().innerText()).includes('إعلان قادم'));

    await context.close();
});

test('اللوحة: الرابط المختصر يُشتق من العنوان ويتوقّف الاشتقاق بعد لمسه', skip, async () => {
    const { page, context } = await open('/admin/blog.html', staffFixtures([]));

    await page.waitForSelector('#newPostBtn');
    await page.click('#newPostBtn');
    await page.waitForSelector('#postModal.active');

    await page.fill('#fTitle', 'دليل قوالب واتساب');
    assert.equal(await page.inputValue('#fSlug'), 'دليل-قوالب-واتساب');

    await page.fill('#fSlug', 'رابط-مختار-يدويًا');
    await page.fill('#fTitle', 'عنوان مختلف تمامًا');
    assert.equal(await page.inputValue('#fSlug'), 'رابط-مختار-يدويًا',
        'العنوان لا يدوس على رابط اختاره المحرّر بيده');

    await context.close();
});

test('اللوحة: المعاينة الحيّة هي نفس مُحوِّل الصفحة العامة', skip, async () => {
    const { page, context } = await open('/admin/blog.html', staffFixtures([]));

    await page.waitForSelector('#newPostBtn');
    await page.click('#newPostBtn');
    await page.waitForSelector('#postModal.active');

    await page.fill('#fContent', '## عنوان\n\n- عنصر\n- عنصر\n\n<img src=x onerror="window.__PWNED__=true">');

    await page.waitForFunction(() => document.querySelectorAll('#previewBody .blog-heading').length === 1);
    assert.equal(await page.locator('#previewBody .blog-list li').count(), 2);
    assert.equal(await page.evaluate(() => window.__PWNED__), undefined);
    assert.equal(await page.locator('#previewBody img').count(), 0);

    await context.close();
});

test('اللوحة: النشر بمتن قصير مرفوض، والحفظ مسودّةً مسموح', skip, async () => {
    const { page, context } = await open('/admin/blog.html', staffFixtures([]));

    await page.waitForSelector('#newPostBtn');
    await page.click('#newPostBtn');
    await page.waitForSelector('#postModal.active');

    await page.fill('#fTitle', 'عنوان');
    await page.fill('#fContent', 'نص قصير جدًّا.');
    await page.selectOption('#fStatus', 'published');
    await page.click('#savePostBtn');

    await page.waitForSelector('[data-error-for="content"]:not([hidden])');
    assert.equal(await page.locator('#postModal.active').count(), 1, 'النافذة تبقى مفتوحة عند الرفض');
    assert.equal(await page.evaluate(() =>
        (window.__WRITES__ || []).filter(w => w.table === 'blog_posts').length), 0,
        'لا كتابة تُرسَل قبل أن يمرّ التحقّق');

    // نفس المحتوى مسودّةً: يُحفظ بلا اعتراض
    await page.selectOption('#fStatus', 'draft');
    await page.click('#savePostBtn');
    await page.waitForFunction(() =>
        (window.__WRITES__ || []).some(w => w.table === 'blog_posts' && w.op === 'insert'));

    const written = await page.evaluate(() =>
        (window.__WRITES__ || []).find(w => w.table === 'blog_posts' && w.op === 'insert').row);
    assert.equal(written.status, 'draft');
    assert.equal(written.author_id, ADMIN_ID, 'الكاتب يُشتق من الجلسة لا من حقل حرّ');
    assert.equal(written.reading_minutes, undefined, 'زمن القراءة يحسبه المحفّز لا الواجهة');
    assert.equal(written.view_count, undefined, 'العدّاد لا يُرسَل من اللوحة');

    await context.close();
});

test('اللوحة: قائمة الجاهزية تعدّ ما نقص', skip, async () => {
    const { page, context } = await open('/admin/blog.html', staffFixtures([]));

    await page.waitForSelector('#newPostBtn');
    await page.click('#newPostBtn');
    await page.waitForSelector('#postModal.active');

    assert.equal(await page.locator('#checklistItems li').count(), 8);

    await page.fill('#fTitle', 'دليل قوالب واتساب الكامل');
    await page.waitForFunction(() => document.querySelectorAll('#checklistItems li.is-done').length >= 1);

    const percent = await page.locator('#checklistPercent').innerText();
    assert.notEqual(percent, '0%');

    await context.close();
});

/* ══════════════════════════════════════════════════════════════════════════
   الهوية البصرية
   ═════════════════════════════════════════════════════════════════════════ */

test('المدوّنة تستعمل نظام تصميم اللوحة نفسه ولا تحجز مكان قائمة غير موجودة', skip, async () => {
    const { page, context } = await open('/blog/', fixtures([post({ slug: 'أ' })]));
    await page.waitForSelector('.blog-featured');

    // نفس قشرة لوحة الشركة/العميل: التوكنز والزجاج يأتيان من هنا.
    assert.equal(await page.locator('body.customer-shell.blog-shell').count(), 1);

    // ولا قائمة جانبية: لولا الإلغاء في blog.css لبقي عمود 290px فارغًا.
    const margin = await page.evaluate(() =>
        getComputedStyle(document.querySelector('.admin-main')).marginRight);
    assert.notEqual(margin, '290px', 'المحتوى يزاح بعرض قائمة لا وجود لها');

    await context.close();
});

test('الصفحة تعمل بعرض هاتف بلا تمرير أفقي', skip, async () => {
    const { page, context } = await open('/blog/', fixtures([post({ slug: 'أ' }), post({ slug: 'ب' })]),
        { viewport: { width: 390, height: 844 } });

    await page.waitForSelector('.blog-card, .blog-featured');
    const overflow = await page.evaluate(() =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `تمرير أفقي بمقدار ${overflow}px`);

    await context.close();
});
