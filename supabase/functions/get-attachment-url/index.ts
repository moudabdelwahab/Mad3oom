import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { callerHas } from "../_shared/caller-authority.js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, accept",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "غير مصرح" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
    const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || "";

    const userToken = authHeader.replace("Bearer ", "");
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        "apikey": SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${userToken}`,
      },
    });
    if (!userRes.ok) {
      return new Response(JSON.stringify({ error: "جلسة غير صالحة" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userData = await userRes.json();
    const userId = userData.id;

    // is_admin() بجلسة المنادي — نفس مُسنَد سياسات mailbox_emails: الأدمن، أو المالك في سياق owner/admin (115)
    if (!userId || !(await callerHas("is_admin", authHeader))) {
      return new Response(JSON.stringify({ error: "غير مصرح - يتطلب صلاحية أدمن" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { email_id, attachment_id } = await req.json();
    if (!email_id || !attachment_id) {
      throw new Error("email_id و attachment_id مطلوبان");
    }

    const res = await fetch(
      `https://api.resend.com/emails/receiving/${email_id}/attachments/${attachment_id}`,
      { headers: { "Authorization": `Bearer ${RESEND_API_KEY}` } },
    );

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`فشل جلب رابط المرفق: ${errText}`);
    }

    const data = await res.json();

    return new Response(
      JSON.stringify({ download_url: data.download_url, filename: data.filename, expires_at: data.expires_at }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 },
    );
  } catch (error) {
    console.error("Error:", error.message);
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 400,
    });
  }
});
