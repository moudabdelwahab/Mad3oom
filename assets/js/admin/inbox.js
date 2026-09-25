/**
 * inbox.js — صندوق الرسائل: الـ helpdesk الإداري لشات العملاء
 * ------------------------------------------------------------
 * المحادثات هنا هي نفس جلسات ويدجت الشات (chat-widget.js) وصفحة شات
 * العميل (chat-logic.js)، بكل ردود البوت المحلي و SIE اللي اتكتبت فيها.
 * الصندوق مابيولّدش ردود بوت ولا بينادي SIE — بيقرا اللي اتكتب، وبيضيف
 * طبقة الفريق فوقه: الإسناد، الفرق، التحويل، الوسوم، الملاحظات الداخلية،
 * الأرشفة، والسجل (migrations/055_inbox_helpdesk_core.sql).
 *
 * بيحل محل chat-admin.html. الروابط القديمة ليها (إشعارات القاعدة
 * `chat-admin.html?session=…`) بتتحوّل هنا من vercel.json، والصفحة دي
 * بتفتح المحادثة من `?session=` أو `?session_id=`.
 *
 * ------------------------------------------------------------
 * ترتيب الرسم
 *
 *   renderRail()          الرِف والعدادات
 *   renderConversations() القايمة
 *   renderThread()        العنوان + الخط الزمني + شريط الكتابة
 *   renderDetails()       اللوح الجانبي
 *
 * مافيش رسم جزئي لعنصر واحد: إعادة رسم كاملة أبسط من مزامنة يدوية
 * بتفتكر تحدّث حاجة وتنسى تانية.
 */
import { initSidebar } from './sidebar.js';
import { checkAdminAuth, updateAdminUI } from './auth.js';
import { iconize } from '/assets/js/chat-icons.js';
import { attachmentFromMessage, renderAttachmentHtml, hydrateAttachments, autoLabelFor } from '/assets/js/chat-attachments.js';
import {
    STATUS_LABELS, senderKind, displayName, initialsOf, isStaffOriginated, isArchived,
    lastMessageOf, lastActivityOf, isAwaitingReply, filterSessions, viewCounts,
    messageStats, fillCannedReply, sessionIdFromSearch, sortMessages,
    buildTimeline, describeEvent, extractMentions
} from './inbox-model.js';
import {
    loadSessions, loadSession, loadThreadExtras, loadAgents, loadTeams, loadTags, createSharedTag,
    loadCustomerContext, sendReply, closeSessions, assign, transfer, addTag, removeTag,
    addNote, editNote, deleteNote, forwardAsNote, setArchived, saveTeam, archiveTeam, setTeamMember,
    loadCannedReplies, signAttachmentPaths, subscribeInbox
} from './inbox-data.js';

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
    me: null,
    agents: [],
    teams: [],
    tags: [],
    sessions: [],
    loaded: false,
    view: 'all',
    activeId: null,
    selected: new Set(),
    drafts: new Map(),
    /** الملاحظات والسجل للمحادثة المفتوحة بس. */
    thread: { sessionId: null, notes: [], events: [] },
    customerCtx: new Map(),
    canned: [],
    mode: 'reply',
    editingNoteId: null,
    forwardingId: null,
    detailsOpen: false,
    sending: false,
    /** آخر محادثة اترسمت — عشان نعرف إمتى ننزل لآخرها. */
    renderedId: null,
    find: { query: '', hits: [], index: 0 },
    pop: null
};

// ═════════════════════════════════════════════════════════════
// أدوات
// ═════════════════════════════════════════════════════════════

const ICON = {
    note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M9 13h6M9 17h4"/></svg>',
    forward: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>'
};

