import { supabase } from '/api-config.js';
import { initSidebar } from './sidebar.js';

initSidebar();

const userSelect = document.getElementById('userSelect');
const manualEmailWrap = document.getElementById('manualEmailWrap');
const manualEmail = document.getElementById('manualEmail');
const manualName = document.getElementById('manualName');
const fromSelect = document.getElementById('fromSelect');
const emailForm = document.getElementById('emailForm');
const sendBtn = document.getElementById('sendBtn');
const statusMessage = document.getElementById('statusMessage');
const recipientTypeInputs = document.querySelectorAll('input[name="recipient_type"]');
const attachmentInput = document.getElementById('emailAttachment');
const attachmentInfo = document.getElementById('attachmentInfo');

const MAX_ATTACHMENT_SIZE = 5 * 1024 * 1024; // 5MB

let users = [];

async function loadUsers() {
    try {
        const { data, error } = await supabase
            .from('profiles')
            .select('id, email, full_name')
            .order('full_name');

        if (error) throw error;

        users = data || [];

        userSelect.innerHTML = '<option value="">اختر مستخدم</option>' +
            users.map(u => `<option value="${u.id}">${u.full_name || u.email} (${u.email})</option>`).join('');
    } catch (err) {
        console.error('Error loading users:', err);
        showToast('فشل تحميل المستخدمين', 'error');
    }
}

function updateRecipientUI(type) {
    userSelect.style.display = type === 'single' ? 'block' : 'none';
    userSelect.disabled = type !== 'single';

    if (type === 'manual') {
        manualEmailWrap.classList.add('active');
    } else {
        manualEmailWrap.classList.remove('active');
        manualEmail.value = '';
        manualName.value = '';
    }
}

recipientTypeInputs.forEach(input => {
    input.addEventListener('change', (e) => {
        updateRecipientUI(e.target.value);
    });
});

attachmentInput.addEventListener('change', () => {
    const file = attachmentInput.files[0];
    if (!file) {
        attachmentInfo.textContent = '';
        return;
    }
    if (file.size > MAX_ATTACHMENT_SIZE) {
        showToast('حجم الملف أكبر من الحد المسموح (5 ميجابايت)', 'error');
        attachmentInput.value = '';
        attachmentInfo.textContent = '';
        return;
    }
    const sizeKb = (file.size / 1024).toFixed(0);
    attachmentInfo.textContent = `${file.name} (${sizeKb} كيلوبايت)`;
});

function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            // النتيجة بصيغة data:<mime>;base64,<content> — نحتاج الجزء بعد الفاصلة فقط
            const result = reader.result;
            const base64 = typeof result === 'string' ? result.split(',')[1] : '';
            resolve(base64);
        };
        reader.onerror = () => reject(new Error('فشل قراءة الملف'));
        reader.readAsDataURL(file);
    });
}

emailForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const recipientType = document.querySelector('input[name="recipient_type"]:checked').value;
    const subject = document.getElementById('emailSubject').value.trim();
    const body = document.getElementById('emailBody').value.trim();
    const fromEmail = fromSelect.value;

    if (!subject || !body) {
        showToast('الرجاء ملء جميع الحقول', 'error');
        return;
    }

    if (recipientType === 'single' && !userSelect.value) {
        showToast('الرجاء اختيار مستخدم', 'error');
        return;
    }

    if (recipientType === 'manual') {
        const emailVal = manualEmail.value.trim();
        if (!emailVal || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailVal)) {
            showToast('الرجاء إدخال بريد إلكتروني صحيح', 'error');
            return;
        }
    }

    // تجهيز المرفق إن وجد
    let attachment = null;
    const file = attachmentInput.files[0];
    if (file) {
        if (file.size > MAX_ATTACHMENT_SIZE) {
            showToast('حجم الملف أكبر من الحد المسموح (5 ميجابايت)', 'error');
            return;
        }
        try {
            const base64Content = await fileToBase64(file);
            attachment = {
                filename: file.name,
                content: base64Content,
                type: file.type,
            };
        } catch (err) {
            console.error('Attachment read error:', err);
            showToast('فشل قراءة الملف المرفق', 'error');
            return;
        }
    }

    sendBtn.disabled = true;
    statusMessage.textContent = 'جاري الإرسال...';
    statusMessage.style.color = 'var(--color-info)';

    try {
        if (recipientType === 'all') {
            await sendToAll(subject, body, fromEmail, attachment);
        } else if (recipientType === 'manual') {
            await sendEmail(manualEmail.value.trim(), manualName.value.trim() || 'عميلنا العزيز', subject, body, fromEmail, attachment);
        } else {
            await sendToUser(userSelect.value, subject, body, fromEmail, attachment);
        }

        showToast('تم إرسال الرسالة بنجاح', 'success');
        emailForm.reset();
        attachmentInfo.textContent = '';
        updateRecipientUI('single');
        statusMessage.textContent = '';
    } catch (err) {
        console.error('Send error:', err);
        showToast('فشل إرسال الرسالة', 'error');
        statusMessage.textContent = 'فشل الإرسال';
        statusMessage.style.color = 'var(--color-danger)';
    } finally {
        sendBtn.disabled = false;
    }
});

async function sendToUser(userId, subject, body, fromEmail, attachment) {
    const user = users.find(u => u.id === userId);
    if (!user || !user.email) throw new Error('المستخدم غير موجود');

    await sendEmail(user.email, user.full_name || 'عميلنا العزيز', subject, body, fromEmail, attachment, userId);
}

async function sendToAll(subject, body, fromEmail, attachment) {
    const validUsers = users.filter(u => u.email);
    let sent = 0;
    let failed = 0;

    for (const user of validUsers) {
        try {
            await sendEmail(user.email, user.full_name || 'عميلنا العزيز', subject, body, fromEmail, attachment, user.id);
            sent++;
            statusMessage.textContent = `تم الإرسال: ${sent}/${validUsers.length}`;
        } catch (err) {
            console.error(`Failed for ${user.email}:`, err);
            failed++;
        }
    }

    if (failed > 0) {
        statusMessage.textContent = `تم: ${sent}, فشل: ${failed}`;
        statusMessage.style.color = 'var(--color-warning)';
    }
}

async function sendEmail(email, name, subject, body, fromEmail, attachment, relatedUserId) {
    const payload = {
        event: 'CUSTOM',
        customer_email: email,
        customer_name: name,
        subject: subject,
        message: body,
        from_email: fromEmail,
        related_user_id: relatedUserId || null,
    };

    if (attachment) {
        payload.attachments = [attachment];
    }

    const { data, error } = await supabase.functions.invoke('send-ticket-email', {
        body: payload
    });

    if (error) throw error;
    return data;
}

function showToast(message, type = 'success') {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.style.background = type === 'success' ? 'var(--color-success)' : 'var(--color-danger)';
    toast.style.display = 'block';
    setTimeout(() => { toast.style.display = 'none'; }, 3000);
}

updateRecipientUI('single');
loadUsers();
