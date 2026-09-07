/**
 * company-model.js — لغة لوحة الشركة كوحدات خالصة.
 *
 * كل ما هنا دوال خالصة بلا أي اتصال بالشبكة أو بالـDOM، عشان تتّختبر بمعزل
 * (tests/company-model.test.mjs) — نفس أسلوب ticket-view-model.js في بوابة
 * العميل.
 *
 * قاعدة مهمة: الدوال دي **عرض** فقط. مفيش قرار صلاحية بيتاخد هنا؛ القرار
 * بيتاخد في قاعدة البيانات (get_my_company_dashboard / company_has_feature)
 * والواجهة بترسم نتيجته. أي إخفاء هنا تجميل، مش أمان.
 */

/** حالات الاشتراك كما تُخزَّن في whatsapp_subscriptions.status */
export const SUBSCRIPTION_STATUS_LABELS = {
    active: { label: 'فعّال', pill: 'status-tone-success' },
    pending: { label: 'قيد المراجعة', pill: 'status-tone-warning' },
    expired: { label: 'منتهٍ', pill: 'status-tone-danger' },
    rejected: { label: 'مرفوض', pill: 'status-tone-danger' }
};

/**
 * حالة الاشتراك كما يراها صاحب الشركة.
 * ملاحظة: صف حالته 'active' لكن تاريخه فات يُعرض "منتهٍ" — لأن تعريف
 * الفعالية في المنصة كلها هو (status='active' AND end_date > now())،
 * والدالة في القاعدة بترجّع is_active محسوبة بنفس القاعدة.
 */
export function subscriptionStatusInfo(sub) {
    if (!sub) return { label: 'غير محددة', pill: 'status-neutral' };
    if (sub.status === 'active' && sub.is_active === false) {
        return { label: 'منتهٍ', pill: 'status-tone-danger' };
    }
    return SUBSCRIPTION_STATUS_LABELS[sub.status] || { label: 'غير محددة', pill: 'status-neutral' };
}

/** الاشتراكات الفعّالة فقط، حسب ما حسبته القاعدة (is_active). */
export function activeSubscriptions(subscriptions) {
    return (subscriptions || []).filter(s => s && s.is_active === true);
}

/**
 * ملخّص الاشتراكات لبطاقات الأرقام أعلى اللوحة.
 * nearestExpiry = أقرب اشتراك فعّال على الانتهاء (أهم رقم لصاحب الشركة).
 */
export function summarizeSubscriptions(subscriptions) {
    const all = subscriptions || [];
    const active = activeSubscriptions(all);
    const nearest = active
        .slice()
        .sort((a, b) => (a.days_remaining ?? Infinity) - (b.days_remaining ?? Infinity))[0] || null;

    return {
        total: all.length,
        active: active.length,
        pending: all.filter(s => s.status === 'pending').length,
        expired: all.filter(s => s.status === 'expired' || (s.status === 'active' && s.is_active === false)).length,
        nearestExpiry: nearest,
        daysToNearestExpiry: nearest ? nearest.days_remaining : null
    };
}

/**
 * قراءة حالة السجل التجاري.
 * بترجّع نبرة عرض فقط — مفيش تنبيهات ولا تجديد هنا (خارج نطاق المهمة).
 */
export function registrationInfo(registration) {
    const days = registration?.days_to_expiry;
    if (!registration || registration.expiry_date == null) {
        return { hasDate: false, isExpired: false, days: null, tone: 'neutral', label: 'غير مسجّل' };
    }
    if (registration.is_expired) {
        return { hasDate: true, isExpired: true, days, tone: 'danger', label: 'منتهي الصلاحية' };
    }
    if (typeof days === 'number' && days <= 30) {
        return { hasDate: true, isExpired: false, days, tone: 'warning', label: `يتبقّى ${days} يومًا` };
    }
    return { hasDate: true, isExpired: false, days, tone: 'success', label: 'ساري' };
}

/**
 * ما الذي تفتحه لوحة الشركة للمستخدم الحالي؟
 * بتتقرا من نفس الحمولة اللي رجّعتها القاعدة، من غير أي اجتهاد من الواجهة.
 */
export function companyAccess(dashboard) {
    if (!dashboard || !dashboard.company) {
        return { hasCompany: false, hasActiveSubscription: false, activePlans: [], isOwner: false };
    }
    return {
        hasCompany: true,
        hasActiveSubscription: dashboard.access?.has_active_subscription === true,
        activePlans: dashboard.access?.active_plans || [],
        isOwner: dashboard.company.is_owner === true
    };
}

/** هل تملك الشركة هذا الامتياز فعلًا (حسب ما رجّعته القاعدة)؟ */
export function hasEntitlement(dashboard, featureKey) {
    return (dashboard?.entitlements || []).some(e => e.feature_key === featureKey);
}

/**
 * تجميع الامتيازات تحت الباقة التي منحتها، عشان صاحب الشركة يشوف
 * "إيه اللي جايلي من كل باقة" مش قائمة مسطّحة.
 * الامتياز اللي جاي من أكتر من باقة بيظهر تحت كل واحدة منها.
 */
export function entitlementsByPlan(dashboard) {
    const subs = activeSubscriptions(dashboard?.subscriptions);
    const nameByKey = new Map(subs.map(s => [s.plan, s.plan_name_ar || s.plan]));
    const groups = new Map();

    for (const entitlement of dashboard?.entitlements || []) {
        const planKeys = Array.isArray(entitlement.granted_by) ? entitlement.granted_by : [];
        for (const planKey of planKeys) {
            if (!nameByKey.has(planKey)) continue; // باقة غير فعّالة حاليًا
            if (!groups.has(planKey)) {
                groups.set(planKey, { planKey, planName: nameByKey.get(planKey), features: [] });
            }
            groups.get(planKey).features.push(entitlement);
        }
    }

    // ترتيب ثابت حسب ترتيب الاشتراكات الفعّالة عشان الصفحة ما ترقصش بين التحميلات
    return subs
        .map(s => groups.get(s.plan))
        .filter(Boolean)
        .filter((group, index, list) => list.findIndex(g => g.planKey === group.planKey) === index);
}

/**
 * تحقّق من نموذج بيانات الشركة.
 * نفس قواعد upsert_my_company في القاعدة حرفيًا — الواجهة بتقولها بالعربي
 * قبل الإرسال، والقاعدة هي اللي بتفرضها فعليًا.
 */
export function validateCompanyForm(values) {
    const errors = {};
    const name = String(values?.companyName || '').trim();
    const cr = String(values?.crNumber || '').trim();
    const expiry = String(values?.crExpiry || '').trim();

    if (name.length < 2) errors.companyName = 'اسم الشركة مطلوب';
    if (cr.length < 3) errors.crNumber = 'رقم السجل التجاري مطلوب';
    if (!expiry) {
        errors.crExpiry = 'تاريخ انتهاء السجل التجاري مطلوب';
    } else if (Number.isNaN(new Date(expiry).getTime())) {
        errors.crExpiry = 'تاريخ غير صالح';
    }

    const email = String(values?.companyEmail || '').trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        errors.companyEmail = 'بريد إلكتروني غير صالح';
    }

    return { isValid: Object.keys(errors).length === 0, errors };
}

/**
 * هل الباقة دي بتستلزم شركة؟ القرار بيانات (subscription_plans.requires_company)
 * مش قائمة أسماء مكتوبة في الواجهة — باقة جديدة بتشتغل من غير تعديل كود.
 */
export function planRequiresCompany(plans, planKey) {
    return (plans || []).some(p => p.key === planKey && p.requires_company === true);
}
