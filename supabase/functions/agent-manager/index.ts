import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ============================================================
// agent-manager
// ------------------------------------------------------------
// طبقة وسيطة (Agent Manager) بين لوحة تحكم "وكلاء الذكاء الاصطناعي"
// وأي وكيل مسجّل في جدول ai_agents. الصفحة لا تعرف شيئًا عن Hermes
// أو أي وكيل آخر بعينه — تتعامل فقط مع هذه الدالة عبر action موحّد.
//
// إضافة وكيل جديد = سجل جديد في ai_agents فقط، بدون أي تعديل هنا.
//
// actions:
//   list            — كل الوكلاء (بدون أسرار)
//   get              — وكيل واحد بالتفصيل (بدون أسرار)
//   create / update / delete — إدارة سجل الوكيل (إعدادات فقط)
//   start / stop / restart   — تنفيذ أمر تشغيل عبر الوكيل نفسه
//   status           — جلب Runtime Metrics لحظية من الوكيل (لا تُخزّن)
//   logs             — جلب السجلات من الوكيل (لا تُخزّن كاملة)
//   test_connection  — تحقق سريع من إمكانية الوصول لـ health_endpoint
//   chat             — محادثة OpenAI عبر Hermes: POST {endpoint}/v1/chat/completions
//   run_create / run_get / run_events / run_stop — تشغيلات Hermes تحت {endpoint}/v1/runs
//
// عقد Hermes (يختلف عن الوكيل العام):
//   - GET /health بلا Authorization (المسار عام)؛ باقي المسارات Bearer.
//   - لا يوجد POST /control ولا POST /logs: start/restart يتحققان من /health
//     فقط، وstop تحديث قاعدة بيانات فقط، وlogs تُرجع {unsupported:true}.
//   - المسارات من قاعدة endpoint (بلا "/" أخيرة) وقابلة للتجاوز من settings:
//     chat_completions_path (افتراضي /v1/chat/completions) وruns_path (افتراضي /v1/runs).
//   - نموذج المحادثة والتشغيل: جسم OpenAI يُمرَّر كما هو، ثم تُطبَّق
//     افتراضيات model/provider (applyHermesModelDefaults) قبل النشر:
//     الزوج العامل الافتراضي model "nvidia/nemotron-3-ultra-550b-a55b"
//     مع provider "nvidia" — مؤكد حيًا 2026-11-27: المحادثة تعمل فقط
//     بهما معًا. إرسال "hermes-agent" وحده يفشل لأن النموذج الافتراضي
//     للخادم لم يُضبط بعد، فتُعامَل "hermes-agent" كمفقودة وتُستبدل
//     بالزوج العامل؛ "hermes-agent" تسمية فقط كما يعلنها GET /v1/models
//     وليست قيمة نموذج عاملة. التجاوز يتطلب "model" و"provider" معًا
//     (كل حقل مفقود يُكمَّل من الزوج الافتراضي)، ولا يُرسَل model بلا
//     provider أبدًا. باقي الحقول (model_options وstream وmessages)
//     تُمرَّر بلا أي تعديل.
//   - مسار معروف لم يُبنَ له عميل بعد: /api/sessions/{id}/chat (يحترم
//     model/provider أيضًا) — خارج نطاق v1 الحالي، فلا كود له هنا.
//
// ملاحظة أمان: أي مفتاح API أو قيمة بيئة معلّمة is_secret تُشفّر هنا
// (AES-GCM) فقط، ولا تُعاد للواجهة أبدًا بنصها الصريح — نفس نمط
// manage-external-integration / mcp_server_connections في المشروع.
//
// [إصلاح] update كانت تُعيد تشفير القيمة المقنّعة "••••••••" حرفيًا في
// أي مرة يُحفظ فيها الوكيل دون تعديل متغيّر سرّي فعليًا، مما يمحو القيمة
// السرّية الأصلية. الحل: نجلب الصف الحالي أولاً، ولو القيمة الواردة لا
// تزال المقنّعة، نحتفظ بالقيمة المشفّرة القديمة لنفس المفتاح.
// ============================================================

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// الأعمدة المسموح إرجاعها للواجهة (بدون api_key_encrypted الخام)
const PUBLIC_COLUMNS = `
  id, name, slug, description, type, version, status, enabled, auto_start, auto_restart,
  connection_type, protocol, host, port, endpoint, health_endpoint, api_key_last4,
  timeout_ms, retry_count, retry_delay_ms,
  executable, working_directory, command_start, command_stop, command_restart,
  health_check_interval, last_heartbeat, last_error,
  resources, permissions, environment_variables, settings, metadata,
  created_by, created_at, updated_at
`;

