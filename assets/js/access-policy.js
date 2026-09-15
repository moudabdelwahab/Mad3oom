/**
 * access-policy.js — قرار الوصول لصفحة، كدالة خالصة.
 *
 * ليه ملف مستقل؟
 *   القرار ده كان محشورًا جوّه requireAuth() في auth-client.js، وكان بيرجّع
 *   `null` لحالتين مختلفتين تمامًا:
 *
 *     • مفيش جلسة أصلًا            (401 — مكانه صفحة الدخول)
 *     • فيه جلسة لكن الرتبة مش مسموحة (403 — مكانه رسالة، مش صفحة الدخول)
 *
 *   وكل مستدعٍ كان بيترجم `null` إلى «روح login.html». ولأن login.html
 *   بيلاقي الجلسة سليمة فبيرجّع المستخدم لبيته (لوحة الشركة مثلًا)، كانت
 *   النتيجة حلقة تحويل لا نهائية:
 *
 *     company-dashboard → صفحة محمية → login → company-dashboard → …
 *
 *   الفصل هنا بيخلي الحلقة **مستحيلة بنيويًا** لا مجرد مُصلَحة: ما دامت
 *   الجلسة قائمة، القرار لا يمكن أن يكون ANONYMOUS مهما كانت الرتبة، وبالتالي
 *   لا يوجد مسار يؤدي إلى صفحة الدخول من الأساس.
 *
 * الملف ده **خالص**: بلا DOM وبلا شبكة وبلا استيراد — عشان يتّختبر مباشرةً
 * في node (tests/access-policy.test.mjs). القرار الفعلي للبيانات يظل في
 * قاعدة البيانات (RLS ودوال SECURITY DEFINER)؛ اللي هنا قرار **عرض صفحة**.
 */

/** نتائج القرار الأربع. لا توجد نتيجة خامسة، ولا `null`. */
export const ACCESS = {
    ANONYMOUS: 'anonymous',   // لا جلسة — الوجهة الوحيدة المسموح بها هي صفحة الدخول
    BANNED: 'banned',         // جلسة سليمة لحساب موقوف — رسالة، لا تحويل
    FORBIDDEN: 'forbidden',   // جلسة سليمة بلا صلاحية للصفحة — رسالة، لا تحويل
    AUTHORIZED: 'authorized'  // مسموح
};

/**
 * ثلاثة نطاقات سلطة لا تتقاطع — نفس الفصل المفروض في القاعدة
 * (migrations/035_company_roles.sql).
 *
 *   Platform Staff  platform_owner · admin · support   ← سلطة على المنصة
 *   Company Roles   company_admin · company_user       ← سلطة داخل شركة واحدة
 *   Employee Ops    نطاق emp_ops                       ← هوية مستقلة تمامًا
 *
 * القائمة هنا مطابقة لـSTAFF_ROLES في account-destination.js عمدًا: مصدرا
 * القرار (أين يذهب / ماذا يرى) لازم يتفقوا على تعريف «طاقم».
 *
 * **قاعدة لا تُخرَق:** لا يدخل دور شركة هذه القائمة أبدًا. إضافته هنا تجعل
 * حساب شركة يفتح لوحة الإدارة، واختبار في tests/access-policy.test.mjs يفشل
 * إن حدث. والقرار الفعلي للبيانات في القاعدة على أي حال — هذا قرار **عرض**.
 */
export const STAFF_ROLES = ['platform_owner', 'admin', 'support'];

/** أدوار الشركة — سلطتها داخل شركتها وحدها، ولا تمنح شيئًا على المنصة. */
export const COMPANY_ROLES = ['company_admin', 'company_user'];

/** هل هذه هوية حساب شركة؟ للعرض فقط — النطاق تفرضه القاعدة. */
export function isCompanyIdentity({ role } = {}) {
    return COMPANY_ROLES.includes(role);
}

/**
 * مدير شركة **بحسب ما رجّعته القاعدة**.
 * الواجهة لا تحسب الشرط: company_role تأتي محسوبة من company_members()
 * (دالة SECURITY DEFINER تشترط الرتبة والعلاقة معًا).
 */
