// huggingface-chatbot — RETIRED 2026-09-18 (audit finding H-07)
//
// The previous version was an UNAUTHENTICATED public LLM proxy: verify_jwt was false
// and the body contained no identity check of any kind, so anyone on the internet could
// POST a message and have it forwarded to Hugging Face on the platform's
// HUGGINGFACE_API_KEY. Cost abuse and quota exhaustion, with no rate limit.
//
// Verified before retiring: ZERO references anywhere in the repository
// (html/js/ts/json/sql). Nothing calls this function.
//
// This replacement deliberately does NOTHING:
//   * it never reads HUGGINGFACE_API_KEY, so the key cannot be spent through it
//   * no database access, no outbound request
//   * verify_jwt is now true as well, so even the stub is not anonymously reachable
//   * every request is refused with 410 Gone
//
// Same shape as the ai-probe-temp and gemini-proxy retirement stubs in this project.
// Deleting the function from the Supabase dashboard is the remaining cleanup step;
// the cost/abuse exposure is already closed by this deployment.
//
// Original source archived at: supabase/functions/_retired/huggingface-chatbot/index.ts.retired

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve((req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  return new Response(
    JSON.stringify({
      error: "gone",
      message:
        "huggingface-chatbot has been retired: it was an unauthenticated proxy spending the platform's Hugging Face key. Use ai-gateway or generate-ai-chat-reply instead.",
    }),
    {
      status: 410,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
});
