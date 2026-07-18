import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateTurn, evaluateComparison, DEFAULT_POLICY } from '../validation-policy.js';

function turnComparison(turn, before, after) {
    return { turn, before, after };
}

// ------------------------------------------------------------------
// evaluateTurn
// ------------------------------------------------------------------

test('evaluateTurn: passes when nothing changed', () => {
    const before = { action: 'ANSWER', confidence: 0.8 };
    const after = { action: 'ANSWER', confidence: 0.8 };
    const verdict = evaluateTurn(turnComparison(1, before, after));
    assert.equal(verdict.passed, true);
    assert.deepEqual(verdict.reasons, []);
});

test('evaluateTurn: passes when confidence IMPROVES', () => {
    const before = { action: 'ANSWER', confidence: 0.6 };
    const after = { action: 'ANSWER', confidence: 0.9 };
    const verdict = evaluateTurn(turnComparison(1, before, after));
    assert.equal(verdict.passed, true);
});

test('evaluateTurn: fails when confidence regresses beyond tolerance', () => {
    const before = { action: 'ANSWER', confidence: 0.8 };
    const after = { action: 'ANSWER', confidence: 0.5 };
    const verdict = evaluateTurn(turnComparison(1, before, after));
    assert.equal(verdict.passed, false);
    assert.ok(verdict.reasons[0].includes('confidence regressed'));
});

test('evaluateTurn: a tiny confidence decrease within tolerance is not a regression (floating-point noise)', () => {
    const before = { action: 'ANSWER', confidence: 0.8 };
    const after = { action: 'ANSWER', confidence: 0.8 - DEFAULT_POLICY.confidenceRegressionTolerance / 2 };
    const verdict = evaluateTurn(turnComparison(1, before, after));
    assert.equal(verdict.passed, true);
});

test('evaluateTurn: fails when action degrades from ANSWER to FALLBACK', () => {
    const before = { action: 'ANSWER', confidence: 0.7 };
    const after = { action: 'FALLBACK', confidence: null };
    const verdict = evaluateTurn(turnComparison(1, before, after));
    assert.equal(verdict.passed, false);
    assert.ok(verdict.reasons[0].includes('degraded from ANSWER to FALLBACK'));
});

test('evaluateTurn: fails when action degrades from COMPLETE to ESCALATE_TO_HUMAN', () => {
    const before = { action: 'COMPLETE', confidence: null };
    const after = { action: 'ESCALATE_TO_HUMAN', confidence: null };
    const verdict = evaluateTurn(turnComparison(1, before, after));
    assert.equal(verdict.passed, false);
});

test('evaluateTurn: an action change that is NOT a resolving->degrading transition is not, by itself, a failure', () => {
    const before = { action: 'ASK_CLARIFYING_QUESTION', confidence: 0.4 };
    const after = { action: 'ASK_FOR_LOGS', confidence: 0.4 };
    const verdict = evaluateTurn(turnComparison(1, before, after));
    assert.equal(verdict.passed, true);
});

test('evaluateTurn: a turn present in only one replay fails explicitly', () => {
    const verdict = evaluateTurn(turnComparison(1, { action: 'ANSWER', confidence: 0.8 }, null));
    assert.equal(verdict.passed, false);
    assert.ok(verdict.reasons[0].includes('only one replay'));
});

test('evaluateTurn: both action degradation AND confidence regression are reported together', () => {
    const before = { action: 'ANSWER', confidence: 0.8 };
    const after = { action: 'FALLBACK', confidence: 0.1 };
    const verdict = evaluateTurn(turnComparison(1, before, after));
    assert.equal(verdict.reasons.length, 2);
});

// ------------------------------------------------------------------
// evaluateComparison
// ------------------------------------------------------------------

test('evaluateComparison: passes only when every turn passes', () => {
    const comparison = {
        turns: [
            turnComparison(1, { action: 'ANSWER', confidence: 0.8 }, { action: 'ANSWER', confidence: 0.8 }),
            turnComparison(2, { action: 'ANSWER', confidence: 0.8 }, { action: 'ANSWER', confidence: 0.8 })
        ]
    };
    assert.equal(evaluateComparison(comparison).passed, true);
});

test('evaluateComparison: fails overall if even one turn fails, and prefixes reasons with the turn number', () => {
    const comparison = {
        turns: [
            turnComparison(1, { action: 'ANSWER', confidence: 0.8 }, { action: 'ANSWER', confidence: 0.8 }),
            turnComparison(2, { action: 'ANSWER', confidence: 0.8 }, { action: 'FALLBACK', confidence: null })
        ]
    };
    const verdict = evaluateComparison(comparison);
    assert.equal(verdict.passed, false);
    assert.ok(verdict.reasons[0].startsWith('turn 2:'));
});

test('evaluateComparison: an empty comparison passes trivially', () => {
    assert.equal(evaluateComparison({ turns: [] }).passed, true);
});

test('evaluateComparison: a missing/malformed comparison degrades to a trivial pass rather than throwing', () => {
    assert.equal(evaluateComparison(null).passed, true);
});

test('evaluateComparison: result round-trips through JSON', () => {
    const comparison = { turns: [turnComparison(1, { action: 'ANSWER', confidence: 0.8 }, { action: 'FALLBACK', confidence: null })] };
    const verdict = evaluateComparison(comparison);
    assert.deepEqual(JSON.parse(JSON.stringify(verdict)), verdict);
});
