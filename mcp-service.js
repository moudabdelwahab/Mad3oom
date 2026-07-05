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
 *
 * بيانات الاعتماد (api_key / api_secret):
 *  - لا تُشفَّر أو تُفَك أبداً في هذا الملف (متصفح).
 *  - الحفظ: تُرسل صريحة مرة واحدة لدالة Edge Function
 *    "save-mcp-credentials" التي تشفّرها وتخزّنها (AES-GCM, MCP_ENC_KEY).
 *  - الاختبار: "test-mcp-server" تفك التشفير وتُجري الاتصال بالكامل من
 *    جهة الخادم، وتُرجع نتيجة مُعقَّمة فقط (بدون أي قيمة مفكوكة أو مشفّرة).
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
        // نستثني العمودين المشفّرين عمداً - لا سبب لإرسالهما للمتصفح إطلاقاً،
        // لا كنص صريح ولا حتى كنص مشفّر (لا فائدة تُعرض منه في الواجهة).
        const { data, error } = await supabase
            .from(TABLE)
            .select('id, name, transport, url, command, args, env, headers, description, category, enabled, status, tools, created_by, created_at, updated_at, last_checked_at')
            .order('created_at', { ascending: false });
        if (error) throw error;
        servers = data || [];
    } else {
        servers = readLocal();
    }
 
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
 * جلب خادم واحد عبر المعرّف (بدون أي حقول اعتماد - نفس منطق fetchServers)
 */
export async function fetchServerById(id) {
    const useDb = await detectStorageMode();
    if (useDb) {
        const { data, error } = await supabase
            .from(TABLE)
            .select('id, name, transport, url, command, args, env, headers, description, category, enabled, status, tools, created_by, created_at, updated_at, last_checked_at')
            .eq('id', id)
            .maybeSingle();
        if (error) throw error;
        return data;
    }
    return readLocal().find((s) => s.id === id) || null;
}

/**
 * يبعت المفتاح/السر الصريحين (لو وُجدا) لدالة save-mcp-credentials
 * لتشفيرهم وحفظهم مباشرة على الخادم (service_role + AES-GCM هناك فقط).
 * لا يحدث أي تشفير أو تمرير لنص صريح غير هذا النداء.
 */
async function persistCredentials(serverId, { api_key, api_secret } = {}) {
    if (!api_key && !api_secret) return;
    const { data, error } = await supabase.functions.invoke('save-mcp-credentials', {
        body: { server_id: serverId, api_key: api_key || '', api_secret: api_secret || '' },
    });
    if (error) throw new Error('فشل حفظ بيانات الاعتماد بأمان: ' + error.message);
    if (data?.error) throw new Error(data.error);
}
 
/**
 * إنشاء خادم MCP جديد
 * @param {object} payload
 */
export async function createServer(payload) {
    // api_key_encrypted هنا نص صريح قادم من النموذج (اسم الحقل قديم من الواجهة)،
    // وapi_secret نص صريح أيضاً. كلاهما لا يُخزَّن أبداً كنص صريح في قاعدة
    // البيانات أو في هذا الملف؛ يُرسلان فقط لـ save-mcp-credentials بعد
    // إنشاء الصف بدونهما، وهي التي تُشفّرهم وتكتبهم في عمودَي *_encrypted.
    const { api_key_encrypted: apiKeyPlain, api_secret: apiSecretPlain, ...rest } = payload;
    const record = normalizePayload(rest, true);
 
    const useDb = await detectStorageMode();
    if (useDb) {
        const { data, error } = await supabase.from(TABLE).insert(record).select().single();
        if (error) throw error;
        await persistCredentials(data.id, { api_key: apiKeyPlain, api_secret: apiSecretPlain });
        await logMcpActivity('created', data.id, { name: data.name });
        return data;
    }
 
    // وضع localStorage (تطوير محلي بدون Supabase): لا توجد دالة خلفية
    // لتشفير البيانات في هذه الحالة، فنحتفظ بالسلوك السابق كما هو.
    if (apiKeyPlain) record.api_key_encrypted = apiKeyPlain;
    if (apiSecretPlain) record.api_secret_encrypted = apiSecretPlain;
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
    const { api_key_encrypted: apiKeyPlain, api_secret: apiSecretPlain, ...rest } = payload;
    const updates = normalizePayload(rest, false);
 
    const useDb = await detectStorageMode();
    if (useDb) {
        const { data, error } = await supabase
            .from(TABLE)
            .update(updates)
            .eq('id', id)
            .select()
            .single();
        if (error) throw error;
        await persistCredentials(id, { api_key: apiKeyPlain, api_secret: apiSecretPlain });
        await logMcpActivity('updated', id, { name: data.name });
        return data;
    }
 
    const servers = readLocal();
    const idx = servers.findIndex((s) => s.id === id);
    if (idx === -1) throw new Error('الخادم غير موجود');
    if (apiKeyPlain) updates.api_key_encrypted = apiKeyPlain;
    if (apiSecretPlain) updates.api_secret_encrypted = apiSecretPlain;
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
 * الاختبار بالكامل (فك التشفير + initialize + tools/list) يحدث الآن
 * داخل دالة Edge Function "test-mcp-server" فقط. هذا الملف لا يعمل
 * fetch مباشر لأي خادم MCP بعيد، ولا يبني Authorization header، ولا
 * يرى أي قيمة مفكوكة أو مشفّرة - فقط نتيجة الاختبار النهائية.
 */
export async function testServer(id) {
    const server = await fetchServerById(id);
    if (!server) throw new Error('الخادم غير موجود');

    const useDb = await detectStorageMode();
    if (!useDb) {
        // وضع localStorage: لا توجد دالة خلفية لفك التشفير/الاتصال، فلا يوجد
        // اختبار اتصال حقيقي متاح في هذا الوضع (بيئة تطوير بدون Supabase).
        throw new Error('اختبار الاتصال متاح فقط عند استخدام Supabase (localStorage غير مدعوم لهذه العملية)');
    }

    const { data, error } = await supabase.functions.invoke('test-mcp-server', {
        body: { server_id: id },
    });

    const result = error || data?.error
        ? { ok: false, message: (data?.error) || error.message || 'فشل الاتصال', tools: 0 }
        : data;

    await logMcpActivity(result.ok ? 'connected' : 'error', id, {
        name: server.name,
        message: result.message,
    });

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
 
/**
 * تنظيف وتوحيد بيانات الإدخال قبل الحفظ + تحقق من الصحة.
 * ملاحظة: بيانات الاعتماد (api_key / api_secret) لا تُعالَج هنا أبداً -
 * تُستثنى في createServer/updateServer قبل الوصول لهذه الدالة، وتُمرَّر
 * لـ persistCredentials بشكل منفصل تماماً.
 *
 * ملاحظة مهمة: هذه الدالة تُستخدم في وضعين:
 *   1) isNew = true  → إنشاء خادم جديد، كل الحقول الأساسية (name/url) مطلوبة.
 *   2) isNew = false → تحديث خادم موجود. قد يكون هذا تحديثاً "جزئياً"
 *      يُرسل من الكود الداخلي (مثل disconnectServer) ولا يحتوي إلا على
 *      status/last_checked_at. لذلك لا نفرض وجود name أو url إلا إذا
 *      أُرسلا فعلاً ضمن payload.
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
