/**
 * saas-trial-model.js — منطق التجربة المجانية 3 أيام الخالص (بلا DOM ولا شبكة).
 *
 *   • المدة 3 أيام بالضبط (TRIAL_DAYS) — والنهاية = البداية + 3 أيام، بلا
 *     أي مدة أخرى في أي مسار؛ والقاعدة تفرضها بقيد
 *     saas_trial_requests_three_days_check في الترحيل 137.
 *   • التدفق: طلب من مالك الشركة → موافقة/رفض المالك أولًا → تبدأ الـ 3
 *     أيام فقط لحظة الموافقة. بلا موافقة مالك لا تبدأ التجربة إطلاقًا.
 *   • لا بيئة تجريبية (Sandbox) إطلاقًا: التجربة اشتراك عادي على الحساب
 *     الحي نفسه بصلاحيات الباقة المطلوبة، بلا نسخة حساب ولا صفحة sandbox
 *     ولا وضع sandbox — وهذا الملف لا يعرف أي مسار كهذا ولا يبنيه.
 *   • بلا بطاقة وبلا دفع وبلا تجديد تلقائي: لا حقل بطاقة ولا مبلغ هنا،
 *     والانتهاء يوقف الامتياز ولا يحوّل لاشتراك مدفوع.
 *   • تجربة واحدة لكل شركة وكل باقة: سبق الاستخدام يمنع طلبًا جديدًا.
 *
 * الباقات المشمولة (من subscription_plans): support و ultimate للشركات،
 * و store للمتاجر الإلكترونية فقط. الأسعار لا تخصّ هذا الملف: التجربة
 * مجانية (المبلغ 0 في price_snapshot) والأسعار المدفوعة مصدرها
 * subscription_plans كما هي — لا أرقام مخترعة هنا.
 */
export const TRIAL_DAYS = 3;
export const TRIAL_PLAN_KEYS = ['support', 'ultimate', 'store'];

export const TRIAL_PLAN_LABELS = {
    support: 'الخطة المتقدمة',
    ultimate: 'الخطة الفائقة',
    store: 'باقة المتاجر الإلكترونية'
};

export const TRIAL_STATUS_LABELS = {
    pending: 'بانتظار قرار المالك',
    approved: 'تجربة جارية',
    rejected: 'مرفوضة',
    expired: 'انتهت',
    cancelled: 'ملغاة'
};

/** هل الباقة من باقات التجربة؟ */
export function isTrialPlan(planKey) {
    return TRIAL_PLAN_KEYS.includes(planKey);
}

/**
 * هل الباقة متاحة لنوع الحساب؟ store للمتاجر الإلكترونية فقط؛
 * support و ultimate لأي شركة (بما فيها المتجر).
 */
export function trialPlanAllowed(planKey, accountKind) {
    if (!isTrialPlan(planKey)) return false;
    if (planKey === 'store') return accountKind === 'ecommerce_store';
    return true;
}

/** نهاية التجربة: البداية + 3 أيام بالضبط. */
export function trialEndAt(start) {
    const t = new Date(start).getTime();
    if (Number.isNaN(t)) return null;
    return new Date(t + TRIAL_DAYS * 86400000).toISOString();
}

/** مدة التجربة بالأيام بين بدايتها ونهايتها — يجب أن تكون 3 دائمًا. */
export function trialLengthDays(start, end) {
    const s = new Date(start).getTime();
    const e = new Date(end).getTime();
    if (Number.isNaN(s) || Number.isNaN(e)) return null;
    return Math.round((e - s) / 86400000);
}

/**
 * وسائط طلب التجربة: خطة صالحة فقط، بلا أي حقل دفع أو بطاقة.
 * يُرجع { args } أو { error } برسالة عربية.
 */
export function trialRequestArgs({ planKey } = {}) {
    if (!isTrialPlan(planKey)) return { error: 'اختر باقة من باقات التجربة: المتقدمة أو الفائقة أو المتاجر.' };
    return { args: { p_plan_key: planKey } };
}

/**
 * وسائط قرار المالك: موافقة أو رفض فقط.
 * الرفض بسبب مسجَّل (10 أحرف على الأقل، على نمط منح المتاجر 133)؛
 * الموافقة بسببها اختياري.
 */
