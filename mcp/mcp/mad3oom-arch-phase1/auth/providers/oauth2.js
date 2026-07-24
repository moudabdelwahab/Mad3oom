import { registerAuthProvider } from '../registry.js';

/**
 * OAuth2 Auth Provider
 * --------------------------------------------------------
 * الطبقات الثلاث (dcr / platform_app / manual) المتفق عليها في تقرير
 * المعمارية تعيش بالكامل داخل هذا الملف فقط - أي كود خارج هذا الملف
 * (Connection Manager، MCP Session، UI) يتعامل مع authType='oauth2'
 * ككتلة واحدة، ولا يعرف ولا يهمه أي طبقة استُخدمت فعليًا.
 *
 * التنفيذ الفعلي لكل خطوة (استدعاء mcp-provider-discover، DCR register،
 * تبادل الكود، تجديد التوكن) هو نداء لـ Edge Functions موجودة/مخطط لها في
 * تقرير المعمارية - هنا فقط الشكل (shape) اللي يحقق العقد المطلوب من
 * AuthProvider، جاهز ليُربط بالتنفيذ الفعلي في Phase 1+ بدون تغيير العقد.
 */

/** @param {string} serverUrl @returns {Promise<import('../types.js').AuthDiscoveryResult>} */
async function discoverOAuth(serverUrl) {
    // TODO Phase 1: نداء حقيقي لـ mcp-provider-discover(serverUrl)
    // يرجّع authorization_endpoint/token_endpoint/registration_endpoint إلخ
    // من RFC 8414 + RFC 9728، كما هو موضّح في تقرير المعمارية §3.1
    throw new Error('discoverOAuth: لم يُربط بعد بـ mcp-provider-discover (Phase 1)');
}

/** يقرر الطبقة (dcr|platform_app|manual) - قرار داخلي، لا يُصدَّر ولا يظهر لأي طبقة أعلى */
function decideTier(discovery, connection) {
    if (discovery?.oauth?.registration_endpoint) return 'dcr';
    if (connection._hasPlatformApp?.()) return 'platform_app';
    return 'manual';
}

/** @type {import('../types.js').AuthProvider} */
const OAuth2AuthProvider = {
    authType: 'oauth2',

    async discover(serverUrl) {
        return discoverOAuth(serverUrl);
    },

    /** يبدأ الفلو المناسب حسب الطبقة المُكتشَفة - النتيجة الخارجية دائمًا نفس الشكل: redirectUrl واحد */
    async connect(connection) {
        const discovery = await discoverOAuth(connection.url).catch(() => null);
        const tier = decideTier(discovery, connection);

        switch (tier) {
            case 'dcr':
                // TODO Phase 3: تسجيل ديناميكي (RFC 7591) ثم بناء authorize URL بـ client_id عام + PKCE
                throw new Error('DCR flow: غير مُفعَّل بعد (Phase 3)');
            case 'platform_app':
                // TODO Phase 2: استخدام mcp_platform_oauth_apps المخزّن + PKCE
                throw new Error('Platform-app flow: غير مُفعَّل بعد (Phase 2)');
            case 'manual':
            default:
                // التوافق مع الخلف: نفس مسار اليوم بالضبط (saveCredentials ثم startOAuth)
                // عبر الدالتين الموجودتين فعليًا في mcp-service.js - بدون أي تعديل فيهما
                if (!connection._legacyStartOAuth) {
                    throw new Error('manual OAuth flow يتطلب ربط _legacyStartOAuth (توافق مع mcp-service.js الحالي)');
                }
                const { authorize_url } = await connection._legacyStartOAuth();
                return { redirectUrl: authorize_url, connected: false };
        }
    },

    async resolve(connection) {
        const token = connection._resolveSecret ? await connection._resolveSecret('access_token') : null;
        const expiresAt = connection.oauth_token_expires_at ? new Date(connection.oauth_token_expires_at) : null;
        if (!token) throw new Error('لا يوجد OAuth access token محفوظ لهذا الاتصال');

        return {
            applyToRequest: () => ({ headers: { Authorization: `Bearer ${token}` } }),
            isExpired: () => Boolean(expiresAt && expiresAt.getTime() <= Date.now()),
            onAuthFailure: async () => {
                await OAuth2AuthProvider.refresh(connection);
                return OAuth2AuthProvider.resolve(connection);
            },
        };
    },

    async refresh(connection) {
        // TODO Phase 4: نداء مجدول (mcp-refresh-tokens) - نفس منطق تبادل refresh_token
        // بغض النظر عن الطبقة (dcr/platform_app/manual) لأن refresh_token grant موحّد في OAuth2 نفسه
        throw new Error('refresh: غير مُفعَّل بعد (Phase 4)');
    },

    async revoke(connection) {
        // TODO: نداء revocation_endpoint المُكتشَف، أو تعطيل محلي لو غير مدعوم
        throw new Error('revoke: غير مُفعَّل بعد');
    },
};

registerAuthProvider(OAuth2AuthProvider);
export { OAuth2AuthProvider };
