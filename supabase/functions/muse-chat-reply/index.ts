// ============================================================
// muse-chat-reply — المسار السريع لردود Muse داخل المنصة
// ------------------------------------------------------------
// صفحة owner/muse-chat.html كانت تنتظر الرد من الجسر (كرون كل دقيقة
// + hook كل 15 ثانية + وكيل Muse كامل يُشغَّل من الصفر لكل رسالة):
// الرد كان يصل بعد ~165 ثانية، والـ runs نفسها كانت تتكدّس (run يأخذ
// 133-300 ثانية فيتجاوز فترته وتلغى الـ runs التالية).
//
// هذه الدالة هي المسار السريع بدلًا من ذلك: trigger على INSERT في
// ai_session_messages (الترحيل 132، عبر pg_net) يناديها فور وصول
// رسالة user في جلسة muse% نشطة لمالك مفعّل، وهي في عملية واحدة:
//   1. تحجز الرسالة ذريًا (muse_reply_claims، ON CONFLICT DO NOTHING)
//      فلا يردّ عليها أحد مرتين — ولا الجسر ولا استدعاء مكرر.
//   2. تقرأ آخر 10 رسائل للسياق، وتصنّف الرسالة.
//   3. الرسالة الثقيلة (بناء صفحة، إجراء كتابة، تذكير، كوتة، إرسال):
//      إقرار فوري `⏳ جارٍ التنفيذ — …` في أقل من 3 ثوانٍ، ويكمل الوكيل
//      (الجسر الحالي) المهمة — الإقرار ليس ردًا نهائيًا.
//   4. الرسالة العادية أو سؤال البيانات: نداء واحد لـ ai-gateway
//      (Cerebras أولًا، وقاعدة وضع chat احتياطيًا، max_attempts=2،
//      ميزانية 25 ثانية) ثم إدخال الرد.
//   5. عند فشل الـ gateway: تُحرَّر الحجز (حذف الصف) بلا رد، فيلتقط
//      الجسر الحالي الرسالة في الـ run التالي — لا صمت بلا صاحب.
//
// لماذا Cerebras صراحةً؟ قاعدة توجيه وضع chat الحيّة (ai_routing_rules)
// توجّه mode='chat' إلى تكامل OpenAI بموديل agnes-2.0-flash — موديل بلا
// أي صف استخدام مسجّل. أما Cerebras (zai-glm-4.7) فله زمن استجابة فعلي
// مسجّل 631ms–2403ms. تمرير integration_id صراحةً يجعل Cerebras
// الأساسي وقاعدة الوضع احتياطيًا بعده (router.ts: الاختيار الصريح يبقى
// الأساسي وقواعد الوضع تُلحق كاحتياطيات). تكامل AgentRouter حالته
// failed فلا يظهر في السلسلة أصلًا.
//
// بلا أي استيراد (صفر اعتماديات) عمدًا: الدالة تُنفَّذ في اختبار Node
// مثل verify-turnstile (Deno shim + fetch مُستبدَل)، وكل ما تلمسه
// (fetch, AbortController, Deno.env, Deno.serve) موجود في Node أصالةً.
// لذلك تُنفَّذ قراءات/كتابات Supabase بـ fetch خام على PostgREST
// ومفتاح service_role، لا بمكتبة supabase-js.
//
// الأمان:
//   - النداء لا يُقبل إلا بسر webhook في header ‏X-Muse-Reply-Secret‏
//     مطابق لمتغير البيئة MUSE_REPLY_WEBHOOK_SECRET — بلا سر مضبوط
//     503، وسر خاطئ 401. السر نفسه يُولَّد داخل القاعدة في الترحيل 132
//     (internal_service_secrets) ويُضبط كمتغير بيئة وقت التطبيق الحي؛
//     لا يظهر في أي كود أو ملف.
//   - لا تكتب إلا في ai_session_messages و ai_sessions و
//     agent_activity_log و muse_reply_claims. لا واتساب، لا تذاكر كتابة،
//     لا SIE. أسئلة البيانات تُجاب بقراءة SQL مباشرة (tickets/profiles)
//     وتُمرَّر كسياق لـ ai-gateway — لا نداءات MCP من هنا.
//   - المالك الوحيد المسموح: من في muse_account_activations (active).
//
// حدود صادقة: هذا المسار ليس الوكيل الكامل — لا يبني صفحات ولا ينفّذ
// إجراءات كتابة ولا تذكيرات؛ يقرّ بها فورًا ويسلّمها للجسر. وإن فشل
// الـ gateway مرتين يترك الرد للجسر بدل اختراع رد.
// ============================================================

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-muse-reply-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/** تكامل Cerebras — الأساسي الصريح (انظر التعليق أعلاه). */
const CEREBRAS_INTEGRATION_ID = "9c8eab8c-de82-49cf-9b6a-57fbc4622fca";

