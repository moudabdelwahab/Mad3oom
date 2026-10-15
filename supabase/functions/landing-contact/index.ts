// landing-contact — يستقبل نموذج التواصل من صفحة الهبوط md3.in
// عام عمداً (verify_jwt=false) لأن الزائر غير مسجّل، لكنه لا يكشف أي سر:
// مفتاح Resend و service role يبقيان داخل بيئة الدالة فقط.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { checkRateLimit, rateLimitResponse, restRpcClient, trustedClientIp } from "../_shared/rate-limit.js";

const RESEND_API_URL = "https://api.resend.com/emails";
const FROM_EMAIL = "no-reply@mad3oom.online"; // ضمن النطاق الموثّق في Resend
const TO_EMAIL = "support@mad3oom.online";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]!)
  );

const clean = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
  const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

  try {
    const payload = await req.json().catch(() => ({}));

    const name = clean(payload.name, 120);
    const phone = clean(payload.phone, 40);
    const email = clean(payload.email, 160).toLowerCase();
    const service = clean(payload.service, 120);
    const message = clean(payload.message, 4000);
    const website = clean(payload.website, 100); // مصيدة سبام مخفية

    // فخ العناكب: الحقل مخفي عن البشر، فامتلاؤه يعني بوت
    if (website) return json({ success: true });

    if (!name || !phone || !email) {
      return json({ error: "الاسم ورقم الجوال والبريد الإلكتروني مطلوبة" }, 400);
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json({ error: "البريد الإلكتروني غير صحيح" }, 400);
    }

    const db = async (path: string, init: RequestInit) =>
      fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
        ...init,
        headers: {
          apikey: SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
          ...(init.headers || {}),
        },
      });

    // حدّ لكل IP قبل أي كتابة أو بريد. البريد في الجسم يختاره المرسل، فحدّه
    // وحده (أدناه) يُتجاوز بتغيير العنوان. يفشل مغلقًا: نموذج عام يرسل بريدًا.
    const rate = await checkRateLimit(
      restRpcClient(SUPABASE_URL, SERVICE_ROLE_KEY), "public.form.ip", trustedClientIp(req), { failClosed: true },
    );
    if (!rate.allowed) return rateLimitResponse(rate, corsHeaders);

    // حد معدل بسيط: 3 طلبات لكل بريد خلال 10 دقائق
    const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const recent = await db(
      `landing_leads?select=id&email=eq.${encodeURIComponent(email)}&created_at=gte.${since}`,
      { method: "GET" },
    );
    if (recent.ok) {
      const rows = await recent.json();
      if (Array.isArray(rows) && rows.length >= 3) {
        return json({ error: "تم استلام طلبك بالفعل، سنتواصل معك قريباً." }, 429);
      }
    }

    // 1) تخزين الطلب — يحدث دائماً حتى لو فشل الإيميل
    const ins = await db("landing_leads", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ name, phone, email, service, message }),
    });
    if (!ins.ok) {
      const t = await ins.text();
      console.error("lead insert failed:", t);
      return json({ error: "تعذّر حفظ الطلب، حاول مرة أخرى" }, 500);
    }
    const lead = (await ins.json())?.[0] ?? null;

    // 2) إشعار بالبريد
    const subject = `طلب جديد من موقع مدعوم — ${name}`;
    const html = `
      <div dir="rtl" style="font-family:sans-serif;line-height:1.8;color:#111">
        <h2 style="margin:0 0 16px">طلب جديد من صفحة الهبوط</h2>
        <table style="border-collapse:collapse;width:100%;max-width:560px">
          <tr><td style="padding:8px;background:#f5f5f7;font-weight:bold;width:140px">الاسم</td><td style="padding:8px">${esc(name)}</td></tr>
          <tr><td style="padding:8px;background:#f5f5f7;font-weight:bold">رقم الجوال</td><td style="padding:8px" dir="ltr">${esc(phone)}</td></tr>
          <tr><td style="padding:8px;background:#f5f5f7;font-weight:bold">البريد</td><td style="padding:8px" dir="ltr">${esc(email)}</td></tr>
          <tr><td style="padding:8px;background:#f5f5f7;font-weight:bold">الخدمة</td><td style="padding:8px">${esc(service) || "—"}</td></tr>
          <tr><td style="padding:8px;background:#f5f5f7;font-weight:bold;vertical-align:top">التفاصيل</td><td style="padding:8px;white-space:pre-wrap">${esc(message) || "—"}</td></tr>
        </table>
        <p style="font-size:12px;color:#666;margin-top:18px">وصل هذا الطلب من md3.in — رقم الطلب: ${esc(lead?.id || "—")}</p>
      </div>`;

    const resendKey = Deno.env.get("RESEND_API_KEY");
    let emailed = false;
    let emailError: string | null = null;

    if (!resendKey) {
      emailError = "RESEND_API_KEY غير مضبوط";
    } else {
      const r = await fetch(RESEND_API_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: FROM_EMAIL,
          to: TO_EMAIL,
          reply_to: email,
          subject,
          html,
        }),
      });
      const result = await r.json().catch(() => ({}));
      emailed = r.ok;
      if (!r.ok) emailError = JSON.stringify(result);

      // تسجيل في نفس سجل البريد المستخدم في المنصة
      await db("mailbox_emails", {
        method: "POST",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          direction: "outbound",
          from_email: FROM_EMAIL,
          to_email: TO_EMAIL,
          subject,
          html_body: html,
          status: r.ok ? "sent" : "failed",
          provider_message_id: r.ok ? (result?.id ?? null) : null,
          error_message: r.ok ? null : JSON.stringify(result),
          is_read: r.ok ? true : false,
        }),
      }).catch((e) => console.error("mailbox log failed:", e));
    }

    if (emailError) console.error("email send failed:", emailError);

    // الطلب محفوظ في كل الأحوال، فلا نُفشل الاستجابة بسبب البريد
    return json({ success: true, stored: true, emailed });
  } catch (e) {
    console.error("landing-contact error:", e);
    return json({ error: "حدث خطأ غير متوقع" }, 500);
  }
});
