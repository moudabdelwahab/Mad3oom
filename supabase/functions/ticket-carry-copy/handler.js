/**
 * ticket-carry-copy — ينسخ مرفقات العميل للتذاكر المنسوخة (migrations/101_customer_transfers_carry.sql).
 *
 * القاعدة تقرر ما يُنسخ (carry_tickets يضع مرفقات العميل غير الداخلية في الطابور بمسار وجهة يولّده الخادم)،
 * وهذه الدالة تنقل البايتات فقط: تنزيل الأصل ← تحقق الحجم ← رفع ملف جديد للمسار المولَّد ← carry_copy_complete
 * بالبصمة. الأصل لا يُلمس، والملف الجديد مستقل عنه (حذف أحدهما لا يمس الآخر).
 *
 * يستدعيها مُجدول بمفتاح سري: POST · Authorization: Bearer <CARRY_COPY_SECRET> (≥ 32 حرفًا). بلا السر ترد 503
 * دائمًا فتبقى العناصر pending_copy والتذكرة المنسوخة بلا مرفقات (نصها كامل). النشر يحتاج موافقة صريحة.
 */
import { safeEqualHex } from '../_shared/company-documents.js';

const json = (status, body) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});
const MIN_SECRET = 32;
const BATCH = 20;
const PATH_RE = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[^/]{1,200}$/;

/**
 * مسار وجهة يولّده الخادم: <العميل>/<التذكرة الجديدة>/<اسم> — بلا رجوع ولا مطابقة للأصل. والأصل بنفس الشكل
 * وفي مجلد العميل نفسه (القاعدة تتحقق من ملكية الكائن؛ هذا دفاع ثانٍ إن وصل مسار غريب إلى الطابور).
 */
export function destPathOk(item) {
    return typeof item?.dest_path === 'string' && PATH_RE.test(item.dest_path)
        && !item.dest_path.includes('..') && item.dest_path !== item.source_path;
}

export function sourcePathOk(item) {
    return typeof item?.source_path === 'string' && PATH_RE.test(item.source_path) && !item.source_path.includes('..')
        && typeof item?.dest_path === 'string' && item.source_path.split('/')[0] === item.dest_path.split('/')[0];
}

/**
 * deps: secret · sha256(Uint8Array) ⇒ hex · queue(limit) ⇒ { data, error }
 *       download(path) ⇒ { bytes, notFound?, error? } · upload(path, bytes, mime) ⇒ { error?, exists? }
 *       complete({ p_item, p_ok, p_sha256, p_error }) ⇒ { data, error }   (كلها بمفتاح الخدمة، دلو tickets)
 */
export async function handleCarryCopy(req, deps) {
    if (req.method !== 'POST') return json(405, { error: { code: 'method_not_allowed' } });
    if (typeof deps.secret !== 'string' || deps.secret.length < MIN_SECRET) return json(503, { error: { code: 'not_configured' } });
    const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    const enc = new TextEncoder();
    if (!token || !safeEqualHex(await deps.sha256(enc.encode(token)), await deps.sha256(enc.encode(deps.secret)))) {
        return json(401, { error: { code: 'unauthorized' } });
    }

    const q = await deps.queue(BATCH);
    if (q.error) return json(502, { error: { code: 'server_error' } });
    const out = { processed: 0, copied: 0, failed: 0, retry: 0 };
    for (const item of q.data ?? []) {
        out.processed++;
        const fail = async (code) => { await deps.complete({ p_item: item.id, p_ok: false, p_sha256: null, p_error: code }); out.failed++; };
        if (!destPathOk(item)) { await fail('invalid_dest_path'); continue; }
        if (!sourcePathOk(item)) { await fail('invalid_source_path'); continue; }

        const src = await deps.download(item.source_path);
        if (src.notFound) { await fail('source_missing'); continue; }
        if (src.error || !src.bytes) { out.retry++; continue; }            // عطل عابر: يبقى في الطابور
        if (Number.isInteger(item.size_bytes) && item.size_bytes > 0 && src.bytes.length !== item.size_bytes) {
            await fail('size_mismatch'); continue;
        }

        // المسار المولَّد لا يكتبه غير هذا العامل: كائن موجود فيه = رفع سابق لم يُؤكَّد، فنكمل إلى التأكيد
        const up = await deps.upload(item.dest_path, src.bytes, item.mime_type || 'application/octet-stream');
        if (up.error && !up.exists) { out.retry++; continue; }
        const done = await deps.complete({ p_item: item.id, p_ok: true, p_sha256: await deps.sha256(src.bytes), p_error: null });
        if (done.error) {
            // لا حذف: ربما سُجّل التأكيد وضاع الرد. العنصر يعود في الطابور (حتى 5 محاولات) أو صار مكتملًا
            out.retry++;
            continue;
        }
        out.copied++;
    }
    return json(200, out);
}
