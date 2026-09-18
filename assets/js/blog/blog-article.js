/**
 * blog-article.js — قارئ المقال.
 *
 * ثلاثة قرارات تستحق الشرح:
 *
 *   ① **المتن لا يُحقَن خامًا.** كل ما يُعرض يمرّ بـrenderArticleHtml في
 *      blog-model.js، وهي تهرب كل نص وتكتب الوسوم بنفسها. المتن يكتبه
 *      الطاقم، وهذا ليس سببًا كافيًا: صفحة عامة + HTML خام = أي فقرة
 *      مُلصَقة من مصدر خارجي تصير شفرة تعمل عند كل زائر.
 *
 *   ② **«غير موجود» و«غير منشور» رسالتان مختلفتان.** القاعدة تعيد null في
 *      الحالتين للزائر (وهو الصحيح أمنيًا — لا نكشف وجود مسودّة)، لكن
 *      الطاقم يستقبل الصف كاملًا، فيرى رسالته الخاصة: «هذا المقال مسودّة».
 *      الفرق يأتي من RLS لا من فحص رتبة هنا.
 *
 *   ③ **عدّاد المشاهدة يُنادى مرة واحدة لكل مقال في الجلسة.** بلا ذلك،
 *      إعادة تحميل الصفحة عشر مرات تصير عشر قراءات، فيصير العدّاد كذبة
 *      مهذّبة. sessionStorage يكفي: لا نحتاج دقة تحليلية، نحتاج ألّا نكذب.
 */

import { fetchPost, fetchRelated, countView } from '/assets/js/blog/blog-data.js';
import {
    escapeHtml, renderArticleHtml, tableOfContents, formatDate, relativeDate,
    formatCount, deriveExcerpt, postState, POST_STATES, documentTitle,
    metaDescription, shareLinks, articleJsonLd
} from '/assets/js/blog/blog-model.js';

const $ = (id) => document.getElementById(id);
const VIEWED_KEY = 'mad3oom-blog-viewed';

document.addEventListener('DOMContentLoaded', init);

async function init() {
    const slug = new URLSearchParams(window.location.search).get('slug');

    if (!slug) {
        renderState('error', 'لا مقال محدَّد', 'الرابط لا يحمل معرّف مقال.');
        return;
    }

    renderLoading();

    const result = await fetchPost(slug);

    if (!result.ok) {
        renderState('error', 'تعذّر تحميل المقال', result.error);
        return;
    }
    if (!result.data) {
        renderState('empty', 'هذا المقال غير متاح',
            'ربما غُيّر رابطه أو أُخرج من النشر. تصفّح المدوّنة لعلّك تجد ما تبحث عنه.');
        return;
    }

    renderPost(result.data);

    // ما بعد الرسم: لا شيء منها يعطّل ظهور المقال لو فشل.
    loadRelated(slug);
    countOnce(slug);
}

/* =========================================================
   حالات الصفحة
========================================================= */

function renderLoading() {
    $('blogPostState').innerHTML = `
        <div class="blog-article">
            <div class="skeleton skeleton-line" style="width: 40%;"></div>
            <div class="skeleton skeleton-card" style="margin: 1rem 0;"></div>
            <div class="skeleton skeleton-line"></div>
            <div class="skeleton skeleton-line"></div>
            <div class="skeleton skeleton-line"></div>
        </div>`;
}

function renderState(variant, title, text) {
    $('blogArticleLayout').hidden = true;
    $('blogPostState').innerHTML = `
        <div class="state-block ${variant === 'error' ? 'state-block--error' : ''}">
            <p class="state-title">${escapeHtml(title)}</p>
            <p class="state-text">${escapeHtml(text || '')}</p>
            <a class="btn btn-secondary" href="/blog/">تصفّح المدوّنة</a>
        </div>`;
}

/* =========================================================
   المقال
========================================================= */

function renderPost(post) {
    $('blogPostState').innerHTML = '';
    $('blogArticleLayout').hidden = false;

    applyHead(post);
    renderEditorBar(post);

    $('postTitle').textContent = post.title;

    const subtitle = $('postSubtitle');
    subtitle.textContent = post.subtitle || '';
    subtitle.hidden = !post.subtitle;

    const category = post.category;
    const chip = $('postCategoryChip');
    if (category?.slug) {
        chip.textContent = category.name;
        chip.href = `/blog/?category=${encodeURIComponent(category.slug)}`;
        chip.hidden = false;
    } else {
        chip.hidden = true;
    }

    renderByline(post);
    renderCover(post);
    renderBody(post);
    renderTags(post);
    renderShare(post);
}

