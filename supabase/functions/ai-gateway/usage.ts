// ============================================================================
// Usage & Cost — كل نداء (ناجح أو فاشل أو محوّل لاحتياطي) يُسجَّل هنا.
// التسجيل best-effort دائمًا: فشل الكتابة لا يُفشل نداء المستخدم أبدًا.
// ============================================================================

import { computeCost } from "./capabilities.ts";

export interface UsageEvent {
    integration_id?: string | null;
    provider?: string | null;
    protocol?: string | null;
    model_id?: string | null;
    mode?: string | null;
    source?: string;
    session_id?: string | null;
    request_id?: string | null;
    user_id?: string | null;
    status: "success" | "error" | "fallback";
    error_code?: string | null;
    error_message?: string | null;
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    cost?: number;
    latency_ms?: number | null;
    attempt?: number;
}

/** سعر الموديل (لكل توكن) من سجل الموديلات المكتشفة. */
export async function lookupModelPricing(
    adminClient: any,
    integrationId: string,
    modelId: string | null,
): Promise<{ input: number | null; output: number | null }> {
    if (!modelId) return { input: null, output: null };
    const { data } = await adminClient
        .from("external_integration_models")
        .select("input_price, output_price")
        .eq("integration_id", integrationId)
        .eq("model_id", modelId)
        .maybeSingle();
    return { input: data?.input_price ?? null, output: data?.output_price ?? null };
}

export async function logUsage(adminClient: any, event: UsageEvent): Promise<void> {
    try {
        const input = event.input_tokens ?? 0;
        const output = event.output_tokens ?? 0;
        await adminClient.from("ai_usage_events").insert({
            integration_id: event.integration_id ?? null,
            provider: event.provider ?? null,
            protocol: event.protocol ?? null,
            model_id: event.model_id ?? null,
            mode: event.mode ?? null,
            source: event.source || "unknown",
            session_id: event.session_id ?? null,
            request_id: event.request_id ?? null,
            user_id: event.user_id ?? null,
            status: event.status,
            error_code: event.error_code ?? null,
            error_message: event.error_message ? String(event.error_message).slice(0, 500) : null,
            input_tokens: input,
            output_tokens: output,
            total_tokens: event.total_tokens ?? (input + output),
            cost: event.cost ?? 0,
            latency_ms: event.latency_ms ?? null,
            attempt: event.attempt ?? 1,
        });
    } catch (e) {
        console.error("[ai-gateway] logUsage failed:", (e as Error).message);
    }
}

export { computeCost };
