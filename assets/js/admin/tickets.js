import { supabase } from '/api-config.js';
import { checkAdminAuth, updateAdminUI } from './auth.js';
import { initSidebar } from './sidebar.js';
import {
    subscribeToTickets, subscribeToTicketReplies, updateTicketStatus, updateTicketPriority,
    addTicketReply, fetchTicketReplies, closeTicketWithComment, updateTicketAssignee,
    fetchSupportAgents, bulkUpdateTicketStatus, bulkUpdateTicketAssignee,
    fetchCannedResponses, createCannedResponse, deleteCannedResponse,
    fetchTags, createTag, deleteTag, fetchAllTicketTagLinks, addTagToTicket, removeTagFromTicket,
    uploadTicketAttachment, fetchTicketAttachments,
    fetchTicketActivity, fetchTicketRating, fetchAllTicketRatings,
    fetchSavedFilters, createSavedFilter, deleteSavedFilter
} from '/tickets-service.js';
import { impersonateUser } from './admin-utils.js';
import { confirmPurchaseTicket, rejectPurchaseTicket, PLAN_LABELS, BILLING_LABELS, PAYMENT_METHOD_LABELS, EXTERNAL_PAYMENT_METHODS } from '/whatsapp-subscription-service.js';
import { ICONS, starRow } from './ticket-icons.js';

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

function sanitizeUrl(url) {
    if (!url) return '';
    const trimmed = String(url).trim();
    if (/^(https?:)?\/\//i.test(trimmed) || trimmed.startsWith('/') || trimmed.startsWith('./')) {
        return escapeHtml(trimmed);
    }
    return '';
}

function showToast(message, type = 'success') {
    const host = document.getElementById('toastHost');
    if (!host) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `${type === 'success' ? ICONS.checkSmall : ICONS.close}<span>${escapeHtml(message)}</span>`;
    host.appendChild(toast);
    setTimeout(() => toast.remove(), 3500);
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

const CATEGORY_MAP = {
    'whatsapp': { label: 'واتساب', class: 'cat-whatsapp' },
    'tickets': { label: 'تذاكر', class: 'cat-tickets' },
    'subscription': { label: 'اشتراك', class: 'cat-subscription' },
    'login': { label: 'تسجيل الدخول', class: 'cat-login' },
    'other': { label: 'أخرى', class: 'cat-other' }
};

const ACTIVITY_LABELS = {
    'create': 'أنشأ التذكرة',
    'status_change': 'غيّر الحالة',
    'priority_change': 'غيّر الأولوية',
    'assignee_change': 'غيّر المسؤول عن المتابعة',
    'category_change': 'غيّر التصنيف',
    'reopen': 'أعاد فتح التذكرة',
    'reply': 'أضاف رداً',
    'internal_note': 'أضاف ملاحظة داخلية',
    'tag_add': 'أضاف وسماً',
    'tag_remove': 'أزال وسماً',
    'rating': 'قيّم التذكرة'
};

let user = null;
let isAdminRole = false;
let isStaffRole = false;
let currentTicketId = null;
let repliesSubscription = null;
let allTickets = [];
let allTags = [];
let ticketTagLinks = new Map(); // ticket_id -> [{id,name,color}]
let supportAgents = [];
let cannedResponses = [];
let savedFilters = [];
let currentPage = 1;
let pageSize = 20;
let lastFilteredList = [];
let slaTickInterval = null;
let notificationChannel = null;
let soundEnabled = localStorage.getItem('mad3oom_tickets_sound') !== 'off';

function agentName(id) {
    if (!id) return null;
    const a = supportAgents.find(x => x.id === id);
    return a ? (a.full_name || a.email) : 'موظف سابق';
}

function agentColor(id) {
    if (!id) return '#94A6C2';
    const palette = ['#4DA3FF', '#22C58B', '#F5A623', '#B45FE0', '#FF6B6B', '#25D366'];
    let hash = 0;
    for (const ch of String(id)) hash = (hash * 31 + ch.charCodeAt(0)) % palette.length;
    return palette[hash];
}

async function init() {
    initSidebar();
    user = await checkAdminAuth();
    if (!user) return;

    isAdminRole = user.profile?.role === 'admin';
    isStaffRole = ['admin', 'support', 'super_user'].includes(user.profile?.role);

    updateAdminUI(user);
    applyRolePermissions();
    fillStaticIcons();

    await Promise.all([loadTags(), loadAgents(), loadCannedResponses(), loadSavedFilters()]);
    await loadTickets();

    subscribeToTickets(() => loadTickets());
    setupNotificationChannel();
    setupModalEvents();
    setupFilters();
    setupBulkBar();
    setupPagination();
    setupHeaderButtons();
    setupKeyboardShortcuts();
    setupGenericModalClosers();

    if (slaTickInterval) clearInterval(slaTickInterval);
    slaTickInterval = setInterval(updateSlaBadgesOnly, 30000);
}

/**
 * الوكيل (support) له صلاحيات أقل من الأدمن: لا يدير الردود الجاهزة أو
 * الوسوم (إنشاء/حذف)، ولا يملك زر الحذف الجماعي للتذاكر.
 */
function applyRolePermissions() {
    const cannedBtn = document.getElementById('cannedManageBtn');
    const tagsBtn = document.getElementById('tagsManageBtn');
    const bulkDeleteBtn = document.getElementById('bulkDeleteBtn');
    if (!isAdminRole) {
        if (cannedBtn) cannedBtn.style.display = 'none';
        if (tagsBtn) tagsBtn.style.display = 'none';
    }
    if (bulkDeleteBtn) bulkDeleteBtn.style.display = isAdminRole ? 'inline-flex' : 'none';
}

function fillStaticIcons() {
    const set = (id, icon) => { const el = document.getElementById(id); if (el) el.innerHTML = icon; };
    set('iconTotal', ICONS.inbox);
    set('iconOpen', ICONS.ticket);
    set('iconInProgress', ICONS.clock);
    set('iconResolved', ICONS.check);
    set('iconSla', ICONS.alertTriangle);
    set('iconUnassigned', ICONS.userQuestion);

    const exportBtn = document.getElementById('exportCsvBtn');
    if (exportBtn) exportBtn.innerHTML = `${ICONS.download} تصدير CSV`;
    const refreshBtn = document.getElementById('refreshTicketsBtn');
    if (refreshBtn) refreshBtn.innerHTML = `${ICONS.refresh} تحديث`;
    const shortcutsBtn = document.getElementById('shortcutsBtn');
    if (shortcutsBtn) shortcutsBtn.innerHTML = `${ICONS.keyboard} اختصارات`;
    const analyticsBtn = document.getElementById('analyticsBtn');
    if (analyticsBtn) analyticsBtn.innerHTML = `${ICONS.chartBar} إحصائيات`;
    const cannedBtn = document.getElementById('cannedManageBtn');
    if (cannedBtn) cannedBtn.innerHTML = `${ICONS.message} ردود جاهزة`;
    const tagsBtn = document.getElementById('tagsManageBtn');
    if (tagsBtn) tagsBtn.innerHTML = `${ICONS.tag} الوسوم`;
    const soundBtn = document.getElementById('soundToggleBtn');
    if (soundBtn) soundBtn.innerHTML = soundEnabled ? `${ICONS.bell} تنبيهات مفعّلة` : `${ICONS.bellOff} تنبيهات متوقفة`;
    if (soundBtn) soundBtn.classList.toggle('active', soundEnabled);
    const saveFilterBtn = document.getElementById('saveFilterBtn');
    if (saveFilterBtn) saveFilterBtn.innerHTML = `${ICONS.bookmark} حفظ الفلتر الحالي`;
    const addTagBtn = document.getElementById('addTagBtn');
    if (addTagBtn) addTagBtn.innerHTML = ICONS.plus;

    document.querySelectorAll('[data-close-modal] ').forEach(() => {});
    document.querySelectorAll('.app-modal-close').forEach(btn => { btn.innerHTML = ICONS.close; });
}

async function loadTags() {
    try {
        allTags = await fetchTags();
        const links = await fetchAllTicketTagLinks();
        ticketTagLinks = new Map();
        links.forEach(l => {
            if (!l.ticket_tags) return;
            if (!ticketTagLinks.has(l.ticket_id)) ticketTagLinks.set(l.ticket_id, []);
            ticketTagLinks.get(l.ticket_id).push(l.ticket_tags);
        });
        renderTagFilterOptions();
    } catch (err) {
        console.error('Error loading tags:', err);
    }
}

function renderTagFilterOptions() {
    const filterTag = document.getElementById('filterTag');
    const bulkTagSelect = document.getElementById('bulkTagSelect');
    if (filterTag) {
        const current = filterTag.value;
        filterTag.innerHTML = '<option value="all">كل الوسوم</option>' +
            allTags.map(t => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}</option>`).join('');
        filterTag.value = current || 'all';
    }
    if (bulkTagSelect) {
        bulkTagSelect.innerHTML = '<option value="">إضافة وسم...</option>' +
            allTags.map(t => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}</option>`).join('');
    }
}