const SECRET_MASK = "••••••••";

type EnvVar = { key: string; value: string; is_secret?: boolean };

async function getAesKey(): Promise<CryptoKey> {
  const secret = Deno.env.get("AI_AGENTS_ENC_KEY");
  if (!secret) throw new Error("AI_AGENTS_ENC_KEY is not configured");
  const keyMaterial = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", keyMaterial, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptText(plain: string): Promise<string> {
  const key = await getAesKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(plain);
  const cipherBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
  const combined = new Uint8Array(iv.length + cipherBuf.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(cipherBuf), iv.length);
  return btoa(String.fromCharCode(...combined));
}

async function decryptText(encoded: string): Promise<string> {
  const key = await getAesKey();
  const combined = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const data = combined.slice(12);
  const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
  return new TextDecoder().decode(plainBuf);
}

// يشفّر قيم متغيرات البيئة المعلّمة is_secret فقط، ويترك الباقي كما هو.
// القيم المشفّرة سابقًا (تبدأ بعلامة enc:) لا تُعاد تشفيرها لو لم تتغيّر.
//
// [إصلاح] existingVars: الصف القديم كما هو مخزّن (بقيمه المشفّرة الحقيقية،
// وليست المقنّعة). لو القيمة الواردة من الواجهة هي القناع "••••••••"
// (يعني المستخدم لم يلمس هذا الحقل)، نرجع للقيمة القديمة المشفّرة لنفس
// المفتاح بدلاً من تشفير القناع نفسه كقيمة سرّية جديدة.
async function encryptEnvVars(vars: EnvVar[] | undefined, existingVars?: EnvVar[]): Promise<EnvVar[]> {
  if (!Array.isArray(vars)) return [];
  const existingByKey = new Map((Array.isArray(existingVars) ? existingVars : []).map((v) => [v.key, v]));
  const out: EnvVar[] = [];
  for (const v of vars) {
    if (!v?.key) continue;
    if (!v.is_secret) {
      out.push({ key: v.key, value: v.value ?? "", is_secret: false });
      continue;
    }
    if (v.value && !v.value.startsWith("enc:") && v.value !== SECRET_MASK) {
      // قيمة سرّية جديدة فعليًا من المستخدم — شفّرها
      out.push({ key: v.key, value: "enc:" + (await encryptText(v.value)), is_secret: true });
    } else if (v.value?.startsWith("enc:")) {
      // مُرسلة مشفّرة بالفعل (نادر من الواجهة، لكن آمن لو حصل)
      out.push({ key: v.key, value: v.value, is_secret: true });
    } else {
      // القيمة ما زالت القناع أو فارغة — احتفظ بالقيمة القديمة المشفّرة لنفس المفتاح إن وُجدت
      const prev = existingByKey.get(v.key);
      out.push({ key: v.key, value: prev?.value?.startsWith("enc:") ? prev.value : "", is_secret: true });
    }
  }
  return out;
}

// يقنّع القيم السرّية قبل إرسالها للواجهة (لا يفك تشفيرها إطلاقًا هنا)
function maskEnvVarsForClient(vars: unknown): EnvVar[] {
  if (!Array.isArray(vars)) return [];
  return vars.map((v: EnvVar) => (v?.is_secret ? { key: v.key, value: SECRET_MASK, is_secret: true } : v));
}

function sanitizeAgent(row: Record<string, unknown>) {
  return { ...row, environment_variables: maskEnvVarsForClient(row.environment_variables) };
}

