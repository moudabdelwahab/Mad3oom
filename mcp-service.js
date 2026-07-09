/**
 * MCP Service - إدارة خوادم Model Context Protocol (MCP)
 * --------------------------------------------------------
 * تعريف الخادم (mcp_servers) منفصل عن بيانات الاعتماد وحالة الاتصال
 * (mcp_server_connections) - كل مستخدم (أدمن) له اتصاله الخاص بنفس
 * تعريف الخادم، بأي auth_type: none | api_key | bearer | oauth2 | custom.
 *
 * لا تشفير أو فك تشفير هنا إطلاقاً. كل التعامل مع الأسرار عبر:
 *  - save-mcp-credentials  → يشفّر ويخزّن (api_key/secret/bearer/custom/oauth app config)
 *  - mcp-oauth-start       → يرجّع رابط authorize كامل
 *  - mcp-oauth-callback    → يُستدعى مباشرة من مزود الـ OAuth (خارج هذا الملف)
 *  - test-mcp-server       → يفك التشفير ويتصل بالخادم الفعلي، يرجّع نتيجة مُعقَّمة فقط
 *
 * الواجهة لا ترى ولا تعيد قراءة أي access_token / refresh_token / secret أبداً.
 */

import { supabase } from '/api-config.js';

const STORAGE_KEY = 'mad3oom_mcp_servers';
const ACTIVITY_KEY = 'mad3oom_mcp_activity';
const TABLE = 'mcp_servers';
const CONN_TABLE = 'mcp_server_connections';

export const MCP_TRANSPORTS = ['stdio', 'sse', 'streamable_http'];
export const MCP_AUTH_TYPES = ['none', 'api_key', 'bearer', 'oauth2', 'custom'];

export const MCP_STATUSES = {
    CONNECTED: 'connected',
    DISCONNECTED: 'disconnected',
    ERROR: 'error',
    PENDING: 'pending',
};

/** رابط الـ OAuth callback الثابت - نفس القيمة المسجَّلة عند أي مزود OAuth */
export const MCP_OAUTH_REDIRECT_URI = `${supabase.supabaseUrl}/functions/v1/mcp-oauth-callback`;

/* =========================================================
 *  أدوات مساعدة داخلية
 * ========================================================= */

function uuid() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

let _useSupabase = null;

async function detectStorageMode() {
    if (_useSupabase !== null) return _useSupabase;
    try {
        const { error } = await supabase.from(TABLE).select('id').limit(1);
        if (error && (error.code === 'PGRST205' || error.message?.includes('schema cache') || error.message?.includes('Could not find the table'))) {
            _useSupabase = false;
        } else {
            _useSupabase = !error;
        }
    } catch {
        _useSupabase = false;
    }
    return _useSupabase;
}

function readLocal() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { return []; }
}
function writeLocal(servers) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(servers));
}

/* =========================================================
 *  سجل النشاط (محلي دائماً)
 * ========================================================= */

export async function logMcpActivity(action, serverId, details = {}) {
    const entry = { id: uuid(), action, server_id: serverId, details, created_at: new Date().toISOString() };
    try {
        const log = JSON.parse(localStorage.getItem(ACTIVITY_KEY) || '[]');
        log.unshift(entry);
        localStorage.setItem(ACTIVITY_KEY, JSON.stringify(log.slice(0, 100)));
    } catch (e) {
        console.warn('[MCP] Failed to log activity:', e);
    }
    return entry;
}

export async function fetchMcpActivity(limit = 50) {
    try {
        const log = JSON.parse(localStorage.getItem(ACTIVITY_KEY) || '[]');
        return log.slice(0, limit);
    } catch { return []; }
}

/* =========================================================
 *  دمج تعريف الخادم مع اتصال المستخدم الحالي
 * ========================================================= */

