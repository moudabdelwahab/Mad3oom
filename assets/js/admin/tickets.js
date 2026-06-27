import { supabase } from '/api-config.js';
import { checkAdminAuth, updateAdminUI } from './auth.js';
import { initSidebar } from './sidebar.js';
import { subscribeToTickets, subscribeToTicketReplies, updateTicketStatus, addTicketReply, fetchTicketReplies, closeTicketWithComment } from '/tickets-service.js';
import { adminImpersonateUser } from '/auth-client.js';
import { confirmPurchaseTicket, rejectPurchaseTicket } from '/whatsapp-subscription-service.js';

/**
 * تنقية أي نص قادم من المستخدم/قاعدة البيانات قبل حقنه داخل innerHTML
 * لمنع هجمات XSS (Cross-Site Scripting).
 */
function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * تنقية الروابط قبل استخدامها في خصائص مثل src لمنع بروتوكولات خطيرة مثل javascript:
 */
function sanitizeUrl(url) {
    if (!url) return '';
    const trimmed = String(url).trim();
    if (/^(https?:)?\/\//i.test(trimmed) || trimmed.startsWith('/') || trimmed.startsWith('./')) {
        return escapeHtml(trimmed);
    }
    return '';
}

let user = null;
let currentTicketId = null;
let repliesSubscription = null;
let allTickets = [];

async function init() {
    initSidebar();
    user = await checkAdminAuth();
    if (!user) return;

    updateAdminUI(user);
    await loadTickets();
    subscribeToTickets(() => loadTickets());
    setupModalEvents();
    setupFilters();
}

async function loadTickets() {
    const { data: tickets, error } = await supabase
        .from('tickets')
        .select('*, profiles(full_name, email)')
        .order('created_at', { ascending: false });

    if (error) {
        console.error("Error fetching tickets:", error);
        return;
    }

    allTickets = tickets || [];
    updateStats();
    renderTickets(allTickets);
}

function updateStats() {
    const stats = {
        total: allTickets.length,
        open: allTickets.filter(t => t.status === 'open').length,
        inProgress: allTickets.filter(t => t.status === 'in-progress').length,
        resolved: allTickets.filter(t => t.status === 'resolved').length,
        confirmed: allTickets.filter(t => t.status === 'confirmed').length,
        rejected: allTickets.filter(t => t.status === 'rejected').length
    };

    document.getElementById('statTotal').textContent = stats.total;
    document.getElementById('statOpen').textContent = stats.open;
    document.getElementById('statInProgress').textContent = stats.inProgress;
    document.getElementById('statResolved').textContent = stats.resolved;
    
    // تحديث إحصائيات الشراء إذا كانت موجودة
    const confirmedStat = document.getElementById('statConfirmed');
    const rejectedStat = document.getElementById('statRejected');
    if (confirmedStat) confirmedStat.textContent = stats.confirmed;
    if (rejectedStat) rejectedStat.textContent = stats.rejected;
}

function setupFilters() {
    const statusFilter = document.getElementById('filterStatus');
    const priorityFilter = document.getElementById('filterPriority');
    const searchInput = document.getElementById('searchInput');

    const applyFilters = () => {
        let filtered = [...allTickets];

        // فلتر الحالة
        const status = statusFilter.value;
        if (status !== 'all') {
            filtered = filtered.filter(t => t.status === status);
        }

        // فلتر الأولوية
        const priority = priorityFilter.value;
        if (priority !== 'all') {
            filtered = filtered.filter(t => t.priority === priority);
        }

        // فلتر البحث
        const search = searchInput.value.trim().toLowerCase();
        if (search) {
            filtered = filtered.filter(t => 
                t.title.toLowerCase().includes(search) ||
                t.description.toLowerCase().includes(search) ||
                t.profiles?.full_name?.toLowerCase().includes(search) ||
                t.profiles?.email?.toLowerCase().includes(search) ||
                String(t.ticket_number).includes(search)
            );
        }

        renderTickets(filtered);
    };

    statusFilter.addEventListener('change', applyFilters);
    priorityFilter.addEventListener('change', applyFilters);
    searchInput.addEventListener('input', applyFilters);
}

