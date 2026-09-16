import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

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

  const issuer = "https://mad3oom.online";

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
    service_documentation: "https://mad3oom.online",
  };

  return new Response(JSON.stringify(metadata), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600", ...CORS_HEADERS },
  });
});
