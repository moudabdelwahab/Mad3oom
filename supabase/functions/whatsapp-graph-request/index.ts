import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { decryptSecret } from "./_shared/crypto.ts";

const GRAPH_VERSION = "v25.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// Operations that represent an actual outbound WhatsApp message being sent
// (as opposed to media upload, template management, billing, profile, or
// contact-verification calls). Only these persist a row to `messages` after
// a successful Graph API response.
const MESSAGE_SEND_OPS = new Set(["sendText", "sendMedia", "sendTemplate"]);

// Derives the message_type / message_text pair that whatsapp-webhook and the
// rest of the Inbox pipeline expect, for each send operation's payload.
function deriveMessageFields(operation: string, payload: Record<string, any>) {
  if (operation === "sendText") {
    return { message_type: "text", message_text: payload.text || "" };
  }
  if (operation === "sendMedia") {
    return { message_type: payload.type || "document", message_text: payload.caption || "" };
  }
  if (operation === "sendTemplate") {
    return { message_type: "template", message_text: `[template] ${payload.templateName || ""}` };
  }
  return { message_type: "text", message_text: "" };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "missing_auth" }, 401);

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData?.user) return jsonResponse({ error: "unauthorized" }, 401);
    const userId = userData.user.id;

    const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const contentType = req.headers.get("content-type") || "";
    let operation: string;
    let payload: Record<string, any> = {};
    let uploadFile: File | null = null;

    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      operation = String(form.get("operation") || "");
      const f = form.get("file");
      if (f instanceof File) uploadFile = f;
    } else {
      const body = await req.json().catch(() => ({}));
      operation = body.operation;
      payload = body.payload || {};
    }

    const ALLOWED_OPS = new Set([
      "sendText",
      "sendMedia",
      "uploadMedia",
      "sendTemplate",
      "getTemplates",
      "createTemplate",
      "deleteTemplate",
      "getBillingStatus",
      "updateBusinessProfile",
      "verifyContacts",
    ]);
    if (!ALLOWED_OPS.has(operation)) {
      return jsonResponse({ error: "unsupported_operation" }, 400);
    }

    // token-migration: DONE. The plaintext `access_token` fallback that used to
    // live here is gone, as the TODO it carried instructed. Verified read-only
    // on production before removal: every `integrations` row of provider
    // 'whatsapp' has `encrypted_access_token`, and no row is plaintext-only —
    // so the fallback was already unreachable. migrations/032 then nulls the
    // legacy column outright, which is why this function no longer selects it:
    // reading a credential we refuse to use only widens its blast radius.
    const { data: rows, error: fetchError } = await adminClient
      .from("integrations")
      .select("encrypted_access_token, metadata")
      .eq("user_id", userId)
      .eq("provider", "whatsapp");

    if (fetchError) {
      console.error("integrations fetch error:", fetchError.message);
      return jsonResponse({ error: "fetch_failed" }, 500);
    }

    const phoneNumberId = payload.phone_number_id;
    const integration = phoneNumberId
      ? rows?.find((r: any) => r.metadata?.phone_number_id === phoneNumberId)
      : rows?.[0];

    if (!integration || !integration.encrypted_access_token) {
      return jsonResponse({ error: "not_connected" }, 404);
    }

    let accessToken: string;
    try {
      accessToken = await decryptSecret(integration.encrypted_access_token);
    } catch (decErr) {
      console.error("Failed to decrypt access token:", (decErr as Error).message);
      return jsonResponse({ error: "decryption_failed" }, 500);
    }

    const targetPhoneId = integration.metadata?.phone_number_id;
    const wabaId = integration.metadata?.waba_account_id;

    async function graphFetch(path: string, options: RequestInit = {}) {
      const headers = new Headers(options.headers || {});
      headers.set("Authorization", `Bearer ${accessToken}`);
      const res = await fetch(`${GRAPH_BASE}${path}`, { ...options, headers });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        throw new Error(data.error?.message || `Graph API HTTP ${res.status}`);
      }
      return data;
    }

    let result: unknown;

    switch (operation) {
      case "sendText": {
        result = await graphFetch(`/${targetPhoneId}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to: payload.to,
            type: "text",
            text: { preview_url: true, body: payload.text },
          }),
        });
        break;
      }
      case "sendMedia": {
        const media: Record<string, any> = { id: payload.mediaId };
        if (payload.caption && ["image", "video", "document"].includes(payload.type)) {
          media.caption = payload.caption;
        }
        if (payload.fileName && payload.type === "document") media.filename = payload.fileName;
        result = await graphFetch(`/${targetPhoneId}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to: payload.to,
            type: payload.type,
            [payload.type]: media,
          }),
        });
        break;
      }
      case "uploadMedia": {
        if (!uploadFile) return jsonResponse({ error: "missing_file" }, 400);
        const fd = new FormData();
        fd.append("messaging_product", "whatsapp");
        fd.append("file", uploadFile, uploadFile.name || "upload");
        result = await graphFetch(`/${targetPhoneId}/media`, { method: "POST", body: fd });
        break;
      }
      case "sendTemplate": {
        result = await graphFetch(`/${targetPhoneId}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to: payload.to,
            type: "template",
            template: {
              name: payload.templateName,
              language: { code: payload.languageCode },
              components: payload.components || [],
            },
          }),
        });
        break;
      }
      case "getTemplates": {
        if (!wabaId) return jsonResponse({ error: "missing_waba_id" }, 400);
        result = await graphFetch(`/${wabaId}/message_templates`);
        break;
      }
      case "createTemplate": {
        if (!wabaId) return jsonResponse({ error: "missing_waba_id" }, 400);
        result = await graphFetch(`/${wabaId}/message_templates`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: payload.name,
            category: payload.category,
            language: payload.language,
            components: payload.components,
          }),
        });
        break;
      }
      case "deleteTemplate": {
        if (!wabaId) return jsonResponse({ error: "missing_waba_id" }, 400);
        result = await graphFetch(
          `/${wabaId}/message_templates?name=${encodeURIComponent(payload.templateName)}`,
          { method: "DELETE" }
        );
        break;
      }
      case "getBillingStatus": {
        if (!wabaId) return jsonResponse({ error: "missing_waba_id" }, 400);
        result = await graphFetch(`/${wabaId}?fields=currency,message_template_namespace`);
        break;
      }
      case "updateBusinessProfile": {
        result = await graphFetch(`/${targetPhoneId}/whatsapp_business_profile`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messaging_product: "whatsapp", ...payload.profileData }),
        });
        break;
      }
      case "verifyContacts": {
        result = await graphFetch(`/${targetPhoneId}/contacts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ blocking: "wait", contacts: payload.contacts, force_check: true }),
        });
        break;
      }
    }

    // ── Persist outbound message (manual-send persistence fix) ──────────
    // Meta has already accepted the message at this point (graphFetch() would
    // have thrown otherwise, which is caught below and returns an error
    // response without ever reaching here). Persistence uses the same
    // service-role-backed insert shape whatsapp-webhook uses for inbound/bot
    // messages, so the Inbox's existing fetch/Realtime/normalizer pipeline
    // picks these rows up with no changes needed there.
    //
    // This is intentionally its own try/catch: a failure here must never turn
    // an already-successful Meta send into an error response to the caller —
    // the customer already received the message regardless of whether this
    // insert succeeds.
    let persistedMessage: Record<string, any> | null = null;
    if (MESSAGE_SEND_OPS.has(operation)) {
      try {
        const { message_type, message_text } = deriveMessageFields(operation, payload);
        const waMessageId = (result as any)?.messages?.[0]?.id || null;

        const { data: inserted, error: insertError } = await adminClient
          .from("messages")
          .insert({
            user_id: userId,
            from_number: integration.metadata?.phone_number || targetPhoneId,
            to_number: payload.to,
            message_text,
            message_type,
            direction: "outbound",
            status: "sent",
            delivery_status: "sent",
            waba_id: targetPhoneId,
            timestamp: new Date().toISOString(),
            wa_message_id: waMessageId,
            client_id: payload.client_id || null,
            raw_data: result,
          })
          .select()
          .single();

        if (insertError) {
          console.error(JSON.stringify({
            event: "whatsapp_graph_request.persist_failed",
            user_id: userId,
            operation,
            error: insertError.message,
          }));
        } else {
          persistedMessage = inserted;
        }
      } catch (persistErr) {
        console.error(JSON.stringify({
          event: "whatsapp_graph_request.persist_failed",
          user_id: userId,
          operation,
          error: (persistErr as Error).message,
        }));
      }
    }

    return jsonResponse({
      success: true,
      data: result,
      message: persistedMessage,
    });
  } catch (err) {
    console.error("whatsapp-graph-request error:", (err as Error).message);
    return jsonResponse({ error: "unexpected_error", message: (err as Error).message }, 500);
  }
});
