import { createClient } from "jsr:@supabase/supabase-js@2";

export interface VerifiedToken {
  id: string;
  user_id: string;
  scopes: string[];
  name: string;
}

export type VerifyResult =
  | { ok: true; token: VerifiedToken }
  | { ok: false; status: number; error: string };

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const RATE_LIMIT_MAX_PER_MINUTE = 60;
const TOKEN_COLUMNS = "id, user_id, name, api_key, secret_hash, bearer_token_hash, is_active, revoked_at, scopes, expires_at, credential_type";

function adminClient() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
}

export async function verifyApiToken(req: Request): Promise<VerifyResult> {
  const authHeader = req.headers.get("Authorization") || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return { ok: false, status: 401, error: "Missing Authorization header" };

  const raw = match[1];
  const admin = adminClient();

  const dotIndex = raw.indexOf(".");
  let row: any = null;

  if (dotIndex !== -1) {
    const apiKey = raw.slice(0, dotIndex);
    const secret = raw.slice(dotIndex + 1);
    if (!apiKey || !secret) return { ok: false, status: 401, error: "Malformed token" };

    const { data, error } = await admin.from("api_tokens").select(TOKEN_COLUMNS).eq("api_key", apiKey).maybeSingle();
    if (error || !data) return { ok: false, status: 401, error: "Invalid API key" };

    const computedHash = await sha256Hex(secret);
    if (!data.secret_hash || !timingSafeEqual(computedHash, data.secret_hash)) {
      return { ok: false, status: 401, error: "Invalid API secret" };
    }
    row = data;
  } else {
    const bearerHash = await sha256Hex(raw);
    const { data, error } = await admin.from("api_tokens").select(TOKEN_COLUMNS).eq("bearer_token_hash", bearerHash).maybeSingle();
    if (error || !data) return { ok: false, status: 401, error: "Invalid bearer token" };
    row = data;
  }

  if (!row.is_active || row.revoked_at) return { ok: false, status: 401, error: "Token is inactive or revoked" };
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    return { ok: false, status: 401, error: "Token has expired" };
  }

  const oneMinuteAgo = new Date(Date.now() - 60_000).toISOString();
  const { count } = await admin
    .from("api_token_usage_logs")
    .select("id", { count: "exact", head: true })
    .eq("token_id", row.id)
    .gte("created_at", oneMinuteAgo);

  if ((count ?? 0) >= RATE_LIMIT_MAX_PER_MINUTE) {
    return { ok: false, status: 429, error: "Rate limit exceeded (60 req/min)" };
  }

  return { ok: true, token: { id: row.id, user_id: row.user_id, scopes: row.scopes || [], name: row.name } };
}

export function requireScope(token: VerifiedToken, scope: string): { ok: false; status: number; error: string } | null {
  if (!token.scopes.includes(scope)) {
    return { ok: false, status: 403, error: `Missing required scope: ${scope}` };
  }
  return null;
}

export function logApiUsage(params: {
  tokenId: string;
  userId: string;
  endpoint: string;
  method: string;
  statusCode: number;
  ip: string;
  userAgent: string;
}): void {
  const admin = adminClient();

  admin.from("api_token_usage_logs").insert({
    token_id: params.tokenId,
    user_id: params.userId,
    endpoint: params.endpoint,
    method: params.method,
    status_code: params.statusCode,
    ip_address: params.ip,
    user_agent: params.userAgent,
  }).then(() => {}, (e: unknown) => console.error("[api-auth] logApiUsage insert failed:", e));

  admin.rpc("increment_api_token_usage", { p_token_id: params.tokenId, p_ip: params.ip || null })
    .then(() => {}, (e: unknown) => console.error("[api-auth] increment_api_token_usage failed:", e));
}
