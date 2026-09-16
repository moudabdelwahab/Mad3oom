import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { encryptString } from "./_shared/mcp-crypto.ts";
import { decryptString } from "./_shared/mcp-crypto.ts";

// ============================================================
// mcp-oauth-callback
// ------------------------------------------------------------
// عامة (يناديها متصفح المستخدم مباشرة بعد redirect من مزود
// OAuth، مفيش أي Authorization header هنا). تتحقق من state بدلاً من
// أي جلسة Supabase Auth، تعمل exchange للـ code، تشفر التوكنات،
// وترجّع المستخدم للوحة admin/mcp.html بنتيجة العملية.
//
// ⚠️ رابط التفويض (redirect_uri) اللي لازم تسجله يدويًا في إعدادات
// تطبيق OAuth لأي مزود خارجي هو:
// {SUPABASE_URL}/functions/v1/mcp-oauth-callback
// ============================================================

const ADMIN_MCP_PAGE_URL = "https://mad3oom.online/admin/mcp.html";

function redirectToAdmin(params: Record<string, string>): Response {
  const url = new URL(ADMIN_MCP_PAGE_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Response(null, { status: 302, headers: { Location: url.toString() } });
}

Deno.serve(async (req: Request) => {
  try {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const oauthError = url.searchParams.get("error");
    const oauthErrorDesc = url.searchParams.get("error_description");

    if (oauthError) {
      return redirectToAdmin({ oauth: "error", message: oauthErrorDesc || oauthError });
    }
    if (!code || !state) {
      return redirectToAdmin({ oauth: "error", message: "رابط رجوع غير مكتمل (code/state مفقودين)" });
    }

    const dotIndex = state.indexOf(".");
    if (dotIndex === -1) return redirectToAdmin({ oauth: "error", message: "state غير صالح" });
    const connectionId = state.slice(0, dotIndex);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    const { data: connection, error: connErr } = await adminClient
      .from("mcp_server_connections")
      .select("id, server_id, oauth_state, oauth_client_id, oauth_client_secret_encrypted, oauth_token_url")
      .eq("id", connectionId)
      .maybeSingle();

    if (connErr || !connection) return redirectToAdmin({ oauth: "error", message: "لم يتم العثور على الاتصال المطلوب" });
    if (!connection.oauth_state || connection.oauth_state !== state) {
      return redirectToAdmin({ oauth: "error", message: "state غير مطابق - محاولة اتصال غير موثوقة أو منتهية الصلاحية", server_id: connection.server_id || "" });
    }

    const redirectUri = `${supabaseUrl}/functions/v1/mcp-oauth-callback`;
    const clientSecret = connection.oauth_client_secret_encrypted ? await decryptString(connection.oauth_client_secret_encrypted) : "";

    const tokenRes = await fetch(connection.oauth_token_url!, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: connection.oauth_client_id || "",
        client_secret: clientSecret,
      }),
    });
    const tokenData = await tokenRes.json().catch(() => ({}));

    if (!tokenRes.ok || !tokenData.access_token) {
      const message = tokenData.error_description || tokenData.error || `HTTP ${tokenRes.status}`;
      await adminClient.from("mcp_server_connections").update({
        status: "error", last_error: message, oauth_state: null,
      }).eq("id", connection.id);
      return redirectToAdmin({ oauth: "error", message, server_id: connection.server_id });
    }

    const updates: Record<string, unknown> = {
      oauth_access_token_encrypted: await encryptString(tokenData.access_token),
      oauth_token_expires_at: tokenData.expires_in ? new Date(Date.now() + Number(tokenData.expires_in) * 1000).toISOString() : null,
      oauth_state: null,
      status: "connected",
      last_error: null,
      last_checked_at: new Date().toISOString(),
    };
    if (tokenData.refresh_token) updates.oauth_refresh_token_encrypted = await encryptString(tokenData.refresh_token);

    await adminClient.from("mcp_server_connections").update(updates).eq("id", connection.id);

    return redirectToAdmin({ oauth: "success", server_id: connection.server_id });
  } catch (err) {
    console.error("Unexpected error:", err);
    return redirectToAdmin({ oauth: "error", message: "حدث خطأ غير متوقع أثناء معالجة OAuth callback" });
  }
});
