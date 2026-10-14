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

/**
 * 095: من يرى لوحة الشركة وبأي قدر — كما قرّرته القاعدة في viewer_role.
 *   admin       مالك الشركة: كل الأقسام.
 *   supervisor  مشرف، agent موظف دعم: بلا الاشتراكات ولا مفاتيح API (القاعدة لا ترسل
 *               بياناتهما أصلًا؛ إخفاء القسمين تنظيم للعرض لا حماية).
 * حمولة بلا viewer_role = خادم قبل 095، وكانت تُرسل للمالك والأعضاء معًا؛ نعاملها
 * كما كانت تُعرض (admin) حتى لا يتغير شيء قبل تطبيق الترحيل.
 */
export const ADMIN_ONLY_SECTIONS = Object.freeze(['subscriptions', 'api']);

export function viewerRoleOf(dashboard) {
    const role = dashboard?.viewer_role;
    if (role === undefined || role === null) return 'admin';
    return ['admin', 'supervisor', 'agent'].includes(role) ? role : 'agent';
}

export function sectionAllowed(section, viewerRole) {
    return viewerRole === 'admin' || !ADMIN_ONLY_SECTIONS.includes(section);
}

export const VIEWER_ROLE_LABELS = Object.freeze({
    admin: 'مدير الشركة',
    supervisor: 'مشرف في فريق الشركة',
    agent: 'موظف دعم في فريق الشركة'
});

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
 * هل تسمح القاعدة لهذا المستخدم بإدارة مستخدمي الشركة؟
 *
 * الإجابة تُقرأ من حمولة company_members() فقط — وهي دالة SECURITY DEFINER
 * بتحسب can_manage = (مالك الشركة) AND (امتياز sub_users فعّال) جوّه القاعدة.
 * الواجهة **لا تحسب** الشرط ولا تخمّنه؛ بتقرأه. أي true هنا لازم يكون جاي من
 * نداء حديث للقاعدة، لا من حالة محفوظة في الصفحة.
 */
export function canManageMembers(membersPayload) {
    return membersPayload?.can_manage === true;
}

/**
 * هل رجّعت القاعدة القائمة المحصورة (migrations/085_company_members_privacy.sql)؟
 * القائمة الكاملة لمدير الشركة وحده؛ غيره يرى نفسه ومديره. قاعدة قبل 085 لا
 * ترسل scope فتُعامَل كما كانت (كاملة) — الواجهة تعرض ولا تقرر.
 */
export function membersScopeIsSelf(membersPayload) {
    return membersPayload?.scope === 'self';
}

/**
 * أدوار الشركة كما تعرّفها القاعدة (migrations/035_company_roles.sql).
 *
 * الواجهة **تعرض** الدور ولا تحسبه: القاعدة تشترط الرتبة والعلاقة معًا في
 * is_company_admin()/is_company_member()، وترجّع النتيجة في company_role.
 */
export const COMPANY_ROLE_LABELS = {
    company_admin: { label: 'مدير الشركة', pill: 'status-tone-accent',
                     hint: 'يدير اللوحة والمستخدمين والاشتراكات ومفاتيح API' },
    company_user:  { label: 'مستخدم الشركة', pill: 'status-neutral',
                     hint: 'حساب تابع للشركة بصلاحياته الخاصة' }
};

/** دور الحساب الحالي داخل شركته، كما رجّعته company_members(). */
export function companyRoleOf(membersPayload) {
    return membersPayload?.company_role || null;
}

/** هل الحساب الحالي مدير شركة؟ قراءة لا حساب. */
export function isCompanyAdmin(membersPayload) {
    return companyRoleOf(membersPayload) === 'company_admin';
}

/**
 * وصف دور عضو في القائمة.
 * is_owner يأتي من القاعدة (مقارنة companies.user_id)، والدور يأتي من
 * profiles.role المشتقّ بمحفّز. نعرض الاثنين متسقَّين، ولو اختلفا نعرض
 * ما تقوله العلاقة — فهي مصدر الحقيقة.
 */
export function memberRoleInfo(member) {
    if (member?.is_owner) return COMPANY_ROLE_LABELS.company_admin;
    return COMPANY_ROLE_LABELS[member?.role] || COMPANY_ROLE_LABELS.company_user;
}

/**
 * ما الذي يجوز فعله بعضو في القائمة؟
 * دالة خالصة: القرار النهائي في القاعدة (remove_company_member تتحقق من
 * can_manage_company_members ومن العلاقة معًا)، وهذه تمنع رحلة فاشلة.
 */
