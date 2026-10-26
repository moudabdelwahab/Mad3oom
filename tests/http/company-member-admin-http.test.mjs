/**
 * إدارة حساب عضو الشركة من الطرف إلى الطرف عبر HTTP حقيقي (113):
 *   دالة company-member-admin (handler.js نفسه) ← PostgREST 12 بـ JWT المدير (company_member_account_check /
 *   company_member_password_reset_check) ← نظام دخول بديل (يكتب auth.users كما يفعل GoTrue) ←
 *   مفتاح الخدمة (_company_member_account_apply) ← المرسل المشترك (_shared/email.js) بعميل Resend بديل.
 *
 * نظام الدخول وResend وحدهما بديلان (لا بريد حقيقي). القاعدة وPostgREST والدوال والمرسل هي الحقيقية.
 * لا شيء يلمس الإنتاج: قاعدة مؤقتة ومعطيات اصطناعية.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { U, createStack, skipReason } from './stack.mjs';
import { handleMemberAdmin } from '../../supabase/functions/company-member-admin/handler.js';
import { emailConfig, sendEmail } from '../../supabase/functions/_shared/email.js';

const SKIP = skipReason('company-member-admin-http');
const stack = createStack();
const { psql, restClient } = stack;
const FAKE_KEY = 're_fake_' + crypto.randomBytes(12).toString('hex');
const sq = (v) => `'${String(v).replace(/'/g, "''")}'`;

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

/** نظام دخول بديل: يكتب auth.users كما يفعل GoTrue (ومحفّز sync_profile_from_auth يعمل كما في الإنتاج). */
function fakeAuth({ failWith } = {}) {
    const calls = [];
    return {
        calls,
        updateAuthUser: async (id, attrs) => {
            calls.push(['update', id, attrs]);
            if (failWith) return { error: failWith };
            const sets = [];
            if (attrs.email) sets.push(`email = ${sq(attrs.email)}`, 'email_confirmed_at = now()');
            if (attrs.user_metadata) sets.push(`raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || ${sq(JSON.stringify(attrs.user_metadata))}::jsonb`);
            if (sets.length) psql(`update auth.users set ${sets.join(', ')} where id = ${sq(id)}`);
            return { error: null };
        },
        recoveryLink: async (email, redirectTo) => {
            calls.push(['link', email, redirectTo]);
            return { link: `https://project.supabase.co/auth/v1/verify?token=${'r'.repeat(40)}&type=recovery&redirect_to=${encodeURIComponent(redirectTo)}` };
        }
    };
}

function admin(persona, input, { resend = fakeResend(), auth = fakeAuth(), env = { RESEND_API_KEY: FAKE_KEY } } = {}) {
    const mail = emailConfig((k) => env[k]);
    const logs = [];
    return handleMemberAdmin(input, {
        userRpc: (name, args) => restClient(persona).rpc(name, args),
        serviceRpc: (name, args) => restClient('service').rpc(name, args),
        updateAuthUser: auth.updateAuthUser,
        recoveryLink: auth.recoveryLink,
        send: (message) => sendEmail(message, { config: mail, fetchImpl: resend.fetchImpl }),
        mail,
        siteOrigin: 'https://mad3oom.com',
        log: (e) => logs.push(e)
    }).then(r => ({ ...r, logs, resend, auth }));
}
const profile = (id) => JSON.parse(psql(`select row_to_json(x) from (select full_name, phone, email from public.profiles where id = ${sq(id)}) x`));
const authEmail = (id) => psql(`select email from auth.users where id = ${sq(id)}`);

test.before(async () => {
    if (SKIP) return;
    await stack.start();
    psql(`update auth.users set email_confirmed_at = now() - interval '30 days'`);
    // create-sub-user يضع العلامة لحسابات أنشأتها الشركة
    psql(`update auth.users set raw_app_meta_data = '{"company_created": true}' where id in ('${U.A1}', '${U.B1}')`);
});
test.after(() => { if (!SKIP) stack.stop(); });
const opts = { skip: SKIP || false };