/** بادئة الإقرار الفوري — يستثنيها استعلام "غير مجاب" المحدَّث في الجسر. */
const ACK_PREFIX = "⏳ جارٍ التنفيذ — ";

/** ميزانية نداء ai-gateway الكلية (محاولتان كحد أقصى داخلها). */
const GATEWAY_TIMEOUT_MS = 25000;

/** رسائل السياق المرسلة لـ ai-gateway. */
const CONTEXT_LIMIT = 10;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

/** مقارنة ثابتة الزمن تقريبًا حتى لا يُسرَّب السر بطول المطابقة. */
function secretsEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ── التصنيف: دوال نقية بلا اعتماديات (تُختبَر مباشرة من Node) ──────────────

/**
 * ثقيلة = تحتاج الوكيل الكامل (الجسر)، لا الرد السريع:
 * بناء/تعديل صفحة، إجراء كتابة (إرسال لتذكرة/واتساب، إنشاء/تجديد/إلغاء)،
 * تذكير، سؤال عن الكوتة/الحصة. أي شيء آخر عادي.
 */
export function classifyMuseMessage(text: string): "heavy" | "normal" {
  const t = (text || "").toLowerCase();

  // تذكير — أي صيغة.
  if (/فك[ّٰ]?رن[يى]|ذك[ّٰ]?رن[يى]|تذكير|فكرنى|ذكرنى/.test(t)) return "heavy";

  // الكوتة/الحصة/المتبقي.
  if (/الكوت[ةه]|الحص[ةه]|المتبق[يى]|المتبقية|الاستهلاك|رصيد/.test(t)) return "heavy";

  // بناء أو تعديل صفحة/واجهة/شاشة.
  const pageNoun = /صفحة|صفحه|واجهة|واجهه|شاشة|شاشه|تبويب|لوحة|لوحه/.test(t);
  const buildVerb = /ابن[يى]?|أنشئ|انشئ|اعمل|صم[ّٰ]?م|عد[ّٰ]?ل|غي[ّٰ]?ر|حد[ّٰ]?ث|أضف|اضف|طو[ّٰ]?ر|برمج|build|create|edit|update/.test(t);
  if (pageNoun && (buildVerb || /جديد[ةه]?/.test(t))) return "heavy";

  // إرسال لواتساب أو لتذكرة (كتابة — لا يرسلها المسار السريع).
  if (/واتساب|whatsapp/.test(t) && /أرسل|ابعت|ابعث|ارسل|send/.test(t)) return "heavy";
  if (/تذكرة|تذكره|ticket/.test(t) && /أرسل|ابعت|ابعث|أرسلها|ابعتها|ارسل|send/.test(t)) return "heavy";

  // إنشاء/تجديد/إلغاء/حذف (كتابة).
  if (/أنشئ تذكرة|انشئ تذكرة|افتح تذكرة|جدد الاشتراك|ألغ|الغاء الاشتراك|إلغاء الاشتراك|أنشئ اشتراك|انشئ اشتراك/.test(t)) return "heavy";
  if (/احذف|امسح/.test(t) && /رسالة|رساله|جلسة|جلسه|تذكرة|تذكره/.test(t)) return "heavy";

  return "normal";
}

/** سؤال بيانات يُجاب بقراءة مباشرة (تذاكر/عملاء/إحصائيات) كسياق للـ gateway. */
export function isDataQuestion(text: string): boolean {
  const t = (text || "").toLowerCase();
  return /تذكرة|تذاكر|إحصائ|احصائ|داشبورد|عميل|عملاء|عدد|كم عدد|آخر|اخر/.test(t)
    && !/فك[ّٰ]?رن[يى]|ذك[ّٰ]?رن[يى]/.test(t);
}

