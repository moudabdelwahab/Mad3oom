/**
 * دالة عرض المرفق المشترك (091، S-7) ببدائل حقنية. البوابة نفسها مقيسة في
 * tests/sql/continuity-scoped-handover.test.sql (G6).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { handleShared, MAX_TTL, BUCKET } from '../supabase/functions/continuity-shared-attachment/handler.js';

const ID = '3e550000-0000-4000-8000-0000000000a1';
const PATH = '11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333';

function req({ method = 'POST', token = 'tok', body = { attachment_id: ID }, raw } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    return new Request('https://x.test/functions/v1/continuity-shared-attachment', {
        method, headers, body: method === 'POST' || method === 'PUT' ? (raw ?? JSON.stringify(body)) : undefined,
    });
}

function deps(over = {}) {
    const calls = { rpc: [], sign: [] };
    return {
        calls,
        getUser: async (t) => (t === 'tok' ? { id: 'u1' } : null),
        rpc: async (token, fn, args) => {
            calls.rpc.push({ token, fn, args });
            return { data: { path: PATH, ttl: 42, mime: 'image/png', name: 'صورة.png', size: 1000 }, error: null };
        },
        sign: async (path, ttl) => {
            calls.sign.push({ path, ttl });
            return { data: { signedUrl: `https://x.test/sign/${path}?t=${ttl}` }, error: null };
        },
        ...over,
    };
}

const body = async (res) => JSON.parse(await res.text());

test('المسار الكامل: الفحص بهوية المستخدم، والتوقيع بالمسار والمدة التي أعادتها القاعدة', async () => {
    const d = deps();
    const res = await handleShared(req(), d);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const b = await body(res);
    assert.equal(b.expires_in, 42);
    assert.equal(b.mime, 'image/png');
    assert.match(b.url, /^https:\/\/x\.test\/sign\//);
    assert.deepEqual(d.calls.rpc, [{ token: 'tok', fn: 'continuity_shared_attachment_check', args: { p_attachment: ID } }]);
    assert.deepEqual(d.calls.sign, [{ path: PATH, ttl: 42 }]);
    assert.ok(!('path' in b), 'no bare storage path in the response');
});

test('بلا JWT أو JWT غير صالح ⇒ 401 بلا أي نداء للقاعدة', async () => {
    for (const token of ['', 'bad']) {
        const d = deps();
        const res = await handleShared(req({ token }), d);
        assert.equal(res.status, 401);
        assert.equal(d.calls.rpc.length, 0);
        assert.equal(d.calls.sign.length, 0);
    }
});

test('الطريقة والجسم: GET ⇒ 405، معرّف غير صالح ⇒ 400، جسم كبير ⇒ 413، OPTIONS ⇒ 204', async () => {
    assert.equal((await handleShared(req({ method: 'GET' }), deps())).status, 405);
    assert.equal((await handleShared(req({ method: 'OPTIONS' }), deps())).status, 204);
    for (const b of [{}, { attachment_id: 'x' }, { attachment_id: 5 }, null]) {
        const d = deps();
        const res = await handleShared(req({ body: b }), d);
        assert.equal(res.status, 400);
        assert.equal((await body(res)).error.field, 'attachment_id');
        assert.equal(d.calls.rpc.length, 0);
    }
    assert.equal((await handleShared(req({ raw: 'not json' }), deps())).status, 400);
    assert.equal((await handleShared(req({ raw: JSON.stringify({ attachment_id: ID, pad: 'x'.repeat(2000) }) }), deps())).status, 413);
});

test('رفض القاعدة: not_found واحد بلا سبب (لا منحة، خارج النطاق، غير موجود)، ولا توقيع', async () => {
    const d = deps({ rpc: async () => ({ data: null, error: { code: 'P0002', details: '{"code":"not_found","field":"x","reason":"y"}' } }) });
    const res = await handleShared(req(), d);
    assert.equal(res.status, 404);
    assert.deepEqual(await body(res), { error: { code: 'not_found' } });
    assert.equal(d.calls.sign.length, 0);
    const off = await handleShared(req(), deps({ rpc: async () => ({ data: null, error: { code: '0A000', details: '{"code":"feature_not_enabled"}' } }) }));
    assert.equal(off.status, 403);
});

test('دفاع إضافي: مدة خارج 1..60 أو مسار بشكل غير متوقع ⇒ 502 بلا توقيع', async () => {
    for (const data of [{ path: PATH, ttl: 61 }, { path: PATH, ttl: 0 }, { path: PATH, ttl: 1.5 }, { path: '../etc/passwd', ttl: 10 },
        { path: `${PATH}/../x`, ttl: 10 }, { ttl: 10 }]) {
        const d = deps({ rpc: async () => ({ data, error: null }) });
        const res = await handleShared(req(), d);
        assert.equal(res.status, 502, JSON.stringify(data));
        assert.equal(d.calls.sign.length, 0);
    }
    assert.equal(MAX_TTL, 60);
    assert.equal(BUCKET, 'continuity-attachments');
});

test('فشل التوقيع ⇒ 502 sign_failed (لا نجاح وهمي)', async () => {
    const res = await handleShared(req(), deps({ sign: async () => ({ data: null, error: { message: 'x' } }) }));
    assert.equal(res.status, 502);
    assert.equal((await body(res)).error.code, 'sign_failed');
});

test('الربط: الفحص بمفتاح anon ورأس المستخدم، والتوقيع فقط بمفتاح الخدمة لنفس المستودع', async () => {
    const src = await readFile(new URL('../supabase/functions/continuity-shared-attachment/index.ts', import.meta.url), 'utf8');
    assert.match(src, /rpc: \(token: string, fn: string, args: Record<string, unknown>\) => asUser\(token\)\.rpc\(fn, args\)/);
    assert.match(src, /sign: \(path: string, ttl: number\) => admin\.storage\.from\(BUCKET\)\.createSignedUrl\(path, ttl\)/);
    assert.equal((src.match(/admin\./g) || []).length, 2, 'admin only for getUser and sign');
    const sql = await readFile(new URL('../migrations/091_continuity_scoped_handover.sql', import.meta.url), 'utf8');
    assert.match(sql, /least\(60, floor\(extract\(epoch from \(h\.expires_at - now\(\)\)\)\)::int\)/);
});
