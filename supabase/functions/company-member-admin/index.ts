// company-member-admin — إدارة حساب عضو الشركة من لوحة الشركة (113).
//
// POST { action: "update_account", user_id, full_name, phone, email }
// POST { action: "password_reset", user_id }
//   Authorization: Bearer <جلسة مدير الشركة>   (verify_jwt: true)
//   200 { status: "updated" | "unchanged" | "reset_sent", message, ... }
//   4xx/5xx { status: "<رمز>", error: "<رسالة عربية>" }
//
// التفويض في القاعدة بهوية المستخدم (company_member_account_check / company_member_password_reset_check)،
// ثم نظام الدخول بمفتاح الخدمة (updateUserById / generateLink) لأن البريد هناك، ثم
// _company_member_account_apply (مفتاح الخدمة). المنطق كله في handler.js (مُختبَر بلا Deno).
// لا يُعاد للمتصفح رابط الاستعادة ولا رد Resend ولا أي سر.
//
// الأسرار: RESEND_API_KEY، EMAIL_SENDER_DOMAIN (اختياري)، PUBLIC_SITE_ORIGIN (افتراضيًا https://mad3oom.com)،
// و SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY التي توفرها المنصة.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { emailConfig, sendEmail } from "../_shared/email.js";
import { handleMemberAdmin, MESSAGES } from "./handler.js";

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
  try { input = await req.json(); } catch { /* جسم غير JSON = طلب غير صالح */ }

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
    const result = await handleMemberAdmin(input as Record<string, unknown> | null, {
      userRpc: (name: string, args: Record<string, unknown>) => userClient.rpc(name, args),
      serviceRpc: (name: string, args: Record<string, unknown>) => adminClient.rpc(name, args),
      updateAuthUser: async (id: string, attrs: Record<string, unknown>) => {
        const { error } = await adminClient.auth.admin.updateUserById(id, attrs);
        return { error: error ? { code: (error as { code?: string }).code, status: error.status, message: error.message } : null };
      },
      recoveryLink: async (email: string, redirectTo: string) => {
        const { data, error } = await adminClient.auth.admin.generateLink({ type: "recovery", email, options: { redirectTo } });
        return error ? { error: { status: error.status } } : { link: data?.properties?.action_link ?? null };
      },
      send: (message: Parameters<typeof sendEmail>[0]) => sendEmail(message, { config: mail }),
      mail,
      siteOrigin: Deno.env.get("PUBLIC_SITE_ORIGIN") ?? "https://mad3oom.com",
      log: (event: Record<string, unknown>) => console.error(JSON.stringify({ fn: "company-member-admin", ...event })),
    });
    return json(result.status, result.body);
  } catch (err) {
    console.error(JSON.stringify({ fn: "company-member-admin", event: "unhandled", name: (err as Error)?.name || "Error" }));
    return json(500, { status: "server", error: MESSAGES.server });
  }
});