const VIEW_META = [
    { id: 'all', label: 'الكل', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>' },
    { id: 'awaiting', label: 'بانتظار رد', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>' },
    { id: 'mine', label: 'المسندة لي', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>' },
    { id: 'team', label: 'فرقي', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>' },
    { id: 'unassigned', label: 'من غير مسؤول', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>' },
    { id: 'open', label: 'النشطة', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9"/><polyline points="3 3 3 9 9 9"/></svg>' },
    { id: 'manual', label: 'الدعم ماسكها', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8h1a4 4 0 0 1 0 8h-1"/><path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"/></svg>' },
    { id: 'bot', label: 'مع البوت', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M12 8V4M9 13h.01M15 13h.01"/></svg>' },
    { id: 'closed', label: 'المقفولة', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' },
    { id: 'archived', label: 'الأرشيف', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="5" rx="1"/><path d="M4 9v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9"/></svg>' }
];

const ROLE_LABELS = {
    customer: 'عميل', user: 'عميل', admin: 'أدمن', support: 'دعم',
    super_user: 'سوبر يوزر', platform_owner: 'مالك المنصة'
};
const TICKET_STATUS = { open: 'مفتوحة', in_progress: 'قيد المعالجة', pending: 'معلّقة', resolved: 'اتحلت', closed: 'مقفولة' };

const QUICK_EMOJI = ['👍', '🙏', '✅', '😀', '😅', '❤️', '🎉', '👏', '🤔', '😢', '💯', '⚡', '📌', '🔥', '👋', '🙂'];

function toast(message, kind = 'ok') {
    const el = $('toast');
    el.textContent = message;
    el.className = kind === 'err' ? 'toast toast--err' : 'toast';
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.hidden = true; }, 3600);
}

const errText = (err, fallback) => err?.message || fallback;

function shortTime(iso) {
    if (!iso) return '';
    const date = new Date(iso);
    const sameDay = date.toDateString() === new Date().toDateString();
    return sameDay
        ? date.toLocaleTimeString('ar-EG', { hour: 'numeric', minute: '2-digit' })
        : date.toLocaleDateString('ar-EG', { day: 'numeric', month: 'short' });
}

function fullTime(iso) {
    return iso ? new Date(iso).toLocaleString('ar-EG', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
}

function dayLabel(iso) {
    const date = new Date(iso);
    if (date.toDateString() === new Date().toDateString()) return 'النهاردة';
    if (date.toDateString() === new Date(Date.now() - 86400000).toDateString()) return 'إمبارح';
    return date.toLocaleDateString('ar-EG', { weekday: 'long', day: 'numeric', month: 'long' });
}

/** رموز [[icon:…]] بتاعة البوت بتتشال من المعاينة — القص ممكن يقطعها نصين. */
const stripIcons = (text) => String(text || '').replace(/\[\[icon:[^\]]+\]\]\s*/g, '');

const findSession = (id) => state.sessions.find((s) => s.id === id) || null;
const activeSession = () => findSession(state.activeId);
const agentById = (id) => state.agents.find((a) => a.id === id) || null;
const agentName = (id) => (id === state.me?.id ? 'أنت' : (agentById(id)?.full_name || agentById(id)?.email || null));
const teamById = (id) => state.teams.find((t) => t.id === id) || null;
const tagById = (id) => state.tags.find((t) => t.id === id) || null;
const meAgent = () => agentById(state.me?.id);
const isElevated = () => !!meAgent()?.is_elevated;
const viewCtx = () => ({ meId: state.me?.id, myTeamIds: meAgent()?.team_ids || [] });
const tagNames = () => Object.fromEntries(state.tags.map((t) => [t.id, t.name]));

/**
 * بيخلّي الصندوق يملا الباقي من الشاشة بالظبط.
 *
 * ⚠️ الحسبة بإحداثيات **المستند** مش الشاشة: `getBoundingClientRect().top`
 * بيبقى بالسالب لما الصفحة تتمرر، ولو اتخلط مع `scrollHeight` الارتفاع
 * بيكبر كل مرة في لفة مالهاش آخر.
 */
function fitShellHeight() {
    const shell = $('inboxShell');
    if (!shell) return;
    const box = shell.getBoundingClientRect();
    const shellTop = window.scrollY + box.top;
    const below = document.documentElement.scrollHeight - (window.scrollY + box.bottom);
    document.documentElement.style.setProperty('--ib-height', `${Math.max(360, window.innerHeight - shellTop - below)}px`);
}

// ═════════════════════════════════════════════════════════════
// المرفقات (صور، صوت، ملفات) — نفس chat-attachments.js بتاع صفحة العميل
// ═════════════════════════════════════════════════════════════

/**
 * التوقيع مع كاش قصير: الخط الزمني بيترسم تاني مع كل رسالة جديدة، ومن غير
 * الكاش كل رسمة كانت طلب توقيع جديد لكل مرفق.
 */
const SIGN_REUSE_MS = 4 * 60 * 1000; // الرابط صالح 5 دقايق؛ بنعيد التوقيع قبلها
const signedCache = new Map();

async function signCached(paths, { download = false } = {}) {
    const now = Date.now();
    const key = (p) => `${download ? 'd' : 'v'}:${p}`;
    const missing = [...new Set(paths)].filter((p) => !(signedCache.get(key(p))?.at > now - SIGN_REUSE_MS));
    if (missing.length) {
        const urls = await signAttachmentPaths(missing, { download });
        missing.forEach((p, i) => signedCache.set(key(p), { url: urls?.[i] || null, at: now }));
    }
    // الرابط مابيتسندش لعنصر إلا لو http(s) فعلاً — مش javascript: ولا data:.
    return paths.map((p) => {
        const url = signedCache.get(key(p))?.url;
        return url && /^https?:\/\//i.test(url) ? url : null;
    });
}

const hydrateMessageAttachments = (root) => hydrateAttachments(root, signCached);

/** المرفق + النص المعروض: النص التلقائي («صورة مرفقة») بيتخفى لأن المرفق نفسه ظاهر. */
function messageParts(message) {
    const att = attachmentFromMessage(message);
    const raw = message.message_text || '';
    return { att, text: att && raw === autoLabelFor(att) ? '' : raw };
}

// ═════════════════════════════════════════════════════════════
// الرِف
// ═════════════════════════════════════════════════════════════

function renderRail() {
    const counts = viewCounts(state.sessions, viewCtx());
    const views = VIEW_META.filter((v) => v.id !== 'team' || (meAgent()?.team_ids || []).length);
    $('viewRail').innerHTML = `<div class="ib-rail-title">الصندوق</div>` + views.map((view) => `
        <button class="ib-view ${view.id === state.view ? 'is-active' : ''}" data-view="${view.id}">
          ${view.icon}<span>${esc(view.label)}</span>
          ${counts[view.id] ? `<span class="ib-view-count">${counts[view.id]}</span>` : ''}
        </button>`).join('')
        + (isElevated() ? `<div class="ib-rail-action"><button type="button" class="btn btn-secondary" id="manageTeamsBtn">إدارة الفرق</button></div>` : '');

    $('viewRail').querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => {
        state.view = b.dataset.view;
        state.selected.clear();
        renderRail();
        renderConversations();
    }));
    $('manageTeamsBtn')?.addEventListener('click', openTeamsDialog);
}

// ═════════════════════════════════════════════════════════════
// القايمة
// ═════════════════════════════════════════════════════════════

function currentRows() {
    return filterSessions(state.sessions, {
        view: state.view, query: $('convSearch').value, ctx: viewCtx(), tagNames: tagNames()
    });
}

function tagChip(tagId) {
    const tag = tagById(tagId);
    if (!tag) return '';
    return `<span class="ib-tag" style="background:${esc(tag.color)}22;color:${esc(tag.color)}">${esc(tag.name)}</span>`;
}

function sessionTags(session, { withTags = true } = {}) {
    const tags = [];
    if (session.status === 'closed') tags.push(['ok', STATUS_LABELS.closed]);
    else tags.push(session.is_manual_mode ? ['accent', 'الدعم ماسكها'] : ['muted', 'البوت']);
    if (isAwaitingReply(session)) tags.push(['danger', 'بانتظار رد']);
    if (isArchived(session)) tags.push(['muted', 'مؤرشفة']);
    if (isStaffOriginated(session)) tags.push(['warn', 'فريق العمل']);
    if (!session.user_id) tags.push(['muted', 'زائر']);
    const meta = session.meta || {};
    if (meta.assignee_id) tags.push(['muted', `👤 ${agentName(meta.assignee_id) || 'موظف'}`]);
    if (meta.team_id) tags.push(['muted', `👥 ${teamById(meta.team_id)?.name || 'فريق'}`]);
    return tags.map(([tone, label]) => `<span class="ib-tag ib-tag--${tone}">${esc(label)}</span>`).join('')
        + (withTags ? (session.tagIds || []).map(tagChip).join('') : '');
}

function renderConversations() {
    const list = $('convList');
    $('bulkBar').hidden = state.selected.size === 0;
    $('bulkCount').textContent = `${state.selected.size} مختارة`;

    if (!state.loaded) return;
    const rows = currentRows();
    if (!rows.length) {
        list.innerHTML = `<div class="ib-empty" style="padding:2.5rem 1rem;">
            <p>${$('convSearch').value.trim() ? 'مفيش محادثة مطابقة.' : 'مفيش محادثات في المشهد ده.'}</p></div>`;
        return;
    }

    list.innerHTML = rows.map((session) => {
        const name = displayName(session);
        return `
        <div class="ib-row ${session.id === state.activeId ? 'is-active' : ''} ${state.selected.has(session.id) ? 'is-selected' : ''}"
             data-conversation="${esc(session.id)}" role="button" tabindex="0">
          <input type="checkbox" class="ib-row-check" data-select="${esc(session.id)}"
                 ${state.selected.has(session.id) ? 'checked' : ''} aria-label="اختيار المحادثة">
          <div class="ib-avatar ${session.user_id ? '' : 'ib-avatar--guest'}">${esc(initialsOf(name))}</div>
          <span class="ib-row-main">
            <span class="ib-row-top">
              <span class="ib-row-title">${esc(name)}</span>
              <span class="ib-row-time">${esc(shortTime(lastActivityOf(session)))}</span>
            </span>
            <span class="ib-row-preview">${previewOf(session, lastMessageOf(session))}</span>
            <span class="ib-row-meta">${sessionTags(session)}</span>
          </span>
        </div>`;
    }).join('');

    list.querySelectorAll('[data-conversation]').forEach((row) => {
        row.addEventListener('click', (e) => {
            if (e.target.matches('[data-select]')) return;
            openConversation(row.dataset.conversation);
        });
        row.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openConversation(row.dataset.conversation); }
        });
    });
    list.querySelectorAll('[data-select]').forEach((box) => {
        box.addEventListener('change', () => {
            const id = box.dataset.select;
            if (box.checked) state.selected.add(id); else state.selected.delete(id);
            renderConversations();
        });
    });
}

/** سطر المعاينة: مسودة الموظف الأول، وبعدين آخر رسالة ومين كاتبها. */
function previewOf(session, message) {
    const draft = state.drafts.get(session.id);
    if (draft) return `<span style="color:var(--color-danger)">مسودة:</span> ${esc(draft.slice(0, 45))}`;
    if (!message) return '<span style="opacity:.6">مفيش رسايل لسه</span>';

    const kind = senderKind(message);
    const who = kind === 'agent' ? 'الدعم: ' : kind === 'bot' ? 'البوت: ' : '';
    const att = attachmentFromMessage(message);
    const text = stripIcons(message.message_text) || (att ? autoLabelFor(att) : '');
    return `${esc(who)}${att ? '📎 ' : ''}${esc(text.slice(0, 70))}`;
}

// ═════════════════════════════════════════════════════════════
// المحادثة
// ═════════════════════════════════════════════════════════════

async function openConversation(id, { refresh = true } = {}) {
    let session = findSession(id);
    if (!session) {
        // رابط مباشر لمحادثة مش في القايمة (أحدث من التحميل مثلاً).
        session = await loadSession(id).catch(() => null);
        if (!session) { toast('المحادثة دي مش موجودة أو مش مسموحلك تشوفها.', 'err'); return; }
        state.sessions.push(session);
    }

    if (state.activeId && state.activeId !== id) state.drafts.set(state.activeId, $('messageInput').value);
    state.activeId = id;
    state.thread = { sessionId: id, notes: [], events: [] };
    cancelEdit();
    closeFind();
    closePop();

    // الرابط بيوصف المحادثة المفتوحة — ينفع يتبعت لزميل.
    const url = new URL(window.location.href);
    url.searchParams.delete('session_id');
    url.searchParams.set('session', id);
    history.replaceState(null, '', url);

    $('threadEmpty').hidden = true;
    $('threadBody').hidden = false;
    $('inboxShell').classList.add('is-thread-open');
    $('messageInput').value = state.drafts.get(id) || '';
    autoGrow();

    renderThread();
    renderConversations();
    renderDetails();

    if (refresh) await refreshThread(id, { withSession: true });
    if (activeSession()?.status === 'active' || state.mode === 'note') $('messageInput').focus();
}

/**
 * الملاحظات والسجل وسياق العميل، والجلسة نفسها لو `withSession`.
 *
 * بعد أي إجراء بنجيب الملاحظات والسجل بس: الجلسة بتتحدّث من اللي الـ RPC
 * رجّعه ومن Realtime، وإعادة قراءتها ممكن ترجّع نسخة أقدم من اللي لسه
 * اتكتب وتمسح التحديث من الشاشة.
 */
async function refreshThread(id, { withSession = false } = {}) {
    const [fresh, extras] = await Promise.all([
        withSession ? loadSession(id).catch(() => null) : null,
        loadThreadExtras(id).catch((err) => { console.warn('[inbox] الملاحظات/السجل:', err?.message || err); return null; })
    ]);
    if (state.activeId !== id) return;
    if (fresh) replaceSession(fresh);
    if (extras) state.thread = { sessionId: id, ...extras };
    const userId = findSession(id)?.user_id;
    if (userId && !state.customerCtx.has(userId)) {
        state.customerCtx.set(userId, await loadCustomerContext(userId));
    }
    if (state.activeId === id) { renderThread(); renderDetails(); renderConversations(); }
}

function replaceSession(fresh) {
    const index = state.sessions.findIndex((s) => s.id === fresh.id);
    if (index >= 0) state.sessions[index] = fresh; else state.sessions.push(fresh);
}

function dropSession(id) {
    state.sessions = state.sessions.filter((s) => s.id !== id);
    state.selected.delete(id);
    if (state.activeId === id) closeThread();
}

function closeThread() {
    state.activeId = null;
    state.renderedId = null;
    state.thread = { sessionId: null, notes: [], events: [] };
    cancelEdit();
    $('threadBody').hidden = true;
    $('threadEmpty').hidden = false;
    $('inboxShell').classList.remove('is-thread-open');
    const url = new URL(window.location.href);
    url.searchParams.delete('session');
    url.searchParams.delete('session_id');
    history.replaceState(null, '', url);
    renderConversations();
    renderDetails();
}

function renderAssignmentControls(session) {
    const meta = session.meta || {};
    const team = meta.team_id ? teamById(meta.team_id) : null;
    // لو فيه فريق، المسؤول لازم يكون من أعضائه (القاعدة بترفض غير كده).
    const pool = team ? state.agents.filter((a) => team.members.some((m) => m.user_id === a.id)) : state.agents;

    $('assigneeSelect').innerHTML = `<option value="">من غير مسؤول</option>` + pool.map((a) =>
        `<option value="${esc(a.id)}" ${meta.assignee_id === a.id ? 'selected' : ''}>${esc(a.id === state.me?.id ? `أنا (${a.full_name || a.email})` : (a.full_name || a.email))}</option>`).join('');
    $('teamSelect').innerHTML = `<option value="">من غير فريق</option>` + state.teams.map((t) =>
        `<option value="${esc(t.id)}" ${meta.team_id === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
    $('teamSelect').hidden = state.teams.length === 0;
}

function renderThread() {
    const session = activeSession();
    if (!session) return;
    const name = displayName(session);

    const avatar = $('threadAvatar');
    avatar.className = `ib-avatar ${session.user_id ? '' : 'ib-avatar--guest'}`;
    avatar.textContent = initialsOf(name);
    $('threadTitle').textContent = name;
    $('threadSub').textContent = [
        session.customer?.email,
        session.status === 'closed' ? 'محادثة مقفولة' : 'محادثة نشطة'
    ].filter(Boolean).join(' · ');
    $('threadTags').innerHTML = sessionTags(session, { withTags: false });
    $('detailsBtn').classList.toggle('is-on', state.detailsOpen);
    $('archiveBtn').classList.toggle('is-on', isArchived(session));
    $('archiveBtn').title = isArchived(session) ? 'رجّع من الأرشيف' : 'أرشفة';
    renderAssignmentControls(session);

    const closed = session.status === 'closed';
    $('closeSessionBtn').hidden = closed;
    $('closedNote').hidden = !closed;
    // المقفولة: الرد للعميل مش هيوصل، لكن الملاحظة للفريق لسه مفيدة.
    const replyBtn = $('modeToggle').querySelector('[data-mode="reply"]');
    replyBtn.disabled = closed;
    if (closed && state.mode === 'reply') setMode('note');
    updateComposerNote(session);

    renderMessages(session);
}

function updateComposerNote(session) {
    $('composerNote').textContent = state.mode === 'note'
        ? 'ملاحظة داخلية — العميل مش هيشوفها. اكتب @ عشان تذكر حد من الفريق.'
        : (session.is_manual_mode
            ? 'الدعم ماسك المحادثة — البوت واقف ومش هيرد على العميل.'
            : 'البوت شغال في المحادثة دي. أول رد منك هيوقّفه، والعميل هيشوف «فريق الدعم انضم».');
}

function senderLabel(message, kind) {
    if (kind === 'bot') return 'البوت';
    if (kind !== 'agent') return '';
    return agentName(message.sender_id) || 'فريق الدعم';
}

function renderMessage(message) {
    const kind = senderKind(message);
    const side = kind === 'agent' ? 'mine' : kind === 'bot' ? 'bot' : 'theirs';
    const label = senderLabel(message, kind);
    const hit = state.find.hits.includes(message.id);
    const { att, text } = messageParts(message);
    return `
        <div class="ib-msg ib-msg--${side} ${hit ? 'is-hit' : ''}" data-message="${esc(message.id)}" tabindex="-1">
          ${label ? `<span class="ib-sender">${esc(label)}</span>` : ''}
          ${message.message_text ? `<div class="ib-tools">
            <button type="button" data-act="forward" data-id="${esc(message.id)}" title="تحويل كملاحظة داخلية لمحادثة تانية">${ICON.forward}</button>
          </div>` : ''}
          <div class="ib-bubble">
            ${att ? renderAttachmentHtml(att, esc) : ''}
            ${text ? `<span class="ib-text">${renderBody(text)}</span>` : ''}
          </div>
          <div class="ib-msg-meta"><span title="${esc(fullTime(message.created_at))}">${esc(shortTime(message.created_at))}</span></div>
        </div>`;
}

function renderNote(note) {
    const mine = note.author_id === state.me?.id;
    const canDelete = mine || isElevated();
    const hit = state.find.hits.includes(note.id);
    const tools = note.deleted_at ? '' : `<div class="ib-tools">
        ${mine ? `<button type="button" data-act="edit-note" data-id="${esc(note.id)}" title="تعديل">${ICON.edit}</button>` : ''}
        ${canDelete ? `<button type="button" data-act="delete-note" data-id="${esc(note.id)}" title="سحب">${ICON.trash}</button>` : ''}
      </div>`;
    return `
        <div class="ib-msg ib-msg--note ${hit ? 'is-hit' : ''}" data-note="${esc(note.id)}" tabindex="-1">
          ${mine || canDelete ? tools : ''}
          <div class="ib-bubble">
            <div class="ib-note-flag">${ICON.note}<span>ملاحظة داخلية — العميل مايشوفهاش · ${esc(agentName(note.author_id) || 'موظف')}</span></div>
            ${note.deleted_at
                ? '<div class="ib-deleted">الملاحظة دي اتسحبت.</div>'
                : `<span class="ib-text">${renderBody(note.body, note.mentions)}</span>`}
          </div>
          <div class="ib-msg-meta"><span title="${esc(fullTime(note.created_at))}">${esc(shortTime(note.created_at))}</span>
            ${note.edited_at && !note.deleted_at ? '<span>· اتعدلت</span>' : ''}</div>
        </div>`;
}

function renderEvent(event) {
    // الجملة بصيغة الغائب («هبة أسندت…»)، فالاسم مش «أنت».
    const fullName = (id) => agentById(id)?.full_name || agentById(id)?.email || null;
    const text = describeEvent(event, { actor: fullName, agent: fullName, team: (id) => teamById(id)?.name });
    return `<div class="ib-event" title="${esc(fullTime(event.created_at))}">${esc(text)} · ${esc(shortTime(event.created_at))}</div>`;
}

function renderMessages(session) {
    const container = $('messageList');
    const extras = state.thread.sessionId === session.id ? state.thread : { notes: [], events: [] };
    const timeline = buildTimeline(session.messages, extras.notes, extras.events);
    const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;

    if (!timeline.length) {
        container.innerHTML = `<div class="ib-empty"><p>مفيش رسايل في المحادثة دي لسه.</p></div>`;
        return;
    }

    let lastDay = '';
    container.innerHTML = timeline.map(({ type, at, item }) => {
        const day = dayLabel(at);
        const daySep = day === lastDay ? '' : `<div class="ib-day">${esc(day)}</div>`;
        lastDay = day;
        if (type === 'note') return daySep + renderNote(item);
        if (type === 'event') return daySep + renderEvent(item);
        return daySep + renderMessage(item);
    }).join('');

    container.querySelectorAll('[data-act]').forEach((button) => button.addEventListener('click', () => {
        const { act, id } = button.dataset;
        if (act === 'forward') openForwardDialog(id);
        if (act === 'edit-note') startEditNote(id);
        if (act === 'delete-note') removeNote(id);
    }));

    hydrateMessageAttachments(container);
    // الصورة بتتفتح بحجمها الكامل (رابط موقَّع قصير العمر) في تبويب جديد.
    container.querySelectorAll('.cw-att-image').forEach((btn) => btn.addEventListener('click', () => {
        const src = btn.querySelector('img')?.src;
        if (src && btn.classList.contains('is-ready')) window.open(src, '_blank', 'noopener');
    }));
    // محادثة اتفتحت دلوقتي → آخرها. نفس المحادثة → ننزل بس لو الموظف كان
    // تحت أصلاً، عشان رسالة جديدة ماتشدّوش وهو بيقرا اللي فوق.
    const switched = state.renderedId !== session.id;
    state.renderedId = session.id;
    if (switched || (nearBottom && !state.find.query)) container.scrollTop = container.scrollHeight;
}

/**
 * النص بيتهرب الأول، وبعدين المنشن وعلامة البحث، وبعدين أيقونات البوت —
 * iconize() لازم تيجي بعد التنقية دايمًا (راجع chat-icons.js).
 */
function renderBody(text, mentions = []) {
    let html = esc(text);
    for (const id of mentions || []) {
        const name = agentById(id)?.full_name;
        if (name) html = html.split(esc(`@${name}`)).join(`<span class="ib-mention">@${esc(name)}</span>`);
    }
    const query = state.find.query.trim();
    if (query) {
        const needle = esc(query);
        html = html.split(needle).join(`<mark>${needle}</mark>`);
    }
    return iconize(html);
}

function jumpTo(id) {
    const el = $('messageList').querySelector(`[data-message="${id}"], [data-note="${id}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('is-jumped');
    setTimeout(() => el.classList.remove('is-jumped'), 1300);
}

// ═════════════════════════════════════════════════════════════
// لوح التفاصيل
// ═════════════════════════════════════════════════════════════

function renderDetails() {
    const pane = $('detailsPane');
    pane.hidden = !state.detailsOpen;
    $('inboxShell').classList.toggle('has-details', state.detailsOpen);
    if (!state.detailsOpen) return;

    const session = activeSession();
    if (!session) { pane.innerHTML = ''; return; }

    const c = session.customer;
    const meta = session.meta || {};
    const stats = messageStats(session.messages);
    const ctx = state.customerCtx.get(session.user_id) || null;
    const kv = (k, v) => `<div class="ib-kv"><span>${esc(k)}</span><span>${esc(v)}</span></div>`;
    const canCreateTag = state.me?.profile?.role === 'admin';

    pane.innerHTML = `
      <button type="button" class="ib-details-back" data-close-details>→ رجوع للمحادثة</button>
      <div class="ib-details-sec">
        <h3>الإسناد</h3>
        ${kv('المسؤول', meta.assignee_id ? (agentName(meta.assignee_id) || 'موظف') : 'مافيش')}
        ${kv('الفريق', meta.team_id ? (teamById(meta.team_id)?.name || 'فريق') : 'مافيش')}
        ${kv('الحالة', STATUS_LABELS[session.status] || session.status || '—')}
        ${kv('مين بيرد', session.status === 'closed' ? '—' : (session.is_manual_mode ? 'فريق الدعم' : 'البوت'))}
        ${isArchived(session) ? kv('مؤرشفة', fullTime(meta.archived_at)) : ''}
      </div>
      <div class="ib-details-sec">
        <h3>الوسوم</h3>
        <div class="ib-labels">${state.tags.length ? state.tags.map((tag) => `
          <button type="button" class="ib-label-btn ${(session.tagIds || []).includes(tag.id) ? 'is-on' : ''}"
                  style="--tag-color:${esc(tag.color)}" data-tag="${esc(tag.id)}">${esc(tag.name)}</button>`).join('')
            : '<span class="ib-thread-sub">مفيش وسوم لسه.</span>'}</div>
        ${canCreateTag ? `<div class="ib-team-add"><input type="text" class="ib-select" style="max-width:none;flex:1" id="newTagName" maxlength="40" placeholder="وسم جديد (للتذاكر والشات)">
          <button type="button" class="btn btn-secondary" id="createTagBtn" style="padding:.3rem .6rem;font-size:.75rem">إضافة</button></div>` : ''}
      </div>
      <div class="ib-details-sec">
        <h3>العميل</h3>
        ${c ? [
            kv('الاسم', c.full_name || '—'),
            kv('الإيميل', c.email || '—'),
            kv('الهاتف', c.phone || '—'),
            kv('الدور', ROLE_LABELS[c.role] || c.role || '—'),
            kv('عضو من', fullTime(c.created_at))
        ].join('') : kv('النوع', 'زائر من غير حساب')}
        ${ctx?.notes?.length ? `<ul class="ib-details-list" style="margin-top:.4rem">${ctx.notes.map((n) =>
            `<li>${esc(n.note)}<small>${esc(fullTime(n.created_at))}</small></li>`).join('')}</ul>` : ''}
        ${session.user_id ? `<a class="ib-details-link" href="/customer-history.html?customer_id=${encodeURIComponent(session.user_id)}">سجل العميل وملاحظاته ←</a>` : ''}
      </div>
      ${ctx?.tickets?.length ? `<div class="ib-details-sec">
        <h3>تذاكر العميل</h3>
        <ul class="ib-details-list">${ctx.tickets.map((t) =>
            `<li>#${esc(t.ticket_number ?? '')} ${esc(t.title || 'تذكرة')}<small>${esc(TICKET_STATUS[t.status] || t.status || '')} · ${esc(fullTime(t.created_at))}</small></li>`).join('')}</ul>
        <a class="ib-details-link" href="/admin/tickets.html">صفحة التذاكر ←</a>
      </div>` : ''}
      <div class="ib-details-sec">
        <h3>المحادثة</h3>
        ${kv('اتفتحت', fullTime(session.created_at))}
        ${kv('آخر نشاط', fullTime(lastActivityOf(session)))}
        ${kv('من العميل', stats.customer)}
        ${kv('من البوت', stats.bot)}
        ${kv('من الدعم', stats.agent)}
        ${kv('مرفقات', stats.attachments)}
        ${kv('ملاحظات داخلية', state.thread.sessionId === session.id ? state.thread.notes.filter((n) => !n.deleted_at).length : '…')}
      </div>`;

    pane.querySelectorAll('[data-tag]').forEach((b) => b.addEventListener('click', () => toggleTag(session.id, b.dataset.tag)));
    pane.querySelector('[data-close-details]')?.addEventListener('click', () => {
        state.detailsOpen = false;
        renderDetails();
        $('detailsBtn').classList.remove('is-on');
    });
    $('createTagBtn')?.addEventListener('click', createTagFromDetails);
}

async function toggleTag(sessionId, tagId) {
    const session = findSession(sessionId);
    if (!session) return;
    const on = (session.tagIds || []).includes(tagId);
    try {
        if (on) await removeTag(sessionId, tagId); else await addTag(sessionId, tagId);
        session.tagIds = on ? session.tagIds.filter((t) => t !== tagId) : [...(session.tagIds || []), tagId];
    } catch (err) {
        toast(errText(err, 'الوسم ماتغيرش.'), 'err');
    }
    renderAll();
    if (state.activeId === sessionId) refreshThread(sessionId);
}

async function createTagFromDetails() {
    const input = $('newTagName');
    const name = input?.value.trim();
    if (!name) return;
    try {
        const tag = await createSharedTag(name);
        state.tags = [...state.tags, tag].sort((a, b) => a.name.localeCompare(b.name, 'ar'));
        if (state.activeId) await toggleTag(state.activeId, tag.id);
    } catch (err) {
        toast(errText(err, 'الوسم مااتعملش.'), 'err');
    }
}

// ═════════════════════════════════════════════════════════════
// الإسناد والتحويل والأرشفة والإقفال
// ═════════════════════════════════════════════════════════════

/**
 * بعد أي نقل للمحادثة: لو الموظف مابقاش يوصلها (مش مرتفع، ومش هو المسؤول،
 * ومش في الفريق) القاعدة هتخفيها عنه — فبنشيلها من القايمة فورًا بدل ما
 * تفضل ظاهرة وكل إجراء عليها يرجع «مش مسموح».
 */
function stillHasAccess(meta) {
    if (isElevated()) return true;
    if (!meta) return false;
    return meta.assignee_id === state.me?.id || (meAgent()?.team_ids || []).includes(meta.team_id);
}

function applyMeta(sessionId, meta) {
    const session = findSession(sessionId);
    if (session && meta) session.meta = meta;
    if (meta && !stillHasAccess(meta)) {
        dropSession(sessionId);
        toast('المحادثة اتنقلت ومابقتش في صندوقك.');
    }
}

async function onAssignmentChange(changed) {
    const session = activeSession();
    if (!session) return;
    let assignee = $('assigneeSelect').value || null;
    const teamId = $('teamSelect').value || null;
    // تغيير الفريق لمسؤول مش عضو فيه: المسؤول بيتشال بدل ما القاعدة ترفض.
    if (changed === 'team' && teamId && assignee && !teamById(teamId)?.members.some((m) => m.user_id === assignee)) {
        assignee = null;
    }
    try {
        applyMeta(session.id, await assign(session.id, assignee, teamId));
        toast(assignee || teamId ? 'اتسندت.' : 'اتشال الإسناد.');
    } catch (err) {
        toast(errText(err, 'الإسناد ماتمش.'), 'err');
    }
    renderAll();
    if (state.activeId === session.id) refreshThread(session.id);
}

function openTransferDialog() {
    const session = activeSession();
    if (!session) return;
    $('transferUser').innerHTML = '<option value="">—</option>' + state.agents
        .filter((a) => a.id !== session.meta?.assignee_id)
        .map((a) => `<option value="${esc(a.id)}">${esc(a.full_name || a.email)}${a.is_elevated ? ' (مرتفع)' : ''}</option>`).join('');
    $('transferTeam').innerHTML = '<option value="">—</option>' + state.teams
        .map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
    $('transferReason').value = '';
    $('transferError').textContent = '';
    $('transferDialog').showModal();
}

async function confirmTransfer() {
    const session = activeSession();
    if (!session) return;
    const toUser = $('transferUser').value || null;
    const toTeam = $('transferTeam').value || null;
    const reason = $('transferReason').value.trim();
    if (!toUser && !toTeam) { $('transferError').textContent = 'اختار موظف أو فريق.'; return; }
    if (reason.length < 3) { $('transferError').textContent = 'اكتب سبب التحويل (3 حروف على الأقل).'; return; }
    if (toUser && toTeam && !teamById(toTeam)?.members.some((m) => m.user_id === toUser)) {
        $('transferError').textContent = 'الموظف ده مش عضو في الفريق اللي اخترته.'; return;
    }
    try {
        const meta = await transfer(session.id, toUser, toTeam, reason);
        $('transferDialog').close();
        toast('المحادثة اتحوّلت.');
        applyMeta(session.id, meta);
        renderAll();
        if (state.activeId === session.id) refreshThread(session.id);
    } catch (err) {
        $('transferError').textContent = errText(err, 'التحويل ماتمش.');
    }
}

async function toggleArchive(sessionId = state.activeId) {
    const session = findSession(sessionId);
    if (!session) return;
    const archiving = !isArchived(session);
    try {
        session.meta = await setArchived(session.id, archiving) || session.meta;
        toast(archiving ? 'اتأرشفت.' : 'رجعت من الأرشيف.');
    } catch (err) {
        toast(errText(err, 'الأرشفة ماتمتش.'), 'err');
    }
    renderAll();
    if (state.activeId === session.id) refreshThread(session.id);
}

async function closeSelected(ids) {
    if (!ids.length) return;
    const msg = ids.length === 1
        ? 'تقفل المحادثة دي؟ العميل هيشوف إن فريق الدعم غادر.'
        : `تقفل ${ids.length} محادثة؟ كل عميل هيشوف إن فريق الدعم غادر.`;
    if (!confirm(msg)) return;
    try {
        await closeSessions(ids);
        ids.forEach((id) => { const s = findSession(id); if (s) s.status = 'closed'; });
        state.selected.clear();
        toast(ids.length === 1 ? 'المحادثة اتقفلت.' : `اتقفلت ${ids.length} محادثة.`);
    } catch (err) {
        toast(errText(err, 'مقدرناش نقفل المحادثة.'), 'err');
    }
    renderAll();
    if (state.activeId && ids.includes(state.activeId)) refreshThread(state.activeId);
}

async function bulkArchive() {
    const ids = [...state.selected].filter((id) => { const s = findSession(id); return s && !isArchived(s); });
    let done = 0;
    for (const id of ids) {
        try { findSession(id).meta = await setArchived(id, true); done++; } catch { /* بيتقال تحت */ }
    }
    state.selected.clear();
    toast(done === ids.length ? `اتأرشفت ${done} محادثة.` : `اتأرشفت ${done} من ${ids.length}.`, done === ids.length ? 'ok' : 'err');
    renderAll();
}

// ═════════════════════════════════════════════════════════════
// الكتابة: رد للعميل / ملاحظة داخلية / تعديل ملاحظة
// ═════════════════════════════════════════════════════════════

function setMode(mode) {
    const session = activeSession();
    if (mode === 'reply' && session?.status === 'closed') return;
    state.mode = mode;
    if (mode === 'reply') cancelEdit();
    $('composer').classList.toggle('is-note', mode === 'note');
    $('modeToggle').querySelectorAll('button').forEach((b) => b.classList.toggle('is-on', b.dataset.mode === mode));
    $('messageInput').placeholder = mode === 'note'
        ? 'ملاحظة للفريق — العميل مش هيشوفها… (@ لذكر حد من الفريق)'
        : 'اكتب ردك للعميل… (Enter للإرسال، / لرد جاهز)';
    if (session) updateComposerNote(session);
    closePop();
}

function autoGrow() {
    const input = $('messageInput');
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 144)}px`;
}

function startEditNote(noteId) {
    const note = state.thread.notes.find((n) => n.id === noteId);
    if (!note) return;
    setMode('note');
    state.editingNoteId = noteId;
    $('editingBar').hidden = false;
    $('editingText').textContent = note.body;
    $('messageInput').value = note.body;
    autoGrow();
    $('messageInput').focus();
}

function cancelEdit() {
    if (!state.editingNoteId) return;
    state.editingNoteId = null;
    $('editingBar').hidden = true;
    $('messageInput').value = state.drafts.get(state.activeId) || '';
    autoGrow();
}

async function removeNote(noteId) {
    if (!confirm('تسحب الملاحظة دي؟ مكانها هيفضل باين ومكتوب إنها اتسحبت.')) return;
    try {
        await deleteNote(noteId);
        const note = state.thread.notes.find((n) => n.id === noteId);
        if (note) Object.assign(note, { deleted_at: new Date().toISOString(), body: '' });
    } catch (err) {
        toast(errText(err, 'الملاحظة ماتسحبتش.'), 'err');
    }
    renderThread();
}

function upsertNote(note) {
    if (!note || note.session_id !== state.thread.sessionId) return;
    const i = state.thread.notes.findIndex((n) => n.id === note.id);
    if (i >= 0) state.thread.notes[i] = note; else state.thread.notes.push(note);
}

async function send() {
    const session = activeSession();
    const input = $('messageInput');
    const text = input.value.trim();
    if (!session || !text || state.sending) return;

    state.sending = true;
    $('sendBtn').disabled = true;
    try {
        if (state.editingNoteId) {
            upsertNote(await editNote(state.editingNoteId, text));
            state.editingNoteId = null;
            $('editingBar').hidden = true;
        } else if (state.mode === 'note') {
            const wanted = extractMentions(text, state.agents);
            const note = await addNote(session.id, text, wanted);
            upsertNote(note);
            const dropped = wanted.filter((id) => !(note?.mentions || []).includes(id));
            if (dropped.length) {
                toast(`${dropped.map((id) => agentName(id)).join('، ')} مش واصل للمحادثة دي، فماوصلوش إشعار.`, 'err');
            }
        } else {
            const row = await sendReply(session.id, text);
            session.is_manual_mode = true;
            addMessage(row);
            if (session.meta?.archived_at) session.meta = { ...session.meta, archived_at: null, archived_by: null };
        }
        input.value = '';
        state.drafts.delete(session.id);
        autoGrow();
        closePop();
    } catch (err) {
        // النص بيفضل في الخانة عشان مايضيعش.
        toast(errText(err, 'مااتبعتتش. جرّب تاني.'), 'err');
    } finally {
        state.sending = false;
        $('sendBtn').disabled = false;
    }
    renderAll();
}

/** رسالة جديدة (من الإرسال أو Realtime) — مرة واحدة بس لكل id. */
function addMessage(row) {
    const session = row && findSession(row.session_id);
    if (!session) return false;
    if (session.messages.some((m) => m.id === row.id)) return true;
    session.messages = sortMessages([...session.messages, row]);
    return true;
}

// ═════════════════════════════════════════════════════════════
// تحويل رسالة كملاحظة داخلية (D3)
// ═════════════════════════════════════════════════════════════

function openForwardDialog(messageId) {
    const message = activeSession()?.messages.find((m) => m.id === messageId);
    if (!message) return;
    state.forwardingId = messageId;
    $('forwardPreview').textContent = stripIcons(message.message_text);
    $('forwardSearch').value = '';
    renderForwardPicker();
    $('forwardDialog').showModal();
}

function renderForwardPicker() {
    const q = $('forwardSearch').value.trim().toLowerCase();
    const targets = state.sessions
        .filter((s) => s.id !== state.activeId)
        .filter((s) => !q || displayName(s).toLowerCase().includes(q) || (s.customer?.email || '').toLowerCase().includes(q))
        .sort((a, b) => new Date(lastActivityOf(b) || 0) - new Date(lastActivityOf(a) || 0))
        .slice(0, 50);

    $('forwardPicker').innerHTML = targets.length
        ? targets.map((s) => `<button type="button" class="ib-pick" data-target="${esc(s.id)}">
            <div class="ib-avatar" style="width:1.7rem;height:1.7rem;font-size:.62rem">${esc(initialsOf(displayName(s)))}</div>
            <span class="ib-pick-main"><span>${esc(displayName(s))}</span>
              <span class="ib-pick-sub">${esc(STATUS_LABELS[s.status] || '')} · ${esc(shortTime(lastActivityOf(s)))}</span></span>
          </button>`).join('')
        : '<div style="padding:1.2rem;text-align:center;color:var(--color-text-secondary);font-size:.83rem;">مفيش محادثة تانية.</div>';

    $('forwardPicker').querySelectorAll('[data-target]').forEach((b) => b.addEventListener('click', async () => {
        try {
            await forwardAsNote(state.forwardingId, b.dataset.target);
            $('forwardDialog').close();
            toast('اتحوّلت كملاحظة داخلية.');
        } catch (err) {
            toast(errText(err, 'التحويل ماتمش.'), 'err');
        }
    }));
}

// ═════════════════════════════════════════════════════════════
// الفرق (للسلطة المرتفعة)
// ═════════════════════════════════════════════════════════════

function openTeamsDialog() {
    $('teamsError').textContent = '';
    $('newTeamName').value = '';
    renderTeamsList();
    $('teamsDialog').showModal();
}

function renderTeamsList() {
    const roleLabel = { lead: 'قائد', member: 'عضو' };
    $('teamsList').innerHTML = state.teams.length ? state.teams.map((team) => {
        const outside = state.agents.filter((a) => !team.members.some((m) => m.user_id === a.id));
        return `<div class="ib-team" data-team="${esc(team.id)}">
          <div class="ib-team-head"><b>${esc(team.name)}</b>
            <span class="ib-thread-sub">${team.members.length} عضو</span>
            <button type="button" class="btn btn-secondary" style="padding:.2rem .5rem;font-size:.72rem" data-archive-team="${esc(team.id)}">أرشفة</button></div>
          ${team.members.map((m) => `<div class="ib-team-member">
              <span>${esc(agentName(m.user_id) || 'موظف')}</span>
              <select class="ib-select" data-member-role="${esc(m.user_id)}">
                ${['lead', 'member'].map((r) => `<option value="${r}" ${m.role === r ? 'selected' : ''}>${roleLabel[r]}</option>`).join('')}
              </select>
              <button type="button" class="ib-mini" data-remove-member="${esc(m.user_id)}" aria-label="شيل العضو">✕</button>
            </div>`).join('')}
          ${outside.length ? `<div class="ib-team-add">
            <select class="ib-select" style="max-width:none" data-add-select>${outside.map((a) =>
                `<option value="${esc(a.id)}">${esc(a.full_name || a.email)}</option>`).join('')}</select>
            <button type="button" class="btn btn-secondary" style="padding:.3rem .6rem;font-size:.75rem" data-add-member>ضيف</button>
          </div>` : ''}
        </div>`;
    }).join('') : '<p class="ib-thread-sub">مفيش فرق لسه.</p>';

    $('teamsList').querySelectorAll('.ib-team').forEach((box) => {
        const teamId = box.dataset.team;
        box.querySelector('[data-archive-team]')?.addEventListener('click', () => teamAction(
            () => archiveTeam(teamId), `تأرشف الفريق؟ أعضاؤه هيفقدوا الوصول للمحادثات المسندة للفريق.`));
        box.querySelectorAll('[data-member-role]').forEach((sel) => sel.addEventListener('change', () =>
            teamAction(() => setTeamMember(teamId, sel.dataset.memberRole, sel.value))));
        box.querySelectorAll('[data-remove-member]').forEach((b) => b.addEventListener('click', () =>
            teamAction(() => setTeamMember(teamId, b.dataset.removeMember, null))));
        box.querySelector('[data-add-member]')?.addEventListener('click', () =>
            teamAction(() => setTeamMember(teamId, box.querySelector('[data-add-select]').value, 'member')));
    });
}

async function teamAction(fn, confirmText) {
    if (confirmText && !confirm(confirmText)) return;
    $('teamsError').textContent = '';
    try {
        await fn();
        await refreshDirectory();
        renderTeamsList();
        renderAll();
    } catch (err) {
        $('teamsError').textContent = errText(err, 'العملية ماتمتش.');
    }
}

async function refreshDirectory() {
    const [agents, teams] = await Promise.all([loadAgents(), loadTeams()]);
    state.agents = agents;
    state.teams = teams;
}

// ═════════════════════════════════════════════════════════════
// اللوحة المنبثقة: ردود جاهزة / منشن / إيموجي
// ═════════════════════════════════════════════════════════════

function closePop() {
    state.pop = null;
    $('popPanel').hidden = true;
    $('popPanel').innerHTML = '';
}

function openPop(kind, items, onPick, empty) {
    state.pop = kind;
    const panel = $('popPanel');
    panel.hidden = false;
    panel.innerHTML = items.length
        ? items.map((item, i) => `<button type="button" class="ib-pop-item ${i === 0 ? 'is-active' : ''}" data-pick="${i}">
            <b>${esc(item.title)}</b><span>${esc(item.sub || '')}</span></button>`).join('')
        : `<div style="padding:.8rem;text-align:center;color:var(--color-text-secondary);font-size:.82rem">${esc(empty)}</div>`;
    panel.querySelectorAll('[data-pick]').forEach((b) =>
        b.addEventListener('click', () => onPick(items[Number(b.dataset.pick)])));
}

function openCanned(filter = '') {
    const q = filter.trim().toLowerCase();
    const items = state.canned
        .filter((r) => !q || (r.shortcut || '').toLowerCase().includes(q) || (r.title || '').toLowerCase().includes(q))
        .map((r) => ({ title: r.shortcut || r.title, sub: r.shortcut ? r.title : r.content, body: r.content }));
    openPop('canned', items, (item) => {
        $('messageInput').value = fillCannedReply(item.body, activeSession());
        autoGrow();
        closePop();
        $('messageInput').focus();
    }, state.canned.length ? 'مفيش رد مطابق.' : 'مفيش ردود جاهزة لسه — بتتضاف من صفحة التذاكر.');
}

function openMentions(filter = '') {
    const q = filter.trim().toLowerCase();
    const items = state.agents
        .filter((a) => a.id !== state.me?.id && a.full_name)
        .filter((a) => !q || a.full_name.toLowerCase().includes(q))
        .map((a) => ({ title: `@${a.full_name}`, sub: a.email, name: a.full_name }));
    openPop('mention', items, (item) => {
        const input = $('messageInput');
        input.value = input.value.replace(/@[^\s@]*$/, `@${item.name} `);
        autoGrow();
        closePop();
        input.focus();
    }, 'مفيش موظف مطابق.');
}

function openEmoji() {
    state.pop = 'emoji';
    const panel = $('popPanel');
    panel.hidden = false;
    panel.innerHTML = `<div class="ib-emoji-grid">${QUICK_EMOJI.map((e) => `<button type="button" data-emoji="${e}">${e}</button>`).join('')}</div>`;
    panel.querySelectorAll('[data-emoji]').forEach((b) => b.addEventListener('click', () => {
        const input = $('messageInput');
        input.value += b.dataset.emoji;
        autoGrow();
        closePop();
        input.focus();
    }));
}

function onInputChanged() {
    const input = $('messageInput');
    autoGrow();
    if (state.activeId && !state.editingNoteId) state.drafts.set(state.activeId, input.value);

    const slash = input.value.match(/(?:^|\s)\/([^\s/]*)$/);
    const mention = state.mode === 'note' ? input.value.match(/(?:^|\s)@([^\s@]*)$/) : null;
    if (slash) openCanned(slash[1]);
    else if (mention) openMentions(mention[1]);
    else if (state.pop === 'canned' || state.pop === 'mention') closePop();
}

// ═════════════════════════════════════════════════════════════
// البحث جوه المحادثة (الرسايل والملاحظات)
// ═════════════════════════════════════════════════════════════

function runFind() {
    const raw = $('findInput').value.trim();
    const query = raw.toLowerCase();
    state.find.query = raw;
    const session = activeSession();
    state.find.hits = query && session
        ? buildTimeline(session.messages, state.thread.notes, [])
            .filter(({ type, item }) => ((type === 'note' ? item.body : item.message_text) || '').toLowerCase().includes(query))
            .map(({ item }) => item.id)
        : [];
    state.find.index = 0;

    $('findCount').textContent = query
        ? (state.find.hits.length ? `1 / ${state.find.hits.length}` : 'مفيش نتايج')
        : '';

    renderThread();
    if (state.find.hits.length) jumpTo(state.find.hits[0]);
}

function stepFind(delta) {
    if (!state.find.hits.length) return;
    state.find.index = (state.find.index + delta + state.find.hits.length) % state.find.hits.length;
    $('findCount').textContent = `${state.find.index + 1} / ${state.find.hits.length}`;
    jumpTo(state.find.hits[state.find.index]);
}

function openFind() {
    $('findBar').hidden = false;
    $('findInput').focus();
}

function closeFind() {
    const hadQuery = !!state.find.query;
    $('findBar').hidden = true;
    $('findInput').value = '';
    $('findCount').textContent = '';
    state.find = { query: '', hits: [], index: 0 };
    if (hadQuery && state.activeId) renderThread();
}

// ═════════════════════════════════════════════════════════════
// التحميل و Realtime
// ═════════════════════════════════════════════════════════════

function renderAll() {
    renderRail();
    renderConversations();
    if (state.activeId) renderThread();
    renderDetails();
}

async function reload() {
    try {
        state.sessions = await loadSessions();
        state.loaded = true;
    } catch (err) {
        console.error('[inbox] تحميل المحادثات فشل:', err);
        $('convList').innerHTML = `<div class="ib-empty" style="padding:2.5rem 1rem;">
            <p>حصل خطأ في تحميل المحادثات.</p>
            <button type="button" class="btn btn-secondary" id="retryLoad">حاول تاني</button></div>`;
        $('retryLoad')?.addEventListener('click', reload);
        return;
    }
    if (state.activeId && !findSession(state.activeId)) closeThread();
    renderAll();
}

let reloadTimer = null;
function scheduleReload() {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(reload, 600);
}

const realtime = {
    onMessage(row) {
        if (!row?.session_id) return;
        if (!addMessage(row)) { scheduleReload(); return; }
        const session = findSession(row.session_id);
        if (session && row.created_at) session.updated_at = row.created_at;
        renderAll();
    },
    onSession(eventType, row) {
        if (eventType === 'DELETE' || !row?.id) return;
        const session = findSession(row.id);
        if (!session || eventType === 'INSERT') { scheduleReload(); return; }
        // الـ payload بيجيب أعمدة الجدول بس، من غير العميل والرسايل.
        Object.assign(session, { status: row.status, is_manual_mode: row.is_manual_mode, updated_at: row.updated_at });
        renderAll();
    },
    onMeta(eventType, row, old) {
        const id = row?.session_id || old?.session_id;
        const session = id && findSession(id);
        // محادثة اتسندت لي أو لفريقي دلوقتي ولسه مش في القايمة.
        if (!session) { scheduleReload(); return; }
        session.meta = eventType === 'DELETE' ? null : row;
        renderAll();
    },
    onTag(eventType, row, old) {
        const link = eventType === 'DELETE' ? old : row;
        const session = link?.session_id && findSession(link.session_id);
        if (!session) return;
        const has = session.tagIds.includes(link.tag_id);
        if (eventType === 'DELETE' && has) session.tagIds = session.tagIds.filter((t) => t !== link.tag_id);
        if (eventType === 'INSERT' && !has) session.tagIds = [...session.tagIds, link.tag_id];
        renderAll();
    },
    onNote(_eventType, row) {
        if (row?.session_id !== state.thread.sessionId) return;
        upsertNote(row);
        renderThread();
        renderDetails();
    },
    onEvent(row) {
        if (row?.session_id !== state.thread.sessionId) return;
        if (!state.thread.events.some((e) => e.id === row.id)) state.thread.events.push(row);
        renderThread();
    }
};

// ═════════════════════════════════════════════════════════════
// الاختصارات
// ═════════════════════════════════════════════════════════════

/** بنتجاهل الاختصارات وإحنا بنكتب — وإلا «j» بتنقل بدل ما تتكتب. */
const isTyping = () => ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);

function moveSelection(delta) {
    const rows = currentRows();
    if (!rows.length) return;
    const at = rows.findIndex((s) => s.id === state.activeId);
    const next = rows[Math.min(rows.length - 1, Math.max(0, (at < 0 ? 0 : at + delta)))];
    if (next) openConversation(next.id);
}

function onKeydown(event) {
    if (event.key === 'Escape') {
        if (state.pop) return closePop();
        if (!$('findBar').hidden) return closeFind();
        if (state.editingNoteId) return cancelEdit();
        return;
    }
    if (event.key === 'f' && (event.ctrlKey || event.metaKey) && state.activeId) {
        event.preventDefault();
        return openFind();
    }
    if (isTyping() || document.querySelector('dialog[open]')) return;
    switch (event.key) {
        case '/': event.preventDefault(); $('convSearch').focus(); break;
        case 'j': moveSelection(1); break;
        case 'k': moveSelection(-1); break;
        case 'n': if (state.activeId) setMode(state.mode === 'reply' ? 'note' : 'reply'); break;
        case 'e': if (state.activeId) toggleArchive(); break;
        default: break;
    }
}

// ═════════════════════════════════════════════════════════════
// الربط
// ═════════════════════════════════════════════════════════════

function wire() {
    $('convSearch').addEventListener('input', () => { state.selected.clear(); renderConversations(); });
    $('refreshBtn').addEventListener('click', async () => { await refreshDirectory().catch(() => {}); await reload(); });
    $('shortcutsBtn').addEventListener('click', () => $('shortcutsDialog').showModal());
    $('closeShortcuts').addEventListener('click', () => $('shortcutsDialog').close());

    $('backBtn').addEventListener('click', closeThread);
    $('closeSessionBtn').addEventListener('click', () => closeSelected(state.activeId ? [state.activeId] : []));
    $('archiveBtn').addEventListener('click', () => toggleArchive());
    $('assigneeSelect').addEventListener('change', () => onAssignmentChange('assignee'));
    $('teamSelect').addEventListener('change', () => onAssignmentChange('team'));
    $('transferBtn').addEventListener('click', openTransferDialog);
    $('cancelTransfer').addEventListener('click', () => $('transferDialog').close());
    $('confirmTransfer').addEventListener('click', confirmTransfer);
    $('detailsBtn').addEventListener('click', () => {
        state.detailsOpen = !state.detailsOpen;
        $('detailsBtn').classList.toggle('is-on', state.detailsOpen);
        renderDetails();
    });

    $('forwardSearch').addEventListener('input', renderForwardPicker);
    $('cancelForward').addEventListener('click', () => $('forwardDialog').close());

    $('closeTeams').addEventListener('click', () => $('teamsDialog').close());
    $('createTeamBtn').addEventListener('click', () => {
        const name = $('newTeamName').value.trim();
        if (!name) return;
        teamAction(async () => { await saveTeam(null, name); $('newTeamName').value = ''; });
    });

    $('findBtn').addEventListener('click', openFind);
    $('findInput').addEventListener('input', runFind);
    $('findNext').addEventListener('click', () => stepFind(1));
    $('findPrev').addEventListener('click', () => stepFind(-1));
    $('findClose').addEventListener('click', closeFind);

    $('modeToggle').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
    $('cancelEditBtn').addEventListener('click', cancelEdit);

    const input = $('messageInput');
    input.addEventListener('input', onInputChanged);
    input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            // اللوحة مفتوحة؟ Enter بيختار أول عنصر بدل ما يبعت.
            if (state.pop) {
                $('popPanel').querySelector('[data-pick], [data-emoji]')?.click();
                return;
            }
            send();
        }
    });
    $('sendBtn').addEventListener('click', send);
    $('cannedBtn').addEventListener('click', () => (state.pop === 'canned' ? closePop() : openCanned()));
    $('emojiBtn').addEventListener('click', () => (state.pop === 'emoji' ? closePop() : openEmoji()));

    $('bulkArchiveBtn').addEventListener('click', bulkArchive);
    $('bulkCloseBtn').addEventListener('click', () => closeSelected(
        [...state.selected].filter((id) => findSession(id)?.status !== 'closed')));
    $('bulkClearBtn').addEventListener('click', () => { state.selected.clear(); renderConversations(); });

    document.addEventListener('keydown', onKeydown);
    // ضغطة برّه اللوحة بتقفلها.
    document.addEventListener('click', (e) => {
        if (state.pop && !e.target.closest('.ib-composer-wrap')) closePop();
    });
    window.addEventListener('resize', fitShellHeight);
}

async function boot() {
    initSidebar();
    const user = await checkAdminAuth();
    if (!user) return;
    updateAdminUI(user);
    state.me = user;

    wire();
    setMode('reply');
    fitShellHeight();
    setTimeout(fitShellHeight, 300);

    const [, tags] = await Promise.all([
        refreshDirectory().catch((err) => console.warn('[inbox] الموظفين/الفرق:', err?.message || err)),
        loadTags()
    ]);
    state.tags = tags || [];

    await reload();
    subscribeInbox(realtime);

    const deepLink = sessionIdFromSearch(window.location.search);
    if (deepLink) openConversation(deepLink);

    state.canned = await loadCannedReplies();
}

boot();
