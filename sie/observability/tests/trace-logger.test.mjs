import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTraceEvent, learningQueueReason, filterLearningQueue, LOW_CONFIDENCE_THRESHOLD } from '../trace-logger.js';
import { ACTIONS } from '../../decision/decision-types.js';

function fakeDiagnosticState() {
    return {
        hypotheses: [
            { scenarioId: 'a', confidence: 0.7, status: 'active' },
            { scenarioId: 'b', confidence: 0.05, status: 'unconsidered' },
            { scenarioId: 'c', confidence: 0.03, status: 'rejected' }
        ]
    };
}

function fakeRanking(overrides = {}) {
    return {
        topHypothesis: { hypothesis: { scenarioId: 'a', confidence: 0.7 } },
        isAmbiguous: false,
        ...overrides
    };
}

function fakeDecision(overrides = {}) {
    return { action: ACTIONS.ANSWER, scenarioId: 'a', confidence: 0.7, turn: 1, ...overrides };
}

// ------------------------------------------------------------------
// buildTraceEvent
// ------------------------------------------------------------------

test('buildTraceEvent: projects hypotheses, excluding unconsidered ones', () => {
    const trace = buildTraceEvent({
        sessionId: 's1',
        turn: 1,
        rawText: 'hi',
        normalizedTokens: [{ canonical: 'hi' }],
        diagnosticState: fakeDiagnosticState(),
        ranking: fakeRanking(),
        decision: fakeDecision(),
        responseText: 'reply',
        timestamp: '2026-01-01T00:00:00.000Z'
    });
    assert.deepEqual(
        trace.hypothesesSnapshot.map((h) => h.scenarioId),
        ['a', 'c']
    );
});

test('buildTraceEvent: derives rankingSnapshot from the RankingResult', () => {
    const trace = buildTraceEvent({
        sessionId: 's1',
        turn: 1,
        rawText: 'hi',
        normalizedTokens: [],
        diagnosticState: fakeDiagnosticState(),
        ranking: fakeRanking({ isAmbiguous: true }),
        decision: fakeDecision(),
        responseText: 'reply',
        timestamp: '2026-01-01T00:00:00.000Z'
    });
    assert.deepEqual(trace.rankingSnapshot, { topScenarioId: 'a', topConfidence: 0.7, isAmbiguous: true });
});

test('buildTraceEvent: a null topHypothesis degrades to null fields rather than throwing', () => {
    const trace = buildTraceEvent({
        sessionId: 's1',
        turn: 1,
        rawText: '',
        normalizedTokens: [],
        diagnosticState: { hypotheses: [] },
        ranking: { topHypothesis: null, isAmbiguous: false },
        decision: fakeDecision({ action: ACTIONS.FALLBACK, scenarioId: null, confidence: null }),
        responseText: 'x',
        timestamp: '2026-01-01T00:00:00.000Z'
    });
    assert.equal(trace.rankingSnapshot.topScenarioId, null);
    assert.equal(trace.rankingSnapshot.topConfidence, null);
});

test('buildTraceEvent: defaults timestamp to now() when not supplied', () => {
    const trace = buildTraceEvent({
        sessionId: 's1',
        turn: 1,
        rawText: '',
        normalizedTokens: [],
        diagnosticState: fakeDiagnosticState(),
        ranking: fakeRanking(),
        decision: fakeDecision(),
        responseText: 'x'
    });
    assert.ok(trace.timestamp.length > 0);
});

test('buildTraceEvent: extracts only .canonical from normalizedTokens, filtering out empty ones', () => {
    const trace = buildTraceEvent({
        sessionId: 's1',
        turn: 1,
        rawText: 'x y',
        normalizedTokens: [{ canonical: 'x' }, { canonical: '' }, { canonical: 'y' }],
        diagnosticState: fakeDiagnosticState(),
        ranking: fakeRanking(),
        decision: fakeDecision(),
        responseText: 'x',
        timestamp: '2026-01-01T00:00:00.000Z'
    });
    assert.deepEqual(trace.normalizedTokenCanonicals, ['x', 'y']);
});

test('buildTraceEvent: output round-trips through JSON', () => {
    const trace = buildTraceEvent({
        sessionId: 's1',
        turn: 1,
        rawText: 'hi',
        normalizedTokens: [{ canonical: 'hi' }],
        diagnosticState: fakeDiagnosticState(),
        ranking: fakeRanking(),
        decision: fakeDecision(),
        responseText: 'reply',
        timestamp: '2026-01-01T00:00:00.000Z'
    });
    assert.deepEqual(JSON.parse(JSON.stringify(trace)), trace);
});

// ------------------------------------------------------------------
// learningQueueReason / filterLearningQueue
// ------------------------------------------------------------------

test('learningQueueReason: FALLBACK is always flagged, regardless of confidence', () => {
    assert.equal(learningQueueReason(fakeDecision({ action: ACTIONS.FALLBACK, confidence: 0.9 })), 'fallback');
});

test('learningQueueReason: ESCALATE_TO_HUMAN for the "unknown" scenario is flagged', () => {
    assert.equal(learningQueueReason(fakeDecision({ action: ACTIONS.ESCALATE_TO_HUMAN, scenarioId: 'unknown', confidence: null })), 'escalated_unknown');
});

test('learningQueueReason: ESCALATE_TO_HUMAN for a KNOWN scenario (e.g. a confidently-diagnosed technical ticket) is NOT flagged as unknown', () => {
    assert.equal(learningQueueReason(fakeDecision({ action: ACTIONS.ESCALATE_TO_HUMAN, scenarioId: 'api_integration_issue', confidence: 0.8 })), null);
});

test(`learningQueueReason: confidence below ${LOW_CONFIDENCE_THRESHOLD} is flagged as low_confidence`, () => {
    assert.equal(learningQueueReason(fakeDecision({ confidence: 0.1 })), 'low_confidence');
});

test('learningQueueReason: confidence at/above the threshold is not flagged', () => {
    assert.equal(learningQueueReason(fakeDecision({ confidence: LOW_CONFIDENCE_THRESHOLD })), null);
    assert.equal(learningQueueReason(fakeDecision({ confidence: 0.9 })), null);
});

test('learningQueueReason: a normal ANSWER/COMPLETE with no confidence recorded is not flagged', () => {
    assert.equal(learningQueueReason(fakeDecision({ action: ACTIONS.COMPLETE, confidence: null })), null);
});

test('learningQueueReason: a null decision is handled without throwing', () => {
    assert.equal(learningQueueReason(null), null);
});

test('filterLearningQueue: keeps only flagged entries, each with its reason attached', () => {
    const traceEvents = [
        { decision: fakeDecision({ confidence: 0.9 }) }, // not flagged
        { decision: fakeDecision({ action: ACTIONS.FALLBACK, confidence: 0.9 }) }, // flagged
        { decision: fakeDecision({ confidence: 0.05 }) } // flagged
    ];
    const queue = filterLearningQueue(traceEvents);
    assert.equal(queue.length, 2);
    assert.equal(queue[0].reason, 'fallback');
    assert.equal(queue[1].reason, 'low_confidence');
});

test('filterLearningQueue: a non-array input degrades to an empty queue rather than throwing', () => {
    assert.deepEqual(filterLearningQueue(null), []);
});
