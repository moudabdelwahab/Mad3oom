/**
 * SSE Transport (MCP legacy "HTTP+SSE" transport, spec 2024-11-05)
 * --------------------------------------------------------
 * Phase 1: تفعيل كامل. يطبّق عقد Transport في types.js فقط - لا يعرف
 * JSON-RPC method names ولا auth، يستقبل RequestContext عام مثل
 * streamable-http.js بالضبط.
 *
 * لماذا لا EventSource: الكلاس ده مصمَّم يشتغل server-side (Edge Function/
 * Deno) بنفس حدود الثقة الموضّحة في README - نفس منطق streamable-http.js.
 * EventSource كائن متصفح (وغير مضمون توفره في كل بيئة Deno server-side)،
 * فبدل الاعتماد عليه، بنقرأ الـ SSE stream يدويًا فوق fetch() + ReadableStream
 * القياسي (متاح في fetch أي بيئة حديثة: متصفح/Deno/Node) - نفس الأداة
 * المستخدمة بالفعل في streamable-http.js، فقط بقراءة streaming بدل رد واحد.
 *
 * بروتوكول HTTP+SSE القديم (قبل Streamable HTTP):
 *   1) GET على url مع Accept: text/event-stream → يفتح استماع مستمر.
 *   2) أول حدث بيوصل اسمه "endpoint" وبياناته URI (نسبي أو مطلق) تُستخدم
 *      كعنوان POST لكل رسائل JSON-RPC التالية (initialize، tools/list...).
 *   3) send() = POST على endpoint. الرد المباشر على الـ POST عادة 202
 *      Accepted بدون جسم - الرد الفعلي لـ JSON-RPC بيوصل لاحقًا كحدث
 *      "message" على نفس اتصال SSE المفتوح من الخطوة 1، ويُربط بالطلب
 *      عبر id (JSON-RPC correlation) - لهذا send() هنا لا تُرجع مباشرة من
 *      نتيجة POST، بل تنتظر الرسالة المرتبطة بنفس id من الـ stream (مع
 *      قبول اختصار: لو بعض السيرفرات ردّت بالنتيجة الكاملة مباشرة في جسم
 *      POST - حالة غير قياسية لكن شائعة عمليًا - نقبلها فورًا كذلك).
 *   4) أي رسالة توصل بدون id (إشعار) تُمرَّر لـ onMessage() كما هي -
 *      Connection Manager هو من يقرر إنها إشعار (بند "لا id" في dispatch).
 *
 * timeout الطلب الواحد: نفس نطاق الـ timeouts المستخدمة في باقي الكود
 * (٨-٣٠ ثانية حسب نوع النداء في Edge Functions الحالية) - هنا نستخدم قيمة
 * معقولة عامة (30s) قابلة للتجاوز عبر opts.signal الممرّر من فوق.
 */
import { registerTransport } from '../registry.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const ENDPOINT_WAIT_TIMEOUT_MS = 10_000;

function resolveEndpointUrl(baseUrl, endpointData) {
    // endpoint event data ممكن يكون URI نسبي (الحالة الشائعة في السيرفرات
    // القديمة) أو مطلق - new URL(relative, base) بتتعامل مع الحالتين بنفس السطر
    return new URL(endpointData, baseUrl).toString();
}