test('تعديل الحساب: الاسم والجوال والبريد يتغيرون في نظام الدخول والملف معًا، والعضو يُبلَّغ على بريديه', opts, async () => {
    const r = await admin('OA', { action: 'update_account', user_id: U.A1, full_name: 'عميل أ1 المعدّل', phone: '0100 777 6666', email: 'A1.New@Tenancy.test' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, 'updated');
    assert.deepEqual(r.body.fields, ['full_name', 'phone', 'email']);
    assert.equal(r.body.notice, 'sent');
    assert.deepEqual(profile(U.A1), { full_name: 'عميل أ1 المعدّل', phone: '+201007776666', email: 'a1.new@tenancy.test' });
    assert.equal(authEmail(U.A1), 'a1.new@tenancy.test');
    assert.deepEqual(r.auth.calls[0], ['update', U.A1, { email: 'a1.new@tenancy.test', email_confirm: true, user_metadata: { full_name: 'عميل أ1 المعدّل' } }]);
    // الإشعار الأمني: للبريد القديم والجديد، بلا القيم الجديدة
    assert.deepEqual(r.resend.calls.map(c => c.body.to[0]), ['a1@tenancy.test', 'a1.new@tenancy.test']);
    for (const c of r.resend.calls) {
        assert.ok(!c.body.html.includes('a1.new@tenancy.test') && !c.body.html.includes('7776666'), 'القيمة الجديدة في الإشعار');
        assert.match(c.body.subject, /تغيّرت بيانات حسابك/);
    }
    assert.equal(psql(`select count(*) from public.notifications where user_id = '${U.A1}' and title = 'تحديث بيانات حسابك'`), '1');
    // الرد للمتصفح بلا مفتاح ولا بريد قديم
    assert.ok(!JSON.stringify(r.body).includes(FAKE_KEY) && !JSON.stringify(r.body).includes('a1@tenancy.test'));
    // بلا تغيير: لا نداء لنظام الدخول ولا بريد
    const again = await admin('OA', { action: 'update_account', user_id: U.A1, full_name: 'عميل أ1 المعدّل', phone: '+201007776666', email: 'a1.new@tenancy.test' });
    assert.equal(again.body.status, 'unchanged');
    assert.equal(again.auth.calls.length, 0);
    assert.equal(again.resend.calls.length, 0);
});

test('الاسم والجوال وحدهما: لا تغيير لبريد الدخول، والإشعار للبريد الحالي؛ والجوال لا يُحذف', opts, async () => {
    const cleared = await admin('OA', { action: 'update_account', user_id: U.A1, full_name: 'عميل أ1', phone: '', email: 'a1.new@tenancy.test' });
    assert.deepEqual([cleared.status, cleared.body.status], [400, 'phone_required'], 'حذف الجوال يوقف الحساب في بوابة الحساب');
    assert.equal(cleared.auth.calls.length, 0);
    const r = await admin('OA', { action: 'update_account', user_id: U.A1, full_name: 'عميل أ1', phone: '01005554444', email: 'a1.new@tenancy.test' });
    assert.equal(r.body.status, 'updated', JSON.stringify(r.body));
    assert.deepEqual(r.body.fields, ['full_name', 'phone']);
    assert.deepEqual(r.auth.calls[0][2], { user_metadata: { full_name: 'عميل أ1' } });
    assert.equal(profile(U.A1).phone, '+201005554444');
    assert.equal(psql(`select public._inbox_account_active('${U.A1}')`), 't', 'الحساب بقي مفعّلًا');
    assert.deepEqual(r.resend.calls.map(c => c.body.to[0]), ['a1.new@tenancy.test']);
});

test('الرفض قبل نظام الدخول: غير المدير، والشركة الأخرى، وحساب لم تنشئه الشركة، وبريد أو رقم مستعمل', opts, async () => {
    const cases = [
        ['A2', U.A1, 403, 'forbidden'],
        ['AS', U.A1, 403, 'forbidden'],
        ['OB', U.A1, 404, 'not_found'],
        ['OA', U.A2, 403, 'not_editable']
    ];
    for (const [who, target, status, code] of cases) {
        const r = await admin(who, { action: 'update_account', user_id: target, full_name: 'اسم ما', phone: '01009990000', email: 'z@tenancy.test' });
        assert.equal(r.status, status, `${who}→${target}: ${JSON.stringify(r.body)}`);
        assert.equal(r.body.status, code);
        assert.equal(r.auth.calls.length, 0, 'وصل نظام الدخول');
    }
    let r = await admin('OA', { action: 'update_account', user_id: U.A1, full_name: 'عميل أ1', phone: '01005554444', email: 'a2@tenancy.test' });
    assert.deepEqual([r.status, r.body.status], [409, 'email_unavailable']);
    r = await admin('OA', { action: 'update_account', user_id: U.A1, full_name: 'عميل أ1', phone: '01100000012', email: 'a1.new@tenancy.test' });
    assert.deepEqual([r.status, r.body.status], [409, 'phone_unavailable']);
    r = await admin('OA', { action: 'update_account', user_id: U.A1, full_name: 'عميل أ1', phone: 'abc', email: 'a1.new@tenancy.test' });
    assert.deepEqual([r.status, r.body.status], [400, 'invalid_phone']);
    r = await admin('OA', { action: 'update_account', user_id: 'not-a-uuid', full_name: 'x', email: 'x@y.z' });
    assert.deepEqual([r.status, r.body.status], [400, 'invalid_input']);
    assert.equal(authEmail(U.A1), 'a1.new@tenancy.test');
});

test('فشل نظام الدخول: لا تغيير في الملف، والطلب مسجَّل فاشلًا برمز، والرسالة عامة', opts, async () => {
    const auth = fakeAuth({ failWith: { status: 422, code: 'email_exists', message: 'A user with this email address has already been registered' } });
    const r = await admin('OA', { action: 'update_account', user_id: U.A1, full_name: 'عميل أ1', phone: '01005554444', email: 'ghost@tenancy.test' }, { auth });
    assert.deepEqual([r.status, r.body.status], [409, 'email_unavailable']);
    assert.equal(profile(U.A1).email, 'a1.new@tenancy.test');
    assert.equal(psql(`select status || ':' || error from public.company_member_account_changes order by requested_at desc limit 1`), 'failed:email_exists');
    assert.ok(!JSON.stringify(r.body).includes('already been registered'));
});

test('رابط إعادة كلمة المرور: لبريد العضو برابط الاستعادة إلى mad3oom.com، والرابط لا يعود للمتصفح؛ ثم المهلة', opts, async () => {
    const r = await admin('OB', { action: 'password_reset', user_id: U.B1 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, 'reset_sent');
    assert.deepEqual(r.auth.calls[0], ['link', 'b1@tenancy.test', 'https://mad3oom.com/reset-password.html']);
    assert.equal(r.resend.calls.length, 1);
    const mail = r.resend.calls[0];
    assert.deepEqual(mail.body.to, ['b1@tenancy.test']);
    assert.ok(mail.body.html.includes('type=recovery'));
    assert.match(mail.headers['Idempotency-Key'], new RegExp(`^member-reset/${U.B1}/\\d+$`));
    assert.ok(!JSON.stringify(r.body).includes('verify?token') && !JSON.stringify(r.body).includes('b1@tenancy.test'));
    const again = await admin('OB', { action: 'password_reset', user_id: U.B1 });
    assert.deepEqual([again.status, again.body.status], [429, 'cooldown']);
    assert.equal(again.auth.calls.length, 0);
    // شركة أخرى ومشرف: لا رابط
    for (const who of ['OA', 'BS']) {
        const x = await admin(who, { action: 'password_reset', user_id: U.B1 });
        assert.ok([403, 404].includes(x.status), `${who}: ${x.status}`);
        assert.equal(x.auth.calls.length, 0);
    }
});

test('رابط الاستعادة وفشل المزوّد: لا «نجاح»، ورسالة عامة', opts, async () => {
    const resend = fakeResend();
    resend.reply({ status: 403, body: { name: 'validation_error', message: 'domain is not verified' } });
    const r = await admin('OA', { action: 'password_reset', user_id: U.A1 }, { resend });
    assert.deepEqual([r.status, r.body.status], [502, 'send_failed']);
    assert.ok(!JSON.stringify(r.body).includes('verified'));
    const nokey = await admin('OB', { action: 'password_reset', user_id: U.BS }, { env: {} });
    assert.ok(['not_configured', 'target_inactive'].includes(nokey.body.status), JSON.stringify(nokey.body));
});
