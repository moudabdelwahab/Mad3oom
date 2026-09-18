const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

Deno.serve(async (req) => {
  // التعامل مع CORS
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // قراءة الرسالة
    const { message } = await req.json();

    if (!message) {
      return new Response(JSON.stringify({ error: "Message is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // قراءة التوكن
    const HF_API_KEY = Deno.env.get("HUGGINGFACE_API_KEY");

    if (!HF_API_KEY) {
      return new Response(JSON.stringify({ error: "Hugging Face API Key not configured" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // اختيار الموديل
    const modelId = "HuggingFaceH4/zephyr-7b-beta";

    // 🧠 Prompt احترافي
    const prompt = `
أنت موظف خدمة عملاء محترف.

قواعد:
- رد باللهجة المصرية
- خليك واضح ومختصر
- لو مش فاهم السؤال قول: مش فاهم قصدك
- متخترعش معلومات

سؤال العميل:
${message}
`;

    // إرسال الطلب لـ Hugging Face
    const response = await fetch(
      `https://api-inference.huggingface.co/models/${modelId}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${HF_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          inputs: prompt,
          parameters: {
            max_new_tokens: 200,
            temperature: 0.5,
            return_full_text: false
          }
        }),
      }
    );

    // 🔥 معالجة الأخطاء من Hugging Face
    if (!response.ok) {
      const errorText = await response.text();
      console.log("HF HTTP ERROR:", errorText);

      return new Response(JSON.stringify({
        reply: "البوت مش متاح حالياً، حاول تاني بعد شوية"
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    const result = await response.json();
    console.log("HF RESPONSE:", result);

    // 🔥 استخراج الرد بشكل آمن
    let reply = "مفيش رد";

    if (Array.isArray(result)) {
      reply = result[0]?.generated_text || reply;
    } else if (result.generated_text) {
      reply = result.generated_text;
    } else if (result.error) {
      return new Response(JSON.stringify({
        reply: "البوت بيجهز نفسه، جرب تاني بعد شوية"
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // الرد النهائي
    return new Response(JSON.stringify({ reply }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });

  } catch (error) {
    console.error("SERVER ERROR:", error);

    return new Response(JSON.stringify({
      reply: "حصل خطأ غير متوقع، حاول تاني"
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
});
