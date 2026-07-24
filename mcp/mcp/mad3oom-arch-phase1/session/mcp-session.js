/**
 * MCP Session
 * --------------------------------------------------------
 * يملك بروتوكول MCP بالكامل ولا شيء غيره:
 *   initialize → initialized → notifications → tools/list →
 *   resources/list → prompts/list → tools/call
 *
 * لا يستورد أي شيء من auth/ ولا من transport/ - كل ما يعرفه هو
 * ConnectionManager.send(payload) الذي يُمرَّر له جاهزًا من الخارج.
 * هذا يحقق الفصل المطلوب: تغيير Auth أو Transport لا يمس سطرًا واحدًا هنا،
 * وإصدار MCP protocol جديد مستقبلًا يُضاف هنا فقط دون لمس Auth/Transport.
 *
 * التزام بالمواصفة الرسمية: أسماء الطرق (methods) وبنية الطلب/الرد هنا
 * مطابقة حرفيًا لـ MCP spec (JSON-RPC 2.0 envelope + initialize/
 * capabilities negotiation). أي سلوك إضافي خاص بـ Mad3oom (مثل تخزين
 * resources/prompts في mcp_server_connections) معزول في طبقة التخزين
 * خارج هذا الملف، ولا يُضاف كحقل غير قياسي داخل الرسائل نفسها.
 */
import { parseMcpCapabilities, canRun } from '../capabilities/capability-registry.js';

// أحدث إصدار أولاً - هذا ما نطلبه في initialize. الإصدارات الأقدم هنا فقط
// عشان لو السيرفر رد بواحد منها (وهو مسموح له وفق الـ spec لو مش داعم
// الأحدث)، نقبله بدل ما نفشل الاتصال بالكامل. أي إصدار غير موجود في هذه
// القائمة = عدم توافق حقيقي، والجلسة تفشل بوضوح بدل ما تكمل بصمت.
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];
const CLIENT_INFO = { name: 'mad3oom-mcp-client', version: '1.0.0' };

/** الأنواع الثلاثة من list_changed المُعرَّفة في MCP spec - كل واحد يعلّم الميزة المقابلة "قديمة" فقط، بدون أي cache فعلي هنا (التخزين نفسه مسؤولية طبقة التخزين حول هذا الملف، راجع README) */
const LIST_CHANGED_METHODS = {
    'notifications/tools/list_changed': 'tools',
    'notifications/resources/list_changed': 'resources',
    'notifications/prompts/list_changed': 'prompts',
};

let _rpcId = 0;
function nextId() { return ++_rpcId; }

function rpcRequest(method, params) {
    return { jsonrpc: '2.0', id: nextId(), method, params };
}
function rpcNotification(method, params) {
    return { jsonrpc: '2.0', method, params }; // بدون id - إشعار وفق JSON-RPC 2.0
}

export class McpSession {
    /** @param {import('../connection-manager/connection-manager.js').ConnectionManager} connectionManager */
    constructor(connectionManager) {
        this.connection = connectionManager; // الاسم مقصود عام - Session لا يعرف تفاصيل ما بداخله
        /** @type {import('../capabilities/capability-registry.js').McpCapabilities|null} */
        this.capabilities = null;
        this.serverInfo = null;
        this.protocolVersion = null; // الإصدار الفعلي المتفَق عليه بعد initialize - null قبل ذلك
        this._initialized = false;

        // علامات "قديم" فقط (بدون أي cache) - تتحدث من إشعارات list_changed
        // وتُمسح عند أول استدعاء ناجح للقائمة المقابلة بعدها. الاستهلاك الفعلي
        // (إعادة الجلب وتخزينه) مسؤولية الطبقة المستهلكة (Legacy Bridge/storage)، لا هنا.
        this._stale = { tools: false, resources: false, prompts: false };
        this._notificationHandlers = new Set();
        this._unsubscribeFromConnection = null;
    }

