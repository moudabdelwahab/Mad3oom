/**
 * Transport Layer - Contract
 * --------------------------------------------------------
 * Transport = "كيف تتنقل البايتات" فقط (HTTP request/response واحد،
 * اتصال SSE مستمر، عملية stdio فرعية، WebSocket...). لا يعرف Transport
 * أي شيء عن:
 *   - Authentication (لا Header اسمه Authorization، لا OAuth، لا API Key)
 *   - MCP protocol (لا initialize، لا tools/list، لا JSON-RPC method names)
 *
 * الـ headers/credentials بتتحط عن طريق Connection Manager وقت الإرسال
 * (هو اللي بيسأل Auth Manager ويحقن النتيجة) - مش Transport نفسه.
 * إضافة WebSocket أو أي Transport مستقبلي = ملف جديد يطبّق العقد ده فقط.
 */

/** @typedef {{
 *   signal?: AbortSignal,
 * }} TransportOptions  - إعدادات خاصة بالـ transport نفسه (إلغاء الطلب...)، غير متعلقة بالـ auth إطلاقًا */

/** @typedef {{
 *   status: number,
 *   headers: Record<string, string>,
 *   body: unknown,
 * }} TransportResponse */

/**
 * @typedef {Object} Transport
 * @property {string} kind - 'streamable_http' | 'sse' | 'stdio' | 'websocket' | أي جديد
 * @property {(url: string, opts?: object) => Promise<void>} open
 * @property {(payload: unknown, requestContext?: import('../contracts/request-context.js').RequestContext, opts?: TransportOptions) => Promise<TransportResponse>} send
 *           - يبعت payload خام (JSON-RPC envelope جاهز من فوق) + RequestContext عام
 *             (headers/query/cookies/tls/sign) ويرجّع رد خام. Transport يطبّق فقط
 *             الحقول التي يفهمها فعليًا (مثلاً fetch في المتصفح لا يدعم tls.clientCert)
 *             ويتجاهل الباقي بصمت - لا يفشل بسبب حقل لا يفهمه. Transport لا يبني
 *             ولا يفسّر محتوى payload نفسه - هذا عمل MCP Session حصريًا.
 * @property {(onMessage: (msg: unknown) => void) => void} [onMessage]
 *           - للـ transports ذات الاتجاه المزدوج (SSE/WebSocket/stdio) فقط
 * @property {() => Promise<void>} close
 * @property {() => boolean} isOpen
 */

export const TRANSPORT_KINDS = /** @type {const} */ (['streamable_http', 'sse', 'stdio', 'websocket']);
