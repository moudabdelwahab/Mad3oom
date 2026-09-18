/**
 * اختبارات الوحدات الخالصة في المدوّنة.
 *
 * ما يُختبَر هنا هو ما لا يجوز أن يتغيّر لأن أحدًا أعاد ترتيب بطاقة في
 * الصفحة: بناء الـslug، حدود ما يُسمح به في المتن، اشتقاق حالة المقال،
 * وقواعد النشر. أما **من** يُسمح له بالكتابة فمُختبَر في
 * tests/sql/blog.test.sql لأن القرار يُتَّخذ في القاعدة لا هنا.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const {
    slugify, isValidSlug, normalizeTags, wordCount, readingMinutes, deriveExcerpt,
    parseArticle, renderInline, renderArticleHtml, tableOfContents, safeUrl,
    postState, POST_STATES, isLivePost, validatePost, editorialScore,
    documentTitle, metaDescription, articleJsonLd, paginationState, formatCount
} = await import('../assets/js/blog/blog-model.js');

/* ══════════════════════════════════════════════════════════════════════════
   الـslug
   ═════════════════════════════════════════════════════════════════════════ */

test('slugify: العنوان العربي يبقى عربيًا — الرابط يُقرأ لا يُنقحَر', () => {
    assert.equal(slugify('دليل قوالب واتساب'), 'دليل-قوالب-واتساب');
});

test('slugify: يُسقط ما يكسر المسار ويطوي الشرطات', () => {
    assert.equal(slugify('  ما هو WhatsApp Cloud API؟  '), 'ما-هو-whatsapp-cloud-api');
    assert.equal(slugify('a//b??c'), 'a-b-c');
    assert.equal(slugify('--- نص ---'), 'نص');
});

test('slugify: يُسقط التشكيل فلا يختلف رابطان لعنوان واحد', () => {
    assert.equal(slugify('مُدَوَّنة'), slugify('مدونة'));
});

test('slugify: يحترم الطول الأقصى ولا يترك شرطة في آخره', () => {
    const slug = slugify('كلمة '.repeat(60), { maxLength: 20 });
    assert.ok(slug.length <= 20);
    assert.ok(!slug.endsWith('-'));
});

test('isValidSlug: نفس شروط قيد القاعدة', () => {
    assert.equal(isValidSlug('دليل-قوالب'), true);
    assert.equal(isValidSlug('whatsapp-api'), true);
    assert.equal(isValidSlug('a'), false, 'أقصر من حرفين');
    assert.equal(isValidSlug('فيه فراغ'), false);
    assert.equal(isValidSlug('a/b'), false);
    assert.equal(isValidSlug('Upper'), false);
    assert.equal(isValidSlug('-يبدأ-بشرطة'), false);
    assert.equal(isValidSlug('ينتهي-بشرطة-'), false);
});

/* ══════════════════════════════════════════════════════════════════════════
   الوسوم وزمن القراءة
   ═════════════════════════════════════════════════════════════════════════ */

test('normalizeTags: يوحّد ويُسقط المكرّر والفراغ — كما يفعل المحفّز', () => {
    assert.deepEqual(normalizeTags(['واتساب', ' واتساب ', '', 'API']), ['api', 'واتساب']);
});

test('normalizeTags: يقبل نصًّا مفصولًا بفواصل عربية أو لاتينية', () => {
    assert.deepEqual(normalizeTags('واتساب، api, واتساب'), ['api', 'واتساب']);
});

test('readingMinutes: ٢٠٠ كلمة/دقيقة وبحدّ أدنى دقيقة', () => {
    assert.equal(readingMinutes(''), 1, '«٠ دقيقة» ليست معلومة');
    assert.equal(readingMinutes('كلمة '.repeat(400)), 2);
    assert.equal(readingMinutes('كلمة '.repeat(1000)), 5);
});

test('wordCount: لا يعدّ علامات التنسيق كلماتٍ', () => {
    assert.equal(wordCount('## عنوان\n\n- عنصر\n- عنصر'), 3);
});

