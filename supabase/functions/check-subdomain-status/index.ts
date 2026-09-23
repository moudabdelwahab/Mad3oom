import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Content-Type": "application/json",
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders() });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders() });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  // يدعم استدعاء GET بـ query param (?hostname=xxx) أو POST بـ JSON body
  let hostname = "";
  if (req.method === "GET") {
    const url = new URL(req.url);
    hostname = url.searchParams.get("hostname") ?? "";
  } else if (req.method === "POST") {
    try {
      const body = await req.json();
      hostname = (body.hostname ?? "").trim();
    } catch {
      return jsonResponse({ error: "Invalid JSON body" }, 400);
    }
  } else {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  hostname = hostname.trim().toLowerCase();
  // نسمح إما بالدومين الكامل (name.mad3oom.online) أو بالاسم الفرعي فقط (name)
  const subdomain = hostname.includes(".") ? hostname.split(".")[0] : hostname;

  if (!subdomain) {
    return jsonResponse({ error: "hostname مطلوب" }, 400);
  }

  const { data: row, error } = await supabase
    .from("subdomain_requests")
    .select("subdomain, full_domain, status, logo_url, user_id, deleted_at")
    .eq("subdomain", subdomain)
    .maybeSingle();

  if (error || !row) {
    return jsonResponse({ status: "not_found" }, 200);
  }

  if (row.deleted_at || row.status === "deleted") {
    return jsonResponse({ status: "deleted", full_domain: row.full_domain }, 200);
  }

  if (row.status === "suspended") {
    return jsonResponse({
      status: "suspended",
      full_domain: row.full_domain,
      logo_url: row.logo_url,
    }, 200);
  }

  if (row.status === "success") {
    return jsonResponse({
      status: "active",
      full_domain: row.full_domain,
      logo_url: row.logo_url,
      user_id: row.user_id,
    }, 200);
  }

  // creating / propagating / failed / pending — لسه مش جاهز للعرض الكامل
  return jsonResponse({
    status: "pending_setup",
    full_domain: row.full_domain,
  }, 200);
});