export function isCompanyAdminPayload(membersPayload) {
    return membersPayload?.company_role === 'company_admin';
}

/**
 * هل هذه هوية حساب طاقم؟
 *
 * كان هنا فرع بالبريد (`email === 'support@mad3oom.online'`) وأُزيل: البريد
 * لم يعد آلية تفويض في أي طبقة — لا هنا ولا في القاعدة (migrations/040).
 * ومصدر السلطة الحقيقي صار صفًّا في platform_authority لا عنوانًا مكتوبًا.
 */
export function isStaffIdentity({ role } = {}) {
    return STAFF_ROLES.includes(role);
}

/**
 * من يملك «الدخول كعضو» (impersonation): admin فقط — لا support ولا أي دور
 * شركة. أما مالك المنصة فيملكها داخل سياق الإدارة، لا بمجرد كونه مالكًا:
 * السياق يقيّد أعلى سلطة كما يقيّد أدناها.
 */
export function canImpersonate({ role } = {}, activeContext = null) {
    if (role === PLATFORM_OWNER_ROLE) return contextAllows(activeContext, 'admin');
    return role === 'admin';
}

/** رتبة مالك المنصة — هوية ثابتة لا تتغير عند تبديل السياق أبدًا. */
export const PLATFORM_OWNER_ROLE = 'platform_owner';

/** مفاتيح السياقات الخمسة، بنفس ترتيب available_contexts() في الخادم. */
export const OWNER_CONTEXTS = [
    'owner', 'admin', 'company_admin', 'company_user_preview', 'customer'
];

/**
 * خريطة القدرات — **نسخة طبق الأصل** من public.context_allows() في
 * migrations/038. اختبار في tests/access-policy.test.mjs يقارن الجدولين
 * ويفشل إن افترقا، لأن افتراقهما يعني أن الواجهة تعرض ما لا تعطيه القاعدة
 * (أو تخفي ما تعطيه) — وكلاهما عطب.
 *
 * ولا تُستعمل هذه الخريطة كحاجز أمني بحال: القرار الفعلي في RLS ودوال
 * SECURITY DEFINER. هذه تقرر **ما يُعرَض**، لا ما يُقرأ.
 */
export const CONTEXT_CAPABILITIES = {
    owner:                ['owner_only', 'admin', 'staff', 'company_admin', 'customer'],
    admin:                ['admin', 'staff'],
    company_admin:        ['company_admin'],
    company_user_preview: ['company_member'],
    customer:             ['customer']
};

/** هل يسمح هذا السياق بهذه القدرة؟ fail-closed: بلا سياق لا قدرة. */
export function contextAllows(activeContext, capability) {
    if (!activeContext) return false;
    return (CONTEXT_CAPABILITIES[activeContext] || []).includes(capability);
}

/** هل هذه هوية مالك المنصة؟ للعرض فقط — السلطة تُثبَت في الخادم. */
export function isPlatformOwnerIdentity({ role } = {}) {
    return role === PLATFORM_OWNER_ROLE;
}

/**
 * قرار الوصول.
 *
 * @param {object}   input
 * @param {object|null} input.identity      هوية المستخدم الحالية: { email, role }
 *                                          أو null لو مفيش جلسة.
 * @param {string|null} input.requiredRole  'admin' | 'user' | null
 * @param {boolean}  input.impersonating    هل الجلسة الحالية «دخول كعضو»؟
 * @param {boolean}  input.banned           هل الحساب موقوف؟
 * @returns {{ status: string, reason: string|null }}
 */