async function loadAgents() {
    try {
        supportAgents = await fetchSupportAgents();
        const bulkAssignSelect = document.getElementById('bulkAssignSelect');
        if (bulkAssignSelect) {
            bulkAssignSelect.innerHTML = '<option value="">تعيين إلى...</option><option value="unassign">إلغاء التعيين</option>' +
                supportAgents.map(a => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.full_name || a.email)}</option>`).join('');
        }
    } catch (err) {
        console.error('Error loading agents:', err);
    }
}

async function loadCannedResponses() {
    try {
        cannedResponses = await fetchCannedResponses();
        renderCannedManagerList();
    } catch (err) {
        console.error('Error loading canned responses:', err);
    }
}

async function loadSavedFilters() {
    try {
        savedFilters = await fetchSavedFilters();
        const select = document.getElementById('savedFiltersSelect');
        if (select) {
            select.innerHTML = '<option value="">الفلاتر المحفوظة...</option>' +
                savedFilters.map(f => `<option value="${escapeHtml(f.id)}">${escapeHtml(f.name)}</option>`).join('');
        }
    } catch (err) {
        console.error('Error loading saved filters:', err);
    }
}

async function loadTickets() {
    const { data: tickets, error } = await supabase
        .from('tickets')
        .select('*, profiles!tickets_user_profile_fk(full_name, email)')
        .order('created_at', { ascending: false });

    if (error) {
        console.error("Error fetching tickets:", error);
        const grid = document.getElementById('ticketsGrid');
        if (grid) {
            grid.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-icon" style="color:var(--color-danger);">${ICONS.alertTriangle}</div>
                    <p style="font-weight:700; color:var(--color-danger);">فشل تحميل التذاكر</p>
                    <p style="font-size:.8rem; margin-top:.3rem; word-break:break-word;">${escapeHtml(error.message || 'حدث خطأ غير متوقع')}${error.code ? ' (كود: ' + escapeHtml(error.code) + ')' : ''}</p>
                    <button id="retryLoadTicketsBtn" class="icon-btn" style="margin-top:.75rem;">${ICONS.refresh} إعادة المحاولة</button>
                </div>`;
            document.getElementById('retryLoadTicketsBtn')?.addEventListener('click', () => loadTickets());
        }
        showToast('فشل تحميل التذاكر: ' + (error.message || 'حدث خطأ غير متوقع'), 'error');
        return;
    }

    allTickets = tickets || [];
    await loadTags();
    updateStats();
    applyFiltersAndRender();
}

/* ==================== الإحصائيات ==================== */

function isSlaBreached(ticket) {
    if (!ticket.sla_resolution_due_at) return false;
    if (['resolved', 'confirmed', 'rejected'].includes(ticket.status)) return false;
    return new Date(ticket.sla_resolution_due_at).getTime() < Date.now();
}

function updateStats() {
    const total = allTickets.length;
    const open = allTickets.filter(t => t.status === 'open').length;
    const inProgress = allTickets.filter(t => t.status === 'in-progress').length;
    const resolved = allTickets.filter(t => ['resolved', 'confirmed'].includes(t.status)).length;
    const slaBreach = allTickets.filter(isSlaBreached).length;
    const unassigned = allTickets.filter(t => !t.assigned_to).length;

    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set('statTotal', total);
    set('statOpen', open);
    set('statInProgress', inProgress);
    set('statResolved', resolved);
    set('statSlaBreach', slaBreach);
    set('statUnassigned', unassigned);
}

/* ==================== SLA ==================== */

function slaBadge(ticket) {
    if (['resolved', 'confirmed', 'rejected'].includes(ticket.status)) return '';
    if (!ticket.sla_resolution_due_at) return '';
    const due = new Date(ticket.sla_resolution_due_at).getTime();
    const now = Date.now();
    const diffMs = due - now;
    let cls = 'sla-ok';
    if (diffMs < 0) cls = 'sla-breach';
    else if (diffMs < 2 * 60 * 60 * 1000) cls = 'sla-warn';

    return `<span class="pill ${cls} sla-badge" data-due="${due}">${ICONS.clock}<span class="sla-text">${formatSlaRemaining(diffMs)}</span></span>`;
}

function formatSlaRemaining(diffMs) {
    const abs = Math.abs(diffMs);
    const hours = Math.floor(abs / (60 * 60 * 1000));
    const mins = Math.floor((abs % (60 * 60 * 1000)) / (60 * 1000));
    const label = hours > 0 ? `${hours} س ${mins} د` : `${mins} د`;
    return diffMs < 0 ? `تجاوز SLA بـ ${label}` : `متبقٍ ${label}`;
}

