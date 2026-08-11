import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ============================================================
// generate-ai-chat-reply
// ------------------------------------------------------------
// نقطة نهاية يستدعيها محرك البوت (حاليًا: chat-bot-reply، كنداء
// server-to-server) كـ fallback ذكي لما رسالة العميل الحرة متطابقتش
// مع أي كلمة مفتاحية أو فلو معروف.
//
// [تحديث] لم تعد هذه الدالة تتكلم مع أي مزوّد بنفسها.
//   كانت تحتوي على: فك تشفير المفاتيح + خريطة موديلات افتراضية مكتوبة
//   في الكود + ثلاث دوال نداء (OpenAI/Claude/Gemini) — أي مزوّد خارج
//   الخمسة المعروفين كان يفشل بـ "المزود مش مدعوم لردود الشات".
//   الآن كل ذلك يمر عبر ai-gateway، فيكسب الشات بوت تلقائيًا:
//     • أي مزوّد في الكتالوج (AgentRouter وغيره) بدون تعديل هنا
//     • سلسلة احتياطي: لو سقط المزوّد المختار يُجرَّب التالي
//     • تسجيل التوكنات والتكلفة وزمن الاستجابة في ai_usage_events
//   والأهم: المفاتيح لم تعد تُفك هنا إطلاقًا — تقلّص عدد الأماكن التي
//   تلمس الأسرار.
//
// ما لم يتغيّر عمدًا: حد الاستخدام الساعي، وشروط التفعيل، والذاكرة
// الذكية، وشكل الطلب والرد ({sessionId, message} → {reply}).
//
// [Phase A] حد استخدام ساعي للحسابات المجانية (غير المستحقة عبر
// has_chatbot_entitlement) — راجع "Chatbot Modes Phase 1 Implementation
// Report" §2.3/§9. الحسابات المستحقة (whatsapp_enabled أو
// role IN ('super_user','admin')) غير محدودة ولا بتتحسب أصلاً.
// ============================================================

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
}

// TODO(product): رقم افتراضي مبدئي لحد الرسائل الذكية للحساب المجاني في
// الساعة - لسه محتاج تأكيد من مدحوم (مش موجود في المواصفة المعتمدة).
// غيّره هنا وقت ما يتحدد الرقم النهائي.
const FREE_TIER_AI_HOURLY_LIMIT = 10;

/** نفس السقف القديم للردود — يُمرَّر صراحةً حتى لا يرث الافتراضي الأعلى للـ Gateway. */
const CHAT_MAX_TOKENS = 500;