function renderByline(post) {
    const author = post.author_name || 'فريق مدعوم';
    $('postAvatar').textContent = author.trim().charAt(0) || 'م';
    $('postAuthor').textContent = author;
    $('postAuthorTitle').textContent = post.author_title || '';

    const state = postState(post);
    const parts = [];

    // المجدول يقول موعده لا «منذ كذا»: تاريخ في المستقبل مكتوبًا بصيغة
    // الماضي يربك المحرّر الذي يراه.
    if (state === POST_STATES.scheduled) parts.push(`يُنشر في ${formatDate(post.published_at)}`);
    else if (post.published_at) parts.push(formatDate(post.published_at));

    parts.push(`${post.reading_minutes || 1} دقيقة قراءة`);
    if (post.view_count > 0) parts.push(`${formatCount(post.view_count)} قراءة`);

    // «حُدِّث مؤخّرًا» يُعرض حين يبتعد التحديث عن النشر بيوم فأكثر — وإلا
    // فكل مقال سيحمل الملاحظة بلا معنى لأن الحفظ الأول يلمس updated_at.
    if (post.updated_at && post.published_at) {
        const gap = new Date(post.updated_at) - new Date(post.published_at);
        if (gap > 86400000) parts.push(`حُدِّث ${relativeDate(post.updated_at)}`);
    }

    $('postMeta').textContent = parts.join(' · ');
}

function renderCover(post) {
    const figure = $('postCover');
    if (!post.cover_url) { figure.hidden = true; return; }

    const img = $('postCoverImg');
    img.src = post.cover_url;
    img.alt = post.cover_alt || post.title || '';
    figure.hidden = false;
}

function renderBody(post) {
    $('postBody').innerHTML = renderArticleHtml(post.content);

    const headings = tableOfContents(post.content);
    if (!headings.length) {
        $('postAside').hidden = true;
        $('postTocInline').hidden = true;
        return;
    }

    const items = headings.map(h => `
        <li data-level="${h.level}">
            <a href="#${encodeURIComponent(h.id)}" data-toc="${escapeHtml(h.id)}">${escapeHtml(h.text)}</a>
        </li>`).join('');

    $('postTocList').innerHTML = items;
    $('postTocInlineList').innerHTML = items;
    $('postAside').hidden = false;
    $('postTocInline').hidden = false;

    wireReadingProgress(headings);
}

function renderTags(post) {
    const tags = Array.isArray(post.tags) ? post.tags : [];
    $('postTags').innerHTML = tags.map(tag =>
        `<a class="blog-tag" href="/blog/?tag=${encodeURIComponent(tag)}">#${escapeHtml(tag)}</a>`
    ).join('');
}

function renderShare(post) {
    const url = window.location.href;
    const buttons = shareLinks(post, url).map(link => `
        <a class="blog-share-btn" href="${escapeHtml(link.href)}" target="_blank" rel="noopener noreferrer">
            ${escapeHtml(link.label)}
        </a>`).join('');

    $('postShare').innerHTML = `
        <span class="blog-share-label">شارك المقال</span>
        ${buttons}
        <button type="button" class="blog-share-btn" id="copyLinkBtn">نسخ الرابط</button>`;

    $('copyLinkBtn').addEventListener('click', async (event) => {
        const button = event.currentTarget;
        try {
            await navigator.clipboard.writeText(url);
            button.textContent = 'نُسخ ✓';
        } catch {
            // الحافظة محجوبة (سياق غير آمن أو رفض المستخدم): نختار الرابط
            // بدل أن نعد بنسخ لم يحدث.
            button.textContent = 'انسخ من شريط العنوان';
        }
        setTimeout(() => { button.textContent = 'نسخ الرابط'; }, 2200);
    });
}

/* =========================================================
   رأس الصفحة: عنوان ووصف وبيانات منظَّمة
========================================================= */

function applyHead(post) {
    document.title = documentTitle(post);

    setMeta('name', 'description', metaDescription(post));
    setMeta('property', 'og:title', post.title);
    setMeta('property', 'og:description', metaDescription(post));
    setMeta('property', 'og:url', window.location.href);
    if (post.cover_url) setMeta('property', 'og:image', absoluteUrl(post.cover_url));

    setCanonical(window.location.href);

    // المسودّة والمجدول لا يُفهرسان: الرابط قد يُشارَك للمراجعة، ودخوله
    // فهرس البحث قبل النشر يعني نتيجةً عامةً لمحتوًى لم يُقرّ بعد.
    const live = postState(post) === POST_STATES.published;
    setMeta('name', 'robots', live ? 'index, follow' : 'noindex, nofollow');

    if (live) injectJsonLd(articleJsonLd(post, window.location.href));
}

function setMeta(attribute, key, value) {
    if (!value) return;
    let tag = document.head.querySelector(`meta[${attribute}="${key}"]`);
    if (!tag) {
        tag = document.createElement('meta');
        tag.setAttribute(attribute, key);
        document.head.appendChild(tag);
    }
    tag.setAttribute('content', value);
}

