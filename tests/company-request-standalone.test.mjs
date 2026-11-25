/**
 * المدخل المستقل لطلب حساب شركة (138) — منطق خالص + الدالتان الطرفيتان.
 *
 * ما لا يراه الخادم هنا:
 *   • قواعد الإثبات المشروط في الواجهة (النموذج الخالص) — والقرار النهائي
 *     في القاعدة (tests/sql/company-account-request-standalone.test.sql).
 *   • وضع «إثبات الطلب» في company-document-upload (X-Proof-Token) ووضع
 *     request_id في company-document-download — ببدائل محقونة، على نمط
 *     tests/company-documents-functions.test.mjs. وضع مستندات الشركات
 *     (100) نفسه لم يُلمس، واختباراته القائمة تغطيه.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
    APPLICANT_TYPE_LABELS,
    proofRequirementFor,
    applicantTypeLabel,
    validApplicantWebsiteUrl,
    validateProofFile,
    validateStandaloneRequest,
    proofFieldsFor,
    formatProofSize,
    PROOF_MAX_BYTES
} from '../assets/js/company/company-request-model.js';
import { handleUpload } from '../supabase/functions/company-document-upload/handler.js';
import { handleDownload } from '../supabase/functions/company-document-download/handler.js';
import { MAX_BYTES } from '../supabase/functions/_shared/company-documents.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const TOKEN = '3f2b7c1e-1111-4222-8333-444455556666';
const KEY = '9a8b7c6d-1111-4222-8333-444455556666';
const REQ = '11111111-2222-4333-8444-555555555555';
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 10, 1, 2, 3]);

const base = {
    companyName: 'شركة الاختبار', crNumber: 'CR-138-1', crExpiry: '2030-01-01',
    companyEmail: '', companyPhone: ''
};
const pdfFile = { type: 'application/pdf', size: 1024, name: 'سجل.pdf' };

/* ── نوع المتقدم والإثبات المشروط ─────────────────────────────────────────── */

test('الإثبات المشروط: شركة ⇒ مستند، متجر/منصة ⇒ رابط، أخرى ⇒ لا شيء', () => {
    assert.equal(proofRequirementFor('company'), 'document');
    assert.equal(proofRequirementFor('store'), 'url');
    assert.equal(proofRequirementFor('platform'), 'url');
    assert.equal(proofRequirementFor('other'), 'none');
    assert.equal(proofRequirementFor('???'), null);
    assert.equal(applicantTypeLabel('store'), 'متجر إلكتروني');
    assert.equal(applicantTypeLabel('platform'), 'منصة');
    assert.equal(applicantTypeLabel('other'), 'أخرى');
    assert.equal(applicantTypeLabel('???'), 'غير محدد');
    assert.deepEqual(proofFieldsFor('company'), { showDocument: true, showUrl: false, requirement: 'document' });
    assert.deepEqual(proofFieldsFor('store'), { showDocument: false, showUrl: true, requirement: 'url' });
    assert.deepEqual(proofFieldsFor('other'), { showDocument: false, showUrl: false, requirement: 'none' });
    assert.deepEqual(Object.keys(APPLICANT_TYPE_LABELS).sort(), ['company', 'other', 'platform', 'store']);
});

test('الرابط: https صالح، بلا مخطط يُكمَّل، وغير الصالح مرفوض', () => {
    assert.deepEqual(validApplicantWebsiteUrl('https://my-store.com'), { ok: true, value: 'https://my-store.com/', error: null });
    assert.equal(validApplicantWebsiteUrl('my-store.com').value, 'https://my-store.com/');
    assert.equal(validApplicantWebsiteUrl('http://shop.example.com:8080/path?a=1').ok, true);
    assert.equal(validApplicantWebsiteUrl('').ok, false);
    assert.equal(validApplicantWebsiteUrl('ftp://example.com').ok, false);
    assert.equal(validApplicantWebsiteUrl('not a url').ok, false);
    assert.equal(validApplicantWebsiteUrl('https://').ok, false);
    assert.equal(validApplicantWebsiteUrl('https://exa mple.com').ok, false);
    assert.equal(validApplicantWebsiteUrl('x'.repeat(2049)).ok, false);
});

