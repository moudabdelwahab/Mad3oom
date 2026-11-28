import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ============================================================================
// ban-user — حظر حساب ورفع الحظر مع إلغاء جلساته، عبر Auth Admin API.
// ============================================================================
//
// يحلّ محلّ التحديث المباشر من `assets/js/admin/users.js` (PostgREST على
// profiles وحده): ذلك المسار كان يكتب ban_status فقط، فلا يُلغي جلسة ولا
// يضبط `auth.users.banned_until`، فيبقى المحظور داخلًا حتى انتهاء رمزه.
//
// ما تفعله الدالة، بالترتيب:
//   1) profiles: ban_status / ban_until / ban_reason (كما كان).
//   2) Auth Admin API: updateUserById({ ban_duration }) — يكتب
//      `auth.users.banned_until`: مؤقت من ban_until، دائم 10 سنوات
//      ('87600h' مرآة Auth للحظر الدائم)، ورفع الحظر 'none'.
//      هذا ما يمنع الدخول وتحديث الرمز (refresh) بعد الحظر.
//   3) الجلسات: لا توجد نقطة نهاية Admin API لإلغاء جلسات مستخدم آخر
//      بمعرّفه — تحقّقنا من GoTrue OpenAPI (master) ومن توثيق supabase-js:
//      دالة admin signOut تأخذ JWT لا معرّف مستخدم، ولا
//      مسار `/admin/users/{id}/signout` في المواصفات. فلا ندّعي إلغاءً لم
//      يحدث: التنفيذ الفوري هو بوابة RLS (الترحيل 144 — المحظور لا يرى
//      صفًا ولا يكتب في أي جدول موبوَّب لحظة كتابة ban_status) + منع
//      التحديث/الدخول عبر banned_until. الرمز الصادر (access token) يبقى
//      صالحًا حتى انتهائه (ساعة على الأكثر بالإعداد الافتراضي) لكنه لا
//      يفتح أي بيانات. الاستجابة تردّ sessions.revoked=false مع السبب،
//      فلا تكذب الواجهة على الإداري.
//
// الصلاحية (fail-closed — الدالة تعمل بمفتاح service_role فيتجاوز RLS
// والمحفِّزات، فالحراسة هنا لا في القاعدة):
//   • مالك المنصة: is_platform_owner() + owner_critical_ok() (تحقّق
//     بخطوتين حديث — مرآة users.ban owner_step_up_default=true في 121).
//   • غيره: رتبة admin/support + staff_write_ok('users.ban').
//   • أي منادٍ آخر (عميل عادي — staff_write_ok ترجع true لغير الفريق
//     لأن «سياساته القائمة تقرر»، ففحص الرتبة إلزامي) → 403.
//   • حظر الذات مرفوض، وحظر مالك المنصة مرفوض دائمًا.
//
// استرداد المالك (موثَّق هنا وفي README.md — الحظر لا يقفل المالك خارج
// حسابه نهائيًا):
//   • الدالة ترفض حظر المالك أصلًا، والمحفِّز guard_privileged_accounts
//     (053) يرفض تغيير أعمدة حظر المالك من أي جلسة أخرى.
//   • إن وُضع حظر على المالك خارج هذين المسارين (SQL مباشر مثلًا)، فإن
//     account_is_active() ترجع false حتى للمعفى (144: NOT is_banned فوق
//     الإعفاء)، وbanned_until في Auth يمنع الدخول — والاسترداد حينها
//     بخطوتين بمفتاح service_role (انظر README: «استرداد المالك»)، وبعد
//     رفع الحظر تعود الجلسات للعمل دون إعادة دخول لأن الجلسات لم تُحذف
//     أصلًا — التحديث (refresh) ينجح ثانيةً.
//   • رفع الحظر عن غير المالك لا يحتاج إعادة دخول منه للسبب نفسه.
//
// الأسرار: لا سرّ جديد — SUPABASE_URL وSUPABASE_ANON_KEY و
// SUPABASE_SERVICE_ROLE_KEY موجودة في بيئة Edge Functions. النشر:
// `supabase functions deploy ban-user --project-ref srnelrdpqkcntbgudyto`
// (بموافقة محمود؛ ليس جزءًا من هذا الفرع).
// ============================================================================

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, accept",
};

const OWNER_EMAIL = "mahmoud@mad3oom.com";
// مرآة Auth للحظر الدائم: لا مدة «أبدية» في ban_duration، فتُستعمل 10 سنوات.
const PERMANENT_BAN_DURATION = "87600h";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const SESSIONS_NOTE =
  "لا توجد نقطة نهاية Admin API لإلغاء جلسات مستخدم آخر بمعرّفه " +
  "(auth.admin.signOut يأخذ JWT لا معرّفًا) — التنفيذ الفوري هو بوابة RLS " +
  "(144) + منع الدخول وتحديث الرمز عبر banned_until؛ الرمز الصادر يبقى " +
  "حتى انتهائه لكنه لا يفتح أي بيانات.";

