/**
 * company-document-download — رابط تنزيل قصير لإصدار مستند (migrations/100_company_documents.sql).
 *
 * POST { version_id } بـ Authorization: Bearer <JWT>.
 *   1. document_download_authorize بهوية المستخدم: مدير الشركة أو مالك المنصة أو المراجع المسند، للإصدار
 *      النظيف فقط (المعزول يُرفض بـ 409)، مع سطر في سجل المستند.
 *   2. رابط موقَّع 60 ثانية بمفتاح الخدمة للمسار الذي أعادته القاعدة فقط.
 */
import { BUCKET, SIGNED_URL_SECONDS } from '../_shared/company-documents.js';
import { CORS_HEADERS as UPLOAD_CORS, dbFail } from '../company-document-upload/handler.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CORS_HEADERS = { ...UPLOAD_CORS, 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (status, body) => new Response(JSON.stringify(body), {
    status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

/** deps: getUser(token) · rpc(token, fn, args) · sign(path, seconds) ⇒ { signedUrl } | { error } */
export async function handleDownload(req, deps) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (req.method !== 'POST') return json(405, { error: { code: 'method_not_allowed' } });
    const auth = req.headers.get('authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token) return json(401, { error: { code: 'unauthorized' } });
    const user = await deps.getUser(token).catch(() => null);
    if (!user?.id) return json(401, { error: { code: 'unauthorized' } });
    let body;
    try { body = await req.json(); } catch { body = null; }
    if (!UUID.test(body?.version_id || '')) return json(400, { error: { code: 'validation_failed', field: 'version_id' } });

    const auth2 = await deps.rpc(token, 'document_download_authorize', { p_version: body.version_id });
    if (auth2.error) return dbFail(auth2.error);
    const grant = auth2.data;
    if (grant?.bucket !== BUCKET || !grant?.path) return json(502, { error: { code: 'server_error' } });
    const signed = await deps.sign(grant.path, SIGNED_URL_SECONDS, grant.file_name);
    if (signed.error || !signed.signedUrl) return json(502, { error: { code: 'sign_failed' } });
    return json(200, { url: signed.signedUrl, expires_in: SIGNED_URL_SECONDS });
}
