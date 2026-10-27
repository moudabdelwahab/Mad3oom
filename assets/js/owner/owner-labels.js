/**
 * owner-labels.js — نصوص العرض لقيم القاعدة في صفحات لوحة المالك، وقرارات العرض الخالصة.
 *
 * القيم نفسها قيود في القاعدة (profiles_role_check، tickets_status_check، whatsapp_subscriptions_status_check)؛
 * هنا تسمياتها فقط. قيمة لا تعرفها الخريطة تُعرض كما هي بدل أن تختفي.
 * ملف خالص بلا DOM ولا شبكة — يُختبر مباشرةً في node (tests/owner-pages.test.mjs).
 */

export const ROLE_LABELS = Object.freeze({
    platform_owner: 'مالك المنصة',
    admin: 'إداري',
    support: 'فريق الدعم',
    company_admin: 'مدير شركة',
    company_user: 'عضو شركة',
    user: 'مستخدم',
    customer: 'عميل'
});

/** رتب فريق المنصة: حظرها وفكّ قفلها يتطلبان owner_critical_ok() (guard_privileged_accounts). */
export const STAFF_ROLES = Object.freeze(['admin', 'support']);

export const TICKET_STATUS_LABELS = Object.freeze({
    open: 'مفتوحة',
    'in-progress': 'قيد المعالجة',
    resolved: 'محلولة',
    confirmed: 'مؤكدة',
    rejected: 'مرفوضة',
    closed: 'مغلقة'
});

export const TICKET_STATUS_TONES = Object.freeze({
    open: 'status-open', 'in-progress': 'status-in-progress', resolved: 'status-resolved',
    confirmed: 'status-confirmed', rejected: 'status-rejected', closed: 'status-neutral'
});

export const PRIORITY_LABELS = Object.freeze({ high: 'عالية', medium: 'متوسطة', low: 'منخفضة' });

export const SCOPE_LABELS = Object.freeze({ mad3oom_support: 'دعم مدعوم', company: 'شركة' });

export const SUB_STATUS_LABELS = Object.freeze({
    active: 'فعّال',
    pending: 'بانتظار المراجعة',
    expired: 'منتهٍ',
    rejected: 'مرفوض',
    superseded: 'مُستبدَل بترقية'
});

export const SUB_STATUS_TONES = Object.freeze({
    active: 'status-resolved', pending: 'status-pending', expired: 'status-neutral',
    rejected: 'status-rejected', superseded: 'status-neutral'
});

/** أسماء مفهومة لأحداث activity-service.js؛ الحدث غير المعروف يُعرض باسمه كما سُجّل. */
export const ACTION_LABELS = Object.freeze({
    login: 'تسجيل دخول', logout: 'تسجيل خروج', ticket_created: 'إنشاء تذكرة', ticket_reply: 'رد على تذكرة',
    status_change: 'تغيير حالة تذكرة', profile_updated: 'تحديث الملف', password_changed: 'تغيير كلمة المرور',
    impersonate: 'دخول كعضو', ban_user: 'حظر حساب', unban_user: 'رفع حظر', unlock_user: 'فكّ قفل حساب',
    admin_updated_user: 'تعديل حساب من الإدارة', report_submitted: 'بلاغ مكافأة'
});

export const label = (map, key) => map[key] || key || '—';

/** قيم ban_status التي تعني قيدًا قائمًا — مكمّل UNRESTRICTED_BAN_STATUSES في account-status.js. */
export const RESTRICTED_BAN_STATUSES = Object.freeze(['banned', 'permanent', 'temporary']);

/**
 * انتقالات حالة الاشتراك المسموحة — نسخة طبق الأصل من شرط admin_set_subscription_status() في القاعدة:
 *   active→expired · expired→active · pending→active|rejected
 * الواجهة تعرض أزرار هذه وحدها؛ والقاعدة ترفض غيرها مهما أُرسل.
 */
export const SUBSCRIPTION_TRANSITIONS = Object.freeze({
    active: Object.freeze([{ to: 'expired', label: 'تعطيل', tone: 'btn-danger' }]),
    expired: Object.freeze([{ to: 'active', label: 'إعادة تفعيل', tone: 'btn-primary', needsEndDate: true }]),
    pending: Object.freeze([
        { to: 'active', label: 'قبول وتفعيل', tone: 'btn-primary', needsEndDate: true },
        { to: 'rejected', label: 'رفض', tone: 'btn-danger' }
    ])
});

export function subscriptionActions(status) {
    return SUBSCRIPTION_TRANSITIONS[status] || [];
}

/**
 * التحقق من نموذج تغيير حالة الاشتراك قبل النداء. يعيد رسالة خطأ أو null.
 * السبب إلزامي هنا (يُكتب في subscription_audit_log)، والتفعيل يحتاج تاريخ انتهاء مستقبليًا — نفس شرط القاعدة.
 */
export function subscriptionChangeError({ to, reason, endDate, currentEnd }, now = new Date()) {
    if (String(reason || '').trim().length < 5) return 'اكتب سببًا واضحًا (5 أحرف على الأقل) — يُسجَّل مع التغيير.';
    if (to === 'active') {
        const end = endDate ? new Date(endDate) : (currentEnd ? new Date(currentEnd) : null);
        if (!end || Number.isNaN(end.getTime()) || end <= now) return 'التفعيل يحتاج تاريخ انتهاء في المستقبل.';
    }
    return null;
}

/**
 * نص بحث آمن لمرشّح PostgREST (or=…ilike.*نص*). المحارف المحجوزة في صياغة المرشّح (, . داخل القيمة
 * مسموحة، أما , ( ) : " فتفصل الشروط أو تقتبسها) ومحارف النمط (* % \) تُحذف — فلا يغيّر المُدخَل بنية الاستعلام.
 */
export function searchTerm(value) {
    return String(value || '').replace(/[,()*%\\:"]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
}

/** حدود صفحة الترقيم (range شامل في PostgREST). */
export function pageRange(page, size) {
    const p = Math.max(0, Number(page) || 0);
    return [p * size, p * size + size - 1];
}

export function pagerText(page, size, total) {
    if (!total) return '';
    const from = page * size + 1;
    const to = Math.min(total, (page + 1) * size);
    return `${from.toLocaleString('ar-EG')}–${to.toLocaleString('ar-EG')} من ${Number(total).toLocaleString('ar-EG')}`;
}
