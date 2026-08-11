import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

import { CORS_HEADERS, jsonResponse } from "./cors.ts";
import { decryptJson } from "./crypto.ts";
import {
    loadCatalog, getCatalogRow, resolveProtocol, resolveBaseUrl, resolveDiscoveryProtocols,
    CatalogRow, IntegrationRow,
} from "./catalog.ts";
import {
    callProvider, discoverModels, listProtocols, resolveProtocolAdapter, readProviderError,
    chatEndpointFor, maskUrl, detectBotChallenge,
    ChatTurn, GenerateRequest, DiscoveryAttempt,
} from "./protocols.ts";
import { categorize, computeCost, DiscoveredModel } from "./capabilities.ts";
import { resolveChain, Candidate } from "./router.ts";
import { logUsage, lookupModelPricing } from "./usage.ts";

// ============================================================================
// ai-gateway
// ----------------------------------------------------------------------------
// نقطة التشغيل الوحيدة التي تتكلم مع مزوّدي الذكاء الاصطناعي.
// لوحة الإدارة (admin/mcp.html) لا تنادي أي مزوّد إطلاقًا — تقرأ وتكتب
// إعدادات فقط، وكل نداء فعلي يمر من هنا.
//
// الطبقات:  Request → Router (سلسلة مرشّحين) → Catalog (مزوّد+بروتوكول+رابط)
//                   → ProtocolAdapter (شكل الـ API) → Provider
//                   → Usage (توكنات/تكلفة/زمن استجابة)
//
// إضافة مزوّد جديد    = صف في ai_provider_catalog.       صفر تعديل هنا.
// إضافة بروتوكول جديد = كائن في protocols.ts + سطر تسجيل. صفر تعديل هنا.
// ============================================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

interface Caller {
    internal: boolean;
    userId: string | null;
    isAdmin: boolean;
}

/**
 * نداء داخلي (server-to-server من Edge Function أخرى بمفتاح service_role)
 * يُعتبر موثوقًا. أي شيء آخر لازم JWT مستخدم صالح.
 */
async function resolveCaller(req: Request, body: Record<string, any>): Promise<Caller | null> {
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!token) return null;

    if (SERVICE_ROLE_KEY && token === SERVICE_ROLE_KEY) {
        return { internal: true, userId: body.user_id || null, isAdmin: true };
    }

    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
        global: { headers: { Authorization: authHeader } },
    });
    const { data, error } = await userClient.auth.getUser();
    if (error || !data?.user) return null;

    const { data: isAdminData } = await userClient.rpc("is_admin");
    return { internal: false, userId: data.user.id, isAdmin: !!isAdminData };
}

async function decryptCredentials(integration: IntegrationRow): Promise<Record<string, any>> {
    if (!integration.credentials_encrypted) throw new Error("لا توجد مفاتيح محفوظة لهذا التكامل");
    try {
        return await decryptJson(integration.credentials_encrypted);
    } catch {
        throw new Error("فشل فك تشفير مفاتيح التكامل");
    }
}

const INTEGRATION_COLUMNS = "id, provider, display_name, protocol, base_url, base_urls, credentials_encrypted, credentials_meta, capabilities_override, is_active, priority";

