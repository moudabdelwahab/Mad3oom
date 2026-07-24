/**
 * Authentication Manager
 * --------------------------------------------------------
 * الطبقة الوسيطة بين Connection Manager وAuth Provider (حسب المخطط المتفق
 * عليه). Connection Manager لا ينادي أي AuthProvider مباشرة أبدًا - ينادي
 * فقط AuthManager.resolveContext()/AuthManager.getCapabilities(). هذا هو
 * المكان الوحيد المسموح له باستدعاء registry.js الخاص بـ auth/.
 *
 * مسؤوليات AuthManager تحديدًا:
 *  - اختيار الـ AuthProvider المناسب (عبر authType فقط، بدون معرفة تفاصيله)
 *  - تخزين/جدولة الـ refresh قبل انتهاء الصلاحية
 *  - كشف AuthCapabilities للطبقات الأعلى (بدون تفاصيل التنفيذ)
 *  - التعامل مع onAuthFailure (401) بإعادة المحاولة عبر refresh مرة واحدة
 */
import { resolveAuthProvider } from '../auth/registry.js';
import { parseAuthCapabilities } from '../capabilities/capability-registry.js';

export class AuthenticationManager {
    /** @param {object} connection - سجل الاتصال (mcp_server_connections + دوال مساعدة _resolveSecret/_legacyStartOAuth) */
    constructor(connection) {
        this.connection = connection;
        this.provider = resolveAuthProvider(connection.auth_type || 'none');
        /** @type {import('../auth/types.js').AuthContext|null} */
        this._context = null;
    }

    /** يُستخدم فقط في UI/Discovery - لا علاقة له بإرسال أي طلب MCP فعلي */
    async discoverCapabilities() {
        if (!this.provider.discover) return parseAuthCapabilities(null);
        const result = await this.provider.discover(this.connection.url).catch(() => null);
        return parseAuthCapabilities(result);
    }

    /** يبدأ فلو الربط (قد يرجّع redirectUrl لو OAuth، أو connected:true فوريًا لغير ذلك) */
    async beginConnect() {
        return this.provider.connect(this.connection);
    }

    /** الدالة الوحيدة اللي Connection Manager ينادي عليها قبل كل send() */
    async resolveContext() {
        if (this._context && !this._context.isExpired()) return this._context;
        this._context = await this.provider.resolve(this.connection);
        return this._context;
    }

    /** يُستدعى من Connection Manager عند رد 401/auth error - محاولة واحدة فقط */
    async handleAuthFailure() {
        if (!this._context?.onAuthFailure) return null;
        this._context = await this._context.onAuthFailure();
        return this._context;
    }

    async refreshIfNeeded() {
        if (this.provider.refresh && this._context?.isExpired()) {
            await this.provider.refresh(this.connection);
            this._context = null; // يُعاد الحل عند أول resolveContext() تالي
        }
    }

    async revoke() {
        if (this.provider.revoke) await this.provider.revoke(this.connection);
        this._context = null;
    }
}
