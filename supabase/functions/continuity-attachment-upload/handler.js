/**
 * continuity-attachment-upload — منطق الرفع (بلا Deno ولا Supabase: الاعتماديات تُحقن).
 * index.ts يربطه بـ Supabase؛ tests/continuity-attachment-upload.test.mjs يختبره ببدائل.
 *
 * الطلب: POST والجسم هو بايتات الملف نفسها.
 *   Authorization: Bearer <JWT المستخدم>
 *   Content-Type: نوع الملف · Content-Length: حجمه بالبايت
 *   X-Continuity-Record: معرّف السجل · X-Continuity-Kind: image | video | audio
 *   X-Idempotency-Key: UUID · X-Continuity-Name: اسم العرض (encodeURIComponent، اختياري)
 *   X-Continuity-Shared: 1 (اختياري، 093) ⇒ مسار مستلم المشاركة التعاونية: continuity_shared_attachment_begin/commit.
 *
 * الخطوات:
 *   1. JWT صالح، والرؤوس سليمة، والنوع والحجم ضمن القائمة (قبل قراءة أي بايت).
 *   2. continuity_attachment_begin **بهوية المستخدم**: الصلاحية، السجل نشط، القدرة مفعّلة،
 *      الحد الأقصى، ومسار يولّده الخادم.
 *   3. قراءة الجسم بحد صارم (لا يتجاوز الحجم المعلن)، ثم فحص التوقيع (magic bytes) مقابل
 *      النوع المعلن، ثم sha256.
 *   4. الرفع بمفتاح الخدمة إلى المسار المولَّد فقط (بلا upsert).
 *   5. continuity_attachment_commit بهوية المستخدم: القاعدة تتحقق من الملف المخزَّن نفسه.
 *
 * الردود JSON دائمًا، بأكواد لا رسائل داخلية: { error: { code, field?, reason? } }.
 */
import { checkDeclared, signatureMatches, baseMime } from '../_shared/continuity-media.js';

export const BUCKET = 'continuity-attachments';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const CORS_HEADERS = Object.freeze({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-continuity-record, '
        + 'x-continuity-kind, x-continuity-name, x-idempotency-key, x-continuity-shared',
});

const json = (status, body) => new Response(JSON.stringify(body), {
    status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});
const fail = (status, code, extra = {}) => json(status, { error: { code, ...extra } });

// رفض القاعدة (PostgREST) ⇒ حالة HTTP وكود؛ التفاصيل من detail فقط (لا نص الرسالة).
const SQLSTATE = { P0002: [404, 'not_found'], '42501': [403, 'forbidden'], '0A000': [403, 'feature_not_enabled'],
    '22023': [400, 'validation_failed'], '55000': [409, 'invalid_transition'], '23505': [409, 'idempotency_conflict'],
    '40001': [409, 'version_conflict'] };
function dbFail(error) {
    const [status, code] = SQLSTATE[error?.code] || [502, 'server_error'];
    let detail = {};
    try { detail = error?.details ? JSON.parse(error.details) : {}; } catch { detail = {}; }
    const extra = {};
    if (typeof detail.field === 'string') extra.field = detail.field;
    if (typeof detail.reason === 'string') extra.reason = detail.reason;
    return fail(status, typeof detail.code === 'string' ? detail.code : code, extra);
}

function decodeName(raw) {
    if (!raw) return null;
    try { return decodeURIComponent(raw); } catch { return null; }
}

/** يقرأ الجسم كاملًا بحد صارم. ⇒ Uint8Array، أو null لو تجاوز الحد. */
export async function readCapped(body, limit) {
    if (!body) return new Uint8Array(0);
    const reader = body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > limit) {
            try { await reader.cancel(); } catch { /* ignore */ }
            return null;
        }
        chunks.push(value);
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.byteLength; }
    return out;
}

