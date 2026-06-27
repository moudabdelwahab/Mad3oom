// customer-dashboard.js
import { requireAuth, logout, updateProfile, updatePassword } from './auth-client.js';
import { initCustomerSidebar } from './assets/js/customer-sidebar.js';
import { initExpiryModalHandler } from './assets/js/subscription-expiry-modal.js';
import { initRewardsDashboard } from './rewards-dashboard.js';
import { initCustomerSettingsModal, openSettingsModal } from './customer-settings-modal.js';
import {
    fetchUserTickets,
    createTicket,
    fetchTicketStats,
    fetchTicketReplies,
    addTicketReply,
    subscribeToTickets,
    deleteTicket
} from './tickets-service.js';
import {
    fetchNotifications,
    markAllAsRead,
    subscribeToNotifications
} from './notifications-service.js';
import { ui } from './ui-service.js';

/**
 * تنقية أي نص قادم من المستخدم/قاعدة البيانات قبل حقنه داخل innerHTML
 * لمنع هجمات XSS (Cross-Site Scripting).
 * يحوّل الأحرف الخطرة (< > & " ') إلى الكيانات الآمنة المقابلة لها.
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
 * تنقية الروابط (URLs) قبل استخدامها في خصائص مثل src/href.
 * يسمح فقط بروابط http/https أو الروابط النسبية، ويرفض أي بروتوكول خطير
 * مثل javascript: أو data: التي قد تُستخدم لتنفيذ كود ضار.
 */
function sanitizeUrl(url) {
    if (!url) return '';
    const trimmed = String(url).trim();
    if (/^(https?:)?\/\//i.test(trimmed) || trimmed.startsWith('/') || trimmed.startsWith('./')) {
        return escapeHtml(trimmed);
    }
    return '';
}