function mergeServerWithConnection(server, connection) {
    return {
        ...server,
        connection_id: connection?.id || null,
        auth_type: connection?.auth_type || 'none',
        oauth_client_id: connection?.oauth_client_id || '',
        oauth_authorize_url: connection?.oauth_authorize_url || '',
        oauth_token_url: connection?.oauth_token_url || '',
        oauth_scope: connection?.oauth_scope || '',
        oauth_token_expires_at: connection?.oauth_token_expires_at || null,
        status: connection?.status || MCP_STATUSES.PENDING,
        tools: Array.isArray(connection?.tools) ? connection.tools : [],
        last_checked_at: connection?.last_checked_at || null,
        last_error: connection?.last_error || null,
    };
}

const CONNECTION_SAFE_COLUMNS =
    'id, server_id, auth_type, oauth_client_id, oauth_authorize_url, oauth_token_url, oauth_scope, oauth_token_expires_at, status, tools, last_checked_at, last_error';

const SERVER_BASE_COLUMNS =
    'id, name, transport, url, command, args, env, headers, description, category, enabled, created_by, created_at, updated_at';

/* =========================================================
 *  CRUD تعريف الخادم
 * ========================================================= */

export async function fetchServers(filters = {}) {
    const useDb = await detectStorageMode();
    let servers;

    if (useDb) {
        const { data: { user } } = await supabase.auth.getUser();
        const [{ data: baseRows, error: baseErr }, connResult] = await Promise.all([
            supabase.from(TABLE).select(SERVER_BASE_COLUMNS).order('created_at', { ascending: false }),
            user
                ? supabase.from(CONN_TABLE).select(CONNECTION_SAFE_COLUMNS).eq('owner_id', user.id)
                : Promise.resolve({ data: [], error: null }),
        ]);
        if (baseErr) throw baseErr;
        if (connResult.error) throw connResult.error;

        const connByServer = new Map((connResult.data || []).map((c) => [c.server_id, c]));
        servers = (baseRows || []).map((s) => mergeServerWithConnection(s, connByServer.get(s.id)));
    } else {
        servers = readLocal();
    }

    return applyFilters(servers, filters);
}

function applyFilters(servers, { status, transport, search } = {}) {
    return servers.filter((s) => {
        if (status && status !== 'all' && s.status !== status) return false;
        if (transport && transport !== 'all' && s.transport !== transport) return false;
        if (search) {
            const q = search.trim().toLowerCase();
            const hay = `${s.name} ${s.url || ''} ${s.description || ''}`.toLowerCase();
            if (!hay.includes(q)) return false;
        }
        return true;
    });
}

export async function fetchServerById(id) {
    const useDb = await detectStorageMode();
    if (useDb) {
        const { data: { user } } = await supabase.auth.getUser();
        const [{ data: server, error: sErr }, { data: connection, error: cErr }] = await Promise.all([
            supabase.from(TABLE).select(SERVER_BASE_COLUMNS).eq('id', id).maybeSingle(),
            user
                ? supabase.from(CONN_TABLE).select(CONNECTION_SAFE_COLUMNS).eq('server_id', id).eq('owner_id', user.id).maybeSingle()
                : Promise.resolve({ data: null, error: null }),
        ]);
        if (sErr) throw sErr;
        if (cErr) throw cErr;
        if (!server) return null;
        return mergeServerWithConnection(server, connection);
    }
    return readLocal().find((s) => s.id === id) || null;
}

export async function createServer(payload) {
    const record = normalizePayload(payload, true);
    const useDb = await detectStorageMode();
    if (useDb) {
        const { data, error } = await supabase.from(TABLE).insert(record).select().single();
        if (error) throw error;
        await logMcpActivity('created', data.id, { name: data.name });
        return data;
    }
    const servers = readLocal();
    servers.unshift(record);
    writeLocal(servers);
    await logMcpActivity('created', record.id, { name: record.name });
    return record;
}

