/**
 * customers-model.js — الأجزاء الخالصة لصفحتي «إدارة العملاء» و«طلبات الحسابات» (migrations/105).
 *
 * لا نداءات ولا DOM هنا: تسميات، وبناء فلاتر الخادم، وترجمة رموز الرفض، والتحقق المبدئي من النماذج.
 * القرار كله في القاعدة — هذا التحقق لتجربة الاستخدام فقط، والخادم يعيده ويرفض بنفسه.
 */

export const VIEWS = Object.freeze([
    { key: 'all', label: 'كل العملاء' },
    { key: 'direct', label: 'عملاء المنصة المباشرون' },
    { key: 'company', label: 'عملاء الشركات' },
    { key: 'by_manager', label: 'حسب مدير الحساب' },
    { key: 'pending_transfer', label: 'بانتظار نقل' },
    { key: 'suspended', label: 'موقوفون' }
]);

export const ACCOUNT_TYPES = Object.freeze({
    direct: 'عميل مباشر للمنصة',
    company_customer: 'عميل شركة',
    direct_and_company: 'مباشر + عميل شركة',
    company_owner: 'مالك شركة',
    company_staff: 'موظف شركة',
    unclassified: 'غير مصنّف'
});

export const STATUS_LABELS = Object.freeze({ active: 'نشط', suspended: 'موقوف' });

export const SORTS = Object.freeze([
    { key: 'created_at:desc', label: 'الأحدث أولًا' },
    { key: 'created_at:asc', label: 'الأقدم أولًا' },
    { key: 'full_name:asc', label: 'الاسم (أ ← ي)' },
    { key: 'email:asc', label: 'البريد (أ ← ي)' }
]);

export const PAGE_SIZES = Object.freeze([25, 50, 100]);

export const REQUEST_TYPES = Object.freeze({
    add_to_company: 'إضافة عميل قائم إلى شركة',
    transfer_direct_to_company: 'نقل عميل مباشر إلى شركة'
});

export const REQUEST_STATUS = Object.freeze({
    pending: 'قيد القرار',
    approved: 'تمت الموافقة',
    rejected: 'مرفوض',
    cancelled: 'ملغى'
});

export const MEMBERSHIP_VIA = Object.freeze({
    backfill: 'ملء أولي', legacy: 'ربط قديم', invitation: 'دعوة', transfer: 'نقل', account_request: 'طلب حساب'
});

export const END_CAUSES = Object.freeze({
    reassigned: 'أُسند لغيره', unassigned: 'أُلغي الإسناد', manager_ineligible: 'المدير فقد الأهلية',
    customer_deleted: 'حُذف الحساب', manager_deleted: 'حُذف حساب المدير',
    left: 'غادر', removed: 'أُزيل', transferred: 'نُقل', company_closed: 'أُغلقت الشركة'
});

// شروط الطلب كما يعيدها الخادم (_account_request_checks) بأسماء مفهومة
export const CHECK_LABELS = Object.freeze({
    customer_exists: 'الحساب موجود',
    email_unambiguous: 'بريد الملف يطابق بريد الدخول',
    email_matches: 'البريد المُدخل يطابق بريد الحساب',
    target_email_valid: 'البريد الآخر بصيغة صحيحة',
    target_email_unclaimed: 'البريد الآخر لا يخص حسابًا آخر',
    customer_is_customer: 'الحساب حساب عميل (ليس طاقمًا ولا مالك شركة)',
    customer_active: 'الحساب غير موقوف',
    customer_is_direct: 'العميل عميل مباشر للمنصة',
    company_exists: 'الشركة موجودة',
    company_active: 'الشركة نشطة',
    not_company_owner: 'العميل ليس مالك الشركة',
    not_already_member: 'العميل ليس عضوًا فيها بالفعل',
    no_pending_transfer: 'لا نقل معلّق للعميل',
    no_conflicting_request: 'لا طلب آخر معلّق للعميل',
    requester_eligible: 'مقدّم الطلب ما زال إداريًا غير موقوف',
    no_active_personal_subscription: 'لا اشتراك شخصي نشط أو معلّق (وإلا تنتقل حصته لخطة الشركة)'
});

