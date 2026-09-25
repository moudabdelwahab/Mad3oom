/**
 * sie-plan-service.js
 * ------------------------------------------------------------
 * نداءات خطة SIE — الخادم هو مصدر الحقيقة:
 *   sie_my_entitlement()        الخطة الفعلية، الوصول وسببه، التنزيلات المسموحة، الحدود
 *   sie_customer_downgrade(t)   تنزيل الخطة (Max→Pro / Max→Free / Pro→Free فقط)
 * (migration 0011 في مستودع SIE). لا localStorage، ولا حساب لأي قاعدة هنا.
 *
 * Fail-safe: أي فشل (شبكة، دالة غير منشورة بعد، رد تالف) يُعاد كحالة
 * «unavailable» مفهومة — لا يرمي، ولا يمنع إرسال الرسائل: الحدود نفسها
 * مفروضة على الخادم عند كل رسالة (sie_consume_message) مهما عرضت الواجهة.
 * ------------------------------------------------------------
 */
import { normalizeEntitlement, downgradeErrorText } from './sie-plan-model.js';

export async function fetchEntitlement(supabase) {
    if (!supabase?.rpc) return normalizeEntitlement(null);
    try {
        const { data, error } = await supabase.rpc('sie_my_entitlement');
        if (error) {
            console.warn('[sie-plan] sie_my_entitlement failed:', error.message || error);
            return { ...normalizeEntitlement(null), error: error.message || String(error) };
        }
        return normalizeEntitlement(data);
    } catch (err) {
        console.warn('[sie-plan] sie_my_entitlement threw:', err?.message || err);
        return { ...normalizeEntitlement(null), error: err?.message || String(err) };
    }
}

/**
 * @returns {Promise<{ok:boolean, error?:string, errorText?:string}>}
 */
export async function downgradePlan(supabase, target) {
    if (!supabase?.rpc) return { ok: false, error: 'unavailable', errorText: downgradeErrorText('unavailable') };
    try {
        const { data, error } = await supabase.rpc('sie_customer_downgrade', { p_target: target });
        if (error) {
            console.warn('[sie-plan] sie_customer_downgrade failed:', error.message || error);
            return { ok: false, error: 'rpc_error', errorText: downgradeErrorText('rpc_error') };
        }
        if (data?.ok === true) return { ok: true, edition: data.edition, previous: data.previous };
        return { ok: false, error: data?.error || 'unknown', errorText: downgradeErrorText(data?.error) };
    } catch (err) {
        console.warn('[sie-plan] sie_customer_downgrade threw:', err?.message || err);
        return { ok: false, error: 'rpc_error', errorText: downgradeErrorText('rpc_error') };
    }
}
