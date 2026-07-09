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
import { supabase } from './api-config.js';

/* =========================================================
   حماية من bfcache (Back-Forward Cache)
   =========================================================
   المشكلة: لو المستخدم سجّل خروج ثم ضغط زرار "رجوع" في المتصفح،
   بعض المتصفحات (خصوصاً Chrome/Safari) بترجّع "صورة مجمدة" من
   الصفحة القديمة من الذاكرة (bfcache) من غير ما تعيد تنفيذ كود
   الصفحة من البداية. النتيجة: الصفحة بتظهر وكأن المستخدم لسه
   مسجّل دخول، رغم إن الجلسة الحقيقية اتمسحت فعلاً من Supabase
   ومن localStorage.
   الحل: لو الصفحة رجعت من bfcache (event.persisted === true)
   نجبر المتصفح يعمل تحميل حقيقي جديد للصفحة، فيتنفذ كود
   requireAuth() تاني ويكتشف إنه مفيش جلسة ويحوّل المستخدم
   لصفحة تسجيل الدخول.
========================================================= */
window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
        window.location.reload();
    }
});

function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function sanitizeUrl(url) {
    if (!url) return '';
    const trimmed = String(url).trim();
    if (/^(https?:)?\/\//i.test(trimmed) || trimmed.startsWith('/') || trimmed.startsWith('./')) {
        return escapeHtml(trimmed);
    }
    return '';
}

/* ================= Labels & Badge Helpers (مشتركة بين القائمة ولوحة التفاصيل) ================= */

const STATUS_LABELS = { open: 'مفتوحة', 'in-progress': 'قيد المعالجة', resolved: 'تم الحل', confirmed: 'مؤكدة', rejected: 'مرفوضة' };
const PRIORITY_LABELS = { high: 'عالية', medium: 'متوسطة', low: 'منخفضة' };
const CATEGORY_LABELS = { whatsapp: 'واتساب', tickets: 'تذاكر', subscription: 'اشتراك', login: 'تسجيل دخول', other: 'أخرى' };
const CATEGORY_CLASS = { whatsapp: 'cat-whatsapp', tickets: 'cat-tickets', subscription: 'cat-subscription', login: 'cat-login', other: 'cat-other' };

function statusBadge(status) {
    return `<span class="pill status-${escapeHtml(status)}"><span class="pill-dot"></span>${escapeHtml(STATUS_LABELS[status] || status)}</span>`;
}

function priorityBadge(priority, { onlyHigh = false } = {}) {
    if (!priority) return '';
    if (onlyHigh && priority !== 'high') return '';
    return `<span class="pill priority-${escapeHtml(priority)}">${escapeHtml(PRIORITY_LABELS[priority] || priority)}</span>`;
}

function categoryBadge(category) {
    if (!category || !CATEGORY_LABELS[category]) return '';
    return `<span class="pill ${CATEGORY_CLASS[category]}">${escapeHtml(CATEGORY_LABELS[category])}</span>`;
}

/**
 * نص ودود يوضح للعميل توقع الرد، بدل مصطلحات SLA التقنية المستخدمة في لوحة الإدارة.
 * يُعرض فقط لو التذكرة لسه محتاجة أول رد ومفيش رد اتبعت لحد دلوقتي.
 */
function slaFriendlyHint(ticket) {
    if (ticket.first_response_at) return '';
    if (!['open', 'in-progress'].includes(ticket.status)) return '';
    if (!ticket.sla_response_due_at) return '';

    const due = new Date(ticket.sla_response_due_at);
    const now = new Date();
    const diffMs = due - now;
    const diffHours = Math.round(diffMs / 3600000);

    if (diffMs > 0) {
        const text = diffHours <= 1 ? 'متوقع الرد خلال أقل من ساعة' : `متوقع الرد خلال ${diffHours} ساعة تقريباً`;
        return `<div class="ticket-sla-hint sla-info"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>${text}</div>`;
    }
    return `<div class="ticket-sla-hint sla-warn"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>فريقنا يعمل على تذكرتك، شكراً لصبرك</div>`;
}

