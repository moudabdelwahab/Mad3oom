import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const ROOT_DOMAIN = "mad3oom.online";
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

async function createCloudflareRecord(
  cfToken: string,
  cfZoneId: string,
  name: string
): Promise<{ ok: true; recordId: string } | { ok: false; error: string }> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${cfZoneId}/dns_records`,
    {
      method: "POST",
      headers: { "Authorization": `Bearer ${cfToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "CNAME", name, content: VERCEL_CNAME_TARGET, ttl: 3600, proxied: false }),
    }
  );
  const data = await res.json();
  if (!res.ok || !data.success) {
    return { ok: false, error: data?.errors?.[0]?.message || "فشل إنشاء سجل DNS في Cloudflare" };
  }
  return { ok: true, recordId: data.result.id };
}

async function deleteCloudflareRecord(cfToken: string, cfZoneId: string, recordId: string) {
  await fetch(
    `https://api.cloudflare.com/client/v4/zones/${cfZoneId}/dns_records/${recordId}`,
    { method: "DELETE", headers: { "Authorization": `Bearer ${cfToken}` } }
  ).catch(() => {});
}

async function addVercelDomain(
  vercelToken: string,
  vercelProjectId: string,
  vercelTeamId: string | undefined,
  fullDomain: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const url = new URL(`https://api.vercel.com/v10/projects/${vercelProjectId}/domains`);
  if (vercelTeamId) url.searchParams.set("teamId", vercelTeamId);
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "Authorization": `Bearer ${vercelToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: fullDomain }),
  });
  const data = await res.json();
  if (!res.ok) {
    return { ok: false, error: data?.error?.message || "فشل ربط النطاق بـ Vercel" };
  }
  return { ok: true };
}

async function removeVercelDomain(
  vercelToken: string,
  vercelProjectId: string,
  vercelTeamId: string | undefined,
  fullDomain: string
) {
  const url = new URL(
    `https://api.vercel.com/v9/projects/${vercelProjectId}/domains/${fullDomain}`
  );
  if (vercelTeamId) url.searchParams.set("teamId", vercelTeamId);
  await fetch(url.toString(), {
    method: "DELETE",
    headers: { "Authorization": `Bearer ${vercelToken}` },
  }).catch(() => {});
}

async function notifyClient(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  userId: string | null,
  title: string,
  message: string
) {
  if (!userId) return;
  await supabase.from("notifications").insert({
    user_id: userId,
    title,
    message,
    type: "subdomain",
    link: null,
  }).then(() => {}).catch(() => {});
}

