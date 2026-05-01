import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const ZOHO_MAIL_API_URL = "https://mail.zoho.com/api/accounts";
const FROM_EMAIL = "tickets@mad3oom.online";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, content-type",
};

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

    // ملاحظة: يتطلب Zoho Mail استخدام OAuth2 Access Token
    // سنفترض وجود ZOHO_ACCESS_TOKEN في متغيرات البيئة أو استخدامه عبر API Key إذا كان متاحاً
    // في Zoho Mail API، نحتاج أولاً لـ Account ID
    const ZOHO_TOKEN = Deno.env.get("ZOHO_ACCESS_TOKEN");
    const ZOHO_ACCOUNT_ID = Deno.env.get("ZOHO_ACCOUNT_ID");

    if (!ZOHO_TOKEN || !ZOHO_ACCOUNT_ID) {
      console.error("Zoho configuration missing");
      // سنقوم بتسجيل الخطأ ولكن سنرجع استجابة ناجحة للـ Trigger لتجنب التعليق
      return new Response(JSON.stringify({ success: false, error: "Zoho config missing" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      });
    }

    const response = await fetch(`${ZOHO_MAIL_API_URL}/${ZOHO_ACCOUNT_ID}/messages`, {
      method: "POST",
      headers: {
        "Authorization": `Zoho-oauthtoken ${ZOHO_TOKEN}`,
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
