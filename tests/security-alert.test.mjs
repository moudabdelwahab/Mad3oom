/**
 * security-alert (121): تنبيهات أمان المالك — supabase/functions/security-alert/handler.js بلا Deno.
 *
 *   ① بلا السر الداخلي لا شيء، والأنواع قائمة مغلقة
 *   ② تغيير محجوز: رمزان عشوائيان، بصمتاهما وحدهما تُحفظان (مرة واحدة)، الرابطان يحملان الرمز في الجزء بعد #،
 *      ولا بصمة كلمة مرور ولا رمز تحقق في الرسالة
 *   ③ دخول جديد ورمز استرداد: الرسالة تسمّي الوقت والعنوان والجهاز
 *   ④ فشل الإرسال يُسجَّل ولا يُبلغ نجاحًا
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { handleSecurityAlert, sha256Hex, generateToken, approvalLinks, buildAlertEmail } from '../supabase/functions/security-alert/handler.js';

const REQ = '6f1d2c3b-4a59-4b6c-8d7e-9f0a1b2c3d4e';

function deps(over = {}) {
    const calls = { tokens: [], sent: [], log: [] };
    const d = {
        internalSecret: async () => 'internal-secret',
        loadRequest: async (id) => ({ id, kind: 'password', status: 'pending', requested_at: '2026-11-03T10:00:00Z',
                                      expires_at: '2026-11-03T10:30:00Z', ip: '192.0.2.66', user_agent: 'Mozilla/5.0 Chrome', pending_value: null }),
        setTokens: async (id, a, r) => { calls.tokens.push({ id, a, r }); return calls.tokens.length === 1; },
        loadEvent: async (id) => ({ id, at: '2026-11-03T10:00:00Z', event_type: 'auth.login', ip: '192.0.2.10', user_agent: 'Firefox/131' }),
        loadStepUp: async (id) => ({ id, method: 'recovery_code', started_at: '2026-11-03T10:00:00Z', ip: '192.0.2.10', user_agent: 'Safari', recovery_codes_left: 3 }),
        ownerEmail: async () => 'owner@mad3oom.com',
        geo: async () => ({ country: 'Egypt', city: 'Cairo' }),
        send: async (m) => { calls.sent.push(m); return { ok: true, id: 'e1' }; },
        log: async (type, severity, details) => { calls.log.push({ type, severity, details }); },
        ...over
    };
    return { d, calls };
}
const run = (body, d, secret = 'internal-secret') =>
    handleSecurityAlert({ headerSecret: secret, body, origin: 'https://mad3oom.com', deps: d, cryptoImpl: webcrypto });

test('① بلا السر الداخلي لا شيء، والأنواع مغلقة', async () => {
    const { d, calls } = deps();
    assert.equal((await run({ kind: 'owner_new_login', event_id: 1 }, d, 'wrong')).status, 401);
    assert.equal((await run({ kind: 'owner_new_login', event_id: 1 }, d, null)).status, 401);
    assert.equal((await run({ kind: 'drop_tables' }, d)).status, 400);
    assert.equal((await run({ kind: 'owner_account_change', request: 'not-a-uuid' }, d)).status, 400);
    assert.equal(calls.sent.length, 0);
    const { d: d2 } = deps({ internalSecret: async () => '' });
    assert.equal((await run({ kind: 'owner_new_login', event_id: 1 }, d2, '')).status, 401, 'سر فارغ لا يطابق فارغًا');
});

test('② تغيير محجوز: بصمتا رمزين عشوائيين تُحفظان مرة واحدة، والرابطان بالرمز بعد #', async () => {
    const { d, calls } = deps();
    const res = await run({ kind: 'owner_account_change', request: REQ }, d);
    assert.equal(res.status, 200);
    assert.equal(calls.tokens.length, 1);
    const { a, r } = calls.tokens[0];
    assert.match(a, /^[0-9a-f]{64}$/); assert.match(r, /^[0-9a-f]{64}$/); assert.notEqual(a, r);
    const [mail] = calls.sent;
    assert.equal(mail.to, 'owner@mad3oom.com');
    assert.match(mail.subject, /كلمة المرور/);
    const approve = mail.text.match(/a=approve#t=([^\s]+)/)[1];
    const reject = mail.text.match(/a=reject#t=([^\s]+)/)[1];
    assert.equal(await sha256Hex(decodeURIComponent(approve), webcrypto), a, 'البريد يحمل الرمز الذي حُفظت بصمته');
    assert.equal(await sha256Hex(decodeURIComponent(reject), webcrypto), r);
    assert.ok(!mail.html.includes(a) && !mail.text.includes(a), 'لا بصمة في الرسالة');
    assert.match(mail.text, /192\.0\.2\.66/); assert.match(mail.text, /Cairo/); assert.match(mail.text, /آخر جلسة نشطة/);
    assert.equal(mail.idempotencyKey, `owner-account-change-${REQ}`);
    assert.deepEqual(calls.log.map(l => l.type), ['alert.sent']);

    // تنبيه ثانٍ لنفس الطلب: لا رموز جديدة ولا بريد ثانٍ
    const again = await run({ kind: 'owner_account_change', request: REQ }, d);
    assert.equal(again.status, 409); assert.equal(calls.sent.length, 1);

    // طلب لم يعد معلقًا
    const { d: d2, calls: c2 } = deps({ loadRequest: async (id) => ({ id, status: 'rejected' }) });
    assert.equal((await run({ kind: 'owner_account_change', request: REQ }, d2)).status, 409);
    assert.equal(c2.tokens.length, 0);
});

test('② البريد: يسمّي العنوان المطلوب، ولا يحمل بصمة كلمة مرور', async () => {
    const { d, calls } = deps({ loadRequest: async (id) => ({ id, kind: 'email', status: 'pending', requested_at: '2026-11-03T10:00:00Z',
        expires_at: '2026-11-03T10:30:00Z', ip: null, user_agent: null, pending_value: 'new@example.com' }) });
    await run({ kind: 'owner_account_change', request: REQ }, d);
    assert.match(calls.sent[0].subject, /البريد الإلكتروني/);
    assert.match(calls.sent[0].text, /new@example\.com/);
    assert.match(calls.sent[0].text, /غير متاح/, 'بلا IP');
    const html = buildAlertEmail('owner_account_change', { kind: 'password', request_id: REQ, approve_token: 'a', reject_token: 'b',
        user_agent: '<script>x</script>' }, { origin: 'https://mad3oom.com' }).html;
    assert.ok(!html.includes('<script>x'), 'النص مهرَّب');
});

test('③ دخول جديد ورمز استرداد', async () => {
    const { d, calls } = deps();
    assert.equal((await run({ kind: 'owner_new_login', event_id: 7 }, d)).status, 200);
    assert.match(calls.sent[0].text, /192\.0\.2\.10/); assert.match(calls.sent[0].text, /security\.html#sessions/);
    assert.equal((await run({ kind: 'recovery_code_used', step_up_session: 3 }, d)).status, 200);
    assert.match(calls.sent[1].text, /رموز الاسترداد المتبقية: 3/);
    const { d: d2 } = deps({ loadEvent: async () => ({ id: 1, event_type: 'auth.session_ended' }) });
    assert.equal((await run({ kind: 'owner_new_login', event_id: 1 }, d2)).status, 409, 'حدث ليس دخولًا');
});

test('④ فشل الإرسال يُسجَّل ولا يُبلغ نجاحًا', async () => {
    const { d, calls } = deps({ send: async () => ({ ok: false, code: 'not_configured' }) });
    const res = await run({ kind: 'owner_new_login', event_id: 7 }, d);
    assert.equal(res.status, 502);
    assert.deepEqual(calls.log.map(l => [l.type, l.details.code]), [['alert.failed', 'not_configured']]);
    const { d: d2 } = deps({ ownerEmail: async () => '' });
    assert.equal((await run({ kind: 'owner_new_login', event_id: 7 }, d2)).status, 409);
});

test('الرمز والروابط', () => {
    const a = generateToken(webcrypto), b = generateToken(webcrypto);
    assert.match(a, /^[A-Za-z0-9_-]{43}$/); assert.notEqual(a, b);
    const l = approvalLinks('https://mad3oom.com/', REQ, 'x+y', 'z');
    assert.equal(l.approve, `https://mad3oom.com/owner/security-approval.html?r=${REQ}&a=approve#t=x%2By`);
});
