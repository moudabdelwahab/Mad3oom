/**
 * security-alert — منطق تنبيهات أمان المالك بالبريد (خالص، بلا Deno) — tests/security-alert.test.mjs.
 *
 * ينادَى من القاعدة فقط (_security_alert_dispatch في 121، X-Internal-Secret). الحمولة نوع ومعرّف لا أكثر؛
 * التفاصيل تُقرأ هنا بمفتاح الخدمة. الأنواع:
 *   owner_account_change  محاولة تغيير كلمة مرور/بريد المالك حُجزت. يولّد رمزَي الموافقة والرفض، يحفظ
 *                         بصمتيهما في القاعدة مرة واحدة (_account_change_set_tokens)، ويرسل الرابطين.
 *                         الرمز النصي لا يُحفظ في أي مكان غير البريد نفسه.
 *   owner_new_login       دخول لحساب المالك من IP لم يظهر له من قبل.
 *   recovery_code_used    جلسة تحرير فُتحت برمز استرداد بدل تطبيق المصادقة.
 *
 * لا كلمة مرور ولا بصمتها ولا رمز تحقق في أي رسالة.
 */
import { esc, siteOriginFrom } from '../_shared/ticket-email.js';

export const ALERT_KINDS = Object.freeze(['owner_account_change', 'owner_new_login', 'recovery_code_used']);
export const APPROVAL_PATH = '/owner/security-approval.html';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function safeEqual(a, b) {
    const x = String(a ?? ''), y = String(b ?? '');
    let diff = x.length ^ y.length;
    const n = Math.max(x.length, y.length);
    for (let i = 0; i < n; i++) diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
    return diff === 0 && x.length > 0;
}

