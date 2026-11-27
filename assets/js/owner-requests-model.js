/**
 * تبويب «الطلبات» المجمّع في لوحة المالك (الترحيل 142) — منطق خالص بلا
 * DOM ولا شبكة: تسميات الأنواع والمصادر والحالات، وترشيح الصفوف، وعدّاد
 * المعلّقة. القراءة نفسها من دالة القاعدة owner_list_requests — UNION
 * على الجداول القائمة وحدها، بلا جدول جديد.
 *
 * التسمية: التعويض يغطي كل الباقات المدفوعة (المتقدمة والفائقة
 * والواتساب والشاملة)؛ وباقة المتجر ليست منها.
 * التعويض يظهر مرة واحدة كمصدر واحد (شركات) رغم أنه طلب عميل على خطته.
 * طلب المتجر الإلكتروني المعلّق هو الصف نفسه في طلبات حساب الشركة،
 * وتشير راية in_store_queue إلى وجوده في قائمة المتاجر.
 */

/** أنواع الطلبات الخمسة — كما ترجّعها دالة التجميع. */
export const REQUEST_TYPES = ['company_account', 'trial', 'refund', 'deletion', 'suggestion'];

export const REQUEST_TYPE_LABELS = {
    company_account: 'إنشاء حساب شركة',
    trial: 'تجربة مجانية',
    refund: 'تعويض إلغاء الاشتراك',
    deletion: 'حذف حساب',
    suggestion: 'اقتراح'
};

/** مصادر الطلبات الثلاثة — كما ترجّعها دالة التجميع. */
export const REQUEST_SOURCES = ['companies', 'management', 'customers'];

export const REQUEST_SOURCE_LABELS = {
    companies: 'طلبات الشركات',
    management: 'طلبات الإدارة',
    customers: 'طلبات العملاء'
};

/** المصدر الافتراضي لكل نوع — احتياط إن غاب حقل source عن الصف. */
export const REQUEST_TYPE_SOURCE = {
    company_account: 'companies',
    trial: 'companies',
    refund: 'companies',
    deletion: 'customers',
    suggestion: 'management'
};

/** الحالات الخام كما في جداولها — اتحاد حالات الأنواع الخمسة. */
export const REQUEST_STATUS_OPTIONS = [
    '', 'pending', 'approved', 'rejected', 'paid', 'closed', 'expired',
    'cancelled', 'executed', 'reviewed', 'implemented'
];

export const REQUEST_STATUS_LABELS = {
    pending: 'معلّق',
    approved: 'موافَق عليه',
    rejected: 'مرفوض',
    paid: 'مدفوع',
    closed: 'مغلق (تراجع العميل)',
    expired: 'منتهٍ',
    cancelled: 'ملغى',
    executed: 'منفَّذ',
    reviewed: 'قيد المراجعة',
    implemented: 'مطبَّق'
};

/** هل النوع من الأنواع الخمسة؟ */
export function isRequestType(type) {
    return REQUEST_TYPES.includes(type);
}

/** هل الحالة من حالات الأنواع الخمسة؟ */
export function isRequestStatus(status) {
    return status !== '' && REQUEST_STATUS_OPTIONS.includes(status);
}

/** مصدر الصف — حقل الخادم أولًا، ثم الافتراضي لنوعه. */
export function requestSource(row) {
    if (!row) return '';
    if (row.source && REQUEST_SOURCE_LABELS[row.source]) return row.source;
    return REQUEST_TYPE_SOURCE[row.type] || '';
}

/** تسمية النوع العربي — عنوان الصف نفسه أسبق إن وُجد. */
export function requestTypeLabel(row) {
    if (!row) return '';
    return REQUEST_TYPE_LABELS[row.type] || row.type || '';
}

/** تسمية الحالة العربية. */
export function requestStatusLabel(row) {
    if (!row) return '';
    return REQUEST_STATUS_LABELS[row.status] || row.status || '';
}

/** ترشيح الصفوف محليًا — على نمط trials.js (القراءة مرة واحدة بلا مرشّحات). */
export function filterRequests(rows, { type = '', source = '', status = '' } = {}) {
    const list = Array.isArray(rows) ? rows : [];
    return list.filter((row) =>
        (type === '' || row.type === type)
        && (source === '' || requestSource(row) === source)
        && (status === '' || row.status === status));
}

/** عدد الطلبات المعلّقة في المجموعة كلها. */
export function countPending(rows) {
    const list = Array.isArray(rows) ? rows : [];
    return list.filter((row) => row.status === 'pending').length;
}

/** المعلّقة حسب المصدر — للمؤشرات الأربعة في الصفحة. */
export function countPendingBySource(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const out = { total: 0, companies: 0, management: 0, customers: 0 };
    for (const row of list) {
        if (row.status !== 'pending') continue;
        out.total += 1;
        const source = requestSource(row);
        if (source in out) out[source] += 1;
    }
    return out;
}

/** عرض مبلغ التعويض — null إن لم يكن للصف مبلغ (كل الأنواع عدا التعويض). */
export function requestAmountText(row) {
    if (!row || row.amount === null || row.amount === undefined || row.amount === '') return null;
    return `${row.amount} ${row.currency || 'EGP'}`;
}
