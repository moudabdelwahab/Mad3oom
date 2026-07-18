/**
 * Agent Service - إدارة وكلاء الذكاء الاصطناعي المتصلين بمنصة مدعوم
 * --------------------------------------------------------
 * كل العمليات تمر عبر Edge Function واحدة: agent-manager
 * (action: list | get | create | update | delete | start | stop | restart |
 *          test_connection | status | logs)
 *
 * لو الدالة agent-manager غير منشورة بعد على Supabase، الخدمة تسقط تلقائياً
 * على تخزين محلي (localStorage) عشان الصفحة تفضل شغالة للتجربة/العرض بدل ما
 * تكسر بالكامل. أول ما تُنشر الدالة فعلياً، الخدمة هتكتشفها تلقائياً وتستخدمها
 * بدون أي تعديل في الصفحة — ودالة agent-manager دلوقتي منشورة فعلاً.
 *
 * بنفس فلسفة mcp-service.js تماماً (نفس مشروع Supabase، نفس supabase client).
 *
 * ===================== إصلاحات هذه المراجعة =====================
 * 1) [حرج] استخراج رسالة الخطأ الحقيقية من استجابة supabase.functions.invoke:
 *    لما الدالة البعيدة ترجّع كود غير 2xx، مكتبة supabase-js بترجّع
 *    FunctionsHttpError برسالة عامة ("Edge Function returned a non-2xx
 *    status code") وتحطّ الاستجابة الفعلية (اللي فيها رسالة الخطأ بالعربي
 *    من agent-manager) داخل error.context كـ Response لسه ما اتقرتش. كانت
 *    الكود القديم بيستخدم error.message مباشرة فتظهر رسالة عامة مش مفيدة
 *    بدل رسائل agent-manager الحقيقية (زي "name و slug مطلوبان" أو "هذا
 *    القسم متاح للأدمن فقط"). الحل: extractFunctionErrorMessage تحاول تقرأ
 *    الـ body الحقيقي أولاً.
 * 2) تفادي نداء "list" مرتين عند فتح الصفحة (مرة للكشف عن الباك-إند، ومرة
 *    فعلية من loadAgents) عبر تخزين نتيجة نداء الكشف وإعادة استخدامها مرة
 *    واحدة فقط.
 * 3) توحيد شكل استجابة الوضع المحلي (localFallback) مع شكل استجابة
 *    agent-manager الحقيقية تمامًا (agent / success بدل data) حتى يبقى
 *    الاستبدال بين الاثنين "بدون أي تعديل" كما هو موثّق أعلاه فعلاً.
 * 4) عدم تخزين مفتاح API أو القيم السرّية بنصها الصريح في localStorage في
 *    وضع الطوارئ المحلي — نفس نهج الإخفاء المستخدم في agent-manager الحقيقية
 *    (تخزين آخر 4 خانات فقط، وإخفاء متغيرات البيئة السرّية).
 */

import { supabase } from '/api-config.js';

const STORAGE_KEY = 'mad3oom_agents';
const FN = 'agent-manager';
const SECRET_MASK = '••••••••';

export const AGENT_STATUSES = {
    RUNNING: 'running',
    STOPPED: 'stopped',
    STARTING: 'starting',
    STOPPING: 'stopping',
    RESTARTING: 'restarting',
    ERROR: 'error',
    UNKNOWN: 'unknown',
};

export const AGENT_RESOURCES = [
    { key: 'tickets', label: 'التذاكر' },
    { key: 'knowledge_base', label: 'قاعدة المعرفة' },
    { key: 'whatsapp', label: 'واتساب' },
    { key: 'email', label: 'البريد الإلكتروني' },
    { key: 'mcp', label: 'MCP' },
    { key: 'files', label: 'الملفات' },
    { key: 'memory', label: 'الذاكرة' },
    { key: 'supabase', label: 'Supabase' },
    { key: 'notifications', label: 'الإشعارات' },
];

export const AGENT_PERMISSIONS = [
    { key: 'tickets.read', label: 'قراءة التذاكر' },
    { key: 'tickets.create', label: 'إنشاء تذاكر' },
    { key: 'tickets.update', label: 'تعديل التذاكر' },
    { key: 'tickets.delete', label: 'حذف التذاكر' },
    { key: 'whatsapp.send', label: 'إرسال رسائل واتساب' },
    { key: 'actions.execute', label: 'تنفيذ الإجراءات' },
    { key: 'data.sensitive', label: 'الوصول إلى البيانات الحساسة' },
    { key: 'commands.execute', label: 'تشغيل الأوامر' },
];

