import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { runTurn, type Deps, type DbError } from "./core.ts";

// ============================================================================
// conversation-turn — الـ Orchestrator بتاع Conversation Core (الموقع)
//
// المنطق كله في core.ts. الملف ده بيوصّله بس: Supabase (القاعدة) و SIE
// (decide عبر HTTP).
//
// العقد:
//   POST  Authorization: Bearer <JWT العميل>
//   body: { message: string, clientMessageId: string, attachment?: {kind, path, name?, mime?} }
//   200:  { reply, options, ticketCreated, ticketNumber, ticketError, skipped:false,
//           conversationId, messageId, duplicate, handoff, stateVersion, agent }
//         أو { skipped: true, reason: human_owner|closed|noop|version_conflict, conversationId }
//   409:  { error: 'core_disabled' }  ⇐ العلم مقفول للعميل ده: مفيش أي كتابة،
//         والمتصل يكمّل في المسار القديم.
//   403:  { error: 'sie_unavailable', reason } | { error: 'account_inactive' }
//   400 / 401 / 500
//
// البيئة:
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY  (من المنصة)
//   SIE_DECIDE_URL    عنوان decide في SIE (العقد v1). مش مضبوط ⇒ رد الخادم الثابت.
//   SIE_DECIDE_TOKEN  توكن بين الخادمين لـ decide. مش مضبوط ⇒ رد الخادم الثابت.
//                     (مفتاح service_role مابيتبعتش لـ SIE.)
//
// النشر: verify_jwt = true. ومفيش أي عميل بينده الدالة دي لحد ما الواجهة
// تتغير ويتفتح core_ingest_website لمستخدمين بعينهم (المرحلة 4/5).
// ============================================================================

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });

function dbError(e: { message?: string; code?: string; hint?: string } | null): DbError {
  const err = new Error(e?.message ?? "database error") as DbError;
  err.code = e?.code;
  err.hint = e?.hint;
  return err;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing Authorization header" }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData?.user) return jsonResponse({ error: "Unauthorized" }, 401);
    const userId = userData.user.id;

    let body: { message?: unknown; clientMessageId?: unknown; attachment?: unknown };
    try { body = await req.json(); } catch { return jsonResponse({ error: "Invalid JSON body" }, 400); }

    const admin = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const decideUrl = Deno.env.get("SIE_DECIDE_URL") ?? "";
    const decideToken = Deno.env.get("SIE_DECIDE_TOKEN") ?? "";

    const rpc = async (fn: string, args: Record<string, unknown>) => {
      const { data, error } = await admin.rpc(fn, args);
      if (error) throw dbError(error);
      return data;
    };

    const deps: Deps = {
      channelEnabled: async (uid) => (await rpc("conv_channel_enabled", { p_channel: "website", p_user: uid })) === true,
      sieEntitlement: async () => {
        const { data, error } = await userClient.rpc("sie_my_entitlement");
        if (error) throw dbError(error);
        return data;
      },
      ingest: (args) => rpc("conv_ingest_message", args),
      loadConversation: async (id) => {
        const { data, error } = await admin.from("chat_sessions")
          .select("id, state_version, is_manual_mode, status, bot_state").eq("id", id).maybeSingle();
        if (error) throw dbError(error);
        return data && {
          id: data.id, stateVersion: data.state_version, status: data.status,
          owner: data.is_manual_mode ? "human" : "agent", state: data.bot_state ?? null,
        };
      },
      loadMessages: async (id, limit) => {
        const { data, error } = await admin.from("chat_messages")
          .select("id, seq, sender_id, message_text, is_bot_reply, is_admin_reply, attachment, created_at")
          .eq("session_id", id).is("deleted_at", null)
          .order("seq", { ascending: false, nullsFirst: false })
          .order("created_at", { ascending: false })
          .limit(limit);
        if (error) throw dbError(error);
        return data ?? [];
      },
      findReply: async (id, key) => {
        const { data, error } = await admin.from("chat_messages")
          .select("id, message_text, metadata")
          .eq("session_id", id).eq("external_id", `turn:${key}`).eq("is_bot_reply", true).maybeSingle();
        if (error) throw dbError(error);
        return data && { id: data.id, text: data.message_text, metadata: data.metadata ?? null };
      },
      ticketQuota: (uid) => rpc("ticket_quota_status", { p_user_id: uid }),
      decide: async (request, timeoutMs) => {
        if (!decideUrl || !decideToken) throw new Error("SIE decide is not configured");
        const res = await fetch(decideUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${decideToken}` },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) throw new Error(`SIE decide HTTP ${res.status}`);
        return await res.json();
      },
      commit: (args) => rpc("conv_commit_turn", args),
      consume: (uid) => rpc("sie_consume_message", { p_user_id: uid }),
      trace: async (row) => {
        const { error } = await admin.from("chat_engine_trace_events").insert(row);
        if (error) throw dbError(error);
      },
      log: (event, data) => console.log(JSON.stringify({ fn: "conversation-turn", event, ...data })),
      now: () => Date.now(),
    };

    const result = await runTurn(deps, {
      userId, message: body.message, clientMessageId: body.clientMessageId, attachment: body.attachment,
    });
    return jsonResponse(result.body, result.status);
  } catch (err) {
    console.error(JSON.stringify({ fn: "conversation-turn", event: "error", error: String(err) }));
    return jsonResponse({ error: "حدث خطأ غير متوقع" }, 500);
  }
});
