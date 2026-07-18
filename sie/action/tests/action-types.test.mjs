import test from 'node:test';
import assert from 'node:assert/strict';
import { buildActionResult, checkActionResultShape, formatTicketDescription } from '../action-types.js';
import { ACTIONS } from '../../decision/decision-types.js';

// ------------------------------------------------------------------
// buildActionResult
// ------------------------------------------------------------------

test('buildActionResult: a single successful step -> success true, atomicityGuaranteed true', () => {
    const result = buildActionResult({ action: ACTIONS.ANSWER, steps: [{ name: 'persistBotTurn', success: true, error: null }] });
    assert.equal(result.success, true);
    assert.equal(result.atomicityGuaranteed, true);
    assert.equal(result.requiresFuturePostgresRPC, false);
    assert.equal(result.ticketNumber, null);
});

test('buildActionResult: a single failed step -> success false, still atomicityGuaranteed true (one atomic call, it just failed)', () => {
    const result = buildActionResult({ action: ACTIONS.ANSWER, steps: [{ name: 'persistBotTurn', success: false, error: 'boom' }] });
    assert.equal(result.success, false);
    assert.equal(result.atomicityGuaranteed, true);
});

test('buildActionResult: zero steps -> success false (nothing succeeded, trivially)', () => {
    const result = buildActionResult({ action: ACTIONS.ANSWER, steps: [] });
    assert.equal(result.success, false);
    assert.equal(result.atomicityGuaranteed, false);
    assert.equal(result.requiresFuturePostgresRPC, true);
});

test('buildActionResult: more than one step (hypothetical, non-atomic case) -> success requires ALL to succeed, atomicityGuaranteed false', () => {
    const result = buildActionResult({
        action: ACTIONS.CREATE_TICKET,
        steps: [
            { name: 'insertTicket', success: true, error: null },
            { name: 'persistBotTurn', success: false, error: 'boom' }
        ]
    });
    assert.equal(result.success, false);
    assert.equal(result.atomicityGuaranteed, false);
    assert.equal(result.requiresFuturePostgresRPC, true);
});

test('buildActionResult: carries the ticketNumber through when supplied', () => {
    const result = buildActionResult({
        action: ACTIONS.CREATE_TICKET,
        steps: [{ name: 'createTicketWithMessageAndSessionUpdate', success: true, error: null }],
        ticketNumber: 4242
    });
    assert.equal(result.ticketNumber, 4242);
});

test('buildActionResult: a non-array steps input degrades to an empty list rather than throwing', () => {
    const result = buildActionResult({ action: ACTIONS.ANSWER, steps: null });
    assert.deepEqual(result.steps, []);
    assert.equal(result.success, false);
});

test('buildActionResult: result round-trips through JSON', () => {
    const result = buildActionResult({ action: ACTIONS.ANSWER, steps: [{ name: 'persistBotTurn', success: true, error: null }] });
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

// ------------------------------------------------------------------
// checkActionResultShape
// ------------------------------------------------------------------

test('checkActionResultShape: accepts a well-formed result', () => {
    const result = buildActionResult({ action: ACTIONS.ANSWER, steps: [{ name: 'persistBotTurn', success: true, error: null }] });
    assert.deepEqual(checkActionResultShape(result), []);
});

test('checkActionResultShape: rejects a non-object', () => {
    assert.deepEqual(checkActionResultShape(null), ['result is not an object']);
});

test('checkActionResultShape: flags a missing/invalid field individually', () => {
    const problems = checkActionResultShape({ success: 'yes', steps: 'not-an-array' });
    assert.ok(problems.some((p) => p.includes('success')));
    assert.ok(problems.some((p) => p.includes('steps')));
    assert.ok(problems.some((p) => p.includes('atomicityGuaranteed')));
    assert.ok(problems.some((p) => p.includes('requiresFuturePostgresRPC')));
});

// ------------------------------------------------------------------
// formatTicketDescription
// ------------------------------------------------------------------

function fakeDecision(overrides = {}) {
    return {
        action: ACTIONS.CREATE_TICKET,
        explanation: 'Confidence stalled below threshold after 2 clarifying questions.',
        ticketDraft: {
            scenarioId: 'api_integration_issue',
            category: 'api',
            diagnosticTrail: [
                { scenarioId: 'api_integration_issue', confidence: 0.62, status: 'active' },
                { scenarioId: 'webhook_delivery_failure', confidence: 0.18, status: 'rejected' }
            ]
        },
        ...overrides
    };
}

test('formatTicketDescription: includes scenario, category, explanation, and every diagnostic trail entry', () => {
    const text = formatTicketDescription(fakeDecision());
    assert.ok(text.includes('api_integration_issue'));
    assert.ok(text.includes('api'));
    assert.ok(text.includes('Confidence stalled below threshold'));
    assert.ok(text.includes('confidence=0.62'));
    assert.ok(text.includes('status=active'));
    assert.ok(text.includes('webhook_delivery_failure'));
    assert.ok(text.includes('status=rejected'));
});

test('formatTicketDescription: a missing ticketDraft degrades to placeholder text rather than throwing', () => {
    const text = formatTicketDescription(fakeDecision({ ticketDraft: null }));
    assert.ok(text.includes('unknown'));
    assert.ok(text.includes('(none recorded)'));
});

test('formatTicketDescription: an empty diagnosticTrail is handled explicitly', () => {
    const text = formatTicketDescription(fakeDecision({ ticketDraft: { scenarioId: 's1', category: 'c1', diagnosticTrail: [] } }));
    assert.ok(text.includes('(none recorded)'));
});

test('formatTicketDescription: a null decision does not throw', () => {
    const text = formatTicketDescription(null);
    assert.equal(typeof text, 'string');
    assert.ok(text.includes('unknown'));
});
