import {
    fetchNotificationsPage,
    fetchNotificationTypeCounts,
    markAsRead,
    markAsUnread,
    markAllAsRead,
    formatRelativeArabic,
    subscribeToNotifications
} from '/notifications-service.js';
import { supabase } from '/api-config.js';

const TYPE_META = {
    chat: {
        label: 'محادثة',
        color: '#ec4899',
        icon: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>'
    },
    info: {
        label: 'معلومة',
        color: '#0ea5e9',
        icon: '<circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line>'
    },
    success: {
        label: 'نجاح',
        color: '#10b981',
        icon: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline>'
    },
    subdomain: {
        label: 'نطاق فرعي',
        color: '#8b5cf6',
        icon: '<circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>'
    },
    error: {
        label: 'تنبيه',
        color: '#ef4444',
        icon: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line>'
    }
};
const DEFAULT_TYPE_META = {
    label: 'إشعار',
    color: '#64748b',
    icon: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path>'
};

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

function dayLabel(dateStr) {
    const d = new Date(dateStr);
    const now = new Date();
    const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
    const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);

    if (diffDays === 0) return 'اليوم';
    if (diffDays === 1) return 'أمس';
    if (diffDays < 7) return d.toLocaleDateString('ar-EG', { weekday: 'long' });
    return d.toLocaleDateString('ar-EG', { day: 'numeric', month: 'long', year: 'numeric' });
}

function fullDateTime(dateStr) {
    const d = new Date(dateStr);
    return d.toLocaleString('ar-EG', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const PAGE_SIZE = 12;

const state = {
    status: 'all',
    type: 'all',
    dateFrom: '',
    dateTo: '',
    search: '',
    page: 1,
    totalCount: 0,
    items: [],
    selectedId: null
};

let els = {};

export function initAdminNotificationsPage() {
    els = {
        statusPills: document.querySelectorAll('.notif-status-pill'),
        typeCards: document.querySelectorAll('.notif-type-card'),
        dateFrom: document.getElementById('notifDateFrom'),
        dateTo: document.getElementById('notifDateTo'),
        search: document.getElementById('notifSearch'),
        searchBtn: document.getElementById('notifSearchBtn'),
        resetBtn: document.getElementById('notifResetBtn'),
        markAllBtn: document.getElementById('notifMarkAllBtn'),
        list: document.getElementById('notifList'),
        pagination: document.getElementById('notifPagination'),
        detail: document.getElementById('notifDetail'),
        heroUnread: document.getElementById('notifHeroUnread'),
        heroTotal: document.getElementById('notifHeroTotal')
    };

    if (!els.list) return;

    els.statusPills.forEach(pill => {
        pill.addEventListener('click', () => {
            els.statusPills.forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
            state.status = pill.dataset.status;
            state.page = 1;
            loadAndRender();
        });
    });

    els.typeCards.forEach(card => {
        card.addEventListener('click', () => {
            const clickedType = card.dataset.type;
            const alreadyActive = state.type === clickedType;
            els.typeCards.forEach(c => c.classList.remove('active'));
            state.type = alreadyActive ? 'all' : clickedType;
            if (!alreadyActive) card.classList.add('active');
            state.page = 1;
            loadAndRender();
        });
    });

    els.dateFrom?.addEventListener('change', () => { state.dateFrom = els.dateFrom.value; state.page = 1; loadAndRender(); });
    els.dateTo?.addEventListener('change', () => { state.dateTo = els.dateTo.value; state.page = 1; loadAndRender(); });

    els.searchBtn?.addEventListener('click', () => { state.search = els.search?.value || ''; state.page = 1; loadAndRender(); });
    els.search?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); state.search = els.search.value; state.page = 1; loadAndRender(); }
    });

    els.resetBtn?.addEventListener('click', () => {
        state.status = 'all'; state.type = 'all'; state.dateFrom = ''; state.dateTo = ''; state.search = ''; state.page = 1;
        els.statusPills.forEach(p => p.classList.toggle('active', p.dataset.status === 'all'));
        els.typeCards.forEach(c => c.classList.remove('active'));
        if (els.dateFrom) els.dateFrom.value = '';
        if (els.dateTo) els.dateTo.value = '';
        if (els.search) els.search.value = '';
        loadAndRender();
    });

    els.markAllBtn?.addEventListener('click', async () => {
        els.markAllBtn.disabled = true;
        try {
            await markAllAsRead();
            await loadAndRender();
        } catch (err) {
            console.error('[AdminNotifications] Error marking all as read:', err);
            alert('فشل تحديد الإشعارات كمقروءة');
        } finally {
            els.markAllBtn.disabled = false;
        }
    });

    supabase.auth.getUser().then(({ data: { user } }) => {
        if (user) subscribeToNotifications(user.id, () => loadAndRender());
    });

    renderDetailPlaceholder();
    loadAndRender();
}

