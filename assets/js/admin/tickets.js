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
import { adminImpersonateUser } from '/auth-client.js';
import { confirmPurchaseTicket, rejectPurchaseTicket, PLAN_LABELS, BILLING_LABELS } from '/whatsapp-subscription-service.js';
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
            ? new Date(subscription.reviewed_at).toLocaleString('ar-EG', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }) : null;
        const reviewerLine = reviewerName
            ? `<div style="margin-top:.5rem; font-size:.78rem; color:var(--color-text-secondary);">بواسطة: <strong style="color:var(--color-text);">${escapeHtml(reviewerName)}</strong>${reviewedAtLabel ? ' - ' + reviewedAtLabel : ''}</div>` : '';

        if (subscription.status === 'pending') {
            const previousEndLabel = (subscription.is_renewal && subscription.previous_end_date)
                ? `<div style="font-size:.78rem; color:var(--color-text-secondary); margin-bottom:.5rem;">الاشتراك الحالي ينتهي في: <strong style="color:var(--color-text);">${new Date(subscription.previous_end_date).toLocaleString('ar-EG')}</strong></div>` : '';

            container.innerHTML = `
                <div class="detail-block">
                    <div style="font-size:.82rem; color:var(--color-text-secondary); margin-bottom:.5rem;">${renewalBadge}طلب اشتراك: <strong style="color:var(--color-text);">${escapeHtml(planLabel)}</strong> (${escapeHtml(billingLabel)})</div>
                    ${previousEndLabel}
                    <div style="display:flex; gap:.6rem; margin-top:.5rem;">
                        <button id="panelConfirmPurchaseBtn" class="icon-btn" style="flex:1; justify-content:center; background:rgba(34,197,139,.14); color:#22C58B; border-color:rgba(34,197,139,.3);">${ICONS.confirmCheck} تأكيد الاشتراك</button>
                        <button id="panelRejectPurchaseBtn" class="icon-btn" style="flex:1; justify-content:center; background:rgba(255,107,107,.14); color:#FF6B6B; border-color:rgba(255,107,107,.3);">${ICONS.reject} رفض الاشتراك</button>
                    </div>
                </div>`;
            document.getElementById('panelConfirmPurchaseBtn').onclick = () => showConfirmPurchaseModal();
            document.getElementById('panelRejectPurchaseBtn').onclick = () => showRejectPurchaseModal();
        } else if (subscription.status === 'active') {
            container.innerHTML = `
                <div class="detail-block" style="color:#22C58B; font-weight:700;">
                    ${renewalBadge}${ICONS.confirmCheck} تم تأكيد الاشتراك (${escapeHtml(planLabel)} - ${escapeHtml(billingLabel)})
                    <div style="font-weight:400; margin-top:.35rem; font-size:.82rem; color:var(--color-text-secondary);">
                        من ${new Date(subscription.start_date).toLocaleDateString('ar-EG')} إلى ${new Date(subscription.end_date).toLocaleDateString('ar-EG')}
                    </div>
                    ${reviewerLine}
                </div>`;
        } else if (subscription.status === 'rejected') {
            container.innerHTML = `
                <div class="detail-block" style="color:#FF6B6B; font-weight:700;">
                    ${renewalBadge}${ICONS.reject} تم رفض هذا الاشتراك
                    ${subscription.rejection_reason ? `<div style="margin-top:.5rem; font-weight:400; font-size:.82rem; color:var(--color-text-secondary);">السبب: ${escapeHtml(subscription.rejection_reason)}</div>` : ''}
                    ${reviewerLine}
                </div>`;
        } else {
            container.innerHTML = `<div class="detail-block" style="color:var(--color-text-secondary);">حالة الاشتراك: ${escapeHtml(subscription.status)}</div>`;
        }
        return;
    }

    container.innerHTML = `
        <div class="detail-block">
            <label>تغيير حالة التذكرة</label>
            <select id="panelStatusSelect">
                <option value="open" ${ticket.status === 'open' ? 'selected' : ''}>مفتوحة</option>
                <option value="in-progress" ${ticket.status === 'in-progress' ? 'selected' : ''}>قيد المعالجة</option>
                <option value="resolved" ${ticket.status === 'resolved' ? 'selected' : ''}>محلولة</option>
            </select>
        </div>`;

    document.getElementById('panelStatusSelect')?.addEventListener('change', async (e) => {
        const previous = ticket.status;
        try {
            await updateTicketStatus(ticket.id, e.target.value);
            await loadTickets();
            await showAdminTicketInPanel(ticket.id);
        } catch (err) {
            showToast('فشل تحديث الحالة: ' + err.message, 'error');
            e.target.value = previous;
        }
    });
}

