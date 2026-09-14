// create-api-token — إصدار مفاتيح API.
//
// ════════════════════════════════════════════════════════════════════════════
// الثغرة التي يصلحها هذا الإصدار
// ════════════════════════════════════════════════════════════════════════════
// الإصدار المنشور (v5) يتحقق من الجلسة ثم **يُنشئ المفتاح لأي حساب مسجّل**:
//
//     const { data: userData } = await userClient.auth.getUser();
//     if (userError || !userData?.user) return 401;
//     const userId = userData.user.id;          // ← ولا فحص بعدها إطلاقًا
//
// ولا فحص لرتبة، ولا لعلاقة بشركة، ولا لاستحقاق. وقائمة ALLOWED_SCOPES تشمل
// admin:full و settings:manage و oauth:manage — أي أن **أي عميل** يقدر بنداء
// مباشر (curl) أن يصدر لنفسه مفتاحًا يحمل صلاحيات مشغّل المنصة. وإخفاء هذه
// الخيارات في لوحة الشركة لا يمنع ذلك بحال: الواجهة ليست حاجزًا.
//
// ════════════════════════════════════════════════════════════════════════════
// التفويض الآن: تُقرّره القاعدة بهوية المنادي، لا هذه الدالة
// ════════════════════════════════════════════════════════════════════════════
// نداء واحد ذرّي — api_token_issue_context() (الترحيل 036) — يعيد:
//
//     { allowed, scope_ceiling[], company_id, actor }
//
// وهو يجمع في القاعدة نفسها:
//     • طاقم منصة (is_platform_staff)                        → سقف كامل
//     • مدير شركة (is_company_admin: الدور **و** العلاقة)
//       مع استحقاق api_tokens فعّال (company_has_feature)     → سقف أضيق
//     • أي أحد آخر — ومنه company_user                        → ممنوع
//
// لا يُعاد بناء أي شرط هنا. إعادة بنائه في TypeScript كانت ستصنع نسخة ثانية
// من قاعدة الصلاحية تنحرف عن الأولى عند أول تعديل.
//
// سقف الصلاحيات **يُفرَض على الخادم**: أي صلاحية خارج scope_ceiling تُرفض،
// فلا يصدر حساب شركة مفتاحًا بـadmin:full مهما أرسل في الطلب.
//
// الهوية: user_id يأتي من الجلسة المتحقَّق منها وحدها. وأي معرّف في جسم
// الطلب (user_id / company_id / owner_id) يُتجاهَل صراحةً — ودوال البوابة
// نفسها بلا مُعامل هوية إطلاقًا، فلا سبيل لتوجيهها إلى حساب آخر.
//
// السرّ: يُعاد **مرة واحدة** في هذا الرد وحده. المخزَّن في القاعدة بصمة
// مشفَّرة (secret_hash / bearer_token_hash) لا القيمة، فلا الخادم نفسه يقدر
// على عرضه لاحقًا. ولا يُسجَّل في أي console.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

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

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomBase62(length: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < length; i++) out += chars[bytes[i] % chars.length];
  return out;
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// الافتراضيات محفوظة كما هي في الإصدار المنشور: تغييرها يمنح صلاحيات جديدة
// ضمنيًا لكل مفتاح يُنشأ بلا scopes صريحة.
const DEFAULT_SCOPES = ["tickets:read", "tickets:write", "whatsapp:send", "whatsapp:read", "chatbot:read"];

