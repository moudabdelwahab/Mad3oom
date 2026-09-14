import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { decryptString } from "./mcp-crypto.ts";
import { ensureFreshAccessToken, type McpConnection } from "./mcp-oauth.ts";
import { createMcpSession, mcpHandshake, mcpPost, type McpHttpSession } from "./mcp-http.ts";

export interface McpServerDef {
  id: string;
  name: string;
  transport: string;
  url: string | null;
  command?: string | null;
  headers?: Record<string, unknown> | null;
}

export interface JsonRpcResult<T = unknown> {
  ok: boolean;
  result?: T;
  error?: string;
}

export async function buildAuthHeaders(adminClient: SupabaseClient, connection: McpConnection): Promise<Record<string, string>> {
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

/**
 * نداء JSON-RPC واحد فوق Streamable HTTP.
 *
 * كان هذا الجسم ينادي fetch() مباشرة بترويسة Content-Type فقط، ويفترض أن
 * كل رد JSON. صار يمرّ عبر mcp-http.ts الذي يرسل ترويسة Accept التي تفرضها
 * المواصفة ويتعامل مع ردود SSE وJSON على السواء. التوقيعات لم تتغيّر،
 * فكل مستدعٍ حالي يعمل كما هو.
 */
async function rpcCall(
  server: McpServerDef,
  headers: Record<string, string>,
  method: string,
  params: Record<string, unknown> | undefined,
  id: number,
  timeoutMs = 15000,
  session?: McpHttpSession
): Promise<JsonRpcResult> {
  if (server.transport === "stdio") return { ok: false, error: "stdio transport غير مدعوم لنداءات مباشرة من الـ Edge Function" };
  if (!server.url) return { ok: false, error: "لا يوجد عنوان (URL) للخادم" };

  const res = await mcpPost(
    server.url,
    headers,
    session ?? createMcpSession(),
    { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) },
    { isInitialize: method === "initialize", timeoutMs }
  );

  if (!res.ok) return { ok: false, error: res.message || `فشل نداء ${method}` };
  return { ok: true, result: res.result };
}

export async function mcpInitialize(server: McpServerDef, headers: Record<string, string>, session?: McpHttpSession) {
  if (server.transport === "stdio") return { ok: false, error: "stdio transport غير مدعوم لنداءات مباشرة من الـ Edge Function" };
  if (!server.url) return { ok: false, error: "لا يوجد عنوان (URL) للخادم" };

  const handshake = await mcpHandshake(server.url, headers, session ?? createMcpSession());
  if (!handshake.ok) return { ok: false, error: handshake.message || "فشل initialize" };
  return {
    ok: true,
    result: {
      protocolVersion: handshake.protocolVersion,
      capabilities: handshake.capabilities,
      serverInfo: { name: handshake.serverName, version: handshake.serverVersion },
    },
  };
}

export async function mcpListTools(server: McpServerDef, headers: Record<string, string>, session?: McpHttpSession) {
  return rpcCall(server, headers, "tools/list", undefined, 2, 15000, session);
}

export async function mcpCallTool(server: McpServerDef, headers: Record<string, string>, toolName: string, args: Record<string, unknown>, session?: McpHttpSession) {
  return rpcCall(server, headers, "tools/call", { name: toolName, arguments: args ?? {} }, 3, 30000, session);
}