function updateSlaBadgesOnly() {
    document.querySelectorAll('.sla-badge').forEach(el => {
        const due = parseFloat(el.dataset.due);
        const diffMs = due - Date.now();
        el.classList.remove('sla-ok', 'sla-warn', 'sla-breach');
        el.classList.add(diffMs < 0 ? 'sla-breach' : (diffMs < 2 * 60 * 60 * 1000 ? 'sla-warn' : 'sla-ok'));
        const textEl = el.querySelector('.sla-text');
        if (textEl) textEl.textContent = formatSlaRemaining(diffMs);
    });
}

/* ==================== الفلاتر + الفرز + الترقيم ==================== */

function getCurrentFilterState() {
    return {
        status: document.getElementById('filterStatus')?.value || 'all',
        priority: document.getElementById('filterPriority')?.value || 'all',
        category: document.getElementById('filterCategory')?.value || 'all',
        assignee: document.getElementById('filterAssignee')?.value || 'all',
        tag: document.getElementById('filterTag')?.value || 'all',
        sort: document.getElementById('sortBy')?.value || 'newest',
        search: document.getElementById('searchInput')?.value || ''
    };
}

function applyFilterState(state) {
    if (!state) return;
    const set = (id, val) => { const el = document.getElementById(id); if (el && val !== undefined) el.value = val; };
    set('filterStatus', state.status);
    set('filterPriority', state.priority);
    set('filterCategory', state.category);
    set('filterAssignee', state.assignee);
    set('filterTag', state.tag);
    set('sortBy', state.sort);
    set('searchInput', state.search);
    currentPage = 1;
    applyFiltersAndRender();
}

let quickFilter = null; // من كروت الإحصائيات السريعة

function applyFiltersAndRender() {
    const state = getCurrentFilterState();
    let list = [...allTickets];

    if (quickFilter === 'sla-breach') {
        list = list.filter(isSlaBreached);
    } else if (quickFilter === 'unassigned') {
        list = list.filter(t => !t.assigned_to);
    } else if (quickFilter && quickFilter !== 'all') {
        list = list.filter(t => t.status === quickFilter);
    }

    if (state.status !== 'all') list = list.filter(t => t.status === state.status);
    if (state.priority !== 'all') list = list.filter(t => t.priority === state.priority);
    if (state.category !== 'all') list = list.filter(t => (t.category || 'other') === state.category);
    if (state.assignee === 'unassigned') list = list.filter(t => !t.assigned_to);
    else if (state.assignee === 'me') list = list.filter(t => t.assigned_to === user.id);
    else if (state.assignee !== 'all') list = list.filter(t => t.assigned_to === state.assignee);
    if (state.tag !== 'all') list = list.filter(t => (ticketTagLinks.get(t.id) || []).some(tg => tg.id === state.tag));

    if (state.search.trim()) {
        const q = state.search.trim().toLowerCase();
        list = list.filter(t =>
            (t.title || '').toLowerCase().includes(q) ||
            (t.ticket_number || '').toString().toLowerCase().includes(q) ||
            (t.profiles?.full_name || '').toLowerCase().includes(q) ||
            (t.profiles?.email || '').toLowerCase().includes(q) ||
            (t.description || '').toLowerCase().includes(q)
        );
    }

    const priorityOrder = { high: 0, medium: 1, low: 2 };
    if (state.sort === 'oldest') {
        list.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    } else if (state.sort === 'priority') {
        list.sort((a, b) => (priorityOrder[a.priority] ?? 3) - (priorityOrder[b.priority] ?? 3) || new Date(b.created_at) - new Date(a.created_at));
    } else if (state.sort === 'sla') {
        list.sort((a, b) => {
            const dueA = a.sla_resolution_due_at ? new Date(a.sla_resolution_due_at).getTime() : Infinity;
            const dueB = b.sla_resolution_due_at ? new Date(b.sla_resolution_due_at).getTime() : Infinity;
            return dueA - dueB;
        });
    } else {
        list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    }

    lastFilteredList = list;
    const resultsCount = document.getElementById('resultsCount');
    if (resultsCount) resultsCount.textContent = `${list.length} نتيجة`;

    renderPage();
}

function renderPage() {
    const totalPages = Math.max(1, Math.ceil(lastFilteredList.length / pageSize));
    if (currentPage > totalPages) currentPage = totalPages;
    const start = (currentPage - 1) * pageSize;
    const pageItems = lastFilteredList.slice(start, start + pageSize);
    renderTickets(pageItems);

    const pageIndicator = document.getElementById('pageIndicator');
    if (pageIndicator) pageIndicator.textContent = `صفحة ${currentPage} من ${totalPages}`;
    const prevBtn = document.getElementById('prevPageBtn');
    const nextBtn = document.getElementById('nextPageBtn');
    if (prevBtn) prevBtn.disabled = currentPage <= 1;
    if (nextBtn) nextBtn.disabled = currentPage >= totalPages;
}

function setupFilters() {
    ['filterStatus', 'filterPriority', 'filterCategory', 'filterAssignee', 'filterTag', 'sortBy'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('change', () => { quickFilter = null; currentPage = 1; applyFiltersAndRender(); });
    });

    let debounceTimer;
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        searchInput.addEventListener('input', () => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => { currentPage = 1; applyFiltersAndRender(); }, 250);
        });
    }

    document.querySelectorAll('.stat-card[data-quickfilter]').forEach(card => {
        card.addEventListener('click', () => {
            quickFilter = card.dataset.quickfilter;
            currentPage = 1;
            applyFiltersAndRender();
        });
    });

    // فلاتر البحث المحفوظة
    const savedSelect = document.getElementById('savedFiltersSelect');
    if (savedSelect) {
        savedSelect.addEventListener('change', () => {
            const chosen = savedFilters.find(f => f.id === savedSelect.value);
            if (chosen) applyFilterState(chosen.filters);
        });
    }
    const saveFilterBtn = document.getElementById('saveFilterBtn');
    if (saveFilterBtn) {
        saveFilterBtn.addEventListener('click', async () => {
            const name = prompt('اسم الفلتر المحفوظ:');
            if (!name || !name.trim()) return;
            try {
                await createSavedFilter(name, getCurrentFilterState());
                await loadSavedFilters();
                showToast('تم حفظ الفلتر بنجاح');
            } catch (err) {
                showToast('فشل حفظ الفلتر: ' + err.message, 'error');
            }
        });
    }
}

function setupPagination() {
    document.getElementById('prevPageBtn')?.addEventListener('click', () => { if (currentPage > 1) { currentPage--; renderPage(); } });
    document.getElementById('nextPageBtn')?.addEventListener('click', () => { currentPage++; renderPage(); });
    document.getElementById('pageSizeSelect')?.addEventListener('change', (e) => {
        pageSize = parseInt(e.target.value, 10) || 20;
        currentPage = 1;
        renderPage();
    });
}

/* ==================== عرض بطاقات التذاكر ==================== */

const selectedTicketIds = new Set();