function currentHourWindowIso(): string {
  const d = new Date();
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

/**
 * بيرجع true لو المستخدم مسموحله يكمل (تحت الحد أو حساب مستحق/unlimited)،
 * و false لو وصل للحد ولازم نرفض. "fail-open": أي خطأ في القراءة/الكتابة
 * هنا (مش المفروض يحصل) بيسيبنا نكمل عادي بدل ما نمنع رد حقيقي بسبب عطل
 * في آلية العد نفسها.
 */
async function checkAiQuota(adminClient: ReturnType<typeof createClient>, userId: string): Promise<boolean> {
  const { data: entitled, error: entErr } = await adminClient.rpc("has_chatbot_entitlement", { p_user_id: userId });
  if (entErr) {
    console.error("generate-ai-chat-reply: خطأ في التحقق من الاستحقاق:", entErr);
    return true; // fail-open
  }
  if (entitled) return true; // حساب مستحق: بلا حدود، ومش بنعدّه أصلاً

  const windowStart = currentHourWindowIso();
  const { data: newCount, error: incErr } = await adminClient.rpc("increment_chat_ai_usage", {
    p_user_id: userId,
    p_window_start: windowStart,
  });
  if (incErr) {
    console.error("generate-ai-chat-reply: خطأ في عدّاد استخدام الذكاء الاصطناعي:", incErr);
    return true; // fail-open
  }

  return typeof newCount === "number" ? newCount <= FREE_TIER_AI_HOURLY_LIMIT : true;
}

const DEFAULT_SYSTEM_PROMPT =
  "أنت مساعد الدعم الفني لمنصة مدعوم (Mad3oom)، منصة إدارة تذاكر دعم فني وواتساب بزنس. " +
  "رد بإيجاز وبالعربية الفصحى المبسطة (أو باللهجة اللي بيتكلم بيها العميل)، وكن ودودًا ومباشرًا. " +
  "لو مش متأكد من إجابة دقيقة، انصح العميل يفتح تذكرة دعم بدل ما تخمّن.";

interface ChatTurn { role: "user" | "assistant"; content: string; }

/** نداء داخلي server-to-server بمفتاح service_role — الـ Gateway يعتبره موثوقًا. */
async function callGateway(payload: Record<string, unknown>) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const res = await fetch(`${supabaseUrl}/functions/v1/ai-gateway`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceRoleKey}` },
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.error) {
    throw new Error(data?.error || `فشل نداء ai-gateway (كود ${res.status})`);
  }
  return data;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing Authorization header" }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData?.user) return jsonResponse({ error: "Unauthorized" }, 401);

    let body: { sessionId?: string; message?: string };
    try { body = await req.json(); } catch { return jsonResponse({ error: "Invalid JSON body" }, 400); }

    const sessionId = (body.sessionId || "").trim();
    const message = (body.message || "").trim();
    if (!sessionId || !message) return jsonResponse({ error: "sessionId و message مطلوبين" }, 400);

    // نتأكد إن الجلسة دي فعلاً بتاعة العميل ده عبر RLS (userClient) قبل أي حاجة تانية
    const { data: sessionRow } = await userClient.from("chat_sessions").select("id").eq("id", sessionId).maybeSingle();
    if (!sessionRow) return jsonResponse({ error: "الجلسة مش موجودة أو ممنوع الوصول" }, 403);

    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    // [Phase A] حد الاستخدام الساعي - قبل أي عمل مكلف (نداء مزود خارجي).
    // الحسابات المستحقة (has_chatbot_entitlement) غير محدودة ومش بتتعدّ أصلاً.
    const withinQuota = await checkAiQuota(adminClient, userData.user.id);
    if (!withinQuota) {
      return jsonResponse({ error: "تم الوصول للحد الأقصى من الردود الذكية لهذه الساعة", code: "quota_exceeded" }, 429);
    }

    // إعدادات البوت (صف واحد بس حاليًا، مفيش تخصيص لكل عميل)
    const { data: botSettings, error: botSettingsError } = await adminClient.from("bot_settings").select("*").single();
    if (botSettingsError || !botSettings) return jsonResponse({ error: "إعدادات البوت غير متاحة" }, 500);
    if (!botSettings.ai_enabled || !botSettings.ai_integration_id) {
      return jsonResponse({ error: "الرد الذكي غير مفعّل حاليًا" }, 400);
    }

    // سياق المحادثة (اختياري) لو الذاكرة الذكية مفعّلة
    let history: ChatTurn[] = [];
    if (botSettings.smart_memory_enabled) {
      const { data: recentMessages } = await adminClient
        .from("chat_messages")
        .select("message_text, is_bot_reply, is_admin_reply")
        .eq("session_id", sessionId)
        .order("created_at", { ascending: false })
        .limit(8);

      history = (recentMessages || [])
        .reverse()
        .map(m => ({ role: (m.is_bot_reply || m.is_admin_reply) ? "assistant" : "user", content: m.message_text || "" }) as ChatTurn)
        .filter(h => h.content);
    }

    const systemPrompt = botSettings.system_prompt || DEFAULT_SYSTEM_PROMPT;
    const temperature = typeof botSettings.ai_temperature === "number" ? botSettings.ai_temperature : 0.7;

    let result: any;
    try {
      result = await callGateway({
        action: "generate",
        // المزوّد المختار في الإعدادات يبقى الأساسي دائمًا. لو الأدمن عرّف
        // سلسلة توجيه للوضع "chat" فهي تُستخدم كاحتياطي بعده، لا كبديل عنه.
        integration_id: botSettings.ai_integration_id,
        mode: "chat",
        system: systemPrompt,
        messages: [...history, { role: "user", content: message }],
        temperature,
        max_tokens: CHAT_MAX_TOKENS,
        source: "chatbot",
        session_id: sessionId,
        user_id: userData.user.id,
      });
    } catch (gatewayErr) {
      // تفاصيل الخطأ الكاملة في لوجات ai-gateway مع اسم المزوّد وكل محاولة.
      // هنا نرجّع رسالة مختصرة تساعد في التشخيص دون كشف أي شيء حسّاس.
      console.error("generate-ai-chat-reply: فشل نداء ai-gateway:", gatewayErr);
      return jsonResponse({ error: `فشل توليد الرد: ${(gatewayErr as Error).message}` }, 502);
    }

    const reply = (result?.reply || "").trim();
    if (!reply) return jsonResponse({ error: "رد فارغ من المزوّد" }, 502);

    // ملاحظة: تحديث last_used_at وتسجيل الاستخدام/التكلفة يتمّان داخل
    // ai-gateway لكل نداء، فلا يتكرران هنا.
    return jsonResponse({ reply });
  } catch (err) {
    console.error("generate-ai-chat-reply error:", err);
    return jsonResponse({ error: "حدث خطأ غير متوقع أثناء توليد الرد: " + (err as Error).message }, 500);
  }
});