function banDurationFor(banUntil: string | null): string {
  if (!banUntil) return PERMANENT_BAN_DURATION;
  const ms = new Date(banUntil).getTime() - Date.now();
  const hours = Math.max(1, Math.ceil(ms / 3_600_000));
  return `${hours}h`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // ── المُنادي ──
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData?.user) return json({ error: "Unauthorized" }, 401);
  const callerId = userData.user.id;

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ── الصلاحية: مالك (مع تحقّق بخطوتين حديث) أو فريق مع users.ban ──
  const { data: callerIsOwner } = await userClient.rpc("is_platform_owner");
  let authorized = false;
  if (callerIsOwner === true) {
    const { data: criticalOk } = await userClient.rpc("owner_critical_ok");
    if (criticalOk === true) authorized = true;
  } else {
    const { data: callerProfile } = await admin
      .from("profiles")
      .select("role")
      .eq("id", callerId)
      .maybeSingle();
    const role = callerProfile?.role;
    if (role === "admin" || role === "support") {
      const { data: banOk, error: banErr } = await userClient.rpc("staff_write_ok", {
        p_permission: "users.ban",
      });
      if (!banErr && banOk === true) authorized = true;
    }
  }
  if (!authorized) {
    return json({ error: "حظر الحسابات مقصور على مالك المنصة وفريق الإدارة المخوَّل" }, 403);
  }

  // ── قراءة الطلب والتحقق منه ──
  let body: { user_id?: unknown; action?: unknown; reason?: unknown; ban_until?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const userId = typeof body.user_id === "string" ? body.user_id.trim() : "";
  const action = body.action;
  if (!userId) return json({ error: "user_id مطلوب" }, 400);
  if (action !== "ban" && action !== "unban") {
    return json({ error: "action يجب أن يكون ban أو unban" }, 400);
  }
  if (userId === callerId) {
    return json({ error: "لا يمكنك حظر حسابك أو رفع الحظر عنه بنفسك" }, 403);
  }

  let reason: string | null = null;
  let banUntil: string | null = null;
  if (action === "ban") {
    reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!reason || reason.length < 5) {
      return json({ error: "اكتب سببًا واضحًا (5 أحرف على الأقل)" }, 400);
    }
    if (body.ban_until !== undefined && body.ban_until !== null) {
      if (typeof body.ban_until !== "string") {
        return json({ error: "ban_until يجب أن يكون تاريخًا بصيغة ISO" }, 400);
      }
      const parsed = new Date(body.ban_until);
      if (Number.isNaN(parsed.getTime())) {
        return json({ error: "ban_until ليس تاريخًا صالحًا" }, 400);
      }
      if (parsed.getTime() <= Date.now()) {
        return json({ error: "ban_until يجب أن يكون في المستقبل (حظر مؤقت)" }, 400);
      }
      banUntil = parsed.toISOString();
    }
  }

  // ── الهدف موجود؟ وليس مالك المنصة؟ ──
  const { data: target, error: targetError } = await admin
    .from("profiles")
    .select("id, email, role")
    .eq("id", userId)
    .maybeSingle();
  if (targetError) return json({ error: targetError.message }, 500);
  if (!target) return json({ error: "الحساب غير موجود" }, 404);
  const { data: targetAuthority } = await admin
    .from("platform_authority")
    .select("level")
    .eq("user_id", userId)
    .maybeSingle();
  if (
    targetAuthority?.level === "owner" ||
    target.role === "platform_owner" ||
    String(target.email ?? "").trim().toLowerCase() === OWNER_EMAIL
  ) {
    return json({ error: "لا يمكن حظر مالك المنصة — راجع «استرداد المالك» في README" }, 403);
  }

  // ── 1) profiles: الحظر/رفعه ──
  const patch = action === "ban"
    ? {
        ban_status: banUntil ? "temporary" : "permanent",
        ban_until: banUntil,
        ban_reason: reason,
      }
    : { ban_status: "none", ban_until: null, ban_reason: null };
  const { data: updated, error: updateError } = await admin
    .from("profiles")
    .update(patch)
    .eq("id", userId)
    .select("id");
  if (updateError) return json({ error: updateError.message }, 500);
  if (!updated?.length) {
    return json({ error: "لم يُنفَّذ الحظر: الحساب غير موجود" }, 404);
  }

  // ── 2) Auth Admin API: banned_until (يمنع الدخول وتحديث الرمز) ──
  // رفع الحظر 'none' يعيد التحديث للعمل بالرمز نفسه — بلا إعادة دخول.
  const banDuration = action === "ban" ? banDurationFor(banUntil) : "none";
  const { error: authError } = await admin.auth.admin.updateUserById(userId, {
    ban_duration: banDuration,
  });
  const authBanApplied = !authError;

  // ── 3) الجلسات: بلا نداء وهمي ──
  // لا نقطة نهاية Admin لإلغاء جلسات مستخدم آخر بمعرّفه (انظر الترويسة).
  // الاستجابة تسمّي ذلك صراحةً بدل sessions_revoked=true كاذبة.
  return json({
    ok: true,
    action,
    user_id: userId,
    ban_status: patch.ban_status,
    ban_until: patch.ban_until,
    auth_ban_applied: authBanApplied,
    auth_error: authError?.message ?? null,
    sessions: { revoked: false, reason: "no_admin_signout_endpoint", note: SESSIONS_NOTE },
  });
});