// ---------- Hermes ----------
// مسارات Hermes تُشتق من endpoint (بلا "/" أخيرة)، مع تجاوز اختياري من settings.
// أمثلة: settings.chat_completions_path = "/v1/chat/completions"،
// وsettings.runs_path = "/v1/runs" (الافتراضيان).
function hermesBase(agent: Record<string, unknown>): string {
  return ((agent.endpoint as string) || "").replace(/\/+$/, "");
}

function hermesSettingPath(agent: Record<string, unknown>, key: string, fallback: string): string {
  const settings = agent.settings as Record<string, unknown> | null | undefined;
  const raw = settings && typeof settings[key] === "string" ? (settings[key] as string).trim() : "";
  const path = raw || fallback;
  return path.startsWith("/") ? path : `/${path}`;
}

function hermesChatPath(agent: Record<string, unknown>): string {
  return hermesSettingPath(agent, "chat_completions_path", "/v1/chat/completions");
}

function hermesRunsPath(agent: Record<string, unknown>): string {
  return hermesSettingPath(agent, "runs_path", "/v1/runs");
}

// يفك تشفير مفتاح الوكيل (إن وُجد) لنداءات Hermes؛ فشل الفك = بلا مفتاح،
// وسيفشل النداء بوضوح أدناه لو كان المفتاح مطلوبًا فعلاً.
async function hermesApiKey(agent: Record<string, unknown>): Promise<string | undefined> {
  if (!agent.api_key_encrypted) return undefined;
  try {
    return await decryptText(agent.api_key_encrypted as string);
  } catch {
    return undefined;
  }
}

// يفسّر نص SSE: يأخذ أسطر "data:" فقط، يتخطى "[DONE]" والأسطر الفارغة،
// ويحوّل كل حمولة JSON إلى كائن (أو يبقيها نصًا خامًا لو لم تكن JSON).
// دالة نقية ومُصدَّرة للاختبار (node --test يستخرجها من هذا الملف وينفذها،
// لأن ملف Deno هذا لا يُستورَد مباشرة في Node بسبب استيرادات jsr:).
// ملاحظة للاختبار: جسم الدالة بلا أي صياغة TypeScript عدا تعليقات النوع
// الثلاثة البسيطة (المعامل، ونوعا الإرجاع والمصفوفة) حتى يبقى تجريدها آليًا.
export function parseSseDataPayloads(sseText: string): unknown[] {
  const events: unknown[] = [];
  if (!sseText) return events;
  for (const rawLine of sseText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      events.push(JSON.parse(payload));
    } catch {
      events.push(payload);
    }
  }
  return events;
}

// يقرأ جسم SSE حتى يُغلَق أو يُجهَض (انتهاء المهلة) ويعيد ما جُمع حتى الآن.
// الإجهاض أثناء القراءة متعمَّد (collect_ms في run_events أو timeout_ms في
// المحادثة المتدفقة) وليس خطأً — ما جُمع هو النتيجة.
async function readSseText(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) text += decoder.decode(value, { stream: true });
    }
  } catch (err) {
    if (!(err instanceof Error && err.name === "AbortError")) throw err;
  } finally {
    text += decoder.decode();
    try {
      reader.releaseLock();
    } catch {
      // تجاهل — القارئ قد يكون مغلقًا بالفعل بعد الإجهاض
    }
  }
  return text;
}

// نداء JSON عام لمسارات Hermes (Bearer دائمًا — ما عدا /health الذي يمر عبر
// callAgent بعلامة noAuth). يعيد JSON كما هو، أو خطأ موحّدًا مع data.
async function hermesFetchJson(
  agent: Record<string, unknown>,
  url: string,
  method: "GET" | "POST",
  body?: Record<string, unknown>
) {
  if (!hermesBase(agent)) {
    return { ok: false, error: "الوكيل غير متصل بعد: لا يوجد endpoint مُعد لهذا الوكيل." };
  }
  const apiKey = await hermesApiKey(agent);
  const timeoutMs = (agent.timeout_ms as number) || 10000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    if (!res.ok) return { ok: false, error: `الوكيل رد بخطأ (${res.status})`, data };
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: "تعذّر الوصول إلى الوكيل: " + (err instanceof Error ? err.message : String(err)) };
  } finally {
    clearTimeout(timer);
  }
}

