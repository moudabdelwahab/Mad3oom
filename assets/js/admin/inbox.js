/**
 * inbox.js — صندوق الرسائل: واجهة الإدارة الوحيدة لشات العملاء
 * ------------------------------------------------------------
 * المحادثات هنا هي نفس جلسات ويدجت الشات (chat-widget.js) وصفحة شات
 * العميل (chat-logic.js)، بكل ردود البوت المحلي و SIE اللي اتكتبت فيها.
 * الصندوق مابيولّدش ردود بوت ولا بينادي SIE — بيقرا اللي اتكتب، وبيكتب
 * رد الدعم بس (inbox-data.js → sendReply).
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
 *   renderThread()        العنوان + الرسايل + شريط الكتابة
 *   renderDetails()       اللوح الجانبي
 *
 * مافيش رسم جزئي لرسالة واحدة: إعادة رسم كاملة أبسط من مزامنة يدوية
 * بتفتكر تحدّث حاجة وتنسى تانية.
 */
import { initSidebar } from './sidebar.js';
import { checkAdminAuth, updateAdminUI } from './auth.js';
import { iconize } from '/assets/js/chat-icons.js';
import {
    STATUS_LABELS, senderKind, displayName, initialsOf, isStaffOriginated,
    lastMessageOf, lastActivityOf, isAwaitingReply, filterSessions, viewCounts,
    messageStats, fillCannedReply, sessionIdFromSearch, sortMessages
} from './inbox-model.js';
import {
    loadSessions, loadSession, loadStaffNames, sendReply, closeSessions,
    loadCannedReplies, signImagePaths, subscribeInbox
} from './inbox-data.js';

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
    me: null,
    sessions: [],
    loaded: false,
    view: 'all',
    activeId: null,
    selected: new Set(),
    drafts: new Map(),
    staffNames: {},
    canned: [],
    detailsOpen: false,
    sending: false,
    /** آخر محادثة اترسمت رسايلها — عشان نعرف إمتى ننزل لآخرها. */
    renderedId: null,
    /** بحث جوه المحادثة: النص، ومكاننا في النتايج. */
    find: { query: '', hits: [], index: 0 },
    pop: null
};

// ═════════════════════════════════════════════════════════════
// أدوات
// ═════════════════════════════════════════════════════════════

