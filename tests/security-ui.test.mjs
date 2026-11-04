/**
 * 121 — الأجزاء الخالصة في واجهة الأمان:
 *   step-up-fetch.js  الإشارة step_up_required ⇒ نافذة واحدة ثم إعادة الطلب نفسه مرة واحدة
 *   security-model.js حدود السياسة، نتيجة RPC، تجميع المصفوفة، ووصف الأحداث بلا أسرار
 *   user-agent.js     وصف الجهاز للعرض
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStepUpFetch, stepUpSignal } from '../assets/js/security/step-up-fetch.js';
import { policyPayload, rpcOutcome, groupPermissions, eventSummary, eventLabel } from '../assets/js/owner/security-model.js';
import { describeUserAgent } from '../assets/js/security/user-agent.js';

const URL_REST = 'https://x.supabase.co/rest/v1';
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('step-up-fetch: خطأ RLS بـ hint=step_up_required ⇒ النافذة ثم الطلب نفسه', async () => {
    const calls = [];
    let n = 0;
    const baseFetch = async (input, init) => {
        calls.push([input, init?.body]);
        return n++ === 0 ? json(403, { code: '42501', hint: 'step_up_required', message: '«تعديل الإعدادات» يتطلب جلسة تحرير' }) : json(200, [{ id: 1 }]);
    };
    const prompts = [];
    const f = createStepUpFetch({ baseFetch, prompt: async (info) => { prompts.push(info.message); return true; } });
    const res = await f(`${URL_REST}/advanced_settings?id=eq.1`, { method: 'PATCH', body: '{"value":1}' });
    assert.equal(res.status, 200);
    assert.deepEqual(prompts, ['«تعديل الإعدادات» يتطلب جلسة تحرير']);
    assert.deepEqual(calls.map(c => c[1]), ['{"value":1}', '{"value":1}'], 'نفس الجسم مرتين');
});

test('step-up-fetch: رد RPC {ok:false,error:step_up_required} ⇒ النافذة؛ الإلغاء يعيد الرد الأصلي', async () => {
    const baseFetch = async () => json(200, { ok: false, error: 'step_up_required' });
    let asked = 0;
    const f = createStepUpFetch({ baseFetch, prompt: async () => { asked++; return false; } });
    const res = await f(`${URL_REST}/rpc/owner_set_security_policy`, { method: 'POST', body: '{}' });
    assert.equal(asked, 1);
    assert.deepEqual(await res.json(), { ok: false, error: 'step_up_required' }, 'الجسم الأصلي سليم');
});

test('step-up-fetch: لا نافذة لغير الإشارة، ولا لنداء owner_step_up نفسه، ونافذة واحدة للطلبات المتزامنة', async () => {
    let asked = 0;
    const prompt = () => new Promise(r => { asked++; setTimeout(() => r(true), 10); });
    const f1 = createStepUpFetch({ baseFetch: async () => json(403, { code: '42501', hint: 'permission_denied' }), prompt });
    assert.equal((await f1(`${URL_REST}/tickets`)).status, 403);
    const f2 = createStepUpFetch({ baseFetch: async () => json(200, { verified: false, error: 'step_up_required' }), prompt });
    await f2(`${URL_REST}/rpc/owner_step_up`);
    const f3 = createStepUpFetch({ baseFetch: async () => json(200, { ok: false, error: 'step_up_required' }), prompt });
    await f3('https://x.supabase.co/functions/v1/security-event');
    const f4 = createStepUpFetch({ baseFetch: async () => json(200, { ok: false, error: 'step_up_required' }), prompt });
    await f4(`${URL_REST}/rpc/my_function`);   // ليست owner_*
    assert.equal(asked, 0);

    let first = true;
    const f5 = createStepUpFetch({ baseFetch: async () => { const r = first ? json(400, { hint: 'step_up_required' }) : json(200, []); return r; }, prompt });
    const [a, b] = await Promise.all([f5(`${URL_REST}/a`), f5(`${URL_REST}/b`)]);
    assert.equal(asked, 1, 'نافذة واحدة');
    assert.equal(a.status, 400); assert.equal(b.status, 400, 'كلاهما أُعيد بعد التحقق (الرد المزيّف يعيد 400 دائمًا هنا)');
    assert.equal(await stepUpSignal(`${URL_REST}/x`, new Response('not json', { status: 403, headers: { 'content-type': 'text/plain' } })), null);
});

test('السياسة: حدود القاعدة نفسها', () => {
    const base = { passwordLocked: true, emailLocked: true, loginAlerts: true, sharedWindow: 30, failThreshold: 5 };
    assert.deepEqual(policyPayload({ ...base, minutes: '15' }).payload,
        { step_up_minutes: 15, password_change_locked: true, email_change_locked: true, login_alerts: true, shared_ip_window_days: 30, failed_login_threshold: 5 });
    for (const minutes of ['0', '241', '', '7.5', 'x']) assert.equal(policyPayload({ ...base, minutes }).ok, false, minutes);
    assert.equal(policyPayload({ ...base, minutes: 10, sharedWindow: 0 }).ok, false);
    assert.equal(policyPayload({ ...base, minutes: 10, failThreshold: 2 }).ok, false);
});

test('نتيجة RPC، المصفوفة، ووصف الأحداث', () => {
    assert.deepEqual(rpcOutcome({ data: { ok: true }, error: null }).ok, true);
    assert.match(rpcOutcome({ data: { ok: false, error: 'forbidden' } }).message, /لمالك المنصة/);
    assert.match(rpcOutcome({ data: { ok: false, error: 'already_approved' } }).message, /من قبل/);
    assert.equal(rpcOutcome({ error: { message: 'boom' } }).message, 'boom');
    const g = groupPermissions([{ key: 'a.b', category: 'users' }, { key: 'c.d', category: 'platform' }, { key: 'e.f', category: 'users' }]);
    assert.deepEqual(g.map(x => [x.label, x.items.length]), [['المستخدمون', 2], ['المنصة', 1]]);
    assert.equal(eventLabel('auth.login'), 'دخول ناجح');
    assert.equal(eventLabel('unknown.type'), 'unknown.type');
    assert.match(eventSummary({ event_type: 'ip.shared', details: { other_accounts: [1, 2], window_days: 30 } }), /2 حساب/);
    assert.match(eventSummary({ event_type: 'step_up.verified', details: { method: 'recovery_code', minutes: 5 } }), /رمز استرداد/);
});

test('وصف الجهاز', () => {
    assert.equal(describeUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36').label, 'Chrome 130 · Windows 10/11');
    const iphone = describeUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1');
    assert.equal(iphone.browser, 'Safari 17'); assert.equal(iphone.os, 'iOS 17.5'); assert.equal(iphone.device, 'جوال');
    assert.equal(describeUserAgent('Mozilla/5.0 (X11; Linux x86_64) Firefox/131.0').label, 'Firefox 131 · Linux');
    assert.equal(describeUserAgent('Mozilla/5.0 (Windows NT 10.0) Chrome/130 Edg/130.0').browser, 'Edge 130');
    assert.equal(describeUserAgent('curl/8.4.0').device, 'برنامج / API');
    assert.equal(describeUserAgent('').label, 'غير معروف');
});
