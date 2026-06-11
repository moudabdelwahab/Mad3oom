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
    const { code, redirect_uri, phone_number_id, waba_account_id } = body;

    console.log("[Exchange] Request body:", { 
      hasCode: !!code, 
      phone_number_id, 
      waba_account_id 
    });

    if (!code) {
      return new Response(JSON.stringify({ error: "Missing code" }), {
        status: 400,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    // 1. Exchange code for access token with Meta
    const tokenResponse = await fetch(
      `https://graph.facebook.com/v21.0/oauth/access_token?client_id=${META_APP_ID}&client_secret=${META_APP_SECRET}&code=${code}&redirect_uri=${redirect_uri}`,
      { method: "GET" }
    );

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.json();
      console.error("[Exchange] Meta token exchange failed:", errorData);
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

    // 2. Determine WABA and Phone IDs
    let finalWabaId = waba_account_id;
    let finalPhoneId = phone_number_id;
    let finalPhoneNumber = null;

    // 3. Fallback: If IDs are missing, fetch from Graph API
    if (!finalWabaId || !finalPhoneId) {
      console.log("[Exchange] IDs missing, attempting Fallback...");
      
      // A. Try debug_token
      try {
        const debugResponse = await fetch(
          `https://graph.facebook.com/debug_token?input_token=${accessToken}&access_token=${META_APP_ID}|${META_APP_SECRET}`
        );
        if (debugResponse.ok) {
          const debugData = await debugResponse.json();
          const metadata = debugData.data?.metadata;
          if (metadata) {
            if (!finalWabaId) finalWabaId = metadata.waba_id;
            if (!finalPhoneId) finalPhoneId = metadata.phone_number_id;
            console.log("[Exchange] Found in debug_token:", { finalWabaId, finalPhoneId });
          }
        }
      } catch (e) { console.error("[Exchange] debug_token error:", e); }

      // B. Try /me/accounts (Most reliable for WhatsApp System User/Embedded tokens)
      if (!finalWabaId) {
        try {
          const meAccountsResponse = await fetch(
            `https://graph.facebook.com/v21.0/me/accounts?access_token=${accessToken}`
          );
          if (meAccountsResponse.ok) {
            const meData = await meAccountsResponse.json();
            if (meData.data && meData.data.length > 0) {
              // Note: For WhatsApp, it might be in shared_waba_accounts instead
              // But some tokens show it here
              const account = meData.data[0];
              finalWabaId = account.id;
              console.log("[Exchange] Found in /me/accounts:", finalWabaId);
            }
          }
        } catch (e) { console.error("[Exchange] /me/accounts error:", e); }
      }

      // C. Try /me/shared_waba_accounts (Specific for Embedded Signup)
      if (!finalWabaId) {
        try {
          const sharedWabaResponse = await fetch(
            `https://graph.facebook.com/v21.0/me/shared_waba_accounts?access_token=${accessToken}`
          );
          if (sharedWabaResponse.ok) {
            const sharedData = await sharedWabaResponse.json();
            if (sharedData.data && sharedData.data.length > 0) {
              finalWabaId = sharedData.data[0].id;
              console.log("[Exchange] Found in /me/shared_waba_accounts:", finalWabaId);
            }
          }
        } catch (e) { console.error("[Exchange] shared_waba error:", e); }
      }

      // D. Fetch Phone ID if we have WABA
      if (finalWabaId && !finalPhoneId) {
        try {
          const phonesResponse = await fetch(
            `https://graph.facebook.com/v21.0/${finalWabaId}/phone_numbers?access_token=${accessToken}`
          );
          if (phonesResponse.ok) {
            const phonesData = await phonesResponse.json();
            if (phonesData.data && phonesData.data.length > 0) {
              finalPhoneId = phonesData.data[0].id;
              finalPhoneNumber = phonesData.data[0].display_phone_number;
              console.log("[Exchange] Found Phone ID in WABA:", { finalPhoneId, finalPhoneNumber });
            }
          }
        } catch (e) { console.error("[Exchange] phones fetch error:", e); }
      }
    }

    // 4. Fetch display number if still missing
    if (finalPhoneId && !finalPhoneNumber) {
      try {
        const phoneDetailResponse = await fetch(
          `https://graph.facebook.com/v21.0/${finalPhoneId}?fields=display_phone_number&access_token=${accessToken}`
        );
        if (phoneDetailResponse.ok) {
          const phoneDetailData = await phoneDetailResponse.json();
          finalPhoneNumber = phoneDetailData.display_phone_number;
        }
      } catch (e) { console.warn("[Exchange] display_phone_number error:", e); }
    }

    console.log("[Exchange] Final Result:", { finalWabaId, finalPhoneId, finalPhoneNumber });

    return new Response(
      JSON.stringify({
        success: true,
        access_token: accessToken,
        token_type: tokenData.token_type || "Bearer",
        expires_in: tokenData.expires_in,
        phone_number_id: finalPhoneId,
        waba_account_id: finalWabaId,
        phone_number: finalPhoneNumber,
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
    console.error("[Exchange] Internal error:", error);
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
