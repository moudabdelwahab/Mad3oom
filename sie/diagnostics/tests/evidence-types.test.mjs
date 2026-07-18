import test from 'node:test';
import assert from 'node:assert/strict';
import { checkEvidenceShape, createEmptyAccumulator, createEmptyDiagnosticState } from '../evidence-types.js';

test('checkEvidenceShape: accepts a well-formed evidence entry', () => {
    const problems = checkEvidenceShape({
        token: 'entity_api',
        source: 'text',
        polarity: 'supports',
        weight: 1,
        turn: 1
    });
    assert.deepEqual(problems, []);
});

test('checkEvidenceShape: rejects null/non-object input', () => {
    assert.ok(checkEvidenceShape(null).length > 0);
    assert.ok(checkEvidenceShape('nope').length > 0);
});

test('checkEvidenceShape: rejects invalid source', () => {
    const problems = checkEvidenceShape({ token: 'x', source: 'telepathy', polarity: 'supports', weight: 1, turn: 1 });
    assert.ok(problems.some((p) => p.includes('source')));
});

test('checkEvidenceShape: rejects invalid polarity', () => {
    const problems = checkEvidenceShape({ token: 'x', source: 'text', polarity: 'maybe', weight: 1, turn: 1 });
    assert.ok(problems.some((p) => p.includes('polarity')));
});

test('checkEvidenceShape: rejects out-of-range weight', () => {
    assert.ok(checkEvidenceShape({ token: 'x', source: 'text', polarity: 'supports', weight: 1.5, turn: 1 }).length > 0);
    assert.ok(checkEvidenceShape({ token: 'x', source: 'text', polarity: 'supports', weight: -0.1, turn: 1 }).length > 0);
});

test('checkEvidenceShape: rejects negative turn', () => {
    const problems = checkEvidenceShape({ token: 'x', source: 'text', polarity: 'supports', weight: 1, turn: -1 });
    assert.ok(problems.some((p) => p.includes('turn')));
});

test('createEmptyAccumulator: returns a fresh, empty accumulator', () => {
    const acc = createEmptyAccumulator();
    assert.deepEqual(acc, { entries: [], turnCount: 0 });
});

test('createEmptyDiagnosticState: returns a fresh, empty state', () => {
    const state = createEmptyDiagnosticState();
    assert.deepEqual(state.hypotheses, []);
    assert.equal(state.turnCount, 0);
    assert.deepEqual(state.accumulator, { entries: [], turnCount: 0 });
});
