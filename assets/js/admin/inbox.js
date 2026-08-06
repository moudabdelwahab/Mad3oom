/**
 * inbox.js — صندوق الرسائل
 * ------------------------------------------------------------
 * محادثات الأدمن مع أعضاء المنصة، والسوبر يوزر مع أعضائه هو.
 *
 * ⚠️ **واجهة أمامية بس.** كل البيانات جاية من `inbox-data.js` وهي وهمية
 * في الذاكرة. مفيش إرسال حقيقي ولا حفظ — التحديث بيمسح كل حاجة.
 *
 * ------------------------------------------------------------
 * الملف ده مابيعرفش إن البيانات وهمية
 *
 * وده مقصود. كل قراءة وكتابة بتعدي على دوال `inbox-data.js`، فالربط
 * بقاعدة البيانات بعدين هو تغيير في **ملف واحد** — الشاشة دي ماتتلمسش.
 *
 * ------------------------------------------------------------
 * ترتيب الرسم
 *
 * فيه أربع دوال رسم بس، وكل تغيير بينده اللي يخصه:
 *   renderRail()          الرِف والعدادات
 *   renderConversations() القايمة
 *   renderThread()        العنوان + المثبّت + الرسايل
 *   renderDetails()       اللوح الجانبي
 *
 * مافيش رسم جزئي لرسالة واحدة. المحادثة كام عشرة عنصر مش كام ألف،
 * وإعادة رسم كاملة أبسط من مزامنة يدوية بتفتكر تحدّث حاجة وتنسى تانية.
 */
import {
    getCurrentUser, setPreviewRole, listContacts, listAssignableAgents, findContact, initialsOf,
    listConversations, findConversation, displayTitle, viewCounts,
    listMessages, findMessage, lastMessageOf, pinnedMessages, conversationAttachments, readReceipt,
    markRead, sendMessage, editMessage, deleteMessage,
    toggleReaction, toggleStar, togglePin,
    setStatus, setAssignee, toggleLabel, setArchived, setMuted, saveDraft,
    openDirectConversation, createGroup, forwardMessage, totalUnread,
    listCannedReplies, fillCannedReply, STATUS_LABELS, LABEL_COLORS
} from './inbox-data.js';

/**
 * القايمة الجانبية بتتحمّل بشكل منفصل عن الصفحة.
 *
 * `sidebar.js` بيستورد `api-config.js`، واللي بدوره بيجيب مكتبة Supabase
 * من CDN. الاستيراد الثابت كان هيوقّع **الصفحة كلها** لو ده فشل، رغم إن
 * الصندوق مش محتاج Supabase في حاجة.
 */
import('./sidebar.js')
    .then((module) => {
        module.initSidebar();
        setTimeout(fitShellHeight, 300);
    })
    .catch((err) => console.warn('[inbox] القايمة الجانبية ماتحمّلتش:', err?.message || err));

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
    view: 'all',
    activeId: null,
    selected: new Set(),
    pending: [],
    mode: 'reply',
    replyToId: null,
    editingId: null,
    recorder: null,
    recordingStartedAt: 0,
    recordingTimer: null,
    forwardingId: null,
    groupSelection: new Set(),
    detailsOpen: false,
    /** بحث جوه المحادثة: النص، ومكاننا في النتايج. */
    find: { query: '', hits: [], index: 0 },
    /** آخر رسالة كانت مقروءة قبل ما نفتح — عشان فاصل «الجديد». */
    firstUnreadId: null,
    pop: null
};

// ═════════════════════════════════════════════════════════════
// أدوات
// ═════════════════════════════════════════════════════════════

const ICON = {
    doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
    mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/></svg>',
    forward: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/></svg>',
    reply: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>',
    star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15 9 22 9.5 17 14.5 18.5 21.5 12 18 5.5 21.5 7 14.5 2 9.5 9 9"/></svg>',
    pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14l-1.5-3V6a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v8z"/></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>',
    smile: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>',
    note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M9 13h6M9 17h4"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    checks: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 6 7 17 2 12"/><polyline points="22 6 11 17 9 15"/></svg>'
};

