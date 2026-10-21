/**
 * company-invite-customer — منطق الدالة (handler.js) وقالب البريد (template.js) بتبعيات بديلة.
 * المسار الكامل عبر PostgREST الحقيقي في tests/http/company-invite-http.test.mjs؛ هنا الحالات الحدّية:
 * ترجمة أخطاء القاعدة، 112 غير مطبَّق، أصل موقع خاطئ، مرسل يرمي، نتيجة لم تُسجَّل، وتهريب القالب.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleInvite, inviteOrigin, MESSAGES, INVITE_PATH } from '../supabase/functions/company-invite-customer/handler.js';
import { inviteEmail } from '../supabase/functions/company-invite-customer/template.js';

const ID = '11111111-2222-4333-8444-555555555555';
const TOKEN = 'ab'.repeat(32);

function deps(over = {}) {
    const calls = { user: [], service: [], send: [], log: [] };
    const d = {
        userRpc: async (name, args) => { calls.user.push([name, args]); return over.userRpc ? over.userRpc(name, args) : { data: { status: 'pending', invitation_id: ID }, error: null }; },
        serviceRpc: async (name, args) => {
            calls.service.push([name, args]);
            if (over.serviceRpc) return over.serviceRpc(name, args);
            return name === '_company_invitation_prepare_email'
                ? { data: { send: true, token: TOKEN, email: 'c@example.test', company_name: 'شركة <أ>', expires_at: '2026-10-28T00:00:00Z', attempt: 1 }, error: null }
                : { data: { recorded: true }, error: null };
        },
        send: async (m) => { calls.send.push(m); return over.send ? over.send(m) : { ok: true, id: 'em_1', status: 200 }; },
        mail: { domain: 'mad3oom.com' },
        siteOrigin: over.siteOrigin ?? 'https://mad3oom.com',
        log: (e) => calls.log.push(e)
    };
    return { d, calls };
}

test('النجاح: الرسالة كاملة والنتيجة مسجَّلة، والرد بلا رمز', async () => {
    const { d, calls } = deps();
    const r = await handleInvite({ email: ' C@Example.test ' }, d);
    assert.deepEqual(r, { status: 200, body: { status: 'sent', message: MESSAGES.sent, invitation_id: ID } });
    assert.deepEqual(calls.user, [['company_invite_customer', { p_email: 'c@example.test' }]]);
    assert.deepEqual(calls.service[0], ['_company_invitation_prepare_email', { p_invitation: ID, p_resend: false }]);
    assert.deepEqual(calls.service[1], ['_company_invitation_email_result', { p_invitation: ID, p_ok: true, p_message_id: 'em_1', p_error: null }]);
    const m = calls.send[0];
    assert.equal(m.from, 'مدعوم <no-reply@mad3oom.com>');
    assert.equal(m.to, 'c@example.test');
    assert.equal(m.idempotencyKey, `company-invite/${ID}/1`);
    assert.ok(m.html.includes(`https://mad3oom.com${INVITE_PATH}#token=${TOKEN}`));
    assert.ok(m.html.includes('شركة &lt;أ&gt;') && !m.html.includes('شركة <أ>'), 'اسم الشركة غير مهرَّب');
    assert.ok(!JSON.stringify(r).includes(TOKEN));
});

test('أخطاء القاعدة تُترجم، ولا تحضير ولا بريد بعدها', async () => {
    for (const [code, status, key] of [['42501', 403, 'forbidden'], ['0A000', 409, 'feature_disabled'], ['54000', 429, 'too_many_pending'], ['22023', 400, 'invalid_email'], ['XX000', 500, 'server']]) {
        const { d, calls } = deps({ userRpc: () => ({ data: null, error: { code, message: 'internal detail' } }) });
        const r = await handleInvite({ email: 'c@example.test' }, d);
        assert.deepEqual([r.status, r.body.status, r.body.error], [status, key, MESSAGES[key]], code);
        assert.doesNotMatch(JSON.stringify(r), /internal detail/);
        assert.equal(calls.service.length + calls.send.length, 0, code);
    }
});

test('112 غير مطبَّق (بلا معرّف دعوة) أو أصل موقع غير https: خطأ خادم بلا بريد', async () => {
    const old = deps({ userRpc: () => ({ data: { status: 'pending' }, error: null }) });
    assert.equal((await handleInvite({ email: 'c@example.test' }, old.d)).status, 500);
    assert.equal(old.calls.send.length, 0);
    assert.match(JSON.stringify(old.calls.log), /no_invitation_id/);
    for (const bad of ['http://mad3oom.com', 'javascript:alert(1)', '', 'not a url']) {
        const x = deps({ siteOrigin: bad });
        assert.equal((await handleInvite({ email: 'c@example.test' }, x.d)).status, 500, bad);
        assert.equal(x.calls.user.length, 0, bad);
    }
    assert.equal(inviteOrigin('https://mad3oom.com/some/path?q=1'), 'https://mad3oom.com');
});

test('التحضير يرفض: الحالة كما هي بلا بريد؛ ورمز غير صالح من القاعدة لا يُرسل', async () => {
    for (const [reason, status] of [['already_sent', 200], ['cooldown', 429], ['in_flight', 409], ['too_many_attempts', 429], ['company_daily_cap', 429], ['not_pending', 409], ['weird', 500]]) {
        const { d, calls } = deps({ serviceRpc: () => ({ data: { send: false, reason }, error: null }) });
        const r = await handleInvite({ email: 'c@example.test', resend: true }, d);
        assert.equal(r.status, status, reason);
        assert.equal(calls.send.length, 0, reason);
        assert.equal(calls.service[0][1].p_resend, true);
    }
    const bad = deps({ serviceRpc: (n) => n === '_company_invitation_prepare_email'
        ? { data: { send: true, token: 'short', email: 'c@example.test', attempt: 1 }, error: null } : { data: { recorded: true }, error: null } });
    assert.equal((await handleInvite({ email: 'c@example.test' }, bad.d)).status, 500);
    assert.equal(bad.calls.send.length, 0);
    assert.deepEqual(bad.calls.service[1][1].p_ok, false, 'المحاولة لم تُغلق failed');
});

test('المرسل يرمي أو يرفض: failed مسجَّلة، 502 برسالة عامة؛ والنتيجة غير المسجَّلة تُسجَّل في السجل', async () => {
    const thrown = deps({ send: () => { throw new Error('boom'); } });
    const r = await handleInvite({ email: 'c@example.test' }, thrown.d);
    assert.deepEqual([r.status, r.body.status], [502, 'send_failed']);
    assert.deepEqual(thrown.calls.service[1][1], { p_invitation: ID, p_ok: false, p_message_id: null, p_error: 'network' });
    const lost = deps({ serviceRpc: (n) => n === '_company_invitation_prepare_email'
        ? { data: { send: true, token: TOKEN, email: 'c@example.test', attempt: 2 }, error: null }
        : { data: null, error: { code: 'XX' } } });
    const r2 = await handleInvite({ email: 'c@example.test' }, lost.d);
    assert.equal(r2.body.status, 'sent', 'قَبِل المزوّد: الرد صادق حتى لو تعذّر التسجيل');
    assert.match(JSON.stringify(lost.calls.log), /invite_result_not_recorded/);
});

test('القالب: عربي RTL، الرابط في الزر والنص، وتاريخ الانتهاء، وبلا HTML من الإدخال', () => {
    const link = `https://mad3oom.com${INVITE_PATH}#token=${TOKEN}`;
    const e = inviteEmail({ companyName: '<img src=x onerror=alert(1)>', link, expiresAt: '2026-10-28T00:00:00Z' });
    assert.match(e.html, /dir="rtl"/);
    assert.ok(!e.html.includes('<img src=x'));
    assert.ok(e.html.includes(`href="${link}"`));
    assert.ok(e.text.includes(link));
    assert.match(e.html, /٢٠٢٦|2026/);
    assert.equal(inviteEmail({ companyName: 'أ\r\nBcc: x@evil.test', link }).subject, 'دعوة للانضمام إلى أ Bcc: x@evil.test على مدعوم');
    const empty = inviteEmail({ companyName: '  ', link, expiresAt: 'bad' });
    assert.equal(empty.subject, 'دعوة للانضمام إلى شركة على مدعوم');
    assert.doesNotMatch(empty.html + empty.text, /تنتهي صلاحية/, 'تاريخ غير صالح لا يُكتب');
});

test('index.ts: Deno.serve يحقن التبعيات الحقيقية، بلا مفتاح أو رمز في الكود', () => {
    const src = readFileSync(new URL('../supabase/functions/company-invite-customer/index.ts', import.meta.url), 'utf8');
    assert.match(src, /from "\.\.\/_shared\/email\.js"/);
    assert.match(src, /userClient\.rpc\(name, args\)/);
    assert.match(src, /adminClient\.rpc\(name, args\)/);
    assert.match(src, /PUBLIC_SITE_ORIGIN"\) \?\? "https:\/\/mad3oom\.com"/);
    assert.doesNotMatch(src, /re_[A-Za-z0-9]{16,}|api\.resend\.com/);
});
