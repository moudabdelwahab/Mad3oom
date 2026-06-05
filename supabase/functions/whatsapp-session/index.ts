import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

type WhatsAppSessionRequest = {
  to: string;
  message: string;
  phone_number_id?: string;
};

const GRAPH_VERSION = 'v25.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Missing or invalid Authorization header' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const apiKey = authHeader.split(' ')[1];
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!supabaseUrl || !serviceRoleKey) {
      return new Response(JSON.stringify({ error: 'Server misconfiguration' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false }
    });

    // 1. Validate API Key
    const { data: keyRow, error: keyError } = await adminClient
      .from('bot_api_keys')
      .select('created_by, status')
      .eq('key_value', apiKey)
      .eq('status', 'active')
      .single();

    if (keyError || !keyRow) {
      return new Response(JSON.stringify({ error: 'Invalid or inactive API key' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const userId = keyRow.created_by;
    const body = (await req.json()) as WhatsAppSessionRequest;
    const { to, message, phone_number_id } = body;

    if (!to || !message) {
      return new Response(JSON.stringify({ error: 'to and message are required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // 2. Get WhatsApp Integration
    let query = adminClient
      .from('integrations')
      .select('access_token, metadata')
      .eq('user_id', userId)
      .eq('provider', 'whatsapp');

    if (phone_number_id) {
      // If specific phone_number_id is provided, we need to filter it from metadata
      // Since it's in a JSONB column, we might need to fetch all and filter or use JSON query
      // For simplicity, let's fetch all and find
    }

    const { data: integrations, error: intError } = await query;

    if (intError || !integrations || integrations.length === 0) {
      return new Response(JSON.stringify({ error: 'No WhatsApp integration found for this user' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    let integration = integrations[0];
    if (phone_number_id) {
      const found = integrations.find(i => i.metadata?.phone_number_id === phone_number_id);
      if (found) {
        integration = found;
      } else {
        return new Response(JSON.stringify({ error: `WhatsApp integration with phone_number_id ${phone_number_id} not found` }), {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    const accessToken = integration.access_token;
    const activePhoneNumberId = integration.metadata?.phone_number_id;

    if (!accessToken || !activePhoneNumberId) {
      return new Response(JSON.stringify({ error: 'WhatsApp integration is incomplete' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // 3. Send Message via Meta Graph API
    const whatsappResponse = await fetch(`${GRAPH_BASE}/${activePhoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { body: message }
      })
    });

    const waData = await whatsappResponse.json();

    if (!whatsappResponse.ok) {
      return new Response(JSON.stringify({ 
        error: 'Failed to send WhatsApp message', 
        details: waData.error?.message || waData 
      }), {
        status: whatsappResponse.status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // 4. Save to message history
    try {
      await adminClient.from('messages').insert({
        user_id: userId,
        from_number: integration.metadata?.phone_number || 'API',
        to_number: to,
        message_text: message,
        message_type: 'text',
        direction: 'outbound',
        status: 'sent',
        wa_message_id: waData.messages?.[0]?.id,
        timestamp: new Date().toISOString()
      });
    } catch (saveError) {
      console.error('Failed to save message to history:', saveError);
      // We don't fail the request if saving to history fails, as the message was sent
    }

    return new Response(JSON.stringify({ 
      success: true, 
      message_id: waData.messages?.[0]?.id 
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[whatsapp-session] Unhandled error', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
