// ============================================================================
// Protocol Adapters — الطبقة الوحيدة التي تعرف شكل الـ API لكل بروتوكول.
// ----------------------------------------------------------------------------
//   AIProvider → ProviderAdapter (catalog.ts) → ProtocolAdapter (هنا) → Model
//
// إضافة بروتوكول جديد = ملف/كائن جديد + سطر تسجيل واحد في PROTOCOLS.
// لا شيء في index.ts أو router.ts أو usage.ts يتغيّر.
// ============================================================================

import {
    CatalogRow, IntegrationRow, resolveBaseUrl, resolvePath,
} from "./catalog.ts";
import { DiscoveredModel, enrichCapabilities, isChatLikeModel } from "./capabilities.ts";

export interface ChatTurn {
    role: "user" | "assistant" | "system";
    content: string;
}

export interface GenerateRequest {
    model: string;
    system?: string;
    messages: ChatTurn[];
    temperature?: number;
    max_tokens?: number;
    tools?: any[];
    stream?: boolean;
}

export interface GenerateResult {
    text: string;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    finish_reason?: string;
    tool_calls: any[];
}

export interface ProtocolAdapter {
    id: string;
    /** رابط نداء التوليد الكامل. */
    chatUrl(base: string, catalogRow: CatalogRow, req: GenerateRequest, creds: Record<string, any>): string;
    /** رابط قائمة الموديلات الكامل، أو null لو المزوّد لا يدعم الاكتشاف. */
    modelsUrl(base: string, catalogRow: CatalogRow, creds: Record<string, any>): string | null;
    headers(creds: Record<string, any>, catalogRow: CatalogRow): Record<string, string>;
    buildBody(req: GenerateRequest): unknown;
    parseResponse(json: any): GenerateResult;
    parseModels(json: any): DiscoveredModel[];
    /** نداء خفيف للتأكد من صلاحية المفتاح فقط. */
    probe?(base: string, catalogRow: CatalogRow, creds: Record<string, any>): { url: string; init: RequestInit };
}

const emptyResult = (): GenerateResult => ({
    text: "", input_tokens: 0, output_tokens: 0, total_tokens: 0, tool_calls: [],
});

// ----------------------------------------------------------------------------
// OpenAI-compatible  (OpenAI, Groq, OpenRouter, AgentRouter/openai, DeepSeek, …)
// الـ base يتضمّن /v1 بالفعل — لا نضيفه هنا إطلاقًا.
// ----------------------------------------------------------------------------
const openaiAdapter: ProtocolAdapter = {
    id: "openai",

    chatUrl: (base, row) => base + resolvePath(row, "openai", "chat", "/chat/completions"),
    modelsUrl: (base, row) => base + resolvePath(row, "openai", "models", "/models"),

    headers: (creds, row) => ({
        "Content-Type": "application/json",
        Authorization: `Bearer ${creds.api_key || creds.bearer_token || ""}`,
        ...(row.default_headers || {}),
    }),

    buildBody: (req) => {
        const messages: any[] = [];
        if (req.system) messages.push({ role: "system", content: req.system });
        messages.push(...req.messages);
        const body: Record<string, unknown> = {
            model: req.model,
            messages,
            temperature: req.temperature ?? 0.7,
            max_tokens: req.max_tokens ?? 2000,
        };
        if (req.tools?.length) body.tools = req.tools;
        return body;
    },

    parseResponse: (json) => {
        const choice = json?.choices?.[0];
        const usage = json?.usage || {};
        return {
            ...emptyResult(),
            text: String(choice?.message?.content ?? "").trim(),
            tool_calls: choice?.message?.tool_calls || [],
            finish_reason: choice?.finish_reason,
            input_tokens: Number(usage.prompt_tokens) || 0,
            output_tokens: Number(usage.completion_tokens) || 0,
            total_tokens: Number(usage.total_tokens) || 0,
        };
    },

    parseModels: (json) => (json?.data || [])
        .filter((m: any) => isChatLikeModel(String(m.id || "")))
        .map((m: any) => {
            const modalities: string[] = m.architecture?.input_modalities
                || (m.architecture?.modality ? [m.architecture.modality] : []);
            return enrichCapabilities({
                model_id: String(m.id),
                display_name: m.name || m.id,
                // OpenRouter وأمثاله يعلنون الطرائق صراحةً — نصدّقهم بدل التخمين
                supports_vision: modalities.length ? modalities.some((x) => /image/i.test(x)) : undefined,
                supports_tools: Array.isArray(m.supported_parameters)
                    ? m.supported_parameters.includes("tools")
                    : undefined,
                context_window: m.context_length ?? m.context_window ?? null,
                max_output_tokens: m.top_provider?.max_completion_tokens ?? null,
                input_price: m.pricing?.prompt != null ? Number(m.pricing.prompt) : null,
                output_price: m.pricing?.completion != null ? Number(m.pricing.completion) : null,
                metadata: { owned_by: m.owned_by ?? null, architecture: m.architecture ?? null },
            });
        }),

    probe: (base, row, creds) => ({
        url: base + resolvePath(row, "openai", "models", "/models"),
        init: { headers: { Authorization: `Bearer ${creds.api_key || creds.bearer_token || ""}` } },
    }),
};

