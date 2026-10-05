import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, svix-id, svix-timestamp, svix-signature",
};

function base64Decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function base64Encode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

async function verifySvixSignature(
  payload: string,
  svixId: string,
  svixTimestamp: string,
  svixSignature: string,
  secret: string,
): Promise<boolean> {
  if (!svixId || !svixTimestamp || !svixSignature) return false;
  const secretBytes = base64Decode(secret.startsWith("whsec_") ? secret.slice(6) : secret);
  const signedContent = `${svixId}.${svixTimestamp}.${payload}`;
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedContent));
  const expectedSig = base64Encode(new Uint8Array(sigBuffer));
  const signatures = svixSignature.split(" ").map((s) => s.split(",")[1]).filter(Boolean);
  return signatures.includes(expectedSig);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
  const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || "";
  const WEBHOOK_SECRET = Deno.env.get("RESEND_WEBHOOK_SECRET");

  try {
    const rawBody = await req.text();

    if (WEBHOOK_SECRET) {
      const svixId = req.headers.get("svix-id") || "";
      const svixTimestamp = req.headers.get("svix-timestamp") || "";
      const svixSignature = req.headers.get("svix-signature") || "";
      const valid = await verifySvixSignature(rawBody, svixId, svixTimestamp, svixSignature, WEBHOOK_SECRET);
      if (!valid) {
        return new Response(JSON.stringify({ error: "توقيع غير صحيح" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    const event = JSON.parse(rawBody);
    const eventType = event.type;
    const data = event.data || {};

    async function dbInsert(table: string, row: Record<string, unknown>) {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
        method: "POST",
        headers: {
          "apikey": SERVICE_ROLE_KEY,
          "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
          "Prefer": "return=minimal",
        },
        body: JSON.stringify(row),
      });
      if (!res.ok) console.error("DB insert error:", await res.text());
    }

    async function dbUpdateOutboundStatus(providerMessageId: string, patch: Record<string, unknown>) {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/mailbox_emails?provider_message_id=eq.${encodeURIComponent(providerMessageId)}&direction=eq.outbound`,
        {
          method: "PATCH",
          headers: {
            "apikey": SERVICE_ROLE_KEY,
            "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
          },
          body: JSON.stringify(patch),
        },
      );
      if (!res.ok) console.error("DB update error:", await res.text());
    }

    if (eventType === "email.received") {
      const emailId = data.email_id;
      if (!emailId) throw new Error("email_id مفقود في الحدث");

      let detail: Record<string, any> = {};
      try {
        const detailRes = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
          headers: { "Authorization": `Bearer ${RESEND_API_KEY}` },
        });
        if (detailRes.ok) {
          detail = await detailRes.json();
        } else {
          console.error("فشل جلب تفاصيل الإيميل من Resend:", await detailRes.text());
        }
      } catch (e) {
        console.error("خطأ في جلب تفاصيل الإيميل:", e);
      }

      const attachmentsMeta = (detail.attachments || data.attachments || []).map((a: any) => ({
        id: a.id,
        email_id: emailId,
        filename: a.filename,
        content_type: a.content_type,
        size: a.size || null,
      }));

      const fromEmail = detail.from || data.from || "";
      const toList = detail.to || data.to || [];
      const toEmail = Array.isArray(toList) ? toList[0] : toList;

      let relatedUserId: string | null = null;
      if (fromEmail) {
        try {
          const profileRes = await fetch(
            `${SUPABASE_URL}/rest/v1/profiles?email=eq.${encodeURIComponent(fromEmail)}&select=id&limit=1`,
            {
              headers: {
                "apikey": SERVICE_ROLE_KEY,
                "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
              },
            },
          );
          if (profileRes.ok) {
            const profileData = await profileRes.json();
            if (Array.isArray(profileData) && profileData.length > 0) {
              relatedUserId = profileData[0].id;
            }
          }
        } catch (_e) {
          // مش حرج لو فشل
        }
      }

      await dbInsert("mailbox_emails", {
        direction: "inbound",
        from_email: fromEmail,
        to_email: toEmail,
        subject: detail.subject || data.subject || "(بدون عنوان)",
        html_body: detail.html || null,
        text_body: detail.text || null,
        status: "received",
        provider_message_id: emailId,
        attachments: attachmentsMeta,
        related_user_id: relatedUserId,
        is_read: false,
      });
    } else if (
      ["email.delivered", "email.bounced", "email.complained", "email.delivery_delayed"].includes(eventType)
    ) {
      const statusMap: Record<string, string> = {
        "email.delivered": "delivered",
        "email.bounced": "bounced",
        "email.complained": "complained",
        "email.delivery_delayed": "delayed",
      };
      if (data?.email_id) {
        const patch: Record<string, unknown> = { status: statusMap[eventType] };
        if (eventType === "email.bounced" || eventType === "email.complained") {
          patch.error_message = JSON.stringify(data);
        }
        await dbUpdateOutboundStatus(data.email_id, patch);
      }
    }

    return new Response(JSON.stringify({ received: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (error) {
    console.error("Webhook error:", error.message);
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 400,
    });
  }
});