const VIEWS = [
    { id: 'all', label: 'الكل', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>' },
    { id: 'unread', label: 'غير المقروءة', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/></svg>' },
    { id: 'mine', label: 'المسندة لي', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>' },
    { id: 'unassigned', label: 'من غير مسؤول', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>' },
    { id: 'open', label: 'المفتوحة', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9"/><polyline points="3 3 3 9 9 9"/></svg>' },
    { id: 'closed', label: 'المقفولة', icon: ICON.check },
    { id: 'archived', label: 'الأرشيف', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="5" rx="1"/><path d="M4 9v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9"/></svg>' }
];

const QUICK_EMOJI = ['👍', '❤️', '😀', '😅', '🙏', '✅', '🔥', '👏', '🎉', '😍', '🤔', '😢', '😮', '💯', '⚡', '📌'];

function toast(message, kind = 'ok') {
    const el = $('toast');
    el.textContent = message;
    el.className = kind === 'err' ? 'toast toast--err' : 'toast';
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.hidden = true; }, 3200);
}

function shortTime(iso) {
    const date = new Date(iso);
    const sameDay = date.toDateString() === new Date().toDateString();
    return sameDay
        ? date.toLocaleTimeString('ar-EG', { hour: 'numeric', minute: '2-digit' })
        : date.toLocaleDateString('ar-EG', { day: 'numeric', month: 'short' });
}

function dayLabel(iso) {
    const date = new Date(iso);
    if (date.toDateString() === new Date().toDateString()) return 'النهاردة';
    if (date.toDateString() === new Date(Date.now() - 86400000).toDateString()) return 'إمبارح';
    return date.toLocaleDateString('ar-EG', { weekday: 'long', day: 'numeric', month: 'long' });
}

function humanSize(bytes) {
    if (!Number.isFinite(bytes)) return '';
    if (bytes < 1024) return `${bytes} بايت`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} ك.ب`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} م.ب`;
}

const clockFormat = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function avatarHtml(name, { group = false, online = false, small = false } = {}) {
    return `<div class="ib-avatar ${group ? 'ib-avatar--group' : ''} ${small ? 'ib-avatar--sm' : ''}" data-online="${online}">${esc(initialsOf(name))}</div>`;
}

function fillAvatar(element, name, { group = false, online = false } = {}) {
    element.className = `ib-avatar ${group ? 'ib-avatar--group' : ''}`;
    element.dataset.online = String(online);
    element.textContent = initialsOf(name);
}

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
// الرِف
// ═════════════════════════════════════════════════════════════

function renderRail() {
    const counts = viewCounts();
    $('viewRail').innerHTML = `<div class="ib-rail-title">الصندوق</div>` + VIEWS.map((view) => `
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
    return listConversations({ view: state.view, query: $('convSearch').value });
}

function renderConversations() {
    const rows = currentRows();
    const list = $('convList');

    $('bulkBar').hidden = state.selected.size === 0;
    $('bulkCount').textContent = `${state.selected.size} مختارة`;

    if (!rows.length) {
        list.innerHTML = `<div class="ib-empty" style="padding:2.5rem 1rem;">
            <p>${$('convSearch').value.trim() ? 'مفيش محادثة مطابقة.' : 'مفيش محادثات في المشهد ده.'}</p></div>`;
        return;
    }

    const me = getCurrentUser();
    list.innerHTML = rows.map((conversation) => {
        const last = lastMessageOf(conversation.id);
        const isGroup = conversation.kind === 'group';
        const other = isGroup ? null : findContact(conversation.memberIds.find((id) => id !== me.id));
        const assignee = conversation.assigneeId ? findContact(conversation.assigneeId) : null;

        return `
        <div class="ib-row ${conversation.id === state.activeId ? 'is-active' : ''} ${state.selected.has(conversation.id) ? 'is-selected' : ''}"
             data-conversation="${esc(conversation.id)}" role="button" tabindex="0">
          <input type="checkbox" class="ib-row-check" data-select="${esc(conversation.id)}"
                 ${state.selected.has(conversation.id) ? 'checked' : ''} aria-label="اختيار المحادثة">
          ${avatarHtml(conversation.title, { group: isGroup, online: other?.online })}
          <span class="ib-row-main">
            <span class="ib-row-top">
              <span class="ib-row-title">${esc(conversation.title)}</span>
              <span class="ib-row-time">${last ? esc(shortTime(last.createdAt)) : ''}</span>
            </span>
            <span class="ib-row-preview">${previewOf(conversation, last)}</span>
            <span class="ib-row-meta">
              ${statusTag(conversation.status)}
              ${assignee ? `<span class="ib-tag ib-tag--muted">${esc(assignee.name)}</span>` : ''}
              ${conversation.labels.map((l) => `<span class="ib-tag ib-tag--${LABEL_COLORS[l] || 'muted'}">${esc(l)}</span>`).join('')}
              ${conversation.muted ? '<span class="ib-tag ib-tag--muted">مكتومة</span>' : ''}
            </span>
          </span>
          ${conversation.unread ? `<span class="ib-unread">${conversation.unread}</span>` : ''}
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

function statusTag(status) {
    const tone = status === 'closed' ? 'ok' : status === 'pending' ? 'warn' : 'accent';
    return `<span class="ib-tag ib-tag--${tone}">${esc(STATUS_LABELS[status])}</span>`;
}

/** سطر المعاينة: المرفق والملاحظة ليهم أيقونة، عشان مايبانوش كنص فاضي. */
function previewOf(conversation, message) {
    if (conversation.draft) return `<span style="color:var(--color-danger)">مسودة:</span> ${esc(conversation.draft.slice(0, 45))}`;
    if (!message) return '<span style="opacity:.6">مفيش رسايل لسه</span>';
    if (message.deleted) return '<span style="opacity:.6">رسالة اتسحبت</span>';

    const prefix = message.visibility === 'note' ? ICON.note : '';
    const voice = message.attachments.find((a) => a.kind === 'voice');
    if (voice) return `${prefix}${ICON.mic}<span>رسالة صوتية</span>`;

    const doc = message.attachments.find((a) => a.kind === 'document');
    if (doc && !message.body) return `${prefix}${ICON.doc}<span>${esc(doc.name)}</span>`;
    return `${prefix}${doc ? ICON.doc : ''}<span>${esc(message.body.slice(0, 60))}</span>`;
}

// ═════════════════════════════════════════════════════════════
// المحادثة
// ═════════════════════════════════════════════════════════════

function openConversation(id) {
    const conversation = findConversation(id);
    if (!conversation) return;

    // أول رسالة مش مقروءة بتتحسب **قبل** التعليم كمقروء، وإلا الفاصل
    // مايبانش أبدًا.
    const me = getCurrentUser();
    const unreadFirst = listMessages(id).find((m) => m.senderId !== me.id && !m.readBy.includes(me.id));
    state.firstUnreadId = conversation.unread > 0 && unreadFirst ? unreadFirst.id : null;

    state.activeId = id;
    markRead(id);
    clearPending();
    cancelReply();
    cancelEdit();
    closeFind();
    closePop();

    $('threadEmpty').hidden = true;
    $('threadBody').hidden = false;
    $('inboxShell').classList.add('is-thread-open');

    // المسودة المحفوظة بترجع مكانها.
    $('messageInput').value = conversation.draft || '';
    autoGrow();

    renderThread();
    renderRail();
    renderConversations();
    renderDetails();
    $('messageInput').focus();
}

function renderThread() {
    const conversation = findConversation(state.activeId);
    if (!conversation) return;

    const me = getCurrentUser();
    const isGroup = conversation.kind === 'group';
    const other = isGroup ? null : findContact(conversation.memberIds.find((id) => id !== me.id));

    fillAvatar($('threadAvatar'), conversation.title, { group: isGroup, online: other?.online });
    $('threadTitle').textContent = conversation.title;
    $('threadMembers').textContent = isGroup
        ? `${conversation.memberIds.length} أعضاء`
        : (other?.online ? 'متصل دلوقتي' : (other?.email || ''));

    $('statusSelect').innerHTML = Object.entries(STATUS_LABELS)
        .map(([value, label]) => `<option value="${value}" ${conversation.status === value ? 'selected' : ''}>${esc(label)}</option>`).join('');
    $('assigneeSelect').innerHTML = `<option value="">من غير مسؤول</option>` + listAssignableAgents()
        .map((a) => `<option value="${esc(a.id)}" ${conversation.assigneeId === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('');

    $('muteBtn').classList.toggle('is-on', conversation.muted);
    $('archiveBtn').classList.toggle('is-on', conversation.archived);
    $('detailsBtn').classList.toggle('is-on', state.detailsOpen);

    renderPinBar(conversation);
    renderMessages(conversation);
}

function renderPinBar(conversation) {
    const pinned = pinnedMessages(conversation.id);
    const bar = $('pinBar');
    bar.hidden = pinned.length === 0;
    if (!pinned.length) return;

    const first = pinned[0];
    bar.innerHTML = `${ICON.pin}<span>${esc(first.body || 'مرفق مثبّت')}</span>
        ${pinned.length > 1 ? `<span class="ib-tag ib-tag--muted">${pinned.length}</span>` : ''}`;
    bar.onclick = () => jumpTo(first.id);
}

function renderMessages(conversation) {
    const me = getCurrentUser();
    const isGroup = conversation.kind === 'group';
    const list = listMessages(conversation.id);
    const container = $('messageList');

    if (!list.length) {
        container.innerHTML = `<div class="ib-empty"><p>مفيش رسايل لسه. اكتب أول واحدة.</p></div>`;
        return;
    }

    let lastDay = '';
    container.innerHTML = list.map((message) => {
        const mine = message.senderId === me.id;
        const isNote = message.visibility === 'note';
        const sender = findContact(message.senderId);

        const day = dayLabel(message.createdAt);
        const daySep = day === lastDay ? '' : `<div class="ib-day">${esc(day)}</div>`;
        lastDay = day;

        const newSep = message.id === state.firstUnreadId ? '<div class="ib-newline">رسايل جديدة</div>' : '';
        const side = isNote ? 'note' : (mine ? 'mine' : 'theirs');

        return `${daySep}${newSep}
        <div class="ib-msg ib-msg--${side} ${isHit(message.id) ? 'is-hit' : ''}" data-message="${esc(message.id)}" tabindex="-1">
          ${!mine && isGroup && !isNote ? `<span class="ib-sender">${esc(sender?.name || 'مستخدم')}</span>` : ''}
          ${message.deleted ? '' : toolsHtml(message, mine)}
          <div class="ib-bubble">
            ${isNote ? `<div class="ib-note-flag">${ICON.note}<span>ملاحظة داخلية — العميل مايشوفهاش · ${esc(sender?.name || '')}</span></div>` : ''}
            ${message.forwardedFrom ? `<div class="ib-forwarded">${ICON.forward}<span>محوّلة من ${esc(message.forwardedFrom.fromName)}${message.forwardedFrom.fromConversation ? ` — ${esc(message.forwardedFrom.fromConversation)}` : ''}</span></div>` : ''}
            ${quoteHtml(message)}
            ${message.deleted
                ? '<div class="ib-deleted">الرسالة دي اتسحبت.</div>'
                : (message.body ? `<span class="ib-text">${renderBody(message)}</span>` : '')}
            ${message.attachments.map(attachmentHtml).join('')}
            ${reactionsHtml(message)}
          </div>
          <div class="ib-msg-meta">
            <span>${esc(shortTime(message.createdAt))}</span>
            ${message.editedAt ? '<span>· اتعدلت</span>' : ''}
            ${message.starred ? '<span title="مميزة">★</span>' : ''}
            ${message.pinned ? '<span title="مثبّتة">📌</span>' : ''}
            ${mine && !isNote ? receiptHtml(message, conversation) : ''}
          </div>
        </div>`;
    }).join('');

    wireMessageEvents();
    // آخر رسالة هي اللي المفروض تتشاف، إلا لو فيه فاصل «جديد» فنقف عنده.
    const target = state.firstUnreadId && container.querySelector(`[data-message="${state.firstUnreadId}"]`);
    if (target) target.scrollIntoView({ block: 'center' });
    else container.scrollTop = container.scrollHeight;
}

/** المنشن بيتلوّن، ونتيجة البحث بتتعلّم — على النص المهروب بس. */
function renderBody(message) {
    let html = esc(message.body);

    for (const id of message.mentions) {
        const name = findContact(id)?.name;
        if (name) html = html.split(esc(`@${name}`)).join(`<span class="ib-mention">@${esc(name)}</span>`);
    }

    const query = state.find.query.trim();
    if (query) {
        // بنقسم على النص المهروب عشان مانكسرش الوسوم اللي لسه ضفناها.
        const needle = esc(query);
        html = html.split(needle).join(`<mark>${needle}</mark>`);
    }
    return html;
}

function quoteHtml(message) {
    if (!message.replyToId) return '';
    const original = findMessage(message.replyToId);
    if (!original) return '';
    const who = findContact(original.senderId)?.name || 'مستخدم';
    const text = original.deleted ? 'رسالة اتسحبت' : (original.body || 'مرفق');
    return `<div class="ib-quote" data-jump="${esc(original.id)}"><b>${esc(who)}</b><span>${esc(text.slice(0, 80))}</span></div>`;
}

function reactionsHtml(message) {
    const entries = Object.entries(message.reactions);
    if (!entries.length) return '';
    const me = getCurrentUser().id;
    return `<div class="ib-reactions">${entries.map(([emoji, ids]) => `
        <button type="button" class="ib-reaction ${ids.includes(me) ? 'is-mine' : ''}"
                data-react="${esc(message.id)}" data-emoji="${esc(emoji)}"
                title="${esc(ids.map((id) => findContact(id)?.name).filter(Boolean).join('، '))}">
          ${emoji} ${ids.length}
        </button>`).join('')}</div>`;
}

function receiptHtml(message, conversation) {
    const { read, total, names } = readReceipt(message, conversation);
    if (!total) return '';
    const all = read === total;
    const title = read ? `قراها: ${names.join('، ')}` : 'لسه ماحدش قراها';
    return `<span class="ib-receipt ${all ? 'is-read' : ''}" title="${esc(title)}">${read ? ICON.checks : ICON.check}${conversation.kind === 'group' ? ` ${read}/${total}` : ''}</span>`;
}

function toolsHtml(message, mine) {
    return `<div class="ib-tools">
        <button type="button" data-act="react" data-id="${esc(message.id)}" title="تفاعل">${ICON.smile}</button>
        <button type="button" data-act="reply" data-id="${esc(message.id)}" title="رد">${ICON.reply}</button>
        <button type="button" data-act="forward" data-id="${esc(message.id)}" title="تحويل">${ICON.forward}</button>
        <button type="button" data-act="star" data-id="${esc(message.id)}" title="تمييز" class="${message.starred ? 'is-on' : ''}">${ICON.star}</button>
        <button type="button" data-act="pin" data-id="${esc(message.id)}" title="تثبيت" class="${message.pinned ? 'is-on' : ''}">${ICON.pin}</button>
        ${mine ? `<button type="button" data-act="edit" data-id="${esc(message.id)}" title="تعديل">${ICON.edit}</button>
                  <button type="button" data-act="delete" data-id="${esc(message.id)}" title="سحب">${ICON.trash}</button>` : ''}
    </div>`;
}

function attachmentHtml(attachment) {
    if (attachment.kind === 'voice') {
        // موجة شكلية بارتفاعات ثابتة — مش تحليل للصوت الحقيقي، وده مقصود:
        // موجة بتدّعي إنها بتمثّل الصوت وهي مش كده بتكدب على اللي بيبص.
        const bars = [7, 12, 18, 10, 22, 14, 9, 17, 11, 20, 8, 15].map((h) => `<i style="height:${h}px"></i>`).join('');
        return `<div class="ib-attach ib-voice">${ICON.mic}<span class="ib-voice-bars">${bars}</span>
            <span class="ib-attach-size">${esc(clockFormat(attachment.durationSeconds || 0))}</span></div>`;
    }
    const inner = `${ICON.doc}<span class="ib-attach-name">${esc(attachment.name)}</span>
        <span class="ib-attach-size">${esc(humanSize(attachment.size))}</span>`;
    return attachment.url
        ? `<a class="ib-attach" href="${esc(attachment.url)}" download="${esc(attachment.name)}">${inner}</a>`
        : `<div class="ib-attach">${inner}</div>`;
}

function wireMessageEvents() {
    const container = $('messageList');

    container.querySelectorAll('[data-jump]').forEach((el) =>
        el.addEventListener('click', () => jumpTo(el.dataset.jump)));

    container.querySelectorAll('[data-react]').forEach((el) =>
        el.addEventListener('click', () => {
            toggleReaction(el.dataset.react, el.dataset.emoji);
            renderThread();
        }));

    container.querySelectorAll('[data-act]').forEach((button) => {
        button.addEventListener('click', () => {
            const { act, id } = button.dataset;
            if (act === 'react') return openReactionPicker(id, button);
            if (act === 'reply') return startReply(id);
            if (act === 'forward') return openForwardDialog(id);
            if (act === 'star') { toggleStar(id); renderThread(); return; }
            if (act === 'pin') { togglePin(id); renderThread(); return; }
            if (act === 'edit') return startEdit(id);
            if (act === 'delete') return removeMessage(id);
        });
    });
}

function jumpTo(messageId) {
    const el = $('messageList').querySelector(`[data-message="${messageId}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('is-jumped');
    setTimeout(() => el.classList.remove('is-jumped'), 1300);
}

function removeMessage(id) {
    if (!confirm('تسحب الرسالة دي؟ مكانها هيفضل باين ومكتوب إنها اتسحبت.')) return;
    const { ok, error } = deleteMessage(id);
    if (!ok) { toast(error, 'err'); return; }
    renderThread();
    renderConversations();
}

// ═════════════════════════════════════════════════════════════
// لوح التفاصيل
// ═════════════════════════════════════════════════════════════

function renderDetails() {
    const pane = $('detailsPane');
    pane.hidden = !state.detailsOpen;
    $('inboxShell').classList.toggle('has-details', state.detailsOpen);
    if (!state.detailsOpen) return;

    const conversation = findConversation(state.activeId);
    if (!conversation) { pane.innerHTML = ''; return; }

    const files = conversationAttachments(conversation.id);
    const assignee = conversation.assigneeId ? findContact(conversation.assigneeId) : null;
    const notes = listMessages(conversation.id).filter((m) => m.visibility === 'note').length;

    pane.innerHTML = `
      <div class="ib-details-sec">
        <h3>الحالة</h3>
        <div class="ib-kv"><span>الحالة</span><span>${esc(STATUS_LABELS[conversation.status])}</span></div>
        <div class="ib-kv"><span>المسؤول</span><span>${esc(assignee?.name || 'مافيش')}</span></div>
        <div class="ib-kv"><span>الرسايل</span><span>${listMessages(conversation.id).length}</span></div>
        <div class="ib-kv"><span>ملاحظات داخلية</span><span>${notes}</span></div>
      </div>
      <div class="ib-details-sec">
        <h3>الوسوم</h3>
        <div class="ib-labels">${Object.keys(LABEL_COLORS).map((label) => `
          <button type="button" class="ib-label-btn ${conversation.labels.includes(label) ? 'is-on' : ''}" data-label="${esc(label)}">${esc(label)}</button>`).join('')}</div>
      </div>
      <div class="ib-details-sec">
        <h3>الأعضاء (${conversation.memberIds.length})</h3>
        ${conversation.memberIds.map((id) => {
            const person = findContact(id);
            return `<div class="ib-member">${avatarHtml(person?.name || '؟', { online: person?.online, small: true })}
              <span>${esc(person?.name || 'مستخدم')}</span></div>`;
        }).join('')}
      </div>
      <div class="ib-details-sec">
        <h3>الملفات (${files.length})</h3>
        ${files.length
            ? files.map((f) => `<div class="ib-file">${f.kind === 'voice' ? ICON.mic : ICON.doc}
                <span>${esc(f.name)}</span></div>`).join('')
            : '<p class="ib-thread-sub" style="margin:0">مفيش مرفقات.</p>'}
      </div>`;

    pane.querySelectorAll('[data-label]').forEach((b) => b.addEventListener('click', () => {
        toggleLabel(conversation.id, b.dataset.label);
        renderDetails();
        renderConversations();
    }));
}

// ═════════════════════════════════════════════════════════════
// الكتابة: رد / ملاحظة / تعديل / مسودة
// ═════════════════════════════════════════════════════════════

function setMode(mode) {
    state.mode = mode;
    $('composer').classList.toggle('is-note', mode === 'note');
    $('modeToggle').querySelectorAll('button').forEach((b) => b.classList.toggle('is-on', b.dataset.mode === mode));
    $('messageInput').placeholder = mode === 'note'
        ? 'ملاحظة للفريق — العميل مش هيشوفها…'
        : 'اكتب رسالتك… (Enter للإرسال، / لرد جاهز، @ لمنشن)';
}

function startReply(messageId) {
    const message = findMessage(messageId);
    if (!message) return;
    cancelEdit();
    state.replyToId = messageId;
    $('replyingBar').hidden = false;
    $('replyingText').textContent = `${findContact(message.senderId)?.name || ''}: ${message.body || 'مرفق'}`;
    $('messageInput').focus();
}

function cancelReply() {
    state.replyToId = null;
    $('replyingBar').hidden = true;
}

function startEdit(messageId) {
    const message = findMessage(messageId);
    if (!message) return;
    cancelReply();
    state.editingId = messageId;
    $('editingBar').hidden = false;
    $('editingText').textContent = message.body;
    $('messageInput').value = message.body;
    autoGrow();
    $('messageInput').focus();
}

function cancelEdit() {
    state.editingId = null;
    $('editingBar').hidden = true;
}

function autoGrow() {
    const input = $('messageInput');
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 144)}px`;
}

function send() {
    if (!state.activeId) return;
    const input = $('messageInput');
    const body = input.value.trim();

    if (state.editingId) {
        const { ok, error } = editMessage(state.editingId, body);
        if (!ok) { toast(error, 'err'); return; }
        cancelEdit();
        input.value = '';
        autoGrow();
        renderThread();
        renderConversations();
        return;
    }

    if (!body && !state.pending.length) return;

    sendMessage({
        conversationId: state.activeId,
        body,
        attachments: state.pending,
        visibility: state.mode,
        replyToId: state.replyToId
    });

    input.value = '';
    autoGrow();
    // مش بننادي clearPending(): الـ blob URLs راحت مع الرسالة وبتتعرض
    // فيها، فإلغاؤها هيكسر اللي لسه بيتشاف.
    state.pending = [];
    renderPending();
    cancelReply();
    closePop();

    renderThread();
    renderConversations();
    renderRail();
    renderDetails();
}

// ═════════════════════════════════════════════════════════════
// المرفقات والصوت
// ═════════════════════════════════════════════════════════════

function renderPending() {
    $('pendingAttachments').innerHTML = state.pending.map((a, i) => `
        <span class="ib-chip">${a.kind === 'voice' ? ICON.mic : ICON.doc}
          <span>${esc(a.name)}</span>
          <span style="opacity:.7">${esc(a.kind === 'voice' ? clockFormat(a.durationSeconds || 0) : humanSize(a.size))}</span>
          <button type="button" data-remove="${i}" aria-label="شيل المرفق">✕</button></span>`).join('');

    $('pendingAttachments').querySelectorAll('[data-remove]').forEach((b) =>
        b.addEventListener('click', () => {
            const [removed] = state.pending.splice(Number(b.dataset.remove), 1);
            if (removed?.url) URL.revokeObjectURL(removed.url);
            renderPending();
        }));
}

function clearPending() {
    state.pending.forEach((a) => { if (a.url) URL.revokeObjectURL(a.url); });
    state.pending = [];
    renderPending();
}

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

function addFiles(files) {
    for (const file of files) {
        if (file.size > MAX_ATTACHMENT_BYTES) { toast(`«${file.name}» أكبر من ٢٠ ميجا.`, 'err'); continue; }
        state.pending.push({
            id: `pending_${Date.now()}_${state.pending.length}`,
            kind: 'document', name: file.name, size: file.size,
            mime: file.type, url: URL.createObjectURL(file)
        });
    }
    renderPending();
}

/**
 * MediaRecorder محتاج إذن الميكروفون، وممكن يترفض أو المتصفح مايدعمهوش.
 * الحالتين بيتقالوا بصوت عالي — زرار بيضغط ومايحصلش حاجة أسوأ من زرار
 * مقفول.
 */
async function startRecording() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        toast('المتصفح ده مابيدعمش التسجيل الصوتي.', 'err'); return;
    }
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch { toast('محتاجين إذن الميكروفون عشان نسجّل.', 'err'); return; }

    const chunks = [];
    const recorder = new MediaRecorder(stream);
    recorder.addEventListener('dataavailable', (e) => { if (e.data.size) chunks.push(e.data); });
    recorder.addEventListener('stop', () => {
        // الميكروفون لازم يتقفل بإيدنا وإلا لمبة التسجيل بتفضل نوّرة بعد
        // ما المستخدم خلص — وده مقلق بحق.
        stream.getTracks().forEach((t) => t.stop());
        clearInterval(state.recordingTimer);
        if (recorder.cancelled || !chunks.length) return;

        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        state.pending.push({
            id: `pending_voice_${Date.now()}`, kind: 'voice', name: 'رسالة صوتية',
            size: blob.size,
            durationSeconds: Math.max(1, Math.round((Date.now() - state.recordingStartedAt) / 1000)),
            url: URL.createObjectURL(blob)
        });
        renderPending();
    });

    recorder.start();
    state.recorder = recorder;
    state.recordingStartedAt = Date.now();
    $('recordingTime').textContent = '0:00';
    state.recordingTimer = setInterval(() => {
        $('recordingTime').textContent = clockFormat((Date.now() - state.recordingStartedAt) / 1000);
    }, 500);
    $('recordBtn').classList.add('ib-icon-btn--recording');
    $('recordingNote').hidden = false;
}

function stopRecording({ cancelled = false } = {}) {
    if (!state.recorder) return;
    state.recorder.cancelled = cancelled;
    state.recorder.stop();
    state.recorder = null;
    $('recordBtn').classList.remove('ib-icon-btn--recording');
    $('recordingNote').hidden = true;
}

// ═════════════════════════════════════════════════════════════
// اللوحة المنبثقة: ردود جاهزة / منشن / إيموجي
// ═════════════════════════════════════════════════════════════

function closePop() {
    state.pop = null;
    $('popPanel').hidden = true;
    $('popPanel').innerHTML = '';
}

function openPop(kind, items, onPick) {
    state.pop = kind;
    const panel = $('popPanel');
    panel.hidden = false;
    panel.innerHTML = items.length
        ? items.map((item, i) => `<button type="button" class="ib-pop-item ${i === 0 ? 'is-active' : ''}" data-pick="${i}">
            <b>${esc(item.title)}</b><span>${esc(item.sub || '')}</span></button>`).join('')
        : '<div style="padding:.8rem;text-align:center;color:var(--color-text-secondary);font-size:.82rem">مفيش نتايج.</div>';

    panel.querySelectorAll('[data-pick]').forEach((b) =>
        b.addEventListener('click', () => onPick(items[Number(b.dataset.pick)])));
}

function openCanned(filter = '') {
    const q = filter.trim().toLowerCase();
    const items = listCannedReplies()
        .filter((r) => !q || r.shortcut.toLowerCase().includes(q) || r.title.toLowerCase().includes(q))
        // من غير الشرطة المايلة قدّام الاسم: في سياق RTL الشرطة محايدة
        // فبتتقلب للناحية التانية و«/ترحيب» بتتقري «ترحيب/». والمستخدم
        // كاتب الشرطة بنفسه أصلاً، فعرضها تكرار مالوش لازمة.
        .map((r) => ({ title: r.shortcut, sub: r.title, body: r.body }));

    openPop('canned', items, (item) => {
        // `{{الاسم}}` بتتبدّل باسم الطرف التاني — رد جاهز بيوصل للعميل
        // باسم حد تاني أسوأ من إنه يتكتب من الأول.
        $('messageInput').value = fillCannedReply(item.body, state.activeId);
        autoGrow();
        closePop();
        $('messageInput').focus();
    });
}

function openMentions(filter = '') {
    const conversation = findConversation(state.activeId);
    if (!conversation) return closePop();
    const q = filter.trim().toLowerCase();
    const me = getCurrentUser().id;

    const items = conversation.memberIds
        .filter((id) => id !== me)
        .map((id) => findContact(id)).filter(Boolean)
        .filter((c) => !q || c.name.toLowerCase().includes(q))
        .map((c) => ({ title: `@${c.name}`, sub: c.email, name: c.name }));

    openPop('mention', items, (item) => {
        const input = $('messageInput');
        input.value = input.value.replace(/@[^\s@]*$/, `@${item.name} `);
        autoGrow();
        closePop();
        input.focus();
    });
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

function openReactionPicker(messageId) {
    state.pop = 'react';
    const panel = $('popPanel');
    panel.hidden = false;
    panel.innerHTML = `<div class="ib-emoji-grid">${QUICK_EMOJI.map((e) => `<button type="button" data-emoji="${e}">${e}</button>`).join('')}</div>`;
    panel.querySelectorAll('[data-emoji]').forEach((b) => b.addEventListener('click', () => {
        toggleReaction(messageId, b.dataset.emoji);
        closePop();
        renderThread();
    }));
}

/** اللي بيتكتب دلوقتي بيفتح اللوحة المناسبة لوحده. */
function onInputChanged() {
    const input = $('messageInput');
    autoGrow();
    saveDraft(state.activeId, input.value);

    const value = input.value;
    const slash = value.match(/(?:^|\s)\/([^\s/]*)$/);
    const mention = value.match(/(?:^|\s)@([^\s@]*)$/);

    if (slash) openCanned(slash[1]);
    else if (mention) openMentions(mention[1]);
    else if (state.pop === 'canned' || state.pop === 'mention') closePop();

    renderConversations();
}

// ═════════════════════════════════════════════════════════════
// البحث جوه المحادثة
// ═════════════════════════════════════════════════════════════

const isHit = (id) => state.find.hits.includes(id);

function runFind() {
    const query = $('findInput').value.trim().toLowerCase();
    state.find.query = $('findInput').value.trim();
    state.find.hits = query
        ? listMessages(state.activeId).filter((m) => !m.deleted && m.body.toLowerCase().includes(query)).map((m) => m.id)
        : [];
    state.find.index = 0;

    $('findCount').textContent = query
        ? (state.find.hits.length ? `${state.find.index + 1} / ${state.find.hits.length}` : 'مفيش نتايج')
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
    $('findBar').hidden = true;
    $('findInput').value = '';
    state.find = { query: '', hits: [], index: 0 };
    if (state.activeId) renderThread();
}

// ═════════════════════════════════════════════════════════════
// النوافذ
// ═════════════════════════════════════════════════════════════

function renderContactPicker(containerId, searchId, { multi = false, onPick = null } = {}) {
    const q = $(searchId).value.trim().toLowerCase();
    const contacts = listContacts().filter((c) =>
        !q || c.name.toLowerCase().includes(q) || c.email.toLowerCase().includes(q));

    const container = $(containerId);
    container.innerHTML = contacts.length
        ? contacts.map((c) => `<button type="button" class="ib-pick" data-contact="${esc(c.id)}">
            ${multi ? `<input type="checkbox" ${state.groupSelection.has(c.id) ? 'checked' : ''} tabindex="-1">` : ''}
            ${avatarHtml(c.name, { online: c.online, small: true })}
            <span class="ib-pick-main"><span>${esc(c.name)}</span><span class="ib-pick-sub">${esc(c.email)}</span></span>
          </button>`).join('')
        : '<div style="padding:1.2rem;text-align:center;color:var(--color-text-secondary);font-size:.83rem;">مفيش عضو مطابق.</div>';

    container.querySelectorAll('[data-contact]').forEach((b) =>
        b.addEventListener('click', () => onPick?.(b.dataset.contact)));
}

function startChatWith(contactId) {
    const conversation = openDirectConversation(contactId);
    $('newChatDialog').close();
    renderRail();
    renderConversations();
    openConversation(conversation.id);
}

function openNewChatDialog() {
    $('newChatScope').textContent = getCurrentUser().role === 'super_user'
        ? 'بتشوف أعضاء فريقك بس.' : 'بتشوف كل أعضاء المنصة.';
    $('contactSearch').value = '';
    renderContactPicker('contactPicker', 'contactSearch', { onPick: startChatWith });
    $('newChatDialog').showModal();
}

function refreshGroupPicker() {
    renderContactPicker('groupPicker', 'groupSearch', {
        multi: true,
        onPick: (id) => {
            if (state.groupSelection.has(id)) state.groupSelection.delete(id);
            else state.groupSelection.add(id);
            refreshGroupPicker();
        }
    });
    $('groupCount').textContent = state.groupSelection.size ? `(${state.groupSelection.size} مختارين)` : '';
}

function openForwardDialog(messageId) {
    state.forwardingId = messageId;
    const message = findMessage(messageId);
    $('forwardPreview').textContent = message?.body
        || (message?.attachments[0]?.kind === 'voice' ? 'رسالة صوتية' : message?.attachments[0]?.name) || '—';
    $('forwardSearch').value = '';
    renderForwardPicker();
    $('forwardDialog').showModal();
}

function renderForwardPicker() {
    const q = $('forwardSearch').value.trim().toLowerCase();
    // المحادثة الحالية مش خيار — تحويل رسالة لنفس مكانها مالوش معنى.
    const targets = listConversations()
        .filter((c) => c.id !== state.activeId)
        .filter((c) => !q || c.title.toLowerCase().includes(q));

    const container = $('forwardPicker');
    container.innerHTML = targets.length
        ? targets.map((c) => `<button type="button" class="ib-pick" data-target="${esc(c.id)}">
            ${avatarHtml(c.title, { group: c.kind === 'group', small: true })}
            <span class="ib-pick-main"><span>${esc(c.title)}</span>
              <span class="ib-pick-sub">${c.kind === 'group' ? `${c.memberIds.length} أعضاء` : 'محادثة فردية'}</span></span>
          </button>`).join('')
        : '<div style="padding:1.2rem;text-align:center;color:var(--color-text-secondary);font-size:.83rem;">مفيش محادثة تانية.</div>';

    container.querySelectorAll('[data-target]').forEach((b) => b.addEventListener('click', () => {
        forwardMessage({ messageId: state.forwardingId, toConversationId: b.dataset.target });
        $('forwardDialog').close();
        renderConversations();
        renderRail();
        toast('الرسالة اتحوّلت.');
    }));
}

// ═════════════════════════════════════════════════════════════
// الإجراءات الجماعية
// ═════════════════════════════════════════════════════════════

function bulk(action) {
    if (!state.selected.size) return;
    const ids = [...state.selected];

    for (const id of ids) {
        if (action === 'read') markRead(id);
        if (action === 'archive') setArchived(id, true);
        if (action === 'close') setStatus(id, 'closed');
    }

    state.selected.clear();
    renderRail();
    renderConversations();
    if (state.activeId && ids.includes(state.activeId)) renderThread();
    toast(`اتنفّذ على ${ids.length} محادثة.`);
}

// ═════════════════════════════════════════════════════════════
// الاختصارات
// ═════════════════════════════════════════════════════════════

/** بنتجاهل الاختصارات وإحنا بنكتب — وإلا «e» بتأرشف بدل ما تتكتب. */
const isTyping = () => ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);

function moveSelection(delta) {
    const rows = currentRows();
    if (!rows.length) return;
    const at = rows.findIndex((c) => c.id === state.activeId);
    const next = rows[Math.min(rows.length - 1, Math.max(0, (at < 0 ? 0 : at + delta)))];
    if (next) openConversation(next.id);
}

function onKeydown(event) {
    if (event.key === 'Escape') {
        if (state.pop) return closePop();
        if (!$('findBar').hidden) return closeFind();
        if (state.editingId) return cancelEdit();
        if (state.replyToId) return cancelReply();
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
        case 'e': if (state.activeId) toggleArchive(); break;
        case 'm': if (state.activeId) toggleMute(); break;
        case 'n': if (state.activeId) setMode(state.mode === 'reply' ? 'note' : 'reply'); break;
        default: break;
    }
}

function toggleArchive() {
    const conversation = findConversation(state.activeId);
    if (!conversation) return;
    setArchived(conversation.id, !conversation.archived);
    renderRail();
    renderConversations();
    renderThread();
    toast(conversation.archived ? 'رجعت من الأرشيف.' : 'اتأرشفت.');
}

function toggleMute() {
    const conversation = findConversation(state.activeId);
    if (!conversation) return;
    setMuted(conversation.id, !conversation.muted);
    renderThread();
    renderConversations();
}

// ═════════════════════════════════════════════════════════════
// الربط
// ═════════════════════════════════════════════════════════════

function applyRole() {
    const me = getCurrentUser();
    $('inboxSubtitle').textContent = me.role === 'super_user'
        ? 'محادثاتك مع أعضاء فريقك' : 'محادثاتك مع أعضاء المنصة';
    $('scopeNote').textContent = me.role === 'super_user'
        ? '— بيشوف أعضاءه هو بس.' : '— بيشوف كل أعضاء المنصة.';

    // تبديل الدور بيغيّر مين أنت، فالمحادثة المفتوحة غالبًا مابقتش بتاعتك.
    state.activeId = null;
    state.selected.clear();
    state.view = 'all';
    $('threadBody').hidden = true;
    $('threadEmpty').hidden = false;
    $('inboxShell').classList.remove('is-thread-open');
    state.detailsOpen = false;
    clearPending();
    renderRail();
    renderConversations();
    renderDetails();
}

function wire() {
    $('convSearch').addEventListener('input', () => { state.selected.clear(); renderConversations(); });

    $('newChatBtn').addEventListener('click', openNewChatDialog);
    $('newGroupBtn').addEventListener('click', () => {
        state.groupSelection.clear();
        $('groupName').value = ''; $('groupSearch').value = ''; $('groupError').textContent = '';
        refreshGroupPicker();
        $('newGroupDialog').showModal();
    });
    $('cancelNewChat').addEventListener('click', () => $('newChatDialog').close());
    $('cancelNewGroup').addEventListener('click', () => $('newGroupDialog').close());
    $('cancelForward').addEventListener('click', () => $('forwardDialog').close());
    $('closeShortcuts').addEventListener('click', () => $('shortcutsDialog').close());
    $('shortcutsBtn').addEventListener('click', () => $('shortcutsDialog').showModal());

    $('contactSearch').addEventListener('input', () =>
        renderContactPicker('contactPicker', 'contactSearch', { onPick: startChatWith }));
    $('groupSearch').addEventListener('input', refreshGroupPicker);
    $('forwardSearch').addEventListener('input', renderForwardPicker);

    $('createGroupBtn').addEventListener('click', () => {
        const { conversation, error } = createGroup({ title: $('groupName').value, memberIds: [...state.groupSelection] });
        if (error) { $('groupError').textContent = error; return; }
        $('newGroupDialog').close();
        renderRail();
        renderConversations();
        openConversation(conversation.id);
        toast('المجموعة اتعملت.');
    });

    $('backBtn').addEventListener('click', () => $('inboxShell').classList.remove('is-thread-open'));

    // رأس المحادثة
    $('statusSelect').addEventListener('change', (e) => {
        setStatus(state.activeId, e.target.value);
        renderRail(); renderConversations(); renderDetails();
        toast(`الحالة بقت «${STATUS_LABELS[e.target.value]}».`);
    });
    $('assigneeSelect').addEventListener('change', (e) => {
        setAssignee(state.activeId, e.target.value);
        renderRail(); renderConversations(); renderDetails();
    });
    $('muteBtn').addEventListener('click', toggleMute);
    $('archiveBtn').addEventListener('click', toggleArchive);
    $('detailsBtn').addEventListener('click', () => {
        state.detailsOpen = !state.detailsOpen;
        renderDetails();
        $('detailsBtn').classList.toggle('is-on', state.detailsOpen);
    });

    // البحث جوه المحادثة
    $('findBtn').addEventListener('click', openFind);
    $('findInput').addEventListener('input', runFind);
    $('findNext').addEventListener('click', () => stepFind(1));
    $('findPrev').addEventListener('click', () => stepFind(-1));
    $('findClose').addEventListener('click', closeFind);

    // الكتابة
    $('modeToggle').querySelectorAll('button').forEach((b) =>
        b.addEventListener('click', () => setMode(b.dataset.mode)));
    $('cancelReplyBtn').addEventListener('click', cancelReply);
    $('cancelEditBtn').addEventListener('click', () => {
        cancelEdit();
        $('messageInput').value = '';
        autoGrow();
    });

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

    $('attachBtn').addEventListener('click', () => $('fileInput').click());
    $('fileInput').addEventListener('change', (e) => {
        addFiles(e.target.files);
        e.target.value = ''; // عشان اختيار نفس الملف تاني يشتغل
    });
    $('recordBtn').addEventListener('click', () => (state.recorder ? stopRecording() : startRecording()));
    $('cancelRecordBtn').addEventListener('click', () => stopRecording({ cancelled: true }));
    $('cannedBtn').addEventListener('click', () => (state.pop === 'canned' ? closePop() : openCanned()));
    $('emojiBtn').addEventListener('click', () => (state.pop === 'emoji' ? closePop() : openEmoji()));

    // الجدولة
    $('scheduleBtn').addEventListener('click', () => {
        if (!$('messageInput').value.trim()) { toast('اكتب الرسالة الأول.', 'err'); return; }
        $('scheduleError').textContent = '';
        $('scheduleDialog').showModal();
    });
    $('cancelSchedule').addEventListener('click', () => $('scheduleDialog').close());
    $('confirmSchedule').addEventListener('click', () => {
        const at = $('scheduleAt').value;
        if (!at || new Date(at) <= new Date()) {
            $('scheduleError').textContent = 'اختار وقت في المستقبل.';
            return;
        }
        $('scheduleDialog').close();
        // ⚠️ الجدولة الحقيقية محتاجة الخلفية. هنا بنقول للمستخدم إنها
        // اتجدولت من غير ما نبعت — وعد بإرسال مش هيحصل أسوأ من زرار مقفول.
        toast(`اتجدولت للإرسال ${new Date(at).toLocaleString('ar-EG')} (محتاج الخلفية).`);
    });

    // الإجراءات الجماعية
    $('bulkReadBtn').addEventListener('click', () => bulk('read'));
    $('bulkArchiveBtn').addEventListener('click', () => bulk('archive'));
    $('bulkCloseBtn').addEventListener('click', () => bulk('close'));
    $('bulkClearBtn').addEventListener('click', () => { state.selected.clear(); renderConversations(); });

    $('roleSelect').addEventListener('change', (e) => { setPreviewRole(e.target.value); applyRole(); });

    document.addEventListener('keydown', onKeydown);
    // ضغطة برّه اللوحة بتقفلها.
    document.addEventListener('click', (e) => {
        if (state.pop && !e.target.closest('.ib-composer-wrap') && !e.target.closest('.ib-tools')) closePop();
    });
}

wire();
setMode('reply');
applyRole();
fitShellHeight();
window.addEventListener('resize', fitShellHeight);

// بيتصدّر عشان الشارة في القايمة الجانبية تقدر تقراه لما تتوصل.
window.__inboxUnread = totalUnread;