export async function updateServer(id, payload) {
    const updates = normalizePayload(payload, false);
    const useDb = await detectStorageMode();
    if (useDb) {
        const { data, error } = await supabase.from(TABLE).update(updates).eq('id', id).select().single();
        if (error) throw error;
        await logMcpActivity('updated', id, { name: data.name });
        return data;
    }
    const servers = readLocal();
    const idx = servers.findIndex((s) => s.id === id);
    if (idx === -1) throw new Error('الخادم غير موجود');
    servers[idx] = { ...servers[idx], ...updates, updated_at: new Date().toISOString() };
    writeLocal(servers);
    await logMcpActivity('updated', id, { name: servers[idx].name });
    return servers[idx];
}

export async function deleteServer(id) {
    const useDb = await detectStorageMode();
    let name = '';
    if (useDb) {
        const { data: existing } = await supabase.from(TABLE).select('name').eq('id', id).maybeSingle();
        name = existing?.name || '';
        const { error } = await supabase.from(TABLE).delete().eq('id', id);
        if (error) throw error;
    } else {
        const servers = readLocal();
        const target = servers.find((s) => s.id === id);
        name = target?.name || '';
        writeLocal(servers.filter((s) => s.id !== id));
    }
    await logMcpActivity('deleted', id, { name });
}

/* =========================================================
 *  بيانات الاعتماد (كل الأنواع) - عبر save-mcp-credentials فقط
 * ========================================================= */

/**
 * payload حسب auth_type:
 *  none      → { auth_type: 'none' }
 *  api_key   → { auth_type: 'api_key', api_key, api_secret }
 *  bearer    → { auth_type: 'bearer', bearer_token }
 *  custom    → { auth_type: 'custom', custom_config } (object أو نص JSON)
 *  oauth2    → { auth_type: 'oauth2', oauth_client_id, oauth_client_secret,
 *                oauth_authorize_url, oauth_token_url, oauth_scope }
 * أي حقل سر فاضي = "سيبه زي ما هو" (نفس سلوك النسخة القديمة).
 */
export async function saveCredentials(serverId, payload) {
    const { data, error } = await supabase.functions.invoke('save-mcp-credentials', {
        body: { server_id: serverId, ...payload },
    });
    if (error) throw new Error('فشل حفظ بيانات الاعتماد: ' + error.message);
    if (data?.error) throw new Error(data.error);
    return data;
}

/** يرجّع { authorize_url, redirect_uri } - الواجهة تعمل location.href = authorize_url */
export async function startOAuth(serverId) {
    const { data, error } = await supabase.functions.invoke('mcp-oauth-start', {
        body: { server_id: serverId },
    });
    if (error) throw new Error('فشل بدء ربط OAuth: ' + error.message);
    if (data?.error) throw new Error(data.error);
    return data;
}

/* =========================================================
 *  اختبار الاتصال / مزامنة الأدوات (نفس الـ Endpoint بالظبط)
 * ========================================================= */

export async function testServer(id) {
    const server = await fetchServerById(id);
    if (!server) throw new Error('الخادم غير موجود');

    const useDb = await detectStorageMode();
    if (!useDb) throw new Error('اختبار الاتصال متاح فقط عند استخدام Supabase');

    const { data, error } = await supabase.functions.invoke('test-mcp-server', {
        body: { server_id: id },
    });

    const result = error || data?.error
        ? { ok: false, message: data?.error || error.message || 'فشل الاتصال', tools: 0 }
        : data;

    await logMcpActivity(result.ok ? 'connected' : 'error', id, { name: server.name, message: result.message });
    return result;
}

/** نفس منطق testServer بالظبط (تحديث + دمج الأدوات مع الحفاظ على enabled) - تسمية دلالية بس */
export const syncTools = testServer;

/* =========================================================
 *  تفعيل/تعطيل أداة واحدة - تحديث مباشر (بيانات غير حساسة)
 * ========================================================= */