test('ملف الإثبات: الأنواع الثلاثة فقط و≤ 10MB', () => {
    assert.equal(validateProofFile(pdfFile), null);
    assert.equal(validateProofFile({ type: 'image/png', size: 10 }), null);
    assert.equal(validateProofFile({ type: 'image/jpeg', size: 10 }), null);
    assert.equal(validateProofFile({ type: 'application/zip', size: 10 }), 'النوع المسموح: PDF أو PNG أو JPEG');
    assert.equal(validateProofFile({ type: 'application/pdf', size: 0 }), 'الملف فارغ');
    assert.equal(validateProofFile({ type: 'application/pdf', size: PROOF_MAX_BYTES + 1 }), 'الحد الأقصى 10 ميجابايت');
    assert.equal(validateProofFile(null), 'اختر ملفًا');
    assert.equal(PROOF_MAX_BYTES, 10 * 1024 * 1024);
});

test('تحقق النموذج: مصفوفة الأنواع الأربعة', () => {
    // شركة بلا مستند مرفوضة، وبملف صالح أو برفع مكتمل مقبولة
    assert.equal(validateStandaloneRequest({ ...base, applicantType: 'company' }).isValid, false);
    assert.equal(validateStandaloneRequest({ ...base, applicantType: 'company' }).errors.proofFile, 'مستند الإثبات مطلوب — ارفع مستندًا يثبت أنها شركة');
    assert.equal(validateStandaloneRequest({ ...base, applicantType: 'company', proofFile: pdfFile }).isValid, true);
    assert.equal(validateStandaloneRequest({ ...base, applicantType: 'company', proofUploaded: true }).isValid, true);
    assert.equal(validateStandaloneRequest({ ...base, applicantType: 'company', proofFile: { type: 'application/zip', size: 10 } }).errors.proofFile, 'النوع المسموح: PDF أو PNG أو JPEG');
    // شركة + رابط مرفوضة (المستند بدل الرابط، لا معه)
    assert.match(validateStandaloneRequest({ ...base, applicantType: 'company', proofUploaded: true, websiteUrl: 'https://x.com' }).errors.websiteUrl, /لا برابط/);
    // متجر/منصة بلا رابط مرفوضة، وبرابط صالح مقبولة، وبملف مرفوضة
    assert.equal(validateStandaloneRequest({ ...base, applicantType: 'store' }).errors.websiteUrl, 'رابط الموقع أو المتجر مطلوب');
    assert.equal(validateStandaloneRequest({ ...base, applicantType: 'store', websiteUrl: 'my-store.com' }).isValid, true);
    assert.equal(validateStandaloneRequest({ ...base, applicantType: 'platform', websiteUrl: 'https://bad url' }).isValid, false);
    assert.match(validateStandaloneRequest({ ...base, applicantType: 'store', websiteUrl: 'https://s.com', proofFile: pdfFile }).errors.proofFile, /لا بمستند/);
    // أخرى بلا شيء مقبولة، وبأي إثبات مرفوضة
    assert.equal(validateStandaloneRequest({ ...base, applicantType: 'other' }).isValid, true);
    assert.equal(validateStandaloneRequest({ ...base, applicantType: 'other', websiteUrl: 'https://x.com' }).isValid, false);
    assert.equal(validateStandaloneRequest({ ...base, applicantType: 'other', proofFile: pdfFile }).isValid, false);
    // نوع مجهول + الحقول القانونية نفسها ما زالت تُفحص
    assert.equal(validateStandaloneRequest({ ...base, applicantType: '???' }).errors.applicantType, 'اختر نوع المتقدم');
    assert.equal(validateStandaloneRequest({ ...base, companyName: 'ش', applicantType: 'other' }).errors.companyName, 'اسم الشركة مطلوب');
    assert.equal(validateStandaloneRequest({ ...base, crNumber: 'C', applicantType: 'other' }).errors.crNumber, 'رقم السجل التجاري مطلوب');
    assert.equal(validateStandaloneRequest({ ...base, crExpiry: '', applicantType: 'other' }).errors.crExpiry, 'تاريخ انتهاء السجل التجاري مطلوب');
    assert.equal(validateStandaloneRequest({ ...base, companyEmail: 'ليس بريدًا', applicantType: 'other' }).errors.companyEmail, 'بريد إلكتروني غير صالح');
});

