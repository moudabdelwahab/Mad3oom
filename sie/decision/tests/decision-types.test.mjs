import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTIONS, checkDecisionShape, createEmptyDecisionState } from '../decision-types.js';

test('checkDecisionShape: accepts a minimal valid decision', () => {
    const problems = checkDecisionShape({
        action: ACTIONS.WAIT_FOR_USER,
        confidence: null,
        explanation: 'nothing yet',
        evaluatedRules: [{ rule: 'R0_WAIT_FOR_USER', matched: true, detail: 'x' }],
        timestamp: '2026-01-01T00:00:00.000Z',
        turn: 1
    });
    assert.deepEqual(problems, []);
});

test('checkDecisionShape: rejects null/non-object input', () => {
    assert.ok(checkDecisionShape(null).length > 0);
    assert.ok(checkDecisionShape('nope').length > 0);
});

test('checkDecisionShape: rejects an action outside the fixed enum', () => {
    const problems = checkDecisionShape({
        action: 'DO_A_BARREL_ROLL',
        confidence: null,
        explanation: 'x',
        evaluatedRules: [{ rule: 'R0', matched: true, detail: 'x' }],
        timestamp: 't',
        turn: 1
    });
    assert.ok(problems.some((p) => p.includes('action must be one of')));
});

test('checkDecisionShape: rejects a non-number, non-null confidence', () => {
    const problems = checkDecisionShape({
        action: ACTIONS.COMPLETE,
        confidence: 'high',
        explanation: 'x',
        evaluatedRules: [{ rule: 'R0', matched: true, detail: 'x' }],
        timestamp: 't',
        turn: 1
    });
    assert.ok(problems.some((p) => p.includes('confidence')));
});

test('checkDecisionShape: accepts null confidence', () => {
    const problems = checkDecisionShape({
        action: ACTIONS.COMPLETE,
        confidence: null,
        explanation: 'x',
        evaluatedRules: [{ rule: 'R0', matched: true, detail: 'x' }],
        timestamp: 't',
        turn: 1
    });
    assert.deepEqual(problems, []);
});

test('checkDecisionShape: rejects an empty explanation', () => {
    const problems = checkDecisionShape({
        action: ACTIONS.COMPLETE,
        confidence: null,
        explanation: '   ',
        evaluatedRules: [{ rule: 'R0', matched: true, detail: 'x' }],
        timestamp: 't',
        turn: 1
    });
    assert.ok(problems.some((p) => p.includes('explanation')));
});

test('checkDecisionShape: rejects a missing/empty evaluatedRules trace', () => {
    const problems = checkDecisionShape({
        action: ACTIONS.COMPLETE,
        confidence: null,
        explanation: 'x',
        evaluatedRules: [],
        timestamp: 't',
        turn: 1
    });
    assert.ok(problems.some((p) => p.includes('evaluatedRules')));
});

test('checkDecisionShape: rejects an evaluatedRules entry missing "matched"', () => {
    const problems = checkDecisionShape({
        action: ACTIONS.COMPLETE,
        confidence: null,
        explanation: 'x',
        evaluatedRules: [{ rule: 'R0', detail: 'x' }],
        timestamp: 't',
        turn: 1
    });
    assert.ok(problems.some((p) => p.includes('evaluatedRules[0].matched')));
});

test('checkDecisionShape: rejects a missing/empty timestamp', () => {
    const problems = checkDecisionShape({
        action: ACTIONS.COMPLETE,
        confidence: null,
        explanation: 'x',
        evaluatedRules: [{ rule: 'R0', matched: true, detail: 'x' }],
        timestamp: '',
        turn: 1
    });
    assert.ok(problems.some((p) => p.includes('timestamp')));
});

test('checkDecisionShape: rejects a non-numeric turn', () => {
    const problems = checkDecisionShape({
        action: ACTIONS.COMPLETE,
        confidence: null,
        explanation: 'x',
        evaluatedRules: [{ rule: 'R0', matched: true, detail: 'x' }],
        timestamp: 't',
        turn: '1'
    });
    assert.ok(problems.some((p) => p.includes('turn')));
});

test('ACTIONS: contains exactly the twelve specified actions', () => {
    const expected = [
        'ANSWER',
        'ASK_CLARIFYING_QUESTION',
        'ASK_FOR_SCREENSHOT',
        'ASK_FOR_ATTACHMENT',
        'ASK_FOR_LOGS',
        'VERIFY_INFORMATION',
        'REQUEST_ACCOUNT_DETAILS',
        'CREATE_TICKET',
        'ESCALATE_TO_HUMAN',
        'WAIT_FOR_USER',
        'COMPLETE',
        'FALLBACK'
    ];
    assert.deepEqual(Object.keys(ACTIONS).sort(), expected.sort());
});

test('ACTIONS: is frozen (cannot be mutated at runtime)', () => {
    assert.throws(() => {
        'use strict';
        ACTIONS.ANSWER = 'SOMETHING_ELSE';
    });
});

test('createEmptyDecisionState: returns sensible, empty defaults', () => {
    const state = createEmptyDecisionState();
    assert.deepEqual(state.askedQuestionIds, []);
    assert.equal(state.questionsAskedCount, 0);
    assert.equal(state.supplementaryEvidenceRequested, false);
    assert.equal(state.accountDetailsRequested, false);
    assert.equal(state.verificationDone, false);
    assert.equal(state.consecutiveNoNewEvidenceTurns, 0);
    assert.equal(state.lastAction, null);
    assert.equal(state.lastScenarioId, null);
    assert.deepEqual(state.history, []);
});
