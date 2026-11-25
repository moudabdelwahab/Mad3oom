/**
 * tickets-page-model.js — ترقيم التذاكر على الخادم، دوال خالصة بلا DOM.
 *
 * القاعدة: لا تُجلب كل التذاكر أبدًا. الصفحة تُطلب بـ .range() مع count دقيق،
 * والفلاتر الدقيقة (الحالة/الأولوية/التصنيف/المسؤول/البحث بالعنوان أو الرقم)
 * تُدفع للخادم. ما لا يستطيع الخادم تصفيته بدقة (الوسم، والبحث باسم العميل
 * أو بريده أو نص التذكرة، وفلاتر SLA/بلا مسؤول السريعة) يُصفَّى على الصفحة
 * المحمّلة فقط — انظر loadTickets في admin/tickets.js.
 */

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/** نطاق PostgREST للصفحة: ‎.range(from, to)‎ شامل الطرفين. */
export function pageRange(page, pageSize) {
    const size = clampPageSize(pageSize);
    const p = Math.max(1, Math.floor(page) || 1);
    return { from: (p - 1) * size, to: p * size - 1, page: p, pageSize: size };
}

export function clampPageSize(value) {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_PAGE_SIZE;
    return Math.min(n, MAX_PAGE_SIZE);
}

/** عدد الصفحات من العدد الإجمالي الدقيق. */
export function totalPages(totalCount, pageSize) {
    return Math.max(1, Math.ceil((totalCount || 0) / clampPageSize(pageSize)));
}

/**
 * يطبّق فلاتر الخادم على مبنّي استعلام Supabase (أو بديل اختباري يسجّل
 * الاستدعاءات)، ويرجع المبنّي نفسه للتسلسل.
 * حالة الفلتر كما تأتي من getCurrentFilterState() في admin/tickets.js.
 */
export function applyTicketServerFilter(query, state, currentUserId) {
    let q = query;
    if (state.status && state.status !== 'all') q = q.eq('status', state.status);
    if (state.priority && state.priority !== 'all') q = q.eq('priority', state.priority);
    if (state.category && state.category !== 'all') q = q.eq('category', state.category);
    if (state.assignee === 'unassigned') q = q.is('assigned_to', null);
    else if (state.assignee === 'me' && currentUserId) q = q.eq('assigned_to', currentUserId);
    else if (state.assignee && state.assignee !== 'all') q = q.eq('assigned_to', state.assignee);

    const search = (state.search || '').trim();
    if (search) {
        if (/^\d+$/.test(search)) {
            // رقم تذكرة أو كلمة في العنوان.
            q = q.or(`title.ilike.%${search}%,ticket_number.eq.${search}`);
        } else {
            q = q.ilike('title', `%${search}%`);
        }
    }

    if (state.sort === 'oldest') q = q.order('created_at', { ascending: true });
    else q = q.order('created_at', { ascending: false });
    return q;
}
