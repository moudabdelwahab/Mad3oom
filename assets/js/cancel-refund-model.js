/**
 * cancel-refund-model.js — منطق تعويض إلغاء الاشتراكات المدفوعة الخالص
 * (بلا DOM ولا شبكة).
 *
 *   • كل الباقات المدفوعة (plan keys: 'support' و'ultimate' و'whatsapp'
 *     و'bundle') — باقة المتجر 'store' ليست منها (دُمجت في الفائقة).
 *     الأسعار بالجنيه المصري: المتقدمة 999/9999، الفائقة 1999/19999،
 *     الواتساب 1299/12999، الشاملة 2099/22999.
 *   • التعويض تناسبي: round(المبلغ المدفوع × الأيام المتبقية / إجمالي
 *     أيام المدة، 2) بالجنيه المصري. مثال: 30 يومًا مدفوع 1999 ومتبقٍ
 *     10 → 666.33 جنيه؛ و365 يومًا مدفوع 19999 ومتبقٍ 100 → 5479.18.
 *     وكامل: المبلغ المدفوع كاملًا، لاشتراك جديد في أول 7 أيام
 *     باستهلاك تذاكر ≤ 10% من الحد الشهري للباقة (دعم 30، واتساب 2،
 *     فائقة/شاملة 30 بالمرجع 300).
 *   • التدفق: عرض (قراءة فقط) → طلب إلغاء مع تعويض (الاشتراك يبقى
 *     فعّالًا حتى نهاية مدته) → قرار المالك (موافقة/رفض) → المالك يفتح
 *     تذكرة تعويض → العميل يرسل بيانات التحويل → المالك يسجّل الدفع.
 *     والتراجع عن الإلغاء قبل نهاية المدة يغلق طلب التعويض المفتوح
 *     تلقائيًا؛ والسنوي يضيف 14 يومًا هدية مرة واحدة لكل مدة.
 *   • المهل: رد المالك خلال 48 ساعة عمل (الأحد–الخميس)، والتحويل خلال
 *     14 يوم عمل للبنك والإنستاباي و3 أيام عمل للمحفظة الإلكترونية.
 *   • حدود صريحة: لا إلغاء فوري للاشتراك ولا صرف مال تلقائيًا — الطلب
 *     للمراجعة والقرار فقط، والدفع الفعلي خارج النظام ويسجّله المالك
 *     يدويًا. هذا الملف لا يعرف أي مسار دفع ولا يبنيه.
 *   • المبلغ المدفوع مصدره القاعدة (لقطة الاشتراك أو سعر الباقة الحالي)
 *     لا هذا الملف: computeRefund تحسب من أرقام تمرَّر إليها فقط.
 */

export const REFUND_PLAN_KEYS = ['support', 'ultimate', 'whatsapp', 'bundle'];
export const REFUND_PLAN_LABEL = 'الباقات المدفوعة';
export const REFUND_CURRENCY = 'EGP';

/** الحد الشهري للتذاكر لكل باقة (مقام الـ10%) — والمرجع 300 للا-محدودة. */
export const REFUND_TICKET_ALLOWANCES = { support: 300, ultimate: 300, whatsapp: 20, bundle: 300 };
/** حد الـ10% للتذاكر لكل باقة. */
export const REFUND_TICKET_LIMITS = { support: 30, ultimate: 30, whatsapp: 2, bundle: 30 };

export const REFUND_KIND_LABELS = {
    full: 'تعويض كامل',
    prorated: 'تعويض تناسبي'
};

export const REFUND_STATUS_LABELS = {
    pending: 'بانتظار قرار المالك',
    approved: 'وافق المالك — بانتظار بيانات التحويل',
    rejected: 'مرفوض',
    paid: 'تم تسجيل الدفع',
    closed: 'أُغلق — تراجع العميل عن الإلغاء'
};

export const REFUND_TRANSFER_METHODS = ['bank_transfer', 'instapay', 'cash_wallet'];
export const REFUND_TRANSFER_METHOD_LABELS = {
    bank_transfer: 'تحويل بنكي',
    instapay: 'إنستاباي',
    cash_wallet: 'محفظة إلكترونية'
};

/** نص الحدود الصريحة — يظهر قبل تأكيد الإلغاء وفي قسم التعويض وصفحة المالك. */
export const REFUND_RULES_TEXT = 'لا إلغاء فوري للاشتراك ولا صرف مال تلقائيًا: الإلغاء في نهاية المدة فقط، والاشتراك يبقى فعّالًا حتى انتهائها، وطلب التعويض يذهب للمالك للمراجعة والقرار، والدفع الفعلي خارج النظام ويسجّله المالك بعد وصول بيانات التحويل.';

/** هل الاشتراك من باقة مدفوعة قابلة للتعويض؟ */
export function isRefundablePlan(planKey) {
    return REFUND_PLAN_KEYS.includes(planKey);
}

/**
 * التعويض التناسبي: المدفوع × المتبقي / إجمالي المدة، مقربًا لقرشين.
 * أي مدخل غير رقمي أو غير موجب يرجع null — لا رقم مخمّن.
 * والكامل: kind === 'full' يرجع المدفوع كاملًا (بلا أيام).
 */