/** يفكّك SSE stream خام (Uint8Array chunks) لأحداث { event, data } وفق سطرين فارغين = فاصل حدث، مطابق لـ SSE spec (يتجاهل comments التي تبدأ بـ ':' وحقل retry - غير مستخدمين هنا) */
async function* parseSseStream(reader) {
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let sepIndex;
        // \n\n أو \r\n\r\n كلاهما فاصل حدث صالح وفق SSE spec
        while ((sepIndex = buffer.search(/\r?\n\r?\n/)) !== -1) {
            const rawEvent = buffer.slice(0, sepIndex);
            buffer = buffer.slice(sepIndex).replace(/^(\r?\n)+/, '');

            let eventName = 'message'; // الافتراضي وفق SSE spec لو مفيش سطر event:
            const dataLines = [];
            for (const line of rawEvent.split(/\r?\n/)) {
                if (!line || line.startsWith(':')) continue; // سطر فارغ أو comment
                const idx = line.indexOf(':');
                const field = idx === -1 ? line : line.slice(0, idx);
                let val = idx === -1 ? '' : line.slice(idx + 1);
                if (val.startsWith(' ')) val = val.slice(1);
                if (field === 'event') eventName = val;
                else if (field === 'data') dataLines.push(val);
                // 'id' و 'retry' غير مستخدمين حاليًا - لا reconnection logic في هذه المرحلة
            }
            if (dataLines.length) yield { event: eventName, data: dataLines.join('\n') };
        }
    }
}

