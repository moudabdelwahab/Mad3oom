import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ============================================================
// regenerate-api-token-secret (v3)
// ------------------------------------------------------------
// api_key_secret: يولّد secret جديد بس (api_key نفسه زي ما هو) - بلا تغيير.
// bearer: يولّد bearer token جديد (256-bit) بدون لمس api_key/secret_hash
// الداخليين للصف - بيفضلوا زي ما هما (مش مستخدمين في مصادقة Bearer أصلاً).
// ============================================================

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomBase62(length: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < length; i++) out += chars[bytes[i] % chars.length];
  return out;
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
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

    let body: { token_id?: string };
    try { body = await req.json(); } catch { return jsonResponse({ error: "Invalid JSON body" }, 400); }

    const tokenId = (body.token_id || "").trim();
    if (!tokenId) return jsonResponse({ error: "token_id مطلوب" }, 400);

    const { data: existing, error: fetchError } = await userClient
      .from("api_tokens")
      .select("id, user_id, name, credential_type")
      .eq("id", tokenId)
      .maybeSingle();

    if (fetchError || !existing) return jsonResponse({ error: "المفتاح غير موجود أو لا تملك صلاحية الوصول له" }, 404);

    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    if (existing.credential_type === "bearer") {
      const newBearer = `mad3oom_bt_${randomHex(32)}`; // 256-bit entropy
      const bearerHash = await sha256Hex(newBearer);
      const { data: updated, error: updateError } = await adminClient
        .from("api_tokens")
        .update({ bearer_token_hash: bearerHash, bearer_last_four: newBearer.slice(-4), revoked_at: null, is_active: true })
        .eq("id", tokenId)
        .select("id, name, description, is_active, created_at, scopes, expires_at, credential_type")
        .single();
      if (updateError || !updated) return jsonResponse({ error: "فشل تجديد Bearer Token" }, 500);
      return jsonResponse({ token: updated, bearer_token: newBearer });
    }

    const newSecret = `mad3oom_sk_${randomBase62(40)}`;
    const secretHash = await sha256Hex(newSecret);
    const secretLastFour = newSecret.slice(-4);

    const { data: updated, error: updateError } = await adminClient
      .from("api_tokens")
      .update({ secret_hash: secretHash, secret_last_four: secretLastFour, revoked_at: null, is_active: true })
      .eq("id", tokenId)
      .select("id, name, description, api_key, is_active, created_at")
      .single();

    if (updateError || !updated) {
      console.error("Update error:", updateError);
      return jsonResponse({ error: "فشل تجديد السر، حاول مرة أخرى" }, 500);
    }

    return jsonResponse({ token: updated, secret: newSecret });
  } catch (err) {
    console.error("Unexpected error:", err);
    return jsonResponse({ error: "حدث خطأ غير متوقع" }, 500);
  }
});
