import { SUPABASE_CONFIG } from './supabase-config.js';
import { requireAuth } from './auth-client.js';
import { initCustomerSidebar } from './assets/js/customer-sidebar.js';
import { initSidebar as initAdminSidebar } from './assets/js/admin/sidebar.js';
// مكتبة تنقية HTML — ضرورية لأن محرر الموضوع/الرد (contenteditable) يولّد HTML حقيقي
// (Bold/Italic/Links/Code) لا يمكن تنظيفه بمجرد escape كامل بدون تكسير التنسيق المشروع.
// ملحوظة: لو المشروع يستخدم bundler (npm/vite/webpack) يُفضّل تثبيتها محليًا بـ
// `npm install dompurify` واستيرادها من 'dompurify' بدلاً من رابط CDN.
import DOMPurify from 'https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.es.mjs';

// إعدادات DOMPurify: تسمح فقط بعناصر التنسيق الأساسية المتوفرة في شريط أدوات
// المحرر (Bold, Italic, List, Link, Code) وتمنع أي عنصر/خاصية أخرى (script, onerror...).
const FORUM_SANITIZE_CONFIG = {
    ALLOWED_TAGS: ['b', 'strong', 'i', 'em', 'u', 'ul', 'ol', 'li', 'a', 'code', 'pre', 'br', 'p', 'span', 'img'],
    ALLOWED_ATTR: ['href', 'target', 'rel', 'src', 'alt'],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i
};

function sanitizeForumHtml(html) {
    return DOMPurify.sanitize(html || '', FORUM_SANITIZE_CONFIG);
}

/**
 * تنقية الروابط (URLs) قبل استخدامها في خصائص مثل src/href لمنع
 * بروتوكولات خطيرة مثل javascript:
 */
function sanitizeUrl(url) {
    if (!url) return '';
    const trimmed = String(url).trim();
    if (/^(https?:)?\/\//i.test(trimmed) || trimmed.startsWith('/') || trimmed.startsWith('./')) {
        return escapeHtml(trimmed);
    }
    return '';
}

// Initialize Supabase client
// Note: We use the global 'supabase' object provided by the CDN script
const supabaseClient = window.supabase.createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey);

let currentUser = null;
let currentView = 'categories'; // categories, subforum, thread
let currentSubforumId = null;
let currentThreadId = null;

// --- DOM Elements ---
const forumContent = document.getElementById('forumContent');
const createThreadBtn = document.getElementById('createNewThread');
const threadModal = document.getElementById('threadModal');
const threadForm = document.getElementById('threadForm');
const closeModals = document.querySelectorAll('.close-modal');
const forumSearch = document.getElementById('forumSearch');
const forumFilter = document.getElementById('forumFilter');

// --- Initialization ---
async function init() {
    try {
        console.log('Initializing Forum...');
        currentUser = await requireAuth();
        if (!currentUser) {
            console.log('User not authenticated');
            return;
        }

        // Load appropriate sidebar
        if (currentUser.profile?.role === 'admin') {
            initAdminSidebar();
        } else {
            initCustomerSidebar();
        }

        setupEventListeners();
        await loadCategories();
        setupRealtime();
        console.log('Forum Initialized Successfully');
    } catch (error) {
        console.error('Error initializing forum:', error);
        if (forumContent) {
            forumContent.innerHTML = `<div class="error-msg" style="padding: 2rem; text-align: center; color: var(--color-danger);">
                <p>حدث خطأ أثناء تحميل المنتدى: ${error.message}</p>
                <button onclick="location.reload()" class="btn btn-primary" style="margin-top: 1rem;">إعادة المحاولة</button>
            </div>`;
        }
    }
}

