// gemini-proxy — RETIRED 2026-09-18 (audit finding C-07)
//
// The previous version (v46) read `userId` from the REQUEST BODY and then used a
// service_role client -- which bypasses RLS -- to read that user's profile name and
// their three most recent tickets, injecting the result into an LLM system prompt that
// was returned to the caller. There was no check that the body's userId matched the
// authenticated identity, so any signed-in account could read any other user's name and
// ticket metadata. A cross-tenant IDOR.
//
// This function has no callers: zero references across the entire repository
// (html/js/ts/sql/json). It is retired rather than silently left running.
//
// This replacement deliberately does NOTHING:
//   * no Supabase client, no service_role key, no database access of any kind
//   * no outbound LLM call, no API keys read from the environment
//   * every request is refused with 410 Gone
//
// Same shape as the existing `ai-probe-temp` retirement stub in this project.
//
// The function should still be DELETED from the Supabase dashboard
// (Edge Functions -> gemini-proxy -> Delete). That is cleanup; the vulnerability is
// already closed by this deployment.
//
// Original source archived at: supabase/functions/_retired/gemini-proxy/index.ts.retired

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
        "gemini-proxy has been retired for a security reason (cross-tenant read via a body-supplied userId). It no longer accesses any data. Use chat-bot-reply or generate-ai-chat-reply instead.",
    }),
    {
      status: 410,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
});