export function classifyAccess({
    identity = null,
    requiredRole = null,
    impersonating = false,
    banned = false,
    activeContext = null
} = {}) {
    // 401 — الحالة الوحيدة التي يجوز فيها التحويل إلى صفحة الدخول.
    if (!identity) return { status: ACCESS.ANONYMOUS, reason: 'no-session' };

    // حساب موقوف: الجلسة قائمة، فالتحويل لصفحة الدخول كان يعيده لبيته فورًا
    // (نفس الحلقة). رسالة صريحة بدل ذلك.
    if (banned === true) return { status: ACCESS.BANNED, reason: 'account-banned' };

    // ── مالك المنصة: السياق يقرر، لا الرتبة ───────────────────────────────
    //
    // رتبته وحدها لا تفتح شيئًا. وهذا ليس تشددًا زائدًا بل مطابقة لما تفعله
    // القاعدة: owner_capability() تشترط سماح السياق، فلو فتحت الواجهة صفحة
    // بلا سياق لعُرضت له لوحة فارغة تمامًا — كل استعلام فيها يُردّ. المنع
    // هنا يجعل الرسالة صحيحة («اختر سياقًا») بدل لوحة مكسورة بلا تفسير.
    //
    // ولا شيء من هذا الفرع يمسّ غير المالك: activeContext لا يُقرأ أصلًا في
    // مساره، فسلوك admin و support و company و customer مطابق لما كان.
    if (isPlatformOwnerIdentity(identity)) {
        if (!activeContext) {
            return { status: ACCESS.FORBIDDEN, reason: 'context-required' };
        }
        if (requiredRole === 'admin' && !contextAllows(activeContext, 'admin')) {
            return { status: ACCESS.FORBIDDEN, reason: 'wrong-context' };
        }
        if (requiredRole === 'user'
            && !contextAllows(activeContext, 'customer')
            && !impersonating) {
            return { status: ACCESS.FORBIDDEN, reason: 'wrong-context' };
        }
        return { status: ACCESS.AUTHORIZED, reason: null };
    }

    const staff = isStaffIdentity(identity);

    if (requiredRole === 'admin' && !staff) {
        return { status: ACCESS.FORBIDDEN, reason: 'staff-only' };
    }

    // صفحات بوابة العميل: الطاقم يُمنع منها إلا وهو «داخل كعضو»، عشان ما
    // يستخدمش عناصر الصفحة بهويته الإدارية. ده منع عرض لا منع بيانات.
    if (requiredRole === 'user' && staff && !impersonating) {
        return { status: ACCESS.FORBIDDEN, reason: 'customer-only' };
    }

    return { status: ACCESS.AUTHORIZED, reason: null };
}

/** رسائل الحالات غير المسموح بها — نص واحد مشترك بين كل الصفحات. */
export const ACCESS_MESSAGES = {
    'staff-only': {
        title: 'هذه الصفحة مخصّصة لفريق المنصة',
        text: 'حسابك مسجّل دخوله بشكل صحيح، لكن هذه الصفحة من صفحات لوحة الإدارة ولا تخصّ حسابك.'
    },
    'customer-only': {
        title: 'هذه الصفحة مخصّصة لحسابات العملاء',
        text: 'حسابك مسجّل دخوله بشكل صحيح، لكن هذه الصفحة تخصّ بوابة العميل. استخدم لوحتك أو ادخل كعضو من لوحة الإدارة.'
    },
    'account-banned': {
        title: 'الحساب موقوف',
        text: 'تم إيقاف هذا الحساب. تواصل مع الدعم لمعرفة التفاصيل.'
    },
    'context-required': {
        title: 'اختر سياق العمل أولًا',
        text: 'حسابك مالك المنصة، وصلاحياته لا تُفعَّل إلا داخل سياق تختاره. '
            + 'ارجع إلى شاشة السياقات واختر السياق الذي تريد العمل فيه.'
    },
    'wrong-context': {
        title: 'هذه الصفحة خارج سياقك الحالي',
        text: 'أنت داخل سياق لا يشمل هذه الصفحة. بدّل السياق من الشريط العلوي '
            + 'أو من شاشة السياقات للوصول إليها.'
    }
};

/** نص الحالة، مع بديل آمن لأي سبب غير معروف. */
export function accessMessageFor(reason) {
    return ACCESS_MESSAGES[reason] || {
        title: 'لا تملك صلاحية الوصول لهذه الصفحة',
        text: 'حسابك مسجّل دخوله بشكل صحيح، لكن هذه الصفحة غير متاحة له.'
    };
}
