import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { handleInbound, MAX_INBOUND_BYTES } from "../_shared/integrations/inbound.js";
import { readEnv, serviceRpc } from "../_shared/integrations/deno-deps.ts";

// ============================================================================
// integrations-inbound — ويب هوك ووكومرس وسلة، رجوع OAuth من سلة، وطلبات
// إضافة ووردبريس الموقَّعة. verify_jwt = false: لكل مسار مصادقته (inbound.js).
// ============================================================================

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  // المسار بعد اسم الدالة: /functions/v1/integrations-inbound/<...>
  const idx = url.pathname.indexOf("/integrations-inbound");
  const path = idx >= 0 ? url.pathname.slice(idx + "/integrations-inbound".length) || "/" : url.pathname;

  const declared = Number(req.headers.get("content-length") || "0");
  if (declared > MAX_INBOUND_BYTES) return new Response(JSON.stringify({ error: "too_large" }), { status: 413 });
  const rawBody = req.method === "GET" ? new Uint8Array() : new Uint8Array(await req.arrayBuffer());

  const result = await handleInbound({
    env: readEnv(),
    fetch: globalThis.fetch.bind(globalThis),
    now: () => Date.now(),
    svcRpc: serviceRpc(),
    logger: console,
  }, { method: req.method, path, headers: req.headers, rawBody, query: url.searchParams });

  if (result.status === 302 && result.redirect) {
    return new Response(null, { status: 302, headers: { Location: result.redirect, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  }
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
});
