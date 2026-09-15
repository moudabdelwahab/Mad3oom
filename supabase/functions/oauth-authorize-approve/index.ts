import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
// v2: إضافة subscriptions:* وnotifications:* للقائمة المسموحة - نفس
// القائمة المضافة في create-api-token/index.ts وoauth-discovery/index.ts.
const ALLOWED_SCOPES = [
  "tickets:read", "tickets:write", "tickets:delete",
  "knowledge_base:read", "knowledge_base:write",
  "customers:read", "customers:write",
  "whatsapp:read", "whatsapp:send",
  "analytics:read", "settings:manage", "oauth:manage", "mcp:connect", "chatbot:read", "admin:full",
  "subscriptions:read", "subscriptions:write", "subscriptions:renew", "subscriptions:cancel", "subscriptions:plans",
  "notifications:read", "notifications:send", "notifications:manage",
];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
}
function randomBase62(n: number) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  let o = "";
  for (let i = 0; i < n; i++) o += chars[b[i] % chars.length];
  return o;
}
async function sha256Hex(input: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Unauthorized" }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData?.user) return json({ error: "Unauthorized" }, 401);
  const userId = userData.user.id;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const { action, client_id, redirect_uri, scope, state, code_challenge, code_challenge_method } = body;

  if (!client_id || !redirect_uri) return json({ error: "بيانات ناقصة" }, 400);

  const admin = createClient(supabaseUrl, serviceRoleKey);
  const { data: client } = await admin
    .from("oauth_clients")
    .select("client_id, redirect_uris, client_name, is_active")
    .eq("client_id", client_id)
    .maybeSingle();

  if (!client || !client.is_active) return json({ error: "invalid_client" }, 400);
  if (!Array.isArray(client.redirect_uris) || !client.redirect_uris.includes(redirect_uri)) {
    return json({ error: "invalid_redirect_uri" }, 400);
  }

  const requestedScopes = (scope || "").split(/\s+/).filter(Boolean);
  const validScopes = requestedScopes.filter((s: string) => ALLOWED_SCOPES.includes(s));

  if (action === "info") {
    return json({ client_name: client.client_name, scopes: validScopes });
  }

  if (action === "deny") {
    const denyUrl = new URL(redirect_uri);
    denyUrl.searchParams.set("error", "access_denied");
    if (state) denyUrl.searchParams.set("state", state);
    return json({ redirect_to: denyUrl.toString() });
  }

  if (action === "approve") {
    if (!code_challenge) return json({ error: "code_challenge مطلوب" }, 400);
    if (!validScopes.length) return json({ error: "invalid_scope" }, 400);

    const code = `mad3oom_ac_${randomBase62(48)}`;
    const codeHash = await sha256Hex(code);

    const { error: insertErr } = await admin.from("oauth_authorization_codes").insert({
      code_hash: codeHash,
      client_id,
      user_id: userId,
      redirect_uri,
      scope: validScopes.join(" "),
      code_challenge,
      code_challenge_method: code_challenge_method || "S256",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    if (insertErr) return json({ error: "server_error" }, 500);

    const redirectUrl = new URL(redirect_uri);
    redirectUrl.searchParams.set("code", code);
    if (state) redirectUrl.searchParams.set("state", state);
    return json({ redirect_to: redirectUrl.toString() });
  }

  return json({ error: "invalid_action" }, 400);
});