// ----------------------------------------------------------------------------
// حفظ الموديلات المكتشفة
// ----------------------------------------------------------------------------
async function saveDiscoveredModels(
    adminClient: any,
    integrationId: string,
    discovered: DiscoveredModel[],
    preferredDefault?: string,
): Promise<any[]> {
    if (!discovered.length) return [];

    const { data: existingRows } = await adminClient
        .from("external_integration_models")
        .select("model_id, is_enabled, is_default, capabilities_source, category, supports_vision, supports_tools, supports_reasoning, supports_coding, supports_agent, supports_long_context")
        .eq("integration_id", integrationId);

    const existingMap = new Map<string, any>((existingRows || []).map((r: any) => [r.model_id, r]));
    const isFirstSync = !existingRows?.length;
    const hadDefault = (existingRows || []).some((r: any) => r.is_default);

    const rows = discovered.map((m, idx) => {
        const existing = existingMap.get(m.model_id);

        // القدرات التي عدّلها الأدمن يدويًا لا تُدهس أبدًا بإعادة المزامنة
        const keepManual = existing?.capabilities_source === "manual";

        let isDefault = existing?.is_default ?? false;
        if (!hadDefault && !isDefault) {
            if (preferredDefault && m.model_id === preferredDefault) isDefault = true;
            else if (isFirstSync && !preferredDefault && idx === 0) isDefault = true;
        }

        const base = {
            integration_id: integrationId,
            model_id: m.model_id,
            display_name: m.display_name || m.model_id,
            supports_chat: m.supports_chat ?? true,
            supports_streaming: m.supports_streaming ?? true,
            context_window: m.context_window ?? null,
            max_output_tokens: m.max_output_tokens ?? null,
            input_price: m.input_price ?? null,
            output_price: m.output_price ?? null,
            is_enabled: existing?.is_enabled ?? true,
            is_default: isDefault,
            metadata: m.metadata || {},
            discovered_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        };

        if (keepManual) {
            return {
                ...base,
                capabilities_source: "manual",
                category: existing.category,
                supports_vision: existing.supports_vision,
                supports_tools: existing.supports_tools,
                supports_reasoning: existing.supports_reasoning,
                supports_coding: existing.supports_coding,
                supports_agent: existing.supports_agent,
                supports_long_context: existing.supports_long_context,
            };
        }

        return {
            ...base,
            capabilities_source: "heuristic",
            category: categorize(m),
            supports_vision: !!m.supports_vision,
            supports_tools: !!m.supports_tools,
            supports_reasoning: !!m.supports_reasoning,
            supports_coding: !!m.supports_coding,
            supports_agent: !!m.supports_agent,
            supports_long_context: !!m.supports_long_context,
            supports_audio: !!m.supports_audio,
        };
    });

    const { data: saved, error } = await adminClient
        .from("external_integration_models")
        .upsert(rows, { onConflict: "integration_id,model_id" })
        .select("id, model_id, display_name, category, supports_chat, supports_vision, supports_tools, supports_streaming, supports_reasoning, supports_coding, supports_agent, supports_long_context, context_window, max_output_tokens, input_price, output_price, is_enabled, is_default, capabilities_source");

    if (error) {
        console.error("[ai-gateway] saveDiscoveredModels failed:", error.message);
        return [];
    }
    return saved || [];
}

// ----------------------------------------------------------------------------
// تلميح تشخيصي بعد فشل نداء
// ----------------------------------------------------------------------------
/**
 * نصيحة مبنية على الرابط الذي جُرّب فعلاً، لا على افتراض عام.
 * السبب: التلميح الثابت "أضِف /v1" كان يظهر حتى لمن رابطه منتهٍ بـ /v1 أصلاً،
 * فيبدو أن الخطأ من المستخدم بينما المشكلة في مكان آخر تمامًا.
 */
function buildEndpointHint(protocol: string, endpoint: string | null): string | null {
    if (!endpoint) {
        return "لم يُبنَ أي رابط — تأكّد من وجود Base URL لهذا البروتوكول في إعدادات الربط.";
    }

    let path = endpoint;
    try { path = new URL(endpoint).pathname; } catch { /* رابط غير قابل للتحليل: نفحص النص كما هو */ }

    // /v1/v1/... يعني أن الـ Base URL يتضمّن نسخة API والبروتوكول أضاف أخرى
    if (/\/v\d+(beta)?\/v\d+(beta)?\//i.test(path)) {
        return "الرابط يحتوي على نسخة API مكرّرة (مثل /v1/v1) — احذف الجزء الزائد من Base URL.";
    }

    if (protocol === "openai") {
        return /\/v\d+/i.test(path)
            ? "الرابط يبدو صحيح الشكل. تحقّق من صلاحية المفتاح وأن هذا المضيف هو مضيف الـ API وليس الموقع التعريفي."
            : "بروتوكول OpenAI يحتاج Base URL منتهيًا بمسار النسخة (غالبًا /v1).";
    }

    if (protocol === "anthropic") {
        return /\/v\d+/i.test(path.replace(/\/v1\/(messages|models)$/i, ""))
            ? "بروتوكول Anthropic يضيف /v1 بنفسه — احذف /v1 من نهاية Base URL."
            : "تحقّق من صلاحية المفتاح وأن Base URL هو مضيف الـ API (بدون /v1 في آخره).";
    }

    if (protocol === "gemini") {
        return "بروتوكول Gemini يتوقّع Base URL منتهيًا بمسار النسخة (غالبًا /v1beta) والمفتاح يُمرَّر في الرابط.";
    }

    return "راجع Base URL والمسارات المخصّصة لهذا المزوّد في كتالوج المزوّدين.";
}

