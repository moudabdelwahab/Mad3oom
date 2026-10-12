/**
 * Continuity — رفع مرفق (080). الوحيد في الواجهة الذي يرسل بيانات خارج supabase.rpc، ولذلك
 * في ملف مستقل: طلب واحد إلى دالة الرفع (continuity-attachment-upload) وجسمه الملف نفسه فقط.
 * لا نص رسائل ولا تخزين في المتصفح. tests/continuity-attachments.test.mjs يفرض ذلك.
 */
import { supabase } from '/api-config.js';
import { ContinuityError } from './continuity-data.js';

export const UPLOAD_FUNCTION = 'continuity-attachment-upload';

/**
 * يرفع ملفًا لدالة الرفع ويرجع السجل الكامل بعد التأكيد (نفس شكل continuity_get).
 * onProgress(0..1). الأخطاء ContinuityError بنفس أكواد الـRPC (+ signature_mismatch إلخ).
 */
export async function uploadAttachment({ recordId, file, kind, mime, idempotencyKey, onProgress = () => {}, signal }) {
    const { data: { session } = {} } = await supabase.auth.getSession();
    const token = session?.access_token;
    if (!token) throw new ContinuityError({ code: 'forbidden', field: null, reason: null, kinds: [], currentVersion: null, message: 'سجّل الدخول من جديد.' });
    const url = `${supabase.supabaseUrl}/functions/v1/${UPLOAD_FUNCTION}`;
    onProgress(0);
    const res = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', url);
        xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        if (supabase.supabaseKey) xhr.setRequestHeader('apikey', supabase.supabaseKey);
        xhr.setRequestHeader('Content-Type', mime);
        xhr.setRequestHeader('X-Continuity-Record', recordId);
        xhr.setRequestHeader('X-Continuity-Kind', kind);
        xhr.setRequestHeader('X-Idempotency-Key', idempotencyKey);
        if (file.name) xhr.setRequestHeader('X-Continuity-Name', encodeURIComponent(file.name));
        xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.min(0.99, e.loaded / e.total)); };
        xhr.onload = () => {
            let body = null;
            try { body = JSON.parse(xhr.responseText || 'null'); } catch { body = null; }
            resolve({ status: xhr.status, body });
        };
        xhr.onerror = () => reject(new ContinuityError({ code: 'network', field: null, reason: null, kinds: [], currentVersion: null,
            message: 'الاتصال انقطع. الملف ما اترفعش؛ جرّب تاني.' }));
        xhr.onabort = () => reject(new ContinuityError({ code: 'aborted', field: null, reason: null, kinds: [], currentVersion: null, message: 'اتلغى الرفع.' }));
        signal?.addEventListener('abort', () => xhr.abort(), { once: true });
        xhr.send(file);
    });
    if (res.status >= 200 && res.status < 300 && res.body?.record) {
        onProgress(1);
        return res.body;
    }
    const e = res.body?.error || {};
    throw new ContinuityError({
        code: typeof e.code === 'string' ? e.code : 'unknown_error',
        field: typeof e.field === 'string' ? e.field : null,
        reason: typeof e.reason === 'string' ? e.reason : null,
        kinds: [], currentVersion: null,
        message: '',
    });
}
