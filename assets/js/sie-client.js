/**
 * sie-client.js
 * ------------------------------------------------------------
 * Mad3oom Core's ONLY point of contact with the Support Intelligence
 * Engine (SIE). SIE is a fully independent product — it is not embedded
 * in this repository, and per the platform's architecture rules Mad3oom
 * must never import SIE source code. Every interaction with SIE MUST go
 * through public HTTP APIs, and this file is that single boundary.
 *
 * RULE: no other file in this codebase may call SIE directly (no
 * fetch()/XHR/axios to the SIE base URL anywhere else). If a new
 * feature needs SIE, add a function here and import it — never inline
 * a request elsewhere. This is what keeps SIE swappable/upgradeable
 * without ever touching a UI component, page, or feature module.
 *
 * What this file provides, end to end:
 *   - Base URL: never hardcoded here — always read from sie-config.js,
 *     which resolves it per environment (dev/staging/production).
 *   - Versioning: every endpoint lives under /api/v1/, centralized in
 *     SIE_ENDPOINTS below (a version bump is a one-place change).
 *   - Contract validation: every exported function documents its
 *     request/response shape and validates the response before
 *     returning it — a malformed/partial response degrades to a safe
 *     default instead of leaking garbage into the UI.
 *   - Reliability: request timeout (AbortController), one automatic
 *     retry for transient failures (network errors / 5xx), and a
 *     short-lived circuit breaker so a down SIE doesn't get hammered
 *     with doomed requests or make the UI feel slow.
 *   - Auth: forwards the current Supabase access token. Token refresh is
 *     never duplicated here — supabase.auth.getSession() already
 *     refreshes an expired session before returning it, so this file
 *     just asks for "the current session" and forwards whatever token
 *     that returns.
 *   - Logging: quiet in production; verbose only in local/dev
 *     environments (see sie-config.js's isSieDebugMode()). Tokens are
 *     never logged.
 *   - Fail-closed: every function catches its own errors and returns a
 *     safe default (false/null/{error}) rather than throwing, so the
 *     rest of the platform (chat, tickets, dashboard, admin, auth...)
 *     keeps working exactly as before even when SIE is unreachable.
 */
import { getSieBaseUrl, isSieDebugMode } from '/sie-config.js';

const API_VERSION = 'v1';

/** Centralized, versioned endpoint definitions — the only place a path is ever written. */
const SIE_ENDPOINTS = Object.freeze({
    HEALTH: `/api/${API_VERSION}/health`,
    IS_ADMIN: `/api/${API_VERSION}/admin/is-admin`,
    ACCESS_STATUS: (userId) => `/api/${API_VERSION}/access/${encodeURIComponent(userId)}`,
    ADMIN_SET_ACCESS: `/api/${API_VERSION}/admin/access`,
    ADMIN_RESET_USAGE: `/api/${API_VERSION}/admin/access/reset-usage`,
    CHAT_REPLY: `/api/${API_VERSION}/chat/reply`
});

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_RETRIES = 1; // one automatic retry for transient failures only
const RETRY_DELAY_MS = 400;

// ----- Circuit breaker: avoid hammering a known-down SIE, keep the UI snappy -----
const CIRCUIT_COOLDOWN_MS = 30000;
let circuitOpenUntil = 0;

function isCircuitOpen() {
    return Date.now() < circuitOpenUntil;
}

function tripCircuit() {
    circuitOpenUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
}

function resetCircuit() {
    circuitOpenUntil = 0;
}

/**
 * Whether SIE is currently considered reachable, WITHOUT making a
 * network call — purely reflects the circuit breaker's current state.
 * Safe to call as often as needed; never blocks or slows the UI.
 * @returns {boolean}
 */
export function isSieLikelyAvailable() {
    return !isCircuitOpen();
}

// ----- Dev-only logging (never verbose in production, never logs tokens) -----
function debugLog(...args) {
    if (isSieDebugMode()) console.debug('[sie-client]', ...args);
}
function warnLog(...args) {
    // Warnings are useful in every environment (they explain a
    // degrade-to-safe-default to whoever's debugging a support ticket),
    // but never include the token/headers, only the error message.
    console.warn('[sie-client]', ...args);
}

