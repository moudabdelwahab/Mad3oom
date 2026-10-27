// supabase/functions/create-template/index.ts
// Edge Function: إنشاء قالب WhatsApp وإرساله لـ Meta API

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { callerHas } from "../_shared/caller-authority.js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // ─── التحقق من هوية المستخدم وأن دوره admin أو support ─────
    // (كانت هذه الدالة بدون أي تحقق صلاحيات إطلاقًا — أي حد كان يقدر
    // ينشئ قوالب WhatsApp فعلية على حساب Meta Business الخاص بالمنصة)
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");

    const { data: callerData, error: callerError } = await supabase.auth.getUser(jwt);
    if (callerError || !callerData?.user) {
      return new Response(
        JSON.stringify({ error: "غير مصرح، يرجى تسجيل الدخول" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // is_platform_staff() بجلسة المنادي: الأدمن والدعم، أو مالك المنصة في سياق owner/admin (117)
    if (!(await callerHas("is_platform_staff", authHeader))) {
      return new Response(
        JSON.stringify({ error: "هذا الإجراء متاح لفريق الإدارة/الدعم فقط" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const {
      name,           // اسم القالب (lowercase, underscores only)
      category,       // MARKETING | UTILITY | AUTHENTICATION
      language,       // ar | en_US | etc.
      header,         // { type: "TEXT"|"IMAGE"|"VIDEO"|"DOCUMENT", text?: string, example?: string[] }
      body,           // { text: string, examples?: string[][] }
      footer,         // { text: string } | undefined
      buttons,        // [ { type: "QUICK_REPLY"|"URL"|"PHONE_NUMBER", text, url?, phone_number? } ] | undefined
    } = await req.json();

    // ─── التحقق من المدخلات ─────────────────────────────
    if (!name || !category || !language || !body?.text) {
      return new Response(
        JSON.stringify({ error: "name, category, language, body.text مطلوبين" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const nameRegex = /^[a-z0-9_]+$/;
    if (!nameRegex.test(name)) {
      return new Response(
        JSON.stringify({ error: "اسم القالب: أحرف صغيرة إنجليزية، أرقام، وشرطة سفلية فقط" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ─── بناء payload القالب ───────────────────────
    const components: object[] = [];

    if (header) {
      const headerComponent: Record<string, unknown> = {
        type: "HEADER",
        format: header.type,
      };
      if (header.type === "TEXT") {
        headerComponent.text = header.text;
        if (header.example) {
          headerComponent.example = { header_text: [header.example] };
        }
      } else if (header.example) {
        headerComponent.example = { header_handle: [header.example] };
      }
      components.push(headerComponent);
    }

    const bodyComponent: Record<string, unknown> = {
      type: "BODY",
      text: body.text,
    };
    if (body.examples && body.examples.length > 0) {
      bodyComponent.example = { body_text: body.examples };
    }
    components.push(bodyComponent);

    if (footer) {
      components.push({ type: "FOOTER", text: footer.text });
    }

    if (buttons && buttons.length > 0) {
      components.push({ type: "BUTTONS", buttons });
    }

    const metaPayload = {
      name,
      category,
      language,
      components,
    };

    // ─── إرسال لـ Meta API ──────────────────────────
    const WABA_ID = Deno.env.get("WHATSAPP_BUSINESS_ACCOUNT_ID")!;
    const META_TOKEN = Deno.env.get("META_ACCESS_TOKEN")!;
    const META_API_VERSION = Deno.env.get("META_API_VERSION") || "v19.0";

    const metaRes = await fetch(
      `https://graph.facebook.com/${META_API_VERSION}/${WABA_ID}/message_templates`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${META_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(metaPayload),
      }
    );

    const metaData = await metaRes.json();

    if (!metaRes.ok) {
      console.error("Meta API Error:", metaData);
      return new Response(
        JSON.stringify({ error: "فشل إنشاء القالب في Meta", details: metaData }),
        { status: metaRes.status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // metaData.id = template ID من Meta
    // metaData.status = "PENDING" دائمًا عند الإنشاء

    // ─── حفظ القالب في Supabase ───────────────────
    const { data: savedTemplate, error: dbError } = await supabase
      .from("whatsapp_templates")
      .insert({
        meta_template_id: metaData.id,
        name,
        category,
        language,
        status: metaData.status || "PENDING",
        components: components,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (dbError) {
      console.error("Supabase insert error:", dbError);
      // القالب اتحفظ في Meta بس Supabase فشل - نرجع النجاح + تحذير
      return new Response(
        JSON.stringify({
          success: true,
          warning: "القالب أُنشئ في Meta لكن فشل الحفظ في قاعدة البيانات",
          meta_template_id: metaData.id,
          status: metaData.status,
        }),
        { status: 207, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        template: savedTemplate,
        meta_response: metaData,
      }),
      { status: 201, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err) {
    console.error("Unexpected error:", err);
    return new Response(
      JSON.stringify({ error: "خطأ غير متوقع", details: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
