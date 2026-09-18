/**
 * blog-admin.js — تحرير المدوّنة من لوحة الإدارة / لوحة المالك.
 *
 * الصفحة **ليست** موضع التفويض. حارس الصفحة هنا (checkAdminAuth) يقرّر ما
 * يُعرض؛ ومن يستطيع الكتابة تقرّره سياسات blog_posts في القاعدة عبر
 * is_platform_staff() — نفس الدالة التي تحرس بقيّة لوحة الإدارة. ولذلك:
 *
 *   • لا فحص رتبة مكتوب هنا. فحصٌ ثانٍ كان سيتفرّع عن السياسة عند أول تعديل،
 *     فتُظهر الواجهة أزرارًا يرفضها الخادم — أو أسوأ: تخفي وظيفة مسموحة.
 *   • كل كتابة تتحقّق من **عدد الصفوف العائدة** لا من غياب الخطأ. رفض RLS
 *     يعود بصفر صفوف بلا خطأ، فـ«تم الحفظ» على تعديل لم يحدث هو أسوأ ما
 *     يمكن أن تقوله لوحة تحرير. blog-data.js تحوّل ذلك إلى خطأ صريح.
 *
 * والمعاينة تستعمل **نفس** renderArticleHtml التي تعرض بها الصفحة العامة
 * المقال. مُحوِّل ثانٍ للمعاينة كان سيعني أن ما يراه المحرّر ليس ما يُنشر.
 */

import { checkAdminAuth } from '/assets/js/admin/auth.js';
import { initSidebar } from '/assets/js/admin/sidebar.js';
import { supabase } from '/api-config.js';
import {
    fetchAllPosts, fetchPostForEdit, createPost, updatePost, deletePost, patchPost,
    fetchAllCategories, saveCategory, deleteCategory, ADMIN_POST_LIMIT
} from '/assets/js/blog/blog-data.js';
import {
    escapeHtml, slugify, normalizeTags, wordCount, readingMinutes,
    renderArticleHtml, validatePost, editorialScore, postState, POST_STATES,
    formatCount, formatDateTime, relativeDate
} from '/assets/js/blog/blog-model.js';

const $ = (id) => document.getElementById(id);

let posts = [];
let categories = [];
let currentUser = null;
let editingId = null;
/** هل لمس المحرّر حقل الرابط بيده؟ إن نعم توقّف الاشتقاق من العنوان. */
let slugTouched = false;

document.addEventListener('DOMContentLoaded', init);

async function init() {
    initSidebar();

    // الحارس يرسم سبب الرفض بنفسه ويعيد null — فلا تنقّل ولا حلقة تحويل.
    const user = await checkAdminAuth();
    if (!user) return;

    currentUser = user;
    $('blogWorkspace').hidden = false;

    wireToolbar();
    wireEditor();
    wireCategories();
    wireRowActions();

    await loadCategories();
    await loadPosts();

    // فتح مقال بعينه من رابط خارجي: شريط المحرّر في الصفحة العامة يشير هنا
    // بـ?edit=<id>، فينتقل المحرّر من «رأيت مشكلة» إلى «أصلحتها» بضغطة.
    const editId = new URLSearchParams(window.location.search).get('edit');
    if (editId) openEditor(editId);
}

/* =========================================================
   القائمة
========================================================= */

async function loadPosts() {
    const result = await fetchAllPosts();

    if (!result.ok) {
        $('blogRows').innerHTML = row(7, `تعذّر تحميل المقالات: ${escapeHtml(result.error)}`);
        return;
    }

    posts = result.data;
    renderStats();
    renderRows();
    renderCapNotice();
}

/**
 * الحدّ مبلوغ: نقوله بدل أن نقتطع صامتين.
 *
 * التصفية والبحث في هذه الصفحة يعملان على الصفوف المحمَّلة، فبلوغ الحدّ
 * يعني أن بحثًا عن مقال قديم قد لا يجده — وهو أسوأ حين لا يُعلَن.
 */
function renderCapNotice() {
    const existing = $('blogCapNotice');
    if (posts.length < ADMIN_POST_LIMIT) { existing?.remove(); return; }
    if (existing) return;

    const notice = document.createElement('div');
    notice.id = 'blogCapNotice';
    notice.className = 'blog-alert blog-alert--info';
    notice.textContent = `تُعرض أحدث ${ADMIN_POST_LIMIT} مقالًا. البحث والتصفية يعملان عليها،`
        + ' فالمقالات الأقدم من ذلك لا تظهر هنا.';
    $('blogWorkspace').prepend(notice);
}

