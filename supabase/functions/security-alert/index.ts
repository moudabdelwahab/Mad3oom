// security-alert — تنبيهات أمان مالك المنصة بالبريد (121).
//
// POST من القاعدة وحدها (public._security_alert_dispatch، pg_net):
//   X-Internal-Secret = internal_service_secrets.security_alert_internal
//   { kind: "owner_account_change", request } | { kind: "owner_new_login", event_id } | { kind: "recovery_code_used", step_up_session }
//
// المنطق في handler.js (مُختبَر بلا Deno). هنا: قراءة الصفوف بمفتاح الخدمة، الموقع التقريبي الاختياري، والإرسال.
//
// الأسرار: RESEND_API_KEY، EMAIL_SENDER_DOMAIN / EMAIL_FROM (اختياريان)، PUBLIC_SITE_ORIGIN،
// IP_GEO_URL (اختياري؛ قالب مثل https://ipapi.co/{ip}/json/ — بلاه لا يُرسَل أي IP لطرف ثالث)،
// و SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY التي توفرها المنصة.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { emailConfig, sendEmail } from "../_shared/email.js";
import { handleSecurityAlert } from "./handler.js";
import { lookupGeo } from "../security-event/handler.js";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !serviceKey) return json(500, { error: "not_configured" });
  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const mail = emailConfig((k: string) => Deno.env.get(k));
  const geoUrl = Deno.env.get("IP_GEO_URL") || "";

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return json(400, { error: "invalid_json" }); }

  const result = await handleSecurityAlert({
    headerSecret: req.headers.get("X-Internal-Secret"),
    body,
    origin: Deno.env.get("PUBLIC_SITE_ORIGIN") ?? "https://mad3oom.com",
    deps: {
      internalSecret: async () => {
        const { data } = await db.from("internal_service_secrets").select("value").eq("key", "security_alert_internal").maybeSingle();
        return data?.value || "";
      },
      loadRequest: async (id: string) => {
        const { data } = await db.from("owner_account_change_requests")
          .select("id, kind, status, requested_at, expires_at, ip, user_agent, pending_value").eq("id", id).maybeSingle();
        // بصمة كلمة المرور لا تغادر هذه الدالة ولا تدخل الرسالة: تُحذف هنا
        if (data && data.kind === "password") data.pending_value = null;
        return data;
      },
      setTokens: async (id: string, a: string, r: string) => {
        const { data, error } = await db.rpc("_account_change_set_tokens", { p_request: id, p_approve_hash: a, p_reject_hash: r });
        return !error && data === true;
      },
      clearTokens: async (id: string, a: string) => {
        const { data, error } = await db.from("owner_account_change_requests")
          .update({ approve_token_hash: null, reject_token_hash: null })
          .eq("id", id).eq("status", "pending").eq("approve_token_hash", a).select("id");
        return !error && Array.isArray(data) && data.length === 1;
      },
      loadEvent: async (id: unknown) => {
        const { data } = await db.from("security_events").select("id, at, event_type, ip, user_agent").eq("id", Number(id)).maybeSingle();
        return data;
      },
      loadStepUp: async (id: unknown) => {
        const { data } = await db.from("owner_step_up_sessions").select("id, method, started_at, ip, user_agent, user_id").eq("id", Number(id)).maybeSingle();
        if (!data) return null;
        const { data: mfa } = await db.from("user_mfa_secrets").select("recovery_code_hashes").eq("user_id", data.user_id).maybeSingle();
        return { ...data, recovery_codes_left: Array.isArray(mfa?.recovery_code_hashes) ? mfa.recovery_code_hashes.length : null };
      },
      ownerEmail: async () => {
        const { data: owner } = await db.from("platform_authority").select("user_id").eq("level", "owner").limit(1).maybeSingle();
        if (!owner?.user_id) return "";
        const { data } = await db.auth.admin.getUserById(owner.user_id);
        return data?.user?.email || "";
      },
      geo: (ip: string) => lookupGeo(ip, { template: geoUrl, db }),
      send: ({ to, subject, html, text, idempotencyKey }: { to: string; subject: string; html: string; text: string; idempotencyKey: string }) =>
        sendEmail({ from: `مدعوم — الأمان <no-reply@${mail.domain}>`, to, subject, html, text, idempotencyKey }, { config: mail }),
      log: async (type: string, severity: string, details: Record<string, unknown>) => {
        await db.from("security_events").insert({ event_type: type, severity, details, source: "edge", hash: "-" });
      },
    },
  });
  return json(result.status, result.body);
});
