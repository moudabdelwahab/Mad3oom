import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { checkRateLimit, clientIp } from "./_shared/rate-limit.ts";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...extra },
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

async function logRegistration(
  admin: any,
  p: {
    clientId: string | null;
    clientName: string;
    redirectUris: string[];
    ip: string;
    userAgent: string;
    success: boolean;
    error?: string;
  },
) {
  admin
    .from("oauth_client_registrations_log")
    .insert({
      client_id: p.clientId,
      client_name: p.clientName,
      redirect_uris: p.redirectUris,
      ip_address: p.ip,
      user_agent: p.userAgent,
      success: p.success,
      error: p.error || null,
    })
    .then(() => {}, () => {});
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") {
    return json({ error: "invalid_request", error_description: "Only POST is supported" }, 405);
  }

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const ip = clientIp(req);
  const userAgent = req.headers.get("user-agent") || "";

  const rl = await checkRateLimit(admin, "oauth-register", ip, 5, 3600);
  if (!rl.ok) {
    return json(
      { error: "invalid_request", error_description: "محاولات تسجيل كثيرة جدًا - حاول لاحقًا" },
      429,
      { "Retry-After": String(rl.retryAfter) },
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_client_metadata" }, 400);
  }

  const clientName = String(body.client_name || "MCP Client").slice(0, 120);
  const redirectUris: string[] = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.filter((u: any) => typeof u === "string")
    : [];

  if (!redirectUris.length) {
    await logRegistration(admin, { clientId: null, clientName, redirectUris, ip, userAgent, success: false, error: "missing redirect_uris" });
    return json({ error: "invalid_redirect_uri", error_description: "redirect_uris مطلوبة" }, 400);
  }

  for (const u of redirectUris) {
    try {
      const parsed = new URL(u);
      if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
        await logRegistration(admin, { clientId: null, clientName, redirectUris, ip, userAgent, success: false, error: `non-https redirect_uri: ${u}` });
        return json({ error: "invalid_redirect_uri", error_description: `redirect_uri يجب أن يكون HTTPS: ${u}` }, 400);
      }
    } catch {
      await logRegistration(admin, { clientId: null, clientName, redirectUris, ip, userAgent, success: false, error: `malformed redirect_uri: ${u}` });
      return json({ error: "invalid_redirect_uri", error_description: `redirect_uri غير صالح: ${u}` }, 400);
    }
  }

  const authMethod = ["none", "client_secret_post", "client_secret_basic"].includes(body.token_endpoint_auth_method)
    ? body.token_endpoint_auth_method
    : "none";
  const grantTypes = Array.isArray(body.grant_types) && body.grant_types.length
    ? body.grant_types
    : ["authorization_code", "refresh_token"];
  const responseTypes = Array.isArray(body.response_types) && body.response_types.length
    ? body.response_types
    : ["code"];

  const clientId = `mad3oom_client_${randomHex(16)}`;
  let clientSecret: string | null = null;
  let clientSecretHash: string | null = null;
  if (authMethod !== "none") {
    clientSecret = `mad3oom_cs_${randomHex(32)}`;
    clientSecretHash = await sha256Hex(clientSecret);
  }

  const { error } = await admin.from("oauth_clients").insert({
    client_id: clientId,
    client_secret_hash: clientSecretHash,
    client_name: clientName,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: authMethod,
    grant_types: grantTypes,
    response_types: responseTypes,
    created_via: "dynamic_registration",
  });

  if (error) {
    await logRegistration(admin, { clientId, clientName, redirectUris, ip, userAgent, success: false, error: error.message });
    return json({ error: "server_error", error_description: "فشل تسجيل العميل" }, 500);
  }

  await logRegistration(admin, { clientId, clientName, redirectUris, ip, userAgent, success: true });

  const response: Record<string, unknown> = {
    client_id: clientId,
    client_name: clientName,
    redirect_uris: redirectUris,
    grant_types: grantTypes,
    response_types: responseTypes,
    token_endpoint_auth_method: authMethod,
    client_id_issued_at: Math.floor(Date.now() / 1000),
  };
  if (clientSecret) {
    response.client_secret = clientSecret;
    response.client_secret_expires_at = 0;
  }

  return json(response, 201);
});
