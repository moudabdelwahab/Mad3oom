import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ============================================================
// test-integration-connection
// ------------------------------------------------------------
// يفك التشفير ويعمل نداء تجريبي حقيقي للمزود المختار، ثم يحدّث
// last_tested_at / last_test_status في external_integrations.
//
// (جديد) بعد نجاح الاختبار، لو المزود بيدعم جلب قائمة موديلات فعلية
// (openai/claude/gemini/openrouter/groq)، بنجيب القائمة ونخزّنها في
// external_integration_models مع أفضل تخمين ممكن لقدراتها الأساسية.
// القدرات دي "heuristic" (تخمين من اسم الموديل أو من بيانات الـ API
// لو متوفرة زي OpenRouter) مش مضمونة 100% - أي بيانات خام إضافية بترجع
// من المزود بتتخزن في عمود metadata للرجوع ليها لاحقاً أو تصحيحها يدوياً.
// فشل جلب الموديلات لا يوقف نجاح الاختبار نفسه (اختبار الاتصال يبقى
// منفصل تماماً عن اكتشاف الموديلات).
// ============================================================

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
}

async function getAesKey(): Promise<CryptoKey> {
  const secret = Deno.env.get("INTEGRATIONS_ENC_KEY");
  if (!secret) throw new Error("INTEGRATIONS_ENC_KEY is not configured");
  const keyMaterial = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", keyMaterial, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function decryptJson(b64: string): Promise<Record<string, any>> {
  const key = await getAesKey();
  const combined = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const cipherBuf = combined.slice(12);
  const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipherBuf);
  return JSON.parse(new TextDecoder().decode(plainBuf));
}

/** المزودين المتوافقين مع OpenAI فقط - بيسمحوا باستبدال الـ base URL (استضافة ذاتية / بروكسي / نسخة مختلفة) */
const OPENAI_COMPATIBLE_PROVIDERS = ["openai", "groq", "openrouter"];

function resolveBaseUrl(provider: string, meta: Record<string, any>, fallback: string): string {
  const custom = (meta?.base_url || "").trim();
  if (custom && OPENAI_COMPATIBLE_PROVIDERS.includes(provider)) {
    return custom.replace(/\/+$/, "");
  }
  return fallback;
}

async function testProvider(provider: string, creds: Record<string, any>, meta: Record<string, any>): Promise<{ ok: boolean; message: string }> {
  try {
    if (provider === "openai") {
      const base = resolveBaseUrl(provider, meta, "https://api.openai.com/v1");
      const res = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${creds.api_key}` } });
      if (res.ok) return { ok: true, message: "تم الاتّصال بنجاح مع OpenAI" };
      return { ok: false, message: `OpenAI رفض الاتّصال (كود ${res.status})` };
    }
    if (provider === "claude") {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": creds.api_key, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
        body: JSON.stringify({ model: meta.model || "claude-3-5-haiku-20241022", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
      });
      if (res.ok || res.status === 400) return { ok: true, message: "مفتاح Claude صالح ويمكن الاتّصال" };
      return { ok: false, message: `Claude رفض الاتّصال (كود ${res.status})` };
    }
    if (provider === "gemini") {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${creds.api_key}`);
      if (res.ok) return { ok: true, message: "تم الاتّصال بنجاح مع Gemini" };
      return { ok: false, message: `Gemini رفض الاتّصال (كود ${res.status})` };
    }
    if (provider === "openrouter") {
      const base = resolveBaseUrl(provider, meta, "https://openrouter.ai/api/v1");
      const res = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${creds.api_key}` } });
      if (res.ok) return { ok: true, message: "تم الاتّصال بنجاح مع OpenRouter" };
      return { ok: false, message: `OpenRouter رفض الاتّصال (كود ${res.status})` };
    }
    if (provider === "groq") {
      const base = resolveBaseUrl(provider, meta, "https://api.groq.com/openai/v1");
      const res = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${creds.api_key}` } });
      if (res.ok) return { ok: true, message: "تم الاتّصال بنجاح مع Groq" };
      return { ok: false, message: `Groq رفض الاتّصال (كود ${res.status})` };
    }
    if (provider === "telegram_bot") {
      const res = await fetch(`https://api.telegram.org/bot${creds.bot_token}/getMe`);
      const data = await res.json();
      if (res.ok && data.ok) return { ok: true, message: `تم الاتّصال بنجاح مع البوت @${data.result?.username || ""}` };
      return { ok: false, message: "توكن بوت تيليجرام مش صحيح" };
    }
    if (provider === "webhook") {
      const res = await fetch(creds.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "test", source: "mad3oom", timestamp: new Date().toISOString() }),
      });
      if (res.status >= 200 && res.status < 300) return { ok: true, message: `الرابط رد بنجاح (كود ${res.status})` };
      return { ok: false, message: `الرابط رد بخطأ (كود ${res.status})` };
    }
    return { ok: true, message: "لا يوجد اختبار اتّصال محدد لهذا المزود (Custom)" };
  } catch (e) {
    return { ok: false, message: "تعذّر الاتّصال: " + (e as Error).message };
  }
}