// نداء SSE لمسارات Hermes: يقرأ لمدة collectMs ثم يُجهض ويعيد ما جُمع.
// collectMs يُقصّ عند timeout_ms الخاص بالوكيل. تُستخدم للمحادثة المتدفقة
// (collectMs = timeout_ms: حتى الإغلاق أو المهلة) ولأحداث التشغيل.
async function hermesFetchSse(
  agent: Record<string, unknown>,
  url: string,
  collectMs: number,
  method: "GET" | "POST" = "GET",
  body?: Record<string, unknown>
) {
  if (!hermesBase(agent)) {
    return { ok: false, error: "الوكيل غير متصل بعد: لا يوجد endpoint مُعد لهذا الوكيل." };
  }
  const apiKey = await hermesApiKey(agent);
  const timeoutMs = (agent.timeout_ms as number) || 10000;
  const cappedMs = Math.max(0, Math.min(Number.isFinite(collectMs) ? collectMs : timeoutMs, timeoutMs));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cappedMs);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
      return { ok: false, error: `الوكيل رد بخطأ (${res.status})`, data };
    }
    const raw = await readSseText(res);
    return { ok: true, raw };
  } catch (err) {
    return { ok: false, error: "تعذّر الوصول إلى الوكيل: " + (err instanceof Error ? err.message : String(err)) };
  } finally {
    clearTimeout(timer);
  }
}

// جسم الطلب المُمرَّر لـ Hermes: يقبل الشكلين المتداولين —
//   {id, body:{...}} (عقد agent-manager المكتوب في المهمة) و
//   {id, ...fields} (ما ترسله agent-service.js فعليًا: chatWithAgent تنشر
//   حقول OpenAI في المستوى الأعلى). الجسم المُدمج يُمرَّر كما هو بلا أي
//   تعديل — لا حذف ولا إعادة كتابة لـ model أو provider أو model_options
//   أو stream. الشكل المُدمج له الأولوية إن وُجد.
// افتراضيات model/provider تُطبَّق بعدها في applyHermesModelDefaults
// (قبل النشر فقط) ولا تمسّ أي حقل آخر.
function hermesPassthroughBody(body: Record<string, any>): Record<string, unknown> | null {
  const nested = body.body;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) return nested as Record<string, unknown>;
  const rest: Record<string, unknown> = { ...body };
  delete rest.action;
  delete rest.id;
  return rest;
}

// يطبّق افتراضيات model/provider على جسم محادثة/تشغيل بعد تمريره
// (hermesPassthroughBody) وقبل نشره للخادم. دالة نقية ومُصدَّرة للاختبار
// (نفس نمط parseSseDataPayloads: تُستخرج من هذا الملف وتُنفَّذ في Node).
// ملاحظة للاختبار: جسم الدالة بلا أي صياغة TypeScript عدا تعليقات النوع
// البسيطة (المعامل ونوع الإرجاع ونوع النسخة) حتى يبقى تجريدها آليًا.
// القواعد بالترتيب:
//   أ. model === "hermes-agent" يُعامَل كمفقود (تسمية GET /v1/models فقط،
//      وليست قيمة نموذج عاملة — إرسالها وحدها يفشل لأن النموذج الافتراضي
//      للخادم لم يُضبط بعد، مؤكد حيًا 2026-11-27).
//   ب. model مفقود/فارغ بعد (أ) → النموذج العامل "nvidia/nemotron-3-ultra-550b-a55b".
//   ج. provider مفقود/فارغ → "nvidia".
//   د. model وprovider معًا (وmodel ليست "hermes-agent") → يُمرَّران بلا مساس.
//   هـ. أي حقل آخر (model_options وstream وmessages...) بلا أي مساس،
//      والدخل نفسه لا يُعدَّل — تُعاد نسخة جديدة.
export function applyHermesModelDefaults(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };
  const model = typeof out.model === "string" ? out.model.trim() : "";
  if (!model || model === "hermes-agent") {
    out.model = "nvidia/nemotron-3-ultra-550b-a55b";
  }
  const provider = typeof out.provider === "string" ? out.provider.trim() : "";
  if (!provider) {
    out.provider = "nvidia";
  }
  return out;
}

