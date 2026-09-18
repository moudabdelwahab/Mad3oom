/**
 * blog-index.js — فهرس المدوّنة العامة.
 *
 * الحالة كلها في **الرابط**، لا في متغيّر في الصفحة:
 *
 *     /blog/?q=قوالب&category=whatsapp-api&tag=جودة&page=2
 *
 * وهذا ليس تفصيلًا: القارئ الذي وصل لنتيجة بحث يستطيع مشاركتها، وزر الرجوع
 * يعمل، وإعادة التحميل تُبقيه حيث كان. الحالة في الذاكرة وحدها تكسر الثلاثة.
 *
 * ولا تفويض هنا البتة: الصفحة ترسم ما أعادته القاعدة. إن أعادت مسودّة فذلك
 * لأن المنادي من الطاقم — وهو ما يُشغِّل شريط المحرّر أسفلُ. فحص الرتبة في
 * المتصفح كان سيكون مصدر قرار ثانيًا يتفرّع عن السياسة عند أول تعديل.
 */

import {
    fetchFeed, fetchCategories, fetchTags
} from '/assets/js/blog/blog-data.js';
import {
    escapeHtml, relativeDate, formatCount, deriveExcerpt,
    postState, POST_STATES, paginationState, PAGE_SIZE
} from '/assets/js/blog/blog-model.js';

const $ = (id) => document.getElementById(id);

/** تأخير البحث: نداء لكل حرف يعني عشر رحلات شبكة لكلمة واحدة. */
const SEARCH_DEBOUNCE = 320;

let searchTimer = null;
let requestToken = 0;

/** آخر نتيجة رُسمت — تقرؤها التصنيفات حين تصل متأخّرةً عن الفهرس. */
let lastResult = { total: 0, featuredSlug: null };

document.addEventListener('DOMContentLoaded', init);

async function init() {
    wireSearch();
    wireNavigation();

    // التصنيفات والوسوم لا تتغيّر بتغيّر الصفحة، فتُحمَّل مرة واحدة بالتوازي
    // مع أول فهرس بدل أن تنتظره.
    loadSidebars();
    await render();
}

/* =========================================================
   قراءة الحالة من الرابط
========================================================= */

function currentState() {
    const params = new URLSearchParams(window.location.search);
    return {
        query: params.get('q')?.trim() || null,
        category: params.get('category') || null,
        tag: params.get('tag') || null,
        page: Math.max(1, Number(params.get('page')) || 1)
    };
}

/**
 * يكتب الحالة في الرابط ثم يعيد الرسم.
 *
 * pushState لا replaceState: كل تصفية خطوة يستطيع القارئ الرجوع عنها.
 * والاستثناء هو الكتابة في مربع البحث — تلك تُستبدَل حتى لا يمتلئ سجلّ
 * المتصفّح بثلاثين حالة لكلمة واحدة.
 */
function goTo(patch, { replace = false } = {}) {
    const state = { ...currentState(), ...patch };
    const params = new URLSearchParams();

    if (state.query) params.set('q', state.query);
    if (state.category) params.set('category', state.category);
    if (state.tag) params.set('tag', state.tag);
    if (state.page > 1) params.set('page', String(state.page));

    const url = params.toString() ? `?${params}` : window.location.pathname;
    if (replace) window.history.replaceState({}, '', url);
    else window.history.pushState({}, '', url);

    render();
}

function wireNavigation() {
    window.addEventListener('popstate', render);

    // تفويض واحد لكل ما ينقل: الشرائح والوسوم وأزرار الترقيم كلها تُرسَم
    // ديناميكيًا، فربط مستمع لكل عنصر بعد كل رسم كان سيسرّب مستمعين.
    document.addEventListener('click', (event) => {
        const filter = event.target.closest('[data-filter]');
        if (filter) {
            event.preventDefault();
            const { filter: kind, value } = filter.dataset;
            goTo({ [kind]: value || null, page: 1 });
            scrollToResults();
            return;
        }

        const pageBtn = event.target.closest('[data-page-to]');
        if (pageBtn) {
            event.preventDefault();
            goTo({ page: Number(pageBtn.dataset.pageTo) || 1 });
            scrollToResults();
            return;
        }

        const retry = event.target.closest('[data-retry="feed"]');
        if (retry) { event.preventDefault(); render(); }
    });
}

function scrollToResults() {
    const target = $('blogListHeading');
    if (!target) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    target.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
}

/* =========================================================
   البحث
========================================================= */

