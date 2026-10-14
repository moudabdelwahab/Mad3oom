/**
 * portal-messages.js — «رسائلي»: العميل يراسل شركته الحالية (migrations/102_company_conversations.sql).
 *
 * القرار في القاعدة: my_company_conversations() ترد null والميزة مطفأة (فلا يظهر القسم)، والشركة تُختم من
 * سياق العميل الذي يتحقق منه الخادم. لا يرى العميل الملاحظات الداخلية ولا من في فريق الشركة كتب الرد.
 * بعد مغادرة الشركة تبقى محادثاته للقراءة فقط (can_reply = false).
 */
import { escapeHtml, formatDate } from '/assets/js/customer/portal-ui.js';
import { ui } from '/ui-service.js';
import {
    fetchMyConversations, validateConversation, startConversation, fetchConversationThread, replyToConversation
} from '/assets/js/portal/portal-data.js';

const newKey = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16)));

let startKey = newKey();
let openId = null;
let wired = false;

/** preview: منظور العضو لمالك المنصة — لا قسم (المسار خاص بالشركة وعميلها). */
export async function initPortalMessages({ preview = false } = {}) {
    const panel = document.getElementById('messages');
    if (!panel || preview) return;
    const result = await fetchMyConversations();
    if (result.ok && result.data === null) { panel.hidden = true; return; }
    panel.hidden = false;
    if (!wired) { wire(); wired = true; }
    renderList(result);
    if (window.location.hash === '#messages') panel.scrollIntoView({ block: 'nearest' });
}

function wire() {
    document.getElementById('portalNewConversationBtn').addEventListener('click', () => {
        document.getElementById('portalNewConversation').hidden = false;
        document.getElementById('portalConversationSubject').focus();
    });
    document.getElementById('portalConversationCancel').addEventListener('click', () => {
        document.getElementById('portalNewConversation').hidden = true;
    });
    document.getElementById('portalNewConversation').addEventListener('submit', async (event) => {
        event.preventDefault();
        const errorBox = document.getElementById('portalConversationError');
        const check = validateConversation({
            subject: document.getElementById('portalConversationSubject').value,
            body: document.getElementById('portalConversationBody').value
        });
        if (!check.ok) {
            errorBox.textContent = check.errors.subject || check.errors.body;
            errorBox.hidden = false;
            return;
        }
        errorBox.hidden = true;
        const submit = document.getElementById('portalConversationSubmit');
        submit.disabled = true;
        const result = await startConversation(check.values.subject, check.values.body, startKey);
        submit.disabled = false;
        if (!result.ok) { errorBox.textContent = result.error; errorBox.hidden = false; return; }
        startKey = newKey();
        event.target.reset();
        event.target.hidden = true;
        ui?.showToast?.('أُرسلت رسالتك إلى الشركة', 'success');
        await refresh();
        await openThread(result.data?.conversation_id);
    });
    document.getElementById('portalThreadBack').addEventListener('click', () => {
        openId = null;
        document.getElementById('portalThread').hidden = true;
        document.getElementById('portalConversationList').hidden = false;
    });
    document.getElementById('portalReplyForm').addEventListener('submit', async (event) => {
        event.preventDefault();
        const input = document.getElementById('portalReplyBody');
        const body = input.value.trim();
        const errorBox = document.getElementById('portalReplyError');
        if (!body || !openId) return;
        const send = document.getElementById('portalReplySubmit');
        send.disabled = true;
        const result = await replyToConversation(openId, body);
        send.disabled = false;
        if (!result.ok) { errorBox.textContent = result.error; errorBox.hidden = false; return; }
        errorBox.hidden = true;
        input.value = '';
        await openThread(openId);
        await refresh();
    });
}

async function refresh() {
    renderList(await fetchMyConversations());
}

function renderList(result) {
    const list = document.getElementById('portalConversationList');
    const errorBox = document.getElementById('portalMessagesError');
    errorBox.hidden = result.ok;
    if (!result.ok) { errorBox.textContent = result.error; return; }
    const data = result.data || { conversations: [], can_write: false };
    document.getElementById('portalNewConversationBtn').hidden = data.can_write !== true;
    const rows = Array.isArray(data.conversations) ? data.conversations : [];
    list.innerHTML = rows.length ? rows.map(c => `
        <li class="company-sub portal-conversation${c.unread ? ' is-unread' : ''}">
            <button type="button" class="portal-conversation-open" data-conversation="${escapeHtml(c.id)}">
                <span class="company-sub-plan">${escapeHtml(c.subject)}</span>
                <span class="company-sub-dates">${c.status === 'closed' ? 'مغلقة · ' : ''}${escapeHtml(formatDate(c.last_message_at))}
                    ${c.unread ? '<span class="pill">رد جديد</span>' : ''}</span>
            </button>
        </li>`).join('') : '<li class="company-sub-dates">لا رسائل بعد. راسل الشركة بأي سؤال.</li>';
    list.querySelectorAll('[data-conversation]').forEach(btn =>
        btn.addEventListener('click', () => openThread(btn.getAttribute('data-conversation'))));
}

async function openThread(id) {
    if (!id) return;
    const result = await fetchConversationThread(id);
    if (!result.ok) { ui?.showToast?.(result.error, 'error'); return; }
    openId = id;
    const t = result.data || {};
    document.getElementById('portalConversationList').hidden = true;
    const pane = document.getElementById('portalThread');
    pane.hidden = false;
    document.getElementById('portalThreadSubject').textContent = t.subject || '';
    document.getElementById('portalThreadMessages').innerHTML = (t.messages || []).map(m => `
        <li class="portal-message ${m.sender_kind === 'customer' ? 'is-mine' : 'is-company'}">
            <span class="portal-message-who">${m.sender_kind === 'customer' ? 'أنت' : 'الشركة'}</span>
            <p class="portal-message-body">${escapeHtml(m.body)}</p>
            <small>${escapeHtml(formatDate(m.created_at))}</small>
        </li>`).join('');
    document.getElementById('portalReplyForm').hidden = t.can_reply !== true;
    document.getElementById('portalThreadReadOnly').hidden = t.can_reply === true;
}