/** True for errors worth a single retry: network failures and 5xx server errors. Not for 4xx (those won't succeed on retry). */
function isRetryableError(err) {
    if (!err) return false;
    if (err.name === 'AbortError') return true; // timeout
    if (err instanceof TypeError) return true; // network failure (fetch throws TypeError on network errors)
    if (typeof err.status === 'number' && err.status >= 500) return true;
    return false;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wraps fetch() with an abort-based timeout so a slow/unreachable SIE can never hang the caller. */
async function withTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Current Supabase access token, if any — forwarded to SIE so it can
 * identify the caller. Reuses supabase-js's own session handling
 * (which already refreshes an expiring/expired token before returning
 * it) rather than re-implementing token refresh here.
 */
async function getAccessToken(supabase) {
    try {
        const { data } = await supabase.auth.getSession();
        return data?.session?.access_token || null;
    } catch (err) {
        warnLog('تعذّر جلب جلسة المستخدم الحالية:', err?.message || err);
        return null;
    }
}

class SieHttpError extends Error {
    constructor(message, status) {
        super(message);
        this.name = 'SieHttpError';
        this.status = status;
    }
}

/**
 * Performs one HTTP call to SIE (no retry, no circuit-breaker check —
 * see sieRequest() below for the full policy). Never logs the token.
 */
async function sieFetchOnce(supabase, path, { method = 'GET', body, timeoutMs } = {}) {
    const baseUrl = getSieBaseUrl();
    const token = await getAccessToken(supabase);
    const headers = { ...(body ? { 'Content-Type': 'application/json' } : {}) };
    if (token) headers.Authorization = `Bearer ${token}`;

    const response = await withTimeout(
        `${baseUrl}${path}`,
        { method, headers, body: body ? JSON.stringify(body) : undefined },
        timeoutMs
    );

    let payload = null;
    try {
        payload = await response.json();
    } catch {
        payload = null;
    }

    if (!response.ok) {
        const message = payload?.error || payload?.message || `SIE request failed (${response.status})`;
        throw new SieHttpError(message, response.status);
    }

    return payload;
}

/**
 * Full request policy: circuit breaker short-circuit -> one HTTP
 * attempt -> one retry on a transient failure -> circuit trip on
 * continued failure. This is what "one automatic retry for transient
 * failures" + "fail-closed" + "avoid unnecessary requests while SIE is
 * down" mean in practice, in one shared place so every exported
 * function below gets it for free.
 */
async function sieRequest(supabase, path, options = {}) {
    if (isCircuitOpen()) {
        debugLog(`الدائرة مفتوحة (SIE اتعتبر مش متاح مؤقتًا) — تخطي الطلب لـ ${path}`);
        throw new SieHttpError('SIE temporarily unavailable (circuit open)', 0);
    }

    try {
        const result = await sieFetchOnce(supabase, path, options);
        resetCircuit();
        return result;
    } catch (err) {
        if (!isRetryableError(err)) {
            throw err;
        }
        debugLog(`فشل مؤقت في ${path}، بيتعمل retry واحد:`, err?.message || err);
        await sleep(RETRY_DELAY_MS);
        try {
            const result = await sieFetchOnce(supabase, path, options);
            resetCircuit();
            return result;
        } catch (retryErr) {
            if (isRetryableError(retryErr)) tripCircuit();
            throw retryErr;
        }
    }
}

// ===================== Health check =====================

/**
 * Lightweight reachability check. Does not throw. Updates the circuit
 * breaker on failure so subsequent calls from any function in this
 * file skip straight to their fail-closed default without a network
 * round-trip, until the cooldown passes.
 *
 * Contract:
 *   Request:  GET {baseUrl}/api/v1/health
 *   Response (200): { status: 'ok' }  — any 2xx with a JSON body is treated as healthy
 * @returns {Promise<boolean>}
 */
export async function checkSieHealth() {
    if (isCircuitOpen()) return false;
    try {
        await sieFetchOnce(null, SIE_ENDPOINTS.HEALTH, { timeoutMs: 4000 });
        resetCircuit();
        return true;
    } catch (err) {
        warnLog('فحص توفر SIE فشل:', err?.message || err);
        tripCircuit();
        return false;
    }
}

// ===================== Entitlement / Admin API =====================

/**
 * هل المستخدم الحالي (حسب الـ token المُرسَل) أدمن معتمَد لدى SIE؟
 *
 * Contract:
 *   Request:  GET {baseUrl}/api/v1/admin/is-admin  (Authorization: Bearer <supabase JWT>)
 *   Response (200): { isAdmin: boolean }
 * Validation: anything other than a strict boolean `true` is treated as false (fail closed).
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @returns {Promise<boolean>}
 */
export async function isCurrentUserSieAdmin(supabase) {
    try {
        const data = await sieRequest(supabase, SIE_ENDPOINTS.IS_ADMIN, { timeoutMs: 6000 });
        if (!data || typeof data.isAdmin !== 'boolean') {
            debugLog('استجابة is-admin غير متوقعة، بيتم التعامل معاها كـ false:', data);
            return false;
        }
        return data.isAdmin === true;
    } catch (err) {
        warnLog('تعذّر التحقق من صلاحية أدمن SIE:', err?.message || err);
        return false;
    }
}

/**
 * يجيب حالة وصول عميل معيّن لمحرك SIE (مفعّل؟ نوع الحد؟ الاستخدام؟...).
 *
 * Contract:
 *   Request:  GET {baseUrl}/api/v1/access/:userId  (Authorization: Bearer <supabase JWT>)
 *   Response (200): {
 *     access: {
 *       is_enabled: boolean,
 *       access_mode: 'unlimited'|'quota'|'expiration',
 *       message_quota: number|null,
 *       messages_used: number|null,
 *       expires_at: string|null,   // ISO-8601
 *       notes: string|null
 *     } | null
 *   }
 * Validation: a response missing the `access` object, or one whose
 * `is_enabled` isn't a boolean, is treated as "no access row" (null) —
 * the same as the old direct-table-read behavior for an unknown user.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} userId
 * @returns {Promise<Object|null>}
 */
export async function getSieAccessStatus(supabase, userId) {
    if (!userId) return null;
    try {
        const data = await sieRequest(supabase, SIE_ENDPOINTS.ACCESS_STATUS(userId), { timeoutMs: 6000 });
        const access = data?.access;
        if (!access || typeof access !== 'object' || typeof access.is_enabled !== 'boolean') {
            return null;
        }
        return access;
    } catch (err) {
        warnLog('تعذّر جلب حالة وصول SIE:', err?.message || err);
        return null;
    }
}

/**
 * إعداد/تحديث وصول عميل لمحرك SIE (أدمن فقط).
 *
 * Contract:
 *   Request:  POST {baseUrl}/api/v1/admin/access
 *             body: { userId, isEnabled, accessMode, messageQuota, expiresAt, notes }
 *   Response (200): { success: true } (body is not required beyond a 2xx status)
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{userId: string, isEnabled: boolean, accessMode: string, messageQuota: number|null, expiresAt: string|null, notes: string|null}} params
 * @returns {Promise<{error: Error|null}>}
 */
export async function adminSetAccess(supabase, { userId, isEnabled, accessMode, messageQuota, expiresAt, notes }) {
    if (!userId) return { error: new Error('userId is required') };
    try {
        await sieRequest(supabase, SIE_ENDPOINTS.ADMIN_SET_ACCESS, {
            method: 'POST',
            body: { userId, isEnabled, accessMode, messageQuota, expiresAt, notes },
            timeoutMs: 10000
        });
        return { error: null };
    } catch (err) {
        warnLog('تعذّر تحديث وصول SIE:', err?.message || err);
        return { error: err instanceof Error ? err : new Error(String(err)) };
    }
}

/**
 * تصفير عداد الاستخدام لعميل معيّن (أدمن فقط).
 *
 * Contract:
 *   Request:  POST {baseUrl}/api/v1/admin/access/reset-usage
 *             body: { userId }
 *   Response (200): { success: true }
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} userId
 * @returns {Promise<{error: Error|null}>}
 */
export async function adminResetUsage(supabase, userId) {
    if (!userId) return { error: new Error('userId is required') };
    try {
        await sieRequest(supabase, SIE_ENDPOINTS.ADMIN_RESET_USAGE, {
            method: 'POST',
            body: { userId },
            timeoutMs: 10000
        });
        return { error: null };
    } catch (err) {
        warnLog('تعذّر تصفير استخدام SIE:', err?.message || err);
        return { error: err instanceof Error ? err : new Error(String(err)) };
    }
}

// ===================== Chat reply API =====================

/**
 * يطلب رد محادثة من محرك SIE الخارجي لرسالة عميل واحدة.
 *
 * Contract:
 *   Request:  POST {baseUrl}/api/v1/chat/reply
 *             body: { text, sessionId, userId, botState }
 *   Response (200): {
 *     reply: string,
 *     options?: Array<{ label: string, value: string }>,
 *     botState?: any,
 *     alreadyPersisted?: boolean,
 *     ticketNumber?: string|null
 *   }
 * Validation: a response with a non-string `reply` is treated as a
 * total failure (returns null) rather than rendering something broken
 * to the customer. `options` defaults to [] if missing/malformed.
 *
 * ⚠️ مين بيكتب في قاعدة البيانات؟
 *
 * كان مكتوب هنا إن SIE بيرجّع بيانات بس والكتابة علينا. ده مش صح: SIE
 * بيكتب دور المحادثة بنفسه - رسالة البوت و bot_state والتذكرة لو
 * اتفتحت - في معاملة واحدة، عشان أثر التشخيص والتذكرة ما يفترقوش. وده
 * بالظبط اللي بيحصل في قناة تيليجرام بردو.
 *
 * فبقى بيرجّع `alreadyPersisted`. الطبقة اللي بتنده الدالة دي
 * (chat-logic.js / chat-widget.js) **لازم** تتخطى الكتابة بتاعتها لما
 * تشوفه true - وإلا كل رد هيتكتب مرتين والعميل هيشوفه مكرر.
 *
 * لو رجع false أو مش موجود خالص (واجهة أقدم)، السلوك القديم بيفضل زي ما
 * هو: الكتابة على الطبقة اللي فوق.
 *
 * @param {Object} params
 * @param {string} params.text
 * @param {import('@supabase/supabase-js').SupabaseClient} params.supabase
 * @param {string} params.sessionId
 * @param {string} params.userId
 * @param {*} params.botState - آخر bot_state معروفة لهذه الجلسة
 * @returns {Promise<{reply: string, options: Array<{label:string,value:string}>, botState: *}|null>}
 */
export async function getSieReply({ text, supabase, sessionId, userId, botState }) {
    if (!text || !supabase || !sessionId || !userId) return null;
    try {
        const data = await sieRequest(supabase, SIE_ENDPOINTS.CHAT_REPLY, {
            method: 'POST',
            body: { text, sessionId, userId, botState: botState || {} },
            timeoutMs: 15000
        });

        if (!data || typeof data.reply !== 'string' || data.reply.trim() === '') {
            debugLog('استجابة chat/reply غير صالحة (مفيش نص رد):', data);
            return null;
        }
        return {
            reply: data.reply,
            options: Array.isArray(data.options) ? data.options.filter((o) => o && typeof o.label === 'string' && typeof o.value === 'string') : [],
            botState: data.botState ?? botState ?? {},
            // SIE بيكتب دور المحادثة بنفسه (رسالة البوت + bot_state +
            // التذكرة لو اتفتحت) في معاملة واحدة، عشان أثر التشخيص
            // والتذكرة ما يفترقوش. فالعلم ده معناه «متكتبش تاني».
            //
            // بيتقرا بـ === true عن قصد: أي رد قديم أو ناقص بيبقى false،
            // يعني السلوك الافتراضي يفضل «اكتب» زي ما كان، والتخطي
            // مابيحصلش إلا لما الواجهة تقوله صراحة.
            alreadyPersisted: data.alreadyPersisted === true,
            ticketNumber: data.ticketNumber ?? null
        };
    } catch (err) {
        warnLog('تعذّر الحصول على رد من محرك SIE الخارجي:', err?.message || err);
        return null;
    }
}