/** موديل جاهز للحفظ في external_integration_models (بدون integration_id - بيتضاف وقت الحفظ) */
interface DiscoveredModel {
  model_id: string;
  display_name?: string;
  supports_chat?: boolean;
  supports_vision?: boolean;
  supports_tools?: boolean;
  supports_streaming?: boolean;
  context_window?: number | null;
  max_output_tokens?: number | null;
  input_price?: number | null;
  output_price?: number | null;
  metadata?: Record<string, any>;
}

/** تخمين مبدئي (heuristic) لدعم الرؤية (Vision) من اسم الموديل - مش مضمون 100%، بيتحفظ خام في metadata */
function guessSupportsVision(modelId: string): boolean {
  return /vision|4o|gemini|claude-3|claude-3\.5|claude-3\.7|llava|pixtral/i.test(modelId);
}

/** تخمين مبدئي لدعم Tool Calling - المزودين والموديلات الحديثة غالباً بتدعمه */
function guessSupportsTools(provider: string, modelId: string): boolean {
  if (provider === "claude") return true; // كل عائلة Claude 3+ بتدعم tool use
  if (/gpt-4|gpt-3\.5-turbo|o1|o3|gemini|llama-3|mixtral/i.test(modelId)) return true;
  return false;
}

/** OpenAI: نفلتر بس على موديلات الدردشة (نستبعد embeddings/whisper/tts/dall-e/moderation) */
function isChatLikeOpenAiModel(id: string): boolean {
  if (/embedding|whisper|tts|dall-e|moderation|babbage|davinci-00|ada-00/i.test(id)) return false;
  return /^(gpt-|o1|o3|o4|chatgpt)/i.test(id);
}

