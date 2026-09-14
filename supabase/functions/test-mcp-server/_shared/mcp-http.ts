// ============================================================
// mcp-http.ts — عميل Streamable HTTP مطابق للمواصفة
// ------------------------------------------------------------
// مسؤولية واحدة: تنفيذ رسالة JSON-RPC واحدة فوق HTTP بالشكل الذي
// تفرضه مواصفة MCP "Streamable HTTP"، وإرجاع نتيجة منظّمة.
// لا يعرف شيئًا عن قاعدة البيانات ولا عن المصادقة — يستقبل ترويسات
// جاهزة ويضيف فوقها ما تفرضه المواصفة فقط.
//
// لماذا وُجد هذا الملف (المشكلة التي يصلحها):
//
//   كان كل من runTest() في test-mcp-server و rpcCall() في
//   mcp-invoke-tool يرسل `Content-Type: application/json` فقط، بدون
//   ترويسة Accept. والمواصفة تُلزم العميل بأن يعلن قبوله للنوعين معًا:
//
//       Accept: application/json, text/event-stream
//
//   الخوادم الملتزمة بالمواصفة ترد 406 Not Acceptable بدونها — وهو
//   بالضبط الخطأ المسجَّل على اتصال Supabase: "Initialize failed (406)".
//
//   وكان الكود القديم يفترض أيضًا أن كل رد هو JSON، فينادي res.json()
//   مباشرة. لكن الخادم مخيَّر بين ردٍّ JSON وردٍّ بصيغة SSE لنفس الطلب،
//   فأي خادم يختار SSE كان سيكسر العميل حتى بعد إصلاح Accept وحده.
//
// نسخة مطابقة بالحرف موجودة في mcp-invoke-tool/_shared/mcp-http.ts —
// نفس عُرف التكرار المتّبع أصلًا في mcp-crypto.ts و mcp-oauth.ts:
// الدالتان حزمتان منفصلتان تمامًا عند النشر، ولا import مشترك بينهما.
// ============================================================

/** حالة الجلسة عبر عدة نداءات لنفس الخادم (Mcp-Session-Id + إصدار البروتوكول المتفاوَض عليه). */
export interface McpHttpSession {
  sessionId: string | null;
  protocolVersion: string | null;
}

export function createMcpSession(): McpHttpSession {
  return { sessionId: null, protocolVersion: null };
}

export interface McpPostResult {
  ok: boolean;
  /** رمز حالة HTTP الفعلي (0 لو فشل الاتصال قبل أي رد). */
  status: number;
  /** نتيجة JSON-RPC عند النجاح. */
  result?: unknown;
  /** رسالة مفهومة عند الفشل. */
  message?: string;
  /** true تحديدًا لو أسقط الخادم الجلسة (404 على جلسة قائمة) فيلزم initialize جديد. */
  sessionExpired?: boolean;
  /** قيمة WWW-Authenticate كما وردت — تُستخدم لاحقًا في اكتشاف المصادقة (مرحلة لاحقة). */
  wwwAuthenticate?: string | null;
}

const PROTOCOL_VERSION = "2025-06-18";
const ACCEPT = "application/json, text/event-stream";

/** أقصى حجم نقرؤه من رد SSE قبل الاستسلام — حارس ضد خادم يُبقي البثّ مفتوحًا بلا نهاية. */
const MAX_SSE_BYTES = 1_000_000;

/**
 * يستخرج أول رسالة JSON-RPC مطابقة من بثّ SSE.
 *
 * لا ينتظر إغلاق البثّ: يقرأ تدريجيًا ويتوقف فور العثور على رسالة تحمل
 * الـ id المطلوب. خادم يُبقي القناة مفتوحة بعد الرد (وهو سلوك مسموح في
 * المواصفة) كان سيعلّق res.text() حتى انتهاء المهلة.
 */
