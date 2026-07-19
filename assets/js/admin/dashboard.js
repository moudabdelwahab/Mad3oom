import { supabase } from '/api-config.js';
import { checkAdminAuth, updateAdminUI } from './auth.js';
import { initSidebar } from './sidebar.js';
import { fetchTicketStats, subscribeToTickets, subscribeToTicketReplies, updateTicketStatus, addTicketReply, fetchTicketReplies, closeTicketWithComment } from '/tickets-service.js';
import { impersonateUser } from './admin-utils.js';

let user = null;
let currentTicketId = null;
let repliesSubscription = null;

async function init() {
    initSidebar();
    user = await checkAdminAuth();
    if (!user) return;

    updateAdminUI(user);
    renderTickets();
    subscribeToTickets(() => renderTickets());
    setupModalEvents();
}

async function renderTickets() {
    const body = document.getElementById('admTicketsBody');
    if (!body) return;

    const { data: tickets } = await supabase
        .from('tickets')
        .select('*, profiles(full_name, email)')
        .order('created_at', { ascending: false })
        .limit(10); 

    body.innerHTML = tickets?.map(t => `
        <tr>
            <td>${t.profiles?.full_name || 'مستخدم'}</td>
            <td>${t.title}</td>
            <td><span class="status-badge status-${t.status}">${t.status}</span></td>
            <td>${new Date(t.created_at).toLocaleDateString('ar-EG')}</td>
            <td><button class="btn btn-primary btn-sm view-ticket-btn" data-id="${t.id}">عرض</button></td>
        </tr>
    `).join('') || '<tr><td colspan="5">لا توجد تذاكر</td></tr>';

    document.querySelectorAll('.view-ticket-btn').forEach(btn => {
        btn.onclick = () => openTicketModal(btn.dataset.id);
    });
    
    const stats = await fetchTicketStats();
    const totalEl = document.getElementById('admTotal');
    const openEl = document.getElementById('admOpen');
    const resolvedEl = document.getElementById('admResolved');

    if (totalEl) totalEl.textContent = stats.total;
    if (openEl) openEl.textContent = stats.open;
    if (resolvedEl) resolvedEl.textContent = stats.resolved;
}

async function openTicketModal(ticketId) {
    currentTicketId = ticketId;
    const modal = document.getElementById('ticketModal');
    
    const { data: ticket, error } = await supabase
        .from('tickets')
        .select('*, profiles(full_name, email)')
        .eq('id', ticketId)
        .single();

    if (error || !ticket) {
        alert('خطأ في جلب بيانات التذكرة');
        return;
    }

    document.getElementById('modalTicketTitle').innerText = ticket.title;
    document.getElementById('modalTicketDesc').innerText = ticket.description;
    document.getElementById('modalTicketNumber').innerText = `#${ticket.ticket_number}`;
    document.getElementById('modalTicketUser').innerText = ticket.profiles?.full_name || 'مستخدم';
    document.getElementById('modalTicketEmail').innerText = ticket.profiles?.email || '';
    document.getElementById('modalTicketDate').innerText = new Date(ticket.created_at).toLocaleString('ar-EG');
    
    const statusMap = { 'open': 'مفتوحة', 'in-progress': 'قيد التنفيذ', 'resolved': 'محلولة' };
    const statusEl = document.getElementById('modalTicketStatus');
    statusEl.innerText = statusMap[ticket.status] || ticket.status;
    statusEl.className = `detail-value status-badge status-${ticket.status}`;

    const imgContainer = document.getElementById('modalTicketImageContainer');
    if (ticket.image_url) {
        imgContainer.style.display = 'block';
        document.getElementById('modalTicketImage').src = ticket.image_url;
        document.getElementById('modalTicketImageLink').href = ticket.image_url;
    } else {
        imgContainer.style.display = 'none';
    }

    document.getElementById('impersonateUserBtn').onclick = () => impersonateUser(ticket.user_id);
    
    const resolveBtn = document.getElementById('resolveTicketBtn');
    if (ticket.status === 'resolved') {
        resolveBtn.innerText = 'إعادة فتح التذكرة';
        resolveBtn.onclick = () => changeStatus('open');
    } else {
        resolveBtn.innerText = 'إغلاق التذكرة (تم الحل)';
        resolveBtn.onclick = () => showCloseModal();
    }

    loadReplies(ticketId);

    if (repliesSubscription) {
        repliesSubscription.unsubscribe();
    }
    repliesSubscription = subscribeToTicketReplies(ticketId, () => {
        loadReplies(ticketId);
    });

    modal.style.display = 'block';
}

