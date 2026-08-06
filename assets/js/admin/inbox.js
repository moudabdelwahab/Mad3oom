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
 * عشان كده الدوال دي مكتوبة كأنها بتتكلم مع شبكة (بترجّع النتيجة
 * وبتسيب الرسم للي بعدها) مش كأنها بتعدّل مصفوفة.
 */
import {
    getCurrentUser, setPreviewRole, listContacts, findContact, initialsOf,
    listConversations, listMessages, lastMessageOf, markRead,
    sendMessage, openDirectConversation, createGroup, forwardMessage, totalUnread
} from './inbox-data.js';

/**
 * القايمة الجانبية بتتحمّل بشكل منفصل عن الصفحة.
 *
 * `sidebar.js` بيستورد `api-config.js`، واللي بدوره بيجيب مكتبة Supabase
 * من CDN. لو الاستيراد ده اتأخر أو فشل — شبكة، حاجب إعلانات، الـ CDN
 * نفسه — الاستيراد الثابت كان هيوقّع **الصفحة كلها** معاه، والصندوق
 * يبقى شاشة بيضا رغم إنه مش محتاج Supabase في حاجة.
 *
 * فالقايمة اختيارية: لو ماجتش، الصندوق شغال والتنقل بس هو اللي ناقص.
 */
import('./sidebar.js')
    .then((module) => {
        module.initSidebar();
        // القايمة بتتحقن بعد ما الصفحة اترسمت، وممكن تزحزح اللي تحتها —
        // فالارتفاع بيتحسب من تاني بعدها.
        setTimeout(() => fitShellHeight(), 300);
    })
    .catch((err) => console.warn('[inbox] القايمة الجانبية ماتحمّلتش:', err?.message || err));

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
    activeConversationId: null,
    /** مرفقات اتحطت ولسه مااتبعتتش. */
    pending: [],
    recorder: null,
    recordingStartedAt: 0,
    recordingTimer: null,
    forwardingMessageId: null,
    /** الأعضاء المختارين في نافذة المجموعة. */
    groupSelection: new Set()
};

// ═════════════════════════════════════════════════════════════
// أدوات صغيرة
// ═════════════════════════════════════════════════════════════

const ICON = {
    doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
    mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/></svg>',
    forward: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/></svg>'
};

function toast(message, kind = 'ok') {
    const el = $('toast');
    el.textContent = message;
    el.className = kind === 'err' ? 'toast toast--err' : 'toast';
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.hidden = true; }, 3200);
}

/** «٤:٠٥ م» للنهاردة، والتاريخ لأي حاجة أقدم. */
function shortTime(iso) {
    const date = new Date(iso);
    const sameDay = date.toDateString() === new Date().toDateString();
    return sameDay
        ? date.toLocaleTimeString('ar-EG', { hour: 'numeric', minute: '2-digit' })
        : date.toLocaleDateString('ar-EG', { day: 'numeric', month: 'short' });
}

function dayLabel(iso) {
    const date = new Date(iso);
    const today = new Date();
    const yesterday = new Date(Date.now() - 86400000);
    if (date.toDateString() === today.toDateString()) return 'النهاردة';
    if (date.toDateString() === yesterday.toDateString()) return 'إمبارح';
    return date.toLocaleDateString('ar-EG', { weekday: 'long', day: 'numeric', month: 'long' });
}

/** ك.ب / م.ب — الرقم بالبايت مايقولش حاجة لحد. */
function humanSize(bytes) {
    if (!Number.isFinite(bytes)) return '';
    if (bytes < 1024) return `${bytes} بايت`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} ك.ب`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} م.ب`;
}