async function readJsonRpcFromSse(res: Response, expectedId: number | null): Promise<unknown | null> {
  const body = res.body;
  if (!body) return null;

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      total += value?.byteLength ?? 0;
      if (total > MAX_SSE_BYTES) break;

      buffer += decoder.decode(value, { stream: true });

      // أحداث SSE مفصولة بسطر فارغ. \r\n\r\n مقبول أيضًا.
      let sep: number;
      while ((sep = findEventBoundary(buffer)) !== -1) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep).replace(/^(\r?\n){2}/, "");

        const payload = dataLinesOf(rawEvent);
        if (!payload) continue;

        let parsed: any;
        try { parsed = JSON.parse(payload); } catch { continue; }

        // نتجاهل أي إشعار من الخادم (بلا id) وأي رد بـ id مختلف.
        if (parsed && typeof parsed === "object" && "id" in parsed) {
          if (expectedId === null || parsed.id === expectedId) return parsed;
        }
      }
    }
  } finally {
    try { await reader.cancel(); } catch { /* البثّ مُغلق بالفعل */ }
  }

  return null;
}

function findEventBoundary(buffer: string): number {
  const a = buffer.indexOf("\n\n");
  const b = buffer.indexOf("\r\n\r\n");
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

/** يجمع كل أسطر `data:` في حدث SSE واحد (المواصفة تسمح بأكثر من سطر لرسالة واحدة). */
function dataLinesOf(rawEvent: string): string | null {
  const lines = rawEvent.split(/\r?\n/);
  const data: string[] = [];
  for (const line of lines) {
    if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  return data.length ? data.join("\n") : null;
}

function httpFailureMessage(status: number, snippet: string): string {
  switch (status) {
    case 401:
      return "المصادقة مرفوضة (401) — التوكن غير صالح أو انتهت صلاحيته. أعد ربط الخادم.";
    case 403:
      return "الوصول مرفوض (403) — التوكن صالح لكنه لا يملك الصلاحية المطلوبة على هذا الخادم.";
    case 404:
      return "المسار غير موجود (404) — تأكد أن عنوان الخادم هو نقطة نهاية MCP الصحيحة.";
    case 405:
      return "الخادم رفض الطريقة (405) — العنوان المُدخل على الأرجح ليس نقطة نهاية MCP.";
    case 406:
      return "الخادم رفض صيغة الرد المطلوبة (406) — وهي حالة لا يفترض أن تحدث بعد إرسال ترويسة Accept الصحيحة.";
    case 415:
      return "الخادم رفض نوع المحتوى المُرسل (415).";
    case 429:
      return "تم تجاوز حد الطلبات على الخادم (429) — حاول بعد قليل.";
    default:
      break;
  }
  if (status >= 500) return `الخادم واجه خطأ داخليًا (${status}).`;
  return `فشل الطلب (HTTP ${status})${snippet ? ` — ${snippet}` : ""}`;
}

/** يقرأ بداية جسم الرد كنصّ، لعرضها داخل رسالة خطأ مفهومة. لا يُستخدم إلا في مسارات الفشل. */
async function safeSnippet(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 200).replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
}

export interface McpPostOptions {
  /** true فقط لنداء initialize — عندها لا تُرسل ترويسة إصدار البروتوكول (لم يُتفاوض عليه بعد). */
  isInitialize?: boolean;
  timeoutMs?: number;
}

/**
 * ينفّذ رسالة JSON-RPC واحدة فوق Streamable HTTP.
 *
 * @param url        عنوان نقطة نهاية MCP
 * @param authHeaders ترويسات المصادقة الجاهزة (لا تُقرأ ولا تُسجَّل هنا)
 * @param session    حالة الجلسة — تُحدَّث موضعيًا عند استلام Mcp-Session-Id
 * @param payload    جسم JSON-RPC كاملًا (يشمل id أو يخلو منه للإشعارات)
 */
export async function mcpPost(
  url: string,
  authHeaders: Record<string, string>,
  session: McpHttpSession,
  payload: Record<string, unknown>,
  opts: McpPostOptions = {}
): Promise<McpPostResult> {
  const { isInitialize = false, timeoutMs = 15000 } = opts;

  const headers: Record<string, string> = {
    ...authHeaders,
    "Content-Type": "application/json",
    // جوهر الإصلاح: المواصفة تُلزم العميل بإعلان قبوله للنوعين معًا.
    Accept: ACCEPT,
  };

  if (session.sessionId) headers["Mcp-Session-Id"] = session.sessionId;
  // المواصفة: تُرسل على كل طلب بعد التفاوض، وتغيب عن initialize نفسه.
  if (!isInitialize && session.protocolVersion) {
    headers["MCP-Protocol-Version"] = session.protocolVersion;
  }

  const expectedId = typeof payload.id === "number" ? (payload.id as number) : null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
      // لا نتبع التحويلات تلقائيًا: مواصفة Fetch تحوّل POST إلى GET عند 301/302/303،
      // فيصل الطلب إلى الخادم بطريقة خاطئة ويردّ 405 بلا أي إشارة إلى السبب الحقيقي.
      // نمسكها هنا ونشرحها بدل أن نبتلعها. (هذا بالضبط ما كان يحدث مع
      // mad3oom.online التي تحوّل الآن إلى mad3oom.com.)
      redirect: "manual",
    });
  } catch (err) {
    clearTimeout(timer);
    const name = (err as Error)?.name;
    if (name === "AbortError") {
      return { ok: false, status: 0, message: `انتهت مهلة الاتصال بالخادم (${timeoutMs} مللي ثانية) دون رد.` };
    }
    return { ok: false, status: 0, message: `تعذر الوصول إلى الخادم: ${(err as Error)?.message ?? "خطأ شبكة"}` };
  }

  try {
    return await handleResponse(res, session, isInitialize, expectedId);
  } catch (err) {
    // قراءة الجسم نفسها قد تفشل (انقطاع في المنتصف، أو إلغاء بالمهلة).
    // العقد هنا أن هذه الدالة لا ترمي أبدًا — كل فشل يعود كنتيجة منظّمة،
    // تمامًا كما كان الكود القديم يلتقط كل شيء في try/catch واحد.
    const name = (err as Error)?.name;
    if (name === "AbortError") {
      return { ok: false, status: res.status, message: `انتهت المهلة أثناء قراءة رد الخادم (${timeoutMs} مللي ثانية).` };
    }
    return { ok: false, status: res.status, message: `تعذّرت قراءة رد الخادم: ${(err as Error)?.message ?? "خطأ غير معروف"}` };
  } finally {
    clearTimeout(timer);
  }
}