// ----------------------------------------------------------------------------
// Anthropic-compatible  (api.anthropic.com, AgentRouter/anthropic, …)
// الـ base لا يتضمّن /v1 — المسار نفسه هو /v1/messages.
// ----------------------------------------------------------------------------
const ANTHROPIC_VERSION = "2023-06-01";

const anthropicAdapter: ProtocolAdapter = {
    id: "anthropic",

    chatUrl: (base, row) => base + resolvePath(row, "anthropic", "chat", "/v1/messages"),
    modelsUrl: (base, row) => base + resolvePath(row, "anthropic", "models", "/v1/models"),

    headers: (creds, row) => ({
        "Content-Type": "application/json",
        "x-api-key": creds.api_key || creds.bearer_token || "",
        "anthropic-version": ANTHROPIC_VERSION,
        ...(row.default_headers || {}),
    }),

    buildBody: (req) => {
        const body: Record<string, unknown> = {
            model: req.model,
            max_tokens: req.max_tokens ?? 2000,
            temperature: req.temperature ?? 0.7,
            // Anthropic يفصل الـ system عن الرسائل — لا يُحقن كدور داخل messages
            messages: req.messages
                .filter((m) => m.role !== "system")
                .map((m) => ({ role: m.role, content: m.content })),
        };
        if (req.system) body.system = req.system;
        if (req.tools?.length) body.tools = req.tools;
        return body;
    },

    parseResponse: (json) => {
        const blocks: any[] = json?.content || [];
        const usage = json?.usage || {};
        const input = Number(usage.input_tokens) || 0;
        const output = Number(usage.output_tokens) || 0;
        return {
            ...emptyResult(),
            text: blocks.filter((b) => b.type === "text").map((b) => b.text).join("").trim(),
            tool_calls: blocks.filter((b) => b.type === "tool_use"),
            finish_reason: json?.stop_reason,
            input_tokens: input,
            output_tokens: output,
            total_tokens: input + output,
        };
    },

    parseModels: (json) => (json?.data || []).map((m: any) => enrichCapabilities({
        model_id: String(m.id),
        display_name: m.display_name || m.id,
        supports_vision: true,
        supports_tools: true,
        supports_streaming: true,
        metadata: { created_at: m.created_at ?? null },
    })),

    probe: (base, row, creds) => ({
        url: base + resolvePath(row, "anthropic", "models", "/v1/models"),
        init: { headers: { "x-api-key": creds.api_key || "", "anthropic-version": ANTHROPIC_VERSION } },
    }),
};

