// ============================================================================
// Model Router — يحوّل "ما الذي أريده" إلى سلسلة مرشّحين مرتّبة.
// ----------------------------------------------------------------------------
// سلسلة الاحتياطي = صفوف ai_routing_rules بنفس (match_kind, match_value)
// مرتّبة بـ position. position الأصغر = الأساسي.
//
// ترتيب البحث عن سلسلة (أول مصدر يعطي نتيجة يفوز):
//   1. مزوّد/موديل محدّد صراحةً في الطلب
//   2. قاعدة على الوضع        (match_kind = 'mode')
//   3. قاعدة على قدرة مطلوبة  (match_kind = 'capability')
//   4. القاعدة الافتراضية      (match_kind = 'default')
//   5. المزوّد الافتراضي القديم في bot_settings  ← توافق رجعي كامل
//   6. أعلى تكامل AI فعّال حسب priority
// ============================================================================

import { IntegrationRow } from "./catalog.ts";

export interface Candidate {
    integration: IntegrationRow;
    model_id: string | null;
    origin: string;
    position: number;
}

const AI_KINDS = ["ai_provider", "ai_gateway", "custom"];

async function loadIntegrations(adminClient: any, ids?: string[]): Promise<Map<string, IntegrationRow>> {
    let q = adminClient
        .from("external_integrations")
        .select("id, provider, display_name, protocol, base_url, base_urls, credentials_encrypted, credentials_meta, capabilities_override, is_active, priority");
    if (ids?.length) q = q.in("id", ids);
    const { data, error } = await q;
    if (error) throw new Error("فشل قراءة التكاملات: " + error.message);
    const map = new Map<string, IntegrationRow>();
    for (const row of data || []) map.set(row.id, row as IntegrationRow);
    return map;
}

/**
 * الموديل الافتراضي لتكامل، بالترتيب:
 *   1. ما حدّده الأدمن يدويًا في إعدادات التكامل
 *   2. الموديل المعلَّم is_default بين الموديلات المكتشفة
 *   3. أول موديل مفعّل
 *   4. default_model من كتالوج المزوّد — ملاذ أخير حتى لا يفشل النداء لمجرد
 *      أن المزامنة لم تُشغَّل بعد.
 */
async function defaultModelFor(
    adminClient: any,
    integration: IntegrationRow,
    catalog: Map<string, any>,
): Promise<string | null> {
    const fromMeta = (integration.credentials_meta?.model || "").trim();
    if (fromMeta) return fromMeta;

    const { data } = await adminClient
        .from("external_integration_models")
        .select("model_id, is_default")
        .eq("integration_id", integration.id)
        .eq("is_enabled", true)
        .order("is_default", { ascending: false })
        .order("display_name", { ascending: true })
        .limit(1);

    if (data?.[0]?.model_id) return data[0].model_id;

    return (catalog.get(integration.provider)?.default_model || "").trim() || null;
}

async function chainFromRules(
    adminClient: any,
    matchKind: string,
    matchValue: string | null,
): Promise<Candidate[]> {
    let q = adminClient
        .from("ai_routing_rules")
        .select("integration_id, model_id, position")
        .eq("match_kind", matchKind)
        .eq("is_active", true)
        .order("position", { ascending: true });

    q = matchValue === null ? q.is("match_value", null) : q.eq("match_value", matchValue);

    const { data, error } = await q;
    if (error || !data?.length) return [];

    const ids = [...new Set(data.map((r: any) => r.integration_id).filter(Boolean))];
    const integrations = await loadIntegrations(adminClient, ids as string[]);

    const out: Candidate[] = [];
    for (const rule of data) {
        const integration = integrations.get(rule.integration_id);
        if (!integration || !integration.is_active) continue;
        out.push({
            integration,
            model_id: rule.model_id || null,
            origin: `rule:${matchKind}${matchValue ? ":" + matchValue : ""}`,
            position: rule.position,
        });
    }
    return out;
}

/** المزوّد الافتراضي القديم المحفوظ في bot_settings — يبقى مدعومًا كما هو. */
async function chainFromBotSettings(adminClient: any): Promise<Candidate[]> {
    const { data } = await adminClient
        .from("bot_settings")
        .select("ai_integration_id")
        .is("phone_number_id", null)
        .limit(1)
        .maybeSingle();

    if (!data?.ai_integration_id) return [];
    const integrations = await loadIntegrations(adminClient, [data.ai_integration_id]);
    const integration = integrations.get(data.ai_integration_id);
    if (!integration || !integration.is_active) return [];
    return [{ integration, model_id: null, origin: "bot_settings", position: 0 }];
}

async function chainFromPriority(adminClient: any, catalog: Map<string, any>): Promise<Candidate[]> {
    const all = await loadIntegrations(adminClient);
    return [...all.values()]
        .filter((i) => i.is_active && i.credentials_encrypted && AI_KINDS.includes(catalog.get(i.provider)?.kind))
        .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100))
        .map((integration, idx) => ({ integration, model_id: null, origin: "priority", position: idx }));
}

export interface ResolveOptions {
    integration_id?: string;
    model?: string;
    mode?: string;
    capability?: string;
    /** أقصى عدد مرشّحين (الأساسي + الاحتياطيات). */
    limit?: number;
}

export async function resolveChain(
    adminClient: any,
    catalog: Map<string, any>,
    opts: ResolveOptions,
): Promise<Candidate[]> {
    let chain: Candidate[] = [];

    if (opts.integration_id) {
        const integrations = await loadIntegrations(adminClient, [opts.integration_id]);
        const integration = integrations.get(opts.integration_id);
        if (!integration) throw new Error("التكامل المطلوب غير موجود");
        if (!integration.is_active) throw new Error("التكامل المطلوب معطّل حاليًا");
        chain = [{ integration, model_id: opts.model || null, origin: "explicit", position: 0 }];

        // الاختيار الصريح يبقى الأساسي دائمًا، لكن قواعد الوضع تُلحق بعده
        // كاحتياطيات بدل أن تُلغى.
        if (opts.mode) {
            const fallbacks = await chainFromRules(adminClient, "mode", opts.mode);
            chain.push(...fallbacks.filter((c) => c.integration.id !== opts.integration_id));
        }
    }

    if (!chain.length && opts.mode) chain = await chainFromRules(adminClient, "mode", opts.mode);
    if (!chain.length && opts.capability) chain = await chainFromRules(adminClient, "capability", opts.capability);
    if (!chain.length) chain = await chainFromRules(adminClient, "default", null);
    if (!chain.length) chain = await chainFromBotSettings(adminClient);
    if (!chain.length) chain = await chainFromPriority(adminClient, catalog);

    // ملء الموديل الناقص لكل مرشّح، واستبعاد أي مرشّح بلا بيانات اعتماد
    const resolved: Candidate[] = [];
    for (const c of chain) {
        if (!c.integration.credentials_encrypted) continue;
        resolved.push({ ...c, model_id: c.model_id || await defaultModelFor(adminClient, c.integration, catalog) });
    }

    return resolved.slice(0, opts.limit ?? 4);
}
