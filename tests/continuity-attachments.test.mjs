/**
 * مرفقات الاستمرارية (080): قواعد الأنواع والتوقيع، وتطابق الحدود في الأماكن الثلاثة
 * (المتصفح، دالة الرفع، القاعدة)، ودالتا الرفع والتنظيف ببدائل حقنية.
 * القاعدة نفسها مقيسة في tests/sql/continuity-attachments.test.sql.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
    MIB, ATTACHMENT_KINDS, MAX_ATTACHMENTS_PER_RECORD, MAX_ATTACHMENT_BYTES, baseMime, kindOfMime, checkDeclared,
    sniffContainer, signatureMatches, cleanDisplayName, formatBytes,
} from '../supabase/functions/_shared/continuity-media.js';
import { handleUpload, readCapped, BUCKET } from '../supabase/functions/continuity-attachment-upload/handler.js';
import { handleCleanup, sameSecret } from '../supabase/functions/continuity-attachment-cleanup/handler.js';

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8');
const bytes = (...parts) => {
    const out = [];
    for (const p of parts) out.push(...(typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p));
    return new Uint8Array(out);
};
const pad = (b, n = 64) => { const o = new Uint8Array(Math.max(n, b.length)); o.set(b); return o; };

const SAMPLES = {
    png: pad(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    jpeg: pad(bytes([0xff, 0xd8, 0xff, 0xe0])),
    gif: pad(bytes('GIF89a')),
    webp: pad(bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 ')),
    wav: pad(bytes('RIFF', [0, 0, 0, 0], 'WAVEfmt ')),
    mp4: pad(bytes([0, 0, 0, 0x18], 'ftypisom')),
    m4a: pad(bytes([0, 0, 0, 0x18], 'ftypM4A ')),
    mov: pad(bytes([0, 0, 0, 0x14], 'ftypqt  ')),
    movOld: pad(bytes([0, 0, 0, 0x08], 'wide')),
    webm: pad(bytes([0x1a, 0x45, 0xdf, 0xa3])),
    ogg: pad(bytes('OggS')),
    mp3: pad(bytes('ID3', [3, 0])),
    mp3sync: pad(bytes([0xff, 0xfb, 0x90])),
    svg: pad(bytes('<svg xmlns="http://www.w3.org/2000/svg">')),
    html: pad(bytes('<!doctype html><script>')),
    pdf: pad(bytes('%PDF-1.7')),
};

test('الحدود بالبايت: 1 MiB = 1,048,576؛ صورة 3، فيديو 16، صوت 8؛ 20 مرفقًا', () => {
    assert.equal(MIB, 1048576);
    assert.equal(ATTACHMENT_KINDS.image.max, 3145728);
    assert.equal(ATTACHMENT_KINDS.video.max, 16777216);
    assert.equal(ATTACHMENT_KINDS.audio.max, 8388608);
    assert.equal(MAX_ATTACHMENT_BYTES, 16777216);
    assert.equal(MAX_ATTACHMENTS_PER_RECORD, 20);
    const all = Object.values(ATTACHMENT_KINDS).flatMap((k) => k.mimes);
    for (const bad of ['image/svg+xml', 'application/pdf', 'text/html', 'application/octet-stream']) assert.ok(!all.includes(bad), bad);
});

test('checkDeclared: النوع والـMIME ضمن نوعه والحجم ضمن حده', () => {
    assert.equal(checkDeclared({ kind: 'image', mime: 'image/png', size: 3145728 }), null);
    assert.deepEqual(checkDeclared({ kind: 'image', mime: 'image/png', size: 3145729 }), { field: 'size', reason: 'too_large' });
    assert.equal(checkDeclared({ kind: 'audio', mime: 'audio/webm;codecs=opus', size: 8388608 }), null);
    assert.deepEqual(checkDeclared({ kind: 'audio', mime: 'audio/webm', size: 8388609 }), { field: 'size', reason: 'too_large' });
    assert.equal(checkDeclared({ kind: 'video', mime: 'video/quicktime', size: 16777216 }), null);
    assert.deepEqual(checkDeclared({ kind: 'image', mime: 'video/mp4', size: 10 }), { field: 'mime', reason: 'not_allowed' });
    assert.deepEqual(checkDeclared({ kind: 'pdf', mime: 'application/pdf', size: 10 }), { field: 'kind', reason: 'not_allowed' });
    assert.deepEqual(checkDeclared({ kind: 'image', mime: 'image/png', size: 0 }), { field: 'size', reason: 'invalid' });
    assert.deepEqual(checkDeclared({ kind: 'image', mime: 'image/png', size: 1.5 }), { field: 'size', reason: 'invalid' });
    assert.equal(baseMime(' Audio/WEBM ; codecs=opus'), 'audio/webm');
    assert.equal(kindOfMime('video/webm'), 'video');
    assert.equal(kindOfMime('image/svg+xml'), null);
});

test('التوقيع يطابق الـMIME المعلن، لا الامتداد', () => {
    const ok = [['image/png', 'png'], ['image/jpeg', 'jpeg'], ['image/gif', 'gif'], ['image/webp', 'webp'],
        ['audio/wav', 'wav'], ['audio/x-wav', 'wav'], ['video/mp4', 'mp4'], ['audio/mp4', 'm4a'], ['video/quicktime', 'mov'],
        ['video/quicktime', 'movOld'], ['video/webm', 'webm'], ['audio/webm', 'webm'], ['audio/ogg', 'ogg'],
        ['audio/mpeg', 'mp3'], ['audio/mpeg', 'mp3sync']];
    for (const [mime, s] of ok) assert.ok(signatureMatches(mime, SAMPLES[s]), `${mime} ← ${s}`);
    const bad = [['image/png', 'jpeg'], ['image/png', 'svg'], ['image/jpeg', 'html'], ['video/mp4', 'webm'], ['audio/ogg', 'mp3'],
        ['image/webp', 'wav'], ['audio/wav', 'webp'], ['audio/mpeg', 'pdf'], ['image/svg+xml', 'svg'], ['application/pdf', 'pdf']];
    for (const [mime, s] of bad) assert.ok(!signatureMatches(mime, SAMPLES[s]), `${mime} ← ${s}`);
    assert.equal(sniffContainer(new Uint8Array([0x89, 0x50])), null, 'too short');
    assert.equal(sniffContainer(SAMPLES.html), null);
});

test('اسم العرض: آخر جزء، بلا تحكم أو اتجاه، 200 حرف — ومطابق لدالة القاعدة', async () => {
    assert.equal(cleanDisplayName('../../etc/\u202Egnp.exe'), 'gnp.exe');
    assert.equal(cleanDisplayName('C:\\Users\\a\\صورة.png'), 'صورة.png');
    assert.equal(cleanDisplayName('a\u0000b\u200Bc'), 'abc');
    assert.equal(cleanDisplayName('   '), null);
    assert.equal(cleanDisplayName('x'.repeat(250)).length, 200);
    const sql = await read('migrations/080_continuity_attachments.sql');
    assert.match(sql, /regexp_replace\(coalesce\(p, ''\), '\^\.\*\[\/\\\\\]', ''\)/, 'SQL strips the path too');
    assert.match(sql, /\\u0001-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ufeff/, 'SQL strips the same characters');
    assert.equal(formatBytes(3145728), '3 ميجا');
    assert.equal(formatBytes(1572864), '1.5 ميجا');
    assert.equal(formatBytes(2048), '2 كيلو');
});

test('ثلاثة أماكن، قاعدة واحدة: نسخة المتصفح مطابقة حرفيًا، والقاعدة بنفس الحدود والأنواع', async () => {
    const shared = await read('supabase/functions/_shared/continuity-media.js');
    const browser = await read('assets/js/continuity/continuity-media.js');
    assert.equal(browser, shared, 'assets/js/continuity/continuity-media.js must equal the shared module byte for byte');
    const sql = await read('migrations/080_continuity_attachments.sql');
    for (const [kind, spec] of Object.entries(ATTACHMENT_KINDS)) {
        assert.ok(sql.includes(`when '${kind}' then ${spec.max}`), `${kind} max in SQL`);
        const line = sql.split('\n').find((l) => l.includes(`when '${kind}' then p_mime in (`));
        assert.deepEqual([...line.matchAll(/'([a-z]+\/[a-z0-9.+-]+)'/g)].map((m) => m[1]), [...spec.mimes], `${kind} mimes in SQL`);
    }
    assert.ok(sql.includes('>= 20 then'), 'per-record cap in SQL');
    assert.ok(sql.includes("false, 16777216,"), 'bucket limit');
});

// ─────────────────────────────────────────────────────────────
// دالة الرفع
// ─────────────────────────────────────────────────────────────
const REC = 'cccccccc-0000-4000-8000-000000000001';
const KEY = 'dddddddd-0000-4000-8000-000000000001';
const ATT = 'eeeeeeee-0000-4000-8000-000000000001';
const PATH = `aaaaaaaa-0000-4000-8000-000000000001/${REC}/${ATT}`;

function makeDeps({ user = { id: 'u1' }, begin, commit, upload, sha = 'f'.repeat(64) } = {}) {
    const calls = [];
    return {
        calls,
        getUser: async (t) => { calls.push(['getUser', t]); return user; },
        rpc: async (t, fn, args) => {
            calls.push(['rpc', fn, args, t]);
            if (fn === 'continuity_attachment_begin' || fn === 'continuity_shared_attachment_begin') return begin || { data: {
                attachment: { id: ATT, status: 'pending' }, upload: { bucket: BUCKET, path: PATH, max_bytes: args.p_size } } };
            return commit || { data: { record: { id: REC }, attachments: [{ id: ATT }] } };
        },
        upload: async (p, b, ct) => { calls.push(['upload', p, b.byteLength, ct]); return upload || { error: null }; },
        remove: async (p) => { calls.push(['remove', p]); return { error: null }; },
        sha256: async () => sha,
    };
}
function req(body, headers = {}, method = 'POST') {
    const h = { authorization: 'Bearer tok', 'content-type': 'image/png', 'content-length': String(body?.length ?? 0),
        'x-continuity-record': REC, 'x-continuity-kind': 'image', 'x-idempotency-key': KEY,
        'x-continuity-name': encodeURIComponent('لقطة.png'), ...headers };
    for (const k of Object.keys(h)) if (h[k] === undefined) delete h[k];
    return new Request('https://fn.test/continuity-attachment-upload', { method, headers: h, body: method === 'POST' ? body : undefined });
}
const out = async (res) => ({ status: res.status, body: res.status === 204 ? null : await res.json() });

test('الرفع: المسار الكامل — begin بهوية المستخدم، رفع للمسار المولَّد، commit بالبصمة', async () => {
    const deps = makeDeps();
    const r = await out(await handleUpload(req(SAMPLES.png), deps));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.attachments, [{ id: ATT }]);
    const begin = deps.calls.find((c) => c[1] === 'continuity_attachment_begin');
    assert.deepEqual(begin[2], { p_record: REC, p_kind: 'image', p_mime: 'image/png', p_size: 64, p_name: 'لقطة.png', p_idempotency_key: KEY });
    assert.equal(begin[3], 'tok', 'begin runs as the user');
    assert.deepEqual(deps.calls.find((c) => c[0] === 'upload'), ['upload', PATH, 64, 'image/png']);
    const commit = deps.calls.find((c) => c[1] === 'continuity_attachment_commit');
    assert.deepEqual(commit[2], { p_attachment: ATT, p_sha256: 'f'.repeat(64) });
    assert.equal(commit[3], 'tok', 'commit runs as the user');
});

test('الرفع (093): X-Continuity-Shared: 1 ⇒ دوال المشاركة بهوية المستخدم، وبلا الترويسة لا تُنادى أبدًا', async () => {
    const deps = makeDeps();
    const r = await out(await handleUpload(req(SAMPLES.png, { 'x-continuity-shared': '1' }), deps));
    assert.equal(r.status, 200);
    const fns = deps.calls.filter((c) => c[0] === 'rpc').map((c) => [c[1], c[3]]);
    assert.deepEqual(fns, [['continuity_shared_attachment_begin', 'tok'], ['continuity_shared_attachment_commit', 'tok']]);
    assert.deepEqual(deps.calls.find((c) => c[0] === 'upload'), ['upload', PATH, 64, 'image/png'], 'same generated path, same checks');
    for (const v of [undefined, '0', 'true', 'yes']) {
        const d = makeDeps();
        await handleUpload(req(SAMPLES.png, { 'x-continuity-shared': v }), d);
        assert.ok(d.calls.filter((c) => c[0] === 'rpc').every((c) => !c[1].includes('shared')), `header ${v}`);
    }
    // التوقيع يُفحص في المسار المشترك أيضًا
    const bad = makeDeps();
    const res = await out(await handleUpload(req(pad(bytes('<svg onload=x>')), { 'x-continuity-shared': '1' }), bad));
    assert.equal(res.status, 415);
    assert.equal(bad.calls.some((c) => c[0] === 'upload'), false);
});

test('الرفع: يرفض قبل أي نداء للقاعدة — بلا JWT، نوع/حجم/رؤوس غير صالحة', async () => {
    const cases = [
        [req(SAMPLES.png, { authorization: undefined }), 401],
        [req(SAMPLES.png, { 'x-continuity-record': 'nope' }), 400],
        [req(SAMPLES.png, { 'x-idempotency-key': '' }), 400],
        [req(SAMPLES.svg, { 'content-type': 'image/svg+xml' }), 400],
        [req(SAMPLES.png, { 'x-continuity-kind': 'video' }), 400],
        [req(SAMPLES.png, { 'content-length': String(3145729) }), 413],
        [req(SAMPLES.png, {}, 'GET'), 405],
    ];
    for (const [r, status] of cases) {
        const deps = makeDeps();
        const res = await out(await handleUpload(r, deps));
        assert.equal(res.status, status, JSON.stringify(res.body));
        assert.ok(!deps.calls.some((c) => c[0] === 'rpc' || c[0] === 'upload'), 'nothing called');
    }
    const noUser = makeDeps({ user: null });
    assert.equal((await handleUpload(req(SAMPLES.png), noUser)).status, 401);
    assert.equal((await handleUpload(req(null, {}, 'OPTIONS'), makeDeps())).status, 204);
});

test('الرفع: التوقيع يُفحص على البايتات — PNG معلن ومحتواه HTML/SVG ⇒ 415 بلا رفع', async () => {
    for (const s of ['html', 'svg', 'jpeg']) {
        const deps = makeDeps();
        const r = await out(await handleUpload(req(SAMPLES[s]), deps));
        assert.equal(r.status, 415);
        assert.deepEqual(r.body.error, { code: 'validation_failed', field: 'file', reason: 'signature_mismatch' });
        assert.ok(!deps.calls.some((c) => c[0] === 'upload'));
    }
});

test('الرفع: الجسم أكبر أو أصغر من المعلن ⇒ رفض بلا رفع (حد صارم أثناء القراءة)', async () => {
    let deps = makeDeps();
    const big = pad(SAMPLES.png, 200);
    let r = await out(await handleUpload(req(big, { 'content-length': '64' }), deps));
    assert.ok([400, 413].includes(r.status));
    assert.ok(!deps.calls.some((c) => c[0] === 'upload'));
    deps = makeDeps();
    r = await out(await handleUpload(req(SAMPLES.png, { 'content-length': '100' }), deps));
    assert.equal(r.status, 400);
    assert.equal(r.body.error.reason, 'size_mismatch');
    const stream = new Blob([new Uint8Array(10), new Uint8Array(10)]).stream();
    assert.equal(await readCapped(stream, 15), null);
});

test('الرفع: رفض القاعدة يُنقل بكوده دون رسالته؛ فشل التأكيد يحذف الملف الجديد', async () => {
    const begin = { error: { code: 'P0002', message: 'غير موجود — نص داخلي', details: '{"code":"not_found"}' } };
    let deps = makeDeps({ begin });
    let r = await out(await handleUpload(req(SAMPLES.png), deps));
    assert.equal(r.status, 404);
    assert.deepEqual(r.body, { error: { code: 'not_found' } });
    assert.ok(!JSON.stringify(r.body).includes('نص داخلي'));
    deps = makeDeps({ begin: { error: { code: '0A000', details: '{"code":"feature_not_enabled","field":"attachments"}' } } });
    r = await out(await handleUpload(req(SAMPLES.png), deps));
    assert.deepEqual([r.status, r.body.error], [403, { code: 'feature_not_enabled', field: 'attachments' }]);
    const commit = { error: { code: '22023', details: '{"code":"validation_failed","field":"object","reason":"mime_mismatch"}' } };
    deps = makeDeps({ commit });
    r = await out(await handleUpload(req(SAMPLES.png), deps));
    assert.deepEqual([r.status, r.body.error.reason], [400, 'mime_mismatch']);
    assert.deepEqual(deps.calls.at(-1), ['remove', PATH], 'orphan removed');
    deps = makeDeps({ upload: { error: { statusCode: '500', message: 'boom' } } });
    r = await out(await handleUpload(req(SAMPLES.png), deps));
    assert.deepEqual([r.status, r.body.error.code], [502, 'upload_failed']);
    assert.ok(!deps.calls.some((c) => c[1] === 'continuity_attachment_commit'));
});

test('الرفع: إعادة المحاولة — الملف موجود من محاولة سابقة ⇒ التأكيد يتحقق منه ولا يُحذف؛ مرفق مكتمل ⇒ بلا رفع', async () => {
    let deps = makeDeps({ upload: { error: { statusCode: '409', message: 'The resource already exists' } },
        commit: { error: { code: '22023', details: '{"code":"validation_failed","reason":"size_mismatch"}' } } });
    let r = await out(await handleUpload(req(SAMPLES.png), deps));
    assert.equal(r.status, 400);
    assert.ok(!deps.calls.some((c) => c[0] === 'remove'), 'an existing object is not removed by a retry');
    deps = makeDeps({ begin: { data: { attachment: { id: ATT, status: 'active' }, upload: null, replayed: true } } });
    r = await out(await handleUpload(req(SAMPLES.png), deps));
    assert.equal(r.status, 200);
    assert.ok(!deps.calls.some((c) => c[0] === 'upload'));
});

test('مفتاح الخدمة لا يصل للمتصفح: لا ذكر له في assets ولا في صفحات الإدارة', async () => {
    const { readdir } = await import('node:fs/promises');
    const files = [];
    async function walk(dir) {
        for (const e of await readdir(new URL(`../${dir}`, import.meta.url), { withFileTypes: true })) {
            const p = `${dir}/${e.name}`;
            if (e.isDirectory()) await walk(p); else if (/\.(js|html)$/.test(e.name)) files.push(p);
        }
    }
    await walk('assets/js/continuity');
    files.push('admin/continuity.html', 'admin/continuity-record.html');
    for (const f of files) assert.doesNotMatch(await read(f), /SERVICE_ROLE|service_role/i, f);
    const index = await read('supabase/functions/continuity-attachment-upload/index.ts');
    assert.match(index, /Deno\.env\.get\("SUPABASE_SERVICE_ROLE_KEY"\)/);
});

// ─────────────────────────────────────────────────────────────
// دالة التنظيف
// ─────────────────────────────────────────────────────────────
test('التنظيف: بالسر فقط، مسارات بالشكل المتوقع فقط، على دفعات', async () => {
    const P = (n) => `aaaaaaaa-0000-4000-8000-000000000001/${REC}/${String(n).padStart(12, '0').replace(/^/, 'eeeeeeee-0000-4000-8000-')}`;
    const removed = [];
    const deps = {
        secret: 's3cret',
        queue: async () => ({ data: [...Array.from({ length: 150 }, (_, i) => ({ path: P(i), reason: 'purged' })),
            { path: '../../avatars/x.png', reason: 'orphan' }, { path: 'other-bucket/file', reason: 'orphan' }], error: null }),
        remove: async (paths) => { removed.push(paths.length); return { error: null }; },
    };
    const mk = (secret, method = 'POST') => new Request('https://fn.test/c', { method, headers: secret ? { 'x-cleanup-secret': secret } : {} });
    assert.equal((await handleCleanup(mk(null), deps)).status, 401);
    assert.equal((await handleCleanup(mk('wrong'), deps)).status, 401);
    assert.equal((await handleCleanup(mk('s3cret'), { ...deps, secret: '' })).status, 401, 'no secret configured ⇒ refuse all');
    const res = await handleCleanup(mk('s3cret'), deps);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { queued: 150, removed: 150, failed: 0 });
    assert.deepEqual(removed, [100, 50]);
    assert.equal(sameSecret('a', 'a'), true);
    assert.equal(sameSecret('a', 'ab'), false);
    assert.equal(sameSecret('', ''), false);
});

test('الواجهة: طلب واحد فقط خارج supabase.rpc — الملف إلى دالة الرفع، ولا شيء آخر', async () => {
    const up = await read('assets/js/continuity/continuity-upload.js');
    assert.equal((up.match(/XMLHttpRequest/g) || []).length, 1, 'one XHR');
    assert.ok(!/fetch\(|sendBeacon|localStorage|sessionStorage|indexedDB|document\.cookie|WebSocket/.test(up), 'no other channel or storage');
    assert.match(up, /xhr\.open\('POST', url\)/);
    assert.match(up, /const url = `\$\{supabase\.supabaseUrl\}\/functions\/v1\/\$\{UPLOAD_FUNCTION\}`;/);
    assert.match(up, /export const UPLOAD_FUNCTION = 'continuity-attachment-upload';/);
    assert.deepEqual([...up.matchAll(/xhr\.send\(([^)]*)\)/g)].map((m) => m[1]), ['file'], 'the body is the file only');
    // وكل وحدات الاستمرارية الأخرى بلا أي قناة شبكة غير supabase
    for (const f of ['continuity-composer.js', 'continuity-contract.js', 'continuity-data.js', 'continuity-dialog.js', 'continuity-icons.js',
        'continuity-media.js', 'continuity-model.js', 'continuity-page.js']) {
        const src = await read(`assets/js/continuity/${f}`);
        assert.ok(!/fetch\(|XMLHttpRequest|sendBeacon|WebSocket/.test(src), f);
    }
});

// ── 089: الدالة تقرأ السر الداخلي فقط لطلب يحمل ترويسة السر، وتقبل سر البيئة لو مضبوط ──
test('089 cleanup entry: the internal secret is read only for a request carrying X-Cleanup-Secret; env wins when set', async () => {
    const src = await readFile(new URL('../supabase/functions/continuity-attachment-cleanup/index.ts', import.meta.url), 'utf8');
    assert.match(src, /secret: req\.headers\.get\("x-cleanup-secret"\) \? await expectedSecret\(\) : ""/);
    assert.match(src, /Deno\.env\.get\("CONTINUITY_CLEANUP_SECRET"\)[\s\S]*if \(fromEnv\) return fromEnv;/);
    assert.match(src, /\.from\("internal_service_secrets"\)\.select\("value"\)\s*\.eq\("key", "continuity_attachment_cleanup"\)/);
    const sql = await readFile(new URL('../migrations/089_continuity_attachment_cleanup_schedule.sql', import.meta.url), 'utf8');
    assert.match(sql, /'continuity_attachment_cleanup', encode\(extensions\.gen_random_bytes\(32\), 'hex'\)/);
    assert.match(sql, /'X-Cleanup-Secret', v_secret/);
});