// ----------------------------------------------------------------------------
// action: generate  — التوليد مع سلسلة الاحتياطي
// ----------------------------------------------------------------------------
async function handleGenerate(adminClient: any, catalog: Map<string, CatalogRow>, body: any, caller: Caller) {
    const messages: ChatTurn[] = Array.isArray(body.messages) ? body.messages : [];
    if (!messages.length) return jsonResponse({ error: "messages مطلوبة" }, 400);

    const mode = (body.mode || "").trim() || null;

    // إعدادات الوضع (system prompt / حرارة / أدوات) بيانات في قاعدة البيانات، ليست كودًا
    let modeRow: any = null;
    if (mode) {
        const { data } = await adminClient.from("ai_agent_modes").select("*").eq("id", mode).maybeSingle();
        modeRow = data;
    }

    const chain = await resolveChain(adminClient, catalog, {
        integration_id: body.integration_id,
        model: body.model,
        mode: mode || undefined,
        capability: body.capability,
        limit: Number(body.max_attempts) || 4,
    });

    if (!chain.length) {
        return jsonResponse({ error: "لا يوجد أي مزوّد فعّال بمفاتيح صالحة. أضِف مزوّدًا من تبويب AI أولًا." }, 400);
    }

    const requestId = crypto.randomUUID();
    const attempts: any[] = [];

    for (let i = 0; i < chain.length; i++) {
        const candidate: Candidate = chain[i];
        const integration = candidate.integration;
        const isLast = i === chain.length - 1;
        const startedAt = Date.now();

        let catalogRow: CatalogRow;
        let protocol = "";
        try {
            catalogRow = getCatalogRow(catalog, integration.provider);
            protocol = resolveProtocol(integration, catalogRow);
            const creds = await decryptCredentials(integration);

            if (!candidate.model_id) throw new Error("لم يُحدَّد موديل لهذا التكامل — شغّل مزامنة الموديلات أولًا");

            const req: GenerateRequest = {
                model: candidate.model_id,
                system: body.system || modeRow?.system_prompt || undefined,
                messages,
                temperature: body.temperature ?? (modeRow ? Number(modeRow.temperature) : undefined),
                max_tokens: body.max_tokens ?? modeRow?.max_output_tokens ?? undefined,
                tools: modeRow && modeRow.allow_tools === false ? undefined : body.tools,
            };

            const result = await callProvider(integration, catalogRow, protocol, creds, req);
            const latency = Date.now() - startedAt;

            const pricing = await lookupModelPricing(adminClient, integration.id, candidate.model_id);
            const cost = computeCost(result.input_tokens, result.output_tokens, pricing.input, pricing.output);

            await logUsage(adminClient, {
                integration_id: integration.id,
                provider: integration.provider,
                protocol,
                model_id: candidate.model_id,
                mode,
                source: body.source || "admin",
                session_id: body.session_id || null,
                request_id: requestId,
                user_id: caller.userId,
                status: "success",
                input_tokens: result.input_tokens,
                output_tokens: result.output_tokens,
                total_tokens: result.total_tokens,
                cost,
                latency_ms: latency,
                attempt: i + 1,
            });

            adminClient.from("external_integrations")
                .update({ last_used_at: new Date().toISOString() })
                .eq("id", integration.id).then(() => {});

            attempts.push({ integration_id: integration.id, provider: integration.provider, model: candidate.model_id, status: "success", latency_ms: latency });

            return jsonResponse({
                success: true,
                request_id: requestId,
                reply: result.text,
                text: result.text,
                tool_calls: result.tool_calls,
                finish_reason: result.finish_reason,
                provider: integration.provider,
                protocol,
                integration_id: integration.id,
                integration_name: integration.display_name,
                model: candidate.model_id,
                mode,
                route_origin: candidate.origin,
                usage: {
                    input_tokens: result.input_tokens,
                    output_tokens: result.output_tokens,
                    total_tokens: result.total_tokens,
                    cost,
                    latency_ms: latency,
                },
                attempts,
            });
        } catch (err) {
            const latency = Date.now() - startedAt;
            const message = (err as Error).message || "خطأ غير معروف";
            console.error(`[ai-gateway] المحاولة ${i + 1} فشلت (${integration.provider}):`, message);

            await logUsage(adminClient, {
                integration_id: integration.id,
                provider: integration.provider,
                protocol,
                model_id: candidate.model_id,
                mode,
                source: body.source || "admin",
                session_id: body.session_id || null,
                request_id: requestId,
                user_id: caller.userId,
                status: isLast ? "error" : "fallback",
                error_message: message,
                latency_ms: latency,
                attempt: i + 1,
            });

            attempts.push({
                integration_id: integration.id,
                provider: integration.provider,
                model: candidate.model_id,
                status: isLast ? "error" : "fallback",
                error: message,
                latency_ms: latency,
            });
        }
    }

    return jsonResponse({
        success: false,
        request_id: requestId,
        error: "فشلت كل المحاولات (الأساسي وكل الاحتياطيات)",
        attempts,
    }, 502);
}