async function fetchProviderModels(provider: string, creds: Record<string, any>, meta: Record<string, any>): Promise<DiscoveredModel[]> {
  if (provider === "openai") {
    const base = resolveBaseUrl(provider, meta, "https://api.openai.com/v1");
    const res = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${creds.api_key}` } });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.data || [])
      .filter((m: any) => isChatLikeOpenAiModel(m.id))
      .map((m: any) => ({
        model_id: m.id,
        display_name: m.id,
        supports_vision: guessSupportsVision(m.id),
        supports_tools: guessSupportsTools(provider, m.id),
        supports_streaming: true,
        metadata: { owned_by: m.owned_by, raw_created: m.created },
      }));
  }

  if (provider === "groq") {
    const base = resolveBaseUrl(provider, meta, "https://api.groq.com/openai/v1");
    const res = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${creds.api_key}` } });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.data || []).map((m: any) => ({
      model_id: m.id,
      display_name: m.id,
      supports_vision: guessSupportsVision(m.id),
      supports_tools: guessSupportsTools(provider, m.id),
      supports_streaming: true,
      context_window: m.context_window ?? null,
      metadata: { owned_by: m.owned_by, active: m.active },
    }));
  }

  if (provider === "openrouter") {
    const base = resolveBaseUrl(provider, meta, "https://openrouter.ai/api/v1");
    const res = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${creds.api_key}` } });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.data || []).map((m: any) => {
      const modalities: string[] = m.architecture?.input_modalities || (m.architecture?.modality ? [m.architecture.modality] : []);
      return {
        model_id: m.id,
        display_name: m.name || m.id,
        supports_vision: modalities.some((mod) => /image/i.test(mod)) || guessSupportsVision(m.id),
        supports_tools: guessSupportsTools(provider, m.id),
        supports_streaming: true,
        context_window: m.context_length ?? null,
        max_output_tokens: m.top_provider?.max_completion_tokens ?? null,
        input_price: m.pricing?.prompt ? Number(m.pricing.prompt) : null,
        output_price: m.pricing?.completion ? Number(m.pricing.completion) : null,
        metadata: { architecture: m.architecture || null },
      };
    });
  }

  if (provider === "gemini") {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${creds.api_key}`);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.models || [])
      .filter((m: any) => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map((m: any) => {
        const id = String(m.name || "").replace(/^models\//, "");
        return {
          model_id: id,
          display_name: m.displayName || id,
          supports_vision: guessSupportsVision(id),
          supports_tools: guessSupportsTools(provider, id),
          supports_streaming: true,
          context_window: m.inputTokenLimit ?? null,
          max_output_tokens: m.outputTokenLimit ?? null,
          metadata: { supported_generation_methods: m.supportedGenerationMethods || [] },
        };
      });
  }

  if (provider === "claude") {
    // GET /v1/models متاح فعلياً في Anthropic API (نفس مفتاح الـ API الحالي، بدون أي حقل جديد)
    const res = await fetch("https://api.anthropic.com/v1/models", {
      headers: { "x-api-key": creds.api_key, "anthropic-version": "2023-06-01" },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.data || []).map((m: any) => ({
      model_id: m.id,
      display_name: m.display_name || m.id,
      supports_vision: true, // عائلة Claude 3+ بالكامل بتدعم الرؤية
      supports_tools: true, // وبتدعم tool use
      supports_streaming: true,
      metadata: { raw_created_at: m.created_at || null },
    }));
  }

  return []; // telegram_bot / webhook / custom: لا يوجد مفهوم "موديلات" لهم
}

/** يحفظ الموديلات المكتشفة مع الحفاظ على is_enabled/is_default الحاليين لو الموديل موجود بالفعل */
async function saveDiscoveredModels(
  adminClient: ReturnType<typeof createClient>,
  integrationId: string,
  discovered: DiscoveredModel[],
  currentDefaultModelId?: string
): Promise<any[]> {
  if (!discovered.length) return [];

  const { data: existingRows } = await adminClient
    .from("external_integration_models")
    .select("model_id, is_enabled, is_default")
    .eq("integration_id", integrationId);

  const existingMap = new Map((existingRows || []).map((r: any) => [r.model_id, r]));
  const isFirstSync = !existingRows || existingRows.length === 0;
  const hadDefaultAlready = (existingRows || []).some((r: any) => r.is_default);

  const rows = discovered.map((m) => {
    const existing = existingMap.get(m.model_id);
    let isDefault = existing?.is_default ?? false;
    if (!hadDefaultAlready && !isDefault) {
      // أول مزامنة (أو مفيش default محفوظ لسه): نفضّل الموديل المحفوظ قديماً في credentials_meta.model
      // لو مطابق، وإلا أول موديل في القائمة (مرة واحدة بس)
      if (currentDefaultModelId && m.model_id === currentDefaultModelId) isDefault = true;
      else if (isFirstSync && !currentDefaultModelId && discovered[0].model_id === m.model_id) isDefault = true;
    }
    return {
      integration_id: integrationId,
      model_id: m.model_id,
      display_name: m.display_name || m.model_id,
      supports_chat: true,
      supports_vision: !!m.supports_vision,
      supports_tools: !!m.supports_tools,
      supports_streaming: m.supports_streaming ?? true,
      context_window: m.context_window ?? null,
      max_output_tokens: m.max_output_tokens ?? null,
      input_price: m.input_price ?? null,
      output_price: m.output_price ?? null,
      is_enabled: existing?.is_enabled ?? true,
      is_default: isDefault,
      metadata: m.metadata || {},
    };
  });

  const { data: saved, error } = await adminClient
    .from("external_integration_models")
    .upsert(rows, { onConflict: "integration_id,model_id" })
    .select("id, model_id, display_name, supports_chat, supports_vision, supports_tools, supports_streaming, context_window, max_output_tokens, input_price, output_price, is_enabled, is_default");

  if (error) {
    console.error("[test-integration-connection] saveDiscoveredModels failed:", error.message);
    return [];
  }
  return saved || [];
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

    let body: { id?: string };
    try { body = await req.json(); } catch { return jsonResponse({ error: "Invalid JSON body" }, 400); }
    const id = (body.id || "").trim();
    if (!id) return jsonResponse({ error: "id مطلوب" }, 400);

    // نتحقق من الوصول عبر RLS أولاً (userClient) قبل ما نقرأ المفاتيح بـ service_role
    const { data: allowedRow } = await userClient.from("external_integrations").select("id").eq("id", id).maybeSingle();
    if (!allowedRow) return jsonResponse({ error: "الربط الخارجي مش موجود أو ممنوع الوصول" }, 404);

    const adminClient = createClient(supabaseUrl, serviceRoleKey);
    const { data: row, error: fetchError } = await adminClient
      .from("external_integrations")
      .select("id, provider, credentials_encrypted, credentials_meta")
      .eq("id", id)
      .single();

    if (fetchError || !row) return jsonResponse({ error: "الربط الخارجي مش موجود" }, 404);
    if (!row.credentials_encrypted) return jsonResponse({ error: "لا يوجد مفاتيح مخزّنة لهذا الربط" }, 400);

    let creds: Record<string, any>;
    try { creds = await decryptJson(row.credentials_encrypted); } catch (e) {
      return jsonResponse({ error: "فشل فك تشفير المفاتيح" }, 500);
    }

    const meta = row.credentials_meta || {};
    const result = await testProvider(row.provider, creds, meta);

    await adminClient.from("external_integrations").update({
      last_tested_at: new Date().toISOString(),
      last_test_status: result.ok ? "success" : "failed",
      last_test_message: result.message,
    }).eq("id", id);

    let models: any[] = [];
    if (result.ok) {
      try {
        const discovered = await fetchProviderModels(row.provider, creds, meta);
        models = await saveDiscoveredModels(adminClient, id, discovered, meta.model);
      } catch (e) {
        // اكتشاف الموديلات مش لازم يفشّل نجاح اختبار الاتصال نفسه
        console.error("[test-integration-connection] model discovery failed:", (e as Error).message);
      }
    }

    return jsonResponse({ success: result.ok, message: result.message, models });
  } catch (err) {
    console.error("Unexpected error:", err);
    return jsonResponse({ error: "حدث خطأ غير متوقع" }, 500);
  }
});
