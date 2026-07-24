/**
 * Connection Manager
 * --------------------------------------------------------
 * مسؤوليته حصرًا (ولا شيء غير ذلك):
 *   - Resolve Authentication  (عبر AuthenticationManager فقط - لا AuthProvider مباشرة)
 *   - Resolve Transport       (عبر negotiateTransport() - لا ربط مباشر بتطبيق transport واحد)
 *   - إنشاء/إدارة الاتصال (open/close lifecycle)
 *   - تعريض send() عام
 *   - reconnect/retry
 *
 * ممنوع تمامًا هنا: أي معرفة بـ initialize/initialized/tools/resources/
 * prompts/notifications. هذه كلها من اختصاص MCP Session، وهو يستدعي
 * send() فقط دون أن يعرف Connection Manager بمحتوى ما يُرسَل.
 */
import { negotiateTransport } from '../transport/negotiator.js';
import { AuthenticationManager } from '../auth-manager/auth-manager.js';

const DEFAULT_RETRY = { attempts: 3, baseDelayMs: 500 };

export class ConnectionManager {
    /** @param {object} connection - سجل الاتصال الكامل (server + connection row) */
    constructor(connection, { retry = DEFAULT_RETRY } = {}) {
        this.connection = connection;
        this.retry = retry;
        this.authManager = new AuthenticationManager(connection);
        // لا ربط مباشر بـ transport محدد - negotiateTransport يقرر بناءً على
        // ما يُعلنه السيرفر (connection.transport اليوم، أو supported_transports
        // لاحقًا) وما هو مسجَّل فعليًا في transport/registry.js
        this.transport = negotiateTransport(connection);
        this._open = false;

        // MCP protocol version المتفَق عليه بعد initialize (يُملأ لاحقًا عبر
        // setProtocolVersion() من MCP Session) - Connection Manager لا يعرف
        // *لماذا* هذا الهيدر مطلوب (هذا تفصيل بروتوكول)، فقط يعرف أنه، بمجرد
        // تحديده، يُرفَق على كل send() تالٍ - تمامًا مثل أي auth header آخر.
        this._protocolVersion = null;

        // مستمعو الإشعارات القادمة من السيرفر (server → client، بدون id في
        // JSON-RPC) - يُسجَّلون عبر onNotification() ويُستدعَون من هنا فقط.
        // MCP Session لا يتعامل مع transport.onMessage مباشرة إطلاقًا.
        this._notificationHandlers = new Set();
    }

    async open() {
        if (this._open) return;
        await this.transport.open(this.connection.url);
        this._open = true;

        // لو الـ Transport ثنائي الاتجاه (SSE/stdio/websocket) بيدعم onMessage،
        // اربطه هنا مرة واحدة عند الفتح - بغض النظر عن ترتيب تسجيل
        // onNotification() (قبل أو بعد open())، لأن dispatch يقرأ
        // _notificationHandlers وقت وصول كل رسالة، مش وقت الربط.
        if (typeof this.transport.onMessage === 'function') {
            this.transport.onMessage((msg) => this._dispatchIncoming(msg));
        }
    }

    /** يُستدعى من MCP Session بعد initialize() الناجح - يُرفق كهيدر على كل send() تالٍ */
    setProtocolVersion(version) {
        this._protocolVersion = version || null;
    }

    /**
     * تسجيل مستمع لإشعارات السيرفر (رسائل بدون id - مثل notifications/tools/list_changed).
     * يعمل فقط مع transports تدعم onMessage فعليًا (SSE/stdio/websocket)؛
     * لا تأثير له مع streamable-http الحالي (طلب/رد واحد، بدون push من السيرفر)
     * حتى يُفعَّل دعم الـ SSE response stream الخاص بـ Streamable HTTP (Phase 1+).
     * @param {(notification: { method: string, params?: unknown }) => void} handler
     * @returns {() => void} unsubscribe
     */
    onNotification(handler) {
        this._notificationHandlers.add(handler);
        return () => this._notificationHandlers.delete(handler);
    }

    /** أي رسالة واردة بدون id = إشعار JSON-RPC (وفق spec) - رسائل لها id هي ردود على طلبات قائمة وتُترك لآلية الـ request/response في الـ Transport نفسه */
    _dispatchIncoming(msg) {
        if (msg && msg.id === undefined && msg.method) {
            this._notificationHandlers.forEach((handler) => {
                try { handler(msg); } catch (err) { console.error('[ConnectionManager] notification handler خطأ:', err); }
            });
        }
    }

    async close() {
        if (!this._open) return;
        await this.transport.close();
        this._open = false;
    }

    isOpen() { return this._open && this.transport.isOpen(); }

    /**
     * الواجهة العامة الوحيدة التي تستخدمها MCP Session. تأخذ payload خام
     * (JSON-RPC envelope جاهز من فوق - Connection Manager لا يفسّر محتواه)
     * وتُرجع رد خام. كل ما يخص auth/transport/retry يحدث هنا بشفافية.
     * @param {unknown} payload
     * @param {{ signal?: AbortSignal }} [opts]
     */
    async send(payload, opts = {}) {
        if (!this.isOpen()) await this.open();

        let lastError;
        for (let attempt = 0; attempt <= this.retry.attempts; attempt++) {
            try {
                const auth = await this.authManager.resolveContext();
                const requestContext = auth.applyToRequest(); // RequestContext كامل - headers/query/cookies/tls/sign
                if (this._protocolVersion) {
                    // نفس requestContext لكن مع هيدر بروتوكول مُرفَق - لا علاقة لهذا بالـ Auth
                    // ولا بمحتوى JSON-RPC نفسه، فقط "ميتاداتا اتصال" زي أي هيدر تاني
                    requestContext.headers = { ...(requestContext.headers || {}), 'MCP-Protocol-Version': this._protocolVersion };
                }
                const res = await this.transport.send(payload, requestContext, { signal: opts.signal });

                if (res.status === 401 || res.status === 403) {
                    const retried = await this.authManager.handleAuthFailure();
                    if (retried) continue; // أعد المحاولة بنفس عداد attempt بسياق auth جديد
                    lastError = new Error(`Auth failed: HTTP ${res.status}`);
                    break;
                }
                return res;
            } catch (err) {
                lastError = err;
                if (attempt < this.retry.attempts) {
                    await sleep(this.retry.baseDelayMs * 2 ** attempt);
                    continue;
                }
            }
        }
        throw lastError || new Error('Connection Manager: فشل الإرسال بعد كل المحاولات');
    }

    /** يبدأ فلو المصادقة (OAuth redirect أو فوري لغير ذلك) - تفويض مباشر لـ AuthManager */
    async connectAuth() {
        return this.authManager.beginConnect();
    }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