// ----------------------------------------------------------------------------
// action: list_models / sync_models
// ----------------------------------------------------------------------------
async function handleListModels(adminClient: any, catalog: Map<string, CatalogRow>, body: any) {
    const id = (body.integration_id || "").trim();
    if (!id) return jsonResponse({ error: "integration_id مطلوب" }, 400);

    const { data: integration } = await adminClient
        .from("external_integrations").select(INTEGRATION_COLUMNS).eq("id", id).maybeSingle();
    if (!integration) return jsonResponse({ error: "التكامل غير موجود" }, 404);

    const catalogRow = getCatalogRow(catalog, integration.provider);
    const protocols = resolveDiscoveryProtocols(integration, catalogRow);
    if (!protocols.length) {
        return jsonResponse({ success: true, models: [], message: "هذا المزوّد لا يدعم اكتشاف الموديلات" });
    }

    const creds = await decryptCredentials(integration);

    // كل المسارات المجرَّبة تُرجَع (نجاحًا أو فشلًا) — بدونها لا يعرف المستخدم
    // أي مضيف/مسار لُمس فعلًا، وهو أول ما يحتاجه لتشخيص 401 أو رد HTML.
    const outcome = await discoverModels(integration, catalogRow, protocols, creds);

    if (!outcome.protocol) {
        const last = outcome.attempts[outcome.attempts.length - 1];
        return jsonResponse({
            error: "فشل جلب الموديلات على كل المسارات المتاحة: " + (last?.error || "سبب غير معروف"),
            endpoint: last?.endpoint || null,
            protocol: last?.protocol || null,
            attempts: outcome.attempts,
            hint: buildEndpointHint(last?.protocol || "", last?.endpoint || null),
        }, 502);
    }

    const saved = await saveDiscoveredModels(adminClient, id, outcome.models, integration.credentials_meta?.model);
    return jsonResponse({
        success: true,
        discovered: outcome.models.length,
        models: saved,
        protocol: outcome.protocol,
        endpoint: outcome.endpoint,
        attempts: outcome.attempts,
        message: outcome.models.length
            ? `تم اكتشاف ${outcome.models.length} موديل عبر بروتوكول ${outcome.protocol}`
            : `المسار ${outcome.endpoint} ردّ بنجاح لكنه لم يُرجع أي موديل — أضِف الموديلات يدويًا.`,
    });
}

// ----------------------------------------------------------------------------
// action: add_model — إضافة موديل يدويًا
// ----------------------------------------------------------------------------
// مخرج ضروري: بعض البوابات لا تعرض /models إطلاقًا، أو تحصر المفتاح في موديلات
// بعينها. بدون هذا المسار يبقى المستخدم عالقًا لو فشل الاكتشاف التلقائي.
async function handleAddModel(adminClient: any, body: any) {
    const integrationId = (body.integration_id || "").trim();
    const modelId = (body.model_id || "").trim();
    if (!integrationId || !modelId) return jsonResponse({ error: "integration_id و model_id مطلوبان" }, 400);

    const { data: integration } = await adminClient
        .from("external_integrations").select("id").eq("id", integrationId).maybeSingle();
    if (!integration) return jsonResponse({ error: "التكامل غير موجود" }, 404);

    const caps = body.capabilities || {};
    const { data, error } = await adminClient
        .from("external_integration_models")
        .upsert({
            integration_id: integrationId,
            model_id: modelId,
            display_name: (body.display_name || "").trim() || modelId,
            supports_chat: true,
            supports_vision: !!caps.vision,
            supports_tools: !!caps.tools,
            supports_streaming: caps.streaming !== false,
            supports_reasoning: !!caps.reasoning,
            supports_coding: !!caps.coding,
            supports_agent: !!caps.agent,
            supports_long_context: !!caps.longContext,
            context_window: body.context_window ?? null,
            is_enabled: true,
            capabilities_source: "manual",
            category: body.category || "general",
            updated_at: new Date().toISOString(),
        }, { onConflict: "integration_id,model_id" })
        .select("*")
        .single();

    if (error) return jsonResponse({ error: "فشل حفظ الموديل: " + error.message }, 500);
    return jsonResponse({ success: true, model: data, message: `تمت إضافة ${modelId}` });
}