async function loadAndRender() {
    renderLoading();

    try {
        const [pageResult, counts] = await Promise.all([
            fetchNotificationsPage({
                status: state.status,
                type: state.type,
                dateFrom: state.dateFrom || null,
                dateTo: state.dateTo || null,
                search: state.search,
                page: state.page,
                pageSize: PAGE_SIZE
            }),
            fetchNotificationTypeCounts()
        ]);

        state.totalCount = pageResult.count;
        state.items = pageResult.data;

        renderHero(counts);
        renderTypeCards(counts.byType);
        renderList(state.items);
        renderPagination();

        // إذا كان العنصر المحدد لم يعد ضمن القائمة الحالية (بعد تغيير فلتر) نفضي لوحة التفاصيل
        if (state.selectedId && !state.items.find(n => n.id === state.selectedId)) {
            state.selectedId = null;
            renderDetailPlaceholder();
        }
    } catch (err) {
        console.error('[AdminNotifications] Error loading notifications:', err);
        if (els.list) {
            els.list.innerHTML = `<div style="padding:3rem 1rem;text-align:center;color:var(--color-danger, #EF4444);">فشل تحميل الإشعارات. حاول مرة أخرى.</div>`;
        }
        if (els.pagination) els.pagination.innerHTML = '';
    }
}

function renderHero(counts) {
    if (els.heroUnread) els.heroUnread.textContent = counts.unread;
    if (els.heroTotal) els.heroTotal.textContent = counts.total;
}

function renderTypeCards(byType) {
    Object.entries(TYPE_META).forEach(([type, meta]) => {
        const countEl = document.querySelector(`.notif-type-card[data-type="${type}"] .notif-type-count`);
        if (countEl) countEl.textContent = byType[type] || 0;
    });
}

function renderLoading() {
    if (!els.list) return;
    els.list.innerHTML = `<div style="padding:2.5rem 1rem;text-align:center;color:var(--color-text-secondary);">جاري تحميل الإشعارات...</div>`;
    if (els.pagination) els.pagination.innerHTML = '';
}

function renderList(notifications) {
    if (!els.list) return;

    if (!notifications.length) {
        els.list.innerHTML = `
            <div style="padding:3rem 1rem;text-align:center;color:var(--color-text-secondary);">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="margin:0 auto 1rem;opacity:0.5;">
                    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
                </svg>
                <p style="font-weight:600;">لا توجد إشعارات مطابقة</p>
                <p style="font-size:0.82rem;margin-top:0.25rem;">جرّب تغيير الفلاتر أو إعادة التعيين</p>
            </div>`;
        return;
    }

    let html = '';
    let lastGroup = null;

    notifications.forEach(n => {
        const group = dayLabel(n.created_at);
        if (group !== lastGroup) {
            html += `<div class="notif-day-header">${group}</div>`;
            lastGroup = group;
        }

        const meta = TYPE_META[n.type] || DEFAULT_TYPE_META;
        const isSelected = n.id === state.selectedId;

        html += `
        <div class="notif-row ${n.is_read ? '' : 'unread'} ${isSelected ? 'selected' : ''}" data-id="${n.id}">
            <div class="notif-row-icon" style="background:${meta.color}1a;">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="${meta.color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${meta.icon}</svg>
            </div>
            <div style="flex:1;min-width:0;">
                <div style="display:flex;justify-content:space-between;align-items:center;gap:0.5rem;">
                    <strong class="notif-row-title">${escapeHtml(n.title)}</strong>
                    ${!n.is_read ? '<span class="notif-unread-dot"></span>' : ''}
                </div>
                <p class="notif-row-message">${escapeHtml(n.message)}</p>
                <span class="notif-row-time">${formatRelativeArabic(n.created_at)}</span>
            </div>
        </div>`;
    });

    els.list.innerHTML = html;

    els.list.querySelectorAll('.notif-row').forEach(row => {
        row.addEventListener('click', () => selectNotification(row.dataset.id));
    });
}

