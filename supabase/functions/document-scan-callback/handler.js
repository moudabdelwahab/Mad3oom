/**
 * document-scan-callback — نتيجة فحص الملف من عامل الفحص (ClamAV) — migrations/100_company_documents.sql.
 *
 * لا عامل فحص منشور اليوم. بلا السر DOCUMENT_SCAN_SECRET (≥ 32 حرفًا) ترد الدالة 503 دائمًا، فتبقى كل
 * الملفات pending_scan (معزولة). لا نتيجة تُقبل بلا توقيع صحيح وطابع زمني حديث (≤ 5 دقائق).
 *
 * POST والجسم JSON: { version_id, result: clean|infected|error, engine, detail? }
 *   X-Scan-Timestamp: ثوانٍ يونكس · X-Scan-Signature: sha256=<hex HMAC-SHA256(secret, `${ts}.${body}`)>
 */
import { verifyScanSignature, parseScanBody } from '../_shared/company-documents.js';

const json = (status, body) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

/** deps: secret · now() ⇒ ms · hmac(secret, message) ⇒ hex · scanResult(args) ⇒ { data, error } (مفتاح الخدمة) */
export async function handleScanCallback(req, deps) {
    if (req.method !== 'POST') return json(405, { error: { code: 'method_not_allowed' } });
    const body = await req.text();
    if (body.length > 16384) return json(413, { error: { code: 'too_large' } });
    const check = await verifyScanSignature({
        secret: deps.secret, signature: req.headers.get('x-scan-signature'), timestamp: req.headers.get('x-scan-timestamp'),
        body, now: deps.now(), hmac: deps.hmac,
    });
    if (!check.ok) return json(check.status, { error: { code: check.code } });
    const parsed = parseScanBody(body);
    if (!parsed) return json(400, { error: { code: 'validation_failed' } });
    const res = await deps.scanResult({ p_version: parsed.version_id, p_result: parsed.result, p_engine: parsed.engine, p_detail: parsed.detail });
    if (res.error) {
        const status = res.error.code === 'P0002' ? 404 : res.error.code === '55000' ? 409 : res.error.code === '22023' ? 400 : 502;
        return json(status, { error: { code: status === 404 ? 'not_found' : status === 409 ? 'invalid_state' : status === 400 ? 'validation_failed' : 'server_error' } });
    }
    return json(200, res.data);
}
