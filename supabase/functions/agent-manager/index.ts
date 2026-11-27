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
//   metrics          — مقاييس الكرت: Hermes (/health/detailed + /api/jobs
//     + /api/sessions) + Northflank (CPU/RAM/uptime من API — توكن قراءة
//     فقط مخزَّن مشفَّرًا في ai_agents.northflank_token_encrypted)؛
//     فشل أي مصدر لا يُسقط الآخر ولا يرمي الصفحة أبدًا.
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
//     الافتراضي model "hermes-agent" بلا provider — مؤكد حيًا 2026-11-27
//     (Mahmoud اختبره بالمفتاح: رد حقيقي، والإعداد يبقى بعد إعادة التشغيل)
//     بعد إصلاح النموذج الافتراضي على الخادم. أي قيمة مرسَلة تمرّ بلا مساس،
//     والتجاوز بإرسال "model" و"provider" معًا ما زال متاحًا (مثال الزوج
//     "nvidia/nemotron-3-ultra-550b-a55b" مع provider "nvidia").
//     باقي الحقول (model_options وstream وmessages) تُمرَّر بلا أي تعديل.
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
// northflank_token_last4 وحدها مسموحة؛ northflank_token_encrypted لا يظهر
// في أي استجابة أبدًا — نفس قاعدة api_key_encrypted.
const PUBLIC_COLUMNS = `
  id, name, slug, description, type, version, status, enabled, auto_start, auto_restart,
  connection_type, protocol, host, port, endpoint, health_endpoint, api_key_last4,
  northflank_token_last4,
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
// القواعد:
//   أ. لا model ولا provider (مفقود/فارغ بعد التقليم) → model "hermes-agent"
//      بلا provider — النموذج الافتراضي للخادم أُصلح، وإرسال "hermes-agent"
//      وحدها يعمل (مؤكد حيًا 2026-11-27: رد حقيقي بالمفتاح، يبقى بعد إعادة
//      التشغيل). provider الفارغ في هذه الحالة يُحذف من النسخة فلا يُرسَل.
//   ب. أي قيمة مرسَلة (model وحده، أو provider وحده، أو model + provider
//      معًا، بما فيها "hermes-agent" نفسها) تمرّ بلا أي مساس.
//   ج. أي حقل آخر (model_options وstream وmessages...) بلا أي مساس،
//      والدخل نفسه لا يُعدَّل — تُعاد نسخة جديدة.
export function applyHermesModelDefaults(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };
  const model = typeof out.model === "string" ? out.model.trim() : "";
  const provider = typeof out.provider === "string" ? out.provider.trim() : "";
  if (!model && !provider) {
    out.model = "hermes-agent";
    delete out.provider;
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

// ---------- مقاييس الكروت (Hermes + Northflank) ----------
// دوال نقية ومُصدَّرة للاختبار (نفس نمط parseSseDataPayloads و
// applyHermesModelDefaults: تُستخرج من هذا الملف وتُنفَّذ في Node).
// ملاحظة للاختبار: أجسام الدوال بلا أي صياغة TypeScript عدا تعليقات النوع
// البسيطة حتى يبقى تجريدها آليًا. كل قراءة لحقل خارجي دفاعية: حقل مفقود
// أو بشكل غير متوقع يتدهور لقيمة محايدة (null أو 0) ولا يرمي أبدًا.

// يعيد الكائن نفسه لو كان كائنًا غير مصفوفة، وإلا كائنًا فارغًا.
export function plainObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

// قائمة Hermes/Northflank: تقبل مصفوفة مباشرة أو غلافًا فيه مصفوفة تحت
// أحد المفاتيح {items|jobs|sessions|containers|data}؛ أي شكل آخر → [].
export function hermesListItems(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  const obj = plainObj(data);
  for (const key of ["items", "jobs", "sessions", "containers", "data"]) {
    const v = obj[key];
    if (Array.isArray(v)) return v;
  }
  return [];
}

// مجاميع الجلسات: العدد + مجموع message_count وtool_call_count (?? 0).
export function hermesSessionTotals(sessions: unknown): { count: number; messages: number; tool_calls: number } {
  const list = hermesListItems(sessions);
  let messages = 0;
  let toolCalls = 0;
  for (const s of list) {
    const row = plainObj(s);
    messages += typeof row.message_count === "number" ? row.message_count : 0;
    toolCalls += typeof row.tool_call_count === "number" ? row.tool_call_count : 0;
  }
  return { count: list.length, messages, tool_calls: toolCalls };
}

// يطبّع /health/detailed + /api/jobs + /api/sessions في شكل hermes الموحّد.
// health/jobs/sessions: بيانات كل مصدر كما عادت (أو null عند فشله)؛
// available تعني نجاح /health/detailed وحدها، وباقي الحقول تتدهور
// لقيم محايدة (null للحقول غير اليومية، 0 لعدّادات اليوم).
export function normalizeHermesMetrics(health: unknown, jobs: unknown, sessions: unknown): Record<string, unknown> {
  const h = plainObj(health);
  const today = plainObj(h.metrics_today);
  const apiServer = plainObj(h.api_server);
  const totals = hermesSessionTotals(sessions);
  const num = (v: unknown, fallback: number | null): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return {
    available: health !== null && health !== undefined && typeof health === "object" && !Array.isArray(health),
    status: typeof h.status === "string" ? h.status : null,
    version: typeof h.version === "string" ? h.version : null,
    gateway_state: typeof h.gateway_state === "string" ? h.gateway_state : null,
    active_agents: num(h.active_agents, null),
    active_runs: num(apiServer.active_runs, null),
    stored_runs: num(apiServer.stored_runs, null),
    jobs_count: hermesListItems(jobs).length,
    sessions_count: totals.count,
    sessions_messages: totals.messages,
    sessions_tool_calls: totals.tool_calls,
    requests_today: num(today.requests, 0),
    messages_today: num(today.messages, 0),
    tokens_today: num(today.tokens, 0),
    latency_p95_ms: num(today.latency_p95_ms, null),
  };
}

// حدود خدمة Hermes على Northflank (Sandbox): 512MB ذاكرة و0.2 vCPU —
// منها تُشتق memory_mb وcpu_vcpu من النسب المئوية. لو تغيّرت خطة الخدمة
// يُحدَّث هذان الثابتان هنا فقط.
const NORTHFLANK_MEMORY_LIMIT_MB = 512;
const NORTHFLANK_CPU_LIMIT_VCPU = 0.2;

// يحوّل نسب Northflank المئوية إلى قيم مطلقة: memory_mb = pct × 512 / 100
// وcpu_vcpu = pct × 0.2 / 100. أي نسبة غير رقمية → null (لا تخمين).
export function northflankDerivedMetrics(cpuPct: unknown, memPct: unknown): Record<string, unknown> {
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const cpu = num(cpuPct);
  const mem = num(memPct);
  return {
    cpu_percent: cpu,
    memory_percent: mem,
    memory_mb: mem === null ? null : (mem * NORTHFLANK_MEMORY_LIMIT_MB) / 100,
    cpu_vcpu: cpu === null ? null : (cpu * NORTHFLANK_CPU_LIMIT_VCPU) / 100,
  };
}

// يقرأ قيمة سلسلة مقياس واحدة: {metricUnit:"pct", values[0].data[0].value}.
// أي شكل مختلف → null.
export function northflankMetricValue(series: unknown): number | null {
  const obj = plainObj(series);
  const values = obj.values;
  if (!Array.isArray(values) || values.length === 0) return null;
  const first = plainObj(values[0]);
  const data = first.data;
  if (!Array.isArray(data) || data.length === 0) return null;
  const point = plainObj(data[0]);
  return typeof point.value === "number" && Number.isFinite(point.value) ? point.value : null;
}

// يفسّر استجابة GET /metrics: تقبل الشكلين المتداولين — كائن فيه cpu/memory
// مباشرةً، أو مصفوفة/كائن metrics فيه سلسلة لكل نوع (تُطابَق بـ type أو
// metricType أو name) — ويعيد نسبتي cpu وmemory. أي سلسلة بلا قيمة رقمية
// صالحة → null لذلك النوع فقط.
export function northflankMetricsValues(payload: unknown): { cpu: number | null; memory: number | null } {
  const out: { cpu: number | null; memory: number | null } = { cpu: null, memory: null };
  if (Array.isArray(payload)) {
    for (const entry of payload) {
      const row = plainObj(entry);
      const kind = typeof row.type === "string" ? row.type : typeof row.metricType === "string" ? row.metricType : typeof row.name === "string" ? row.name : "";
      if (kind === "cpu") out.cpu = northflankMetricValue(entry);
      else if (kind === "memory") out.memory = northflankMetricValue(entry);
    }
    return out;
  }
  const obj = plainObj(payload);
  if ("cpu" in obj || "memory" in obj) {
    out.cpu = northflankMetricValue(obj.cpu);
    out.memory = northflankMetricValue(obj.memory);
    return out;
  }
  const nested = obj.metrics;
  if (Array.isArray(nested)) return northflankMetricsValues(nested);
  return out;
}

// مدة تشغيل الخدمة: createdAt لأقدم حاوية بحالة TASK_RUNNING إلى الآن
// (بالثواني). حاويات TASK_KILLED أقدم تُتجاهل؛ بلا حاوية جارية → null.
// createdAt يقبل ISO نصًا، أو epoch بالثواني، أو epoch بالمللي ثانية.
export function northflankUptimeSeconds(containers: unknown, nowSeconds: number): number | null {
  const list = hermesListItems(containers);
  let oldest: number | null = null;
  for (const c of list) {
    const pod = plainObj(c);
    if (pod.state !== "TASK_RUNNING") continue;
    const created = pod.createdAt;
    let ts = NaN;
    if (typeof created === "number") ts = created > 1e12 ? Math.floor(created / 1000) : Math.floor(created);
    else if (typeof created === "string") ts = Math.floor(new Date(created).getTime() / 1000);
    if (!Number.isFinite(ts)) continue;
    if (oldest === null || ts < oldest) oldest = ts;
  }
  if (oldest === null) return null;
  const uptime = nowSeconds - oldest;
  return uptime >= 0 ? uptime : null;
}

// حالة الخدمة: subset صغير دفاعي من GET {base} — الاسم والحالة فقط،
// وكلاهما null لو غابا (شكل الاستجابة الكامل غير موثَّق هنا، فلا اختراع حقول).
export function northflankServiceStatus(service: unknown): Record<string, unknown> {
  const s = plainObj(service);
  return {
    name: typeof s.name === "string" ? s.name : (typeof s.slug === "string" ? s.slug : null),
    status: typeof s.status === "string" ? s.status : null,
  };
}

// يجمع مصادر Northflank الثلاثة في بلوك northflank الكامل (configured:true).
// أي مصدر null → حقوله null؛ لا يرمي أبدًا.
export function normalizeNorthflankMetrics(metrics: unknown, containers: unknown, service: unknown, nowSeconds: number): Record<string, unknown> {
  const values = northflankMetricsValues(metrics);
  const derived = northflankDerivedMetrics(values.cpu, values.memory);
  return {
    configured: true,
    cpu_percent: derived.cpu_percent,
    memory_percent: derived.memory_percent,
    memory_mb: derived.memory_mb,
    cpu_vcpu: derived.cpu_vcpu,
    uptime_seconds: northflankUptimeSeconds(containers, nowSeconds),
    service_status: northflankServiceStatus(service),
  };
}

// بلوك Northflank قبل التوصيل: غير مهيأ وكل القيم null.
// عند توصيل Northflank لاحقًا تُملأ هذه الحقول من إجراء metrics فقط:
// cpu_percent وmemory_percent وmemory_mb وcpu_vcpu وuptime_seconds
// وservice_status — تغيير محصور في هذا الإجراء ولا يمسّ أي كود آخر.
export function northflankPlaceholder(): Record<string, unknown> {
  return {
    configured: false,
    cpu_percent: null,
    memory_percent: null,
    memory_mb: null,
    cpu_vcpu: null,
    uptime_seconds: null,
    service_status: null,
  };
}

// بلوك خطأ Northflank: التوكن مهيأ لكن القراءة فشلت (توكن خاطئ، 4xx/5xx،
// مهلة). بيانات Hermes في نفس الاستجابة تبقى سليمة — الفشل معزول.
export function northflankError(): Record<string, unknown> {
  return { ...northflankPlaceholder(), configured: true, error: "تعذر قراءة مقاييس Northflank" };
}

// حمولة "غير متاح" الموحّدة لإجراء metrics: لا hermes ولا northflank،
// والسبب رمز قصير (no_key | not_hermes | fetch_failed).
export function unavailableMetricsPayload(reason: string): Record<string, unknown> {
  return {
    ok: false,
    available: false,
    reason,
    hermes: null,
    northflank: northflankPlaceholder(),
  };
}

// ---------- Northflank ----------
// قاعدة خدمة الوكيل: slug الوكيل هو اسم الخدمة على Northflank (افتراض
// موثَّق — خدمة Hermes اسمها hermes-agent، نفس slug الوكيل). بلا slug
// لا قاعدة ولا نداء.
// التوكن يُفك تشفيره هنا فقط (نفس نمط hermesApiKey)، ولا يخرج في أي
// استجابة أبدًا — ولا حتى في رسائل الخطأ.
function northflankBase(agent: Record<string, unknown>): string {
  const slug = ((agent.slug as string) || "").trim();
  return slug ? `https://api.northflank.com/v1/projects/default/services/${encodeURIComponent(slug)}` : "";
}