function renderTickets(tickets) {
    const grid = document.getElementById('ticketsGrid');
    
    if (!tickets || tickets.length === 0) {
        grid.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">📋</div>
                <p>لا توجد تذاكر تطابق معايير البحث</p>
            </div>
        `;
        return;
    }

    const statusMap = {
        'open': 'مفتوحة',
        'in-progress': 'قيد المعالجة',
        'resolved': 'محلولة',
        'confirmed': 'مؤكدة',
        'rejected': 'مرفوضة'
    };

    const priorityMap = {
        'high': { label: 'عالية', class: 'priority-high' },
        'medium': { label: 'متوسطة', class: 'priority-medium' },
        'low': { label: 'منخفضة', class: 'priority-low' }
    };

    grid.innerHTML = tickets.map(t => {
        const userName = escapeHtml(t.profiles?.full_name || 'مستخدم');
        const userInitial = userName[0].toUpperCase();
        const priority = priorityMap[t.priority] || priorityMap['low'];

        return `
            <div class="ticket-card" data-id="${escapeHtml(t.id)}">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
                    <span style="color: var(--color-text-secondary); font-size: 0.8rem; font-weight: 700;">#${escapeHtml(t.ticket_number || '---')}</span>
                    <span class="status-badge status-${escapeHtml(t.status)}" style="padding: 0.2rem 0.5rem; border-radius: 0.5rem; font-size: 0.7rem;">${escapeHtml(statusMap[t.status] || t.status)}</span>
                </div>
                <h4 style="margin: 0 0 0.5rem 0; font-size: 0.95rem; line-height: 1.3; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;">${escapeHtml(t.title)}</h4>
                <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.5rem;">
                    <div style="width: 24px; height: 24px; border-radius: 50%; background: var(--color-accent); color: white; display: flex; align-items: center; justify-content: center; font-size: 0.7rem; font-weight: 700;">${userInitial}</div>
                    <span style="font-size: 0.75rem; color: var(--color-text-secondary);">${userName}</span>
                </div>
                <div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.75rem; color: var(--color-text-secondary);">
                    <span>أولوية: ${priority.label}</span>
                    <span>${new Date(t.created_at).toLocaleDateString('ar-EG', {month: 'short', day: 'numeric'})}</span>
                </div>
            </div>
        `;
    }).join('');

    // Add click handlers and show first ticket by default
    document.querySelectorAll('.ticket-card').forEach((card, index) => {
        card.addEventListener('click', () => {
            // Remove selected class from all cards
            document.querySelectorAll('.ticket-card').forEach(c => c.classList.remove('selected'));
            // Add selected class to clicked card
            card.classList.add('selected');
            
            showAdminTicketInPanel(card.dataset.id);
        });
    });
    
    // Auto-select first ticket
    if (tickets.length > 0) {
        const firstCard = grid.querySelector('.ticket-card');
        if (firstCard) {
            firstCard.classList.add('selected');
            showAdminTicketInPanel(tickets[0].id);
        }
    }
}

async function openTicketModal(ticketId) {
    currentTicketId = ticketId;
    const modal = document.getElementById('ticketModal');
    
    // Fetch full ticket details
    const { data: ticket, error } = await supabase
        .from('tickets')
        .select('*, profiles(full_name, email)')
        .eq('id', ticketId)
        .single();

    if (error || !ticket) {
        alert('خطأ في جلب بيانات التذكرة');
        return;
    }

    // Fill Modal Data
    document.getElementById('modalTicketTitle').innerText = ticket.title;
    document.getElementById('modalTicketDesc').innerText = ticket.description;
    document.getElementById('modalTicketNumber').innerText = `#${ticket.ticket_number}`;
    document.getElementById('modalTicketUser').innerText = ticket.profiles?.full_name || 'مستخدم';
    document.getElementById('modalTicketEmail').innerText = ticket.profiles?.email || '';
    document.getElementById('modalTicketDate').innerText = new Date(ticket.created_at).toLocaleString('ar-EG');
    
    const statusMap = { 'open': 'مفتوحة', 'in-progress': 'قيد المعالجة', 'resolved': 'محلولة' };
    const statusEl = document.getElementById('modalTicketStatus');
    statusEl.innerText = statusMap[ticket.status] || ticket.status;
    statusEl.className = `detail-value status-badge status-${ticket.status}`;

    // Handle Image
    const imgContainer = document.getElementById('modalTicketImageContainer');
    if (ticket.image_url) {
        imgContainer.style.display = 'block';
        document.getElementById('modalTicketImage').src = ticket.image_url;
        document.getElementById('modalTicketImageLink').href = ticket.image_url;
    } else {
        imgContainer.style.display = 'none';
    }

    // Impersonate Button
    document.getElementById('impersonateUserBtn').onclick = () => impersonateUser(ticket.user_id);
    
    // التحقق من نوع التذكرة (شراء أم دعم عادي)
    const isPurchaseTicket = ticket.title.toLowerCase().includes('شراء') || 
                              ticket.title.toLowerCase().includes('اشتراك') ||
                              ticket.title.toLowerCase().includes('واتساب');

    // الأزرار حسب نوع التذكرة
    const resolveBtn = document.getElementById('resolveTicketBtn');
    
    if (isPurchaseTicket) {
        // لتذاكر الشراء: عرض أزرار التأكيد والرفض
        if (ticket.status === 'open' || ticket.status === 'in-progress') {
            resolveBtn.style.display = 'none';
            
            // إنشاء أزرار التأكيد والرفض إذا لم تكن موجودة
            if (!document.getElementById('confirmPurchaseBtn')) {
                const confirmBtn = document.createElement('button');
                confirmBtn.id = 'confirmPurchaseBtn';
                confirmBtn.className = 'btn btn-success';
                confirmBtn.innerText = '✓ تأكيد الشراء';
                confirmBtn.style.cssText = 'background: #2E8A3A; color: white; padding: 0.75rem 1.5rem; border-radius: 0.5rem; border: none; cursor: pointer; font-family: Cairo; margin-right: 0.5rem;';
                confirmBtn.onclick = () => showConfirmPurchaseModal();
                
                const rejectBtn = document.createElement('button');
                rejectBtn.id = 'rejectPurchaseBtn';
                rejectBtn.className = 'btn btn-danger';
                rejectBtn.innerText = '✗ رفض الشراء';
                rejectBtn.style.cssText = 'background: #D9534F; color: white; padding: 0.75rem 1.5rem; border-radius: 0.5rem; border: none; cursor: pointer; font-family: Cairo;';
                rejectBtn.onclick = () => showRejectPurchaseModal();
                
                resolveBtn.parentElement.insertBefore(confirmBtn, resolveBtn);
                resolveBtn.parentElement.insertBefore(rejectBtn, resolveBtn);
            }
        } else if (ticket.status === 'confirmed') {
            resolveBtn.style.display = 'none';
            const statusSpan = document.createElement('span');
            statusSpan.style.cssText = 'color: #2E8A3A; font-weight: 700; padding: 0.75rem 1.5rem;';
            statusSpan.innerText = '✓ تم تأكيد الشراء';
            resolveBtn.parentElement.insertBefore(statusSpan, resolveBtn);
        } else if (ticket.status === 'rejected') {
            resolveBtn.style.display = 'none';
            const statusSpan = document.createElement('span');
            statusSpan.style.cssText = 'color: #D9534F; font-weight: 700; padding: 0.75rem 1.5rem;';
            statusSpan.innerText = '✗ تم رفض الشراء';
            resolveBtn.parentElement.insertBefore(statusSpan, resolveBtn);
        }
    } else {
        // لتذاكر الدعم العادية: الزر العادي
        if (ticket.status === 'resolved') {
            resolveBtn.innerText = 'إعادة فتح التذكرة';
            resolveBtn.onclick = () => changeStatus('open');
        } else {
            resolveBtn.innerText = 'إغلاق التذكرة (تم الحل)';
            resolveBtn.onclick = () => showCloseModal();
        }
    }

    // Load Replies
    loadReplies(ticketId);

    // Subscribe to real-time replies updates
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
                        <span style="font-weight:700;">${escapeHtml(r.profiles?.full_name || 'مستخدم')} ${typeLabel}</span>
                        <span>${new Date(r.created_at).toLocaleString('ar-EG', {hour:'2-digit', minute:'2-digit', day:'numeric', month:'short'})}</span>
                    </div>
                    <div class="reply-content">${escapeHtml(r.message)}</div>
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
        openTicketModal(currentTicketId); // Refresh modal
        await loadTickets(); // Refresh list
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
        openTicketModal(currentTicketId); // Refresh modal
        await loadTickets(); // Refresh list
    } catch (err) {
        alert('فشل إغلاق التذكرة: ' + err.message);
    }
}

