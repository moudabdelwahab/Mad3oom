import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { CORS_HEADERS } from "./_shared/cors.ts";
import { verifyApiToken, requireScope } from "./_shared/api-auth.ts";
import { sendTextMessage, sendTemplateMessage } from "./_shared/whatsapp-service.ts";

function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...extra },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Only POST is supported" }, 405);

  const auth = await verifyApiToken(req, "/send-whatsapp");
  if (!auth.ok) return json({ error: auth.error }, auth.status, auth.headers ?? {});

  const scopeErr = requireScope(auth.token, "whatsapp:send");
  if (scopeErr) return json({ error: scopeErr.error }, scopeErr.status);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const { phone_number_id, to, message_type, text, template } = body || {};

  if (!to) return json({ error: "الحقل to مطلوب" }, 400);
  if (!message_type || !["text", "template"].includes(message_type)) {
    return json({ error: "message_type يجب أن يكون 'text' أو 'template'" }, 400);
  }
  if (message_type === "text" && !text) {
    return json({ error: "الحقل text مطلوب لرسائل message_type=text" }, 400);
  }
  if (message_type === "template" && !template?.name) {
    return json({ error: "template.name مطلوب لرسائل message_type=template" }, 400);
  }

  try {
    const result =
      message_type === "text"
        ? await sendTextMessage({ userId: auth.token.user_id, phoneNumberId: phone_number_id, to, text })
        : await sendTemplateMessage({ userId: auth.token.user_id, phoneNumberId: phone_number_id, to, template });

    return json(result, result.ok ? 200 : result.status || 502);
  } catch (err: any) {
    console.error("[send-whatsapp] error:", err);
    return json({ error: err?.message || "فشل إرسال الرسالة" }, 500);
  }
});
