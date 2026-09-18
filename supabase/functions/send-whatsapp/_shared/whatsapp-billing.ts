// ============================================================
// whatsapp-billing.ts — ربط مسار الإرسال بالمحفظة القائمة
// ------------------------------------------------------------
// H-03: بنية المحفظة موجودة وصحيحة، لكن مسارين من ثلاثة كانا يرسلان بلا فحص
// رصيد وبلا خصم:
//   integrations-api          فحص -> Graph -> خصم   OK
//   send-whatsapp             Graph فقط            NOT OK
//   mcp (أداة send_whatsapp)  Graph فقط            NOT OK
//
// هذا الملف لا ينشئ نظام محفظة جديدًا. ينادي نفس دالتَي القاعدة اللتين
// يناديهما المسار القائم حرفيًا:
//   wa_wallet_check_sufficient(p_user_id, p_amount)
//   wa_wallet_charge_message(p_user_id, p_amount, p_description, p_ticket_id)
//
// و wa_wallet_charge_message هي المرجع الصحيح: تقفل الصف بـFOR UPDATE ثم تفحص
// الرصيد داخل القفل ثم تخصم، فلا يهبط الرصيد تحت الصفر مهما تزامنت الطلبات.
//
// الوضع الحالي: قياس أولًا. wallet_enforce_send = false (الترحيل 045) ⇒ نقص
// الرصيد يُسجَّل تحذيرًا ولا يمنع الإرسال، لأن مستأجرًا واحدًا من ثلاثة فقط
// مموَّل والحظر الفوري كان سيقطع خدمة الاثنين الآخرين. يُرفع العلَم بصفّ واحد.
//
// عدم التكرار: الخصم مرتبط بمعرّف الرسالة من ميتا، ويُكتب في وصف الحركة
// بالشكل [wa:<id>]. وقبل أي خصم نسأل إن كانت حركة بهذا المعرّف قد خُصمت.
// حدّ هذا الضمان: لو انقطع الاتصال بعد قبول ميتا وأعاد العميل الطلب، فميتا
// تنشئ رسالة جديدة بمعرّف جديد — وهي رسالة ثانية فعلية تستحق خصمًا ثانيًا.
// ============================================================
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

function db(): SupabaseClient {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
}

export interface BillingSettings {
  chargeEnabled: boolean;
  enforce: boolean;
  templateCharge: number;
  textCharge: number;
}

/** يقرأ الإعدادات من نفس الجدول الذي يقرؤه integrations-api. يفشل مفتوحًا عمدًا:
 *  تعذُّر قراءة إعداد محاسبي لا يجوز أن يمنع رسالة عميل. */
export async function loadBillingSettings(): Promise<BillingSettings> {
  try {
    const { data, error } = await db()
      .from("integration_settings")
      .select("key, value")
      .in("key", ["wallet_charge_enabled", "wallet_enforce_send", "template_charge_egp", "text_charge_egp"]);
    if (error) throw error;

    const map = new Map<string, unknown>((data || []).map((r: Record<string, unknown>) => [r.key as string, r.value]));
    return {
      chargeEnabled: map.get("wallet_charge_enabled") !== false,
      enforce: map.get("wallet_enforce_send") === true,
      templateCharge: Number(map.get("template_charge_egp") ?? 0.282),
      textCharge: Number(map.get("text_charge_egp") ?? 0),
    };
  } catch (err) {
    console.error("[wa-billing] settings read failed, defaulting to metering-only:", (err as Error).message);
    return { chargeEnabled: true, enforce: false, templateCharge: 0.282, textCharge: 0 };
  }
}

export type PreflightResult =
  | { allowed: true; metered: boolean; note?: string }
  | { allowed: false; reason: "insufficient_balance" };

/** فحص الرصيد قبل النداء الخارجي. يمنع فقط حين يكون العلَم مرفوعًا. */
export async function preflightBalance(userId: string, amount: number, s: BillingSettings): Promise<PreflightResult> {
  if (!s.chargeEnabled || amount <= 0) return { allowed: true, metered: false };

  let sufficient: boolean | null = null;
  try {
    const { data, error } = await db().rpc("wa_wallet_check_sufficient", { p_user_id: userId, p_amount: amount });
    if (error) throw error;
    sufficient = data === true;
  } catch (err) {
    console.error("[wa-billing] balance check failed:", (err as Error).message);
    return { allowed: true, metered: true, note: "balance_check_failed" };
  }

  if (sufficient) return { allowed: true, metered: true };

  if (!s.enforce) {
    console.warn(JSON.stringify({
      event: "wa_billing.insufficient_balance_allowed",
      user_id: userId, amount,
      note: "wallet_enforce_send=false",
    }));
    return { allowed: true, metered: true, note: "insufficient_balance_not_enforced" };
  }

  return { allowed: false, reason: "insufficient_balance" };
}

/** هل خُصمت هذه الرسالة من قبل؟ المفتاح هو معرّف ميتا المكتوب في الوصف. */
async function alreadyCharged(userId: string, providerMessageId: string): Promise<boolean> {
  try {
    const { data, error } = await db()
      .from("whatsapp_wallet_transactions")
      .select("id")
      .eq("user_id", userId)
      .eq("transaction_type", "message_charge")
      .like("description", `%[wa:${providerMessageId}]%`)
      .limit(1);
    if (error) throw error;
    return (data?.length ?? 0) > 0;
  } catch (err) {
    // لا نعرف ⇒ لا نخصم. تفويت خصم أهون من خصم مزدوج على عميل.
    console.error("[wa-billing] idempotency check failed, skipping charge:", (err as Error).message);
    return true;
  }
}

/**
 * الخصم بعد قبول ميتا وحده.
 * لا يرمي أبدًا: الرسالة وصلت العميل فعلًا، وقلب طلب ناجح إلى فاشل بسبب
 * المحاسبة يكذب على المنادي. الفشل يُسجَّل بشكل قابل للتنبيه عليه.
 */
export async function chargeForSentMessage(params: {
  userId: string;
  amount: number;
  providerMessageId: string | null;
  label: string;
  settings: BillingSettings;
}): Promise<void> {
  const { userId, amount, providerMessageId, label, settings } = params;
  if (!settings.chargeEnabled || amount <= 0) return;

  if (providerMessageId && (await alreadyCharged(userId, providerMessageId))) {
    console.log(JSON.stringify({ event: "wa_billing.skip_duplicate_charge", user_id: userId, wa_message_id: providerMessageId }));
    return;
  }

  const description = `${label}${providerMessageId ? ` [wa:${providerMessageId}]` : " [wa:unknown]"}`;

  try {
    const { error } = await db().rpc("wa_wallet_charge_message", {
      p_user_id: userId,
      p_amount: amount,
      p_description: description,
      p_ticket_id: null,
    });
    if (error) throw error;
    console.log(JSON.stringify({ event: "wa_billing.charged", user_id: userId, amount, wa_message_id: providerMessageId }));
  } catch (err) {
    // أهم سطر تنبيه في هذا الملف: رسالة خرجت ولم تُدفع.
    console.error(JSON.stringify({
      event: "wa_billing.charge_failed",
      user_id: userId, amount, wa_message_id: providerMessageId,
      error: (err as Error).message,
    }));
  }
}
