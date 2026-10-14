/**
 * portal-data.js — بيانات بوابة عملاء الشركة (D8، الترحيل 095؛ العضويات المتعددة 096).
 *
 * البوابة لا تقرأ شيئًا من الشركة غير اسمها: my_company_portal() تعيده لعميل الشركة
 * وحده (ولمالك المنصة في منظور العضو)، و null لغيرهما. الشركة الحالية تُشتق من
 * الجلسة في القاعدة؛ معرّف الشركة الذي يُرسل من هنا (التبديل، المغادرة) تتحقق القاعدة
 * من أن للمنادي عضوية نشطة فيه، وترد بنفس الرسالة لشركة غريبة أو غير موجودة.
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

/* ── العضويات المتعددة (096) ───────────────────────────────────────────── */

/**
 * محوّل الشركات من رد my_company_portal() — خالص، مُختبَر في tests/portal-model.test.mjs.
 * يظهر المحوّل حين تكون الميزة مفعّلة وللعميل أكثر من شركة. بلا أساسية (غادرها) يقترح
 * تعيين الحالية أساسيةً — تغيير أساسية قائمة نقلٌ بموافقات، لا زر هنا.
 */
export function membershipView(data) {
    const multi = data?.multi_company === true && data?.preview !== true;
    const list = multi && Array.isArray(data.memberships) ? data.memberships : [];
    const options = list
        .filter(m => m && m.company_id && m.name)
        .map(m => ({ id: String(m.company_id), name: String(m.name),
                     isPrimary: m.is_primary === true, isCurrent: m.is_current === true }));
    const current = options.find(o => o.isCurrent) || null;
    const hasPrimary = options.some(o => o.isPrimary);
    return {
        multi,
        showSwitcher: options.length > 1,
        options,
        current,
        canLeave: multi && !!current,
        canSetPrimary: multi && !!current && !hasPrimary
    };
}

/** نص رسالة خطأ الخادم كما هو (نص، لا HTML)، مع بديل عام. */
function rpcError(error, fallback) {
    if (error?.code === '0A000') return 'هذه الميزة غير مفعّلة بعد.';
    return error?.message || fallback;
}

async function call(name, args, fallback) {
    try {
        const { data, error } = await supabase.rpc(name, args);
        if (error) return { ok: false, error: rpcError(error, fallback) };
        return { ok: true, data };
    } catch (err) {
        console.error(`[Portal] ${name}:`, err?.message || err);
        return { ok: false, error: fallback };
    }
}

/** دعوات الحساب المعلّقة: اسم الشركة وتاريخ الانتهاء فقط ([] والميزة مطفأة). */
export async function fetchMyInvitations() {
    try {
        const { data, error } = await supabase.rpc('my_company_invitations');
        // قبل 096 لا دالة: لا دعوات، لا خطأ يظهر للعميل
        if (error && (MISSING_RPC.has(error.code) || error.status === 404)) return { ok: true, data: [] };
        if (error) throw error;
        return { ok: true, data: Array.isArray(data) ? data : [] };
    } catch (err) {
        console.error('[Portal] invitations:', err?.message || err);
        return { ok: false, data: [], error: 'تعذّر تحميل الدعوات.' };
    }
}

export function respondToInvitation(invitationId, accept) {
    return call('company_invitation_respond', { p_invitation: invitationId, p_accept: accept === true },
                'تعذّر حفظ ردك على الدعوة.');
}

/** null = العودة إلى الشركة الافتراضية (الأساسية). */
export function switchCompany(companyId) {
    return call('enter_customer_company', { p_company: companyId || null }, 'تعذّر التبديل إلى الشركة.');
}

export function leaveCompany(companyId) {
    return call('leave_company', { p_company: companyId }, 'تعذّرت مغادرة الشركة.');
}

export function setPrimaryCompany(companyId) {
    return call('set_primary_company', { p_company: companyId }, 'تعذّر تعيين الشركة الأساسية.');
}