function setupModalEvents() {
    const modal = document.getElementById('ticketModal');
    const closeBtn = document.getElementById('closeModal');
    
    closeBtn.onclick = () => {
        modal.style.display = 'none';
        if (repliesSubscription) {
            repliesSubscription.unsubscribe();

    // Confirm Purchase Modal
    const confirmPurchaseModal = document.getElementById('confirmPurchaseModal');
    if (confirmPurchaseModal) {
        const confirmBtn = document.getElementById('confirmPurchaseConfirmBtn');
        const cancelBtn = document.getElementById('confirmPurchaseCancelBtn');
        
        if (confirmBtn) {
            confirmBtn.onclick = async () => {
                try {
                    await confirmPurchaseTicket(currentTicketId);
                    confirmPurchaseModal.style.display = 'none';
                    await loadTickets();
                    openTicketModal(currentTicketId);
                    alert('تم تأكيد الشراء بنجاح!');
                } catch (err) {
                    alert('فشل تأكيد الشراء: ' + err.message);
                }
            };
        }
        
        if (cancelBtn) {
            cancelBtn.onclick = () => {
                confirmPurchaseModal.style.display = 'none';
            };
        }
    }

    // Reject Purchase Modal
    const rejectPurchaseModal = document.getElementById('rejectPurchaseModal');
    if (rejectPurchaseModal) {
        const rejectBtn = document.getElementById('rejectPurchaseConfirmBtn');
        const cancelBtn = document.getElementById('rejectPurchaseCancelBtn');
        
        if (rejectBtn) {
            rejectBtn.onclick = async () => {
                try {
                    const reason = document.getElementById('rejectReason').value.trim();
                    await rejectPurchaseTicket(currentTicketId, reason);
                    rejectPurchaseModal.style.display = 'none';
                    document.getElementById('rejectReason').value = '';
                    await loadTickets();
                    openTicketModal(currentTicketId);
                    alert('تم رفض الشراء بنجاح!');
                } catch (err) {
                    alert('فشل رفض الشراء: ' + err.message);
                }
            };
        }
        
        if (cancelBtn) {
            cancelBtn.onclick = () => {
                rejectPurchaseModal.style.display = 'none';
                document.getElementById('rejectReason').value = '';
            };
        }
    }

        }
    };
    
    window.onclick = (event) => {
        if (event.target == modal) {
            modal.style.display = 'none';
            if (repliesSubscription) {
                repliesSubscription.unsubscribe();
            }
        }
    };

    // Send Public Reply
    document.getElementById('sendPublicReply').onclick = async () => {
        const text = document.getElementById('replyText').value.trim();
        if (!text) {
            alert('الرجاء كتابة رد قبل الإرسال');
            return;
        }
        
        try {
            const btn = document.getElementById('sendPublicReply');
            btn.disabled = true;
            btn.textContent = 'جاري الإرسال...';
            
            await addTicketReply(currentTicketId, text, false);
            document.getElementById('replyText').value = '';
            await loadReplies(currentTicketId);
            await loadTickets();
            
            btn.disabled = false;
            btn.textContent = 'إرسال رد للعميل';
        } catch (err) {
            console.error('Error sending reply:', err);
            alert('فشل إرسال الرد: ' + (err.message || 'حدث خطأ غير متوقع'));
            const btn = document.getElementById('sendPublicReply');
            btn.disabled = false;
            btn.textContent = 'إرسال رد للعميل';
        }
    };

    // Send Internal Note
    document.getElementById('sendInternalNote').onclick = async () => {
        const text = document.getElementById('replyText').value.trim();
        if (!text) {
            alert('الرجاء كتابة ملاحظة قبل الإضافة');
            return;
        }
        
        try {
            const btn = document.getElementById('sendInternalNote');
            btn.disabled = true;
            btn.textContent = 'جاري الإضافة...';
            
            await addTicketReply(currentTicketId, text, true);
            document.getElementById('replyText').value = '';
            await loadReplies(currentTicketId);
            
            btn.disabled = false;
            btn.textContent = 'إضافة ملاحظة داخلية';
        } catch (err) {
            console.error('Error adding internal note:', err);
            alert('فشل إضافة الملاحظة: ' + (err.message || 'حدث خطأ غير متوقع'));
            const btn = document.getElementById('sendInternalNote');
            btn.disabled = false;
            btn.textContent = 'إضافة ملاحظة داخلية';
        }
    };

    // Close Ticket Modal Events
    const closeTicketModal = document.getElementById('closeTicketModal');
    if (closeTicketModal) {
        const closeCloseBtn = document.getElementById('closeCloseTicketModal');
        if (closeCloseBtn) {
            closeCloseBtn.onclick = () => closeTicketModal.style.display = 'none';
        }

        document.getElementById('confirmCloseTicket').onclick = closeTicket;

        window.onclick = (event) => {
            if (event.target == closeTicketModal) {
                closeTicketModal.style.display = 'none';
            }
        };
    }
}

