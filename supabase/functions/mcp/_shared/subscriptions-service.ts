import { createClient } from "jsr:@supabase/supabase-js@2";
import type { Actor } from "./actor.ts";
import { getVisibleUserIds } from "./authz.ts";

export class ForbiddenError extends Error { constructor(m?: string) { super(m); this.name = "ForbiddenError"; } }
export class NotFoundError extends Error { constructor(m?: string) { super(m); this.name = "NotFoundError"; } }

const PLANS = ["support", "whatsapp", "bundle"];
const BILLING_CYCLES = ["monthly", "yearly"];
const PLAN_LABELS: Record<string, string> = { support: "الدعم الفني", whatsapp: "واتساب", bundle: "دعم فني + واتساب" };
const BILLING_LABELS: Record<string, string> = { monthly: "شهري", yearly: "سنوي" };

function db() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
}

function assertValidPlan(plan: string) {
  if (!PLANS.includes(plan)) throw new Error(`plan غير صالح. القيم المسموحة: ${PLANS.join(", ")}`);
}
function assertValidBillingCycle(cycle: string) {
  if (!BILLING_CYCLES.includes(cycle)) throw new Error(`billing_cycle غير صالح. القيم المسموحة: ${BILLING_CYCLES.join(", ")}`);
}
function getDurationDays(billingCycle: string): number {
  return billingCycle === "yearly" ? 365 : 30;
}
function addBillingPeriod(baseDate: Date, billingCycle: string): Date {
  const d = new Date(baseDate);
  if (billingCycle === "yearly") d.setFullYear(d.getFullYear() + 1);
  else d.setMonth(d.getMonth() + 1);
  return d;
}

function canAccessSubscription(actor: Actor, ownerId: string, ownerSuperUserId: string | null): boolean {
  if (ownerId === actor.id) return true;
  if (actor.isMainAdmin || actor.isAdmin) return true;
  return ownerSuperUserId === actor.id;
}

async function fetchSubscriptionWithOwner(subscriptionId: string) {
  const supabase = db();
  const { data: sub, error } = await supabase.from("whatsapp_subscriptions").select("*").eq("id", subscriptionId).maybeSingle();
  if (error) throw error;
  if (!sub) return null;
  const { data: owner } = await supabase.from("profiles").select("super_user_id").eq("id", (sub as any).user_id).maybeSingle();
  return { sub, ownerSuperUserId: owner?.super_user_id ?? null };
}