// معرّف التشغيل: يقبل run_id (عقد المهمة) وrunId (ما ترسله agent-service.js).
function hermesRunId(body: Record<string, any>): string {
  return String(body.run_id ?? body.runId ?? "").trim();
}

// مهلة جمع أحداث SSE: تقبل collect_ms وcollectMs؛ الافتراضي 5000ms.
function hermesCollectMs(body: Record<string, any>): number {
  const v = body.collect_ms ?? body.collectMs;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 5000;
}

// نداء HTTP عام لأي وكيل (Agent Manager لا يعرف تفاصيل الوكيل، فقط ينفذ
// عقد اتصال موحّد: GET health_endpoint للحالة، POST endpoint/control للتحكم،
// GET endpoint/logs للسجلات). لو endpoint غير مُعد بعد، يرجع خطأ واضح
// بدلاً من الفشل الصامت — وهذا متوقع لأي وكيل لم يُربط بعد (مثل Hermes حالياً).
// opts.noAuth: إسقاط رأس Authorization صراحةً (يُستخدم لنداءات الصحة العامة
// مثل /health في Hermes). وبدونها، تُسقَط المصادقة تلقائيًا عن نداءات الحالة
// لوكيل من نوع hermes فقط، وتبقى Bearer على كل المسارات الأخرى ولكل الأنواع.
async function callAgent(
  agent: Record<string, unknown>,
  path: "control" | "status" | "logs",
  payload?: Record<string, unknown>,
  opts?: { noAuth?: boolean }
) {
  const base = (agent.endpoint as string) || "";
  if (!base) {
    return { ok: false, error: "الوكيل غير متصل بعد: لا يوجد endpoint مُعد لهذا الوكيل." };
  }

  let apiKey: string | undefined;
  if (agent.api_key_encrypted) {
    try {
      apiKey = await decryptText(agent.api_key_encrypted as string);
    } catch {
      // تجاهل فشل فك التشفير هنا؛ سيفشل الاتصال بوضوح أدناه لو المفتاح مطلوب فعلاً
    }
  }

  const url = path === "status" ? (agent.health_endpoint as string) || `${base}/health` : `${base}/${path}`;
  const timeoutMs = (agent.timeout_ms as number) || 10000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // Hermes: مسار /health عام بلا Authorization؛ باقي المسارات Bearer دائمًا.
  const omitAuth = opts?.noAuth ?? (path === "status" && agent.type === "hermes");

  try {
    const res = await fetch(url, {
      method: path === "status" ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey && !omitAuth ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: path === "status" ? undefined : JSON.stringify(payload || {}),
      signal: controller.signal,
    });
    const text = await res.text();
    let data: unknown;
    try { data = JSON.parse(text); } catch { data = text; }
    if (!res.ok) return { ok: false, error: `الوكيل رد بخطأ (${res.status})`, data };
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: "تعذّر الوصول إلى الوكيل: " + (err instanceof Error ? err.message : String(err)) };
  } finally {
    clearTimeout(timer);
  }
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

    const { data: isAdminData } = await userClient.rpc("is_admin");
    if (!isAdminData) return jsonResponse({ error: "هذا القسم متاح للأدمن فقط" }, 403);

    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    let body: Record<string, any>;
    try { body = await req.json(); } catch { return jsonResponse({ error: "Invalid JSON body" }, 400); }

    const action = body.action as string;
    const VALID_ACTIONS = ["list", "get", "create", "update", "delete", "start", "stop", "restart", "status", "logs", "test_connection", "chat", "run_create", "run_get", "run_events", "run_stop"];
    if (!VALID_ACTIONS.includes(action)) return jsonResponse({ error: "action غير معروف" }, 400);

    // ---------- list ----------
    if (action === "list") {
      const { data, error } = await adminClient.from("ai_agents").select(PUBLIC_COLUMNS).order("created_at", { ascending: true });
      if (error) return jsonResponse({ error: error.message }, 500);
      return jsonResponse({ agents: (data || []).map(sanitizeAgent) });
    }

    // ---------- get ----------
    if (action === "get") {
      const id = (body.id || "").trim();
      if (!id) return jsonResponse({ error: "id مطلوب" }, 400);
      const { data, error } = await adminClient.from("ai_agents").select(PUBLIC_COLUMNS).eq("id", id).maybeSingle();
      if (error) return jsonResponse({ error: error.message }, 500);
      if (!data) return jsonResponse({ error: "الوكيل غير موجود" }, 404);
      return jsonResponse({ agent: sanitizeAgent(data) });
    }

    // ---------- create ----------
    if (action === "create") {
      const name = (body.name || "").trim();
      const slug = (body.slug || "").trim().toLowerCase();
      if (!name || !slug) return jsonResponse({ error: "name و slug مطلوبان" }, 400);
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(slug)) return jsonResponse({ error: "slug غير صالح" }, 400);

      const insertRow: Record<string, unknown> = {
        name, slug,
        description: body.description ?? null,
        type: (body.type || "custom").trim(),
        version: body.version ?? null,
        enabled: body.enabled ?? true,
        auto_start: body.auto_start ?? false,
        auto_restart: body.auto_restart ?? false,
        connection_type: body.connection_type || "http",
        protocol: body.protocol ?? null,
        host: body.host ?? null,
        port: body.port ?? null,
        endpoint: body.endpoint ?? null,
        health_endpoint: body.health_endpoint ?? null,
        timeout_ms: body.timeout_ms ?? 10000,
        retry_count: body.retry_count ?? 3,
        retry_delay_ms: body.retry_delay_ms ?? 2000,
        executable: body.executable ?? null,
        working_directory: body.working_directory ?? null,
        command_start: body.command_start ?? null,
        command_stop: body.command_stop ?? null,
        command_restart: body.command_restart ?? null,
        health_check_interval: body.health_check_interval ?? 30,
        resources: body.resources ?? [],
        permissions: body.permissions ?? [],
        environment_variables: await encryptEnvVars(body.environment_variables),
        settings: body.settings ?? {},
        metadata: body.metadata ?? {},
        created_by: userData.user.id,
      };

      if (body.api_key) {
        insertRow.api_key_encrypted = await encryptText(body.api_key);
        insertRow.api_key_last4 = String(body.api_key).slice(-4);
      }

      const { data, error } = await adminClient.from("ai_agents").insert(insertRow).select(PUBLIC_COLUMNS).single();
      if (error) return jsonResponse({ error: "فشل الإنشاء: " + error.message }, 500);
      return jsonResponse({ agent: sanitizeAgent(data) });
    }

    // ---------- update ----------
    if (action === "update") {
      const id = (body.id || "").trim();
      if (!id) return jsonResponse({ error: "id مطلوب" }, 400);

      // [إصلاح] نجلب الصف الحالي أولاً عشان نقدر نحافظ على القيم السرّية
      // المشفّرة لأي متغيّر بيئة لسه معروض للمستخدم كقناع "••••••••".
      const { data: existing, error: existingErr } = await adminClient
        .from("ai_agents")
        .select("environment_variables")
        .eq("id", id)
        .maybeSingle();
      if (existingErr) return jsonResponse({ error: existingErr.message }, 500);
      if (!existing) return jsonResponse({ error: "الوكيل غير موجود" }, 404);

      const updateRow: Record<string, unknown> = {};
      const passthroughFields = [
        "name", "description", "type", "version", "enabled", "auto_start", "auto_restart",
        "connection_type", "protocol", "host", "port", "endpoint", "health_endpoint",
        "timeout_ms", "retry_count", "retry_delay_ms",
        "executable", "working_directory", "command_start", "command_stop", "command_restart",
        "health_check_interval", "resources", "permissions", "settings", "metadata",
      ];
      for (const f of passthroughFields) if (f in body) updateRow[f] = body[f];

      if ("environment_variables" in body) {
        updateRow.environment_variables = await encryptEnvVars(
          body.environment_variables,
          existing.environment_variables as EnvVar[]
        );
      }
      if (body.api_key) {
        updateRow.api_key_encrypted = await encryptText(body.api_key);
        updateRow.api_key_last4 = String(body.api_key).slice(-4);
      }

      const { data, error } = await adminClient.from("ai_agents").update(updateRow).eq("id", id).select(PUBLIC_COLUMNS).single();
      if (error) return jsonResponse({ error: "فشل التحديث: " + error.message }, 500);
      return jsonResponse({ agent: sanitizeAgent(data) });
    }

    // ---------- delete ----------
    if (action === "delete") {
      const id = (body.id || "").trim();
      if (!id) return jsonResponse({ error: "id مطلوب" }, 400);
      const { error } = await adminClient.from("ai_agents").delete().eq("id", id);
      if (error) return jsonResponse({ error: "فشل الحذف: " + error.message }, 500);
      return jsonResponse({ success: true });
    }

    // ---------- start / stop / restart / status / logs / test_connection ----------
    const id = (body.id || "").trim();
    if (!id) return jsonResponse({ error: "id مطلوب" }, 400);
    const { data: agent, error: fetchErr } = await adminClient.from("ai_agents").select("*").eq("id", id).maybeSingle();
    if (fetchErr) return jsonResponse({ error: fetchErr.message }, 500);
    if (!agent) return jsonResponse({ error: "الوكيل غير موجود" }, 404);

    if (action === "test_connection") {
      const result = await callAgent(agent, "status");
      return jsonResponse(result);
    }

    if (action === "status") {
      const result = await callAgent(agent, "status");
      if (result.ok) {
        await adminClient.from("ai_agents").update({ last_heartbeat: new Date().toISOString() }).eq("id", id);
      }
      return jsonResponse(result);
    }

    if (action === "logs") {
      // Hermes لا يوفّر مسار /logs — نرجع "غير مدعوم" بدل نداء سيفشل حتمًا.
      if (agent.type === "hermes") {
        return jsonResponse({ ok: true, data: { unsupported: true, logs: [], message: "Hermes لا يوفّر مسار /logs — السجلات غير متاحة من مدعوم" } });
      }
      const result = await callAgent(agent, "logs", { limit: body.limit ?? 200, level: body.level, search: body.search });
      return jsonResponse(result);
    }

    // ---------- chat / run_* (Hermes: /v1/chat/completions و /v1/runs) ----------
    // الجسم يُمرَّر كما هو، ثم تُطبَّق افتراضيات model/provider
    // (applyHermesModelDefaults) قبل النشر؛ model_options وstream وmessages
    // بلا تعديل. run_get/run_events/run_stop لا تحمل model أصلًا فلا افتراضيات لها.
    if (action === "chat" || action === "run_create" || action === "run_get" || action === "run_events" || action === "run_stop") {
      const base = hermesBase(agent);
      if (!base) return jsonResponse({ ok: false, error: "الوكيل غير متصل بعد: لا يوجد endpoint مُعد لهذا الوكيل." });

      if (action === "chat") {
        let chatBody = hermesPassthroughBody(body);
        if (!chatBody || Object.keys(chatBody).length === 0) {
          return jsonResponse({ error: "body مطلوب" }, 400);
        }
        // الافتراضيات العاملة (model + provider معًا) قبل النشر للخادم.
        chatBody = applyHermesModelDefaults(chatBody);
        const url = `${base}${hermesChatPath(agent)}`;
        if (chatBody.stream === true) {
          // متدفقة: نقرأ SSE حتى يُغلَق الدفق أو تنتهي timeout_ms، ثم نعيد النص الخام.
          const timeoutMs = (agent.timeout_ms as number) || 10000;
          const streamed = await hermesFetchSse(agent, url, timeoutMs, "POST", chatBody);
          if (!streamed.ok) return jsonResponse(streamed);
          return jsonResponse({ ok: true, data: { streamed: true, raw: streamed.raw } });
        }
        const result = await hermesFetchJson(agent, url, "POST", chatBody);
        return jsonResponse(result);
      }

      if (action === "run_create") {
        let runBody = hermesPassthroughBody(body);
        if (!runBody) return jsonResponse({ error: "body مطلوب" }, 400);
        // الافتراضيات العاملة (model + provider معًا) قبل النشر للخادم.
        runBody = applyHermesModelDefaults(runBody);
        const result = await hermesFetchJson(agent, `${base}${hermesRunsPath(agent)}`, "POST", runBody);
        return jsonResponse(result);
      }

      if (action === "run_get") {
        const runId = hermesRunId(body);
        if (!runId) return jsonResponse({ error: "run_id مطلوب" }, 400);
        const result = await hermesFetchJson(agent, `${base}${hermesRunsPath(agent)}/${encodeURIComponent(runId)}`, "GET");
        return jsonResponse(result);
      }

      if (action === "run_events") {
        const runId = hermesRunId(body);
        if (!runId) return jsonResponse({ error: "run_id مطلوب" }, 400);
        // نقرأ SSE لمدة collect_ms (افتراضي 5000، مقصوص عند timeout_ms)
        // ثم نُجهض ونعيد النص الخام مع الحمولات المفسَّرة.
        const streamed = await hermesFetchSse(
          agent,
          `${base}${hermesRunsPath(agent)}/${encodeURIComponent(runId)}/events`,
          hermesCollectMs(body),
          "GET"
        );
        if (!streamed.ok) return jsonResponse(streamed);
        return jsonResponse({ ok: true, data: { events_text: streamed.raw, events: parseSseDataPayloads(streamed.raw) } });
      }

      // run_stop
      const runId = hermesRunId(body);
      if (!runId) return jsonResponse({ error: "run_id مطلوب" }, 400);
      const result = await hermesFetchJson(agent, `${base}${hermesRunsPath(agent)}/${encodeURIComponent(runId)}/stop`, "POST", {});
      return jsonResponse(result);
    }

    // ---------- Hermes: start / stop / restart (بلا POST /control) ----------
    // start/restart: فحص /health فقط — نجاحه = running مع heartbeat الآن،
    // وفشله = error مع last_error. stop: تحديث قاعدة بيانات فقط إلى stopped،
    // بلا أي نداء HTTP (لا يوجد إيقاف على مستوى الوكيل؛ التشغيلات تُوقَف عبر run_stop).
    if (action === "start" || action === "stop" || action === "restart") {
      if (agent.type === "hermes") {
        if (action === "stop") {
          await adminClient.from("ai_agents").update({ status: "stopped", last_error: null }).eq("id", id);
          return jsonResponse({ ok: true, data: { status: "stopped" } });
        }
        await adminClient.from("ai_agents").update({ status: action === "restart" ? "restarting" : "starting" }).eq("id", id);
        const result = await callAgent(agent, "status");
        if (result.ok) {
          await adminClient.from("ai_agents").update({ status: "running", last_heartbeat: new Date().toISOString(), last_error: null }).eq("id", id);
        } else {
          await adminClient.from("ai_agents").update({ status: "error", last_error: result.error as string }).eq("id", id);
        }
        return jsonResponse(result);
      }
    }

    // start / stop / restart (غير Hermes: POST /control كما كان)
    await adminClient.from("ai_agents").update({ status: action === "stop" ? "stopping" : action === "restart" ? "restarting" : "starting" }).eq("id", id);
    const result = await callAgent(agent, "control", { command: action });
    const newStatus = result.ok ? (action === "stop" ? "stopped" : "running") : "error";
    await adminClient
      .from("ai_agents")
      .update({ status: newStatus, last_error: result.ok ? null : (result.error as string) })
      .eq("id", id);

    return jsonResponse(result);
  } catch (err) {
    console.error("Unexpected error:", err);
    return jsonResponse({ error: "حدث خطأ غير متوقع" }, 500);
  }
});