export function computeRefund(amountPaid, remainingDays, cycleDays, kind = 'prorated') {
    const paid = Number(amountPaid);
    if (!Number.isFinite(paid) || paid <= 0) return null;
    if (kind === 'full') return Math.round(paid * 100) / 100;
    const remaining = Number(remainingDays);
    const cycle = Number(cycleDays);
    if (![remaining, cycle].every(Number.isFinite)) return null;
    if (cycle <= 0 || remaining < 0 || remaining > cycle) return null;
    return Math.round((paid * remaining / cycle) * 100) / 100;
}

/** الأيام المتبقية من نهاية مدة بتاريخها — ceil كما تحسبها القاعدة. */
export function remainingDaysUntil(endDate, now = Date.now()) {
    const end = new Date(endDate).getTime();
    if (Number.isNaN(end)) return null;
    return Math.max(0, Math.ceil((end - now) / 86400000));
}

/** إجمالي أيام المدة بين بدايتها ونهايتها — round كما تحسبها القاعدة. */
export function cycleDaysBetween(startDate, endDate) {
    const s = new Date(startDate).getTime();
    const e = new Date(endDate).getTime();
    if (Number.isNaN(s) || Number.isNaN(e)) return null;
    return Math.max(1, Math.round((e - s) / 86400000));
}

/** صياغة مبلغ بالجنيه المصري — عرض فقط. */
export function formatEgp(amount) {
    const n = Number(amount);
    if (!Number.isFinite(n)) return '—';
    return `${n.toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} جنيه`;
}

/**
 * قراءة عرض التعويض كما رجّعه refund_quote: هل هو مؤهل، وما المبلغ
 * والأيام ونوع التعويض — مع التحقق أن الرقم المحسوب محليًا يطابق رقم
 * القاعدة (كاملًا أو تناسبيًا حسب النوع).
 * يُرجع { eligible, quote } أو { eligible: false, code, message }.
 */
export function refundQuoteView(quote) {
    if (!quote || typeof quote !== 'object') return { eligible: false, code: 'quote_failed', message: 'تعذّر حساب عرض التعويض. تحقق من اتصالك ثم أعد المحاولة.' };
    if (quote.eligible !== true) {
        return { eligible: false, code: quote.code || 'not_eligible', message: refundQuoteCodeMessage(quote.code) };
    }
    const kind = quote.refund_kind === 'full' ? 'full' : 'prorated';
    const local = computeRefund(quote.amount_paid, quote.remaining_days, quote.cycle_days, kind);
    const mismatch = local == null || Math.abs(local - Number(quote.refund_amount)) > 0.005;
    return {
        eligible: true,
        code: quote.code || 'refund_quote',
        subscriptionId: quote.subscription_id || null,
        plan: quote.plan || null,
        planName: quote.plan_name_ar || REFUND_PLAN_LABEL,
        billingCycle: quote.billing_cycle || null,
        endDate: quote.end_date || null,
        remainingDays: quote.remaining_days,
        cycleDays: quote.cycle_days,
        amountPaid: quote.amount_paid,
        refundKind: kind,
        refundKindLabel: REFUND_KIND_LABELS[kind],
        refundAmount: quote.refund_amount,
        currency: quote.currency || REFUND_CURRENCY,
        isNewSubscription: quote.is_new_subscription === true,
        withinFullRefundWindow: quote.within_full_refund_window === true,
        ticketsUsed: quote.tickets_used ?? null,
        ticketLimit: quote.ticket_limit ?? null,
        ticketAllowance: quote.ticket_allowance ?? null,
        sieUsage: quote.sie_usage || null,
        alreadyCancelled: quote.already_cancelled_at_period_end === true,
        amountMismatch: mismatch
    };
}

/** رسائل عربية لأكواد عدم أهلية عرض التعويض — نفس أكواد القاعدة. */
export const REFUND_QUOTE_CODE_MESSAGES = {
    not_authenticated: 'يجب تسجيل الدخول أولًا.',
    not_found: 'الاشتراك غير موجود.',
    not_yours: 'هذا الاشتراك لا يخص حسابك.',
    not_refundable_plan: 'طلب التعويض للباقات المدفوعة (المتقدمة والفائقة والواتساب والشاملة) — هذه الباقة لها مسار إلغاء نهاية المدة العادي.',
    no_active_subscription: 'لا يوجد اشتراك فعّال يمكن إلغاؤه مع تعويض.',
    trial_no_refund: 'التجربة المجانية بلا مبلغ مدفوع، فلا تعويض عليها.',
    amount_missing: 'المبلغ المدفوع لهذا الاشتراك غير مسجّل. راجع الدعم.',
    already_requested: 'لديك بالفعل طلب تعويض مفتوح على هذا الاشتراك — بانتظار قرار المالك.',
    quote_failed: 'تعذّر حساب عرض التعويض. تحقق من اتصالك ثم أعد المحاولة.'
};

export function refundQuoteCodeMessage(code) {
    return REFUND_QUOTE_CODE_MESSAGES[code] || 'تعذّر حساب عرض التعويض.';
}