// ----------------------------------------------------------------------------
// Gemini (Generative Language API) — المفتاح في الـ query string
// ----------------------------------------------------------------------------
const geminiAdapter: ProtocolAdapter = {
    id: "gemini",

    chatUrl: (base, row, req, creds) =>
        `${base}${resolvePath(row, "gemini", "chat", "/models")}/${req.model}:generateContent?key=${encodeURIComponent(creds.api_key || "")}`,

    modelsUrl: (base, row, creds) =>
        `${base}${resolvePath(row, "gemini", "models", "/models")}?key=${encodeURIComponent(creds.api_key || "")}`,

    headers: (_creds, row) => ({ "Content-Type": "application/json", ...(row.default_headers || {}) }),

    buildBody: (req) => {
        const body: Record<string, unknown> = {
            contents: req.messages
                .filter((m) => m.role !== "system")
                .map((m) => ({
                    role: m.role === "assistant" ? "model" : "user",
                    parts: [{ text: m.content }],
                })),
            generationConfig: {
                temperature: req.temperature ?? 0.7,
                maxOutputTokens: req.max_tokens ?? 2000,
            },
        };
        if (req.system) body.systemInstruction = { parts: [{ text: req.system }] };
        if (req.tools?.length) body.tools = req.tools;
        return body;
    },

    parseResponse: (json) => {
        const parts: any[] = json?.candidates?.[0]?.content?.parts || [];
        const usage = json?.usageMetadata || {};
        return {
            ...emptyResult(),
            text: parts.map((p) => p.text || "").join("").trim(),
            tool_calls: parts.filter((p) => p.functionCall).map((p) => p.functionCall),
            finish_reason: json?.candidates?.[0]?.finishReason,
            input_tokens: Number(usage.promptTokenCount) || 0,
            output_tokens: Number(usage.candidatesTokenCount) || 0,
            total_tokens: Number(usage.totalTokenCount) || 0,
        };
    },

    parseModels: (json) => (json?.models || [])
        .filter((m: any) => (m.supportedGenerationMethods || []).includes("generateContent"))
        .map((m: any) => {
            const id = String(m.name || "").replace(/^models\//, "");
            return enrichCapabilities({
                model_id: id,
                display_name: m.displayName || id,
                supports_streaming: (m.supportedGenerationMethods || []).includes("streamGenerateContent"),
                context_window: m.inputTokenLimit ?? null,
                max_output_tokens: m.outputTokenLimit ?? null,
                metadata: { supported_generation_methods: m.supportedGenerationMethods || [] },
            });
        }),

    probe: (base, row, creds) => ({
        url: `${base}${resolvePath(row, "gemini", "models", "/models")}?key=${encodeURIComponent(creds.api_key || "")}`,
        init: {},
    }),
};

// ----------------------------------------------------------------------------
// Custom HTTP — لأي مزوّد لا يتبع أيًا مما سبق. يفترض شكل OpenAI افتراضيًا
// ويسمح بتخصيص كامل للمسارات والترويسات من الكتالوج.
// ----------------------------------------------------------------------------
const customHttpAdapter: ProtocolAdapter = {
    id: "custom_http",
    chatUrl: (base, row) => base + resolvePath(row, "custom_http", "chat", ""),
    modelsUrl: (base, row) => {
        const path = resolvePath(row, "custom_http", "models", "");
        return path ? base + path : null;
    },
    headers: (creds, row) => {
        const h: Record<string, string> = { "Content-Type": "application/json", ...(row.default_headers || {}) };
        if (creds.api_key) h.Authorization = `Bearer ${creds.api_key}`;
        if (creds.bearer_token) h.Authorization = `Bearer ${creds.bearer_token}`;
        if (creds.headers && typeof creds.headers === "object") Object.assign(h, creds.headers);
        return h;
    },
    buildBody: openaiAdapter.buildBody,
    parseResponse: openaiAdapter.parseResponse,
    parseModels: openaiAdapter.parseModels,
};

// ----------------------------------------------------------------------------
// السجل (Registry)
// ----------------------------------------------------------------------------
const PROTOCOLS: Record<string, ProtocolAdapter> = {
    openai: openaiAdapter,
    anthropic: anthropicAdapter,
    gemini: geminiAdapter,
    custom_http: customHttpAdapter,
};

export function resolveProtocolAdapter(protocol: string): ProtocolAdapter {
    const adapter = PROTOCOLS[protocol];
    if (!adapter) {
        throw new Error(`البروتوكول "${protocol}" غير مسجَّل. المسجَّل حاليًا: ${Object.keys(PROTOCOLS).join(", ")}`);
    }
    return adapter;
}

export function listProtocols(): string[] {
    return Object.keys(PROTOCOLS);
}

/** قراءة رسالة خطأ مفهومة من رد المزوّد دون تسريب أي بيانات حسّاسة. */
export async function readProviderError(res: Response): Promise<string> {
    let detail = "";
    try {
        const txt = await res.text();
        const parsed = JSON.parse(txt);
        detail = parsed?.error?.message || parsed?.message || parsed?.error || txt.slice(0, 300);
    } catch {
        detail = "";
    }
    return `كود ${res.status}${detail ? ": " + String(detail).slice(0, 300) : ""}`;
}

/** تنفيذ نداء التوليد كاملًا عبر البروتوكول المناسب. */
export async function callProvider(
    integration: IntegrationRow,
    catalogRow: CatalogRow,
    protocol: string,
    creds: Record<string, any>,
    req: GenerateRequest,
    timeoutMs = 90_000,
): Promise<GenerateResult> {
    const adapter = resolveProtocolAdapter(protocol);
    const base = resolveBaseUrl(integration, catalogRow, protocol);
    const url = adapter.chatUrl(base, catalogRow, req, creds);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: adapter.headers(creds, catalogRow),
            body: JSON.stringify(adapter.buildBody(req)),
            signal: controller.signal,
        });
        if (!res.ok) throw new Error(await readProviderError(res));
        const json = await res.json();
        const parsed = adapter.parseResponse(json);
        if (!parsed.text && !parsed.tool_calls.length) throw new Error("رد فارغ من المزوّد");
        return parsed;
    } finally {
        clearTimeout(timer);
    }
}

/** جلب قائمة الموديلات عبر بروتوكول الاكتشاف المعلن في الكتالوج. */
export async function fetchModels(
    integration: IntegrationRow,
    catalogRow: CatalogRow,
    discoveryProtocol: string,
    creds: Record<string, any>,
): Promise<DiscoveredModel[]> {
    const adapter = resolveProtocolAdapter(discoveryProtocol);
    const base = resolveBaseUrl(integration, catalogRow, discoveryProtocol);
    const url = adapter.modelsUrl(base, catalogRow, creds);
    if (!url) return [];

    const res = await fetch(url, { headers: adapter.headers(creds, catalogRow) });
    if (!res.ok) throw new Error(await readProviderError(res));
    return adapter.parseModels(await res.json());
}
