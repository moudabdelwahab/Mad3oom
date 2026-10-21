// company-invite-customer — دعوة عميل إلى الشركة وإرسال بريدها (112).
//
// POST { email, resend? }   Authorization: Bearer <جلسة مدير الشركة>   (verify_jwt: true)
//   200 { status: "sent" | "already_sent", invitation_id }
//   4xx/5xx { status: "<رمز>", error: "<رسالة عربية>" }
//
// التفويض في القاعدة (company_invite_customer بهوية المستخدم)، ومنع التكرار والحدود في
// _company_invitation_prepare_email (مفتاح الخدمة)، والإرسال عبر supabase/functions/_shared/email.js.
// المنطق كله في handler.js (مُختبَر بلا Deno). لا يُعاد للمتصفح رمز الدعوة ولا رد Resend ولا أي سر.
//
// الأسرار: RESEND_API_KEY، EMAIL_SENDER_DOMAIN (اختياري)، PUBLIC_SITE_ORIGIN (افتراضيًا https://mad3oom.com)،
// و SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY التي توفرها المنصة.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { emailConfig, sendEmail } from "../_shared/email.js";
import { handleInvite, MESSAGES } from "./handler.js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { status: "method_not_allowed", error: MESSAGES.server });

  const authorization = req.headers.get("Authorization") || "";
  if (!/^Bearer\s+\S+$/.test(authorization)) return json(401, { status: "unauthorized", error: MESSAGES.unauthorized });

  let input: unknown = null;
  try { input = await req.json(); } catch { /* جسم غير JSON = بريد غير صالح */ }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const adminClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const mail = emailConfig((k: string) => Deno.env.get(k));

  try {
    const result = await handleInvite(input as { email?: unknown; resend?: unknown } | null, {
      userRpc: (name: string, args: Record<string, unknown>) => userClient.rpc(name, args),
      serviceRpc: (name: string, args: Record<string, unknown>) => adminClient.rpc(name, args),
      send: (message: Parameters<typeof sendEmail>[0]) => sendEmail(message, { config: mail }),
      mail,
      siteOrigin: Deno.env.get("PUBLIC_SITE_ORIGIN") ?? "https://mad3oom.com",
      log: (event: Record<string, unknown>) => console.error(JSON.stringify({ fn: "company-invite-customer", ...event })),
    });
    return json(result.status, result.body);
  } catch (err) {
    console.error(JSON.stringify({ fn: "company-invite-customer", event: "unhandled", name: (err as Error)?.name || "Error" }));
    return json(500, { status: "server", error: MESSAGES.server });
  }
});
