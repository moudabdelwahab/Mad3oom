import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { decryptString, encryptString } from "./_shared/mcp-crypto.ts";
import { ensureFreshAccessToken } from "./_shared/mcp-oauth.ts";

// ============================================================
// save-mcp-credentials (v2 - generic auth_type + mcp_server_connections)
// ------------------------------------------------------------
// مسؤولية واحدة: تشفير وحفظ بيانات اعتماد اتصال المستخدم الحالي
// بخادم MCP معيّن (mcp_server_connections)، أياً كان auth_type.
// لا تلمس تعريف الخادم نفسه (mcp_servers) إطلاقاً.
// لا تُرجع أي قيمة مشفّرة أو صريحة للمتصفح.
// ============================================================

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
}

const VALID_AUTH_TYPES = ["none", "api_key", "bearer", "oauth2", "custom"];

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

    let body: {
      server_id?: string; auth_type?: string;
      api_key?: string; api_secret?: string; bearer_token?: string; custom_config?: unknown;
      oauth_client_id?: string; oauth_client_secret?: string; oauth_authorize_url?: string;
      oauth_token_url?: string; oauth_scope?: string;
    };
    try { body = await req.json(); } catch { return jsonResponse({ error: "Invalid JSON body" }, 400); }

    const serverId = (body.server_id || "").trim();
    if (!serverId) return jsonResponse({ error: "server_id مطلوب" }, 400);

    const authType = body.auth_type;
    if (authType && !VALID_AUTH_TYPES.includes(authType)) {
      return jsonResponse({ error: `auth_type غير صالح - القيم المسموحة: ${VALID_AUTH_TYPES.join(", ")}` }, 400);
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    const { data: server, error: serverErr } = await adminClient.from("mcp_servers").select("id").eq("id", serverId).maybeSingle();
    if (serverErr || !server) return jsonResponse({ error: "الخادم مش موجود" }, 404);

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    const updatedFields: string[] = [];

    if (authType) { updates.auth_type = authType; updatedFields.push("auth_type"); }

    const apiKey = (body.api_key || "").trim();
    const apiSecret = (body.api_secret || "").trim();
    if (apiKey) { updates.api_key_encrypted = await encryptString(apiKey); updatedFields.push("api_key"); }
    if (apiSecret) { updates.api_secret_encrypted = await encryptString(apiSecret); updatedFields.push("api_secret"); }

    const bearerToken = (body.bearer_token || "").trim();
    if (bearerToken) { updates.bearer_token_encrypted = await encryptString(bearerToken); updatedFields.push("bearer_token"); }

    if (body.custom_config !== undefined && body.custom_config !== null && body.custom_config !== "") {
      const asString = typeof body.custom_config === "string" ? body.custom_config : JSON.stringify(body.custom_config);
      updates.custom_config_encrypted = await encryptString(asString);
      updatedFields.push("custom_config");
    }

    // إعدادات تطبيق OAuth (مش أسرار حساسة زي الـ client_secret) - تُحفظ نصاً صريحاً
    if (body.oauth_client_id !== undefined) { updates.oauth_client_id = body.oauth_client_id.trim() || null; updatedFields.push("oauth_client_id"); }
    if (body.oauth_authorize_url !== undefined) { updates.oauth_authorize_url = body.oauth_authorize_url.trim() || null; updatedFields.push("oauth_authorize_url"); }
    if (body.oauth_token_url !== undefined) { updates.oauth_token_url = body.oauth_token_url.trim() || null; updatedFields.push("oauth_token_url"); }
    if (body.oauth_scope !== undefined) { updates.oauth_scope = body.oauth_scope.trim() || null; updatedFields.push("oauth_scope"); }

    const oauthClientSecret = (body.oauth_client_secret || "").trim();
    if (oauthClientSecret) { updates.oauth_client_secret_encrypted = await encryptString(oauthClientSecret); updatedFields.push("oauth_client_secret"); }

    const { data: existing } = await adminClient
      .from("mcp_server_connections")
      .select("id")
      .eq("server_id", serverId)
      .eq("owner_id", userData.user.id)
      .maybeSingle();

    if (existing) {
      const { error: updErr } = await adminClient.from("mcp_server_connections").update(updates).eq("id", existing.id);
      if (updErr) return jsonResponse({ error: "فشل حفظ بيانات الاعتماد: " + updErr.message }, 500);
    } else {
      const { error: insErr } = await adminClient.from("mcp_server_connections").insert({
        server_id: serverId,
        owner_id: userData.user.id,
        auth_type: authType || "none",
        ...updates,
      });
      if (insErr) return jsonResponse({ error: "فشل إنشاء الاتصال: " + insErr.message }, 500);
    }

    return jsonResponse({ success: true, updated: updatedFields });
  } catch (err) {
    console.error("Unexpected error:", err);
    return jsonResponse({ error: "حدث خطأ غير متوقع" }, 500);
  }
});
