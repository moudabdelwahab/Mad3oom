/**
 * Agent Service - إدارة وكلاء الذكاء الاصطناعي المتصلين بمنصة مدعوم
 * --------------------------------------------------------
 * كل العمليات تمر عبر Edge Function واحدة: agent-manager
 * (action: list | get | create | update | delete | start | stop | restart |
 *          test_connection | status | logs)
 *
 * لو الدالة agent-manager غير منشورة بعد على Supabase (لسه ما اتعملتش)،
 * الخدمة تسقط تلقائياً على تخزين محلي (localStorage) عشان الصفحة تفضل
 * شغالة للتجربة/العرض بدل ما تكسر بالكامل. أول ما تُنشر الدالة فعلياً،
 * الخدمة هتكتشفها تلقائياً وتستخدمها بدون أي تعديل في الصفحة.
 *
 * بنفس فلسفة mcp-service.js تماماً (نفس مشروع Supabase، نفس supabase client).
 */

import { supabase } from '/api-config.js';

const STORAGE_KEY = 'mad3oom_agents';
const FN = 'agent-manager';

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

let _useEdgeFunction = null;

/** يكتشف مرة واحدة فقط إذا كانت agent-manager منشورة فعلاً على Supabase. */
async function detectBackend() {
    if (_useEdgeFunction !== null) return _useEdgeFunction;
    try {
        const { error } = await supabase.functions.invoke(FN, { body: { action: 'list' } });
        // 404 / Function not found = لسه ما اتعملتش على السيرفر
        if (error && (error.context?.status === 404 || /not\s*found/i.test(error.message || ''))) {
            _useEdgeFunction = false;
        } else {
            _useEdgeFunction = true;
        }
    } catch {
        _useEdgeFunction = false;
    }
    return _useEdgeFunction;
}

/* =========================================================
 *  نداء عام للدالة (يُستخدم مباشرة من الصفحة لإجراءات runtime مثل
 *  start/stop/restart/status/logs/test_connection التي لا معنى لمحاكاتها محلياً)
 * ========================================================= */

export async function callAgentManager(action, payload = {}) {
    const useFn = await detectBackend();
    if (!useFn) {
        return localFallback(action, payload);
    }
    const { data, error } = await supabase.functions.invoke(FN, { body: { action, ...payload } });
    if (error) throw new Error(error.message || 'فشل الاتصال بخدمة إدارة الوكلاء');
    if (data?.error) throw new Error(data.error);
    return data;
}

/* =========================================================
 *  محاكاة محلية (localStorage) — تُستخدم فقط قبل نشر agent-manager فعلياً
 * ========================================================= */

function localFallback(action, payload) {
    let agents = readLocal();

    switch (action) {
        case 'list':
            return { ok: true, agents };

        case 'get': {
            const agent = agents.find(a => a.id === payload.id);
            return { ok: !!agent, data: agent || null, error: agent ? null : 'الوكيل غير موجود' };
        }

        case 'create': {
            const now = new Date().toISOString();
            const agent = {
                id: uuid(),
                status: AGENT_STATUSES.STOPPED,
                last_heartbeat: null,
                created_at: now,
                updated_at: now,
                ...payload,
            };
            agents.unshift(agent);
            writeLocal(agents);
            return { ok: true, data: agent };
        }

        case 'update': {
            const idx = agents.findIndex(a => a.id === payload.id);
            if (idx === -1) return { ok: false, error: 'الوكيل غير موجود' };
            agents[idx] = { ...agents[idx], ...payload, updated_at: new Date().toISOString() };
            writeLocal(agents);
            return { ok: true, data: agents[idx] };
        }

        case 'delete': {
            agents = agents.filter(a => a.id !== payload.id);
            writeLocal(agents);
            return { ok: true };
        }

        case 'start':
        case 'stop':
        case 'restart': {
            const idx = agents.findIndex(a => a.id === payload.id);
            if (idx === -1) return { ok: false, error: 'الوكيل غير موجود' };
            const map = { start: AGENT_STATUSES.RUNNING, stop: AGENT_STATUSES.STOPPED, restart: AGENT_STATUSES.RUNNING };
            agents[idx].status = map[action];
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