async function loadAdminRepliesInPanel(ticketId) {
    const list = document.getElementById('adminPanelRepliesList');
    if (!list) return;
    list.innerHTML = '<div style="text-align:center; padding:1rem; color:var(--color-text-secondary);">جاري تحميل الردود...</div>';

    try {
        const replies = await fetchTicketReplies(ticketId);
        if (replies.length === 0) {
            list.innerHTML = '<p style="text-align:center; color:var(--color-text-secondary); font-size:.85rem; padding:1rem;">لا توجد ردود بعد</p>';
            return;
        }

        list.innerHTML = replies.map(r => {
            const isAdminReply = ['admin', 'support', 'super_user'].includes(r.profiles?.role);
            const displayName = escapeHtml(r.profiles?.full_name || (isAdminReply ? 'فريق الدعم' : 'العميل'));
            const roleTag = isAdminReply ? ' <span style="font-weight:400; color:var(--color-text-secondary);">(فريق الدعم)</span>' : '';
            const cls = r.is_internal ? 'reply-internal' : (isAdminReply ? 'reply-admin' : 'reply-user');
            const internalTag = r.is_internal ? '<span class="internal-tag">ملاحظة داخلية</span> ' : '';

            return `
            <div class="reply-item ${cls}">
                <div style="display:flex; justify-content:space-between; margin-bottom:.4rem; font-size:.72rem;">
                    <strong style="color:var(--color-accent-2);">${internalTag}${displayName}${roleTag}</strong>
                    <span style="color:var(--color-text-secondary);">${new Date(r.created_at).toLocaleString('ar-EG', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })}</span>
                </div>
                <div style="font-size:.85rem; line-height:1.5;">${escapeHtml(r.message)}</div>
            </div>`;
        }).join('');
        list.scrollTop = list.scrollHeight;
    } catch (err) {
        list.innerHTML = '<p style="text-align:center; color:var(--color-danger);">فشل تحميل الردود</p>';
    }
}

async function impersonateUser(id) {
    if (!id) return showToast('لا يمكن الدخول لحساب ضيف', 'error');
    const { data: targetUser } = await supabase.from('profiles').select('email').eq('id', id).single();
    const activityModule = await import('/activity-service.js');
    activityModule.logActivity('impersonate', { target_user_id: id, target_email: targetUser?.email });
    await adminImpersonateUser(id);
    location.href = '/customer-dashboard.html';
}

/* ==================== نافذة إغلاق التذكرة ==================== */

async function closeTicket() {
    if (!currentTicketId) return;
    const comment = document.getElementById('closeTicketComment').value.trim();
    try {
        await closeTicketWithComment(currentTicketId, comment);
        document.getElementById('closeTicketModal').style.display = 'none';
        await loadTickets();
        await showAdminTicketInPanel(currentTicketId);
        showToast('تم إغلاق التذكرة');
    } catch (err) {
        showToast('فشل إغلاق التذكرة: ' + err.message, 'error');
    }
}

function setupModalEvents() {
    const closeTicketModalEl = document.getElementById('closeTicketModal');
    if (closeTicketModalEl) {
        document.getElementById('closeCloseTicketModal')?.addEventListener('click', () => closeTicketModalEl.style.display = 'none');
        document.getElementById('confirmCloseTicket')?.addEventListener('click', closeTicket);
        window.addEventListener('click', (event) => { if (event.target === closeTicketModalEl) closeTicketModalEl.style.display = 'none'; });
    }
}