function wireSearch() {
    const input = $('blogSearchInput');
    const clear = $('blogSearchClear');
    if (!input) return;

    const state = currentState();
    if (state.query) { input.value = state.query; clear.hidden = false; }

    input.addEventListener('input', () => {
        clear.hidden = !input.value;
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
            goTo({ query: input.value.trim() || null, page: 1 }, { replace: true });
        }, SEARCH_DEBOUNCE);
    });

    // Enter يُلغي الانتظار: المستخدم أعلن أنه انتهى من الكتابة.
    input.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        clearTimeout(searchTimer);
        goTo({ query: input.value.trim() || null, page: 1 }, { replace: true });
    });

    clear.addEventListener('click', () => {
        input.value = '';
        clear.hidden = true;
        clearTimeout(searchTimer);
        goTo({ query: null, page: 1 });
        input.focus();
    });
}

/* =========================================================
   الرسم
========================================================= */

async function render() {
    const state = currentState();
    const list = $('blogList');

    syncSearchBox(state);
    markActiveChips(state);
    renderSkeleton(list);
    $('blogEmpty').innerHTML = '';
    $('blogPagination').innerHTML = '';

    // كل رسم يحمل رقمه: ردّ نداء قديم وصل بعد نداء أحدث يُهمَل بدل أن يدوس
    // على النتيجة الصحيحة — وهو ما يحدث فعلًا مع البحث السريع.
    const token = ++requestToken;

    const result = await fetchFeed({
        query: state.query,
        category: state.category,
        tag: state.tag,
        limit: PAGE_SIZE,
        offset: (state.page - 1) * PAGE_SIZE
    });

    if (token !== requestToken) return;

    list.setAttribute('aria-busy', 'false');

    if (!result.ok) {
        list.innerHTML = '';
        $('blogEmpty').innerHTML = `
            <div class="state-block state-block--error">
                <p class="state-title">تعذّر تحميل المقالات</p>
                <p class="state-text">${escapeHtml(result.error)}</p>
                <button type="button" class="btn btn-secondary" data-retry="feed">إعادة المحاولة</button>
            </div>`;
        return;
    }

    const { rows, total } = result.data;
    lastResult = { total, featuredSlug: null };

    renderEditorBar(rows);
    renderHeading(state, total);
    renderFeatured(state, rows);
    renderList(list, state, rows);
    renderPagination(total, state.page);
}

function syncSearchBox(state) {
    const input = $('blogSearchInput');
    if (input && document.activeElement !== input) {
        input.value = state.query || '';
        $('blogSearchClear').hidden = !input.value;
    }
}

function renderSkeleton(list) {
    list.setAttribute('aria-busy', 'true');
    list.innerHTML = Array.from({ length: 6 }, () => `
        <div class="blog-skeleton-card">
            <div class="blog-card-media skeleton"></div>
            <div class="blog-card-body">
                <div class="skeleton skeleton-line"></div>
                <div class="skeleton skeleton-line"></div>
            </div>
        </div>`).join('');
}

function renderHeading(state, total) {
    const title = $('blogListHeading');
    const subtitle = $('blogListSubtitle');

    if (state.query) title.textContent = `نتائج البحث عن «${state.query}»`;
    else if (state.tag) title.textContent = `مقالات موسومة بـ«${state.tag}»`;
    else if (state.category) title.textContent = categoryName(state.category);
    else title.textContent = 'أحدث المقالات';

    const filtered = Boolean(state.query || state.tag || state.category);
    subtitle.textContent = total === 0
        ? ''
        : `${total} ${total === 1 ? 'مقال' : 'مقالًا'}${filtered ? ' مطابقًا' : ''}`;
}

let categoryIndex = new Map();
function categoryName(slug) {
    return categoryIndex.get(slug)?.name || slug;
}

/**
 * المقال المميّز — في الحالة الافتراضية وحدها.
 * فوق نتيجة بحث يصير بطاقة لا علاقة لها بما طُلب.
 */
function renderFeatured(state, rows) {
    const host = $('blogFeatured');
    const isDefault = !state.query && !state.tag && !state.category && state.page === 1;
    const post = isDefault ? (rows.find(r => r.is_featured) || rows[0]) : null;

    if (!post) { host.innerHTML = ''; return; }

    lastResult.featuredSlug = post.slug;
    host.innerHTML = `
        <a class="blog-featured" href="/blog/post.html?slug=${encodeURIComponent(post.slug)}">
            <div class="blog-featured-media">${coverHtml(post)}</div>
            <div class="blog-featured-body">
                <span class="article-card-category">${escapeHtml(post.category_name || 'مقال مميّز')}</span>
                <h2>${escapeHtml(post.title)}</h2>
                <p>${escapeHtml(post.excerpt || deriveExcerpt(post.subtitle, 200))}</p>
                ${metaHtml(post)}
            </div>
        </a>`;
}

