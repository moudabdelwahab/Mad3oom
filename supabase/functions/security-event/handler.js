/**
 * security-event — أحداث أمان يبلغ عنها المتصفح، والموقع التقريبي للعناوين (خالص، بلا Deno) —
 * tests/security-event.test.mjs.
 *
 *   login_failed  (بلا جلسة) Supabase Auth لا يكتب محاولات الدخول الفاشلة في أي جدول نقرؤه، فتبلغ عنها
 *                 صفحة الدخول هنا. البريد من الطلب، والـIP والمتصفح من رؤوس الطلب نفسه (لا من الجسم).
 *                 تُسجَّل بمصدر client_report — «أبلغ عنها المتصفح» لا «تحقق منها الخادم» — مع حد لكل IP.
 *                 تكرار الفشل لبريد واحد (failed_login_threshold في 15 دقيقة) ⇒ auth.failed_burst حرج.
 *   enrich_geo    (جلسة المالك) يملأ ip_geo_cache لعناوين السجل من مزوّد IP_GEO_URL إن ضُبط. بلا ضبط لا يُرسَل
 *                 أي IP لطرف ثالث. التفويض = نجاح owner_geo_pending() بجلسة المنادي (owner_only في القاعدة).
 *
 * لا كلمة مرور في أي حقل: الجسم المقبول بريد وسبب من قائمة مغلقة فقط.
 */

export const FAILURE_REASONS = Object.freeze(['invalid_credentials', 'email_not_confirmed', 'rate_limited', 'banned', 'mfa_failed', 'other']);
export const IP_LIMIT_PER_10_MIN = 30;
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/** IP المنادي كما يضعه وسيط Supabase. أول عنوان في x-forwarded-for، أو cf-connecting-ip / x-real-ip. */
export function clientIp(headers) {
    const get = (k) => (typeof headers?.get === 'function' ? headers.get(k) : headers?.[k]) || '';
    const raw = String(get('x-forwarded-for')).split(',')[0].trim() || String(get('cf-connecting-ip')).trim()
        || String(get('x-real-ip')).trim();
    return isIp(raw) ? raw : null;
}

export function isIp(v) {
    const s = String(v || '');
    if (/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(s)) return s.split('.').every(n => Number(n) <= 255);
    return /^[0-9a-f:]+$/i.test(s) && s.includes(':') && s.length <= 45;
}

/** عناوين خاصة/محلية لا موقع لها ولا تُرسَل لمزوّد. */
export function isPrivateIp(ip) {
    const s = String(ip || '');
    return /^(10\.|127\.|0\.|169\.254\.|192\.168\.)/.test(s) || /^172\.(1[6-9]|2\d|3[01])\./.test(s)
        || /^(::1|fe80:|fc|fd)/i.test(s);
}

/** يقرأ الحقول الشائعة لمزوّدي GeoIP (ipapi.co، ip-api.com، ipinfo.io). */
export function normalizeGeo(raw) {
    if (!raw || typeof raw !== 'object' || raw.error === true || raw.status === 'fail') return null;
    const pick = (...keys) => { for (const k of keys) if (typeof raw[k] === 'string' && raw[k].trim()) return raw[k].trim().slice(0, 80); return null; };
    const geo = {
        country: pick('country_name', 'country'), country_code: pick('country_code', 'countryCode'),
        region: pick('region', 'regionName'), city: pick('city'), org: pick('org', 'isp', 'asn')
    };
    if (geo.country && geo.country.length === 2 && !geo.country_code) { geo.country_code = geo.country; }
    return Object.values(geo).some(Boolean) ? geo : null;
}

/**
 * الموقع التقريبي لعنوان، من الذاكرة المؤقتة ثم المزوّد. template فارغ ⇒ null دائمًا.
 * @param {string} ip
 * @param {{ template?: string, db?: any, fetchImpl?: typeof fetch }} options
 */
export async function lookupGeo(ip, { template = '', db = null, fetchImpl = globalThis.fetch } = {}) {
    if (!template || !isIp(ip) || isPrivateIp(ip)) return null;
    if (db) {
        const { data } = await db.from('ip_geo_cache').select('country, country_code, region, city, org, looked_up_at').eq('ip', ip).maybeSingle();
        if (data && Date.now() - Date.parse(data.looked_up_at) < 30 * 864e5) return data;
    }
    let geo = null;
    try {
        const res = await fetchImpl(template.replace('{ip}', encodeURIComponent(ip)), { headers: { Accept: 'application/json' } });
        if (res.ok) geo = normalizeGeo(await res.json());
    } catch { /* المزوّد غير متاح: بلا موقع */ }
    if (geo && db) {
        let source = 'provider';
        try { source = new URL(template.replace('{ip}', '0.0.0.0')).host; } catch { /* قالب بلا URL صالح */ }
        await db.from('ip_geo_cache').upsert({ ip, ...geo, looked_up_at: new Date().toISOString(), source });
    }
    return geo;
}

/**
 * deps:
 *   countIp(ip, sinceIso)           أحداث client_report من هذا الـIP
 *   countFailures(email, sinceIso)  auth.login_failed لهذا البريد
 *   burstLogged(email, sinceIso)    هل سُجِّل auth.failed_burst لهذا البريد مؤخرًا؟
 *   threshold()                     failed_login_threshold من السياسة
 *   insert(row)                     سطر في security_events
 *   ownerGeoPending(authHeader)     owner_geo_pending() بجلسة المنادي ⇒ مصفوفة IPs، أو null عند الرفض
 *   geo(ip)                         lookupGeo
 */
export async function handleSecurityEvent({ body, headers, authHeader, deps, now = () => new Date() }) {
    const action = body?.action;
    if (action === 'login_failed') {
        const email = String(body.email || '').trim().toLowerCase();
        const reason = FAILURE_REASONS.includes(body.reason) ? body.reason : 'other';
        if (!EMAIL_RE.test(email) || email.length > 254) return { status: 400, body: { error: 'invalid_email' } };
        const ip = clientIp(headers);
        const ua = String((typeof headers?.get === 'function' ? headers.get('user-agent') : headers?.['user-agent']) || '').slice(0, 400) || null;
        const t = now();
        if (ip && (await deps.countIp(ip, new Date(t - 10 * 60e3).toISOString())) >= IP_LIMIT_PER_10_MIN) {
            return { status: 429, body: { error: 'rate_limited' } };
        }
        await deps.insert({ event_type: 'auth.login_failed', severity: 'notice', target_email: email, ip, user_agent: ua,
                            details: { reason, reported_by: 'browser' }, source: 'client_report' });
        const since = new Date(t - 15 * 60e3).toISOString();
        const failures = await deps.countFailures(email, since);
        const threshold = Number(await deps.threshold()) || 5;
        if (failures >= threshold && !(await deps.burstLogged(email, since))) {
            await deps.insert({ event_type: 'auth.failed_burst', severity: 'critical', target_email: email, ip, user_agent: ua,
                                details: { failures, window_minutes: 15, threshold }, source: 'edge' });
        }
        return { status: 200, body: { ok: true } };
    }
    if (action === 'enrich_geo') {
        const pending = await deps.ownerGeoPending(authHeader);
        if (!Array.isArray(pending)) return { status: 403, body: { error: 'forbidden' } };
        let resolved = 0;
        for (const ip of pending.slice(0, 50)) {
            if (await deps.geo(ip)) resolved += 1;
        }
        return { status: 200, body: { ok: true, pending: pending.length, resolved } };
    }
    return { status: 400, body: { error: 'unknown_action' } };
}
