/**
 * Streamable HTTP Transport (MCP spec: "Streamable HTTP")
 * --------------------------------------------------------
 * ينفّذ عقد Transport في types.js فقط. لا يعرف JSON-RPC method names ولا
 * أي طريقة مصادقة - يستقبل RequestContext عام ويطبّق فقط الحقول التي
 * تفهمها بيئة fetch() (headers/query/cookies/sign)، ويتجاهل بصمت أي حقل
 * لا تدعمه (مثل tls.clientCert - غير ممكن من fetch المتصفح؛ transport
 * يعمل مع بيئة server-side تدعمه بدون تغيير هذا العقد).
 *
 * تصحيح مطابقة المواصفة:
 *
 *   كان هذا الناقل يرسل Content-Type فقط بلا ترويسة Accept، ثم ينادي
 *   res.json() مباشرة على أي رد. والمواصفة تُلزم العميل بإعلان قبوله
 *   للنوعين معًا (application/json و text/event-stream)، وتُخيّر الخادم
 *   بين الردّ بأيّهما شاء على نفس الطلب. فكان الناقل يفشل مع أي خادم
 *   ملتزم: 406 قبل أن يبدأ، أو كسر في التحليل لو ردّ الخادم ببثّ SSE.
 *
 *   إضافة إلى ذلك، ترويسة Mcp-Session-Id تُلتقط من الرد وتُعاد على كل
 *   طلب تالٍ — بدونها يرفض أي خادم يعمل بجلسات كل ما يلي initialize.
 *
 * ملاحظة عن حدود العقد: هذا الملف لا يقرأ محتوى الرسائل ولا يعرف أسماء
 * الطرق. التقاط الجلسة يتم من ترويسة HTTP، وربط الرد بالطلب يتم عبر id
 * الموجود في مغلَّف JSON-RPC — وكلاهما خاصية نقل، لا محتوى بروتوكول.
 */
import { registerTransport } from '../registry.js';

const ACCEPT = 'application/json, text/event-stream';
const MAX_SSE_BYTES = 1_000_000;

function buildUrlWithQuery(baseUrl, query) {
    if (!query || !Object.keys(query).length) return baseUrl;
    const url = new URL(baseUrl);
    Object.entries(query).forEach(([k, v]) => url.searchParams.set(k, v));
    return url.toString();
}

function findEventBoundary(buffer) {
    const a = buffer.indexOf('\n\n');
    const b = buffer.indexOf('\r\n\r\n');
    if (a === -1) return b;
    if (b === -1) return a;
    return Math.min(a, b);
}

/** يجمع أسطر `data:` لحدث SSE واحد (المواصفة تسمح بأكثر من سطر للرسالة الواحدة). */
function dataLinesOf(rawEvent) {
    const out = [];
    for (const line of rawEvent.split(/\r?\n/)) {
        if (line.startsWith('data:')) out.push(line.slice(5).replace(/^ /, ''));
    }
    return out.length ? out.join('\n') : null;
}

/**
 * يقرأ أول رسالة JSON-RPC مطابقة من بثّ SSE دون انتظار إغلاق البثّ.
 * الإشعارات (بلا id) تُمرَّر إلى onMessage لو وُجد، تمامًا كما في ناقل SSE.
 */
async function readJsonRpcFromSse(res, expectedId, onMessage) {
    if (!res.body) return null;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let total = 0;

    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value?.byteLength ?? 0;
            if (total > MAX_SSE_BYTES) break;
            buffer += decoder.decode(value, { stream: true });

            let sep;
            while ((sep = findEventBoundary(buffer)) !== -1) {
                const rawEvent = buffer.slice(0, sep);
                buffer = buffer.slice(sep).replace(/^(\r?\n){2}/, '');

                const payload = dataLinesOf(rawEvent);
                if (!payload) continue;

                let parsed;
                try { parsed = JSON.parse(payload); } catch { continue; }
                if (!parsed || typeof parsed !== 'object') continue;

                if (!('id' in parsed) || parsed.id === null || parsed.id === undefined) {
                    if (typeof onMessage === 'function') onMessage(parsed);
                    continue;
                }
                if (expectedId === null || parsed.id === expectedId) return parsed;
            }
        }
    } finally {
        try { await reader.cancel(); } catch { /* مُغلق بالفعل */ }
    }
    return null;
}