// --- Event Listeners ---
function setupEventListeners() {
    if (createThreadBtn) {
        createThreadBtn.addEventListener('click', (e) => {
            e.preventDefault();
            console.log('Create Thread Button Clicked');
            if (!currentUser) {
                alert('يرجى تسجيل الدخول أولاً');
                return;
            }
            loadSubforumsForModal();
            threadModal.classList.add('active');
        });
    }

    closeModals.forEach(btn => {
        btn.addEventListener('click', () => {
            threadModal.classList.remove('active');
        });
    });

    if (threadForm) {
        threadForm.addEventListener('submit', handleThreadSubmit);
    }

    if (forumSearch) {
        forumSearch.addEventListener('input', debounce(() => {
            const query = forumSearch.value.trim();
            if (query.length > 2) {
                searchForum(query);
            } else if (query.length === 0) {
                loadCategories();
            }
        }, 500));
    }

    if (forumFilter) {
        forumFilter.addEventListener('change', () => {
            if (currentView === 'subforum') {
                loadSubforumThreads(currentSubforumId);
            }
        });
    }

    // Rich Editor Toolbar
    const toolbarButtons = document.querySelectorAll('.editor-toolbar button[data-cmd]');
    toolbarButtons.forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            const cmd = btn.getAttribute('data-cmd');
            document.execCommand(cmd, false, null);
        });
    });

    const codeBtn = document.getElementById('insertCode');
    if (codeBtn) {
        codeBtn.addEventListener('click', (e) => {
            e.preventDefault();
            const code = prompt('أدخل الكود هنا:');
            if (code) {
                document.execCommand('insertHTML', false, `<pre style="background: #f4f4f4; padding: 10px; border-radius: 5px; direction: ltr; text-align: left;"><code>${escapeHtml(code)}</code></pre>`);
            }
        });
    }

    const imgBtn = document.getElementById('uploadImg');
    if (imgBtn) {
        imgBtn.addEventListener('click', (e) => {
            e.preventDefault();
            const url = prompt('أدخل رابط الصورة:');
            if (url) {
                document.execCommand('insertImage', false, url);
            }
        });
    }
}

// --- Core Functions ---

async function loadCategories() {
    currentView = 'categories';
    forumContent.innerHTML = '<div class="loading-spinner" style="padding: 3rem; text-align: center;">جاري تحميل الأقسام...</div>';

    const { data: categories, error } = await supabaseClient
        .from('forum_categories')
        .select(`
            *,
            forum_subforums (*)
        `)
        .order('display_order');

    if (error) throw error;

    renderCategories(categories);
}

function renderCategories(categories) {
    let html = '';
    categories.forEach(cat => {
        html += `
            <section class="category-section">
                <h2 class="category-title">${escapeHtml(cat.name)}</h2>
                <div class="subforum-list">
                    ${cat.forum_subforums.map(sub => `
                        <div class="subforum-card" onclick="window.forum.openSubforum('${escapeHtml(sub.id)}')">
                            <div class="subforum-icon">
                                <svg viewBox="0 0 24 24" width="24" height="24" stroke="currentColor" stroke-width="2" fill="none"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
                            </div>
                            <div class="subforum-info">
                                <h3>${escapeHtml(sub.name)}</h3>
                                <p>${escapeHtml(sub.description || '')}</p>
                            </div>
                            <div class="subforum-stats">
                                <div class="stat-item">
                                    <span>${sub.threads_count || 0}</span>
                                    <label>موضوع</label>
                                </div>
                                <div class="stat-item">
                                    <span>${sub.posts_count || 0}</span>
                                    <label>مشاركة</label>
                                </div>
                            </div>
                            <div class="subforum-last-post">
                                ${sub.last_activity_at ? `
                                    <span class="last-post-meta">آخر نشاط: ${formatDate(sub.last_activity_at)}</span>
                                ` : '<span class="last-post-meta">لا توجد نشاطات بعد</span>'}
                            </div>
                        </div>
                    `).join('')}
                </div>
            </section>
        `;
    });
    forumContent.innerHTML = html || '<p class="empty-msg" style="text-align: center; padding: 2rem;">لا توجد أقسام متاحة حالياً.</p>';
}

async function openSubforum(subforumId) {
    currentView = 'subforum';
    currentSubforumId = subforumId;
    forumContent.innerHTML = '<div class="loading-spinner" style="text-align: center; padding: 3rem;">جاري تحميل المواضيع...</div>';

    const { data: subforum, error: subError } = await supabaseClient
        .from('forum_subforums')
        .select('*')
        .eq('id', subforumId)
        .single();

    if (subError) throw subError;

    loadSubforumThreads(subforumId, subforum.name);
}

