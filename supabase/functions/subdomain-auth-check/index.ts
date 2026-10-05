import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

/**
 * subdomain-auth-check
 * ====================
 * تُستدعى من صفحة login.html بعد ما المستخدم يكمل تسجيل الدخول.
 * تتحقق أن الـ JWT المُرسَل ينتمي لصاحب الـ subdomain الموجود في الطلب.
 *
 * POST body: { subdomain: string }
 * Authorization: Bearer <supabase_access_token>
 *
 * Responses:
 *  200 { success: true }               — المستخدم هو صاحب الـ subdomain ✓
 *  403 { error: string, owner_email }  — مستخدم تاني حاول الدخول ✗
 *  404 { error: string }               — الـ subdomain مش موجود
 *  401 { error: string }               — توكن مش صحيح
 */

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: cors() });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors() });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // --- 1. التحقق من الـ JWT ---
  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  const { data: authData, error: authError } = await supabase.auth.getUser(jwt);
  if (authError || !authData?.user) {
    return json({ error: "غير مصرح، يرجى تسجيل الدخول أولاً" }, 401);
  }
  const loggedInUserId = authData.user.id;

  // --- 2. قراءة الـ subdomain من الـ body ---
  let payload: { subdomain?: string };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const subdomain = (payload.subdomain ?? "").trim().toLowerCase();
  if (!subdomain) {
    return json({ error: "يجب إرسال اسم النطاق الفرعي" }, 400);
  }

  // --- 3. جلب صاحب الـ subdomain من قاعدة البيانات ---
  const { data: subRow, error: subError } = await supabase
    .from("subdomain_requests")
    .select("user_id, status, full_domain, profiles:user_id ( email )")
    .eq("subdomain", subdomain)
    .is("deleted_at", null)
    .maybeSingle();

  if (subError || !subRow) {
    return json({ error: "النطاق الفرعي غير موجود أو تم حذفه" }, 404);
  }

  if (subRow.status === "suspended") {
    return json({ error: "هذا النطاق الفرعي موقوف مؤقتاً، يرجى التواصل مع الدعم" }, 403);
  }

  // --- 4. المقارنة: هل المستخدم الحالي هو صاحب الـ subdomain؟ ---
  if (subRow.user_id !== loggedInUserId) {
    // مستخدم تاني حاول يسجل دخول على subdomain مش حقه
    const ownerEmail = (subRow.profiles as { email?: string })?.email ?? "";
    return json(
      {
        error: `هذا النطاق الفرعي (${subRow.full_domain}) مملوك لحساب آخر. فضلاً سجّل الدخول بالحساب المالك للنطاق الفرعي.`,
        owner_hint: ownerEmail ? `الحساب المالك يبدأ بـ: ${ownerEmail.slice(0, 3)}***` : undefined,
        full_domain: subRow.full_domain,
      },
      403
    );
  }

  // --- 5. المستخدم هو الصاحب ✓ ---
  return json({
    success: true,
    message: "تم التحقق بنجاح، مرحباً بك!",
    full_domain: subRow.full_domain,
  });
});
