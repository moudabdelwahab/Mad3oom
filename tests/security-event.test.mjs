/**
 * security-event (121): محاولات الدخول الفاشلة والموقع التقريبي — supabase/functions/security-event/handler.js بلا Deno.
 *
 *   ① الفشل يُسجَّل بـIP من رؤوس الطلب لا من الجسم، بمصدر client_report، وبلا أي حقل غير البريد والسبب
 *   ② حد لكل IP، وتكرار الفشل لبريد ⇒ auth.failed_burst مرة واحدة
 *   ③ الإثراء بجلسة المالك وحدها، وبلا مزوّد مضبوط لا يُرسَل أي IP
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleSecurityEvent, clientIp, isPrivateIp, normalizeGeo, lookupGeo, IP_LIMIT_PER_10_MIN } from '../supabase/functions/security-event/handler.js';

function deps(over = {}) {
    const rows = [];
    return {
        rows,
        d: {
            countIp: async () => 0,
            countFailures: async (email) => rows.filter(r => r.event_type === 'auth.login_failed' && r.target_email === email).length,
            burstLogged: async (email) => rows.some(r => r.event_type === 'auth.failed_burst' && r.target_email === email),
            threshold: async () => 3,
            insert: async (row) => { rows.push(row); },
            ownerGeoPending: async () => null,
            geo: async () => null,
            ...over
        }
    };
}
const H = { 'x-forwarded-for': '203.0.113.5, 10.0.0.1', 'user-agent': 'Mozilla/5.0 Test' };

test('① الفشل: IP من الرؤوس، مصدر client_report، ولا حقول غير البريد والسبب', async () => {
    const { d, rows } = deps();
    const res = await handleSecurityEvent({ body: { action: 'login_failed', email: ' PU@Example.com ', reason: 'invalid_credentials',
        password: 'secret', ip: '1.1.1.1' }, headers: H, deps: d });
    assert.equal(res.status, 200);
    assert.equal(rows.length, 1);
    const r = rows[0];
    assert.equal(r.ip, '203.0.113.5', 'من x-forwarded-for لا من الجسم');
    assert.equal(r.target_email, 'pu@example.com');
    assert.equal(r.source, 'client_report');
    assert.deepEqual(r.details, { reason: 'invalid_credentials', reported_by: 'browser' });
    assert.ok(!JSON.stringify(rows).includes('secret'), 'لا كلمة مرور');
    assert.equal((await handleSecurityEvent({ body: { action: 'login_failed', email: 'nope' }, headers: H, deps: d })).status, 400);
    await handleSecurityEvent({ body: { action: 'login_failed', email: 'a@b.co', reason: 'DROP' }, headers: H, deps: d });
    assert.equal(rows[1].details.reason, 'other', 'سبب خارج القائمة');
    assert.equal((await handleSecurityEvent({ body: { action: 'nuke' }, headers: H, deps: d })).status, 400);
});

test('② حد لكل IP، وتكرار الفشل ⇒ failed_burst مرة واحدة', async () => {
    const { d, rows } = deps({ countIp: async () => IP_LIMIT_PER_10_MIN });
    assert.equal((await handleSecurityEvent({ body: { action: 'login_failed', email: 'a@b.co' }, headers: H, deps: d })).status, 429);
    assert.equal(rows.length, 0);

    const x = deps();
    for (let i = 0; i < 5; i++) await handleSecurityEvent({ body: { action: 'login_failed', email: 'victim@b.co' }, headers: H, deps: x.d });
    const bursts = x.rows.filter(r => r.event_type === 'auth.failed_burst');
    assert.equal(bursts.length, 1);
    assert.equal(bursts[0].severity, 'critical');
    assert.equal(bursts[0].details.failures, 3);
});

test('③ الإثراء: جلسة المالك وحدها، ولا إرسال بلا مزوّد', async () => {
    const { d } = deps();
    assert.equal((await handleSecurityEvent({ body: { action: 'enrich_geo' }, authHeader: 'Bearer x', deps: d })).status, 403);
    const looked = [];
    const ok = deps({ ownerGeoPending: async () => ['203.0.113.5', '198.51.100.7'], geo: async (ip) => { looked.push(ip); return ip === '203.0.113.5' ? { country: 'X' } : null; } });
    const res = await handleSecurityEvent({ body: { action: 'enrich_geo' }, authHeader: 'Bearer owner', deps: ok.d });
    assert.deepEqual(res.body, { ok: true, pending: 2, resolved: 1 });

    let fetched = 0;
    const fetchImpl = async () => { fetched += 1; return { ok: true, json: async () => ({ country_name: 'Egypt' }) }; };
    assert.equal(await lookupGeo('203.0.113.5', { template: '', fetchImpl }), null);
    assert.equal(await lookupGeo('192.168.1.4', { template: 'https://geo.test/{ip}', fetchImpl }), null, 'عنوان خاص');
    assert.equal(fetched, 0, 'لا إرسال');
    assert.deepEqual(await lookupGeo('203.0.113.5', { template: 'https://geo.test/{ip}', fetchImpl }),
        { country: 'Egypt', country_code: null, region: null, city: null, org: null });
    assert.equal(fetched, 1);
});

test('أدوات', () => {
    assert.equal(clientIp({ 'x-forwarded-for': 'garbage' }), null);
    assert.equal(clientIp({ 'cf-connecting-ip': '2001:db8::1' }), '2001:db8::1');
    assert.ok(isPrivateIp('10.1.2.3') && isPrivateIp('172.20.0.1') && isPrivateIp('::1') && !isPrivateIp('8.8.8.8'));
    assert.equal(normalizeGeo({ status: 'fail' }), null);
    assert.deepEqual(normalizeGeo({ country: 'EG', regionName: 'Cairo', city: 'Cairo', isp: 'TE' }),
        { country: 'EG', country_code: 'EG', region: 'Cairo', city: 'Cairo', org: 'TE' });
});