/** سطر الإقرار الفوري حسب نوع المهمة الثقيلة — قصير، ولا يدّعي الإنجاز. */
export function ackTextFor(text: string): string {
  const t = (text || "").toLowerCase();
  if (/صفحة|صفحه|واجهة|واجهه|شاشة|شاشه|تبويب|لوحة|لوحه/.test(t)) {
    return "استلمت طلب الصفحة — بجهّزه وهنفّذه من لوحة المالك، وهيوصلك الرد هنا.";
  }
  if (/فك[ّٰ]?رن[يى]|ذك[ّٰ]?رن[يى]|تذكير/.test(t)) {
    return "استلمت طلب التذكير — بسجّله وهنفّذه في وقته.";
  }
  if (/الكوت[ةه]|الحص[ةه]|المتبق[يى]|الاستهلاك|رصيد/.test(t)) {
    return "بجيب لك حالة الحصة الحالية من الاشتراك.";
  }
  if (/تذكرة|تذكره|ticket/.test(t) && /أرسل|ابعت|ابعث|أرسلها|ابعتها|ارسل|send/.test(t)) {
    return "بجهّز الإرسال للتذكرة — هراجع الصياغة معاك قبل أي إرسال.";
  }
  if (/واتساب|whatsapp/.test(t)) {
    return "بجهّز رسالة الواتساب — هراجعها معاك قبل الإرسال.";
  }
  return "استلمت طلبك — بنفّذه وهيوصلك الرد هنا.";
}

// ── عميل REST خام على PostgREST بمفتاح service_role ─────────────────────────

interface RestClient {
  base: string;
  key: string;
}

function restHeaders(client: RestClient): Record<string, string> {
  return {
    "apikey": client.key,
    "Authorization": `Bearer ${client.key}`,
    "Content-Type": "application/json",
  };
}

async function restGet(client: RestClient, path: string, headersExtra?: Record<string, string>): Promise<{ status: number; data: unknown; headers: Headers }> {
  const res = await fetch(`${client.base}/rest/v1/${path}`, { headers: { ...restHeaders(client), ...(headersExtra || {}) } });
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { status: res.status, data, headers: res.headers };
}

async function restPost(client: RestClient, path: string, body: unknown, prefer?: string): Promise<{ status: number; data: unknown }> {
  const headers: Record<string, string> = restHeaders(client);
  if (prefer) headers["Prefer"] = prefer;
  const res = await fetch(`${client.base}/rest/v1/${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { status: res.status, data };
}

async function restPatch(client: RestClient, path: string, body: unknown): Promise<number> {
  const res = await fetch(`${client.base}/rest/v1/${path}`, {
    method: "PATCH",
    headers: restHeaders(client),
    body: JSON.stringify(body),
  });
  await res.text().catch(() => "");
  return res.status;
}

async function restDelete(client: RestClient, path: string): Promise<void> {
  try {
    const res = await fetch(`${client.base}/rest/v1/${path}`, { method: "DELETE", headers: restHeaders(client) });
    await res.text().catch(() => "");
  } catch { /* تحرير الحجز best-effort — لا يمنع أي شيء */ }
}

// ── سياق البيانات الحي (best-effort — فشله لا يمنع الرد) ────────────────────

async function loadDataContext(client: RestClient): Promise<string | null> {
  try {
    const [statusRes, lastRes, customersRes] = await Promise.all([
      restGet(client, "tickets?select=status&limit=500"),
      restGet(client, "tickets?select=ticket_number,title,status,created_at&order=created_at.desc&limit=5"),
      restGet(client, "profiles?select=id&limit=0", { "Prefer": "count=exact" }),
    ]);
    if (statusRes.status !== 200 || lastRes.status !== 200) return null;

    const byStatus: Record<string, number> = {};
    for (const row of (statusRes.data as Array<{ status?: string }> | null) || []) {
      const s = row?.status || "unknown";
      byStatus[s] = (byStatus[s] || 0) + 1;
    }
    const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
    const lines = (lastRes.data as Array<{ ticket_number?: string; title?: string; status?: string }> | null) || [];
    const lastLines = lines.map((r) => `#${r.ticket_number ?? "?"} — ${r.title ?? ""} (${r.status ?? ""})`.trim()).join("\n");

    let customers = "";
    if (customersRes.status === 200) {
      const range = customersRes.headers.get("content-range") || "";
      const m = /\/(\d+)$/.exec(range);
      if (m) customers = `\nعدد العملاء (profiles): ${m[1]}.`;
    }

    return [
      "بيانات حيّة من المنصة وقت الطلب (لا تخترع غيرها):",
      `إجمالي التذاكر (آخر 500 كحد أقصى): ${total} — بالحالة: ${Object.entries(byStatus).map(([k, v]) => `${k}: ${v}`).join("، ")}.`,
      "آخر 5 تذاكر:",
      lastLines || "لا تذاكر.",
      customers,
    ].filter(Boolean).join("\n");
  } catch {
    return null;
  }
}

