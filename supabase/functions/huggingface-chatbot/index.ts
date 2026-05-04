import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

Deno.serve(async (req) => {
  // Handle CORS preflight request
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { message, context = '', session_id } = await req.json();

    if (!message) {
      return new Response(JSON.stringify({ error: 'Message is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Get API Key from environment variable
    const HF_API_KEY = Deno.env.get('HUGGINGFACE_API_KEY');
    
    if (!HF_API_KEY) {
      console.error('HUGGINGFACE_API_KEY not configured');
      return new Response(JSON.stringify({ 
        error: 'Hugging Face API Key not configured',
        reply: 'عذراً، البوت غير متاح حالياً. يرجى التواصل مع فريق الدعم.'
      }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Using Zephyr-7B-Beta model (recommended for Arabic)
    // Fallback to Mistral if Zephyr is not available
    const modelId = "HuggingFaceH4/zephyr-7b-beta";
    
    // Prepare the prompt with context
    const systemPrompt = context || 'أنت مساعد ذكي من منصة مدعوم. تساعد العملاء بشكل احترافي وودود.';
    const fullPrompt = `${systemPrompt}\n\nالعميل: ${message}\n\nالمساعد:`;

    console.log(`Processing message for session: ${session_id}`);
    console.log(`Using model: ${modelId}`);

    const response = await fetch(
      `https://api-inference.huggingface.co/models/${modelId}`,
      {
        headers: {
          Authorization: `Bearer ${HF_API_KEY}`,
          "Content-Type": "application/json",
        },
        method: "POST",
        body: JSON.stringify({
          inputs: fullPrompt,
          parameters: {
            max_new_tokens: 256,
            temperature: 0.7,
            top_p: 0.95,
            return_full_text: false,
            do_sample: true
          }
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Hugging Face API error: ${response.status} - ${errorText}`);
      
      // If model is loading, return a waiting message
      if (response.status === 503) {
        return new Response(JSON.stringify({ 
          reply: 'البوت جاري تحميله الآن، يرجى المحاولة مرة أخرى في لحظات...'
        }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
      
      throw new Error(`API error: ${response.status}`);
    }

    const result = await response.json();
    
    // Parse the response based on model output format
    let reply = "";
    
    if (Array.isArray(result) && result.length > 0) {
      // Handle array response
      const firstResult = result[0];
      if (firstResult.generated_text) {
        reply = firstResult.generated_text.split('المساعد:').pop()?.trim() || firstResult.generated_text;
      } else if (firstResult.summary_text) {
        reply = firstResult.summary_text;
      } else {
        reply = JSON.stringify(firstResult);
      }
    } else if (result.generated_text) {
      // Handle object response with generated_text
      reply = result.generated_text.split('المساعد:').pop()?.trim() || result.generated_text;
    } else if (result.error) {
      // Handle error response from Hugging Face
      console.error(`Hugging Face error: ${result.error}`);
      throw new Error(result.error);
    } else {
      // Unknown response format
      console.error(`Unknown response format: ${JSON.stringify(result)}`);
      reply = "عذراً، حدث خطأ في معالجة الرد.";
    }

    // Clean up the reply
    reply = reply
      .trim()
      .replace(/^[\s\n]+/, '') // Remove leading whitespace
      .substring(0, 1000); // Limit to 1000 characters

    if (!reply) {
      reply = "عذراً، لم أتمكن من توليد رد مناسب. يرجى إعادة صياغة سؤالك.";
    }

    console.log(`Generated reply: ${reply.substring(0, 100)}...`);

    return new Response(JSON.stringify({ reply }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    });

  } catch (error) {
    console.error(`Error in huggingface-chatbot: ${error.message}`);
    
    return new Response(JSON.stringify({ 
      error: error.message,
      reply: 'عذراً، حدث خطأ في معالجة طلبك. يرجى المحاولة لاحقاً.'
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});
