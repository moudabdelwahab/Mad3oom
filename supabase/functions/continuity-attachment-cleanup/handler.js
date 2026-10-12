/**
 * continuity-attachment-cleanup — الحذف الفعلي لملفات المرفقات (قرار S3).
 *
 * حذف صف storage.objects بـ SQL لا يحذف الملف؛ الحذف عبر Storage API فقط. هذه الدالة:
 *   1. تقرأ continuity_attachment_deletion_queue (service_role فقط): مسارات المرفقات
 *      الممسوحة/المحجوبة/المهجورة والملفات اليتيمة. مسارات فقط، بلا أسماء أو محتوى.
 *   2. تحذفها من المستودع continuity-attachments على دفعات.
 *   3. الكنس (continuity_attachment_sweep) يسجّل اختفاءها في الصف (object_deleted_at).
 *
 * لا تُستدعى إلا بسر مشترك (X-Cleanup-Secret = CONTINUITY_CLEANUP_SECRET). بلا السر في البيئة
 * ترفض كل طلب. الجدولة (pg_cron + pg_net) جزء من النشر ويحتاج موافقة.
 */
export const BATCH = 100;

/** مقارنة بزمن ثابت (لا تكشف طول التطابق). */
export function sameSecret(a, b) {
    const x = String(a ?? '');
    const y = String(b ?? '');
    if (!x || !y) return false;
    let diff = x.length ^ y.length;
    for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
    return diff === 0;
}

const json = (status, body) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

/**
 * deps:
 *   secret                 السر المتوقع (من البيئة)
 *   queue(limit)           ⇒ { data: [{ path, reason }], error }
 *   remove(paths)          ⇒ { error }
 */
export async function handleCleanup(req, deps) {
    if (req.method !== 'POST') return json(405, { error: { code: 'method_not_allowed' } });
    if (!sameSecret(req.headers.get('x-cleanup-secret'), deps.secret)) return json(401, { error: { code: 'unauthorized' } });

    const { data, error } = await deps.queue(1000);
    if (error) return json(502, { error: { code: 'queue_failed' } });
    // دفاع إضافي: مسار بشكل <workspace>/<record>/<id> فقط، ولا شيء خارج المستودع.
    const shape = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36,}$/i;
    const paths = [...new Set((data || []).map((r) => r?.path).filter((p) => typeof p === 'string' && shape.test(p)))];
    let removed = 0;
    let failed = 0;
    for (let i = 0; i < paths.length; i += BATCH) {
        const batch = paths.slice(i, i + BATCH);
        const res = await deps.remove(batch).catch(() => ({ error: true }));
        if (res?.error) failed += batch.length; else removed += batch.length;
    }
    return json(failed ? 207 : 200, { queued: paths.length, removed, failed });
}