function showConfirmPurchaseModal() {
    let modal = document.getElementById('confirmPurchaseModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'confirmPurchaseModal';
        modal.style.cssText = 'display:none; position:fixed; z-index:5000; left:0; top:0; width:100%; height:100%; background-color:rgba(3,7,15,.75);';
        modal.innerHTML = `
            <div style="background:#0D1622; border:1px solid rgba(255,255,255,.09); margin:15% auto; padding:1.75rem; border-radius:1rem; width:90%; max-width:420px; font-family:'IBM Plex Sans Arabic',sans-serif; color:#F3F6FB;">
                <h2 style="margin-top:0; color:#8FC7FF;">تأكيد الاشتراك</h2>
                <p style="color:#94A6C2; font-size:.88rem; line-height:1.6;">هل أنت متأكد من تأكيد طلب الاشتراك؟ سيتم تفعيل الخطة للعميل فوراً.</p>
                <div style="display:flex; gap:.75rem; justify-content:flex-end; margin-top:1rem;">
                    <button id="confirmPurchaseCancelBtn" class="icon-btn">إلغاء</button>
                    <button id="confirmPurchaseConfirmBtn" class="icon-btn" style="background:rgba(34,197,139,.14); color:#22C58B; border-color:rgba(34,197,139,.3);">تأكيد</button>
                </div>
            </div>`;
        document.body.appendChild(modal);

        modal.querySelector('#confirmPurchaseConfirmBtn').onclick = async () => {
            const btn = modal.querySelector('#confirmPurchaseConfirmBtn');
            try {
                btn.disabled = true; btn.textContent = 'جاري التأكيد...';
                const result = await confirmPurchaseTicket(currentTicketId);
                if (!result || result.success !== true) {
                    showToast('فشل تأكيد الاشتراك: ' + ((result && result.error) || 'حدث خطأ غير متوقع'), 'error');
                    return;
                }
                modal.style.display = 'none';
                await loadTickets();
                await showAdminTicketInPanel(currentTicketId);
                showToast('تم تأكيد الاشتراك بنجاح');
            } catch (err) {
                showToast('فشل تأكيد الاشتراك: ' + err.message, 'error');
            } finally {
                btn.disabled = false; btn.textContent = 'تأكيد';
            }
        };
        modal.querySelector('#confirmPurchaseCancelBtn').onclick = () => modal.style.display = 'none';
    }
    modal.style.display = 'block';
}

function showRejectPurchaseModal() {
    let modal = document.getElementById('rejectPurchaseModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'rejectPurchaseModal';
        modal.style.cssText = 'display:none; position:fixed; z-index:5000; left:0; top:0; width:100%; height:100%; background-color:rgba(3,7,15,.75);';
        modal.innerHTML = `
            <div style="background:#0D1622; border:1px solid rgba(255,255,255,.09); margin:15% auto; padding:1.75rem; border-radius:1rem; width:90%; max-width:420px; font-family:'IBM Plex Sans Arabic',sans-serif; color:#F3F6FB;">
                <h2 style="margin-top:0; color:#FF6B6B;">رفض الاشتراك</h2>
                <p style="color:#94A6C2; font-size:.88rem;">هل أنت متأكد من رفض طلب الاشتراك؟</p>
                <label style="display:block; margin-bottom:1rem;">
                    <span style="display:block; margin-bottom:.4rem; font-weight:600; font-size:.85rem;">السبب (اختياري):</span>
                    <textarea id="rejectReason" style="width:100%; padding:.6rem; border-radius:.5rem; border:1px solid rgba(255,255,255,.09); background:#0F1A2A; color:#F3F6FB; font-family:inherit; min-height:80px;"></textarea>
                </label>
                <div style="display:flex; gap:.75rem; justify-content:flex-end;">
                    <button id="rejectPurchaseCancelBtn" class="icon-btn">إلغاء</button>
                    <button id="rejectPurchaseConfirmBtn" class="icon-btn" style="background:rgba(255,107,107,.14); color:#FF6B6B; border-color:rgba(255,107,107,.3);">رفض</button>
                </div>
            </div>`;
        document.body.appendChild(modal);

        modal.querySelector('#rejectPurchaseConfirmBtn').onclick = async () => {
            const btn = modal.querySelector('#rejectPurchaseConfirmBtn');
            try {
                btn.disabled = true; btn.textContent = 'جاري الرفض...';
                const reason = modal.querySelector('#rejectReason').value.trim();
                await rejectPurchaseTicket(currentTicketId, reason);
                modal.style.display = 'none';
                modal.querySelector('#rejectReason').value = '';
                await loadTickets();
                await showAdminTicketInPanel(currentTicketId);
                showToast('تم رفض الاشتراك');
            } catch (err) {
                showToast('فشل رفض الاشتراك: ' + err.message, 'error');
            } finally {
                btn.disabled = false; btn.textContent = 'رفض';
            }
        };
        modal.querySelector('#rejectPurchaseCancelBtn').onclick = () => {
            modal.style.display = 'none';
            modal.querySelector('#rejectReason').value = '';
        };
    }
    modal.style.display = 'block';
}

