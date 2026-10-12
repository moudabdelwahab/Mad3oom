/**
 * التسليم (081): منطق الواجهة النقي ومطابقته لقواعد الخادم. القواعد نفسها مقيسة في
 * tests/sql/continuity-handovers.test.sql (H0–H12)؛ هنا: الواجهة لا تعرض ما سيرفضه الخادم،
 * ولا تعرض أي محتوى رسائل للمستلم قبل القبول.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
    handoverActions, handoverTargets, handoverErrorText, HANDOVER_STATE_LABELS, HANDOVER_CANCEL_LABELS, EVENT_LABELS,
} from '../assets/js/continuity/continuity-model.js';

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8');
const rec = (o = {}) => ({ id: 'r', status: 'open', owner_id: 'me', ...o });

test('handoverActions: المالك أو صاحب الإسناد، سجل نشط، بلا معلّق، والقدرة مفعّلة', () => {
    assert.deepEqual(handoverActions(rec(), { meId: 'me', enabled: true }), { canRequest: true, canCancel: false });
    assert.equal(handoverActions(rec({ owner_id: 'x' }), { meId: 'me', enabled: true }).canRequest, false);
    assert.equal(handoverActions(rec({ owner_id: 'x' }), { meId: 'me', enabled: true, canAssign: true }).canRequest, true);
    assert.equal(handoverActions(rec({ owner_id: null }), { meId: 'me', enabled: true }).canRequest, false, 'unassigned: assigners only');
    for (const status of ['resolved', 'cancelled']) assert.equal(handoverActions(rec({ status }), { meId: 'me', enabled: true }).canRequest, false);
    assert.equal(handoverActions(rec(), { meId: 'me', enabled: false }).canRequest, false);
    const pending = { created_by: 'me' };
    assert.deepEqual(handoverActions(rec(), { meId: 'me', enabled: true, pending }), { canRequest: false, canCancel: true });
    assert.equal(handoverActions(rec(), { meId: 'other', enabled: true, pending }).canCancel, false);
    assert.equal(handoverActions(rec(), { meId: 'other', enabled: true, pending, canAssign: true }).canCancel, true);
});

test('handoverTargets: لا يُعرض المالك الحالي كمستلم', () => {
    const agents = [{ id: 'me', full_name: 'أنا' }, { id: 'a', full_name: 'هبة' }, { id: 'b', email: 'b@x' }, { id: null }];
    assert.deepEqual(handoverTargets(agents, rec()), [{ value: 'a', label: 'هبة' }, { value: 'b', label: 'b@x' }]);
});

test('handoverErrorText: أسباب الخادم كنص مفهوم، بلا نص الخادم', () => {
    assert.match(handoverErrorText({ code: 'invalid_transition', reason: 'handover_pending' }), /معلّق/);
    assert.match(handoverErrorText({ code: 'validation_failed', reason: 'not_eligible' }), /مش مؤهل/);
    assert.match(handoverErrorText({ code: 'validation_failed', reason: 'already_owner' }), /المالك الحالي/);
    assert.match(handoverErrorText({ code: 'invalid_transition', reason: 'handover_accepted' }), /اتحسم/);
    assert.match(handoverErrorText({ code: 'version_conflict' }), /اتعدّل/);
    assert.match(handoverErrorText({ code: 'forbidden' }), /للمالك الحالي أو المشرف/);
    for (const k of ['pending', 'accepted', 'declined', 'cancelled', 'expired']) assert.ok(HANDOVER_STATE_LABELS[k], k);
    for (const k of ['initiator', 'supervisor', 'reassigned', 'record_closed', 'target_ineligible', 'requester_lost_authority']) {
        assert.ok(HANDOVER_CANCEL_LABELS[k], k);
    }
    for (const k of ['handover_requested', 'handover_accepted', 'handover_declined', 'handover_cancelled']) assert.ok(EVENT_LABELS[k], k);
});

test('القيود في الخادم مطابقة: أسباب الإلغاء والحالات، والحزمة بلا مقتطفات', async () => {
    const sql = await read('migrations/081_continuity_handovers.sql');
    const causes = sql.match(/cancel_cause in \(([^)]+)\)/)[1].match(/'([a-z_]+)'/g).map((x) => x.slice(1, -1));
    assert.deepEqual(causes.sort(), Object.keys(HANDOVER_CANCEL_LABELS).sort());
    const states = sql.match(/state in \('pending', 'accepted', 'declined', 'cancelled', 'expired'\)/);
    assert.ok(states);
    const pkg = sql.slice(sql.indexOf('function public._continuity_handover_package'), sql.indexOf('function public._continuity_handover_result'));
    assert.doesNotMatch(pkg, /excerpt|snapshot|storage_path|_continuity_full|source_view/, 'the package reads no excerpt, snapshot or file path');
});

test('الواجهة: الحزمة تُعرض بلا مقتطفات، وكل نص عبر esc', async () => {
    const page = await read('assets/js/continuity/continuity-page.js');
    const incoming = page.slice(page.indexOf('async function renderIncoming'), page.indexOf('async function incomingAction'));
    assert.doesNotMatch(incoming, /excerpt|\.sources\b|signAttachment/);
    for (const f of ['p.title', 'h.reason', 'h.context_note', 'p.next_action']) assert.ok(incoming.includes(`esc(${f})`), f);
    const banner = page.slice(page.indexOf('function handoverHtml'), page.indexOf('async function handoverAction'));
    assert.ok(banner.includes('esc(pending.reason)'));
});
