// اختبارات سلوكية لـ supabase/functions/pi-auth.
//
// الثغرة المغلقة: كلمة المرور كانت مشتقة اشتقاقًا حتميًّا من **معرّف Pi**،
// والبريد من نفس المعرّف. ومعرّف Pi ليس سرًّا ⇒ من عرفه سجّل الدخول من نقطة
// المصادقة العادية متخطّيًا التحقق من Pi كليًّا.
//
// المعالج الحقيقي يُنفَّذ هنا: نقرأ الملف وننزع سطور الاستيراد ونحقن
// createClient و Deno و fetch و crypto — فلا يُعاد كتابة أي منطق.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import * as rateLimit from '../supabase/functions/_shared/rate-limit.js';

const SRC = path.resolve(import.meta.dirname, '../supabase/functions/pi-auth/index.ts');
const PI_UID = 'pi-uid-of-the-victim';
const EXISTING_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NEW_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function loadHandler({ createClient, fetchImpl }) {
    // نزع الأنواع بمُجرِّد Node الرسمي بدل تعبيرات نمطية هشّة: أي تعليق نوعي
    // جديد في المصدر كان سيكسر الاختبار بلا علاقة بالسلوك المُختبَر.
    const raw = fs.readFileSync(SRC, 'utf8')
        .replace(/^import\s+"jsr:@supabase\/functions-js\/edge-runtime\.d\.ts";\s*$/m, '')
        .replace(/^import\s+\{\s*createClient\s*\}\s+from\s+"jsr:@supabase\/supabase-js@2";\s*$/m, '')
        .replace(/^import\s+\{[^}]*\}\s+from\s+"\.\.\/_shared\/rate-limit\.js";\s*$/m, '');
    const src = stripTypeScriptTypes(raw, { mode: 'strip' });

    let handler;
    const Deno = {
        serve: (fn) => { handler = fn; },
        env: { get: (k) => ({ SUPABASE_URL: 'https://stub.local', SUPABASE_SERVICE_ROLE_KEY: 'svc' })[k] || '' }
    };
    // eslint-disable-next-line no-new-func
    const { checkRateLimit, rateLimitResponse, trustedClientIp } = rateLimit;
    new Function('Deno', 'createClient', 'fetch', 'crypto', 'checkRateLimit', 'rateLimitResponse', 'trustedClientIp', src)(
        Deno, createClient, fetchImpl, globalThis.crypto, checkRateLimit, rateLimitResponse, trustedClientIp);
    if (!handler) throw new Error('لم يُلتقط المعالج — تغيّر شكل Deno.serve؟');
    return handler;
}

/**
 * @param {object} s
 * @param {boolean} s.piTokenValid   هل يقبل مزوّد Pi التوكن
 * @param {boolean} s.userExists     هل يوجد حساب مسبق بالبريد المشتق
 * @param {boolean} [s.rotateFails]  هل يفشل إبطال بيانات الاعتماد
 * @param {'allow'|'deny'|'down'} [s.limiter]  ردّ rate_limit_hit
 */
