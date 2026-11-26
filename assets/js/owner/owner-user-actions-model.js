/**
 * owner-user-actions-model.js — منطق إجراءات المالك الأصلية على مستخدم (بلا DOM ولا شبكة).
 *
 * الإجراءات الأربعة (الترحيل 147، دوال SECURITY DEFINER + _owner_require() +
 * owner_critical_ok() + تدقيق) — بلا «عرض الحساب (الدخول كمستخدم)»: التقمّص
 * إداري السياق وحده (auth-client.js) ولا يُبنى للمالك، وبلا SIE (لمن ترجع له
 * is_sie_admin() وحدها):
 *
 *   owner_set_user_role(p_user uuid, p_role text)          — مستخدم ↔ مدير فقط
 *   owner_ban_user(p_user uuid, p_reason text, p_until timestamptz)
 *   owner_set_user_points(p_user uuid, p_points int)        — قيمة مطلقة
 *   manage_user_points(target_user_email, 0, 'freeze'|'unfreeze') — كما هي (134)
 *
 * ملاحظتان على العقد (الترحيل 147 ليس في هذا الفرع بعد — يُراجَعان مع مجموعة SQL):
 *   • إلغاء الحظر: لا دالة إلغاء منفصلة في العقد، فيُرسَل owner_ban_user بسبب
 *     «إلغاء الحظر» وp_until = الآن — حظر منتهٍ أصلًا ليس حظرًا عند is_banned()
 *     (ban_status خارج ('none','active') و(ban_until فارغ أو > الآن)).
 *   • التجميد: manage_user_points (134) ترفض كل من ليس بريده support@mad3oom.online
 *     (UNAUTHORIZED)، بينما can_manage_central_wallet() (117) تسمح للمالك في
 *     سياقه — فزر التجميد قد يفشل للمالك حتى تُطابَق الدالة مع المُسنَد.
 */
import { isBanned } from '../admin/users-hub-model.js';

export { isBanned };

/** الرتبتان اللتان يغيّر المالك بينهما — super_user ليست رتبة في القاعدة، وplatform_owner لا تُمنح. */
export const OWNER_USER_ROLES = Object.freeze([
    { value: 'user', label: 'عضو' },
    { value: 'admin', label: 'مدير' }
]);

export const BAN_REASON_MIN = 5;

/** سبب الحظر: 5 أحرف على الأقل — نفس حدّ واجهة الإدارة القائمة. */
export function validateBanReason(reason) {
    const text = String(reason || '').trim();
    if (text.length < BAN_REASON_MIN) return { ok: false, error: `اكتب سببًا واضحًا (${BAN_REASON_MIN} أحرف على الأقل)` };
    return { ok: true, reason: text };
}

/** النقاط: عدد صحيح لا سالب — القيمة المطلقة الجديدة، لا فرقًا. */
export function validatePointsInput(raw) {
    const text = String(raw ?? '').trim();
    if (!/^-?\d+$/.test(text)) return { ok: false, error: 'أدخل عددًا صحيحًا للنقاط' };
    const points = Number(text);
    if (points < 0) return { ok: false, error: 'النقاط لا تكون سالبة' };
    return { ok: true, points };
}

/**
 * قائمة إجراءات المالك على مستخدم — نفس بنية userActions() بلا تقمّص وبلا SIE:
 *   role:*  تغيير الرتبة (مستخدم ↔ مدير)، لا تُعرض على الذات
 *   ban      حظر بسبب + حتى تاريخ اختياري (فارغ = دائم)
 *   unban    إلغاء الحظر — للمحظور وحده
 *   points   تعديل النقاط (قيمة مطلقة)
 *   freeze   تجميد/إلغاء تجميد الرصيد — لحامل المحفظة المركزية وحده
 * ctx: { viewerId, canManageCentralWallet }
 */
export function ownerUserActionList(target, ctx = {}) {
    const isSelf = !!ctx.viewerId && ctx.viewerId === target.id;
    const banned = isBanned(target);
    const actions = [];
    if (!isSelf) {
        actions.push({ group: 'تغيير الرتبة' });
        for (const r of OWNER_USER_ROLES) {
            actions.push({ id: `role:${r.value}`, label: r.label, current: (target.role || 'user') === r.value });
        }
    }
    actions.push({ group: 'الحساب' });
    if (ctx.canManageCentralWallet === true) {
        actions.push({ id: 'freeze', label: ctx.frozen ? 'إلغاء تجميد الرصيد' : 'تجميد الرصيد' });
    }
    actions.push({ id: 'points', label: 'تعديل النقاط' });
    if (!isSelf) {
        actions.push(banned
            ? { id: 'unban', label: 'إلغاء الحظر' }
            : { id: 'ban', label: 'حظر المستخدم', danger: true });
    }
    return actions;
}

/** حمولة الحظر: حتى فارغ = دائم (p_until null). */
export function banPayload(userId, reason, until) {
    return { p_user: userId, p_reason: reason, p_until: until ? new Date(until).toISOString() : null };
}

/** حمولة إلغاء الحظر: نفس الدالة، بسبب الإلغاء وحظر ينتهي الآن — انظر ملاحظة العقد أعلاه. */
export function unbanPayload(userId) {
    return { p_user: userId, p_reason: 'إلغاء الحظر', p_until: new Date().toISOString() };
}

/** حمولة تغيير الرتبة. */
export function rolePayload(userId, role) {
    return { p_user: userId, p_role: role };
}

/** حمولة تعديل النقاط (قيمة مطلقة). */
export function pointsPayload(userId, points) {
    return { p_user: userId, p_points: points };
}

/** حمولة التجميد/إلغاء التجميد عبر manage_user_points كما هي (134). */
export function freezePayload(email, frozen) {
    return { target_user_email: email, amount_change: 0, action_type: frozen ? 'unfreeze' : 'freeze' };
}

/** نتيجة دالة تُعيد jsonb { success, message }: الرفض رسالة لا «تم». */
export function rpcJsonResult(data, error) {
    if (error) return { ok: false, message: error.message || 'تعذّر تنفيذ العملية.' };
    if (data && typeof data === 'object' && data.success === false) {
        return { ok: false, message: data.message || 'رفضت القاعدة العملية.' };
    }
    return { ok: true, data };
}
