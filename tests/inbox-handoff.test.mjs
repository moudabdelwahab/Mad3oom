/**
 * Phase 2 (059): «رجّع المحادثة للبوت» في صندوق الرسائل.
 *
 * الضمان نفسه في قاعدة البيانات (tests/sql/handoff-guarantee.test.sql).
 * الاختبار ده بيثبت إن الواجهة ماشية على العقد:
 *   - الزرار بينادي المسارات الرسمية بس (inbox_take_over / inbox_return_to_ai)
 *   - مفيش أي كود عميل (صندوق الدعم أو ويدجت العميل) بيكتب is_manual_mode مباشرة
 *   - أحداث التسليم بتتعرض بكلام مفهوم في الخط الزمني
 *   - الدوال اللي الواجهة بتناديها موجودة فعلًا في الترحيل وممنوحة للموظفين
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8');

test('the data layer calls only the audited server paths', async () => {
    const data = await read('assets/js/admin/inbox-data.js');
    assert.match(data, /export const takeOver = [^;]*rpc\('inbox_take_over', \{ p_session: sessionId, p_reason: reason \}\)/s);
    assert.match(data, /export const returnToAi = [^;]*rpc\('inbox_return_to_ai', \{ p_session: sessionId, p_reason: reason \}\)/s);
});

test('the button is wired to setHandoff, which reflects the server result only', async () => {
    const ui = await read('assets/js/admin/inbox.js');
    assert.match(ui, /data-return-ai/);
    assert.match(ui, /data-take-over/);
    assert.match(ui, /\[data-return-ai\]'\)\?\.addEventListener\('click', \(\) => setHandoff\(session\.id, false\)\)/);
    assert.match(ui, /\[data-take-over\]'\)\?\.addEventListener\('click', \(\) => setHandoff\(session\.id, true\)\)/);
    const fn = ui.slice(ui.indexOf('async function setHandoff'), ui.indexOf('async function toggleTag'));
    assert.ok(fn.indexOf('await takeOver') > 0 && fn.indexOf('await returnToAi') > 0);
    // الحالة المحلية بتتغير بعد نجاح النداء بس
    assert.ok(fn.indexOf('session.is_manual_mode = toHuman') > fn.indexOf('await returnToAi'));
    assert.ok(fn.indexOf('session.is_manual_mode = toHuman') < fn.indexOf('catch (err)'));
});

test('no client code writes is_manual_mode directly', async () => {
    const files = ['assets/js/admin/inbox.js', 'assets/js/admin/inbox-data.js', 'chat-widget.js',
        'assets/js/chat-logic.js', 'admin-chat-dashboard.js', 'chat-service.js'];
    for (const f of files) {
        const src = await read(f);
        assert.ok(!/\.(update|upsert|insert)\(\s*\{[^}]*is_manual_mode/s.test(src), `${f} writes is_manual_mode`);
    }
});

test('handoff events read as sentences, and internal reason codes are not shown', async () => {
    const { describeEvent } = await import('../assets/js/admin/inbox-model.js');
    const names = { actor: () => 'منى' };
    const line = (kind, payload) => describeEvent({ kind, payload }, names);
    assert.equal(line('handoff_to_human', { source: 'inbox_reply', reason: 'human_reply' }), 'منى مسك المحادثة بالرد — البوت وقف');
    assert.equal(line('handoff_to_human', { source: 'inbox', reason: 'manual_takeover' }), 'منى مسك المحادثة — البوت وقف');
    assert.equal(line('handoff_to_human', { source: 'sie', reason: 'sie:escalated_by_engine' }), 'SIE سلّم المحادثة لفريق الدعم — البوت وقف');
    assert.equal(line('handoff_to_ai', { source: 'inbox', reason: 'returned_by_agent' }), 'منى رجّع المحادثة للبوت');
    assert.equal(line('handoff_to_ai', { source: 'inbox', reason: 'اتحلت' }), 'منى رجّع المحادثة للبوت — اتحلت');
});

test('the RPCs the UI calls exist in 059 and are granted to staff, not anon', async () => {
    const sql = await read('migrations/059_inbox_handoff_guarantee.sql');
    for (const fn of ['inbox_take_over', 'inbox_return_to_ai']) {
        assert.match(sql, new RegExp(`create or replace function public\\.${fn}\\(p_session uuid, p_reason text default null\\)`));
        assert.match(sql, new RegExp(`'public\\.${fn}\\(uuid, text\\)'`));
    }
    assert.match(sql, /revoke all on function %s from public, anon/);
    assert.match(sql, /grant execute on function %s to authenticated/);
    // المسارات الرسمية كلها بتمر من _inbox_require (وصول الموظف للمحادثة)
    for (const fn of ['inbox_take_over', 'inbox_return_to_ai']) {
        const body = sql.slice(sql.indexOf(`function public.${fn}(`));
        assert.ok(body.indexOf('perform public._inbox_require(p_session)') < body.indexOf('_handoff_set('), fn);
    }
});

test('legacy SIE path: the browser never writes the bot reply or bot_state (superseded by Phase 3 / 062)', async () => {
    // 059 كان بيرفض رد البوت وقت التسليم، فكان لازم الحالة ماتتقدمش لرد ماتخزنش.
    // من 062 المتصفح مابيكتبش لا رد البوت ولا bot_state أصلًا — الخادم بس.
    for (const f of ['chat-widget.js', 'assets/js/chat-logic.js']) {
        const src = await read(f);
        assert.ok(!/is_bot_reply:\s*true/.test(src), `${f}: writes a bot message`);
        assert.ok(!/update\(\{\s*bot_state/.test(src), `${f}: writes bot_state`);
    }
});

test('060: Take over / Return to AI lock the session row before checking closed', async () => {
    const sql = await read('migrations/060_inbox_handoff_close_lock.sql');
    for (const fn of ['inbox_take_over', 'inbox_return_to_ai']) {
        const body = sql.slice(sql.indexOf(`function public.${fn}(`));
        const lock = body.indexOf('for update');
        assert.ok(body.indexOf('perform public._inbox_require(p_session)') < lock, fn);
        assert.ok(lock > 0 && lock < body.indexOf("= 'closed'") && lock < body.indexOf('_handoff_set('), fn);
    }
});

test('064: per-message Conversation Core events never become timeline lines', async () => {
    const { buildTimeline } = await import('../assets/js/admin/inbox-model.js');
    const at = '2026-10-05T10:00:00Z';
    const kinds = ['conversation_created', 'message_received', 'agent_replied', 'human_reply'];
    const timeline = buildTimeline([{ id: 'm1', created_at: at }], [],
        [...kinds, 'closed', 'handoff_to_human'].map((kind, i) => ({ id: i, kind, created_at: at, payload: {} })));
    assert.deepEqual(timeline.filter((r) => r.type === 'event').map((r) => r.item.kind), ['closed', 'handoff_to_human']);
    // كل نوع اتضاف في 064 لازم يبقى مخفي أو ليه جملة — مفيش «فلان: message_received».
    const sql = await read('migrations/064_conversation_core.sql');
    for (const k of kinds) assert.ok(sql.includes(`'${k}'`), k);
});
