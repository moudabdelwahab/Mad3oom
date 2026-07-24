import { registerAuthProvider } from '../registry.js';

/**
 * تصحيح Phase 1: هذا الملف (Phase 0) كان يفترض شكل { headers: {...} } من
 * resolveSecret('custom_config'). الشكل الحقيقي (buildAuthHeaders، حالة
 * "custom") هو JSON مفكوك مباشرة كـ Object.assign(headers, parsed) - أي
 * custom_config نفسه *هو* كائن الـ headers، بدون تغليف. تم تصحيح هذا
 * الملف ليطابق ذلك حرفيًا.
 * @param {object} connection
 */
async function getDecryptedCustomConfig(connection) {
    return connection._resolveSecret ? connection._resolveSecret('custom_config') : null;
}

/** @type {import('../types.js').AuthProvider} */
const CustomAuthProvider = {
    authType: 'custom',
    async connect(connection) {
        const cfg = await getDecryptedCustomConfig(connection);
        return { connected: Boolean(cfg) };
    },
    async resolve(connection) {
        const cfg = await getDecryptedCustomConfig(connection); // كائن headers مباشرة كما يُحفظ اليوم (custom_config_encrypted → JSON.parse → Object.assign(headers, ...))
        const headers = (cfg && typeof cfg === 'object') ? cfg : {};
        return {
            applyToRequest: () => ({ headers }),
            isExpired: () => false,
        };
    },
};

registerAuthProvider(CustomAuthProvider);
export { CustomAuthProvider };