// ----------------------------------------------------------------------------
// action: test — فحص الاتصال
// ----------------------------------------------------------------------------

/** الموديل الذي سيُستخدم في فحص الاتصال: المحدّد يدويًا، ثم المكتشف، ثم كتالوج المزوّد. */
async function resolveTestModel(adminClient: any, integration: any, catalogRow: CatalogRow): Promise<string | null> {
    const fromMeta = (integration.credentials_meta?.model || "").trim();
    if (fromMeta) return fromMeta;

    const { data } = await adminClient
        .from("external_integration_models")
        .select("model_id")
        .eq("integration_id", integration.id)
        .eq("is_enabled", true)
        .order("is_default", { ascending: false })
        .limit(1);

    return data?.[0]?.model_id || (catalogRow.default_model || "").trim() || null;
}

async function handleTest(adminClient: any, catalog: Map<string, CatalogRow>, body: any) {
    const id = (body.integration_id || "").trim();
    if (!id) return jsonResponse({ error: "integration_id مطلوب" }, 400);

    const { data: integration } = await adminClient
        .from("external_integrations").select(INTEGRATION_COLUMNS).eq("id", id).maybeSingle();
    if (!integration) return jsonResponse({ error: "التكامل غير موجود" }, 404);

    const catalogRow = getCatalogRow(catalog, integration.provider);
    const protocol = resolveProtocol(integration, catalogRow);
    const discoveryProtocols = resolveDiscoveryProtocols(integration, catalogRow);

    let ok = false;
    let message = "";
    let endpoint: string | null = null;
    let method = "";
    const attempts: DiscoveryAttempt[] = [];
    const startedAt = Date.now();

    try {
        const creds = await decryptCredentials(integration);

        // (1) أرخص فحص وأدقّه: قائمة الموديلات. نجرّبها على كل بروتوكول يدعمه
        //     المزوّد لأن البوابات المجمِّعة قد تعرضها على مسار بروتوكول آخر.
        for (const p of discoveryProtocols) {
            const adapter = resolveProtocolAdapter(p);
            if (!adapter.probe) continue;
            method = "models";
            let url = "";
            try {
                const base = resolveBaseUrl(integration, catalogRow, p);
                const probe = adapter.probe(base, catalogRow, creds);
                url = probe.url;
                endpoint = maskUrl(url);
                const res = await fetch(url, probe.init);

                // res.ok وحده لا يكفي: مواقع الويب تُرجع صفحة SPA بكود 200 لأي
                // مسار غير معروف، فكان الفحص يعلن "متصل" وهو لم يلمس API إطلاقًا.
                const contentType = res.headers.get("content-type") || "";
                if (!res.ok) {
                    message = `${catalogRow.label} رفض الاتّصال (${await readProviderError(res)})`;
                } else if (!/json/i.test(contentType)) {
                    const body = await res.text().catch(() => "");
                    const challenge = detectBotChallenge(body);
                    message = challenge
                        ? `المضيف ردّ بصفحة تحقّق بشري (${challenge}) — يحجب الطلبات من الخوادم ويطلب كابتشا في متصفّح. `
                          + `الرابط والمفتاح ليسا السبب؛ يلزم استثناء عناوين خوادمك لدى المزوّد أو مضيف API للاتّصال من خادم إلى خادم.`
                        : `الرابط رجّع ${contentType || "محتوى غير معروف"} بدل JSON — هذا مسار موقع وليس واجهة API.`;
                } else {
                    ok = true;
                    message = `تم الاتّصال بنجاح مع ${catalogRow.label} عبر بروتوكول ${p}`;
                }
            } catch (probeErr) {
                message = (probeErr as Error).message;
            }
            attempts.push({ protocol: p, endpoint: endpoint, ok, count: 0, error: ok ? undefined : message });
            if (ok) break;
        }

        // (2) بوابات كثيرة لا تعرض قائمة موديلات على أي مسار (AgentRouter كان
        //     يبدو كذلك)، فالفحص الصادق الوحيد المتبقي هو نداء توليد حقيقي
        //     بأقل تكلفة ممكنة. لا نُسقط الفحص لمجرد أن القائمة غير متاحة.
        if (!ok) {
            method = "generate";
            const model = await resolveTestModel(adminClient, integration, catalogRow);
            if (!model) {
                message = message || "لا يوجد موديل للاختبار — أضِف موديلًا يدويًا من تبويب الموديلات أولًا.";
            } else {
                endpoint = chatEndpointFor(integration, catalogRow, protocol, model, creds);
                try {
                    await callProvider(integration, catalogRow, protocol, creds, {
                        model,
                        messages: [{ role: "user", content: "ping" }],
                        max_tokens: 8,
                        temperature: 0,
                    }, 30_000);
                    ok = true;
                    message = `تم الاتّصال بنجاح مع ${catalogRow.label} عبر نداء توليد بالموديل ${model}`;
                } catch (callErr) {
                    const detail = (callErr as Error).message || "";
                    // رد فارغ ما زال دليلًا على أن الـ API استُدعي وردّ JSON صالحًا
                    if (/رد فارغ/.test(detail)) {
                        ok = true;
                        message = `تم الاتّصال بنجاح مع ${catalogRow.label} (رد قصير) بالموديل ${model}`;
                    } else {
                        message = `${catalogRow.label} رفض النداء: ${detail}`;
                    }
                }
                attempts.push({ protocol, endpoint, ok, count: 0, error: ok ? undefined : message });
            }
        }
    } catch (err) {
        message = "تعذّر الاتّصال: " + (err as Error).message;
    }

    await adminClient.from("external_integrations").update({
        last_tested_at: new Date().toISOString(),
        last_test_status: ok ? "success" : "failed",
        last_test_message: message,
    }).eq("id", id);

    return jsonResponse({
        success: ok,
        message,
        protocol,
        endpoint,
        method,
        attempts,
        hint: ok ? null : buildEndpointHint(protocol, endpoint),
        latency_ms: Date.now() - startedAt,
    });
}

