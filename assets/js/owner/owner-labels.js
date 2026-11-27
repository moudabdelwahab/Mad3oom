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

/** تسميات مزايا متجر الاختبار الثلاث (118/119) — نفس المفاتيح في company_feature_overrides. */
export const STORE_FEATURE_LABELS = Object.freeze({
    integrations_hub: 'مركز التكاملات',
    shopify_integration: 'تكامل Shopify',
    shopify_management: 'إدارة المتجر',
    store_support: 'دعم المتجر'
});

/**
 * التحقق من نموذج سعر باقة المتاجر قبل النداء — نسخة من شرط
 * owner_set_store_plan_price() في القاعدة (133): السعران موجبان، بالجنيه.
 * يعيد رسالة خطأ أو null.
 */
export function storePriceError({ monthly, yearly }) {
    const m = Number(monthly);
    const y = Number(yearly);
    if (!Number.isFinite(m) || m <= 0) return 'السعر الشهري موجب (بالجنيه) — اكتب رقمًا أكبر من صفر.';
    if (!Number.isFinite(y) || y <= 0) return 'السعر السنوي موجب (بالجنيه) — اكتب رقمًا أكبر من صفر.';
    return null;
}

/**
 * حمولة نداء سعر باقة المتاجر — نسخة من قواعد owner_set_store_plan_price()
 * في القاعدة (133/135): التفعيل مع سعرين موجبين، والحفظ العادي كذلك،
 * والإلغاء بسعرين اختياريين (فارغ = إبقاء الحالي). التفعيل والإلغاء معًا
 * مرفوضان. الحقول الاختيارية الفارغة تُحذف من الحمولة، فيبقى نداء الحفظ
 * العادي {p_monthly, p_yearly, p_activate} كما هو. يعيد {args} أو {error}.
 */
export function storePlanPriceArgs({ monthly, yearly, activate = false, deactivate = false, reason = null } = {}) {
    if (activate && deactivate) return { error: 'لا يمكن تفعيل باقة المتاجر وإلغاء تفعيلها معًا.' };
    const m = monthly === '' || monthly === null || monthly === undefined ? null : Number(monthly);
    const y = yearly === '' || yearly === null || yearly === undefined ? null : Number(yearly);
    if (deactivate) {
        if ((m !== null && (!Number.isFinite(m) || m <= 0)) || (y !== null && (!Number.isFinite(y) || y <= 0))) {
            return { error: 'السعر الشهري والسنوي موجبان (بالجنيه) إن أُرسلا — اكتب رقمًا أكبر من صفر أو اتركهما فارغين.' };
        }
        const args = { p_monthly: m, p_yearly: y, p_activate: false, p_deactivate: true };
        const r = String(reason || '').trim();
        if (r) args.p_reason = r;
        return { args };
    }
    const err = storePriceError({ monthly, yearly });
    if (err) return { error: err };
    return { args: { p_monthly: m, p_yearly: y, p_activate: !!activate } };
}

/**
 * باقة المتاجر لنموذج السعر من owner_store_plan_config (135): التفعيل
 * والسعران والعملة والمزايا المفعّلة وتعريف الحد — بلا اعتماد على
 * owner_entitlement_diagnostics، فيبقى النموذج وإن فشل التشخيص.
 * يعيد null إن لم تصل بيانات الإعداد.
 */
export function storePlanFromConfig(planCfg) {
    if (!planCfg || typeof planCfg !== 'object') return null;
    return {
        key: 'store',
        is_active: planCfg.is_active ?? null,
        price_monthly: planCfg.price_monthly ?? null,
        price_yearly: planCfg.price_yearly ?? null,
        currency: planCfg.currency || 'EGP',
        features: (Array.isArray(planCfg.features) ? planCfg.features : [])
            .filter((f) => f?.enabled).map((f) => f.feature_key),
        ticket_quota_defined: planCfg.quota_defined ?? false
    };
}

/**
 * ما سيُعطَّل من مزايا باقة المتاجر عند حفظ نموذج الحصة (135): الفرق بين
 * المفعّلة حاليًا والمختارة للحفظ. يعيد null إن لم يكن في التعطيل ما يستدعي
 * تأكيدًا صريحًا، وإلا {disabling, disablesShopify, disablesAll}:
 * تعطيل shopify_integration أو إلغاء الكل (قائمة مختارة فارغة) يستدعيان
 * التحذير والتأكيد؛ تعطيل ميزة أخرى وحدها لا يستدعيه.
 */
