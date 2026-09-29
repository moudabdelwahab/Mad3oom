/**
 * Phase 3 (061/062): رد البوت ورد الدعم من الخادم بس.
 *
 * الضمان نفسه في قاعدة البيانات (tests/sql/chat-message-authority.test.sql).
 * الاختبار ده بيثبت إن المتصفح ماشي على العقد الجديد قبل ما 062 يتطبّق:
 *   - مفيش إدراج رسالة بعلم is_bot_reply / is_admin_reply من المتصفح
 *   - مفيش تحديث bot_state من المتصفح
 *   - كل رسايل البوت الثابتة بتمر من chat_post_notice بنوع معروف للخادم
 *   - رسايل العميل نفسه بتتكتب بـ sender_id = المستخدم ومن غير أعلام
 *   - الأنواع اللي المتصفح بيطلبها موجودة فعلًا في 061
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8');
const CLIENTS = ['chat-widget.js', 'assets/js/chat-logic.js'];

/** كل كائنات insert على chat_messages في الملف (نص الكائن). */
function messageInserts(src) {
    const out = [];
    const re = /from\('chat_messages'\)\.insert\(/g;
    let m;
    while ((m = re.exec(src))) {
        let i = m.index + m[0].length, depth = 0, start = i;
        for (; i < src.length; i++) {
            if (src[i] === '(' || src[i] === '{') depth++;
            else if (src[i] === ')' || src[i] === '}') { if (depth === 0) break; depth--; }
        }
        out.push(src.slice(start, i));
    }
    return out;
}

test('the browser never inserts a bot or support message', async () => {
    for (const f of CLIENTS) {
        const src = await read(f);
        assert.ok(!/is_bot_reply\s*:\s*true/.test(src), `${f}: is_bot_reply: true`);
        assert.ok(!/is_admin_reply\s*:\s*true/.test(src), `${f}: is_admin_reply: true`);
        assert.ok(!/sender_id\s*:\s*null/.test(src), `${f}: a message with no sender`);
    }
});

test('the browser never writes bot_state', async () => {
    for (const f of CLIENTS) {
        const src = await read(f);
        assert.ok(!/\.update\(\s*\{[^}]*bot_state/s.test(src), `${f}: updates bot_state`);
        assert.ok(!/\.insert\(\s*\{[^}]*bot_state/s.test(src), `${f}: inserts bot_state`);
    }
});

test("the customer's own messages carry their id and no reply flags", async () => {
    for (const f of CLIENTS) {
        const src = await read(f);
        const inserts = messageInserts(src);
        assert.ok(inserts.length >= 1, `${f}: expected the customer's message insert`);
        for (const body of inserts) {
            const payload = body.trim().startsWith('{') ? body : src.slice(src.indexOf(`const ${body.trim()} = {`));
            assert.match(payload, /sender_id:\s*(this\.)?currentUser\.id/, `${f}: customer insert without sender_id = user`);
            assert.doesNotMatch(payload.slice(0, 400), /is_bot_reply\s*:\s*true|is_admin_reply\s*:\s*true/);
        }
    }
});

test('every bot notice goes through chat_post_notice with a kind the server knows', async () => {
    const sql = await read('migrations/061_chat_server_notices.sql');
    const known = new Set(/p_kind not in \(([^)]*)\)/.exec(sql)[1].split(',').map((s) => s.trim().replace(/'/g, '')));
    for (const f of CLIENTS) {
        const src = await read(f);
        assert.match(src, /rpc\('chat_post_notice', \{\s*p_session: (this\.)?currentSessionId, p_kind: kind, p_seconds: seconds\s*\}\)/, `${f}: postNotice wiring`);
        const kinds = [...src.matchAll(/postNotice\('([a-z_]+)'/g)].map((m) => m[1]);
        for (const k of ['greeting', 'sie_unavailable', 'sie_error', 'error', 'rate_limited']) {
            assert.ok(kinds.includes(k), `${f}: never asks for ${k}`);
        }
        for (const k of kinds) assert.ok(known.has(k), `${f}: asks for unknown kind ${k}`);
    }
});

test('061 is staff-free and anon-free: authenticated only, owner checked inside', async () => {
    const sql = await read('migrations/061_chat_server_notices.sql');
    assert.match(sql, /revoke all on function public\.chat_post_notice\(uuid, text, integer\) from public, anon/);
    assert.match(sql, /grant execute on function public\.chat_post_notice\(uuid, text, integer\) to authenticated/);
    assert.match(sql, /v_owner is distinct from auth\.uid\(\)/);
    assert.match(sql, /for update/, 'the session row is locked (one greeting across tabs)');
});

test('062 revokes the turn RPCs from customers and guards bot_state', async () => {
    const sql = await read('migrations/062_chat_message_authority.sql');
    assert.match(sql, /revoke execute on function public\.persist_bot_turn\(uuid, integer, text, jsonb\) from public, anon, authenticated/);
    assert.match(sql, /revoke execute on function public\.create_ticket_with_message_and_session_update\([^)]*\)\s*from public, anon, authenticated/);
    assert.match(sql, /coalesce\(is_admin_reply, false\) = false/);
    assert.match(sql, /coalesce\(is_bot_reply, false\) = false/);
    assert.match(sql, /sender_id = auth\.uid\(\)/);
    assert.match(sql, /create trigger trg_guard_bot_state/);
});