async function showAdminTicketInPanel(ticketId) {
    currentTicketId = ticketId;
    const panel = document.getElementById('adminTicketDetailsContent');
    if (!panel) return;
    
    // Fetch full ticket details
    const { data: ticket, error } = await supabase
        .from('tickets')
        .select('*, profiles(full_name, email, id)')
        .eq('id', ticketId)
        .single();

    if (error || !ticket) {
        panel.innerHTML = '<p style="text-align:center; color:red;">خطأ في جلب بيانات التذكرة</p>';
        return;
    }
    
    const statusMap = {
        'open': 'مفتوحة',
        'in-progress': 'قيد المعالجة',
        'resolved': 'محلولة',
        'confirmed': 'مؤكدة',
        'rejected': 'مرفوضة'
    };
    
    const priorityMap = {
        'high': 'عالية',
        'medium': 'متوسطة',
        'low': 'منخفضة'
    };
    
    panel.style.display = 'block';
    panel.style.alignItems = 'flex-start';
    panel.style.justifyContent = 'flex-start';
    
    panel.innerHTML = `
        <div style="width: 100%;">
            <!-- Header -->
            <div style="border-bottom: 2px solid var(--color-border); padding-bottom: 1rem; margin-bottom: 1.5rem;">
                <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 0.75rem;">
                    <h2 style="margin: 0; font-size: 1.3rem; line-height: 1.4;">${escapeHtml(ticket.title)}</h2>
                    <span class="status-badge status-${escapeHtml(ticket.status)}" style="padding: 0.3rem 0.75rem; border-radius: 0.5rem; font-size: 0.8rem; white-space: nowrap;">${escapeHtml(statusMap[ticket.status])}</span>
                </div>
                <div style="display: flex; gap: 1.5rem; font-size: 0.85rem; color: var(--color-text-secondary); flex-wrap: wrap;">
                    <span>رقم التذكرة: <strong>#${escapeHtml(ticket.ticket_number || '---')}</strong></span>
                    <span>الأولوية: <strong style="color: var(--color-accent);">${escapeHtml(priorityMap[ticket.priority])}</strong></span>
                    <span>${new Date(ticket.created_at).toLocaleDateString('ar-EG')}</span>
                </div>
                <div style="margin-top: 0.75rem; padding: 0.75rem; background: var(--color-muted); border-radius: 0.5rem;">
                    <div style="font-size: 0.85rem; color: var(--color-text-secondary); margin-bottom: 0.25rem;">العميل</div>
                    <div style="font-weight: 700;">${escapeHtml(ticket.profiles?.full_name || 'مستخدم')}</div>
                    <div style="font-size: 0.85rem; color: var(--color-text-secondary);">${escapeHtml(ticket.profiles?.email || '')}</div>
                </div>
            </div>
            
            <!-- Description -->
            <div style="margin-bottom: 1.5rem;">
                <h3 style="font-size: 0.9rem; color: var(--color-text-secondary); margin-bottom: 0.5rem;">وصف المشكلة</h3>
                <p style="line-height: 1.6; white-space: pre-wrap;">${escapeHtml(ticket.description)}</p>
            </div>
            
            ${ticket.image_url ? `
            <div style="margin-bottom: 1.5rem;">
                <h3 style="font-size: 0.9rem; color: var(--color-text-secondary); margin-bottom: 0.5rem;">المرفقات</h3>
                <img src="${sanitizeUrl(ticket.image_url)}" style="max-width: 100%; border-radius: 0.5rem; border: 1px solid var(--color-border);">
            </div>
            ` : ''}
            
            <!-- Status Control -->
            <div style="margin-bottom: 1.5rem; padding: 1rem; background: var(--color-muted); border-radius: 0.75rem;">
                <label style="display: block; font-size: 0.9rem; font-weight: 700; margin-bottom: 0.5rem;">تغيير حالة التذكرة</label>
                <select id="panelStatusSelect" style="width: 100%; padding: 0.75rem; border-radius: 0.5rem; border: 1px solid var(--color-border); background: var(--color-surface); color: var(--color-text); font-weight: 600;">
                    <option value="open" ${ticket.status === 'open' ? 'selected' : ''}>مفتوحة</option>
                    <option value="in-progress" ${ticket.status === 'in-progress' ? 'selected' : ''}>قيد المعالجة</option>
                    <option value="resolved" ${ticket.status === 'resolved' ? 'selected' : ''}>محلولة</option>
                </select>
            </div>
            
            <!-- Replies Section -->
            <div style="border-top: 2px solid var(--color-border); padding-top: 1.5rem;">
                <h3 style="font-size: 1rem; margin-bottom: 1rem;">الردود</h3>
                <div id="adminPanelRepliesList" style="max-height: 250px; overflow-y: auto; margin-bottom: 1rem; padding-left: 0.5rem;">
                    <div style="text-align:center; padding:1rem; color: var(--color-text-secondary);">جاري تحميل الردود...</div>
                </div>
                
                <div>
                    <textarea id="adminPanelReplyText" style="width: 100%; padding: 0.75rem; border-radius: 0.5rem; border: 1px solid var(--color-border); background: var(--color-muted); color: var(--color-text); font-family: inherit; min-height: 70px; resize: vertical;" placeholder="اكتب ردك هنا..."></textarea>
                    <button id="adminPanelSendReply" class="btn btn-primary" style="margin-top: 0.5rem; width: 100%;">إرسال الرد</button>
                </div>
            </div>
        </div>
    `;
    
    // Load replies
    await loadAdminRepliesInPanel(ticket.id);
    
    // Setup status change
    const statusSelect = document.getElementById('panelStatusSelect');
    if (statusSelect) {
        statusSelect.addEventListener('change', async () => {
            try {
                await updateTicketStatus(ticket.id, statusSelect.value);
                // Refresh tickets list to show updated status
                await loadTickets();
            } catch (err) {
                alert('فشل تغيير الحالة: ' + err.message);
            }
        });
    }
    
    // Setup reply button
    const sendBtn = document.getElementById('adminPanelSendReply');
    const replyInput = document.getElementById('adminPanelReplyText');
    if (sendBtn && replyInput) {
        sendBtn.onclick = async () => {
            const message = replyInput.value.trim();
            if (!message) {
                alert('الرجاء كتابة رد قبل الإرسال');
                return;
            }
            
            try {
                sendBtn.disabled = true;
                sendBtn.textContent = 'جاري الإرسال...';
                await addTicketReply(ticket.id, message, false);
                replyInput.value = '';
                await loadAdminRepliesInPanel(ticket.id);
                await loadTickets();
            } catch (err) {
                console.error('Error sending reply:', err);
                alert('فشل إرسال الرد: ' + (err.message || 'حدث خطأ غير متوقع'));
            } finally {
                sendBtn.disabled = false;
                sendBtn.textContent = 'إرسال الرد';
            }
        };
    }
}

