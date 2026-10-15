// اختبارات حدّ المعدل المشترك للدوال الطرفية (supabase/functions/_shared/rate-limit.js، 103).
//
//   ① الـIP الموثوق: cf-connecting-ip وحده، تزوير X-Forwarded-For / X-Real-IP لا يغيّر الموضوع،
//      IPv6 بالـ/64، IPv4-mapped يُطوى
//   ② القرار: مسموح / مرفوض / observe / فشل مغلق (503) / فشل مفتوح، ولا يُسجَّل الموضوع أبدًا
//   ③ عقد الرد: 429 + Retry-After + RateLimit-*، error نصّ، لا أرقام داخلية
//   ④ الربط: كل دالة تنادي سياستها، السياسات موجودة في 103، ولا limiter يقرأ X-Forwarded-For
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
    trustedClientIp, checkRateLimit, rateLimitHeaders, rateLimitBody, rateLimitResponse,
    restRpcClient, RATE_LIMIT_CODE, RATE_LIMIT_UNAVAILABLE_CODE
} from '../supabase/functions/_shared/rate-limit.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const FN = (p) => fs.readFileSync(path.join(ROOT, 'supabase/functions', p), 'utf8');
const reqWith = (h) => new Request('https://stub.local/x', { headers: h });

const row = (o = {}) => ({
    allowed: true, enforced: true, would_block: false, limit_total: 5, window_seconds: 600,
    remaining: 4, reset_seconds: 120, retry_after: 0, ...o
});
const client = (impl) => ({ calls: [], async rpc(fn, args) { this.calls.push({ fn, args }); return impl(fn, args); } });
const silent = () => { const l = { lines: [], warn: (m) => l.lines.push(m), error: (m) => l.lines.push(m) }; return l; };

/* ── ① IP ─────────────────────────────────────────────────────────────── */

test('IP: cf-connecting-ip هو المصدر الوحيد — الترويسات التي يكتبها المتصل تُتجاهل', () => {
    assert.equal(trustedClientIp(reqWith({ 'cf-connecting-ip': '198.51.100.7', 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '5.6.7.8' })), '198.51.100.7');
    assert.equal(trustedClientIp(reqWith({ 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '5.6.7.8' })), null,
        'بلا ترويسة المنصة لا يُؤخذ IP من غيرها');
    assert.equal(trustedClientIp(reqWith({ 'cf-connecting-ip': 'not-an-ip' })), null);
    assert.equal(trustedClientIp(reqWith({ 'cf-connecting-ip': '999.1.1.1' })), null);
});

test('IP: IPv6 يُجمَّع بالـ/64 فلا يُدار الحد بتدوير العنوان داخل الشبكة نفسها', () => {
    const a = trustedClientIp(reqWith({ 'cf-connecting-ip': '2001:db8:abcd:12::1' }));
    const b = trustedClientIp(reqWith({ 'cf-connecting-ip': '2001:DB8:abcd:12:ffff:ffff:ffff:fffe' }));
    const c = trustedClientIp(reqWith({ 'cf-connecting-ip': '2001:db8:abcd:13::1' }));
    assert.equal(a, '2001:0db8:abcd:0012::/64');
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.equal(trustedClientIp(reqWith({ 'cf-connecting-ip': '::ffff:198.51.100.7' })), '198.51.100.7');
    assert.equal(trustedClientIp(reqWith({ 'cf-connecting-ip': '1::2::3' })), null);
});

/* ── ② القرار ─────────────────────────────────────────────────────────── */

test('القرار: تحت الحد يمر وينادي rate_limit_hit بالسياسة والموضوع فقط', async () => {
    const c = client(async () => ({ data: [row()], error: null }));
    const d = await checkRateLimit(c, 'public.form.ip', '198.51.100.7', { logger: silent() });
    assert.equal(d.allowed, true);
    assert.equal(d.remaining, 4);
    assert.deepEqual(c.calls, [{ fn: 'rate_limit_hit', args: { p_policy: 'public.form.ip', p_subject: '198.51.100.7' } }]);
});

test('القرار: فوق الحد يُرفض بمدة إعادة محاولة، والسجل بلا موضوع', async () => {
    const log = silent();
    const d = await checkRateLimit(client(async () => ({ data: [row({ allowed: false, would_block: true, remaining: 0, retry_after: 117 })], error: null })),
        'public.form.ip', '198.51.100.7', { logger: log });
    assert.equal(d.allowed, false);
    assert.equal(d.retryAfter, 117);
    assert.equal(log.lines.length, 1);
    assert.match(log.lines[0], /"outcome":"rejected"/);
    assert.ok(!log.lines[0].includes('198.51.100.7'), 'الـIP في السجل');
});

