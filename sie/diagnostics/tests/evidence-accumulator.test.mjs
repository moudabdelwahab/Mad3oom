import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeEvidence, getTokenPresence, getAllTokenPresences } from '../evidence-accumulator.js';
import { createEmptyAccumulator } from '../evidence-types.js';

function evidence(token, weight, polarity = 'supports', turn = 1) {
    return { token, source: 'text', polarity, weight, turn };
}

test('mergeEvidence: starting from empty, appends new evidence and sets turnCount', () => {
    const acc = mergeEvidence(createEmptyAccumulator(), [evidence('x', 1)], 1);
    assert.equal(acc.entries.length, 1);
    assert.equal(acc.turnCount, 1);
});

test('mergeEvidence: does not mutate the input accumulator (pure function)', () => {
    const original = createEmptyAccumulator();
    mergeEvidence(original, [evidence('x', 1)], 1);
    assert.deepEqual(original, { entries: [], turnCount: 0 });
});

test('mergeEvidence: accumulates across multiple calls (append-only)', () => {
    let acc = createEmptyAccumulator();
    acc = mergeEvidence(acc, [evidence('x', 1)], 1);
    acc = mergeEvidence(acc, [evidence('y', 1)], 2);
    assert.equal(acc.entries.length, 2);
    assert.equal(acc.turnCount, 2);
});

test('mergeEvidence: turnCount never decreases even if called with an older turn number', () => {
    let acc = createEmptyAccumulator();
    acc = mergeEvidence(acc, [], 5);
    acc = mergeEvidence(acc, [], 2); // out-of-order call, shouldn't roll back
    assert.equal(acc.turnCount, 5);
});

test('mergeEvidence: handles null accumulator and non-array evidence gracefully', () => {
    const acc = mergeEvidence(null, null, 1);
    assert.deepEqual(acc.entries, []);
});

test('getTokenPresence: a single observation returns exactly its weight', () => {
    const acc = mergeEvidence(createEmptyAccumulator(), [evidence('x', 0.6)], 1);
    assert.equal(getTokenPresence(acc, 'x'), 0.6);
});

test('getTokenPresence: unseen token returns 0', () => {
    const acc = mergeEvidence(createEmptyAccumulator(), [evidence('x', 1)], 1);
    assert.equal(getTokenPresence(acc, 'never_seen'), 0);
});

test('getTokenPresence: repeated supporting evidence combines via noisy-OR (diminishing returns, bounded by 1)', () => {
    const acc = mergeEvidence(createEmptyAccumulator(), [evidence('x', 0.5), evidence('x', 0.5)], 1);
    // 1 - (1-0.5)*(1-0.5) = 1 - 0.25 = 0.75
    assert.ok(Math.abs(getTokenPresence(acc, 'x') - 0.75) < 1e-9);
});

test('getTokenPresence: presence never exceeds 1 no matter how much supporting evidence accumulates', () => {
    const many = Array.from({ length: 20 }, () => evidence('x', 0.9));
    const acc = mergeEvidence(createEmptyAccumulator(), many, 1);
    assert.ok(getTokenPresence(acc, 'x') <= 1);
    assert.ok(getTokenPresence(acc, 'x') > 0.99);
});

test('getTokenPresence: contradicting evidence lowers presence built up by supporting evidence', () => {
    const acc = mergeEvidence(
        createEmptyAccumulator(),
        [evidence('x', 0.9, 'supports'), evidence('x', 0.9, 'contradicts')],
        1
    );
    // supportPresence = 0.9, contradictPresence = 0.9 -> net = 0.9 * 0.1 = 0.09
    assert.ok(Math.abs(getTokenPresence(acc, 'x') - 0.09) < 1e-9);
});

test('getTokenPresence: strong enough contradiction can drive presence close to 0', () => {
    const acc = mergeEvidence(
        createEmptyAccumulator(),
        [evidence('x', 1.0, 'supports'), evidence('x', 1.0, 'contradicts')],
        1
    );
    assert.ok(getTokenPresence(acc, 'x') < 1e-9);
});

test('getTokenPresence: a later contradiction can reduce presence after multiple turns of support', () => {
    let acc = createEmptyAccumulator();
    acc = mergeEvidence(acc, [evidence('x', 0.8, 'supports', 1)], 1);
    const beforeContradiction = getTokenPresence(acc, 'x');
    acc = mergeEvidence(acc, [evidence('x', 0.9, 'contradicts', 2)], 2);
    const afterContradiction = getTokenPresence(acc, 'x');
    assert.ok(afterContradiction < beforeContradiction);
});

test('getAllTokenPresences: returns presence for every distinct token, matching getTokenPresence individually', () => {
    const acc = mergeEvidence(
        createEmptyAccumulator(),
        [evidence('a', 0.5), evidence('b', 0.7), evidence('a', 0.3)],
        1
    );
    const map = getAllTokenPresences(acc);
    assert.equal(map.size, 2);
    assert.ok(Math.abs(map.get('a') - getTokenPresence(acc, 'a')) < 1e-9);
    assert.ok(Math.abs(map.get('b') - getTokenPresence(acc, 'b')) < 1e-9);
});

test('getAllTokenPresences: empty accumulator returns an empty map', () => {
    const map = getAllTokenPresences(createEmptyAccumulator());
    assert.equal(map.size, 0);
});
