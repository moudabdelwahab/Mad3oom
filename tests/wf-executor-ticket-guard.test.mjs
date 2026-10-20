/**
 * wf-executor: خطوات سير العمل على تذكرة بمعرّفها تحترم عزل الشركات (097) وتفشل مغلقة.
 * الحارس في supabase/functions/wf-executor/ticket-guard.js، ويُستدعى في الخطوات الأربع التي تقرأ التذكرة أو تكتب
 * فيها مباشرة بمفتاح الخدمة (الوسم، سجل النشاط، البريد، استطلاع الرضا).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertWorkflowTicketAllowed, TICKET_NOT_FOUND } from '../supabase/functions/wf-executor/ticket-guard.js';

function fakeDb({ isolation = false, isolationError = null, tickets = {}, ticketError = null } = {}) {
    const calls = [];
    return {
        calls,
        rpc(name) {
            calls.push(['rpc', name]);
            return Promise.resolve(isolationError ? { data: null, error: isolationError } : { data: isolation, error: null });
        },
        from(table) {
            calls.push(['from', table]);
            const q = { id: null };
            return {
                select() { return this; },
                eq(_c, v) { q.id = v; return this; },
                maybeSingle() {
                    return Promise.resolve(ticketError ? { data: null, error: ticketError } : { data: tickets[q.id] ?? null, error: null });
                }
            };
        }
    };
}

const T = { company: { scope: 'company' }, support: { scope: 'mad3oom_support' } };

test('العزل مطفأ: لا تغيير (ولا قراءة للتذكرة)', async () => {
    const db = fakeDb({ isolation: false, tickets: T });
    await assertWorkflowTicketAllowed(db, 'company');
    await assertWorkflowTicketAllowed(db, 'support');
    assert.deepEqual(db.calls.filter(([k]) => k === 'from'), []);
});

test('العزل مفعّل: تذكرة الشركة «غير موجودة» بنفس رسالة الغياب؛ تذكرة مدعوم مسموحة', async () => {
    const db = fakeDb({ isolation: true, tickets: T });
    await assert.rejects(assertWorkflowTicketAllowed(db, 'company'), { message: TICKET_NOT_FOUND });
    await assert.rejects(assertWorkflowTicketAllowed(db, 'missing'), { message: TICKET_NOT_FOUND });
    await assertWorkflowTicketAllowed(db, 'support');
});

test('يفشل مغلقًا: خطأ في قراءة العزل أو التذكرة، أو رد غير منطقي، أو معرّف فارغ ⇒ رفض', async () => {
    await assert.rejects(assertWorkflowTicketAllowed(fakeDb({ isolationError: { code: 'PGRST202' }, tickets: T }), 'support'), { message: TICKET_NOT_FOUND });
    await assert.rejects(assertWorkflowTicketAllowed(fakeDb({ isolation: 'true', tickets: T }), 'support'), { message: TICKET_NOT_FOUND });
    await assert.rejects(assertWorkflowTicketAllowed(fakeDb({ isolation: null, tickets: T }), 'support'), { message: TICKET_NOT_FOUND });
    await assert.rejects(assertWorkflowTicketAllowed(fakeDb({ isolation: true, ticketError: { code: '57014' }, tickets: T }), 'support'), { message: TICKET_NOT_FOUND });
    await assert.rejects(assertWorkflowTicketAllowed(fakeDb({ isolation: false }), ''), { message: TICKET_NOT_FOUND });
});

test('الحارس مستدعى في كل خطوة تعمل على تذكرة بمعرّفها مباشرة، قبل أي قراءة أو كتابة', () => {
    const src = readFileSync(new URL('../supabase/functions/wf-executor/index.ts', import.meta.url), 'utf8');
    assert.match(src, /import \{ assertWorkflowTicketAllowed \} from "\.\/ticket-guard\.js";/);
    for (const h of ['h_add_ticket_tag', 'h_log_ticket_activity', 'h_send_email', 'h_send_satisfaction_survey']) {
        const body = src.slice(src.indexOf(`async function ${h}(`), src.indexOf('\n}\n', src.indexOf(`async function ${h}(`)));
        const guard = body.indexOf('await assertWorkflowTicketAllowed(ctx.db, cfg.ticket_id)');
        assert.ok(guard > 0, `${h} لا يستدعي الحارس`);
        for (const touch of ['ctx.db.from(', 'dryRunResult(']) {
            const at = body.indexOf(touch);
            assert.ok(at === -1 || at > guard, `${h}: ${touch} قبل الحارس`);
        }
    }
    // الخطوتان المبنيتان على دوال القاعدة محروستان في القاعدة نفسها (097)
    assert.match(src, /rpc\("wf_update_ticket_status"/);
    assert.match(src, /rpc\("wf_assign_ticket"/);
});