function makeEnv(s) {
    const calls = { created: null, updated: null, linkFor: null, listPages: 0, piCalled: 0, rpc: [] };

    const adminClient = {
        rpc: async (fn, args) => {
            calls.rpc.push({ fn, args });
            if (s.limiter === 'down') return { data: null, error: { message: 'connection refused' } };
            const deny = s.limiter === 'deny';
            return { data: [{ allowed: !deny, enforced: true, would_block: deny, limit_total: 10, window_seconds: 600,
                              remaining: deny ? 0 : 9, reset_seconds: 60, retry_after: deny ? 60 : 0 }], error: null };
        },
        auth: {
            admin: {
                listUsers: async ({ page }) => {
                    calls.listPages = Math.max(calls.listPages, page);
                    if (page > 1) return { data: { users: [] }, error: null };
                    return {
                        data: {
                            users: s.userExists
                                ? [{ id: EXISTING_ID, email: `pi_${PI_UID}@pi.network`, user_metadata: { pi_uid: PI_UID } }]
                                : []
                        },
                        error: null
                    };
                },
                createUser: async (payload) => {
                    calls.created = payload;
                    return { data: { user: { id: NEW_ID, email: payload.email, user_metadata: payload.user_metadata } }, error: null };
                },
                updateUserById: async (id, payload) => {
                    calls.updated = { id, payload };
                    return s.rotateFails ? { error: new Error('rotate failed') } : { error: null };
                },
                generateLink: async ({ type, email }) => {
                    calls.linkFor = { type, email };
                    return { data: { properties: { hashed_token: 'HASHED_TOKEN_XYZ' } }, error: null };
                }
            }
        },
        from() {
            return {
                upsert: async () => ({ error: null }),
                select() { return this; },
                eq() { return this; },
                single: async () => ({ data: { role: 'user' }, error: null })
            };
        }
    };

    const fetchImpl = async (url) => {
        if (String(url).includes('minepi.com')) {
            calls.piCalled++;
            return s.piTokenValid
                ? { ok: true, status: 200, json: async () => ({ uid: PI_UID, username: 'victim' }) }
                : { ok: false, status: 401, text: async () => 'invalid', json: async () => ({}) };
        }
        throw new Error('unexpected fetch: ' + url);
    };

    return { createClient: () => adminClient, fetchImpl, calls };
}

const req = (body, headers = {}) => new Request('https://stub.local/pi-auth', {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body)
});

test('التوكن الصالح يُصدر جلسة عبر توكن لمرة واحدة، لا كلمة مرور', async () => {
    const env = makeEnv({ piTokenValid: true, userExists: true });
    const res = await loadHandler(env)(req({ accessToken: 'valid-pi-token' }));
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.token_hash, 'HASHED_TOKEN_XYZ');
    assert.equal(env.calls.linkFor.type, 'magiclink');
    assert.ok(!('access_token' in body), 'الرد يحمل جلسة جاهزة بدل توكن لمرة واحدة');
    assert.ok(!('password' in body), 'الرد يسرّب كلمة مرور');
});

test('توكن Pi غير صالح → 401 ولا يُنشأ حساب ولا تُصدر جلسة', async () => {
    const env = makeEnv({ piTokenValid: false, userExists: false });
    const res = await loadHandler(env)(req({ accessToken: 'forged' }));

    assert.equal(res.status, 401);
    assert.equal(env.calls.created, null);
    assert.equal(env.calls.linkFor, null);
});

test('معرفة معرّف Pi وحده لا تُصدر جلسة — التوكن هو الحدّ', async () => {
    // المهاجم يعرف المعرّف العام لكنه لا يملك توكنًا صالحًا.
    const env = makeEnv({ piTokenValid: false, userExists: true });
    const res = await loadHandler(env)(req({ accessToken: 'attacker-guess-from-known-uid' }));

    assert.equal(res.status, 401);
    assert.equal(env.calls.linkFor, null, 'أُصدرت جلسة لمن لا يملك توكنًا');
    assert.equal(env.calls.updated, null);
    assert.equal(env.calls.piCalled, 1, 'لم يُسأل مزوّد Pi أصلًا');
});

test('لا كلمة مرور مشتقة من المعرّف عند الإنشاء', async () => {
    const env = makeEnv({ piTokenValid: true, userExists: false });
    await loadHandler(env)(req({ accessToken: 'valid-pi-token' }));

    const pw = env.calls.created?.password ?? '';
    assert.ok(pw.length >= 32, 'كلمة المرور أقصر من أن تكون عشوائية');
    assert.ok(!pw.includes(PI_UID), 'كلمة المرور مشتقة من معرّف Pi');
    assert.ok(!pw.includes(PI_UID.slice(-8)), 'كلمة المرور تتضمن جزءًا من المعرّف');
});

test('كل تبادل ناجح يُبطل بيانات الاعتماد القديمة (إغلاق المسار القديم لا الالتفاف حوله)', async () => {
    const env = makeEnv({ piTokenValid: true, userExists: true });
    await loadHandler(env)(req({ accessToken: 'valid-pi-token' }));

    assert.ok(env.calls.updated, 'لم تُبطَل بيانات الاعتماد للحساب القائم');
    assert.equal(env.calls.updated.id, EXISTING_ID);
    const pw = env.calls.updated.payload.password ?? '';
    assert.ok(pw.length >= 32 && !pw.includes(PI_UID), 'كلمة المرور الجديدة مشتقة أو ضعيفة');
});

