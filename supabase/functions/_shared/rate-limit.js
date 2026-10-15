/**
 * rate-limit.js — حدّ المعدل المشترك للدوال الطرفية (103).
 * خالصة بلا Deno: مختبرة في tests/rate-limit-shared.test.mjs.
 *
 * ------------------------------------------------------------------------
 * THE DECISION IS MADE IN POSTGRES
 *
 * Every check is one call to public.rate_limit_hit(policy, subject), which
 * spends a token atomically in the shared bucket table (the same statement
 * SIE's limiter uses). No state lives here: Supabase runs and recycles any
 * number of instances, and a module-level counter would be N independent
 * limits that reset on cold start.
 *
 * Policy NUMBERS (capacity, window, enforce/observe/off) live in
 * public.rate_limit_policies so they change without a deploy. What lives in
 * code is the policy NAME, the SUBJECT, and the FAILURE MODE — the last
 * because when the database cannot be reached there is no row to read it from.
 *
 * ------------------------------------------------------------------------
 * SUBJECTS MUST BE SERVER-VERIFIED
 *
 * Pass a trusted IP (trustedClientIp), a user id from a verified JWT, a token
 * id after the token was verified — never an id, e-mail or IP taken from the
 * request body or from X-Forwarded-For. The database hashes the subject with a
 * pepper it never releases, so raw IPs and ids are not stored.
 *
 * ------------------------------------------------------------------------
 * FAILURE MODES
 *
 *   failClosed: true   (default) — authentication, account recovery, public
 *       unauthenticated endpoints, expensive operations. If the allowance
 *       cannot be verified the request is refused with 503, not waved through.
 *   failClosed: false — authenticated business endpoints whose limiter is
 *       a ceiling, not a control (e.g. personal API tokens). A database blip
 *       must not become an outage for every integration; it is logged.
 */

export const RATE_LIMIT_CODE = 'RATE_LIMIT_EXCEEDED';
export const RATE_LIMIT_UNAVAILABLE_CODE = 'RATE_LIMIT_UNAVAILABLE';

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HEXTET = /^[0-9a-f]{1,4}$/;

/** Expands an IPv6 literal to 8 four-digit hextets, or null if it is not one. */
function expandIpv6(raw) {
    let s = String(raw).toLowerCase();
    const zone = s.indexOf('%');
    if (zone >= 0) s = s.slice(0, zone);
    const lastColon = s.lastIndexOf(':');
    if (lastColon < 0) return null;
    // Embedded IPv4 in the low 32 bits: ::ffff:192.0.2.1, ::192.0.2.1, 64:ff9b::192.0.2.1
    let v4 = [];
    const last = s.slice(lastColon + 1);
    if (last.includes('.')) {
        if (!IPV4.test(last)) return null;
        const o = last.split('.').map(Number);
        v4 = [((o[0] << 8) | o[1]).toString(16), ((o[2] << 8) | o[3]).toString(16)];
        s = s.slice(0, lastColon + 1);
        if (!s.endsWith('::')) s = s.slice(0, -1);
    }
    const parts = s.split('::');
    if (parts.length > 2) return null;
    const head = parts[0] ? parts[0].split(':') : [];
    const tail = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
    for (const g of [...head, ...tail]) if (!HEXTET.test(g)) return null;
    const n = head.length + tail.length + v4.length;
    const pad = (g) => g.padStart(4, '0');
    if (parts.length === 1) return n === 8 ? [...head, ...v4].map(pad) : null;
    if (n > 7) return null;
    return [...head, ...new Array(8 - n).fill('0'), ...tail, ...v4].map(pad);
}

/**
 * The client IP as the platform saw it, or null.
 *
 * Supabase serves Edge Functions behind Cloudflare, which sets
 * `cf-connecting-ip` to the address of the TCP peer and overwrites any value a
 * client sends. Verified on production function_edge_logs (2026-10-15): the
 * header is present on every request and equals `x-real-ip`.
 *
 * `x-forwarded-for` and `x-real-ip` are deliberately NOT read: the left-most
 * X-Forwarded-For entry is whatever the client wrote (SIE audit S2).
 *
 * IPv6 is bucketed by /64 — one subscriber usually owns a whole /64, so a
 * per-address limit is trivially rotated. IPv4-mapped IPv6 is folded to IPv4.
 *
 * Known limit: requests proxied by Vercel (/oauth/*, /mcp rewrites) arrive
 * from Vercel's egress, so their IP buckets are per egress address. The
 * policies for those routes are sized for that; Cloudflare in front of the
 * public domain sees the real client (docs/security/RATE_LIMITING.md).
 */
