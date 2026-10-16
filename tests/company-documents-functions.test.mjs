/**
 * دوال مستندات الشركات الطرفية (100) وعامل الفحص المرجعي — منطق خالص ببدائل.
 * القرار نفسه في القاعدة (tests/sql/company-documents.test.sql). هنا ما لا تراه القاعدة:
 * البايتات والتوقيع والحجم الفعلي، توقيع نتيجة الفحص، والرابط القصير.
 * 104: التأكيد بمفتاح الخدمة والبصمة من الخادم (L3)، حد الرفع 429 (L6)، nonce نتيجة الفحص (L5)،
 *      وتحقق الخطوتين لتنزيل المالك (L1).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { checkDeclared, signatureMatches, cleanName, verifyScanSignature, parseScanBody, parseClamdReply, MAX_BYTES }
    from '../supabase/functions/_shared/company-documents.js';
import { handleUpload } from '../supabase/functions/company-document-upload/handler.js';
import { handleDownload } from '../supabase/functions/company-document-download/handler.js';
import { handleScanCallback } from '../supabase/functions/document-scan-callback/handler.js';
import { instreamFrames, signBody } from '../tools/document-scanner/worker.mjs';

const KEY = '3f2b7c1e-1111-4222-8333-444455556666';
const VER = '9a8b7c6d-1111-4222-8333-444455556666';
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 10, 1, 2, 3]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const hmac = async (secret, msg) => crypto.createHmac('sha256', secret).update(msg).digest('hex');
const SECRET = 's'.repeat(40);

function uploadReq(bytes, { mime = 'application/pdf', type = 'tax_card', key = KEY, token = 'jwt', length } = {}) {
    return new Request('https://x/functions/v1/company-document-upload', {
        method: 'POST', body: bytes, duplex: 'half',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': mime, 'Content-Length': String(length ?? bytes.length),
                   'X-Document-Type': type, 'X-Idempotency-Key': key, 'X-Document-Name': encodeURIComponent('بطاقة/ضريبية.pdf') },
    });
}
function uploadDeps(over = {}) {
    const log = { rpc: [], upload: [], remove: [], commit: [] };
    return {
        log,
        getUser: async () => ({ id: 'u1' }),
        rpc: async (token, fn, args) => {
            log.rpc.push([fn, args]);
            if (over[fn]) return over[fn](args);
            if (fn === 'document_upload_begin') return { data: { version: { id: VER, status: 'uploading' },
                upload: { bucket: 'company-documents', path: `c/d/${VER}.pdf`, max_bytes: MAX_BYTES } } };
            return { data: { version_id: VER, status: 'pending_scan' } };
        },
        commit: async (version, actor, sha) => {
            log.commit.push([version, actor, sha]);
            return over.commit ? over.commit() : { data: { version_id: VER, status: 'pending_scan' } };
        },
        download: async () => over.stored === undefined ? null : over.stored,
        upload: async (path, bytes, type) => { log.upload.push([path, bytes.length, type]); return over.uploadError ? { error: over.uploadError } : {}; },
        remove: async (path) => { log.remove.push(path); return {}; },
        sha256: async (b) => crypto.createHash('sha256').update(b).digest('hex'),
    };
}

test('المعلَن: الأنواع الثلاثة فقط و≤ 10MB', () => {
    assert.equal(checkDeclared({ mime: 'application/pdf', size: 1 }), null);
    assert.deepEqual(checkDeclared({ mime: 'application/zip', size: 1 }), { field: 'mime', reason: 'not_allowed' });
    assert.deepEqual(checkDeclared({ mime: 'image/png', size: MAX_BYTES + 1 }), { field: 'size', reason: 'too_large' });
    assert.deepEqual(checkDeclared({ mime: 'image/png', size: 0 }), { field: 'size', reason: 'invalid' });
});

test('التوقيع يطابق النوع، والاسم بلا مسارات', () => {
    assert.equal(signatureMatches('application/pdf', PDF), true);
    assert.equal(signatureMatches('image/png', PDF), false, 'PDF باسم صورة');
    assert.equal(signatureMatches('image/jpeg', new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), true);
    assert.equal(signatureMatches('image/png', PNG), true);
    assert.equal(cleanName(encodeURIComponent('../../etc/passwd')), '....etcpasswd');
    assert.equal(cleanName('%E0%A4%A'), null);
});

test('الرفع: بايتات صحيحة ⇒ begin ثم رفع للمسار المولَّد ثم تأكيد بمفتاح الخدمة والبصمة المحسوبة هنا (104 L3)', async () => {
    const deps = uploadDeps();
    const res = await handleUpload(uploadReq(PDF), deps);
    assert.equal(res.status, 200);
    assert.deepEqual(deps.log.rpc.map(([fn]) => fn), ['document_upload_begin'], 'لا تأكيد بهوية المستخدم');
    assert.equal(deps.log.rpc[0][1].p_name, 'بطاقةضريبية.pdf');
    assert.deepEqual(deps.log.upload, [[`c/d/${VER}.pdf`, PDF.length, 'application/pdf']]);
    assert.deepEqual(deps.log.commit, [[VER, 'u1', crypto.createHash('sha256').update(PDF).digest('hex')]]);
});

test('الرفع: إعادة إرسال لإصدار مؤكَّد ⇒ حالته بلا رفع ولا بصمة من المنادي', async () => {
    const deps = uploadDeps({ document_upload_begin: () => ({ data: { version: { id: VER, status: 'pending_scan' },
        upload: { bucket: 'company-documents', path: `c/d/${VER}.pdf`, max_bytes: MAX_BYTES } } }) });
    const res = await handleUpload(uploadReq(PDF), deps);
    assert.equal(res.status, 200);
    assert.deepEqual(deps.log.commit, [[VER, 'u1', null]]);
    assert.equal(deps.log.upload.length, 0);
});

test('الرفع: الكائن موجود من محاولة سابقة ⇒ البصمة من البايتات المخزَّنة لا من هذا الطلب', async () => {
    const STORED = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x39, 9, 9, 9, 9, 9, 9]);
    let deps = uploadDeps({ uploadError: { statusCode: '409', message: 'The resource already exists' }, stored: STORED });
    let res = await handleUpload(uploadReq(PDF), deps);
    assert.equal(res.status, 200);
    assert.deepEqual(deps.log.commit, [[VER, 'u1', crypto.createHash('sha256').update(STORED).digest('hex')]]);
    assert.equal(deps.log.remove.length, 0, 'لا يُحذف ملف لم يرفعه هذا الطلب');
    deps = uploadDeps({ uploadError: { statusCode: '409', message: 'exists' } });
    res = await handleUpload(uploadReq(PDF), deps);
    assert.equal(res.status, 502);
    assert.equal(deps.log.commit.length, 0, 'لا تأكيد بلا بصمة الملف المخزَّن');
});

test('الرفع: حد الرفع من القاعدة (54000) ⇒ 429 rate_limited بلا رفع (104 L6)', async () => {
    const deps = uploadDeps({ document_upload_begin: () => ({ error: { code: '54000', details: '{"code":"rate_limited","reason":"hourly_limit"}' } }) });
    const res = await handleUpload(uploadReq(PDF), deps);
    assert.equal(res.status, 429);
    assert.deepEqual((await res.json()).error, { code: 'rate_limited', reason: 'hourly_limit' });
    assert.equal(deps.log.upload.length, 0);
});

test('الرفع: توقيع مخالف أو حجم مخالف ⇒ رفض بلا رفع', async () => {
    let deps = uploadDeps();
    let res = await handleUpload(uploadReq(PDF, { mime: 'image/png' }), deps);
    assert.equal(res.status, 415);
    assert.equal(deps.log.upload.length, 0);
    deps = uploadDeps();
    res = await handleUpload(uploadReq(PDF, { length: PDF.length + 5 }), deps);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.reason, 'size_mismatch');
    assert.equal(deps.log.upload.length, 0);
    deps = uploadDeps();
    res = await handleUpload(uploadReq(PDF, { mime: 'application/x-msdownload' }), deps);
    assert.equal(res.status, 400);
    assert.equal(deps.log.rpc.length, 0, 'لا نداء للقاعدة قبل فحص المعلَن');
});

test('الرفع: رفض القاعدة يُترجم، وفشل التأكيد يحذف الملف المرفوع', async () => {
    let deps = uploadDeps({ document_upload_begin: () => ({ error: { code: '0A000', details: '{"code":"feature_not_enabled"}' } }) });
    let res = await handleUpload(uploadReq(PDF), deps);
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, 'feature_not_enabled');
    deps = uploadDeps({ commit: () => ({ error: { code: '22023', details: '{"field":"size","reason":"size_mismatch"}' } }) });
    res = await handleUpload(uploadReq(PDF), deps);
    assert.equal(res.status, 400);
    assert.deepEqual(deps.log.remove, [`c/d/${VER}.pdf`]);
    res = await handleUpload(uploadReq(PDF, { token: '' }), uploadDeps());
    assert.equal(res.status, 401);
});

test('التنزيل: رابط 60 ثانية بعد قرار القاعدة؛ المعزول 409؛ بلا رمز 401', async () => {
    const signed = [];
    const deps = {
        getUser: async () => ({ id: 'u1' }),
        rpc: async (t, fn, args) => args.p_version === VER
            ? { data: { bucket: 'company-documents', path: 'c/d/v.pdf', expires_in: 60, file_name: 'x.pdf' } }
            : { error: { code: '55000', details: '{"reason":"pending_scan"}' } },
        sign: async (path, seconds) => { signed.push([path, seconds]); return { signedUrl: 'https://signed/x' }; },
    };
    const req = (id, token = 'jwt') => new Request('https://x', { method: 'POST', body: JSON.stringify({ version_id: id }),
                                                                 headers: { Authorization: `Bearer ${token}` } });
    let res = await handleDownload(req(VER), deps);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { url: 'https://signed/x', expires_in: 60 });
    assert.deepEqual(signed, [['c/d/v.pdf', 60]]);
    res = await handleDownload(req(KEY), deps);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.reason, 'pending_scan');
    assert.equal(signed.length, 1, 'لا رابط لملف معزول');
    res = await handleDownload(req(VER, ''), deps);
    assert.equal(res.status, 401);
});

test('التنزيل: مالك المنصة بلا تحقق خطوتين حديث ⇒ 403 step_up_required بلا رابط (104 L1)', async () => {
    const signed = [];
    const deps = {
        getUser: async () => ({ id: 'owner' }),
        rpc: async () => ({ error: { code: '42501', details: '{"code":"step_up_required"}' } }),
        sign: async (path, seconds) => { signed.push([path, seconds]); return { signedUrl: 'https://signed/x' }; },
    };
    const res = await handleDownload(new Request('https://x', { method: 'POST', body: JSON.stringify({ version_id: VER }),
                                                                headers: { Authorization: 'Bearer jwt' } }), deps);
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, 'step_up_required');
    assert.equal(signed.length, 0);
});

test('نتيجة الفحص: بلا سر 503 (الملفات تبقى معزولة)، توقيع خاطئ أو قديم 401، الصحيح يُسجَّل', async () => {
    const calls = [];
    const now = 1_800_000_000_000;
    const deps = (secret) => ({ secret, now: () => now, hmac, scanResult: async (a) => { calls.push(a); return { data: { status: 'clean' } }; } });
    const body = JSON.stringify({ version_id: VER, result: 'clean', engine: 'clamav' });
    const ts = Math.floor(now / 1000);
    const good = signBody(SECRET, body, ts);
    const req = (headers) => new Request('https://x', { method: 'POST', body, headers });

    assert.equal((await handleScanCallback(req(good), deps(''))).status, 503);
    assert.equal((await handleScanCallback(req({ ...good, 'X-Scan-Signature': 'sha256=' + '0'.repeat(64) }), deps(SECRET))).status, 401);
    assert.equal((await handleScanCallback(req(signBody(SECRET, body, ts - 3600)), deps(SECRET))).status, 401);
    assert.equal(calls.length, 0);
    const res = await handleScanCallback(req(good), deps(SECRET));
    assert.equal(res.status, 200);
    const nonce = good['X-Scan-Signature'].replace('sha256=', '');
    assert.deepEqual(calls, [{ p_version: VER, p_result: 'clean', p_engine: 'clamav', p_detail: {}, p_nonce: nonce }],
                     'التوقيع المتحقَّق منه هو nonce (104 L5)');
    assert.equal(await verifyScanSignature({ secret: SECRET, signature: good['X-Scan-Signature'], timestamp: String(ts), body: body + ' ', now, hmac })
        .then(r => r.ok), false, 'جسم معدَّل');
});

test('نتيجة الفحص: إعادة إرسال الطلب الموقَّع نفسه ⇒ 409 replayed (القاعدة رفضت الـ nonce)', async () => {
    const now = 1_800_000_000_000;
    const body = JSON.stringify({ version_id: VER, result: 'error', engine: 'clamav' });
    const headers = signBody(SECRET, body, Math.floor(now / 1000));
    const seen = new Set();
    const deps = { secret: SECRET, now: () => now, hmac, scanResult: async (a) => {
        if (seen.has(a.p_nonce)) return { error: { code: '23505', details: '{"code":"replayed"}' } };
        seen.add(a.p_nonce);
        return { data: { status: 'scan_error' } };
    } };
    const req = () => new Request('https://x', { method: 'POST', body, headers });
    assert.equal((await handleScanCallback(req(), deps)).status, 200);
    const again = await handleScanCallback(req(), deps);
    assert.equal(again.status, 409);
    assert.equal((await again.json()).error.code, 'replayed');
});

test('عامل الفحص المرجعي: إطار INSTREAM وقراءة ردّ clamd', () => {
    const frames = instreamFrames(Buffer.from('abc'), 2);
    assert.equal(frames.subarray(0, 10).toString(), 'zINSTREAM\0');
    assert.deepEqual([...frames.subarray(10)], [0, 0, 0, 2, 97, 98, 0, 0, 0, 1, 99, 0, 0, 0, 0]);
    assert.deepEqual(parseClamdReply('stream: OK\0'), { result: 'clean' });
    assert.deepEqual(parseClamdReply('stream: Eicar-Test-Signature FOUND\0'), { result: 'infected', signature: 'Eicar-Test-Signature' });
    assert.equal(parseClamdReply('INSTREAM size limit exceeded. ERROR').result, 'error');
    assert.equal(parseScanBody('{"version_id":"x","result":"clean","engine":"c"}'), null);
    assert.equal(parseScanBody(JSON.stringify({ version_id: VER, result: 'maybe', engine: 'clamav' })), null);
});