/** معالجة الرد بعد وصوله. مفصولة عن mcpPost ليبقى التقاط الأخطاء في مكان واحد. */
async function handleResponse(
  res: Response,
  session: McpHttpSession,
  isInitialize: boolean,
  expectedId: number | null
): Promise<McpPostResult> {
  {
    // الجلسة تُسلَّم في الرد على initialize، وتُعاد على كل طلب بعده.
    const incomingSession = res.headers.get("mcp-session-id");
    if (incomingSession) session.sessionId = incomingSession;

    // 202 Accepted: الرد المتوقّع لإشعار بلا id — لا جسم له.
    if (res.status === 202) {
      try { await res.body?.cancel(); } catch { /* لا جسم */ }
      return { ok: true, status: 202 };
    }

    // تحويل: السبب الأشيع هو عنوان خادم قديم. نسمّي الوجهة الجديدة بدل
    // ترك المستخدم أمام 405 غامض.
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      try { await res.body?.cancel(); } catch { /* لا جسم */ }
      return {
        ok: false,
        status: res.status,
        message: location
          ? `عنوان الخادم يحوّل الطلب إلى ${location} — حدّث عنوان الخادم إلى هذا الرابط مباشرة. (التحويل يفقد طريقة POST فيفشل الاتصال.)`
          : `الخادم ردّ بتحويل (${res.status}) بلا عنوان وجهة — تأكد من صحة رابط الخادم.`,
      };
    }

    if (!res.ok) {
      const wwwAuthenticate = res.headers.get("www-authenticate");
      // 404 على جلسة قائمة تعني أن الخادم أسقطها ويلزم initialize جديد.
      const sessionExpired = res.status === 404 && !!session.sessionId && !isInitialize;
      if (sessionExpired) session.sessionId = null;

      const snippet = await safeSnippet(res);
      return {
        ok: false,
        status: res.status,
        sessionExpired,
        wwwAuthenticate,
        message: sessionExpired
          ? "انتهت جلسة الخادم — يلزم إعادة الاتصال."
          : httpFailureMessage(res.status, snippet),
      };
    }

    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    let message: any = null;

    if (contentType.includes("text/event-stream")) {
      message = await readJsonRpcFromSse(res, expectedId);
      if (message === null) {
        return { ok: false, status: res.status, message: "الخادم فتح بثًّا (SSE) لكنه لم يرسل ردًّا مطابقًا للطلب." };
      }
    } else {
      // لا نفترض JSON: نقرأ نصًّا ثم نحلّل، فنستطيع عرض المحتوى الفعلي عند الفشل.
      const text = await res.text();
      if (!text.trim()) {
        return { ok: false, status: res.status, message: "الخادم ردّ بجسم فارغ." };
      }
      try {
        message = JSON.parse(text);
      } catch {
        const snippet = text.slice(0, 200).replace(/\s+/g, " ").trim();
        return {
          ok: false,
          status: res.status,
          message: `الخادم ردّ بمحتوى غير JSON (${contentType || "بلا نوع محدّد"}) — ${snippet}`,
        };
      }
    }

    if (message && typeof message === "object" && message.error) {
      const code = message.error.code;
      const text = message.error.message || "الخادم ردّ بخطأ بلا وصف";
      return { ok: false, status: res.status, message: code !== undefined ? `${text} (JSON-RPC ${code})` : text };
    }

    return { ok: true, status: res.status, result: message?.result };
  }
}

