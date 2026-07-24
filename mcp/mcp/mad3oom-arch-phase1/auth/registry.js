/**
 * Auth Provider Registry
 * --------------------------------------------------------
 * إضافة طريقة مصادقة جديدة (mTLS، JWT مخصص، SAML...) = ملف جديد يطبّق
 * عقد AuthProvider في types.js + سطر تسجيل واحد هنا. صفر تعديل في
 * Connection Manager أو Auth Manager أو MCP Session.
 */

/** @type {Record<string, import('./types.js').AuthProvider>} */
const AUTH_PROVIDERS = {};

/** @param {import('./types.js').AuthProvider} provider */
export function registerAuthProvider(provider) {
    AUTH_PROVIDERS[provider.authType] = provider;
}

/** @param {string} authType @returns {import('./types.js').AuthProvider} */
export function resolveAuthProvider(authType) {
    const provider = AUTH_PROVIDERS[authType];
    if (!provider) throw new Error(`Auth provider غير مسجّل لـ authType="${authType}"`);
    return provider;
}

export function listRegisteredAuthTypes() {
    return Object.keys(AUTH_PROVIDERS);
}
