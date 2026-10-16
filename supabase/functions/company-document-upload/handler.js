/**
 * company-document-upload — رفع إصدار مستند شركة (migrations/100_company_documents.sql).
 * المنطق هنا والاعتماديات تُحقن (index.ts يربطها بـ Supabase؛ tests/company-documents-functions.test.mjs يختبرها).
 *
 * الطلب: POST والجسم بايتات الملف.
 *   Authorization: Bearer <JWT> · Content-Type · Content-Length
 *   X-Document-Type: commercial_registration | authorization_letter | contract_proof | tax_card
 *   X-Idempotency-Key: UUID · X-Document-Name: اسم العرض (encodeURIComponent، اختياري)
 *
 * 1. المعلَن (النوع، الحجم ≤ 10MB) قبل قراءة أي بايت.
 * 2. document_upload_begin بهوية المستخدم: مدير الشركة + المفتاح + مسار يولّده الخادم.
 * 3. قراءة الجسم بحد صارم، الحجم الفعلي = المعلن، التوقيع يطابق النوع، ثم sha256 من البايتات نفسها.
 * 4. الرفع بمفتاح الخدمة إلى المسار المولَّد فقط (بلا upsert).
 * 5. document_upload_commit_server بمفتاح الخدمة (104 L3): الرافع الذي تحققنا منه والبصمة التي حسبناها —
 *    لا يرسل المستخدم البصمة أبدًا ⇒ pending_scan (معزول حتى نتيجة فحص موقَّعة).
 */
import { BUCKET, baseMime, checkDeclared, signatureMatches, cleanName } from '../_shared/company-documents.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CORS_HEADERS = Object.freeze({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-document-type, x-document-name, x-idempotency-key',
});
const json = (status, body) => new Response(JSON.stringify(body), {
    status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});
const fail = (status, code, extra = {}) => json(status, { error: { code, ...extra } });

const SQLSTATE = { P0002: [404, 'not_found'], '42501': [403, 'forbidden'], '0A000': [403, 'feature_not_enabled'],
    '22023': [400, 'validation_failed'], '55000': [409, 'invalid_state'], '23505': [409, 'idempotency_conflict'],
    '54000': [429, 'rate_limited'] };
export function dbFail(error) {
    const [status, code] = SQLSTATE[error?.code] || [502, 'server_error'];
    let detail = {};
    try { detail = error?.details ? JSON.parse(error.details) : {}; } catch { detail = {}; }
    const extra = {};
    if (typeof detail.field === 'string') extra.field = detail.field;
    if (typeof detail.reason === 'string') extra.reason = detail.reason;
    return fail(status, typeof detail.code === 'string' ? detail.code : code, extra);
}

export async function readCapped(body, limit) {
    if (!body) return new Uint8Array(0);
    const reader = body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > limit) { try { await reader.cancel(); } catch { /* ignore */ } return null; }
        chunks.push(value);
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.byteLength; }
    return out;
}

/** deps: getUser(token) · rpc(token, fn, args) · commit(versionId, actorId, sha256) (مفتاح الخدمة)
 *        · upload(path, bytes, contentType) · download(path) ⇒ Uint8Array|null · remove(path) · sha256(bytes) */
export async function handleUpload(req, deps) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (req.method !== 'POST') return fail(405, 'method_not_allowed');
    const auth = req.headers.get('authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token) return fail(401, 'unauthorized');
    const user = await deps.getUser(token).catch(() => null);
    if (!user?.id) return fail(401, 'unauthorized');

    const docType = req.headers.get('x-document-type') || '';
    const key = req.headers.get('x-idempotency-key') || '';
    const mime = baseMime(req.headers.get('content-type'));
    const len = req.headers.get('content-length');
    const size = /^\d{1,12}$/.test(len || '') ? Number(len) : NaN;
    if (!/^[a-z_]{3,40}$/.test(docType)) return fail(400, 'validation_failed', { field: 'doc_type' });
    if (!UUID.test(key)) return fail(400, 'validation_failed', { field: 'idempotency_key' });
    if (!Number.isSafeInteger(size)) return fail(411, 'validation_failed', { field: 'size', reason: 'length_required' });
    const declared = checkDeclared({ mime, size });
    if (declared) return fail(declared.reason === 'too_large' ? 413 : 400, 'validation_failed', declared);

    const begun = await deps.rpc(token, 'document_upload_begin', {
        p_doc_type: docType, p_mime: mime, p_size: size, p_name: cleanName(req.headers.get('x-document-name')), p_idempotency_key: key,
    });
    if (begun.error) return dbFail(begun.error);
    const version = begun.data?.version;
    const upload = begun.data?.upload;
    if (!version?.id || !upload?.path || upload.bucket !== BUCKET) return fail(502, 'server_error');
    // إعادة إرسال لإصدار اكتمل رفعه: التأكيد بلا أثر يرجع حالته
    if (version.status !== 'uploading') {
        const done = await deps.commit(version.id, user.id, null);
        return done.error ? dbFail(done.error) : json(200, done.data);
    }

    const bytes = await readCapped(req.body, Math.min(size, upload.max_bytes));
    if (!bytes) return fail(413, 'validation_failed', { field: 'size', reason: 'too_large' });
    if (bytes.byteLength !== size) return fail(400, 'validation_failed', { field: 'size', reason: 'size_mismatch' });
    if (!signatureMatches(mime, bytes.subarray(0, 16))) return fail(415, 'validation_failed', { field: 'file', reason: 'signature_mismatch' });
    let sha = await deps.sha256(bytes);

    const put = await deps.upload(upload.path, bytes, mime);
    const exists = put.error && (put.error.statusCode === '409' || put.error.statusCode === 409 || /exists/i.test(put.error.message || ''));
    if (put.error && !exists) return fail(502, 'upload_failed');
    // الكائن موجود من محاولة سابقة بنفس المفتاح (تكرار أو انقطاع قبل التأكيد): البصمة من البايتات المخزَّنة
    // فعلًا لا من هذا الطلب، فلا تُسجَّل بصمة لا تطابق الملف.
    if (exists) {
        const stored = await deps.download(upload.path).catch(() => null);
        if (!stored) return fail(502, 'upload_failed');
        sha = await deps.sha256(stored);
    }

    const done = await deps.commit(version.id, user.id, sha);
    if (done.error) {
        if (!exists) await deps.remove(upload.path).catch(() => null);
        return dbFail(done.error);
    }
    return json(200, done.data);
}