(async function () {

    /* ================= AUTH ================= */

    const user = await requireAuth('customer');
    if (!user) {
        window.location.replace('login.html');
        return;
    }

    const isGuest = user.isGuest || false;

    // تحديث واجهة المستخدم ببيانات المستخدم
    const welcomeEl = document.getElementById('welcomeUser');
    const updateWelcomeText = () => {
        if (welcomeEl) {
            welcomeEl.textContent = isGuest
                ? 'مرحباً بك (زائر)'
                : `مرحباً، ${user.profile?.full_name || user.email?.split('@')[0] || 'مستخدم'}`;
        }
    };
    updateWelcomeText();

    // Initialize Sidebar — callback runs after sidebar HTML is injected
    initCustomerSidebar((tabName) => {
        const tabEl = document.querySelector(`.nav-tab[data-tab="${tabName}"]`);
        if (tabEl) tabEl.click();
        updateSidebarUserInfo();
    });

    // Initialize Subscription Expiry Modal Handler
    if (!isGuest) {
        initExpiryModalHandler();
    }

    // Initialize Settings Modal
    if (!isGuest) {
        initCustomerSettingsModal();
    }

    // Initialize Rewards Dashboard
    if (!isGuest) {
        initRewardsDashboard(user);
    }

    // Update Sidebar User Info — runs after sidebar HTML is injected
    const updateSidebarUserInfo = () => {
        const customerInitial = document.getElementById('customerInitial');
        if (customerInitial) {
            customerInitial.textContent = (user.profile?.full_name || user.email || 'U')[0].toUpperCase();
        }
    };

    /* ================= TABS LOGIC ================= */

    const tabs = document.querySelectorAll('.nav-tab');
    const contents = document.querySelectorAll('.tab-content');

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            if (isGuest && tab.id === 'profileTab') {
                alert('هذه الميزة غير متاحة في وضع الضيف.');
                return;
            }

            const target = tab.getAttribute('data-tab');
            tabs.forEach(t => t.classList.remove('active'));
            contents.forEach(c => c.classList.remove('active'));

            tab.classList.add('active');
            const targetContent = document.getElementById(target + 'TabContent');
            if (targetContent) targetContent.classList.add('active');
        });
    });

    /* ================= MODALS LOGIC ================= */

    const openCreateTicketBtn = document.getElementById('openCreateTicket');
    const createTicketModal = document.getElementById('createTicketModal');
    
    if (openCreateTicketBtn && createTicketModal) {
        openCreateTicketBtn.addEventListener('click', () => {
            if (isGuest) return alert('يرجى تسجيل الدخول لإنشاء تذكرة');
            createTicketModal.classList.add('active');
        });
    }

    const closeModalBtns = document.querySelectorAll('.close-modal, .modal');
    closeModalBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            if (e.target === btn || btn.classList.contains('close-modal')) {
                const modal = btn.closest('.modal');
                if (modal) modal.classList.remove('active');
            }
        });
    });

    /* ================= TICKETS LOGIC ================= */

    let currentTicketId = null;

    async function renderStats() {
        const stats = await fetchTicketStats();
        const elements = {
            'userTotalTickets': stats.total,
            'userInProgressTickets': stats.inProgress,
            'userResolvedTickets': stats.resolved
        };

        for (const [id, val] of Object.entries(elements)) {
            const el = document.getElementById(id);
            if (el) el.textContent = val ?? 0;
        }

        // Update ticket count badge on the tickets tab
        const ticketsTab = document.querySelector('.nav-tab[data-tab="tickets"]');
        if (ticketsTab && stats.inProgress > 0) {
            let badge = ticketsTab.querySelector('.ticket-count-badge');
            if (!badge) {
                badge = document.createElement('span');
                badge.className = 'ticket-count-badge';
                badge.style.cssText = 'display: inline-flex; align-items: center; justify-content: center; background: #D9534F; color: white; border-radius: 50%; width: 24px; height: 24px; font-size: 0.75rem; font-weight: 700; margin-right: 0.5rem;';
                ticketsTab.appendChild(badge);
            }
            badge.textContent = stats.inProgress;
        } else if (ticketsTab) {
            const badge = ticketsTab.querySelector('.ticket-count-badge');
            if (badge) badge.remove();
        }
    }

    async function renderTickets(filters = {}) {
        const list = document.getElementById('userTicketsList');
        if (!list) return;

        const tickets = await fetchUserTickets(filters);
        
        if (!tickets.length) {
            list.innerHTML = `<p style="text-align: center; padding: 2rem; color: var(--color-text-secondary);">لا توجد تذاكر حتى الآن</p>`;
            return;
        }

        const statusLabels = { open: 'مفتوحة', 'in-progress': 'قيد المعالجة', resolved: 'تم الحل' };
        const priorityLabels = { high: 'عالية', medium: 'متوسطة', low: 'منخفضة' };

        list.innerHTML = tickets.map(t => `
            <div class="ticket-card" data-id="${t.id}">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
                    <span style="color: var(--color-text-secondary); font-size: 0.8rem; font-weight: 700;">#${t.ticket_number || '---'}</span>
                    <span class="status-badge status-${t.status}" style="padding: 0.2rem 0.5rem; border-radius: 0.5rem; font-size: 0.7rem;">${statusLabels[t.status] || t.status}</span>
                </div>
                <h4 style="margin: 0 0 0.5rem 0; font-size: 0.95rem; line-height: 1.3; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;">${escapeHtml(t.title)}</h4>
                <div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.75rem; color: var(--color-text-secondary);">
                    <span>أولوية: ${priorityLabels[t.priority] || t.priority}</span>
                    <span>${new Date(t.created_at).toLocaleDateString('ar-EG', {month: 'short', day: 'numeric'})}</span>
                </div>
            </div>
        `).join('');

        // Add click handlers and show first ticket by default
        list.querySelectorAll('.ticket-card').forEach((card, index) => {
            card.onclick = () => {
                // Remove selected class from all cards
                list.querySelectorAll('.ticket-card').forEach(c => c.classList.remove('selected'));
                // Add selected class to clicked card
                card.classList.add('selected');
                
                const ticket = tickets.find(t => t.id === card.dataset.id);
                if (ticket) showTicketInPanel(ticket);
            };
        });
        
        // Auto-select first ticket
        if (tickets.length > 0) {
            const firstCard = list.querySelector('.ticket-card');
            if (firstCard) {
                firstCard.classList.add('selected');
                showTicketInPanel(tickets[0]);
            }
        }
    }

    async function openTicketDetail(ticket) {
        currentTicketId = ticket.id;
        const modal = document.getElementById('ticketDetailModal');
        if (!modal) return;

        document.getElementById('detailTicketTitle').textContent = ticket.title;
        document.getElementById('detailTicketNumber').textContent = `#${ticket.ticket_number}`;
        document.getElementById('detailTicketDesc').textContent = ticket.description;
        document.getElementById('detailTicketDate').textContent = new Date(ticket.created_at).toLocaleString('ar-EG');
        
        const statusEl = document.getElementById('detailTicketStatus');
        const statusLabels = { open: 'مفتوحة', 'in-progress': 'قيد المعالجة', resolved: 'تم الحل' };
        statusEl.textContent = statusLabels[ticket.status] || ticket.status;
        statusEl.className = `status-badge status-${ticket.status}`;
        statusEl.style.display = 'inline-block';
        statusEl.style.fontWeight = '700';

        // Image handling
        const imgContainer = document.getElementById('detailTicketImageContainer');
        const imgEl = document.getElementById('detailTicketImage');
        if (ticket.image_url) {
            imgContainer.style.display = 'block';
            imgEl.src = ticket.image_url;
        } else {
            imgContainer.style.display = 'none';
        }

        // Rating section
        const ratingSection = document.getElementById('ratingSection');
        if (ratingSection) {
            ratingSection.style.display = ticket.status === 'resolved' ? 'block' : 'none';
        }

        modal.classList.add('active');
        await loadReplies(ticket.id);
    }

    // New function to show ticket details in the side panel
    async function showTicketInPanel(ticket) {
        currentTicketId = ticket.id;
        const panel = document.getElementById('ticketDetailsContent');
        if (!panel) return;
        
        const statusLabels = { open: 'مفتوحة', 'in-progress': 'قيد المعالجة', resolved: 'تم الحل' };
        const priorityLabels = { high: 'عالية', medium: 'متوسطة', low: 'منخفضة' };
        
        panel.style.display = 'block';
        panel.style.alignItems = 'flex-start';
        panel.style.justifyContent = 'flex-start';
        
        panel.innerHTML = `
            <div style="width: 100%;">
                <!-- Header -->
                <div style="border-bottom: 2px solid var(--color-border); padding-bottom: 1rem; margin-bottom: 1.5rem;">
                    <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 0.75rem;">
                        <h2 style="margin: 0; font-size: 1.3rem; line-height: 1.4;">${escapeHtml(ticket.title)}</h2>
                        <span class="status-badge status-${escapeHtml(ticket.status)}" style="padding: 0.3rem 0.75rem; border-radius: 0.5rem; font-size: 0.8rem; white-space: nowrap;">${escapeHtml(statusLabels[ticket.status])}</span>
                    </div>
                    <div style="display: flex; gap: 1.5rem; font-size: 0.85rem; color: var(--color-text-secondary); flex-wrap: wrap;">
                        <span>رقم التذكرة: <strong>#${ticket.ticket_number || '---'}</strong></span>
                        <span>الأولوية: <strong style="color: var(--color-accent);">${priorityLabels[ticket.priority]}</strong></span>
                        <span>${new Date(ticket.created_at).toLocaleDateString('ar-EG')}</span>
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
                
                <!-- Replies Section -->
                <div style="border-top: 2px solid var(--color-border); padding-top: 1.5rem;">
                    <h3 style="font-size: 1rem; margin-bottom: 1rem;">الردود</h3>
                    <div id="panelRepliesList" style="max-height: 250px; overflow-y: auto; margin-bottom: 1rem; padding-left: 0.5rem;">
                        <div style="text-align:center; padding:1rem; color: var(--color-text-secondary);">جاري تحميل الردود...</div>
                    </div>
                    
                    <div>
                        <textarea id="panelReplyText" style="width: 100%; padding: 0.75rem; border-radius: 0.5rem; border: 1px solid var(--color-border); background: var(--color-muted); color: var(--color-text); font-family: inherit; min-height: 70px; resize: vertical;" placeholder="اكتب ردك هنا..."></textarea>
                        <button id="panelSendReply" class="btn btn-primary" style="margin-top: 0.5rem; width: 100%;">إرسال الرد</button>
                    </div>
                </div>
                
                <!-- Action Buttons -->
                <div style="display: flex; gap: 0.5rem; margin-top: 1.5rem; border-top: 2px solid var(--color-border); padding-top: 1.5rem;">
                    <button id="followUpWhatsApp" class="btn" style="flex: 1; background: #25D366; color: white; border: none; padding: 0.75rem; border-radius: 0.5rem; cursor: pointer; font-weight: 600; display: flex; align-items: center; justify-content: center; gap: 0.5rem;">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.67-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.076 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421-7.403h-.004c-1.052 0-2.082.398-2.847 1.12-.735.71-1.14 1.656-1.14 2.66 0 1.04.424 2.044 1.163 2.802l.03.03c.692.713 1.651 1.173 2.694 1.173h.004c1.044 0 2.04-.46 2.73-1.175.39-.377.707-.821.922-1.315.215-.494.328-1.026.328-1.56 0-1.04-.424-2.044-1.161-2.802-.694-.718-1.651-1.173-2.694-1.173M12 0C5.383 0 0 5.383 0 12s5.383 12 12 12 12-5.383 12-12S18.617 0 12 0z"/></svg>
                        متابعة على الواتساب
                    </button>
                    <button id="deleteTicket" class="btn" style="flex: 1; background: #EF4444; color: white; border: none; padding: 0.75rem; border-radius: 0.5rem; cursor: pointer; font-weight: 600; display: flex; align-items: center; justify-content: center; gap: 0.5rem;">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                        حذف التذكرة
                    </button>
                </div>
            </div>
        `;
        
        // Load replies
        await loadRepliesInPanel(ticket.id);
        
        // Setup WhatsApp follow-up button
        const whatsappBtn = document.getElementById('followUpWhatsApp');
        if (whatsappBtn) {
            whatsappBtn.onclick = async () => {
                try {
                    // تجميع تفاصيل التذكرة
                    const ticketDetails = `
*تفاصيل التذكرة #${ticket.ticket_number}*

*العنوان:* ${ticket.title}
*الحالة:* ${statusLabels[ticket.status]}
*الأولوية:* ${priorityLabels[ticket.priority]}
*تاريخ الإنشاء:* ${new Date(ticket.created_at).toLocaleDateString('ar-EG')}

*الوصف:*
${ticket.description}

---
تم إرسال هذه الرسالة من منصة مدعوم
                    `.trim();
                    
                    // ترميز الرسالة للواتساب
                    const encodedMessage = encodeURIComponent(ticketDetails);
                    const whatsappUrl = `https://wa.me/201274000741?text=${encodedMessage}`;
                    
                    // فتح الواتساب
                    window.open(whatsappUrl, '_blank');
                } catch (err) {
                    console.error('Error opening WhatsApp:', err);
                    alert('حدث خطأ في فتح الواتساب');
                }
            };
        }
        
        // Setup delete button with confirmation modal
        const deleteBtn = document.getElementById('deleteTicket');
        if (deleteBtn) {
            deleteBtn.onclick = async () => {
                // الحصول على عناصر النافذة المنبثقة
                const deleteModal = document.getElementById('deleteConfirmModal');
                const deleteConfirmText = document.getElementById('deleteConfirmText');
                const confirmDeleteBtn = document.getElementById('confirmDeleteBtn');
                const cancelDeleteBtn = document.getElementById('cancelDeleteBtn');
                
                if (!deleteModal) return;
                
                // تحديث نص التأكيد برقم التذكرة
                deleteConfirmText.textContent = `هل أنت متأكد من رغبتك في حذف التذكرة #${ticket.ticket_number}؟ هذا الإجراء لا يمكن التراجع عنه.`;
                
                // عرض النافذة
                deleteModal.classList.add('active');
                
                // إعادة تعيين حالة الأزرار
                confirmDeleteBtn.disabled = false;
                confirmDeleteBtn.textContent = 'حذف الآن';
                
                // إعداد معالج الحذف
                const performDelete = async () => {
                    try {
                        confirmDeleteBtn.disabled = true;
                        confirmDeleteBtn.textContent = 'جاري الحذف...';
                        
                        // حذف التذكرة
                        await deleteTicket(ticket.id);
                        
                        // إعادة تحميل قائمة التذاكر
                        await renderStats();
                        await renderTickets();
                        
                        // إغلاق النافذة
                        deleteModal.classList.remove('active');
                        
                        // إظهار رسالة نجاح
                        alert('تم حذف التذكرة بنجاح');
                        
                        // مسح لوحة التفاصيل
                        if (panel) {
                            panel.innerHTML = `
                                <div style="text-align: center; padding: 2rem; color: var(--color-text-secondary);">
                                    <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="margin: 0 auto 1rem;">
                                        <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/>
                                    </svg>
                                    <p style="font-size: 1.1rem; font-weight: 600;">اختر تذكرة لعرض التفاصيل</p>
                                    <p style="font-size: 0.9rem; margin-top: 0.5rem;">انقر على أي تذكرة من القائمة</p>
                                </div>
                            `;
                        }
                        currentTicketId = null;
                        
                        // إزالة معالجات الأحداث
                        confirmDeleteBtn.removeEventListener('click', performDelete);
                        cancelDeleteBtn.removeEventListener('click', closeModal);
                    } catch (err) {
                        console.error('Error deleting ticket:', err);
                        alert('فشل حذف التذكرة: ' + (err.message || 'حدث خطأ غير متوقع'));
                        confirmDeleteBtn.disabled = false;
                        confirmDeleteBtn.textContent = 'حذف الآن';
                    }
                };
                
                const closeModal = () => {
                    deleteModal.classList.remove('active');
                    confirmDeleteBtn.removeEventListener('click', performDelete);
                    cancelDeleteBtn.removeEventListener('click', closeModal);
                    confirmDeleteBtn.disabled = false;
                    confirmDeleteBtn.textContent = 'حذف الآن';
                };
                
                // إضافة معالجات الأحداث
                confirmDeleteBtn.addEventListener('click', performDelete);
                cancelDeleteBtn.addEventListener('click', closeModal);
            };
        }
        
        // Setup reply button
        const sendBtn = document.getElementById('panelSendReply');
        const replyInput = document.getElementById('panelReplyText');
        if (sendBtn && replyInput) {
            sendBtn.onclick = async () => {
                const message = replyInput.value.trim();
                if (!message) return;
                
                try {
                    sendBtn.disabled = true;
                    sendBtn.textContent = 'جاري الإرسال...';
                    await addTicketReply(ticket.id, message);
                    replyInput.value = '';
                    await loadRepliesInPanel(ticket.id);
                } catch (err) {
                    alert('فشل إرسال الرد: ' + err.message);
                } finally {
                    sendBtn.disabled = false;
                    sendBtn.textContent = 'إرسال الرد';
                }
            };
        }
    }
    
    async function loadRepliesInPanel(ticketId) {
        const list = document.getElementById('panelRepliesList');
        if (!list) return;
        
        list.innerHTML = '<div style="text-align:center; padding:1rem; color: var(--color-text-secondary);">جاري تحميل الردود...</div>';
        
        try {
            const replies = await fetchTicketReplies(ticketId);
            if (replies.length === 0) {
                list.innerHTML = '<p style="text-align: center; color: var(--color-text-secondary); font-size: 0.85rem; padding: 1rem;">لا توجد ردود بعد</p>';
                return;
            }
            
            list.innerHTML = replies.map(r => `
                <div class="reply-item ${r.profiles?.role === 'admin' ? 'reply-admin' : 'reply-user'}" style="padding: 1rem; border-radius: 0.5rem; margin-bottom: 1rem; background: var(--color-muted); border-right: 4px solid ${r.profiles?.role === 'admin' ? 'var(--color-accent)' : 'var(--color-success)'};">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
                        <strong style="font-size: 0.9rem;">${escapeHtml(r.profiles?.full_name || 'مستخدم')}</strong>
                        <span style="font-size: 0.75rem; color: var(--color-text-secondary);">${new Date(r.created_at).toLocaleString('ar-EG')}</span>
                    </div>
                    <p style="margin: 0.5rem 0 0 0; line-height: 1.5; white-space: pre-wrap; word-break: break-word;">${escapeHtml(r.message)}</p>
                </div>
            `).join('');
        } catch (err) {
            list.innerHTML = '<p style="text-align: center; color: var(--color-text-secondary); font-size: 0.85rem; padding: 1rem;">فشل تحميل الردود</p>';
        }
    }

    async function loadReplies(ticketId) {
        const list = document.getElementById('detailRepliesList');
        if (!list) return;
        
        list.innerHTML = '<div style="text-align:center; padding:1rem; color: var(--color-text-secondary);">جاري تحميل الردود...</div>';
        
        try {
            const replies = await fetchTicketReplies(ticketId);
            if (replies.length === 0) {
                list.innerHTML = '<p style="text-align: center; color: var(--color-text-secondary); font-size: 0.85rem; padding: 1rem;">لا توجد ردود بعد</p>';
                return;
            }
            
            list.innerHTML = replies.map(r => `
                <div class="reply-item ${r.profiles?.role === 'admin' ? 'reply-admin' : 'reply-user'}" style="padding: 1rem; border-radius: 0.5rem; margin-bottom: 1rem; background: var(--color-muted); border-right: 4px solid ${r.profiles?.role === 'admin' ? 'var(--color-accent)' : 'var(--color-success)'};">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
                        <strong style="font-size: 0.9rem;">${escapeHtml(r.profiles?.full_name || 'مستخدم')}</strong>
                        <span style="font-size: 0.75rem; color: var(--color-text-secondary);">${new Date(r.created_at).toLocaleString('ar-EG')}</span>
                    </div>
                    <p style="margin: 0.5rem 0 0 0; line-height: 1.5; white-space: pre-wrap; word-break: break-word;">${escapeHtml(r.message)}</p>
                </div>
            `).join('');
        } catch (err) {
            list.innerHTML = '<p style="text-align: center; color: var(--color-text-secondary); font-size: 0.85rem; padding: 1rem;">فشل تحميل الردود</p>';
        }
    }

    // Create Ticket Form Handler
    const userCreateTicketForm = document.getElementById('userCreateTicketForm');
    if (userCreateTicketForm) {
        userCreateTicketForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const title = document.getElementById('userTicketTitle').value;
            const description = document.getElementById('userTicketDescription').value;
            const priority = document.getElementById('userTicketPriority').value;
            
            try {
                await createTicket({ title, description, priority });
                alert('تم إنشاء التذكرة بنجاح');
                userCreateTicketForm.reset();
                createTicketModal.classList.remove('active');
                await renderStats();
                await renderTickets();
            } catch (err) {
                alert('فشل إنشاء التذكرة: ' + err.message);
            }
        });
    }

    async function renderNotifications() {
        const container = document.getElementById('notificationsList');
        if (!container) return;
        
        try {
            const notifications = await fetchNotifications();
            if (!notifications.length) {
                container.innerHTML = '<p style="text-align: center; padding: 1rem; color: var(--color-text-secondary);">لا توجد إشعارات</p>';
                return;
            }
            
            container.innerHTML = notifications.map(n => `
                <div class="notification-item ${!n.is_read ? 'unread' : ''}" style="border-bottom: 1px solid var(--color-border); padding: 12px 16px; cursor: pointer; transition: background 0.2s;">
                    <div style="font-weight: 600; font-size: 0.9rem;">${escapeHtml(n.title)}</div>
                    <div style="font-size: 0.8rem; color: var(--color-text-secondary); margin-top: 0.2rem;">${escapeHtml(n.message)}</div>
                    <div style="font-size: 0.7rem; color: var(--color-text-secondary); margin-top: 0.4rem; opacity: 0.7;">${new Date(n.created_at).toLocaleString('ar-EG')}</div>
                </div>
            `).join('');
        } catch (err) {
            console.error('Error rendering notifications:', err);
        }
    }

    /* ================= INIT ================= */

    await Promise.all([renderStats(), renderTickets(), renderNotifications()]);

    // اشتراكات لحظية
    if (!isGuest) {
        console.log('[Customer Dashboard] Setting up realtime subscriptions for user:', user.id);
        subscribeToTickets(() => {
            console.log('[Customer Dashboard] Tickets callback triggered');
            // Run stats and tickets fetch in parallel
            Promise.all([renderStats(), renderTickets()]);
            if (currentTicketId) loadRepliesInPanel(currentTicketId);
        });
        subscribeToNotifications(user.id, (newNotification) => {
            console.log('[Customer Dashboard] Notification callback triggered:', newNotification);
            renderNotifications();
        });
    }

    // Logout
    const signOutLink = document.getElementById('signOutLink');
    if (signOutLink) {
        signOutLink.onclick = async (e) => {
            e.preventDefault();
            await logout();
            window.location.replace('login.html');
        };
    }

})();