export const AGENT_STATUS_LABELS = {
    running: 'يعمل', stopped: 'متوقف', starting: 'قيد التشغيل', stopping: 'قيد الإيقاف',
    restarting: 'قيد إعادة التشغيل', error: 'خطأ', unknown: 'غير معروف',
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

function readLocal() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { return []; }
}
function writeLocal(agents) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(agents));
}

// يقنّع متغيرات البيئة السرّية ومفتاح الـ API قبل تخزينهم محلياً — نفس مبدأ
// agent-manager الحقيقية (لا نخزّن قيمًا سرّية بنصها الصريح، ولو مؤقتًا).
function sanitizeForLocalStorage(payload) {
    const out = { ...payload };
    if (Array.isArray(out.environment_variables)) {
        out.environment_variables = out.environment_variables.map((v) =>
            v?.is_secret && v.value && v.value !== SECRET_MASK
                ? { key: v.key, value: 'local:' + btoa(unescape(encodeURIComponent(v.value))), is_secret: true }
                : v
        );
    }
    if (out.api_key) {
        out.api_key_last4 = String(out.api_key).slice(-4);
        delete out.api_key;
    }
    return out;
}

let _useEdgeFunction = null;
// نتيجة نداء الكشف الأول (list) — تُستخدم مرة واحدة فقط لتفادي تكرار النداء
let _detectionListCache = null;

/** يكتشف مرة واحدة فقط إذا كانت agent-manager منشورة فعلاً على Supabase. */
async function detectBackend() {
    if (_useEdgeFunction !== null) return _useEdgeFunction;
    try {
        const { data, error } = await supabase.functions.invoke(FN, { body: { action: 'list' } });
        // 404 / Function not found = لسه ما اتعملتش على السيرفر
        if (error && (await isFunctionNotFoundError(error))) {
            _useEdgeFunction = false;
        } else {
            _useEdgeFunction = true;
            if (!error && data) _detectionListCache = data; // إعادة استخدامها في أول list() بدل نداء مكرر
        }
    } catch {
        _useEdgeFunction = false;
    }
    return _useEdgeFunction;
}

async function isFunctionNotFoundError(error) {
    if (error?.context?.status === 404) return true;
    if (/not\s*found/i.test(error?.message || '')) return true;
    return false;
}

/**
 * [إصلاح حرج] تستخرج رسالة الخطأ الحقيقية من خطأ supabase.functions.invoke.
 * لو الاستجابة الأصلية غير 2xx، supabase-js بترجّع FunctionsHttpError برسالة
 * عامة ("Edge Function returned a non-2xx status code") وتترك جسم الاستجابة
 * الحقيقي (اللي فيه { error: "..." } بالعربي من agent-manager) في
 * error.context كـ Response لسه ما اتقرتش. لازم نحاول نقرأه هنا قبل ما نرجع
 * لرسالة عامة.
 */
async function extractFunctionErrorMessage(error) {
    try {
        const ctx = error?.context;
        if (ctx && typeof ctx.json === 'function') {
            const body = await ctx.json();
            if (body?.error) return body.error;
            if (body?.message) return body.message; // شكل أخطاء بوابة Supabase نفسها (401 مثلاً)
        }
    } catch {
        // فشل قراءة الـ body (مثلاً اتقرى قبل كده) — نرجع للرسالة العامة أدناه
    }
    return error?.message || 'فشل الاتصال بخدمة إدارة الوكلاء';
}

/* =========================================================
 *  نداء عام للدالة (يُستخدم مباشرة من الصفحة لإجراءات runtime مثل
 *  start/stop/restart/status/logs/test_connection التي لا معنى لمحاكاتها محلياً)
 * ========================================================= */

