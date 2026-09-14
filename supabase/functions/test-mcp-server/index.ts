import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { decryptString } from "./_shared/mcp-crypto.ts";
import { ensureFreshAccessToken, type McpConnection } from "./_shared/mcp-oauth.ts";
import { discoverServerViaBridge, isBridgeEnabledFor } from "./_shared/mcp-arch/bridge/legacy-bridge.js";
import { createMcpSession, mcpHandshake, mcpPost } from "./_shared/mcp-http.ts";

// ============================================================
// test-mcp-server (v3 + Phase 1 Legacy Bridge gate)
// ------------------------------------------------------------
// نفس v2 بالضبط + فرع إضافي واحد فقط: لو connector_type = 'oauth_connector'
// (خدمة REST بعد OAuth زي Google Drive/Sheets - مش خادم MCP حقيقي)،
// نتأكد إن الاعتماد/التوكن صالح فقط، وما بنعملش أي JSON-RPC initialize/
// tools/list خالص. أي صف قديم (connector_type الافتراضي 'mcp_server')
// بيمشي بنفس المسار القديم تمامًا بدون أي تغيير.
//
// Phase 1: تمت إضافة IF واحد فقط حول هذا المسار الأخير (mcp_server):
// لو server.id ضمن MCP_BRIDGE_ENABLED_SERVER_IDS (متغير بيئة، افتراضيًا
// فاضي = لا سيرفر مفعّل = صفر تغيير سلوك)، ننفّذ نفس initialize + tools/list
// لكن عبر المعمارية الجديدة (McpSession → ConnectionManager → AuthManager →
// Transport) بدل fetch() المباشر تحت. المسار القديم (runTest) لسه موجود
// بالحرف ولم يُحذف - قابل للتراجع فورًا بمسح متغير البيئة فقط.
// ============================================================

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
}

// تفعيل تدريجي عبر Project Secret - بدون أي عمود DB جديد (خارج نطاق Phase 1).
// افتراضيًا فاضي = المسار القديم runTest() هو المسار الوحيد لكل سيرفر، كما هو اليوم بالضبط.
const BRIDGE_ENABLED_SERVER_IDS = (Deno.env.get("MCP_BRIDGE_ENABLED_SERVER_IDS") || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing Authorization header" }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData?.user) return jsonResponse({ error: "Unauthorized" }, 401);

    const { data: isAdminData, error: adminCheckError } = await userClient.rpc("is_admin");
    if (adminCheckError || !isAdminData) return jsonResponse({ error: "هذه العملية متاحة للأدمن فقط" }, 403);

    let body: { server_id?: string };
    try { body = await req.json(); } catch { return jsonResponse({ error: "Invalid JSON body" }, 400); }
    const serverId = (body.server_id || "").trim();
    if (!serverId) return jsonResponse({ error: "server_id مطلوب" }, 400);

    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    const { data: server, error: serverErr } = await adminClient
      .from("mcp_servers")
      .select("id, name, transport, url, command, headers, connector_type")
      .eq("id", serverId)
      .maybeSingle();
    if (serverErr || !server) return jsonResponse({ ok: false, message: "الخادم مش موجود" }, 404);

    let { data: connection } = await adminClient
      .from("mcp_server_connections")
      .select("*")
      .eq("server_id", serverId)
      .eq("owner_id", userData.user.id)
      .maybeSingle();

    if (!connection) {
      const { data: created, error: createErr } = await adminClient
        .from("mcp_server_connections")
        .insert({ server_id: serverId, owner_id: userData.user.id, auth_type: "none" })
        .select("*")
        .single();
      if (createErr) return jsonResponse({ ok: false, message: "تعذر إنشاء اتصال: " + createErr.message }, 500);
      connection = created;
    }

    const useBridge = server.connector_type !== "oauth_connector"
      && isBridgeEnabledFor(server.id, { enabledServerIds: BRIDGE_ENABLED_SERVER_IDS });

    const result = server.connector_type === "oauth_connector"
      ? await runOauthConnectorCheck(adminClient, connection as McpConnection)
      : useBridge
        ? await runTestViaBridge(server, connection as McpConnection)
        : await runTest(adminClient, server, connection as McpConnection);

    const persistUpdate: Record<string, unknown> = {
      status: result.ok ? "connected" : "error",
      last_checked_at: new Date().toISOString(),
      last_error: result.ok ? null : result.message,
    };
    if (result.ok && result.mergedTools) persistUpdate.tools = result.mergedTools;

    await adminClient.from("mcp_server_connections").update(persistUpdate).eq("id", (connection as McpConnection).id);

    return jsonResponse({
      ok: result.ok,
      message: result.message,
      latency: result.latency,
      serverName: result.serverName,
      serverVersion: result.serverVersion,
      protocolVersion: result.protocolVersion,
      tools: result.ok ? (result.mergedTools?.length ?? 0) : Array.isArray((connection as McpConnection).tools) ? (connection as McpConnection).tools.length : 0,
      via: useBridge ? "bridge" : "legacy", // Phase 1: تشخيصي فقط - أي مستهلك حالي يقرأ فقط الحقول القديمة يستمر يعمل بدون تعديل
    });
  } catch (err) {
    console.error("Unexpected error:", err);
    return jsonResponse({ ok: false, message: "حدث خطأ غير متوقع" }, 500);
  }
});