test('حجم الإثبات للعرض في قائمة المراجعة', () => {
    assert.equal(formatProofSize(500), '500 بايت');
    assert.equal(formatProofSize(2048), '2.0 ك.ب');
    assert.equal(formatProofSize(2.5 * 1024 * 1024), '2.5 م.ب');
    assert.equal(formatProofSize(null), '—');
    assert.equal(formatProofSize(0), '—');
});

/* ── وضع إثبات الطلب في company-document-upload ─────────────────────────── */

function proofReq(bytes, { token = TOKEN, key = KEY, mime = 'application/pdf', docType, length } = {}) {
    const headers = {
        Authorization: 'Bearer jwt', 'Content-Type': mime,
        'Content-Length': String(length ?? bytes.length),
        'X-Proof-Token': token, 'X-Idempotency-Key': key,
        'X-Document-Name': encodeURIComponent('سجل.pdf')
    };
    if (docType !== undefined) headers['X-Document-Type'] = docType;
    return new Request('https://x/functions/v1/company-document-upload', {
        method: 'POST', body: bytes, duplex: 'half', headers
    });
}

function proofDeps(over = {}) {
    const log = { rpc: [], upload: [], commitRequest: [], commit: [] };
    return {
        log,
        getUser: async () => ({ id: 'u1' }),
        rpc: async (token, fn, args) => {
            log.rpc.push([fn, args]);
            if (over[fn]) return over[fn](args);
            if (fn === 'company_account_request_proof_begin') {
                return { data: { proof_token: TOKEN, status: 'uploading',
                    upload: { bucket: 'company-documents', path: `request-proofs/u1/${TOKEN}.pdf`, max_bytes: MAX_BYTES } } };
            }
            if (fn === 'document_upload_begin') {
                return { data: { version: { id: KEY, status: 'uploading' },
                    upload: { bucket: 'company-documents', path: `c/d/${KEY}.pdf`, max_bytes: MAX_BYTES } } };
            }
            return { data: {} };
        },
        commit: async (version, actor, sha) => { log.commit.push([version, actor, sha]); return { data: { version_id: version, status: 'pending_scan' } }; },
        commitRequest: async (proofToken, actor, sha) => {
            log.commitRequest.push([proofToken, actor, sha]);
            return over.commitRequest ? over.commitRequest() : { data: { proof_token: proofToken, status: 'uploaded', sha256: sha } };
        },
        download: async () => over.stored === undefined ? null : over.stored,
        upload: async (path, bytes, type) => { log.upload.push([path, bytes.length, type]); return over.uploadError ? { error: over.uploadError } : {}; },
        remove: async (path) => { log.remove.push(path); return {}; },
        sha256: async (b) => crypto.createHash('sha256').update(b).digest('hex')
    };
}

test('الرفع بوضع إثبات الطلب: begin برمز الطلب + تأكيد برمز الطلب، لا بنوع مستند', async () => {
    const deps = proofDeps();
    const res = await handleUpload(proofReq(PDF), deps);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.proof_token, TOKEN);
    assert.equal(body.status, 'uploaded');
    assert.deepEqual(deps.log.rpc[0][0], 'company_account_request_proof_begin');
    assert.equal(deps.log.rpc[0][1].p_proof_token, TOKEN);
    assert.equal(deps.log.rpc[0][1].p_mime, 'application/pdf');
    assert.equal(deps.log.upload[0][0], `request-proofs/u1/${TOKEN}.pdf`);
    assert.deepEqual(deps.log.commitRequest[0].slice(0, 2), [TOKEN, 'u1']);
    assert.equal(deps.log.commit.length, 0, 'وضع الشركة (document_upload_begin) لم يُنادَ');
    assert.match(deps.log.commitRequest[0][2], /^[0-9a-f]{64}$/);
});