export async function setToolEnabled(connectionId, toolName, enabled) {
    if (!connectionId) throw new Error('لا يوجد اتصال محفوظ لهذا الخادم بعد - اعمل اختبار اتصال أولاً');

    const { data: conn, error: fetchErr } = await supabase
        .from(CONN_TABLE)
        .select('tools')
        .eq('id', connectionId)
        .single();
    if (fetchErr) throw fetchErr;

    const tools = Array.isArray(conn.tools) ? conn.tools : [];
    const updated = tools.map((t) => (t.name === toolName ? { ...t, enabled } : t));

    const { error: updErr } = await supabase.from(CONN_TABLE).update({ tools: updated }).eq('id', connectionId);
    if (updErr) throw updErr;
    return updated;
}

export async function disconnectServer(id) {
    const server = await fetchServerById(id);
    if (server?.connection_id) {
        const { error } = await supabase.from(CONN_TABLE).update({ status: MCP_STATUSES.DISCONNECTED }).eq('id', server.connection_id);
        if (error) throw error;
    }
    await logMcpActivity('disconnected', id, { name: server?.name || '' });
}

/* =========================================================
 *  إحصائيات
 * ========================================================= */

export async function fetchStats() {
    const servers = await fetchServers();
    const tools = servers.reduce((sum, s) => sum + (Array.isArray(s.tools) ? s.tools.length : 0), 0);
    return {
        total: servers.length,
        connected: servers.filter((s) => s.status === MCP_STATUSES.CONNECTED).length,
        disconnected: servers.filter((s) => s.status === MCP_STATUSES.DISCONNECTED).length,
        error: servers.filter((s) => s.status === MCP_STATUSES.ERROR).length,
        pending: servers.filter((s) => s.status === MCP_STATUSES.PENDING).length,
        tools,
    };
}

/* =========================================================
 *  تحقق وتوحيد بيانات تعريف الخادم (بدون أي بيانات اعتماد)
 * ========================================================= */

function normalizePayload(payload, isNew) {
    const out = {};

    if (isNew || payload.name !== undefined) {
        const name = (payload.name || '').trim();
        if (!name) throw new Error('اسم الخادم مطلوب');
        out.name = name;
    }

    if (isNew || payload.transport !== undefined) {
        out.transport = MCP_TRANSPORTS.includes(payload.transport) ? payload.transport : 'streamable_http';
    }

    if (isNew || payload.url !== undefined) {
        const url = (payload.url || '').trim();
        const transportForCheck = out.transport || 'streamable_http';
        if (transportForCheck !== 'stdio' && !url) throw new Error('عنوان URL مطلوب لخوادم غير stdio');
        out.url = url;
    }

    if (payload.command !== undefined) out.command = (payload.command || '').trim();

    if (payload.args !== undefined) {
        out.args = Array.isArray(payload.args) ? payload.args : String(payload.args).split(/\s+/).filter(Boolean);
    }

    if (payload.env !== undefined) {
        out.env = payload.env && typeof payload.env === 'object' ? payload.env : parseKeyValue(payload.env);
    }

    if (payload.headers !== undefined) {
        out.headers = payload.headers && typeof payload.headers === 'object' ? payload.headers : parseKeyValue(payload.headers);
    }

    if (payload.description !== undefined) out.description = (payload.description || '').trim();
    if (payload.category !== undefined) out.category = (payload.category || 'general').trim() || 'general';

    if (payload.enabled !== undefined) out.enabled = Boolean(payload.enabled);
    else if (isNew) out.enabled = true;

    if (isNew) {
        out.id = uuid();
        out.category = out.category || 'general';
        out.created_at = new Date().toISOString();
        out.updated_at = out.created_at;
    } else {
        out.updated_at = new Date().toISOString();
    }

    return out;
}

function parseKeyValue(input) {
    if (!input) return {};
    if (typeof input === 'object') return input;
    try { return JSON.parse(input); } catch {
        const obj = {};
        String(input).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).forEach((line) => {
            const i = line.indexOf('=');
            if (i > -1) obj[line.slice(0, i).trim()] = line.slice(i + 1).trim();
        });
        return obj;
    }
}

