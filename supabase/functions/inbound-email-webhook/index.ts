import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, accept, svix-id, svix-timestamp, svix-signature",
};

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// التحقق من توقيع Svix الذي يضيفه Resend على كل Webhook
async function verifySvixSignature(
  payload: string,
  svixId: string,
  svixTimestamp: string,
  svixSignature: string,
  secret: string,
): Promise<boolean> {
  try {
    const secretBytes = base64Decode(secret.startsWith("whsec_") ? secret.slice(6) : secret);
    const signedContent = `${svixId}.${svixTimestamp}.${payload}`;

    const key = await crypto.subtle.importKey(
      "raw",
      secretBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );

    const signatureBuffer = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(signedContent),
    );

    const expectedSignature = base64Encode(new Uint8Array(signatureBuffer));

    // svix-signature ممكن يحتوي على أكتر من توقيع مفصول بمسافة، كل واحد بصيغة "v1,<base64>"
    const signatures = svixSignature.split(" ").map((s) => s.split(",")[1]).filter(Boolean);

    return signatures.includes(expectedSignature);
  } catch (err) {
    console.error("Signature verification error:", err);
    return false;
  }
}

function base64Decode(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const rawBody = await req.text();
    const webhookSecret = Deno.env.get("RESEND_WEBHOOK_SECRET");

    // تحقق من التوقيع لو السر متظبط (موصى بشدة في الإنتاج)
    if (webhookSecret) {
      const svixId = req.headers.get("svix-id") || "";
      const svixTimestamp = req.headers.get("svix-timestamp") || "";
      const svixSignature = req.headers.get("svix-signature") || "";

      if (!svixId || !svixTimestamp || !svixSignature) {
        return new Response(JSON.stringify({ error: "Missing svix headers" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const valid = await verifySvixSignature(rawBody, svixId, svixTimestamp, svixSignature, webhookSecret);
      if (!valid) {
        return new Response(JSON.stringify({ error: "Invalid signature" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    } else {
      console.warn("RESEND_WEBHOOK_SECRET غير متظبط - التحقق من التوقيع متجاوَز. متنصحش تسيبها كده في الإنتاج.");
    }

    const event = JSON.parse(rawBody);
    const resendApiKey = Deno.env.get("RESEND_API_KEY");

    // أحداث متابعة حالة الصادر - بنحدّث السجل الموجود بدل ما ننشئ سجل جديد
    if (["email.delivered", "email.bounced", "email.complained", "email.delivery_delayed"].includes(event.type)) {
      const emailId = event.data?.email_id;
      const statusMap: Record<string, string> = {
        "email.delivered": "delivered",
        "email.bounced": "bounced",
        "email.complained": "complained",
        "email.delivery_delayed": "delayed",
      };
      if (emailId) {
        await supabaseAdmin
          .from("mailbox_emails")
          .update({ status: statusMap[event.type] })
          .eq("provider_message_id", emailId)
          .eq("direction", "outbound");
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (event.type !== "email.received") {
      // أي حدث تاني مش محتاجين نعالجه دلوقتي
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const emailId = event.data?.email_id;
    if (!emailId) {
      throw new Error("email_id missing in webhook payload");
    }

    if (!resendApiKey) {
      throw new Error("RESEND_API_KEY is not configured");
    }

    // الـ webhook بيحتوي على البيانات الوصفية بس - لازم نجيب محتوى الرسالة بنداء إضافي
    const contentRes = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
      headers: { "Authorization": `Bearer ${resendApiKey}` },
    });
    const emailContent = await contentRes.json();

    // جلب قائمة المرفقات (لو موجودة) مع روابط تحميلها
    let attachmentsList: any[] = [];
    if (Array.isArray(event.data?.attachments) && event.data.attachments.length > 0) {
      try {
        const attRes = await fetch(`https://api.resend.com/emails/receiving/${emailId}/attachments`, {
          headers: { "Authorization": `Bearer ${resendApiKey}` },
        });
        const attData = await attRes.json();
        attachmentsList = Array.isArray(attData?.data) ? attData.data : (Array.isArray(attData) ? attData : []);
      } catch (attErr) {
        console.error("Failed to fetch attachments:", attErr);
        attachmentsList = event.data.attachments; // نكتفي بالميتاداتا الأساسية من الـ webhook
      }
    }

    const fromEmail = event.data?.from || "unknown@unknown";
    const toEmail = (event.data?.received_for && event.data.received_for[0])
      || (event.data?.to && event.data.to[0])
      || "unknown";

    // محاولة ربط الرسالة بمستخدم موجود عندنا عن طريق الإيميل
    let relatedUserId: string | null = null;
    try {
      const { data: matchedUser } = await supabaseAdmin
        .from("profiles")
        .select("id")
        .eq("email", fromEmail)
        .maybeSingle();
      relatedUserId = matchedUser?.id || null;
    } catch (_) {
      // تجاهل لو فشل البحث
    }

    await supabaseAdmin.from("mailbox_emails").insert({
      direction: "inbound",
      from_email: fromEmail,
      to_email: toEmail,
      subject: event.data?.subject || "(بدون عنوان)",
      html_body: emailContent?.html || null,
      text_body: emailContent?.text || null,
      status: "received",
      provider_message_id: emailId,
      attachments: attachmentsList,
      related_user_id: relatedUserId,
      is_read: false,
    });

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Inbound webhook error:", error.message);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
