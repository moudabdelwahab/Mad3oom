import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { checkRateLimit, clientIp } from "./_shared/rate-limit.ts";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const ACCESS_TOKEN_TTL_SECONDS = 3600;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", Pragma: "no-cache", ...CORS_HEADERS },
  });
}
function randomHex(n: number) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}
async function sha256Hex(input: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function sha256Base64Url(input: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return btoa(String.fromCharCode(...new Uint8Array(d))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function peekClientId(req: Request, params: URLSearchParams): string {
  const basicMatch = (req.headers.get("Authorization") || "").match(/^Basic\s+(.+)$/i);
  if (basicMatch) {
    try {
      const decoded = atob(basicMatch[1]);
      const idx = decoded.indexOf(":");
      if (idx !== -1) return decoded.slice(0, idx);
    } catch {
      /* ignore */
    }
  }
  return params.get("client_id") || "unknown";
}

async function verifyClient(admin: any, req: Request, params: URLSearchParams) {
  let clientId = params.get("client_id") || "";
  let clientSecret = params.get("client_secret") || "";

  const basicMatch = (req.headers.get("Authorization") || "").match(/^Basic\s+(.+)$/i);
  if (basicMatch) {
    try {
      const decoded = atob(basicMatch[1]);
      const idx = decoded.indexOf(":");
      if (idx !== -1) {
        clientId = decoded.slice(0, idx);
        clientSecret = decoded.slice(idx + 1);
      }
    } catch {
      /* ignore */
    }
  }
  if (!clientId) return { ok: false as const, error: "invalid_client", description: "client_id مطلوب" };

  const { data: client, error } = await admin
    .from("oauth_clients")
    .select("client_id, client_secret_hash, token_endpoint_auth_method, client_name, is_active")
    .eq("client_id", clientId)
    .maybeSingle();
  if (error || !client || !client.is_active) {
    return { ok: false as const, error: "invalid_client", description: "عميل غير معروف" };
  }

  if (client.token_endpoint_auth_method !== "none") {
    if (!clientSecret || !client.client_secret_hash) {
      return { ok: false as const, error: "invalid_client", description: "client_secret مطلوب" };
    }
    if (!timingSafeEqual(await sha256Hex(clientSecret), client.client_secret_hash)) {
      return { ok: false as const, error: "invalid_client", description: "client_secret غير صحيح" };
    }
  }
  return { ok: true as const, client };
}

async function issueTokenPair(admin: any, params: { userId: string; clientId: string; scope: string }) {
  const internalApiKey = `mad3oom_ik_${randomHex(32)}`;
  // يُفك هاشه فقط ويُرمى فورًا - لا يُعرض ولا يُستخدم في المصادقة.
  // نفس نمط create-api-token::insertBearerRow بالضبط (secret_hash يجي من هاش سر داخلي مؤقت).
  const internalSecret = randomHex(32);
  const internalSecretHash = await sha256Hex(internalSecret);

  const accessToken = `mad3oom_bt_${randomHex(32)}`;
  const accessTokenHash = await sha256Hex(accessToken);
  const expiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString();

  const { data: tokenRow, error: tokenErr } = await admin
    .from("api_tokens")
    .insert({
      user_id: params.userId,
      name: "OAuth (MCP)",
      description: `صادر تلقائيًا عبر OAuth 2.1 لصالح client_id=${params.clientId}`,
      scopes: params.scope.split(" ").filter(Boolean),
      credential_type: "bearer",
      api_key: internalApiKey,
      secret_hash: internalSecretHash,
      // secret_last_four عمود NOT NULL بدون default في api_tokens - نفس الاتفاقية
      // المستخدمة في create-api-token::insertApiKeySecretRow (آخر 4 خانات من السر الذي هاشه مخزّن في secret_hash).
      secret_last_four: internalSecret.slice(-4),
      bearer_token_hash: accessTokenHash,
      bearer_last_four: accessToken.slice(-4),
      expires_at: expiresAt,
    })
    .select("id")
    .single();
  if (tokenErr || !tokenRow) throw new Error("فشل إصدار access token" + (tokenErr ? ": " + tokenErr.message : ""));

  const refreshToken = `mad3oom_rt_${randomHex(32)}`;
  const { error: refreshErr } = await admin.from("oauth_refresh_tokens").insert({
    // عمود الجدول الفعلي اسمه token_hash وليس refresh_token_hash (كان هذا سبب فشل 500 الثاني
    // بعد نجاح إصلاح secret_last_four - PostgREST كان يرفض عمود غير موجود).
    token_hash: await sha256Hex(refreshToken),
    client_id: params.clientId,
    user_id: params.userId,
    api_token_id: tokenRow.id,
    scope: params.scope,
    expires_at: new Date(Date.now() + REFRESH_TOKEN_TTL_MS).toISOString(),
  });
  if (refreshErr) throw new Error("فشل إصدار refresh token" + (refreshErr ? ": " + refreshErr.message : ""));

  return { accessToken, refreshToken };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "invalid_request" }, 405);

  const contentType = req.headers.get("content-type") || "";
  const params = contentType.includes("application/json")
    ? new URLSearchParams(Object.entries(await req.json().catch(() => ({}))).map(([k, v]) => [k, String(v)]))
    : new URLSearchParams(await req.text());

  const grantType = params.get("grant_type");
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const ip = clientIp(req);
  const rawClientId = peekClientId(req, params);

  const ipGuard = await checkRateLimit(admin, "oauth-token:ip", ip, 40, 60);
  if (!ipGuard.ok) return json({ error: "slow_down", error_description: "طلبات كثيرة جدًا" }, 429);

  const perClient = await checkRateLimit(admin, "oauth-token:client-ip", `${rawClientId}:${ip}`, 15, 60);
  if (!perClient.ok) return json({ error: "slow_down", error_description: "طلبات كثيرة جدًا لهذا التطبيق" }, 429);

  const clientCheck = await verifyClient(admin, req, params);
  if (!clientCheck.ok) return json({ error: clientCheck.error, error_description: clientCheck.description }, 401);
  const client = clientCheck.client;

  if (grantType === "authorization_code") {
    const code = params.get("code");
    const redirectUri = params.get("redirect_uri");
    const codeVerifier = params.get("code_verifier");
    if (!code || !redirectUri || !codeVerifier) {
      return json({ error: "invalid_request", error_description: "code, redirect_uri, code_verifier مطلوبة" }, 400);
    }

    const { data: authCode, error } = await admin
      .from("oauth_authorization_codes")
      .select("*")
      .eq("code_hash", await sha256Hex(code))
      .maybeSingle();

    if (error || !authCode) return json({ error: "invalid_grant", error_description: "كود غير صالح" }, 400);
    if (authCode.used_at) return json({ error: "invalid_grant", error_description: "الكود مستخدم مسبقًا" }, 400);
    if (new Date(authCode.expires_at).getTime() < Date.now()) {
      return json({ error: "invalid_grant", error_description: "الكود منتهي" }, 400);
    }
    if (authCode.client_id !== client.client_id) {
      return json({ error: "invalid_grant", error_description: "client_id غير مطابق" }, 400);
    }
    if (authCode.redirect_uri !== redirectUri) {
      return json({ error: "invalid_grant", error_description: "redirect_uri غير مطابق" }, 400);
    }
    if (!timingSafeEqual(await sha256Base64Url(codeVerifier), authCode.code_challenge)) {
      return json({ error: "invalid_grant", error_description: "PKCE code_verifier غير صحيح" }, 400);
    }

    await admin.from("oauth_authorization_codes").update({ used_at: new Date().toISOString() }).eq("id", authCode.id);

    try {
      const tokens = await issueTokenPair(admin, { userId: authCode.user_id, clientId: client.client_id, scope: authCode.scope });
      return json({
        access_token: tokens.accessToken,
        token_type: "Bearer",
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
        refresh_token: tokens.refreshToken,
        scope: authCode.scope,
      });
    } catch (e) {
      return json({ error: "server_error", error_description: (e as Error).message }, 500);
    }
  }

  if (grantType === "refresh_token") {
    const refreshToken = params.get("refresh_token");
    if (!refreshToken) return json({ error: "invalid_request", error_description: "refresh_token مطلوب" }, 400);

    const { data: rtRow, error } = await admin
      .from("oauth_refresh_tokens")
      .select("*")
      .eq("token_hash", await sha256Hex(refreshToken))
      .maybeSingle();

    if (error || !rtRow) return json({ error: "invalid_grant", error_description: "refresh_token غير صالح" }, 400);
    if (rtRow.revoked_at) return json({ error: "invalid_grant", error_description: "refresh_token مُلغى" }, 400);
    if (new Date(rtRow.expires_at).getTime() < Date.now()) {
      return json({ error: "invalid_grant", error_description: "refresh_token منتهي الصلاحية - أعد ربط التطبيق" }, 400);
    }
    if (rtRow.client_id !== client.client_id) {
      return json({ error: "invalid_grant", error_description: "client_id غير مطابق" }, 400);
    }

    const requestedScope = params.get("scope");
    const scope = requestedScope && rtRow.scope.split(" ").includes(requestedScope) ? requestedScope : rtRow.scope;

    await admin.from("oauth_refresh_tokens").update({ revoked_at: new Date().toISOString() }).eq("id", rtRow.id);
    await admin.from("api_tokens").update({ is_active: false, revoked_at: new Date().toISOString() }).eq("id", rtRow.api_token_id);

    try {
      const tokens = await issueTokenPair(admin, { userId: rtRow.user_id, clientId: client.client_id, scope });
      return json({
        access_token: tokens.accessToken,
        token_type: "Bearer",
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
        refresh_token: tokens.refreshToken,
        scope,
      });
    } catch (e) {
      return json({ error: "server_error", error_description: (e as Error).message }, 500);
    }
  }

  return json({ error: "unsupported_grant_type" }, 400);
});
