/**
 * blog-model.js — لغة المدوّنة: دوال خالصة، بلا DOM وبلا شبكة.
 *
 * كل ما هنا يُختبَر وحده في tests/blog-model.test.mjs، ولذلك بالضبط هو هنا
 * وليس داخل صفحة: العرض يتغيّر كثيرًا، وقواعد «كيف يُبنى الـslug» و«ماذا
 * يُسمح في المتن» و«متى يُعتبر المقال جاهزًا للنشر» لا يجوز أن تتغيّر لأن
 * أحدًا أعاد ترتيب بطاقة في الصفحة.
 *
 * ثلاث قواعد تحكم الملف:
 *
 *   ① لا نحقن HTML خامًا أبدًا. متن المقال يكتبه الطاقم، وهذا ليس سببًا
 *     كافيًا: مقال واحد مُلصَق من مصدر خارجي يصير سكربتًا شغّالًا في صفحة
 *     عامة. نهرب كل شيء وندعم مجموعة تنسيق صغيرة مقصودة — نفس عقيدة
 *     help-article-model.js، وموسَّعة هنا لما تحتاجه المدوّنة (اقتباس،
 *     كتلة كود، صورة، رابط، قائمة مرقّمة، تشديد).
 *
 *   ② الروابط في المتن تُفلتَر بالمخطَّط (scheme). `javascript:` و`data:`
 *     مرفوضان، فوسم <a> لا يصير ناقلًا لتنفيذ.
 *
 *   ③ ما تحسبه القاعدة لا نعيد حسابه هنا. زمن القراءة يأتي من الصف
 *     (reading_minutes) لأنه محسوب في محفّز؛ والدالة الموجودة هنا للمعاينة
 *     الحيّة في لوحة التحرير قبل الحفظ وحدها، وهي تستخدم نفس المعادلة
 *     (٢٠٠ كلمة/دقيقة) عمدًا حتى لا يتغيّر الرقم لحظة الحفظ.
 */

/* =========================================================
   أساسيات
========================================================= */

export function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * محارف لا تدخل الـslug المُولَّد.
 *
 * أوسع من قيد القاعدة عن قصد. القيد هناك قائمة منع ASCII (ما يكسر المسار
 * أو الاستعلام فعلًا)، وهذه قائمة **توليد**: علامات الترقيم العربية
 * (؟ ، ؛ ٪ …) تمرّ من القيد لأنها لا تكسر شيئًا تقنيًا، لكن تركها في رابط
 * مُولَّد ينتج `…cloud-api؟` — رابطًا صحيحًا وقبيحًا. التوليد يُنظّف،
 * والقيد يحرس؛ ولذلك isValidSlug أدناه يطابق القيد لا هذه القائمة: محرّر
 * كتب slug بيده لا يُرفض لأن مولّدنا كان سيكتبه بشكل آخر.
 */
