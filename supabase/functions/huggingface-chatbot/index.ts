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
    const { message } = await req.json();

    if (!message) {
      return new Response(JSON.stringify({ error: 'Message is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Get API Key from environment variable or database
    // For now, we'll assume it's in environment variables for security
    const HF_API_KEY = Deno.env.get('HUGGINGFACE_API_KEY');
    
    if (!HF_API_KEY) {
      return new Response(JSON.stringify({ error: 'Hugging Face API Key not configured' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Using a strong Arabic-supporting model: ALLaM-7B-Instruct or Nile-Chat
    // We'll use ALLaM-7B-Instruct-preview as it's highly rated for Arabic
    const modelId = "humain-ai/ALLaM-7B-Instruct-preview";
    
    const response = await fetch(
      `https://api-inference.huggingface.co/models/${modelId}`,
      {
        headers: {
          Authorization: `Bearer ${HF_API_KEY}`,
          "Content-Type": "application/json",
        },
        method: "POST",
        body: JSON.stringify({
          inputs: message,
          parameters: {
            max_new_tokens: 500,
            temperature: 0.7,
            return_full_text: false
          }
        }),
      }
    );

    const result = await response.json();
    
    // Hugging Face Inference API returns an array or an object depending on the model
    let reply = "";
    if (Array.isArray(result) && result.length > 0) {
      reply = result[0].generated_text || result[0].summary_text || "لم أتمكن من توليد رد.";
    } else if (result.generated_text) {
      reply = result.generated_text;
    } else if (result.error) {
      throw new Error(result.error);
    } else {
      reply = "عذراً، حدث خطأ في معالجة الرد.";
    }

    return new Response(JSON.stringify({ reply }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});