test('القرار: observe يمر ويُسجَّل كمراقَب ولا يعلن سقفًا', async () => {
    const log = silent();
    const d = await checkRateLimit(client(async () => ({ data: [row({ allowed: true, enforced: false, would_block: true, remaining: 0 })], error: null })),
        'api.token', 'tok', { logger: log });
    assert.equal(d.allowed, true);
    assert.match(log.lines[0], /"outcome":"observed"/);
    assert.deepEqual(rateLimitHeaders(d), {});
});

test('القرار: تعذّر القاعدة — مغلق افتراضيًا (503)، ومفتوح عند الطلب، والسجل بلا موضوع', async () => {
    const down = client(async () => ({ data: null, error: { message: 'timeout' } }));
    const throws = client(async () => { throw new Error('network'); });
    const log = silent();
    const closed = await checkRateLimit(down, 'auth.exchange.ip', '203.0.113.1', { logger: log });
    assert.equal(closed.allowed, false);
    assert.equal(closed.degraded, true);
    const res = rateLimitResponse(closed);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, RATE_LIMIT_UNAVAILABLE_CODE);
    assert.ok(res.headers.get('Retry-After'));

    const open = await checkRateLimit(throws, 'api.token', 'tok', { failClosed: false, logger: log });
    assert.equal(open.allowed, true);
    assert.equal(open.degraded, true);
    assert.deepEqual(rateLimitHeaders(open), {});
    assert.ok(log.lines.every((l) => !l.includes('203.0.113.1') && !l.includes('tok"')), 'الموضوع في السجل');
    assert.match(log.lines[0], /"fail":"closed"/);
    assert.match(log.lines[1], /"fail":"open"/);
});

test('القرار: صف فارغ يُعامل كتعذّر لا كسماح', async () => {
    const d = await checkRateLimit(client(async () => ({ data: [], error: null })), 'auth.exchange.ip', 'x', { logger: silent() });
    assert.equal(d.allowed, false);
    assert.equal(d.degraded, true);
});

/* ── ③ عقد الرد ───────────────────────────────────────────────────────── */

test('الرد: 429 بـRetry-After وRateLimit-* مقروءة من المتصفح، وerror نصّ، بلا أرقام داخلية', async () => {
    const d = await checkRateLimit(client(async () => ({ data: [row({ allowed: false, would_block: true, remaining: 0, retry_after: 42, reset_seconds: 600 })], error: null })),
        'public.form.ip', 'x', { logger: silent() });
    const res = rateLimitResponse(d, { 'Access-Control-Allow-Origin': '*' });
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('Retry-After'), '42');
    assert.equal(res.headers.get('RateLimit-Limit'), '5');
    assert.equal(res.headers.get('RateLimit-Remaining'), '0');
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
    assert.match(res.headers.get('Access-Control-Expose-Headers'), /Retry-After/);
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ['code', 'error', 'message', 'message_ar', 'retry_after']);
    assert.equal(body.error, RATE_LIMIT_CODE);
    assert.equal(body.code, RATE_LIMIT_CODE);
    assert.equal(body.retry_after, 42);
    assert.deepEqual(rateLimitBody({ retryAfter: 0 }).retry_after, 1, 'Retry-After لا يكون صفرًا');
});

test('restRpcClient: ينادي PostgREST بمفتاح الخدمة ويعيد { data, error } ولا يرمي', async () => {
    const seen = [];
    const ok = restRpcClient('https://p.local/', 'svc', async (url, init) => {
        seen.push({ url, init });
        return { ok: true, status: 200, json: async () => [row()] };
    });
    const r = await ok.rpc('rate_limit_hit', { p_policy: 'a.b', p_subject: 's' });
    assert.equal(seen[0].url, 'https://p.local/rest/v1/rpc/rate_limit_hit');
    assert.equal(seen[0].init.headers.Authorization, 'Bearer svc');
    assert.deepEqual(JSON.parse(seen[0].init.body), { p_policy: 'a.b', p_subject: 's' });
    assert.equal(r.error, null);
    const bad = await restRpcClient('https://p.local', 'svc', async () => ({ ok: false, status: 404, json: async () => ({ message: 'no fn' }) })).rpc('x', {});
    assert.equal(bad.data, null);
    assert.equal(bad.error.code, '404');
    const thrown = await restRpcClient('https://p.local', 'svc', async () => { throw new Error('dns'); }).rpc('x', {});
    assert.equal(thrown.error.message, 'dns');
});

/* ── ④ الربط ──────────────────────────────────────────────────────────── */

