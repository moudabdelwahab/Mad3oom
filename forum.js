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
        if (currentUser.role === 'admin') {
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

    renderThreadDetail(thread);
}

function renderThreadDetail(thread) {
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
                            ${currentUser.id === thread.author_id || currentUser.role === 'admin' ? `
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

            <div class="replies-section" style="display: flex; flex-direction: column; gap: 1rem;">
                <h3 style="margin: 1rem 0;">الردود (${thread.replies?.length || 0})</h3>
                ${thread.replies?.map(reply => `
                    <div class="post-item reply-item" id="reply-${escapeHtml(reply.id)}" style="display: flex; background: var(--color-surface); border-radius: 1rem; border: 1px solid var(--color-border); overflow: hidden;">
                        <div class="post-sidebar" style="width: 150px; background: var(--color-muted); padding: 1rem; display: flex; flex-direction: column; align-items: center; gap: 0.5rem; border-left: 1px solid var(--color-border);">
                            <div class="author-avatar-small" style="width: 50px; height: 50px; border-radius: 50%; background: var(--color-surface); display: flex; align-items: center; justify-content: center; font-weight: 700; color: var(--color-primary); border: 2px solid var(--color-border);">
                                ${reply.author?.avatar_url ? `<img src="${sanitizeUrl(reply.author.avatar_url)}" alt="" style="width:100%; height:100%; border-radius:50%; object-fit:cover;">` : escapeHtml(reply.author?.full_name?.charAt(0) || 'U')}
                            </div>
                            <div class="author-name" style="font-size: 0.9rem; font-weight: 600; text-align: center;">${escapeHtml(reply.author?.full_name || 'مستخدم مجهول')}</div>
                        </div>
                        <div class="post-content-wrapper" style="flex: 1; padding: 1rem;">
                            <div class="post-header" style="display: flex; justify-content: space-between; border-bottom: 1px solid var(--color-border); padding-bottom: 0.5rem; margin-bottom: 0.5rem;">
                                <span class="post-date" style="font-size: 0.8rem; color: var(--color-text-secondary);">${formatDate(reply.created_at)}</span>
                                <div class="post-actions">
                                    <button onclick="window.forum.quoteReply('${escapeHtml(reply.id)}')" style="background:none; border:none; color:var(--color-accent); cursor:pointer; font-size:0.85rem;">اقتباس</button>
                                </div>
                            </div>
                            <div class="post-body">
                                <div class="content" style="line-height: 1.5;">${sanitizeForumHtml(reply.content)}</div>
                            </div>
                        </div>
                    </div>
                `).join('') || '<p class="empty-msg" style="text-align: center; padding: 2rem; background: var(--color-muted); border-radius: 1rem;">لا توجد ردود بعد. كن أول من يعلق!</p>'}
            </div>

            <div class="quick-reply" style="background: var(--color-surface); padding: 1.5rem; border-radius: 1rem; border: 1px solid var(--color-border); margin-top: 1rem;">
                <h3 style="margin-bottom: 1rem;">أضف رداً</h3>
                <div id="replyEditor" contenteditable="true" class="rich-editor" style="min-height: 150px; padding: 1rem; border: 1px solid var(--color-border); border-radius: 0.5rem; background: var(--color-muted);" placeholder="اكتب ردك هنا..."></div>
                <button onclick="window.forum.submitReply()" class="btn btn-primary" style="margin-top:1rem; padding: 0.8rem 2.5rem;">إرسال الرد</button>
            </div>
        </div>
    `;
    forumContent.innerHTML = html;
    window.scrollTo({ top: 0, behavior: 'smooth' });
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
    quoteReply: (id) => {
        const replyContent = document.querySelector(`#reply-${id} .content`).innerHTML;
        const editor = document.getElementById('replyEditor');
        editor.innerHTML = `<blockquote style="border-right: 4px solid var(--color-accent); padding-right: 15px; margin-bottom: 15px; color: var(--color-text-secondary); background: rgba(0,0,0,0.05); padding: 10px;">${replyContent}</blockquote><br>`;
        editor.focus();
        editor.scrollIntoView({ behavior: 'smooth' });
    }
};

// Start initialization when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