const SLUG_FORBIDDEN = /[\s/?#&=%.:,;!"'()[\]{}<>@$^*+~`|\\،؛؟٪٫٬٭ـ«»‐-‧‰-⁞]+/g;

/**
 * يبني slug من العنوان.
 *
 * الحروف العربية تبقى كما هي عن قصد: الـslug العربي رابط صحيح تمامًا
 * (يُرمَّز بـpercent-encoding عند الطلب) وتقرأه محرّكات البحث، بينما نقحرته
 * إلى لاتينية تنتج روابط لا يفهمها قارئ ولا محرّك. القاعدة تقبله لأن قيدها
 * قائمة منع لا قائمة سماح.
 */
export function slugify(input, { maxLength = 120 } = {}) {
    const base = String(input || '')
        .trim()
        .toLowerCase()
        .replace(/[ً-ْٰ]/g, '')   // إسقاط التشكيل
        .replace(SLUG_FORBIDDEN, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^-+|-+$/g, '');

    return base.slice(0, maxLength).replace(/-+$/g, '');
}

/** هل الـslug مقبول في القاعدة؟ نفس شروط blog_posts_slug_shape. */
export function isValidSlug(slug) {
    const value = String(slug || '');
    if (value.length < 2 || value.length > 120) return false;
    if (value !== value.toLowerCase().trim()) return false;
    if (/[\s/?#&=%.]/.test(value)) return false;
    if (value.startsWith('-') || value.endsWith('-')) return false;
    return true;
}

/**
 * توحيد الوسوم: قصّ، توحيد الحالة، إسقاط الفارغ والمكرّر — نفس ما يفعله
 * المحفّز، فما يراه المحرّر في المعاينة هو ما سيُحفَظ.
 *
 * الترتيب هنا للثبات البصري وحده (حتى لا ترقص الشرائح بين رسمتين)، لا
 * ادّعاء بمطابقة ترتيب القاعدة: ذاك يتبع ترتيب المحارف (collation) الخاص
 * بالعنقود. وهو لا يهمّ عمليًا لأن الصف يُعاد قراءته بعد الحفظ، فالترتيب
 * المعروض بعدها ترتيب القاعدة على كل حال.
 */
export function normalizeTags(tags) {
    const list = Array.isArray(tags)
        ? tags
        : String(tags || '').split(/[,،\n]/);

    const seen = new Set();
    for (const raw of list) {
        const value = String(raw || '').trim().toLowerCase();
        if (value) seen.add(value);
    }
    return [...seen].sort();
}

/** عدد الكلمات بنفس تقريب القاعدة (إسقاط علامات التنسيق ثم القسمة على الفراغ). */
export function wordCount(content) {
    const plain = String(content || '').replace(/[#*_`>-]+/g, ' ').trim();
    if (!plain) return 0;
    return plain.split(/\s+/).length;
}

/** ٢٠٠ كلمة/دقيقة، وبحدّ أدنى دقيقة — «٠ دقيقة» ليست معلومة. */
export function readingMinutes(content) {
    return Math.max(1, Math.ceil(wordCount(content) / 200));
}

/**
 * مقتطف مشتق من المتن حين لا يكتبه المحرّر.
 * نقطع عند حدّ كلمة لا في منتصفها، فالبطاقة لا تعرض «الاشترا…».
 */
export function deriveExcerpt(content, limit = 180) {
    const plain = String(content || '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[#>*_`-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (plain.length <= limit) return plain;
    const cut = plain.slice(0, limit);
    const lastSpace = cut.lastIndexOf(' ');
    return `${(lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

/* =========================================================
   التواريخ والأرقام
========================================================= */

export function formatDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleDateString('ar-EG', { year: 'numeric', month: 'long', day: 'numeric' });
}

export function formatDateTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString('ar-EG', { dateStyle: 'medium', timeStyle: 'short' });
}

/** «منذ ٣ أيام» للمقالات الحديثة، وتاريخ كامل لما قدُم — الحداثة معلومة مفيدة. */
export function relativeDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';

    const days = Math.floor((Date.now() - date.getTime()) / 86400000);
    if (days < 0) return formatDate(value);
    if (days === 0) return 'اليوم';
    if (days === 1) return 'أمس';
    if (days < 7) return `منذ ${days} أيام`;
    if (days < 30) return `منذ ${Math.floor(days / 7)} أسابيع`;
    return formatDate(value);
}

export function formatCount(value) {
    const number = Number(value) || 0;
    if (number < 1000) return String(number);
    if (number < 1000000) return `${(number / 1000).toFixed(number < 10000 ? 1 : 0)} ألف`;
    return `${(number / 1000000).toFixed(1)} مليون`;
}

/* =========================================================
   المتن: تفكيك آمن
========================================================= */

const RE_HEADING   = /^\s{0,3}(#{2,4})\s+(.+)$/;
const RE_UL        = /^\s{0,3}[-*]\s+(.+)$/;
const RE_OL        = /^\s{0,3}\d+[.)]\s+(.+)$/;
const RE_QUOTE     = /^\s{0,3}>\s?(.*)$/;
const RE_FENCE     = /^\s{0,3}```\s*([A-Za-z0-9+#-]*)\s*$/;
const RE_RULE      = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const RE_IMAGE     = /^\s{0,3}!\[([^\]]*)\]\(([^)\s]+)\)\s*$/;

/** روابط مسموحة فقط: نسبي، أو http(s)، أو mailto/tel. لا javascript: ولا data:. */
export function safeUrl(value) {
    const url = String(value || '').trim();
    if (!url) return '';
    if (/^(?:https?:|mailto:|tel:)/i.test(url)) return url;
    if (/^[/#]/.test(url)) return url;            // مسار داخلي أو مرساة
    return '';
}

/**
 * يفكّ متن المقال إلى كتل + فهرس عناوين.
 *
 * ما يُدعم عن قصد: `## عنوان`، قوائم منقّطة ومرقّمة، اقتباس `>`، كتلة كود
 * ```‎، فاصل `---`، صورة `![وصف](رابط)`، وفقرات. أي شيء آخر نصٌّ عادي —
 * لا وسم مجهول يمرّ.
 */
export function parseArticle(content) {
    const lines = String(content || '').replace(/\r\n?/g, '\n').split('\n');
    const blocks = [];
    const headings = [];

    let paragraph = [];
    let list = null;          // { ordered, items }
    let quote = [];
    let fence = null;         // { lang, lines }

    const flushParagraph = () => {
        if (paragraph.length) {
            blocks.push({ type: 'paragraph', text: paragraph.join(' ').trim() });
            paragraph = [];
        }
    };
    const flushList = () => {
        if (list && list.items.length) blocks.push({ type: 'list', ...list });
        list = null;
    };
    const flushQuote = () => {
        if (quote.length) {
            blocks.push({ type: 'quote', text: quote.join(' ').trim() });
            quote = [];
        }
    };
    const flushAll = () => { flushParagraph(); flushList(); flushQuote(); };

    for (const line of lines) {
        // كتلة الكود تبتلع كل شيء حتى سياجها المقابل — وإلا فسّرنا شفرة
        // المستخدم كتنسيق وكسرناها.
        const fenceMark = line.match(RE_FENCE);
        if (fence) {
            if (fenceMark) {
                blocks.push({ type: 'code', lang: fence.lang, text: fence.lines.join('\n') });
                fence = null;
            } else {
                fence.lines.push(line);
            }
            continue;
        }
        if (fenceMark) {
            flushAll();
            fence = { lang: fenceMark[1] || '', lines: [] };
            continue;
        }

        const image = line.match(RE_IMAGE);
        if (image) {
            flushAll();
            const src = safeUrl(image[2]);
            if (src) blocks.push({ type: 'image', alt: image[1] || '', src });
            continue;
        }

        if (RE_RULE.test(line)) { flushAll(); blocks.push({ type: 'rule' }); continue; }

        const heading = line.match(RE_HEADING);
        if (heading) {
            flushAll();
            const level = Math.min(heading[1].length, 4);
            const text = heading[2].trim();
            const id = headingId(text, headings.length);
            headings.push({ id, text, level });
            blocks.push({ type: 'heading', level, text, id });
            continue;
        }

        const quoted = line.match(RE_QUOTE);
        if (quoted) { flushParagraph(); flushList(); quote.push(quoted[1].trim()); continue; }

        const ordered = line.match(RE_OL);
        const bullet = line.match(RE_UL);
        if (ordered || bullet) {
            flushParagraph(); flushQuote();
            const wantsOrdered = Boolean(ordered);
            if (!list || list.ordered !== wantsOrdered) { flushList(); list = { ordered: wantsOrdered, items: [] }; }
            list.items.push((ordered ? ordered[1] : bullet[1]).trim());
            continue;
        }

        if (!line.trim()) { flushAll(); continue; }

        flushList(); flushQuote();
        paragraph.push(line.trim());
    }

    // سياج لم يُغلق: نعرض ما جُمع كتلةَ كود بدل أن نبتلع بقية المقال صامتين.
    if (fence) blocks.push({ type: 'code', lang: fence.lang, text: fence.lines.join('\n') });
    flushAll();

    return { blocks, headings };
}

function headingId(text, index) {
    const slug = String(text)
        .trim()
        .replace(/[^\p{L}\p{N}\s-]/gu, '')
        .replace(/\s+/g, '-')
        .slice(0, 60);
    return `sec-${index}-${slug || 'part'}`;
}

/**
 * تنسيق داخل السطر — يعمل على نصٍّ **مهروب مسبقًا**.
 *
 * الترتيب مقصود: الكود المضمّن أولًا، فلا يُفسَّر ما بداخله كتشديد أو رابط.
 * ولا يُسمح بأي وسم إلا الذي نكتبه نحن هنا.
 */
export function renderInline(text) {
    let html = escapeHtml(text);

    const codeSlots = [];
    html = html.replace(/`([^`]+)`/g, (_match, code) => {
        codeSlots.push(`<code class="blog-code-inline">${code}</code>`);
        return `\u0000${codeSlots.length - 1}\u0000`;
    });

    html = html
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[\s(])_([^_]+)_(?=[\s).,،:!?]|$)/g, '$1<em>$2</em>');

    // النص هنا مهروب، فالقوس في [نص](رابط) لا يمكن أن يكون وسمًا.
    html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, href) => {
        const url = safeUrl(href.replace(/&amp;/g, '&'));
        if (!url) return label;
        const external = /^https?:/i.test(url) && !url.includes('mad3oom');
        const attrs = external ? ' target="_blank" rel="noopener noreferrer nofollow"' : '';
        return `<a href="${escapeHtml(url)}"${attrs}>${label}</a>`;
    });

    return html.replace(/\u0000(\d+)\u0000/g, (_match, index) => codeSlots[Number(index)]);
}

/** HTML آمن لمتن المقال — كل نص مهروب، وكل وسم من عندنا. */
export function renderArticleHtml(content) {
    const { blocks } = parseArticle(content);

    return blocks.map(block => {
        switch (block.type) {
            case 'heading':
                return `<h${block.level} id="${escapeHtml(block.id)}" class="blog-heading">`
                     + `${renderInline(block.text)}</h${block.level}>`;
            case 'list': {
                const tag = block.ordered ? 'ol' : 'ul';
                const items = block.items.map(i => `<li>${renderInline(i)}</li>`).join('');
                return `<${tag} class="blog-list">${items}</${tag}>`;
            }
            case 'quote':
                return `<blockquote class="blog-quote">${renderInline(block.text)}</blockquote>`;
            case 'code':
                return `<pre class="blog-code"><code>${escapeHtml(block.text)}</code></pre>`;
            case 'image':
                return `<figure class="blog-figure">`
                     + `<img src="${escapeHtml(block.src)}" alt="${escapeHtml(block.alt)}" loading="lazy">`
                     + (block.alt ? `<figcaption>${escapeHtml(block.alt)}</figcaption>` : '')
                     + `</figure>`;
            case 'rule':
                return '<hr class="blog-rule">';
            default:
                return `<p>${renderInline(block.text)}</p>`;
        }
    }).join('');
}

/** الفهرس يظهر للمقالات الطويلة وحدها — عنوانان فأكثر. */
export function tableOfContents(content) {
    const { headings } = parseArticle(content);
    return headings.length >= 2 ? headings : [];
}

/* =========================================================
   حالة المقال — لغة واحدة للوحة وللصفحة
========================================================= */

export const POST_STATES = Object.freeze({
    draft:     { label: 'مسودّة',  pill: 'status-neutral',  hint: 'لا يظهر لأحد خارج اللوحة' },
    scheduled: { label: 'مجدول',   pill: 'status-in-progress', hint: 'يُنشر تلقائيًا في موعده' },
    published: { label: 'منشور',   pill: 'status-resolved',  hint: 'ظاهر على الإنترنت للجميع' },
    archived:  { label: 'مؤرشف',   pill: 'status-rejected',  hint: 'أُخرج من الفهرس ولا يظهر' }
});

/**
 * الحالة المعروضة مشتقّة، لا مخزَّنة.
 *
 * القاعدة تعرف ثلاث حالات (draft/published/archived)، و«مجدول» ليست رابعة:
 * هي مقال منشور بتاريخ لم يحن. تخزينها كحالة رابعة كان سيستلزم مهمة دورية
 * تحوّلها إلى published — ونقطة فشل جديدة. الاشتقاق يجعل الجدولة تعمل بلا
 * أي جدولة.
 */
export function postState(post) {
    if (!post) return POST_STATES.draft;
    if (post.status === 'archived') return POST_STATES.archived;
    if (post.status === 'draft') return POST_STATES.draft;
    if (post.published_at && new Date(post.published_at).getTime() > Date.now()) {
        return POST_STATES.scheduled;
    }
    return POST_STATES.published;
}

export function isLivePost(post) {
    return postState(post) === POST_STATES.published;
}

/* =========================================================
   التحقّق قبل الحفظ
========================================================= */

const REQUIRED_TO_PUBLISH = 220;   // حرفًا — أقصر من ذلك ليس مقالًا

/**
 * يتحقّق من نموذج المقال قبل إرساله.
 *
 * الشروط الصارمة (العنوان، الـslug، المتن) تمنع الحفظ. وشروط النشر أعلى:
 * مقال بلا مقتطف ولا تصنيف يُحفظ مسودّةً بلا اعتراض، ولا يُنشر — لأن ما
 * ينقصه لا يظهر في اللوحة بل في نتيجة البحث وبطاقة المشاركة.
 */
export function validatePost(values = {}) {
    const errors = {};
    const warnings = [];

    const title = String(values.title || '').trim();
    const slug = String(values.slug || '').trim();
    const content = String(values.content || '').trim();

    if (!title) errors.title = 'العنوان مطلوب.';
    else if (title.length > 160) errors.title = 'العنوان أطول من 160 حرفًا.';

    if (!slug) errors.slug = 'الرابط المختصر مطلوب.';
    else if (!isValidSlug(slug)) {
        errors.slug = 'الرابط المختصر يقبل الحروف والأرقام والشرطة فقط، بلا فراغات أو علامات.';
    }

    if (!content) errors.content = 'متن المقال مطلوب.';

    if (values.cover_url && !safeUrl(values.cover_url)) {
        errors.cover_url = 'رابط الغلاف يجب أن يبدأ بـhttps:// أو بمسار داخلي.';
    }

    if (values.publish_at && Number.isNaN(new Date(values.publish_at).getTime())) {
        errors.publish_at = 'تاريخ النشر غير صالح.';
    }

    const wantsPublish = values.status === 'published';
    if (wantsPublish) {
        if (content.length < REQUIRED_TO_PUBLISH) {
            errors.content = `المتن أقصر من أن يُنشر (${content.length} حرفًا، والحدّ ${REQUIRED_TO_PUBLISH}). احفظه مسودّة وأكمله.`;
        }
        if (!String(values.excerpt || '').trim()) {
            warnings.push('بلا مقتطف: ستأخذ نتيجة البحث وبطاقة المشاركة أول سطر من المتن.');
        }
        if (!values.category_id) {
            warnings.push('بلا تصنيف: المقال لن يظهر في تصفّح المدوّنة حسب الموضوع.');
        }
        if (!values.cover_url) {
            warnings.push('بلا صورة غلاف: البطاقة ستُعرض بخلفية بديلة.');
        }
    }

    return { valid: Object.keys(errors).length === 0, errors, warnings };
}

/**
 * جاهزية المقال كنسبة — مؤشّر تحريري لا حارس.
 * الغرض أن يرى المحرّر ما ينقص قبل أن ينشر، لا أن يُمنع.
 */
export function editorialScore(values = {}) {
    const checks = [
        { key: 'title',    label: 'عنوان واضح',        ok: String(values.title || '').trim().length >= 8 },
        { key: 'excerpt',  label: 'مقتطف للبحث',       ok: String(values.excerpt || '').trim().length >= 40 },
        { key: 'cover',    label: 'صورة غلاف',         ok: Boolean(values.cover_url) },
        { key: 'category', label: 'تصنيف',             ok: Boolean(values.category_id) },
        { key: 'tags',     label: 'وسم واحد على الأقل', ok: normalizeTags(values.tags).length > 0 },
        { key: 'depth',    label: 'متن كافٍ (٣٠٠ كلمة+)', ok: wordCount(values.content) >= 300 },
        { key: 'structure',label: 'عناوين داخلية',      ok: tableOfContents(values.content).length >= 2 },
        { key: 'seo',      label: 'وصف SEO',           ok: String(values.seo_description || '').trim().length >= 50 }
    ];

    const done = checks.filter(c => c.ok).length;
    return { checks, done, total: checks.length, percent: Math.round((done / checks.length) * 100) };
}

/* =========================================================
   عنوان المتصفّح وبطاقات المشاركة
========================================================= */

/** عنوان الصفحة: seo_title إن وُجد، وإلا العنوان — بلا تكرار اسم المنصة مرتين. */
export function documentTitle(post) {
    const base = String(post?.seo_title || post?.title || 'المدوّنة').trim();
    return base.includes('مدعوم') ? base : `${base} | مدوّنة مدعوم`;
}

export function metaDescription(post) {
    const value = String(post?.seo_description || post?.excerpt || '').trim();
    return value || deriveExcerpt(post?.content, 160);
}

/**
 * روابط المشاركة. لا سكربتات طرف ثالث: زر مشاركة من شبكة اجتماعية يعني
 * تتبّعًا لكل قارئ على صفحة عامة. الرابط العادي يؤدّي الغرض بلا ذلك.
 */
export function shareLinks(post, pageUrl) {
    const url = encodeURIComponent(String(pageUrl || ''));
    const text = encodeURIComponent(String(post?.title || ''));
    return [
        { key: 'whatsapp', label: 'واتساب', href: `https://wa.me/?text=${text}%20${url}` },
        { key: 'x',        label: 'X',      href: `https://twitter.com/intent/tweet?text=${text}&url=${url}` },
        { key: 'linkedin', label: 'لينكدإن', href: `https://www.linkedin.com/sharing/share-offsite/?url=${url}` }
    ];
}

/** بيانات Schema.org — ما يجعل المقال يظهر كمقال في نتائج البحث لا كصفحة. */
export function articleJsonLd(post, pageUrl) {
    if (!post) return null;
    return {
        '@context': 'https://schema.org',
        '@type': 'BlogPosting',
        headline: String(post.title || '').slice(0, 110),
        description: metaDescription(post),
        image: post.cover_url ? [post.cover_url] : undefined,
        datePublished: post.published_at || undefined,
        dateModified: post.updated_at || post.published_at || undefined,
        author: { '@type': 'Person', name: post.author_name || 'فريق مدعوم' },
        publisher: {
            '@type': 'Organization',
            name: 'منصة مدعوم',
            logo: { '@type': 'ImageObject', url: 'https://mad3oom.com/logo.png' }
        },
        mainEntityOfPage: { '@type': 'WebPage', '@id': pageUrl || undefined },
        wordCount: post.word_count || wordCount(post.content),
        inLanguage: 'ar'
    };
}

/* =========================================================
   الترقيم
========================================================= */

export const PAGE_SIZE = 9;

/**
 * حالة الترقيم من العدد الكلي الذي ترجّعه blog_feed مع الصفحة نفسها.
 * نافذة الأرقام محدودة بخمسة: صفحة بها ٤٠ رقمًا ليست تنقّلًا.
 */
export function paginationState(total, page, pageSize = PAGE_SIZE) {
    const size = Math.max(1, pageSize);
    const count = Math.max(0, Number(total) || 0);
    const pages = Math.max(1, Math.ceil(count / size));
    const current = Math.min(Math.max(1, Number(page) || 1), pages);

    const window = [];
    const from = Math.max(1, Math.min(current - 2, pages - 4));
    const to = Math.min(pages, Math.max(current + 2, 5));
    for (let i = from; i <= to; i += 1) window.push(i);

    return {
        page: current,
        pages,
        total: count,
        offset: (current - 1) * size,
        hasPrev: current > 1,
        hasNext: current < pages,
        window
    };
}