/** يحوّل اسم سر منطقي (كما يتوقعه auth/providers/*.js) إلى القيمة المفكوكة فعليًا من نفس أعمدة mcp_server_connections التي يقرأها buildAuthHeaders الحالي أدناه - نفس منطق فك التشفير بالحرف، بدون أي تكرار للتشفير نفسه */
function makeResolveSecret(adminClient: ReturnType<typeof createClient>, connection: McpConnection) {
  return async (secretName: string): Promise<unknown> => {
    switch (secretName) {
      case "bearer_token":
        return connection.bearer_token_encrypted ? await decryptString(connection.bearer_token_encrypted) : null;
      case "api_key":
        return connection.api_key_encrypted ? await decryptString(connection.api_key_encrypted) : null;
      case "api_secret":
        return connection.api_secret_encrypted ? await decryptString(connection.api_secret_encrypted) : null;
      case "custom_config": {
        if (!connection.custom_config_encrypted) return null;
        try {
          const raw = await decryptString(connection.custom_config_encrypted);
          return JSON.parse(raw);
        } catch {
          throw new Error("تعذر قراءة/فك تشفير custom_config - تأكد أنه JSON صالح يمثل الترويسات");
        }
      }
      case "access_token": {
        const fresh = await ensureFreshAccessToken(adminClient, connection);
        Object.assign(connection, fresh);
        return connection.oauth_access_token_encrypted ? await decryptString(connection.oauth_access_token_encrypted) : null;
      }
      default:
        return null;
    }
  };
}

/** يعادل runTest() تمامًا من ناحية الشكل المُرجَع، لكن عبر McpSession → ConnectionManager → AuthManager → Transport بدل fetch() المباشر - نفس merge منطق mergeTools() أدناه، بدون تكرار */
async function runTestViaBridge(server: Record<string, any>, connection: McpConnection) {
  const start = performance.now();
  const adminClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const discovery = await discoverServerViaBridge({
    server: { id: server.id, url: server.url, transport: server.transport, name: server.name },
    connection,
    resolveSecret: makeResolveSecret(adminClient, connection),
  });

  if (!discovery.ok) return { ok: false, message: discovery.message };

  const merged = mergeTools(connection.tools, discovery.tools as Array<{ name: string; description?: string; inputSchema?: unknown }>);
  return {
    ok: true,
    latency: Math.round(performance.now() - start),
    serverName: discovery.serverInfo?.name ?? null,
    serverVersion: discovery.serverInfo?.version ?? null,
    protocolVersion: discovery.protocolVersion ?? null,
    mergedTools: merged,
    message: `تم الاتصال بخادم MCP بنجاح عبر المعمارية الجديدة (${merged.length} أداة)`,
  };
}

async function buildAuthHeaders(adminClient: ReturnType<typeof createClient>, connection: McpConnection): Promise<Record<string, string>> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };

  switch (connection.auth_type) {
    case "none":
      break;
    case "api_key": {
      const apiKey = connection.api_key_encrypted ? await decryptString(connection.api_key_encrypted) : "";
      const apiSecret = connection.api_secret_encrypted ? await decryptString(connection.api_secret_encrypted) : "";
      if (apiKey && apiSecret) headers.Authorization = `Bearer ${apiKey}.${apiSecret}`;
      else if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      break;
    }
    case "bearer": {
      const token = connection.bearer_token_encrypted ? await decryptString(connection.bearer_token_encrypted) : "";
      if (token) headers.Authorization = `Bearer ${token}`;
      break;
    }
    case "custom": {
      if (connection.custom_config_encrypted) {
        try {
          const raw = await decryptString(connection.custom_config_encrypted);
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object") Object.assign(headers, parsed);
        } catch {
          throw new Error("تعذر قراءة/فك تشفير custom_config - تأكد أنه JSON صالح يمثل الترويسات");
        }
      }
      break;
    }
    case "oauth2": {
      const fresh = await ensureFreshAccessToken(adminClient, connection);
      Object.assign(connection, fresh);
      const token = connection.oauth_access_token_encrypted ? await decryptString(connection.oauth_access_token_encrypted) : "";
      if (!token) throw new Error("لا يوجد OAuth access token - لازم ربط الخادم عبر OAuth أولاً");
      headers.Authorization = `Bearer ${token}`;
      break;
    }
  }

  return headers;
}

