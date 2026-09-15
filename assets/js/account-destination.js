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
    customer: 'customer-dashboard.html'
};

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
 * الأولوية: فريق المنصة ← الشركة ← العميل الفرد.
 * @param {{role?: string, hasCompany?: boolean}} state
 * @returns {string}
 */
export function accountHomeFor(state = {}) {
    if (state.role === PLATFORM_OWNER_ROLE) return DESTINATIONS.ownerContexts;
    if (STAFF_ROLES.includes(state.role)) return DESTINATIONS.admin;
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

    let hasCompany = false;
    try {
        const { data, error } = await supabaseClient.rpc('current_company_id');
        if (!error && data) hasCompany = true;
    } catch (err) {
        console.error('[AccountDestination] company lookup failed:', err?.message || err);
    }

    return accountHomeFor({ role, hasCompany });
}
