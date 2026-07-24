/**
 * Streamable HTTP Transport (MCP spec: "Streamable HTTP")
 * --------------------------------------------------------
 * ينفّذ عقد Transport في types.js فقط. لا يعرف JSON-RPC method names ولا
 * أي طريقة مصادقة - يستقبل RequestContext عام ويطبّق فقط الحقول التي
 * تفهمها بيئة fetch() في المتصفح (headers/query/cookies/sign)، ويتجاهل
 * بصمت أي حقل لا تدعمه (مثل tls.clientCert - غير ممكن من fetch المتصفح؛
 * transport يعمل مع بيئة server-side تدعمه بدون تغيير هذا العقد).
 */
import { registerTransport } from '../registry.js';

function buildUrlWithQuery(baseUrl, query) {
    if (!query || !Object.keys(query).length) return baseUrl;
    const url = new URL(baseUrl);
    Object.entries(query).forEach(([k, v]) => url.searchParams.set(k, v));
    return url.toString();
}

function createStreamableHttpTransport() {
    /** @type {string|null} */
    let baseUrl = null;

    return {
        kind: 'streamable_http',

        async open(url) {
            baseUrl = url;
        },

        /**
         * @param {unknown} payload
         * @param {import('../../contracts/request-context.js').RequestContext} [requestContext]
         * @param {import('../types.js').TransportOptions} [opts]
         */
        async send(payload, requestContext = {}, opts = {}) {
            if (!baseUrl) throw new Error('Transport غير مفتوح - نادِ open(url) أولاً');

            const headers = { 'Content-Type': 'application/json', ...(requestContext.headers || {}) };
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
            });
            const resHeaders = Object.fromEntries(res.headers.entries());
            let body;
            try { body = await res.json(); } catch { body = await res.text().catch(() => null); }
            return { status: res.status, headers: resHeaders, body };
        },

        async close() { baseUrl = null; },
        isOpen() { return baseUrl !== null; },
    };
}

registerTransport('streamable_http', createStreamableHttpTransport);
export { createStreamableHttpTransport };
