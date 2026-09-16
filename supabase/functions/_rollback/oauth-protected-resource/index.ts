import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

// RFC 9728 - OAuth 2.0 Protected Resource Metadata
// يصف mcp/index.ts بالضبط كما هو حاليًا - لا يعدّل أي منطق مصادقة،
// فقط يعلن أين يمكن للعميل إيجاد authorization server.
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  // resource يطابق بالضبط MCP_ENDPOINT_URL الموجود فعليًا في mcp-service.js
  // (${supabase.supabaseUrl}/functions/v1/mcp) - هو العنوان الفعلي الذي تصل بيه العملاء حاليًا.
  const resource = `${Deno.env.get("SUPABASE_URL")!}/functions/v1/mcp`;

  const metadata = {
    resource,
    authorization_servers: ["https://mad3oom.online"],
    bearer_methods_supported: ["header"],
    resource_documentation: "https://mad3oom.online",
  };

  return new Response(JSON.stringify(metadata), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600", ...CORS_HEADERS },
  });
});
