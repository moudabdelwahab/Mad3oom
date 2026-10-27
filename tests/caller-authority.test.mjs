/**
 * 115: دوال Edge تسأل القاعدة عن سلطة المنادي (is_admin / is_platform_staff) بجلسته، ولا تقارن رتبته حرفيًا.
 *
 *   ① callerHas: النداء الصحيح (REST rpc بمفتاح anon وجلسة المنادي)، و fail-closed على كل فشل
 *   ② لا دالة Edge تفوّض المنادي بمقارنة profiles.role حرفيًا — كانت تردّ مالك المنصة في سياق الإدارة
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { callerHas, CALLER_PREDICATES } from '../supabase/functions/_shared/caller-authority.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const OPTS = { supabaseUrl: 'https://x.supabase.co/', anonKey: 'anon-key' };

function fakeFetch(reply) {
    const calls = [];
    const impl = async (url, init) => {
        calls.push({ url, init });
        if (reply instanceof Error) throw reply;
        return { ok: reply.ok ?? true, json: async () => reply.body };
    };
    return { impl, calls };
}

test('① callerHas ينادي المُسنَد بجلسة المنادي ومفتاح anon، ويقبل true وحدها', async () => {
    const { impl, calls } = fakeFetch({ body: true });
    assert.equal(await callerHas('is_admin', 'Bearer user-jwt', { ...OPTS, fetchImpl: impl }), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://x.supabase.co/rest/v1/rpc/is_admin');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers.apikey, 'anon-key');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer user-jwt', 'جلسة المنادي لا مفتاح الخدمة');

    for (const body of [false, null, 'true', 1, {}]) {
        assert.equal(await callerHas('is_platform_staff', 'Bearer t', { ...OPTS, fetchImpl: fakeFetch({ body }).impl }), false, String(body));
    }
});

test('① fail-closed: بلا جلسة، أو مفتاح، أو رد غير ناجح، أو خطأ شبكة', async () => {
    const yes = fakeFetch({ body: true });
    assert.equal(await callerHas('is_admin', '', { ...OPTS, fetchImpl: yes.impl }), false);
    assert.equal(await callerHas('is_admin', 'Bearer ', { ...OPTS, fetchImpl: yes.impl }), false);
    assert.equal(await callerHas('is_admin', 'Bearer t', { ...OPTS, anonKey: '', fetchImpl: yes.impl }), false);
    assert.equal(await callerHas('is_admin', 'Bearer t', { ...OPTS, supabaseUrl: '', fetchImpl: yes.impl }), false);
    assert.equal(yes.calls.length, 0, 'لا نداء بلا جلسة أو إعداد');
    assert.equal(await callerHas('is_admin', 'Bearer t', { ...OPTS, fetchImpl: fakeFetch({ ok: false, body: true }).impl }), false);
    assert.equal(await callerHas('is_admin', 'Bearer t', { ...OPTS, fetchImpl: fakeFetch(new Error('net')).impl }), false);
});

test('① المُسنَدات قائمة مغلقة', async () => {
    assert.deepEqual([...CALLER_PREDICATES], ['is_admin', 'is_platform_staff']);
    await assert.rejects(() => callerHas('is_platform_owner', 'Bearer t', OPTS), /غير معروف/);
});

/** دوال Edge الحية (بلا المتقاعدة ونسخ التراجع). */
function edgeSources() {
    const dir = path.join(ROOT, 'supabase/functions');
    const out = [];
    const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            if (e.name.startsWith('_retired') || e.name.startsWith('_rollback') || e.name === 'node_modules') continue;
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (/\.(ts|js)$/.test(e.name)) out.push(p);
        }
    };
    walk(dir);
    return out;
}

test('② لا دالة Edge تفوّض المنادي بمقارنة رتبته حرفيًا', () => {
    const offenders = [];
    for (const file of edgeSources()) {
        const src = fs.readFileSync(file, 'utf8');
        const rel = path.relative(ROOT, file);
        // mcp/_shared/actor.ts: هوية مفتاح API (لا جلسة ولا سياق) — خارج نطاق 115 وموثّق في التقرير
        if (rel.endsWith('mcp/_shared/actor.ts')) continue;
        // approve-waitlist-entry: الرتبة ∨ rpc('is_admin') — المُسنَد الواعي بالسياق حاضر، والرتبة فرع زائد لا مانع
        if (rel.endsWith('approve-waitlist-entry/index.ts') && /callerIsAdmin !== true/.test(src)) continue;
        if (/(callerProfile|profile|profileData\[0\])\??\.role\s*(!==|===)\s*["']admin["']/.test(src)
            || /\[\s*["']admin["']\s*,\s*["']support["']\s*\]\.includes\(\s*\w+(\?\.|\.)role\s*\)/.test(src)) {
            offenders.push(rel);
        }
    }
    assert.deepEqual(offenders, [], 'دوال تفوّض بالرتبة الحرفية: ' + offenders.join('، '));
});

test('② الدوال الثماني المصحّحة تسأل القاعدة بالمُسنَد الصحيح', () => {
    const expect = {
        'create-subdomain': 'is_admin', 'manage-subdomain': 'is_admin', 'check-dns-status': 'is_admin',
        'get-attachment-url': 'is_admin', 'sie-channel-telegram': 'is_admin',
        'send-ticket-email': 'is_platform_staff', 'create-template': 'is_platform_staff', 'wf-executor': 'is_platform_staff'
    };
    for (const [fn, predicate] of Object.entries(expect)) {
        const src = fs.readFileSync(path.join(ROOT, `supabase/functions/${fn}/index.ts`), 'utf8');
        assert.match(src, /from ["']\.\.\/_shared\/caller-authority\.js["']/, fn);
        assert.match(src, new RegExp(`callerHas\\(["']${predicate}["']`), `${fn} → ${predicate}`);
    }
});
