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

// ── التسعير المصدَّر (Meta — بطاقة أسعار مصر، سارية 1 أكتوبر 2026) ──
// المصدر: Meta for Developers, "Pricing on the WhatsApp Business Platform"
// — بطاقة أسعار USD سارية 2026-10-01 (رُوجعت من الصفحة الرسمية وملف PDF
// الخاص بها في 2026-11-23): مصر سوق مستقل — Marketing 0.0644، Utility
// 0.0036، Authentication 0.0036، Service 0.0036 دولار للرسالة المسلَّمة.
// الأسعار بالدولار كما هي من Meta — بلا مصاريف مدعوم وبلا سعر صرف ثابت.
// الجنيه يُحسب وقت المحاسبة فقط: سعر الدولار × سعر صرف البنك المركزي
// الحي، عبر دالة fx-rate (supabase/functions/fx-rate — البنك المركزي
// أولًا، ثم Frankfurter، ثم ذاكرة fx_rates؛ الترحيل 126). التفصيل الكامل
// في الترحيل 125 وفي docs/whatsapp-pricing-egypt-2026-10-01.md
// (ريبو whatsapp-mad3oom). الشرائح الحجمية لا تُطبَّق: تبدأ من 100,001
// رسالة مرافق شهريًا.
export const META_EGYPT_RATES_USD = Object.freeze({
  marketing: 0.0644,
  utility: 0.0036,
  authentication: 0.0036,
  service: 0.0036,
});
export const META_RATE_CARD_EFFECTIVE = "2026-10-01";

export interface BillingSettings {
  chargeEnabled: boolean;
  enforce: boolean;
  // الأسعار بالدولار (مفاتيح integration_settings) — الجنيه يُحسب وقت
  // المحاسبة عبر getUsdEgpRate()، لا يُخزَّن هنا.
  templateChargeUsd: number;
  textChargeUsd: number;
}

/** يقرأ الإعدادات من نفس الجدول الذي يقرؤه integrations-api. يفشل مفتوحًا عمدًا:
 *  تعذُّر قراءة إعداد محاسبي لا يجوز أن يمنع رسالة عميل. */
export async function loadBillingSettings(): Promise<BillingSettings> {
  try {
    const { data, error } = await db()
      .from("integration_settings")
      .select("key, value")
      .in("key", ["wallet_charge_enabled", "wallet_enforce_send", "template_charge_usd", "text_charge_usd"]);
    if (error) throw error;

    const map = new Map<string, unknown>((data || []).map((r: Record<string, unknown>) => [r.key as string, r.value]));
    return {
      chargeEnabled: map.get("wallet_charge_enabled") !== false,
      enforce: map.get("wallet_enforce_send") === true,
      // الافتراضيات بالدولار من بطاقة Meta لمصر (انظر الثوابت أعلاه):
      // قالب (يتبع سعر المرافق) 0.0036، نصية (خدمة بعد الشريحة) 0.0036.
      // القيمة المخزَّنة في integration_settings (الترحيل 125) هي المرجع؛
      // الافتراضي هنا شبكة أمان فقط عند غياب الصف.
      templateChargeUsd: Number(map.get("template_charge_usd") ?? 0.0036),
      textChargeUsd: Number(map.get("text_charge_usd") ?? 0.0036),
    };
  } catch (err) {
    console.error("[wa-billing] settings read failed, defaulting to metering-only:", (err as Error).message);
    return { chargeEnabled: true, enforce: false, templateChargeUsd: 0.0036, textChargeUsd: 0.0036 };
  }
}

