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
 * رتب فريق المنصة — وحدها سلطة على مستوى المنصة.
 * الارتباط بشركة **ليس** رتبة طاقم، ورتبة super_user القديمة لم تعد كذلك
 * (migrations/024). القائمة هنا مطابقة لـSTAFF_ROLES في account-destination.js
 * عمدًا: مصدرا القرار (أين يذهب / ماذا يرى) لازم يتفقوا على تعريف «طاقم».
 */
export const STAFF_ROLES = ['admin', 'support'];

/** الأدمن الرئيسي بإيميله — بديل احتياطي لو عمود الرتبة اتلخبط. */
export const MAIN_ADMIN_EMAIL = 'support@mad3oom.online';

/** هل هذه هوية حساب طاقم؟ */
export function isStaffIdentity({ email, role } = {}) {
    return email === MAIN_ADMIN_EMAIL || STAFF_ROLES.includes(role);
}

/**
 * من يملك «الدخول كعضو» (impersonation): الأدمن الرئيسي و admin فقط —
 * لا support ولا super_user. تفويض أضيق ومنفصل عن isStaffIdentity.
 */
export function canImpersonate({ email, role } = {}) {
    return email === MAIN_ADMIN_EMAIL || role === 'admin';
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
    banned = false
} = {}) {
    // 401 — الحالة الوحيدة التي يجوز فيها التحويل إلى صفحة الدخول.
    if (!identity) return { status: ACCESS.ANONYMOUS, reason: 'no-session' };

    // حساب موقوف: الجلسة قائمة، فالتحويل لصفحة الدخول كان يعيده لبيته فورًا
    // (نفس الحلقة). رسالة صريحة بدل ذلك.
    if (banned === true) return { status: ACCESS.BANNED, reason: 'account-banned' };

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
    }
};

/** نص الحالة، مع بديل آمن لأي سبب غير معروف. */
export function accessMessageFor(reason) {
    return ACCESS_MESSAGES[reason] || {
        title: 'لا تملك صلاحية الوصول لهذه الصفحة',
        text: 'حسابك مسجّل دخوله بشكل صحيح، لكن هذه الصفحة غير متاحة له.'
    };
}
