import { supabase } from '/api-config.js';
import { initSidebar } from './sidebar.js';

initSidebar();

const mailList = document.getElementById('mailList');
const mailDetail = document.getElementById('mailDetail');
const mailListCount = document.getElementById('mailListCount');
const tabInbound = document.getElementById('tabInbound');
const tabOutbound = document.getElementById('tabOutbound');
const inboundBadge = document.getElementById('inboundBadge');
const refreshBtn = document.getElementById('refreshBtn');

const PAGE_SIZE = 30;
let currentDirection = 'inbound';
let emails = [];
let selectedEmailId = null;

const ICONS = {
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>',
    doubleCheck: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 6 7 17 2 12"></polyline><polyline points="22 6 11 17 9 15"></polyline></svg>',
    inbox: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>',
    alertTriangle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>',
    user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>',
    mailOpen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8"/><path d="M22 6 12 13 2 6"/><path d="M22 6H2a1 1 0 0 0-1 1v.2a1 1 0 0 0 .45.83l10 6.67a1 1 0 0 0 1.1 0l10-6.67A1 1 0 0 0 23 7.2V7a1 1 0 0 0-1-1Z"/></svg>',
    inboxEmpty: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>',
    paperclip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05 12.25 20.24a6 6 0 0 1-8.49-8.49L12.91 2.6a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>',
    reply: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"></polyline><path d="M20 18v-2a4 4 0 0 0-4-4H4"></path></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>',
    calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>',
    at: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"></circle><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94"></path></svg>',
    arrowLeft: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>',
    checkCircle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>',
    xCircle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>',
    inboxArrowDown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>',
};

const statusMeta = {
    sent: { label: 'تم الإرسال', icon: ICONS.check },
    delivered: { label: 'تم التسليم', icon: ICONS.doubleCheck },
    received: { label: 'وارد', icon: ICONS.inboxArrowDown },
    failed: { label: 'فشل', icon: ICONS.xCircle },
    bounced: { label: 'ارتد', icon: ICONS.alertTriangle },
    complained: { label: 'شكوى (سبام)', icon: ICONS.alertTriangle },
    delayed: { label: 'تأخر التسليم', icon: ICONS.clock },
};

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
}

function formatDate(dateStr) {
    const d = new Date(dateStr);
    return d.toLocaleString('ar-EG', { dateStyle: 'medium', timeStyle: 'short' });
}

function formatRelativeTime(dateStr) {
    const d = new Date(dateStr);
    const diffMs = Date.now() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'الآن';
    if (diffMin < 60) return `منذ ${diffMin} د`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `منذ ${diffHr} س`;
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 7) return `منذ ${diffDay} ي`;
    return d.toLocaleDateString('ar-EG', { day: 'numeric', month: 'short' });
}

function initialsFromEmail(email) {
    if (!email) return '?';
    const namePart = email.split('@')[0];
    const cleaned = namePart.replace(/[._-]/g, ' ').trim();
    const parts = cleaned.split(' ').filter(Boolean);
    if (parts.length === 0) return email[0].toUpperCase();
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
}

function statusPill(status) {
    const meta = statusMeta[status] || { label: status, icon: '' };
    return `<span class="status-pill status-${status}">${meta.icon}${escapeHtml(meta.label)}</span>`;
}

function renderSkeleton() {
    let html = '';
    for (let i = 0; i < 6; i++) {
        html += `
            <div class="skeleton-item">
                <div class="sk-circle"></div>
                <div style="flex:1;">
                    <div class="sk-line" style="width:70%;"></div>
                    <div class="sk-line" style="width:45%;"></div>
                </div>
            </div>
        `;
    }
    mailList.innerHTML = html;
}

async function loadEmails(direction, { silent = false } = {}) {
    if (!silent) {
        renderSkeleton();
        mailListCount.textContent = '—';
        mailDetail.innerHTML = emptyDetailHtml();
        selectedEmailId = null;
    }

    try {
        const { data, error } = await supabase
            .from('mailbox_emails')
            .select('*')
            .eq('direction', direction)
            .order('created_at', { ascending: false })
            .limit(PAGE_SIZE);

        if (error) throw error;

        emails = data || [];
        renderList();
    } catch (err) {
        console.error('Error loading emails:', err);
        mailList.innerHTML = `
            <div class="empty-state">
                ${ICONS.alertTriangle}
                <p>تعذّر تحميل الرسائل، حاول التحديث مرة أخرى</p>
            </div>
        `;
        mailListCount.textContent = '—';
    }
}

async function refreshUnreadBadge() {
    try {
        const { count, error } = await supabase
            .from('mailbox_emails')
            .select('id', { count: 'exact', head: true })
            .eq('direction', 'inbound')
            .eq('is_read', false);

        if (error) throw error;
        inboundBadge.textContent = count || 0;
        inboundBadge.style.display = count > 0 ? 'inline-flex' : 'none';
    } catch (err) {
        console.error('Error counting unread:', err);
    }
}