function setCanonical(href) {
    let link = document.head.querySelector('link[rel="canonical"]');
    if (!link) {
        link = document.createElement('link');
        link.rel = 'canonical';
        document.head.appendChild(link);
    }
    link.href = href;
}

function injectJsonLd(data) {
    if (!data) return;
    const script = document.createElement('script');
    script.type = 'application/ld+json';
    script.textContent = JSON.stringify(data);
    document.head.appendChild(script);
}

function absoluteUrl(url) {
    try { return new URL(url, window.location.origin).href; } catch { return url; }
}

/* =========================================================
   شريط المحرّر
========================================================= */

/**
 * يظهر حين يكون المقال غير منشور — وهو ما لا يصل إلا لمن تسمح له RLS.
 * الزائر لا يستقبل الصف أصلًا، فالشريط لا يمكن أن يظهر له.
 */
function renderEditorBar(post) {
    const bar = $('blogEditorBar');
    const state = postState(post);

    if (state === POST_STATES.published) { bar.hidden = true; return; }

    $('blogEditorBarText').textContent =
        `هذا المقال ${state.label} — ${state.hint}. أنت تراه بصلاحية تحرير، والزائر لا يراه.`;
    $('blogEditorBarLink').href = `/admin/blog.html?edit=${encodeURIComponent(post.id)}`;
    bar.hidden = false;
}

/* =========================================================
   المقالات ذات الصلة
========================================================= */

async function loadRelated(slug) {
    const result = await fetchRelated(slug, 3);
    if (!result.ok || !result.data.length) return;

    $('postRelated').innerHTML = result.data.map(post => `
        <a class="blog-card" href="/blog/post.html?slug=${encodeURIComponent(post.slug)}">
            <div class="blog-card-media"${post.cover_url ? '' : ` data-fallback="${escapeHtml(String(post.title || '؟').charAt(0))}"`}>
                ${post.cover_url ? `<img src="${escapeHtml(post.cover_url)}" alt="" loading="lazy">` : ''}
            </div>
            <div class="blog-card-body">
                ${post.category_name ? `<span class="article-card-category">${escapeHtml(post.category_name)}</span>` : ''}
                <h3 class="blog-card-title">${escapeHtml(post.title)}</h3>
                <p class="blog-card-excerpt">${escapeHtml(post.excerpt || deriveExcerpt(post.title, 120))}</p>
                <div class="blog-card-meta">
                    <span>${escapeHtml(relativeDate(post.published_at))}</span>
                    <span class="sep">·</span>
                    <span>${post.reading_minutes || 1} دقيقة</span>
                </div>
            </div>
        </a>`).join('');

    $('postRelatedPanel').hidden = false;
}

/* =========================================================
   عدّاد المشاهدة
========================================================= */

function countOnce(slug) {
    let viewed = [];
    try {
        viewed = JSON.parse(sessionStorage.getItem(VIEWED_KEY) || '[]');
    } catch { /* التخزين غير متاح (وضع خاص) — نعدّ مرة واحدة لهذه الصفحة */ }

    if (viewed.includes(slug)) return;

    countView(slug);

    try {
        sessionStorage.setItem(VIEWED_KEY, JSON.stringify([...viewed, slug].slice(-50)));
    } catch { /* لا تخزين: العدّاد قد يتكرر عند إعادة التحميل، ولا ضرر أبعد */ }
}

/* =========================================================
   تقدّم القراءة والفهرس النشط
========================================================= */

function wireReadingProgress(headings) {
    const bar = $('blogProgress')?.querySelector('i');
    const body = $('postBody');
    if (!bar || !body) return;

    const links = [...document.querySelectorAll('[data-toc]')];
    let ticking = false;

    const update = () => {
        ticking = false;

        const start = body.offsetTop;
        const height = body.offsetHeight - window.innerHeight;
        const scrolled = window.scrollY - start;
        const percent = height > 0 ? Math.min(100, Math.max(0, (scrolled / height) * 100)) : 0;
        bar.style.width = `${percent}%`;

        // العنوان النشط: آخر عنوان تجاوزه المستخدم. الحساب من أعلى الشاشة
        // بإزاحة الشريط الثابت، فالعنوان الملاصق للشريط يُحسب مقروءًا.
        const offset = 120;
        let currentId = headings[0]?.id;
        for (const heading of headings) {
            const element = document.getElementById(heading.id);
            if (element && element.getBoundingClientRect().top <= offset) currentId = heading.id;
        }

        for (const link of links) {
            link.classList.toggle('is-current', link.dataset.toc === currentId);
        }
    };

    window.addEventListener('scroll', () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(update);
    }, { passive: true });

    update();
}
