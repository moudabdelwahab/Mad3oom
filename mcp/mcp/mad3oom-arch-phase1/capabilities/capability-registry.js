/**
 * Capability Registry
 * --------------------------------------------------------
 * لا "if provider == X" ولا "if authType == oauth2" في أي مكان بعد هذه النقطة.
 * كل قرار (استدعي tools/list؟ فعّل زر Refresh؟ جدول heartbeat؟) يُبنى على
 * capability flags مُكتشَفة فعليًا من السيرفر (initialize response) أو من
 * الـ AuthProvider (discover()) - وليس على اسم المزوّد أو نوع المصادقة.
 *
 * المصدر الرسمي لـ capabilities هو استجابة initialize في MCP spec:
 *   result.capabilities = { tools, resources, prompts, sampling, roots, logging, ... }
 * نضيف فوقها فقط capabilities خاصة بطبقة الـ Auth (supportsOAuth/supportsRefresh)
 * لأنها مش جزء من MCP protocol نفسه - معزولة هنا بوضوح تحت auth.*
 */

/** @typedef {{
 *   tools: boolean,
 *   resources: boolean,
 *   prompts: boolean,
 *   sampling: boolean,
 *   roots: boolean,
 *   logging: boolean,
 * }} McpCapabilities  - مطابقة 1:1 لحقل capabilities في رد initialize (MCP spec) */

/** @typedef {{
 *   supportsOAuth: boolean,
 *   supportsRefresh: boolean,
 *   supportsRevocation: boolean,
 *   supportsDCR: boolean,        // Dynamic Client Registration (RFC 7591)
 * }} AuthCapabilities  - من اكتشاف الـ Auth Layer فقط، ليست جزءًا من MCP protocol */

/** يحوّل رد initialize الخام (زي ما جه من السيرفر) لكائن Capabilities موحّد.
 *  لا نفترض أي شيء غير موجود فعليًا في الرد - أي capability غير مُعلَنة = false. */
export function parseMcpCapabilities(initializeResult) {
    const c = initializeResult?.capabilities || {};
    return {
        tools: Boolean(c.tools),
        resources: Boolean(c.resources),
        prompts: Boolean(c.prompts),
        sampling: Boolean(c.sampling),
        roots: Boolean(c.roots),
        logging: Boolean(c.logging),
    };
}

/** يحوّل نتيجة AuthProvider.discover() لكائن AuthCapabilities موحّد. */
export function parseAuthCapabilities(discoveryResult) {
    return {
        supportsOAuth: Boolean(discoveryResult?.oauth),
        supportsRefresh: Boolean(discoveryResult?.oauth?.refresh_token_supported),
        supportsRevocation: Boolean(discoveryResult?.oauth?.revocation_endpoint),
        supportsDCR: Boolean(discoveryResult?.oauth?.registration_endpoint),
    };
}

/**
 * دالة القرار المركزية الوحيدة - أي كود آخر (Session/ConnectionManager/UI)
 * ينادي عليها بدل ما يكتب شرطه الخاص. مثال استخدام:
 *   if (canRun(caps, 'resources')) await session.resourcesList();
 */
export function canRun(mcpCapabilities, feature) {
    return Boolean(mcpCapabilities?.[feature]);
}

/** دمج capabilities من مصادر متعددة (initialize + أي إضافات مستقبلية) في كائن واحد للتخزين والعرض */
export function mergeCapabilities(mcpCapabilities, authCapabilities) {
    return { mcp: mcpCapabilities, auth: authCapabilities };
}