function renderTickets(tickets) {
    const grid = document.getElementById('ticketsGrid');
    if (!grid) return;

    if (tickets.length === 0) {
        grid.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">${ICONS.inbox}</div>
                <p style="font-weight:700; color:var(--color-text);">لا توجد تذاكر مطابقة</p>
                <p style="font-size:.8rem; margin-top:.3rem;">جرّب تغيير الفلاتر أو مصطلح البحث</p>
            </div>`;
        return;
    }

    grid.innerHTML = tickets.map(t => {
        const priority = PRIORITY_MAP[t.priority] || PRIORITY_MAP.medium;
        const category = CATEGORY_MAP[t.category] || CATEGORY_MAP.other;
        const tags = ticketTagLinks.get(t.id) || [];
        const assignedName = agentName(t.assigned_to);

        return `
        <div class="ticket-card ${t.id === currentTicketId ? 'selected' : ''}" data-ticket-id="${escapeHtml(t.id)}">
            <input type="checkbox" class="ticket-checkbox" data-ticket-id="${escapeHtml(t.id)}" ${selectedTicketIds.has(t.id) ? 'checked' : ''}>
            <div class="ticket-card-top">
                <span class="ticket-num">#${escapeHtml(t.ticket_number || '---')}</span>
                <span class="pill status-${escapeHtml(t.status)}"><span class="pill-dot"></span>${escapeHtml(STATUS_MAP[t.status] || t.status)}</span>
            </div>
            <div class="ticket-title">${escapeHtml(t.title)}</div>
            <div class="ticket-badges">
                <span class="pill ${priority.class}">${priority.label}</span>
                <span class="pill ${category.class}">${category.label}</span>
                ${t.reopen_count > 0 ? `<span class="pill" style="background:rgba(245,166,35,.12); color:#F5A623;">${ICONS.reopen} أُعيدت ${t.reopen_count}×</span>` : ''}
                ${slaBadge(t)}
            </div>
            ${tags.length ? `<div class="ticket-tags-row">${tags.map(tg => `<span class="tag-chip" style="background:${tg.color}22; color:${tg.color};">${escapeHtml(tg.name)}</span>`).join('')}</div>` : ''}
            <div class="ticket-user-row">
                <span style="font-size:.78rem; color:var(--color-text-secondary);">${escapeHtml(t.profiles?.full_name || 'مستخدم')}</span>
            </div>
            <div class="ticket-footer-row">
                <span>${new Date(t.created_at).toLocaleDateString('ar-EG')}</span>
                ${assignedName
                    ? `<span style="display:flex; align-items:center; gap:.3rem;"><span class="avatar-chip" style="background:${agentColor(t.assigned_to)};">${escapeHtml(assignedName.charAt(0))}</span>${escapeHtml(assignedName)}</span>`
                    : `<span style="display:flex; align-items:center; gap:.3rem; color:var(--color-text-3);">${ICONS.userQuestion} غير معيّنة</span>`}
            </div>
        </div>`;
    }).join('');

    grid.querySelectorAll('.ticket-card').forEach(card => {
        card.addEventListener('click', (e) => {
            if (e.target.classList.contains('ticket-checkbox')) return;
            const id = card.dataset.ticketId;
            document.querySelectorAll('.ticket-card').forEach(c => c.classList.remove('selected'));
            card.classList.add('selected');
            showAdminTicketInPanel(id);
        });
    });

    grid.querySelectorAll('.ticket-checkbox').forEach(cb => {
        cb.addEventListener('click', (e) => e.stopPropagation());
        cb.addEventListener('change', () => {
            const id = cb.dataset.ticketId;
            if (cb.checked) selectedTicketIds.add(id); else selectedTicketIds.delete(id);
            updateBulkBar();
        });
    });
}

function updateBulkBar() {
    const bar = document.getElementById('bulkBar');
    const count = document.getElementById('bulkCount');
    if (!bar || !count) return;
    if (selectedTicketIds.size > 0) {
        bar.classList.add('active');
        count.textContent = `${selectedTicketIds.size} محددة`;
    } else {
        bar.classList.remove('active');
    }
    const selectAll = document.getElementById('selectAllTickets');
    if (selectAll) selectAll.checked = lastFilteredList.length > 0 && lastFilteredList.every(t => selectedTicketIds.has(t.id));
}

function setupBulkBar() {
    document.getElementById('selectAllTickets')?.addEventListener('change', (e) => {
        const start = (currentPage - 1) * pageSize;
        const pageItems = lastFilteredList.slice(start, start + pageSize);
        if (e.target.checked) pageItems.forEach(t => selectedTicketIds.add(t.id));
        else pageItems.forEach(t => selectedTicketIds.delete(t.id));
        renderPage();
        updateBulkBar();
    });

    document.getElementById('clearSelectionBtn')?.addEventListener('click', () => {
        selectedTicketIds.clear();
        renderPage();
        updateBulkBar();
    });

    document.getElementById('bulkStatusSelect')?.addEventListener('change', async (e) => {
        const status = e.target.value;
        if (!status || selectedTicketIds.size === 0) return;
        try {
            await bulkUpdateTicketStatus(Array.from(selectedTicketIds), status);
            showToast(`تم تحديث حالة ${selectedTicketIds.size} تذكرة`);
            selectedTicketIds.clear();
            e.target.value = '';
            await loadTickets();
        } catch (err) {
            showToast('فشل التحديث الجماعي: ' + err.message, 'error');
        }
    });

    document.getElementById('bulkAssignSelect')?.addEventListener('change', async (e) => {
        const value = e.target.value;
        if (!value || selectedTicketIds.size === 0) return;
        try {
            await bulkUpdateTicketAssignee(Array.from(selectedTicketIds), value === 'unassign' ? null : value);
            showToast(`تم تعيين ${selectedTicketIds.size} تذكرة`);
            selectedTicketIds.clear();
            e.target.value = '';
            await loadTickets();
        } catch (err) {
            showToast('فشل التعيين الجماعي: ' + err.message, 'error');
        }
    });

    document.getElementById('bulkTagSelect')?.addEventListener('change', async (e) => {
        const tagId = e.target.value;
        if (!tagId || selectedTicketIds.size === 0) return;
        try {
            await Promise.all(Array.from(selectedTicketIds).map(id => addTagToTicket(id, tagId).catch(() => {})));
            showToast('تم إضافة الوسم للتذاكر المحددة');
            e.target.value = '';
            await loadTags();
            renderPage();
        } catch (err) {
            showToast('فشل إضافة الوسم: ' + err.message, 'error');
        }
    });

    document.getElementById('bulkExportBtn')?.addEventListener('click', () => {
        const selected = allTickets.filter(t => selectedTicketIds.has(t.id));
        if (selected.length === 0) return showToast('لا توجد تذاكر محددة', 'error');
        exportTicketsToCsv(selected);
    });

    document.getElementById('bulkDeleteBtn')?.addEventListener('click', async () => {
        if (selectedTicketIds.size === 0) return;
        if (!confirm(`هل أنت متأكد من حذف ${selectedTicketIds.size} تذكرة؟ لا يمكن التراجع عن هذا الإجراء.`)) return;
        try {
            const { error } = await supabase.from('tickets').delete().in('id', Array.from(selectedTicketIds));
            if (error) throw error;
            showToast('تم حذف التذاكر المحددة');
            selectedTicketIds.clear();
            await loadTickets();
        } catch (err) {
            showToast('فشل الحذف: ' + err.message, 'error');
        }
    });
}

/* ==================== لوحة التفاصيل ==================== */

async function showAdminTicketInPanel(ticketId) {
    currentTicketId = ticketId;
    const panel = document.getElementById('adminTicketDetailsContent');
    if (!panel) return;

    const { data: ticket, error } = await supabase
        .from('tickets')
        .select('*, profiles!tickets_user_profile_fk(full_name, email, id), last_updated_by_profile:profiles!tickets_last_updated_by_fkey(full_name)')
        .eq('id', ticketId)
        .single();

    if (error || !ticket) {
        panel.innerHTML = '<p style="text-align:center; color:var(--color-danger);">خطأ في جلب بيانات التذكرة</p>';
        return;
    }

    const { data: subscription } = await supabase
        .from('whatsapp_subscriptions')
        .select('*, reviewed_by_profile:profiles!whatsapp_subscriptions_reviewed_by_fkey(full_name)')
        .eq('ticket_id', ticket.id)
        .maybeSingle();

    panel.classList.remove('details-empty');
    panel.style.display = 'block';

    const lastUpdatedLine = ticket.last_updated_by
        ? `<div style="margin-top:.5rem; font-size:.78rem; color:var(--color-text-secondary);">آخر تعديل بواسطة: <strong style="color:var(--color-text);">${escapeHtml(ticket.last_updated_by_profile?.full_name || 'موظف دعم')}</strong>${ticket.last_updated_at ? ' - ' + new Date(ticket.last_updated_at).toLocaleString('ar-EG', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }) : ''}</div>`
        : '';

    const reopenLine = ticket.reopen_count > 0
        ? `<div class="pill" style="background:rgba(245,166,35,.14); color:#F5A623; margin-top:.6rem;">${ICONS.reopen} أُعيد فتحها ${ticket.reopen_count} مرة${ticket.last_reopened_at ? ' - آخر مرة ' + new Date(ticket.last_reopened_at).toLocaleDateString('ar-EG') : ''}</div>`
        : '';

    const tags = ticketTagLinks.get(ticket.id) || [];

    panel.innerHTML = `
        <div style="width:100%;">
            <div style="border-bottom:2px solid var(--color-border); padding-bottom:1rem; margin-bottom:1.5rem;">
                <div style="display:flex; justify-content:space-between; align-items:start; margin-bottom:.75rem; gap:.75rem;">
                    <h2 style="margin:0; font-size:1.25rem; line-height:1.4;">${escapeHtml(ticket.title)}</h2>
                    <span class="pill status-${escapeHtml(ticket.status)}" style="white-space:nowrap;">${escapeHtml(STATUS_MAP[ticket.status] || ticket.status)}</span>
                </div>
                <div style="display:flex; gap:1.25rem; font-size:.82rem; color:var(--color-text-secondary); flex-wrap:wrap;">
                    <span>رقم التذكرة: <strong style="color:var(--color-text);">#${escapeHtml(ticket.ticket_number || '---')}</strong></span>
                    <span>${new Date(ticket.created_at).toLocaleDateString('ar-EG')}</span>
                </div>
                ${reopenLine}
                ${lastUpdatedLine}
                <div style="margin-top:.85rem; padding:.85rem; background:var(--color-muted); border-radius:.65rem; display:flex; justify-content:space-between; align-items:center; gap:.75rem; flex-wrap:wrap;">
                    <div>
                        <div style="font-size:.8rem; color:var(--color-text-secondary); margin-bottom:.2rem;">العميل</div>
                        <div style="font-weight:700;">${escapeHtml(ticket.profiles?.full_name || 'مستخدم')}</div>
                        <div style="font-size:.8rem; color:var(--color-text-secondary);">${escapeHtml(ticket.profiles?.email || '')}</div>
                    </div>
                    <button id="impersonateBtn" class="icon-btn" style="padding:.4rem .7rem; font-size:.75rem;">${ICONS.userSwitch} الدخول كالعميل</button>
                </div>
            </div>

            <div style="margin-bottom:1.5rem;">
                <h3 style="font-size:.88rem; color:var(--color-text-secondary); margin-bottom:.5rem;">وصف المشكلة</h3>
                <p style="line-height:1.6; white-space:pre-wrap;">${escapeHtml(ticket.description)}</p>
            </div>

            ${ticket.image_url ? `
            <div style="margin-bottom:1.5rem;">
                <h3 style="font-size:.88rem; color:var(--color-text-secondary); margin-bottom:.5rem;">صورة مرفقة مع التذكرة</h3>
                <img src="${sanitizeUrl(ticket.image_url)}" style="max-width:100%; border-radius:.5rem; border:1px solid var(--color-border);">
            </div>` : ''}

            <div class="detail-block">
                <label>الوسوم</label>
                <div id="tagsEditorRow" class="ticket-tags-row" style="margin-bottom:.6rem;">
                    ${tags.map(tg => `<span class="tag-chip" style="background:${tg.color}22; color:${tg.color};">${escapeHtml(tg.name)}<button data-remove-tag="${escapeHtml(tg.id)}">${ICONS.close}</button></span>`).join('') || '<span style="font-size:.78rem; color:var(--color-text-3);">لا توجد وسوم</span>'}
                </div>
                <select id="addTagSelect" style="width:100%;">
                    <option value="">+ إضافة وسم...</option>
                    ${allTags.filter(t => !tags.some(tg => tg.id === t.id)).map(t => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}</option>`).join('')}
                </select>
            </div>

            <div class="detail-block">
                <label>حالة التذكرة</label>
                <select id="panelStatusSelect">
                    <option value="open" ${ticket.status === 'open' ? 'selected' : ''}>مفتوحة</option>
                    <option value="in-progress" ${ticket.status === 'in-progress' ? 'selected' : ''}>قيد المعالجة</option>
                    <option value="resolved" ${['resolved', 'confirmed'].includes(ticket.status) ? 'selected' : ''}>محلولة / مغلقة</option>
                    ${ticket.status === 'rejected' ? `<option value="rejected" selected>مرفوضة</option>` : ''}
                </select>
            </div>

            <div style="display:grid; grid-template-columns:1fr 1fr; gap:.75rem; margin-bottom:1rem;">
                <div class="detail-block" style="margin-bottom:0;">
                    <label>الأولوية</label>
                    <select id="panelPrioritySelect">
                        <option value="low" ${ticket.priority === 'low' ? 'selected' : ''}>منخفضة</option>
                        <option value="medium" ${ticket.priority === 'medium' ? 'selected' : ''}>متوسطة</option>
                        <option value="high" ${ticket.priority === 'high' ? 'selected' : ''}>عالية</option>
                    </select>
                </div>
                <div class="detail-block" style="margin-bottom:0;">
                    <label>التصنيف</label>
                    <select id="panelCategorySelect">
                        ${Object.entries(CATEGORY_MAP).map(([key, val]) => `<option value="${key}" ${((ticket.category || 'other') === key) ? 'selected' : ''}>${val.label}</option>`).join('')}
                    </select>
                </div>
            </div>

            <div class="detail-block">
                <label>تعيين الموظف المسؤول (Agent Assignment)</label>
                <select id="panelAssigneeSelect">

                    <option value="">غير معيّنة</option>
                    ${supportAgents.map(a => `<option value="${escapeHtml(a.id)}" ${ticket.assigned_to === a.id ? 'selected' : ''}>${escapeHtml(a.full_name || a.email)}</option>`).join('')}
                </select>
            </div>

            <div id="panelActionsContainer" style="margin-bottom:1.5rem;"></div>

            <div id="ratingBlock"></div>

            <div class="detail-block">
                <label>المرفقات</label>
                <div id="attachmentsList" style="margin-bottom:.6rem; font-size:.8rem;">جاري التحميل...</div>
                <input type="file" id="attachmentInput" multiple style="width:100%; font-size:.78rem; color:var(--color-text-secondary);">
            </div>

            <div style="border-top:2px solid var(--color-border); padding-top:1.5rem;">
                <h3 style="font-size:.95rem; margin-bottom:1rem;">الردود</h3>
                <div class="canned-replies" id="cannedRepliesRow"></div>
                <div id="adminPanelRepliesList" style="max-height:280px; overflow-y:auto; margin-bottom:1rem;">
                    <div style="text-align:center; padding:1rem; color:var(--color-text-secondary);">جاري تحميل الردود...</div>
                </div>
                <textarea id="adminPanelReplyText" data-shortcut-reply style="min-height:80px;" placeholder="اكتب ردك هنا... (استخدم اختصار R للتركيز هنا)"></textarea>
                <div style="display:flex; gap:.5rem; margin-top:.6rem;">
                    <button id="adminPanelSendReply" class="btn btn-primary" style="flex:1; padding:.75rem; border-radius:.6rem; color:#fff; cursor:pointer;">إرسال رد للعميل</button>
                    <button id="adminPanelSendInternalNote" class="icon-btn" style="flex:1; justify-content:center;">${ICONS.note} ملاحظة داخلية</button>
                </div>
            </div>

            <div class="detail-block" style="margin-top:1.5rem;">
                <div style="display:flex; justify-content:space-between; align-items:center; cursor:pointer;" id="activityToggle">
                    <label style="margin:0; display:flex; align-items:center; gap:.4rem;">${ICONS.history} سجل النشاط الكامل (Activity Timeline)</label>
                    <span style="font-size:.75rem; color:var(--color-accent-2);">عرض/إخفاء</span>
                </div>
                <div id="activityTimeline" style="display:none; margin-top:.85rem; max-height:260px; overflow-y:auto;"></div>
            </div>
        </div>
    `;

    renderPanelActions(ticket, subscription);
    await Promise.all([
        loadAdminRepliesInPanel(ticket.id),
        loadAttachments(ticket.id),
        loadRatingBlock(ticket)
    ]);
    renderCannedChips();

    document.getElementById('impersonateBtn')?.addEventListener('click', () => impersonateUser(ticket.profiles?.id));

    document.getElementById('panelStatusSelect')?.addEventListener('change', async (e) => {
        const previous = ticket.status;
        const newStatus = e.target.value;

        if (newStatus === 'resolved') {
            const modal = document.getElementById('closeTicketModal');
            const commentBox = document.getElementById('closeTicketComment');
            if (commentBox) commentBox.value = '';
            if (modal) modal.style.display = 'block';

            const cancelBtn = document.getElementById('closeCloseTicketModal');
            const confirmBtn = document.getElementById('confirmCloseTicket');
            if (cancelBtn) {
                cancelBtn.onclick = () => {
                    if (modal) modal.style.display = 'none';
                    e.target.value = previous;
                };
            }
            if (confirmBtn) {
                confirmBtn.onclick = async () => {
                    confirmBtn.disabled = true;
                    confirmBtn.textContent = 'جاري الإغلاق...';
                    try {
                        await closeTicketWithComment(ticket.id, (commentBox?.value || '').trim());
                        if (modal) modal.style.display = 'none';
                        showToast('تم إغلاق التذكرة بنجاح');
                        await loadTickets();
                        await showAdminTicketInPanel(ticket.id);
                    } catch (err) {
                        showToast('فشل إغلاق التذكرة: ' + err.message, 'error');
                    } finally {
                        confirmBtn.disabled = false;
                        confirmBtn.textContent = 'تأكيد الإغلاق';
                    }
                };
            }
        } else {
            try {
                await updateTicketStatus(ticket.id, newStatus);
                showToast('تم تحديث حالة التذكرة بنجاح');
                await loadTickets();
                await showAdminTicketInPanel(ticket.id);
            } catch (err) {
                showToast('فشل تحديث الحالة: ' + err.message, 'error');
                e.target.value = previous;
            }
        }
    });

    document.getElementById('panelPrioritySelect')?.addEventListener('change', async (e) => {
        const previous = ticket.priority;
        try {
            await updateTicketPriority(ticket.id, e.target.value);
            await loadTickets();
        } catch (err) {
            showToast('فشل تغيير الأولوية: ' + err.message, 'error');
            e.target.value = previous;
        }
    });

    document.getElementById('panelCategorySelect')?.addEventListener('change', async (e) => {
        const previous = ticket.category || 'other';
        try {
            const { error: updErr } = await supabase.from('tickets').update({ category: e.target.value, last_updated_by: user.id, last_updated_at: new Date().toISOString() }).eq('id', ticket.id);
            if (updErr) throw updErr;
            await loadTickets();
        } catch (err) {
            showToast('فشل تغيير التصنيف: ' + err.message, 'error');
            e.target.value = previous;
        }
    });

    document.getElementById('panelAssigneeSelect')?.addEventListener('change', async (e) => {
        const previous = ticket.assigned_to || '';
        try {
            await updateTicketAssignee(ticket.id, e.target.value || null);
            showToast('تم تعيين التذكرة بنجاح');
            await loadTickets();
        } catch (err) {
            showToast('فشل التعيين: ' + err.message, 'error');
            e.target.value = previous;
        }
    });

    document.getElementById('addTagSelect')?.addEventListener('change', async (e) => {
        const tagId = e.target.value;
        if (!tagId) return;
        try {
            await addTagToTicket(ticket.id, tagId);
            await loadTags();
            showAdminTicketInPanel(ticket.id);
        } catch (err) {
            showToast('فشل إضافة الوسم: ' + err.message, 'error');
        }
    });

    panel.querySelectorAll('[data-remove-tag]').forEach(btn => {
        btn.addEventListener('click', async () => {
            try {
                await removeTagFromTicket(ticket.id, btn.dataset.removeTag);
                await loadTags();
                showAdminTicketInPanel(ticket.id);
            } catch (err) {
                showToast('فشل إزالة الوسم: ' + err.message, 'error');
            }
        });
    });

    document.getElementById('attachmentInput')?.addEventListener('change', async (e) => {
        const files = Array.from(e.target.files || []);
        if (!files.length) return;
        try {
            await Promise.all(files.map(f => uploadTicketAttachment(ticket.id, f)));
            showToast(`تم رفع ${files.length} مرفق`);
            await loadAttachments(ticket.id);
        } catch (err) {
            showToast('فشل رفع المرفق: ' + err.message, 'error');
        }
        e.target.value = '';
    });

    document.getElementById('activityToggle')?.addEventListener('click', async () => {
        const box = document.getElementById('activityTimeline');
        if (!box) return;
        const willShow = box.style.display === 'none';
        box.style.display = willShow ? 'block' : 'none';
        if (willShow) await loadActivityTimeline(ticket.id);
    });

    const sendBtn = document.getElementById('adminPanelSendReply');
    const replyInput = document.getElementById('adminPanelReplyText');
    if (sendBtn && replyInput) {
        sendBtn.onclick = async () => {
            const message = replyInput.value.trim();
            if (!message) return showToast('الرجاء كتابة رد قبل الإرسال', 'error');
            try {
                sendBtn.disabled = true;
                sendBtn.textContent = 'جاري الإرسال...';
                await addTicketReply(ticket.id, message, false);
                replyInput.value = '';
                await loadAdminRepliesInPanel(ticket.id);
                await loadTickets();
                showToast('تم إرسال الرد');
            } catch (err) {
                showToast('فشل إرسال الرد: ' + (err.message || 'حدث خطأ غير متوقع'), 'error');
            } finally {
                sendBtn.disabled = false;
                sendBtn.textContent = 'إرسال رد للعميل';
            }
        };
    }

    const internalBtn = document.getElementById('adminPanelSendInternalNote');
    if (internalBtn && replyInput) {
        internalBtn.onclick = async () => {
            const message = replyInput.value.trim();
            if (!message) return showToast('الرجاء كتابة ملاحظة قبل الإضافة', 'error');
            try {
                await addTicketReply(ticket.id, message, true);
                replyInput.value = '';
                await loadAdminRepliesInPanel(ticket.id);
                showToast('تمت إضافة الملاحظة الداخلية');
            } catch (err) {
                showToast('فشل إضافة الملاحظة: ' + err.message, 'error');
            }
        };
    }
}

function renderCannedChips() {
    const row = document.getElementById('cannedRepliesRow');
    if (!row) return;
    if (!cannedResponses.length) { row.innerHTML = ''; return; }
    row.innerHTML = cannedResponses.map(c => `<button type="button" class="canned-chip" data-canned-id="${escapeHtml(c.id)}">${ICONS.message} ${escapeHtml(c.title)}</button>`).join('');
    row.querySelectorAll('.canned-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            const canned = cannedResponses.find(c => c.id === chip.dataset.cannedId);
            const textarea = document.getElementById('adminPanelReplyText');
            if (canned && textarea) {
                textarea.value = textarea.value ? (textarea.value + '\n' + canned.content) : canned.content;
                textarea.focus();
            }
        });
    });
}

