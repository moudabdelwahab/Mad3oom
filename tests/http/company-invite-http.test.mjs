/**
 * دعوة عميل الشركة من الطرف إلى الطرف عبر HTTP حقيقي (112):
 *   دالة company-invite-customer (handler.js نفسه) ← PostgREST 12 بـ JWT المدير (company_invite_customer)
 *   ← مفتاح الخدمة (_company_invitation_prepare_email / _email_result) ← المرسل المشترك (_shared/email.js)
 *   بعميل Resend بديل يلتقط الطلب ← الرابط في البريد ← claim ثم القبول بـ JWT المدعو.
 *
 * Resend وحده بديل (لا بريد حقيقي). القاعدة وPostgREST والدوال والمرسل هي الحقيقية.
 * لا شيء يلمس الإنتاج: قاعدة مؤقتة ومعطيات اصطناعية.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { U, createStack, skipReason } from './stack.mjs';
import { handleInvite } from '../../supabase/functions/company-invite-customer/handler.js';
import { emailConfig, sendEmail, RESEND_API_URL } from '../../supabase/functions/_shared/email.js';

const SKIP = skipReason('company-invite-http');
const stack = createStack();
const { psql, http, restClient } = stack;
const FAKE_KEY = 're_fake_' + crypto.randomBytes(12).toString('hex');
const LATE = '0a000000-0000-4000-8000-0000000000aa';

/** Resend بديل: يسجّل الطلبات ويرد بما يُضبط له. */
function fakeResend() {
    const calls = [];
    let next = { status: 200, body: { id: 'em_1' } };
    return {
        calls,
        reply(r) { next = r; },
        fetchImpl: async (url, init) => {
            calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
            const r = next;
            return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
        }
    };
}

function invite(persona, input, { resend, env = { RESEND_API_KEY: FAKE_KEY } } = {}) {
    const mail = emailConfig((k) => env[k]);
    const logs = [];
    return handleInvite(input, {
        userRpc: (name, args) => restClient(persona).rpc(name, args),
        serviceRpc: (name, args) => restClient('service').rpc(name, args),
        send: (message) => sendEmail(message, { config: mail, fetchImpl: resend.fetchImpl }),
        mail,
        siteOrigin: 'https://mad3oom.com',
        log: (e) => logs.push(e)
    }).then(r => ({ ...r, logs }));
}
const tokenFrom = (call) => call.body.html.match(/#token=([0-9a-f]{64})/)?.[1];
const row = (email) => JSON.parse(psql(`select row_to_json(i) from public.company_membership_invitations i where invited_email = '${email}' order by created_at desc limit 1`) || 'null');

test.before(async () => {
    if (SKIP) return;
    await stack.start();
    assert.equal(psql(`select t.owner_sw('multi_company_memberships_enabled', true) ->> 'enabled'`), 'true');
    psql(`update auth.users set email_confirmed_at = now() - interval '30 days'`);
});
test.after(() => { if (!SKIP) stack.stop(); });
const opts = { skip: SKIP || false };

test('النجاح: المزوّد قَبِل ⇒ «sent»، والبريد إلى المدعو برابط mad3oom.com ومرسل موثَّق ومفتاح منع تكرار', opts, async () => {
    const resend = fakeResend();
    const r = await invite('OA', { email: 'Late@Tenancy.test' }, { resend });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, 'sent');
    assert.equal(resend.calls.length, 1);
    const call = resend.calls[0];
    assert.equal(call.url, RESEND_API_URL);
    assert.equal(call.headers.Authorization, `Bearer ${FAKE_KEY}`);
    assert.equal(call.headers['Idempotency-Key'], `company-invite/${r.body.invitation_id}/1`);
    assert.deepEqual(call.body.to, ['late@tenancy.test']);
    assert.equal(call.body.from, 'مدعوم <no-reply@mad3oom.online>', 'بلا EMAIL_SENDER_DOMAIN يبقى النطاق المثبَت');
    assert.match(call.body.subject, /شركة أ/);
    const token = tokenFrom(call);
    assert.ok(token, 'لا رابط برمز');
    assert.ok(call.body.html.includes(`https://mad3oom.com/portal/invite.html#token=${token}`));
    assert.ok(call.body.text.includes(`https://mad3oom.com/portal/invite.html#token=${token}`));
    // الرد للمتصفح بلا رمز ولا مفتاح
    assert.ok(!JSON.stringify(r.body).includes(token) && !JSON.stringify(r.body).includes(FAKE_KEY));
    const db = row('late@tenancy.test');
    assert.deepEqual([db.email_status, db.email_message_id, db.email_attempts], ['sent', 'em_1', 1]);
    assert.equal(db.token_hash, crypto.createHash('sha256').update(token).digest('hex'));
    // لاستعماله في القبول
    psql(`insert into t.saved values ('late_token', '${token}') on conflict (k) do update set v = excluded.v`);
});

