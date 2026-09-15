import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { getToolsCatalog } from "./_shared/tools-catalog-db.ts";

// ============================================================
// mcp-server-info (v6)
// ------------------------------------------------------------
// لوحة تحكم الأدمن فقط (verify_jwt:true). v6: TOOLS بقت تُقرأ من
// جدول public.mcp_tools_catalog لايف (نفس الجدول اللي بيقرأه mcp/index.ts) -
// مصدر واحد حقيقي وقت التشغيل، مش ملف مكرر. أي أداة تتضاف/تتعدّل
// في الجدول تظهر فورًا هنا بدون أي deploy تاني.
//
// actions:
//  - status        → معلومات الخادم الكاملة + قائمة الأدوات مع حالة enabled
//  - set_tool      → { tool_name, enabled } - يحفظ في advanced_settings.mcp_server_tools
//  - test          → فحص ذاتي للمنطق (بدون توكن API حقيقي) يؤكد أن الكود يشتغل
// ============================================================

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
}

const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05", "2025-11-25"];
const DEFAULT_VERSION = "2025-06-18";
const SERVER_INFO = { name: "mad3oom-mcp", version: "1.1.0" };

const RESOURCES_INFO = [
  { name: "tickets", description: "تذاكر الدعم (إنشاء/قراءة/تعديل/إغلاق) - متاحة عبر tools فقط، لا يوجد resources/list فعلي" },
  { name: "customers", description: "بيانات العملاء (قراءة فقط) - متاحة عبر tools فقط، لا يوجد resources/list فعلي" },
  { name: "subscriptions", description: "اشتراكات العملاء (قراءة/إنشاء/تجديد/إلغاء/خطط) - متاحة عبر tools فقط" },
  { name: "notifications", description: "إشعارات المستخدمين (قراءة/إرسال/إدارة) - متاحة عبر tools فقط" },
];

function adminClient() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
}

async function getToolsState() {
  const [catalog, admin] = [await getToolsCatalog(), adminClient()];
  const { data } = await admin.from("advanced_settings").select("value").eq("key", "mcp_server_tools").maybeSingle();
  const disabled: string[] = Array.isArray(data?.value?.disabled_tools) ? data.value.disabled_tools : [];
  return catalog.map((t) => ({ name: t.name, description: t.description, scope: t.scope, enabled: !disabled.includes(t.name) }));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing Authorization header" }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData?.user) return jsonResponse({ error: "Unauthorized" }, 401);

    const { data: isAdminData, error: adminCheckError } = await userClient.rpc("is_admin");
    if (adminCheckError || !isAdminData) return jsonResponse({ error: "هذه العملية متاحة للأدمن فقط" }, 403);

    let body: { action?: string; tool_name?: string; enabled?: boolean };
    try { body = await req.json(); } catch { return jsonResponse({ error: "Invalid JSON body" }, 400); }

    const action = body.action || "status";

    if (action === "status" || action === "test") {
      const tools = await getToolsState();
      return jsonResponse({
        status: "online",
        endpoint: `${supabaseUrl}/functions/v1/mcp`,
        protocol_version: DEFAULT_VERSION,
        supported_protocol_versions: SUPPORTED_VERSIONS,
        transport: "streamable_http (JSON-RPC 2.0 عبر HTTPS)",
        authentication_methods: ["api_key_secret", "bearer"],
        server_info: SERVER_INFO,
        capabilities: { tools: true, resources: false, prompts: false, streaming: false, oauth: false },
        tools,
        resources_info: RESOURCES_INFO,
      });
    }

    if (action === "set_tool") {
      const toolName = (body.tool_name || "").trim();
      if (!toolName) return jsonResponse({ error: "tool_name مطلوب" }, 400);
      const catalog = await getToolsCatalog();
      if (!catalog.some((t) => t.name === toolName)) return jsonResponse({ error: "أداة غير موجودة" }, 400);
      const enabled = body.enabled !== false;

      const admin = adminClient();
      const { data: existing } = await admin.from("advanced_settings").select("id, value").eq("key", "mcp_server_tools").maybeSingle();
      const disabled: string[] = Array.isArray(existing?.value?.disabled_tools) ? existing.value.disabled_tools : [];
      const nextDisabled = enabled ? disabled.filter((n) => n !== toolName) : Array.from(new Set([...disabled, toolName]));
      const value = { disabled_tools: nextDisabled };

      if (existing) {
        await admin.from("advanced_settings").update({ value, updated_at: new Date().toISOString() }).eq("id", existing.id);
      } else {
        await admin.from("advanced_settings").insert({ key: "mcp_server_tools", value });
      }

      const tools = await getToolsState();
      return jsonResponse({ success: true, tools });
    }

    return jsonResponse({ error: `action غير معروف: ${action}` }, 400);
  } catch (err) {
    console.error("Unexpected error:", err);
    return jsonResponse({ error: "حدث خطأ غير متوقع" }, 500);
  }
});
