// customer-dashboard.js
import { requireAuth, logout, updateProfile, updatePassword } from './auth-client.js';
import { initCustomerSidebar } from './assets/js/customer-sidebar.js';
import { initRewardsDashboard } from './rewards-dashboard.js';
import { initCustomerSettingsModal, openSettingsModal } from './customer-settings-modal.js';
import {
    fetchUserTickets,
    createTicket,
    fetchTicketStats,
    fetchTicketReplies,
    addTicketReply,
    subscribeToTickets
} from './tickets-service.js';
import {
    fetchNotifications,
    markAllAsRead,
    subscribeToNotifications
} from './notifications-service.js';
import { ui } from './ui-service.js';

(async function () {

    /* ================= AUTH ================= */

    const user = await requireAuth('customer');
    if (!user) {
        window.location.replace('sign-in.html');
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

    // Initialize Sidebar
    initCustomerSidebar((tabName) => {
        const tabEl = document.querySelector(`.nav-tab[data-tab="${tabName}"]`);
        if (tabEl) tabEl.click();
    });

    // Initialize Settings Modal
    if (!isGuest) {
        initCustomerSettingsModal();
        
        // Setup settings button click handlers
        setTimeout(() => {
            const customerAccountSettings = document.getElementById('customerAccountSettings');
            if (customerAccountSettings) {
                customerAccountSettings.addEventListener('click', (e) => {
                    e.preventDefault();
                    openSettingsModal();
                    const customerAvatarMenu = document.getElementById('customerAvatarMenu');
                    if (customerAvatarMenu) customerAvatarMenu.style.display = 'none';
                });
            }
        }, 500);
    }

    // Initialize Rewards Dashboard
    if (!isGuest) {
        initRewardsDashboard(user);
    }

    // Update Sidebar User Info
    const updateSidebarUserInfo = () => {
        const customerInitial = document.getElementById('customerInitial');
        if (customerInitial) {
            customerInitial.textContent = (user.profile?.full_name || user.email || 'U')[0].toUpperCase();
        }
    };
    setTimeout(updateSidebarUserInfo, 500);

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
                <h4 style="margin: 0 0 0.5rem 0; font-size: 0.95rem; line-height: 1.3; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;">${t.title}</h4>
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
                        <h2 style="margin: 0; font-size: 1.3rem; line-height: 1.4;">${ticket.title}</h2>
                        <span class="status-badge status-${ticket.status}" style="padding: 0.3rem 0.75rem; border-radius: 0.5rem; font-size: 0.8rem; white-space: nowrap;">${statusLabels[ticket.status]}</span>
                    </div>
                    <div style="display: flex; gap: 1.5rem; font-size: 0.85rem; color: var(--color-text-secondary);">
                        <span>رقم التذكرة: <strong>#${ticket.ticket_number || '---'}</strong></span>
                        <span>الأولوية: <strong style="color: var(--color-accent);">${priorityLabels[ticket.priority]}</strong></span>
                        <span>${new Date(ticket.created_at).toLocaleDateString('ar-EG')}</span>
                    </div>
                </div>
                
                <!-- Description -->
                <div style="margin-bottom: 1.5rem;">
                    <h3 style="font-size: 0.9rem; color: var(--color-text-secondary); margin-bottom: 0.5rem;">وصف المشكلة</h3>
                    <p style="line-height: 1.6; white-space: pre-wrap;">${ticket.description}</p>
                </div>
                
                ${ticket.image_url ? `
                <div style="margin-bottom: 1.5rem;">
                    <h3 style="font-size: 0.9rem; color: var(--color-text-secondary); margin-bottom: 0.5rem;">المرفقات</h3>
                    <img src="${ticket.image_url}" style="max-width: 100%; border-radius: 0.5rem; border: 1px solid var(--color-border);">
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
            </div>
        `;
        
        // Load replies
        await loadRepliesInPanel(ticket.id);
        
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
                <div class="reply-item ${r.profiles?.role === 'admin' ? 'reply-admin' : 'reply-user'}" style="margin-bottom: 0.75rem; padding: 0.75rem; border-radius: 0.5rem; background: var(--color-surface); border: 1px solid var(--color-border);">
                    <div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem; font-size: 0.75rem;">
                        <strong style="color: var(--color-accent);">${r.profiles?.role === 'admin' ? 'الدعم الفني' : (r.profiles?.full_name || 'أنت')}</strong>
                        <span style="color: var(--color-text-secondary);">${new Date(r.created_at).toLocaleString('ar-EG', {hour:'2-digit', minute:'2-digit', day: 'numeric', month: 'short'})}</span>
                    </div>
                    <div style="font-size: 0.85rem; line-height: 1.5;">${r.message}</div>
                </div>
            `).join('');
            list.scrollTop = list.scrollHeight;
        } catch (err) {
            list.innerHTML = '<p style="text-align:center; color:red;">فشل تحميل الردود</p>';
        }
    }

    async function loadReplies(ticketId) {
        const list = document.getElementById('detailRepliesList');
        if (!list) return;

        list.innerHTML = '<div style="text-align:center; padding:1rem; color:#999;">جاري تحميل الردود...</div>';
        
        try {
            const replies = await fetchTicketReplies(ticketId);
            if (replies.length === 0) {
                list.innerHTML = '<p style="text-align: center; color: var(--color-text-secondary); font-size: 0.85rem; padding: 1rem;">لا توجد ردود بعد</p>';
                return;
            }

            list.innerHTML = replies.map(r => `
                <div class="reply-item ${r.profiles?.role === 'admin' ? 'reply-admin' : 'reply-user'}" style="margin-bottom: 1rem; padding: 0.75rem; border-radius: 0.5rem; background: var(--color-surface); border: 1px solid var(--color-border);">
                    <div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem; font-size: 0.75rem;">
                        <strong style="color: var(--color-accent);">${r.profiles?.role === 'admin' ? 'الدعم الفني' : (r.profiles?.full_name || 'أنت')}</strong>
                        <span style="color: var(--color-text-secondary);">${new Date(r.created_at).toLocaleString('ar-EG', {hour:'2-digit', minute:'2-digit'})}</span>
                    </div>
                    <div style="font-size: 0.85rem; line-height: 1.5;">${r.message}</div>
                </div>
            `).join('');
            list.scrollTop = list.scrollHeight;
        } catch (err) {
            list.innerHTML = '<p style="text-align:center; color:red;">فشل تحميل الردود</p>';
        }
    }

    // Send Reply
    const sendReplyBtn = document.getElementById('sendDetailReply');
    if (sendReplyBtn) {
        sendReplyBtn.onclick = async () => {
            const msgInput = document.getElementById('detailReplyText');
            const message = msgInput?.value.trim();
            if (!message || !currentTicketId) return;

            try {
                sendReplyBtn.disabled = true;
                sendReplyBtn.textContent = 'جاري الإرسال...';
                await addTicketReply(currentTicketId, message);
                msgInput.value = '';
                await loadReplies(currentTicketId);
                ui.showToast('تم إرسال الرد بنجاح', 'success');
            } catch (err) {
                ui.showAlert('خطأ في الإرسال', err.message, 'error');
            } finally {
                sendReplyBtn.disabled = false;
                sendReplyBtn.textContent = 'إرسال الرد';
            }
        };
    }

    // Handle reply form submission (for the second modal structure)
    const detailReplyForm = document.getElementById('detailReplyForm');
    if (detailReplyForm) {
        detailReplyForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const msgInput = document.getElementById('detailReplyMessage');
            const message = msgInput?.value.trim();
            if (!message || !currentTicketId) return;

            try {
                const submitBtn = detailReplyForm.querySelector('button[type="submit"]');
                if (submitBtn) {
                    submitBtn.disabled = true;
                    submitBtn.textContent = 'جاري الإرسال...';
                }
                await addTicketReply(currentTicketId, message);
                msgInput.value = '';
                await loadReplies(currentTicketId);
                ui.showToast('تم إرسال الرد بنجاح', 'success');
            } catch (err) {
                ui.showAlert('خطأ في الإرسال', err.message, 'error');
            } finally {
                const submitBtn = detailReplyForm.querySelector('button[type="submit"]');
                if (submitBtn) {
                    submitBtn.disabled = false;
                    submitBtn.textContent = 'إرسال الرد';
                }
            }
        });
    }

    // Create Ticket Form
    const createTicketForm = document.getElementById('userCreateTicketForm');
    if (createTicketForm) {
        createTicketForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const title = document.getElementById('userTicketTitle')?.value;
            const description = document.getElementById('userTicketDescription')?.value;
            const priority = document.getElementById('userTicketPriority')?.value;

            try {
                const submitBtn = createTicketForm.querySelector('button[type="submit"]');
                submitBtn.disabled = true;
                submitBtn.textContent = 'جاري الإنشاء...';
                
                await createTicket({ title, description, priority });
                createTicketForm.reset();
                document.getElementById('createTicketModal')?.classList.remove('active');
                await renderStats();
                await renderTickets();
                ui.showAlert('تم بنجاح', 'تم إنشاء التذكرة بنجاح، سيقوم فريقنا بالرد عليك في أقرب وقت.', 'success');
            } catch (err) {
                ui.showAlert('خطأ في إنشاء التذكرة', err.message, 'error');
            } finally {
                const submitBtn = createTicketForm.querySelector('button[type="submit"]');
                submitBtn.disabled = false;
                submitBtn.textContent = 'إرسال التذكرة';
            }
        });
    }

    /* ================= NOTIFICATIONS ================= */

    async function renderNotifications() {
        const list = document.getElementById('notificationsList');
        const badge = document.getElementById('notificationBadge');
        if (!list) return;

        const notifications = await fetchNotifications();
        const unreadCount = notifications.filter(n => !n.is_read).length;

        if (badge) {
            badge.textContent = unreadCount;
            badge.style.display = unreadCount > 0 ? 'flex' : 'none';
        }

        if (notifications.length === 0) {
            list.innerHTML = '<p style="padding: 1rem; text-align: center; font-size: 0.8rem; color: var(--color-text-secondary);">لا توجد إشعارات</p>';
            return;
        }

        list.innerHTML = notifications.map(n => `
            <div class="notification-item ${n.is_read ? '' : 'unread'}" style="padding: 0.75rem; border-bottom: 1px solid var(--color-border); cursor: pointer; ${n.is_read ? '' : 'background: var(--hover-bg);'}">
                <div style="font-weight: 700; font-size: 0.85rem;">${n.title}</div>
                <div style="font-size: 0.8rem; color: var(--color-text-secondary); margin-top: 0.2rem;">${n.message}</div>
                <div style="font-size: 0.7rem; color: var(--color-text-secondary); margin-top: 0.4rem; opacity: 0.7;">${new Date(n.created_at).toLocaleString('ar-EG')}</div>
            </div>
        `).join('');
    }

    /* ================= INIT ================= */

    await renderStats();
    await renderTickets();
    await renderNotifications();

    // اشتراكات لحظية
    if (!isGuest) {
        console.log('[Customer Dashboard] Setting up realtime subscriptions for user:', user.id);
        subscribeToTickets(() => {
            console.log('[Customer Dashboard] Tickets callback triggered');
            renderStats();
            renderTickets();
            if (currentTicketId) loadReplies(currentTicketId);
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
            window.location.replace('sign-in.html');
        };
    }

})();
