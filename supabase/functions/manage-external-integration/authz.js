// manage-external-integration — قرار الصلاحية (خالص، بلا شبكة، مُختبَر في
// tests/manage-external-integration-authz.test.mjs).
//
// لماذا ملف مستقل: الكتابة تتم بمفتاح الخدمة (لتشفير المفاتيح قبل الحفظ)، فـ RLS لا
// تحرسها. كل قرار كتابة يجب أن يُتخذ هنا صراحةً، لا أن يُستنتج من «الصف مرئي لي».
//
// الثغرة التي يغلقها (قائمة في الإصدار المنشور 22 حتى 2026-10-14):
//   الحذف والتعديل كانا يتحققان من رؤية الصف عبر عميل المستخدم ثم يكتبان بمفتاح الخدمة.
//   وتكاملات المنصة (owner_scope = 'platform') مقروءة لكل حساب مسجّل بالسياسة
//   "View own/managed/platform integrations" — فأي حساب كان يستطيع حذف مفتاح مزوّد
//   المنصة أو استبداله أو تغيير base_url إلى خادم يملكه.
//
// القواعد (095 + السؤال 11):
//   • تكامل المنصة: الإداري (is_admin) وحده يُنشئه ويعدّله ويحذفه.
//   • التكامل الشخصي: صاحبه وحده — لا مالك الشركة ولا الإداري.
//   • لا إنشاء باسم حساب آخر: owner_id القادم من الطلب يُتجاهل لغير تكامل المنصة.

export const PLATFORM = 'platform';

/** من يملك الصف الجديد ونطاقه، أو رفض. */
export function decideCreate({ isAdmin, callerId, requestedScope }) {
    if (!callerId) return { ok: false, status: 401, error: 'Unauthorized' };
    if (requestedScope === PLATFORM) {
        if (!isAdmin) return { ok: false, status: 403, error: 'تكاملات المنصة يديرها فريق الإدارة وحده' };
        return { ok: true, ownerId: null, ownerScope: PLATFORM };
    }
    // تكامل شخصي: لصاحب الطلب دائمًا، مهما أُرسل في owner_id.
    return { ok: true, ownerId: callerId, ownerScope: 'user' };
}

/** هل يحق للمنادي تعديل/حذف هذا الصف؟ row = { owner_id, owner_scope } مقروءة بمفتاح الخدمة. */
export function canModify({ isAdmin, callerId, row }) {
    if (!callerId || !row) return false;
    if (row.owner_scope === PLATFORM) return isAdmin === true;
    return row.owner_id != null && row.owner_id === callerId;
}
