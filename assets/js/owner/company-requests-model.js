/**
 * company-requests-model.js — الأجزاء الخالصة لقسم «طلبات حسابات الشركات» في owner/stores.html.
 *
 * لا نداءات ولا DOM هنا: فلترة غير-المتاجر، وتسمية الباقة، والتحقق المبدئي من القرار.
 * القرار كله في القاعدة — admin_review_company_account_request (068)؛
 * الرفض بلا سبب يرفضه الخادم، وهذا التحقق لتجربة الاستخدام فقط.
 *
 * طلبات المتاجر الإلكترونية (account_kind = 'ecommerce_store') لا تمر من هنا إطلاقًا:
 * لها قسمها وقرارها في owner_store_requests / owner_store_request_decide في الصفحة نفسها.
 */

export const COMPANY_REQUEST_STATUS_LABELS = Object.freeze({
    pending: 'قيد المراجعة',
    approved: 'تمت الموافقة',
    rejected: 'مرفوض'
});

export const COMPANY_REQUEST_STATUS_TONES = Object.freeze({
    pending: 'status-pending',
    approved: 'status-resolved',
    rejected: 'status-danger'
});

const CYCLE_LABELS = Object.freeze({ monthly: 'شهري', yearly: 'سنوي' });

/** طلب شركة غير متجر — ما يعرضه قسم المالك هنا. المتجر له قسمه الخاص. */
export function isNonStoreCompanyRequest(request) {
    return !!request && request.account_kind !== 'ecommerce_store';
}

/** «الباقة الفائقة (شهري)» — بلا باقة يعيد '—'. */
export function companyRequestPlanLabel(request) {
    if (!request?.requested_plan) return '—';
    const name = request.requested_plan_name_ar || request.requested_plan;
    const cycle = CYCLE_LABELS[request.requested_billing_cycle];
    return cycle ? `${name} (${cycle})` : name;
}

/**
 * تحقق مبدئي من قرار المراجعة — الخادم يعيد التحقق ويرفض بنفسه.
 * الرفض بلا سبب مرفوض في القاعدة (068) ليظهر السبب للعميل في الإشعار.
 */
export function companyRequestReviewError({ decision, note }) {
    if (decision !== 'approve' && decision !== 'reject') return 'قرار غير معروف.';
    if (decision === 'reject' && !String(note || '').trim()) return 'اكتب سبب الرفض — سيظهر للعميل في الإشعار.';
    return null;
}