/* =========================================================
 *  مفاتيح API (نُقلت هنا من صفحة الإعدادات - مصدر واحد فقط)
 *  التشفير/الهاش والتحقق من الصلاحيات كلها في الـ Edge Functions فقط:
 *   - create-api-token
 *   - regenerate-api-token-secret
 *  التفعيل/التعطيل والحذف عمليات مباشرة على الجدول (RLS يضمن الملكية) -
 *  بدون أي تغيير في منطق المصادقة أو قاعدة البيانات.
 * ========================================================= */

const API_TOKENS_TABLE = 'api_tokens';
const API_USAGE_LOGS_TABLE = 'api_token_usage_logs';

/** القائمة المسموحة فعلياً من create-api-token - هنا للعرض فقط، التحقق الحقيقي في السيرفر */
export const API_TOKEN_ALLOWED_SCOPES = [
    'tickets:read', 'tickets:write', 'tickets:delete',
    'knowledge_base:read', 'knowledge_base:write',
    'customers:read', 'customers:write',
    'whatsapp:read', 'whatsapp:send',
    'analytics:read',
    'settings:manage',
    'oauth:manage',
    'mcp:connect',
    'chatbot:read',
    'admin:full',
    // أدوات MCP الجديدة: الاشتراكات والإشعارات (نفس القائمة المضافة في
    // create-api-token/index.ts و oauth-authorize-approve/index.ts و
    // oauth-discovery/index.ts)
    'subscriptions:read', 'subscriptions:write', 'subscriptions:renew', 'subscriptions:cancel', 'subscriptions:plans',
    'notifications:read', 'notifications:send', 'notifications:manage',
];

export const API_TOKEN_DEFAULT_SCOPES = ['tickets:read', 'tickets:write', 'whatsapp:send', 'whatsapp:read', 'chatbot:read'];

export async function fetchApiTokens() {
    const { data, error } = await supabase
        .from(API_TOKENS_TABLE)
        .select('id, name, description, api_key, secret_last_four, bearer_last_four, credential_type, credential_group_id, scopes, is_active, last_used_at, usage_count, expires_at, created_at')
        .order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
}

export async function fetchApiUsageLogs(limit = 50) {
    const { data, error } = await supabase
        .from(API_USAGE_LOGS_TABLE)
        .select('*, api_tokens(name)')
        .order('created_at', { ascending: false })
        .limit(limit);
    if (error) throw error;
    return data || [];
}

/**
 * payload: { name, description, credential_type: 'api_key_secret'|'bearer'|'both', scopes: string[], expires_at?: string|null }
 * الرد بيختلف حسب credential_type:
 *  - api_key_secret → { token, secret }
 *  - bearer         → { token, bearer_token }
 *  - both           → { credential_group_id, api_key_secret: {token, secret}, bearer: {token, bearer_token} }
 */
export async function createApiToken(payload) {
    const { data, error } = await supabase.functions.invoke('create-api-token', { body: payload });
    if (error) throw new Error('فشل إنشاء المفتاح: ' + error.message);
    if (data?.error) throw new Error(data.error);
    return data;
}

/** الرد: { token, secret } أو { token, bearer_token } حسب credential_type المخزّن للصف */
export async function regenerateApiTokenSecret(tokenId) {
    const { data, error } = await supabase.functions.invoke('regenerate-api-token-secret', { body: { token_id: tokenId } });
    if (error) throw new Error('فشل تجديد السر: ' + error.message);
    if (data?.error) throw new Error(data.error);
    return data;
}

export async function toggleApiToken(tokenId, currentlyActive) {
    const { error } = await supabase
        .from(API_TOKENS_TABLE)
        .update({ is_active: !currentlyActive, revoked_at: currentlyActive ? new Date().toISOString() : null })
        .eq('id', tokenId);
    if (error) throw error;
}

