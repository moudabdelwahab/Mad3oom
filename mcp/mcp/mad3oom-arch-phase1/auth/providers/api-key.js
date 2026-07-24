import { registerAuthProvider } from '../registry.js';

/**
 * تصحيح Phase 1: هذا الملف (Phase 0) كان يفترض Header قابل للتخصيص
 * (connection.api_key_header, افتراضي X-API-Key) - عمود غير موجود فعليًا في
 * mcp_server_connections. الشكل الحقيقي (test-mcp-server/_shared/mcp-transport.ts
 * buildAuthHeaders, حالة "api_key") هو: Authorization: Bearer <api_key> لو
 * فيه api_key فقط، أو Authorization: Bearer <api_key>.<api_secret> لو الاثنين
 * محفوظين. تم تصحيح هذا الملف ليطابق ذلك حرفيًا - لا "if provider=="، فقط
 * تصحيح شكل هيدر واحد داخل نفس الـ plugin.
 * @param {object} connection
 */
async function getDecryptedApiKeyParts(connection) {
    if (!connection._resolveSecret) return { apiKey: null, apiSecret: null };
    const [apiKey, apiSecret] = await Promise.all([
        connection._resolveSecret('api_key'),
        connection._resolveSecret('api_secret'),
    ]);
    return { apiKey: apiKey || null, apiSecret: apiSecret || null };
}

/** @type {import('../types.js').AuthProvider} */
const ApiKeyAuthProvider = {
    authType: 'api_key',
    async connect(connection) {
        const { apiKey } = await getDecryptedApiKeyParts(connection);
        return { connected: Boolean(apiKey) };
    },
    async resolve(connection) {
        const { apiKey, apiSecret } = await getDecryptedApiKeyParts(connection);
        if (!apiKey) throw new Error('لا يوجد API Key محفوظ لهذا الاتصال');
        const token = apiSecret ? `${apiKey}.${apiSecret}` : apiKey;
        return {
            applyToRequest: () => ({ headers: { Authorization: `Bearer ${token}` } }),
            isExpired: () => false,
        };
    },
};

registerAuthProvider(ApiKeyAuthProvider);
export { ApiKeyAuthProvider };
