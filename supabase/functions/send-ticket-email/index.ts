import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { emailConfig, senderFor, sendEmail } from "../_shared/email.js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, accept, x-internal-trigger-secret",
};

async function logToMailbox(
  supabaseUrl: string,
  serviceRoleKey: string,
  row: Record<string, unknown>,
) {
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/mailbox_emails`, {
      method: "POST",
      headers: {
        "apikey": serviceRoleKey,
        "Authorization": `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
      },
      body: JSON.stringify(row),
    });
    if (!res.ok) {
      console.error("mailbox log failed:", await res.text());
    }
  } catch (e) {
    console.error("mailbox log exception:", e);
  }
}

async function authorize(req: Request, supabaseUrl: string, anonKey: string, serviceRoleKey: string): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const internalSecret = req.headers.get("X-Internal-Trigger-Secret");
  if (internalSecret) {
    const db = createClient(supabaseUrl, serviceRoleKey);
    const { data: secretRow } = await db
      .from("internal_service_secrets")
      .select("value")
      .eq("key", "send_ticket_email_internal")
      .maybeSingle();
    if (secretRow?.value && secretRow.value === internalSecret) {
      return { ok: true };
    }
    return { ok: false, status: 401, error: "Unauthorized" };
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return { ok: false, status: 401, error: "Missing Authorization header" };
  const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
  const { data: userData, error } = await userClient.auth.getUser();
  if (error || !userData?.user) return { ok: false, status: 401, error: "Unauthorized" };
  const db = createClient(supabaseUrl, serviceRoleKey);
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

  const auth = await authorize(req, SUPABASE_URL, ANON_KEY, SERVICE_ROLE_KEY);
  if (!auth.ok) {
    return new Response(JSON.stringify({ error: auth.error }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: auth.status,
    });
  }

  try {
    const payload = await req.json();
    const {
      event,
      ticket_number,
      title,
      status,
      customer_email,
      customer_name,
      message,
      subject,
      from_email,
      attachments,
      related_user_id,
    } = payload;

    if (!customer_email) {
      throw new Error("Customer email is missing");
    }

    // RESEND_API_KEY / EMAIL_SENDER_DOMAIN / EMAIL_FROM — supabase/functions/_shared/email.js
    const mail = emailConfig((k: string) => Deno.env.get(k));
    if (!mail.configured) {
      throw new Error("RESEND_API_KEY is not configured in environment variables");
    }

    let emailFrom = mail.defaultFrom;
    if (from_email) {
      // صناديق المنصة المعروفة على نطاق الإرسال المضبوط (القيم القديمة @mad3oom.online تُقبل)
      const allowed = senderFor(from_email, mail);
      if (!allowed) {
        throw new Error("عنوان المرسل غير مسموح به");
      }
      emailFrom = allowed;
    }

    let emailSubject = "";
    let htmlContent = "";

    const statusMap: Record<string, string> = {
      'open': 'مفتوحة',
      'in-progress': 'قيد المعالجة',
      'resolved': 'محلولة'
    };

    const greeting = `مرحباً ${customer_name || 'عميلنا العزيز'}،`;

    if (event === 'CUSTOM') {
      emailSubject = subject || 'رسالة من منصة مدعوم';
      htmlContent = `
        <div dir="rtl" style="font-family: sans-serif; line-height: 1.6;">
          <h2 style="color: #333;">${greeting}</h2>
          <div style="background: #f9f9f9; padding: 20px; border-radius: 8px; margin: 20px 0;">
            ${message}
          </div>
          <p style="font-size: 0.9em; color: #666;">شكراً لاستخدامك منصة مدعوم.</p>
        </div>
      `;
    } else if (event === 'INSERT') {
      emailSubject = `تم إنشاء تذكرة جديدة #${ticket_number}: ${title}`;
      htmlContent = `
        <div dir="rtl" style="font-family: sans-serif; line-height: 1.6;">
          <h2 style="color: #333;">${greeting}</h2>
          <p>تم استلام تذكرتك بنجاح في منصة مدعوم.</p>
          <div style="background: #f9f9f9; padding: 15px; border-right: 4px solid #007bff; margin: 20px 0;">
            <p><strong>رقم التذكرة:</strong> #${ticket_number}</p>
            <p><strong>العنوان:</strong> ${title}</p>
            <p><strong>الحالة:</strong> مفتوحة</p>
          </div>
          <p>سنقوم بالرد عليك في أقرب وقت ممكن. يمكنك متابعة التذكرة عبر حسابك في المنصة.</p>
          <p style="font-size: 0.9em; color: #666;">شكراً لاستخدامك منصة مدعوم.</p>
        </div>
      `;
    } else if (event === 'UPDATE') {
      emailSubject = `تحديث حالة التذكرة #${ticket_number}`;
      htmlContent = `
        <div dir="rtl" style="font-family: sans-serif; line-height: 1.6;">
          <h2 style="color: #333;">${greeting}</h2>
          <p>نود إعلامك بأنه تم تحديث حالة تذكرتك #${ticket_number}.</p>
          <div style="background: #f9f9f9; padding: 15px; border-right: 4px solid #28a745; margin: 20px 0;">
            <p><strong>الحالة الجديدة:</strong> ${statusMap[status] || status}</p>
          </div>
          <p>شكراً لتواصلك معنا.</p>
        </div>
      `;
    } else if (event === 'REPLY') {
      emailSubject = `رد جديد على التذكرة #${ticket_number}`;
      htmlContent = `
        <div dir="rtl" style="font-family: sans-serif; line-height: 1.6;">
          <h2 style="color: #333;">${greeting}</h2>
          <p>هناك رد جديد من فريق الدعم على تذكرتك #${ticket_number}:</p>
          <div style="background: #f4f4f4; padding: 20px; border-radius: 8px; margin: 20px 0; border: 1px solid #ddd;">
            ${message}
          </div>
          <p>يمكنك الرد ومتابعة المحادثة عبر المنصة.</p>
        </div>
      `;
    }

    const emailBody: Record<string, unknown> = {
      from: emailFrom,
      to: customer_email,
      subject: emailSubject,
      html: htmlContent,
    };

    let attachmentsMeta: Array<Record<string, unknown>> = [];
    if (Array.isArray(attachments) && attachments.length > 0) {
      const validAttachments = attachments.filter((a: any) => a && a.filename && a.content);
      emailBody.attachments = validAttachments.map((a: any) => ({
        filename: a.filename,
        content: a.content,
      }));
      attachmentsMeta = validAttachments.map((a: any) => ({
        filename: a.filename,
        content_type: a.type || null,
      }));
    }

    const sent = await sendEmail({
      from: emailBody.from as string,
      to: emailBody.to as string,
      subject: emailBody.subject as string,
      html: emailBody.html as string,
      attachments: emailBody.attachments as unknown[] | undefined,
    }, { config: mail });
    const result = sent.ok ? { id: sent.id } : { code: sent.code, status: sent.status, detail: sent.detail };

    if (!sent.ok) {
      if (SUPABASE_URL && SERVICE_ROLE_KEY) {
        await logToMailbox(SUPABASE_URL, SERVICE_ROLE_KEY, {
          direction: "outbound",
          from_email: emailFrom,
          to_email: customer_email,
          subject: emailSubject,
          html_body: htmlContent,
          text_body: event === 'CUSTOM' || event === 'REPLY' ? (message || null) : null,
          status: "failed",
          attachments: attachmentsMeta,
          related_user_id: related_user_id || null,
          error_message: JSON.stringify(result),
        });
      }
      throw new Error(`Resend API error: ${sent.code}`);
    }

    if (SUPABASE_URL && SERVICE_ROLE_KEY) {
      await logToMailbox(SUPABASE_URL, SERVICE_ROLE_KEY, {
        direction: "outbound",
        from_email: emailFrom,
        to_email: customer_email,
        subject: emailSubject,
        html_body: htmlContent,
        text_body: event === 'CUSTOM' || event === 'REPLY' ? (message || null) : null,
        status: "sent",
        provider_message_id: result?.id || null,
        attachments: attachmentsMeta,
        related_user_id: related_user_id || null,
        is_read: true,
      });
    }

    return new Response(JSON.stringify({ success: true, data: result }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (error) {
    console.error("Error:", (error as Error).message);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 400,
    });
  }
});
