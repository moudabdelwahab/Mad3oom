import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { handleApi } from "../_shared/integrations/api.js";
import { readEnv, rpcVia, serviceRpc, userClient } from "../_shared/integrations/deno-deps.ts";

// ============================================================================
// integrations-api — عمليات مركز التكاملات من لوحة الشركة.
// verify_jwt = true. التفويض في القاعدة (ihub_authorize*)؛ هنا ربط فقط.
// docs/integrations/ARCHITECTURE.md
// ============================================================================

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const MAX_BODY = 32 * 1024;

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS_HEADERS },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return reply(405, { error: "method_not_allowed" });

  const authHeader = req.headers.get("Authorization") || "";
  if (!/^Bearer\s+\S+$/i.test(authHeader)) return reply(401, { error: "unauthorized" });
  const client = userClient(authHeader);
  const { data: userData, error: userError } = await client.auth.getUser();
  if (userError || !userData?.user) return reply(401, { error: "unauthorized" });

  const raw = new Uint8Array(await req.arrayBuffer());
  if (raw.byteLength > MAX_BODY) return reply(413, { error: "too_large" });
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return reply(400, { error: "invalid_input" });
  }

  const result = await handleApi({
    env: readEnv(),
    fetch: globalThis.fetch.bind(globalThis),
    now: () => Date.now(),
    userRpc: rpcVia(client),
    svcRpc: serviceRpc(),
    logger: console,
  }, body);
  return reply(result.status, result.body);
});