async function selectNotification(id) {
    const notification = state.items.find(n => n.id === id);
    if (!notification) return;

    state.selectedId = id;

    els.list.querySelectorAll('.notif-row').forEach(row => {
        row.classList.toggle('selected', row.dataset.id === id);
    });

    if (!notification.is_read) {
        try {
            await markAsRead(id);
            notification.is_read = true;
            const row = els.list.querySelector(`.notif-row[data-id="${id}"]`);
            row?.classList.remove('unread');
            row?.querySelector('.notif-unread-dot')?.remove();
            if (els.heroUnread) {
                els.heroUnread.textContent = Math.max(0, parseInt(els.heroUnread.textContent || '0', 10) - 1);
            }
        } catch (err) {
            console.error('[AdminNotifications] Error marking as read:', err);
        }
    }

    renderDetail(notification);
}

function renderDetailPlaceholder() {
    if (!els.detail) return;
    els.detail.innerHTML = `
        <div style="height:100%;display:flex;align-items:center;justify-content:center;flex-direction:column;color:var(--color-text-secondary);padding:2rem;text-align:center;">
            <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="margin-bottom:1rem;opacity:0.5;">
                <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/>
            </svg>
            <p style="font-size:1rem;font-weight:600;">اختر إشعاراً لعرض تفاصيله</p>
            <p style="font-size:0.85rem;margin-top:0.4rem;">انقر على أي إشعار من القائمة</p>
        </div>`;
}

function renderDetail(n) {
    if (!els.detail) return;
    const meta = TYPE_META[n.type] || DEFAULT_TYPE_META;
    const link = sanitizeUrl(n.link);

    els.detail.innerHTML = `
        <div style="padding:2rem;height:100%;overflow-y:auto;">
            <div style="display:flex;align-items:center;gap:0.9rem;margin-bottom:1.5rem;">
                <div style="width:52px;height:52px;min-width:52px;border-radius:1rem;background:${meta.color}1a;display:flex;align-items:center;justify-content:center;">
                    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="${meta.color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${meta.icon}</svg>
                </div>
                <div>
                    <span style="font-size:0.72rem;font-weight:700;color:${meta.color};background:${meta.color}14;padding:0.2rem 0.7rem;border-radius:1rem;">${meta.label}</span>
                </div>
            </div>

            <h2 style="margin:0 0 0.75rem 0;font-size:1.3rem;line-height:1.4;">${escapeHtml(n.title)}</h2>

            <p style="line-height:1.8;color:var(--color-text);white-space:pre-wrap;margin-bottom:1.5rem;">${escapeHtml(n.message)}</p>

            <div style="display:flex;flex-wrap:wrap;gap:0.75rem;font-size:0.82rem;color:var(--color-text-secondary);border-top:1px solid var(--color-border);border-bottom:1px solid var(--color-border);padding:1rem 0;margin-bottom:1.5rem;">
                <span>📅 ${fullDateTime(n.created_at)}</span>
                <span>${n.is_read ? '✔ مقروء' : '● غير مقروء'}</span>
            </div>

            <div style="display:flex;gap:0.6rem;flex-wrap:wrap;">
                ${link ? `<a href="${link}" class="btn btn-primary" style="text-decoration:none;">فتح الصفحة المرتبطة</a>` : ''}
                <button id="notifToggleReadBtn" class="btn btn-secondary">${n.is_read ? 'تحديد كغير مقروء' : 'تحديد كمقروء'}</button>
            </div>
        </div>`;

    document.getElementById('notifToggleReadBtn')?.addEventListener('click', async () => {
        try {
            if (n.is_read) {
                await markAsUnread(n.id);
                n.is_read = false;
            } else {
                await markAsRead(n.id);
                n.is_read = true;
            }
            await loadAndRender();
            const stillThere = state.items.find(x => x.id === n.id);
            if (stillThere) renderDetail(stillThere);
        } catch (err) {
            console.error('[AdminNotifications] Error toggling read state:', err);
        }
    });
}

function renderPagination() {
    if (!els.pagination) return;

    const totalPages = Math.max(1, Math.ceil(state.totalCount / PAGE_SIZE));
    if (totalPages <= 1) {
        els.pagination.innerHTML = '';
        return;
    }

    els.pagination.innerHTML = `
        <button id="notifPrevPage" class="btn btn-secondary" ${state.page <= 1 ? 'disabled' : ''}>الصفحة السابقة</button>
        <span style="font-size:0.82rem;color:var(--color-text-secondary);">صفحة ${state.page} من ${totalPages}</span>
        <button id="notifNextPage" class="btn btn-secondary" ${state.page >= totalPages ? 'disabled' : ''}>الصفحة التالية</button>
    `;

    document.getElementById('notifPrevPage')?.addEventListener('click', () => { if (state.page > 1) { state.page -= 1; loadAndRender(); } });
    document.getElementById('notifNextPage')?.addEventListener('click', () => { if (state.page < totalPages) { state.page += 1; loadAndRender(); } });
}