// ما يحدث فعلًا لكل فئة بيانات عند التنفيذ (owner_account_request_details.impact، 106)
export const IMPACT_LABELS = Object.freeze({
    membership: { primary: 'يصبح عضوًا في الشركة كشركة أساسية', secondary: 'يصبح عضوًا في الشركة كشركة إضافية (أساسيته لا تتغير)' },
    direct_relationship: { ended: 'تنتهي علاقته المباشرة بالمنصة (تبقى في السجل)', kept: 'تبقى علاقته المباشرة بالمنصة' },
    platform_account_manager: { ended: 'ينتهي إسناد مدير حسابه على المنصة (يبقى في السجل)', kept: 'مدير حسابه على المنصة لا يتغير' },
    ticket_quota_owner: { company: 'حصة تذاكره الجديدة على خطة الشركة', unchanged: 'حصة تذاكره لا تتغير' },
    historical_tickets: { stay_private: 'تذاكره السابقة تبقى خاصة به ولا تراها الشركة' },
    conversations_and_attachments: { stay_private: 'محادثاته ومرفقاته السابقة تبقى خاصة به' },
    notifications: { unchanged: 'إشعاراته في مكانها' },
    subscriptions: { stay_with_customer: 'اشتراكاته تبقى باسمه (لا نقل ولا إلغاء)' },
    api_tokens_and_integrations: { unchanged: 'رموز الربط والتكاملات تبقى له' },
    login_identity: { unchanged: 'نفس الحساب وبيانات الدخول — لا حساب جديد' }
});

export function impactLines(impact) {
    if (!impact) return [];
    return Object.entries(IMPACT_LABELS).map(([k, m]) => m[impact[k]]).filter(Boolean);
}

/** طلب قيد القرار فشل تنفيذه آخر مرة: قابل لإعادة المحاولة أو الرفض. */
export function isFailedRecoverable(row) {
    return !!row && row.status === 'pending' && !!row.last_failure;
}

export function failureText(failure) {
    if (!failure) return '';
    if (failure.code === 'revalidation_failed' && failure.check) {
        return `تغيّر حال العميل أو الشركة: لم يتحقق «${CHECK_LABELS[failure.check] || failure.check}». لم يتغير شيء.`;
    }
    if (failure.code === 'prerequisite_not_enabled') {
        const missing = (failure.missing || []).map(k => SWITCH_LABELS[k] || k).join('، ');
        return `التنفيذ غير متاح بعد${missing ? ` (يتطلب: ${missing})` : ''}. لم يتغير شيء.`;
    }
    return 'تعذّر التنفيذ ولم يتغير شيء. يمكن إعادة المحاولة أو رفض الطلب.';
}

/** نص النتيجة بعد القرار — من رد الخادم وحده، لا يُفترض نجاح لم يؤكده. */
export function decisionResultText(result) {
    if (!result) return '';
    if (result.status === 'rejected') return 'رُفض الطلب.';
    if (result.outcome === 'failed') return failureText(result);
    if (result.status !== 'approved') return 'لم يُنفَّذ شيء.';
    const parts = [result.primary ? 'أصبح العميل عضوًا أساسيًا في الشركة' : 'أصبح العميل عضوًا إضافيًا في الشركة'];
    if (result.direct_relationship_ended) parts.push('وانتهت علاقته المباشرة بالمنصة');
    if (result.platform_manager_ended) parts.push('وانتهى إسناد مدير حسابه على المنصة');
    return `تم التنفيذ: ${parts.join('، ')}.`;
}

export function requestStatusLabel(row) {
    if (isFailedRecoverable(row)) return 'فشل التنفيذ — قابل للإعادة';
    return REQUEST_STATUS[row?.status] || row?.status || '';
}

// متطلبات التنفيذ (_account_request_execution)
export const SWITCH_LABELS = Object.freeze({
    account_request_execution_enabled: 'تنفيذ طلبات الحسابات',
    company_isolation_enforced: 'عزل الشركات',
    company_permissions_enabled: 'صلاحيات فريق الشركة',
    multi_company_memberships_enabled: 'تعدد الشركات للعميل'
});

