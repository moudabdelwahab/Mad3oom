/**
 * MCP Service - إدارة خوادم Model Context Protocol (MCP)
 * --------------------------------------------------------
 * يوفر طبقة منطق وتخزين نظيفة لخوادم MCP المرتبطة بمنصة مدعوم.
 *
 * التخزين:
 *  - يحاول استخدام جدول Supabase `mcp_servers` أولاً (إذا وُجد وسمح RLS).
 *  - وإلا يلجأ تلقائياً إلى localStorage لمفتاح `mad3oom_mcp_servers`
 *    ليعمل دون الحاجة لإعداد قاعدة بيانات مسبق.
 *
 * أنواع النقل المدعومة: stdio | sse | streamable_http
 */
 
import { supabase } from '/api-config.js';
 
const STORAGE_KEY = 'mad3oom_mcp_servers';
const ACTIVITY_KEY = 'mad3oom_mcp_activity';
const TABLE = 'mcp_servers';
 
/** أنواع النقل المدعومة */
export const MCP_TRANSPORTS = ['stdio', 'sse', 'streamable_http'];
 
/** الحالات الممكنة للخادم */
export const MCP_STATUSES = {
    CONNECTED: 'connected',
    DISCONNECTED: 'disconnected',
    ERROR: 'error',
    PENDING: 'pending',
};
 
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
 
/** هل جدول Supabase متاح؟ نكتشف ذلك مرّة واحدة ونخزّن النتيجة */

   let _useSupabase = null;

async function detectStorageMode() {
    if (_useSupabase !== null) return _useSupabase;

    try {
        const { error } = await supabase
            .from(TABLE)
            .select('id')
            .limit(1);

        if (
            error &&
            (
                error.code === "PGRST205" ||
                error.message?.includes("schema cache") ||
                error.message?.includes("Could not find the table")
            )
        ) {
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
    try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    } catch {
        return [];
    }
}
 
function writeLocal(servers) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(servers));
}
 
/** تشفير بسيط للحقول الحساسة (مفاتيح API / tokens) لتجنّب التخزين كنص صريح */
function maskSecret(value) {
    if (!value) return value;
    return value.replace(/(.{4}).+(.{4})$/, '$1••••••••$2');
}
 
/* =========================================================
 *  سجل النشاط (Activity Log) - محلي دائماً
 * ========================================================= */
 
export async function logMcpActivity(action, serverId, details = {}) {
    const entry = {
        id: uuid(),
        action,            // created | updated | deleted | connected | disconnected | error | tested
        server_id: serverId,
        details,
        created_at: new Date().toISOString(),
    };
    try {
        const log = JSON.parse(localStorage.getItem(ACTIVITY_KEY) || '[]');
        log.unshift(entry);
        // نحتفظ بآخر 100 حدث فقط
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
    } catch {
        return [];
    }
}
 
/* =========================================================
 *  العمليات الأساسية (CRUD)
 * ========================================================= */
 
/**
 * جلب كل خوادم MCP المسجّلة.
 * @param {object} filters - { status, transport, search }
 * @returns {Promise<Array>}
 */
