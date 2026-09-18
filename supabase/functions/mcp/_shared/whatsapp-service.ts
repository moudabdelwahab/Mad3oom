import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";
import {
  loadBillingSettings,
  preflightBalance,
  chargeForSentMessage,
} from "./whatsapp-billing.ts";

const GRAPH_VERSION = "v25.0";

export interface WhatsAppIntegration {
  id: string;
  user_id: string;
  access_token: string;
  phone: string | null;
  channel_id: string | null;
  metadata: Record<string, any> | null;
}

export interface SendResult {
  ok: boolean;
  status: number;
  data?: any;
  error?: string;
}

function db(): SupabaseClient {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
}

export function getWhatsAppAccessToken(integration: WhatsAppIntegration): string {
  const token = Deno.env.get("WHATSAPP_TOKEN");
  if (!token) throw new Error("WHATSAPP_TOKEN غير مُهيأ في متغيرات البيئة");
  return token;
}

export async function resolveIntegration(userId: string, phoneNumberId?: string): Promise<WhatsAppIntegration> {
  const supabase = db();
  let query = supabase.from("integrations").select("*").eq("user_id", userId).eq("provider", "whatsapp");
  if (phoneNumberId) query = query.eq("metadata->>phone_number_id", phoneNumberId);

  const { data, error } = await query;
  if (error) throw error;

  if (!data || data.length === 0) {
    throw new Error(
      phoneNumberId
        ? `لا يوجد رقم واتساب مرتبط بـ phone_number_id: ${phoneNumberId}`
        : "لا يوجد أي رقم واتساب مرتبط بهذا الحساب"
    );
  }
  if (data.length > 1) {
    throw new Error("عندك أكتر من رقم واتساب مرتبط بهذا الحساب — لازم تحديد phone_number_id صراحةً");
  }
  return data[0] as WhatsAppIntegration;
}

async function sendToGraph(phoneNumberId: string, token: string, payload: Record<string, any>): Promise<{ res: Response; data: any }> {
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

async function logMessage(params: {
  userId: string; phoneNumberId: string; to: string; text: string; messageType: string; ok: boolean; raw: any;
}) {
  try {
    const supabase = db();
    await supabase.from("messages").insert({
      user_id: params.userId,
      from_number: params.phoneNumberId,
      to_number: params.to,
      message_text: params.text,
      message_type: params.messageType,
      direction: "outbound",
      status: params.ok ? "sent" : "failed",
      waba_id: params.phoneNumberId,
      timestamp: new Date().toISOString(),
      raw_data: params.raw,
    });
  } catch (e) {
    console.error("[WhatsAppService] logMessage failed:", e);
  }
}

export interface SendTextParams { userId: string; phoneNumberId?: string; to: string; text: string; }
export interface SendTemplateParams {
  userId: string; phoneNumberId?: string; to: string;
  template: { name: string; language: string; components?: any[] };
}

export async function sendTextMessage(params: SendTextParams): Promise<SendResult> {
  if (!params.to?.trim()) return { ok: false, status: 400, error: "الرقم المستقبل (to) مطلوب" };
  if (!params.text?.trim()) return { ok: false, status: 400, error: "نص الرسالة (text) مطلوب" };

  const integration = await resolveIntegration(params.userId, params.phoneNumberId);
  const token = getWhatsAppAccessToken(integration);
  const pid = params.phoneNumberId || integration.metadata?.phone_number_id;
  if (!pid) return { ok: false, status: 400, error: "تعذر تحديد phone_number_id" };

  // ── المحفظة: فحص قبل أي نداء خارجي (H-03) ────────────────────────────────
  const settings = await loadBillingSettings();
  const amount = settings.textCharge;
  const pre = await preflightBalance(params.userId, amount, settings);
  if (!pre.allowed) {
    return { ok: false, status: 402, error: "الرصيد غير كافٍ لإرسال الرسالة. اشحن محفظة واتساب ثم أعد المحاولة." };
  }

  const payload = { messaging_product: "whatsapp", recipient_type: "individual", to: params.to, type: "text", text: { body: params.text } };
  const { res, data } = await sendToGraph(pid, token, payload);
  await logMessage({ userId: params.userId, phoneNumberId: pid, to: params.to, text: params.text, messageType: "text", ok: res.ok, raw: data });

  if (res.ok) {
    await chargeForSentMessage({
      userId: params.userId,
      amount,
      providerMessageId: data?.messages?.[0]?.id ?? null,
      label: "تكلفة رسالة نصية عبر أداة MCP",
      settings,
    });
  }

  return res.ok ? { ok: true, status: 200, data } : { ok: false, status: res.status, error: data?.error?.message || "فشل إرسال الرسالة", data };
}

export async function sendTemplateMessage(params: SendTemplateParams): Promise<SendResult> {
  if (!params.to?.trim()) return { ok: false, status: 400, error: "الرقم المستقبل (to) مطلوب" };
  if (!params.template?.name) return { ok: false, status: 400, error: "اسم التمبلت (template.name) مطلوب" };

  const integration = await resolveIntegration(params.userId, params.phoneNumberId);
  const token = getWhatsAppAccessToken(integration);
  const pid = params.phoneNumberId || integration.metadata?.phone_number_id;
  if (!pid) return { ok: false, status: 400, error: "تعذر تحديد phone_number_id" };

  // ── المحفظة: فحص قبل أي نداء خارجي (H-03) ────────────────────────────────
  // نفس سعر القالب الذي تستعمله integrations-api (template_charge_egp).
  const settings = await loadBillingSettings();
  const amount = settings.templateCharge;
  const pre = await preflightBalance(params.userId, amount, settings);
  if (!pre.allowed) {
    return { ok: false, status: 402, error: "الرصيد غير كافٍ لإرسال رسالة القالب. اشحن محفظة واتساب ثم أعد المحاولة." };
  }

  const payload = {
    messaging_product: "whatsapp", recipient_type: "individual", to: params.to, type: "template",
    template: { name: params.template.name, language: { code: params.template.language || "ar" }, components: params.template.components || [] },
  };
  const { res, data } = await sendToGraph(pid, token, payload);
  await logMessage({ userId: params.userId, phoneNumberId: pid, to: params.to, text: `[template:${params.template.name}]`, messageType: "template", ok: res.ok, raw: data });

  if (res.ok) {
    await chargeForSentMessage({
      userId: params.userId,
      amount,
      providerMessageId: data?.messages?.[0]?.id ?? null,
      label: `تكلفة رسالة قالب (${params.template.name}) عبر أداة MCP`,
      settings,
    });
  }

  return res.ok ? { ok: true, status: 200, data } : { ok: false, status: res.status, error: data?.error?.message || "فشل إرسال التمبلت", data };
}