/* ==================== تصدير CSV ==================== */

function csvEscape(value) {
    const str = String(value ?? '');
    if (/[",\n]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
    return str;
}

function exportTicketsToCsv(tickets) {
    const headers = ['رقم التذكرة', 'العنوان', 'الحالة', 'الأولوية', 'التصنيف', 'العميل', 'البريد الإلكتروني', 'الموظف المسؤول', 'الوسوم', 'تاريخ الإنشاء', 'تاريخ الحل', 'مخالفة SLA'];
    const rows = tickets.map(t => [
        t.ticket_number || '',
        t.title || '',
        STATUS_MAP[t.status] || t.status,
        PRIORITY_MAP[t.priority]?.label || t.priority,
        CATEGORY_MAP[t.category || 'other']?.label || t.category,
        t.profiles?.full_name || '',
        t.profiles?.email || '',
        agentName(t.assigned_to) || 'غير معيّنة',
        (ticketTagLinks.get(t.id) || []).map(tg => tg.name).join(' | '),
        new Date(t.created_at).toLocaleString('ar-EG'),
        t.resolved_at ? new Date(t.resolved_at).toLocaleString('ar-EG') : '',
        isSlaBreached(t) ? 'نعم' : 'لا'
    ]);

    const csvContent = '\uFEFF' + [headers, ...rows].map(r => r.map(csvEscape).join(',')).join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tickets-export-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

/* ==================== الإشعارات الصوتية وإشعارات سطح المكتب ==================== */

function playNotificationSound() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.15, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.4);
    } catch (err) { /* تجاهل لو المتصفح مانع تشغيل الصوت تلقائياً */ }
}

function notifyNewTicket(ticket) {
    if (!soundEnabled) return;
    playNotificationSound();
    if ('Notification' in window && Notification.permission === 'granted') {
        new Notification('تذكرة جديدة في مدعوم', {
            body: ticket?.title || 'تم إنشاء تذكرة دعم جديدة',
            icon: '/assets/images/logo.png'
        });
    }
    showToast('تذكرة جديدة: ' + (ticket?.title || ''));
}

function setupNotificationChannel() {
    if (notificationChannel) return;
    notificationChannel = supabase
        .channel('tickets-new-notify')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'tickets' }, (payload) => {
            notifyNewTicket(payload.new);
        })
        .subscribe();
}

/* ==================== اختصارات لوحة المفاتيح ==================== */

