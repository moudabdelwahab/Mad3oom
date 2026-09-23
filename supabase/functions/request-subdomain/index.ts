import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const RESERVED = new Set([
  "www", "api", "mail", "ftp", "admin", "app", "ns1", "ns2",
  "mad3oom", "support", "help", "blog", "status", "cdn", "assets",
]);

const NAME_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// ── Root domain ──────────────────────────────────────────────────────────────
// Default is mad3oom.com. CLOUDFLARE_ZONE_ID must point at the mad3oom.com
// zone, since the DNS record is created in that zone under this root.
// SUBDOMAIN_ROOT_DOMAIN overrides it without a redeploy.
// See docs/DOMAIN-MIGRATION.md.
const ROOT_DOMAIN = Deno.env.get("SUBDOMAIN_ROOT_DOMAIN") ?? "mad3oom.com";

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

function validateName(name: string): string | null {
  if (!name || name.length < 2 || name.length > 63) {
    return "الاسم يجب أن يكون بين 2 و 63 حرف";
  }
  if (!NAME_REGEX.test(name)) {
    return "الاسم يجب أن يحتوي على حروف إنجليزية صغيرة وأرقام وشرطات فقط، ولا يبدأ أو ينتهي بشرطة";
  }
  if (RESERVED.has(name)) {
    return "هذا الاسم محجوز، اختر اسمًا آخر";
  }
  return null;
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

  // ---- لازم يكون مستخدم مسجل دخول (أي صلاحية، مش بالضرورة أدمن) ----
  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");

  const { data: callerData, error: callerError } = await supabase.auth.getUser(jwt);
  if (callerError || !callerData?.user) {
    return jsonResponse({ error: "غير مصرح، يرجى تسجيل الدخول" }, 401);
  }

  const userId = callerData.user.id;

  let payload: { name?: string };
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const rawName = (payload.name ?? "").trim().toLowerCase();

  const validationError = validateName(rawName);
  if (validationError) {
    return jsonResponse({ error: validationError }, 400);
  }

  // ---- منع تكرار الطلب: عميل لا يقدر يبعت طلب جديد لو عنده طلب pending قائم بالفعل ----
  const { data: existingPending } = await supabase
    .from("subdomain_request_queue")
    .select("id, requested_name")
    .eq("user_id", userId)
    .eq("status", "pending")
    .maybeSingle();

  if (existingPending) {
    return jsonResponse({
      error: `لديك طلب قيد المراجعة بالفعل (${existingPending.requested_name}.${ROOT_DOMAIN}). يرجى انتظار مراجعته قبل إرسال طلب جديد.`,
    }, 409);
  }

  // ---- تأكد إن الاسم مش مستخدم فعليًا أو محجوز في طلب آخر معلّق ----
  const { data: existingDomain } = await supabase
    .from("subdomain_requests")
    .select("id")
    .eq("subdomain", rawName)
    .is("deleted_at", null)
    .maybeSingle();

  if (existingDomain) {
    return jsonResponse({ error: "هذا النطاق الفرعي مستخدم بالفعل" }, 409);
  }

  const { data: existingRequest } = await supabase
    .from("subdomain_request_queue")
    .select("id")
    .eq("requested_name", rawName)
    .eq("status", "pending")
    .maybeSingle();

  if (existingRequest) {
    return jsonResponse({ error: "يوجد طلب معلّق بالفعل بنفس الاسم" }, 409);
  }

  // ---- تسجيل الطلب ----
  const { data: row, error: insertError } = await supabase
    .from("subdomain_request_queue")
    .insert({
      user_id: userId,
      requested_name: rawName,
      status: "pending",
    })
    .select()
    .single();

  if (insertError) {
    return jsonResponse({ error: "فشل تسجيل الطلب", details: insertError.message }, 500);
  }

  // إشعار اختياري للعميل بتأكيد استلام الطلب
  await supabase.from("notifications").insert({
    user_id: userId,
    title: "تم استلام طلب النطاق الفرعي",
    message: `تم استلام طلبك لإنشاء النطاق الفرعي ${rawName}.${ROOT_DOMAIN}، وسيتم مراجعته من الإدارة قريبًا.`,
    type: "subdomain",
    link: null,
  }).then(() => {}).catch(() => {});

  return jsonResponse({
    success: true,
    id: row.id,
    message: `تم تسجيل طلبك لإنشاء النطاق الفرعي ${rawName}.${ROOT_DOMAIN}، وسيتم مراجعته قريبًا`,
  });
});
