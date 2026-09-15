import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ============================================================
// mcp-oauth-start
// ------------------------------------------------------------
// أدمن فقط. يأخذ server_id، يتأكد من وجود اتصال auth_type='oauth2'
// له بيانات تطبيق (محفوظة مسبقًا عبر save-mcp-credentials)، يولّد
// state عشوائي ويرجع رابط التفويض الكامل. لا يقوم بأي Business Logic
// غير ذلك - مجرد تجهيز للتوجيه.
// ============================================================

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing Authorization header" }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData?.user) return jsonResponse({ error: "Unauthorized" }, 401);

    const { data: isAdminData, error: adminCheckError } = await userClient.rpc("is_admin");
    if (adminCheckError || !isAdminData) return jsonResponse({ error: "هذه العملية متاحة للأدمن فقط" }, 403);

    let body: { server_id?: string };
    try { body = await req.json(); } catch { return jsonResponse({ error: "Invalid JSON body" }, 400); }
    const serverId = (body.server_id || "").trim();
    if (!serverId) return jsonResponse({ error: "server_id مطلوب" }, 400);

    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    const { data: connection, error: connErr } = await adminClient
      .from("mcp_server_connections")
      .select("id, auth_type, oauth_client_id, oauth_authorize_url, oauth_token_url, oauth_scope")
      .eq("server_id", serverId)
      .eq("owner_id", userData.user.id)
      .maybeSingle();

    if (connErr || !connection) {
      return jsonResponse({ error: "مفيش اتصال محفوظ لهذا الخادم - احفظ إعدادات OAuth أولاً عبر save-mcp-credentials" }, 400);
    }
    if (connection.auth_type !== "oauth2") {
      return jsonResponse({ error: "نوع المصادقة لهذا الاتصال ليس oauth2" }, 400);
    }
    if (!connection.oauth_client_id || !connection.oauth_authorize_url || !connection.oauth_token_url) {
      return jsonResponse({ error: "لازم حفظ client_id وauthorize_url وtoken_url أولاً عبر save-mcp-credentials" }, 400);
    }

    const state = `${connection.id}.${crypto.randomUUID().replace(/-/g, "")}`;
    const redirectUri = `${supabaseUrl}/functions/v1/mcp-oauth-callback`;

    const { error: updErr } = await adminClient
      .from("mcp_server_connections")
      .update({ oauth_state: state })
      .eq("id", connection.id);
    if (updErr) return jsonResponse({ error: "فشل توليد state: " + updErr.message }, 500);

    const authorizeUrl = new URL(connection.oauth_authorize_url);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", connection.oauth_client_id);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    if (connection.oauth_scope) authorizeUrl.searchParams.set("scope", connection.oauth_scope);
    authorizeUrl.searchParams.set("state", state);

    return jsonResponse({ authorize_url: authorizeUrl.toString(), redirect_uri: redirectUri });
  } catch (err) {
    console.error("Unexpected error:", err);
    return jsonResponse({ error: "حدث خطأ غير متوقع" }, 500);
  }
});