export async function deleteApiToken(tokenId) {
    const { error } = await supabase.from(API_TOKENS_TABLE).delete().eq('id', tokenId);
    if (error) throw error;
}

/* =========================================================
 *  External Integrations (نُقلت هنا من صفحة الإعدادات - مصدر واحد فقط)
 *  التشفير (AES-GCM) وفك التشفير والاختبار الفعلي كلها في:
 *   - manage-external-integration (create/update/delete)
 *   - test-integration-connection
 *  بدون أي تغيير في منطق المصادقة أو قاعدة البيانات.
 * ========================================================= */

const EXTERNAL_INTEGRATIONS_TABLE = 'external_integrations';
const EXTERNAL_INTEGRATION_MODELS_TABLE = 'external_integration_models';

export const INTEGRATION_PROVIDERS = ['openai', 'claude', 'gemini', 'openrouter', 'groq', 'telegram_bot', 'webhook', 'custom'];

export const INTEGRATION_PROVIDER_LABELS = {
    openai: 'OpenAI', claude: 'Claude (Anthropic)', gemini: 'Gemini (Google)',
    openrouter: 'OpenRouter', groq: 'Groq', telegram_bot: 'Telegram Bot',
    webhook: 'Webhook', custom: 'مزوّد آخر',
};

export const INTEGRATION_CREDENTIAL_FIELDS = {
    openai: [{ key: 'api_key', label: 'API Key', type: 'password', placeholder: 'sk-...' }],
    claude: [{ key: 'api_key', label: 'API Key', type: 'password', placeholder: 'sk-ant-...' }],
    gemini: [{ key: 'api_key', label: 'API Key', type: 'password', placeholder: 'AIza...' }],
    openrouter: [{ key: 'api_key', label: 'API Key', type: 'password', placeholder: 'sk-or-...' }],
    groq: [{ key: 'api_key', label: 'API Key', type: 'password', placeholder: 'gsk_...' }],
    telegram_bot: [{ key: 'bot_token', label: 'Bot Token', type: 'password', placeholder: '123456:ABC-DEF...' }],
    webhook: [{ key: 'url', label: 'Webhook URL', type: 'url', placeholder: 'https://example.com/webhook' }],
    custom: [
        { key: 'api_key', label: 'API Key (اختياري)', type: 'password', placeholder: '' },
        { key: 'url', label: 'Base URL (اختياري)', type: 'url', placeholder: '' },
    ],
};

export const AI_INTEGRATION_PROVIDERS = ['openai', 'claude', 'gemini', 'openrouter', 'groq'];

/** المزودين المتوافقين مع OpenAI فقط - بيسمحوا بحقل Base URL اختياري (استضافة ذاتية/بروكسي/نسخة متوافقة) */
export const OPENAI_COMPATIBLE_PROVIDERS = ['openai', 'groq', 'openrouter'];

/** فقط تكاملات نطاق platform (إدارة المنصة) - نفس نطاق صفحة الإعدادات القديمة */
export async function fetchExternalIntegrations() {
    const { data, error } = await supabase
        .from(EXTERNAL_INTEGRATIONS_TABLE)
        .select('*')
        .eq('owner_scope', 'platform')
        .order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
}

/** action محسوبة تلقائياً من وجود id. priority اختياري (رقم) - يُترك بدون تغيير لو undefined */
export async function saveExternalIntegration({ id, provider, display_name, is_active, priority, credentials, credentials_meta }) {
    const payload = id
        ? { action: 'update', id, display_name, is_active, priority, credentials, credentials_meta }
        : { action: 'create', provider, owner_scope: 'platform', display_name, is_active, priority, credentials, credentials_meta };

    const { data, error } = await supabase.functions.invoke('manage-external-integration', { body: payload });
    if (error) throw new Error('فشل حفظ التكامل: ' + error.message);
    if (data?.error) throw new Error(data.error);
    return data.integration;
}

