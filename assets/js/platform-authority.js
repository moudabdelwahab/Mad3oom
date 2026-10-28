/**
 * platform-authority.js — «هل هذا الحساب إداري؟» تُسأل عنه القاعدة، لا تُشتق من profiles.role.
 *
 * كانت صفحات لوحة الإدارة تقارن profile.role بـ 'admin' (أو بالبريد support@) لتقرر ما تعرضه. مالك المنصة
 * رتبته platform_owner دائمًا، فكانت الصفحة تعامله كمستخدم عادي داخل لوحة الإدارة — رغم أن الحارس فتحها له
 * (guardPage يحترم السياق) ورغم أن القاعدة تعدّه إداريًا في سياقَي owner/admin (is_admin() منذ 040، وسياسات
 * الإدارة منذ 117).
 *
 * هنا المُسنَدات نفسها التي تحرس بها RLS البيانات، فما تعرضه الواجهة = ما تسمح به القاعدة:
 *   isAdmin          ← is_admin()                 الأدمن، أو المالك في سياق owner/admin
 *   isStaff          ← is_platform_staff()        الأدمن والدعم، أو المالك في سياق owner/admin
 *   isElevated       ← has_elevated_authority()   الأدمن المرتفع، أو المالك في سياق owner
 *   isOwner          ← is_platform_owner()        الهوية وحدها (لا تمنح شيئًا بلا سياق)
 *   activeContext    ← active_context()
 *   canManageCentralWallet ← can_manage_central_wallet() (117)
 *
 * عرض لا حماية: إخفاء زر هنا تهذيب للواجهة، والرفض الحقيقي في RLS والدوال. وأي فشل نداء = false (fail-closed).
 */
import { supabase } from '/api-config.js';

export const CENTRAL_WALLET_LEGACY_EMAIL = 'support@mad3oom.online';

let pending = null;

async function rpc(name) {
    try {
        const { data, error } = await supabase.rpc(name);
        return error ? { error } : { data };
    } catch (error) {
        return { error };
    }
}

/** قبل تطبيق 117 لا توجد can_manage_central_wallet: نعود لشرط الإنتاج القديم حرفيًا (بريد الجلسة). */
const missingFunction = (error) => ['PGRST202', '42883', 'PGRST404'].includes(error?.code);

async function load() {
    const [admin, staff, elevated, owner, ctx, wallet] = await Promise.all([
        rpc('is_admin'), rpc('is_platform_staff'), rpc('has_elevated_authority'),
        rpc('is_platform_owner'), rpc('active_context'), rpc('can_manage_central_wallet')
    ]);

    let canManageCentralWallet = wallet.data === true;
    if (missingFunction(wallet.error)) {
        const { data: { session } = {} } = await supabase.auth.getSession().catch(() => ({ data: {} }));
        canManageCentralWallet = session?.user?.email === CENTRAL_WALLET_LEGACY_EMAIL;
    }

    return Object.freeze({
        isAdmin: admin.data === true,
        isStaff: staff.data === true,
        isElevated: elevated.data === true,
        isOwner: owner.data === true,
        activeContext: typeof ctx.data === 'string' ? ctx.data : null,
        canManageCentralWallet
    });
}

/** سلطة الجلسة الحالية — نداء واحد للصفحة، يُعاد استعماله. refresh بعد تبديل السياق. */
export function platformAuthority({ refresh = false } = {}) {
    if (!pending || refresh) pending = load();
    return pending;
}

/** يُسقط النتيجة المحفوظة (تغيّر الجلسة): النداء التالي يسأل القاعدة من جديد. */
export function resetPlatformAuthority() {
    pending = null;
}