// ----------------------------------------------------------------------------
// action: resolve_route — معاينة سلسلة الاحتياطي بدون أي نداء لمزوّد
// ----------------------------------------------------------------------------
async function handleResolveRoute(adminClient: any, catalog: Map<string, CatalogRow>, body: any) {
    const chain = await resolveChain(adminClient, catalog, {
        mode: body.mode,
        capability: body.capability,
        limit: Number(body.max_attempts) || 4,
    });

    return jsonResponse({
        success: true,
        chain: chain.map((c, idx) => ({
            position: idx,
            role: idx === 0 ? "primary" : `fallback_${idx}`,
            integration_id: c.integration.id,
            integration_name: c.integration.display_name,
            provider: c.integration.provider,
            protocol: resolveProtocol(c.integration, getCatalogRow(catalog, c.integration.provider)),
            model: c.model_id,
            origin: c.origin,
        })),
    });
}

// ----------------------------------------------------------------------------
Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
    if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

    try {
        let body: Record<string, any>;
        try { body = await req.json(); } catch { return jsonResponse({ error: "Invalid JSON body" }, 400); }

        const caller = await resolveCaller(req, body);
        if (!caller) return jsonResponse({ error: "Unauthorized" }, 401);
        if (!caller.isAdmin) return jsonResponse({ error: "هذه العملية متاحة لمديري المنصة فقط" }, 403);

        const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
        const catalog = await loadCatalog(adminClient, body.refresh_catalog === true);

        switch (body.action) {
            case "generate":
                return await handleGenerate(adminClient, catalog, body, caller);
            case "list_models":
            case "sync_models":
                return await handleListModels(adminClient, catalog, body);
            case "test":
                return await handleTest(adminClient, catalog, body);
            case "add_model":
                return await handleAddModel(adminClient, body);
            case "resolve_route":
                return await handleResolveRoute(adminClient, catalog, body);
            case "capabilities":
                return jsonResponse({
                    success: true,
                    protocols: listProtocols(),
                    providers: [...catalog.values()].filter((c) => c.is_enabled).map((c) => c.id),
                });
            default:
                return jsonResponse({
                    error: "action غير معروف. المتاح: generate | list_models | add_model | test | resolve_route | capabilities",
                }, 400);
        }
    } catch (err) {
        console.error("[ai-gateway] unexpected error:", err);
        return jsonResponse({ error: "حدث خطأ غير متوقع: " + (err as Error).message }, 500);
    }
});