export interface McpHandshakeResult {
  ok: boolean;
  message?: string;
  serverName?: string | null;
  serverVersion?: string | null;
  protocolVersion?: string | null;
  capabilities?: Record<string, unknown> | null;
}

/**
 * initialize ثم notifications/initialized — المصافحة كاملة كما تفرضها المواصفة.
 *
 * الإشعار الثاني كان غائبًا تمامًا عن الكود القديم؛ بعض الخوادم ترفض
 * tools/list قبل استلامه. فشله لا يُسقط الاتصال (خوادم كثيرة تتجاهله)،
 * لكن إرساله يجعلنا صحيحين مع التي تشترطه.
 */
export async function mcpHandshake(
  url: string,
  authHeaders: Record<string, string>,
  session: McpHttpSession,
  opts: { timeoutMs?: number; clientName?: string } = {}
): Promise<McpHandshakeResult> {
  const { timeoutMs = 15000, clientName = "Mad3oom" } = opts;

  const init = await mcpPost(url, authHeaders, session, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: clientName, version: "1.0.0" },
    },
  }, { isInitialize: true, timeoutMs });

  if (!init.ok) return { ok: false, message: init.message ?? "فشل initialize" };

  const result = (init.result ?? {}) as Record<string, any>;
  session.protocolVersion = typeof result.protocolVersion === "string" ? result.protocolVersion : PROTOCOL_VERSION;

  await mcpPost(url, authHeaders, session, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
  }, { timeoutMs }).catch(() => undefined);

  return {
    ok: true,
    serverName: result.serverInfo?.name ?? null,
    serverVersion: result.serverInfo?.version ?? null,
    protocolVersion: session.protocolVersion,
    capabilities: result.capabilities ?? null,
  };
}