function isTypingContext(target) {
    const tag = (target.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || target.isContentEditable;
}

function currentPageTickets() {
    const start = (currentPage - 1) * pageSize;
    return lastFilteredList.slice(start, start + pageSize);
}

function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            document.querySelectorAll('.app-modal-overlay.active').forEach(m => m.classList.remove('active'));
            return;
        }

        if (isTypingContext(document.activeElement) && e.key !== 'Escape') {
            // نسمح فقط بـ Escape جوه حقول الكتابة، الباقي يتجاهل عشان محتفسدش الكتابة العادية
            return;
        }

        if (e.key === '?') { document.getElementById('shortcutsModal')?.classList.add('active'); return; }
        if (e.key === '/') { e.preventDefault(); document.getElementById('searchInput')?.focus(); return; }

        const items = currentPageTickets();
        const idx = items.findIndex(t => t.id === currentTicketId);

        if (e.key === 'j' || e.key === 'J') {
            const next = items[Math.min(idx + 1, items.length - 1)] || items[0];
            if (next) { document.querySelector(`.ticket-card[data-ticket-id="${next.id}"]`)?.scrollIntoView({ block: 'nearest' }); showAdminTicketInPanel(next.id); highlightCard(next.id); }
        } else if (e.key === 'k' || e.key === 'K') {
            const prev = items[Math.max(idx - 1, 0)];
            if (prev) { document.querySelector(`.ticket-card[data-ticket-id="${prev.id}"]`)?.scrollIntoView({ block: 'nearest' }); showAdminTicketInPanel(prev.id); highlightCard(prev.id); }
        } else if (e.key === 'r' || e.key === 'R') {
            if (e.shiftKey) { loadTickets(); showToast('تم تحديث القائمة'); }
            else document.getElementById('adminPanelReplyText')?.focus();
        } else if (e.key === 'e' || e.key === 'E') {
            if (currentTicketId) { updateTicketStatus(currentTicketId, 'resolved').then(() => { loadTickets(); showAdminTicketInPanel(currentTicketId); }); }
        } else if (e.key === 'o' || e.key === 'O') {
            if (currentTicketId) { updateTicketStatus(currentTicketId, 'open').then(() => { loadTickets(); showAdminTicketInPanel(currentTicketId); }); }
        } else if (e.key === 'x' || e.key === 'X') {
            if (currentTicketId) {
                if (selectedTicketIds.has(currentTicketId)) selectedTicketIds.delete(currentTicketId);
                else selectedTicketIds.add(currentTicketId);
                renderPage();
                updateBulkBar();
            }
        }
    });
}

function highlightCard(id) {
    document.querySelectorAll('.ticket-card').forEach(c => c.classList.remove('selected'));
    document.querySelector(`.ticket-card[data-ticket-id="${id}"]`)?.classList.add('selected');
}

/* ==================== إغلاق النوافذ المنبثقة العامة ==================== */

function setupGenericModalClosers() {
    document.querySelectorAll('.app-modal-close').forEach(btn => {
        btn.addEventListener('click', () => btn.closest('.app-modal-overlay')?.classList.remove('active'));
    });
    document.querySelectorAll('.app-modal-overlay').forEach(overlay => {
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.remove('active'); });
    });
}

/* ==================== أزرار الرأس (تصدير، تحديث، اختصارات، إحصائيات، ردود جاهزة، وسوم، صوت) ==================== */