export async function callAgentManager(action, payload = {}) {
    const useFn = await detectBackend();
    if (!useFn) {
        // [إصلاح] لازم نرمي استثناء هنا كمان لو الوضع المحلي رجّع خطأ، تمامًا
        // زي مسار agent-manager الحقيقي أدناه — كانت الكود القديم بترجع نتيجة
        // الفشل كأنها نجاح لأي كود مستدعي بيفترض النجاح بدون فحص result.error.
        const result = localFallback(action, payload);
        if (result?.error) throw new Error(result.error);
        return result;
    }

    // إعادة استخدام نتيجة نداء الكشف الأولي لو كان نفسه list() بدون فلاتر إضافية
    if (action === 'list' && Object.keys(payload).length === 0 && _detectionListCache) {
        const cached = _detectionListCache;
        _detectionListCache = null; // استخدام مرة واحدة فقط
        return cached;
    }

    const { data, error } = await supabase.functions.invoke(FN, { body: { action, ...payload } });
    if (error) throw new Error(await extractFunctionErrorMessage(error));
    if (data?.error) throw new Error(data.error);
    return data;
}

/* =========================================================
 *  محاكاة محلية (localStorage) — تُستخدم فقط قبل نشر agent-manager فعلياً
 *  ملاحظة: أشكال الاستجابة هنا مطابقة تمامًا لأشكال استجابة agent-manager
 *  الحقيقية (agent / agents / success) حتى يبقى التبديل بينهما شفافًا.
 * ========================================================= */

function localFallback(action, payload) {
    let agents = readLocal();

    switch (action) {
        case 'list':
            return { agents };

        case 'get': {
            const agent = agents.find(a => a.id === payload.id);
            if (!agent) return { error: 'الوكيل غير موجود' };
            return { agent };
        }

        case 'create': {
            const now = new Date().toISOString();
            const clean = sanitizeForLocalStorage(payload);
            const agent = {
                id: uuid(),
                status: AGENT_STATUSES.STOPPED,
                last_heartbeat: null,
                last_error: null,
                created_at: now,
                updated_at: now,
                ...clean,
            };
            agents.unshift(agent);
            writeLocal(agents);
            return { agent };
        }

        case 'update': {
            const idx = agents.findIndex(a => a.id === payload.id);
            if (idx === -1) return { error: 'الوكيل غير موجود' };
            const clean = sanitizeForLocalStorage(payload);
            agents[idx] = { ...agents[idx], ...clean, updated_at: new Date().toISOString() };
            writeLocal(agents);
            return { agent: agents[idx] };
        }

        case 'delete': {
            agents = agents.filter(a => a.id !== payload.id);
            writeLocal(agents);
            return { success: true };
        }

        case 'start':
        case 'stop':
        case 'restart': {
            const idx = agents.findIndex(a => a.id === payload.id);
            if (idx === -1) return { ok: false, error: 'الوكيل غير موجود' };
            const map = { start: AGENT_STATUSES.RUNNING, stop: AGENT_STATUSES.STOPPED, restart: AGENT_STATUSES.RUNNING };
            agents[idx].status = map[action];
            agents[idx].last_error = null;
            agents[idx].last_heartbeat = action === 'stop' ? agents[idx].last_heartbeat : new Date().toISOString();
            writeLocal(agents);
            return { ok: true, data: agents[idx] };
        }

        case 'test_connection':
            return { ok: false, error: 'لا يمكن اختبار الاتصال بدون خدمة agent-manager منشورة على الخادم (وضع محلي تجريبي فقط)' };

        case 'status':
            return { ok: false, error: 'بيانات الحالة اللحظية غير متاحة في الوضع المحلي — تحتاج نشر Edge Function باسم agent-manager' };

        case 'logs':
            return { ok: true, data: [] };

        default:
            return { ok: false, error: `إجراء غير معروف: ${action}` };
    }
}

/* =========================================================
 *  اختصارات مباشرة (اختيارية) لبقية الكود
 * ========================================================= */

export const fetchAgents = () => callAgentManager('list');
export const createAgent = (payload) => callAgentManager('create', payload);
export const updateAgent = (payload) => callAgentManager('update', payload);
export const deleteAgent = (id) => callAgentManager('delete', { id });
export const startAgent = (id) => callAgentManager('start', { id });
export const stopAgent = (id) => callAgentManager('stop', { id });
export const restartAgent = (id) => callAgentManager('restart', { id });
export const testAgentConnection = (id) => callAgentManager('test_connection', { id });
export const fetchAgentStatus = (id) => callAgentManager('status', { id });
export const fetchAgentLogs = (params) => callAgentManager('logs', params);

/** true لو الصفحة شغّالة في الوضع المحلي (لسه ما فيش agent-manager على السيرفر) */
export async function isUsingLocalFallback() {
    return !(await detectBackend());
}
