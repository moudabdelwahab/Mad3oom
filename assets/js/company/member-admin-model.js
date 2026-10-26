/**
 * member-admin-model.js — منطق عرض إدارة عضو الشركة (113) بلا DOM، مُختبَر في
 * tests/company-member-admin.render.test.mjs. القرار كله في القاعدة (company_member_details وأخواتها)؛
 * هنا الترجمة إلى نصوص وأزرار فقط، فلا زر يمنح ما لا تمنحه القاعدة.
 */

export const JOINED_VIA_LABELS = Object.freeze({
    backfill: 'منذ إنشاء الحساب', legacy: 'أضافته الشركة', invitation: 'دعوة', transfer: 'نقل من شركة أخرى',
    account_request: 'طلب حساب', reactivated: 'أُعيد تفعيله'
});

export const TICKET_STATUS_LABELS = Object.freeze({
    open: 'مفتوحة', 'in-progress': 'قيد المعالجة', resolved: 'محلولة', confirmed: 'مؤكَّدة', rejected: 'مرفوضة', closed: 'مغلقة'
});

const MEMBERSHIP_ACTIONS = Object.freeze({
    joined: 'انضم للشركة', ended: 'انتهت العضوية', primary_set: 'صارت الشركة الأساسية', primary_unset: 'لم تعد الشركة الأساسية',
    invited: 'دُعي', invitation_accepted: 'قبل الدعوة', invitation_declined: 'رفض الدعوة', invitation_cancelled: 'أُلغيت الدعوة',
    context_set: 'اختار سياق الشركة', transfer_requested: 'طلب نقلًا', transferred_out: 'نُقل من الشركة', transferred_in: 'نُقل إلى الشركة',
    member_profile_updated: 'حُدّث ملفه لدى الشركة', member_account_updated: 'حُدّثت بيانات حسابه',
    member_password_reset: 'أُرسل له رابط إعادة كلمة المرور', member_suspended: 'أُوقف مؤقتًا', member_reactivated: 'أُعيد تفعيله',
    member_transfer_requested: 'طُلب نقله لشركة أخرى', member_transfer_cancelled: 'أُلغي طلب نقله',
    member_transfer_approved: 'وافقت المنصة على نقله', member_transfer_rejected: 'رفضت المنصة نقله'
});
const END_CAUSES = Object.freeze({ left: 'غادر', removed: 'أُزيل', transferred: 'نُقل', company_closed: 'أُغلقت الشركة', suspended: 'إيقاف مؤقت' });
const STAFF_ROLES = Object.freeze({ supervisor: 'مشرف', agent: 'موظف دعم' });

/** سطر في سجل العضو. */
export function historyLabel(h) {
    if (h?.kind === 'staff') {
        if (h.action === 'granted') return `مُنح دور ${STAFF_ROLES[h.role_to] || h.role_to || ''}`.trim();
        if (h.action === 'role_changed') return `تغيّر دوره من ${STAFF_ROLES[h.role_from] || '—'} إلى ${STAFF_ROLES[h.role_to] || '—'}`;
        if (h.action === 'revoked') return h.cause === 'left_company' ? 'سقط دوره بمغادرة الشركة' : 'أُلغي دوره في الفريق';
        return 'تغيير في الفريق';
    }
    const base = MEMBERSHIP_ACTIONS[h?.action] || 'حدث';
    return h?.action === 'ended' && END_CAUSES[h.cause] ? `${base} (${END_CAUSES[h.cause]})` : base;
}

const ACCOUNT_REASONS = Object.freeze({
    not_company_created: 'هذا الحساب أنشأه صاحبه (انضم بدعوة)؛ بيانات الدخول يعدّلها بنفسه. يمكنك تعديل ملفه لدى الشركة.',
    not_exclusive: 'الحساب مرتبط بجهات أخرى غير شركتك؛ بيانات الدخول يعدّلها صاحبه. يمكنك تعديل ملفه لدى الشركة.',
    suspended: 'العضو موقوف؛ أعد تفعيله أولًا لتعديل بيانات دخوله.'
});

