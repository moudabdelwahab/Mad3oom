/**
 * Authentication Layer - Contract
 * --------------------------------------------------------
 * Auth = "كيف تثبت هويتك" فقط. لا يعرف Auth:
 *   - Transport (لا HTTP، لا SSE، لا stdio) - يُرجع RequestContext عام فقط،
 *     Connection Manager هو اللي يحقنه في Transport أيًا كان نوعه.
 *   - MCP protocol (لا initialize، لا tools/list)
 *
 * AuthContext.applyToRequest() يرجّع RequestContext (contracts/request-context.js)
 * - وليس شكلاً خاصًا بأي transport. هذا يسمح بإضافة أي طريقة مصادقة مستقبلية
 * (cookies، query-param signing، mTLS، توقيع الطلب بالكامل HMAC...) بمجرد
 * ملء الحقل المناسب في RequestContext، دون تعديل هذا العقد أو أي كود يستهلكه.
 */

/**
 * @typedef {Object} AuthContext
 * @property {() => import('../contracts/request-context.js').RequestContext} applyToRequest
 *           - يُستدعى من Connection Manager قبل كل send()، يرجّع RequestContext (وليس {headers} فقط)
 * @property {() => boolean} isExpired
 * @property {(() => Promise<AuthContext|null>)} [onAuthFailure] - إعادة محاولة بعد 401، null = افصل نهائيًا
 */

/** @typedef {{
 *   oauth?: {
 *     authorization_endpoint?: string,
 *     token_endpoint?: string,
 *     registration_endpoint?: string,      // وجوده = يدعم DCR (RFC 7591)
 *     revocation_endpoint?: string,
 *     refresh_token_supported?: boolean,
 *   } | null,
 * }} AuthDiscoveryResult - نتيجة discover()، تُترجم لاحقًا عبر capability-registry.js فقط */

/**
 * @typedef {Object} AuthProvider
 * @property {string} authType - 'none' | 'api_key' | 'bearer' | 'oauth2' | 'custom' | أي جديد
 * @property {(serverUrl: string) => Promise<AuthDiscoveryResult>} [discover] - اختياري (OAuth فقط)
 * @property {(connection: object) => Promise<{ redirectUrl?: string, connected: boolean }>} connect
 * @property {(connection: object) => Promise<AuthContext>} resolve
 * @property {(connection: object) => Promise<void>} [refresh]
 * @property {(connection: object) => Promise<void>} [revoke]
 */

export const AUTH_TYPES = /** @type {const} */ (['none', 'api_key', 'bearer', 'oauth2', 'custom']);
