// ============================================================================
// Provider Registry — يقرأ ai_provider_catalog من قاعدة البيانات.
// ----------------------------------------------------------------------------
// ممنوع أي "if provider === 'agentrouter'" في أي مكان في هذه الدالة أو خارجها.
// إضافة مزوّد جديد = صف جديد في الجدول، ولا شيء غير ذلك.
// ============================================================================

export interface CatalogRow {
    id: string;
    label: string;
    kind: string;
    protocols: string[];
    default_endpoints: Record<string, string>;
    endpoint_paths: Record<string, Record<string, string>>;
    auth_methods: string[];
    credential_fields: any[];
    models_discovery: { supported?: boolean; protocol?: string; path?: string };
    default_headers: Record<string, string>;
    requires_base_url: boolean;
    allows_base_url: boolean;
    is_enabled: boolean;
    /** ملاذ أخير للموديل عندما لا يوجد موديل محدّد ولا مكتشف. */
    default_model?: string | null;
}

export interface IntegrationRow {
    id: string;
    provider: string;
    display_name: string;
    protocol: string | null;
    base_url: string | null;
    base_urls: Record<string, string> | null;
    credentials_encrypted: string | null;
    credentials_meta: Record<string, any>;
    capabilities_override: Record<string, any>;
    is_active: boolean;
    priority: number;
}

let catalogCache: Map<string, CatalogRow> | null = null;
let catalogCachedAt = 0;
const CATALOG_TTL_MS = 60_000;

export async function loadCatalog(adminClient: any, force = false): Promise<Map<string, CatalogRow>> {
    if (!force && catalogCache && Date.now() - catalogCachedAt < CATALOG_TTL_MS) return catalogCache;

    const { data, error } = await adminClient.from("ai_provider_catalog").select("*");
    if (error) throw new Error("فشل قراءة كتالوج المزوّدين: " + error.message);

    const map = new Map<string, CatalogRow>();
    for (const row of data || []) map.set(row.id, row as CatalogRow);
    catalogCache = map;
    catalogCachedAt = Date.now();
    return map;
}

export function getCatalogRow(catalog: Map<string, CatalogRow>, providerId: string): CatalogRow {
    const row = catalog.get(providerId);
    if (!row) throw new Error(`المزوّد "${providerId}" غير معرَّف في كتالوج المزوّدين`);
    return row;
}

/** البروتوكول الفعلي: ما اختاره الأدمن لهذا الربط، وإلا أول بروتوكول يدعمه المزوّد. */
export function resolveProtocol(integration: IntegrationRow, catalogRow: CatalogRow): string {
    const chosen = (integration.protocol || "").trim();
    if (chosen && catalogRow.protocols.includes(chosen)) return chosen;
    const first = catalogRow.protocols[0];
    if (!first) throw new Error(`المزوّد "${catalogRow.id}" ليس له أي بروتوكول معرَّف`);
    return first;
}

/**
 * الرابط الأساسي للبروتوكول المطلوب.
 * ملاحظة مقصودة: لا يُضاف "/v1" تلقائيًا أبدًا — البروتوكول (ومسارات الكتالوج)
 * هما ما يحدّدان المسار النهائي. مثال AgentRouter:
 *   anthropic → https://co.agentrouter.org        ثم /v1/messages
 *   openai    → https://co.agentrouter.org/v1     ثم /chat/completions
 *
 * انتبه: مضيف الـ API هو co.agentrouter.org وليس agentrouter.org — الأخير هو
 * الموقع/الكونسول خلف Aliyun WAF، ويرد صفحة HTML بكود 200 لأي مسار API.
 */
export function resolveBaseUrl(integration: IntegrationRow, catalogRow: CatalogRow, protocol: string): string {
    // رابط مخصّص لهذا البروتوكول تحديدًا
    const perProtocol = (integration.base_urls?.[protocol] || "").trim();

    // العمود القديم (رابط واحد) ينطبق على البروتوكول المختار للتكامل فقط.
    // تطبيقه على كل البروتوكولات كان يكسر الاكتشاف: مزوّد يتحدث anthropic
    // برابط بلا /v1 ويكتشف الموديلات بـ openai برابط بـ /v1 — رابط واحد
    // لا يصلح للاثنين.
    const selectedProtocol = (integration.protocol || catalogRow.protocols[0] || "").trim();
    const legacy = selectedProtocol === protocol
        ? (integration.base_url || integration.credentials_meta?.base_url || "").trim()
        : "";

    const base = perProtocol || legacy || catalogRow.default_endpoints?.[protocol] || "";
    if (!base) {
        throw new Error(`لا يوجد رابط أساسي للمزوّد "${catalogRow.id}" بالبروتوكول "${protocol}" — أضِف Base URL في إعدادات الربط.`);
    }
    return base.replace(/\/+$/, "");
}

/** مسار مخصّص من الكتالوج لبروتوكول معيّن، وإلا الافتراضي الخاص بالبروتوكول. */
export function resolvePath(catalogRow: CatalogRow, protocol: string, key: string, fallback: string): string {
    const p = catalogRow.endpoint_paths?.[protocol]?.[key];
    return (p && String(p).trim()) || fallback;
}

/**
 * البروتوكولات التي يُجرَّب اكتشاف الموديلات عبرها، بالترتيب.
 *
 * لماذا قائمة وليست بروتوكولًا واحدًا: البوابات المجمِّعة (AgentRouter مثلاً)
 * تتكلم أكثر من بروتوكول، وقائمة الموديلات قد تكون متاحة على مسار بروتوكول
 * واحد فقط من بينها — أو على نفس المسار لكن بآلية مصادقة مختلفة
 * (Authorization: Bearer مقابل x-api-key). محاولة واحدة بمسار واحد كانت
 * تُنتج استنتاجًا خاطئًا: "هذا المزوّد لا يدعم اكتشاف الموديلات".
 * نجرّب المعلن في الكتالوج أولًا، ثم بروتوكول المحادثة، ثم بقية ما يدعمه
 * المزوّد، ونعرض للمستخدم كل ما جُرّب.
 */
export function resolveDiscoveryProtocols(integration: IntegrationRow, catalogRow: CatalogRow): string[] {
    if (catalogRow.models_discovery?.supported === false) return [];

    const ordered: string[] = [];
    const push = (p?: string | null) => {
        const v = (p || "").trim();
        if (v && catalogRow.protocols.includes(v) && !ordered.includes(v)) ordered.push(v);
    };

    push(catalogRow.models_discovery?.protocol);
    push(integration.protocol);
    for (const p of catalogRow.protocols) push(p);

    return ordered;
}