async function loadSubforumThreads(subforumId, subforumName) {
    let query = supabaseClient
        .from('forum_threads')
        .select(`
            *,
            author:profiles(full_name, avatar_url)
        `)
        .eq('subforum_id', subforumId);

    // Apply Filters
    const filter = forumFilter.value;
    if (filter === 'popular') query = query.order('views_count', { ascending: false });
    else if (filter === 'unanswered') query = query.eq('replies_count', 0);
    else if (filter === 'activity') query = query.order('last_post_at', { ascending: false });
    else query = query.order('is_pinned', { ascending: false }).order('created_at', { ascending: false });

    const { data: threads, error } = await query;

    if (error) throw error;

    renderThreads(threads, subforumName);
}

function renderThreads(threads, subforumName) {
    let html = `
        <div class="breadcrumb" style="margin-bottom: 1.5rem; font-size: 0.95rem;">
            <a href="#" onclick="window.forum.loadCategories(); return false;" style="color: var(--color-accent); text-decoration: none;">الرئيسية</a> &raquo; <span style="color: var(--color-text-secondary);">${escapeHtml(subforumName)}</span>
        </div>
        <div class="thread-list" style="background: var(--color-surface); border-radius: 1rem; border: 1px solid var(--color-border); overflow: hidden;">
            ${threads.map(thread => `
                <div class="thread-card ${thread.is_pinned ? 'pinned' : ''}" onclick="window.forum.openThread('${escapeHtml(thread.id)}')" style="cursor: pointer; display: flex; align-items: center; padding: 1.25rem 1.5rem; border-bottom: 1px solid var(--color-border); transition: background 0.2s;">
                    <div class="thread-main" style="flex: 1; display: flex; gap: 1rem; align-items: flex-start;">
                        <div class="author-avatar" style="width: 45px; height: 45px; border-radius: 50%; background: var(--color-muted); display: flex; align-items: center; justify-content: center; font-weight: 700; color: var(--color-primary);">
                            ${thread.author?.avatar_url ? `<img src="${sanitizeUrl(thread.author.avatar_url)}" alt="" style="width:100%; height:100%; border-radius:50%; object-fit:cover;">` : escapeHtml(thread.author?.full_name?.charAt(0) || 'U')}
                        </div>
                        <div class="thread-details">
                            <h3 style="font-size: 1.1rem; font-weight: 600; margin-bottom: 0.25rem; color: var(--color-text);">
                                ${thread.is_pinned ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="margin-left:5px; color: var(--color-accent);"><path d="M12 2L4.5 20.29l.71.71L12 18l6.79 3 .71-.71z"/></svg>' : ''}
                                ${escapeHtml(thread.title)}
                            </h3>
                            <div class="thread-meta" style="display: flex; gap: 1rem; font-size: 0.85rem; color: var(--color-text-secondary);">
                                <span>بواسطة: ${escapeHtml(thread.author?.full_name || 'مستخدم مجهول')}</span>
                                <span>${formatDate(thread.created_at)}</span>
                                ${thread.tags && thread.tags.length > 0 ? `<div class="tags" style="display:flex; gap:0.5rem;">${thread.tags.map(t => `<span class="tag" style="background:var(--color-muted); padding:2px 8px; border-radius:4px; font-size:0.75rem;">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
                            </div>
                        </div>
                    </div>
                    <div class="thread-stats" style="display: flex; gap: 1.5rem; margin-right: 2rem; color: var(--color-text-secondary);">
                        <div class="thread-stat" style="display: flex; align-items: center; gap: 0.4rem;">
                            <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" fill="none"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
                            ${thread.replies_count}
                        </div>
                        <div class="thread-stat" style="display: flex; align-items: center; gap: 0.4rem;">
                            <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" fill="none"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
                            ${thread.views_count}
                        </div>
                    </div>
                </div>
            `).join('')}
        </div>
    `;
    forumContent.innerHTML = html || '<p class="empty-msg" style="text-align: center; padding: 3rem;">لا توجد مواضيع في هذا القسم بعد.</p>';
}

async function handleThreadSubmit(e) {
    e.preventDefault();
    const title = document.getElementById('threadTitle').value;
    const subforumId = document.getElementById('threadSubforum').value;
    const content = sanitizeForumHtml(document.getElementById('threadContent').innerHTML);
    const tagsInput = document.getElementById('threadTags').value;
    const tags = tagsInput ? tagsInput.split(',').map(t => t.trim()).filter(t => t) : [];

    if (!content.trim() || content === '<br>') {
        alert('يرجى كتابة محتوى الموضوع');
        return;
    }

    const slug = slugify(title) + '-' + Math.random().toString(36).substr(2, 5);

    const { data, error } = await supabaseClient
        .from('forum_threads')
        .insert([{
            title,
            subforum_id: subforumId,
            author_id: currentUser.id,
            content,
            slug,
            tags
        }])
        .select()
        .single();

    if (error) {
        alert('خطأ في نشر الموضوع: ' + error.message);
    } else {
        threadModal.classList.remove('active');
        threadForm.reset();
        document.getElementById('threadContent').innerHTML = '';
        openThread(data.id);
    }
}

async function openThread(threadId) {
    currentView = 'thread';
    currentThreadId = threadId;
    
    // Increment views
    await supabaseClient.rpc('increment_thread_views', { thread_id: threadId });

    const { data: thread, error } = await supabaseClient
        .from('forum_threads')
        .select(`
            *,
            author:profiles(full_name, avatar_url, role),
            replies:forum_replies(
                *,
                author:profiles(full_name, avatar_url, role)
            )
        `)
        .eq('id', threadId)
        .single();

    if (error) throw error;

    // نجيب كل الإعجابات على ردود الموضوع في استعلام واحد، ونحسب منها
    // عدد الإعجابات لكل رد + هل المستخدم الحالي معجب بيه (زي فيسبوك بالضبط)
    const replyIds = (thread.replies || []).map(r => r.id);
    const likesCountMap = new Map();
    const likedByMeSet = new Set();

    if (replyIds.length > 0) {
        const { data: likesRows, error: likesError } = await supabaseClient
            .from('forum_likes')
            .select('reply_id, user_id')
            .in('reply_id', replyIds);

        if (!likesError && likesRows) {
            likesRows.forEach(row => {
                likesCountMap.set(row.reply_id, (likesCountMap.get(row.reply_id) || 0) + 1);
                if (currentUser && row.user_id === currentUser.id) likedByMeSet.add(row.reply_id);
            });
        }
    }

    renderThreadDetail(thread, likesCountMap, likedByMeSet);
}

function renderThreadDetail(thread, likesCountMap, likedByMeSet) {
    let html = `
        <div class="breadcrumb" style="margin-bottom: 1.5rem; font-size: 0.95rem;">
            <a href="#" onclick="window.forum.loadCategories(); return false;" style="color: var(--color-accent); text-decoration: none;">الرئيسية</a> &raquo; <span style="color: var(--color-text-secondary);">${escapeHtml(thread.title)}</span>
        </div>
        <div class="thread-detail-container" style="display: flex; flex-direction: column; gap: 1.5rem;">
            <div class="post-item original-post" style="display: flex; background: var(--color-surface); border-radius: 1rem; border: 1px solid var(--color-border); overflow: hidden;">
                <div class="post-sidebar" style="width: 180px; background: var(--color-muted); padding: 1.5rem; display: flex; flex-direction: column; align-items: center; gap: 0.5rem; border-left: 1px solid var(--color-border);">
                    <div class="author-avatar-large" style="width: 80px; height: 80px; border-radius: 50%; background: var(--color-surface); display: flex; align-items: center; justify-content: center; font-size: 2rem; font-weight: 800; color: var(--color-primary); margin-bottom: 0.5rem; border: 3px solid var(--color-accent);">
                        ${thread.author?.avatar_url ? `<img src="${sanitizeUrl(thread.author.avatar_url)}" alt="" style="width:100%; height:100%; border-radius:50%; object-fit:cover;">` : escapeHtml(thread.author?.full_name?.charAt(0) || 'U')}
                    </div>
                    <div class="author-name" style="font-weight: 700; text-align: center;">${escapeHtml(thread.author?.full_name || 'مستخدم مجهول')}</div>
                    <div class="author-role" style="font-size: 0.75rem; background: var(--color-accent); color: white; padding: 2px 10px; border-radius: 1rem;">${escapeHtml(thread.author?.role || 'عضو')}</div>
                </div>
                <div class="post-content-wrapper" style="flex: 1; padding: 1.5rem; display: flex; flex-direction: column;">
                    <div class="post-header" style="display: flex; justify-content: space-between; border-bottom: 1px solid var(--color-border); padding-bottom: 0.5rem; margin-bottom: 1rem;">
                        <span class="post-date" style="font-size: 0.85rem; color: var(--color-text-secondary);">${formatDate(thread.created_at)}</span>
                        <div class="post-actions">
                            ${currentUser.id === thread.author_id || currentUser.profile?.role === 'admin' ? `
                                <button onclick="window.forum.editThread('${escapeHtml(thread.id)}')" style="background:none; border:none; color:var(--color-accent); cursor:pointer; font-size:0.9rem;">تعديل</button>
                            ` : ''}
                        </div>
                    </div>
                    <div class="post-body">
                        <h2 style="margin-bottom: 1rem; color: var(--color-primary);">${escapeHtml(thread.title)}</h2>
                        <div class="content" style="line-height: 1.6; font-size: 1.05rem;">${sanitizeForumHtml(thread.content)}</div>
                    </div>
                </div>
            </div>

            ${renderCommentsSection(thread, likesCountMap, likedByMeSet)}
        </div>
    `;
    forumContent.innerHTML = html;
    window.scrollTo({ top: 0, behavior: 'smooth' });
    handleComposerInput();
}

/* ============================================================
   نظام التعليقات بنمط فيسبوك
   ============================================================ */

/**
 * يبني شجرة التعليقات: كل رد مبني على parent_id، لكن العرض بيتم
 * بمستوى تعشيش واحد فقط بالظبط زي فيسبوك (أي رد على رد بيتحط
 * تحت التعليق الرئيسي مباشرة، مش متعشش أكتر من مستوى).
 */
function buildCommentTree(replies) {
    const list = replies || [];
    const byId = new Map(list.map(r => [r.id, r]));
    const topLevel = [];
    const childrenMap = new Map();

    function findRootId(reply) {
        let cur = reply;
        const seen = new Set();
        while (cur.parent_id && byId.has(cur.parent_id) && !seen.has(cur.id)) {
            seen.add(cur.id);
            cur = byId.get(cur.parent_id);
        }
        return cur.id;
    }

    list.forEach(r => {
        if (!r.parent_id || !byId.has(r.parent_id)) topLevel.push(r);
    });
    list.forEach(r => {
        if (r.parent_id && byId.has(r.parent_id)) {
            const rootId = findRootId(r);
            if (!childrenMap.has(rootId)) childrenMap.set(rootId, []);
            childrenMap.get(rootId).push(r);
        }
    });

    topLevel.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    childrenMap.forEach(arr => arr.sort((a, b) => new Date(a.created_at) - new Date(b.created_at)));

    return { topLevel, childrenMap };
}

function avatarHtml(profile) {
    if (profile?.avatar_url) return `<img src="${sanitizeUrl(profile.avatar_url)}" alt="">`;
    return escapeHtml(profile?.full_name?.charAt(0) || 'U');
}

function renderComment(reply, likesCountMap, likedByMeSet) {
    const count = likesCountMap.get(reply.id) || 0;
    const liked = likedByMeSet.has(reply.id);
    const id = escapeHtml(reply.id);

    return `
    <div class="fb-comment" id="comment-${id}">
        <div class="fb-comment-avatar">${avatarHtml(reply.author)}</div>
        <div class="fb-comment-body">
            <div class="fb-comment-bubble">
                <div class="fb-comment-author">${escapeHtml(reply.author?.full_name || 'مستخدم مجهول')}</div>
                <div class="fb-comment-text">${sanitizeForumHtml(reply.content)}</div>
                <div class="fb-like-pill" id="like-pill-${id}" style="${count > 0 ? '' : 'display:none;'}">👍 <span class="like-pill-count">${count}</span></div>
            </div>
            <div class="fb-comment-actions">
                <button class="like-btn ${liked ? 'liked' : ''}" id="like-btn-${id}" data-count="${count}" onclick="window.forum.toggleLike('${id}')">إعجاب</button>
                <button onclick="window.forum.showReplyBox('${id}')">رد</button>
                <span class="fb-comment-time" title="${formatDate(reply.created_at)}">${timeAgo(reply.created_at)}</span>
            </div>
            <div class="fb-reply-box-container" id="reply-box-${id}"></div>
        </div>
    </div>`;
}

function renderRepliesForRoot(rootId, childrenMap, likesCountMap, likedByMeSet) {
    const children = childrenMap.get(rootId) || [];
    if (children.length === 0) return '';

    const visibleCount = 2;
    const visible = children.slice(0, visibleCount);
    const hidden = children.slice(visibleCount);

    let html = `<div class="fb-replies">`;
    html += visible.map(c => renderComment(c, likesCountMap, likedByMeSet)).join('');
    if (hidden.length > 0) {
        const chevron = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m18 15-6-6-6 6"/></svg>`;
        html += `<button class="fb-view-more" id="view-more-${escapeHtml(rootId)}" onclick="window.forum.toggleMoreReplies('${escapeHtml(rootId)}')">${chevron} عرض ${hidden.length} ${hidden.length === 1 ? 'رد آخر' : 'ردود أخرى'}</button>`;
        html += `<div class="fb-replies" id="hidden-replies-${escapeHtml(rootId)}" style="display:none; padding-inline-end:0;">${hidden.map(c => renderComment(c, likesCountMap, likedByMeSet)).join('')}</div>`;
    }
    html += `</div>`;
    return html;
}

function renderCommentsSection(thread, likesCountMap, likedByMeSet) {
    const { topLevel, childrenMap } = buildCommentTree(thread.replies);
    const totalCount = thread.replies?.length || 0;

    const commentsHtml = topLevel.length
        ? topLevel.map(c => `
            <div class="fb-comment-thread">
                ${renderComment(c, likesCountMap, likedByMeSet)}
                ${renderRepliesForRoot(c.id, childrenMap, likesCountMap, likedByMeSet)}
            </div>`).join('')
        : '<p class="fb-empty-comments">لا توجد تعليقات بعد. كن أول من يعلق!</p>';

    return `
    <div class="fb-comments-wrap">
        <div class="fb-comments-header">التعليقات (${totalCount})</div>
        <div id="fbCommentsList" style="display:flex; flex-direction:column; gap:1rem;">
            ${commentsHtml}
        </div>
        <div class="fb-composer">
            <div class="fb-comment-avatar">${avatarHtml(currentUser.profile)}</div>
            <div class="fb-composer-input-wrap">
                <div class="fb-composer-input" contenteditable="true" id="replyEditor" data-placeholder="اكتب تعليقاً..." oninput="window.forum.handleComposerInput()" onkeydown="window.forum.handleComposerKeydown(event)"></div>
                <button class="fb-send-btn" id="composerSendBtn" onclick="window.forum.submitReply()" title="إرسال">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" style="transform:scaleX(-1);"><path d="M2 21l21-9L2 3v7l15 2-15 2z"/></svg>
                </button>
            </div>
        </div>
    </div>`;
}

async function submitReply() {
    const editor = document.getElementById('replyEditor');
    const content = sanitizeForumHtml(editor.innerHTML);
    if (!content.trim() || content === '<br>') return;

    const { error } = await supabaseClient
        .from('forum_replies')
        .insert([{
            thread_id: currentThreadId,
            author_id: currentUser.id,
            content
        }]);

    if (error) {
        alert('خطأ في إرسال الرد: ' + error.message);
    } else {
        editor.innerHTML = '';
        openThread(currentThreadId); // Refresh
    }
}

/**
 * تبديل الإعجاب (Like/Unlike) على رد معين — نفس سلوك زر "إعجاب" في فيسبوك،
 * بتحديث فوري للواجهة (optimistic update) قبل تأكيد الحفظ في القاعدة،
 * مع التراجع عن التحديث لو فشل الطلب.
 */
async function toggleLike(replyId) {
    const btn = document.getElementById(`like-btn-${replyId}`);
    if (!btn || !currentUser) return;

    const pill = document.getElementById(`like-pill-${replyId}`);
    const countSpan = pill?.querySelector('.like-pill-count');
    const wasLiked = btn.classList.contains('liked');
    let count = parseInt(btn.dataset.count || '0', 10);

    const applyState = (isLiked, newCount) => {
        btn.classList.toggle('liked', isLiked);
        btn.dataset.count = String(newCount);
        if (pill) {
            if (newCount > 0) { pill.style.display = 'flex'; if (countSpan) countSpan.textContent = newCount; }
            else pill.style.display = 'none';
        }
    };

    // تحديث متفائل فوري
    applyState(!wasLiked, wasLiked ? Math.max(0, count - 1) : count + 1);

    try {
        if (wasLiked) {
            const { error } = await supabaseClient.from('forum_likes').delete().eq('reply_id', replyId).eq('user_id', currentUser.id);
            if (error) throw error;
        } else {
            const { error } = await supabaseClient.from('forum_likes').insert([{ reply_id: replyId, user_id: currentUser.id }]);
            if (error) throw error;
        }
    } catch (err) {
        console.error('Error toggling like:', err);
        // تراجع عن التحديث المتفائل عند فشل الطلب
        applyState(wasLiked, count);
    }
}

/**
 * يفتح صندوق رد مصغّر تحت أي تعليق (رئيسي أو فرعي) — بالضبط زي الضغط
 * على "رد" تحت تعليق في فيسبوك. يقفل أي صندوق رد آخر مفتوح قبل كده.
 */
function showReplyBox(parentId) {
    document.querySelectorAll('.fb-reply-box-container').forEach(el => {
        if (el.id !== `reply-box-${parentId}`) el.innerHTML = '';
    });

    const container = document.getElementById(`reply-box-${parentId}`);
    if (!container) return;

    if (container.innerHTML.trim()) {
        container.innerHTML = '';
        return;
    }

    container.innerHTML = `
        <div class="fb-reply-box">
            <div class="fb-comment-avatar">${avatarHtml(currentUser.profile)}</div>
            <div class="fb-reply-input-wrap">
                <div class="fb-reply-input" contenteditable="true" data-placeholder="اكتب رداً..." id="reply-input-${parentId}" onkeydown="window.forum.handleReplyKeydown(event, '${parentId}')"></div>
            </div>
        </div>
        <div class="fb-reply-box-actions" style="padding-inline-start:2.9rem;">
            <button class="btn btn-secondary btn-sm" onclick="window.forum.cancelReplyBox('${parentId}')">إلغاء</button>
            <button class="btn btn-primary btn-sm" onclick="window.forum.submitNestedReply('${parentId}')">رد</button>
        </div>`;

    document.getElementById(`reply-input-${parentId}`)?.focus();
}

function cancelReplyBox(parentId) {
    const container = document.getElementById(`reply-box-${parentId}`);
    if (container) container.innerHTML = '';
}

/**
 * إرسال رد متعشش على تعليق معين (parent_id) — بيحدّث الموضوع كامل بعد
 * الإرسال عشان يضمن دقة الترتيب والتعشيش وعداد الإعجابات.
 */
async function submitNestedReply(parentId) {
    const input = document.getElementById(`reply-input-${parentId}`);
    if (!input) return;
    const content = sanitizeForumHtml(input.innerHTML);
    if (!content.trim() || content === '<br>') return;

    const { error } = await supabaseClient
        .from('forum_replies')
        .insert([{
            thread_id: currentThreadId,
            author_id: currentUser.id,
            parent_id: parentId,
            content
        }]);

    if (error) {
        alert('خطأ في إرسال الرد: ' + error.message);
    } else {
        openThread(currentThreadId);
    }
}

function toggleMoreReplies(rootId) {
    const hiddenDiv = document.getElementById(`hidden-replies-${rootId}`);
    const btn = document.getElementById(`view-more-${rootId}`);
    if (hiddenDiv) hiddenDiv.style.display = 'flex';
    if (btn) btn.style.display = 'none';
}

function handleComposerInput() {
    const editor = document.getElementById('replyEditor');
    const btn = document.getElementById('composerSendBtn');
    if (!editor || !btn) return;
    btn.classList.toggle('active', editor.innerText.trim().length > 0);
}

function handleComposerKeydown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submitReply();
    }
}

