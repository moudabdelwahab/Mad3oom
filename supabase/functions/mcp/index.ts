// ============================================================
// mad3oom-mcp — Remote MCP Server (v8)
// ------------------------------------------------------------
// v8: إصلاح فجوة تتبع الاستخدام (usage tracking) الثلاثية:
//   1) endpoint كان ثابت دايمًا "/mcp:unknown" -> بقى ديناميكي حسب
//      method الفعلي، ولـ tools/call بيتسجل اسم الأداة نفسه:
//      "/mcp:tools/call:list_tickets" مثلاً.
//   2) status_code كان NULL دايمًا -> بقى بياخد status الرد الحقيقي
//      (نفس الـ Response اللي بيوصل للعميل، عبر withLogging()).
//   3) usage_count على api_tokens كان مايتحدّثش خالص -> بقى بيتزوّد
//      أتوميك عبر RPC increment_api_token_usage (migration منفصلة).
// التسجيل نفسه اتنقل من verifyApiToken (بداية الطلب) لنهاية الطلب
// (بعد معرفة الـ Response النهائي) عشان نقدر نسجل status_code
// الصحيح - تريد-أوف بسيط: نافذة الـ race على rate-limit للطلبات
// المتزامنة جدًا بقت أوسع شوية، موثّق بالتفصيل في api-auth.ts.
// ============================================================
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { CORS_HEADERS } from "./_shared/cors.ts";
import { verifyApiToken, requireScope, logApiUsage } from "./_shared/api-auth.ts";
import { getActor } from "./_shared/actor.ts";
import * as Tickets from "./_shared/tickets-service.ts";
import * as Customers from "./_shared/customers-service.ts";
import * as Subscriptions from "./_shared/subscriptions-service.ts";
import * as Notifications from "./_shared/notifications-service.ts";
import { sendTextMessage, sendTemplateMessage } from "./_shared/whatsapp-service.ts";
import { getToolsCatalog, type CatalogTool } from "./_shared/tools-catalog-db.ts";

const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05", "2025-11-25"];
const DEFAULT_VERSION = "2025-06-18";
const SERVER_INFO = { name: "mad3oom-mcp", version: "1.1.0" };

const PROTECTED_RESOURCE_METADATA_URL = "https://mad3oom.online/.well-known/oauth-protected-resource";

function rpcResult(id: unknown, result: unknown) { return { jsonrpc: "2.0", id, result }; }
function rpcError(id: unknown, code: number, message: string) { return { jsonrpc: "2.0", id, error: { code, message } }; }
function httpJson(body: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...extraHeaders } });
}