test('فشل إبطال الاعتماد القديم يمنع إصدار الجلسة', async () => {
    // لو لم نستطع قتل الزوج المشتق، إصدار جلسة يعني ترك الثغرة مفتوحة بصمت.
    const env = makeEnv({ piTokenValid: true, userExists: true, rotateFails: true });
    const res = await loadHandler(env)(req({ accessToken: 'valid-pi-token' }));

    assert.equal(res.status, 500);
    assert.equal(env.calls.linkFor, null, 'أُصدرت جلسة رغم بقاء الاعتماد القديم صالحًا');
});

test('الهوية تُشتق من التوكن لا من جسم الطلب', async () => {
    const env = makeEnv({ piTokenValid: true, userExists: false });
    await loadHandler(env)(req({ accessToken: 'valid-pi-token', uid: 'attacker-uid', email: 'attacker@evil.test' }));

    assert.equal(env.calls.created.email, `pi_${PI_UID}@pi.network`);
    assert.equal(env.calls.created.user_metadata.pi_uid, PI_UID);
});

test('البحث بالبريد يمرّ على أكثر من صفحة', async () => {
    const env = makeEnv({ piTokenValid: true, userExists: false });
    await loadHandler(env)(req({ accessToken: 'valid-pi-token' }));
    assert.ok(env.calls.listPages >= 1);
    assert.ok(env.calls.created, 'لم يُنشأ حساب رغم عدم وجوده');
});

test('طلب بلا accessToken مرفوض قبل أي نداء خارجي', async () => {
    const env = makeEnv({ piTokenValid: true, userExists: false });
    const res = await loadHandler(env)(req({}));
    assert.equal(res.status, 400);
    assert.equal(env.calls.piCalled, 0);
});

/* ── حدّ المعدل (103) ─────────────────────────────────────────────────── */

test('حدّ المعدل: الطلب الزائد يُرفض 429 قبل أي نداء لـPi أو بحث في المستخدمين', async () => {
    const env = makeEnv({ piTokenValid: true, userExists: true, limiter: 'deny' });
    const res = await loadHandler(env)(req({ accessToken: 'valid-pi-token' }, { 'cf-connecting-ip': '203.0.113.5' }));
    const body = await res.json();
    assert.equal(res.status, 429);
    assert.equal(body.code, 'RATE_LIMIT_EXCEEDED');
    assert.equal(typeof body.error, 'string', 'عقد الأخطاء: error نصّ');
    assert.equal(res.headers.get('Retry-After'), '60');
    assert.equal(env.calls.piCalled, 0);
    assert.equal(env.calls.listPages, 0);
    assert.equal(env.calls.linkFor, null);
});

test('حدّ المعدل: تعذّر استشارته يفشل مغلقًا (503) ولا تُصدر جلسة', async () => {
    const env = makeEnv({ piTokenValid: true, userExists: true, limiter: 'down' });
    const res = await loadHandler(env)(req({ accessToken: 'valid-pi-token' }));
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, 'RATE_LIMIT_UNAVAILABLE');
    assert.equal(env.calls.piCalled, 0);
    assert.equal(env.calls.linkFor, null);
});

test('حدّ المعدل: الموضوع هو IP المنصة، لا X-Forwarded-For الذي يكتبه المتصل', async () => {
    const env = makeEnv({ piTokenValid: true, userExists: true, limiter: 'allow' });
    await loadHandler(env)(req({ accessToken: 'valid-pi-token' },
        { 'cf-connecting-ip': '198.51.100.20', 'x-forwarded-for': '1.1.1.1', 'x-real-ip': '2.2.2.2' }));
    assert.deepEqual(env.calls.rpc[0], { fn: 'rate_limit_hit', args: { p_policy: 'auth.exchange.ip', p_subject: '198.51.100.20' } });
});