function handleReplyKeydown(e, parentId) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submitNestedReply(parentId);
    }
}

/**
 * تنسيق وقت نسبي بالعربية (منذ 5 دقائق، منذ ساعتين...) بنفس أسلوب فيسبوك
 * بدل عرض التاريخ الكامل مباشرة (التاريخ الكامل لسه متاح عبر title عند التحويم).
 */
function timeAgo(dateStr) {
    const diffMs = Date.now() - new Date(dateStr).getTime();
    const sec = Math.floor(diffMs / 1000);
    if (sec < 60) return 'الآن';

    const min = Math.floor(sec / 60);
    if (min < 60) return `منذ ${min} ${min === 1 ? 'دقيقة' : min === 2 ? 'دقيقتين' : min <= 10 ? 'دقائق' : 'دقيقة'}`;

    const hr = Math.floor(min / 60);
    if (hr < 24) return `منذ ${hr} ${hr === 1 ? 'ساعة' : hr === 2 ? 'ساعتين' : hr <= 10 ? 'ساعات' : 'ساعة'}`;

    const day = Math.floor(hr / 24);
    if (day < 30) return `منذ ${day} ${day === 1 ? 'يوم' : day === 2 ? 'يومين' : day <= 10 ? 'أيام' : 'يوم'}`;

    const month = Math.floor(day / 30);
    if (month < 12) return `منذ ${month} ${month === 1 ? 'شهر' : month === 2 ? 'شهرين' : month <= 10 ? 'أشهر' : 'شهر'}`;

    const year = Math.floor(month / 12);
    return `منذ ${year} ${year === 1 ? 'سنة' : year === 2 ? 'سنتين' : year <= 10 ? 'سنوات' : 'سنة'}`;
}

