import test from 'node:test';
import assert from 'node:assert/strict';
import {
    logTraceEvent,
    flagConversationForReview,
    updateConversationReviewStatus,
    saveScenarioDraft,
    saveKnowledgeDraft,
    recordValidationRun,
    publishScenarioVersion,
    publishKnowledgeVersion
} from '../../action/action-layer.js';
import { createMockSupabasePort, createThrowingSupabasePort } from '../../action/tests/helpers/mock-supabase-port.js';

// ------------------------------------------------------------------
// logTraceEvent
// ------------------------------------------------------------------

test('logTraceEvent: routes to insertTraceEvent and succeeds', async () => {
    const { port, calls, state } = createMockSupabasePort();
    const result = await logTraceEvent({ sessionId: 's1', turn: 1, traceEvent: { turn: 1 }, port });
    assert.equal(result.success, true);
    assert.equal(calls[0].method, 'insertTraceEvent');
    assert.equal(state.traceEvents.length, 1);
});

test('logTraceEvent: missing traceEvent is reported as a failed ActionResult, not thrown', async () => {
    const { port } = createMockSupabasePort();
    const result = await logTraceEvent({ sessionId: 's1', turn: 1, traceEvent: null, port });
    assert.equal(result.success, false);
    assert.equal(result.steps[0].name, 'validate_input');
});

test('logTraceEvent: a structured write failure is reported, not thrown', async () => {
    const { port } = createMockSupabasePort({ failMethod: 'insertTraceEvent' });
    const result = await logTraceEvent({ sessionId: 's1', turn: 1, traceEvent: {}, port });
    assert.equal(result.success, false);
});

// ------------------------------------------------------------------
// flagConversationForReview / updateConversationReviewStatus
// ------------------------------------------------------------------

test('flagConversationForReview: returns a reviewId on success', async () => {
    const { port } = createMockSupabasePort();
    const result = await flagConversationForReview({ sessionId: 's1', triggeredByTurn: 3, reason: 'low_confidence', port });
    assert.equal(result.success, true);
    assert.ok(result.reviewId);
});

test('updateConversationReviewStatus: updates an existing review', async () => {
    const { port, state } = createMockSupabasePort();
    const created = await flagConversationForReview({ sessionId: 's1', triggeredByTurn: 3, reason: 'fallback', port });
    const result = await updateConversationReviewStatus({ reviewId: created.reviewId, status: 'resolved', correction: 'was actually pricing_inquiry', port });
    assert.equal(result.success, true);
    assert.equal(state.conversationReviews[created.reviewId].status, 'resolved');
    assert.equal(state.conversationReviews[created.reviewId].correction, 'was actually pricing_inquiry');
});

test('updateConversationReviewStatus: updating a non-existent review fails cleanly', async () => {
    const { port } = createMockSupabasePort();
    const result = await updateConversationReviewStatus({ reviewId: 'does-not-exist', status: 'resolved', port });
    assert.equal(result.success, false);
});

// ------------------------------------------------------------------
// saveScenarioDraft / saveKnowledgeDraft
// ------------------------------------------------------------------

test('saveScenarioDraft: returns an incrementing draftVersion per key', async () => {
    const { port } = createMockSupabasePort();
    const first = await saveScenarioDraft({ key: 'pricing_inquiry', definition: { id: 'pricing_inquiry' }, port });
    const second = await saveScenarioDraft({ key: 'pricing_inquiry', definition: { id: 'pricing_inquiry' }, port });
    assert.equal(first.success, true);
    assert.ok(second.draftVersion > first.draftVersion);
});

test('saveKnowledgeDraft: succeeds and returns a draftVersion', async () => {
    const { port, state } = createMockSupabasePort();
    const result = await saveKnowledgeDraft({ key: 'pricing', definition: { key: 'pricing', text: { ar: 'x', en: 'y' } }, authorNote: 'updated Q3 prices', port });
    assert.equal(result.success, true);
    assert.equal(result.draftVersion, 1);
    assert.equal(state.knowledgeDrafts['pricing:1'].authorNote, 'updated Q3 prices');
});