/** رمز رابط: 32 بايتًا عشوائيًا تشفيريًا، base64url. */
export function generateToken(cryptoImpl = globalThis.crypto) {
    const bytes = new Uint8Array(32);
    cryptoImpl.getRandomValues(bytes);
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** نفس public._token_hash(): sha256 hex للنص كما هو. */
export async function sha256Hex(text, cryptoImpl = globalThis.crypto) {
    const digest = new Uint8Array(await cryptoImpl.subtle.digest('SHA-256', new TextEncoder().encode(String(text))));
    return Array.from(digest, b => b.toString(16).padStart(2, '0')).join('');
}

export function approvalLinks(origin, requestId, approveToken, rejectToken) {
    const base = `${siteOriginFrom(origin)}${APPROVAL_PATH}?r=${encodeURIComponent(requestId)}`;
    return {
        approve: `${base}&a=approve#t=${encodeURIComponent(approveToken)}`,
        reject: `${base}&a=reject#t=${encodeURIComponent(rejectToken)}`
    };
}

const when = (v) => {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString('ar-EG', { timeZone: 'Africa/Cairo', dateStyle: 'medium', timeStyle: 'medium' });
};
const place = (geo) => [geo?.city, geo?.region, geo?.country].filter(Boolean).join('، ') || 'غير متاح';

function layout(title, intro, rows, actionsHtml, footer) {
    const tr = rows.map(([k, v]) => `<tr><td style="padding:6px 0;color:#5b6475;width:160px">${esc(k)}</td>`
        + `<td style="padding:6px 0;color:#0f172a;direction:ltr;text-align:right">${esc(v)}</td></tr>`).join('');
    return `<!doctype html><html lang="ar" dir="rtl"><body style="margin:0;background:#f4f6fb;font-family:Tahoma,Arial,sans-serif">
<div style="max-width:560px;margin:24px auto;background:#fff;border:1px solid #e3e7ef;border-radius:12px;overflow:hidden">
  <div style="background:#0b1f3a;color:#fff;padding:18px 22px;font-size:18px;font-weight:bold">مدعوم — تنبيه أمني</div>
  <div style="padding:22px">
    <h1 style="margin:0 0 10px;font-size:18px;color:#b42318">${esc(title)}</h1>
    <p style="margin:0 0 16px;color:#334155;line-height:1.7">${esc(intro)}</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px">${tr}</table>
    ${actionsHtml}
    <p style="margin:18px 0 0;color:#64748b;font-size:12px;line-height:1.7">${esc(footer)}</p>
  </div>
</div></body></html>`;
}

const button = (href, label, color) =>
    `<a href="${esc(href)}" style="display:inline-block;margin:6px 0 6px 8px;padding:10px 18px;border-radius:8px;background:${color};color:#fff;text-decoration:none;font-weight:bold">${esc(label)}</a>`;

/**
 * نص الرسالة. لا يستقبل أي سر غير رمزَي الرابطين (للتغيير المحجوز وحده).
 * @returns {{ subject: string, html: string, text: string }}
 */
export function buildAlertEmail(kind, data, { origin } = {}) {
    const ip = data?.ip || 'غير متاح';
    const ua = String(data?.user_agent || 'غير متاح').slice(0, 160);
    if (kind === 'owner_account_change') {
        const what = data.kind === 'email' ? 'البريد الإلكتروني' : 'كلمة المرور';
        const links = approvalLinks(origin, data.request_id, data.approve_token, data.reject_token);
        const rows = [
            ['المحاولة', `تغيير ${what}`], ['الوقت', when(data.requested_at)],
            ['عنوان IP (آخر جلسة نشطة)', ip], ['الموقع التقريبي', place(data.geo)], ['الجهاز/المتصفح', ua],
            ...(data.kind === 'email' && data.requested_email ? [['البريد المطلوب', data.requested_email]] : []),
            ['تنتهي صلاحية الطلب', when(data.expires_at)]
        ];
        const intro = `حاول أحدهم تغيير ${what} لحساب مالك المنصة. لم يُنفَّذ التغيير: القيمة الحالية باقية حتى توافق أنت.`;
        const actions = `<div style="margin-top:18px">${button(links.reject, 'لم أطلب هذا — ارفض وأخرج كل الجلسات', '#b42318')}`
            + `${button(links.approve, 'أنا من طلبه — راجع ووافق', '#1d4ed8')}</div>`;
        const footer = 'الموافقة تتطلب تسجيل الدخول بحساب المالك ثم رمز تطبيق المصادقة. الرفض لا يحتاج تسجيل دخول، ويُخرج كل جلسات الحساب. '
            + 'عنوان IP هو عنوان آخر جلسة نشطة للحساب لحظة المحاولة، لا يمرره نظام الدخول مباشرة.';
        return {
            subject: `تنبيه أمني: محاولة تغيير ${what} لحساب مالك المنصة`,
            html: layout(`محاولة تغيير ${what}`, intro, rows, actions, footer),
            text: [`محاولة تغيير ${what} لحساب مالك المنصة — لم يُنفَّذ.`, ...rows.map(([k, v]) => `${k}: ${v}`),
                   `للرفض وإخراج كل الجلسات: ${links.reject}`, `للمراجعة والموافقة: ${links.approve}`].join('\n')
        };
    }
    if (kind === 'owner_new_login') {
        const rows = [['الوقت', when(data.at)], ['عنوان IP', ip], ['الموقع التقريبي', place(data.geo)], ['الجهاز/المتصفح', ua]];
        const href = `${siteOriginFrom(origin)}/owner/security.html#sessions`;
        return {
            subject: 'تنبيه أمني: دخول جديد لحساب مالك المنصة',
            html: layout('دخول من عنوان جديد', 'سُجِّل دخول لحساب مالك المنصة من عنوان IP لم يظهر لهذا الحساب من قبل.', rows,
                `<div style="margin-top:18px">${button(href, 'مراجعة الجلسات', '#1d4ed8')}</div>`,
                'إن لم يكن هذا أنت: افتح الجلسات وأخرج كل الأجهزة، ثم غيّر كلمة المرور (التغيير نفسه يحتاج موافقتك من هذا البريد).'),
            text: ['دخول جديد لحساب مالك المنصة من عنوان IP جديد.', ...rows.map(([k, v]) => `${k}: ${v}`), `مراجعة الجلسات: ${href}`].join('\n')
        };
    }
    if (kind === 'recovery_code_used') {
        const rows = [['الوقت', when(data.at)], ['عنوان IP', ip], ['الجهاز/المتصفح', ua],
                      ['رموز الاسترداد المتبقية', String(data.recovery_codes_left ?? '—')]];
        return {
            subject: 'تنبيه أمني: استُخدم رمز استرداد لحساب مالك المنصة',
            html: layout('جلسة تحرير برمز استرداد', 'فُتحت جلسة تحرير لعمليات المالك الحساسة برمز استرداد بدل تطبيق المصادقة.', rows, '',
                'إن فقدت تطبيق المصادقة أعد تفعيل التحقق بخطوتين من إعدادات الأمان لتحصل على رموز جديدة. إن لم يكن هذا أنت فحسابك مخترق: أخرج كل الجلسات فورًا.'),
            text: ['استُخدم رمز استرداد لحساب مالك المنصة.', ...rows.map(([k, v]) => `${k}: ${v}`)].join('\n')
        };
    }
    throw new Error(`نوع تنبيه غير معروف: ${kind}`);
}

/**
 * التنفيذ. deps (كلها مُحقنة، بمفتاح الخدمة في index.ts):
 *   internalSecret()               السر المحفوظ في internal_service_secrets
 *   loadRequest(id)                صف owner_account_change_requests (بلا pending_value لكلمة المرور)
 *   setTokens(id, aHash, rHash)    _account_change_set_tokens ⇒ true مرة واحدة
 *   loadEvent(id)                  صف security_events
 *   loadStepUp(id)                 صف owner_step_up_sessions
 *   ownerEmail()                   بريد المالك الأساسي (auth.users)
 *   geo(ip)                        { country, region, city } أو null
 *   send({ to, subject, html, text, idempotencyKey })  ⇒ { ok, code? }
 *   log(type, severity, details)   سطر في security_events (source = 'edge')
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function handleSecurityAlert({ headerSecret, body, origin, deps, cryptoImpl = globalThis.crypto }) {
    const secret = await deps.internalSecret();
    if (!secret || !safeEqual(secret, headerSecret)) return { status: 401, body: { error: 'unauthorized' } };
    const kind = body?.kind;
    if (!ALERT_KINDS.includes(kind)) return { status: 400, body: { error: 'unknown_kind' } };

    const to = await deps.ownerEmail();
    if (!to) return { status: 409, body: { error: 'no_owner_email' } };

    let data;
    let idempotencyKey;
    if (kind === 'owner_account_change') {
        if (!UUID_RE.test(String(body.request || ''))) return { status: 400, body: { error: 'invalid_request' } };
        const req = await deps.loadRequest(body.request);
        if (!req || req.status !== 'pending') return { status: 409, body: { error: 'not_pending' } };
        const approveToken = generateToken(cryptoImpl);
        const rejectToken = generateToken(cryptoImpl);
        const stored = await deps.setTokens(req.id, await sha256Hex(approveToken, cryptoImpl), await sha256Hex(rejectToken, cryptoImpl));
        // تنبيه سابق لنفس الطلب وُلِّدت رموزه: لا رموز ثانية (الأولى في البريد الأول)
        if (!stored) return { status: 409, body: { error: 'tokens_already_set' } };
        data = { request_id: req.id, kind: req.kind, requested_at: req.requested_at, expires_at: req.expires_at,
                 ip: req.ip, user_agent: req.user_agent, requested_email: req.kind === 'email' ? req.pending_value : null,
                 geo: req.ip ? await deps.geo(req.ip) : null, approve_token: approveToken, reject_token: rejectToken };
        idempotencyKey = `owner-account-change-${req.id}`;
    } else if (kind === 'owner_new_login') {
        const ev = await deps.loadEvent(body.event_id);
        if (!ev || ev.event_type !== 'auth.login') return { status: 409, body: { error: 'no_event' } };
        data = { at: ev.at, ip: ev.ip, user_agent: ev.user_agent, geo: ev.ip ? await deps.geo(ev.ip) : null };
        idempotencyKey = `owner-new-login-${ev.id}`;
    } else {
        const s = await deps.loadStepUp(body.step_up_session);
        if (!s || s.method !== 'recovery_code') return { status: 409, body: { error: 'no_session' } };
        data = { at: s.started_at, ip: s.ip, user_agent: s.user_agent, recovery_codes_left: s.recovery_codes_left };
        idempotencyKey = `recovery-code-${s.id}`;
    }

    const mail = buildAlertEmail(kind, data, { origin });
    const result = await deps.send({ to, ...mail, idempotencyKey });
    await deps.log(result.ok ? 'alert.sent' : 'alert.failed', result.ok ? 'info' : 'warning',
        { kind, reference: body.request || body.event_id || body.step_up_session || null, ...(result.ok ? {} : { code: result.code }) });
    return result.ok ? { status: 200, body: { ok: true } } : { status: 502, body: { error: 'send_failed', code: result.code } };
}