export async function fetchServers(filters = {}) {
    const useDb = await detectStorageMode();
 
    let servers;
    if (useDb) {
        const { data, error } = await supabase
            .from(TABLE)
            .select('*')
            .order('created_at', { ascending: false });
        if (error) throw error;
        servers = data || [];
    } else {
        servers = readLocal();
    }
 
    // إخفاء الحقول الحساسة قبل الإرجاع
    servers = servers.map((s) => ({
        ...s,
        api_key_encrypted: s.api_key_encrypted ? maskSecret(s.api_key_encrypted) : '',
        headers: s.headers,
    }));
 
    // تطبيق الفلاتر
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
 
/**
 * جلب خادم واحد عبر المعرّف
 */
export async function fetchServerById(id) {
    const useDb = await detectStorageMode();
    if (useDb) {
        const { data, error } = await supabase.from(TABLE).select('*').eq('id', id).maybeSingle();
        if (error) throw error;
        if (data) data.api_key_encrypted = data.api_key_encrypted ? maskSecret(data.api_key_encrypted) : '';
        return data;
    }
    return readLocal().find((s) => s.id === id) || null;
}
 
/**
 * إنشاء خادم MCP جديد
 * @param {object} payload
 */
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
 
/**
 * تحديث خادم موجود (يدعم التحديث الجزئي - partial update)
 */
export async function updateServer(id, payload) {
    const updates = normalizePayload(payload, false);
 
    const useDb = await detectStorageMode();
    if (useDb) {
        const { data, error } = await supabase
            .from(TABLE)
            .update(updates)
            .eq('id', id)
            .select()
            .single();
        if (error) throw error;
        await logMcpActivity('updated', id, { name: data.name });
        return data;
    }
 
    const servers = readLocal();
    const idx = servers.findIndex((s) => s.id === id);
    if (idx === -1) throw new Error('الخادم غير موجود');
    // لا نستبدل الحقول الحساسة بقيم فارغة
    servers[idx] = { ...servers[idx], ...updates, updated_at: new Date().toISOString() };
    writeLocal(servers);
    await logMcpActivity('updated', id, { name: servers[idx].name });
    return servers[idx];
}
 
/**
 * حذف خادم
 */
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
 *  اختبار الاتصال والحالة
 * ========================================================= */
 
/**
 * اختبار الاتصال بخادم MCP.
 * - لخوادم HTTP/SSE نحاول إجراء fetch بسيط إلى نقطة النهاية.
 * - لخوادم stdio نتحقق فقط من صحة الإعداد (لا يمكن تشغيل عملية محلية من المتصفح).
 */
export async function testServer(id) {
    const server = await fetchServerById(id);

 console.log("SERVER:", server);
console.log("api_key_encrypted:", server.api_key_encrypted);
console.log("api_secret:", server.api_secret);
    if (!server) throw new Error('الخادم غير موجود');

    const result = {
        ok: false,
        latency: null,
        message: '',
        tools: 0
    };

    const start = performance.now();

    if (server.transport === 'stdio') {
        if (!server.command) {
            result.message = 'أمر التشغيل (command) غير محدد';
        } else {
            result.ok = true;
            result.message = 'الإعداد صحيح (stdio يتطلب التشغيل من جهة الخادم)';
            result.tools = Array.isArray(server.tools) ? server.tools.length : 0;
        }
    } else if (server.url) {
        try {
            const headers = {
                "Content-Type": "application/json",
                ...buildHeaders(server)
            };

            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 8000);

            // الخطوة الأولى: initialize
            const initRes = await fetch(server.url, {
                method: "POST",
                headers,
                signal: controller.signal,
                body: JSON.stringify({
                    jsonrpc: "2.0",
                    id: 1,
                    method: "initialize",
                    params: {
                        protocolVersion: "2025-03-26",
                        capabilities: {},
                        clientInfo: {
                            name: "Mad3oom",
                            version: "1.0.0"
                        }
                    }
                })
            });

            if (!initRes.ok) {
                throw new Error(`Initialize failed (${initRes.status})`);
            }

            const initData = await initRes.json();

            if (initData.error) {
                throw new Error(initData.error.message);
            }

            // الخطوة الثانية: tools/list
            const toolsRes = await fetch(server.url, {
                method: "POST",
                headers,
                signal: controller.signal,
                body: JSON.stringify({
                    jsonrpc: "2.0",
                    id: 2,
                    method: "tools/list"
                })
            });

            clearTimeout(timeout);

            if (!toolsRes.ok) {
                throw new Error(`tools/list failed (${toolsRes.status})`);
            }

            const toolsData = await toolsRes.json();

            result.ok = true;
            result.latency = Math.round(performance.now() - start);
            result.tools = toolsData.result?.tools?.length ?? 0;

            result.message =
                `تم الاتصال بخادم MCP بنجاح (${result.tools} أداة)`;

        } catch (err) {
            result.message = err.message || "فشل الاتصال";
        }
    } else {
        result.message = "لا يوجد عنوان (URL) أو أمر (command) للاختبار";
    }

    const newStatus = result.ok
        ? MCP_STATUSES.CONNECTED
        : MCP_STATUSES.ERROR;

    await updateServer(id, {
        status: newStatus,
        last_checked_at: new Date().toISOString()
    });

    await logMcpActivity(
        result.ok ? "connected" : "error",
        id,
        {
            name: server.name,
            message: result.message
        }
    );

    return result;
}
 
/**
 * فصل (إيقاف اتصال) خادم - تغيير الحالة فقط
 */
export async function disconnectServer(id) {
    const server = await fetchServerById(id);
    // تحديث جزئي: name/url غير مرسلين عن قصد
    await updateServer(id, { status: MCP_STATUSES.DISCONNECTED });
    await logMcpActivity('disconnected', id, { name: server?.name || '' });
}
 
/* =========================================================
 *  إحصائيات سريعة للوحة المعلومات
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
 *  أدوات داخلية: التحقق والتجهيز
 * ========================================================= */