/** فحص "OAuth Connector" (REST بعد OAuth، مش خادم MCP) - بيتأكد بس إن الاعتماد/التوكن
 *  صالح وقابل لفك التشفير (ولو oauth2، بيجدّده لو منتهي)، وما بيعملش أي JSON-RPC خالص.
 *  mergedTools فاضية دايمًا بتصميم - الموصل ده معندوش "أدوات MCP" أصلاً. */
async function runOauthConnectorCheck(adminClient: ReturnType<typeof createClient>, connection: McpConnection) {
  const start = performance.now();
  try {
    const headers = await buildAuthHeaders(adminClient, connection);
    if (!headers.Authorization) {
      return { ok: false, message: "لا يوجد Access Token محفوظ بعد - أكمل تسجيل الدخول (OAuth) أولاً" };
    }
    return {
      ok: true,
      latency: Math.round(performance.now() - start),
      mergedTools: [],
      message: "الحساب مربوط بنجاح (OAuth) - Access Token صالح. هذا موصل REST وليس خادم MCP، فلا توجد أدوات MCP لعرضها.",
    };
  } catch (err) {
    return { ok: false, message: (err as Error).message || "فشل التحقق من الاعتماد" };
  }
}

function mergeTools(existing: unknown, discovered: Array<{ name: string; description?: string; inputSchema?: unknown }>) {
  const existingArr = Array.isArray(existing) ? existing : [];
  const existingByName = new Map(existingArr.map((t: any) => [t.name, t]));

  return discovered.map((tool) => {
    const prev = existingByName.get(tool.name);
    return {
      name: tool.name,
      description: tool.description ?? prev?.description ?? "",
      inputSchema: tool.inputSchema ?? prev?.inputSchema ?? {},
      enabled: prev ? Boolean(prev.enabled) : true,
      visible: prev ? prev.visible !== false : true,
      ...(prev?.rate_limit !== undefined ? { rate_limit: prev.rate_limit } : {}),
      ...(prev?.permissions !== undefined ? { permissions: prev.permissions } : {}),
    };
  });
}

async function runTest(adminClient: ReturnType<typeof createClient>, server: Record<string, any>, connection: McpConnection) {
  if (server.transport === "stdio") {
    return {
      ok: !!server.command,
      message: server.command ? "الإعداد صحيح (stdio يتطلب التشغيل من جهة الخادم)" : "أمر التشغيل (command) غير محدد",
      mergedTools: Array.isArray(connection.tools) ? connection.tools : [],
    };
  }

  if (!server.url) return { ok: false, message: "لا يوجد عنوان (URL) للاختبار" };

  let headers: Record<string, string>;
  try {
    headers = await buildAuthHeaders(adminClient, connection);
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }

  if (server.headers && typeof server.headers === "object") Object.assign(headers, server.headers);

  const start = performance.now();

  // المصافحة والاكتشاف صارا يمرّان عبر mcp-http.ts: ترويسة Accept الصحيحة،
  // ودعم ردود SSE بجانب JSON، وترويسات الجلسة، ورسائل خطأ مفهومة بدل
  // "Initialize failed (<رقم>)". هذا هو موضع الخطأ 406 المسجَّل على اتصال
  // Supabase — كان هذا الكود ينادي fetch() مباشرة بلا Accept.
  const session = createMcpSession();

  const handshake = await mcpHandshake(server.url, headers, session, { timeoutMs: 8000 });
  if (!handshake.ok) return { ok: false, message: handshake.message ?? "فشل الاتصال" };

  const toolsRes = await mcpPost(server.url, headers, session, {
    jsonrpc: "2.0", id: 2, method: "tools/list",
  }, { timeoutMs: 8000 });

  if (!toolsRes.ok) {
    return { ok: false, message: `تعذّر جلب قائمة الأدوات: ${toolsRes.message ?? "سبب غير معروف"}` };
  }

  const discovered = Array.isArray((toolsRes.result as any)?.tools) ? (toolsRes.result as any).tools : [];
  const merged = mergeTools(connection.tools, discovered);

  return {
    ok: true,
    latency: Math.round(performance.now() - start),
    serverName: handshake.serverName ?? null,
    serverVersion: handshake.serverVersion ?? null,
    protocolVersion: handshake.protocolVersion ?? null,
    mergedTools: merged,
    message: `تم الاتصال بخادم MCP بنجاح (${merged.length} أداة)`,
  };
}
