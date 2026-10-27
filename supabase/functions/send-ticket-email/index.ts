// send-ticket-email — بريد دورة حياة التذكرة ورسائل الطاقم، بقالب مدعوم الموحّد.
//
// POST من محفّزات القاعدة (X-Internal-Trigger-Secret = internal_service_secrets.send_ticket_email_internal):
//   { event: "INSERT" | "UPDATE" | "REPLY", ticket_id, status?, previous_status?, reply_id? }
// POST من الأدمن/الدعم (JWT، رتبة admin أو support):
//   { event: "CUSTOM", customer_email, customer_name?, subject, message, from_email?, attachments?, related_user_id? }
//
// المنطق في handler.js (مُختبَر بلا Deno)، والقالب في ../_shared/ticket-email.js، وقراءة التذكرة بمفتاح الخدمة
// في ../_shared/ticket-email-data.js. هنا: التفويض وسجل mailbox_emails.
//
// الأسرار: RESEND_API_KEY، EMAIL_SENDER_DOMAIN / EMAIL_FROM (اختياريان، ../_shared/email.js)،
// PUBLIC_SITE_ORIGIN (افتراضيًا https://mad3oom.com) لرابط «عرض التذكرة» وصورة الشعار،
// و SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY التي توفرها المنصة.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { emailConfig, sendEmail } from "../_shared/email.js";
import { ticketEmailData } from "../_shared/ticket-email-data.js";
import { handleTicketEmail, safeEqual } from "./handler.js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, accept, x-internal-trigger-secret",
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

type Db = ReturnType<typeof createClient>;

async function authorize(req: Request, db: Db, supabaseUrl: string, anonKey: string): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const internalSecret = req.headers.get("X-Internal-Trigger-Secret");
  if (internalSecret) {
    const { data: secretRow } = await db
      .from("internal_service_secrets")
      .select("value")
      .eq("key", "send_ticket_email_internal")
      .maybeSingle();
    if (secretRow?.value && safeEqual(secretRow.value, internalSecret)) {
      return { ok: true };
    }
    return { ok: false, status: 401, error: "Unauthorized" };
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return { ok: false, status: 401, error: "Missing Authorization header" };
  const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
  const { data: userData, error } = await userClient.auth.getUser();
  if (error || !userData?.user) return { ok: false, status: 401, error: "Unauthorized" };
  const { data: profile } = await db.from("profiles").select("role").eq("id", userData.user.id).maybeSingle();
  if (!profile || !["admin", "support"].includes(profile.role)) {
    return { ok: false, status: 403, error: "هذه الميزة مقصورة على فريق الإدارة/الدعم" };
  }
  return { ok: true };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
  const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  const auth = await authorize(req, db, SUPABASE_URL, ANON_KEY);
  if (!auth.ok) return json(auth.status, { error: auth.error });

  let payload: Record<string, unknown> | null = null;
  try { payload = await req.json(); } catch { /* جسم غير JSON */ }

  // RESEND_API_KEY / EMAIL_SENDER_DOMAIN / EMAIL_FROM — supabase/functions/_shared/email.js
  const mail = emailConfig((k: string) => Deno.env.get(k));

  try {
    const result = await handleTicketEmail(payload || {}, {
      data: ticketEmailData(db),
      mail,
      send: (message: Parameters<typeof sendEmail>[0]) => sendEmail(message, { config: mail }),
      siteOrigin: Deno.env.get("PUBLIC_SITE_ORIGIN") ?? "https://mad3oom.com",
      logMailbox: async (row: Record<string, unknown>) => {
        const { error } = await db.from("mailbox_emails").insert(row);
        if (error) console.error("mailbox log failed:", error.message);
      },
      log: (event: Record<string, unknown>) => console.error(JSON.stringify({ fn: "send-ticket-email", ...event })),
    });
    return json(result.status, result.body);
  } catch (error) {
    console.error(JSON.stringify({ fn: "send-ticket-email", event: "unhandled", name: (error as Error)?.name || "Error" }));
    return json(500, { error: "تعذّر إرسال البريد" });
  }
});