async function northflankApiKey(agent: Record<string, unknown>): Promise<string | undefined> {
  if (!agent.northflank_token_encrypted) return undefined;
  try {
    return await decryptText(agent.northflank_token_encrypted as string);
  } catch {
    return undefined;
  }
}

// نداء JSON عام لـ Northflank (Bearer دائمًا على كل المسارات)؛ يعيد
// {ok, data} أو خطأ موحّدًا — بلا أي أثر للتوكن في الخطأ.
async function northflankFetchJson(token: string, url: string, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    const text = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    if (!res.ok) return { ok: false, error: `Northflank رد بخطأ (${res.status})`, data };
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: "تعذّر الوصول إلى Northflank: " + (err instanceof Error ? err.message : String(err)) };
  } finally {
    clearTimeout(timer);
  }
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
    const VALID_ACTIONS = ["list", "get", "create", "update", "delete", "start", "stop", "restart", "status", "logs", "test_connection", "metrics", "chat", "run_create", "run_get", "run_events", "run_stop"];
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

      // توكن Northflank (قراءة فقط): نفس نمط api_key حرفيًا — تشفير
      // بـ AI_AGENTS_ENC_KEY + آخر 4 خانات للعرض المقنَّع فقط.
      if (body.northflank_token) {
        insertRow.northflank_token_encrypted = await encryptText(body.northflank_token);
        insertRow.northflank_token_last4 = String(body.northflank_token).slice(-4);
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
      // توكن Northflank: نفس نمط api_key — يُرسَل فقط عند تغييره من
      // النموذج (الحقل لا يُعاد تعبئته عند الفتح)، فيُحفَظ القديم دونه.
      if (body.northflank_token) {
        updateRow.northflank_token_encrypted = await encryptText(body.northflank_token);
        updateRow.northflank_token_last4 = String(body.northflank_token).slice(-4);
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

    // ---------- metrics (مقاييس الكرت: Hermes + Northflank) ----------
    // خادم فقط، ولا شيء يُخزَّن. Hermes أولًا: /health/detailed + /api/jobs
    // + /api/sessions بالتوازي (Promise.allSettled)، كل مصدر معزول عن
    // الآخر — فشل مصدر واحد لا يُسقط الباقي، وفشلها كلها مع غياب Northflank
    // يرجع fetch_failed. ثم Northflank فقط لو توكن مخزَّن: /metrics (cpu +
    // memory فقط) + /containers + GET الخدمة، بالتوازي كذلك — وأي فشل فيها
    // يرجع بلوك error معزولًا وتبقى بيانات Hermes سليمة (والعكس صحيح).
    // التوكن لا يظهر في أي استجابة أبدًا — لا مشفَّرًا ولا صريحًا ولا في
    // رسائل الخطأ. الاستجابة الناجحة:
    //   { ok:true, agent_id, hermes:{available,status,version,gateway_state,
    //     active_agents,active_runs,stored_runs,jobs_count,sessions_count,
    //     sessions_messages,sessions_tool_calls,requests_today,messages_today,
    //     tokens_today,latency_p95_ms},
    //     northflank:{configured,cpu_percent,memory_percent,memory_mb,
    //     cpu_vcpu,uptime_seconds,service_status,error?} }
    // وغير المتاح: { ok:false, available:false, reason, hermes:null,
    //   northflank:{configured:false, ...nulls} }.
    if (action === "metrics") {
      const base = hermesBase(agent);
      const apiKey = await hermesApiKey(agent);
      if (agent.type !== "hermes" && !base) return jsonResponse(unavailableMetricsPayload("not_hermes"));
      if (!apiKey) return jsonResponse(unavailableMetricsPayload("no_key"));

      // كل نداء آمن بذاته (try/catch داخلي) + معزول بـ allSettled.
      const safeCall = async (fn: () => Promise<{ ok: boolean; data?: unknown }>): Promise<{ ok: boolean; data: unknown | null }> => {
        try {
          const res = await fn();
          return { ok: !!res.ok, data: res.ok ? (res.data ?? null) : null };
        } catch {
          return { ok: false, data: null };
        }
      };
      const settledOk = (r: PromiseSettledResult<{ ok: boolean; data: unknown | null }>): boolean =>
        r.status === "fulfilled" && r.value.ok;
      const settledData = (r: PromiseSettledResult<{ ok: boolean; data: unknown | null }>): unknown =>
        r.status === "fulfilled" ? r.value.data : null;

      // Hermes — الثلاثة بالتوازي. المسارات في مصفوفة حتى لا يُبنى أي
      // نداء لحساب /api/sessions/{id}/chat (مسار موثَّق بلا عميل — انظر
      // تعليق الرأس): هذه الثلاثة فقط هي ما يُنادى.
      const hermesPaths = ["/health/detailed", "/api/jobs", "/api/sessions"];
      const [healthRes, jobsRes, sessionsRes] = await Promise.allSettled(
        hermesPaths.map((p) => safeCall(() => hermesFetchJson(agent, `${base}${p}`, "GET")))
      );
      const hermesOkCount = [healthRes, jobsRes, sessionsRes].filter(settledOk).length;
      const hermes = normalizeHermesMetrics(settledData(healthRes), settledData(jobsRes), settledData(sessionsRes));

      // Northflank — فقط لو توكن مخزَّن؛ بلا توكن يبقى بلوك configured:false.
      let northflank: Record<string, unknown> = northflankPlaceholder();
      let northflankOk = false;
      const nfToken = await northflankApiKey(agent);
      if (nfToken) {
        const nfBase = northflankBase(agent);
        if (nfBase) {
          const timeoutMs = (agent.timeout_ms as number) || 10000;
          const [mRes, cRes, sRes] = await Promise.allSettled([
            safeCall(() => northflankFetchJson(nfToken, `${nfBase}/metrics?queryType=single&metricTypes=cpu&metricTypes=memory`, timeoutMs)),
            safeCall(() => northflankFetchJson(nfToken, `${nfBase}/containers`, timeoutMs)),
            safeCall(() => northflankFetchJson(nfToken, nfBase, timeoutMs)),
          ]);
          // أي فشل داخل Northflank → بلوك error معزول (بلا رمي وبلا مساس بـ Hermes).
          if (settledOk(mRes) && settledOk(cRes) && settledOk(sRes)) {
            northflank = normalizeNorthflankMetrics(
              settledData(mRes),
              settledData(cRes),
              settledData(sRes),
              Math.floor(Date.now() / 1000)
            );
            northflankOk = true;
          } else {
            northflank = northflankError();
          }
        }
      }

      // لا مصدر أعطى شيئًا إطلاقًا — غير متاح، لا رمي. بلوك northflank
      // المُعاد هنا هو الفعلي (placeholder بلا توكن، أو error عند فشله).
      if (hermesOkCount === 0 && !northflankOk) {
        return jsonResponse({ ok: false, available: false, reason: "fetch_failed", hermes: null, northflank });
      }
      return jsonResponse({ ok: true, agent_id: id, hermes, northflank });
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