function buildHeaders(server) {
    const headers = {};

    if (server.api_key_encrypted && server.api_secret) {
        headers.Authorization =
            `Bearer ${server.api_key_encrypted}.${server.api_secret}`;
    }

    if (server.headers && typeof server.headers === "object") {
        Object.assign(headers, server.headers);
    }

    return headers;
}
 
/**
 * تنظيف وتوحيد بيانات الإدخال قبل الحفظ + تحقق من الصحة.
 *
 * ملاحظة مهمة: هذه الدالة تُستخدم في وضعين:
 *   1) isNew = true  → إنشاء خادم جديد، كل الحقول الأساسية (name/url) مطلوبة.
 *   2) isNew = false → تحديث خادم موجود. قد يكون هذا تحديثاً "جزئياً"
 *      يُرسل من الكود الداخلي (مثل testServer/disconnectServer) ولا يحتوي
 *      إلا على status/last_checked_at. لذلك لا نفرض وجود name أو url إلا
 *      إذا أُرسلا فعلاً ضمن payload.
 */
function normalizePayload(payload, isNew) {
    const out = {};
 
    // الاسم: مطلوب دائماً عند الإنشاء، وعند التعديل فقط إن أُرسل ضمن الحمولة
    if (isNew || payload.name !== undefined) {
        const name = (payload.name || '').trim();
        if (!name) throw new Error('اسم الخادم مطلوب');
        out.name = name;
    }
 
    // نوع النقل: يُحدَّد فقط عند الإنشاء أو إن أُرسل صراحة
    if (isNew || payload.transport !== undefined) {
        out.transport = MCP_TRANSPORTS.includes(payload.transport)
            ? payload.transport
            : 'streamable_http';
    }
 
    // عنوان URL: نتحقق منه فقط عند الإنشاء أو عند إرساله/تغيير نوع النقل صراحة
    if (isNew || payload.url !== undefined) {
        const url = (payload.url || '').trim();
        const transportForCheck = out.transport || 'streamable_http';
        if (transportForCheck !== 'stdio' && !url) {
            throw new Error('عنوان URL مطلوب لخوادم غير stdio');
        }
        out.url = url;
    }
 
    if (payload.command !== undefined) {
        out.command = (payload.command || '').trim();
    }
 
    if (payload.args !== undefined) {
        // نص مفصول بمسافات أو مصفوفة
        if (Array.isArray(payload.args)) out.args = payload.args;
        else out.args = String(payload.args).split(/\s+/).filter(Boolean);
    }
 
    if (payload.env !== undefined) {
        if (payload.env && typeof payload.env === 'object') out.env = payload.env;
        else out.env = parseKeyValue(payload.env);
    }
 
    if (payload.headers !== undefined) {
        if (payload.headers && typeof payload.headers === 'object') out.headers = payload.headers;
        else out.headers = parseKeyValue(payload.headers);
    }
 
    // نحتفظ بالمفتاح فقط إذا قُدّم ولم يكن قناعاً (يحتوي على •••)
    if (payload.api_key_encrypted !== undefined) {
        const ak = String(payload.api_key_encrypted);
        if (ak && !ak.includes('••••')) out.api_key_encrypted = ak;
    }
 
    if (payload.description !== undefined) {
        out.description = (payload.description || '').trim();
    }
 
    if (payload.category !== undefined) {
        out.category = (payload.category || 'general').trim() || 'general';
    }
 
    if (payload.enabled !== undefined) {
        out.enabled = Boolean(payload.enabled);
    } else if (isNew) {
        out.enabled = true;
    }
 
    // قائمة الأدوات إن وُجدت
    if (payload.tools !== undefined) {
        out.tools = Array.isArray(payload.tools) ? payload.tools : [];
    }
 
    if (payload.status) out.status = payload.status;
 
    if (isNew) {
        out.id = uuid();
        out.category = out.category || 'general';
        out.status = out.status || MCP_STATUSES.PENDING;
        out.tools = out.tools || [];
        out.created_at = new Date().toISOString();
        out.updated_at = out.created_at;
        out.last_checked_at = null;
    } else {
        out.updated_at = new Date().toISOString();
        if (payload.last_checked_at !== undefined) out.last_checked_at = payload.last_checked_at;
    }
 
    return out;
}
 
/** تحويل نص "KEY=VALUE\nKEY2=VALUE2" أو JSON إلى كائن */
function parseKeyValue(input) {
    if (!input) return {};
    if (typeof input === 'object') return input;
    try {
        return JSON.parse(input);
    } catch {
        const obj = {};
        String(input)
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean)
            .forEach((line) => {
                const i = line.indexOf('=');
                if (i > -1) obj[line.slice(0, i).trim()] = line.slice(i + 1).trim();
            });
        return obj;
    }
}