// --- Helpers ---

async function loadSubforumsForModal() {
    const select = document.getElementById('threadSubforum');
    if (!select) return;
    
    const { data, error } = await supabaseClient.from('forum_subforums').select('id, name');
    if (data) {
        select.innerHTML = data.map(s => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join('');
    }
}

function setupRealtime() {
    supabaseClient.channel('forum-changes')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'forum_notifications', filter: `user_id=eq.${currentUser.id}` }, payload => {
            showNotification(payload.new);
        })
        .subscribe();
}

function showNotification(notif) {
    const toast = document.createElement('div');
    toast.style.cssText = 'position:fixed; bottom:20px; right:20px; background:var(--color-accent); color:white; padding:1rem 2rem; border-radius:10px; box-shadow:0 5px 15px rgba(0,0,0,0.2); z-index:10001; animation:slideIn 0.3s ease;';
    toast.innerText = 'لديك إشعار جديد في المنتدى';
    document.body.appendChild(toast);
    setTimeout(() => {
        toast.style.animation = 'slideOut 0.3s ease';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

function debounce(func, wait) {
    let timeout;
    return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}

function formatDate(dateStr) {
    const date = new Date(dateStr);
    return date.toLocaleDateString('ar-EG', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function slugify(text) {
    return text.toString().toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^\w\u0621-\u064A-]+/g, '')
        .replace(/--+/g, '-')
        .replace(/^-+/, '')
        .replace(/-+$/, '');
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Expose functions to global window for onclick events
window.forum = {
    loadCategories,
    openSubforum,
    openThread,
    submitReply,
    editThread: (id) => console.log('Edit', id),
    toggleLike,
    showReplyBox,
    cancelReplyBox,
    submitNestedReply,
    toggleMoreReplies,
    handleComposerInput,
    handleComposerKeydown,
    handleReplyKeydown
};

// Start initialization when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