export async function deleteExternalIntegration(id) {
    const { data, error } = await supabase.functions.invoke('manage-external-integration', { body: { action: 'delete', id } });
    if (error) throw new Error('فشل حذف التكامل: ' + error.message);
    if (data?.error) throw new Error(data.error);
}

/** الرد الآن قد يتضمن أيضاً models (لو المزود بيدعم اكتشاف موديلات) - راجع fetchIntegrationModels لقراءتها من الجدول مباشرة أي وقت */
export async function testExternalIntegration(id) {
    const { data, error } = await supabase.functions.invoke('test-integration-connection', { body: { id } });
    if (error) throw new Error('فشل اختبار الاتصال: ' + error.message);
    if (data?.error) throw new Error(data.error);
    return data; // { success, message, models? }
}

/** الموديلات المكتشفة/المحفوظة لتكامل معيّن (external_integration_models) - RLS بيسمح بالقراءة فقط لنفس نطاق التكامل */
export async function fetchIntegrationModels(integrationId) {
    if (!integrationId) return [];
    const { data, error } = await supabase
        .from(EXTERNAL_INTEGRATION_MODELS_TABLE)
        .select('id, model_id, display_name, supports_chat, supports_vision, supports_tools, supports_streaming, context_window, max_output_tokens, input_price, output_price, is_default, is_enabled')
        .eq('integration_id', integrationId)
        .order('display_name', { ascending: true });
    if (error) throw error;
    return data || [];
}

/** المزود الافتراضي للذكاء الاصطناعي في شات بوت الموقع - صف bot_settings حيث phone_number_id IS NULL */
export async function fetchDefaultAiProvider() {
    const { data, error } = await supabase
        .from('bot_settings')
        .select('id, ai_integration_id')
        .is('phone_number_id', null)
        .limit(1)
        .maybeSingle();
    if (error) throw error;
    return data?.ai_integration_id || '';
}

export async function saveDefaultAiProvider(integrationId) {
    const value = integrationId || null;
    const { data: existing, error: fetchErr } = await supabase
        .from('bot_settings')
        .select('id')
        .is('phone_number_id', null)
        .limit(1)
        .maybeSingle();
    if (fetchErr) throw fetchErr;

    if (existing) {
        const { error } = await supabase.from('bot_settings').update({ ai_integration_id: value, ai_enabled: !!value }).eq('id', existing.id);
        if (error) throw error;
    } else {
        const { error } = await supabase.from('bot_settings').insert({ ai_integration_id: value, ai_enabled: !!value });
        if (error) throw error;
    }
}

/* =========================================================
 *  Mad3oom كـ MCP Server (Phase 3) - قراءة/تحكم فقط، بدون منطق مكرر
 *  البيانات كلها قادمة من mcp-server-info (نفس TOOLS المستخدمة فعليًا
 *  في mcp/index.ts). أي capability جديدة تُضاف مستقبلاً من الباك إند
 *  فقط، والواجهة تعرضها تلقائياً بدون أي تعديل هنا.
 * ========================================================= */

export const MCP_ENDPOINT_URL = `${supabase.supabaseUrl}/functions/v1/mcp`;

/* =========================================================
 *  إعدادات OAuth 2.1 (Phase 4) - تُجلب تلقائيًا من الخادم فقط
 *  عبر oauth-discovery (RFC 8414) وoauth-protected-resource (RFC 9728).
 *  لا تُكتب أي قيمة يدويًا هنا - أي تغيير مستقبلي في الخادم (رابط، PKCE،
 *  طريقة مصادقة جديدة...) ينعكس تلقائيًا في الواجهة بدون أي تعديل هنا.
 * ========================================================= */

/** الروابط العامة الثابتة (Reverse Proxy عبر mad3oom.online) - لا تتغيّر حتى لو تغيّر مشروع Supabase */
export const OAUTH_DISCOVERY_URL = 'https://mad3oom.online/.well-known/oauth-authorization-server';
export const OAUTH_PROTECTED_RESOURCE_URL = 'https://mad3oom.online/.well-known/oauth-protected-resource';

