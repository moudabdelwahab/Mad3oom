/**
 * caller-authority.js — سلطة المنادي تُسأل عنها القاعدة، لا تُشتق من رتبته في profiles.
 *
 * كانت دوال Edge تقرأ profiles.role بمفتاح الخدمة وتقارن بـ 'admin' (أو admin/support) حرفيًا. مالك المنصة
 * رتبته platform_owner دائمًا، فيُردّ هنا حتى وهو في سياق الإدارة — بينما القاعدة نفسها (is_admin() بعد 040)
 * تعدّه إداريًا في سياقَي owner/admin. فتختلف الطبقتان: الواجهة تفتح، والدالة ترفض.
 *
 * هنا يُسأل المُسنَد نفسه الذي تحرس به RLS بقية اللوحة، بجلسة المنادي (لا بمفتاح الخدمة):
 *   is_admin()           ← رتبة admin، أو المالك في سياق owner/admin
 *   is_platform_staff()  ← رتبة admin/support، أو المالك في سياق owner/admin
 * فقرار الدالة = قرار السياسة حرفيًا، والمالك خارج سياقه (عميل، شركة، معاينة، بلا سياق) مرفوض كغيره.
 *
 * وحدة خالصة بلا Deno ولا عميل Supabase (نداء REST واحد) — مُختبَرة في tests/caller-authority.test.mjs.
 * أي فشل (شبكة، مفتاح غائب، رد غير true) = لا سلطة: fail-closed.
 */

export const CALLER_PREDICATES = Object.freeze(['is_admin', 'is_platform_staff']);

const env = (name) => {
    try { return globalThis.Deno?.env?.get(name) || ''; } catch { return ''; }
};

/**
 * @param {'is_admin'|'is_platform_staff'} predicate
 * @param {string|null} authHeader  رأس Authorization كما وصل من المنادي («Bearer <jwt>»)
 * @param {{ supabaseUrl?: string, anonKey?: string, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<boolean>}
 */
export async function callerHas(predicate, authHeader, options = {}) {
    if (!CALLER_PREDICATES.includes(predicate)) {
        throw new Error(`مُسنَد غير معروف: ${predicate}`);
    }
    const token = String(authHeader || '').replace(/^Bearer\s+/i, '').trim();
    const supabaseUrl = options.supabaseUrl ?? env('SUPABASE_URL');
    const anonKey = options.anonKey ?? env('SUPABASE_ANON_KEY');
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (!token || !supabaseUrl || !anonKey || typeof fetchImpl !== 'function') return false;

    try {
        const res = await fetchImpl(`${String(supabaseUrl).replace(/\/+$/, '')}/rest/v1/rpc/${predicate}`, {
            method: 'POST',
            headers: {
                apikey: anonKey,
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: '{}'
        });
        if (!res.ok) return false;
        return (await res.json()) === true;
    } catch {
        return false;
    }
}