function renderList(list, state, rows) {
    // المقال المميّز معروض أعلاه، فعرضه مرة ثانية في الشبكة تكرار.
    const visible = lastResult.featuredSlug
        ? rows.filter(r => r.slug !== lastResult.featuredSlug)
        : rows;

    if (visible.length === 0) {
        list.innerHTML = '';
        renderEmpty(state);
        return;
    }

    list.innerHTML = visible.map(post => `
        <a class="blog-card" href="/blog/post.html?slug=${encodeURIComponent(post.slug)}">
            <div class="blog-card-media"${post.cover_url ? '' : ` data-fallback="${escapeHtml(firstLetter(post.title))}"`}>
                ${coverHtml(post)}
            </div>
            <div class="blog-card-body">
                ${post.category_name ? `<span class="article-card-category">${escapeHtml(post.category_name)}</span>` : ''}
                ${statePill(post)}
                <h3 class="blog-card-title">${escapeHtml(post.title)}</h3>
                <p class="blog-card-excerpt">${escapeHtml(post.excerpt || deriveExcerpt(post.subtitle, 150))}</p>
                ${metaHtml(post)}
            </div>
        </a>`).join('');
}

function firstLetter(title) {
    return String(title || '؟').trim().charAt(0) || '؟';
}

function coverHtml(post) {
    if (!post.cover_url) return '';
    return `<img src="${escapeHtml(post.cover_url)}" alt="${escapeHtml(post.cover_alt || '')}" loading="lazy">`;
}

function metaHtml(post) {
    const parts = [
        relativeDate(post.published_at),
        `${post.reading_minutes || 1} دقيقة قراءة`
    ];
    if (post.view_count > 0) parts.push(`${formatCount(post.view_count)} قراءة`);

    return `<div class="blog-card-meta">
        <span>${escapeHtml(post.author_name || 'فريق مدعوم')}</span>
        ${parts.map(p => `<span class="sep">·</span><span>${escapeHtml(p)}</span>`).join('')}
    </div>`;
}

/**
 * شارة الحالة تُرسَم للطاقم وحده — لأن الزائر لا تصله أصلًا إلا المقالات
 * المنشورة، فالشارة عنده ستكون دائمًا «منشور»: ضجيج بلا معلومة.
 */
function statePill(post) {
    const state = postState(post);
    if (state === POST_STATES.published) return '';
    return `<span class="pill ${state.pill}">${escapeHtml(state.label)}</span>`;
}

function renderEmpty(state) {
    const host = $('blogEmpty');
    const filtered = Boolean(state.query || state.tag || state.category);

    host.innerHTML = filtered
        ? `<div class="state-block">
               <p class="state-title">لا مقالات تطابق هذا البحث</p>
               <p class="state-text">جرّب كلمة أعمّ، أو تصفّح كل المواضيع.</p>
               <button type="button" class="btn btn-secondary" data-filter="category" data-value="">عرض كل المقالات</button>
           </div>`
        : `<div class="state-block">
               <p class="state-title">المدوّنة على وشك أن تبدأ</p>
               <p class="state-text">
                   لم يُنشر مقال بعد. حتى ذلك الحين، مركز المساعدة يجيب على أكثر الأسئلة تكرارًا.
               </p>
               <a class="btn btn-secondary" href="/knowledge-base.html">مركز المساعدة</a>
           </div>`;
}

function renderPagination(total, page) {
    const host = $('blogPagination');
    const state = paginationState(total, page);

    if (state.pages <= 1) { host.innerHTML = ''; return; }

    const button = (label, target, { disabled = false, current = false, aria } = {}) => `
        <button type="button" class="blog-page-btn${current ? ' is-current' : ''}"
                data-page-to="${target}"${disabled ? ' disabled' : ''}
                ${current ? ' aria-current="page"' : ''}
                ${aria ? ` aria-label="${escapeHtml(aria)}"` : ''}>${escapeHtml(label)}</button>`;

    host.innerHTML = [
        button('السابق', state.page - 1, { disabled: !state.hasPrev, aria: 'الصفحة السابقة' }),
        ...state.window.map(n => button(String(n), n, { current: n === state.page })),
        button('التالي', state.page + 1, { disabled: !state.hasNext, aria: 'الصفحة التالية' })
    ].join('');
}

/**
 * شريط المحرّر.
 *
 * ظهوره مشروط بأن **القاعدة** أعادت مقالًا غير منشور — وهو ما لا يحدث إلا
 * لطاقم المنصة. لا نسأل «هل أنت أدمن؟»: نعرض ما تدلّ عليه البيانات العائدة.
 */
