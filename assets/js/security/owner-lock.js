// حالة قفل كلمة مرور مالك المنصة (121) — دالة نقية بعميل مُحقن، تُختبر في node.
// القرار في القاعدة (guard_owner_account_change)؛ هذه تحدد فقط ما تقوله الواجهة.

/**
 * هل الحساب مالك المنصة وتغيير كلمة مروره مقفل بسياسته؟
 * true/false، أو null إن تعذّر التحقق (خطأ من أي استدعاء) — المنادي يرفض حينها ولا يفترض «لا».
 */
export async function ownerPasswordLocked(client) {
    try {
        const owner = await client.rpc('is_platform_owner');
        if (owner.error || typeof owner.data !== 'boolean') return null;
        if (owner.data !== true) return false;
        const status = await client.rpc('owner_security_status');
        if (status.error || typeof status.data?.policy?.password_change_locked !== 'boolean') return null;
        return status.data.policy.password_change_locked;
    } catch {
        return null;
    }
}
