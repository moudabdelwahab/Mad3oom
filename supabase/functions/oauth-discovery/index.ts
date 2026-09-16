import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

// ── Public origin ────────────────────────────────────────────────────────────
// The domain is migrating mad3oom.online → mad3oom.com. Reading it from one
// environment variable, with the CURRENT value as the default, makes deploying
// this file a strict no-op: behaviour only changes when PUBLIC_SITE_ORIGIN is
// set. The cutover is then one variable across every OAuth function, flipped
// together, instead of four separate code deploys racing each other.
//
// This value is the OAuth issuer identity. Do not flip it independently of
// oauth-discovery, oauth-protected-resource, oauth-authorize, mcp-oauth-callback
// and mcp — see docs/MCP-CANONICAL-CUTOVER.md.
//
// CUTOVER 2026-09-16: the default is now the canonical domain. Before this, the
// default was mad3oom.online and every POST in the OAuth chain was dead: the
// advertised .online host 301s to .com, and per the Fetch spec a 301 turns a
// POST into a GET, so dynamic client registration answered 405 "Only POST is
// supported" to a request that WAS a POST. Rollback is this same variable set
// back to https://mad3oom.online — no redeploy needed.
const PUBLIC_SITE_ORIGIN = Deno.env.get("PUBLIC_SITE_ORIGIN") ?? "https://mad3oom.com";

// v2: إضافة subscriptions:* وnotifications:* - نفس القائمة المضافة في
// create-api-token/index.ts وoauth-authorize-approve/index.ts.
const ALLOWED_SCOPES = [
  "tickets:read", "tickets:write", "tickets:delete",
  "knowledge_base:read", "knowledge_base:write",
  "customers:read", "customers:write",
  "whatsapp:read", "whatsapp:send",
  "analytics:read", "settings:manage", "oauth:manage", "mcp:connect", "chatbot:read", "admin:full",
  "subscriptions:read", "subscriptions:write", "subscriptions:renew", "subscriptions:cancel", "subscriptions:plans",
  "notifications:read", "notifications:send", "notifications:manage",
];

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  const issuer = PUBLIC_SITE_ORIGIN;

  const metadata = {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    scopes_supported: ALLOWED_SCOPES,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    service_documentation: issuer,
  };

  return new Response(JSON.stringify(metadata), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600", ...CORS_HEADERS },
  });
});
