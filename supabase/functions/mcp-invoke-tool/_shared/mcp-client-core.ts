import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { buildAuthHeaders, mcpCallTool, mcpInitialize, type McpServerDef } from "./mcp-transport.ts";
import { createMcpSession } from "./mcp-http.ts";
import { resolveTool } from "./mcp-tool-registry.ts";
import { decryptString } from "./mcp-crypto.ts";
import { ensureFreshAccessToken, type McpConnection } from "./mcp-oauth.ts";
import { callToolViaBridge, isBridgeEnabledFor } from "./mcp-arch/bridge/legacy-bridge.js";

// ============================================================
// mcp-client-core.ts (v2 + Phase 1 Legacy Bridge gate)
// ------------------------------------------------------------
// نفس v2 بالحرف + فرع إضافي واحد فقط قبل بناء serverDef/headers يدويًا:
// لو server.id ضمن MCP_BRIDGE_ENABLED_SERVER_IDS (نفس متغير البيئة
// المستخدم في test-mcp-server، لازم يتفق نفس ID في الاتنين)، ننفّذ tools/call
// عبر المعمارية الجديدة (McpSession → ConnectionManager → AuthManager →
// Transport) بدل mcpCallTool() اليدوي تحت. حارس oauth_connector لسه أول
// حاجة بتتفحص زي ما هو - الجسر ده بروتوكول MCP فقط، معندوش علاقة بـ
// oauth_connector إطلاقًا ولا لازم يتفحص فيه.
// ============================================================

export interface InvokeToolResult {
  ok: boolean;
  toolName: string;
  serverName?: string;
  result?: unknown;
  error?: string;
}

const BRIDGE_ENABLED_SERVER_IDS = (Deno.env.get("MCP_BRIDGE_ENABLED_SERVER_IDS") || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** يحوّل اسم سر منطقي (كما يتوقعه auth/providers/*.js) إلى القيمة المفكوكة فعليًا -
 *  نفس دالة test-mcp-server/index.ts بالحرف (مكررة عمدًا: الدالتان مستقلتان لأن
 *  الملفين Edge Functions منفصلتان بالكامل، بنفس نمط التكرار الموجود بالفعل بين
 *  الدالتين لملفات _shared الأخرى - لا import مشترك بينهما في الإنتاج). */
function makeResolveSecret(adminClient: SupabaseClient, connection: McpConnection) {
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

export async function invokeTool(
  adminClient: SupabaseClient,
  ownerId: string,
  toolName: string,
  args: Record<string, unknown>,
  opts: { requireAiEnabled?: boolean } = {}
): Promise<InvokeToolResult> {
  if (!ownerId) return { ok: false, toolName, error: "ownerId مطلوب" };
  if (!toolName) return { ok: false, toolName, error: "toolName مطلوب" };

  const resolved = await resolveTool(adminClient, ownerId, toolName, opts);
  if (!resolved) return { ok: false, toolName, error: "الأداة غير موجودة أو غير مفعّلة لهذا المالك" };

  const { server, connection, tool } = resolved;

  // حارس صريح: OAuth Connector (REST) مش خادم MCP - استدعاء أدوات مباشر غير
  // مدعوم بعد. نقطة التمديد المستقبلية لـ Adapters هنا بالضبط. لا علاقة
  // للجسر الجديد بهذا الحارس - يُفحص أولاً كما هو دايمًا.
  if ((server as any).connector_type === "oauth_connector") {
    return {
      ok: false,
      toolName,
      serverName: server.name,
      error: "هذا موصل OAuth (REST) وليس خادم MCP - استدعاء الأدوات المباشر غير مدعوم بعد - يحتاج Adapter مخصص (قيد التطوير).",
    };
  }

  if (isBridgeEnabledFor(server.id, { enabledServerIds: BRIDGE_ENABLED_SERVER_IDS })) {
    const bridgeInput = {
      server: { id: server.id, url: server.url, transport: server.transport, name: server.name },
      connection,
      resolveSecret: makeResolveSecret(adminClient, connection as McpConnection),
    };
    const callResult = await callToolViaBridge(bridgeInput, tool.name, args || {});
    if (!callResult.ok) return { ok: false, toolName, serverName: server.name, error: callResult.error };
    return { ok: true, toolName, serverName: server.name, result: callResult.result };
  }

  const serverDef: McpServerDef = { id: server.id, name: server.name, transport: server.transport, url: server.url, command: server.command, headers: server.headers };

  let headers: Record<string, string>;
  try {
    headers = await buildAuthHeaders(adminClient, connection as McpConnection);
  } catch (err) {
    return { ok: false, toolName, serverName: server.name, error: (err as Error).message };
  }
  if (server.headers && typeof server.headers === "object") Object.assign(headers, server.headers);

  // المصافحة قبل الاستدعاء: كان tools/call يُرسَل مباشرة بلا initialize، وهو ما
  // ترفضه أي خادم يعمل بجلسات (يصدر Mcp-Session-Id ويشترط وجودها). الجلسة
  // الواحدة تُمرَّر للنداءين معًا حتى تُحمل الترويسة الصحيحة على الثاني.
  const session = createMcpSession();
  const handshake = await mcpInitialize(serverDef, headers, session);
  if (!handshake.ok) return { ok: false, toolName, serverName: server.name, error: handshake.error };

  const callResult = await mcpCallTool(serverDef, headers, tool.name, args || {}, session);
  if (!callResult.ok) return { ok: false, toolName, serverName: server.name, error: callResult.error };

  return { ok: true, toolName, serverName: server.name, result: callResult.result };
}
