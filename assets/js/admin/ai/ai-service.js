/**
 * AI Service (طبقة بيانات الواجهة)
 * --------------------------------------------------------
 * الواجهة لا تنادي أي مزوّد خارجي إطلاقًا. هذا الملف يتكلم فقط مع:
 *   - Supabase (قراءة/كتابة إعدادات: تكاملات، موديلات، قواعد توجيه، أوضاع)
 *   - Edge Function `ai-gateway`  (اختبار / مزامنة موديلات / توليد / معاينة مسار)
 *   - Edge Function `ai-session`  (جلسات المحادثة والبرمجة)
 *   - Edge Function `manage-external-integration` (حفظ مشفّر للمفاتيح)
 *
 * لا يمر أي API Key من هنا إلا في اتجاه واحد: من الفورم إلى الـ Edge Function
 * التي تشفّره. لا تُقرأ المفاتيح مرة أخرى أبدًا — العرض يعتمد على البصمة
 * المقنّعة المحفوظة في credentials_meta.
 */

import { supabase } from '/api-config.js';

const INTEGRATIONS_TABLE = 'external_integrations';
const MODELS_TABLE = 'external_integration_models';
const ROUTING_TABLE = 'ai_routing_rules';
const MODES_TABLE = 'ai_agent_modes';

/* ====================  استدعاء Edge Functions  ==================== */

/**
 * أي فشل يحمل معه الجسم الكامل في `err.details`، لأن الـ Gateway يرجّع مع كل
 * خطأ الرابط الذي جُرّب فعلًا والبروتوكول وتلميح السبب — وهي المعلومات التي
 * تحوّل "فشل جلب الموديلات" من رسالة مسدودة إلى تشخيص قابل للتصرّف.
 */
async function invoke(fn, body) {
    const { data, error } = await supabase.functions.invoke(fn, { body });

    if (error) {
        let payload = null;
        try { payload = await error.context?.json?.(); } catch { /* الرد ليس JSON */ }
        const err = new Error(payload?.error || `فشل نداء ${fn}: ${error.message}`);
        err.details = payload || {};
        throw err;
    }

    if (data?.error) {
        const err = new Error(data.error);
        err.details = data;
        throw err;
    }
    return data;
}

/* ====================  التكاملات (المزوّدون المُعدّون)  ==================== */

export async function fetchIntegrations() {
    const { data, error } = await supabase
        .from(INTEGRATIONS_TABLE)
        .select('id, provider, display_name, protocol, base_url, credentials_meta, capabilities_override, tags, is_active, priority, last_tested_at, last_test_status, last_test_message, last_used_at, created_at')
        .eq('owner_scope', 'platform')
        .order('priority', { ascending: true })
        .order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
}

/** الحفظ يمر دائمًا عبر Edge Function لأن التشفير لا يحدث في المتصفح أبدًا. */
export async function saveIntegration({ id, provider, display_name, protocol, base_url, is_active, priority, credentials, credentials_meta }) {
    const payload = id
        ? { action: 'update', id, display_name, protocol, base_url, is_active, priority, credentials, credentials_meta }
        : { action: 'create', provider, owner_scope: 'platform', display_name, protocol, base_url, is_active, priority, credentials, credentials_meta };

    // إزالة المفاتيح غير المعرّفة حتى لا تُفسَّر كـ "امسح القيمة الحالية"
    for (const key of Object.keys(payload)) {
        if (payload[key] === undefined) delete payload[key];
    }

    const data = await invoke('manage-external-integration', payload);
    return data.integration;
}

export async function deleteIntegration(id) {
    await invoke('manage-external-integration', { action: 'delete', id });
}

/* ====================  الـ Gateway (الـ runtime المستقل)  ==================== */

export function testIntegration(integrationId) {
    return invoke('ai-gateway', { action: 'test', integration_id: integrationId });
}

export function syncModels(integrationId) {
    return invoke('ai-gateway', { action: 'list_models', integration_id: integrationId });
}

/** إضافة موديل يدويًا — مخرج ضروري للبوابات التي لا تعرض /models. */
export function addModelManually({ integration_id, model_id, display_name, capabilities, category, context_window }) {
    return invoke('ai-gateway', {
        action: 'add_model',
        integration_id, model_id, display_name, capabilities, category, context_window,
    });
}

export function previewRoute({ mode, capability } = {}) {
    return invoke('ai-gateway', { action: 'resolve_route', mode, capability });
}

export function generate({ integration_id, model, messages, mode, system, temperature, max_tokens, tools, source }) {
    return invoke('ai-gateway', {
        action: 'generate',
        integration_id, model, messages, mode, system, temperature, max_tokens, tools,
        source: source || 'admin',
    });
}

