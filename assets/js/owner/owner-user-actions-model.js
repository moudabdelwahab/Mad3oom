/**
 * owner-user-actions-model.js — منطق إجراءات المالك الأصلية على مستخدم (بلا DOM ولا شبكة).
 *
 * الإجراءات الأربعة — الرتبة والنقاط والتجميد عبر دوال الترحيل 147
 * (SECURITY DEFINER + _owner_require() + owner_critical_ok() + تدقيق)،
 * أما الحظر/إلغاء الحظر فعبر Edge Function `ban-user` (من البند 6،
 * 2026-11-28): الدالة تكتب profiles **وتضبط `auth.users.banned_until`
 * عبر Auth Admin API** فيمنع الدخول وتحديث الرمز. دالة
 * `owner_ban_user` (147) ما زالت موجودة في القاعدة للتوافق، لكن
 * الواجهة لم تعد تناديها — ومن يناديها مباشرةً يكتب profiles وحدها
 * بلا مرآة Auth (نفس فجوة المسار القديم؛ إهمالها لاحقًا قرار منفصل).
 *
 * ملاحظة على العقد: التجميد manage_user_points (134) يرفض كل من ليس
 * بريده support@mad3oom.online (UNAUTHORIZED)، بينما
 * can_manage_central_wallet() (117) تسمح للمالك في سياقه — فزر التجميد
 * قد يفشل للمالك حتى تُطابَق الدالة مع المُسنَد.
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

/** جسم الحظر لـ Edge Function `ban-user`: حتى فارغ = دائم (ban_until null). */
export function banUserBody(userId, reason, until) {
    return { user_id: userId, action: 'ban', reason, ban_until: until ? new Date(until).toISOString() : null };
}

/** جسم إلغاء الحظر لـ Edge Function `ban-user`. */
export function unbanUserBody(userId) {
    return { user_id: userId, action: 'unban' };
}

/**
 * نتيجة `ban-user` إلى { ok, message?, note? } كما يفهمها runWrite:
 * خطأ النقل أو ok=false رسالة رفض؛ والنجاح بلا مرآة Auth أو بلا إلغاء
 * جلسات يُرفَق به تنبيه (note) يعرضه runWrite بدل «تم التنفيذ» وحده.
 * الجلسات لا تُلغى فورًا من الخادم أصلًا (لا نقطة نهاية Admin لذلك) —
 * التنبيه يذكّر بذلك كل مرة، فلا يُقرأ النجاح إلغاءً كاملًا للجلسات.
 */
export function banUserResult(data, error) {
    if (error) return { ok: false, message: error.message || 'تعذّر تنفيذ العملية.' };
    if (!data || data.ok !== true) {
        return { ok: false, message: (data && data.error) || 'تعذّر تنفيذ العملية.' };
    }
    if (data.auth_ban_applied !== true) {
        return {
            ok: true,
            note: data.action === 'unban'
                ? 'رُفع الحظر في قاعدة البيانات، لكن إزالة الحظر من المصادقة (Auth) فشلت — أعد المحاولة من زر رفع الحظر.'
                : 'تم الحظر في قاعدة البيانات، لكن ضبط الحظر في المصادقة (Auth) فشل — أعد المحاولة من زر الحظر.',
        };
    }
    if (data.sessions && data.sessions.revoked === false && data.action === 'ban') {
        return {
            ok: true,
            note: 'تم الحظر. ملاحظة: جلسات الحساب الحالية لا تُلغى فورًا من الخادم، لكن الحساب محجوب عن كل البيانات الآن ولن يستطيع الدخول أو تحديث جلسته بعد انتهاء رمزه الحالي.',
        };
    }
    return { ok: true };
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