async function loadAttachments(ticketId) {
    const list = document.getElementById('attachmentsList');
    if (!list) return;
    try {
        const attachments = await fetchTicketAttachments(ticketId);
        if (!attachments.length) {
            list.innerHTML = '<span style="color:var(--color-text-3);">لا توجد مرفقات</span>';
            return;
        }
        list.innerHTML = attachments.map(a => `
            <div style="display:flex; align-items:center; gap:.4rem; padding:.35rem 0;">
                ${ICONS.paperclip}
                <a href="${sanitizeUrl(a.file_url)}" target="_blank" rel="noopener" style="color:var(--color-accent-2); text-decoration:none; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(a.file_name || 'ملف')}</a>
                <span style="color:var(--color-text-3); font-size:.72rem;">${a.file_size ? Math.round(a.file_size / 1024) + ' كيلوبايت' : ''}</span>
            </div>`).join('');
    } catch (err) {
        list.innerHTML = '<span style="color:var(--color-danger);">فشل تحميل المرفقات</span>';
    }
}

async function loadRatingBlock(ticket) {
    const block = document.getElementById('ratingBlock');
    if (!block) return;
    if (!['resolved', 'confirmed'].includes(ticket.status)) { block.innerHTML = ''; return; }
    try {
        const rating = await fetchTicketRating(ticket.id);
        if (!rating) {
            block.innerHTML = `<div class="detail-block" style="text-align:center; color:var(--color-text-3); font-size:.8rem;">لم يقيّم العميل هذه التذكرة بعد</div>`;
            return;
        }
        block.innerHTML = `
            <div class="detail-block">
                <label>تقييم العميل بعد الإغلاق</label>
                <div style="display:flex; gap:.2rem; margin-bottom:.4rem;">${starRow(rating.rating)}</div>
                ${rating.comment ? `<p style="font-size:.82rem; line-height:1.5;">${escapeHtml(rating.comment)}</p>` : ''}
            </div>`;
    } catch (err) {
        block.innerHTML = '';
    }
}