function row(span, text) {
    return `<tr><td colspan="${span}" style="text-align:center; padding:2.5rem;">${text}</td></tr>`;
}

function renderStats() {
    const by = (state) => posts.filter(p => postState(p) === state).length;
    const reads = posts.reduce((sum, p) => sum + (Number(p.view_count) || 0), 0);

    const cards = [
        ['كل المقالات', posts.length, 'rgba(0,119,204,.14)', 'var(--color-accent)'],
        ['منشور', by(POST_STATES.published), 'rgba(46,138,58,.16)', 'var(--color-success)'],
        ['مسودّة', by(POST_STATES.draft), 'rgba(120,120,120,.16)', 'var(--color-text-secondary)'],
        ['مجدول', by(POST_STATES.scheduled), 'rgba(224,168,0,.16)', 'var(--color-warning)'],
        ['إجمالي القراءات', formatCount(reads), 'rgba(0,119,204,.14)', 'var(--color-accent)']
    ];

    $('blogStats').innerHTML = cards.map(([label, value, bg, color]) => `
        <div class="stat-card">
            <div class="stat-icon" style="background:${bg}; color:${color};">
                <svg viewBox="0 0 24 24" width="22" height="22" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path></svg>
            </div>
            <div class="stat-info">
                <h3>${escapeHtml(label)}</h3>
                <p class="stat-value">${escapeHtml(String(value))}</p>
            </div>
        </div>`).join('');
}

function visiblePosts() {
    const term = $('blogAdminSearch').value.trim().toLowerCase();
    const status = $('blogStatusFilter').value;
    const category = $('blogCategoryFilter').value;

    return posts.filter(post => {
        if (term) {
            const haystack = `${post.title} ${post.slug} ${(post.tags || []).join(' ')}`.toLowerCase();
            if (!haystack.includes(term)) return false;
        }
        // التصفية بـ«مجدول» تعمل على الحالة **المشتقّة**، لأن المجدول في
        // القاعدة صفّه status='published' — تصفية على العمود وحده كانت
        // ستضع المجدول تحت «منشور» وتجعل خانة «مجدول» فارغة أبدًا.
        if (status) {
            const key = Object.keys(POST_STATES).find(k => POST_STATES[k] === postState(post));
            if (key !== status) return false;
        }
        if (category && post.category?.slug !== category) return false;
        return true;
    });
}

function renderRows() {
    const list = visiblePosts();
    const body = $('blogRows');

    if (posts.length === 0) {
        body.innerHTML = row(7, `
            <div class="blog-empty">
                <h3>لا مقالات بعد</h3>
                <p>
                    المدوّنة جاهزة وتنتظر أول مقال. التصنيفات مزروعة مسبقًا،
                    فكل ما ينقص هو ما تكتبه أنت.
                </p>
                <button type="button" class="btn btn-primary" data-action="new">اكتب أول مقال</button>
            </div>`);
        return;
    }

    if (list.length === 0) {
        body.innerHTML = row(7, 'لا مقالات تطابق التصفية الحالية.');
        return;
    }

    body.innerHTML = list.map(post => {
        const state = postState(post);
        const stateKey = Object.keys(POST_STATES).find(k => POST_STATES[k] === state);

        return `<tr data-id="${escapeHtml(post.id)}">
            <td>
                <div class="blog-row-title">
                    <b>${escapeHtml(post.title)}</b>
                    <span class="blog-row-slug">/blog/post.html?slug=${escapeHtml(post.slug)}</span>
                    ${post.is_featured ? '<span class="blog-row-flags"><span class="status-badge status-open">مميّز</span></span>' : ''}
                </div>
            </td>
            <td>${post.category?.name ? escapeHtml(post.category.name) : '<span style="color:var(--color-text-secondary)">—</span>'}</td>
            <td>
                <span class="status-badge blog-state-${stateKey}" title="${escapeHtml(state.hint)}">${escapeHtml(state.label)}</span>
                ${state === POST_STATES.scheduled ? `<div style="font-size:.72rem; color:var(--color-text-secondary); margin-top:.25rem;">${escapeHtml(formatDateTime(post.published_at))}</div>` : ''}
            </td>
            <td>${escapeHtml(post.author_name || '—')}</td>
            <td class="blog-num">${escapeHtml(formatCount(post.view_count))}</td>
            <td class="blog-num" title="${escapeHtml(formatDateTime(post.updated_at))}">${escapeHtml(relativeDate(post.updated_at))}</td>
            <td>
                <div class="blog-row-actions">
                    <button type="button" class="btn btn-secondary btn-sm" data-action="edit">تعديل</button>
                    ${state === POST_STATES.published
                        ? '<button type="button" class="btn btn-outline btn-sm" data-action="unpublish">إلغاء النشر</button>'
                        : '<button type="button" class="btn btn-success btn-sm" data-action="publish">نشر</button>'}
                    <button type="button" class="btn btn-outline btn-sm" data-action="feature">${post.is_featured ? 'إلغاء التمييز' : 'تمييز'}</button>
                    <a class="btn btn-outline btn-sm" href="/blog/post.html?slug=${encodeURIComponent(post.slug)}" target="_blank" rel="noopener">معاينة ↗</a>
                </div>
            </td>
        </tr>`;
    }).join('');
}

