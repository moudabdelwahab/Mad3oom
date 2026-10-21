/**
 * supabase/functions/_shared/email.js — إعداد Resend الموحَّد ومرسله، بعميل HTTP بديل (لا بريد حقيقي).
 *
 * يثبت: نطاق الإرسال لا يُفترض (mad3oom.online ما لم يُضبط EMAIL_SENDER_DOMAIN)، وصناديق المنصة
 * القديمة تُرسل من النطاق المضبوط، والمرسل لا يرمي ولا يعيد المفتاح ولا رد المزوّد كاملًا،
 * وأن الدوال الثلاث القديمة صارت تمر به وحده.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    emailConfig, senderFor, sendEmail, parseAddress, RESEND_API_URL, LEGACY_SENDER_DOMAIN
} from '../supabase/functions/_shared/email.js';

const KEY = 're_test_' + 'x'.repeat(24);
const env = (vars) => (k) => vars[k];

function fakeFetch(reply) {
    const calls = [];
    const impl = async (url, init) => {
        calls.push({ url, init, body: JSON.parse(init.body) });
        if (reply instanceof Error) throw reply;
        return { ok: reply.status >= 200 && reply.status < 300, status: reply.status,
                 json: async () => { if (reply.body === undefined) throw new Error('no json'); return reply.body; } };
    };
    return { impl, calls };
}

test('الإعداد: بلا نطاق مضبوط = mad3oom.online (النطاق المثبَت)، ولا يُفترض mad3oom.com', () => {
    const c = emailConfig(env({ RESEND_API_KEY: KEY }));
    assert.equal(c.domain, LEGACY_SENDER_DOMAIN);
    assert.equal(c.defaultFrom, 'info@mad3oom.online');
    assert.equal(c.configured, true);
    const com = emailConfig(env({ RESEND_API_KEY: KEY, EMAIL_SENDER_DOMAIN: 'Mad3oom.com' }));
    assert.equal(com.domain, 'mad3oom.com');
    assert.equal(com.defaultFrom, 'info@mad3oom.com');
    // EMAIL_FROM وحده يحدد النطاق (توافق مع الإعداد القائم)
    assert.equal(emailConfig(env({ EMAIL_FROM: 'Mad3oom <info@mad3oom.com>' })).domain, 'mad3oom.com');
    assert.equal(emailConfig(env({ EMAIL_FROM: 'Mad3oom <info@mad3oom.com>' })).defaultFrom, 'Mad3oom <info@mad3oom.com>');
    // EMAIL_FROM على نطاق غير المضبوط لا يُستعمل
    assert.equal(emailConfig(env({ EMAIL_SENDER_DOMAIN: 'mad3oom.com', EMAIL_FROM: 'info@mad3oom.online' })).defaultFrom, 'info@mad3oom.com');
    // قيمة نطاق غير صالحة تُهمل
    assert.equal(emailConfig(env({ EMAIL_SENDER_DOMAIN: 'not a domain' })).domain, LEGACY_SENDER_DOMAIN);
    assert.equal(emailConfig(env({})).configured, false);
    assert.equal(emailConfig(undefined).configured, false);
});

test('المرسل: صناديق المنصة على أي نطاق معروف تُرسَل من النطاق المضبوط، وغيرها مرفوض', () => {
    const online = emailConfig(env({}));
    const com = emailConfig(env({ EMAIL_SENDER_DOMAIN: 'mad3oom.com' }));
    assert.equal(senderFor('support@mad3oom.online', com), 'support@mad3oom.com');
    assert.equal(senderFor('support@mad3oom.com', online), 'support@mad3oom.online');
    assert.equal(senderFor('مدعوم <No-Reply@Mad3oom.com>', com), 'مدعوم <no-reply@mad3oom.com>');
    assert.equal(senderFor('tickets@mad3oom.online', com), 'tickets@mad3oom.com');
    for (const bad of ['ceo@mad3oom.com', 'support@evil.test', 'support@mad3oom.com.evil.test', '', null, 'not-an-email']) {
        assert.equal(senderFor(bad, com), null, String(bad));
    }
    assert.deepEqual(parseAddress('A <x@y.co>'), { name: 'A', address: 'x@y.co' });
    assert.equal(parseAddress('x y@z.co'), null);
});

test('الإرسال الناجح: الطلب كما يتوقعه Resend، ومفتاح منع التكرار، والمعرّف', async () => {
    const config = emailConfig(env({ RESEND_API_KEY: KEY, EMAIL_SENDER_DOMAIN: 'mad3oom.com' }));
    const f = fakeFetch({ status: 200, body: { id: 'em_1' } });
    const r = await sendEmail({ from: 'مدعوم <no-reply@mad3oom.com>', to: 'Customer@Example.test', subject: 'س',
                                html: '<p>x</p>', text: 'x', replyTo: 'r@example.test', idempotencyKey: 'company-invite/1/1' },
                              { config, fetchImpl: f.impl });
    assert.deepEqual(r, { ok: true, id: 'em_1', status: 200 });
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, RESEND_API_URL);
    assert.equal(f.calls[0].init.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(f.calls[0].init.headers['Idempotency-Key'], 'company-invite/1/1');
    assert.deepEqual(f.calls[0].body, { from: 'مدعوم <no-reply@mad3oom.com>', to: ['customer@example.test'], subject: 'س',
                                        html: '<p>x</p>', text: 'x', reply_to: 'r@example.test' });
});

test('الفشل: كل حالة برمز، بلا رمي، وبلا المفتاح أو رد المزوّد الكامل', async () => {
    const config = emailConfig(env({ RESEND_API_KEY: KEY }));
    const msg = { from: 'no-reply@mad3oom.online', to: 'c@example.test', subject: 's', html: 'h' };
    const cases = [
        [{ status: 403, body: { statusCode: 403, name: 'validation_error', message: 'The mad3oom.com domain is not verified' } }, 'auth'],
        [{ status: 401, body: { name: 'missing_api_key', message: 'Missing API key' } }, 'auth'],
        [{ status: 422, body: { name: 'validation_error', message: 'Invalid `to` field' } }, 'rejected'],
        [{ status: 429, body: { name: 'rate_limit_exceeded', message: 'Too many requests' } }, 'rate_limited'],
        [{ status: 409, body: { name: 'invalid_idempotent_request' } }, 'idempotency_conflict'],
        [{ status: 500, body: { name: 'application_error' } }, 'provider_error'],
        [{ status: 502 }, 'provider_error'],
        [{ status: 200, body: {} }, 'provider_error'],
        [new TypeError('fetch failed'), 'network']
    ];
    for (const [reply, code] of cases) {
        const r = await sendEmail(msg, { config, fetchImpl: fakeFetch(reply).impl });
        assert.equal(r.ok, false);
        assert.equal(r.code, code, JSON.stringify(reply.body ?? reply.message));
        assert.ok(!JSON.stringify(r).includes(KEY), 'المفتاح في النتيجة');
        assert.ok((r.detail || '').length <= 300);
    }
    const detail = (await sendEmail(msg, { config, fetchImpl: fakeFetch(cases[0][0]).impl })).detail;
    assert.match(detail, /^403 validation_error: The mad3oom\.com domain is not verified$/);
});

test('بلا مفتاح أو بمستلم أو رسالة غير صالحة: لا نداء للمزوّد', async () => {
    const f = fakeFetch({ status: 200, body: { id: 'x' } });
    const msg = { from: 'no-reply@mad3oom.online', to: 'c@example.test', subject: 's', html: 'h' };
    assert.equal((await sendEmail(msg, { config: emailConfig(env({})), fetchImpl: f.impl })).code, 'not_configured');
    const config = emailConfig(env({ RESEND_API_KEY: KEY }));
    assert.equal((await sendEmail({ ...msg, to: 'bad' }, { config, fetchImpl: f.impl })).code, 'invalid_recipient');
    assert.equal((await sendEmail({ ...msg, to: [] }, { config, fetchImpl: f.impl })).code, 'invalid_recipient');
    assert.equal((await sendEmail({ ...msg, subject: ' ' }, { config, fetchImpl: f.impl })).code, 'invalid_message');
    assert.equal(f.calls.length, 0);
});

test('الدوال القديمة الثلاث تمر بالوحدة المشتركة وحدها: لا fetch مباشر لـ Resend ولا مرسل .online ثابت', () => {
    for (const f of ['send-ticket-email', 'landing-contact', 'wf-executor']) {
        const src = readFileSync(new URL(`../supabase/functions/${f}/index.ts`, import.meta.url), 'utf8');
        assert.match(src, /from "\.\.\/_shared\/email\.js"/, f);
        assert.doesNotMatch(src, /api\.resend\.com\/emails"/, `${f} يرسل مباشرة`);
        assert.doesNotMatch(src, /ALLOWED_SENDERS/, f);
        assert.doesNotMatch(src, /(?:from|FROM_EMAIL|defaultFrom)[^\n]*"[a-z-]+@mad3oom\.online"/, `${f} مرسل .online ثابت`);
        assert.doesNotMatch(src, /re_[A-Za-z0-9]{16,}/, `${f} مفتاح مضمَّن`);
    }
});

test('كل مرسل تعرضه صفحات الإدارة (الإرسال اليدوي وسير العمل) يقبله المرسل المشترك على أي نطاق مضبوط', () => {
    const pages = ['admin/send-email.html', 'admin/automation.html']
        .map(f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'));
    const offered = [...new Set(pages.flatMap(src => [...src.matchAll(/(?:value|from)\s*[:=]\s*["']([a-z-]+@mad3oom\.[a-z]+)["']/g)].map(m => m[1])))];
    assert.ok(offered.length >= 4, offered.join(','));
    for (const domain of ['mad3oom.online', 'mad3oom.com']) {
        const config = emailConfig(env({ EMAIL_SENDER_DOMAIN: domain }));
        for (const addr of offered) assert.equal(senderFor(addr, config), `${addr.split('@')[0]}@${domain}`, `${addr} → ${domain}`);
    }
});