async function logActivity(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  params: {
    subdomainId: string | null;
    subdomainName: string;
    action: string;
    performedBy: string;
    performedByEmail: string | null;
    targetClientId?: string | null;
    details?: Record<string, unknown>;
  }
) {
  await supabase.from("subdomain_activity_log").insert({
    subdomain_id: params.subdomainId,
    subdomain_name: params.subdomainName,
    action: params.action,
    performed_by: params.performedBy,
    performed_by_email: params.performedByEmail,
    target_client_id: params.targetClientId ?? null,
    details: params.details ?? null,
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

  let payload: {
    action?:
      | "list"
      | "rename"
      | "reassign"
      | "delete"
      | "search_clients"
      | "check_availability"
      | "suspend"
      | "reactivate"
      | "update_logo"
      | "recheck_propagation"
      | "list_requests"
      | "approve_request"
      | "reject_request"
      | "list_activity_log";
    id?: string;
    name?: string;
    new_name?: string;
    new_client_user_id?: string;
    q?: string;
    logo_url?: string;
    request_id?: string;
    rejection_note?: string;
    custom_note?: string;
    activity_limit?: number;
  };
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const action = payload.action;

  // =========================================================
  // ACTION: check_availability — فحص توافر الاسم لحظيًا أثناء الكتابة
  // =========================================================
  if (action === "check_availability") {
    const rawName = (payload.name ?? "").trim().toLowerCase();

    const validationError = validateName(rawName);
    if (validationError) {
      return jsonResponse({ success: true, available: false, reason: validationError });
    }

    const { data: clash } = await supabase
      .from("subdomain_requests")
      .select("id, status")
      .eq("subdomain", rawName)
      .is("deleted_at", null)
      .maybeSingle();

    if (clash) {
      return jsonResponse({ success: true, available: false, reason: "هذا الاسم مستخدم بالفعل" });
    }

    return jsonResponse({ success: true, available: true });
  }

  // =========================================================
  // ACTION: search_clients — بحث عن عميل بالإيميل/الاسم (آمن، أدمن فقط)
  // =========================================================
  if (action === "search_clients") {
    const q = (payload.q ?? "").trim();
    if (q.length < 1) {
      return jsonResponse({ success: true, items: [] });
    }

    const { data, error } = await supabase
      .from("profiles")
      .select("id, email, full_name")
      .or(`email.ilike.%${q}%,full_name.ilike.%${q}%`)
      .limit(8);

    if (error) {
      return jsonResponse({ error: "فشل البحث عن العملاء", details: error.message }, 500);
    }

    return jsonResponse({ success: true, items: data });
  }

  // =========================================================
  // ACTION: list — جدول النطاقات (غير المحذوفة نهائيًا) مع بيانات العميل
  // =========================================================
  if (action === "list") {
    const { data, error } = await supabase
      .from("subdomain_requests")
      .select(`
        id, subdomain, full_domain, status, created_ip,
        activated_at, suspended_at, created_at, updated_at, last_action,
        user_id, logo_url,
        profiles:user_id ( email, full_name )
      `)
      .is("deleted_at", null)
      .order("created_at", { ascending: false });

    if (error) {
      return jsonResponse({ error: "فشل تحميل القائمة", details: error.message }, 500);
    }

    return jsonResponse({ success: true, items: data });
  }

  // =========================================================
  // ACTION: list_requests — قائمة طلبات النطاقات من العملاء (معلّقة افتراضيًا)
  // =========================================================
  if (action === "list_requests") {
    const { data, error } = await supabase
      .from("subdomain_request_queue")
      .select(`
        id, user_id, requested_name, status, note,
        reviewed_at, created_at, updated_at,
        profiles:user_id ( email, full_name )
      `)
      .order("created_at", { ascending: false });

    if (error) {
      return jsonResponse({ error: "فشل تحميل الطلبات", details: error.message }, 500);
    }

    return jsonResponse({ success: true, items: data });
  }

  // =========================================================
  // ACTION: list_activity_log — سجل كل التغييرات مع هوية الأدمن المنفّذ
  // =========================================================
  if (action === "list_activity_log") {
    const limit = Math.min(Math.max(payload.activity_limit ?? 100, 1), 300);

    const { data, error } = await supabase
      .from("subdomain_activity_log")
      .select(`
        id, subdomain_id, subdomain_name, action, details, created_at,
        performed_by, performed_by_email,
        target_client_id,
        target_profile:target_client_id ( email, full_name )
      `)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) {
      return jsonResponse({ error: "فشل تحميل سجل النشاط", details: error.message }, 500);
    }

    return jsonResponse({ success: true, items: data });
  }

  // =========================================================
  // ACTION: reject_request — رفض طلب نطاق من عميل
  // =========================================================
  if (action === "reject_request") {
    const REJECTION_REASONS = new Set([
      "الاسم غير لائق أو مسيء",
      "الاسم مكرر بشكل مضلل لجهة أخرى",
      "الاسم يخالف هوية المنصة",
      "الاسم محجوز للاستخدام الداخلي",
      "العميل لم يستوفِ شروط الاشتراك",
      "أخرى",
    ]);

    const requestId = (payload.request_id ?? "").trim();
    if (!requestId) {
      return jsonResponse({ error: "يجب تحديد الطلب المطلوب رفضه" }, 400);
    }

    const note = (payload.rejection_note ?? "").trim() || null;
    if (note && !REJECTION_REASONS.has(note) && !payload.custom_note) {
      return jsonResponse({
        error: "سبب الرفض يجب أن يكون من القائمة المحددة",
        valid_reasons: [...REJECTION_REASONS],
      }, 400);
    }

    // لو السبب "أخرى" يجب تقديم ملاحظة مخصصة
    const finalNote = note === "أخرى"
      ? ((payload.custom_note ?? "").trim() || "أخرى")
      : note;

    const { data: reqRow, error: reqFetchError } = await supabase
      .from("subdomain_request_queue")
      .select("*")
      .eq("id", requestId)
      .maybeSingle();

    if (reqFetchError || !reqRow) {
      return jsonResponse({ error: "الطلب غير موجود" }, 404);
    }
    if (reqRow.status !== "pending") {
      return jsonResponse({ error: "تمت مراجعة هذا الطلب بالفعل" }, 400);
    }

    await supabase
      .from("subdomain_request_queue")
      .update({
        status: "rejected",
        note: finalNote,
        reviewed_by: callerData.user.id,
        reviewed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", requestId);

    await notifyClient(
      supabase,
      reqRow.user_id,
      "تم رفض طلب النطاق الفرعي",
      finalNote
        ? `تم رفض طلبك لإنشاء النطاق الفرعي ${reqRow.requested_name}.mad3oom.online. السبب: ${finalNote}`
        : `تم رفض طلبك لإنشاء النطاق الفرعي ${reqRow.requested_name}.mad3oom.online.`
    );

    await logActivity(supabase, {
      subdomainId: null,
      subdomainName: `${reqRow.requested_name}.mad3oom.online`,
      action: "request_rejected",
      performedBy: callerData.user.id,
      performedByEmail: callerData.user.email ?? null,
      targetClientId: reqRow.user_id,
      details: { reason: finalNote },
    });

    return jsonResponse({ success: true, message: `تم رفض طلب ${reqRow.requested_name}` });
  }

  // =========================================================
  // ACTION: approve_request — قبول طلب عميل وإنشاء النطاق فعليًا
  // =========================================================
  if (action === "approve_request") {
    const requestId = (payload.request_id ?? "").trim();
    if (!requestId) {
      return jsonResponse({ error: "يجب تحديد الطلب المطلوب قبوله" }, 400);
    }

    const { data: reqRow, error: reqFetchError } = await supabase
      .from("subdomain_request_queue")
      .select("*")
      .eq("id", requestId)
      .maybeSingle();

    if (reqFetchError || !reqRow) {
      return jsonResponse({ error: "الطلب غير موجود" }, 404);
    }
    if (reqRow.status !== "pending") {
      return jsonResponse({ error: "تمت مراجعة هذا الطلب بالفعل" }, 400);
    }

    const approveCfToken = Deno.env.get("CLOUDFLARE_API_TOKEN")!;
    const approveCfZoneId = Deno.env.get("CLOUDFLARE_ZONE_ID")!;
    const approveVercelToken = Deno.env.get("VERCEL_API_TOKEN")!;
    const approveVercelProjectId = Deno.env.get("VERCEL_PROJECT_ID")!;
    const approveVercelTeamId = Deno.env.get("VERCEL_TEAM_ID");

    const rawName = reqRow.requested_name;
    const fullDomain = `${rawName}.${ROOT_DOMAIN}`;

    // تأكد مرة أخيرة إن الاسم لسه متاح وقت القبول الفعلي
    const validationError = validateName(rawName);
    if (validationError) {
      return jsonResponse({ error: validationError }, 400);
    }
    const { data: clash } = await supabase
      .from("subdomain_requests")
      .select("id")
      .eq("subdomain", rawName)
      .is("deleted_at", null)
      .maybeSingle();
    if (clash) {
      return jsonResponse({ error: "هذا الاسم أصبح مستخدمًا من جهة أخرى، يرجى رفض الطلب وتنبيه العميل" }, 409);
    }

    // ---- إنشاء صف النطاق الفعلي ----
    const { data: newDomainRow, error: domainInsertError } = await supabase
      .from("subdomain_requests")
      .insert({
        subdomain: rawName,
        full_domain: fullDomain,
        status: "creating",
        user_id: reqRow.user_id,
        created_ip: "client-request",
        last_action: "created",
      })
      .select()
      .single();

    if (domainInsertError) {
      return jsonResponse({ error: "فشل تسجيل النطاق", details: domainInsertError.message }, 500);
    }

    try {
      const cfResult = await createCloudflareRecord(approveCfToken, approveCfZoneId, rawName);
      if (!cfResult.ok) throw new Error(cfResult.error);

      const vercelResult = await addVercelDomain(approveVercelToken, approveVercelProjectId, approveVercelTeamId, fullDomain);
      if (!vercelResult.ok) {
        await deleteCloudflareRecord(approveCfToken, approveCfZoneId, cfResult.recordId);
        throw new Error(vercelResult.error);
      }

      await supabase
        .from("subdomain_requests")
        .update({
          status: "propagating",
          cloudflare_record_id: cfResult.recordId,
          vercel_added: true,
          updated_at: new Date().toISOString(),
        })
        .eq("id", newDomainRow.id);

      await supabase
        .from("subdomain_request_queue")
        .update({
          status: "approved",
          reviewed_by: callerData.user.id,
          reviewed_at: new Date().toISOString(),
          resulting_subdomain_id: newDomainRow.id,
          updated_at: new Date().toISOString(),
        })
        .eq("id", requestId);

      await notifyClient(
        supabase,
        reqRow.user_id,
        "تم تسجيل النطاق الفرعي",
        `تمت الموافقة على طلبك، وتم تسجيل النطاق الفرعي ${fullDomain} بنجاح، وهو الآن قيد التفعيل وسيصلك إشعار عند اكتمال التفعيل.`
      );

      await logActivity(supabase, {
        subdomainId: newDomainRow.id,
        subdomainName: fullDomain,
        action: "request_approved",
        performedBy: callerData.user.id,
        performedByEmail: callerData.user.email ?? null,
        targetClientId: reqRow.user_id,
      });

      return jsonResponse({
        success: true,
        full_domain: fullDomain,
        message: `تمت الموافقة على الطلب وتسجيل ${fullDomain}، وهو الآن قيد الانتشار`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "حدث خطأ غير متوقع أثناء إنشاء النطاق";
      await supabase
        .from("subdomain_requests")
        .update({ status: "failed", error_message: message, updated_at: new Date().toISOString() })
        .eq("id", newDomainRow.id);
      return jsonResponse({ error: message }, 500);
    }
  }

  // =========================================================
  // كل الإجراءات الباقية تحتاج id لسطر موجود
  // =========================================================
  const id = (payload.id ?? "").trim();
  if (!id) {
    return jsonResponse({ error: "يجب تحديد النطاق المطلوب" }, 400);
  }

  const { data: existingRow, error: fetchError } = await supabase
    .from("subdomain_requests")
    .select("*")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();

  if (fetchError || !existingRow) {
    return jsonResponse({ error: "النطاق المطلوب غير موجود" }, 404);
  }

  const cfToken = Deno.env.get("CLOUDFLARE_API_TOKEN")!;
  const cfZoneId = Deno.env.get("CLOUDFLARE_ZONE_ID")!;
  const vercelToken = Deno.env.get("VERCEL_API_TOKEN")!;
  const vercelProjectId = Deno.env.get("VERCEL_PROJECT_ID")!;
  const vercelTeamId = Deno.env.get("VERCEL_TEAM_ID");

  // =========================================================
  // ACTION: reassign — تغيير العميل المرتبط بنفس الدومين
  // =========================================================
  if (action === "reassign") {
    const newClientUserId = (payload.new_client_user_id ?? "").trim();
    if (!newClientUserId) {
      return jsonResponse({ error: "يجب تحديد العميل الجديد" }, 400);
    }

    const { data: newClient } = await supabase
      .from("profiles")
      .select("id, email")
      .eq("id", newClientUserId)
      .maybeSingle();

    if (!newClient) {
      return jsonResponse({ error: "العميل الجديد غير موجود" }, 404);
    }

    const { error: updateError } = await supabase
      .from("subdomain_requests")
      .update({
        user_id: newClientUserId,
        last_action: "reassigned",
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);

    if (updateError) {
      return jsonResponse({ error: "فشل تحديث العميل", details: updateError.message }, 500);
    }

    await logActivity(supabase, {
      subdomainId: existingRow.id,
      subdomainName: existingRow.full_domain,
      action: "reassigned",
      performedBy: callerData.user.id,
      performedByEmail: callerData.user.email ?? null,
      targetClientId: newClientUserId,
      details: { from_user_id: existingRow.user_id, to_user_id: newClientUserId, to_email: newClient.email },
    });

    return jsonResponse({
      success: true,
      message: `تم نقل ملكية ${existingRow.full_domain} إلى ${newClient.email}`,
    });
  }

  // =========================================================
  // ACTION: recheck_propagation — فحص يدوي فوري لانتشار DNS لنطاق معلّق
  // =========================================================
  if (action === "recheck_propagation") {
    if (existingRow.status !== "propagating") {
      return jsonResponse({
        success: true,
        status: existingRow.status,
        propagated: existingRow.status === "success",
        message: existingRow.status === "success" ? "النطاق مفعّل بالفعل" : "النطاق ليس في حالة انتظار انتشار",
      });
    }

    let responding = false;
    try {
      const res = await fetch(`https://${existingRow.full_domain}`, {
        method: "HEAD",
        redirect: "follow",
        signal: AbortSignal.timeout(6000),
      });
      responding = res.status > 0;
    } catch {
      responding = false;
    }

    if (!responding) {
      return jsonResponse({
        success: true,
        status: "propagating",
        propagated: false,
        message: "النطاق لا يزال قيد الانتشار، حاول مرة أخرى بعد قليل",
      });
    }

    await supabase
      .from("subdomain_requests")
      .update({
        status: "success",
        activated_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);

    await notifyClient(
      supabase,
      existingRow.user_id,
      "تم تفعيل النطاق الفرعي",
      `تم تفعيل النطاق الفرعي ${existingRow.full_domain} بنجاح، وهو الآن متاح للاستخدام.`
    );

    return jsonResponse({
      success: true,
      status: "success",
      propagated: true,
      message: `تم تأكيد تفعيل ${existingRow.full_domain}`,
    });
  }

  // =========================================================
  // ACTION: update_logo — تحديث/إضافة/إزالة شعار الجهة
  // =========================================================
  if (action === "update_logo") {
    const logoUrl = (payload.logo_url ?? "").trim() || null;

    const { error: updateError } = await supabase
      .from("subdomain_requests")
      .update({
        logo_url: logoUrl,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);

    if (updateError) {
      return jsonResponse({ error: "فشل تحديث الشعار", details: updateError.message }, 500);
    }

    await logActivity(supabase, {
      subdomainId: existingRow.id,
      subdomainName: existingRow.full_domain,
      action: "logo_updated",
      performedBy: callerData.user.id,
      performedByEmail: callerData.user.email ?? null,
      targetClientId: existingRow.user_id,
      details: { logo_url: logoUrl },
    });

    return jsonResponse({
      success: true,
      message: logoUrl
        ? `تم تحديث شعار ${existingRow.full_domain} بنجاح`
        : `تم إزالة شعار ${existingRow.full_domain}`,
    });
  }

  // =========================================================
  // ACTION: rename — تغيير اسم النطاق نفسه
  // =========================================================
  if (action === "rename") {
    const newRawName = (payload.new_name ?? "").trim().toLowerCase();

    const validationError = validateName(newRawName);
    if (validationError) {
      return jsonResponse({ error: validationError }, 400);
    }
    if (newRawName === existingRow.subdomain) {
      return jsonResponse({ error: "هذا هو الاسم الحالي بالفعل" }, 400);
    }

    const { data: clash } = await supabase
      .from("subdomain_requests")
      .select("id")
      .eq("subdomain", newRawName)
      .is("deleted_at", null)
      .maybeSingle();

    if (clash) {
      return jsonResponse({ error: "هذا الاسم مستخدم بالفعل من جهة أخرى" }, 409);
    }

    const newFullDomain = `${newRawName}.${ROOT_DOMAIN}`;

    try {
      // 1) remove old DNS record + vercel domain (if currently active)
      if (existingRow.cloudflare_record_id) {
        await deleteCloudflareRecord(cfToken, cfZoneId, existingRow.cloudflare_record_id);
      }
      if (existingRow.vercel_added) {
        await removeVercelDomain(vercelToken, vercelProjectId, vercelTeamId, existingRow.full_domain);
      }

      // 2) create new DNS record
      const cfResult = await createCloudflareRecord(cfToken, cfZoneId, newRawName);
      if (!cfResult.ok) throw new Error(cfResult.error);

      // 3) add new vercel domain
      const vercelResult = await addVercelDomain(vercelToken, vercelProjectId, vercelTeamId, newFullDomain);
      if (!vercelResult.ok) {
        await deleteCloudflareRecord(cfToken, cfZoneId, cfResult.recordId);
        throw new Error(vercelResult.error);
      }

      // 4) update row
      await supabase
        .from("subdomain_requests")
        .update({
          subdomain: newRawName,
          full_domain: newFullDomain,
          cloudflare_record_id: cfResult.recordId,
          vercel_added: true,
          status: "success",
          last_action: "renamed",
          error_message: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id);

      const oldFullDomain = existingRow.full_domain;

      await logActivity(supabase, {
        subdomainId: existingRow.id,
        subdomainName: newFullDomain,
        action: "renamed",
        performedBy: callerData.user.id,
        performedByEmail: callerData.user.email ?? null,
        targetClientId: existingRow.user_id,
        details: { from: oldFullDomain, to: newFullDomain },
      });

      return jsonResponse({
        success: true,
        full_domain: newFullDomain,
        message: `تم تغيير النطاق إلى ${newFullDomain} بنجاح`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "حدث خطأ غير متوقع أثناء تغيير الاسم";
      await supabase
        .from("subdomain_requests")
        .update({ status: "failed", error_message: message, updated_at: new Date().toISOString() })
        .eq("id", id);
      return jsonResponse({ error: message }, 500);
    }
  }

  // =========================================================
  // ACTION: suspend — تعطيل النطاق (تحديث الحالة فقط، بدون لمس DNS/Vercel)
  // =========================================================
  if (action === "suspend") {
    if (existingRow.status === "suspended") {
      return jsonResponse({ error: "هذا النطاق معطّل بالفعل" }, 400);
    }

    await supabase
      .from("subdomain_requests")
      .update({
        status: "suspended",
        last_action: "suspended",
        suspended_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);

    await notifyClient(
      supabase,
      existingRow.user_id,
      "تم تعطيل النطاق الفرعي",
      `تم تعطيل النطاق الفرعي ${existingRow.full_domain}، ولن يكون متاحًا حتى تتم إعادة تفعيله.`
    );

    await logActivity(supabase, {
      subdomainId: existingRow.id,
      subdomainName: existingRow.full_domain,
      action: "suspended",
      performedBy: callerData.user.id,
      performedByEmail: callerData.user.email ?? null,
      targetClientId: existingRow.user_id,
    });

    return jsonResponse({
      success: true,
      message: `تم تعطيل ${existingRow.full_domain}`,
    });
  }

  // =========================================================
  // ACTION: reactivate — إعادة تفعيل نطاق معطّل (تحديث الحالة فقط، الدومين مضاف بالفعل على Vercel)
  // =========================================================
  if (action === "reactivate") {
    if (existingRow.status !== "suspended") {
      return jsonResponse({ error: "هذا النطاق غير معطّل، لا يمكن إعادة تفعيله" }, 400);
    }

    await supabase
      .from("subdomain_requests")
      .update({
        status: "success",
        last_action: "reactivated",
        suspended_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);

    await notifyClient(
      supabase,
      existingRow.user_id,
      "تم تفعيل النطاق الفرعي",
      `تمت إعادة تفعيل النطاق الفرعي ${existingRow.full_domain} بنجاح، وهو متاح الآن للاستخدام.`
    );

    await logActivity(supabase, {
      subdomainId: existingRow.id,
      subdomainName: existingRow.full_domain,
      action: "reactivated",
      performedBy: callerData.user.id,
      performedByEmail: callerData.user.email ?? null,
      targetClientId: existingRow.user_id,
    });

    return jsonResponse({
      success: true,
      status: "success",
      message: `تمت إعادة تفعيل ${existingRow.full_domain} بنجاح`,
    });
  }

  // =========================================================
  // ACTION: delete — حذف النطاق نهائيًا (تحديث الحالة فقط؛ الدومين يبقى على Vercel وتظهر صفحة "محذوف")
  // =========================================================
  if (action === "delete") {
    await supabase
      .from("subdomain_requests")
      .update({
        status: "deleted",
        last_action: "deleted",
        deleted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);

    await notifyClient(
      supabase,
      existingRow.user_id,
      "تم حذف النطاق الفرعي",
      `تم حذف النطاق الفرعي ${existingRow.full_domain} نهائيًا.`
    );

    await logActivity(supabase, {
      subdomainId: existingRow.id,
      subdomainName: existingRow.full_domain,
      action: "deleted",
      performedBy: callerData.user.id,
      performedByEmail: callerData.user.email ?? null,
      targetClientId: existingRow.user_id,
    });

    return jsonResponse({ success: true, message: `تم حذف النطاق ${existingRow.full_domain} نهائيًا` });
  }

  return jsonResponse({ error: "إجراء غير معروف" }, 400);
});
