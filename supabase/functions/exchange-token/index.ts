import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { encryptSecret } from "./_shared/crypto.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Subscribes the مدعوم app to a WABA's webhooks (messages, message status,
// etc). This is what makes inbound messages/status updates start flowing
// to the whatsapp-webhook function — without it, sending still works but
// nothing is ever received. Meta's POST /{waba-id}/subscribed_apps is
// naturally idempotent: calling it again for an already-subscribed WABA
// still returns { success: true }, so no "already subscribed" special-case
// is needed. Failure here must never fail the overall onboarding — it is
// logged and onboarding still completes, since the phone/WABA link itself
// is more important than this one side effect succeeding on the first try.
async function subscribeAppToWaba(wabaId: string, accessToken: string) {
  try {
    const response = await fetch(
      `https://graph.facebook.com/v25.0/${wabaId}/subscribed_apps`,
      { method: "POST", headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const data = await response.json();
    if (!response.ok || data.error) {
      console.error("subscribed_apps failed for WABA", wabaId, JSON.stringify(data));
      return { subscribed: false, error: data.error || data };
    }
    console.log("subscribed_apps ok for WABA", wabaId, JSON.stringify(data));
    return { subscribed: true, result: data };
  } catch (error) {
    console.error("subscribed_apps request threw for WABA", wabaId, error.message);
    return { subscribed: false, error: error.message };
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ success: false, message: "Authorization header is required" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 401 }
      );
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData?.user) {
      return new Response(
        JSON.stringify({ success: false, message: "Unauthorized" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 401 }
      );
    }
    const userId = userData.user.id;

    const body = await req.json();
    const code = body.code;

    if (!code) {
      return new Response(
        JSON.stringify({ success: false, message: "Authorization code is required" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400 }
      );
    }

    const FB_APP_ID     = Deno.env.get("FB_APP_ID") || "";
    const FB_APP_SECRET = Deno.env.get("FB_APP_SECRET") || "";

    const tokenResponse = await fetch("https://graph.facebook.com/v25.0/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id:     FB_APP_ID,
        client_secret: FB_APP_SECRET,
        code:          code,
      }).toString(),
    });

    const tokenData = await tokenResponse.json();
    console.log("Token exchange result:", JSON.stringify({
      success: !tokenData.error,
      token_type: tokenData.token_type,
      expires_in: tokenData.expires_in,
      error: tokenData.error,
    }));

    if (tokenData.error) {
      return new Response(
        JSON.stringify({ success: false, error: tokenData.error }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400 }
      );
    }

    const access_token = tokenData.access_token;
    const authFetch = (url: string) =>
      fetch(url, { headers: { Authorization: `Bearer ${access_token}` } });

    let waba_account_id = null;
    let phone_number_id = null;
    let phone_number    = null;

    const wabaDirectResponse = await authFetch(
      `https://graph.facebook.com/v25.0/me/whatsapp_business_accounts`
    );
    const wabaDirectData = await wabaDirectResponse.json();

    if (wabaDirectData.data && wabaDirectData.data.length > 0) {
      waba_account_id = wabaDirectData.data[0].id;
    }

    if (!waba_account_id) {
      const businessesResponse = await authFetch(
        `https://graph.facebook.com/v25.0/me/businesses?fields=id,name,whatsapp_business_accounts`
      );
      const businessesData = await businessesResponse.json();

      if (businessesData.data && businessesData.data.length > 0) {
        const business = businessesData.data[0];

        if (business.whatsapp_business_accounts?.data?.length > 0) {
          waba_account_id = business.whatsapp_business_accounts.data[0].id;
        } else {
          const wabaResponse = await authFetch(
            `https://graph.facebook.com/v25.0/${business.id}/whatsapp_business_accounts`
          );
          const wabaData = await wabaResponse.json();
          if (wabaData.data && wabaData.data.length > 0) {
            waba_account_id = wabaData.data[0].id;
          }
        }
      }
    }

    if (!waba_account_id) {
      const debugResponse = await fetch(
        `https://graph.facebook.com/v25.0/debug_token?input_token=${access_token}&access_token=${FB_APP_ID}|${FB_APP_SECRET}`
      );
      const debugData = await debugResponse.json();

      const scopes = debugData.data?.granular_scopes || [];
      for (const scope of scopes) {
        if (scope.scope === "whatsapp_business_management" && scope.target_ids?.length > 0) {
          waba_account_id = scope.target_ids[0];
          break;
        }
      }
    }

    if (waba_account_id) {
      const phonesResponse = await authFetch(
        `https://graph.facebook.com/v25.0/${waba_account_id}/phone_numbers?fields=id,display_phone_number,verified_name`
      );
      const phonesData = await phonesResponse.json();

      if (phonesData.data && phonesData.data.length > 0) {
        phone_number_id = phonesData.data[0].id;
        phone_number    = phonesData.data[0].display_phone_number;
      }
    }

    console.log("Discovery result - WABA:", waba_account_id, "Phone ID:", phone_number_id);

    if (!phone_number_id) {
      return new Response(
        JSON.stringify({ success: false, message: "لم يتم العثور على رقم واتساب مرتبط بهذا الحساب" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 422 }
      );
    }

    // Subscribe the app to this WABA's webhooks right after a successful
    // Embedded Signup discovery, so inbound messages start flowing without
    // any extra manual step. Best-effort: never blocks/fails onboarding.
    let webhookSubscription = null;
    if (waba_account_id) {
      webhookSubscription = await subscribeAppToWaba(waba_account_id, access_token);
    }

    const encryptedToken = await encryptSecret(access_token);
    const connectedAt = new Date().toISOString();

    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: existing, error: findError } = await adminClient
      .from("integrations")
      .select("id")
      .eq("user_id", userId)
      .eq("provider", "whatsapp")
      .eq("phone", phone_number)
      .maybeSingle();

    if (findError) {
      console.error("Lookup error:", findError.message);
    }

    const row = {
      user_id: userId,
      provider: "whatsapp",
      phone: phone_number,
      encrypted_access_token: encryptedToken,
      token_type: tokenData.token_type || "Bearer",
      expires_in: tokenData.expires_in,
      metadata: {
        phone_number_id,
        waba_account_id,
        phone_number,
        connected_at: connectedAt,
      },
    };

    let saveError;
    if (existing?.id) {
      ({ error: saveError } = await adminClient
        .from("integrations")
        .update(row)
        .eq("id", existing.id));
    } else {
      ({ error: saveError } = await adminClient.from("integrations").insert(row));
    }

    if (saveError) {
      console.error("Failed to save integration:", saveError.message);
      return new Response(
        JSON.stringify({ success: false, message: "فشل حفظ بيانات الربط" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        waba_account_id,
        phone_number_id,
        phone_number,
        connected_at: connectedAt,
        webhook_subscribed: webhookSubscription?.subscribed ?? null,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
    );

  } catch (error) {
    console.error("Edge function error:", error.message);
    return new Response(
      JSON.stringify({ success: false, error: "unexpected_error" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 }
    );
  }
});