test('deriveExcerpt: يقطع عند حدّ كلمة ويُسقط التنسيق', () => {
    const excerpt = deriveExcerpt('## عنوان\n\nنص [رابط](https://x.com) و`كود` هنا.', 200);
    assert.ok(!excerpt.includes('##'));
    assert.ok(!excerpt.includes('https://'));
    assert.ok(excerpt.includes('رابط'));

    const long = deriveExcerpt('كلمة '.repeat(100), 40);
    assert.ok(long.endsWith('…'));
    assert.ok(long.length <= 42);
});

/* ══════════════════════════════════════════════════════════════════════════
   المتن: العرض الآمن
   ═════════════════════════════════════════════════════════════════════════ */

test('renderArticleHtml: لا يمرّ وسم واحد من المتن', () => {
    const html = renderArticleHtml('<img src=x onerror=alert(1)> نص');
    assert.ok(!html.includes('<img src=x'));
    assert.ok(html.includes('&lt;img'));
});

test('renderArticleHtml: السكربت المُلصَق يصير نصًّا معروضًا', () => {
    const html = renderArticleHtml('<script>alert(1)</script>');
    assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('&lt;script&gt;'));
});

test('renderInline: javascript: لا يصير رابطًا', () => {
    const html = renderInline('[اضغط](javascript:alert(1))');
    assert.ok(!html.includes('href'));
    assert.ok(html.includes('اضغط'));
});

test('renderInline: data: مرفوض كذلك', () => {
    assert.equal(safeUrl('data:text/html;base64,PHNjcmlwdD4='), '');
    assert.equal(safeUrl('https://mad3oom.com/x'), 'https://mad3oom.com/x');
    assert.equal(safeUrl('/subscriptions.html'), '/subscriptions.html');
    assert.equal(safeUrl('#سؤال'), '#سؤال');
});

test('renderInline: الرابط الخارجي يحمل rel آمنًا، والداخلي لا يفتح تبويبًا', () => {
    const external = renderInline('[موقع](https://example.com)');
    assert.ok(external.includes('rel="noopener noreferrer nofollow"'));

    const internal = renderInline('[الباقات](/subscriptions.html)');
    assert.ok(!internal.includes('target='));
});

test('renderInline: الكود المضمّن لا يُفسَّر تنسيقًا', () => {
    const html = renderInline('استخدم `**ليس تشديدًا**` هنا');
    assert.ok(html.includes('<code class="blog-code-inline">**ليس تشديدًا**</code>'));
    assert.ok(!html.includes('<strong>'));
});

test('renderInline: التشديد والميل يعملان', () => {
    assert.ok(renderInline('**مهم**').includes('<strong>مهم</strong>'));
    assert.ok(renderInline('كلمة _مائلة_ هنا').includes('<em>مائلة</em>'));
});

test('parseArticle: يفكّ العناوين والقوائم والاقتباس والكود والفاصل', () => {
    const { blocks, headings } = parseArticle([
        '## الخطوة الأولى',
        'فقرة تمهيدية.',
        '- عنصر أ',
        '- عنصر ب',
        '1. أولًا',
        '2. ثانيًا',
        '> اقتباس مهم',
        '```js',
        'const x = 1;',
        '```',
        '---',
        '### الخطوة الثانية'
    ].join('\n'));

    const types = blocks.map(b => b.type);
    assert.deepEqual(types, [
        'heading', 'paragraph', 'list', 'list', 'quote', 'code', 'rule', 'heading'
    ]);
    assert.equal(blocks[2].ordered, false);
    assert.equal(blocks[3].ordered, true);
    assert.equal(blocks[5].lang, 'js');
    assert.equal(blocks[5].text, 'const x = 1;');
    assert.equal(headings.length, 2);
    assert.equal(headings[1].level, 3);
});

test('parseArticle: كتلة الكود تبتلع التنسيق بداخلها', () => {
    const { blocks } = parseArticle('```\n## ليس عنوانًا\n- ليس قائمة\n```');
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, 'code');
    assert.ok(blocks[0].text.includes('## ليس عنوانًا'));
});

