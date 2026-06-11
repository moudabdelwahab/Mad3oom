/**
 * =====================================================
 * supabase/functions/exchange-token/index.ts
 * Meta OAuth Token Exchange Function
 * منصة مدعوم - وظيفة تبادل رموز Meta
 * =====================================================
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.0";

// ─── Configuration ───────────────────────────────────
const META_APP_ID = Deno.env.get("META_APP_ID") || "1510313544014876";
const META_APP_SECRET = Deno.env.get("META_APP_SECRET");

// ─── Supabase Client ─────────────────────────────────
const supabaseUrl = Deno.env.get("SUPABASE_URL");
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

const supabase = createClient(supabaseUrl!, supabaseServiceRoleKey!);

// ─── Main Handler ───────────────────────────────────

Deno.serve(async (req) => {
  // Handle CORS
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }

  try {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { code, redirect_uri } = body;

    if (!code) {
      return new Response(JSON.stringify({ error: "Missing code" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 1. Exchange code for access token with Meta
    const tokenResponse = await fetch(
      `https://graph.facebook.com/v21.0/oauth/access_token?client_id=${META_APP_ID}&client_secret=${META_APP_SECRET}&code=${code}&redirect_uri=${redirect_uri}`,
      { method: "GET" }
    );

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.json();
      console.error("Meta token exchange failed:", errorData);
      return new Response(
        JSON.stringify({
          error: "Failed to exchange code with Meta",
          details: errorData,
        }),
        {
          status: tokenResponse.status,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        }
      );
    }

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;

    // 2. Get Debug Token Info to get WABA and Phone Number ID
    const debugResponse = await fetch(
      `https://graph.facebook.com/debug_token?input_token=${accessToken}&access_token=${META_APP_ID}|${META_APP_SECRET}`
    );

    let wabaInfo = {
      phone_number_id: null,
      waba_account_id: null,
      business_account_id: null,
      phone_number: null
    };

    if (debugResponse.ok) {
      const debugData = await debugResponse.json();
      const metadata = debugData.data?.metadata;
      
      if (metadata) {
        wabaInfo.waba_account_id = metadata.waba_id || null;
        wabaInfo.phone_number_id = metadata.phone_number_id || null;
      }
    }

    // 3. Enrich data: Always try to get phone number if we have the ID or WABA
    // Even if we got IDs from debug_token, we still need the display_phone_number
    if (wabaInfo.phone_number_id) {
        const phoneDetailResponse = await fetch(
            `https://graph.facebook.com/v21.0/${wabaInfo.phone_number_id}?access_token=${accessToken}`
        );
        if (phoneDetailResponse.ok) {
            const phoneDetailData = await phoneDetailResponse.json();
            wabaInfo.phone_number = phoneDetailData.display_phone_number || null;
        }
    }

    // 4. Fallback: If still missing IDs, try to fetch from shared_waba_accounts
    if (!wabaInfo.waba_account_id) {
      const sharedWabaResponse = await fetch(
        `https://graph.facebook.com/v21.0/me/shared_waba_accounts?access_token=${accessToken}`
      );
      if (sharedWabaResponse.ok) {
        const sharedData = await sharedWabaResponse.json();
        if (sharedData.data && sharedData.data.length > 0) {
          wabaInfo.waba_account_id = sharedData.data[0].id;
          
          const phonesResponse = await fetch(
            `https://graph.facebook.com/v21.0/${wabaInfo.waba_account_id}/phone_numbers?access_token=${accessToken}`
          );
          if (phonesResponse.ok) {
            const phonesData = await phonesResponse.json();
            if (phonesData.data && phonesData.data.length > 0) {
              wabaInfo.phone_number_id = phonesData.data[0].id;
              wabaInfo.phone_number = phonesData.data[0].display_phone_number;
            }
          }
        }
      }
    }

    // Return success response
    return new Response(
      JSON.stringify({
        success: true,
        access_token: accessToken,
        token_type: tokenData.token_type || "Bearer",
        expires_in: tokenData.expires_in,
        ...wabaInfo,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  } catch (error) {
    console.error("Exchange token error:", error);
    return new Response(
      JSON.stringify({
        error: "Internal server error",
        message: error.message,
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      }
    );
  }
});