const WIRING = [
    // [function file, policy, fail mode]
    ['pi-auth/index.ts', 'auth.exchange.ip', 'closed'],
    ['aqar-auth/index.ts', 'auth.exchange.ip', 'closed'],
    ['landing-contact/index.ts', 'public.form.ip', 'closed'],
    ['oauth-register/index.ts', 'oauth.register.ip', 'closed'],
    ['oauth-authorize/index.ts', 'oauth.authorize.ip', 'closed'],
    ['oauth-authorize/index.ts', 'oauth.authorize.client_ip', 'closed'],
    ['oauth-token/index.ts', 'oauth.token.ip', 'closed'],
    ['oauth-token/index.ts', 'oauth.token.client_ip', 'closed'],
    ['mcp/_shared/api-auth.ts', 'api.token', 'open'],
    ['send-whatsapp/_shared/api-auth.ts', 'api.token', 'open'],
    ['generate-ai-chat-reply/index.ts', 'ai.generate.user', 'closed'],
];

test('الربط: كل دالة تنادي سياستها بنمط الفشل المقصود', () => {
    for (const [file, policy, mode] of WIRING) {
        const src = FN(file);
        const call = new RegExp(`checkRateLimit\\([^;]*["']${policy.replace(/\./g, '\\.')}["'][^;]*\\)`, 's').exec(src);
        assert.ok(call, `${file} لا ينادي ${policy}`);
        assert.equal(/failClosed:\s*false/.test(call[0]), mode === 'open', `${file} ${policy}: نمط الفشل ليس ${mode}`);
        assert.match(src, /from ["'](\.\.\/)+_shared\/rate-limit\.js["']/, `${file} لا يستورد الوحدة المشتركة`);
    }
});

test('الربط: كل سياسة في الكود مزروعة في 103، وكل سياسة مزروعة مستعملة', () => {
    const sql = fs.readFileSync(path.join(ROOT, 'migrations/103_platform_rate_limiting.sql'), 'utf8');
    const seeded = new Set([...sql.matchAll(/^\s*\('([a-z][a-z0-9_.]+)',\s+\d+,\s+\d+,\s+'enforce'/gm)].map((m) => m[1]));
    const used = new Set(WIRING.map((w) => w[1]));
    assert.deepEqual([...used].filter((p) => !seeded.has(p)), [], 'سياسة مستعملة غير مزروعة ⇒ 503 دائم');
    assert.deepEqual([...seeded].filter((p) => !used.has(p)), [], 'سياسة مزروعة لا يستعملها أحد');
});

test('الربط: لا limiter يقرأ X-Forwarded-For، والنسخ المحلية القديمة أُزيلت', () => {
    for (const [file] of WIRING) {
        const src = FN(file);
        assert.ok(!/clientIp\(req\)/.test(src), `${file} ما زال يستعمل clientIp القديم`);
    }
    for (const f of ['oauth-register', 'oauth-token', 'oauth-authorize']) {
        assert.ok(!fs.existsSync(path.join(ROOT, 'supabase/functions', f, '_shared/rate-limit.ts')), `${f}/_shared/rate-limit.ts باقٍ`);
        assert.ok(!/headers\.get\(["']x-forwarded-for["']\)/i.test(FN(`${f}/index.ts`)), `${f} يقرأ X-Forwarded-For`);
    }
    assert.ok(!/headers\.get\(["']x-forwarded-for["']\)/i.test(FN('verify-otp/index.ts')), 'verify-otp يمرّر IP يكتبه المتصل لبوابة المحاولات');
    assert.match(FN('verify-otp/index.ts'), /trustedClientIp\(req\)/);
    // the count-over-usage-logs limiter is gone from both token verifiers
    for (const f of ['mcp/_shared/api-auth.ts', 'send-whatsapp/_shared/api-auth.ts']) {
        assert.ok(!/count:\s*"exact"/.test(FN(f)), `${f} ما زال يعدّ سجل الاستخدام`);
    }
});

test('الربط: الحد يسبق العمل المكلف في كل دالة عامة', () => {
    const order = (file, before, after) => {
        const src = FN(file);
        const a = src.indexOf(before), b = src.indexOf(after);
        assert.ok(a > 0 && b > 0 && a < b, `${file}: ${before} ليس قبل ${after}`);
    };
    order('pi-auth/index.ts', '"auth.exchange.ip"', 'api.minepi.com');
    order('aqar-auth/index.ts', "'auth.exchange.ip'", 'verifyPlatformToken(token)');
    order('landing-contact/index.ts', '"public.form.ip"', 'landing_leads", {');
    order('oauth-register/index.ts', '"oauth.register.ip"', 'from("oauth_clients")');
    order('oauth-token/index.ts', '"oauth.token.ip"', 'await verifyClient(admin');
    order('generate-ai-chat-reply/index.ts', '"ai.generate.user"', 'await checkAiQuota(adminClient');
});
