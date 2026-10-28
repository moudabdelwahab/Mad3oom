/**
 * store-data.js — نداءات صفحات المتجر (store_* و ihub_* و ihub-api).
 *
 * لا معرّف شركة في أي نداء: الشركة من الجلسة في القاعدة. بيانات Shopify الحية تمر من
 * ihub-api (الرموز على الخادم وحده)؛ كل ما عداها دوال القاعدة مباشرة.
 * نفس اصطلاح integrations-data.js: { ok, data, error, code }.
 */

import { supabase } from '/api-config.js';
import { invokeIntegrationsApi, prepareConnection, disconnectConnection, setConnectionViewRole } from '/assets/js/company/integrations-data.js';

const MISSING_RPC_CODES = new Set(['PGRST202', '42883']);

function reasonOf(error) {
    try {
        const d = typeof error?.details === 'string' ? JSON.parse(error.details) : error?.details;
        if (d && typeof d.code === 'string') return d.code;
    } catch { /* ignore */ }
    return null;
}

async function rpc(name, args) {
    try {
        const { data, error } = await supabase.rpc(name, args);
        if (error) {
            if (MISSING_RPC_CODES.has(error.code) || error.status === 404) return { ok: false, data: null, missing: true, code: 'missing' };
            return { ok: false, data: null, error: error.message || 'تعذّر تنفيذ الطلب', code: reasonOf(error) || error.code || null };
        }
        return { ok: true, data: data ?? null, error: null };
    } catch (err) {
        return { ok: false, data: null, error: err?.message || 'تعذّر تنفيذ الطلب', code: null };
    }
}

export const fetchAccountType = () => rpc('my_account_type');
export const fetchStoreOverview = () => rpc('store_overview');
export const fetchStoreReport = (days) => rpc('store_report', { p_days: days });
export const fetchSyncStatus = (connectionId) => rpc('ihub_sync_status', { p_connection: connectionId });
export const requestSync = (connectionId) => rpc('ihub_sync_request', { p_connection: connectionId });
export const retryFailedEvents = (connectionId) => rpc('ihub_events_retry', { p_connection: connectionId });
export const fetchComplianceList = () => rpc('ihub_compliance_list');
export const exportCompliance = (id) => rpc('ihub_compliance_export', { p_request: id });
export const fetchRecordContext = (connectionId, recordType, externalId) =>
    rpc('ihub_store_record_context', { p_connection: connectionId, p_record_type: recordType, p_external_id: externalId });
export const fetchCategories = () => rpc('store_categories');
export const saveCategory = ({ key, labelAr, labelEn, active, sort }) =>
    rpc('store_category_save', { p_key: key, p_label_ar: labelAr, p_label_en: labelEn || null, p_active: active !== false, p_sort: sort ?? null });
export const fetchTicketStoreMeta = (ticketId) => rpc('store_ticket_meta_get', { p_ticket: ticketId });
export const setTicketCategory = (ticketId, category) => rpc('store_ticket_set_category', { p_ticket: ticketId, p_category: category || null });
export const fetchRequests = ({ status = 'open', kind = null, limit = 50, offset = 0 } = {}) =>
    rpc('store_requests_list', { p_status: status, p_kind: kind, p_limit: limit, p_offset: offset });
export const fetchRequest = (id) => rpc('store_request_get', { p_request: id });
export const createRequest = ({ kind, ticketId = null, recordId = null, note = null, assignedTo = null, dueAt = null }) =>
    rpc('store_request_create', { p_kind: kind, p_ticket: ticketId, p_record: recordId, p_note: note, p_assigned_to: assignedTo, p_due_at: dueAt });
export const updateRequest = (id, { status = null, note = null, resolutionNote = null, assignedTo = null, unassign = false, dueAt = null, clearDue = false } = {}) =>
    rpc('store_request_update', { p_request: id, p_status: status, p_note: note, p_resolution_note: resolutionNote,
                                  p_assigned_to: assignedTo, p_unassign: unassign, p_due_at: dueAt, p_clear_due: clearDue });
export const fetchStaff = () => rpc('company_staff_list');

export { prepareConnection, disconnectConnection, setConnectionViewRole };

/** بيانات Shopify الحية وإدارة الربط عبر الدالة الطرفية. */
export const startShopify = (connectionId, shop) => invokeIntegrationsApi('shopify_start', { connection_id: connectionId, shop });
export const testConnection = (connectionId) => invokeIntegrationsApi('test', { connection_id: connectionId });
export const searchShopify = (connectionId, kind, query, after = null) =>
    invokeIntegrationsApi('shopify_search', { connection_id: connectionId, kind, query, after });
export const getShopify = (connectionId, kind, id) => invokeIntegrationsApi('shopify_get', { connection_id: connectionId, kind, id });

/* ── إدارة Shopify (120) ───────────────────────────────────────────────
 * ما يستطيعه المستخدم من القاعدة (الصلاحيات والنطاقات)، والعمليات عبر ihub-api بخطوتين للمؤثرة:
 * بلا رمز ← تأكيد ومعاينة من Shopify؛ بالرمز ← تنفيذ. جسم الخطأ كاملًا (الحقل، السبب، رفض Shopify). */
export const fetchManageStatus = (connectionId) => rpc('ihub_shopify_manage_status', { p_connection: connectionId });
export const fetchOpsLog = (connectionId, limit = 50) => rpc('ihub_shopify_ops_list', { p_connection: connectionId, p_limit: limit });
export async function shopifyAdmin(connectionId, op, input, confirmationToken = null) {
    const body = { action: 'shopify_admin', connection_id: connectionId, op, input };
    if (confirmationToken) body.confirmation_token = confirmationToken;
    try {
        const { data, error } = await supabase.functions.invoke('ihub-api', { body });
        if (error) {
            let detail = { error: 'unknown_error' };
            try {
                const b = await error.context?.json?.();
                if (b && typeof b.error === 'string') detail = b;
            } catch { /* ignore */ }
            return { ok: false, data: null, code: detail.error, detail };
        }
        return { ok: true, data, code: null, detail: null };
    } catch {
        return { ok: false, data: null, code: 'unknown_error', detail: { error: 'unknown_error' } };
    }
}
