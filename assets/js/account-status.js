/**
 * account-status.js — هل الحساب مقيّد فعلًا؟ مصدر واحد للواجهات كلها.
 *
 * القرار الحقيقي في القاعدة: public.is_banned() (migrations/029):
 *
 *     ban_status is not null
 *     and ban_status not in ('none','active')
 *     and (ban_until is null or ban_until > now())
 *
 * هذه الوحدة نسخة حرفية من الشرط نفسه للعرض فقط — لا تمنح ولا تمنع شيئًا.
 *
 * لماذا وحدة مستقلة: كانت كل واجهة تعيد كتابة الشرط بطريقتها، فاختلفت:
 *   • customer-sidebar.js  اعتبرت كل ما ليس 'active' مقيّدًا — و'none' هي
 *     القيمة الافتراضية للعمود وقيمة **كل** الحسابات على الإنتاج، فظهرت
 *     شارة «الحساب مقيّد» لكل عميل سليم.
 *   • customer-history.js  اعتبرت كل ما ليس 'none' محظورًا — فكان 'active'
 *     يظهر للأدمن «محظور».
 *   • وكلتاهما تجاهلت انتهاء الحظر المؤقت (ban_until).
 */

/** القيم التي تعني «لا قيد» — نفس قائمة is_banned(). */
export const UNRESTRICTED_BAN_STATUSES = Object.freeze(['none', 'active']);

/**
 * @param {{ban_status?: string|null, ban_until?: string|null}|null|undefined} profile
 * @param {Date} [now]
 * @returns {boolean}
 */
export function isAccountRestricted(profile, now = new Date()) {
    const status = profile?.ban_status;
    if (status === null || status === undefined || status === '') return false;
    if (UNRESTRICTED_BAN_STATUSES.includes(status)) return false;

    if (profile.ban_until) {
        const until = new Date(profile.ban_until);
        // تاريخ غير صالح لا يُسقط قيدًا مسجَّلًا — نفس سلوك القاعدة مع قيمة قائمة
        if (!Number.isNaN(until.getTime()) && until <= now) return false;
    }
    return true;
}

/**
 * التسمية المعروضة لقيد قائم، أو null إن لم يكن الحساب مقيّدًا.
 * @returns {string|null}
 */
export function accountRestrictionLabel(profile, now = new Date()) {
    if (!isAccountRestricted(profile, now)) return null;
    const status = profile.ban_status;
    if (status === 'permanent' || status === 'banned') return 'الحساب موقوف';
    if (status === 'temporary') return 'الحساب مقيّد مؤقتًا';
    return 'الحساب مقيّد';
}
