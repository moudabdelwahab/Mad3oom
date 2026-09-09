/**
 * ticket-view-model.js — لغة التذاكر كما يراها العميل.
 *
 * قاعدة البيانات بتخزّن 5 حالات داخلية:
 *   open · in-progress · resolved · confirmed · rejected
 * (اتأكدنا منها من قيم tickets.status الفعلية ومن فلتر admin/tickets.html)
 *
 * العميل مش محتاج يفهم الفرق بين "resolved" و"confirmed" — دول تفصيل تشغيلي
 * عند فريق الدعم. فبنعرّف هنا طبقة عرض واحدة:
 *   • تسمية ولون لكل حالة داخلية.
 *   • "مجموعات" (views) بالمعنى اللي يهم العميل: الكل / مفتوحة /
 *     بانتظار ردّك / مغلقة.
 *
 * كل شاشة بتقرا من هنا، فمفيش نسختين من نفس المنطق بين مؤشرات النظرة العامة
 * وقائمة التذاكر والفلاتر.
 */

/** الحالات الداخلية كما تُعرض للعميل. */
export const TICKET_STATUS = Object.freeze({
    'open':        { label: 'مفتوحة',        pill: 'status-open',        closed: false },
    'in-progress': { label: 'قيد المعالجة',  pill: 'status-in-progress', closed: false },
    'resolved':    { label: 'تم الحل',       pill: 'status-resolved',    closed: true  },
    'confirmed':   { label: 'مكتملة',        pill: 'status-confirmed',   closed: true  },
    'rejected':    { label: 'مرفوضة',        pill: 'status-rejected',    closed: true  }
});

const UNKNOWN_STATUS = { label: 'غير محددة', pill: 'status-neutral', closed: false };

export function statusInfo(status) {
    return TICKET_STATUS[status] || UNKNOWN_STATUS;
}

export function isClosed(ticket) {
    return statusInfo(ticket?.status).closed;
}

/**
 * التذكرة "بانتظار ردّك" لما يكون آخر مَن حدّثها شخص غير العميل وهي لسه مفتوحة.
 * ده أهم تمييز في بوابة الدعم: بيقول للعميل إن الكرة في ملعبه.
 */
export function needsCustomerReply(ticket, userId) {
    if (!ticket || isClosed(ticket)) return false;
    return !!ticket.last_updated_by && ticket.last_updated_by !== userId;
}

/**
 * مجموعات العرض. كل واحدة لها predicate واحد يُستخدم في العدّ والتصفية معًا،
 * فالرقم اللي في التبويب هو بالظبط عدد الصفوف اللي هتظهر تحته.
 */
export const TICKET_VIEWS = Object.freeze([
    {
        key: 'all',
        label: 'كل التذاكر',
        hint: 'كل تذاكرك على المنصة',
        match: () => true
    },
    {
        key: 'open',
        label: 'مفتوحة',
        hint: 'تذاكر ما زال العمل عليها جاريًا',
        match: (t) => !isClosed(t)
    },
    {
        key: 'awaiting',
        label: 'بانتظار ردّك',
        hint: 'ردّ فريق الدعم ولم تردّ بعد',
        match: (t, userId) => needsCustomerReply(t, userId)
    },
    {
        key: 'closed',
        label: 'مغلقة',
        hint: 'تذاكر تم حلّها أو إغلاقها',
        match: (t) => isClosed(t)
    }
]);

export function viewByKey(key) {
    return TICKET_VIEWS.find(v => v.key === key) || TICKET_VIEWS[0];
}

/** يطبّق مجموعة + بحث نصّي على قائمة التذاكر (كله محلي، بدون استعلام إضافي). */
export function applyTicketView(tickets, { view = 'all', search = '', userId } = {}) {
    const matcher = viewByKey(view).match;
    const term = (search || '').trim().toLowerCase();

    return (tickets || []).filter(ticket => {
        if (!matcher(ticket, userId)) return false;
        if (!term) return true;
        const number = String(ticket.ticket_number ?? '');
        return (ticket.title || '').toLowerCase().includes(term)
            || (ticket.description || '').toLowerCase().includes(term)
            || number.includes(term);
    });
}

/** عدد التذاكر في كل مجموعة — مصدر أرقام التبويبات والمؤشرات. */
export function countByView(tickets, userId) {
    const counts = {};
    for (const view of TICKET_VIEWS) {
        counts[view.key] = (tickets || []).filter(t => view.match(t, userId)).length;
    }
    return counts;
}

/**
 * هل يُسمح بإعادة فتح التذكرة؟
 *
 * إعادة الفتح صارت **إجراءً صريحًا** بزرّ مستقل، تنفّذه دالة القاعدة
 * reopen_ticket_in_my_scope (الترحيل 034). قبل ذلك كان مجرد الردّ على تذكرة
 * محلولة يعيد فتحها تلقائيًا عبر محفّز — وهو ما أُلغي: من يضيف معلومة على
 * تذكرة مغلقة لا يريد بالضرورة إعادتها إلى طابور الدعم.
 *
 * الحدّ هنا مطابق لحدّ الدالة حرفيًا: 'confirmed' و'rejected' نتيجتا قرار
 * (شراء تم تأكيده / طلب رُفض)، وإعادتهما بضغطة نقضٌ لقرار لا إعادة فتح.
 */
export function canReopen(ticket) {
    return ticket?.status === 'resolved';
}

/**
 * هل يُسمح بإغلاق التذكرة؟ نفس حدّ close_ticket_in_my_scope في القاعدة.
 * الواجهة لا تعرض إجراءً ترفضه القاعدة، ولا تخفي إجراءً تقبله.
 */
export function canClose(ticket) {
    return ticket?.status === 'open' || ticket?.status === 'in-progress';
}

/** الإجراءات المتاحة على التذكرة حسب حالتها — الواجهة بتعرض دي فقط. */
export function availableActions(ticket, { userId, ratingAllowed = true } = {}) {
    return {
        // الردّ متاح على أي حالة: سياسة الإدراج في القاعدة لا تنظر للحالة،
        // والقرار المنتَجي صريح — الردّ على تذكرة مغلقة مسموح **ولا يفتحها**.
        canReply: true,
        canReopen: canReopen(ticket),
        canClose: canClose(ticket),
        canRate: ratingAllowed && ticket?.status === 'resolved',
        needsReply: needsCustomerReply(ticket, userId),
        canArchive: true
    };
}