function setupHeaderButtons() {
    document.getElementById('exportCsvBtn')?.addEventListener('click', () => {
        if (!lastFilteredList.length) return showToast('لا توجد تذاكر لتصديرها', 'error');
        exportTicketsToCsv(lastFilteredList);
    });

    document.getElementById('refreshTicketsBtn')?.addEventListener('click', async () => {
        await loadTickets();
        showToast('تم تحديث القائمة');
    });

    document.getElementById('shortcutsBtn')?.addEventListener('click', () => {
        document.getElementById('shortcutsModal')?.classList.add('active');
    });

    document.getElementById('analyticsBtn')?.addEventListener('click', async () => {
        document.getElementById('analyticsModal')?.classList.add('active');
        await renderAnalytics();
    });

    document.getElementById('cannedManageBtn')?.addEventListener('click', () => {
        document.getElementById('cannedModal')?.classList.add('active');
    });

    document.getElementById('tagsManageBtn')?.addEventListener('click', () => {
        document.getElementById('tagsModal')?.classList.add('active');
        renderTagsManagerList();
    });

    document.getElementById('soundToggleBtn')?.addEventListener('click', async (e) => {
        soundEnabled = !soundEnabled;
        localStorage.setItem('mad3oom_tickets_sound', soundEnabled ? 'on' : 'off');
        const btn = e.currentTarget;
        btn.innerHTML = soundEnabled ? `${ICONS.bell} تنبيهات مفعّلة` : `${ICONS.bellOff} تنبيهات متوقفة`;
        btn.classList.toggle('active', soundEnabled);
        if (soundEnabled && 'Notification' in window && Notification.permission === 'default') {
            await Notification.requestPermission();
        }
        if (soundEnabled) playNotificationSound();
    });

    document.getElementById('addCannedBtn')?.addEventListener('click', async () => {
        const title = document.getElementById('cannedTitleInput').value.trim();
        const category = document.getElementById('cannedCategoryInput').value.trim();
        const content = document.getElementById('cannedContentInput').value.trim();
        if (!title || !content) return showToast('العنوان والمحتوى مطلوبان', 'error');
        try {
            await createCannedResponse({ title, content, category });
            document.getElementById('cannedTitleInput').value = '';
            document.getElementById('cannedCategoryInput').value = '';
            document.getElementById('cannedContentInput').value = '';
            await loadCannedResponses();
            renderCannedChips();
            showToast('تمت إضافة الرد الجاهز');
        } catch (err) {
            showToast('فشل الإضافة: ' + err.message, 'error');
        }
    });

    document.getElementById('addTagBtn')?.addEventListener('click', async () => {
        const name = document.getElementById('newTagName').value.trim();
        const color = document.getElementById('newTagColor').value;
        if (!name) return showToast('اسم الوسم مطلوب', 'error');
        try {
            await createTag(name, color);
            document.getElementById('newTagName').value = '';
            await loadTags();
            renderTagsManagerList();
            showToast('تمت إضافة الوسم');
        } catch (err) {
            showToast('فشل إضافة الوسم: ' + err.message, 'error');
        }
    });
}

/* ==================== إدارة الردود الجاهزة والوسوم (نافذتا الإدارة) ==================== */

function renderCannedManagerList() {
    const list = document.getElementById('cannedList');
    if (!list) return;
    if (!cannedResponses.length) {
        list.innerHTML = '<p style="text-align:center; color:var(--color-text-3); font-size:.85rem;">لا توجد ردود جاهزة بعد</p>';
        return;
    }
    list.innerHTML = cannedResponses.map(c => `
        <div class="list-row">
            <div class="list-row-main">
                <div class="list-row-title">${escapeHtml(c.title)}${c.category ? ` <span style="color:var(--color-text-3); font-weight:400;">(${escapeHtml(c.category)})</span>` : ''}</div>
                <div class="list-row-sub">${escapeHtml(c.content)}</div>
            </div>
            ${isAdminRole ? `<button class="icon-action-btn" data-delete-canned="${escapeHtml(c.id)}">${ICONS.trash}</button>` : ''}
        </div>`).join('');

    list.querySelectorAll('[data-delete-canned]').forEach(btn => {
        btn.addEventListener('click', async () => {
            if (!confirm('حذف هذا الرد الجاهز؟')) return;
            try {
                await deleteCannedResponse(btn.dataset.deleteCanned);
                await loadCannedResponses();
                renderCannedChips();
                showToast('تم الحذف');
            } catch (err) {
                showToast('فشل الحذف: ' + err.message, 'error');
            }
        });
    });
}

function renderTagsManagerList() {
    const list = document.getElementById('tagsList');
    if (!list) return;
    if (!allTags.length) {
        list.innerHTML = '<p style="text-align:center; color:var(--color-text-3); font-size:.85rem;">لا توجد وسوم بعد</p>';
        return;
    }
    list.innerHTML = allTags.map(t => `
        <div class="list-row">
            <div class="list-row-main" style="display:flex; align-items:center; gap:.5rem;">
                <span style="width:14px; height:14px; border-radius:50%; background:${t.color}; display:inline-block;"></span>
                <span class="list-row-title">${escapeHtml(t.name)}</span>
            </div>
            ${isAdminRole ? `<button class="icon-action-btn" data-delete-tag="${escapeHtml(t.id)}">${ICONS.trash}</button>` : ''}
        </div>`).join('');

    list.querySelectorAll('[data-delete-tag]').forEach(btn => {
        btn.addEventListener('click', async () => {
            if (!confirm('حذف هذا الوسم من كل التذاكر؟')) return;
            try {
                await deleteTag(btn.dataset.deleteTag);
                await loadTags();
                renderTagsManagerList();
                renderPage();
                showToast('تم حذف الوسم');
            } catch (err) {
                showToast('فشل الحذف: ' + err.message, 'error');
            }
        });
    });
}