export function storeQuotaDisableWarning({ currentFeatures = [], selectedFeatures = [] } = {}) {
    const current = Array.isArray(currentFeatures) ? currentFeatures : [];
    const selected = Array.isArray(selectedFeatures) ? selectedFeatures : [];
    const disabling = current.filter((f) => !selected.includes(f));
    if (!disabling.length) return null;
    const disablesShopify = disabling.includes('shopify_integration');
    const disablesAll = selected.length === 0;
    if (!disablesShopify && !disablesAll) return null;
    return { disabling, disablesShopify, disablesAll };
}

/**
 * أساس حساب الانتهاء عند استئناف اشتراك متوقف (135)، من حقول
 * _store_subscription_json: تاريخ حُدّد يدويًا أثناء الإيقاف يفوز، ثم
 * تحويل دورة أثناء الإيقاف، ثم التمديد بمدة التوقف.
 */
export function storeResumeBasis(sub) {
    if (sub?.end_date_set_while_paused) return 'manual';
    if (sub?.cycle_changed_while_paused) return 'cycle';
    return 'extension';
}

/**
 * التحقق من سبب عملية مالك قبل النداء — نفس شرط القاعدة (118/119):
 * السبب إلزامي 10 أحرف على الأقل، ويُسجَّل في تدقيق المالك.
 */
export function storeReasonError(reason) {
    if (String(reason || '').trim().length < 10) return 'اكتب سببًا واضحًا (10 أحرف على الأقل) — يُسجَّل في تدقيق المالك.';
    return null;
}

/**
 * الأيام المتبقية لامتياز ينتهي في expiresAt — نسخة من حساب
 * owner_store_test_status() في القاعدة (133): بلا انتهاء = null،
 * ومنتهٍ = 0، وإلا السقف الكامل للأيام المتبقية.
 */
export function testDaysRemaining(expiresAt, now = new Date()) {
    if (!expiresAt) return null;
    const end = new Date(expiresAt);
    if (Number.isNaN(end.getTime())) return null;
    if (end <= now) return 0;
    return Math.ceil((end - now) / 864e5);
}

/** تسميات دورة الفوترة في اشتراكات المتاجر (133) — نفس القيم في القاعدة. */
export const BILLING_CYCLE_LABELS = Object.freeze({ monthly: 'شهري', yearly: 'سنوي' });

/**
 * التحقق من تاريخ انتهاء اشتراك متجر قبل النداء — نسخة من شرط
 * owner_store_grant_exception / owner_store_set_end_date في القاعدة (133):
 * مستقبلي، أبعد من البداية، وخلال maxDays يومًا كحد أقصى. يعيد رسالة خطأ أو null.
 */
export function storeEndDateError(endDate, { maxDays = 365, startDate = null } = {}, now = new Date()) {
    const end = endDate ? new Date(endDate) : null;
    if (!end || Number.isNaN(end.getTime())) return 'اختر تاريخ انتهاء صحيحًا.';
    if (end <= now) return 'تاريخ الانتهاء في المستقبل — لا تاريخ ماضٍ.';
    if (end > new Date(now.getTime() + maxDays * 864e5)) return `تاريخ الانتهاء خلال ${maxDays} يومًا كحد أقصى.`;
    if (startDate) {
        const start = new Date(startDate);
        if (!Number.isNaN(start.getTime()) && end <= start) return 'تاريخ الانتهاء أبعد من تاريخ بداية الاشتراك.';
    }
    return null;
}

/** خلية CSV: تُقتبس عند وجود فاصلة أو سطر أو علامة اقتباس، وتُضاعف الاقتباسات. */
export function csvCell(value) {
    const s = value == null ? '' : String(value);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** جدول CSV نصي (سطر عناوين + صفوف) من مصفوفات قيم — يُبنى في المتصفح من بيانات محمّلة. */
export function toCsv(headers, rows) {
    const lines = [headers.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))];
    return lines.join('\r\n');
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
