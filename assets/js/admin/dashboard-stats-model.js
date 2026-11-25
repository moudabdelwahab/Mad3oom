/**
 * dashboard-stats-model.js — عدّادات لوحة الإدارة، دوال خالصة بلا DOM وبلا Supabase.
 *
 * الحالات الحقيقية للتذاكر (tickets_status_check في الشكل الحي):
 * open / in-progress / resolved / confirmed / rejected / closed.
 * «المغلقة» حالة مستقلة (closed) وليست مرادفًا لـ «المحلولة» (resolved).
 * «معدل الاستجابة» = التذاكر التي لها أول رد فعلًا (first_response_at
 * يكتبه محفِّز القاعدة track_first_response عند أول رد من الفريق)،
 * لا أي تذكرة ليست open.
 */

export const TICKET_STATUSES = ['open', 'in-progress', 'resolved', 'confirmed', 'rejected', 'closed'];

export function countTicketStatuses(tickets) {
    const counts = { total: 0, open: 0, inProgress: 0, resolved: 0, confirmed: 0, rejected: 0, closed: 0 };
    for (const t of tickets || []) {
        counts.total += 1;
        if (t.status === 'open') counts.open += 1;
        else if (t.status === 'in-progress') counts.inProgress += 1;
        else if (t.status === 'resolved') counts.resolved += 1;
        else if (t.status === 'confirmed') counts.confirmed += 1;
        else if (t.status === 'rejected') counts.rejected += 1;
        else if (t.status === 'closed') counts.closed += 1;
    }
    return counts;
}

/** نسبة مئوية صحيحة 0..100؛ بلا تذاكر = 0 لا قسمة على صفر. */
export function computeResponseRate(total, responded) {
    if (!total || total <= 0) return 0;
    return Math.round((Math.min(responded, total) / total) * 100);
}

/** عدد التذاكر التي لها أول رد فعلًا (first_response_at مكتوب من القاعدة). */
export function countRespondedTickets(tickets) {
    return (tickets || []).filter((t) => t.first_response_at != null).length;
}

export function responseRateFromTickets(tickets) {
    const list = tickets || [];
    return computeResponseRate(list.length, countRespondedTickets(list));
}
