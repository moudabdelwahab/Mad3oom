/**
 * company-documents.js — قواعد ملفات مستندات الشركات (100) المشتركة بين الدوال الطرفية.
 * خالصة بلا Deno: مختبرة في tests/company-documents-functions.test.mjs.
 *
 * القاعدة تتحقق مرة أخرى من النوع والحجم (document_upload_begin) ومن الملف المخزَّن (commit).
 * هنا ما لا تراه القاعدة: البايتات نفسها (التوقيع) والحجم الفعلي للجسم.
 */
export const BUCKET = 'company-documents';
export const MAX_BYTES = 10 * 1024 * 1024;
export const ALLOWED_MIME = Object.freeze(['application/pdf', 'image/png', 'image/jpeg']);
export const SIGNED_URL_SECONDS = 60;

export function baseMime(raw) {
    return String(raw || '').split(';')[0].trim().toLowerCase();
}

/** فحص المعلَن قبل قراءة أي بايت. ⇒ null أو { field, reason }. */
export function checkDeclared({ mime, size }) {
    if (!ALLOWED_MIME.includes(mime)) return { field: 'mime', reason: 'not_allowed' };
    if (!Number.isSafeInteger(size) || size < 1) return { field: 'size', reason: 'invalid' };
    if (size > MAX_BYTES) return { field: 'size', reason: 'too_large' };
    return null;
}

/** التوقيع (magic bytes) يطابق النوع المعلن؟ ملف PDF باسم صورة أو العكس مرفوض. */
export function signatureMatches(mime, head) {
    const b = head instanceof Uint8Array ? head : new Uint8Array(head || []);
    const starts = (...sig) => sig.every((x, i) => b[i] === x);
    switch (mime) {
        case 'application/pdf': return starts(0x25, 0x50, 0x44, 0x46, 0x2d);                    // %PDF-
        case 'image/png': return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
        case 'image/jpeg': return starts(0xff, 0xd8, 0xff);
        default: return false;
    }
}

/** اسم العرض: نص قصير بلا مسارات ولا محارف تحكم (المسار نفسه يولّده الخادم). */
export function cleanName(raw) {
    let name = '';
    try { name = decodeURIComponent(String(raw || '')); } catch { return null; }
    name = name.replace(/[\u0000-\u001f\u007f/\\]/g, '').trim().slice(0, 200);
    return name || null;
}

/* ── توقيع نتيجة الفحص (HMAC-SHA256 على `${timestamp}.${body}`) ───────────────────── */

export const SCAN_MAX_SKEW_SECONDS = 300;

export function hex(bytes) {
    return [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join('');
}

/** مقارنة بزمن ثابت لسلسلتين hex. */
export function safeEqualHex(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || !/^[0-9a-f]+$/.test(a)) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

/**
 * يتحقق من رأسَي التوقيع والطابع الزمني. hmac(secret, message) ⇒ hex (يُحقن: Web Crypto في Deno، crypto في Node).
 * ⇒ { ok: true, nonce } أو { ok: false, status, code }. nonce = التوقيع المتحقَّق منه (hex): القاعدة تقبله مرة واحدة
 * (104 L5)، فإعادة إرسال الطلب الموقَّع نفسه خلال نافذة الدقائق الخمس تُرفض.
 */
export async function verifyScanSignature({ secret, signature, timestamp, body, now, hmac }) {
    if (!secret || secret.length < 32) return { ok: false, status: 503, code: 'scanner_not_configured' };
    const ts = Number(timestamp);
    if (!Number.isSafeInteger(ts)) return { ok: false, status: 401, code: 'bad_signature' };
    if (Math.abs(Math.floor(now / 1000) - ts) > SCAN_MAX_SKEW_SECONDS) return { ok: false, status: 401, code: 'stale_signature' };
    const given = String(signature || '').replace(/^sha256=/, '').toLowerCase();
    const expected = await hmac(secret, `${ts}.${body}`);
    return safeEqualHex(given, expected) ? { ok: true, nonce: expected } : { ok: false, status: 401, code: 'bad_signature' };
}

/** جسم نتيجة الفحص. ⇒ { version_id, result, engine, detail } أو null. */
export function parseScanBody(text) {
    let b;
    try { b = JSON.parse(text); } catch { return null; }
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!b || !UUID.test(b.version_id || '') || !['clean', 'infected', 'error'].includes(b.result)) return null;
    const engine = String(b.engine || '').slice(0, 100);
    if (engine.length < 2) return null;
    const detail = b.detail && typeof b.detail === 'object' && !Array.isArray(b.detail) ? b.detail : {};
    return { version_id: b.version_id, result: b.result, engine, detail };
}

/** ردّ clamd على INSTREAM: «stream: OK» أو «stream: <name> FOUND» أو خطأ. */
export function parseClamdReply(line) {
    const text = String(line || '').replace(/\0/g, '').trim();
    if (/^stream: OK$/.test(text)) return { result: 'clean' };
    const found = text.match(/^stream: (.+) FOUND$/);
    if (found) return { result: 'infected', signature: found[1].slice(0, 200) };
    return { result: 'error', message: text.slice(0, 200) };
}