test('parseArticle: سياج لم يُغلق يُعرض ولا يبتلع المقال صامتًا', () => {
    const { blocks } = parseArticle('نص\n```\nكود بلا إغلاق');
    assert.equal(blocks.at(-1).type, 'code');
    assert.ok(blocks.at(-1).text.includes('كود بلا إغلاق'));
});

test('parseArticle: الصورة بمصدر غير آمن تُسقَط لا تُعرض', () => {
    const { blocks } = parseArticle('![وصف](javascript:alert(1))');
    assert.equal(blocks.filter(b => b.type === 'image').length, 0);

    const ok = parseArticle('![غلاف](https://cdn.example.com/a.png)');
    assert.equal(ok.blocks[0].type, 'image');
    assert.equal(ok.blocks[0].alt, 'غلاف');
});

test('tableOfContents: يظهر لعنوانين فأكثر فقط', () => {
    assert.deepEqual(tableOfContents('## واحد فقط'), []);
    assert.equal(tableOfContents('## أ\n## ب').length, 2);
});

test('tableOfContents: معرّفات العناوين فريدة ولو تطابق النص', () => {
    const toc = tableOfContents('## مقدّمة\n## مقدّمة');
    assert.notEqual(toc[0].id, toc[1].id);
});

/* ══════════════════════════════════════════════════════════════════════════
   حالة المقال
   ═════════════════════════════════════════════════════════════════════════ */

const HOUR = 3600000;

test('postState: «مجدول» مشتقّة لا مخزَّنة — فالجدولة تعمل بلا مهمة دورية', () => {
    const future = new Date(Date.now() + 48 * HOUR).toISOString();
    const past = new Date(Date.now() - 48 * HOUR).toISOString();

    assert.equal(postState({ status: 'published', published_at: future }), POST_STATES.scheduled);
    assert.equal(postState({ status: 'published', published_at: past }), POST_STATES.published);
    assert.equal(postState({ status: 'draft', published_at: past }), POST_STATES.draft);
    assert.equal(postState({ status: 'archived', published_at: past }), POST_STATES.archived);
});

test('isLivePost: المجدول والمسودّة والمؤرشف ليسوا منشورين', () => {
    const future = new Date(Date.now() + HOUR).toISOString();
    assert.equal(isLivePost({ status: 'published', published_at: future }), false);
    assert.equal(isLivePost({ status: 'draft' }), false);
    assert.equal(isLivePost({ status: 'published', published_at: new Date(Date.now() - HOUR).toISOString() }), true);
});

/* ══════════════════════════════════════════════════════════════════════════
   التحقّق قبل الحفظ
   ═════════════════════════════════════════════════════════════════════════ */

function draft(over = {}) {
    return {
        title: 'دليل قوالب واتساب',
        slug: 'دليل-قوالب-واتساب',
        content: 'كلمة '.repeat(100),
        status: 'draft',
        ...over
    };
}

test('validatePost: المسودّة الناقصة تُحفظ — النقص يمنع النشر لا الحفظ', () => {
    const result = validatePost(draft({ excerpt: '', category_id: null }));
    assert.equal(result.valid, true);
    assert.deepEqual(result.warnings, []);
});

test('validatePost: النشر يشترط متنًا كافيًا', () => {
    const short = validatePost(draft({ status: 'published', content: 'نص قصير.' }));
    assert.equal(short.valid, false);
    assert.ok(short.errors.content.includes('أقصر'));

    const enough = validatePost(draft({ status: 'published', excerpt: 'مقتطف', category_id: 'c1', cover_url: '/a.png' }));
    assert.equal(enough.valid, true);
});

test('validatePost: النشر بلا مقتطف أو تصنيف أو غلاف تحذير لا منع', () => {
    const result = validatePost(draft({ status: 'published' }));
    assert.equal(result.valid, true);
    assert.equal(result.warnings.length, 3);
});

