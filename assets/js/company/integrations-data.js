/**
 * integrations-data.js — نداءات مركز التكاملات من لوحة الشركة.
 *
 * كل شيء عبر دوال ihub_* (authenticated) أو الدالة الطرفية integrations-api.
 * لا معرّف شركة في أي نداء: الشركة تُشتق من الجلسة في القاعدة. والأسرار لا
 * تمر من هنا إلا مرة واحدة باتجاه واحد (المدير يكتبها ⇒ الخادم يشفّرها)، أو
 * تُعرض مرة واحدة عند الإنشاء/التدوير ثم تُنسى.
 *
 * نفس اصطلاح company-data.js: { ok, data, error } بدل الاستثناءات.
 */

import { supabase } from '/api-config.js';

const MISSING_RPC_CODES = new Set(['PGRST202', '42883']);
const isMissingRpc = (error) => !!error && (MISSING_RPC_CODES.has(error.code) || error.status === 404);

function reasonOf(error) {
    if (!error) return null;
    try {
        const d = typeof error.details === 'string' ? JSON.parse(error.details) : error.details;
        if (d && typeof d.code === 'string') return d.code;
    } catch { /* ignore */ }
    return null;
}

async function rpc(name, args) {
    try {
        const { data, error } = await supabase.rpc(name, args);
        if (error) {
            if (isMissingRpc(error)) return { ok: true, data: null, error: null, missing: true };
            return { ok: false, data: null, error: error.message || 'تعذّر تنفيذ الطلب', code: reasonOf(error) || error.code || null };
        }
        return { ok: true, data: data ?? null, error: null };
    } catch (err) {
        return { ok: false, data: null, error: err?.message || 'تعذّر تنفيذ الطلب', code: null };
    }
}

export const fetchIntegrationsOverview = () => rpc('ihub_overview');
export const prepareConnection = (provider, label) => rpc('ihub_prepare_connection', { p_provider: provider, p_label: label || null });
export const disconnectConnection = (id) => rpc('ihub_disconnect', { p_connection: id });
export const setConnectionViewRole = (id, role) => rpc('ihub_set_view_role', { p_connection: id, p_role: role });
export const fetchIntegrationAudit = (limit = 20) => rpc('ihub_audit_list', { p_limit: limit });
export const fetchIntakeRequests = (status = 'new') => rpc('ihub_intake_list', { p_status: status, p_limit: 50 });
export const dismissIntake = (id) => rpc('ihub_intake_dismiss', { p_intake: id });
export const convertIntake = (id, customerId) => rpc('ihub_intake_convert', { p_intake: id, p_customer: customerId });
export const fetchCustomerLinks = () => rpc('ihub_customer_links_list');
export const linkCustomer = (connectionId, customerId, externalId) =>
    rpc('ihub_customer_link', { p_connection: connectionId, p_customer: customerId, p_external_customer_id: externalId });
export const unlinkCustomer = (id) => rpc('ihub_customer_unlink', { p_link: id });

/** سياق التذكرة: null لمن لا يحق له (P0002) أو قبل 088 — اللوحة لا تظهر. */
export async function fetchTicketIntegrationContext(ticketId) {
    const r = await rpc('ihub_ticket_context', { p_ticket: ticketId });
    if (!r.ok) return { ok: true, data: null, error: null };
    return r;
}

export const unlinkTicketRecord = (linkId) => rpc('ihub_ticket_unlink', { p_link: linkId });

/**
 * الدالة الطرفية. الخطأ يُقرأ من جسم الرد ({ error: code }) — رمز ثابت فقط.
 */
export async function invokeIntegrationsApi(action, payload = {}) {
    try {
        const { data, error } = await supabase.functions.invoke('integrations-api', { body: { action, ...payload } });
        if (error) {
            let code = 'unknown_error';
            try {
                const body = await error.context?.json?.();
                if (body && typeof body.error === 'string') code = body.error;
            } catch { /* ignore */ }
            return { ok: false, data: null, error: code, code };
        }
        return { ok: true, data, error: null };
    } catch {
        return { ok: false, data: null, error: 'unknown_error', code: 'unknown_error' };
    }
}
