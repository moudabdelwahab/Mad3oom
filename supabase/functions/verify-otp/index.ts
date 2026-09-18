// supabase/functions/verify-otp/index.ts
// التحقق من رمز تيليجرام لمرة واحدة.
//
// ما كان معطوبًا هنا (H-02 في FULL_PROJECT_AUDIT.md) — وثلاثتها مُصلَحة أدناه:
//
//   ① الهوية كانت تأتي من **جسم الطلب** (`userId`) بلا أي JWT، والدالة منشورة
//      بـ‎verify_jwt = false. أي أن أي جهة على الإنترنت كانت تستطيع التحقق
//      نيابةً عن أي مستخدم بمجرد معرفة معرّفه. الآن الهوية من التوكن وحده،
//      و`userId` في الجسم يُتجاهَل تمامًا.
//
//   ② فحص `attempts >= 5` كان يقع **بعد** نجاح مطابقة الهاش. والمحاولة الخاطئة
//      لا تصل إليه أصلًا (تخرج عند `!otpData`)، فالفحص لم يكن يخنق شيئًا على
//      الإطلاق. الآن البوابة تُستشار قبل أي مطابقة.
//
//   ③ لا حدّ لكل IP. الآن هناك حدّ (أفضل جهد) داخل نفس البوابة.
//
// ولماذا المنطق في القاعدة لا هنا: `public.otp_attempt_gate` قابلة للاختبار
// بـSQL داخل transaction ويُتراجَع عنها، بينما منطقٌ محبوس في دالة حافة لا
// يُختبر إلا فوق HTTP على Production. القرار هناك، وهذه الدالة تستهلكه.
//
// ملاحظة تشغيلية مهمة: هذا المسار **لم ينجح ولا مرة في Production**. الواجهة
// كانت ترسل `{ userId, code }` والدالة تقرأ `{ userId, otp }`، فكانت تخرج دائمًا
// بـ400 "Missing data" — و`telegram_auth_logs` كان فارغًا تمامًا تأكيدًا لذلك.
// نقبل الاسمين معًا حتى لا يتعلّق الإصلاح على ترتيب نشر الواجهة.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")

const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!)

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
    status,
  })
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders })
  }

  try {
    // ── الهوية من التوكن، لا من الجسم ────────────────────────────────
    //
    // ‎verify_jwt = true‎ على البوابة يردّ الطلبات بلا توكن، لكنه يقبل مفتاح
    // anon أيضًا لأنه JWT صالح شكلًا. لذلك لا نكتفي به: نطلب من طبقة المصادقة
    // أن تحلّ **مستخدمًا** من التوكن، ومفتاح anon لا يحلّ إلى مستخدم.
    const authHeader = req.headers.get("Authorization") || ""
    const token = authHeader.toLowerCase().startsWith("bearer ")
      ? authHeader.slice(7).trim()
      : ""

    if (!token) {
      return json({ success: false, message: "يجب تسجيل الدخول أولًا" }, 401)
    }

    const { data: authData, error: authError } = await supabase.auth.getUser(token)
    const userId = authData?.user?.id

    if (authError || !userId) {
      return json({ success: false, message: "جلسة غير صالحة. سجّل الدخول مرة أخرى." }, 401)
    }

    const body = await req.json().catch(() => ({}))
    // نقبل `otp` و`code`: الواجهة كانت ترسل الثاني والدالة تقرأ الأول.
    const otp = String(body?.otp ?? body?.code ?? "").trim()

    const ip = req.headers.get("x-real-ip") || req.headers.get("x-forwarded-for") || "unknown"
    const userAgent = req.headers.get("user-agent") || "unknown"

    if (!otp) {
      return json({ success: false, message: "أدخل رمز التحقق" }, 400)
    }

    // ── البوابة أولًا: قبل الهاش وقبل أي مطابقة ──────────────────────
    const { data: gate, error: gateError } = await supabase.rpc("otp_attempt_gate", {
      p_user_id: userId,
      p_ip: ip,
    })

    if (gateError) {
      // البوابة هي الخانق. تعذُّر استشارتها يعني أننا لا نعرف إن كان هذا تخمينًا
      // متسلسلًا — فنفشل **مغلقين**. الرفض هنا يعطّل تسجيل دخول مشروعًا مؤقتًا،
      // وقبوله يفتح تخمينًا بلا سقف. الأول أرخص.
      console.error("[verify-otp] تعذّر استشارة otp_attempt_gate:", gateError.message)
      return json({ success: false, message: "تعذّر التحقق الآن. حاول بعد قليل." }, 503)
    }

    if (!gate?.allowed) {
      await supabase.rpc("otp_log_attempt", {
        p_user_id: userId,
        p_action: "otp_blocked",
        p_ip: ip,
        p_user_agent: userAgent,
        p_details: { reason: gate?.reason ?? "unknown" },
      })

      return json({
        success: false,
        message: "تم تجاوز عدد المحاولات المسموح بها. اطلب رمزًا جديدًا بعد قليل.",
      }, 429)
    }

    // ── المطابقة ─────────────────────────────────────────────────────
    const otpHash = await hashString(otp)

    const { data: otpData, error: otpError } = await supabase
      .from("admin_telegram_otps")
      .select("id")
      .eq("user_id", userId)
      .eq("otp_hash", otpHash)
      .eq("is_used", false)
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    if (otpError || !otpData) {
      await supabase.rpc("increment_otp_attempts", { target_user_id: userId })
      await supabase.rpc("otp_log_attempt", {
        p_user_id: userId,
        p_action: "otp_failed",
        p_ip: ip,
        p_user_agent: userAgent,
        p_details: null,
      })

      return json({ success: false, message: "رمز التحقق غير صحيح أو انتهت صلاحيته" }, 401)
    }

    // الاستهلاك مشروط بـ‎is_used = false‎ حتى لا يُستهلك الرمز مرتين لو وصل
    // طلبان متوازيان — الخاسر منهما يجد صفر صفوف ويُعامَل كفشل.
    const { data: consumed, error: consumeError } = await supabase
      .from("admin_telegram_otps")
      .update({ is_used: true, ip_address: ip, user_agent: userAgent })
      .eq("id", otpData.id)
      .eq("is_used", false)
      .select("id")

    if (consumeError || !consumed || consumed.length === 0) {
      await supabase.rpc("otp_log_attempt", {
        p_user_id: userId,
        p_action: "otp_failed",
        p_ip: ip,
        p_user_agent: userAgent,
        p_details: { reason: "already_consumed" },
      })

      return json({ success: false, message: "رمز التحقق غير صحيح أو انتهت صلاحيته" }, 401)
    }

    await supabase.rpc("otp_log_attempt", {
      p_user_id: userId,
      p_action: "otp_verified",
      p_ip: ip,
      p_user_agent: userAgent,
      p_details: null,
    })

    return json({ success: true }, 200)

  } catch (err) {
    // لا نُعيد نص الخطأ للعميل: كان يسرّب تفاصيل داخلية.
    console.error("[verify-otp] خطأ غير متوقع:", err instanceof Error ? err.message : String(err))
    return json({ success: false, message: "تعذّر التحقق الآن. حاول بعد قليل." }, 500)
  }
})

async function hashString(str: string) {
  const msgUint8 = new TextEncoder().encode(str)
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgUint8)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("")
}