async function loadReplies(ticketId) {
    const container = document.getElementById('ticketRepliesList');
    container.innerHTML = '<div style="text-align:center; padding:1rem; color:#999;">جاري تحميل الردود...</div>';
    
    try {
        const replies = await fetchTicketReplies(ticketId);
        if (!replies || replies.length === 0) {
            container.innerHTML = '<div style="text-align:center; padding:1rem; color:#999; font-size:0.8rem;">لا توجد ردود بعد.</div>';
            return;
        }

        container.innerHTML = replies.map(r => {
            const isAdmin = r.profiles?.role === 'admin';
            const typeClass = r.is_internal ? 'reply-internal' : (isAdmin ? 'reply-admin' : 'reply-user');
            const typeLabel = r.is_internal ? '<span class="internal-tag">ملاحظة داخلية</span>' : '';
            
            return `
                <div class="reply-item ${typeClass}">
                    <div class="reply-header">
                        <span style="font-weight:700;">${r.profiles?.full_name || 'مستخدم'} ${typeLabel}</span>
                        <span>${new Date(r.created_at).toLocaleString('ar-EG', {hour:'2-digit', minute:'2-digit', day:'numeric', month:'short'})}</span>
                    </div>
                    <div class="reply-content">${r.message}</div>
                </div>
            `;
        }).join('');
        container.scrollTop = container.scrollHeight;
    } catch (err) {
        container.innerHTML = '<div style="color:red; text-align:center;">فشل تحميل الردود</div>';
    }
}

async function changeStatus(newStatus) {
    if (!currentTicketId) return;
    try {
        await updateTicketStatus(currentTicketId, newStatus);
        openTicketModal(currentTicketId);
        renderTickets();
    } catch (err) {
        alert('فشل تحديث الحالة');
    }
}

function showCloseModal() {
    const closeModal = document.getElementById('closeTicketModal');
    if (closeModal) {
        closeModal.style.display = 'block';
        document.getElementById('closeTicketComment').value = '';
    }
}

async function closeTicket() {
    if (!currentTicketId) return;
    const comment = document.getElementById('closeTicketComment').value.trim();
    try {
        await closeTicketWithComment(currentTicketId, comment);
        document.getElementById('closeTicketModal').style.display = 'none';
        openTicketModal(currentTicketId);
        renderTickets();
    } catch (err) {
        alert('فشل إغلاق التذكرة: ' + err.message);
    }
}

function setupModalEvents() {
    const modal = document.getElementById('ticketModal');
    const closeBtn = document.getElementById('closeModal');
    
    closeBtn.onclick = () => {
        modal.style.display = 'none';
        if (repliesSubscription) repliesSubscription.unsubscribe();
    };
    
    window.onclick = (event) => {
        if (event.target == modal) {
            modal.style.display = 'none';
            if (repliesSubscription) repliesSubscription.unsubscribe();
        }
    };

    document.getElementById('sendPublicReply').onclick = async () => {
        const text = document.getElementById('replyText').value.trim();
        if (!text) return;
        try {
            await addTicketReply(currentTicketId, text, false);
            document.getElementById('replyText').value = '';
            loadReplies(currentTicketId);
            renderTickets();
        } catch (err) {
            alert('فشل إرسال الرد');
        }
    };

    document.getElementById('sendInternalNote').onclick = async () => {
        const text = document.getElementById('replyText').value.trim();
        if (!text) return;
        try {
            await addTicketReply(currentTicketId, text, true);
            document.getElementById('replyText').value = '';
            loadReplies(currentTicketId);
        } catch (err) {
            alert('فشل إضافة الملاحظة');
        }
    };

    const closeTicketModal = document.getElementById('closeTicketModal');
    if (closeTicketModal) {
        document.getElementById('closeCloseTicketModal').onclick = () => closeTicketModal.style.display = 'none';
        document.getElementById('confirmCloseTicket').onclick = closeTicket;
        window.onclick = (event) => {
            if (event.target == closeTicketModal) closeTicketModal.style.display = 'none';
        };
    }
}

async function impersonateUser(id) { 
    if (!id) return alert('لا يمكن الدخول لحساب ضيف');
    const { data: targetUser } = await supabase.from('profiles').select('email').eq('id', id).single();
    const activityModule = await import('/activity-service.js');
    activityModule.logActivity('impersonate', { target_user_id: id, target_email: targetUser?.email });
    await adminImpersonateUser(id);
    location.href = '/customer-dashboard.html';
}

init();