/**
 * deps:
 *   getUser(token)                    ⇒ { id } | null   (التحقق من JWT)
 *   rpc(token, fn, args)              ⇒ { data, error } (بهوية المستخدم، مفتاح anon)
 *   upload(path, bytes, contentType)  ⇒ { error }       (مفتاح الخدمة، المستودع BUCKET، بلا upsert)
 *   remove(path)                      ⇒ { error }       (مفتاح الخدمة)
 *   sha256(bytes)                     ⇒ hex
 */
export async function handleUpload(req, deps) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (req.method !== 'POST') return fail(405, 'method_not_allowed');

    const auth = req.headers.get('authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token) return fail(401, 'unauthorized');
    const user = await deps.getUser(token).catch(() => null);
    if (!user?.id) return fail(401, 'unauthorized');

    const record = req.headers.get('x-continuity-record') || '';
    // 093: مستلم مشاركة تعاونية (add_source) — نفس الخطوات عبر دوال المشاركة، والرد هو العرض المشترك.
    const shared = req.headers.get('x-continuity-shared') === '1';
    const BEGIN = shared ? 'continuity_shared_attachment_begin' : 'continuity_attachment_begin';
    const COMMIT = shared ? 'continuity_shared_attachment_commit' : 'continuity_attachment_commit';
    const kind = req.headers.get('x-continuity-kind') || '';
    const mime = baseMime(req.headers.get('content-type'));
    const key = req.headers.get('x-idempotency-key') || '';
    const lengthHeader = req.headers.get('content-length');
    const size = /^\d{1,12}$/.test(lengthHeader || '') ? Number(lengthHeader) : NaN;
    if (!UUID.test(record)) return fail(400, 'validation_failed', { field: 'record' });
    if (!UUID.test(key)) return fail(400, 'validation_failed', { field: 'idempotency_key' });
    if (!Number.isSafeInteger(size)) return fail(411, 'validation_failed', { field: 'size', reason: 'length_required' });
    const declared = checkDeclared({ kind, mime, size });
    if (declared) return fail(declared.reason === 'too_large' ? 413 : 400, 'validation_failed', declared);

    const begun = await deps.rpc(token, BEGIN, {
        p_record: record, p_kind: kind, p_mime: mime, p_size: size,
        p_name: decodeName(req.headers.get('x-continuity-name')), p_idempotency_key: key,
    });
    if (begun.error) return dbFail(begun.error);
    const attachment = begun.data?.attachment;
    const upload = begun.data?.upload;

    // إعادة إرسال لمرفق اكتمل: لا رفع، والتأكيد بلا أثر يرجع السجل.
    if (attachment?.status === 'active') {
        const done = await deps.rpc(token, COMMIT, { p_attachment: attachment.id, p_sha256: null });
        return done.error ? dbFail(done.error) : json(200, done.data);
    }
    if (!attachment?.id || !upload?.path || upload.bucket !== BUCKET) return fail(502, 'server_error');

    const bytes = await readCapped(req.body, Math.min(size, upload.max_bytes));
    if (!bytes) return fail(413, 'validation_failed', { field: 'size', reason: 'too_large' });
    if (bytes.byteLength !== size) return fail(400, 'validation_failed', { field: 'size', reason: 'size_mismatch' });
    if (!signatureMatches(mime, bytes.subarray(0, 64))) return fail(415, 'validation_failed', { field: 'file', reason: 'signature_mismatch' });
    const sha = await deps.sha256(bytes);

    const put = await deps.upload(upload.path, bytes, mime);
    // محاولة سابقة رفعت الملف ثم انقطعت قبل التأكيد: الملف موجود في نفس المسار، والتأكيد يتحقق منه.
    const exists = put.error && (put.error.statusCode === '409' || put.error.statusCode === 409 || /exists/i.test(put.error.message || ''));
    if (put.error && !exists) return fail(502, 'upload_failed');

    const done = await deps.rpc(token, COMMIT, { p_attachment: attachment.id, p_sha256: sha });
    if (done.error) {
        // الملف لا يطابق ما أعلنه (أو اختفى السجل): يُحذف الآن، والصف المعلّق يكنسه الكنس.
        if (!exists) await deps.remove(upload.path).catch(() => null);
        return dbFail(done.error);
    }
    return json(200, done.data);
}
