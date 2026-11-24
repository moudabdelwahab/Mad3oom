// ============================================================
// verify-turnstile — التحقق من توكن Cloudflare Turnstile
// ------------------------------------------------------------
// صفحة تسجيل الدخول (login.html) تعرض ويدجت Turnstile بالمفتاح
// العام (turnstile-config.js)، وتستدعي هذه الدالة بالتوكن قبل
// signInWithPassword. التحقق لا يجري في المتصفح أبدًا: السرّ
// (TURNSTILE_SECRET_KEY) يُقرأ من بيئة الدالة فقط.
//
// السلوك:
//   - بلا توكن → 400 { success:false, error:"missing_token" }.
//   - بلا سرّ مضبوط في Supabase → 503
//     { success:false, error:"secret_not_configured" }.
//     الواجهة عندها تُكمل الدخول مع تنبيه ظاهر (fail-open مقصود
//     لخطأ الإعداد وحده)، حتى لا يُقفل الدخول على الجميع بسبب
//     سرّ غير مضبوط. أي فشل تحقق آخر يمنع الدخول.
//   - توكن صحيح → { success:true }.
//   - توكن خاطئ/مستهلك → { success:false, error-codes:[...] }
//     كما ترد من Cloudflare (مثال invalid-input-response).
//
// بلا أي استيراد (صفر اعتماديات) عمدًا: الدالة تُنفَّذ في اختبار
// Node مثل verify-2fa، وكل ما تلمسه (fetch, FormData,
// Deno.env, Deno.serve) موجود في Node 22 أصالةً.
//
// ملاحظة أمنية: سرّ الويدجت الحالي ظهر في تاريخ Git
// (H-08 في FULL_PROJECT_AUDIT.md) ولم يُدوَّر بعد — عند تدويره
// من لوحة Cloudflare يجب تحديث TURNSTILE_SECRET_KEY في Supabase
// في الجلسة نفسها، وإلا عاد التحقق بـ invalid-input-secret.
// ============================================================

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const FETCH_TIMEOUT_MS = 8000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return json({ success: false, error: "Method not allowed" }, 405);
  }

  const secret = Deno.env.get("TURNSTILE_SECRET_KEY");
  if (!secret) {
    return json({ success: false, error: "secret_not_configured" }, 503);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ success: false, error: "invalid_json" }, 400);
  }

  const token = typeof (body as { token?: unknown } | null)?.token === "string"
    ? ((body as { token: string }).token.trim())
    : "";
  if (!token) {
    return json({ success: false, error: "missing_token" }, 400);
  }

  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  const forwardedFor = req.headers.get("x-forwarded-for");
  const remoteIp = forwardedFor?.split(",")[0]?.trim();
  if (remoteIp) form.append("remoteip", remoteIp);

  let res: Response;
  try {
    res = await fetchWithTimeout(SITEVERIFY_URL, { method: "POST", body: form });
  } catch (err) {
    console.error("[verify-turnstile] siteverify fetch failed:", (err as Error).message);
    return json({ success: false, error: "verification_unavailable" }, 502);
  }

  let result: { success?: unknown; "error-codes"?: unknown };
  try {
    result = await res.json();
  } catch {
    return json({ success: false, error: "verification_unavailable" }, 502);
  }

  return json({
    success: result.success === true,
    "error-codes": Array.isArray(result["error-codes"]) ? result["error-codes"] : [],
  });
});