/* =========================================================
   أفعال الصفوف
========================================================= */

function wireRowActions() {
    // تفويض واحد على الجدول: الصفوف تُعاد كتابتها بعد كل تغيير، فربط مستمع
    // لكل زر كان سيسرّب مستمعين عند كل رسم.
    $('blogRows').addEventListener('click', async (event) => {
        const button = event.target.closest('[data-action]');
        if (!button) return;

        const action = button.dataset.action;
        if (action === 'new') { openEditor(null); return; }

        const id = button.closest('tr')?.dataset.id;
        if (!id) return;

        if (action === 'edit') { openEditor(id); return; }

        const post = posts.find(p => p.id === id);
        if (!post) return;

        button.disabled = true;
        try {
            if (action === 'publish') await applyPatch(id, publishPatch(post));
            else if (action === 'unpublish') await applyPatch(id, { status: 'draft' });
            else if (action === 'feature') await applyPatch(id, { is_featured: !post.is_featured });
        } finally {
            button.disabled = false;
        }
    });
}

/**
 * النشر من القائمة.
 *
 * مقال أُلغي نشره وله موعد في المستقبل: إعادة نشره تعني «الآن» لا «في ذلك
 * الموعد الذي مضى قراره». نمسح الموعد صراحةً فيضبطه المحفّز على اللحظة.
 */
function publishPatch(post) {
    const scheduledInFuture = post.published_at && new Date(post.published_at) > new Date();
    return scheduledInFuture
        ? { status: 'published', published_at: null }
        : { status: 'published' };
}

async function applyPatch(id, patch) {
    const result = await patchPost(id, patch);
    if (!result.ok) { alert(result.error); return; }
    await loadPosts();
}

/* =========================================================
   شريط الأدوات
========================================================= */

function wireToolbar() {
    $('blogAdminSearch').addEventListener('input', renderRows);
    $('blogStatusFilter').addEventListener('change', renderRows);
    $('blogCategoryFilter').addEventListener('change', renderRows);
    $('newPostBtn').addEventListener('click', () => openEditor(null));
    $('manageCategoriesBtn').addEventListener('click', openCategories);
}

/* =========================================================
   المحرّر
========================================================= */

const FIELDS = {
    title: 'fTitle', slug: 'fSlug', subtitle: 'fSubtitle', excerpt: 'fExcerpt',
    content: 'fContent', cover_url: 'fCover', cover_alt: 'fCoverAlt',
    author_name: 'fAuthorName', author_title: 'fAuthorTitle',
    seo_title: 'fSeoTitle', seo_description: 'fSeoDescription'
};