/** قسم الحساب: هل يُعدَّل، ولماذا لا. */
export function accountEditView(details) {
    const a = details?.account || {};
    if (a.editable === true) return { editable: true, note: 'أنشأت شركتك هذا الحساب: تعديل البريد يغيّر بريد الدخول، ويصل العضوَ إشعار أمني.' };
    return { editable: false, note: ACCOUNT_REASONS[a.not_editable_reason] || 'بيانات الدخول يعدّلها صاحب الحساب.' };
}

const TRANSFER_REASONS = Object.freeze({
    suspended: 'العضو موقوف.',
    pending: 'يوجد طلب نقل معلّق بانتظار قرار إدارة المنصة.',
    staff: 'هذا العضو في فريق الشركة؛ أزل دوره أولًا (النقل للعملاء وحدهم).',
    feature_off: 'نقل الأعضاء بين الشركات غير مفعّل على المنصة حاليًا.',
    not_available: 'لا يمكن طلب نقل هذا العضو من شركتك.'
});

/** قسم النقل. */
export function transferView(details) {
    const t = details?.transfer || {};
    return { canRequest: t.can_request === true, note: t.can_request === true ? null : (TRANSFER_REASONS[t.blocked_reason] || TRANSFER_REASONS.not_available),
             pending: t.pending || null };
}

/** أزرار الإجراءات حسب الحالة (القاعدة ترفض أي شيء آخر على أي حال). */
export function memberActionsView(details) {
    const suspended = details?.state === 'suspended';
    return {
        canSuspend: !suspended,
        canReactivate: suspended,
        canResetPassword: !suspended,
        canEditProfile: true
    };
}

const PHONE_RE = /^\+?[0-9][0-9\s-]{6,18}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateProfileForm({ displayName = '', phone = '', jobTitle = '', notes = '' } = {}) {
    const errors = {};
    if (String(displayName).trim().length > 120) errors.displayName = 'الاسم أطول من 120 حرفًا.';
    if (String(phone).trim() && !PHONE_RE.test(String(phone).trim())) errors.phone = 'رقم الجوال غير صالح.';
    if (String(jobTitle).trim().length > 80) errors.jobTitle = 'المسمى أطول من 80 حرفًا.';
    if (String(notes).trim().length > 2000) errors.notes = 'الملاحظات أطول من 2000 حرف.';
    return { ok: Object.keys(errors).length === 0, errors };
}

export function validateAccountForm({ fullName = '', phone = '', email = '' } = {}, { hadPhone = false } = {}) {
    const errors = {};
    const name = String(fullName).trim();
    if (name.length < 2 || name.length > 120) errors.fullName = 'الاسم مطلوب (2 إلى 120 حرفًا).';
    const p = String(phone).trim();
    if (!p && hadPhone) errors.phone = 'رقم الجوال لا يُحذف لأنه يوثّق الحساب؛ أدخل الرقم الجديد بدلًا منه.';
    else if (p && !PHONE_RE.test(p)) errors.phone = 'رقم الجوال غير صالح.';
    const e = String(email).trim();
    if (!EMAIL_RE.test(e) || e.length > 320) errors.email = 'بريد إلكتروني غير صالح.';
    return { ok: Object.keys(errors).length === 0, errors };
}

export function validateReason(value, min = 10) {
    const v = String(value || '').trim();
    if (v.length < min) return `السبب مطلوب (${min} أحرف على الأقل).`;
    if (v.length > 500) return 'السبب أطول من 500 حرف.';
    return null;
}

export function validateTransferForm({ destRef = '', reason = '' } = {}) {
    const errors = {};
    const ref = String(destRef).trim();
    if (ref.length < 2 || ref.length > 320) errors.destRef = 'أدخل رقم السجل التجاري أو بريد الشركة الوجهة.';
    const r = validateReason(reason);
    if (r) errors.reason = r;
    return { ok: Object.keys(errors).length === 0, errors };
}

export const TRANSFER_STATUS_LABELS = Object.freeze({
    pending: { label: 'بانتظار المنصة', pill: 'status-tone-warning' },
    approved: { label: 'تم النقل', pill: 'status-tone-success' },
    rejected: { label: 'مرفوض', pill: 'status-tone-danger' },
    cancelled: { label: 'ملغى', pill: 'status-neutral' },
    expired: { label: 'منتهٍ', pill: 'status-neutral' }
});
export const transferStatusInfo = (s) => TRANSFER_STATUS_LABELS[s] || { label: s || '—', pill: 'status-neutral' };