function emptyDetailHtml() {
    return `
        <div class="mail-detail-empty">
            ${ICONS.mailOpen}
            <p>اختر رسالة من القائمة لعرض تفاصيلها</p>
        </div>
    `;
}

function renderList() {
    mailListCount.textContent = emails.length === 1 ? 'رسالة واحدة' : `${emails.length} رسالة`;

    if (emails.length === 0) {
        const emptyCopy = currentDirection === 'inbound'
            ? 'لا توجد رسائل واردة حتى الآن'
            : 'لم يتم إرسال أي رسائل بعد';
        mailList.innerHTML = `
            <div class="empty-state">
                ${ICONS.inboxEmpty}
                <p>${emptyCopy}</p>
            </div>
        `;
        return;
    }

    mailList.innerHTML = emails.map(email => {
        const isUnread = currentDirection === 'inbound' && !email.is_read;
        const partyLabel = currentDirection === 'inbound' ? email.from_email : email.to_email;
        const hasAttachments = Array.isArray(email.attachments) && email.attachments.length > 0;
        return `
            <div class="mail-item ${isUnread ? 'unread' : ''} ${email.id === selectedEmailId ? 'selected' : ''}" data-id="${email.id}">
                <div class="mail-avatar">${initialsFromEmail(partyLabel)}</div>
                <div class="mail-item-body">
                    <div class="mi-top">
                        <span class="mi-from">${escapeHtml(partyLabel || '')}</span>
                        <span class="mi-time">${formatRelativeTime(email.created_at)}</span>
                    </div>
                    <div class="mi-subject">${escapeHtml(email.subject || '(بدون عنوان)')}</div>
                    <div class="mi-bottom">
                        ${isUnread ? '<span class="unread-dot"></span>' : ''}
                        ${statusPill(email.status)}
                        ${hasAttachments ? `<span style="color:var(--color-text-secondary,#888);display:inline-flex;">${ICONS.paperclip}</span>` : ''}
                    </div>
                </div>
            </div>
        `;
    }).join('');

    mailList.querySelectorAll('.mail-item').forEach(item => {
        item.addEventListener('click', () => selectEmail(item.dataset.id));
    });
}

async function selectEmail(id) {
    selectedEmailId = id;
    renderList();

    const email = emails.find(e => e.id === id);
    if (!email) return;

    if (currentDirection === 'inbound' && !email.is_read) {
        email.is_read = true;
        supabase.from('mailbox_emails').update({ is_read: true }).eq('id', id).then(() => {
            refreshUnreadBadge();
        });
    }

    renderDetail(email);
}

function renderDetail(email) {
    const attachments = Array.isArray(email.attachments) ? email.attachments : [];
    const isInbound = email.direction === 'inbound';
    const partyLabel = isInbound ? email.from_email : email.to_email;

    let attachmentsHtml = '';
    if (attachments.length > 0) {
        attachmentsHtml = `
            <div class="mail-attachments">
                ${attachments.map(a => `
                    <div class="attachment-chip" data-email-id="${escapeHtml(email.provider_message_id || '')}" data-attachment-id="${escapeHtml(a.id || '')}">
                        ${ICONS.paperclip}
                        <span>${escapeHtml(a.filename || 'ملف')}</span>
                        <span class="att-download">${ICONS.download}</span>
                    </div>
                `).join('')}
            </div>
        `;
    }

    let errorHtml = '';
    if (email.error_message) {
        errorHtml = `
            <div class="mail-error-box">
                ${ICONS.alertTriangle}
                <span>${escapeHtml(email.error_message)}</span>
            </div>
        `;
    }

    mailDetail.innerHTML = `
        <div class="mail-detail-header">
            <h2>${escapeHtml(email.subject || '(بدون عنوان)')}</h2>
            <div class="mail-parties">
                <div class="mail-detail-avatar">${initialsFromEmail(partyLabel)}</div>
                <div class="mail-party-info">
                    <div><strong>${escapeHtml(partyLabel || '')}</strong></div>
                    <div class="mp-row">${ICONS.at}<span>${isInbound ? 'إلى: ' + escapeHtml(email.to_email || '') : 'من: ' + escapeHtml(email.from_email || '')}</span></div>
                    <div class="mp-row">${ICONS.calendar}<span>${formatDate(email.created_at)}</span></div>
                </div>
                <div class="mail-detail-meta-right">
                    ${statusPill(email.status)}
                </div>
            </div>
        </div>
        <div class="mail-body-wrap">
            <iframe class="mail-body-frame" sandbox="allow-same-origin" srcdoc="${escapeHtml(email.html_body || `<pre style='font-family:inherit;white-space:pre-wrap;'>${escapeHtml(email.text_body || '(بدون محتوى)')}</pre>`)}"></iframe>
            ${attachmentsHtml}
            ${errorHtml}
        </div>
        ${isInbound ? `
            <div class="reply-box">
                <div class="reply-box-label">${ICONS.reply}<span>رد سريع</span></div>
                <textarea id="quickReplyText" rows="4" placeholder="اكتب ردك هنا..."></textarea>
                <div class="reply-box-actions">
                    <button class="btn btn-primary btn-icon" id="quickReplyBtn">${ICONS.send}إرسال الرد</button>
                    <span id="quickReplyStatus" style="font-weight:600;font-size:0.9em;"></span>
                </div>
            </div>
        ` : ''}
    `;

    mailDetail.querySelectorAll('.attachment-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            const filename = chip.querySelector('span').textContent.trim();
            downloadAttachment(chip.dataset.emailId, chip.dataset.attachmentId, filename);
        });
    });

    const replyBtn = document.getElementById('quickReplyBtn');
    if (replyBtn) {
        replyBtn.addEventListener('click', () => sendQuickReply(email));
    }
}