function renderEditorBar(rows) {
    const bar = $('blogEditorBar');
    const hidden = rows.filter(r => postState(r) !== POST_STATES.published);

    if (hidden.length === 0) { bar.hidden = true; return; }

    const drafts = hidden.filter(r => postState(r) === POST_STATES.draft).length;
    const scheduled = hidden.filter(r => postState(r) === POST_STATES.scheduled).length;

    const parts = [];
    if (drafts) parts.push(`${drafts} مسودّة`);
    if (scheduled) parts.push(`${scheduled} مجدولًا`);

    $('blogEditorBarText').textContent =
        `أنت ترى هذه الصفحة بصلاحية تحرير: تظهر لك ${parts.join(' و')} لا يراها الزائر.`;
    bar.hidden = false;
}

/* =========================================================
   التصنيفات والوسوم والإحصاءات
========================================================= */

async function loadSidebars() {
    const [categories, tags] = await Promise.all([fetchCategories(), fetchTags(18)]);

    if (categories.ok) {
        categoryIndex = new Map((categories.data || []).map(c => [c.slug, c]));
        renderCategories(categories.data || []);
        // العنوان قد يكون رُسم قبل وصول التصنيفات فعرض الـslug بدل الاسم.
        // إعادة رسمه هنا بآخر عدد معروف تُصحّحه بلا نداء ثانٍ.
        renderHeading(currentState(), lastResult.total);
    }

    if (tags.ok) renderTags(tags.data || []);
    renderHeroStats(categories.ok ? categories.data : []);
}

function renderCategories(categories) {
    const host = $('blogCategories');
    const state = currentState();

    // تصنيف بلا مقال واحد ليس طريق تصفّح — هو طريق مسدود مضمون.
    const withPosts = categories.filter(c => Number(c.post_count) > 0);

    const chips = [`
        <button type="button" class="blog-chip${!state.category ? ' is-active' : ''}"
                data-filter="category" data-value="">كل المواضيع</button>`];

    for (const category of withPosts) {
        chips.push(`
            <button type="button" class="blog-chip${state.category === category.slug ? ' is-active' : ''}"
                    data-filter="category" data-value="${escapeHtml(category.slug)}"
                    title="${escapeHtml(category.description || '')}">
                ${escapeHtml(category.name)}<b>${Number(category.post_count)}</b>
            </button>`);
    }

    host.innerHTML = chips.join('');
}

/**
 * يعلّم الشريحة النشطة بعد كل تنقّل.
 *
 * الشرائح تُرسَم مرة واحدة (التصنيفات والوسوم لا تتغيّر بتغيّر الصفحة)، أما
 * **أيّها نشطة** فيتغيّر مع كل تصفية — فلولا هذا التزامن لبقيت الشريحة
 * المضغوطة بلا علامة، ولبدا للقارئ أن ضغطته لم تُسجَّل.
 */
function markActiveChips(state) {
    document.querySelectorAll('#blogCategories .blog-chip').forEach(chip => {
        chip.classList.toggle('is-active', (chip.dataset.value || null) === state.category);
    });
    document.querySelectorAll('#blogTags .blog-tag').forEach(chip => {
        chip.classList.toggle('is-active', (chip.dataset.value || null) === state.tag);
    });
}

function renderTags(tags) {
    if (!tags.length) return;
    const state = currentState();

    $('blogTags').innerHTML = tags.map(tag => `
        <button type="button" class="blog-tag${state.tag === tag.tag ? ' is-active' : ''}"
                data-filter="tag" data-value="${escapeHtml(tag.tag)}">
            #${escapeHtml(tag.tag)}
        </button>`).join('');
    $('blogTagsPanel').hidden = false;
}

async function renderHeroStats(categories) {
    // نداء مستقلّ **بلا فلاتر** عن عمد: أرقام الواجهة أرقام المدوّنة كلها،
    // ولو أُخذت من نتيجة render() لعرضت «3 مقالات» لمن فتح رابطًا مصفّى —
    // وهي إجابة عن سؤال آخر. والتكلفة صفٌّ واحد لأن العدد الكلي يأتي معه.
    const result = await fetchFeed({ limit: 1, offset: 0 });
    if (!result.ok || !result.data.total) return;

    const latest = result.data.rows[0];
    $('statPosts').textContent = result.data.total;
    $('statCategories').textContent = (categories || []).filter(c => Number(c.post_count) > 0).length || '—';
    $('statLatest').textContent = latest ? relativeDate(latest.published_at) : '—';
    $('blogHeroStats').hidden = false;
}