const clockFormat = (seconds) =>
    `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

function avatarHtml(name, { group = false, online = false } = {}) {
    return `<div class="ib-avatar ${group ? 'ib-avatar--group' : ''}" data-online="${online}">${esc(initialsOf(name))}</div>`;
}

/** بيملا عنصر موجود بدل ما يستبدله، عشان الـ id مايضيعش. */
function fillAvatar(element, name, { group = false, online = false } = {}) {
    element.className = `ib-avatar ${group ? 'ib-avatar--group' : ''}`;
    element.dataset.online = String(online);
    element.textContent = initialsOf(name);
}

// ═════════════════════════════════════════════════════════════
// قائمة المحادثات
// ═════════════════════════════════════════════════════════════

function renderConversations() {
    const query = $('convSearch').value.trim().toLowerCase();
    const rows = listConversations().filter((conversation) => {
        if (!query) return true;
        // البحث بيدوّر في نص الرسايل كمان مش في العناوين بس — الناس
        // بتفتكر اللي اتقال أكتر ما بتفتكر مع مين.
        const haystack = [
            conversation.title,
            ...listMessages(conversation.id).map((m) => m.body)
        ].join(' ').toLowerCase();
        return haystack.includes(query);
    });

    const list = $('convList');
    if (!rows.length) {
        list.innerHTML = `<div class="ib-empty" style="padding:2.5rem 1rem;">
            <p>${query ? 'مفيش محادثة مطابقة.' : 'مفيش محادثات لسه. ابدأ واحدة من فوق.'}</p>
        </div>`;
        return;
    }

    list.innerHTML = rows.map((conversation) => {
        const last = lastMessageOf(conversation.id);
        const isGroup = conversation.kind === 'group';
        const other = isGroup
            ? null
            : findContact(conversation.memberIds.find((id) => id !== getCurrentUser().id));

        return `
        <button class="ib-row ${conversation.id === state.activeConversationId ? 'is-active' : ''}"
                data-conversation="${esc(conversation.id)}">
          ${avatarHtml(conversation.title, { group: isGroup, online: other?.online })}
          <span class="ib-row-main">
            <span class="ib-row-top">
              <span class="ib-row-title">${esc(conversation.title)}</span>
              <span class="ib-row-time">${last ? esc(shortTime(last.createdAt)) : ''}</span>
            </span>
            <span class="ib-row-preview">${previewOf(last)}</span>
          </span>
          ${conversation.unread ? `<span class="ib-unread">${conversation.unread}</span>` : ''}
        </button>`;
    }).join('');

    list.querySelectorAll('[data-conversation]').forEach((button) => {
        button.addEventListener('click', () => openConversation(button.dataset.conversation));
    });
}

/** سطر المعاينة: المرفق له أيقونة، عشان «رسالة صوتية» ماتبانش كنص فاضي. */
function previewOf(message) {
    if (!message) return '<span style="opacity:.6">مفيش رسايل لسه</span>';

    const voice = message.attachments.find((a) => a.kind === 'voice');
    if (voice) return `${ICON.mic}<span>رسالة صوتية</span>`;

    const doc = message.attachments.find((a) => a.kind === 'document');
    if (doc && !message.body) return `${ICON.doc}<span>${esc(doc.name)}</span>`;

    const prefix = doc ? ICON.doc : '';
    return `${prefix}<span>${esc(message.body.slice(0, 60))}</span>`;
}

// ═════════════════════════════════════════════════════════════
// المحادثة المفتوحة
// ═════════════════════════════════════════════════════════════

function openConversation(conversationId) {
    state.activeConversationId = conversationId;
    markRead(conversationId);
    clearPending();

    const conversation = listConversations().find((c) => c.id === conversationId);
    if (!conversation) return;

    $('threadEmpty').hidden = true;
    $('threadBody').hidden = false;
    $('inboxShell').classList.add('is-thread-open');

    const isGroup = conversation.kind === 'group';
    const other = isGroup ? null : findContact(conversation.memberIds.find((id) => id !== getCurrentUser().id));

    fillAvatar($('threadAvatar'), conversation.title, { group: isGroup, online: other?.online });
    $('threadTitle').textContent = conversation.title;
    $('threadMembers').textContent = isGroup
        ? `${conversation.memberIds.length} أعضاء`
        : (other?.online ? 'متصل دلوقتي' : (other?.email || ''));

    renderMessages();
    renderConversations();
    $('messageInput').focus();
}

function renderMessages() {
    const conversation = listConversations().find((c) => c.id === state.activeConversationId);
    if (!conversation) return;

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
        const sender = findContact(message.senderId);

        // فاصل يوم لما التاريخ يتغير — من غيره كل الرسايل بتبان كأنها
        // في نفس اللحظة.
        const day = dayLabel(message.createdAt);
        const separator = day === lastDay ? '' : `<div class="ib-day">${esc(day)}</div>`;
        lastDay = day;

        return `${separator}
        <div class="ib-msg ib-msg--${mine ? 'mine' : 'theirs'}" data-message="${esc(message.id)}">
          ${!mine && isGroup ? `<span class="ib-sender">${esc(sender?.name || 'مستخدم')}</span>` : ''}
          <div class="ib-bubble">
            ${message.forwardedFrom ? `
              <div class="ib-forwarded">${ICON.forward}
                <span>محوّلة من ${esc(message.forwardedFrom.fromName)}${
                    message.forwardedFrom.fromConversation
                        ? ` — ${esc(message.forwardedFrom.fromConversation)}` : ''}</span>
              </div>` : ''}
            ${message.body ? `<span class="ib-text">${esc(message.body)}</span>` : ''}
            ${message.attachments.map(attachmentHtml).join('')}
          </div>
          <div class="ib-msg-meta">
            <span>${esc(shortTime(message.createdAt))}</span>
            <button type="button" class="ib-forward-btn" data-forward="${esc(message.id)}"
                    title="تحويل الرسالة" aria-label="تحويل الرسالة">${ICON.forward}</button>
          </div>
        </div>`;
    }).join('');

    container.querySelectorAll('[data-forward]').forEach((button) => {
        button.addEventListener('click', () => openForwardDialog(button.dataset.forward));
    });

    // آخر رسالة هي اللي المفروض تتشاف، مش أولها.
    container.scrollTop = container.scrollHeight;
}

function attachmentHtml(attachment) {
    if (attachment.kind === 'voice') {
        // موجة شكلية بارتفاعات ثابتة — مش تحليل للصوت الحقيقي، وده
        // مقصود: موجة بتدّعي إنها بتمثّل الصوت وهي مش كده بتكدب على
        // اللي بيبص.
        const bars = [7, 12, 18, 10, 22, 14, 9, 17, 11, 20, 8, 15]
            .map((height) => `<i style="height:${height}px"></i>`).join('');
        return `<div class="ib-attach ib-voice">
            ${ICON.mic}
            <span class="ib-voice-bars">${bars}</span>
            <span class="ib-attach-size">${esc(clockFormat(attachment.durationSeconds || 0))}</span>
        </div>`;
    }

    // الـ blob: لينك بيشتغل في الجلسة دي بس. من غير URL بيبقى مجرد
    // كارت — أحسن من لينك بيوعد بتنزيل مش هيحصل.
    const inner = `${ICON.doc}
        <span class="ib-attach-name">${esc(attachment.name)}</span>
        <span class="ib-attach-size">${esc(humanSize(attachment.size))}</span>`;

    return attachment.url
        ? `<a class="ib-attach" href="${esc(attachment.url)}" download="${esc(attachment.name)}">${inner}</a>`
        : `<div class="ib-attach">${inner}</div>`;
}

// ═════════════════════════════════════════════════════════════
// المرفقات المعلّقة
// ═════════════════════════════════════════════════════════════

function renderPending() {
    $('pendingAttachments').innerHTML = state.pending.map((attachment, index) => `
        <span class="ib-chip">
          ${attachment.kind === 'voice' ? ICON.mic : ICON.doc}
          <span>${esc(attachment.name)}</span>
          <span style="opacity:.7">${esc(attachment.kind === 'voice'
              ? clockFormat(attachment.durationSeconds || 0)
              : humanSize(attachment.size))}</span>
          <button type="button" data-remove="${index}" aria-label="شيل المرفق">✕</button>
        </span>`).join('');

    $('pendingAttachments').querySelectorAll('[data-remove]').forEach((button) => {
        button.addEventListener('click', () => {
            const [removed] = state.pending.splice(Number(button.dataset.remove), 1);
            // الـ blob بياخد ذاكرة لحد ما يتلغي بالاسم.
            if (removed?.url) URL.revokeObjectURL(removed.url);
            renderPending();
        });
    });
}

function clearPending() {
    state.pending.forEach((a) => { if (a.url) URL.revokeObjectURL(a.url); });
    state.pending = [];
    renderPending();
}

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

function addFiles(files) {
    for (const file of files) {
        if (file.size > MAX_ATTACHMENT_BYTES) {
            toast(`«${file.name}» أكبر من ٢٠ ميجا.`, 'err');
            continue;
        }
        state.pending.push({
            id: `pending_${Date.now()}_${state.pending.length}`,
            kind: 'document',
            name: file.name,
            size: file.size,
            mime: file.type,
            url: URL.createObjectURL(file)
        });
    }
    renderPending();
}

// ═════════════════════════════════════════════════════════════
// التسجيل الصوتي
// ═════════════════════════════════════════════════════════════

/**
 * MediaRecorder محتاج إذن الميكروفون، وممكن الإذن يترفض أو المتصفح
 * مايدعمهوش أصلاً. الحالتين بيتقالوا بصوت عالي — زرار بيضغط ومايحصلش
 * حاجة أسوأ من زرار مقفول.
 */
async function startRecording() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        toast('المتصفح ده مابيدعمش التسجيل الصوتي.', 'err');
        return;
    }

    let stream;
    try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
        toast('محتاجين إذن الميكروفون عشان نسجّل.', 'err');
        return;
    }

    const chunks = [];
    const recorder = new MediaRecorder(stream);
    recorder.addEventListener('dataavailable', (event) => {
        if (event.data.size) chunks.push(event.data);
    });

    recorder.addEventListener('stop', () => {
        // الميكروفون لازم يتقفل بإيدنا، وإلا لمبة التسجيل بتفضل نوّرة
        // بعد ما المستخدم خلص — وده مقلق بحق.
        stream.getTracks().forEach((track) => track.stop());
        stopRecordingTimer();

        if (recorder.cancelled || !chunks.length) return;

        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        const seconds = Math.max(1, Math.round((Date.now() - state.recordingStartedAt) / 1000));
        state.pending.push({
            id: `pending_voice_${Date.now()}`,
            kind: 'voice',
            name: 'رسالة صوتية',
            size: blob.size,
            durationSeconds: seconds,
            url: URL.createObjectURL(blob)
        });
        renderPending();
    });

    recorder.start();
    state.recorder = recorder;
    state.recordingStartedAt = Date.now();
    startRecordingTimer();

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

function startRecordingTimer() {
    $('recordingTime').textContent = '0:00';
    state.recordingTimer = setInterval(() => {
        $('recordingTime').textContent = clockFormat((Date.now() - state.recordingStartedAt) / 1000);
    }, 500);
}

function stopRecordingTimer() {
    clearInterval(state.recordingTimer);
    state.recordingTimer = null;
}

// ═════════════════════════════════════════════════════════════
// الإرسال
// ═════════════════════════════════════════════════════════════

function send() {
    if (!state.activeConversationId) return;

    const input = $('messageInput');
    const body = input.value.trim();
    if (!body && !state.pending.length) return;

    sendMessage({
        conversationId: state.activeConversationId,
        body,
        attachments: state.pending
    });

    input.value = '';
    input.style.height = 'auto';
    // مش بننادي clearPending() هنا: الـ blob URLs راحت مع الرسالة
    // وبتتعرض فيها، فإلغاؤها هيكسر اللي لسه بيتشاف.
    state.pending = [];
    renderPending();

    renderMessages();
    renderConversations();
}

// ═════════════════════════════════════════════════════════════
// النوافذ
// ═════════════════════════════════════════════════════════════

function renderContactPicker(containerId, searchId, { multi = false, onPick = null } = {}) {
    const query = $(searchId).value.trim().toLowerCase();
    const contacts = listContacts().filter((contact) =>
        !query
        || contact.name.toLowerCase().includes(query)
        || contact.email.toLowerCase().includes(query));

    const container = $(containerId);
    if (!contacts.length) {
        container.innerHTML = '<div style="padding:1.2rem;text-align:center;color:var(--color-text-secondary);font-size:.83rem;">مفيش عضو مطابق.</div>';
        return;
    }

    container.innerHTML = contacts.map((contact) => `
        <button type="button" class="ib-pick" data-contact="${esc(contact.id)}">
          ${multi ? `<input type="checkbox" ${state.groupSelection.has(contact.id) ? 'checked' : ''} tabindex="-1">` : ''}
          ${avatarHtml(contact.name, { online: contact.online })}
          <span class="ib-pick-main">
            <span>${esc(contact.name)}</span>
            <span class="ib-pick-sub">${esc(contact.email)}</span>
          </span>
        </button>`).join('');

    container.querySelectorAll('[data-contact]').forEach((button) => {
        button.addEventListener('click', () => onPick?.(button.dataset.contact));
    });
}

function openNewChatDialog() {
    const me = getCurrentUser();
    $('newChatScope').textContent = me.role === 'super_user'
        ? 'بتشوف أعضاء فريقك بس.'
        : 'بتشوف كل أعضاء المنصة.';
    $('contactSearch').value = '';
    renderContactPicker('contactPicker', 'contactSearch', {
        onPick: (contactId) => {
            const conversation = openDirectConversation(contactId);
            $('newChatDialog').close();
            renderConversations();
            openConversation(conversation.id);
        }
    });
    $('newChatDialog').showModal();
}

function openNewGroupDialog() {
    state.groupSelection.clear();
    $('groupName').value = '';
    $('groupSearch').value = '';
    $('groupError').textContent = '';
    refreshGroupPicker();
    $('newGroupDialog').showModal();
}

function refreshGroupPicker() {
    renderContactPicker('groupPicker', 'groupSearch', {
        multi: true,
        onPick: (contactId) => {
            if (state.groupSelection.has(contactId)) state.groupSelection.delete(contactId);
            else state.groupSelection.add(contactId);
            refreshGroupPicker();
        }
    });
    const count = state.groupSelection.size;
    $('groupCount').textContent = count ? `(${count} مختارين)` : '';
}

function openForwardDialog(messageId) {
    state.forwardingMessageId = messageId;

    const message = listMessages(state.activeConversationId).find((m) => m.id === messageId);
    const preview = message?.body
        || (message?.attachments[0]?.kind === 'voice' ? 'رسالة صوتية' : message?.attachments[0]?.name)
        || '—';
    $('forwardPreview').textContent = preview;

    $('forwardSearch').value = '';
    renderForwardPicker();
    $('forwardDialog').showModal();
}

function renderForwardPicker() {
    const query = $('forwardSearch').value.trim().toLowerCase();
    // المحادثة الحالية مش خيار — تحويل رسالة لنفس مكانها مالوش معنى.
    const targets = listConversations()
        .filter((c) => c.id !== state.activeConversationId)
        .filter((c) => !query || c.title.toLowerCase().includes(query));

    const container = $('forwardPicker');
    if (!targets.length) {
        container.innerHTML = '<div style="padding:1.2rem;text-align:center;color:var(--color-text-secondary);font-size:.83rem;">مفيش محادثة تانية تحوّلها ليها.</div>';
        return;
    }

    container.innerHTML = targets.map((conversation) => `
        <button type="button" class="ib-pick" data-target="${esc(conversation.id)}">
          ${avatarHtml(conversation.title, { group: conversation.kind === 'group' })}
          <span class="ib-pick-main">
            <span>${esc(conversation.title)}</span>
            <span class="ib-pick-sub">${conversation.kind === 'group' ? `${conversation.memberIds.length} أعضاء` : 'محادثة فردية'}</span>
          </span>
        </button>`).join('');

    container.querySelectorAll('[data-target]').forEach((button) => {
        button.addEventListener('click', () => {
            forwardMessage({ messageId: state.forwardingMessageId, toConversationId: button.dataset.target });
            $('forwardDialog').close();
            renderConversations();
            toast('الرسالة اتحوّلت.');
        });
    });
}

// ═════════════════════════════════════════════════════════════
// الربط
// ═════════════════════════════════════════════════════════════

function applyRole() {
    const me = getCurrentUser();
    $('inboxSubtitle').textContent = me.role === 'super_user'
        ? 'محادثاتك مع أعضاء فريقك'
        : 'محادثاتك مع أعضاء المنصة';
    $('scopeNote').textContent = me.role === 'super_user'
        ? 'السوبر يوزر بيشوف أعضاءه هو بس.'
        : 'الأدمن بيشوف كل أعضاء المنصة.';

    // تبديل الدور بيغيّر مين أنت، فالمحادثة المفتوحة غالبًا مابقتش بتاعتك.
    state.activeConversationId = null;
    $('threadBody').hidden = true;
    $('threadEmpty').hidden = false;
    $('inboxShell').classList.remove('is-thread-open');
    clearPending();
    renderConversations();
}

/**
 * بيخلّي الصندوق يملا الباقي من الشاشة بالظبط.
 *
 * من غير ده الصفحة بيبقى فيها تمريرين: الصفحة نفسها والمحادثة جواها —
 * وشريط الكتابة بيقع تحت حافة الشاشة، فالمستخدم بيكتب رسالة وهو مش
 * شايف الزرار اللي هيبعتها.
 *
 * الارتفاع بيتقاس مش بيتحسب، لأن اللي فوق الصندوق بيلف على سطرين في
 * الشاشات الضيقة وأي رقم ثابت بيبقى غلط عند عرض معيّن.
 */
function fitShellHeight() {
    const shell = $('inboxShell');
    const box = shell.getBoundingClientRect();

    // ⚠️ كل الحسبة دي **بإحداثيات المستند**، مش إحداثيات الشاشة.
    //
    // `getBoundingClientRect().top` بيتقاس من أعلى الشاشة، فبيبقى بالسالب
    // لو الصفحة متمررة. لو اتخلط مع `scrollHeight` (اللي بالمستند)،
    // الارتفاع بيطلع أكبر من الشاشة، والصفحة بتطول، فيبقى فيه تمرير أكتر،
    // فالحسبة اللي بعدها تطلع أكبر — لفة بتكبر كل مرة. حصل فعلاً: الصندوق
    // طلع ١١٠٩ بكسل جوه شاشة ٩٠٠.
    const shellTop = window.scrollY + box.top;
    const belowShell = document.documentElement.scrollHeight - (window.scrollY + box.bottom);

    const height = Math.max(360, window.innerHeight - shellTop - belowShell);
    document.documentElement.style.setProperty('--ib-height', `${height}px`);
}

function wire() {
    $('convSearch').addEventListener('input', renderConversations);

    $('newChatBtn').addEventListener('click', openNewChatDialog);
    $('newGroupBtn').addEventListener('click', openNewGroupDialog);
    $('cancelNewChat').addEventListener('click', () => $('newChatDialog').close());
    $('cancelNewGroup').addEventListener('click', () => $('newGroupDialog').close());
    $('cancelForward').addEventListener('click', () => $('forwardDialog').close());

    $('contactSearch').addEventListener('input', () => renderContactPicker('contactPicker', 'contactSearch', {
        onPick: (contactId) => {
            const conversation = openDirectConversation(contactId);
            $('newChatDialog').close();
            renderConversations();
            openConversation(conversation.id);
        }
    }));
    $('groupSearch').addEventListener('input', refreshGroupPicker);
    $('forwardSearch').addEventListener('input', renderForwardPicker);

    $('createGroupBtn').addEventListener('click', () => {
        const { conversation, error } = createGroup({
            title: $('groupName').value,
            memberIds: [...state.groupSelection]
        });
        if (error) { $('groupError').textContent = error; return; }
        $('newGroupDialog').close();
        renderConversations();
        openConversation(conversation.id);
        toast('المجموعة اتعملت.');
    });

    $('backBtn').addEventListener('click', () => {
        $('inboxShell').classList.remove('is-thread-open');
    });

    // الكتابة
    const input = $('messageInput');
    input.addEventListener('input', () => {
        input.style.height = 'auto';
        input.style.height = `${Math.min(input.scrollHeight, 144)}px`;
    });
    input.addEventListener('keydown', (event) => {
        // Shift+Enter سطر جديد، Enter لوحده إرسال — زي أي تطبيق محادثة.
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            send();
        }
    });
    $('sendBtn').addEventListener('click', send);

    // المرفقات
    $('attachBtn').addEventListener('click', () => $('fileInput').click());
    $('fileInput').addEventListener('change', (event) => {
        addFiles(event.target.files);
        // بنفضّي القيمة عشان اختيار نفس الملف تاني يشتغل.
        event.target.value = '';
    });

    // الصوت
    $('recordBtn').addEventListener('click', () => {
        if (state.recorder) stopRecording();
        else startRecording();
    });
    $('cancelRecordBtn').addEventListener('click', () => stopRecording({ cancelled: true }));

    // معاينة الأدوار — بتتشال مع الجلسة الحقيقية
    $('roleSelect').addEventListener('change', (event) => {
        setPreviewRole(event.target.value);
        applyRole();
    });
}

wire();
applyRole();
fitShellHeight();
window.addEventListener('resize', fitShellHeight);

// بيتصدّر عشان الشارة في القايمة الجانبية تقدر تقراه لما تتوصل.
window.__inboxUnread = totalUnread;
