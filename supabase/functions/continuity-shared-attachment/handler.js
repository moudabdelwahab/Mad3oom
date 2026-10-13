/**
 * continuity-shared-attachment — عرض مرفق داخل نطاق تسليم محدود (091، القرار S-7).
 *
 * المستلم لا يوقّع ملفًا بنفسه أبدًا: سياسة المستودع (080) كما هي، تسمح للمالك وفريق السجل فقط.
 * هذه الدالة تعيد البوابة كاملة **بهوية المستخدم** لكل طلب، ثم توقّع داخليًا رابطًا قصيرًا:
 *   1. JWT صالح.
 *   2. continuity_shared_attachment_check بهوية المستخدم: منحة فعّالة (الحالة، الانتهاء، الجلسة،
 *      الأهلية، سلطة المانح، السجل، المفتاح)، والمرفق داخل النطاق المعتمد ونشط. ⇒ المسار والمدة.
 *      المدة ≤ min(60 ثانية، الوقت المتبقي في المنحة) — تحسبها القاعدة لا الدالة.
 *   3. توقيع بمفتاح الخدمة للمسار نفسه بالمدة نفسها (بلا تنزيل إجباري، بلا تخزين مؤقت).
 *
 * الطلب: POST { "attachment_id": "<uuid>" } مع Authorization: Bearer <JWT>.
 * الرد: { url, expires_in, mime, name, size } أو { error: { code, field?, reason? } }.
 * أي رفض من القاعدة (لا منحة، خارج النطاق، غير موجود) ⇒ 404 not_found واحد لا يفرّق.
 * المسار لا يظهر في الرد إلا داخل الرابط الموقّع، ولا يُسجَّل.
 */
export const BUCKET = 'continuity-attachments';
export const MAX_TTL = 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// <workspace>/<record>/<attachment> كما يولّدها continuity_attachment_begin
const PATH = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36,}$/i;
const MAX_BODY = 1024;
const TOO_LARGE = Symbol('too_large');

export const CORS_HEADERS = Object.freeze({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
});

const json = (status, body) => new Response(JSON.stringify(body), {
    status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});
const fail = (status, code, extra = {}) => json(status, { error: { code, ...extra } });

const SQLSTATE = { P0002: [404, 'not_found'], '42501': [403, 'forbidden'], '0A000': [403, 'feature_not_enabled'],
    '22023': [400, 'validation_failed'] };
function dbFail(error) {
    const [status, code] = SQLSTATE[error?.code] || [502, 'server_error'];
    // not_found موحّد: لا field ولا reason (لا يكشف لماذا)
    if (code === 'not_found') return fail(404, 'not_found');
    let detail = {};
    try { detail = error?.details ? JSON.parse(error.details) : {}; } catch { detail = {}; }
    const extra = {};
    if (typeof detail.field === 'string') extra.field = detail.field;
    if (typeof detail.reason === 'string') extra.reason = detail.reason;
    return fail(status, typeof detail.code === 'string' ? detail.code : code, extra);
}

async function readBody(req) {
    const declared = Number(req.headers.get('content-length') || 0);
    if (declared > MAX_BODY) return TOO_LARGE;
    const text = await req.text();
    if (text.length > MAX_BODY) return TOO_LARGE;
    try { return JSON.parse(text || 'null'); } catch { return undefined; }
}

/**
 * deps:
 *   getUser(token)                       ⇒ user | null
 *   rpc(token, fn, args)                 ⇒ { data, error } بهوية المستخدم
 *   sign(path, ttlSeconds)               ⇒ { data: { signedUrl }, error } بمفتاح الخدمة
 */
export async function handleShared(req, deps) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (req.method !== 'POST') return fail(405, 'method_not_allowed');
    const auth = req.headers.get('authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token) return fail(401, 'unauthorized');
    const user = await deps.getUser(token).catch(() => null);
    if (!user?.id) return fail(401, 'unauthorized');

    const body = await readBody(req);
    if (body === TOO_LARGE) return fail(413, 'payload_too_large');
    const id = body && typeof body === 'object' ? body.attachment_id : undefined;
    if (typeof id !== 'string' || !UUID.test(id)) return fail(400, 'validation_failed', { field: 'attachment_id' });

    const { data, error } = await deps.rpc(token, 'continuity_shared_attachment_check', { p_attachment: id })
        .catch(() => ({ data: null, error: { code: 'network' } }));
    if (error) return dbFail(error);
    const path = data?.path;
    const ttl = Number(data?.ttl);
    if (typeof path !== 'string' || !PATH.test(path) || !Number.isInteger(ttl) || ttl < 1 || ttl > MAX_TTL) {
        return fail(502, 'server_error');
    }
    const signed = await deps.sign(path, ttl).catch(() => ({ data: null, error: true }));
    const url = signed?.data?.signedUrl;
    if (signed?.error || typeof url !== 'string' || !url) return fail(502, 'sign_failed');
    return json(200, {
        url, expires_in: ttl,
        mime: typeof data.mime === 'string' ? data.mime : null,
        name: typeof data.name === 'string' ? data.name : null,
        size: Number.isFinite(Number(data.size)) ? Number(data.size) : null,
    });
}