export function memberActions(member, { canManage = false } = {}) {
    return {
        canRemove: canManage === true
                   && member?.is_owner !== true
                   && member?.is_me !== true
    };
}

/* ── فريق الشركة (migrations/086_company_staff.sql) ──────────────────────
 *
 * «مستخدم الشركة» علاقة تبعية فقط، وهي نفسها علاقة عميل الشركة. الموظف دور
 * صريح فوقها يمنحه المدير. الواجهة تعرض ما رجّعته company_staff_list() ولا
 * تحسب شيئًا: الرفض والقبول في القاعدة.
 */
export const STAFF_ROLE_LABELS = {
    admin:      { label: 'مدير الفريق', pill: 'status-tone-accent',
                  hint: 'مالك الشركة — يدير الفريق ويرى كل محادثات الشركة' },
    supervisor: { label: 'مشرف', pill: 'status-tone-success',
                  hint: 'موظف يرى كل محادثات الشركة ويوزّعها' },
    agent:      { label: 'موظف دعم', pill: 'status-tone-success',
                  hint: 'موظف يرد على المحادثات المسندة إليه' },
    customer:   { label: 'عميل', pill: 'status-neutral',
                  hint: 'تابع للشركة بلا صلاحيات موظف' }
};

/** خيارات المدير لعضو تابع. «عميل» = إلغاء دور الموظف. */
export const STAFF_ROLE_OPTIONS = Object.freeze([
    { value: 'customer',   label: 'عميل (بلا صلاحيات موظف)' },
    { value: 'agent',      label: 'موظف دعم' },
    { value: 'supervisor', label: 'مشرف' }
]);

/**
 * دور عضو في الفريق كما رجّعته القاعدة.
 * null = لا نعرف (المنادي عميل، أو 086 غير مطبّق) — فلا نعرض شيئًا بدل تخمين «عميل».
 */
export function staffRoleOf(member, staffPayload) {
    if (!staffPayload || !Array.isArray(staffPayload.staff) || !member) return null;
    if (member.is_owner === true) return 'admin';
    const entry = staffPayload.staff.find(s => s && s.user_id === member.id);
    return entry && STAFF_ROLE_LABELS[entry.role] ? entry.role : 'customer';
}

export function staffRoleInfo(role) {
    return STAFF_ROLE_LABELS[role] || null;
}

/**
 * هل يظهر للمدير محدِّد دور لهذا العضو؟ دالة خالصة توفّر رحلة فاشلة فقط:
 * company_staff_set/revoke تعيد فحص كل شيء في القاعدة.
 */
export function staffActions(member, staffPayload) {
    const role = staffRoleOf(member, staffPayload);
    return {
        canEdit: staffPayload?.can_manage === true
                 && role !== null
                 && role !== 'admin'
                 && member?.is_owner !== true
    };
}

/**
 * ترجمة اختيار المدير إلى نداء: 'set' مع الدور، أو 'revoke'، أو null لا تغيير.
 */
export function staffChangeFor(currentRole, nextRole) {
    if (!STAFF_ROLE_OPTIONS.some(o => o.value === nextRole) || nextRole === currentRole) return null;
    if (nextRole === 'customer') return currentRole === 'customer' ? null : { kind: 'revoke' };
    return { kind: 'set', role: nextRole };
}

/**
 * تحقّق من نموذج «إضافة مستخدم للشركة».
 *
 * القواعد مطابقة لما تفرضه الطبقات الأدنى فعليًا:
 *   • الحقول الثلاثة إلزامية — create-sub-user بترد 400 بدونها.
 *   • قوة كلمة المرور نفس قاعدة المنصة في auth-validation.validatePassword.
 * ده تحقّق **عرض** يوفّر رحلة فاشلة للخادم؛ الرفض النهائي يظل عند القاعدة
 * والـEdge Function.
 */
export function validateMemberForm(values) {
    const errors = {};
    const fullName = String(values?.fullName || '').trim();
    const email = String(values?.email || '').trim();
    const password = String(values?.password || '');
    const confirm = String(values?.passwordConfirm || '');

    if (fullName.length < 2) errors.fullName = 'اسم المستخدم مطلوب';

    if (!email) {
        errors.email = 'البريد الإلكتروني مطلوب';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        errors.email = 'بريد إلكتروني غير صالح';
    }

    if (!password) {
        errors.password = 'كلمة المرور مطلوبة';
    } else if (password.length < 8) {
        errors.password = 'كلمة المرور يجب أن تكون 8 أحرف على الأقل';
    } else if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
        errors.password = 'كلمة المرور يجب أن تحتوي على حرف كبير وحرف صغير ورقم';
    }

    if (!errors.password && confirm !== password) {
        errors.passwordConfirm = 'كلمتا المرور غير متطابقتين';
    }

    return { isValid: Object.keys(errors).length === 0, errors };
}

