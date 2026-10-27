import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { callerHas } from "../_shared/caller-authority.js";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders() });
}

async function isDomainResponding(fullDomain: string): Promise<boolean> {
  try {
    const res = await fetch(`https://${fullDomain}`, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(6000),
    });
    // أي رد HTTP (حتى 404/401) يعني السيرفر استجاب فعليًا والـ DNS + SSL يعملان
    return res.status > 0;
  } catch {
    return false;
  }
}

async function notifyClient(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  userId: string,
  title: string,
  message: string
) {
  await supabase.from("notifications").insert({
    user_id: userId,
    title,
    message,
    type: "subdomain",
    link: null,
  }).then(() => {}).catch(() => {});
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders() });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  // ---- المتصل لازم يكون مسجّل دخول ----
  // كانت الدالة مفتوحة بالكامل: أي شخص مجهول يبعت id لصف propagating كان
  // يقدر ينقله لـ success ويبعت إشعار لصاحبه. التحقق من الـ DNS نفسه كان
  // بيحد الأثر لكنه ما كانش بيصرّح بالانتقال ده.
  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) {
    return jsonResponse({ error: "غير مصرح، يرجى تسجيل الدخول" }, 401);
  }

  const { data: callerData, error: callerError } = await supabase.auth.getUser(jwt);
  if (callerError || !callerData?.user) {
    return jsonResponse({ error: "غير مصرح، يرجى تسجيل الدخول" }, 401);
  }
  const callerId = callerData.user.id;

  let payload: { id?: string };
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const id = (payload.id ?? "").trim();
  if (!id) {
    return jsonResponse({ error: "يجب تحديد النطاق المطلوب فحصه" }, 400);
  }

  const { data: row, error: fetchError } = await supabase
    .from("subdomain_requests")
    .select("id, full_domain, status, user_id")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();

  if (fetchError || !row) {
    return jsonResponse({ error: "النطاق المطلوب غير موجود" }, 404);
  }

  // ---- المتصل لازم يكون الأدمن أو صاحب الطلب نفسه ----
  // نفس نموذج الصلاحيات الموجود بالفعل: create-subdomain و manage-subdomain
  // بيطلبوا is_admin()، وde بيسمح كمان لصاحب النطاق يتابع حالة نطاقه هو.
  // مفيش أي دور جديد اتضاف.
  // is_admin() بجلسة المنادي — الأدمن، أو مالك المنصة في سياق owner/admin (115)
  const isAdmin = await callerHas("is_admin", authHeader);
  const isOwner = row.user_id === callerId;

  if (!isAdmin && !isOwner) {
    // نفس رد "غير موجود" المستخدم أعلاه، عشان ما نأكدش لغير المصرّح له
    // إن الصف ده موجود أصلاً.
    return jsonResponse({ error: "النطاق المطلوب غير موجود" }, 404);
  }

  // لو النطاق أصلًا مفعّل أو في حالة لا تستدعي الفحص، رجّع وضعه الحالي فقط
  if (row.status !== "propagating") {
    return jsonResponse({ success: true, status: row.status, propagated: row.status === "success" });
  }

  const responding = await isDomainResponding(row.full_domain);

  if (!responding) {
    return jsonResponse({ success: true, status: "propagating", propagated: false });
  }

  // ---- تأكد الانتشار: تحديث الحالة وإرسال إشعار التفعيل ----
  // شرط status='propagating' في التحديث نفسه يمنع إرسال إشعار مكرر لو وصل
  // طلبان في نفس اللحظة (الاستطلاع من الواجهة كل 5 ثوانٍ).
  const { data: updated } = await supabase
    .from("subdomain_requests")
    .update({
      status: "success",
      activated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("status", "propagating")
    .select("id");

  if (row.user_id && updated && updated.length > 0) {
    await notifyClient(
      supabase,
      row.user_id,
      "تم تفعيل النطاق الفرعي",
      `تم تفعيل النطاق الفرعي ${row.full_domain} بنجاح، وهو الآن متاح للاستخدام.`
    );
  }

  return jsonResponse({ success: true, status: "success", propagated: true });
});