test('validatePost: يرفض الـslug والغلاف غير الصالحين', () => {
    assert.ok(validatePost(draft({ slug: 'فيه فراغ' })).errors.slug);
    assert.ok(validatePost(draft({ cover_url: 'javascript:alert(1)' })).errors.cover_url);
    assert.ok(validatePost(draft({ publish_at: 'ليس تاريخًا' })).errors.publish_at);
    assert.ok(validatePost(draft({ title: '' })).errors.title);
    assert.ok(validatePost(draft({ content: '' })).errors.content);
});

test('editorialScore: مؤشّر تحريري يعدّ ما نقص', () => {
    const empty = editorialScore({ title: '', content: '' });
    assert.equal(empty.percent, 0);

    const full = editorialScore({
        title: 'دليل قوالب واتساب الكامل',
        excerpt: 'كل ما تحتاج معرفته لاعتماد قالب من أول محاولة دون رفض.',
        cover_url: '/cover.png',
        category_id: 'c1',
        tags: ['واتساب'],
        content: `## أ\n${'كلمة '.repeat(300)}\n## ب\nنص`,
        seo_description: 'دليل عملي لاعتماد قوالب واتساب من أول مرة مع أمثلة وأسباب الرفض الشائعة.'
    });
    assert.equal(full.percent, 100);
});

/* ══════════════════════════════════════════════════════════════════════════
   SEO والترقيم
   ═════════════════════════════════════════════════════════════════════════ */

test('documentTitle: لا يكرّر اسم المنصة مرتين', () => {
    assert.equal(documentTitle({ title: 'قوالب واتساب' }), 'قوالب واتساب | مدوّنة مدعوم');
    assert.equal(documentTitle({ title: 'ما الجديد في مدعوم' }), 'ما الجديد في مدعوم');
    assert.equal(documentTitle({ title: 'أ', seo_title: 'عنوان SEO' }), 'عنوان SEO | مدوّنة مدعوم');
});

test('metaDescription: يقع على المقتطف ثم على المتن', () => {
    assert.equal(metaDescription({ seo_description: 'وصف' }), 'وصف');
    assert.equal(metaDescription({ excerpt: 'مقتطف' }), 'مقتطف');
    assert.ok(metaDescription({ content: 'نص المقال الطويل هنا.' }).includes('نص المقال'));
});

test('articleJsonLd: بيانات منظَّمة صالحة للمقال', () => {
    const ld = articleJsonLd(
        { title: 'قوالب', excerpt: 'مقتطف', published_at: '2026-01-01T00:00:00Z', author_name: 'فريق مدعوم', word_count: 500 },
        'https://mad3oom.com/blog/post.html?slug=x'
    );
    assert.equal(ld['@type'], 'BlogPosting');
    assert.equal(ld.author.name, 'فريق مدعوم');
    assert.equal(ld.inLanguage, 'ar');
    assert.equal(ld.wordCount, 500);
    assert.equal(articleJsonLd(null, 'x'), null);
});

test('paginationState: يحسب الصفحات والإزاحة ونافذة أرقام محدودة', () => {
    const first = paginationState(50, 1, 9);
    assert.equal(first.pages, 6);
    assert.equal(first.offset, 0);
    assert.equal(first.hasPrev, false);
    assert.equal(first.hasNext, true);
    assert.ok(first.window.length <= 5);

    const third = paginationState(50, 3, 9);
    assert.equal(third.offset, 18);
    assert.ok(third.window.includes(3));

    const beyond = paginationState(50, 99, 9);
    assert.equal(beyond.page, 6, 'صفحة خارج المدى تُقصَر على الأخيرة');

    const empty = paginationState(0, 1, 9);
    assert.equal(empty.pages, 1);
    assert.equal(empty.hasNext, false);
});

test('formatCount: أرقام كبيرة تُقرأ لا تُعدّ', () => {
    assert.equal(formatCount(0), '0');
    assert.equal(formatCount(999), '999');
    assert.equal(formatCount(1500), '1.5 ألف');
    assert.equal(formatCount(25000), '25 ألف');
    assert.equal(formatCount(1200000), '1.2 مليون');
});