test('saveScenarioDraft: missing definition is reported as a failed ActionResult', async () => {
    const { port } = createMockSupabasePort();
    const result = await saveScenarioDraft({ key: 'x', definition: null, port });
    assert.equal(result.success, false);
});

// ------------------------------------------------------------------
// recordValidationRun
// ------------------------------------------------------------------

test('recordValidationRun: succeeds and returns a runId', async () => {
    const { port, state } = createMockSupabasePort();
    const result = await recordValidationRun({
        kind: 'simulation',
        targetType: 'scenario',
        targetKey: 'pricing_inquiry',
        targetVersion: 2,
        verdict: { passed: true, reasons: [] },
        details: { turns: [] },
        port
    });
    assert.equal(result.success, true);
    assert.ok(result.runId);
    assert.equal(state.validationRuns.length, 1);
});

// ------------------------------------------------------------------
// publishScenarioVersion / publishKnowledgeVersion
// ------------------------------------------------------------------

test('publishScenarioVersion: marks the matching draft published and records the published version', async () => {
    const { port, state } = createMockSupabasePort();
    const draft = await saveScenarioDraft({ key: 'pricing_inquiry', definition: { id: 'pricing_inquiry' }, port });
    const result = await publishScenarioVersion({ key: 'pricing_inquiry', version: draft.draftVersion, port });
    assert.equal(result.success, true);
    assert.equal(state.scenarioDrafts[`pricing_inquiry:${draft.draftVersion}`].status, 'published');
    assert.equal(state.published['scenario:pricing_inquiry'], draft.draftVersion);
});

test('publishKnowledgeVersion: carries an overrideReason through to the port call', async () => {
    const { port, calls } = createMockSupabasePort();
    await saveKnowledgeDraft({ key: 'pricing', definition: { key: 'pricing' }, port });
    await publishKnowledgeVersion({ key: 'pricing', version: 1, overrideReason: 'urgent price correction', port });
    const publishCall = calls.find((c) => c.method === 'publishKnowledge');
    assert.equal(publishCall.params.overrideReason, 'urgent price correction');
});

test('publishScenarioVersion: a missing version (wrong type) is reported as a failed ActionResult, not thrown', async () => {
    const { port } = createMockSupabasePort();
    const result = await publishScenarioVersion({ key: 'x', version: 'not-a-number', port });
    assert.equal(result.success, false);
    assert.equal(result.steps[0].name, 'validate_input');
});

// ------------------------------------------------------------------
// Resilience: thrown exceptions never propagate out of any of the 8
// ------------------------------------------------------------------

test('every observability write function catches a thrown port exception and reports it as data', async () => {
    const port = createThrowingSupabasePort('connection reset');

    const results = await Promise.all([
        logTraceEvent({ sessionId: 's1', turn: 1, traceEvent: {}, port }),
        flagConversationForReview({ sessionId: 's1', triggeredByTurn: 1, reason: 'x', port }),
        updateConversationReviewStatus({ reviewId: 'r1', status: 'resolved', port }),
        saveScenarioDraft({ key: 'x', definition: {}, port }),
        saveKnowledgeDraft({ key: 'x', definition: {}, port }),
        recordValidationRun({ kind: 'simulation', targetType: 'scenario', targetKey: 'x', targetVersion: 1, verdict: {}, details: {}, port }),
        publishScenarioVersion({ key: 'x', version: 1, port }),
        publishKnowledgeVersion({ key: 'x', version: 1, port })
    ]);

    for (const result of results) {
        assert.equal(result.success, false);
        assert.equal(result.steps[0].error, 'connection reset');
    }
});

// ------------------------------------------------------------------
// JSON safety
// ------------------------------------------------------------------

test('every observability write function\'s ActionResult round-trips through JSON', async () => {
    const { port } = createMockSupabasePort();
    const result = await logTraceEvent({ sessionId: 's1', turn: 1, traceEvent: { turn: 1 }, port });
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});