function createStreamableHttpTransport() {
    /** @type {string|null} */
    let baseUrl = null;
    /** @type {string|null} معرّف الجلسة كما سلّمه الخادم في رد initialize. */
    let sessionId = null;
    /** @type {((message: unknown) => void)|null} */
    let messageHandler = null;

    return {
        kind: 'streamable_http',

        async open(url) {
            baseUrl = url;
            sessionId = null;
        },

        /** يسجّل مستقبِلًا لإشعارات الخادم (الرسائل بلا id) الواردة داخل بثّ SSE. */
        onMessage(handler) {
            messageHandler = typeof handler === 'function' ? handler : null;
        },

        /**
         * @param {unknown} payload
         * @param {import('../../contracts/request-context.js').RequestContext} [requestContext]
         * @param {import('../types.js').TransportOptions} [opts]
         */
        async send(payload, requestContext = {}, opts = {}) {
            if (!baseUrl) throw new Error('Transport غير مفتوح - نادِ open(url) أولاً');

            const headers = {
                'Content-Type': 'application/json',
                Accept: ACCEPT,
                ...(requestContext.headers || {}),
            };
            if (sessionId) headers['Mcp-Session-Id'] = sessionId;

            if (requestContext.cookies && Object.keys(requestContext.cookies).length) {
                headers['Cookie'] = Object.entries(requestContext.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
            }
            if (requestContext.tls) {
                console.warn('[streamable-http transport] تجاهل tls.* - غير مدعوم من fetch() في المتصفح');
            }

            const outgoingBody = requestContext.sign ? await requestContext.sign(payload) : payload;
            const url = buildUrlWithQuery(baseUrl, requestContext.query);

            const res = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(outgoingBody),
                signal: opts.signal,
                // مواصفة Fetch تحوّل POST إلى GET عند 301/302/303، فيصل الطلب
                // للخادم بطريقة خاطئة ويردّ 405 بلا أي إشارة للسبب. نمسك
                // التحويل هنا ونُبلغ عنه بدل ابتلاعه.
                redirect: 'manual',
            });

            const resHeaders = Object.fromEntries(res.headers.entries());

            if (res.status >= 300 && res.status < 400) {
                const location = res.headers.get('location');
                try { await res.body?.cancel(); } catch { /* لا جسم */ }
                const err = new Error(location
                    ? `عنوان الخادم يحوّل الطلب إلى ${location} — حدّث عنوان الخادم إلى هذا الرابط مباشرة.`
                    : `الخادم ردّ بتحويل (${res.status}) بلا عنوان وجهة.`);
                err.status = res.status;
                err.location = location;
                throw err;
            }

            // الخادم يسلّم الجلسة في رد initialize؛ نحتفظ بها لكل طلب تالٍ.
            const incomingSession = res.headers.get('mcp-session-id');
            if (incomingSession) sessionId = incomingSession;
            // 404 على جلسة قائمة = الخادم أسقطها؛ الطبقة الأعلى تقرّر إعادة الاتصال.
            if (res.status === 404 && sessionId) sessionId = null;

            // 202 هو الرد المتوقّع للإشعارات (بلا id) ولا جسم له.
            if (res.status === 202) {
                try { await res.body?.cancel(); } catch { /* لا جسم */ }
                return { status: res.status, headers: resHeaders, body: null };
            }

            const contentType = (res.headers.get('content-type') || '').toLowerCase();
            let body;

            if (contentType.includes('text/event-stream')) {
                const expectedId = outgoingBody && typeof outgoingBody === 'object' && 'id' in outgoingBody
                    ? outgoingBody.id
                    : null;
                body = await readJsonRpcFromSse(res, expectedId, messageHandler);
            } else {
                // لا نفترض JSON: نقرأ نصًّا ثم نحاول التحليل، فيبقى المحتوى الفعلي
                // متاحًا للطبقة الأعلى عند الفشل بدل رمي خطأ تحليل غامض.
                const text = await res.text().catch(() => null);
                if (text === null || text.trim() === '') {
                    body = null;
                } else {
                    try { body = JSON.parse(text); } catch { body = text; }
                }
            }

            return { status: res.status, headers: resHeaders, body };
        },

        async close() { baseUrl = null; sessionId = null; messageHandler = null; },
        isOpen() { return baseUrl !== null; },
    };
}

registerTransport('streamable_http', createStreamableHttpTransport);
export { createStreamableHttpTransport };
