import { registerAuthProvider } from '../registry.js';

/**
 * ملاحظة: فك تشفير الـ bearer_token الفعلي يحدث فقط في الطبقة الخلفية
 * (Edge Function) - نفس الالتزام الموجود في mcp-service.js الحالي
 * ("لا تشفير أو فك تشفير هنا إطلاقًا"). secureStore هنا تجريد بسيط يمثّل
 * تلك الطبقة، ولا يُستبدل بقراءة مباشرة للسر من الواجهة.
 * @param {object} connection
 */
async function getDecryptedBearerToken(connection) {
    return connection._resolveSecret ? connection._resolveSecret('bearer_token') : null;
}

/** @type {import('../types.js').AuthProvider} */
const BearerAuthProvider = {
    authType: 'bearer',
    async connect(connection) {
        // لا redirect - التوكن يُحفظ مسبقًا عبر saveCredentials الحالية، فقط نتأكد من وجوده
        const token = await getDecryptedBearerToken(connection);
        return { connected: Boolean(token) };
    },
    async resolve(connection) {
        const token = await getDecryptedBearerToken(connection);
        if (!token) throw new Error('لا يوجد Bearer Token محفوظ لهذا الاتصال');
        return {
            applyToRequest: () => ({ headers: { Authorization: `Bearer ${token}` } }),
            isExpired: () => false, // Bearer tokens ثابتة، لا انتهاء صلاحية معروف بروتوكوليًا
        };
    },
};

registerAuthProvider(BearerAuthProvider);
export { BearerAuthProvider };