export function trialDecisionArgs({ decision, reason } = {}) {
    if (decision !== 'approved' && decision !== 'rejected') {
        return { error: 'القرار موافقة أو رفض فقط.' };
    }
    const clean = typeof reason === 'string' ? reason.trim() : '';
    if (decision === 'rejected') {
        if (clean.length < 10) return { error: 'سبب الرفض مطلوب (10 أحرف على الأقل) — يُسجَّل مع القرار.' };
        return { args: { p_decision: 'rejected', p_reason: clean } };
    }
    const args = { p_decision: 'approved' };
    if (clean) args.p_reason = clean;
    return { args };
}

/**
 * هل هذا الاشتراك اشتراك تجربة؟ العلامة الوحيدة هي price_snapshot.trial.
 * (اشتراك مدفوع في نفس الباقة لا يُحسب تجربة ولو تشابهت التواريخ.)
 */
export function isTrialSubscription(sub) {
    return sub?.price_snapshot?.trial === true;
}

/**
 * قراءة طلب تجربة واحد: حالته، وأيامه المتبقية، وما يجوز فعله به.
 * الأيام من ساعة المتصفح للعرض فقط — ساعة القاعدة هي المعتمدة للامتياز.
 */
export function trialRequestView(request, { now = Date.now() } = {}) {
    if (!request) return null;
    const end = request.trial_ends_at ? new Date(request.trial_ends_at).getTime() : null;
    const daysRemaining = request.status === 'approved' && end != null && end > now
        ? Math.ceil((end - now) / 86400000)
        : 0;
    return {
        id: request.id,
        planKey: request.plan_key,
        planLabel: TRIAL_PLAN_LABELS[request.plan_key] || request.plan_key,
        status: request.status,
        statusLabel: TRIAL_STATUS_LABELS[request.status] || request.status,
        isPending: request.status === 'pending',
        isActive: request.status === 'approved' && end != null && end > now,
        isFinished: request.status === 'expired' || (request.status === 'approved' && end != null && end <= now),
        daysRemaining,
        endsAt: request.trial_ends_at || null,
        canCancel: request.status === 'pending',
        canDecide: request.status === 'pending'
    };
}

/**
 * قراءة حالة التجربة لشركة (حمولة my_saas_trial_status):
 * التجربة الجارية، والطلبات، والباقات التي ما زال طلبها متاحًا.
 */
export function trialStatusView(status, { now = Date.now() } = {}) {
    if (!status || status.has_company !== true) {
        return { hasCompany: false, canRequest: false, activeTrial: null, requests: [], eligiblePlans: [] };
    }
    const requests = (status.requests || []).map(r => trialRequestView(r, { now }));
    const active = status.active_trial ? trialRequestView(status.active_trial, { now }) : null;
    return {
        hasCompany: true,
        canRequest: status.can_request === true,
        companyName: status.company_name || null,
        accountKind: status.account_kind || null,
        activeTrial: active && active.isActive ? active : null,
        requests,
        pendingRequests: requests.filter(r => r.isPending),
        eligiblePlans: (status.eligible_plans || []).filter(p => p.eligible === true).map(p => ({
            planKey: p.plan_key,
            planLabel: TRIAL_PLAN_LABELS[p.plan_key] || p.plan_name_ar || p.plan_key
        })),
        ineligiblePlans: (status.eligible_plans || []).filter(p => p.eligible !== true).map(p => ({
            planKey: p.plan_key,
            planLabel: TRIAL_PLAN_LABELS[p.plan_key] || p.plan_name_ar || p.plan_key,
            reason: p.reason || 'غير متاحة حاليًا'
        }))
    };
}

/** نص واحد ثابت يشرح قواعد التجربة في الواجهتين — بلا أرقام مخترعة. */
export const TRIAL_RULES_TEXT =
    'تجربة مجانية 3 أيام بالضبط، بلا بطاقة وبلا دفع. تبدأ فقط بعد موافقة المالك، وتنتهي تلقائيًا بعد 3 أيام بلا تجديد تلقائي وبلا خصم، ولا تتحول لاشتراك مدفوع. التجربة مرة واحدة لكل باقة.';