/**
 * @param {Request} req
 * @returns {string | null}
 */
export function trustedClientIp(req) {
    const raw = req?.headers?.get?.('cf-connecting-ip');
    if (!raw) return null;
    const ip = String(raw).trim();
    if (IPV4.test(ip)) return ip;
    if (!ip.includes(':')) return null;
    const g = expandIpv6(ip);
    if (!g) return null;
    if (g.slice(0, 5).every((x) => x === '0000') && g[5] === 'ffff') {
        const a = parseInt(g[6], 16), b = parseInt(g[7], 16);
        return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
    }
    return `${g.slice(0, 4).join(':')}::/64`;
}

/**
 * What a request gets when the limiter cannot be consulted.
 * @returns {RateLimitDecision}
 */
function degraded(policy, failClosed, elapsedMs) {
    return Object.freeze({
        policy, allowed: !failClosed, enforced: false, wouldBlock: false, degraded: true,
        limit: 0, windowSeconds: 0, remaining: 0, resetSeconds: 0, retryAfter: failClosed ? 5 : 0, elapsedMs
    });
}

const now = () => (globalThis.performance?.now?.() ?? Date.now());

/**
 * @typedef {object} RateLimitDecision
 * @property {string} policy
 * @property {boolean} allowed      false ⇒ refuse the request
 * @property {boolean} enforced     the policy is in enforce mode
 * @property {boolean} wouldBlock   the bucket was empty (also in observe mode)
 * @property {boolean} degraded     the limiter could not be consulted
 * @property {number} limit
 * @property {number} windowSeconds
 * @property {number} remaining
 * @property {number} resetSeconds
 * @property {number} retryAfter
 * @property {number} elapsedMs
 */

/**
 * Spends one token of `policy` for `subject`.
 *
 * @param {object} admin   supabase-js client with the SERVICE ROLE key
 * @param {string} policy  a row in public.rate_limit_policies
 * @param {string|null} subject  server-verified identity (see header)
 * @param {{ failClosed?: boolean, logger?: Pick<Console,'warn'|'error'> }} [opts]
 * @returns {Promise<RateLimitDecision>}
 */
export async function checkRateLimit(admin, policy, subject, opts = {}) {
    const failClosed = opts.failClosed !== false;
    const log = opts.logger ?? console;
    const t0 = now();
    let data, error;
    try {
        ({ data, error } = await admin.rpc('rate_limit_hit', { p_policy: policy, p_subject: subject ?? null }));
    } catch (err) {
        error = err;
    }
    const elapsedMs = Math.round(now() - t0);
    const row = Array.isArray(data) ? data[0] : data;
    if (error || !row) {
        // Never log the subject: it is an IP or an identity.
        log.error(JSON.stringify({
            event: 'rate_limit_unavailable', policy, fail: failClosed ? 'closed' : 'open', elapsed_ms: elapsedMs,
            reason: error ? String(error.code || error.message || error).slice(0, 120) : 'no_row'
        }));
        return degraded(policy, failClosed, elapsedMs);
    }
    const decision = Object.freeze({
        policy,
        allowed: row.allowed === true,
        enforced: row.enforced === true,
        wouldBlock: row.would_block === true,
        degraded: false,
        limit: Number(row.limit_total ?? 0),
        windowSeconds: Number(row.window_seconds ?? 0),
        remaining: Number(row.remaining ?? 0),
        resetSeconds: Number(row.reset_seconds ?? 0),
        retryAfter: Number(row.retry_after ?? 0),
        elapsedMs
    });
    if (decision.wouldBlock) {
        log.warn(JSON.stringify({
            event: 'rate_limit', policy, outcome: decision.allowed ? 'observed' : 'rejected',
            retry_after: decision.retryAfter, elapsed_ms: elapsedMs
        }));
    }
    return decision;
}

