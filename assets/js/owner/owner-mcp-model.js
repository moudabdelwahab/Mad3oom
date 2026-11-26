/**
 * owner-mcp-model.js — منطق قسم خوادم MCP في صفحة مالك التكاملات (بلا DOM ولا شبكة).
 *
 * القراءة عبر owner_list_mcp_servers() (الترحيل 147، غير موجود في هذا الفرع
 * بعد): كل mcp_servers + mcp_server_connections بلا أعمدة سرية. الصفوف قد
 * تأتي مسطّحة (خادم + اتصال في صف واحد) أو صفًا لكل اتصال — تُدمج هنا
 * بخادم واحد، واتصال المالك الحالي أولًا للحالة والأدوات ونوع المصادقة
 * (هو وحده ما يمكن اختباره وربطه من هنا؛ دوال الحافة تفرض الملكية
 * بمفتاح service_role).
 *
 * الكتابة: تعريف الخادم عبر mcp-service.js المباشر (create/update/delete) —
 * سياسات 048: owner_id = auth.uid()، فخادم غيرك قراءة فقط هنا. بيانات
 * الاعتماد والاختبار وOAuth عبر دوال الحافة كما هي (save-mcp-credentials /
 * test-mcp-server / mcp-oauth-start).
 *
 * الحالات هنا نسخة من MCP_STATUSES في /mcp-service.js — تُعاد كتابتها هنا
 * عمدًا لتبقى هذه الوحدة بلا تبعيات وقابلة للاختبار في Node (mcp-service.js
 * يستورد /api-config.js).
 */
export const MCP_STATUSES = Object.freeze({
    CONNECTED: 'connected',
    DISCONNECTED: 'disconnected',
    ERROR: 'error',
    PENDING: 'pending'
});

export const MCP_STATUS_LABELS = Object.freeze({
    connected: 'متصل',
    disconnected: 'غير متصل',
    error: 'خطأ',
    pending: 'بانتظار الربط'
});

export const MCP_STATUS_TONES = Object.freeze({
    connected: 'status-resolved',
    disconnected: 'status-neutral',
    error: 'status-rejected',
    pending: 'status-pending'
});

export const MCP_TRANSPORT_LABELS = Object.freeze({
    streamable_http: 'HTTP متدفق',
    sse: 'SSE',
    stdio: 'stdio'
});

export const MCP_AUTH_LABELS = Object.freeze({
    none: 'بلا مصادقة',
    api_key: 'مفتاح API',
    bearer: 'رمز وصول',
    oauth2: 'OAuth',
    custom: 'ترويسات مخصّصة'
});

export const mcpStatusLabel = (status) => MCP_STATUS_LABELS[status] || MCP_STATUS_LABELS.pending;
export const mcpStatusTone = (status) => MCP_STATUS_TONES[status] || MCP_STATUS_TONES.pending;

/**
 * يدمج صفوف owner_list_mcp_servers() في خادم واحد لكل معرّف.
 * row: { id, name, transport, url, command, args, env, headers, description,
 *   category, connector_type, enabled, owner_id, created_by, created_at,
 *   updated_at, connection_id?, auth_type?, status?, tools?, last_checked_at?,
 *   last_error?, oauth_*? } — الحقول بلا اتصال قد تكون null.
 */
export function normalizeMcpServers(rows, meId) {
    const byId = new Map();
    for (const row of rows || []) {
        if (!row?.id) continue;
        let server = byId.get(row.id);
        if (!server) {
            server = {
                id: row.id,
                name: row.name || '',
                transport: row.transport || 'streamable_http',
                url: row.url || '',
                command: row.command || '',
                description: row.description || '',
                category: row.category || 'general',
                connector_type: row.connector_type || 'mcp_server',
                enabled: row.enabled !== false,
                owner_id: row.owner_id || null,
                created_by: row.created_by || null,
                created_at: row.created_at || null,
                updated_at: row.updated_at || null,
                status: MCP_STATUSES.PENDING,
                tools: [],
                auth_type: 'none',
                connection_id: null,
                last_checked_at: null,
                last_error: null,
                _mine: null,
                _other: null
            };
            byId.set(row.id, server);
        }
        if (!row.connection_id && !row.status) continue;
        const conn = {
            connection_id: row.connection_id || null,
            owner_id: row.connection_owner_id || row.owner_id || null,
            auth_type: row.auth_type || 'none',
            status: row.status || MCP_STATUSES.PENDING,
            tools: Array.isArray(row.tools) ? row.tools : [],
            last_checked_at: row.last_checked_at || null,
            last_error: row.last_error || null
        };
        if (meId && conn.owner_id === meId) server._mine = conn;
        else if (!server._other) server._other = conn;
    }
    return [...byId.values()].map((s) => {
        const conn = s._mine || s._other;
        const mine = !!s._mine;
        delete s._mine;
        delete s._other;
        return {
            ...s,
            status: conn?.status || MCP_STATUSES.PENDING,
            tools: conn?.tools || [],
            auth_type: conn?.auth_type || 'none',
            connection_id: conn?.connection_id || null,
            last_checked_at: conn?.last_checked_at || null,
            last_error: conn?.last_error || null,
            mine
        };
    }).sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
}

/** الكتابة المباشرة على تعريف الخادم مسموحة لمالكه وحده (سياسات 048). */
export const canManageMcpServer = (server, meId) => !!meId && !!server && server.owner_id === meId;

/** الاختبار والاعتماد وOAuth: لاتصال المالك الحالي وحده — دوال الحافة تفرض الملكية. */
export const canTestMcpServer = (server) => !!server?.mine && !!server?.connection_id;

/** حقول بيانات الاعتماد لكل نوع مصادقة (save-mcp-credentials). */
export function credentialFields(authType) {
    switch (authType) {
        case 'api_key':
            return [
                { key: 'api_key', label: 'مفتاح API', type: 'password', required: true },
                { key: 'api_secret', label: 'السر (اختياري — فارغ = كما هو)', type: 'password' }
            ];
        case 'bearer':
            return [{ key: 'bearer_token', label: 'رمز الوصول', type: 'password', required: true }];
        case 'oauth2':
            return [
                { key: 'oauth_client_id', label: 'Client ID', type: 'text', required: true },
                { key: 'oauth_client_secret', label: 'Client Secret', type: 'password' },
                { key: 'oauth_authorize_url', label: 'رابط التفويض', type: 'url', required: true },
                { key: 'oauth_token_url', label: 'رابط التوكن', type: 'url', required: true },
                { key: 'oauth_scope', label: 'النطاق (اختياري)', type: 'text' }
            ];
        case 'custom':
            return [{ key: 'custom_config', label: 'إعداد مخصّص (JSON)', type: 'textarea' }];
        default:
            return [];
    }
}

/** تحقق نموذج تعريف الخادم — نفس قواعد normalizePayload في mcp-service.js. */
export function validateServerForm({ name, transport, url }) {
    if (!String(name || '').trim()) return { ok: false, error: 'اسم الخادم مطلوب' };
    if (transport !== 'stdio' && !String(url || '').trim()) return { ok: false, error: 'عنوان URL مطلوب لخوادم غير stdio' };
    return { ok: true };
}
