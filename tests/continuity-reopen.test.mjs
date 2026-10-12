/**
 * 079: تاريخ الإغلاق وإعادة الفتح، منطق الواجهة النقي. القواعد نفسها مقيسة على الخادم
 * في tests/sql/continuity-reopen.test.sql (L1–L9)؛ هنا: الواجهة تطلب الموعد في نفس
 * الحالات التي يرفضها الخادم، ولا تعرض خانة فارغة لإغلاق قديم بلا نص.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
    reopenRequirements, closureHistory, allowedTransitions, REOPEN_DUE_MARGIN_MS,
} from '../assets/js/continuity/continuity-model.js';

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8');
const NOW = new Date('2026-10-12T10:00:00Z');
const rec = (o = {}) => ({ id: 'r1', kind: 'follow_up', status: 'resolved', owner_id: 'me', due_at: null, due_tz: 'Africa/Cairo', ...o });
const at = (ms) => new Date(NOW.getTime() + ms).toISOString();

test('reopenRequirements: متابعة بلا موعد أو موعد فات أو خلال 5 دقائق ⇒ موعد جديد إلزامي', () => {
    assert.equal(reopenRequirements(rec(), NOW).needsDue, true);
    assert.equal(reopenRequirements(rec({ due_at: at(-3600e3) }), NOW).needsDue, true);
    assert.equal(reopenRequirements(rec({ due_at: at(-3600e3) }), NOW).expiredDue, true);
    assert.equal(reopenRequirements(rec({ due_at: at(3 * 60e3) }), NOW).needsDue, true);
    assert.equal(reopenRequirements(rec({ due_at: at(REOPEN_DUE_MARGIN_MS) }), NOW).needsDue, true, 'الحد نفسه مش مستقبلي كفاية (الخادم: <=)');
    const future = reopenRequirements(rec({ due_at: at(REOPEN_DUE_MARGIN_MS + 1000), status: 'cancelled' }), NOW);
    assert.deepEqual(future, { needsDue: false, keepsDue: true, expiredDue: false, tz: 'Africa/Cairo' });
});

test('reopenRequirements: المشكلة (issue) الموعد اختياري؛ سجل غير مقفول ⇒ null', () => {
    const issue = reopenRequirements(rec({ kind: 'issue', due_at: at(-60e3) }), NOW);
    assert.equal(issue.needsDue, false);
    assert.equal(issue.expiredDue, true, 'الواجهة تقول إن الموعد عدّى وتسمح بجديد');
    assert.equal(reopenRequirements(rec({ kind: 'issue' }), NOW).needsDue, false);
    for (const status of ['open', 'scheduled', 'in_progress', 'waiting']) assert.equal(reopenRequirements(rec({ status }), NOW), null);
    assert.equal(reopenRequirements(null, NOW), null);
    assert.equal(reopenRequirements(rec({ due_tz: null, due_at: at(-1) }), NOW).tz, 'Africa/Cairo');
});

test('الهامش وقاعدة «بعد الآن» مطابقان لـ 079', async () => {
    const sql = await read('migrations/079_continuity_reopen_lifecycle.sql');
    assert.equal(REOPEN_DUE_MARGIN_MS, 5 * 60 * 1000);
    assert.match(sql, /r\.kind = 'follow_up' and \(r\.due_at is null or r\.due_at <= now\(\) \+ interval '5 minutes'\)/);
    assert.match(sql, /_continuity_validation\('details\.due', 'due_required_on_reopen'\)/);
    assert.match(sql, /if v_due_at <= now\(\) then perform public\._continuity_validation\('details\.due\.at', 'in_past'\)/);
});

test('إعادة الفتح تظهر للمالك أو المشرف فقط، وتنقل لـ open دائمًا (L1)', () => {
    assert.deepEqual(allowedTransitions(rec(), { meId: 'me' }).map((t) => t.to), ['open']);
    assert.deepEqual(allowedTransitions(rec({ owner_id: 'x' }), { meId: 'me', supervisor: true }).map((t) => t.to), ['open']);
    assert.deepEqual(allowedTransitions(rec({ owner_id: 'x' }), { meId: 'me' }), []);
});

test('closureHistory: يعرض ما أرسله الخادم بالترتيب ويقول صراحة لو النص غير محفوظ', () => {
    const rows = closureHistory([
        { seq: 3, closed_status: 'cancelled', closed_at: 't3', closed_by: 'a', cancel_reason: 'سبب', resolution_note: null,
          reopened_at: null, reopened_by: null, reopen_reason: null, backfilled: false },
        { seq: 2, closed_status: 'resolved', closed_at: 't2', closed_by: 'b', resolution_note: 'حل', cancel_reason: null,
          reopened_at: 't2r', reopened_by: 'c', reopen_reason: 'رجع', backfilled: false },
        { seq: 1, closed_status: 'resolved', closed_at: 't1', closed_by: null, resolution_note: null, cancel_reason: null,
          reopened_at: 't1r', reopened_by: 'b', reopen_reason: null, backfilled: true },
    ]);
    assert.deepEqual(rows.map((r) => r.seq), [3, 2, 1]);
    assert.deepEqual([rows[0].statusLabel, rows[0].noteLabel, rows[0].note, rows[0].reopened], ['اتلغى', 'سبب الإلغاء', 'سبب', false]);
    assert.deepEqual([rows[1].statusLabel, rows[1].note, rows[1].reopenReason, rows[1].noteMissing], ['اتحل', 'حل', 'رجع', false]);
    assert.deepEqual([rows[2].note, rows[2].noteMissing, rows[2].reopenReasonMissing, rows[2].closedBy], [null, true, true, null]);
});

test('closureHistory: خادم أقدم من 079 (لا closures) ⇒ قائمة فارغة', () => {
    assert.deepEqual(closureHistory(undefined), []);
    assert.deepEqual(closureHistory(null), []);
});

test('الصفحة تعرض النصوص عبر esc وتنادي إعادة الفتح بسبب وموعد فقط', async () => {
    const page = await read('assets/js/continuity/continuity-page.js');
    const section = page.slice(page.indexOf('function closureHtml'), page.indexOf('function patchFromForm'));
    for (const field of ['c.note', 'c.reopenReason', 'c.statusLabel', 'c.noteLabel']) {
        assert.ok(section.includes(`esc(${field})`), `${field} عبر esc`);
    }
    assert.doesNotMatch(section, /\$\{c\.(note|reopenReason)\}/, 'لا نص خام');
    assert.match(page, /details = got\.due \? \{ reason: got\.reason, due: got\.due \} : \{ reason: got\.reason \}/);
});
