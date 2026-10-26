/**
 * company-member-admin — منطق الدالة (handler.js) والقوالب (template.js) بتبعيات بديلة.
 * المسار الكامل عبر PostgREST الحقيقي في tests/http/company-member-admin-http.test.mjs؛ هنا الحالات الحدّية:
 * ترجمة أخطاء القاعدة ونظام الدخول، إعادة نظام الدخول إن رفض الملف، 113 غير مطبَّق، رابط غير صالح، وتهريب القوالب.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleMemberAdmin, mapRpcError, authErrorCode, MESSAGES, RESET_PATH } from '../supabase/functions/company-member-admin/handler.js';
import { passwordResetEmail, accountChangedEmail } from '../supabase/functions/company-member-admin/template.js';

const USER = '0a000000-0000-4000-8000-000000000011';
const CHANGE = '11111111-2222-4333-8444-555555555555';
const CHECK = { changed: true, change_id: CHANGE, user_id: USER, full_name: 'اسم جديد', phone: '+201001112222', email: 'new@example.test',
                old_email: 'old@example.test', old_full_name: 'اسم قديم', email_changed: true, name_changed: true };

function deps(over = {}) {
    const calls = { user: [], service: [], auth: [], link: [], send: [], log: [] };
    const d = {
        userRpc: async (name, args) => {
            calls.user.push([name, args]);
            if (over.userRpc) return over.userRpc(name, args);
            return name === 'company_member_account_check'
                ? { data: CHECK, error: null }
                : { data: { user_id: USER, email: 'member@example.test', company_name: 'شركة <أ>' }, error: null };
        },
        serviceRpc: async (name, args) => {
            calls.service.push([name, args]);
            if (over.serviceRpc) return over.serviceRpc(name, args);
            return { data: args.p_ok ? { status: 'applied', fields: ['full_name', 'phone', 'email'], company_name: 'شركة أ' } : { status: 'failed' }, error: null };
        },
        updateAuthUser: async (id, attrs) => { calls.auth.push([id, attrs]); return over.updateAuthUser ? over.updateAuthUser(id, attrs) : { error: null }; },
        recoveryLink: async (email, redirectTo) => {
            calls.link.push([email, redirectTo]);
            return over.recoveryLink ? over.recoveryLink(email, redirectTo) : { link: 'https://ref.supabase.co/auth/v1/verify?token=abc&type=recovery' };
        },
        send: async (m) => { calls.send.push(m); return over.send ? over.send(m) : { ok: true, id: 'em_1', status: 200 }; },
        mail: { domain: 'mad3oom.com' },
        siteOrigin: over.siteOrigin ?? 'https://mad3oom.com',
        now: () => 1_800_000_000_000,
        log: (e) => calls.log.push(e)
    };
    return { d, calls };
}

test('ترجمة أخطاء القاعدة: كل رمز برسالته، والتفاصيل لا تُعاد كما هي', () => {
    assert.deepEqual(mapRpcError({ code: '42501', details: '{"code": "not_editable", "reason": "not_exclusive"}' }), [403, 'not_editable']);
    assert.deepEqual(mapRpcError({ code: '42501' }), [403, 'forbidden']);
    assert.deepEqual(mapRpcError({ code: 'P0002' }), [404, 'not_found']);
    assert.deepEqual(mapRpcError({ code: '22023', details: '{"reason":"phone"}' }), [400, 'invalid_phone']);
    assert.deepEqual(mapRpcError({ code: '22023', details: '{"reason":"phone_required"}' }), [400, 'phone_required']);
    assert.deepEqual(mapRpcError({ code: '22023', details: 'not json' }), [400, 'invalid_input']);
    assert.deepEqual(mapRpcError({ code: '23505', details: '{"code":"phone_unavailable"}' }), [409, 'phone_unavailable']);
    assert.deepEqual(mapRpcError({ code: '23505' }), [409, 'email_unavailable']);
    assert.deepEqual(mapRpcError({ code: '54000', details: '{"code":"cooldown"}' }), [429, 'cooldown']);
    assert.deepEqual(mapRpcError({ code: '54000' }), [429, 'rate_limited']);
    assert.equal(mapRpcError({ code: 'XX000' }), null);
    assert.equal(authErrorCode({ code: 'email_exists' }), 'email_exists');
    assert.equal(authErrorCode({ message: 'A user with this email address has already been registered' }), 'email_exists');
    assert.equal(authErrorCode({ message: 'Unable to validate email address: invalid format' }), 'email_invalid');
    assert.equal(authErrorCode({ message: 'boom' }), 'auth_update_failed');
    for (const c of ['email_exists', 'email_invalid', 'auth_update_failed']) assert.match(c, /^[a-z_]{1,40}$/);
});

test('طلب غير صالح: لا نداء لأي شيء', async () => {
    for (const input of [null, {}, { action: 'update_account' }, { action: 'update_account', user_id: 'x' }, { action: 'delete', user_id: USER }]) {
        const { d, calls } = deps();
        const r = await handleMemberAdmin(input, d);
        assert.deepEqual([r.status, r.body.status], [400, 'invalid_input'], JSON.stringify(input));
        assert.equal(calls.user.length + calls.service.length + calls.auth.length, 0);
    }
});

test('تعديل الحساب: الترتيب الفحص ← نظام الدخول ← الملف ← الإشعار، والرد بلا البريد القديم', async () => {
    const { d, calls } = deps();
    const r = await handleMemberAdmin({ action: 'update_account', user_id: USER.toUpperCase(), full_name: 'اسم جديد', phone: '01001112222', email: 'New@Example.test' }, d);
    assert.deepEqual(r, { status: 200, body: { status: 'updated', message: MESSAGES.updated, fields: ['full_name', 'phone', 'email'], notice: 'sent' } });
    assert.deepEqual(calls.user, [['company_member_account_check', { p_user: USER, p_full_name: 'اسم جديد', p_phone: '01001112222', p_email: 'New@Example.test' }]]);
    assert.deepEqual(calls.auth, [[USER, { email: 'new@example.test', email_confirm: true, user_metadata: { full_name: 'اسم جديد' } }]]);
    assert.deepEqual(calls.service, [['_company_member_account_apply', { p_change: CHANGE, p_ok: true, p_error: null }]]);
    assert.deepEqual(calls.send.map(m => [m.to, m.idempotencyKey, m.from]),
        [['old@example.test', `member-account/${CHANGE}/0`, 'مدعوم <no-reply@mad3oom.com>'], ['new@example.test', `member-account/${CHANGE}/1`, 'مدعوم <no-reply@mad3oom.com>']]);
    assert.ok(!JSON.stringify(r).includes('old@example.test'));
});

test('رفض الملف بعد تحديث نظام الدخول: يُعاد نظام الدخول لقيمه السابقة، ولا إشعار', async () => {
    const { d, calls } = deps({ serviceRpc: async () => ({ data: { status: 'failed', error: 'scope_changed' }, error: null }) });
    const r = await handleMemberAdmin({ action: 'update_account', user_id: USER, full_name: 'اسم جديد', phone: '01001112222', email: 'new@example.test' }, d);
    assert.deepEqual([r.status, r.body.status], [409, 'conflict']);
    assert.deepEqual(calls.auth[1], [USER, { email: 'old@example.test', email_confirm: true, user_metadata: { full_name: 'اسم قديم' } }]);
    assert.equal(calls.send.length, 0);
});

test('فشل نظام الدخول: يُسجَّل الطلب فاشلًا برمز قصير، ولا كتابة للملف', async () => {
    const { d, calls } = deps({ updateAuthUser: async () => ({ error: { status: 500, message: 'Database error <secret detail>' } }) });
    const r = await handleMemberAdmin({ action: 'update_account', user_id: USER, full_name: 'اسم جديد', phone: '01001112222', email: 'new@example.test' }, d);
    assert.deepEqual([r.status, r.body.status], [502, 'server']);
    assert.deepEqual(calls.service, [['_company_member_account_apply', { p_change: CHANGE, p_ok: false, p_error: 'auth_update_failed' }]]);
    assert.ok(!JSON.stringify(r).includes('secret') && !JSON.stringify(calls.log).includes('secret'));
});

test('113 غير مطبَّق أو رد ناقص: خطأ عام بلا نظام الدخول', async () => {
    const { d, calls } = deps({ userRpc: async () => ({ data: { changed: true }, error: null }) });
    const r = await handleMemberAdmin({ action: 'update_account', user_id: USER, full_name: 'x y', phone: '1', email: 'a@b.c' }, d);
    assert.deepEqual([r.status, r.body.status], [500, 'server']);
    assert.equal(calls.auth.length, 0);
});

test('فشل الإشعار الأمني لا يُفشل التعديل', async () => {
    const { d } = deps({ send: async () => ({ ok: false, code: 'provider_error', status: 500 }) });
    const r = await handleMemberAdmin({ action: 'update_account', user_id: USER, full_name: 'اسم جديد', phone: '01001112222', email: 'new@example.test' }, d);
    assert.deepEqual([r.status, r.body.status, r.body.notice], [200, 'updated', 'failed']);
});

test('رابط الاستعادة: إلى mad3oom.com/reset-password.html، بلا رابط في الرد، ومفتاح منع تكرار لكل 10 دقائق', async () => {
    const { d, calls } = deps();
    const r = await handleMemberAdmin({ action: 'password_reset', user_id: USER }, d);
    assert.deepEqual(r, { status: 200, body: { status: 'reset_sent', message: MESSAGES.reset_sent } });
    assert.deepEqual(calls.link, [['member@example.test', `https://mad3oom.com${RESET_PATH}`]]);
    assert.equal(calls.send[0].to, 'member@example.test');
    assert.equal(calls.send[0].idempotencyKey, `member-reset/${USER}/${Math.floor(1_800_000_000_000 / 600000)}`);
    assert.ok(calls.send[0].html.includes('https://ref.supabase.co/auth/v1/verify?token=abc&amp;type=recovery'));
    assert.ok(calls.send[0].html.includes('شركة &lt;أ&gt;') && !calls.send[0].html.includes('<أ>'));
});

test('رابط الاستعادة: أصل موقع خاطئ، رابط غير https، نظام دخول يرمي، مزوّد غير مهيأ', async () => {
    let { d, calls } = deps({ siteOrigin: 'http://evil.test' });
    assert.deepEqual((await handleMemberAdmin({ action: 'password_reset', user_id: USER }, d)).body.status, 'server');
    assert.equal(calls.user.length, 0);
    ({ d, calls } = deps({ recoveryLink: async () => ({ link: 'javascript:alert(1)' }) }));
    assert.deepEqual((await handleMemberAdmin({ action: 'password_reset', user_id: USER }, d)).body.status, 'send_failed');
    assert.equal(calls.send.length, 0);
    ({ d, calls } = deps({ recoveryLink: async () => { throw new Error('down'); } }));
    assert.deepEqual((await handleMemberAdmin({ action: 'password_reset', user_id: USER }, d)).body.status, 'send_failed');
    ({ d } = deps({ send: async () => ({ ok: false, code: 'not_configured' }) }));
    const r = await handleMemberAdmin({ action: 'password_reset', user_id: USER }, d);
    assert.deepEqual([r.status, r.body.status], [503, 'not_configured']);
});

test('القوالب: تهريب اسم الشركة، بلا محارف تحكم في النص، والإشعار لا يحمل القيم الجديدة', () => {
    const reset = passwordResetEmail({ companyName: 'شركة\n<script>', link: 'https://x.test/v?a=1&b=2' });
    assert.ok(!reset.html.includes('<script>') && reset.html.includes('&lt;script&gt;'));
    assert.ok(reset.html.includes('https://x.test/v?a=1&amp;b=2') && reset.text.includes('https://x.test/v?a=1&b=2'));
    assert.ok(!/[\n\r]/.test(reset.subject));
    const changed = accountChangedEmail({ companyName: 'شركة أ', fields: ['email', 'phone', 'bogus'] });
    assert.match(changed.text, /البريد الإلكتروني، رقم الجوال/);
    assert.ok(!changed.text.includes('bogus'));
    assert.equal(accountChangedEmail({ companyName: '', fields: [] }).text.includes('شركتك'), true);
});

test('index.ts: JWT مطلوب، والمنطق كله في handler.js، ولا سر مضمَّن', () => {
    const src = readFileSync(new URL('../supabase/functions/company-member-admin/index.ts', import.meta.url), 'utf8');
    assert.match(src, /from "\.\/handler\.js"/);
    assert.match(src, /from "\.\.\/_shared\/email\.js"/);
    assert.match(src, /Bearer\\s\+\\S\+/);
    assert.match(src, /generateLink\(\{ type: "recovery"/);
    assert.doesNotMatch(src, /re_[A-Za-z0-9]{16,}|eyJ[A-Za-z0-9_-]{20,}/);
    assert.doesNotMatch(src, /console\.(log|error)\([^)]*(email|link|token)/i);
});
