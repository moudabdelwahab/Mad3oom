import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { decryptSecret } from "./_shared/crypto.ts";

const GRAPH_VERSION = "v25.0";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "missing_auth" }), {
        status: 401,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData?.user) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }
    const userId = userData.user.id;

    const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { phone_number_id } = await req.json().catch(() => ({}));

    let query = adminClient
      .from("integrations")
      .select("encrypted_access_token, metadata")
      .eq("user_id", userId)
      .eq("provider", "whatsapp");

    const { data: rows, error: fetchError } = await query;
    if (fetchError) {
      console.error("integrations fetch error:", fetchError.message);
      return new Response(JSON.stringify({ error: "fetch_failed" }), {
        status: 500,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const integration = phone_number_id
      ? rows?.find((r: any) => r.metadata?.phone_number_id === phone_number_id)
      : rows?.[0];

    if (!integration?.encrypted_access_token) {
      return new Response(JSON.stringify({ error: "not_connected" }), {
        status: 404,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    let accessToken: string;
    try {
      accessToken = await decryptSecret(integration.encrypted_access_token);
    } catch (decErr) {
      console.error("Failed to decrypt access token:", (decErr as Error).message);
      return new Response(JSON.stringify({ error: "decryption_failed" }), {
        status: 500,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const targetPhoneId = phone_number_id || integration.metadata?.phone_number_id;
    if (!targetPhoneId) {
      return new Response(JSON.stringify({ error: "missing_phone_id" }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const graphRes = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${targetPhoneId}?fields=display_phone_number,verified_name,quality_rating,account_mode,messaging_limit_tier,status,code_verification_status`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const phoneData = await graphRes.json();

    if (phoneData.error) {
      console.error("Meta API error:", phoneData.error);
      return new Response(JSON.stringify({ error: "meta_api_error", details: phoneData.error.message }), {
        status: 502,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({
        phoneNumber: phoneData.display_phone_number || "—",
        verifiedName: phoneData.verified_name || "—",
        qualityRating: phoneData.quality_rating || "—",
        accountMode: phoneData.account_mode || "—",
        limitTier: phoneData.messaging_limit_tier || "—",
        status: phoneData.status || "—",
        verification: phoneData.code_verification_status || "—",
        wabaId: integration.metadata?.waba_account_id || "—",
      }),
      { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("whatsapp-phone-status unexpected error:", (err as Error).message);
    return new Response(JSON.stringify({ error: "unexpected_error" }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