test('التكرار: إرسال ثانٍ لنفس البريد لا يرسل بريدًا ثانيًا، وإعادة الإرسال الفورية تنتظر المهلة', opts, async () => {
    const resend = fakeResend();
    const again = await invite('OA', { email: 'late@tenancy.test' }, { resend });
    assert.deepEqual([again.status, again.body.status], [200, 'already_sent']);
    const now = await invite('OA', { email: 'late@tenancy.test', resend: true }, { resend });
    assert.deepEqual([now.status, now.body.status], [429, 'cooldown']);
    assert.equal(resend.calls.length, 0);
    assert.equal(psql(`select count(*) from public.company_membership_invitations where invited_email = 'late@tenancy.test'`), '1');
});

test('رفض المزوّد: لا «نجاح»، رسالة عامة بلا تفاصيل المزوّد، والحالة failed؛ ثم إعادة المحاولة تنجح', opts, async () => {
    const resend = fakeResend();
    resend.reply({ status: 403, body: { statusCode: 403, name: 'validation_error', message: 'The mad3oom.online domain is not verified' } });
    const r = await invite('OA', { email: 'fail@tenancy.test' }, { resend });
    assert.deepEqual([r.status, r.body.status], [502, 'send_failed']);
    assert.match(r.body.error, /تعذّر إرسال البريد/);
    assert.doesNotMatch(JSON.stringify(r.body), /verified|validation_error|403/);
    assert.deepEqual([row('fail@tenancy.test').email_status, row('fail@tenancy.test').email_error], ['failed', 'auth']);
    // السجل الداخلي فيه السبب (بلا الرمز ولا المفتاح ولا البريد)
    const logged = JSON.stringify(r.logs);
    assert.match(logged, /invite_email_failed/);
    assert.match(logged, /not verified/);
    assert.ok(!logged.includes(FAKE_KEY) && !logged.includes('fail@tenancy.test') && !/[0-9a-f]{64}/.test(logged));
    // قائمة الشركة تُظهر الفشل
    const list = await http('OA', 'POST', '/rpc/company_invitations_list', { body: {} });
    assert.equal(list.body.find(i => i.email === 'fail@tenancy.test').email_status, 'failed');
    // إعادة المحاولة بعد المهلة
    psql(`update public.company_membership_invitations set email_last_attempt_at = now() - interval '2 minutes' where invited_email = 'fail@tenancy.test'`);
    resend.reply({ status: 200, body: { id: 'em_2' } });
    const retry = await invite('OA', { email: 'fail@tenancy.test' }, { resend });
    assert.deepEqual([retry.status, retry.body.status], [200, 'sent']);
    assert.equal(resend.calls.at(-1).headers['Idempotency-Key'], `company-invite/${retry.body.invitation_id}/2`);
    assert.equal(row('fail@tenancy.test').email_status, 'sent');
});

test('بلا مفتاح Resend: 503 «not_configured» بلا نداء للمزوّد، والدعوة failed قابلة لإعادة الإرسال', opts, async () => {
    const resend = fakeResend();
    const r = await invite('OA', { email: 'nokey@tenancy.test' }, { resend, env: {} });
    assert.deepEqual([r.status, r.body.status], [503, 'not_configured']);
    assert.equal(resend.calls.length, 0);
    assert.deepEqual([row('nokey@tenancy.test').email_status, row('nokey@tenancy.test').email_error], ['failed', 'not_configured']);
});