/**
 * RateLimit-* (IETF draft) and X-RateLimit-* headers, plus Retry-After on a
 * refusal. Nothing for a policy that is not enforcing — an observe-mode
 * policy must not advertise a ceiling it does not apply.
 *
 * @param {RateLimitDecision | null | undefined} d
 * @returns {Record<string, string>}
 */
export function rateLimitHeaders(d) {
    /** @type {Record<string, string>} */
    const none = {};
    if (!d) return none;
    if (d.degraded) return d.allowed ? none : { 'Retry-After': String(Math.max(d.retryAfter, 1)) };
    if (!d.enforced) return none;
    /** @type {Record<string, string>} */
    const h = {
        'RateLimit-Limit': String(d.limit),
        'RateLimit-Remaining': String(d.remaining),
        'RateLimit-Reset': String(d.resetSeconds),
        'X-RateLimit-Limit': String(d.limit),
        'X-RateLimit-Remaining': String(d.remaining),
        'X-RateLimit-Reset': String(d.resetSeconds)
    };
    if (!d.allowed) h['Retry-After'] = String(Math.max(d.retryAfter, 1));
    return h;
}

/** Headers a browser needs permission to read on a cross-origin response. */
export const RATE_LIMIT_EXPOSE_HEADERS =
    'Retry-After, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset';

/**
 * The standard refusal body. `error` stays a STRING because every Mad3oom
 * client reads `body.error` as text; `code` carries the machine-readable value.
 * No counters beyond the retry hint, no policy name, no subject.
 */
/** @param {RateLimitDecision | null | undefined} d */
export function rateLimitBody(d) {
    if (d?.degraded) {
        return {
            error: RATE_LIMIT_UNAVAILABLE_CODE,
            code: RATE_LIMIT_UNAVAILABLE_CODE,
            message: 'Service temporarily unavailable. Please try again shortly.',
            message_ar: 'الخدمة غير متاحة مؤقتًا. حاول مرة أخرى بعد قليل.',
            retry_after: Math.max(d.retryAfter, 1)
        };
    }
    return {
        error: RATE_LIMIT_CODE,
        code: RATE_LIMIT_CODE,
        message: 'Too many requests. Please try again later.',
        message_ar: 'طلبات كثيرة جدًا. حاول مرة أخرى بعد قليل.',
        retry_after: Math.max(d?.retryAfter ?? 1, 1)
    };
}

/** 429 for a refusal, 503 when a fail-closed limiter could not decide. */
/** @param {RateLimitDecision | null | undefined} d */
export function rateLimitStatus(d) {
    return d?.degraded ? 503 : 429;
}

/**
 * A complete refusal Response (JSON), merged with the caller's CORS headers.
 * @param {RateLimitDecision} d
 * @param {Record<string, string>} [headers]
 */
export function rateLimitResponse(d, headers = {}) {
    return new Response(JSON.stringify(rateLimitBody(d)), {
        status: rateLimitStatus(d),
        headers: {
            ...headers,
            ...rateLimitHeaders(d),
            'Access-Control-Expose-Headers': RATE_LIMIT_EXPOSE_HEADERS,
            'Content-Type': 'application/json'
        }
    });
}

/**
 * A `{ rpc }` client over PostgREST for functions that do not load supabase-js.
 * Same contract as supabase-js: resolves to `{ data, error }`, never throws.
 */
/**
 * @param {string} supabaseUrl
 * @param {string} serviceRoleKey
 * @param {typeof fetch} [fetchImpl]
 */
export function restRpcClient(supabaseUrl, serviceRoleKey, fetchImpl = globalThis.fetch) {
    const base = String(supabaseUrl || '').replace(/\/+$/, '');
    return {
        async rpc(fn, args) {
            try {
                const res = await fetchImpl(`${base}/rest/v1/rpc/${fn}`, {
                    method: 'POST',
                    headers: {
                        apikey: serviceRoleKey,
                        Authorization: `Bearer ${serviceRoleKey}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(args ?? {})
                });
                const body = await res.json().catch(() => null);
                return res.ok ? { data: body, error: null } : { data: null, error: { code: String(res.status), message: body?.message ?? 'rpc failed' } };
            } catch (err) {
                return { data: null, error: { message: err instanceof Error ? err.message : String(err) } };
            }
        }
    };
}