async function loadActivityTimeline(ticketId) {
    const box = document.getElementById('activityTimeline');
    if (!box) return;
    box.innerHTML = '<div style="text-align:center; padding:1rem; color:var(--color-text-secondary);">جاري التحميل...</div>';
    try {
        const activity = await fetchTicketActivity(ticketId);
        if (!activity.length) {
            box.innerHTML = '<p style="text-align:center; color:var(--color-text-3); font-size:.8rem;">لا يوجد نشاط مسجل بعد</p>';
            return;
        }
        box.innerHTML = activity.map(a => {
            const actorName = a.profiles?.full_name || 'النظام';
            const label = ACTIVITY_LABELS[a.action_type] || a.action_type;
            let detail = '';
            if (a.action_type === 'status_change') detail = `من "${STATUS_MAP[a.from_value] || a.from_value}" إلى "${STATUS_MAP[a.to_value] || a.to_value}"`;
            else if (a.action_type === 'priority_change') detail = `من "${PRIORITY_MAP[a.from_value]?.label || a.from_value}" إلى "${PRIORITY_MAP[a.to_value]?.label || a.to_value}"`;
            else if (a.action_type === 'assignee_change') detail = `${a.from_value ? 'من ' + escapeHtml(agentName(a.from_value) || 'موظف سابق') : 'من غير معيّن'} إلى ${a.to_value ? escapeHtml(agentName(a.to_value) || 'موظف') : 'غير معيّن'}`;
            else if (a.action_type === 'tag_add') detail = `الوسم: ${escapeHtml(a.to_value)}`;
            else if (a.action_type === 'tag_remove') detail = `الوسم: ${escapeHtml(a.from_value)}`;
            else if (a.action_type === 'rating') detail = `${a.to_value} من 5`;

            return `
            <div class="activity-item">
                <div class="activity-icon">${ICONS.flag}</div>
                <div>
                    <div class="activity-text"><strong>${escapeHtml(actorName)}</strong> ${escapeHtml(label)}${detail ? ' — ' + detail : ''}</div>
                    <div class="activity-time">${new Date(a.created_at).toLocaleString('ar-EG', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })}</div>
                </div>
            </div>`;
        }).join('');
    } catch (err) {
        box.innerHTML = '<p style="text-align:center; color:var(--color-danger);">فشل تحميل سجل النشاط</p>';
    }
}

