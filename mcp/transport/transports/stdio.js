/**
 * stdio Transport (MCP spec: local subprocess transport)
 * --------------------------------------------------------
 * Phase 1: تفعيل كامل من ناحية الكود - لكن قيد تشغيل حقيقي مهم اتأكدنا
 * منه أثناء هذه المرحلة ولازم يُقرأ قبل تفعيل أي سيرفر stdio حقيقي:
 *
 * **stdio transport لا يمكن تفعيله داخل Supabase Edge Functions حاليًا.**
 * بيئة Supabase Edge Runtime بتشتغل جوه sandbox مبني على Deno لكنه مش
 * Deno الكامل بكل صلاحياته - تحديدًا subprocess spawning (Deno.Command /
 * الاسم القديم Deno.run) مش متاح في هذا الـ sandbox (توثيق Supabase الرسمي
 * لا يذكر أي دعم لـ subprocess في Edge Functions - فقط WASM لعمليات حسابية
 * ثقيلة، لا subprocess حقيقي). هذا ليس افتراضًا - جرّبنا Deno.Command داخل
 * نفس بيئة الـ Edge Runtime وقت التحقق ولم يكن الكائن متاحًا إطلاقًا.
 *
 * ده معناه عمليًا: transport ده حقيقي وجاهز 100% لو اتشغّل من بيئة Deno
 * كاملة الصلاحيات (سيرفر Deno مستقل، أو Deno CLI محلي، أو مستقبلًا "Mad3oom
 * background worker" منفصل عن Edge Functions) - لكن مش من داخل
 * test-mcp-server/mcp-invoke-tool الحاليين. لأي سيرفر MCP بـ transport=stdio
 * حاليًا، الحل العملي الوحيد قبل وجود backend منفصل هو تشغيله عبر بروكسي
 * streamable_http/sse خارجي (mcp-remote أو ما شابه) وتسجيله في Mad3oom
 * كـ transport=streamable_http بدل stdio - قرار تشغيلي، لا يحتاج تعديل كود.
 *
 * التصميم هنا مطابق لباقي الـ transports: نفس عقد types.js، JSON-RPC
 * newline-delimited عبر stdin/stdout (وفق spec stdio transport)، مراسلات
 * الرد تُربط بالـ id بنفس منطق sse.js بالضبط (Map<id, {resolve,reject}>) -
 * لأن subprocess زي SSE: قناة push مستمرة، مش طلب/رد واحد زي streamable-http.
 * stderr يُمرَّر لـ console.error فقط (logging) وفق الـ spec - مش جزء من
 * البروتوكول.
 */
import { registerTransport } from '../registry.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** فحص توفر Deno.Command وقت التشغيل الفعلي - بدون أي افتراض ثابت في وقت الكتابة، لأن نفس الملف قد يُحمَّل يومًا في بيئة Deno كاملة (Phase 1+ backend منفصل) حيث الكائن متاح فعليًا */
function getCommandCtor() {
    // deno-lint-ignore no-explicit-any
    const g = /** @type {any} */ (globalThis);
    return g?.Deno?.Command || null;
}

function parseCommandLine(command) {
    // "npx -y @some/mcp-server --flag" -> ["npx", "-y", "@some/mcp-server", "--flag"]
    // تقسيم بسيط على المسافات - يكفي لأوامر stdio القياسية؛ أوامر بها quotes
    // معقدة تحتاج parser أدق، خارج نطاق هذا الملف (نفس بساطة command كعمود نصي في mcp_servers اليوم)
    return command.trim().split(/\s+/);
}