test('الرفع بوضع إثبات الطلب: رمز غير UUID ونوع مستند مخالف مرفوضان قبل أي نداء', async () => {
    const deps = proofDeps();
    let res = await handleUpload(proofReq(PDF, { token: 'not-a-uuid' }), deps);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.field, 'proof_token');
    res = await handleUpload(proofReq(PDF, { docType: 'tax_card' }), deps);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.field, 'doc_type');
    assert.equal(deps.log.rpc.length, 0);
});

test('الرفع بوضع إثبات الطلب: إعادة إرسال لرفع مكتمل تعيد حالته بلا قراءة بايتات', async () => {
    const deps = proofDeps({
        'company_account_request_proof_begin': () => ({ data: { proof_token: TOKEN, status: 'uploaded',
            upload: { bucket: 'company-documents', path: `request-proofs/u1/${TOKEN}.pdf`, max_bytes: MAX_BYTES } } })
    });
    const res = await handleUpload(proofReq(PDF), deps);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, 'uploaded');
    assert.deepEqual(deps.log.commitRequest[0], [TOKEN, 'u1', null]);
    assert.equal(deps.log.upload.length, 0);
});

test('الرفع بوضع الشركة لم يتغير: بلا X-Proof-Token ينادي document_upload_begin', async () => {
    const deps = proofDeps();
    const req = new Request('https://x/functions/v1/company-document-upload', {
        method: 'POST', body: PDF, duplex: 'half',
        headers: { Authorization: 'Bearer jwt', 'Content-Type': 'application/pdf',
                   'Content-Length': String(PDF.length), 'X-Document-Type': 'tax_card',
                   'X-Idempotency-Key': KEY, 'X-Document-Name': encodeURIComponent('بطاقة.pdf') }
    });
    const res = await handleUpload(req, deps);
    assert.equal(res.status, 200);
    assert.equal(deps.log.rpc[0][0], 'document_upload_begin');
    assert.equal(deps.log.commitRequest.length, 0);
    assert.equal(deps.log.commit.length, 1);
});

/* ── وضع request_id في company-document-download ────────────────────────── */

function downloadReq(body) {
    return new Request('https://x/functions/v1/company-document-download', {
        method: 'POST', body: JSON.stringify(body),
        headers: { Authorization: 'Bearer jwt', 'Content-Type': 'application/json' }
    });
}

function downloadDeps(over = {}) {
    const log = { rpc: [] };
    return {
        log,
        getUser: async () => ({ id: 'admin1' }),
        rpc: async (token, fn, args) => {
            log.rpc.push([fn, args]);
            if (over[fn]) return over[fn](args);
            if (fn === 'admin_company_account_request_proof_download') {
                return { data: { bucket: 'company-documents', path: `request-proofs/u1/${TOKEN}.pdf`, file_name: 'سجل.pdf' } };
            }
            return { data: { bucket: 'company-documents', path: 'c/d/x.pdf', file_name: 'x.pdf' } };
        },
        sign: async (path, seconds, fileName) => {
            if (over.signError) return { error: over.signError };
            return { signedUrl: `https://signed.example/${encodeURIComponent(path)}?name=${encodeURIComponent(fileName || '')}` };
        }
    };
}

test('التنزيل بوضع request_id: تفويض الإدارة ثم رابط موقَّع للمسار المعاد وحده', async () => {
    const deps = downloadDeps();
    const res = await handleDownload(downloadReq({ request_id: REQ }), deps);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.match(body.url, /^https:\/\/signed\.example\/request-proofs/);
    assert.equal(body.expires_in, 60);
    assert.deepEqual(deps.log.rpc[0], ['admin_company_account_request_proof_download', { p_request_id: REQ }]);
});