function createSseTransport() {
    /** @type {string|null} */
    let baseUrl = null;
    /** @type {string|null} */
    let endpointUrl = null;
    /** @type {AbortController|null} */
    let streamController = null;
    /** @type {Promise<void>|null} - يتحلّل عند وصول حدث endpoint */
    let endpointReadyPromise = null;
    let resolveEndpointReady = null;
    let rejectEndpointReady = null;
    /** @type {Map<string|number, { resolve: (v: any) => void, reject: (e: Error) => void }>} */
    const pending = new Map();
    /** @type {Set<(msg: unknown) => void>} */
    const messageHandlers = new Set();
    let readLoopPromise = null;

    function settleAllPending(err) {
        for (const [, p] of pending) p.reject(err);
        pending.clear();
    }

    async function runReadLoop(res) {
        try {
            const reader = res.body.getReader();
            for await (const evt of parseSseStream(reader)) {
                if (evt.event === 'endpoint') {
                    try {
                        endpointUrl = resolveEndpointUrl(baseUrl, evt.data.trim());
                        resolveEndpointReady?.();
                    } catch (err) {
                        rejectEndpointReady?.(err);
                    }
                    continue;
                }
                // أي حدث تاني (الاسم الافتراضي "message" أو أي اسم مخصص من السيرفر)
                // نحاول تفسيره كـ JSON-RPC (رد له id، أو إشعار بدون id)
                let msg;
                try { msg = JSON.parse(evt.data); } catch { continue; } // بيانات غير JSON = تجاهل بصمت (خارج نطاق JSON-RPC)

                if (msg && msg.id !== undefined && pending.has(msg.id)) {
                    pending.get(msg.id).resolve(msg);
                    pending.delete(msg.id);
                } else {
                    messageHandlers.forEach((cb) => {
                        try { cb(msg); } catch (err) { console.error('[sse transport] onMessage handler خطأ:', err); }
                    });
                }
            }
            // الـ stream اتقفل من السيرفر - أي طلبات لسه معلّقة مستحيل تتحل
            settleAllPending(new Error('SSE transport: الاتصال اتقفل من السيرفر قبل ما يوصل رد لكل الطلبات المعلّقة'));
        } catch (err) {
            if (err?.name !== 'AbortError') {
                settleAllPending(err instanceof Error ? err : new Error(String(err)));
                rejectEndpointReady?.(err);
            }
        }
    }

    return {
        kind: 'sse',

        async open(u) {
            baseUrl = u;
            endpointUrl = null;
            streamController = new AbortController();
            endpointReadyPromise = new Promise((resolve, reject) => {
                resolveEndpointReady = resolve;
                rejectEndpointReady = reject;
            });

            const res = await fetch(u, {
                method: 'GET',
                headers: { Accept: 'text/event-stream' },
                signal: streamController.signal,
            });
            if (!res.ok || !res.body) {
                throw new Error(`SSE transport: فشل فتح اتصال SSE (HTTP ${res.status})`);
            }
            readLoopPromise = runReadLoop(res);
        },

        /**
         * @param {unknown} payload
         * @param {import('../../contracts/request-context.js').RequestContext} [requestContext]
         * @param {import('../types.js').TransportOptions} [opts]
         */
        async send(payload, requestContext = {}, opts = {}) {
            if (!baseUrl) throw new Error('Transport غير مفتوح - نادِ open(url) أولاً');

            // لازم ننتظر endpoint الأول قبل أي POST - لو استنى أكتر من المهلة، فشل واضح
            if (!endpointUrl) {
                await Promise.race([
                    endpointReadyPromise,
                    new Promise((_, reject) => setTimeout(
                        () => reject(new Error('SSE transport: لم يصل حدث "endpoint" من السيرفر خلال المهلة المسموحة')),
                        ENDPOINT_WAIT_TIMEOUT_MS,
                    )),
                ]);
            }

            const headers = { 'Content-Type': 'application/json', ...(requestContext.headers || {}) };
            if (requestContext.cookies && Object.keys(requestContext.cookies).length) {
                headers['Cookie'] = Object.entries(requestContext.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
            }
            if (requestContext.tls) {
                console.warn('[sse transport] تجاهل tls.* - غير مدعوم من fetch() القياسي');
            }

            const outgoingBody = requestContext.sign ? await requestContext.sign(payload) : payload;
            const isRequest = payload && typeof payload === 'object' && 'id' in payload && payload.id !== undefined;

            // نجهّز الانتظار على id *قبل* إرسال الـ POST - عشان منفوتش رد سريع
            // ممكن يوصل عبر الـ stream قبل ما نسجّل pending
            let correlatedPromise = null;
            if (isRequest) {
                correlatedPromise = new Promise((resolve, reject) => {
                    pending.set(payload.id, { resolve, reject });
                });
            }

            const postRes = await fetch(endpointUrl, {
                method: 'POST',
                headers,
                body: JSON.stringify(outgoingBody),
                signal: opts.signal,
            });
            const resHeaders = Object.fromEntries(postRes.headers.entries());

            if (!isRequest) {
                // إشعار (بدون id) - لا انتظار رد مطلوب وفق JSON-RPC
                return { status: postRes.status, headers: resHeaders, body: null };
            }

            // بعض السيرفرات (غير قياسي لكن شائع) بترجّع الرد الكامل مباشرة في جسم
            // الـ POST بدل الاعتماد حصريًا على الـ SSE stream - لو حصل كده، نقبله
            // فورًا ونلغي الانتظار على الـ stream لنفس الـ id
            let directBody = null;
            try { directBody = await postRes.clone().json(); } catch { /* مش JSON مباشر - عادي، ننتظر الـ stream */ }
            if (directBody && directBody.id === payload.id && (directBody.result !== undefined || directBody.error !== undefined)) {
                pending.delete(payload.id);
                return { status: postRes.status, headers: resHeaders, body: directBody };
            }

            if (postRes.status >= 400) {
                pending.delete(payload.id);
                let errBody = null;
                try { errBody = await postRes.json(); } catch { /* تجاهل */ }
                return { status: postRes.status, headers: resHeaders, body: errBody };
            }

            const timeoutMs = opts.timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;
            const timedOut = Symbol('timeout');
            const rpcMsg = await Promise.race([
                correlatedPromise,
                new Promise((resolve) => setTimeout(() => resolve(timedOut), timeoutMs)),
            ]);
            if (rpcMsg === timedOut) {
                pending.delete(payload.id);
                throw new Error(`SSE transport: انتهت مهلة انتظار الرد المرتبط بـ id=${payload.id} على الـ SSE stream`);
            }
            return { status: 200, headers: resHeaders, body: rpcMsg };
        },

        onMessage(cb) {
            messageHandlers.add(cb);
        },

        async close() {
            streamController?.abort();
            settleAllPending(new Error('SSE transport: الاتصال اتقفل'));
            await readLoopPromise?.catch(() => {});
            streamController = null;
            baseUrl = null;
            endpointUrl = null;
            readLoopPromise = null;
            messageHandlers.clear();
        },

        isOpen() { return baseUrl !== null; },
    };
}

registerTransport('sse', createSseTransport);
export { createSseTransport };