function wireEditor() {
    $('postModalClose').addEventListener('click', closeEditor);
    $('cancelPostBtn').addEventListener('click', closeEditor);
    $('postForm').addEventListener('submit', onSubmit);
    $('deletePostBtn').addEventListener('click', onDelete);

    $('fTitle').addEventListener('input', () => {
        if (!slugTouched) $('fSlug').value = slugify($('fTitle').value);
        refreshPreview();
    });

    $('fSlug').addEventListener('input', () => { slugTouched = true; refreshPreview(); });
    $('regenSlugBtn').addEventListener('click', () => {
        $('fSlug').value = slugify($('fTitle').value);
        slugTouched = false;
        refreshPreview();
    });

    for (const id of ['fSubtitle', 'fExcerpt', 'fContent', 'fCover', 'fCategory', 'fTags', 'fSeoDescription']) {
        $(id).addEventListener('input', refreshPreview);
        $(id).addEventListener('change', refreshPreview);
    }

    $('fStatus').addEventListener('change', () => {
        const scheduling = $('fStatus').value === 'published';
        $('fPublishAt').disabled = !scheduling;
        $('publishAtHint').textContent = scheduling
            ? 'اتركه فارغًا لينشر فور الحفظ، أو اختر موعدًا مستقبليًا ليُنشر وحده.'
            : 'الجدولة متاحة للحالة «منشور» وحدها.';
        refreshPreview();
    });

    wireFormatBar();

    // Esc يغلق، وفي نافذة تحرير طويلة ذلك خطر: نسأل قبل أن نُفقد عملًا.
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && $('postModal').classList.contains('active')) closeEditor();
    });
}

async function openEditor(id) {
    editingId = id || null;
    slugTouched = Boolean(id);

    $('postForm').reset();
    clearErrors();
    $('postFormAlert').innerHTML = '';
    $('postId').value = id || '';
    $('deletePostBtn').hidden = !id;
    $('postModalTitle').textContent = id ? 'تعديل المقال' : 'مقال جديد';
    $('fPublishAt').disabled = true;
    $('publishAtHint').textContent = 'الجدولة متاحة للحالة «منشور» وحدها.';

    // الكاتب الافتراضي هو من يكتب — لقطة عرض تُحفظ على الصف، فيقرؤها
    // الزائر المجهول الذي لا يستطيع قراءة profiles.
    $('fAuthorName').value = currentUser?.profile?.full_name || 'فريق مدعوم';

    $('postModal').classList.add('active');

    if (id) {
        const result = await fetchPostForEdit(id);
        if (!result.ok || !result.data) {
            showAlert('postFormAlert', 'danger', result.error || 'تعذّر فتح المقال.');
            return;
        }
        fill(result.data);
    }

    refreshPreview();
    $('fTitle').focus();
}

function fill(post) {
    for (const [key, elementId] of Object.entries(FIELDS)) {
        $(elementId).value = post[key] ?? '';
    }
    $('fCategory').value = post.category_id || '';
    $('fTags').value = (post.tags || []).join('، ');
    $('fStatus').value = post.status || 'draft';
    $('fFeatured').checked = Boolean(post.is_featured);

    const scheduling = post.status === 'published';
    $('fPublishAt').disabled = !scheduling;
    if (scheduling) {
        $('publishAtHint').textContent = 'اتركه فارغًا لينشر فور الحفظ، أو اختر موعدًا مستقبليًا ليُنشر وحده.';
    }

    // datetime-local لا يقبل ISO بمنطقة زمنية: يحتاج توقيتًا محليًا بلا
    // لاحقة. التحويل هنا صريح لأن تمرير القيمة كما هي يترك الحقل فارغًا
    // بصمت — فيبدو أن المقال بلا موعد وهو مجدول.
    $('fPublishAt').value = post.published_at ? toLocalInput(post.published_at) : '';
}

