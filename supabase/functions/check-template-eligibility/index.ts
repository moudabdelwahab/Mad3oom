import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

type EligibilityCheckRequest = {
  phone_numbers: string[];
  phone_number_id?: string;
};

type EligibilityResult = {
  phone: string;
  window_open: boolean;
  last_inbound_at?: string;
  hours_remaining?: number;
};

const SESSION_WINDOW_HOURS = 24;

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

    const token = authHeader.split(' ')[1];
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');

    if (!supabaseUrl || !supabaseAnonKey) {
      return new Response(JSON.stringify({ error: 'Server misconfiguration' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      },
      global: {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    });

    // Get current user
    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const userId = user.id;
    const body = (await req.json()) as EligibilityCheckRequest;
    const { phone_numbers } = body;

    if (!phone_numbers || !Array.isArray(phone_numbers) || phone_numbers.length === 0) {
      return new Response(JSON.stringify({ error: 'phone_numbers array is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Get billing status
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false }
    });

    const { data: integrations, error: intError } = await adminClient
      .from('integrations')
      .select('metadata')
      .eq('user_id', userId)
      .eq('provider', 'whatsapp')
      .limit(1);

    let hasBilling = false;
    if (!intError && integrations && integrations.length > 0) {
      const metadata = integrations[0].metadata as any;
      // Check if billing info exists (currency field indicates billing is set up)
      hasBilling = !!metadata?.currency || !!metadata?.billing_event_type;
    }

    // Check 24-hour window for each phone number
    const results: EligibilityResult[] = [];

    for (const phone of phone_numbers) {
      const { data: userState, error: stateError } = await adminClient
        .from('bot_user_states')
        .select('last_inbound_message_at')
        .eq('user_id', userId)
        .eq('phone_number', phone)
        .maybeSingle();

      let lastInbound = userState?.last_inbound_message_at;

      // Fallback: Check messages table
      if (!lastInbound) {
        const { data: lastMsg } = await adminClient
          .from('messages')
          .select('timestamp')
          .eq('user_id', userId)
          .eq('from_number', phone)
          .eq('direction', 'inbound')
          .order('timestamp', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (lastMsg) {
          lastInbound = lastMsg.timestamp;
        }
      }

      let windowOpen = false;
      let hoursRemaining = 0;

      if (lastInbound) {
        const lastInboundDate = new Date(lastInbound);
        const now = new Date();
        const diffHours = (now.getTime() - lastInboundDate.getTime()) / (1000 * 60 * 60);

        windowOpen = diffHours < SESSION_WINDOW_HOURS;
        hoursRemaining = Math.max(0, SESSION_WINDOW_HOURS - diffHours);

        results.push({
          phone,
          window_open: windowOpen,
          last_inbound_at: lastInboundDate.toISOString(),
          hours_remaining: parseFloat(hoursRemaining.toFixed(2))
        });
      } else {
        results.push({
          phone,
          window_open: false,
          hours_remaining: 0
        });
      }
    }

    // Determine overall eligibility
    const openWindows = results.filter(r => r.window_open).length;
    const closedWindows = results.filter(r => !r.window_open).length;

    let eligibilityStatus = 'eligible';
    let message = '';

    if (closedWindows > 0 && !hasBilling) {
      eligibilityStatus = 'requires_billing';
      message = `${closedWindows} رقم يحتاج وسيلة دفع (لا توجد محادثة مفتوحة خلال 24 ساعة)`;
    } else if (closedWindows > 0 && hasBilling) {
      eligibilityStatus = 'will_charge';
      message = `${closedWindows} رقم سيتم خصم تكلفة الرسالة منهم (لا توجد محادثة مفتوحة خلال 24 ساعة)`;
    } else if (openWindows > 0) {
      eligibilityStatus = 'free';
      message = `جميع الأرقام لديها محادثات مفتوحة - الإرسال مجاني`;
    }

    return new Response(JSON.stringify({
      success: true,
      eligibility_status: eligibilityStatus,
      message,
      has_billing: hasBilling,
      open_windows: openWindows,
      closed_windows: closedWindows,
      results
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[check-template-eligibility] Unhandled error', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