    /** initialize → تفاوض protocolVersion → (تخزين capabilities) → إرسال إشعار initialized - وفق التسلسل الإلزامي في MCP spec */
    async initialize() {
        // نربط استقبال إشعارات السيرفر قبل initialize نفسه - أي إشعار يوصل
        // أثناء أو بعد initialize (مثلاً list_changed فوري من بعض السيرفرات)
        // يُلتقط، مش بس اللي بعد وصول discoverAll(). الاشتراك idempotent
        // (unsubscribe القديم أولاً لو initialize() اتنادى أكتر من مرة).
        this._unsubscribeFromConnection?.();
        this._unsubscribeFromConnection = this.connection.onNotification((msg) => this._handleNotification(msg));

        const res = await this.connection.send(rpcRequest('initialize', {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {}, // قدرات العميل نفسه - تُملأ حسب ما يدعمه Mad3oom فعليًا
            clientInfo: CLIENT_INFO,
        }));

        const result = res.body?.result;
        if (!result) throw new Error(res.body?.error?.message || 'initialize فشل: رد غير متوقع من السيرفر');

        // تفاوض protocolVersion: السيرفر المفروض يرجّع الإصدار اللي هيستخدمه فعليًا
        // (نفس اللي طلبناه لو بيدعمه، أو إصدار أقدم يدعمه هو لو مش بيدعم الأحدث -
        // وفق الـ spec). لو رجّع إصدار مش في قائمتنا المدعومة، مفيش توافق حقيقي -
        // نفشل بوضوح بدل ما نكمل ونكتشف المشكلة لاحقًا في رسالة غامضة.
        const negotiated = result.protocolVersion;
        if (!negotiated) {
            // بعض السيرفرات غير الملتزمة بالكامل بالـ spec ما بترجعش الحقل ده -
            // بدل فشل الاتصال بالكامل، نفترض الإصدار اللي طلبناه ونحذّر فقط.
            console.warn('[McpSession] السيرفر لم يرجّع protocolVersion في رد initialize - نفترض', PROTOCOL_VERSION);
            this.protocolVersion = PROTOCOL_VERSION;
        } else if (!SUPPORTED_PROTOCOL_VERSIONS.includes(negotiated)) {
            throw new Error(`عدم توافق إصدار MCP: السيرفر رد بإصدار "${negotiated}" غير مدعوم من هذا العميل (المدعوم: ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')})`);
        } else {
            this.protocolVersion = negotiated;
        }
        // من هنا فصاعدًا، كل send() تالٍ (بما فيها إشعار initialized نفسه) يحمل
        // هيدر MCP-Protocol-Version بالإصدار المتفَق عليه - Connection Manager
        // هو من يطبّق هذا، الـ Session لا يعرف اسم الهيدر ولا كيف يُرسَل.
        this.connection.setProtocolVersion(this.protocolVersion);

        this.capabilities = parseMcpCapabilities(result);
        this.serverInfo = result.serverInfo || null;

        await this.connection.send(rpcNotification('notifications/initialized', {}));
        this._initialized = true;
        return { capabilities: this.capabilities, serverInfo: this.serverInfo, protocolVersion: this.protocolVersion };
    }

    /** يوزّع إشعار وارد من الـ Connection Manager: يحدّث علامات "قديم" للقوائم الثلاثة، ثم يمرّره لأي مستمع خارجي مسجَّل عبر onNotification() */
    _handleNotification(msg) {
        const feature = LIST_CHANGED_METHODS[msg?.method];
        if (feature) this._stale[feature] = true;
        this._notificationHandlers.forEach((handler) => {
            try { handler(msg); } catch (err) { console.error('[McpSession] notification handler خطأ:', err); }
        });
    }

    /**
     * تسجيل مستمع لأي إشعار من السيرفر (list_changed، notifications/message،
     * notifications/progress، إلخ) - يمرّر الرسالة الخام كما وصلت، بدون تفسير.
     * التفسير/التخزين الفعلي (مثلاً: أعد جلب tools وخزّنها في mcp_server_connections)
     * مسؤولية المستهلك (Legacy Bridge اليوم)، وفق حدود هذا الملف الموضّحة في README.
     * @param {(notification: { method: string, params?: unknown }) => void} handler
     * @returns {() => void} unsubscribe
     */
    onNotification(handler) {
        this._notificationHandlers.add(handler);
        return () => this._notificationHandlers.delete(handler);
    }

    /** true لو وصل list_changed لهذه الميزة منذ آخر جلب ناجح لها */
    isStale(feature) { return Boolean(this._stale[feature]); }

    _assertInitialized() {
        if (!this._initialized) throw new Error('MCP Session: نادِ initialize() أولاً');
    }

    /** يشغّل fetch لأي method فقط لو capability المقابلة مُعلَنة فعليًا - بدون أي "if provider==" */
    async _listIfSupported(feature, method) {
        this._assertInitialized();
        if (!canRun(this.capabilities, feature)) return { supported: false, items: [] };
        const res = await this.connection.send(rpcRequest(method, {}));
        if (res.body?.error) throw new Error(res.body.error.message || `${method} فشل`);
        this._stale[feature] = false; // جلب ناجح = طازج من الآن، لحد ما يوصل list_changed تاني
        return { supported: true, items: res.body?.result || {} };
    }

    /** ينظّف الاشتراك في إشعارات الـ Connection Manager - يُستدعى عند إغلاق الجلسة/الاتصال */
    dispose() {
        this._unsubscribeFromConnection?.();
        this._unsubscribeFromConnection = null;
        this._notificationHandlers.clear();
    }

    async toolsList() { return this._listIfSupported('tools', 'tools/list'); }
    async resourcesList() { return this._listIfSupported('resources', 'resources/list'); }
    async promptsList() { return this._listIfSupported('prompts', 'prompts/list'); }

    /** تنفيذ أداة فعلية - نفس مسار التحقق الحالي (can_use_mcp_client) يبقى في الـ Edge Function، لا تغيير هنا */
    async toolsCall(name, args = {}) {
        this._assertInitialized();
        if (!canRun(this.capabilities, 'tools')) throw new Error('السيرفر لا يعلن دعم tools - لا يمكن استدعاء أي أداة');
        const res = await this.connection.send(rpcRequest('tools/call', { name, arguments: args }));
        if (res.body?.error) throw new Error(res.body.error.message || 'tools/call فشل');
        return res.body?.result;
    }

    /** يجمع كل الاكتشاف بعد initialize في نداء واحد - يُستخدم بعد نجاح OAuth مباشرة (تسلسل التقرير §3.2) */
    async discoverAll() {
        await this.initialize();
        const [tools, resources, prompts] = await Promise.all([
            this.toolsList(), this.resourcesList(), this.promptsList(),
        ]);
        return { capabilities: this.capabilities, serverInfo: this.serverInfo, tools, resources, prompts };
    }
}