/* ====================  الموديلات  ==================== */

const MODEL_COLUMNS = 'id, integration_id, model_id, display_name, category, supports_chat, supports_vision, supports_tools, supports_streaming, supports_reasoning, supports_coding, supports_agent, supports_long_context, supports_audio, context_window, max_output_tokens, input_price, output_price, is_default, is_enabled, capabilities_source, notes, discovered_at';

export async function fetchModels(integrationId = null) {
    let q = supabase.from(MODELS_TABLE).select(MODEL_COLUMNS);
    if (integrationId) q = q.eq('integration_id', integrationId);
    const { data, error } = await q.order('display_name', { ascending: true });
    if (error) throw error;
    return data || [];
}

export async function updateModel(modelRowId, patch) {
    const { data, error } = await supabase
        .from(MODELS_TABLE).update(patch).eq('id', modelRowId).select(MODEL_COLUMNS).single();
    if (error) throw error;
    return data;
}

/**
 * تعديل يدوي للقدرات: نضع capabilities_source='manual' حتى لا تدهسه أي
 * مزامنة لاحقة (الخادم يحترم هذه القيمة صراحةً).
 */
export function setModelCapability(modelRowId, column, value) {
    return updateModel(modelRowId, { [column]: value, capabilities_source: 'manual' });
}

export async function setDefaultModel(integrationId, modelRowId) {
    const { error: clearError } = await supabase
        .from(MODELS_TABLE).update({ is_default: false }).eq('integration_id', integrationId).eq('is_default', true);
    if (clearError) throw clearError;
    return updateModel(modelRowId, { is_default: true });
}

/* ====================  التوجيه والاحتياطي  ==================== */

export async function fetchRoutingRules() {
    const { data, error } = await supabase
        .from(ROUTING_TABLE)
        .select('*')
        .order('match_kind', { ascending: true })
        .order('match_value', { ascending: true })
        .order('position', { ascending: true });
    if (error) throw error;
    return data || [];
}

export async function saveRoutingRule(rule) {
    const payload = {
        name: rule.name,
        match_kind: rule.match_kind,
        match_value: rule.match_value || null,
        integration_id: rule.integration_id,
        model_id: rule.model_id || null,
        position: Number(rule.position) || 0,
        is_active: rule.is_active !== false,
        updated_at: new Date().toISOString(),
    };
    const q = rule.id
        ? supabase.from(ROUTING_TABLE).update(payload).eq('id', rule.id)
        : supabase.from(ROUTING_TABLE).insert(payload);
    const { data, error } = await q.select('*').single();
    if (error) throw error;
    return data;
}

export async function deleteRoutingRule(id) {
    const { error } = await supabase.from(ROUTING_TABLE).delete().eq('id', id);
    if (error) throw error;
}

/* ====================  الأوضاع (Agent Modes)  ==================== */

export async function fetchAgentModes() {
    const { data, error } = await supabase
        .from(MODES_TABLE).select('*').eq('is_enabled', true).order('sort_order', { ascending: true });
    if (error) throw error;
    return data || [];
}

/* ====================  الاستخدام والتكلفة  ==================== */

/** ملخص مجمّع عبر RPC — لا نسحب آلاف الصفوف للمتصفح. */
export async function fetchUsageSummary(sinceIso) {
    const { data, error } = await supabase.rpc('get_ai_usage_summary', { p_since: sinceIso });
    if (error) throw error;
    return data || [];
}

export async function fetchRecentUsageEvents(limit = 40) {
    const { data, error } = await supabase
        .from('ai_usage_events')
        .select('id, provider, model_id, mode, source, status, error_message, total_tokens, cost, latency_ms, attempt, created_at')
        .order('created_at', { ascending: false })
        .limit(limit);
    if (error) throw error;
    return data || [];
}

/* ====================  الجلسات (بيئة التطوير)  ==================== */

export function listSessions(status = 'active') {
    return invoke('ai-session', { action: 'list', status });
}

export function createSession({ title, mode, integration_id, model_id, system_prompt }) {
    return invoke('ai-session', { action: 'create', title, mode, integration_id, model_id, system_prompt });
}

export function getSession(sessionId) {
    return invoke('ai-session', { action: 'get', session_id: sessionId });
}

export function updateSession(sessionId, patch) {
    return invoke('ai-session', { action: 'update', session_id: sessionId, ...patch });
}

export function deleteSession(sessionId) {
    return invoke('ai-session', { action: 'delete', session_id: sessionId });
}

export function sendSessionMessage({ session_id, message, mode, integration_id, model_id }) {
    return invoke('ai-session', { action: 'send', session_id, message, mode, integration_id, model_id });
}