// ── نداء ai-gateway ─────────────────────────────────────────────────────────

async function callGateway(client: RestClient, body: Record<string, unknown>): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GATEWAY_TIMEOUT_MS);
  try {
    const res = await fetch(`${client.base}/functions/v1/ai-gateway`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${client.key}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({})) as { reply?: unknown; error?: unknown };
    if (!res.ok || data?.error) {
      throw new Error(typeof data?.error === "string" ? data.error : `ai-gateway HTTP ${res.status}`);
    }
    const reply = typeof data?.reply === "string" ? data.reply.trim() : "";
    if (!reply) throw new Error("ai-gateway returned an empty reply");
    return reply;
  } finally {
    clearTimeout(timer);
  }
}

// ── المعالج ─────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const startedAt = Date.now();
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  // 1) مصادقة الـ webhook — فشل مغلق: بلا سر مضبوط لا يُقبل أي نداء.
  const expectedSecret = Deno.env.get("MUSE_REPLY_WEBHOOK_SECRET") || "";
  if (!expectedSecret) {
    return json({ ok: false, error: "secret_not_configured" }, 503);
  }
  const providedSecret = req.headers.get("x-muse-reply-secret") || "";
  if (!providedSecret || !secretsEqual(providedSecret, expectedSecret)) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  const supabaseUrl = (Deno.env.get("SUPABASE_URL") || "").replace(/\/$/, "");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !serviceKey) {
    return json({ ok: false, error: "supabase_not_configured" }, 503);
  }
  const client: RestClient = { base: supabaseUrl, key: serviceKey };

  let body: { message_id?: unknown; session_id?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }
  const messageId = typeof body?.message_id === "string" ? body.message_id.trim() : "";
  const sessionId = typeof body?.session_id === "string" ? body.session_id.trim() : "";
  if (!messageId || !sessionId) {
    return json({ ok: false, error: "message_id_and_session_id_required" }, 400);
  }

  try {
    // 2) الرسالة: يجب أن توجد وأن تكون من المستخدم.
    const msgRes = await restGet(client, `ai_session_messages?select=id,session_id,role,content,created_at&session_id=eq.${encodeURIComponent(sessionId)}&id=eq.${encodeURIComponent(messageId)}&limit=1`);
    const msg = (Array.isArray(msgRes.data) ? msgRes.data[0] : null) as
      | { id: string; session_id: string; role: string; content: string; created_at: string }
      | null;
    if (!msg || msg.role !== "user") {
      return json({ ok: true, action: "ignored", reason: "not_a_user_message" });
    }

    // 3) الجلسة: نشطة، model_id يبدأ بـ muse.
    const sessRes = await restGet(client, `ai_sessions?select=id,owner_id,model_id,status&id=eq.${encodeURIComponent(sessionId)}&limit=1`);
    const sess = (Array.isArray(sessRes.data) ? sessRes.data[0] : null) as
      | { id: string; owner_id: string; model_id: string; status: string }
      | null;
    if (!sess || sess.status !== "active" || !sess.model_id.startsWith("muse")) {
      return json({ ok: true, action: "ignored", reason: "not_an_active_muse_session" });
    }

    // 4) المالك: مفعّل في muse_account_activations فقط.
    const actRes = await restGet(client, `muse_account_activations?select=owner_id&owner_id=eq.${encodeURIComponent(sess.owner_id)}&active=eq.true&limit=1`);
    if (!Array.isArray(actRes.data) || actRes.data.length === 0) {
      return json({ ok: true, action: "ignored", reason: "owner_not_activated" });
    }

    // 5) الحجز الذري: صف واحد لكل رسالة؛ صفر صفوف = حد تاني حجزها.
    const claimRes = await restPost(
      client,
      "muse_reply_claims",
      { message_id: messageId, session_id: sessionId, status: "claimed" },
      "return=representation,resolution=ignore-duplicates",
    );
    if (claimRes.status >= 400 || !Array.isArray(claimRes.data) || claimRes.data.length === 0) {
      return json({ ok: true, action: "ignored", reason: "already_claimed" });
    }

    // 6) إعادة فحص: هل ردّ الجسر عليها قبل أن نبدأ؟ (سباق الجسر والمسار السريع)
    const afterRes = await restGet(client,
      `ai_session_messages?select=content&session_id=eq.${encodeURIComponent(sessionId)}&role=eq.assistant&created_at=gt.${encodeURIComponent(msg.created_at)}&order=created_at.asc&limit=5`);
    const alreadyAnswered = (Array.isArray(afterRes.data) ? afterRes.data : [])
      .some((r) => typeof (r as { content?: unknown }).content === "string"
        && !(r as { content: string }).content.startsWith(ACK_PREFIX));
    if (alreadyAnswered) {
      return json({ ok: true, action: "ignored", reason: "already_answered" });
    }

    const content = msg.content || "";

    // 7) المهمة الثقيلة: إقرار فوري، والوكيل يكمل.
    if (classifyMuseMessage(content) === "heavy") {
      const ack = ACK_PREFIX + ackTextFor(content);
      const ins = await restPost(client, "ai_session_messages",
        { session_id: sessionId, role: "assistant", content: ack, model_id: sess.model_id },
        "return=representation");
      if (ins.status >= 400) {
        await restDelete(client, `muse_reply_claims?message_id=eq.${encodeURIComponent(messageId)}`);
        return json({ ok: false, error: "ack_insert_failed" }, 502);
      }
      await restPatch(client, `ai_sessions?id=eq.${encodeURIComponent(sessionId)}`, { last_active_at: new Date().toISOString() });
      await restPost(client, "agent_activity_log",
        { action: "ack_sent", details: { message_id: messageId }, session_id: sessionId, model_id: sess.model_id })
        .catch(() => null);
      return json({ ok: true, action: "acknowledged", latency_ms: Date.now() - startedAt });
    }

    // 8) المسار السريع: سياق + نداء gateway واحد.
    const histRes = await restGet(client,
      `ai_session_messages?select=role,content&session_id=eq.${encodeURIComponent(sessionId)}&order=created_at.desc&limit=${CONTEXT_LIMIT}`);
    const history = ((Array.isArray(histRes.data) ? histRes.data : []) as Array<{ role: string; content: string }>)
      .reverse()
      .filter((m) => (m.role === "user" || m.role === "assistant")
        && typeof m.content === "string" && m.content
        && !m.content.startsWith(ACK_PREFIX))
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

    let system: string | undefined;
    if (isDataQuestion(content)) {
      const dataCtx = await loadDataContext(client);
      if (dataCtx) {
        system = "أنت مساعد تقني داخل لوحة إدارة منصة مدعوم. أجب بإيجاز ووضوح، وبنفس لغة المستخدم.\n\n" + dataCtx;
      }
    }

    let reply: string;
    try {
      reply = await callGateway(client, {
        action: "generate",
        integration_id: CEREBRAS_INTEGRATION_ID,
        mode: "chat",
        system,
        messages: history.length ? history : [{ role: "user", content }],
        max_attempts: 2,
        source: "muse-fast-reply",
        session_id: sessionId,
        user_id: sess.owner_id,
      });
    } catch (err) {
      // فشل الـ gateway بعد الحجز: حرّر الحجز بلا رد، فيلتقطها الجسر.
      console.error("[muse-chat-reply] gateway failed:", (err as Error).message);
      await restDelete(client, `muse_reply_claims?message_id=eq.${encodeURIComponent(messageId)}`);
      return json({ ok: false, error: "gateway_failed" }, 502);
    }

    // 9) إدخال الرد + تحديث النشاط + سجل واحد. فشل الإدخال يحرّر الحجز للجسر.
    const replyIns = await restPost(client, "ai_session_messages",
      { session_id: sessionId, role: "assistant", content: reply, model_id: sess.model_id },
      "return=representation");
    if (replyIns.status >= 400) {
      await restDelete(client, `muse_reply_claims?message_id=eq.${encodeURIComponent(messageId)}`);
      return json({ ok: false, error: "reply_insert_failed" }, 502);
    }
    await restPatch(client, `ai_sessions?id=eq.${encodeURIComponent(sessionId)}`, { last_active_at: new Date().toISOString() });
    await restPost(client, "agent_activity_log",
      { action: "reply_sent", details: { message_id: messageId }, session_id: sessionId, model_id: sess.model_id })
      .catch(() => null);

    return json({ ok: true, action: "replied", latency_ms: Date.now() - startedAt });
  } catch (err) {
    console.error("[muse-chat-reply] unexpected error:", (err as Error).message);
    return json({ ok: false, error: "internal_error" }, 500);
  }
});
