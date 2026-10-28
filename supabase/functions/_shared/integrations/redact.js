// ============================================================================
// redact.js — لا أسرار ولا بيانات عملاء في السجلات.
//
// السجلات (console) تمر بـ safeLog وحده: يقبل حقولًا بقائمة سماح من مفاتيح
// تشغيلية (المزوّد، الرمز، المدة، معرّف الربط...) ويرمي أي مفتاح آخر، ثم
// يحجب أي نص يشبه سرًّا. الحمولات لا تُسجَّل إطلاقًا.
// ============================================================================

const ALLOWED_LOG_KEYS = new Set([
    'provider', 'action', 'code', 'status', 'duration_ms', 'connection_id', 'event_id', 'topic',
    'duplicate', 'linked', 'applied', 'attempts', 'count', 'route', 'stage'
]);

const SECRET_PATTERNS = [
    /\b(ck|cs)_[A-Za-z0-9]{8,}\b/g,                 // مفاتيح ووكومرس
    /\bshp[a-z]{2}_[A-Za-z0-9]{8,}\b/g,              // رموز Shopify (shpat_ / shprt_ / shpss_ …)
    /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,          // رموز حامل
    /\bBasic\s+[A-Za-z0-9+/=]{8,}/gi,               // Basic auth
    /\bihub1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,     // نص مشفّر
    /\bm3c1\.[A-Za-z0-9_-]{16,}/g,                  // رمز ربط الإضافة
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g, // JWT
    /\b[A-Fa-f0-9]{40,}\b/g,                        // سلاسل hex طويلة
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g // بريد
];

export function redactString(value, extraSecrets = []) {
    let s = String(value ?? '');
    for (const secret of extraSecrets) {
        if (secret && String(secret).length >= 6) s = s.split(String(secret)).join('[REDACTED]');
    }
    for (const re of SECRET_PATTERNS) s = s.replace(re, '[REDACTED]');
    return s;
}

export function sanitizeLogFields(fields = {}) {
    const out = {};
    for (const [k, v] of Object.entries(fields || {})) {
        if (!ALLOWED_LOG_KEYS.has(k)) continue;
        if (v === null || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
        else out[k] = redactString(v).slice(0, 120);
    }
    return out;
}

export function safeLog(logger, event, fields) {
    try {
        (logger || console).log(JSON.stringify({ ihub: String(event).slice(0, 48), ...sanitizeLogFields(fields) }));
    } catch {
        /* السجل لا يُسقط الطلب */
    }
}

/** بريد مقنّع للعرض: a***@example.com — يكفي للتأكد من الهوية دون كشف كامل. */
export function maskEmail(email) {
    const m = String(email || '').trim().match(/^([^@\s]+)@([^@\s]+\.[^@\s]+)$/);
    if (!m) return null;
    return `${m[1].slice(0, 1)}***@${m[2].toLowerCase()}`;
}