/* ==================== لوحة الإحصائيات (Analytics) ==================== */

async function renderAnalytics() {
    const body = document.getElementById('analyticsBody');
    if (!body) return;
    body.innerHTML = 'جاري الحساب...';

    let ratings = [];
    try { ratings = await fetchAllTicketRatings(); } catch (err) { ratings = []; }

    const total = allTickets.length;
    const resolvedTickets = allTickets.filter(t => t.resolved_at);
    const avgResolutionMs = resolvedTickets.length
        ? resolvedTickets.reduce((sum, t) => sum + (new Date(t.resolved_at) - new Date(t.created_at)), 0) / resolvedTickets.length
        : 0;
    const avgResolutionHours = (avgResolutionMs / (1000 * 60 * 60)).toFixed(1);

    const slaBreachCount = allTickets.filter(isSlaBreached).length;
    const slaBreachPct = total ? Math.round((slaBreachCount / total) * 100) : 0;

    const csatAvg = ratings.length ? (ratings.reduce((s, r) => s + r.rating, 0) / ratings.length).toFixed(1) : '—';
    const reopenedCount = allTickets.filter(t => t.reopen_count > 0).length;
    const reopenPct = total ? Math.round((reopenedCount / total) * 100) : 0;

    const byAgent = {};
    allTickets.forEach(t => {
        const key = t.assigned_to || 'unassigned';
        byAgent[key] = (byAgent[key] || 0) + 1;
    });
    const agentRows = Object.entries(byAgent).sort((a, b) => b[1] - a[1]).slice(0, 8);
    const maxAgentCount = Math.max(1, ...agentRows.map(r => r[1]));

    const byCategory = {};
    allTickets.forEach(t => { const k = t.category || 'other'; byCategory[k] = (byCategory[k] || 0) + 1; });
    const categoryRows = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);
    const maxCategoryCount = Math.max(1, ...categoryRows.map(r => r[1]));

    body.innerHTML = `
        <div class="analytics-grid">
            <div class="analytics-mini"><div class="val">${total}</div><div class="lbl">إجمالي التذاكر</div></div>
            <div class="analytics-mini"><div class="val">${avgResolutionHours}</div><div class="lbl">متوسط ساعات الحل</div></div>
            <div class="analytics-mini"><div class="val">${slaBreachPct}%</div><div class="lbl">نسبة مخالفة SLA</div></div>
            <div class="analytics-mini"><div class="val">${csatAvg}</div><div class="lbl">متوسط رضا العملاء (من 5)</div></div>
            <div class="analytics-mini"><div class="val">${reopenPct}%</div><div class="lbl">نسبة إعادة الفتح</div></div>
        </div>

        <h4 style="color:var(--color-text); margin-bottom:.75rem;">التوزيع حسب الموظف</h4>
        ${agentRows.map(([id, count]) => `
            <div class="bar-row">
                <span class="bar-label">${escapeHtml(id === 'unassigned' ? 'غير معيّنة' : (agentName(id) || 'موظف سابق'))}</span>
                <div class="bar-track"><div class="bar-fill" style="width:${(count / maxAgentCount) * 100}%;"></div></div>
                <span class="bar-value">${count}</span>
            </div>`).join('') || '<p style="font-size:.8rem;">لا توجد بيانات</p>'}

        <h4 style="color:var(--color-text); margin:1.25rem 0 .75rem;">التوزيع حسب التصنيف</h4>
        ${categoryRows.map(([cat, count]) => `
            <div class="bar-row">
                <span class="bar-label">${CATEGORY_MAP[cat]?.label || cat}</span>
                <div class="bar-track"><div class="bar-fill" style="width:${(count / maxCategoryCount) * 100}%;"></div></div>
                <span class="bar-value">${count}</span>
            </div>`).join('')}
    `;
}

init();