async function downloadAttachment(emailId, attachmentId, label) {
    if (!emailId || !attachmentId) {
        showToast('بيانات المرفق غير مكتملة', 'error');
        return;
    }
    try {
        const { data: sessionData } = await supabase.auth.getSession();
        const accessToken = sessionData?.session?.access_token;

        const { data, error } = await supabase.functions.invoke('get-attachment-url', {
            body: { email_id: emailId, attachment_id: attachmentId },
            headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined,
        });

        if (error) throw error;
        if (data?.download_url) {
            window.open(data.download_url, '_blank');
        } else {
            throw new Error('لم يتم استلام رابط التنزيل');
        }
    } catch (err) {
        console.error('Attachment download error:', err);
        showToast('فشل تحميل المرفق', 'error');
    }
}

async function sendQuickReply(email) {
    const textarea = document.getElementById('quickReplyText');
    const btn = document.getElementById('quickReplyBtn');
    const status = document.getElementById('quickReplyStatus');
    const message = textarea.value.trim();

    if (!message) {
        showToast('اكتب محتوى الرد أولاً', 'error');
        return;
    }

    btn.disabled = true;
    status.textContent = 'جاري الإرسال...';
    status.style.color = 'var(--color-info)';

    try {
        const { data, error } = await supabase.functions.invoke('send-ticket-email', {
            body: {
                event: 'CUSTOM',
                customer_email: email.from_email,
                customer_name: email.from_email,
                subject: email.subject ? `رد: ${email.subject}` : 'رد على رسالتك',
                message: message.replace(/\n/g, '<br>'),
                from_email: email.to_email,
                related_user_id: email.related_user_id || null,
            }
        });

        if (error) throw error;

        showToast('تم إرسال الرد بنجاح', 'success');
        textarea.value = '';
        status.textContent = '';
    } catch (err) {
        console.error('Reply send error:', err);
        showToast('فشل إرسال الرد', 'error');
        status.textContent = 'فشل الإرسال';
        status.style.color = 'var(--color-danger)';
    } finally {
        btn.disabled = false;
    }
}

function showToast(message, type = 'success') {
    const toast = document.getElementById('toast');
    const icon = type === 'success' ? ICONS.checkCircle : ICONS.xCircle;
    toast.innerHTML = `<span style="display:inline-flex;width:18px;height:18px;">${icon}</span><span>${escapeHtml(message)}</span>`;
    toast.style.background = type === 'success' ? 'var(--color-success)' : 'var(--color-danger)';
    toast.style.display = 'flex';
    setTimeout(() => { toast.style.display = 'none'; }, 3000);
}

function switchTab(direction) {
    currentDirection = direction;
    tabInbound.classList.toggle('active', direction === 'inbound');
    tabOutbound.classList.toggle('active', direction === 'outbound');
    loadEmails(direction);
}

tabInbound.addEventListener('click', () => switchTab('inbound'));
tabOutbound.addEventListener('click', () => switchTab('outbound'));

refreshBtn.addEventListener('click', async () => {
    refreshBtn.classList.add('spinning');
    await Promise.all([loadEmails(currentDirection, { silent: true }), refreshUnreadBadge()]);
    setTimeout(() => refreshBtn.classList.remove('spinning'), 400);
});

// تحديث تلقائي للوارد الجديد كل 30 ثانية (بدون إعادة تحميل كاملة لو المستخدم بيقرأ رسالة)
setInterval(() => {
    refreshUnreadBadge();
    if (currentDirection === 'inbound' && !selectedEmailId) {
        loadEmails('inbound', { silent: true });
    }
}, 30000);

switchTab('inbound');
refreshUnreadBadge();