/**
 * وسائط طلب الإلغاء مع التعويض: اشتراك مدفوع مؤهل + سبب اختياري (500 حرف).
 * يُرجع { args } أو { error } برسالة عربية.
 */
export function refundRequestArgs({ subscriptionId, reason } = {}) {
    if (!subscriptionId) return { error: 'حدّد الاشتراك المراد إلغاؤه.' };
    const trimmed = String(reason || '').trim();
    if (trimmed.length > 500) return { error: 'سبب الإلغاء 500 حرف كحد أقصى.' };
    return { args: { p_subscription_id: subscriptionId, p_reason: trimmed || null } };
}

/**
 * وسائط إرسال بيانات التحويل: وسيلة من الثلاث + رقم/حساب 6..100 أحرف.
 * يُرجع { args } أو { error } برسالة عربية.
 */
export function refundTransferArgs({ requestId, method, account } = {}) {
    if (!requestId) return { error: 'حدّد طلب التعويض.' };
    if (!REFUND_TRANSFER_METHODS.includes(method)) {
        return { error: 'اختر وسيلة التحويل: تحويل بنكي أو إنستاباي أو محفظة إلكترونية.' };
    }
    const trimmed = String(account || '').trim();
    if (trimmed.length < 6 || trimmed.length > 100) {
        return { error: 'رقم/حساب التحويل مطلوب (6 أحرف على الأقل، و100 كحد أقصى).' };
    }
    return { args: { p_request: requestId, p_transfer_method: method, p_transfer_account: trimmed } };
}

/**
 * وسائط قرار المالك: موافقة أو رفض فقط.
 * الرفض بسبب مسجَّل (10 أحرف على الأقل، على نمط منح المتاجر 133)؛
 * الموافقة بسببها اختياري.
 */
export function refundDecisionArgs({ decision, reason } = {}) {
    if (decision !== 'approved' && decision !== 'rejected') return { error: 'القرار موافقة أو رفض فقط.' };
    const trimmed = String(reason || '').trim();
    if (decision === 'rejected' && trimmed.length < 10) {
        return { error: 'سبب الرفض مطلوب (10 أحرف على الأقل) — يُسجَّل مع القرار ويظهر للعميل.' };
    }
    if (trimmed.length > 300) return { error: 'السبب 300 حرف كحد أقصى.' };
    return { args: { p_decision: decision, p_reason: trimmed || null } };
}

/**
 * وسائط تسجيل الدفع: ملاحظة مسجَّلة (10 أحرف على الأقل) — ما الذي حُوّل
 * وأين ومتى — لأن الدفع نفسه خارج النظام؛ ورسوم تحويل فعلية اختيارية
 * (0 افتراضيًا، ولا تتجاوز مبلغ التعويض) تُخصم من الإجمالي.
 */
export function refundPaidArgs({ note, fee } = {}) {
    const trimmed = String(note || '').trim();
    if (trimmed.length < 10) return { error: 'ملاحظة الدفع مطلوبة (10 أحرف على الأقل): ما الذي حُوّل وأين ومتى.' };
    if (trimmed.length > 300) return { error: 'الملاحظة 300 حرف كحد أقصى.' };
    const feeNumber = fee === undefined || fee === null || fee === '' ? 0 : Number(fee);
    if (!Number.isFinite(feeNumber) || feeNumber < 0) return { error: 'رسوم التحويل مبلغ غير سالب.' };
    return { args: { p_note: trimmed, p_transfer_fee: Math.round(feeNumber * 100) / 100 } };
}

/**
 * قراءة طلب تعويض واحد كما يرجع من القاعدة — حالاته وما ينتظره.
 */
export function refundRequestView(request) {
    if (!request || typeof request !== 'object') return null;
    const status = request.status || 'pending';
    return {
        ...request,
        statusLabel: REFUND_STATUS_LABELS[status] || status,
        refundKindLabel: REFUND_KIND_LABELS[request.refund_kind] || null,
        isPending: status === 'pending',
        isApproved: status === 'approved',
        isRejected: status === 'rejected',
        isPaid: status === 'paid',
        isClosed: status === 'closed',
        canDecide: status === 'pending',
        canOpenTicket: request.can_open_ticket === true,
        canMarkPaid: request.can_mark_paid === true,
        needsTransferDetails: request.needs_transfer_details === true,
        transferMethodLabel: REFUND_TRANSFER_METHOD_LABELS[request.transfer_method] || null
    };
}

/**
 * قراءة حالة التعويض لشركة (my_refund_requests): الطلبات مع تقسيمها —
 * المفتوح أولًا.
 */
export function refundStatusView(data) {
    if (!data || typeof data !== 'object') return { hasCompany: false, requests: [], canRequest: false };
    const requests = Array.isArray(data.requests) ? data.requests.map(refundRequestView).filter(Boolean) : [];
    return {
        hasCompany: data.has_company === true,
        companyName: data.company_name || null,
        canRequest: data.can_request === true,
        requests,
        openRequests: requests.filter(r => r.isPending || r.isApproved),
        pastRequests: requests.filter(r => r.isRejected || r.isPaid || r.isClosed)
    };
}
