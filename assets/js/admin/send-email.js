import { supabase } from '/api-config.js';
import { initSidebar } from './sidebar.js';

initSidebar();

const userSelect = document.getElementById('userSelect');
const emailForm = document.getElementById('emailForm');
const sendBtn = document.getElementById('sendBtn');
const statusMessage = document.getElementById('statusMessage');
const recipientTypeInputs = document.querySelectorAll('input[name="recipient_type"]');

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

recipientTypeInputs.forEach(input => {
    input.addEventListener('change', (e) => {
        userSelect.disabled = e.target.value === 'all';
        if (e.target.value === 'all') {
            userSelect.value = '';
        }
    });
});

emailForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const recipientType = document.querySelector('input[name="recipient_type"]:checked').value;
    const subject = document.getElementById('emailSubject').value.trim();
    const body = document.getElementById('emailBody').value.trim();
    
    if (!subject || !body) {
        showToast('الرجاء ملء جميع الحقول', 'error');
        return;
    }

    if (recipientType === 'single' && !userSelect.value) {
        showToast('الرجاء اختيار مستخدم', 'error');
        return;
    }

    sendBtn.disabled = true;
    statusMessage.textContent = 'جاري الإرسال...';
    statusMessage.style.color = 'var(--color-info)';

    try {
        if (recipientType === 'all') {
            await sendToAll(subject, body);
        } else {
            await sendToUser(userSelect.value, subject, body);
        }
        
        showToast('تم إرسال الرسالة بنجاح', 'success');
        emailForm.reset();
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

async function sendToUser(userId, subject, body) {
    const user = users.find(u => u.id === userId);
    if (!user || !user.email) throw new Error('المستخدم غير موجود');
    
    await sendEmail(user.email, user.full_name || 'عميلنا العزيز', subject, body);
}

async function sendToAll(subject, body) {
    const validUsers = users.filter(u => u.email);
    let sent = 0;
    let failed = 0;
    
    for (const user of validUsers) {
        try {
            await sendEmail(user.email, user.full_name || 'عميلنا العزيز', subject, body);
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

async function sendEmail(email, name, subject, body) {
    const { data, error } = await supabase.functions.invoke('send-ticket-email', {
        body: {
            event: 'CUSTOM',
            customer_email: email,
            customer_name: name,
            subject: subject,
            message: body
        }
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

loadUsers();
