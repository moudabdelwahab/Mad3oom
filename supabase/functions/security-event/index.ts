// security-event — محاولات الدخول الفاشلة (يبلغ عنها المتصفح) وإثراء الموقع التقريبي للعناوين (121).
//
// POST { action: "login_failed", email, reason }    بلا جلسة (مفتاح anon). الـIP والمتصفح من رؤوس الطلب.
// POST { action: "enrich_geo" }                     بجلسة مالك المنصة في واجهته (owner_geo_pending).
//
// المنطق في handler.js. الأسرار: IP_GEO_URL (اختياري؛ بلاه لا موقع ولا إرسال لطرف ثالث)،
// و SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY التي توفرها المنصة.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { handleSecurityEvent, lookupGeo } from "./handler.js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !serviceKey || !anonKey) return json(500, { error: "not_configured" });
  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const geoUrl = Deno.env.get("IP_GEO_URL") || "";

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return json(400, { error: "invalid_json" }); }

  const count = async (q: any) => { const { count: n } = await q; return n || 0; };
  const result = await handleSecurityEvent({
    body,
    headers: req.headers,
    authHeader: req.headers.get("Authorization"),
    deps: {
      countIp: (ip: string, since: string) =>
        count(db.from("security_events").select("id", { count: "exact", head: true }).eq("ip", ip).eq("source", "client_report").gte("at", since)),
      countFailures: (email: string, since: string) =>
        count(db.from("security_events").select("id", { count: "exact", head: true }).eq("event_type", "auth.login_failed").eq("target_email", email).gte("at", since)),
      burstLogged: async (email: string, since: string) =>
        (await count(db.from("security_events").select("id", { count: "exact", head: true }).eq("event_type", "auth.failed_burst").eq("target_email", email).gte("at", since))) > 0,
      threshold: async () => {
        const { data } = await db.from("owner_security_policy").select("failed_login_threshold").eq("id", 1).maybeSingle();
        return data?.failed_login_threshold ?? 5;
      },
      insert: async (row: Record<string, unknown>) => {
        await db.from("security_events").insert({ ...row, hash: "-" });
      },
      ownerGeoPending: async (authHeader: string | null) => {
        if (!authHeader) return null;
        const user = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } });
        const { data, error } = await user.rpc("owner_geo_pending", { p_limit: 25 });
        return error ? null : data;
      },
      geo: (ip: string) => lookupGeo(ip, { template: geoUrl, db }),
    },
  });
  return json(result.status, result.body);
});