/**
 * يرجّع كل إعدادات OAuth تلقائيًا للعرض في لوحة التحكم:
 * { status: 'connected'|'error', issuer, authorization_endpoint, token_endpoint,
 *   registration_endpoint, discovery_url, protected_resource_metadata_url,
 *   code_challenge_methods_supported, token_endpoint_auth_methods_supported,
 *   scopes_supported, resource, authorization_servers, error? }
 */
export async function fetchOAuthConfig() {
    try {
        const [discoveryRes, resourceRes] = await Promise.all([
            supabase.functions.invoke('oauth-discovery'),
            supabase.functions.invoke('oauth-protected-resource'),
        ]);

        if (discoveryRes.error) throw new Error('فشل جلب OAuth Discovery: ' + discoveryRes.error.message);
        if (resourceRes.error) throw new Error('فشل جلب Protected Resource Metadata: ' + resourceRes.error.message);

        const discovery = discoveryRes.data || {};
        const resource = resourceRes.data || {};

        if (discovery.error || resource.error) {
            throw new Error(discovery.error_description || resource.error_description || 'رد غير متوقع من خدمات OAuth');
        }

        return {
            status: 'connected',
            issuer: discovery.issuer || '',
            authorization_endpoint: discovery.authorization_endpoint || '',
            token_endpoint: discovery.token_endpoint || '',
            registration_endpoint: discovery.registration_endpoint || '',
            discovery_url: OAUTH_DISCOVERY_URL,
            protected_resource_metadata_url: OAUTH_PROTECTED_RESOURCE_URL,
            code_challenge_methods_supported: discovery.code_challenge_methods_supported || [],
            token_endpoint_auth_methods_supported: discovery.token_endpoint_auth_methods_supported || [],
            scopes_supported: discovery.scopes_supported || [],
            resource: resource.resource || '',
            authorization_servers: resource.authorization_servers || [],
        };
    } catch (err) {
        return {
            status: 'error',
            error: err.message || 'تعذّر الاتصال بخدمات OAuth',
            discovery_url: OAUTH_DISCOVERY_URL,
            protected_resource_metadata_url: OAUTH_PROTECTED_RESOURCE_URL,
        };
    }
}

export async function fetchMcpServerInfo(action = 'status') {
    const { data, error } = await supabase.functions.invoke('mcp-server-info', { body: { action } });
    if (error) throw new Error('فشل جلب معلومات MCP Server: ' + error.message);
    if (data?.error) throw new Error(data.error);
    return data; // { status, endpoint, protocol_version, transport, authentication_methods, capabilities, tools, resources_info, server_info }
}

/** enabled=false يعطّل الأداة على مستوى المنصة كلها لأي عميل MCP خارجي */
export async function setMcpServerToolEnabled(toolName, enabled) {
    const { data, error } = await supabase.functions.invoke('mcp-server-info', {
        body: { action: 'set_tool', tool_name: toolName, enabled },
    });
    if (error) throw new Error('فشل تحديث حالة الأداة: ' + error.message);
    if (data?.error) throw new Error(data.error);
    return data; // { success, tools }
}
export const MCP_CATALOG_CATEGORIES = [
    { key: 'all', label: 'الكل' },
    { key: 'database', label: 'قواعد البيانات' },
    { key: 'development', label: 'أدوات المطورين' },
    { key: 'communication', label: 'التواصل' },
    { key: 'productivity', label: 'الإنتاجية' },
    { key: 'custom', label: 'مخصص' }
];

export const MCP_CLIENT_CATALOG = [];

export function findConnectedServerForCatalogEntry(entry, servers = []) {
    return servers.find(s =>
        (s.url || '').replace(/\/$/, '') === (entry.url || '').replace(/\/$/, '')
    ) || null;
}

export async function invokeMcpTool() {
    throw new Error('invokeMcpTool غير منفذة بعد');
}
