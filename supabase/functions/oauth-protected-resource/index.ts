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
// oauth-discovery, oauth-protected-resource, oauth-authorize and
// mcp-oauth-callback — see docs/DOMAIN-MIGRATION.md.
// CUTOVER 2026-09-16: default is now the canonical domain — see
// docs/MCP-CANONICAL-CUTOVER.md. Rollback: set PUBLIC_SITE_ORIGIN back to
// https://mad3oom.online (no redeploy needed).
const PUBLIC_SITE_ORIGIN = Deno.env.get("PUBLIC_SITE_ORIGIN") ?? "https://mad3oom.com";

// RFC 9728 - OAuth 2.0 Protected Resource Metadata
// يصف mcp/index.ts بالضبط كما هو حاليًا - لا يعدّل أي منطق مصادقة،
// فقط يعلن أين يمكن للعميل إيجاد authorization server.
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  // resource لازم يطابق العنوان الذي يتصل به العميل فعلًا، لا العنوان الداخلي.
  //
  // كان `${SUPABASE_URL}/functions/v1/mcp`، وهو العنوان الداخلي. لكن العميل
  // الخارجي يتصل بـ`${PUBLIC_SITE_ORIGIN}/mcp` (Vercel يعيد الكتابة إلى
  // Supabase بلا إعادة توجيه). و RFC 9728 §3.3 يُلزم العميل بالتحقق من تطابق
  // `resource` مع المورد الذي يصل إليه، فعميل صارم كان يرفض البيانات الوصفية
  // كلها عند هذا الاختلاف.
  //
  // تغييره آمن خادميًا بدليل لا بترجيح: لا يوجد أي ربط جمهور في السلسلة —
  // oauth-token لا يقرأ المعامل `resource` إطلاقًا، ولا وجود لـ`aud` في
  // mcp/_shared/api-auth.ts، والتوكنات غير شفّافة (mad3oom_bt_*) يُتحقَّق منها
  // بمطابقة SHA-256 في api_tokens. أي أن القيمة مُعلَنة لا مُتحقَّق منها.
  const resource = `${PUBLIC_SITE_ORIGIN}/mcp`;

  const metadata = {
    resource,
    authorization_servers: [PUBLIC_SITE_ORIGIN],
    bearer_methods_supported: ["header"],
    resource_documentation: PUBLIC_SITE_ORIGIN,
  };

  return new Response(JSON.stringify(metadata), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600", ...CORS_HEADERS },
  });
});
