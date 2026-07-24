/**
 * Transport Registry
 * --------------------------------------------------------
 * أي كود يحتاج Transport ينادي resolveTransport(kind) فقط - ممنوع أي
 * "if kind === 'sse' ... else if kind === 'stdio'" خارج هذا الملف.
 * إضافة Transport مستقبلي (WebSocket مثلاً) = تسجيله هنا بسطر واحد،
 * بدون تعديل Connection Manager أو MCP Session.
 */

/** @type {Record<string, () => import('./types.js').Transport>} */
const TRANSPORT_FACTORIES = {};

/** @param {string} kind @param {() => import('./types.js').Transport} factory */
export function registerTransport(kind, factory) {
    TRANSPORT_FACTORIES[kind] = factory;
}

/** @param {string} kind @returns {import('./types.js').Transport} */
export function resolveTransport(kind) {
    const factory = TRANSPORT_FACTORIES[kind];
    if (!factory) throw new Error(`Transport غير مسجّل: "${kind}". سجّله عبر registerTransport() أولاً.`);
    return factory();
}

export function listRegisteredTransports() {
    return Object.keys(TRANSPORT_FACTORIES);
}
