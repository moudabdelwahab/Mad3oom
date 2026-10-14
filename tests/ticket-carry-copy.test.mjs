/**
 * ticket-carry-copy (101) — منطق خالص ببدائل. القاعدة تقرر ما يُنسخ وتتحقق من وجود الملف الجديد
 * (tests/sql/customer-transfers-carry.test.sql)؛ هنا السر، والحجم، ومسار الوجهة، وما يبقى في الطابور.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { handleCarryCopy, destPathOk, sourcePathOk } from '../supabase/functions/ticket-carry-copy/handler.js';

const SECRET = 'c'.repeat(40);
const U = '11111111-1111-4111-8111-111111111111';
const T = '22222222-2222-4222-8222-222222222222';
const T0 = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const sha256 = async (b) => crypto.createHash('sha256').update(b).digest('hex');
const item = (over = {}) => ({ id: 'i1', bucket: 'tickets', source_path: `${U}/${T0}/invoice.png`,
    dest_path: `${U}/${T}/3f2b7c1e-1111-4222-8333-444455556666-invoice.png`, mime_type: 'image/png', size_bytes: BYTES.length, ...over });
const req = (token = SECRET, method = 'POST') => new Request('https://x/functions/v1/ticket-carry-copy',
    { method, headers: token ? { Authorization: `Bearer ${token}` } : {} });

function deps(items, over = {}) {
    const log = { complete: [], upload: [], remove: [] };
    return {
        log, secret: SECRET, sha256,
        queue: async () => ({ data: items }),
        download: async () => ({ bytes: BYTES }),
        upload: async (path, bytes, mime) => { log.upload.push([path, bytes.length, mime]); return {}; },
        remove: async (path) => { log.remove.push(path); },
        complete: async (args) => { log.complete.push(args); return { data: { status: args.p_ok ? 'copied' : 'failed' } }; },
        ...over,
    };
}

test('مسار الوجهة: مولَّد بثلاثة أجزاء، بلا رجوع ولا مطابقة للأصل', () => {
    assert.equal(destPathOk(item()), true);
    assert.equal(destPathOk(item({ dest_path: `${U}/../x/y` })), false);
    assert.equal(destPathOk(item({ dest_path: 'a/b' })), false);
    assert.equal(destPathOk(item({ dest_path: `${U}/${T}/a/b` })), false);
    assert.equal(destPathOk(item({ source_path: item().dest_path })), false);
});

test('مسار الأصل: بنفس الشكل وفي مجلد العميل نفسه', () => {
    assert.equal(sourcePathOk(item()), true);
    assert.equal(sourcePathOk(item({ source_path: `${OTHER}/${T0}/x.png` })), false, 'ملف عميل آخر');
    assert.equal(sourcePathOk(item({ source_path: `${U}/../x` })), false);
    assert.equal(sourcePathOk(item({ source_path: 'invoices/secret.pdf' })), false);
    // ما يرفعه التطبيق فعلًا (tickets-service.js): <التذكرة>/<وقت>_<اسم> — القاعدة تتحقق من الملكية والتذكرة
    assert.equal(sourcePathOk(item({ source_path: `${T0}/1760000000000_ab12cd_receipt.png` })), true);
    assert.equal(sourcePathOk(item({ source_path: `${T0}/../x` })), false);
});

test('بلا سر (أو قصير) 503 والطابور لا يُقرأ؛ سر خاطئ 401؛ غير POST 405', async () => {
    let read = 0;
    const d = deps([item()], { queue: async () => { read++; return { data: [] }; } });
    assert.equal((await handleCarryCopy(req(), { ...d, secret: '' })).status, 503);
    assert.equal((await handleCarryCopy(req(), { ...d, secret: 'short' })).status, 503);
    assert.equal((await handleCarryCopy(req('wrong'.repeat(9)), d)).status, 401);
    assert.equal((await handleCarryCopy(req(null), d)).status, 401);
    assert.equal((await handleCarryCopy(req(SECRET, 'GET'), d)).status, 405);
    assert.equal(read, 0);
});

test('النسخ: تنزيل ← رفع للمسار المولَّد بلا استبدال ← تأكيد بالبصمة', async () => {
    const d = deps([item()]);
    const res = await handleCarryCopy(req(), d);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { processed: 1, copied: 1, failed: 0, retry: 0 });
    assert.deepEqual(d.log.upload, [[item().dest_path, BYTES.length, 'image/png']]);
    assert.deepEqual(d.log.complete, [{ p_item: 'i1', p_ok: true, p_sha256: await sha256(BYTES), p_error: null }]);
});

test('الأصل مفقود أو الحجم مخالف أو مسار غير صالح ⇒ فشل مسجَّل بلا رفع', async () => {
    for (const [it, over, code] of [
        [item(), { download: async () => ({ notFound: true, error: { message: 'Object not found' } }) }, 'source_missing'],
        [item({ size_bytes: 999 }), {}, 'size_mismatch'],
        [item({ dest_path: '../../etc' }), {}, 'invalid_dest_path'],
        [item({ source_path: `${OTHER}/${T0}/x.png` }), {}, 'invalid_source_path'],
    ]) {
        const d = deps([it], over);
        const out = await (await handleCarryCopy(req(), d)).json();
        assert.equal(out.failed, 1, code);
        assert.deepEqual(d.log.upload, [], code);
        assert.equal(d.log.complete[0].p_ok, false);
        assert.equal(d.log.complete[0].p_error, code);
    }
});

test('عطل عابر يبقى في الطابور؛ لا حذف بعد رفع قد سُجّل؛ كائن موجود في المسار المولَّد يكمل إلى التأكيد', async () => {
    let d = deps([item()], { download: async () => ({ error: { message: 'timeout' } }) });
    assert.deepEqual(await (await handleCarryCopy(req(), d)).json(), { processed: 1, copied: 0, failed: 0, retry: 1 });
    assert.deepEqual(d.log.complete, []);
    d = deps([item()], { upload: async () => ({ error: { message: 'exists' } }) });
    assert.equal((await (await handleCarryCopy(req(), d)).json()).retry, 1);
    assert.deepEqual(d.log.complete, []);
    d = deps([item()], { complete: async () => ({ error: { code: '55000' } }) });
    assert.equal((await (await handleCarryCopy(req(), d)).json()).retry, 1);
    assert.deepEqual(d.log.remove, [], 'لا حذف: ربما سُجّل التأكيد وضاع الرد');
    d = deps([item()], { upload: async () => ({ error: { message: 'The resource already exists' }, exists: true }) });
    assert.equal((await (await handleCarryCopy(req(), d)).json()).copied, 1);
    assert.equal(d.log.complete[0].p_ok, true);
    d = deps([], { queue: async () => ({ error: { code: '42501' } }) });
    assert.equal((await handleCarryCopy(req(), d)).status, 502);
});
