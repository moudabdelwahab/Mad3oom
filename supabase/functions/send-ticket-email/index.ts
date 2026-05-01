import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const RESEND_API_URL = "https://api.resend.com/emails";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, content-type",
};

Deno.serve(async (req: Request) => {
  // Handle CORS
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const payload = await req.json();
    const { event, ticket_number, title, status, customer_email, customer_name, message } = payload;

    if (!customer_email) {
      throw new Error("Customer email is missing");
    }

    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    const emailFrom = Deno.env.get("EMAIL_FROM") || "tickets@mad3oom.online";

    if (!resendApiKey) {
      throw new Error("RESEND_API_KEY is not configured");
    }

    let subject = "";
    let htmlContent = "";

    const statusMap: Record<string, string> = {
      'open': 'مفتوحة',
      'in-progress': 'قيد المعالجة',
      'resolved': 'محلولة'
    };

    const greeting = `مرحباً ${customer_name || 'عميلنا العزيز'}،`;

    if (event === 'INSERT') {
      subject = `تم إنشاء تذكرة جديدة #${ticket_number}: ${title}`;
      htmlContent = `
        <div dir="rtl" style="font-family: sans-serif;">
          <h2>${greeting}</h2>
          <p>تم استلام تذكرتك بنجاح في منصة مدعوم.</p>
          <hr/>
          <p><strong>رقم التذكرة:</strong> #${ticket_number}</p>
          <p><strong>العنوان:</strong> ${title}</p>
          <p><strong>الحالة:</strong> مفتوحة</p>
          <hr/>
          <p>سنقوم بالرد عليك في أقرب وقت ممكن. يمكنك متابعة التذكرة عبر حسابك في المنصة.</p>
        </div>
      `;
    } else if (event === 'UPDATE') {
      subject = `تحديث حالة التذكرة #${ticket_number}`;
      htmlContent = `
        <div dir="rtl" style="font-family: sans-serif;">
          <h2>${greeting}</h2>
          <p>نود إعلامك بأنه تم تحديث حالة تذكرتك #${ticket_number}.</p>
          <hr/>
          <p><strong>الحالة الجديدة:</strong> ${statusMap[status] || status}</p>
          <hr/>
          <p>شكراً لتواصلك معنا.</p>
        </div>
      `;
    } else if (event === 'REPLY') {
      subject = `رد جديد على التذكرة #${ticket_number}`;
      htmlContent = `
        <div dir="rtl" style="font-family: sans-serif;">
          <h2>${greeting}</h2>
          <p>هناك رد جديد من فريق الدعم على تذكرتك #${ticket_number}:</p>
          <div style="background: #f4f4f4; padding: 15px; border-radius: 5px; margin: 10px 0;">
            ${message}
          </div>
          <p>يمكنك الرد ومتابعة المحادثة عبر المنصة.</p>
        </div>
      `;
    }

    const response = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: emailFrom,
        to: customer_email,
        subject: subject,
        html: htmlContent,
      }),
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(`Resend API error: ${JSON.stringify(result)}`);
    }

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