/** أيقونة/معاينة مناسبة للمرفق حسب نوعه */
function attachmentPreview(att) {
    const isImage = (att.mime_type || '').startsWith('image/');
    if (isImage) {
        return `<img src="${sanitizeUrl(att.file_url)}" alt="${escapeHtml(att.file_name || '')}" loading="lazy">`;
    }
    return `<span class="att-file-icon"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg></span>`;
}

function timeAgo(dateStr) {
    const diffMs = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'الآن';
    if (mins < 60) return `منذ ${mins} دقيقة`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `منذ ${hours} ساعة`;
    const days = Math.floor(hours / 24);
    return `منذ ${days} يوم`;
}

// نفس القيم الفعلية المخزّنة في عمود action_type بجدول ticket_activity (متوافقة مع admin/tickets.js)
const ACTIVITY_LABELS = {
    'create': 'تم إنشاء التذكرة',
    'status_change': 'تم تحديث حالة التذكرة',
    'priority_change': 'تم تحديث الأولوية',
    'category_change': 'تم تحديث تصنيف التذكرة',
    'reopen': 'تم إعادة فتح التذكرة',
    'reply': 'رد جديد',
    'tag_add': 'تمت إضافة وسم',
    'tag_remove': 'تمت إزالة وسم',
    'rating': 'تم إضافة تقييم'
};
// أنواع داخلية خاصة بفريق الدعم فقط، لا تُعرض للعميل (تعيين الموظفين والملاحظات الداخلية)
const CUSTOMER_HIDDEN_ACTIVITY_TYPES = new Set(['assignee_change', 'internal_note']);

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
            'userOpenTickets': stats.open,
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

    let currentFilters = { status: 'all', search: '' };

    async function renderTickets(filters = currentFilters) {
        const list = document.getElementById('userTicketsList');
        if (!list) return;

        const tickets = await fetchUserTickets(filters);

        if (!tickets.length) {
            list.innerHTML = `
                <div style="text-align: center; padding: 2.5rem 1rem; color: var(--color-text-secondary);">
                    <svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="margin: 0 auto 0.75rem; opacity: .5;"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/></svg>
                    <p style="font-weight: 600; color: var(--color-text);">${filters.status !== 'all' || filters.search ? 'لا توجد نتائج مطابقة' : 'لا توجد تذاكر حتى الآن'}</p>
                </div>`;
            return;
        }

        list.innerHTML = tickets.map(t => `
            <div class="ticket-card" data-id="${t.id}">
                <div class="ticket-card-top">
                    <span class="ticket-num">#${t.ticket_number || '---'}</span>
                    ${statusBadge(t.status)}
                </div>
                <h4 class="ticket-title">${escapeHtml(t.title)}</h4>
                <div class="ticket-badges-row">
                    ${priorityBadge(t.priority, { onlyHigh: true })}
                    ${categoryBadge(t.category)}
                </div>
                <div class="ticket-footer-row">
                    <span>${new Date(t.created_at).toLocaleDateString('ar-EG', {month: 'short', day: 'numeric'})}</span>
                </div>
                ${slaFriendlyHint(t)}
            </div>
        `).join('');

        // Add click handlers and show first ticket by default
        list.querySelectorAll('.ticket-card').forEach((card) => {
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

    // New function to show ticket details in the side panel
    async function showTicketInPanel(ticket) {
        currentTicketId = ticket.id;
        const panel = document.getElementById('ticketDetailsContent');
        if (!panel) return;

        panel.style.display = 'block';
        panel.style.alignItems = 'flex-start';
        panel.style.justifyContent = 'flex-start';

        // جلب البيانات الإضافية (مرفقات، وسوم، سجل نشاط، تقييم سابق إن وُجد) دفعة واحدة
        let attachments = [], tags = [], activity = [], existingRating = null;
        try {
            [attachments, tags, activity, existingRating] = await Promise.all([
                fetchTicketAttachments(ticket.id).catch(() => []),
                fetchTicketTags(ticket.id).catch(() => []),
                fetchTicketActivity(ticket.id).catch(() => []),
                ticket.status === 'resolved' ? fetchTicketRating(ticket.id).catch(() => null) : Promise.resolve(null)
            ]);
        } catch (err) {
            console.error('Error loading ticket extras:', err);
        }

        // توافقاً مع تذاكر قديمة كانت تخزن صورة واحدة فقط في image_url قبل إضافة جدول المرفقات
        const legacyImage = (ticket.image_url && !attachments.some(a => a.file_url === ticket.image_url))
            ? [{ file_url: ticket.image_url, file_name: 'مرفق', mime_type: 'image/*' }]
            : [];
        const allAttachments = [...attachments, ...legacyImage];

        panel.innerHTML = `
            <div style="width: 100%;">
                <!-- Header -->
                <div style="border-bottom: 2px solid var(--color-border); padding-bottom: 1rem; margin-bottom: 1.5rem;">
                    <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 0.75rem; gap: 1rem;">
                        <h2 style="margin: 0; font-size: 1.3rem; line-height: 1.4;">${escapeHtml(ticket.title)}</h2>
                        ${statusBadge(ticket.status)}
                    </div>
                    <div class="ticket-badges-row" style="margin-bottom: .6rem;">
                        ${priorityBadge(ticket.priority)}
                        ${categoryBadge(ticket.category)}
                        ${tags.map(t => `<span class="tag-chip" style="background:${t.color}22;color:${t.color}">${escapeHtml(t.name)}</span>`).join('')}
                    </div>
                    <div style="display: flex; gap: 1.5rem; font-size: 0.85rem; color: var(--color-text-secondary); flex-wrap: wrap;">
                        <span>رقم التذكرة: <strong>#${ticket.ticket_number || '---'}</strong></span>
                        <span>${new Date(ticket.created_at).toLocaleDateString('ar-EG')}</span>
                    </div>
                    ${slaFriendlyHint(ticket)}
                </div>
                
                <!-- Description -->
                <div style="margin-bottom: 1.5rem;">
                    <h3 style="font-size: 0.9rem; color: var(--color-text-secondary); margin-bottom: 0.5rem;">وصف المشكلة</h3>
                    <p style="line-height: 1.6; white-space: pre-wrap;">${escapeHtml(ticket.description)}</p>
                </div>

                ${allAttachments.length ? `
                <div style="margin-bottom: 1.5rem;">
                    <h3 style="font-size: 0.9rem; color: var(--color-text-secondary); margin-bottom: 0.5rem;">المرفقات (${allAttachments.length})</h3>
                    <div class="attachments-grid">
                        ${allAttachments.map(a => `
                            <a class="attachment-item" href="${sanitizeUrl(a.file_url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(a.file_name || '')}">
                                ${attachmentPreview(a)}
                                <span class="att-name">${escapeHtml(a.file_name || 'مرفق')}</span>
                            </a>
                        `).join('')}
                    </div>
                </div>
                ` : ''}

                <!-- Rating Widget (تظهر فقط بعد حل التذكرة) -->
                ${ticket.status === 'resolved' ? `
                <div class="rating-widget glass-card" style="padding: 1.1rem 1.25rem; margin-bottom: 1.5rem;">
                    <h3 style="font-size: 0.9rem; margin-bottom: 0.6rem;">تقييمك للخدمة</h3>
                    <div id="ratingContainer">
                        ${existingRating ? `
                            <div class="rating-submitted">
                                <span style="color:#F5A623;">${'★'.repeat(existingRating.rating)}${'☆'.repeat(5 - existingRating.rating)}</span>
                                <span>شكراً لتقييمك</span>
                            </div>
                            ${existingRating.comment ? `<p style="margin-top:.5rem; color: var(--color-text-secondary); font-size: .85rem; white-space: pre-wrap;">${escapeHtml(existingRating.comment)}</p>` : ''}
                        ` : `
                            <div class="star-rating" id="panelStarRating">
                                <span class="star" data-value="1">★</span>
                                <span class="star" data-value="2">★</span>
                                <span class="star" data-value="3">★</span>
                                <span class="star" data-value="4">★</span>
                                <span class="star" data-value="5">★</span>
                            </div>
                            <textarea id="panelRatingComment" placeholder="أضف تعليقاً (اختياري)..."></textarea>
                            <button id="panelSubmitRating" class="btn btn-primary" style="margin-top:.6rem;" disabled>إرسال التقييم</button>
                        `}
                    </div>
                </div>
                ` : ''}

                <!-- Activity Timeline -->
                ${activity.filter(a => !CUSTOMER_HIDDEN_ACTIVITY_TYPES.has(a.action_type)).length ? `
                <div style="margin-bottom: 1.5rem;">
                    <h3 style="font-size: 0.9rem; color: var(--color-text-secondary); margin-bottom: 0.5rem;">سجل التذكرة</h3>
                    <div class="activity-timeline">
                        ${activity.filter(a => !CUSTOMER_HIDDEN_ACTIVITY_TYPES.has(a.action_type)).slice(0, 8).map(a => `
                            <div class="activity-item">
                                <span class="activity-icon"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg></span>
                                <div>
                                    <div class="activity-text">${escapeHtml(ACTIVITY_LABELS[a.action_type] || a.action_type)}${a.action_type === 'status_change' && a.to_value ? ` — ${escapeHtml(STATUS_LABELS[a.to_value] || a.to_value)}` : ''}</div>
                                    <div class="activity-time">${timeAgo(a.created_at)}</div>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                </div>
                ` : ''}
                
                <!-- Replies Section -->
                <div style="border-top: 2px solid var(--color-border); padding-top: 1.5rem;">
                    <h3 style="font-size: 1rem; margin-bottom: 1rem;">الردود</h3>
                    <div id="panelRepliesList" style="max-height: 250px; overflow-y: auto; margin-bottom: 1rem; padding-left: 0.5rem;">
                        <div style="text-align:center; padding:1rem; color: var(--color-text-secondary);">جاري تحميل الردود...</div>
                    </div>
                    
                    <div>
                        <textarea id="panelReplyText" style="width: 100%; padding: 0.75rem; border-radius: 0.5rem; border: 1px solid var(--color-border); background: var(--input-bg); color: var(--color-text); font-family: inherit; min-height: 70px; resize: vertical;" placeholder="اكتب ردك هنا..."></textarea>
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

        // Setup rating widget (نجوم قابلة للاختيار + تعليق اختياري)
        const starRatingEl = document.getElementById('panelStarRating');
        const submitRatingBtn = document.getElementById('panelSubmitRating');
        if (starRatingEl && submitRatingBtn) {
            let selectedRating = 0;
            const stars = starRatingEl.querySelectorAll('.star');
            const paintStars = (value) => {
                stars.forEach(s => s.classList.toggle('active', Number(s.dataset.value) <= value));
            };
            stars.forEach(star => {
                star.addEventListener('mouseenter', () => paintStars(Number(star.dataset.value)));
                star.addEventListener('mouseleave', () => paintStars(selectedRating));
                star.addEventListener('click', () => {
                    selectedRating = Number(star.dataset.value);
                    paintStars(selectedRating);
                    submitRatingBtn.disabled = false;
                });
            });
            submitRatingBtn.onclick = async () => {
                if (!selectedRating) return;
                const comment = document.getElementById('panelRatingComment')?.value.trim() || '';
                try {
                    submitRatingBtn.disabled = true;
                    submitRatingBtn.textContent = 'جاري الإرسال...';
                    await submitTicketRating(ticket.id, selectedRating, comment);
                    const container = document.getElementById('ratingContainer');
                    if (container) {
                        container.innerHTML = `
                            <div class="rating-submitted">
                                <span style="color:#F5A623;">${'★'.repeat(selectedRating)}${'☆'.repeat(5 - selectedRating)}</span>
                                <span>شكراً لتقييمك</span>
                            </div>
                            ${comment ? `<p style="margin-top:.5rem; color: var(--color-text-secondary); font-size: .85rem; white-space: pre-wrap;">${escapeHtml(comment)}</p>` : ''}
                        `;
                    }
                } catch (err) {
                    alert('فشل إرسال التقييم: ' + (err.message || 'حدث خطأ غير متوقع'));
                    submitRatingBtn.disabled = false;
                    submitRatingBtn.textContent = 'إرسال التقييم';
                }
            };
        }
        
        // Setup WhatsApp follow-up button
        const whatsappBtn = document.getElementById('followUpWhatsApp');
        if (whatsappBtn) {
            whatsappBtn.onclick = async () => {
                try {
                    // تجميع تفاصيل التذكرة
                    const ticketDetails = `
*تفاصيل التذكرة #${ticket.ticket_number}*

*العنوان:* ${ticket.title}
*الحالة:* ${STATUS_LABELS[ticket.status] || ticket.status}
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
        // ملاحظة: "الحذف" هنا من منظور العميل هو أرشفة (إخفاء من لوحته فقط).
        // التذكرة وسجل ردودها يبقيان محفوظين بالكامل ومتاحين للأدمن دائماً.
        const deleteBtn = document.getElementById('deleteTicket');
        if (deleteBtn) {
            deleteBtn.onclick = async () => {
                // الحصول على عناصر النافذة المنبثقة
                const deleteModal = document.getElementById('deleteConfirmModal');
                const deleteConfirmText = document.getElementById('deleteConfirmText');
                const confirmDeleteBtn = document.getElementById('confirmDeleteBtn');
                const cancelDeleteBtn = document.getElementById('cancelDeleteBtn');
                
                if (!deleteModal) return;
                
                // تحديث نص التأكيد برقم التذكرة (يوضح أنها إخفاء من لوحة العميل لا حذف نهائي)
                deleteConfirmText.textContent = `هل أنت متأكد من رغبتك في حذف التذكرة #${ticket.ticket_number} من لوحتك؟ ستبقى التذكرة محفوظة لدى فريق الدعم، ولن تظهر بعد الآن في قائمة تذاكرك.`;
                
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
                        
                        // أرشفة التذكرة (إخفاؤها من لوحة العميل فقط)
                        await deleteTicket(ticket.id);
                        
                        // إعادة تحميل قائمة التذاكر
                        await renderStats();
                        await renderTickets();
                        
                        // إغلاق النافذة
                        deleteModal.classList.remove('active');
                        
                        // إظهار رسالة نجاح
                        alert('تم حذف التذكرة من قائمتك بنجاح');
                        
                        // مسح لوحة التفاصيل
                        if (panel) {
                            panel.innerHTML = `
                                <div style="text-align: center; padding: 2rem; color: var(--color-text-secondary);">
                                    <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="margin: 0 auto 1rem; opacity: .5;">
                                        <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/>
                                    </svg>
                                    <p style="font-size: 1.1rem; font-weight: 600; color: var(--color-text);">اختر تذكرة لعرض التفاصيل</p>
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

    // Tickets search & filter toolbar
    const ticketFilterStatus = document.getElementById('ticketFilterStatus');
    const ticketSearchInput = document.getElementById('ticketSearchInput');
    let searchDebounce = null;

    if (ticketFilterStatus) {
        ticketFilterStatus.addEventListener('change', () => {
            currentFilters = { ...currentFilters, status: ticketFilterStatus.value };
            renderTickets(currentFilters);
        });
    }
    if (ticketSearchInput) {
        ticketSearchInput.addEventListener('input', () => {
            clearTimeout(searchDebounce);
            searchDebounce = setTimeout(() => {
                currentFilters = { ...currentFilters, search: ticketSearchInput.value.trim() };
                renderTickets(currentFilters);
            }, 350);
        });
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

    /* ================= BADGES LOGIC ================= */

    async function renderBadges() {
        const grid = document.getElementById('badgesGrid');
        const summaryEl = document.getElementById('badgesProgressSummary');
        if (!grid) return;

        if (isGuest) {
            grid.innerHTML = '<p class="empty-state">سجّل الدخول لتتمكن من جمع الشارات ومتابعة إنجازاتك.</p>';
            if (summaryEl) summaryEl.textContent = '';
            return;
        }

        try {
            // نطلب من السيرفر تقييم شارات المستخدم فورًا (بأمان، تعمل فقط على نفس المستخدم المسجّل دخوله)
            // بحيث لو استحق شارة جديدة بس السيرفر لسه ما فعّلهاش (مثال: عميل مخلص بعد مرور شهر)، تتفعل فورًا هنا.
            await supabase.rpc('evaluate_customer_badges', { p_user_id: user.id });
        } catch (err) {
            console.warn('[Badges] evaluate_customer_badges failed (non-blocking):', err?.message || err);
        }

        try {
            const [{ data: definitions, error: defError }, { data: earned, error: earnedError }] = await Promise.all([
                supabase
                    .from('badge_definitions')
                    .select('id, key, name, description, icon, sort_order')
                    .eq('is_active', true)
                    .order('sort_order', { ascending: true }),
                supabase
                    .from('customer_badges')
                    .select('badge_id, earned_at')
                    .eq('user_id', user.id)
            ]);

            if (defError) throw defError;
            if (earnedError) throw earnedError;

            const earnedMap = new Map((earned || []).map(e => [e.badge_id, e.earned_at]));

            if (!definitions || !definitions.length) {
                grid.innerHTML = '<p class="empty-state">لا توجد شارات متاحة حاليًا.</p>';
                if (summaryEl) summaryEl.textContent = '';
                return;
            }

            if (summaryEl) {
                summaryEl.textContent = `حصلت على ${earnedMap.size} من ${definitions.length} شارة`;
            }

            grid.innerHTML = definitions.map(badge => {
                const earnedAt = earnedMap.get(badge.id);
                const isEarned = !!earnedAt;
                const dateLabel = isEarned
                    ? new Date(earnedAt).toLocaleDateString('ar-EG', { year: 'numeric', month: 'long', day: 'numeric' })
                    : '';

                return `
                    <div class="badge-card glass-card ${isEarned ? 'earned' : 'locked'}" data-badge-key="${escapeHtml(badge.key)}" title="${isEarned ? 'شارة مكتسبة' : 'شارة غير مكتسبة بعد'}">
                        ${!isEarned ? '<span class="badge-locked-tag">🔒</span>' : ''}
                        <div class="badge-icon">${escapeHtml(badge.icon || '🏆')}</div>
                        <h3>${escapeHtml(badge.name)}</h3>
                        <p>${escapeHtml(badge.description)}</p>
                        ${isEarned ? `<div class="badge-earned-date">✓ حصلت عليها في ${dateLabel}</div>` : ''}
                    </div>
                `;
            }).join('');
        } catch (err) {
            console.error('[Badges] Error loading badges:', err);
            grid.innerHTML = '<p class="empty-state">حدث خطأ أثناء تحميل الشارات، حاول تحديث الصفحة.</p>';
        }
    }

    // تحميل الشارات عند فتح تبويب "الشارات" لأول مرة (Lazy Load)
    let badgesLoadedOnce = false;
    const badgesTabEl = document.querySelector('.nav-tab[data-tab="badges"]');
    if (badgesTabEl) {
        badgesTabEl.addEventListener('click', () => {
            if (!badgesLoadedOnce) {
                badgesLoadedOnce = true;
                renderBadges();
            }
        });
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
            if (badgesLoadedOnce) renderBadges();
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
            // مهم: نستخدم try/finally هنا. لو حصل أي خطأ أو استثناء جوه
            // logout() لأي سبب، لازم إعادة التوجيه لصفحة تسجيل الدخول
            // تحصل برضه، عشان المستخدم ميفضلش عالق في الداشبورد وكأنه
            // "رجع اتسجل دخول لوحده".
            try {
                await logout();
            } catch (err) {
                console.error('Logout error (proceeding to redirect anyway):', err);
            } finally {
                window.location.replace('login.html');
            }
        };
    }

})();
