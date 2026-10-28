// ============================================================================
// errors.js — أخطاء الموصلات برموز ثابتة.
//
// القاعدة: لا نص من المزوّد يصل إلى القاعدة أو الواجهة أو السجل. كل فشل يتحول
// إلى رمز من القائمة أدناه (ihub_connections.last_error_code يفرض الشكل نفسه).
// ============================================================================

export const ERROR_CODES = Object.freeze({
    invalid_input: { status: 400, retryable: false },
    invalid_url: { status: 400, retryable: false },
    unsupported: { status: 400, retryable: false },
    auth_failed: { status: 422, retryable: false },
    token_expired: { status: 422, retryable: false },
    forbidden_scope: { status: 422, retryable: false },
    not_found: { status: 404, retryable: false },
    api_not_found: { status: 422, retryable: false },
    rate_limited: { status: 429, retryable: true },
    provider_unavailable: { status: 502, retryable: true },
    timeout: { status: 504, retryable: true },
    response_too_large: { status: 502, retryable: false },
    invalid_response: { status: 502, retryable: false },
    redirect_refused: { status: 502, retryable: false },
    invalid_payload: { status: 400, retryable: false },
    signature_invalid: { status: 401, retryable: false },
    not_configured: { status: 503, retryable: false },
    app_uninstalled: { status: 422, retryable: false },
    account_in_use: { status: 409, retryable: false },
    state_invalid: { status: 409, retryable: false },
    // 120: إدارة Shopify — رفض Shopify (userErrors، الحقل والرمز فقط)، وعدم أهلية تحقّق منها الخادم من حالة Shopify
    provider_rejected: { status: 422, retryable: false },
    not_eligible: { status: 409, retryable: false },
    unknown_error: { status: 500, retryable: true }
});

export class ConnectorError extends Error {
    constructor(code, detail) {
        const known = Object.prototype.hasOwnProperty.call(ERROR_CODES, code) ? code : 'unknown_error';
        super(known);
        this.name = 'ConnectorError';
        this.code = known;
        this.status = ERROR_CODES[known].status;
        this.retryable = ERROR_CODES[known].retryable;
        // detail يبقى داخل العملية للاختبارات فقط؛ لا يُسلسَل ولا يُسجَّل
        Object.defineProperty(this, 'detail', { value: detail, enumerable: false });
    }
}

/** يحوّل أي خطأ لرمز آمن. */
export function errorCode(err) {
    if (err instanceof ConnectorError) return err.code;
    if (err && typeof err.code === 'string' && Object.prototype.hasOwnProperty.call(ERROR_CODES, err.code)) return err.code;
    return 'unknown_error';
}

/** يحوّل رمز HTTP من المزوّد لرمز ثابت. */
export function codeForStatus(status) {
    if (status === 401) return 'auth_failed';
    if (status === 403) return 'forbidden_scope';
    if (status === 404) return 'not_found';
    if (status === 429) return 'rate_limited';
    if (status >= 500) return 'provider_unavailable';
    return 'invalid_response';
}