/** نص آمن داخل HTML وداخل قيم السمات (يهرّب علامات الاقتباس أيضًا). */
export function escapeText(value) {
    return String(value === null || value === undefined ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const ERROR_CODES = Object.freeze({
    not_authorized: 'هذه الصفحة أو العملية غير متاحة لحسابك.',
    step_up_required: 'القرار يحتاج تحققًا بخطوتين حديثًا من لوحة المالك.',
    self_approval: 'لا يمكنك اتخاذ قرار في طلب قدّمته أنت.',
    self_assignment: 'لا تُسند نفسك مديرًا لحساب — يُسندك المالك أو مفوَّض آخر.',
    self_account: 'لا تُسند مديرًا لحسابك أنت.',
    manager_not_eligible: 'مدير الحساب يجب أن يكون من فريق المنصة وغير موقوف.',
    not_a_customer: 'هذا الحساب ليس حساب عميل.',
    request_final: 'الطلب نهائي — أي تغيير يحتاج طلبًا جديدًا.',
    request_immutable: 'بيانات الطلب لا تتغير بعد إرساله.',
    operation_not_available: 'النقل الكامل غير متاح بعد — لم يُنفَّذ شيء والطلب ما زال معلّقًا.',
    prerequisite_not_enabled: 'التنفيذ غير متاح بعد: متطلبات الأمان غير مفعّلة. لم يُنفَّذ شيء والطلب ما زال معلّقًا.',
    revalidation_failed: 'تغيّر حال العميل أو الشركة منذ الطلب — لم يُنفَّذ شيء.',
    execution_failed: 'تعذّر التنفيذ — لم يُنفَّذ شيء.',
    idempotency_conflict: 'هذا النموذج أُرسل ببيانات مختلفة؛ افتحه من جديد.',
    invalid_filter: 'قيمة فلتر غير صالحة.',
    invalid_page: 'حجم الصفحة بين 1 و100.',
    manager_required: 'اختر مدير الحساب (أو «بلا مدير»).',
    not_found: 'العنصر غير موجود.',
    invalid_type: 'نوع الطلب غير معروف.',
    missing_field: 'العميل والشركة مطلوبان.'
});

/** رسالة عربية من خطأ PostgREST: الرمز داخل details أولًا، وإلا نص الخادم كما هو. */
export function errorMessage(error) {
    if (!error) return '';
    let detail = null;
    try { detail = error.details ? JSON.parse(error.details) : null; } catch { detail = null; }
    const code = detail?.code;
    if (code === 'revalidation_failed' && detail.check) {
        return `${ERROR_CODES.revalidation_failed} (${CHECK_LABELS[detail.check] || detail.check})`;
    }
    if (code && ERROR_CODES[code]) return ERROR_CODES[code];
    const m = /تعذّر إرسال الطلب: ([a-z_]+)/.exec(error.message || '');
    if (m && CHECK_LABELS[m[1]]) return `تعذّر إرسال الطلب: لم يتحقق شرط «${CHECK_LABELS[m[1]]}».`;
    if (error.code === '42501') return ERROR_CODES.not_authorized;
    return error.message || 'حدث خطأ غير متوقع.';
}

/** فلاتر الدليل كما يقبلها admin_customer_directory — القيم الفارغة لا تُرسل. */
export function directoryFilters(state) {
    const [sort, dir] = String(state.sort || 'created_at:desc').split(':');
    const f = { view: state.view || 'all', sort, dir, limit: Number(state.limit) || 25, offset: Math.max(0, Number(state.offset) || 0) };
    const q = String(state.q || '').trim().slice(0, 100);
    if (q) f.q = q;
    for (const k of ['account_type', 'company_id', 'manager_id', 'status']) {
        if (state[k]) f[k] = state[k];
    }
    return f;
}

export function pageSummary(total, offset, count) {
    if (!total) return 'لا نتائج';
    return `${offset + 1}–${offset + count} من ${total}`;
}

export function shortId(id) {
    return id ? String(id).slice(0, 8) : '—';
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** تحقق مبدئي من نموذج الطلب (الخادم يعيد التحقق ويرفض بنفسه). */
export function requestFormError({ type, customerEmail, targetEmail, companyId, reason }) {
    if (!REQUEST_TYPES[type]) return 'اختر نوع الطلب.';
    if (!EMAIL_RE.test(String(customerEmail || '').trim())) return 'اكتب بريد العميل كما هو في حسابه للتحقق.';
    if (targetEmail && !EMAIL_RE.test(String(targetEmail).trim())) return 'البريد الآخر بصيغة غير صحيحة.';
    if (!companyId) return 'اختر الشركة الوجهة.';
    if (String(reason || '').trim().length < 10) return 'السبب مطلوب (10 أحرف على الأقل).';
    return null;
}

export function reasonError(reason) {
    return String(reason || '').trim().length < 10 ? 'السبب مطلوب (10 أحرف على الأقل).' : null;
}

/** حالة زر الموافقة: لا موافقة بلا تنفيذ، ولا قرار على طلبك، ولا قرار بلا تحقق بخطوتين. */
export function approvalState(details) {
    if (!details || details.status !== 'pending') return { enabled: false, label: 'نهائي' };
    if (details.self_requested) return { enabled: false, label: 'لا قرار على طلبك' };
    const exec = details.execution || {};
    if (exec.code === 'operation_not_available') return { enabled: false, label: 'التنفيذ غير متاح بعد' };
    if (!exec.available) {
        const missing = (exec.missing || []).map(k => SWITCH_LABELS[k] || k).join('، ');
        return { enabled: false, label: 'التنفيذ غير متاح بعد', note: missing ? `يتطلب: ${missing}` : '' };
    }
    const failed = (details.checks || []).filter(c => !c.ok);
    if (failed.length) return { enabled: false, label: 'شروط غير متحققة', note: failed.map(c => CHECK_LABELS[c.code] || c.code).join('، ') };
    if (!details.can_decide) return { enabled: false, label: 'يتطلب تحققًا بخطوتين' };
    return { enabled: true, label: details.last_failure ? 'إعادة المحاولة والتنفيذ' : 'موافقة وتنفيذ' };
}

export function newIdempotencyKey() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    const b = new Uint8Array(16);
    globalThis.crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function formatDate(value, withTime = false) {
    if (!value) return '—';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '—';
    return withTime ? d.toLocaleString('ar-EG') : d.toLocaleDateString('ar-EG');
}
