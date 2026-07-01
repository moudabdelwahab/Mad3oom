import { supabase } from '/api-config.js';
import { initSidebar } from './sidebar.js';

initSidebar();

const mailList = document.getElementById('mailList');
const mailDetail = document.getElementById('mailDetail');
const tabInbound = document.getElementById('tabInbound');
const tabOutbound = document.getElementById('tabOutbound');
const inboundBadge = document.getElementById('inboundBadge');

const PAGE_SIZE = 30;
let currentDirection = 'inbound';
let emails = [];
let selectedEmailId = null;

const statusLabels = {
    sent: 'تم الإرسال',
    delivered: 'تم التسليم',
    received: 'وارد',
    failed: 'فشل',
    bounced: 'ارتد',
    complained: 'شكوى (سبام)',
    delayed: 'تأخر التسليم',
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

async function loadEmails(direction) {
    mailList.innerHTML = '<div class="empty-state">جاري التحميل...</div>';
    mailDetail.innerHTML = '<div class="mail-detail-empty">اختر رسالة لعرض تفاصيلها</div>';
    selectedEmailId = null;

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
        mailList.innerHTML = '<div class="empty-state">فشل تحميل الرسائل</div>';
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
        inboundBadge.style.display = count > 0 ? 'inline-block' : 'none';
    } catch (err) {
        console.error('Error counting unread:', err);
    }
}

function renderList() {
    if (emails.length === 0) {
        mailList.innerHTML = '<div class="empty-state">لا توجد رسائل</div>';
        return;
    }

    mailList.innerHTML = emails.map(email => {
        const isUnread = currentDirection === 'inbound' && !email.is_read;
        const partyLabel = currentDirection === 'inbound' ? email.from_email : email.to_email;
        const statusClass = `status-${email.status}`;
        return `
            <div class="mail-item ${isUnread ? 'unread' : ''} ${email.id === selectedEmailId ? 'selected' : ''}" data-id="${email.id}">
                <div class="mi-top">
                    <span>${formatDate(email.created_at)}</span>
                    <span class="status-pill ${statusClass}">${statusLabels[email.status] || email.status}</span>
                </div>
                <div class="mi-from">${escapeHtml(partyLabel || '')}</div>
                <div class="mi-subject">${escapeHtml(email.subject || '(بدون عنوان)')}</div>
            </div>
        `;
    }).join('');

    mailList.querySelectorAll('.mail-item').forEach(item => {
        item.addEventListener('click', () => {
            const id = item.dataset.id;
            selectEmail(id);
        });
    });
}

async function selectEmail(id) {
    selectedEmailId = id;
    renderList();

    const email = emails.find(e => e.id === id);
    if (!email) return;

    // تعليم الوارد كمقروء
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

    let attachmentsHtml = '';
    if (attachments.length > 0) {
        attachmentsHtml = `
            <div class="mail-attachments">
                ${attachments.map((a, idx) => `
                    <div class="attachment-chip" data-idx="${idx}" data-email-id="${email.provider_message_id || ''}" data-attachment-id="${a.id || ''}">
                        📎 ${escapeHtml(a.filename || 'ملف')}
                    </div>
                `).join('')}
            </div>
        `;
    }

    let errorHtml = '';
    if (email.error_message) {
        errorHtml = `<div style="background:rgba(220,53,69,0.1); color:#dc3545; padding:0.75rem; border-radius:0.5rem; margin-top:1rem; font-size:0.85em;">خطأ: ${escapeHtml(email.error_message)}</div>`;
    }

    mailDetail.innerHTML = `
        <div class="mail-detail-header">
            <h2>${escapeHtml(email.subject || '(بدون عنوان)')}</h2>
            <div class="mail-meta-row"><strong>من:</strong> ${escapeHtml(email.from_email || '')}</div>
            <div class="mail-meta-row"><strong>إلى:</strong> ${escapeHtml(email.to_email || '')}</div>
            <div class="mail-meta-row"><strong>التاريخ:</strong> ${formatDate(email.created_at)}</div>
            <div class="mail-meta-row"><strong>الحالة:</strong> <span class="status-pill status-${email.status}">${statusLabels[email.status] || email.status}</span></div>
        </div>
        <iframe class="mail-body-frame" sandbox="allow-same-origin" srcdoc="${escapeHtml(email.html_body || `<pre style='font-family:inherit;white-space:pre-wrap;'>${escapeHtml(email.text_body || '(بدون محتوى)')}</pre>`)}"></iframe>
        ${attachmentsHtml}
        ${errorHtml}
        ${isInbound ? `
            <div class="reply-box">
                <label style="display:block;margin-bottom:0.5rem;font-weight:700;">رد سريع</label>
                <textarea id="quickReplyText" rows="4" placeholder="اكتب ردك هنا..."></textarea>
                <button class="btn btn-primary" id="quickReplyBtn" style="margin-top:0.75rem;">إرسال الرد</button>
                <span id="quickReplyStatus" style="margin-right:0.75rem;font-weight:600;"></span>
            </div>
        ` : ''}
    `;

    mailDetail.querySelectorAll('.attachment-chip').forEach(chip => {
        chip.addEventListener('click', () => downloadAttachment(chip.dataset.emailId, chip.dataset.attachmentId, chip.textContent.trim()));
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
    toast.textContent = message;
    toast.style.background = type === 'success' ? 'var(--color-success)' : 'var(--color-danger)';
    toast.style.display = 'block';
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

// تحديث تلقائي للوارد الجديد كل 30 ثانية (بدون إعادة تحميل كاملة لو المستخدم بيقرأ رسالة)
setInterval(() => {
    refreshUnreadBadge();
    if (currentDirection === 'inbound' && !selectedEmailId) {
        loadEmails('inbound');
    }
}, 30000);

switchTab('inbound');
refreshUnreadBadge();