function createStdioTransport() {
    let opened = false;
    let child = null; // Deno.ChildProcess
    let writer = null; // WritableStreamDefaultWriter
    const pending = new Map();
    const messageHandlers = new Set();
    let readLoopPromise = null;
    let closing = false;

    function settleAllPending(err) {
        for (const [, p] of pending) p.reject(err);
        pending.clear();
    }

    async function runReadLoop(readable) {
        const reader = readable.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                let nl;
                // newline-delimited JSON-RPC وفق stdio transport spec - كل سطر رسالة JSON-RPC كاملة
                while ((nl = buffer.indexOf('\n')) !== -1) {
                    const line = buffer.slice(0, nl).trim();
                    buffer = buffer.slice(nl + 1);
                    if (!line) continue;
                    let msg;
                    try { msg = JSON.parse(line); } catch { continue; } // سطر غير JSON صالح = تجاهل (سيرفرات معينة بتطبع logs على نفس stdout بالخطأ - خارج نطاقنا)
                    if (msg && msg.id !== undefined && pending.has(msg.id)) {
                        pending.get(msg.id).resolve(msg);
                        pending.delete(msg.id);
                    } else {
                        messageHandlers.forEach((cb) => {
                            try { cb(msg); } catch (err) { console.error('[stdio transport] onMessage handler خطأ:', err); }
                        });
                    }
                }
            }
            if (!closing) settleAllPending(new Error('stdio transport: العملية الفرعية أقفلت stdout قبل الرد على كل الطلبات المعلّقة'));
        } catch (err) {
            if (!closing) settleAllPending(err instanceof Error ? err : new Error(String(err)));
        }
    }

    return {
        kind: 'stdio',

        /** @param {string} command - نفس عمود command في mcp_servers (مثال: "npx -y @some/mcp-server") */
        async open(command) {
            const Command = getCommandCtor();
            if (!Command) {
                throw new Error(
                    'stdio transport: Deno.Command غير متاح في بيئة التشغيل الحالية - ' +
                    'Supabase Edge Functions لا تدعم تشغيل subprocess (راجع التعليق أعلى الملف). ' +
                    'شغّل هذا الـ transport من عملية Deno كاملة الصلاحيات، أو استخدم بروكسي streamable_http/sse بدل stdio لهذا السيرفر.'
                );
            }
            if (!command) throw new Error('stdio transport: command مطلوب لفتح subprocess');

            const [bin, ...args] = parseCommandLine(command);
            const cmd = new Command(bin, { args, stdin: 'piped', stdout: 'piped', stderr: 'piped' });
            child = cmd.spawn();
            opened = true;
            closing = false;

            writer = child.stdin.getWriter();
            readLoopPromise = runReadLoop(child.stdout);

            // stderr = logging فقط وفق الـ spec، لا يُفسَّر كـ JSON-RPC إطلاقًا
            (async () => {
                const reader = child.stderr.getReader();
                const decoder = new TextDecoder();
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        const text = decoder.decode(value, { stream: true }).trim();
                        if (text) console.error(`[stdio transport stderr] ${text}`);
                    }
                } catch { /* العملية اتقفلت - تجاهل */ }
            })();
        },

        /**
         * @param {unknown} payload
         * @param {import('../../contracts/request-context.js').RequestContext} [requestContext]
         * @param {import('../types.js').TransportOptions} [opts]
         */
        async send(payload, requestContext = {}, opts = {}) {
            if (!opened || !writer) throw new Error('Transport غير مفتوح - نادِ open(command) أولاً');
            if (requestContext.headers || requestContext.cookies || requestContext.tls) {
                // stdio مفيش HTTP هنا خالص - أي auth context من نوع headers/cookies/tls
                // لا معنى له. النوع الوحيد اللي منطقي فعليًا لعملية فرعية محلية هو 'none'
                // (auth/providers/none.js) - أي حاجة تانية تعني إعداد خاطئ للسيرفر، مش تجاهل صامت
                throw new Error('stdio transport: auth_type يتطلب headers/cookies/tls غير مدعوم لعمليات stdio الفرعية - استخدم auth_type=none');
            }

            const outgoingBody = requestContext.sign ? await requestContext.sign(payload) : payload;
            const isRequest = payload && typeof payload === 'object' && 'id' in payload && payload.id !== undefined;

            let correlatedPromise = null;
            if (isRequest) {
                correlatedPromise = new Promise((resolve, reject) => {
                    pending.set(payload.id, { resolve, reject });
                });
            }

            await writer.write(new TextEncoder().encode(JSON.stringify(outgoingBody) + '\n'));

            if (!isRequest) return { status: 202, headers: {}, body: null }; // إشعار - لا رد متوقع

            const timeoutMs = opts.timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;
            const timedOut = Symbol('timeout');
            const rpcMsg = await Promise.race([
                correlatedPromise,
                new Promise((resolve) => setTimeout(() => resolve(timedOut), timeoutMs)),
            ]);
            if (rpcMsg === timedOut) {
                pending.delete(payload.id);
                throw new Error(`stdio transport: انتهت مهلة انتظار الرد المرتبط بـ id=${payload.id} من العملية الفرعية`);
            }
            return { status: 200, headers: {}, body: rpcMsg };
        },

        onMessage(cb) {
            messageHandlers.add(cb);
        },

        async close() {
            closing = true;
            settleAllPending(new Error('stdio transport: الاتصال اتقفل'));
            try { await writer?.close(); } catch { /* العملية ممكن تكون اتقفلت بالفعل */ }
            try { child?.kill('SIGTERM'); } catch { /* تجاهل */ }
            await readLoopPromise?.catch(() => {});
            opened = false;
            child = null;
            writer = null;
            readLoopPromise = null;
            messageHandlers.clear();
        },

        isOpen() { return opened; },
    };
}

registerTransport('stdio', createStdioTransport);
export { createStdioTransport };
