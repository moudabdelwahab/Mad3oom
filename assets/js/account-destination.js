/**
 * account-destination.js — أين تذهب بعد تسجيل الدخول أو التسجيل؟
 *
 * كان القرار مكررًا في أربعة أماكن (ثلاثة في login.html + autoRedirect في
 * auth-client.js) بنفس السطر:
 *
 *     (role === 'admin' || role === 'support' || role === 'super_user')
 *         ? 'admin-dashboard.html' : 'customer-dashboard.html'
 *
 * وده كان بيسبب مشكلتين حقيقيتين:
 *
 *   1) super_user مش أدمن. الرتبة دي بتتمنح تلقائيًا لأي عميل يشتري باقة
 *      "الدعم الفني" أو "الباقة الشاملة" (upgradeToSuperUserIfEligible)، فكان
 *      العميل الدافع بيتحوّل بعد الدخول للوحة الإدارة. الـRLS بتمنعه من
 *      البيانات فعلًا (is_admin لا تشمل super_user)، فالنتيجة لوحة إدارة
 *      شبه فاضية — سلوك غير منطقي لعميل.
 *      (مُثبَت في الإنتاج: حسابان بالرتبة دي وكلاهما عميل باشتراك فعّال.)
 *
 *   2) صاحب الشركة ماكانش بيوصل للوحة شركته أصلًا بعد الدخول.
 *
 * القرار هنا مبني على حالة الحساب الفعلية (الرتبة + وجود شركة تُقرأ من
 * القاعدة)، مش على أي query parameter يقدر المستخدم يتلاعب بيه.
 */

/**
 * رتب فريق المنصة — وحدها تفتح لوحة الإدارة.
 * مطابقة لـSTAFF_ROLES في access-policy.js عمدًا، ولا تدخلها أدوار الشركة:
 * company_admin حساب عميل بلوحة شركته، لا مشغّل منصة.
 */
const STAFF_ROLES = ['platform_owner', 'admin', 'support'];

export const DESTINATIONS = {
    ownerContexts: '/owner-contexts.html',
    admin: 'admin-dashboard.html',
    company: '/company-dashboard/',
    // 095 (D8): عميل الشركة له بوابة منفصلة، لا لوحة الشركة الداخلية
    companyPortal: '/portal/',
    customer: 'customer-dashboard.html'
};

/**
 * أنواع الحسابات كما تحسبها القاعدة (my_account_kind، الترحيل 095).
 * النوع يُقرأ من الخادم ولا يُستنتج في المتصفح؛ الصلاحية الفعلية في كل دالة وسياسة.
 */
export const ACCOUNT_KINDS = Object.freeze([
    'platform_owner', 'platform_staff', 'company_admin',
    'company_employee', 'company_customer', 'independent'
]);

/**
 * مالك المنصة لا «بيت» له — له شاشة اختيار سياق.
 *
 * وهذا ليس تفضيلًا في التنقّل: صلاحياته في القاعدة لا تُفعَّل إلا داخل سياق
 * (owner_capability تشترط سماح السياق)، فإرساله مباشرةً إلى لوحة الإدارة
 * كان سيعرض عليه لوحة **فارغة** يُردّ فيها كل استعلام. الشاشة هي الخطوة
 * الأولى الصحيحة، لا حاجزًا مضافًا.
 */
export const PLATFORM_OWNER_ROLE = 'platform_owner';

/**
 * القاعدة نفسها كدالة خالصة — بلا شبكة ولا DOM، عشان تتّختبر مباشرة.
 * الأولوية: فريق المنصة ← نوع الحساب من الخادم (إن وُجد) ← الشركة ← العميل الفرد.
 *
 * kind (095) يحسم بين فريق الشركة وعملائها: كلاهما «له شركة»، لكن العميل يذهب
 * لبوابة العملاء لا للوحة الداخلية (D8). بلا kind (خادم قبل 095) يبقى السلوك القديم.
 * @param {{role?: string, hasCompany?: boolean, kind?: string}} state
 * @returns {string}
 */
export function accountHomeFor(state = {}) {
    if (state.role === PLATFORM_OWNER_ROLE) return DESTINATIONS.ownerContexts;
    if (STAFF_ROLES.includes(state.role)) return DESTINATIONS.admin;
    switch (state.kind) {
        case 'platform_owner': return DESTINATIONS.ownerContexts;
        case 'platform_staff': return DESTINATIONS.admin;
        case 'company_admin':
        case 'company_employee': return DESTINATIONS.company;
        case 'company_customer': return DESTINATIONS.companyPortal;
        case 'independent': return DESTINATIONS.customer;
        default: break;
    }
    if (state.hasCompany === true) return DESTINATIONS.company;
    return DESTINATIONS.customer;
}

/**
 * نفس القاعدة لكن بقراءة وجود الشركة من القاعدة.
 * بيتمرَّر عميل Supabase صراحةً لأن login.html بينشئ نسخته الخاصة.
 * لو النداء فشل بنرجع لوجهة العميل — أسوأ حالة إن صاحب الشركة يبدأ من لوحته
 * الشخصية ويوصل لشركته من القائمة، مش إنه يعلق.
 */
export async function resolveAccountHome(supabaseClient, profile) {
    const role = profile?.role;
    if (role === PLATFORM_OWNER_ROLE) return DESTINATIONS.ownerContexts;
    if (STAFF_ROLES.includes(role)) return DESTINATIONS.admin;

    // 095: نوع الحساب من الخادم أولًا. قبل تطبيق 095 الدالة غير موجودة، فنرجع للقراءة القديمة.
    try {
        const { data, error } = await supabaseClient.rpc('my_account_kind');
        if (!error && ACCOUNT_KINDS.includes(data)) return accountHomeFor({ role, kind: data });
    } catch (err) {
        console.error('[AccountDestination] account kind lookup failed:', err?.message || err);
    }

    let hasCompany = false;
    try {
        const { data, error } = await supabaseClient.rpc('current_company_id');
        if (!error && data) hasCompany = true;
    } catch (err) {
        console.error('[AccountDestination] company lookup failed:', err?.message || err);
    }

    return accountHomeFor({ role, hasCompany });
}
