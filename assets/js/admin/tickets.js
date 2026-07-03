import { supabase } from '/api-config.js';
import { checkAdminAuth, updateAdminUI } from './auth.js';
import { initSidebar } from './sidebar.js';
import { subscribeToTickets, subscribeToTicketReplies, updateTicketStatus, updateTicketPriority, addTicketReply, fetchTicketReplies, closeTicketWithComment } from '/tickets-service.js';
import { adminImpersonateUser } from '/auth-client.js';
import { confirmPurchaseTicket, rejectPurchaseTicket, PLAN_LABELS, BILLING_LABELS } from '/whatsapp-subscription-service.js';

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

const STATUS_MAP = {
    'open': 'مفتوحة',
    'in-progress': 'قيد المعالجة',
    'resolved': 'محلولة',
    'confirmed': 'مؤكدة',
    'rejected': 'مرفوضة'
};

const PRIORITY_MAP = {
    'high': { label: 'عالية', class: 'priority-high' },
    'medium': { label: 'متوسطة', class: 'priority-medium' },
    'low': { label: 'منخفضة', class: 'priority-low' }
};

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
    // ملاحظة: جدول tickets فيه أكتر من foreign key بيربطه بجدول profiles
    // (tickets_user_profile_fk عبر user_id، وtickets_assigned_to_fkey عبر
    // assigned_to)، فلازم نحدد صراحة أي علاقة نقصدها وإلا PostgREST هيرفض
    // الطلب بالكامل (PGRST201: "more than one relationship was found")
    // وده كان بيمنع ظهور أي تذاكر خالص في لوحة الأدمن. هنا إحنا عايزين
    // بيانات صاحب التذكرة (العميل)، فنستخدم tickets_user_profile_fk.
    const { data: tickets, error } = await supabase
        .from('tickets')
        .select('*, profiles!tickets_user_profile_fk(full_name, email)')
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

    // تحديث إحصائيات الشراء إذا كانت موجودة في الصفحة
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

    grid.innerHTML = tickets.map(t => {
        const userName = escapeHtml(t.profiles?.full_name || 'مستخدم');
        const userInitial = userName[0].toUpperCase();
        const priority = PRIORITY_MAP[t.priority] || PRIORITY_MAP['low'];

        return `
            <div class="ticket-card" data-id="${escapeHtml(t.id)}">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
                    <span style="color: var(--color-text-secondary); font-size: 0.8rem; font-weight: 700;">#${escapeHtml(t.ticket_number || '---')}</span>
                    <span class="status-badge status-${escapeHtml(t.status)}" style="padding: 0.2rem 0.5rem; border-radius: 0.5rem; font-size: 0.7rem;">${escapeHtml(STATUS_MAP[t.status] || t.status)}</span>
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
    document.querySelectorAll('.ticket-card').forEach((card) => {
        card.addEventListener('click', () => {
            document.querySelectorAll('.ticket-card').forEach(c => c.classList.remove('selected'));
            card.classList.add('selected');
            showAdminTicketInPanel(card.dataset.id);
        });
    });

    // Auto-select the previously selected ticket if still present, otherwise the first one
    const toSelectId = (currentTicketId && tickets.some(t => t.id === currentTicketId)) ? currentTicketId : (tickets[0] && tickets[0].id);
    if (toSelectId) {
        const cardToSelect = grid.querySelector(`.ticket-card[data-id="${CSS.escape(toSelectId)}"]`);
        if (cardToSelect) {
            cardToSelect.classList.add('selected');
        }
        showAdminTicketInPanel(toSelectId);
    }
}

/* ==================== Panel: Details + Actions (الواجهة الفعلية المستخدمة) ==================== */

async function showAdminTicketInPanel(ticketId) {
    currentTicketId = ticketId;
    const panel = document.getElementById('adminTicketDetailsContent');
    if (!panel) return;

    // جلب بيانات التذكرة (نفس ملاحظة تحديد الـ FK الصريح، انظر loadTickets)
    const { data: ticket, error } = await supabase
        .from('tickets')
        .select('*, profiles!tickets_user_profile_fk(full_name, email, id)')
        .eq('id', ticketId)
        .single();

    if (error || !ticket) {
        panel.innerHTML = '<p style="text-align:center; color:red;">خطأ في جلب بيانات التذكرة</p>';
        return;
    }

    // التحقق هل هذه تذكرة طلب اشتراك (مرتبطة بجدول whatsapp_subscriptions) عبر ticket_id،
    // بدلاً من الاعتماد على مطابقة نصية لعنوان التذكرة (أدق وأكثر ثباتاً).
    const { data: subscription } = await supabase
        .from('whatsapp_subscriptions')
        .select('*')
        .eq('ticket_id', ticket.id)
        .maybeSingle();

    panel.style.display = 'block';
    panel.style.alignItems = 'flex-start';
    panel.style.justifyContent = 'flex-start';

    panel.innerHTML = `
        <div style="width: 100%;">
            <!-- Header -->
            <div style="border-bottom: 2px solid var(--color-border); padding-bottom: 1rem; margin-bottom: 1.5rem;">
                <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 0.75rem;">
                    <h2 style="margin: 0; font-size: 1.3rem; line-height: 1.4;">${escapeHtml(ticket.title)}</h2>
                    <span class="status-badge status-${escapeHtml(ticket.status)}" style="padding: 0.3rem 0.75rem; border-radius: 0.5rem; font-size: 0.8rem; white-space: nowrap;">${escapeHtml(STATUS_MAP[ticket.status] || ticket.status)}</span>
                </div>
                <div style="display: flex; gap: 1.5rem; font-size: 0.85rem; color: var(--color-text-secondary); flex-wrap: wrap;">
                    <span>رقم التذكرة: <strong>#${escapeHtml(ticket.ticket_number || '---')}</strong></span>
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

            <!-- Priority Control (الإدارة فقط هي من تحدد الأولوية) -->
            <div style="margin-bottom: 1rem; padding: 1rem; background: var(--color-muted); border-radius: 0.75rem;">
                <label style="display: block; font-size: 0.9rem; font-weight: 700; margin-bottom: 0.5rem;">أولوية التذكرة</label>
                <select id="panelPrioritySelect" style="width: 100%; padding: 0.75rem; border-radius: 0.5rem; border: 1px solid var(--color-border); background: var(--color-surface); color: var(--color-text); font-weight: 600;">
                    <option value="low" ${ticket.priority === 'low' ? 'selected' : ''}>منخفضة</option>
                    <option value="medium" ${ticket.priority === 'medium' ? 'selected' : ''}>متوسطة</option>
                    <option value="high" ${ticket.priority === 'high' ? 'selected' : ''}>عالية</option>
                </select>
            </div>

            <!-- Status / Purchase Actions -->
            <div id="panelActionsContainer" style="margin-bottom: 1.5rem;"></div>

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

    // بناء منطقة الإجراءات (تأكيد/رفض لتذاكر الاشتراك، أو تغيير الحالة للتذاكر العادية)
    renderPanelActions(ticket, subscription);

    // Load replies
    await loadAdminRepliesInPanel(ticket.id);

    // Setup priority change
    const prioritySelect = document.getElementById('panelPrioritySelect');
    if (prioritySelect) {
        prioritySelect.addEventListener('change', async () => {
            const previousValue = ticket.priority;
            try {
                await updateTicketPriority(ticket.id, prioritySelect.value);
                await loadTickets();
            } catch (err) {
                alert('فشل تغيير الأولوية: ' + err.message);
                prioritySelect.value = previousValue;
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

/**
 * يبني منطقة الإجراءات أسفل بيانات التذكرة:
 * - لو التذكرة مرتبطة باشتراك pending: زرار "تأكيد" و"رفض"
 * - لو الاشتراك اتأكد/اترفض بالفعل: badge يوضح الحالة فقط
 * - لو مش تذكرة اشتراك أصلاً: قائمة تغيير الحالة العادية (مفتوحة/قيد المعالجة/محلولة)
 */
function renderPanelActions(ticket, subscription) {
    const container = document.getElementById('panelActionsContainer');
    if (!container) return;

    if (subscription) {
        const planLabel = PLAN_LABELS[subscription.plan] || subscription.plan;
        const billingLabel = BILLING_LABELS[subscription.billing_cycle] || subscription.billing_cycle;

        if (subscription.status === 'pending') {
            container.innerHTML = `
                <div style="padding: 1rem; background: var(--color-muted); border-radius: 0.75rem;">
                    <div style="font-size: 0.85rem; color: var(--color-text-secondary); margin-bottom: 0.75rem;">
                        طلب اشتراك: <strong style="color: var(--color-text);">${escapeHtml(planLabel)}</strong> (${escapeHtml(billingLabel)})
                    </div>
                    <div style="display: flex; gap: 0.75rem;">
                        <button id="panelConfirmPurchaseBtn" class="btn" style="flex:1; background:#2E8A3A; color:#fff; border:none; padding:0.75rem; border-radius:0.5rem; font-weight:700; cursor:pointer;">✓ تأكيد الاشتراك</button>
                        <button id="panelRejectPurchaseBtn" class="btn" style="flex:1; background:#D9534F; color:#fff; border:none; padding:0.75rem; border-radius:0.5rem; font-weight:700; cursor:pointer;">✗ رفض الاشتراك</button>
                    </div>
                </div>
            `;

            document.getElementById('panelConfirmPurchaseBtn').onclick = () => showConfirmPurchaseModal();
            document.getElementById('panelRejectPurchaseBtn').onclick = () => showRejectPurchaseModal();
        } else if (subscription.status === 'active') {
            container.innerHTML = `
                <div style="padding: 1rem; background: var(--color-muted); border-radius: 0.75rem; color: #2E8A3A; font-weight: 700;">
                    ✓ تم تأكيد الاشتراك (${escapeHtml(planLabel)} - ${escapeHtml(billingLabel)})
                </div>
            `;
        } else if (subscription.status === 'rejected') {
            container.innerHTML = `
                <div style="padding: 1rem; background: var(--color-muted); border-radius: 0.75rem; color: #D9534F; font-weight: 700;">
                    ✗ تم رفض هذا الاشتراك
                    ${subscription.rejection_reason ? `<div style="margin-top:0.5rem; font-weight:400; font-size:0.85rem; color: var(--color-text-secondary);">السبب: ${escapeHtml(subscription.rejection_reason)}</div>` : ''}
                </div>
            `;
        } else {
            container.innerHTML = `
                <div style="padding: 1rem; background: var(--color-muted); border-radius: 0.75rem; color: var(--color-text-secondary);">
                    حالة الاشتراك: ${escapeHtml(subscription.status)}
                </div>
            `;
        }
        return;
    }

    // تذكرة دعم عادية (ليست طلب اشتراك): قائمة تغيير الحالة كالمعتاد
    container.innerHTML = `
        <label style="display: block; font-size: 0.9rem; font-weight: 700; margin-bottom: 0.5rem;">تغيير حالة التذكرة</label>
        <select id="panelStatusSelect" style="width: 100%; padding: 0.75rem; border-radius: 0.5rem; border: 1px solid var(--color-border); background: var(--color-muted); color: var(--color-text); font-weight: 600;">
            <option value="open" ${ticket.status === 'open' ? 'selected' : ''}>مفتوحة</option>
            <option value="in-progress" ${ticket.status === 'in-progress' ? 'selected' : ''}>قيد المعالجة</option>
            <option value="resolved" ${ticket.status === 'resolved' ? 'selected' : ''}>محلولة</option>
        </select>
    `;

    const statusSelect = document.getElementById('panelStatusSelect');
    if (statusSelect) {
        statusSelect.addEventListener('change', async () => {
            const previousValue = ticket.status;
            try {
                await updateTicketStatus(ticket.id, statusSelect.value);
                await loadTickets();
            } catch (err) {
                alert('فشل تغيير الحالة: ' + err.message);
                statusSelect.value = previousValue;
            }
        });
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

/* ==================== Legacy modal (ticketModal) — kept for pages that still open it ==================== */

async function openTicketModal(ticketId) {
    currentTicketId = ticketId;
    const modal = document.getElementById('ticketModal');
    if (!modal) return;

    // نفس ملاحظة تحديد الـ FK الصريح (انظر loadTickets)
    const { data: ticket, error } = await supabase
        .from('tickets')
        .select('*, profiles!tickets_user_profile_fk(full_name, email)')
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

    const statusEl = document.getElementById('modalTicketStatus');
    statusEl.innerText = STATUS_MAP[ticket.status] || ticket.status;
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
    if (!container) return;
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
        if (document.getElementById('ticketModal')?.style.display === 'block') {
            openTicketModal(currentTicketId);
        }
        await loadTickets();
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
        if (document.getElementById('ticketModal')?.style.display === 'block') {
            openTicketModal(currentTicketId);
        }
        await loadTickets();
    } catch (err) {
        alert('فشل إغلاق التذكرة: ' + err.message);
    }
}

/* ==================== Modal events (ticketModal + confirm/reject purchase modals) ====================
   ملاحظة: كانت هذه الدالة فيها خطأ - كود ربط أزرار تأكيد/رفض الشراء كان
   محقون جوه closeBtn.onclick بالغلط، يعني ما كانش بيتنفذ إلا لما حد يقفل
   المودال القديم (اللي أصلاً مش بيتفتح من أي مكان في الواجهة الحالية).
   اتصلحت هنا بحيث كل زرار بياخد الـ handler بتاعه فوراً عند استدعاء
   setupModalEvents(). */
function setupModalEvents() {
    const modal = document.getElementById('ticketModal');
    const closeBtn = document.getElementById('closeModal');

    if (modal && closeBtn) {
        closeBtn.onclick = () => {
            modal.style.display = 'none';
            if (repliesSubscription) {
                repliesSubscription.unsubscribe();
            }
        };

        window.addEventListener('click', (event) => {
            if (event.target === modal) {
                modal.style.display = 'none';
                if (repliesSubscription) {
                    repliesSubscription.unsubscribe();
                }
            }
        });
    }

    // Confirm Purchase Modal
    const confirmPurchaseModal = document.getElementById('confirmPurchaseModal');
    if (confirmPurchaseModal) {
        const confirmBtn = document.getElementById('confirmPurchaseConfirmBtn');
        const cancelBtn = document.getElementById('confirmPurchaseCancelBtn');

        if (confirmBtn) {
            confirmBtn.onclick = async () => {
                try {
                    confirmBtn.disabled = true;
                    confirmBtn.textContent = 'جاري التأكيد...';
                    await confirmPurchaseTicket(currentTicketId);
                    confirmPurchaseModal.style.display = 'none';
                    await loadTickets();
                    await showAdminTicketInPanel(currentTicketId);
                    alert('تم تأكيد الاشتراك بنجاح!');
                } catch (err) {
                    alert('فشل تأكيد الاشتراك: ' + err.message);
                } finally {
                    confirmBtn.disabled = false;
                    confirmBtn.textContent = 'تأكيد';
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
                    rejectBtn.disabled = true;
                    rejectBtn.textContent = 'جاري الرفض...';
                    const reason = document.getElementById('rejectReason').value.trim();
                    await rejectPurchaseTicket(currentTicketId, reason);
                    rejectPurchaseModal.style.display = 'none';
                    document.getElementById('rejectReason').value = '';
                    await loadTickets();
                    await showAdminTicketInPanel(currentTicketId);
                    alert('تم رفض الاشتراك.');
                } catch (err) {
                    alert('فشل رفض الاشتراك: ' + err.message);
                } finally {
                    rejectBtn.disabled = false;
                    rejectBtn.textContent = 'رفض';
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

    // Legacy modal reply buttons (فقط لو المودال القديم موجود في الصفحة)
    const sendPublicReplyBtn = document.getElementById('sendPublicReply');
    if (sendPublicReplyBtn) {
        sendPublicReplyBtn.onclick = async () => {
            const text = document.getElementById('replyText').value.trim();
            if (!text) {
                alert('الرجاء كتابة رد قبل الإرسال');
                return;
            }
            try {
                sendPublicReplyBtn.disabled = true;
                sendPublicReplyBtn.textContent = 'جاري الإرسال...';
                await addTicketReply(currentTicketId, text, false);
                document.getElementById('replyText').value = '';
                await loadReplies(currentTicketId);
                await loadTickets();
            } catch (err) {
                console.error('Error sending reply:', err);
                alert('فشل إرسال الرد: ' + (err.message || 'حدث خطأ غير متوقع'));
            } finally {
                sendPublicReplyBtn.disabled = false;
                sendPublicReplyBtn.textContent = 'إرسال رد للعميل';
            }
        };
    }

    const sendInternalNoteBtn = document.getElementById('sendInternalNote');
    if (sendInternalNoteBtn) {
        sendInternalNoteBtn.onclick = async () => {
            const text = document.getElementById('replyText').value.trim();
            if (!text) {
                alert('الرجاء كتابة ملاحظة قبل الإضافة');
                return;
            }
            try {
                sendInternalNoteBtn.disabled = true;
                sendInternalNoteBtn.textContent = 'جاري الإضافة...';
                await addTicketReply(currentTicketId, text, true);
                document.getElementById('replyText').value = '';
                await loadReplies(currentTicketId);
            } catch (err) {
                console.error('Error adding internal note:', err);
                alert('فشل إضافة الملاحظة: ' + (err.message || 'حدث خطأ غير متوقع'));
            } finally {
                sendInternalNoteBtn.disabled = false;
                sendInternalNoteBtn.textContent = 'إضافة ملاحظة داخلية';
            }
        };
    }

    // Close Ticket Modal Events
    const closeTicketModalEl = document.getElementById('closeTicketModal');
    if (closeTicketModalEl) {
        const closeCloseBtn = document.getElementById('closeCloseTicketModal');
        if (closeCloseBtn) {
            closeCloseBtn.onclick = () => closeTicketModalEl.style.display = 'none';
        }

        const confirmCloseBtn = document.getElementById('confirmCloseTicket');
        if (confirmCloseBtn) {
            confirmCloseBtn.onclick = closeTicket;
        }

        window.addEventListener('click', (event) => {
            if (event.target === closeTicketModalEl) {
                closeTicketModalEl.style.display = 'none';
            }
        });
    }
}

/* دوال عرض النوافذ المنبثقة الخاصة بتأكيد/رفض الاشتراك.
   بتتنشأ ديناميكياً أول مرة فقط، وبعدين بتتعاد إظهارها فقط. */
function showConfirmPurchaseModal() {
    let modal = document.getElementById('confirmPurchaseModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'confirmPurchaseModal';
        modal.style.cssText = 'display: none; position: fixed; z-index: 3000; left: 0; top: 0; width: 100%; height: 100%; background-color: rgba(0,0,0,0.4);';
        modal.innerHTML = `
            <div style="background-color: #fefefe; margin: 15% auto; padding: 2rem; border: 1px solid #888; border-radius: 0.5rem; width: 80%; max-width: 400px; font-family: Cairo;">
                <h2 style="margin-top: 0; color: #003366;">تأكيد الاشتراك</h2>
                <p>هل أنت متأكد من تأكيد طلب الاشتراك ده؟ هيتم تفعيل الخطة للعميل فوراً.</p>
                <div style="display: flex; gap: 1rem; justify-content: flex-end;">
                    <button id="confirmPurchaseCancelBtn" style="padding: 0.5rem 1rem; background: #999; color: white; border: none; border-radius: 0.25rem; cursor: pointer; font-family: Cairo;">إلغاء</button>
                    <button id="confirmPurchaseConfirmBtn" style="padding: 0.5rem 1rem; background: #2E8A3A; color: white; border: none; border-radius: 0.25rem; cursor: pointer; font-family: Cairo;">تأكيد</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        setupModalEvents();
    }
    modal.style.display = 'block';
}

function showRejectPurchaseModal() {
    let modal = document.getElementById('rejectPurchaseModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'rejectPurchaseModal';
        modal.style.cssText = 'display: none; position: fixed; z-index: 3000; left: 0; top: 0; width: 100%; height: 100%; background-color: rgba(0,0,0,0.4);';
        modal.innerHTML = `
            <div style="background-color: #fefefe; margin: 15% auto; padding: 2rem; border: 1px solid #888; border-radius: 0.5rem; width: 80%; max-width: 400px; font-family: Cairo;">
                <h2 style="margin-top: 0; color: #D9534F;">رفض الاشتراك</h2>
                <p>هل أنت متأكد من رفض طلب الاشتراك ده؟</p>
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
        document.body.appendChild(modal);
        setupModalEvents();
    }
    modal.style.display = 'block';
}

init();
