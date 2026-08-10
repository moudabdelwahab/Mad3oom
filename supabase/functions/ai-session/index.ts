import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ============================================================================
// ai-session
// ----------------------------------------------------------------------------
// جلسات المحادثة/البرمجة (Chat • Reason • Code • Build • Debug • Review • Refactor).
// لا تتكلم مع أي مزوّد مباشرة — كل توليد يمر عبر ai-gateway.
//
// ⚠ حدود أمنية مقصودة في هذه المرحلة:
//   لا يوجد تنفيذ كود، ولا نظام ملفات حقيقي، ولا طرفية (terminal) حقيقية.
//   workspace مجرد بيان للقراءة، ونقاط الامتداد التالية معرَّفة بالاسم فقط
//   وتُرجع "غير مفعّلة" حتى يوفّرها backend مخصّص لاحقًا:
//       sandbox • repository • github • filesystem • terminal • code_execution
//   إضافة أي منها لاحقًا = تفعيل العلم في ai_sessions.extensions + مُنفِّذ
//   في الخادم، دون تغيير أي شيء في الواجهة.
// ============================================================================

const CORS_HEADERS: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

/** أقصى عدد رسائل سابقة تُرسل كسياق. الجلسات الطويلة تُقصّ من البداية. */
const HISTORY_LIMIT = 24;

/** نقاط الامتداد المعرَّفة. القيمة false = المُنفِّذ غير موجود بعد. */
const EXTENSION_POINTS = ["sandbox", "repository", "github", "filesystem", "terminal", "code_execution"];