async function getDisabledToolNames(): Promise<Set<string>> {
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data } = await admin.from("advanced_settings").select("value").eq("key", "mcp_server_tools").maybeSingle();
    const disabled = data?.value?.disabled_tools;
    return new Set(Array.isArray(disabled) ? disabled : []);
  } catch {
    return new Set();
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return httpJson(rpcError(null, -32600, "Only POST is supported"), 405);

  const auth = await verifyApiToken(req);
  if (!auth.ok) {
    const extraHeaders = auth.status === 401
      ? { "WWW-Authenticate": `Bearer resource_metadata="${PROTECTED_RESOURCE_METADATA_URL}"` }
      : {};
    return httpJson(rpcError(null, -32001, auth.error), auth.status, extraHeaders);
  }

  const ip = req.headers.get("x-forwarded-for") || "";
  const userAgent = req.headers.get("user-agent") || "";

  let endpointLabel = "/mcp:parse_error";

  function withLogging(response: Response): Response {
    logApiUsage({
      tokenId: auth.token.id,
      userId: auth.token.user_id,
      endpoint: endpointLabel,
      method: req.method,
      statusCode: response.status,
      ip,
      userAgent,
    });
    return response;
  }

  let body: any;
  try { body = await req.json(); } catch { return withLogging(httpJson(rpcError(null, -32700, "Parse error"), 400)); }

  const { id = null, method, params } = body || {};
  if (!method || typeof method !== "string") return withLogging(httpJson(rpcError(id, -32600, "Invalid Request"), 400));

  endpointLabel = method === "tools/call" && params?.name
    ? `/mcp:tools/call:${params.name}`
    : `/mcp:${method}`;

  try {
    switch (method) {
      case "initialize": {
        const requested = params?.protocolVersion;
        const version = SUPPORTED_VERSIONS.includes(requested) ? requested : DEFAULT_VERSION;
        const sessionId = crypto.randomUUID();
        return withLogging(httpJson(rpcResult(id, {
          protocolVersion: version,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        }), 200, { "Mcp-Session-Id": sessionId }));
      }

      case "notifications/initialized":
        return withLogging(new Response(null, { status: 202, headers: CORS_HEADERS }));

      case "tools/list": {
        const [catalog, disabled] = await Promise.all([getToolsCatalog(), getDisabledToolNames()]);
        const available = catalog.filter((t) => auth.token.scopes.includes(t.scope) && !disabled.has(t.name));
        return withLogging(httpJson(rpcResult(id, {
          tools: available.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        })));
      }

      case "tools/call": {
        const toolName = params?.name;
        const args = params?.arguments || {};
        const catalog = await getToolsCatalog();
        const tool = catalog.find((t) => t.name === toolName);
        if (!tool) return withLogging(httpJson(rpcError(id, -32602, `Unknown tool: ${toolName}`)));

        const disabled = await getDisabledToolNames();
        if (disabled.has(toolName)) return withLogging(httpJson(rpcError(id, -32602, `Tool is disabled by platform administrator: ${toolName}`)));

        const scopeErr = requireScope(auth.token, tool.scope);
        if (scopeErr) return withLogging(httpJson(rpcError(id, -32003, scopeErr.error)));

        const actor = await getActor(auth.token.user_id);
        const result = await callTool(toolName, actor, args);
        return withLogging(httpJson(rpcResult(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] })));
      }

      default:
        return withLogging(httpJson(rpcError(id, -32601, `Method not found: ${method}`), 404));
    }
  } catch (err: any) {
    const status = err?.name === "ForbiddenError" ? 403 : err?.name === "NotFoundError" ? 404 : 500;
    const code = status === 403 ? -32004 : status === 404 ? -32005 : -32603;
    return withLogging(httpJson(rpcError(id, code, err?.message || "Internal error"), status));
  }
});

async function callTool(name: string, actor: any, args: any) {
  switch (name) {
    case "create_ticket": return await Tickets.createTicket(actor, args);
    case "update_ticket": return await Tickets.updateTicket(actor, args.ticket_id, args.updates || {});
    case "close_ticket": return await Tickets.closeTicket(actor, args.ticket_id);
    case "list_tickets": return await Tickets.listTickets(actor, args);
    case "get_ticket": return await Tickets.getTicket(actor, args.ticket_id);
    case "get_dashboard_stats": return await Tickets.getDashboardStats(actor);
    case "get_customer": return await Customers.getCustomer(actor, args.customer_id);
    case "list_customers": return await Customers.listCustomers(actor, args);
    case "send_whatsapp": return await callSendWhatsapp(actor, args);
    case "list_subscriptions": return await Subscriptions.listSubscriptions(actor, args);
    case "get_subscription": return await Subscriptions.getSubscription(actor, args.subscription_id);
    case "create_subscription": return await Subscriptions.createSubscription(actor, args);
    case "renew_subscription": return await Subscriptions.renewSubscription(actor, args);
    case "cancel_subscription": return await Subscriptions.cancelSubscription(actor, args.subscription_id);
    case "list_subscription_plans": return await Subscriptions.listSubscriptionPlans();
    case "list_notifications": return await Notifications.listNotifications(actor, args);
    case "send_notification": return await Notifications.sendNotification(actor, args);
    case "manage_notification": return await Notifications.manageNotification(actor, args);
    default: throw new Error("Tool not implemented: " + name);
  }
}

async function callSendWhatsapp(actor: any, args: any) {
  const { phone_number_id, to, message_type, text, template } = args || {};
  if (!to) throw new Error("الحقل to مطلوب");
  if (message_type === "template") {
    return await sendTemplateMessage({ userId: actor.id, phoneNumberId: phone_number_id, to, template });
  }
  return await sendTextMessage({ userId: actor.id, phoneNumberId: phone_number_id, to, text });
}
