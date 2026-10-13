// ============================================================================
// deno-deps.ts — يبني deps لمعالجات مركز التكاملات داخل Supabase Edge (Deno).
// المنطق كله في الوحدات .js المجاورة (تُختبر في node)؛ هذا الملف ربط فقط.
// ============================================================================
import { createClient } from "jsr:@supabase/supabase-js@2";

const ENV_KEYS = [
  "IHUB_ENC_KEY", "IHUB_KEY_VERSION", "IHUB_PUBLIC_BASE", "IHUB_DASHBOARD_URL", "IHUB_WORKER_SECRET",
  "SALLA_CLIENT_ID", "SALLA_CLIENT_SECRET", "SALLA_REDIRECT_URI", "SALLA_WEBHOOK_SECRET",
];

export function readEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ENV_KEYS) env[k] = Deno.env.get(k) ?? "";
  return env;
}

// deno-lint-ignore no-explicit-any
function rpcVia(client: any) {
  return async (name: string, args: Record<string, unknown>) => {
    const { data, error } = await client.rpc(name, args);
    if (error) throw error;
    return data;
  };
}

export function serviceRpc() {
  const client = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return rpcVia(client);
}

export function userClient(authHeader: string) {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export { rpcVia };