async function callGateway(payload: Record<string, unknown>) {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/ai-gateway`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        },
        body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.error) throw new Error(data?.error || `فشل نداء ai-gateway (كود ${res.status})`);
    return data;
}

Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
    if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

    try {
        const authHeader = req.headers.get("Authorization");
        if (!authHeader) return jsonResponse({ error: "Missing Authorization header" }, 401);

        const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
        const { data: userData, error: userError } = await userClient.auth.getUser();
        if (userError || !userData?.user) return jsonResponse({ error: "Unauthorized" }, 401);

        const { data: isAdminData } = await userClient.rpc("is_admin");
        if (!isAdminData) return jsonResponse({ error: "هذه العملية متاحة لمديري المنصة فقط" }, 403);

        const userId = userData.user.id;
        const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

        let body: Record<string, any>;
        try { body = await req.json(); } catch { return jsonResponse({ error: "Invalid JSON body" }, 400); }

        const action = body.action;

        // ------------------------------------------------------------------
        if (action === "list") {
            const { data, error } = await adminClient
                .from("ai_sessions")
                .select("id, title, mode, integration_id, model_id, status, total_tokens, total_cost, last_active_at, created_at")
                .eq("owner_id", userId)
                .eq("status", body.status || "active")
                .order("last_active_at", { ascending: false })
                .limit(Number(body.limit) || 50);
            if (error) throw error;
            return jsonResponse({ success: true, sessions: data || [] });
        }

        // ------------------------------------------------------------------
        if (action === "create") {
            const { data, error } = await adminClient.from("ai_sessions").insert({
                owner_id: userId,
                title: (body.title || "").trim() || "جلسة جديدة",
                mode: body.mode || "chat",
                integration_id: body.integration_id || null,
                model_id: body.model_id || null,
                system_prompt: body.system_prompt || null,
            }).select("*").single();
            if (error) throw error;
            return jsonResponse({ success: true, session: data });
        }

        // ------------------------------------------------------------------
        if (action === "get") {
            const sessionId = (body.session_id || "").trim();
            if (!sessionId) return jsonResponse({ error: "session_id مطلوب" }, 400);

            const { data: session } = await adminClient
                .from("ai_sessions").select("*").eq("id", sessionId).eq("owner_id", userId).maybeSingle();
            if (!session) return jsonResponse({ error: "الجلسة غير موجودة" }, 404);

            const { data: messages } = await adminClient
                .from("ai_session_messages")
                .select("id, role, content, mode, model_id, tool_calls, usage, channel, error, created_at")
                .eq("session_id", sessionId)
                .order("created_at", { ascending: true })
                .limit(500);

            return jsonResponse({ success: true, session, messages: messages || [], extension_points: EXTENSION_POINTS });
        }

        // ------------------------------------------------------------------
        if (action === "update") {
            const sessionId = (body.session_id || "").trim();
            if (!sessionId) return jsonResponse({ error: "session_id مطلوب" }, 400);

            const patch: Record<string, unknown> = {};
            if (typeof body.title === "string" && body.title.trim()) patch.title = body.title.trim();
            if (body.mode) patch.mode = body.mode;
            if ("integration_id" in body) patch.integration_id = body.integration_id || null;
            if ("model_id" in body) patch.model_id = body.model_id || null;
            if ("system_prompt" in body) patch.system_prompt = body.system_prompt || null;
            if (body.status === "active" || body.status === "archived") patch.status = body.status;
            if (!Object.keys(patch).length) return jsonResponse({ error: "لا يوجد ما يُحدَّث" }, 400);

            const { data, error } = await adminClient
                .from("ai_sessions").update(patch).eq("id", sessionId).eq("owner_id", userId).select("*").single();
            if (error) throw error;
            return jsonResponse({ success: true, session: data });
        }

        // ------------------------------------------------------------------
        if (action === "delete") {
            const sessionId = (body.session_id || "").trim();
            if (!sessionId) return jsonResponse({ error: "session_id مطلوب" }, 400);
            const { error } = await adminClient.from("ai_sessions").delete().eq("id", sessionId).eq("owner_id", userId);
            if (error) throw error;
            return jsonResponse({ success: true });
        }

        // ------------------------------------------------------------------
        if (action === "send") {
            const sessionId = (body.session_id || "").trim();
            const message = (body.message || "").trim();
            if (!sessionId || !message) return jsonResponse({ error: "session_id و message مطلوبين" }, 400);

            const { data: session } = await adminClient
                .from("ai_sessions").select("*").eq("id", sessionId).eq("owner_id", userId).maybeSingle();
            if (!session) return jsonResponse({ error: "الجلسة غير موجودة" }, 404);

            const mode = body.mode || session.mode || "chat";

            // سياق المحادثة: آخر HISTORY_LIMIT رسالة من قناة الجلسة فقط
            const { data: recent } = await adminClient
                .from("ai_session_messages")
                .select("role, content")
                .eq("session_id", sessionId)
                .eq("channel", "session")
                .in("role", ["user", "assistant"])
                .order("created_at", { ascending: false })
                .limit(HISTORY_LIMIT);

            const history = (recent || []).reverse()
                .filter((m: any) => m.content)
                .map((m: any) => ({ role: m.role, content: m.content }));

            await adminClient.from("ai_session_messages").insert({
                session_id: sessionId, role: "user", content: message, mode, channel: "session",
            });

            let result: any;
            try {
                result = await callGateway({
                    action: "generate",
                    integration_id: body.integration_id || session.integration_id || undefined,
                    model: body.model_id || session.model_id || undefined,
                    mode,
                    system: session.system_prompt || undefined,
                    messages: [...history, { role: "user", content: message }],
                    source: "coding_session",
                    session_id: sessionId,
                    user_id: userId,
                });
            } catch (err) {
                const errMessage = (err as Error).message;
                await adminClient.from("ai_session_messages").insert({
                    session_id: sessionId, role: "event", content: errMessage,
                    mode, channel: "logs", error: errMessage,
                });
                return jsonResponse({ error: errMessage }, 502);
            }

            const usage = result.usage || {};
            const { data: assistantMessage } = await adminClient.from("ai_session_messages").insert({
                session_id: sessionId,
                role: "assistant",
                content: result.reply || "",
                mode,
                model_id: result.model || null,
                tool_calls: result.tool_calls || [],
                usage,
                channel: "session",
            }).select("*").single();

            // أثر تشغيلي مقروء في تبويب Logs (من أي مزوّد/موديل جاء الرد وبكم)
            await adminClient.from("ai_session_messages").insert({
                session_id: sessionId,
                role: "event",
                channel: "logs",
                mode,
                content: `${result.provider}/${result.model} • ${usage.total_tokens ?? 0} توكن • ${usage.latency_ms ?? 0}ms • $${Number(usage.cost ?? 0).toFixed(6)}`,
                usage,
            });

            await adminClient.from("ai_sessions").update({
                last_active_at: new Date().toISOString(),
                total_tokens: (session.total_tokens || 0) + (usage.total_tokens || 0),
                total_cost: Number(session.total_cost || 0) + Number(usage.cost || 0),
                integration_id: session.integration_id || result.integration_id || null,
                model_id: session.model_id || result.model || null,
            }).eq("id", sessionId);

            return jsonResponse({
                success: true,
                message: assistantMessage,
                provider: result.provider,
                model: result.model,
                usage,
                attempts: result.attempts || [],
            });
        }

        // ------------------------------------------------------------------
        // نقاط الامتداد — معرَّفة بالاسم، غير مفعّلة عمدًا في هذه المرحلة
        if (EXTENSION_POINTS.includes(action)) {
            return jsonResponse({
                error: `الامتداد "${action}" معرَّف لكنه غير مفعّل في هذه البيئة`,
                code: "extension_not_enabled",
                extension: action,
            }, 501);
        }

        return jsonResponse({
            error: "action غير معروف. المتاح: list | create | get | update | delete | send",
        }, 400);
    } catch (err) {
        console.error("[ai-session] unexpected error:", err);
        return jsonResponse({ error: "حدث خطأ غير متوقع: " + (err as Error).message }, 500);
    }
});