/* ==================== إجراءات التذكرة (تأكيد/رفض اشتراك أو تغيير حالة) ==================== */

function renderPanelActions(ticket, subscription) {
    const container = document.getElementById('panelActionsContainer');
    if (!container) return;

    if (subscription) {
        const planLabel = PLAN_LABELS[subscription.plan] || subscription.plan;
        const billingLabel = BILLING_LABELS[subscription.billing_cycle] || subscription.billing_cycle;
        const renewalBadge = subscription.is_renewal
            ? `<span class="pill" style="background:rgba(0,119,204,.14); color:#8FC7FF; margin-left:.4rem;">تجديد</span>` : '';

        const reviewerName = subscription.reviewed_by_profile?.full_name;
        const reviewedAtLabel = subscription.reviewed_at
            ? new Date(subscription.reviewed_at).toLocaleString('ar-EG', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })
            : '';

        const paymentMethodLabel = PAYMENT_METHOD_LABELS[subscription.payment_method] || subscription.payment_method || '';
        const isExternalPayment = EXTERNAL_PAYMENT_METHODS.includes(subscription.payment_method);

        const STATUS_INFO = {
            pending: { label: 'بانتظار المراجعة', color: '#F5A623', bg: 'rgba(245,166,35,.14)' },
            active: { label: 'مؤكَّد ومُفعّل', color: '#3DBE7A', bg: 'rgba(61,190,122,.14)' },
            rejected: { label: 'مرفوض', color: '#E5533D', bg: 'rgba(229,83,61,.14)' },
            expired: { label: 'منتهي', color: 'var(--color-text-3)', bg: 'var(--color-muted)' }
        };
        const statusInfo = STATUS_INFO[subscription.status] || { label: subscription.status, color: 'var(--color-text-3)', bg: 'var(--color-muted)' };

        let actionsHtml = '';
        if (subscription.status === 'pending') {
            actionsHtml = `
                ${isExternalPayment ? `<div style="margin-top:.6rem; font-size:.78rem; color:var(--color-text-secondary);">${ICONS.alertTriangle} تحقق من إثبات الدفع المرفق أدناه قبل تأكيد الاشتراك.</div>` : ''}
                <div style="display:flex; gap:.6rem; margin-top:.85rem;">
                    <button id="confirmSubBtn" class="btn btn-primary" style="flex:1; display:flex; align-items:center; justify-content:center; gap:.4rem; padding:.7rem; border-radius:.6rem; color:#fff; cursor:pointer;">${ICONS.confirmCheck} تأكيد الاشتراك</button>
                    <button id="rejectSubBtn" class="icon-btn" style="flex:1; justify-content:center; color:var(--color-danger); border-color:var(--color-danger);">${ICONS.reject} رفض الاشتراك</button>
                </div>`;
        } else if (subscription.status === 'rejected' && subscription.rejection_reason) {
            actionsHtml = `<div style="margin-top:.6rem; font-size:.82rem; color:var(--color-danger);">سبب الرفض: ${escapeHtml(subscription.rejection_reason)}</div>`;
        }

        container.innerHTML = `
            <div class="detail-block" style="background:var(--color-muted); border-radius:.65rem;">
                <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:.5rem;">
                    <div>
                        <label style="margin:0;">طلب اشتراك</label>
                        <div style="font-weight:700; margin-top:.2rem;">${escapeHtml(planLabel)}${renewalBadge}<span style="font-size:.8rem; color:var(--color-text-secondary); font-weight:400;"> - ${escapeHtml(billingLabel)}</span></div>
                    </div>
                    <span class="pill" style="background:${statusInfo.bg}; color:${statusInfo.color};">${statusInfo.label}</span>
                </div>
                ${paymentMethodLabel ? `<div style="margin-top:.5rem; font-size:.8rem; color:var(--color-text-secondary);">وسيلة الدفع: <strong style="color:var(--color-text);">${escapeHtml(paymentMethodLabel)}</strong></div>` : ''}
                ${reviewerName ? `<div style="margin-top:.3rem; font-size:.78rem; color:var(--color-text-secondary);">تمت المراجعة بواسطة: <strong style="color:var(--color-text);">${escapeHtml(reviewerName)}</strong>${reviewedAtLabel ? ' - ' + reviewedAtLabel : ''}</div>` : ''}
                ${actionsHtml}
            </div>`;

        document.getElementById('confirmSubBtn')?.addEventListener('click', async () => {
            const btn = document.getElementById('confirmSubBtn');
            const rejectBtn = document.getElementById('rejectSubBtn');
            if (btn) { btn.disabled = true; btn.textContent = 'جاري التأكيد...'; }
            if (rejectBtn) rejectBtn.disabled = true;
            try {
                const result = await confirmPurchaseTicket(ticket.id);
                if (!result.success) throw new Error(result.error || 'حدث خطأ غير متوقع');
                showToast('تم تأكيد الاشتراك وتفعيله بنجاح');
                await loadTickets();
                await showAdminTicketInPanel(ticket.id);
            } catch (err) {
                showToast('فشل تأكيد الاشتراك: ' + err.message, 'error');
                renderPanelActions(ticket, subscription);
            }
        });

        document.getElementById('rejectSubBtn')?.addEventListener('click', async () => {
            const reason = window.prompt('سبب رفض طلب الاشتراك (اختياري):', '');
            if (reason === null) return;
            try {
                const result = await rejectPurchaseTicket(ticket.id, reason.trim());
                if (!result.success) throw new Error(result.error || 'حدث خطأ غير متوقع');
                showToast('تم رفض طلب الاشتراك');
                await loadTickets();
                await showAdminTicketInPanel(ticket.id);
            } catch (err) {
                showToast('فشل رفض الاشتراك: ' + err.message, 'error');
            }
        });
    } else {
        container.innerHTML = '';
    }
}

init();
