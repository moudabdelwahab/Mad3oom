import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const ZOHO_MAIL_API_URL = "https://mail.zoho.com/api/accounts";
const ZOHO_TOKEN_URL = "https://accounts.zoho.com/oauth/v2/token";
const FROM_EMAIL = "tickets@mad3oom.online";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, content-type",
};

async function getAccessToken() {
  const refreshToken = Deno.env.get("ZOHO_REFRESH_TOKEN");
  const clientId = Deno.env.get("ZOHO_CLIENT_ID");
  const clientSecret = Deno.env.get("ZOHO_CLIENT_SECRET");

  if (!refreshToken || !clientId || !clientSecret) {
    throw new Error("Zoho OAuth credentials missing");
  }

  const params = new URLSearchParams();
  params.append("refresh_token", refreshToken);
  params.append("client_id", clientId);
  params.append("client_secret", clientSecret);
  params.append("grant_type", "refresh_token");

  const response = await fetch(ZOHO_TOKEN_URL, {
    method: "POST",
    body: params,
  });

  const data = await response.json();
  if (!data.access_token) {
    throw new Error("Failed to refresh Zoho access token: " + JSON.stringify(data));
  }
  return data.access_token;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const payload = await req.json();
    const { event, ticket_number, title, status, customer_email, customer_name, message } = payload;

    if (!customer_email) {
      throw new Error("Customer email is missing");
    }

    let subject = "";
    let content = "";

    const statusMap: Record<string, string> = {
      'open': 'مفتوحة',
      'in-progress': 'قيد المعالجة',
      'resolved': 'محلولة'
    };

    if (event === 'INSERT') {
      subject = `تم إنشاء تذكرة جديدة #${ticket_number}: ${title}`;
      content = `مرحباً ${customer_name || 'عميلنا العزيز'}،\n\nتم استلام تذكرتك بنجاح.\nرقم التذكرة: #${ticket_number}\nالعنوان: ${title}\nالحالة: مفتوحة\n\nسنقوم بالرد عليك في أقرب وقت ممكن.`;
    } else if (event === 'UPDATE') {
      subject = `تحديث حالة التذكرة #${ticket_number}`;
      content = `مرحباً ${customer_name || 'عميلنا العزيز'}،\n\nتم تحديث حالة تذكرتك #${ticket_number} إلى: ${statusMap[status] || status}.\n\nشكراً لتواصلك معنا.`;
    } else if (event === 'REPLY') {
      subject = `رد جديد على التذكرة #${ticket_number}`;
      content = `مرحباً ${customer_name || 'عميلنا العزيز'}،\n\nهناك رد جديد من فريق الدعم على تذكرتك #${ticket_number}:\n\n"${message}"\n\nيمكنك متابعة التذكرة عبر المنصة.`;
    }

    const accessToken = await getAccessToken();
    const accountId = Deno.env.get("ZOHO_ACCOUNT_ID");

    if (!accountId) {
      throw new Error("Zoho Account ID missing");
    }

    const response = await fetch(`${ZOHO_MAIL_API_URL}/${accountId}/messages`, {
      method: "POST",
      headers: {
        "Authorization": `Zoho-oauthtoken ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        fromAddress: FROM_EMAIL,
        toAddress: customer_email,
        subject: subject,
        content: content,
      }),
    });

    const result = await response.json();

    return new Response(JSON.stringify({ success: true, data: result }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (error) {
    console.error("Error:", error.message);
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 400,
    });
  }
});