/** أقصى مدّة صلاحية مسموحة — مفتاح دائم لا يُدوَّر هو أطول نافذة تسريب ممكنة. */
const MAX_EXPIRY_DAYS = 730;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing Authorization header" }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData?.user) return jsonResponse({ error: "Unauthorized" }, 401);
    const userId = userData.user.id;

    // ── التفويض: نداء واحد ذرّي بهوية المنادي ─────────────────────────────
    const { data: context, error: contextError } = await userClient.rpc("api_token_issue_context");

    if (contextError || !context) {
      console.error("authorization context failed:", contextError?.message);
      return jsonResponse({ error: "تعذّر التحقق من صلاحيتك الآن. حاول مرة أخرى." }, 503);
    }

    if (context.allowed !== true) {
      // رسالة واحدة لكل أسباب الرفض عمدًا: التمييز بين «لست مديرًا» و«لا
      // استحقاق» يكشف حالة حساب الشركة لمن لا يملكه.
      return jsonResponse({
        error: "إصدار مفاتيح API متاح لمدير الشركة ضمن اشتراك يمنح ميزة api_tokens.",
      }, 403);
    }

    const scopeCeiling: string[] = Array.isArray(context.scope_ceiling) ? context.scope_ceiling : [];
    if (scopeCeiling.length === 0) {
      return jsonResponse({ error: "لا صلاحيات متاحة لحسابك لإصدار مفتاح." }, 403);
    }

    // ── المدخلات ──────────────────────────────────────────────────────────
    let body: {
      name?: string; description?: string; credential_type?: string;
      scopes?: string[]; expires_at?: string | null;
    };
    try { body = await req.json(); } catch { return jsonResponse({ error: "Invalid JSON body" }, 400); }

    const name = (body.name || "").trim();
    const description = (body.description || "").trim();
    const credentialType = body.credential_type || "api_key_secret";

    if (!name) return jsonResponse({ error: "الاسم مطلوب" }, 400);
    if (name.length > 80) return jsonResponse({ error: "الاسم طويل جدًا (الحد الأقصى 80 حرفًا)" }, 400);
    if (description.length > 200) return jsonResponse({ error: "الوصف طويل جدًا (الحد الأقصى 200 حرف)" }, 400);
    if (!["api_key_secret", "bearer", "both"].includes(credentialType)) {
      return jsonResponse({ error: "credential_type غير صالح" }, 400);
    }

    // ── سقف الصلاحيات مفروض على الخادم ────────────────────────────────────
    //
    // القائمة المرجعية هي scope_ceiling القادم من القاعدة، لا ثابت في هذا
    // الملف: حساب شركة لا يبلغ admin:full مهما أرسل، وطاقم المنصة يبلغها.
    let scopes = DEFAULT_SCOPES.filter((s) => scopeCeiling.includes(s));
    if (body.scopes !== undefined) {
      if (!Array.isArray(body.scopes)) {
        return jsonResponse({ error: "scopes يجب أن تكون مصفوفة" }, 400);
      }
      const beyond = body.scopes.filter((s) => !scopeCeiling.includes(s));
      if (beyond.length > 0) {
        return jsonResponse({
          error: `صلاحيات خارج ما يسمح به حسابك: ${beyond.join(", ")}`,
        }, 403);
      }
      scopes = body.scopes;
    }

    if (scopes.length === 0) {
      return jsonResponse({ error: "اختر صلاحية واحدة على الأقل" }, 400);
    }

    // ── تاريخ الانتهاء ────────────────────────────────────────────────────
    let expiresAt: string | null = null;
    if (body.expires_at) {
      const d = new Date(body.expires_at);
      if (isNaN(d.getTime())) return jsonResponse({ error: "expires_at غير صالح" }, 400);
      if (d.getTime() <= Date.now()) {
        return jsonResponse({ error: "تاريخ الانتهاء يجب أن يكون في المستقبل" }, 400);
      }
      if (d.getTime() > Date.now() + MAX_EXPIRY_DAYS * 86400000) {
        return jsonResponse({ error: `أقصى مدّة مسموحة ${MAX_EXPIRY_DAYS} يومًا` }, 400);
      }
      expiresAt = d.toISOString();
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey);
    const groupId = credentialType === "both" ? crypto.randomUUID() : null;

    async function insertApiKeySecretRow() {
      const apiKey = `mad3oom_pk_${randomHex(16)}`;
      const apiSecret = `mad3oom_sk_${randomBase62(40)}`;
      const secretHash = await sha256Hex(apiSecret);
      const { data, error } = await adminClient.from("api_tokens").insert({
        user_id: userId, name, description: description || null, scopes, expires_at: expiresAt,
        credential_type: "api_key_secret", credential_group_id: groupId,
        api_key: apiKey, secret_hash: secretHash, secret_last_four: apiSecret.slice(-4),
      }).select("id, name, description, api_key, is_active, created_at, scopes, expires_at, credential_type").single();
      if (error || !data) throw new Error("فشل إنشاء بيانات اعتماد API Key + Secret" + (error ? `: ${error.message}` : ""));
      return { token: data, secret: apiSecret };
    }

    async function insertBearerRow() {
      // قيم داخلية عشوائية بحتة: لا تُعرض ولا تُستخدم في المصادقة، غرضها
      // الوحيد الحفاظ على قيود NOT NULL بلا تغيير في الجدول.
      const internalApiKey = `mad3oom_ik_${randomHex(32)}`;
      const internalSecret = randomHex(32);
      const internalSecretHash = await sha256Hex(internalSecret);

      const bearerToken = `mad3oom_bt_${randomHex(32)}`;
      const bearerHash = await sha256Hex(bearerToken);

      const { data, error } = await adminClient.from("api_tokens").insert({
        user_id: userId, name, description: description || null, scopes, expires_at: expiresAt,
        credential_type: "bearer", credential_group_id: groupId,
        api_key: internalApiKey, secret_hash: internalSecretHash, secret_last_four: internalSecret.slice(-4),
        bearer_token_hash: bearerHash, bearer_last_four: bearerToken.slice(-4),
      }).select("id, name, description, is_active, created_at, scopes, expires_at, credential_type").single();
      if (error || !data) throw new Error("فشل إنشاء Bearer Token" + (error ? `: ${error.message}` : ""));
      return { token: data, secret: bearerToken };
    }

    if (credentialType === "api_key_secret") {
      const result = await insertApiKeySecretRow();
      return jsonResponse({ token: result.token, secret: result.secret });
    }

    if (credentialType === "bearer") {
      const result = await insertBearerRow();
      return jsonResponse({ token: result.token, bearer_token: result.secret });
    }

    const keySecretResult = await insertApiKeySecretRow();
    const bearerResult = await insertBearerRow();
    return jsonResponse({
      credential_group_id: groupId,
      api_key_secret: { token: keySecretResult.token, secret: keySecretResult.secret },
      bearer: { token: bearerResult.token, bearer_token: bearerResult.secret },
    });
  } catch (err) {
    // الرسالة وحدها — لا جسم الطلب ولا أي سرّ قد يكون تولّد قبل الفشل.
    console.error("Unexpected error:", (err as Error).message);
    return jsonResponse({ error: (err as Error).message || "حدث خطأ غير متوقع" }, 500);
  }
});
