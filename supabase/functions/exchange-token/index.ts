/**
 * =====================================================
 * supabase/functions/exchange-token/index.ts
 * Meta OAuth Token Exchange Function - Enhanced Version
 * منصة مدعوم - نسخة محسنة لجلب بيانات الواتساب
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

    let wabaInfo = {
      phone_number_id: null,
      waba_account_id: null,
      business_account_id: null,
      phone_number: null
    };

    // 2. Try Multiple Methods to get IDs
    
    // Method A: Debug Token (Fastest)
    try {
        const debugResponse = await fetch(
            `https://graph.facebook.com/debug_token?input_token=${accessToken}&access_token=${META_APP_ID}|${META_APP_SECRET}`
        );
        if (debugResponse.ok) {
            const debugData = await debugResponse.json();
            const metadata = debugData.data?.metadata;
            if (metadata) {
                wabaInfo.waba_account_id = metadata.waba_id || null;
                wabaInfo.phone_number_id = metadata.phone_number_id || null;
            }
        }
    } catch (e) { console.error("Debug token failed", e); }

    // Method B: Shared WABA Accounts (Reliable for embedded signup)
    if (!wabaInfo.waba_account_id) {
        try {
            const sharedWabaResponse = await fetch(
                `https://graph.facebook.com/v21.0/me/shared_waba_accounts?access_token=${accessToken}`
            );
            if (sharedWabaResponse.ok) {
                const sharedData = await sharedWabaResponse.json();
                if (sharedData.data && sharedData.data.length > 0) {
                    wabaInfo.waba_account_id = sharedData.data[0].id;
                }
            }
        } catch (e) { console.error("Shared WABA failed", e); }
    }

    // Method C: Client Business Accounts (Last resort)
    if (!wabaInfo.waba_account_id) {
        try {
            const bizResponse = await fetch(
                `https://graph.facebook.com/v21.0/me/accounts?access_token=${accessToken}`
            );
            if (bizResponse.ok) {
                const bizData = await bizResponse.json();
                if (bizData.data && bizData.data.length > 0) {
                    wabaInfo.business_account_id = bizData.data[0].id;
                }
            }
        } catch (e) { console.error("Biz accounts failed", e); }
    }

    // 3. Get Phone Number Details if we have WABA ID
    if (wabaInfo.waba_account_id && !wabaInfo.phone_number_id) {
        try {
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
        } catch (e) { console.error("Fetching phones from WABA failed", e); }
    }

    // 4. Final attempt to get display name/number if we only have phone_number_id
    if (wabaInfo.phone_number_id && !wabaInfo.phone_number) {
        try {
            const phoneDetailResponse = await fetch(
                `https://graph.facebook.com/v21.0/${wabaInfo.phone_number_id}?access_token=${accessToken}`
            );
            if (phoneDetailResponse.ok) {
                const phoneDetailData = await phoneDetailResponse.json();
                wabaInfo.phone_number = phoneDetailData.display_phone_number || null;
            }
        } catch (e) { console.error("Final phone detail fetch failed", e); }
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