test('التنزيل: request_id مع version_id معًا، وrequest_id غير UUID، مرفوضان', async () => {
    const deps = downloadDeps();
    let res = await handleDownload(downloadReq({ request_id: REQ, version_id: REQ }), deps);
    assert.equal(res.status, 400);
    res = await handleDownload(downloadReq({ request_id: 'bad' }), deps);
    assert.equal(res.status, 400);
    assert.equal(deps.log.rpc.length, 0);
});

test('التنزيل: رفض القاعدة (غير إدارة) يمر كما هو، ووضع version_id لم يتغير', async () => {
    const deps = downloadDeps({
        'admin_company_account_request_proof_download': () => ({ error: { code: '42501', message: 'هذه العملية متاحة للإدارة فقط' } })
    });
    const res = await handleDownload(downloadReq({ request_id: REQ }), deps);
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, 'forbidden');

    const deps2 = downloadDeps();
    const res2 = await handleDownload(downloadReq({ version_id: REQ }), deps2);
    assert.equal(res2.status, 200);
    assert.deepEqual(deps2.log.rpc[0][0], 'document_download_authorize');
});

/* ── نقاط الدخول والمراجعة موجودة في الملفات (بلا متصفح) ─────────────────── */

test('نقاط الدخول: login و index ولوحة الشركة وصفحة المراجعة', () => {
    const login = fs.readFileSync(path.join(ROOT, 'login.html'), 'utf8');
    assert.match(login, /data-standalone-company-request/);
    assert.match(login, /company-request-standalone\.js/);
    assert.match(login, /initStandaloneCompanyRequestEntry\(\)/);
    assert.match(login, /#register/);

    const index = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    assert.match(index, /login\.html\?company_request=1/);
    assert.match(index, /اطلب إنشاء حساب شركة/);

    const dashboard = fs.readFileSync(path.join(ROOT, 'assets/js/company/company-dashboard.js'), 'utf8');
    assert.match(dashboard, /data-standalone-company-request/);
    assert.match(dashboard, /initStandaloneCompanyRequestEntry/);

    const standalone = fs.readFileSync(path.join(ROOT, 'assets/js/company/company-request-standalone.js'), 'utf8');
    assert.match(standalone, /openStandaloneCompanyRequestModal/);
    assert.match(standalone, /submitStandaloneCompanyAccountRequest/);
    assert.match(standalone, /uploadStandaloneProof/);

    const adminHtml = fs.readFileSync(path.join(ROOT, 'admin/company-requests.html'), 'utf8');
    assert.match(adminHtml, /id="crApplicantType"/);
    assert.match(adminHtml, /id="crWebsiteRow"/);
    assert.match(adminHtml, /id="crProofRow"/);
    assert.match(adminHtml, /id="crProofDownload"/);
    assert.match(adminHtml, /نوع المتقدم/);
    assert.match(adminHtml, /colspan="7"/);

    const adminJs = fs.readFileSync(path.join(ROOT, 'assets/js/admin/company-requests.js'), 'utf8');
    assert.match(adminJs, /fetchStandaloneProofUrl/);
    assert.match(adminJs, /APPLICANT_TYPE_LABELS/);

    const migration = fs.readFileSync(path.join(ROOT, 'migrations/138_standalone_company_account_request.sql'), 'utf8');
    assert.match(migration, /submit_standalone_company_account_request/);
    assert.match(migration, /company_account_request_proof_begin/);
    assert.match(migration, /company_account_request_proof_commit_server/);
    assert.match(migration, /admin_company_account_request_proof_download/);
    assert.match(migration, /company_account_requests_standalone_proof_check/);
    assert.ok(fs.existsSync(path.join(ROOT, 'migrations/_rollback/138_standalone_company_account_request.down.sql')));
});
