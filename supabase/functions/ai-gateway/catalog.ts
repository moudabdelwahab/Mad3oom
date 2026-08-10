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
}

export interface IntegrationRow {
    id: string;
    provider: string;
    display_name: string;
    protocol: string | null;
    base_url: string | null;
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
 */
export function resolveBaseUrl(integration: IntegrationRow, catalogRow: CatalogRow, protocol: string): string {
    const custom = (integration.base_url || integration.credentials_meta?.base_url || "").trim();
    const base = custom || catalogRow.default_endpoints?.[protocol] || "";
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

/** البروتوكول المستخدم لاكتشاف الموديلات — قد يختلف عن بروتوكول المحادثة. */
export function resolveDiscoveryProtocol(integration: IntegrationRow, catalogRow: CatalogRow): string | null {
    if (catalogRow.models_discovery?.supported === false) return null;
    const declared = catalogRow.models_discovery?.protocol;
    if (declared && catalogRow.protocols.includes(declared)) return declared;
    return resolveProtocol(integration, catalogRow);
}
