/**
 * =====================================================
 * supabase/functions/exchange-token/index.ts
 * Meta OAuth Token Exchange Function
 * منصة مدعوم - وظيفة تبادل رموز Meta
 * =====================================================
 *
 * هذه الوظيفة تتعامل مع:
 * 1. استقبال authorization code من Meta
 * 2. تبديل الـ code برمز الوصول (access token)
 * 3. حفظ البيانات في Supabase
 * 4. إرجاع النتيجة للعميل
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.0";

// ─── Configuration ───────────────────────────────────
const META_APP_ID = Deno.env.get("META_APP_ID") || "1510313544014876";
const META_APP_SECRET = Deno.env.get("META_APP_SECRET");

if (!META_APP_SECRET) {
  throw new Error("META_APP_SECRET is not set in environment variables");
}

// ─── Supabase Client ─────────────────────────────────
const supabaseUrl = Deno.env.get("SUPABASE_URL");
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error("Supabase configuration is missing");
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

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
    // Only accept POST requests
    if (req.method !== "POST") {
      return new Response(
        JSON.stringify({ error: "Method not allowed" }),
        {
          status: 405,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // Get the request body
    const body = await req.json();
    const { code, redirect_uri } = body;

    if (!code || !redirect_uri) {
      return new Response(
        JSON.stringify({ error: "Missing code or redirect_uri" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // Get the user from the Authorization header
    const authHeader = req.headers.get("Authorization");
    let userId: string | null = null;

    if (authHeader) {
      try {
        const token = authHeader.replace("Bearer ", "");
        const {
          data: { user },
        } = await supabase.auth.getUser(token);
        userId = user?.id || null;
      } catch (error) {
        console.error("Failed to get user from token:", error);
      }
    }

    // Exchange code for access token with Meta
    const tokenResponse = await fetch(
      "https://graph.instagram.com/v21.0/oauth/access_token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: META_APP_ID,
          client_secret: META_APP_SECRET,
          grant_type: "authorization_code",
          redirect_uri: redirect_uri,
          code: code,
        }).toString(),
      }
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
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    const tokenData = await tokenResponse.json();

    // Get WhatsApp Business Account info
    let wabaInfo = {};
    try {
      const meResponse = await fetch(
        `https://graph.instagram.com/me/accounts?access_token=${tokenData.access_token}`
      );

      if (meResponse.ok) {
        const meData = await meResponse.json();
        if (meData.data && meData.data.length > 0) {
          const account = meData.data[0];
          wabaInfo = {
            phone_number_id: account.phone_number_id,
            waba_account_id: account.id,
            business_account_id: account.business_account_id,
          };
        }
      }
    } catch (error) {
      console.error("Failed to get WhatsApp Business Account info:", error);
    }

    // Return success response
    return new Response(
      JSON.stringify({
        success: true,
        access_token: tokenData.access_token,
        token_type: tokenData.token_type || "Bearer",
        expires_in: tokenData.expires_in,
        refresh_token: tokenData.refresh_token || null,
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
        headers: { "Content-Type": "application/json" },
      }
    );
  }
});
