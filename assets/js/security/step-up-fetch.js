/**
 * step-up-fetch.js — التحقق بخطوتين حسب السياق (121): النافذة تظهر لحظة الإجراء المحمي، لا في مكان ثابت.
 *
 * يلفّ fetch في عميل Supabase (api-config.js). كل إجراء تحرسه القاعدة بجلسة تحرير يعود بإشارة واحدة:
 *   • خطأ PostgREST بـ hint = 'step_up_required'   (staff_write_ok في سياسات RLS والمحفّزات)
 *   • رد RPC (owner_*) بـ { ok: false, error: 'step_up_required' }   (دوال 121)
 * عندها تُفتح نافذة التحقق؛ بعد نجاحه يُعاد الطلب نفسه مرة واحدة، فيكمل الإجراء من حيث توقف.
 *
 * لا قرار أمان هنا: لو تجاوز أحدهم هذه الطبقة لما تغيّر شيء — القاعدة ترفض بلا جلسة تحرير سارية.
 * وحدة خالصة (لا DOM) — tests/step-up-fetch.test.mjs.
 */

export const STEP_UP_HINT = 'step_up_required';

const urlOf = (input) => (typeof input === 'string' ? input : input?.url || String(input || ''));

/** هل هذا الرد يطلب جلسة تحرير؟ يعيد { message } أو null. لا يستهلك جسم الرد الأصلي. */
export async function stepUpSignal(input, response) {
    const url = urlOf(input);
    if (!url.includes('/rest/v1/') || /\/rpc\/owner_step_up(\?|$)/.test(url)) return null;
    if (!/json/i.test(response?.headers?.get?.('content-type') || '')) return null;
    const isError = response.status >= 400 && response.status < 500;
    const isOwnerRpc = response.ok && /\/rest\/v1\/rpc\/owner_[a-z_]+/.test(url);
    if (!isError && !isOwnerRpc) return null;
    let body;
    try { body = await response.clone().json(); } catch { return null; }
    if (isError && body?.hint === STEP_UP_HINT) return { message: String(body.message || '') };
    if (isOwnerRpc && body && body.ok === false && body.error === STEP_UP_HINT) return { message: '' };
    return null;
}

/**
 * @param {{ baseFetch: typeof fetch, prompt: (info: { message: string }) => Promise<boolean> }} deps
 * @returns {typeof fetch}
 */
export function createStepUpFetch({ baseFetch, prompt }) {
    let pending = null;   // نافذة واحدة لكل الطلبات المتزامنة
    return async function stepUpFetch(input, init) {
        const response = await baseFetch(input, init);
        const signal = await stepUpSignal(input, response);
        if (!signal) return response;
        pending ||= Promise.resolve(prompt(signal)).catch(() => false).finally(() => { pending = null; });
        const verified = await pending;
        return verified ? baseFetch(input, init) : response;
    };
}