function toLocalInput(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
         + `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function closeEditor() {
    $('postModal').classList.remove('active');
    editingId = null;
}

function readForm() {
    const values = {};
    for (const [key, elementId] of Object.entries(FIELDS)) values[key] = $(elementId).value;

    values.category_id = $('fCategory').value || null;
    values.tags = normalizeTags($('fTags').value);
    values.status = $('fStatus').value;
    values.is_featured = $('fFeatured').checked;

    // الموعد يُرسَل مع «منشور» وحدها. إرساله مع مسودّة كان سيضبط published_at
    // على صفّ لا يُنشر، فيظهر بعد النشر بتاريخ لا علاقة له بقرار النشر.
    if (values.status === 'published' && $('fPublishAt').value) {
        values.publish_at = $('fPublishAt').value;
    } else if (values.status === 'published') {
        values.clear_schedule = true;
    }

    return values;
}

async function onSubmit(event) {
    event.preventDefault();
    clearErrors();
    $('postFormAlert').innerHTML = '';

    const values = readForm();
    const check = validatePost(values);

    if (!check.valid) {
        for (const [field, message] of Object.entries(check.errors)) showError(field, message);
        showAlert('postFormAlert', 'danger', 'راجع الحقول المعلَّمة أدناه.');
        document.querySelector('.error:not([hidden])')?.scrollIntoView({ block: 'center' });
        return;
    }

    // التحذيرات لا تمنع: تُعرض ويُكمَّل الحفظ. منعُ النشر على مقتطف ناقص
    // كان سيجعل اللوحة تفرض رأيًا تحريريًا لا قاعدة بيانات.
    if (check.warnings.length) {
        showAlert('postFormAlert', 'warning',
            'نُشر مع ملاحظات:<ul>' + check.warnings.map(w => `<li>${escapeHtml(w)}</li>`).join('') + '</ul>');
    }

    const button = $('savePostBtn');
    button.disabled = true;
    button.textContent = 'جارٍ الحفظ…';

    const context = { authorId: currentUser?.id, authorName: values.author_name };
    const result = editingId
        ? await updatePost(editingId, values, context)
        : await createPost(values, context);

    button.disabled = false;
    button.textContent = 'حفظ';

    if (!result.ok) {
        showAlert('postFormAlert', 'danger', escapeHtml(result.error));
        if (/الرابط المختصر/.test(result.error)) showError('slug', result.error);
        return;
    }

    closeEditor();
    await loadPosts();
}

async function onDelete() {
    if (!editingId) return;

    const post = posts.find(p => p.id === editingId);
    const live = post && postState(post) === POST_STATES.published;

    const message = live
        ? 'هذا المقال منشور على الإنترنت الآن، وحذفه يكسر كل رابط مُشارَك له. '
        + 'إن أردت إخفاءه فقط فالأرشفة تُبقي الرابط يعمل.\n\nأتريد الحذف النهائي؟'
        : 'حذف المقال نهائي ولا يمكن التراجع عنه. أتريد المتابعة؟';

    if (!confirm(message)) return;

    const result = await deletePost(editingId);
    if (!result.ok) { showAlert('postFormAlert', 'danger', escapeHtml(result.error)); return; }

    closeEditor();
    await loadPosts();
}

/* =========================================================
   المعاينة والجاهزية
========================================================= */

function refreshPreview() {
    const values = readForm();

    $('slugPreview').textContent = values.slug || '—';
    $('previewTitle').textContent = values.title || 'عنوان المقال';

    const subtitle = $('previewSubtitle');
    subtitle.textContent = values.subtitle || '';
    subtitle.hidden = !values.subtitle;

    const body = $('previewBody');
    body.innerHTML = values.content
        ? renderArticleHtml(values.content)
        : '<p class="blog-preview-empty">ابدأ الكتابة ليظهر المقال هنا كما سيراه القارئ.</p>';

    const words = wordCount(values.content);
    $('previewWords').textContent = `${words} كلمة`;
    $('previewMinutes').textContent = `${readingMinutes(values.content)} دقيقة`;

    renderChecklist(values);
}

function renderChecklist(values) {
    const score = editorialScore(values);

    $('checklistPercent').textContent = `${score.percent}%`;
    $('checklistBar').style.width = `${score.percent}%`;
    $('checklistItems').innerHTML = score.checks.map(check => `
        <li class="${check.ok ? 'is-done' : ''}">
            <span class="mark" aria-hidden="true">${check.ok ? '✓' : '○'}</span>
            <span>${escapeHtml(check.label)}</span>
        </li>`).join('');
}

/* =========================================================
   شريط التنسيق
========================================================= */

const SNIPPETS = {
    heading: { before: '## ', after: '', placeholder: 'عنوان القسم', block: true },
    bold: { before: '**', after: '**', placeholder: 'نص غامق' },
    italic: { before: '_', after: '_', placeholder: 'نص مائل' },
    ul: { before: '- ', after: '', placeholder: 'عنصر', block: true },
    ol: { before: '1. ', after: '', placeholder: 'عنصر', block: true },
    quote: { before: '> ', after: '', placeholder: 'اقتباس', block: true },
    code: { before: '```\n', after: '\n```', placeholder: 'الشفرة هنا', block: true },
    link: { before: '[', after: '](https://)', placeholder: 'نص الرابط' },
    image: { before: '![', after: '](https://)', placeholder: 'وصف الصورة' },
    rule: { before: '\n---\n', after: '', placeholder: '', block: true }
};

function wireFormatBar() {
    document.querySelector('.blog-format-bar').addEventListener('click', (event) => {
        const button = event.target.closest('[data-insert]');
        if (!button) return;
        insertSnippet(SNIPPETS[button.dataset.insert]);
    });
}

/**
 * يُدرج التنسيق حول ما اختاره المحرّر، ويُبقي التحديد على النص لا على
 * العلامات — فيستطيع الكتابة فوقه مباشرة.
 */
function insertSnippet(snippet) {
    if (!snippet) return;

    const area = $('fContent');
    const start = area.selectionStart;
    const end = area.selectionEnd;
    const selected = area.value.slice(start, end) || snippet.placeholder;

    // تنسيق الكتلة يحتاج سطرًا خاصًّا به: إدراجه في منتصف فقرة ينتج
    // `نص ## عنوان` — وهو ليس عنوانًا عند أي مُحوِّل.
    const needsBreak = snippet.block && start > 0 && area.value[start - 1] !== '\n';
    const prefix = needsBreak ? '\n' : '';

    const inserted = `${prefix}${snippet.before}${selected}${snippet.after}`;
    area.value = area.value.slice(0, start) + inserted + area.value.slice(end);

    const selectionStart = start + prefix.length + snippet.before.length;
    area.focus();
    area.setSelectionRange(selectionStart, selectionStart + selected.length);

    refreshPreview();
}