/**
 * 097: «تذاكر العملاء» = تذاكر نطاق الشركة. تذكرة العميل مع مدعوم (فوترته الشخصية) ليست
 * للشركة؛ القاعدة تحجبها والعزل مفعّل، والواجهة لا تعرضها في كل الأحوال. قبل 097: بلا scope.
 */
export function isCompanyScopedTicket(ticket) {
    return !!ticket && (!('scope' in ticket) || ticket.scope === 'company');
}

/* ── صلاحيات الفريق (098) ─────────────────────────────────────────────── */

export const TEAM_STATUS_OPTIONS = Object.freeze([
    { value: 'open', label: 'مفتوحة' },
    { value: 'in-progress', label: 'قيد المعالجة' },
    { value: 'resolved', label: 'تم الحل' },
    { value: 'rejected', label: 'مرفوضة' }
]);

/**
 * ماذا يملك الفريق في قسم «تذاكر العملاء» من رد my_company_permissions() — خالص.
 * المفتاح مطفأ أو قبل 098: لا شيء (يبقى القسم كما كان: تذاكر التابعين للمالك).
 */
export function teamTicketControls(payload) {
    const off = { enabled: false, companyId: null, canStatus: false, canAssign: false, assignees: [] };
    if (!payload || payload.enabled !== true || !payload.company_id) return off;
    const perms = payload.permissions || {};
    return {
        enabled: perms['tickets.view'] === true || perms['tickets.view_assigned'] === true,
        companyId: String(payload.company_id),
        canStatus: perms['tickets.status'] === true,
        canAssign: perms['tickets.assign'] === true,
        assignees: Array.isArray(payload.assignees)
            ? payload.assignees.filter(a => a && a.id).map(a => ({ id: String(a.id), name: String(a.name || '—') }))
            : []
    };
}

/* ── دعوات العملاء (096) ──────────────────────────────────────────────── */

export const INVITATION_STATUS_LABELS = Object.freeze({
    pending:   { label: 'بانتظار الرد', pill: 'status-tone-warning' },
    accepted:  { label: 'مقبولة',       pill: 'status-tone-success' },
    declined:  { label: 'مرفوضة',       pill: 'status-neutral' },
    cancelled: { label: 'ملغاة',        pill: 'status-neutral' },
    expired:   { label: 'منتهية',       pill: 'status-neutral' }
});

/**
 * ماذا يظهر في لوحة العملاء من رد company_customers_list() — خالص.
 * الدعوة لمن رجّعت له القاعدة can_manage والمفتاح مفعّل؛ قائمة العملاء للمشرف
 * (المدير يرى العملاء في «مستخدمو الشركة» أصلًا).
 */
export function customersPanelView(payload, viewerRole) {
    if (!payload || typeof payload !== 'object') return { show: false, canInvite: false, showList: false, customers: [] };
    const canInvite = payload.can_manage === true && payload.invitations_enabled === true;
    const showList = viewerRole === 'supervisor';
    const customers = Array.isArray(payload.customers) ? payload.customers : [];
    return { show: canInvite || showList, canInvite, showList, customers };
}

export function invitationStatusInfo(status) {
    return INVITATION_STATUS_LABELS[status] || { label: 'غير معروفة', pill: 'status-neutral' };
}

/** تحقّق عرض لبريد الدعوة؛ القاعدة تتحقق مرة أخرى (22023). */
export function validateInviteEmail(value) {
    const email = String(value || '').trim();
    if (!email) return { ok: false, error: 'اكتب البريد الإلكتروني للعميل' };
    if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: 'بريد إلكتروني غير صالح' };
    return { ok: true, email };
}

/**
 * هل الباقة دي بتستلزم شركة؟ القرار بيانات (subscription_plans.requires_company)
 * مش قائمة أسماء مكتوبة في الواجهة — باقة جديدة بتشتغل من غير تعديل كود.
 */
export function planRequiresCompany(plans, planKey) {
    return (plans || []).some(p => p.key === planKey && p.requires_company === true);
}
