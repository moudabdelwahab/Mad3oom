/**
 * portal-data.js — بيانات بوابة عملاء الشركة (D8، الترحيل 095).
 *
 * البوابة لا تقرأ شيئًا من الشركة غير اسمها: my_company_portal() تعيده لعميل الشركة
 * وحده (ولمالك المنصة في منظور العضو)، و null لغيرهما. لا معرّف شركة يُرسل من هنا:
 * الشركة تُشتق من الجلسة في القاعدة.
 */
import { supabase } from '/api-config.js';

const MISSING_RPC = new Set(['PGRST202', '42883', 'PGRST404']);

/**
 * @returns {Promise<{ ok: boolean, data: null | { company: { id: string, name: string }, preview: boolean },
 *                     unavailable?: boolean, error?: string }>}
 */
export async function fetchPortalContext() {
    try {
        const { data, error } = await supabase.rpc('my_company_portal');
        if (error && (MISSING_RPC.has(error.code) || error.status === 404)) {
            return { ok: true, data: null, unavailable: true };
        }
        if (error) throw error;
        return { ok: true, data: data || null };
    } catch (err) {
        console.error('[Portal] context:', err?.message || err);
        return { ok: false, data: null, error: 'تعذّر تحميل البوابة. حاول مرة أخرى.' };
    }
}

/** حالة العرض من رد الخادم — خالصة، مُختبَرة في tests/portal-model.test.mjs. */
export function portalState(result) {
    if (!result || result.ok !== true) return { kind: 'error' };
    if (result.unavailable) return { kind: 'unavailable' };
    const company = result.data?.company;
    if (!company || !company.name) return { kind: 'not-customer' };
    return { kind: 'ready', companyName: String(company.name), preview: result.data.preview === true };
}

/** تحقق نموذج التذكرة قبل الإرسال (القاعدة تتحقق مرة أخرى). */
export function validateTicketForm({ title, description }) {
    const errors = {};
    const t = String(title || '').trim();
    const d = String(description || '').trim();
    if (t.length < 3) errors.title = 'اكتب عنوانًا من 3 أحرف على الأقل';
    if (t.length > 200) errors.title = 'العنوان أطول من 200 حرف';
    if (d.length < 10) errors.description = 'صف المشكلة في 10 أحرف على الأقل';
    if (d.length > 5000) errors.description = 'الوصف أطول من 5000 حرف';
    return { ok: Object.keys(errors).length === 0, errors, values: { title: t, description: d } };
}
