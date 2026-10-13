import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { handleWorker } from "../_shared/integrations/worker.js";
import { readEnv, serviceRpc } from "../_shared/integrations/deno-deps.ts";

// ============================================================================
// integrations-worker — إعادة الأحداث الفاشلة وتجديد رموز سلة.
// verify_jwt = false + ترويسة x-ihub-worker-secret (worker.js). يُجدول بخطوة
// نشر موثقة (docs/integrations/PROD_INSTALL.md)، لا من 088.
// ============================================================================

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405 });
  const result = await handleWorker({
    env: readEnv(),
    fetch: globalThis.fetch.bind(globalThis),
    now: () => Date.now(),
    svcRpc: serviceRpc(),
    logger: console,
  }, req.headers);
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
});