const VIEW_META = [
    { id: 'all', label: 'الكل', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>' },
    { id: 'awaiting', label: 'بانتظار رد', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>' },
    { id: 'open', label: 'النشطة', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9"/><polyline points="3 3 3 9 9 9"/></svg>' },
    { id: 'manual', label: 'الدعم ماسكها', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>' },
    { id: 'bot', label: 'مع البوت', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M12 8V4M9 13h.01M15 13h.01"/></svg>' },
    { id: 'closed', label: 'المقفولة', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' }
];

const ROLE_LABELS = {
    customer: 'عميل', user: 'عميل', admin: 'أدمن', support: 'دعم',
    super_user: 'سوبر يوزر', platform_owner: 'مالك المنصة'
};

const QUICK_EMOJI = ['👍', '🙏', '✅', '😀', '😅', '❤️', '🎉', '👏', '🤔', '😢', '💯', '⚡', '📌', '🔥', '👋', '🙂'];

function toast(message, kind = 'ok') {
    const el = $('toast');
    el.textContent = message;
    el.className = kind === 'err' ? 'toast toast--err' : 'toast';
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.hidden = true; }, 3200);
}

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
// الصور المرفقة (المستودع خاص — التوقيع وقت العرض)
// ═════════════════════════════════════════════════════════════

const SIGN_REUSE_MS = 4 * 60 * 1000; // الرابط صالح 5 دقايق؛ بنعيد التوقيع قبلها
const signedCache = new Map();

async function hydrateImages(root) {
    const imgs = Array.from(root.querySelectorAll('img[data-storage-path]'));
    if (!imgs.length) return;

    const now = Date.now();
    const missing = [...new Set(imgs.map((el) => el.dataset.storagePath))]
        .filter((p) => !(signedCache.get(p)?.at > now - SIGN_REUSE_MS));
    if (missing.length) {
        const urls = await signImagePaths(missing).catch(() => []);
        missing.forEach((p, i) => signedCache.set(p, { url: urls[i] || null, at: now }));
    }

    imgs.forEach((el) => {
        const url = signedCache.get(el.dataset.storagePath)?.url;
        el.removeAttribute('data-storage-path');
        // الرابط مابيتسندش لـ src إلا لو https فعلاً.
        if (url && /^https:\/\//i.test(url)) { el.src = url; el.hidden = false; }
        else el.remove();
    });
}

// ═════════════════════════════════════════════════════════════
// الرِف
// ═════════════════════════════════════════════════════════════

function renderRail() {
    const counts = viewCounts(state.sessions);
    $('viewRail').innerHTML = `<div class="ib-rail-title">الصندوق</div>` + VIEW_META.map((view) => `
        <button class="ib-view ${view.id === state.view ? 'is-active' : ''}" data-view="${view.id}">
          ${view.icon}<span>${esc(view.label)}</span>
          ${counts[view.id] ? `<span class="ib-view-count">${counts[view.id]}</span>` : ''}
        </button>`).join('');

    $('viewRail').querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => {
        state.view = b.dataset.view;
        state.selected.clear();
        renderRail();
        renderConversations();
    }));
}

// ═════════════════════════════════════════════════════════════
// القايمة
// ═════════════════════════════════════════════════════════════

function currentRows() {
    return filterSessions(state.sessions, { view: state.view, query: $('convSearch').value });
}

function sessionTags(session) {
    const tags = [];
    if (session.status === 'closed') tags.push(['ok', STATUS_LABELS.closed]);
    else tags.push(session.is_manual_mode ? ['accent', 'الدعم ماسكها'] : ['muted', 'البوت']);
    if (isAwaitingReply(session)) tags.push(['danger', 'بانتظار رد']);
    if (isStaffOriginated(session)) tags.push(['warn', 'فريق العمل']);
    if (!session.user_id) tags.push(['muted', 'زائر']);
    return tags.map(([tone, label]) => `<span class="ib-tag ib-tag--${tone}">${esc(label)}</span>`).join('');
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
        const last = lastMessageOf(session);
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
            <span class="ib-row-preview">${previewOf(session, last)}</span>
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
    const text = stripIcons(message.message_text) || (message.image_url ? 'صورة مرفقة' : '');
    return `${esc(who)}${esc(text.slice(0, 70))}`;
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

    if (refresh) {
        // القايمة ممكن تكون قديمة بثواني — نجيب الجلسة طازة وأسماء الموظفين.
        const fresh = await loadSession(id).catch(() => null);
        if (fresh && state.activeId === id) replaceSession(fresh);
        await refreshStaffNames(findSession(id));
        if (state.activeId === id) { renderThread(); renderDetails(); }
    }
    if (activeSession()?.status === 'active') $('messageInput').focus();
}

function replaceSession(fresh) {
    const index = state.sessions.findIndex((s) => s.id === fresh.id);
    if (index >= 0) state.sessions[index] = fresh; else state.sessions.push(fresh);
}

async function refreshStaffNames(session) {
    const ids = (session?.messages || [])
        .filter((m) => senderKind(m) === 'agent' && m.sender_id && !(m.sender_id in state.staffNames))
        .map((m) => m.sender_id);
    if (!ids.length) return;
    Object.assign(state.staffNames, await loadStaffNames(ids));
}

function closeThread() {
    state.activeId = null;
    state.renderedId = null;
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
    $('threadTags').innerHTML = sessionTags(session);
    $('detailsBtn').classList.toggle('is-on', state.detailsOpen);

    const closed = session.status === 'closed';
    $('closeSessionBtn').hidden = closed;
    $('composer').hidden = closed;
    $('closedNote').hidden = !closed;
    $('composerNote').textContent = session.is_manual_mode
        ? 'الدعم ماسك المحادثة — البوت واقف ومش هيرد على العميل.'
        : 'البوت شغال في المحادثة دي. أول رد منك هيوقّفه، والعميل هيشوف «فريق الدعم انضم».';

    renderMessages(session);
}

function senderLabel(message, kind) {
    if (kind === 'bot') return 'البوت';
    if (kind !== 'agent') return '';
    if (message.sender_id && message.sender_id === state.me?.id) return 'أنت';
    return state.staffNames[message.sender_id] || 'فريق الدعم';
}

function renderMessages(session) {
    const container = $('messageList');
    const list = session.messages || [];
    const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;

    if (!list.length) {
        container.innerHTML = `<div class="ib-empty"><p>مفيش رسايل في المحادثة دي لسه.</p></div>`;
        return;
    }

    let lastDay = '';
    container.innerHTML = list.map((message) => {
        const kind = senderKind(message);
        const side = kind === 'agent' ? 'mine' : kind === 'bot' ? 'bot' : 'theirs';
        const label = senderLabel(message, kind);

        const day = dayLabel(message.created_at);
        const daySep = day === lastDay ? '' : `<div class="ib-day">${esc(day)}</div>`;
        lastDay = day;

        return `${daySep}
        <div class="ib-msg ib-msg--${side} ${state.find.hits.includes(message.id) ? 'is-hit' : ''}" data-message="${esc(message.id)}" tabindex="-1">
          ${label ? `<span class="ib-sender">${esc(label)}</span>` : ''}
          <div class="ib-bubble">
            ${message.image_url ? `<img class="ib-image" data-storage-path="${esc(message.image_url)}" alt="صورة مرفقة" hidden>` : ''}
            ${message.message_text ? `<span class="ib-text">${renderBody(message.message_text)}</span>` : ''}
          </div>
          <div class="ib-msg-meta"><span title="${esc(fullTime(message.created_at))}">${esc(shortTime(message.created_at))}</span></div>
        </div>`;
    }).join('');

    hydrateImages(container);
    // محادثة اتفتحت دلوقتي → آخرها. نفس المحادثة → ننزل بس لو الموظف كان
    // تحت أصلاً، عشان رسالة جديدة ماتشدّوش وهو بيقرا اللي فوق.
    const switched = state.renderedId !== session.id;
    state.renderedId = session.id;
    if (switched || (nearBottom && !state.find.query)) container.scrollTop = container.scrollHeight;
}

/**
 * النص بيتهرب الأول، وبعدين علامة البحث، وبعدين أيقونات البوت — iconize()
 * لازم تيجي بعد التنقية دايمًا (راجع chat-icons.js).
 */
function renderBody(text) {
    let html = esc(text);
    const query = state.find.query.trim();
    if (query) {
        const needle = esc(query);
        html = html.split(needle).join(`<mark>${needle}</mark>`);
    }
    return iconize(html);
}

function jumpTo(messageId) {
    const el = $('messageList').querySelector(`[data-message="${messageId}"]`);
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
    const stats = messageStats(session.messages);
    const kv = (k, v) => `<div class="ib-kv"><span>${esc(k)}</span><span>${esc(v)}</span></div>`;

    pane.innerHTML = `
      <div class="ib-details-sec">
        <h3>العميل</h3>
        ${c ? [
            kv('الاسم', c.full_name || '—'),
            kv('الإيميل', c.email || '—'),
            kv('الهاتف', c.phone || '—'),
            kv('الدور', ROLE_LABELS[c.role] || c.role || '—'),
            kv('عضو من', fullTime(c.created_at))
        ].join('') : kv('النوع', 'زائر من غير حساب')}
      </div>
      <div class="ib-details-sec">
        <h3>المحادثة</h3>
        ${kv('الحالة', STATUS_LABELS[session.status] || session.status || '—')}
        ${kv('مين بيرد', session.status === 'closed' ? '—' : (session.is_manual_mode ? 'فريق الدعم' : 'البوت'))}
        ${kv('اتفتحت', fullTime(session.created_at))}
        ${kv('آخر نشاط', fullTime(lastActivityOf(session)))}
      </div>
      <div class="ib-details-sec">
        <h3>الرسايل (${session.messages.length})</h3>
        ${kv('من العميل', stats.customer)}
        ${kv('من البوت', stats.bot)}
        ${kv('من الدعم', stats.agent)}
        ${kv('صور مرفقة', stats.images)}
      </div>`;
}

// ═════════════════════════════════════════════════════════════
// الكتابة والإرسال
// ═════════════════════════════════════════════════════════════

function autoGrow() {
    const input = $('messageInput');
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 144)}px`;
}

async function send() {
    const session = activeSession();
    const input = $('messageInput');
    const text = input.value.trim();
    if (!session || !text || state.sending) return;

    state.sending = true;
    $('sendBtn').disabled = true;
    try {
        const row = await sendReply({ session, senderId: state.me.id, text });
        session.is_manual_mode = true;
        addMessage(row);
        input.value = '';
        state.drafts.delete(session.id);
        autoGrow();
        closePop();
    } catch (err) {
        // النص بيفضل في الخانة عشان مايضيعش.
        toast(err?.message || 'الرسالة مااتبعتتش. جرّب تاني.', 'err');
    } finally {
        state.sending = false;
        $('sendBtn').disabled = false;
    }
    renderAll();
}

/** رسالة جديدة (من الإرسال أو Realtime) — مرة واحدة بس لكل id. */
function addMessage(row) {
    const session = findSession(row.session_id);
    if (!session) return false;
    if (session.messages.some((m) => m.id === row.id)) return true;
    session.messages = sortMessages([...session.messages, row]);
    return true;
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
        toast(err?.message || 'مقدرناش نقفل المحادثة.', 'err');
    }
    renderAll();
}

// ═════════════════════════════════════════════════════════════
// اللوحة المنبثقة: ردود جاهزة / إيموجي
// ═════════════════════════════════════════════════════════════

function closePop() {
    state.pop = null;
    $('popPanel').hidden = true;
    $('popPanel').innerHTML = '';
}

function openCanned(filter = '') {
    const q = filter.trim().toLowerCase();
    const items = state.canned
        .filter((r) => !q || (r.shortcut || '').toLowerCase().includes(q) || (r.title || '').toLowerCase().includes(q));

    state.pop = 'canned';
    const panel = $('popPanel');
    panel.hidden = false;
    panel.innerHTML = items.length
        ? items.map((r, i) => `<button type="button" class="ib-pop-item ${i === 0 ? 'is-active' : ''}" data-pick="${i}">
            <b>${esc(r.shortcut || r.title)}</b><span>${esc(r.shortcut ? r.title : r.content)}</span></button>`).join('')
        : `<div style="padding:.8rem;text-align:center;color:var(--color-text-secondary);font-size:.82rem">
             ${state.canned.length ? 'مفيش رد مطابق.' : 'مفيش ردود جاهزة لسه — بتتضاف من صفحة التذاكر.'}</div>`;

    panel.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => {
        const reply = items[Number(b.dataset.pick)];
        $('messageInput').value = fillCannedReply(reply.content, activeSession());
        autoGrow();
        closePop();
        $('messageInput').focus();
    }));
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
    if (state.activeId) state.drafts.set(state.activeId, input.value);

    const slash = input.value.match(/(?:^|\s)\/([^\s/]*)$/);
    if (slash) openCanned(slash[1]);
    else if (state.pop === 'canned') closePop();
}

// ═════════════════════════════════════════════════════════════
// البحث جوه المحادثة
// ═════════════════════════════════════════════════════════════

function runFind() {
    const raw = $('findInput').value.trim();
    const query = raw.toLowerCase();
    state.find.query = raw;
    state.find.hits = query
        ? (activeSession()?.messages || []).filter((m) => (m.message_text || '').toLowerCase().includes(query)).map((m) => m.id)
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
    renderAll();
}

let reloadTimer = null;
function scheduleReload() {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(reload, 600);
}

function onRealtimeMessage(row) {
    if (!row?.session_id) return;
    if (!addMessage(row)) { scheduleReload(); return; }
    const session = findSession(row.session_id);
    if (session && row.created_at) session.updated_at = row.created_at;
    if (row.session_id === state.activeId && senderKind(row) === 'agent') refreshStaffNames(session).then(renderAll);
    else renderAll();
}

function onRealtimeSession(eventType, row) {
    if (eventType === 'DELETE' || !row?.id) return;
    const session = findSession(row.id);
    if (!session || eventType === 'INSERT') { scheduleReload(); return; }
    // الـ payload بيجيب أعمدة الجدول بس، من غير profiles والرسايل.
    Object.assign(session, {
        status: row.status, is_manual_mode: row.is_manual_mode, updated_at: row.updated_at
    });
    renderAll();
}

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
        return;
    }
    if (event.key === 'f' && (event.ctrlKey || event.metaKey) && state.activeId) {
        event.preventDefault();
        return openFind();
    }
    if (isTyping()) return;
    switch (event.key) {
        case '/': event.preventDefault(); $('convSearch').focus(); break;
        case 'j': moveSelection(1); break;
        case 'k': moveSelection(-1); break;
        default: break;
    }
}

// ═════════════════════════════════════════════════════════════
// الربط
// ═════════════════════════════════════════════════════════════

function wire() {
    $('convSearch').addEventListener('input', () => { state.selected.clear(); renderConversations(); });
    $('refreshBtn').addEventListener('click', reload);
    $('shortcutsBtn').addEventListener('click', () => $('shortcutsDialog').showModal());
    $('closeShortcuts').addEventListener('click', () => $('shortcutsDialog').close());

    $('backBtn').addEventListener('click', closeThread);
    $('closeSessionBtn').addEventListener('click', () => closeSelected(state.activeId ? [state.activeId] : []));
    $('detailsBtn').addEventListener('click', () => {
        state.detailsOpen = !state.detailsOpen;
        $('detailsBtn').classList.toggle('is-on', state.detailsOpen);
        renderDetails();
    });

    $('findBtn').addEventListener('click', openFind);
    $('findInput').addEventListener('input', runFind);
    $('findNext').addEventListener('click', () => stepFind(1));
    $('findPrev').addEventListener('click', () => stepFind(-1));
    $('findClose').addEventListener('click', closeFind);

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
    fitShellHeight();
    setTimeout(fitShellHeight, 300);

    await reload();
    subscribeInbox({ onMessage: onRealtimeMessage, onSession: onRealtimeSession });

    const deepLink = sessionIdFromSearch(window.location.search);
    if (deepLink) openConversation(deepLink);

    state.canned = await loadCannedReplies();
}

boot();
