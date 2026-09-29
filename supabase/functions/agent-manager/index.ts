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

// نداء HTTP عام لأي وكيل (Agent Manager لا يعرف تفاصيل الوكيل، فقط ينفذ
// عقد اتصال موحّد: GET health_endpoint للحالة، POST endpoint/control للتحكم،
// GET endpoint/logs للسجلات). لو endpoint غير مُعد بعد، يرجع خطأ واضح
// بدلاً من الفشل الصامت — وهذا متوقع لأي وكيل لم يُربط بعد (مثل Hermes حالياً).
async function callAgent(
  agent: Record<string, unknown>,
  path: "control" | "status" | "logs",
  payload?: Record<string, unknown>
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

  try {
    const res = await fetch(url, {
      method: path === "status" ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
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
    const VALID_ACTIONS = ["list", "get", "create", "update", "delete", "start", "stop", "restart", "status", "logs", "test_connection"];
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
      const result = await callAgent(agent, "logs", { limit: body.limit ?? 200, level: body.level, search: body.search });
      return jsonResponse(result);
    }

    // start / stop / restart
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