/* =========================================================
   التصنيفات
========================================================= */

async function loadCategories() {
    const result = await fetchAllCategories();
    if (!result.ok) return;

    categories = result.data;

    const options = categories
        .filter(c => c.is_active)
        .map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`)
        .join('');
    $('fCategory').innerHTML = `<option value="">بلا تصنيف</option>${options}`;

    $('blogCategoryFilter').innerHTML = '<option value="">كل التصنيفات</option>'
        + categories.map(c => `<option value="${escapeHtml(c.slug)}">${escapeHtml(c.name)}</option>`).join('');
}

function wireCategories() {
    $('categoryModalClose').addEventListener('click', () => $('categoryModal').classList.remove('active'));
    $('resetCategoryBtn').addEventListener('click', resetCategoryForm);
    $('categoryForm').addEventListener('submit', onSaveCategory);

    $('fCatName').addEventListener('input', () => {
        if ($('categoryId').value) return;      // تعديل: لا نلمس رابطًا منشورًا
        $('fCatSlug').value = slugify($('fCatName').value, { maxLength: 80 });
    });

    $('categoryRows').addEventListener('click', async (event) => {
        const button = event.target.closest('[data-cat-action]');
        if (!button) return;

        const id = button.closest('tr')?.dataset.id;
        const category = categories.find(c => c.id === id);
        if (!category) return;

        if (button.dataset.catAction === 'edit') { fillCategory(category); return; }

        // الحذف يكسر ارتباط مقالات قائمة (category_id يصير NULL بالـFK)،
        // فنقول للمحرّر كم مقالًا سيفقد تصنيفه قبل أن يقرّر.
        const affected = posts.filter(p => p.category?.id === id).length;
        const note = affected
            ? `\n\n${affected} ${affected === 1 ? 'مقال' : 'مقالًا'} سيبقى بلا تصنيف (لن يُحذف).`
            : '';
        if (!confirm(`حذف التصنيف «${category.name}»؟${note}`)) return;

        const result = await deleteCategory(id);
        if (!result.ok) { showAlert('categoryAlert', 'danger', escapeHtml(result.error)); return; }

        await loadCategories();
        await loadPosts();
        renderCategoryRows();
    });
}

function openCategories() {
    resetCategoryForm();
    $('categoryAlert').innerHTML = '';
    renderCategoryRows();
    $('categoryModal').classList.add('active');
}

function renderCategoryRows() {
    const counts = new Map();
    for (const post of posts) {
        if (post.category?.id) counts.set(post.category.id, (counts.get(post.category.id) || 0) + 1);
    }

    $('categoryRows').innerHTML = categories.length === 0
        ? '<tr><td colspan="5" style="text-align:center; padding:2rem;">لا تصنيفات بعد.</td></tr>'
        : categories.map(category => `
            <tr data-id="${escapeHtml(category.id)}">
                <td>
                    <b>${escapeHtml(category.name)}</b>
                    <div style="font-size:.75rem; color:var(--color-text-secondary);">
                        ${counts.get(category.id) || 0} مقالًا
                    </div>
                </td>
                <td class="blog-row-slug">${escapeHtml(category.slug)}</td>
                <td class="blog-num">${escapeHtml(String(category.sort_order))}</td>
                <td>
                    <span class="status-badge ${category.is_active ? 'blog-state-published' : 'blog-state-draft'}">
                        ${category.is_active ? 'نشط' : 'معطَّل'}
                    </span>
                </td>
                <td>
                    <div class="blog-row-actions">
                        <button type="button" class="btn btn-secondary btn-sm" data-cat-action="edit">تعديل</button>
                        <button type="button" class="btn btn-danger btn-sm" data-cat-action="delete">حذف</button>
                    </div>
                </td>
            </tr>`).join('');
}

function fillCategory(category) {
    $('categoryId').value = category.id;
    $('fCatName').value = category.name;
    $('fCatSlug').value = category.slug;
    $('fCatOrder').value = category.sort_order;
    $('fCatDescription').value = category.description || '';
    $('fCatActive').checked = category.is_active !== false;
    $('saveCategoryBtn').textContent = 'حفظ التعديل';
    $('fCatName').focus();
}

function resetCategoryForm() {
    $('categoryForm').reset();
    $('categoryId').value = '';
    $('fCatOrder').value = '100';
    $('fCatActive').checked = true;
    $('saveCategoryBtn').textContent = 'حفظ التصنيف';
}

async function onSaveCategory(event) {
    event.preventDefault();
    $('categoryAlert').innerHTML = '';

    const values = {
        id: $('categoryId').value || null,
        name: $('fCatName').value.trim(),
        slug: $('fCatSlug').value.trim(),
        description: $('fCatDescription').value.trim(),
        sort_order: Number($('fCatOrder').value) || 100,
        is_active: $('fCatActive').checked
    };

    if (!values.name || !values.slug) {
        showAlert('categoryAlert', 'danger', 'الاسم والرابط المختصر مطلوبان.');
        return;
    }

    const result = await saveCategory(values);
    if (!result.ok) { showAlert('categoryAlert', 'danger', escapeHtml(result.error)); return; }

    await loadCategories();
    renderCategoryRows();
    resetCategoryForm();
    showAlert('categoryAlert', 'info', 'حُفظ التصنيف.');
}

/* =========================================================
   رسائل
========================================================= */

function showAlert(hostId, variant, html) {
    $(hostId).innerHTML = `<div class="blog-alert blog-alert--${variant}">${html}</div>`;
}

function showError(field, message) {
    const label = document.querySelector(`[data-error-for="${field}"]`);
    if (label) { label.textContent = message; label.hidden = false; }

    const input = $(FIELDS[field]);
    if (input) input.setAttribute('aria-invalid', 'true');
}

function clearErrors() {
    document.querySelectorAll('[data-error-for]').forEach(el => { el.hidden = true; el.textContent = ''; });
    document.querySelectorAll('[aria-invalid]').forEach(el => el.removeAttribute('aria-invalid'));
}

/* =========================================================
   التحديث الحيّ
========================================================= */
/*
 * محرّران يعملان معًا على نفس المدوّنة يريان تغييرات بعضهما بلا تحديث يدوي.
 * نفس نمط knowledge-base-admin.html — والقناة لا تمنح صلاحية: RLS هي ما
 * يقرّر ما يصل أصلًا.
 */
supabase
    .channel('blog_admin_changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'blog_posts' }, () => {
        // لا نُعيد الرسم بينما نافذة التحرير مفتوحة: تحديث الجدول تحتها
        // غير مرئي، وإعادة تحميل البيانات قد تدوس على ما يكتبه المحرّر.
        if (!$('postModal')?.classList.contains('active')) loadPosts();
    })
    .subscribe();
