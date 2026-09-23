import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ── Root domain ──────────────────────────────────────────────────────────────
// Default is mad3oom.com. CLOUDFLARE_ZONE_ID must point at the mad3oom.com
// zone, since the DNS record is created in that zone under this root.
// SUBDOMAIN_ROOT_DOMAIN overrides it without a redeploy.
// See docs/DOMAIN-MIGRATION.md.
const ROOT_DOMAIN = Deno.env.get("SUBDOMAIN_ROOT_DOMAIN") ?? "mad3oom.com";
const VERCEL_CNAME_TARGET = "cname.vercel-dns.com";

const RESERVED = new Set([
  "www", "api", "mail", "ftp", "admin", "app", "ns1", "ns2",
  "mad3oom", "support", "help", "blog", "status", "cdn", "assets",
]);

const NAME_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

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

  // ---- Authenticate caller & verify admin role ----
  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");

  const { data: callerData, error: callerError } = await supabase.auth.getUser(jwt);
  if (callerError || !callerData?.user) {
    return jsonResponse({ error: "غير مصرح، يرجى تسجيل الدخول" }, 401);
  }

  const { data: callerProfile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", callerData.user.id)
    .maybeSingle();

  if (callerProfile?.role !== "admin") {
    return jsonResponse({ error: "هذا الإجراء متاح للأدمن فقط" }, 403);
  }

  let payload: { name?: string; client_user_id?: string; logo_url?: string };
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const rawName = (payload.name ?? "").trim().toLowerCase();
  const clientUserId = (payload.client_user_id ?? "").trim();
  const logoUrl = (payload.logo_url ?? "").trim() || null;

  if (!clientUserId) {
    return jsonResponse({ error: "يجب تحديد العميل المرتبط بالنطاق" }, 400);
  }

  // Verify the client profile actually exists and grab their email for the response
  const { data: clientProfile, error: clientLookupError } = await supabase
    .from("profiles")
    .select("id, email, full_name")
    .eq("id", clientUserId)
    .maybeSingle();

  if (clientLookupError || !clientProfile) {
    return jsonResponse({ error: "العميل المحدد غير موجود" }, 404);
  }

  // ---- Validation ----
  if (!rawName) {
    return jsonResponse({ error: "اسم الجهة مطلوب" }, 400);
  }
  if (rawName.length < 2 || rawName.length > 63) {
    return jsonResponse({ error: "الاسم يجب أن يكون بين 2 و 63 حرف" }, 400);
  }
  if (!NAME_REGEX.test(rawName)) {
    return jsonResponse({
      error: "الاسم يجب أن يحتوي على حروف إنجليزية صغيرة وأرقام وشرطات فقط، ولا يبدأ أو ينتهي بشرطة",
    }, 400);
  }
  if (RESERVED.has(rawName)) {
    return jsonResponse({ error: "هذا الاسم محجوز، اختر اسمًا آخر" }, 400);
  }

  const fullDomain = `${rawName}.${ROOT_DOMAIN}`;
  const requesterIp =
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    req.headers.get("cf-connecting-ip") ||
    "unknown";

  // ---- Check existing ----
  const { data: existing } = await supabase
    .from("subdomain_requests")
    .select("id, status")
    .eq("subdomain", rawName)
    .maybeSingle();

  if (existing && existing.status === "success") {
    return jsonResponse({ error: "هذا النطاق الفرعي مُسجل بالفعل", full_domain: fullDomain }, 409);
  }

  // ---- Create / update pending row ----
  const { data: row, error: insertError } = await supabase
    .from("subdomain_requests")
    .upsert(
      {
        subdomain: rawName,
        full_domain: fullDomain,
        status: "creating",
        error_message: null,
        user_id: clientUserId,
        created_ip: requesterIp,
        last_action: "created",
        logo_url: logoUrl,
      },
      { onConflict: "subdomain" }
    )
    .select()
    .single();

  if (insertError) {
    return jsonResponse({ error: "خطأ في تسجيل الطلب", details: insertError.message }, 500);
  }

  try {
    // ---- Step 1: Cloudflare DNS record ----
    const cfToken = Deno.env.get("CLOUDFLARE_API_TOKEN")!;
    const cfZoneId = Deno.env.get("CLOUDFLARE_ZONE_ID")!;

    const cfRes = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${cfZoneId}/dns_records`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${cfToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: "CNAME",
          name: rawName,
          content: VERCEL_CNAME_TARGET,
          ttl: 3600,
          proxied: false,
        }),
      }
    );

    const cfData = await cfRes.json();

    if (!cfRes.ok || !cfData.success) {
      const msg = cfData?.errors?.[0]?.message || "فشل إنشاء سجل DNS في Cloudflare";
      throw new Error(msg);
    }

    const cfRecordId = cfData.result.id;

    // ---- Step 2: Add domain to Vercel project ----
    const vercelToken = Deno.env.get("VERCEL_API_TOKEN")!;
    const vercelProjectId = Deno.env.get("VERCEL_PROJECT_ID")!;
    const vercelTeamId = Deno.env.get("VERCEL_TEAM_ID"); // optional

    const vercelUrl = new URL(
      `https://api.vercel.com/v10/projects/${vercelProjectId}/domains`
    );
    if (vercelTeamId) vercelUrl.searchParams.set("teamId", vercelTeamId);

    const vercelRes = await fetch(vercelUrl.toString(), {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${vercelToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: fullDomain }),
    });

    const vercelData = await vercelRes.json();

    if (!vercelRes.ok) {
      // Roll back the Cloudflare record so we don't leave a dangling DNS entry
      await fetch(
        `https://api.cloudflare.com/client/v4/zones/${cfZoneId}/dns_records/${cfRecordId}`,
        {
          method: "DELETE",
          headers: { "Authorization": `Bearer ${cfToken}` },
        }
      ).catch(() => {});

      const msg = vercelData?.error?.message || "فشل ربط الدومين بمشروع Vercel";
      throw new Error(msg);
    }

    // ---- Cloudflare + Vercel succeeded: mark as propagating, not final success yet ----
    await supabase
      .from("subdomain_requests")
      .update({
        status: "propagating",
        cloudflare_record_id: cfRecordId,
        vercel_added: true,
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);

    await notifyClient(
      supabase,
      clientUserId,
      "تم تسجيل النطاق الفرعي",
      `تم تسجيل النطاق الفرعي ${fullDomain} بنجاح، وهو الآن قيد التفعيل وسيصلك إشعار عند اكتمال التفعيل.`
    );

    return jsonResponse({
      success: true,
      id: row.id,
      full_domain: fullDomain,
      client_email: clientProfile.email,
      status: "propagating",
      message: `تم تسجيل النطاق الفرعي ${fullDomain} وربطه بحساب ${clientProfile.email}، وهو الآن قيد الانتشار`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "حدث خطأ غير متوقع";

    await supabase
      .from("subdomain_requests")
      .update({
        status: "failed",
        error_message: message,
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);

    return jsonResponse({ error: message }, 500);
  }
});
