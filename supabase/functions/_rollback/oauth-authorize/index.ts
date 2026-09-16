import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { checkRateLimit, clientIp } from "./_shared/rate-limit.ts";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};
const CONSENT_PAGE_URL = "https://mad3oom.online/admin/oauth-consent.html";

function err(desc: string, status = 400) {
  return new Response(JSON.stringify({ error: "invalid_request", error_description: desc }), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "GET") return err("Only GET is supported", 405);

  const p = new URL(req.url).searchParams;
  const clientId = p.get("client_id");
  const redirectUri = p.get("redirect_uri");
  const responseType = p.get("response_type");
  const codeChallenge = p.get("code_challenge");
  const codeChallengeMethod = p.get("code_challenge_method") || "S256";
  const scope = p.get("scope") || "";
  const state = p.get("state") || "";

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const ip = clientIp(req);

  const ipGuard = await checkRateLimit(admin, "oauth-authorize:ip", ip, 60, 60);
  if (!ipGuard.ok) return err("طلبات كثيرة جدًا - حاول بعد قليل", 429);

  if (clientId) {
    const perClient = await checkRateLimit(admin, "oauth-authorize:client-ip", `${clientId}:${ip}`, 20, 60);
    if (!perClient.ok) return err("طلبات كثيرة جدًا لهذا التطبيق - حاول بعد قليل", 429);
  }

  if (!clientId) return err("client_id مطلوب");
  if (!redirectUri) return err("redirect_uri مطلوب");
  if (responseType !== "code") return err("response_type يجب أن يكون code");
  if (!codeChallenge) return err("code_challenge مطلوب (PKCE إجباري)");
  if (codeChallengeMethod !== "S256") return err("code_challenge_method يجب أن يكون S256 فقط");

  const { data: client, error } = await admin
    .from("oauth_clients")
    .select("client_id, redirect_uris, is_active")
    .eq("client_id", clientId)
    .maybeSingle();

  if (error || !client || !client.is_active) return err("client_id غير معروف", 401);

  const allowed: string[] = Array.isArray(client.redirect_uris) ? client.redirect_uris : [];
  if (!allowed.includes(redirectUri)) return err("redirect_uri غير مسجّل لهذا العميل", 400);

  const consentUrl = new URL(CONSENT_PAGE_URL);
  consentUrl.searchParams.set("client_id", clientId);
  consentUrl.searchParams.set("redirect_uri", redirectUri);
  consentUrl.searchParams.set("scope", scope);
  consentUrl.searchParams.set("state", state);
  consentUrl.searchParams.set("code_challenge", codeChallenge);
  consentUrl.searchParams.set("code_challenge_method", codeChallengeMethod);

  return new Response(null, { status: 302, headers: { Location: consentUrl.toString(), ...CORS_HEADERS } });
});
