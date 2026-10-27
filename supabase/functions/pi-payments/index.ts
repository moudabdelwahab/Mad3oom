import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

/**
 * pi-payments — الموافقة والإتمام من جهة الخادم لمدفوعات Pi (U2A).
 *
 * تدفّق Pi: العميل ينادي Pi.createPayment داخل Pi Browser، ويستقبل
 *   onReadyForServerApproval(paymentId)   → action: "approve"
 *   onReadyForServerCompletion(paymentId, txid) → action: "complete"
 *   onCancel(paymentId)                   → action: "cancel"
 * ولوحة المالك تنادي action: "status" لتعرف هل المفتاح مضبوط.
 *
 * الحدود:
 *   • مفتاح Pi API سرّ (PI_API_KEY) لا يغادر الدالة ولا يُكتب في سجل.
 *   • الموافقة لا تثق بأي رقم من العميل: الدفعة تُقرأ من Pi نفسها، والمبلغ
 *     يُطابَق بسعر الخطة في pi_plan_prices، والشبكة بإعداد pi_settings،
 *     وصاحب الدفعة بـpi_uid المكتوب في auth.users بدور الخدمة.
 *   • الإتمام لا يفعّل اشتراكًا تلقائيًا: يبقى قرار التفعيل في مسار
 *     الاشتراكات القائم.
 */

const PI_API = "https://api.minepi.com/v2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

const NETWORK_LABEL: Record<string, string> = { testnet: "Pi Testnet", mainnet: "Pi Network" };

async function piFetch(path: string, key: string, init: RequestInit = {}) {
  const res = await fetch(`${PI_API}${path}`, {
    ...init,
    headers: { Authorization: `Key ${key}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, body };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  const url = Deno.env.get("SUPABASE_URL")!;
  const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: "Unauthorized" }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const action = String(body?.action ?? "");

  const { data: settings, error: setErr } = await admin
    .from("pi_settings").select("payments_enabled, network").eq("id", true).single();
  if (setErr || !settings) return json({ error: "Pi settings missing" }, 500);

  const key = Deno.env.get("PI_API_KEY") ?? "";

  // ── حالة التكامل: للمالك وحده ─────────────────────────────────────────────
  if (action === "status") {
    const { data: isOwner } = await userClient.rpc("is_platform_owner");
    if (isOwner !== true) return json({ error: "Forbidden" }, 403);
    let key_valid: boolean | null = null;
    if (key) {
      // فحص خفيف: Pi ترفض المفتاح غير الصالح بـ401 على هذا المسار
      const probe = await piFetch("/payments/incomplete_server_payments", key);
      key_valid = probe.status !== 401 && probe.status !== 403;
    }
    return json({ key_configured: Boolean(key), key_valid, ...settings });
  }

  if (!key) return json({ error: "Pi payments are not configured" }, 503);
  const paymentId = String(body?.paymentId ?? "").trim();
  if (!paymentId) return json({ error: "paymentId is required" }, 400);

  // ── الموافقة ─────────────────────────────────────────────────────────────
  if (action === "approve") {
    if (!settings.payments_enabled) return json({ error: "Pi payments are disabled" }, 403);

    const planId = String(body?.planId ?? "");
    const cycle = body?.cycle === "yearly" ? "yearly" : "monthly";

    const { data: price } = await admin.from("pi_plan_prices")
      .select("price_monthly_pi, price_yearly_pi").eq("plan_id", planId).maybeSingle();
    const expected = Number(cycle === "yearly" ? price?.price_yearly_pi : price?.price_monthly_pi);
    if (!expected) return json({ error: "No Pi price for this plan" }, 400);

    const piUid = user.user_metadata?.pi_uid;
    if (!piUid) return json({ error: "Account is not linked to Pi" }, 403);

    const pay = await piFetch(`/payments/${encodeURIComponent(paymentId)}`, key);
    if (!pay.ok || !pay.body) return json({ error: "Payment not found on Pi" }, 404);
    const p = pay.body;

    const problems: string[] = [];
    if (p.user_uid !== piUid) problems.push("payer mismatch");
    if (Math.abs(Number(p.amount) - expected) > 1e-7) problems.push("amount mismatch");
    if (p.network !== NETWORK_LABEL[settings.network]) problems.push("network mismatch");
    if (p.status?.cancelled || p.status?.user_cancelled) problems.push("payment cancelled");
    if (problems.length) {
      console.error("[pi-payments] approve rejected:", paymentId, problems.join(", "));
      return json({ error: "Payment does not match the plan", details: problems }, 409);
    }

    const { error: insErr } = await admin.from("pi_payments").insert({
      pi_payment_id: paymentId, user_id: user.id, pi_uid: piUid, plan_id: planId,
      billing_cycle: cycle, amount: expected, memo: p.memo ?? null,
      network: settings.network, status: "approved", approved_at: new Date().toISOString(),
    });
    if (insErr && insErr.code !== "23505") {
      console.error("[pi-payments] insert:", insErr.message);
      return json({ error: "Failed to record payment" }, 500);
    }

    const ok = await piFetch(`/payments/${encodeURIComponent(paymentId)}/approve`, key, { method: "POST" });
    if (!ok.ok) {
      await admin.from("pi_payments").update({ status: "failed", error: `approve ${ok.status}` })
        .eq("pi_payment_id", paymentId);
      return json({ error: "Pi rejected the approval" }, 502);
    }
    return json({ approved: true });
  }

  // الدفعة المسجّلة لهذا المستخدم وحده
  const { data: row } = await admin.from("pi_payments")
    .select("id, status").eq("pi_payment_id", paymentId).eq("user_id", user.id).maybeSingle();
  if (!row) return json({ error: "Payment not found" }, 404);

  // ── الإتمام ──────────────────────────────────────────────────────────────
  if (action === "complete") {
    const txid = String(body?.txid ?? "").trim();
    if (!txid) return json({ error: "txid is required" }, 400);
    if (row.status === "completed") return json({ completed: true });

    const done = await piFetch(`/payments/${encodeURIComponent(paymentId)}/complete`, key, {
      method: "POST", body: JSON.stringify({ txid }),
    });
    if (!done.ok) {
      await admin.from("pi_payments").update({ error: `complete ${done.status}` }).eq("id", row.id);
      return json({ error: "Pi rejected the completion" }, 502);
    }
    await admin.from("pi_payments").update({
      status: "completed", txid, completed_at: new Date().toISOString(), error: null,
    }).eq("id", row.id);
    return json({ completed: true });
  }

  // ── الإلغاء ──────────────────────────────────────────────────────────────
  if (action === "cancel") {
    if (row.status !== "completed") {
      await admin.from("pi_payments").update({ status: "cancelled" }).eq("id", row.id);
    }
    return json({ cancelled: true });
  }

  return json({ error: "Unknown action" }, 400);
});
