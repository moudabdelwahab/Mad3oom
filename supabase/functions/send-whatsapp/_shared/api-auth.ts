// ============================================================
// verifyApiToken / requireScope (v2)
// ------------------------------------------------------------
// يدعم شكلين من المصادقة في نفس الوقت:
//  1) "Bearer <api_key>.<secret>" - السلوك القديم بالحرف (credential_type='api_key_secret').
//  2) "Bearer <token>" واحد (بدون نقطة) - credential_type='bearer'،
//     يُقارن hash التوكن كاملاً بـ bearer_token_hash مباشرة.
// يتحقق كمان من expires_at لو موجود. لا يفترض وجود أي عمود غير موجود.
// ============================================================
import { createClient } from "jsr:@supabase/supabase-js@2";
import { checkRateLimit, rateLimitHeaders } from "../../_shared/rate-limit.js";

export interface VerifiedToken {
  id: string;
  user_id: string;
  scopes: string[];
  name: string;
}

export type VerifyResult =
  | { ok: true; token: VerifiedToken }
  | { ok: false; status: number; error: string; headers?: Record<string, string> };

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const TOKEN_COLUMNS = "id, user_id, name, api_key, secret_hash, bearer_token_hash, is_active, revoked_at, scopes, expires_at, credential_type";

export async function verifyApiToken(req: Request, requestEndpoint: string): Promise<VerifyResult> {
  const authHeader = req.headers.get("Authorization") || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return { ok: false, status: 401, error: "Missing Authorization header" };

  const raw = match[1];
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceRoleKey);

  const dotIndex = raw.indexOf(".");
  let row: any = null;

  if (dotIndex !== -1) {
    // شكل api_key.secret القديم
    const apiKey = raw.slice(0, dotIndex);
    const secret = raw.slice(dotIndex + 1);
    if (!apiKey || !secret) return { ok: false, status: 401, error: "Malformed token" };

    const { data, error } = await admin.from("api_tokens").select(TOKEN_COLUMNS).eq("api_key", apiKey).maybeSingle();
    if (error || !data) return { ok: false, status: 401, error: "Invalid API key" };

    const computedHash = await sha256Hex(secret);
    if (!data.secret_hash || !timingSafeEqual(computedHash, data.secret_hash)) {
      return { ok: false, status: 401, error: "Invalid API secret" };
    }
    row = data;
  } else {
    // شكل Bearer token واحد
    const bearerHash = await sha256Hex(raw);
    const { data, error } = await admin.from("api_tokens").select(TOKEN_COLUMNS).eq("bearer_token_hash", bearerHash).maybeSingle();
    if (error || !data) return { ok: false, status: 401, error: "Invalid bearer token" };
    row = data;
  }

  if (!row.is_active || row.revoked_at) return { ok: false, status: 401, error: "Token is inactive or revoked" };
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    return { ok: false, status: 401, error: "Token has expired" };
  }

  // حدّ لكل توكن — بعد التحقق منه، فالموضوع معرّف موثوق لا قيمة من الطلب.
  // كان عدًّا لسجل الاستخدام خلال دقيقة: سباق بين الطلبات المتزامنة، والسجل
  // نفسه يُكتب لاحقًا بلا انتظار. الآن دلو ذرّي (سياسة api.token، 60/دقيقة).
  // يفشل مفتوحًا كما كان: التوكن موثَّق، والنطاقات والحصص تُفرض في أماكنها،
  // وتعطّل القاعدة لحظيًا لا يصح أن يوقف كل التكاملات. الفشل يُسجَّل.
  const rate = await checkRateLimit(admin, "api.token", row.id, { failClosed: false });
  if (!rate.allowed) {
    return { ok: false, status: 429, error: `Rate limit exceeded (${rate.limit} requests per ${rate.windowSeconds}s)`, headers: rateLimitHeaders(rate) };
  }

  const ip = req.headers.get("x-forwarded-for") || "";
  const ua = req.headers.get("user-agent") || "";

  admin.from("api_token_usage_logs").insert({
    token_id: row.id, user_id: row.user_id, endpoint: requestEndpoint, method: req.method,
    ip_address: ip, user_agent: ua,
  }).then(() => {}, () => {});
  admin.from("api_tokens").update({ last_used_at: new Date().toISOString(), last_used_ip: ip }).eq("id", row.id)
    .then(() => {}, () => {});

  return { ok: true, token: { id: row.id, user_id: row.user_id, scopes: row.scopes || [], name: row.name } };
}

export function requireScope(token: VerifiedToken, scope: string): { ok: false; status: number; error: string } | null {
  if (!token.scopes.includes(scope)) {
    return { ok: false, status: 403, error: `Missing required scope: ${scope}` };
  }
  return null;
}