test('بريد غير صالح وغير المخوَّلين: لا صف ولا بريد', opts, async () => {
    const resend = fakeResend();
    for (const bad of ['', 'no-at-sign', 'a b@x.test', 'x'.repeat(320) + '@x.test']) {
        const r = await invite('OA', { email: bad }, { resend });
        assert.deepEqual([r.status, r.body.status], [400, 'invalid_email'], bad);
    }
    for (const p of ['A1', 'AS', 'AD', 'anon']) {
        const r = await invite(p, { email: 'x@tenancy.test' }, { resend });
        assert.deepEqual([r.status, r.body.status], [403, 'forbidden'], p);
    }
    assert.equal(resend.calls.length, 0);
    assert.equal(psql(`select count(*) from public.company_membership_invitations where invited_email in ('x@tenancy.test', 'no-at-sign')`), '0');
});

test('لا كاشف لوجود حساب: نفس الرد ونفس البريد لحساب قائم ولبريد بلا حساب', opts, async () => {
    const resend = fakeResend();
    const existing = await invite('OB', { email: 'pu@tenancy.test' }, { resend });
    const none = await invite('OB', { email: 'ghost@tenancy.test' }, { resend });
    assert.deepEqual([existing.status, existing.body.status, Object.keys(existing.body).sort()],
                     [none.status, none.body.status, Object.keys(none.body).sort()]);
    assert.equal(resend.calls.length, 2);
    assert.equal(resend.calls[0].body.subject, resend.calls[1].body.subject);
});

test('القبول من البريد: الرابط يربط صاحب البريد المؤكَّد ثم يقبل = عميل في شركة أ وحدها؛ والحسابات الأخرى لا تستعمله', opts, async () => {
    const token = psql(`select v from t.saved where k = 'late_token'`);
    // الحساب يُنشأ بعد الدعوة (لا حساب وقت الإرسال)
    psql(`insert into auth.users (id, email, email_confirmed_at) values ('${LATE}', 'late@tenancy.test', now());
          insert into public.profiles (id, email, full_name, role, phone, created_at)
          values ('${LATE}', 'late@tenancy.test', 'عميل متأخر', 'user', '01100000031', '2026-09-01')`);
    // حساب آخر معه الرابط = نفس رد الرمز غير الموجود
    const other = await http('A2', 'POST', '/rpc/company_invitation_claim', { body: { p_token: token } });
    const missing = await http('A2', 'POST', '/rpc/company_invitation_claim', { body: { p_token: 'ab'.repeat(32) } });
    assert.deepEqual([other.status, other.body?.code, other.body?.message], [missing.status, missing.body?.code, missing.body?.message]);
    assert.equal((await http('anon', 'POST', '/rpc/company_invitation_claim', { body: { p_token: token } })).status >= 400, true);

    const claim = await http(LATE, 'POST', '/rpc/company_invitation_claim', { body: { p_token: token } });
    assert.equal(claim.status, 200, JSON.stringify(claim.body));
    assert.equal(claim.body.company_name, 'شركة أ');
    const mine = await http(LATE, 'POST', '/rpc/my_company_invitations', { body: {} });
    assert.equal(mine.body[0].id, claim.body.invitation_id);
    const accept = await http(LATE, 'POST', '/rpc/company_invitation_respond', { body: { p_invitation: claim.body.invitation_id, p_accept: true } });
    assert.deepEqual([accept.status, accept.body?.accepted], [200, true]);
    assert.equal(psql(`select string_agg(company_id::text, ',') from public.company_memberships where user_id = '${LATE}' and status = 'active'`), U.CA);
    assert.equal(psql(`select coalesce(public._company_staff_role_of('${U.CA}', '${LATE}'), 'none')`), 'none', 'صار من الفريق');
    // الشركة ترى «مقبولة»، وشركة أخرى لا ترى الدعوة
    const listA = await http('OA', 'POST', '/rpc/company_invitations_list', { body: {} });
    assert.equal(listA.body.find(i => i.id === claim.body.invitation_id).status, 'accepted');
    const listB = await http('OB', 'POST', '/rpc/company_invitations_list', { body: {} });
    assert.ok(!listB.body.some(i => i.id === claim.body.invitation_id));
    // لا رمز ولا تجزئته في أي رد للشركة
    assert.doesNotMatch(JSON.stringify(listA.body), /token|[0-9a-f]{64}/);
});
