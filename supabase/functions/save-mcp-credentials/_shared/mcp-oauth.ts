// ============================================================
// منطق OAuth2 المشترك (تجديد التوكن) - يُستخدم من test-mcp-server
// ومستقبلاً من أي مستهلك تاني لاتصالات MCP، بدون تكرار.
// عام تماماً: لا يفترض مزود OAuth محدد.
// ============================================================
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { decryptString, encryptString } from "./mcp-crypto.ts";

export interface McpConnection {
  id: string;
  server_id: string;
  owner_id: string;
  auth_type: string;
  api_key_encrypted: string | null;
  api_secret_encrypted: string | null;
  bearer_token_encrypted: string | null;
  custom_config_encrypted: string | null;
  oauth_client_id: string | null;
  oauth_client_secret_encrypted: string | null;
  oauth_authorize_url: string | null;
  oauth_token_url: string | null;
  oauth_scope: string | null;
  oauth_access_token_encrypted: string | null;
  oauth_refresh_token_encrypted: string | null;
  oauth_token_expires_at: string | null;
  oauth_state: string | null;
  status: string;
  tools: unknown;
  last_checked_at: string | null;
  last_error: string | null;
}

/**
 * لو التوكن لسه صالح (بهامش أمان دقيقة) بيرجعه زي ما هو. لو منتهي
 * وعنده refresh_token، بيجدده فعلياً عبر oauth_token_url ويحفظ النتيجة.
 */
export async function ensureFreshAccessToken(adminClient: SupabaseClient, connection: McpConnection): Promise<McpConnection> {
  if (connection.auth_type !== "oauth2") return connection;

  const expiresAtMs = connection.oauth_token_expires_at ? new Date(connection.oauth_token_expires_at).getTime() : 0;
  const skewMs = 60_000;
  if (expiresAtMs - Date.now() > skewMs) return connection;

  if (!connection.oauth_refresh_token_encrypted || !connection.oauth_token_url) {
    throw new Error("انتهت صلاحية توكن OAuth ولا يوجد refresh token صالح لتجديده - أعد ربط الخادم عبر OAuth من جديد");
  }

  const clientSecret = connection.oauth_client_secret_encrypted ? await decryptString(connection.oauth_client_secret_encrypted) : "";
  const refreshToken = await decryptString(connection.oauth_refresh_token_encrypted);

  const res = await fetch(connection.oauth_token_url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: connection.oauth_client_id || "",
      client_secret: clientSecret,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error("فشل تجديد توكن OAuth: " + (data.error_description || data.error || `HTTP ${res.status}`));
  }

  const updates: Record<string, unknown> = {
    oauth_access_token_encrypted: await encryptString(data.access_token),
    oauth_token_expires_at: data.expires_in ? new Date(Date.now() + Number(data.expires_in) * 1000).toISOString() : null,
    updated_at: new Date().toISOString(),
  };
  if (data.refresh_token) updates.oauth_refresh_token_encrypted = await encryptString(data.refresh_token);

  await adminClient.from("mcp_server_connections").update(updates).eq("id", connection.id);
  return { ...connection, ...updates } as McpConnection;
}

export function db(): SupabaseClient {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
}