async function loadAdminRepliesInPanel(ticketId) {
    const list = document.getElementById('adminPanelRepliesList');
    if (!list) return;
    
    list.innerHTML = '<div style="text-align:center; padding:1rem; color: var(--color-text-secondary);">جاري تحميل الردود...</div>';
    
    try {
        const replies = await fetchTicketReplies(ticketId);
        if (replies.length === 0) {
            list.innerHTML = '<p style="text-align: center; color: var(--color-text-secondary); font-size: 0.85rem; padding: 1rem;">لا توجد ردود بعد</p>';
            return;
        }
        
        list.innerHTML = replies.map(r => `
            <div class="reply-item ${r.profiles?.role === 'admin' ? 'reply-admin' : 'reply-user'}" style="margin-bottom: 0.75rem; padding: 0.75rem; border-radius: 0.5rem; background: var(--color-surface); border: 1px solid var(--color-border);">
                <div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem; font-size: 0.75rem;">
                    <strong style="color: var(--color-accent);">${r.profiles?.role === 'admin' ? 'الدعم الفني' : escapeHtml(r.profiles?.full_name || 'العميل')}</strong>
                    <span style="color: var(--color-text-secondary);">${new Date(r.created_at).toLocaleString('ar-EG', {hour:'2-digit', minute:'2-digit', day: 'numeric', month: 'short'})}</span>
                </div>
                <div style="font-size: 0.85rem; line-height: 1.5;">${escapeHtml(r.message)}</div>
            </div>
        `).join('');
        list.scrollTop = list.scrollHeight;
    } catch (err) {
        list.innerHTML = '<p style="text-align:center; color:red;">فشل تحميل الردود</p>';
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


// دوال عرض النوافذ المنبثقة
function showConfirmPurchaseModal() {
    const modal = document.getElementById('confirmPurchaseModal');
    if (!modal) {
        // إنشاء النافذة إذا لم تكن موجودة
        const newModal = document.createElement('div');
        newModal.id = 'confirmPurchaseModal';
        newModal.style.cssText = 'display: none; position: fixed; z-index: 3000; left: 0; top: 0; width: 100%; height: 100%; background-color: rgba(0,0,0,0.4);';
        newModal.innerHTML = `
            <div style="background-color: #fefefe; margin: 15% auto; padding: 2rem; border: 1px solid #888; border-radius: 0.5rem; width: 80%; max-width: 400px; font-family: Cairo;">
                <h2 style="margin-top: 0; color: #003366;">تأكيد الشراء</h2>
                <p>هل أنت متأكد من تأكيد هذا الشراء؟ سيتم تفعيل خدمة واتساب للعميل لمدة شهر واحد.</p>
                <div style="display: flex; gap: 1rem; justify-content: flex-end;">
                    <button id="confirmPurchaseCancelBtn" style="padding: 0.5rem 1rem; background: #999; color: white; border: none; border-radius: 0.25rem; cursor: pointer; font-family: Cairo;">إلغاء</button>
                    <button id="confirmPurchaseConfirmBtn" style="padding: 0.5rem 1rem; background: #2E8A3A; color: white; border: none; border-radius: 0.25rem; cursor: pointer; font-family: Cairo;">تأكيد</button>
                </div>
            </div>
        `;
        document.body.appendChild(newModal);
        setupModalEvents();
    } else {
        modal.style.display = 'block';
    }
}

function showRejectPurchaseModal() {
    const modal = document.getElementById('rejectPurchaseModal');
    if (!modal) {
        // إنشاء النافذة إذا لم تكن موجودة
        const newModal = document.createElement('div');
        newModal.id = 'rejectPurchaseModal';
        newModal.style.cssText = 'display: none; position: fixed; z-index: 3000; left: 0; top: 0; width: 100%; height: 100%; background-color: rgba(0,0,0,0.4);';
        newModal.innerHTML = `
            <div style="background-color: #fefefe; margin: 15% auto; padding: 2rem; border: 1px solid #888; border-radius: 0.5rem; width: 80%; max-width: 400px; font-family: Cairo;">
                <h2 style="margin-top: 0; color: #D9534F;">رفض الشراء</h2>
                <p>هل أنت متأكد من رفض هذا الشراء؟</p>
                <label style="display: block; margin-bottom: 1rem;">
                    <span style="display: block; margin-bottom: 0.5rem; font-weight: 600;">السبب (اختياري):</span>
                    <textarea id="rejectReason" style="width: 100%; padding: 0.5rem; border: 1px solid #ddd; border-radius: 0.25rem; font-family: Cairo; resize: vertical; min-height: 80px;"></textarea>
                </label>
                <div style="display: flex; gap: 1rem; justify-content: flex-end;">
                    <button id="rejectPurchaseCancelBtn" style="padding: 0.5rem 1rem; background: #999; color: white; border: none; border-radius: 0.25rem; cursor: pointer; font-family: Cairo;">إلغاء</button>
                    <button id="rejectPurchaseConfirmBtn" style="padding: 0.5rem 1rem; background: #D9534F; color: white; border: none; border-radius: 0.25rem; cursor: pointer; font-family: Cairo;">رفض</button>
                </div>
            </div>
        `;
        document.body.appendChild(newModal);
        setupModalEvents();
    } else {
        modal.style.display = 'block';
    }
}


init();