export async function listSubscriptions(actor: Actor, filters: { status?: string; plan?: string; limit?: number; offset?: number } = {}) {
  const supabase = db();
  const visibility = await getVisibleUserIds(actor);
  let q = supabase.from("whatsapp_subscriptions").select("*").order("created_at", { ascending: false });
  if (!visibility.all) q = q.in("user_id", visibility.ids);
  if (filters.status) q = q.eq("status", filters.status);
  if (filters.plan) q = q.eq("plan", filters.plan);
  const limit = Math.min(filters.limit ?? 20, 100);
  const offset = filters.offset ?? 0;
  q = q.range(offset, offset + limit - 1);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

export async function getSubscription(actor: Actor, subscriptionId: string) {
  if (!subscriptionId) throw new Error("الحقل subscription_id مطلوب");
  const found = await fetchSubscriptionWithOwner(subscriptionId);
  if (!found) throw new NotFoundError("الاشتراك غير موجود");
  if (!canAccessSubscription(actor, (found.sub as any).user_id, found.ownerSuperUserId)) {
    throw new ForbiddenError("لا تملك صلاحية الوصول لهذا الاشتراك");
  }
  return found.sub;
}

export async function listSubscriptionPlans() {
  const supabase = db();
  const { data: plans, error } = await supabase.from("subscription_plans").select("*").eq("is_active", true).order("sort_order", { ascending: true });
  if (error) throw error;
  const { data: features, error: featErr } = await supabase.from("plan_features").select("*");
  if (featErr) throw featErr;
  return (plans || []).map((p: any) => ({ ...p, features: (features || []).filter((f: any) => f.plan_id === p.id) }));
}

async function createSubscriptionRequest(actor: Actor, plan: string, billingCycle: string, isRenewal: boolean) {
  assertValidPlan(plan);
  assertValidBillingCycle(billingCycle);
  const supabase = db();

  const { data: existingPending, error: pendingErr } = await supabase.from("whatsapp_subscriptions").select("id").eq("user_id", actor.id).eq("plan", plan).eq("status", "pending").maybeSingle();
  if (pendingErr) throw pendingErr;
  if (existingPending) {
    throw new Error(`عندك بالفعل طلب اشتراك في خطة "${PLAN_LABELS[plan]}" قيد المراجعة. انتظر رد فريق الدعم قبل إرسال طلب جديد.`);
  }

  let previousEndDate: Date | null = null;
  if (isRenewal) {
    const nowIso = new Date().toISOString();
    const { data: active } = await supabase.from("whatsapp_subscriptions").select("end_date").eq("user_id", actor.id).eq("plan", plan).eq("status", "active").gt("end_date", nowIso).order("end_date", { ascending: false }).limit(1).maybeSingle();
    if (active?.end_date) previousEndDate = new Date(active.end_date);
  }

  const durationDays = getDurationDays(billingCycle);
  const planLabel = PLAN_LABELS[plan];
  const billingLabel = BILLING_LABELS[billingCycle];
  const durationLabel = billingCycle === "yearly" ? "سنة واحدة" : "شهر واحد";

  const placeholderStart = new Date();
  const placeholderEnd = addBillingPeriod(placeholderStart, billingCycle);

  let description: string;
  if (isRenewal && previousEndDate) {
    description = `طلب تجديد اشتراك\n\nالخطة: ${planLabel}\nنوع الفترة: ${billingLabel}\nالمدة: ${durationLabel}\nاشتراكك الحالي ينتهي في: ${previousEndDate.toLocaleString("ar-EG")}\nسيتم تمديد الاشتراك لمدة ${durationLabel} إضافية بدءًا من تاريخ الانتهاء الحالي عند تأكيد الطلب من فريق الدعم.`;
  } else if (isRenewal) {
    description = `طلب تجديد اشتراك\n\nالخطة: ${planLabel}\nنوع الفترة: ${billingLabel}\nالمدة: ${durationLabel}\nملاحظة: لم يتم العثور على اشتراك نشط حالي لهذه الخطة، سيتم احتساب المدة من تاريخ تأكيد الطلب.`;
  } else {
    description = `طلب اشتراك جديد\n\nالخطة: ${planLabel}\nنوع الفترة: ${billingLabel}\nالمدة: ${durationLabel}\nسيتم احتساب تاريخ البداية والنهاية الفعلي عند تأكيد الطلب من فريق الدعم.`;
  }

  const { data: ticket, error: ticketError } = await supabase.from("tickets").insert({ user_id: actor.id, title: `${isRenewal ? "طلب تجديد اشتراك" : "طلب اشتراك"} - ${planLabel} (${billingLabel})`, description, status: "open", priority: "high" }).select().single();
  if (ticketError) throw ticketError;

  const { data: subscription, error: subError } = await supabase.from("whatsapp_subscriptions").insert({ user_id: actor.id, ticket_id: ticket.id, plan, billing_cycle: billingCycle, start_date: placeholderStart.toISOString(), end_date: placeholderEnd.toISOString(), status: "pending", is_renewal: isRenewal, duration_days: durationDays, previous_end_date: previousEndDate ? previousEndDate.toISOString() : null }).select().single();
  if (subError) throw subError;

  return { ticket, subscription };
}

export async function createSubscription(actor: Actor, args: { plan?: string; billing_cycle?: string }) {
  if (!args?.plan) throw new Error("الحقل plan مطلوب");
  if (!args?.billing_cycle) throw new Error("الحقل billing_cycle مطلوب");
  return await createSubscriptionRequest(actor, args.plan, args.billing_cycle, false);
}

export async function renewSubscription(actor: Actor, args: { plan?: string; billing_cycle?: string }) {
  if (!args?.plan) throw new Error("الحقل plan مطلوب");
  if (!args?.billing_cycle) throw new Error("الحقل billing_cycle مطلوب");
  return await createSubscriptionRequest(actor, args.plan, args.billing_cycle, true);
}

export async function cancelSubscription(actor: Actor, subscriptionId: string) {
  if (!subscriptionId) throw new Error("الحقل subscription_id مطلوب");
  const found = await fetchSubscriptionWithOwner(subscriptionId);
  if (!found) throw new NotFoundError("الاشتراك غير موجود");
  if (!canAccessSubscription(actor, (found.sub as any).user_id, found.ownerSuperUserId)) {
    throw new ForbiddenError("لا تملك صلاحية الوصول لهذا الاشتراك");
  }

  const currentStatus = (found.sub as any).status;
  if (currentStatus !== "pending") {
    throw new Error(`لا يمكن إلغاء اشتراك حالته الحالية "${currentStatus}" - الإلغاء متاح فقط للطلبات قيد المراجعة (pending).`);
  }

  const supabase = db();
  const nowIso = new Date().toISOString();
  const { data: updated, error } = await supabase.from("whatsapp_subscriptions").update({ status: "rejected", rejection_reason: "تم الإلغاء بواسطة العميل", reviewed_by: actor.id, reviewed_at: nowIso, updated_at: nowIso }).eq("id", subscriptionId).eq("status", "pending").select().maybeSingle();
  if (error) throw error;
  if (!updated) throw new Error("تعذر الإلغاء - ربما تمت مراجعة الطلب بالفعل من فريق الدعم.");

  if ((updated as any).ticket_id) {
    try {
      const { error: ticketSyncError } = await supabase.rpc("mcp_admin_update_ticket", { p_ticket_id: (updated as any).ticket_id, p_actor_id: actor.id, p_updates: { status: "rejected", last_updated_by: actor.id, last_updated_at: nowIso } });
      if (ticketSyncError) console.error("[cancelSubscription] تعذرت مزامنة حالة التذكرة (غير حرج):", ticketSyncError.message);
    } catch (e) {
      console.error("[cancelSubscription] تعذرت مزامنة حالة التذكرة (غير حرج):", e);
    }
  }

  return updated;
}