// ── سعر الصرف الحي (دولار → جنيه) وقت المحاسبة ──
// المصدر الوحيد هو دالة fx-rate (البنك المركزي المصري أولًا، ثم
// Frankfurter، ثم ذاكرة fx_rates). عند تعذّر الدالة يُقرأ آخر سعر
// مخزَّن مباشرة من fx_rates؛ وعند تعذّر كل شيء يرجع null — والمنادي
// يفشل مفتوحًا (رسالة بلا خصم) بدل منع رسالة عميل أو خصم بسعر قديم
// صامت. لا يوجد سعر صرف ثابت في هذا الملف إطلاقًا.
export async function getUsdEgpRate(): Promise<{ rate: number; source: string; asOf: string } | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/fx-rate`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          apikey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        },
        signal: ctrl.signal,
      });
      if (res.ok) {
        const data = await res.json() as { usd_egp?: unknown; source?: unknown; as_of?: unknown };
        const rate = Number(data.usd_egp);
        if (Number.isFinite(rate) && rate > 0) {
          return { rate, source: String(data.source ?? "fx-rate"), asOf: String(data.as_of ?? "") };
        }
      }
      console.warn("[wa-billing] fx-rate HTTP", res.status, "— falling back to fx_rates table");
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    console.warn("[wa-billing] fx-rate call failed, falling back to fx_rates table:", (err as Error).message);
  }
  try {
    const { data, error } = await db()
      .from("fx_rates")
      .select("rate, source, as_of")
      .eq("base", "USD")
      .eq("quote", "EGP")
      .order("as_of", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (data && Number(data.rate) > 0) {
      return { rate: Number(data.rate), source: `cache:${data.source}`, asOf: String(data.as_of) };
    }
  } catch (err) {
    console.error("[wa-billing] fx_rates fallback read failed:", (err as Error).message);
  }
  return null;
}

/** يحوّل مبلغًا بالدولار إلى جنيه بسعر الصرف الحي. null = لا سعر متاح. */
export async function toEgp(usdAmount: number): Promise<number | null> {
  const fx = await getUsdEgpRate();
  if (!fx) return null;
  return Math.round(usdAmount * fx.rate * 100) / 100;
}

/** سعر القالب بالجنيه وقت المحاسبة: 0 عند تعذّر سعر الصرف (فشل مفتوح). */
export async function resolveTemplateCharge(settings: BillingSettings): Promise<number> {
  if (!settings.chargeEnabled) return 0;
  const egp = await toEgp(settings.templateChargeUsd);
  if (egp === null) {
    console.error("[wa-billing] no FX rate available, skipping template charge (fail-open)");
    return 0;
  }
  return egp;
}

// ── الشريحة المجانية لرسائل الخدمة (Meta، من 1 أكتوبر 2026) ──
// لكل رقم أعمال 1,000 رسالة خدمة مسلَّمة مجانًا شهريًا؛ تُحاسَب الرسالة
// رقم 1,001 فما بعد بسعر الخدمة. تُصفَّر الشريحة شهريًا في 12 ليلًا
// بتوقيت حساب المراسلة (هنا: Africa/Cairo — الأرقام مصرية)، ولا تُرحَّل
// الرسائل غير المستعملة. المصدر: صفحة أسعار Meta الرسمية، قسم
// "Free tier of monthly service messages".
export const SERVICE_FREE_TIER_PER_MONTH = 1000;

// إزاحة Africa/Cairo عن UTC (بالمللي ثانية) في لحظة معينة، عبر Intl.
function cairoOffsetMsAt(utcMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Africa/Cairo", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const v = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const wallAsUtc = Date.UTC(v("year"), v("month") - 1, v("day"), v("hour") % 24, v("minute"), v("second"));
  return wallAsUtc - utcMs;
}

// أول الشهر الحالي 00:00 بتوقيت Africa/Cairo، كـ ISO (UTC).
// تُؤخذ الإزاحة من منتصف الشهر — بعيدًا عن أي انتقال توقيت صيفي، وهي
// نفس إزاحة أول الشهر في Africa/Cairo (الانتقالات آخر الشهر دائمًا).
export function cairoMonthStartIso(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Africa/Cairo", year: "numeric", month: "2-digit",
  }).formatToParts(now);
  const v = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const year = v("year"), month = v("month");
  const offsetMs = cairoOffsetMsAt(Date.UTC(year, month - 1, 15, 12, 0, 0));
  return new Date(Date.UTC(year, month - 1, 1, 0, 0, 0) - offsetMs).toISOString();
}

/**
 * كم رسالة خدمة مسلَّمة استهلكها هذا الرقم هذا الشهر؟ تُعدّ الرسائل
 * الصادرة (text/media) غير الفاشلة التي قبلتها Meta (sent/delivered/read).
 * عند أي خطأ في القراءة تُرجع 0 (فشل مفتوح): قراءة قياس فاشلة لا تمنع
 * ردًا على عميل ولا تخصم خطأً — والخصم الفائت أهون من المنع الخطأ.
 */
export async function countServiceMessagesUsedThisMonth(params: {
  userId: string;
  wabaId: string | null;
}): Promise<number> {
  try {
    let query = db()
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("user_id", params.userId)
      .eq("direction", "outbound")
      .in("message_type", ["text", "media"])
      .neq("status", "failed")
      .in("delivery_status", ["sent", "delivered", "read"])
      .gte("created_at", cairoMonthStartIso());
    if (params.wabaId) query = query.eq("waba_id", params.wabaId);
    const { count, error } = await query;
    if (error) throw error;
    return count ?? 0;
  } catch (err) {
    console.error("[wa-billing] service allowance count failed, treating as within free tier:", (err as Error).message);
    return 0;
  }
}

/**
 * سعر رسالة الخدمة (نصية/وسائط) لهذا الرقم في هذا الشهر بالجنيه: صفر
 * داخل الشريحة المجانية (أول 1,000 رسالة خدمة مسلَّمة شهريًا لكل رقم)،
 * وسعر الخدمة بالدولار × سعر الصرف الحي بعدها. صفر أيضًا عند تعذّر سعر
 * الصرف (فشل مفتوح — يُسجَّل). لا يرمي أبدًا.
 */
export async function resolveServiceCharge(params: {
  userId: string;
  wabaId: string | null;
  settings: BillingSettings;
}): Promise<number> {
  if (!params.settings.chargeEnabled) return 0;
  const used = await countServiceMessagesUsedThisMonth({ userId: params.userId, wabaId: params.wabaId });
  if (used < SERVICE_FREE_TIER_PER_MONTH) return 0;
  const egp = await toEgp(params.settings.textChargeUsd);
  if (egp === null) {
    console.error("[wa-billing] no FX rate available, skipping service charge (fail-open)");
    return 0;
  }
  return egp;
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
