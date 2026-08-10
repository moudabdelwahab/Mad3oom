// ============================================================================
// Capability System — المكان الوحيد الذي تُشتق فيه قدرات الموديل.
// ----------------------------------------------------------------------------
// أي قدرة يعلن عنها المزوّد صراحةً تُستخدم كما هي (source = "discovered").
// وما لا يعلنه يُخمَّن من اسم/بيانات الموديل (source = "heuristic").
// القدرات التي عدّلها الأدمن يدويًا (source = "manual") لا تُدهس أبدًا.
// ============================================================================

export interface DiscoveredModel {
    model_id: string;
    display_name?: string;
    supports_chat?: boolean;
    supports_vision?: boolean;
    supports_tools?: boolean;
    supports_streaming?: boolean;
    supports_reasoning?: boolean;
    supports_coding?: boolean;
    supports_agent?: boolean;
    supports_long_context?: boolean;
    supports_audio?: boolean;
    context_window?: number | null;
    max_output_tokens?: number | null;
    input_price?: number | null;
    output_price?: number | null;
    metadata?: Record<string, any>;
}

const RE_VISION = /vision|4o|4\.1|o3|o4|gemini|claude-(3|4|opus|sonnet|haiku)|llava|pixtral|grok-[2-9]|qwen.*vl/i;
const RE_REASONING = /reason|thinking|^o1|^o3|^o4|-r1|deepseek-r|opus|sonnet|gpt-[5-9]|grok-[3-9]|qwq/i;
const RE_CODING = /cod(e|er|ing)|opus|sonnet|devstral|qwen.*coder|deepseek|gpt-[4-9]|grok-[3-9]/i;
const RE_AUDIO = /audio|whisper|realtime|tts/i;
const RE_NON_CHAT = /embedding|whisper|tts|dall-e|image|moderation|rerank|babbage|davinci-00|ada-00|guard/i;

/** موديل غير محادثي (تضمين/صوت/صور) لا يظهر في قوائم اختيار موديل المحادثة. */
export function isChatLikeModel(id: string): boolean {
    return !RE_NON_CHAT.test(id);
}

/** يملأ القدرات الناقصة بالتخمين، دون المساس بأي قدرة أعلنها المزوّد صراحةً. */
export function enrichCapabilities(model: DiscoveredModel): DiscoveredModel {
    const id = model.model_id || "";
    const ctx = model.context_window ?? null;

    const vision = model.supports_vision ?? RE_VISION.test(id);
    const tools = model.supports_tools ?? false;
    const reasoning = model.supports_reasoning ?? RE_REASONING.test(id);
    const coding = model.supports_coding ?? RE_CODING.test(id);
    const longContext = model.supports_long_context ?? (ctx !== null && ctx >= 128_000);
    const audio = model.supports_audio ?? RE_AUDIO.test(id);

    // Agent = يقدر يشتغل كوكيل متعدد الخطوات: يحتاج أدوات + (سياق طويل أو تفكير)
    const agent = model.supports_agent ?? (tools && (longContext || reasoning));

    return {
        ...model,
        supports_chat: model.supports_chat ?? true,
        supports_vision: vision,
        supports_tools: tools,
        supports_streaming: model.supports_streaming ?? true,
        supports_reasoning: reasoning,
        supports_coding: coding,
        supports_agent: agent,
        supports_long_context: longContext,
        supports_audio: audio,
    };
}

/** التصنيف الأساسي المعروض في الواجهة. الترتيب مقصود: الأخص أولًا. */
export function categorize(m: DiscoveredModel): string {
    if (m.supports_agent && m.supports_tools) return "agent";
    if (m.supports_reasoning) return "reasoning";
    if (m.supports_coding) return "coding";
    if (m.supports_vision) return "vision";
    return "general";
}

/**
 * الأسعار مخزّنة "لكل توكن" (نفس ما يرجّعه OpenRouter مثلًا).
 * أي مزوّد يعطي السعر لكل مليون توكن يُقسَّم قبل التخزين، لا هنا.
 */
export function computeCost(
    inputTokens: number,
    outputTokens: number,
    inputPrice: number | null | undefined,
    outputPrice: number | null | undefined,
): number {
    const inp = Number(inputPrice) || 0;
    const out = Number(outputPrice) || 0;
    return inputTokens * inp + outputTokens * out;
}
