import test from 'node:test';
import assert from 'node:assert/strict';
import { compareReplays } from '../comparison-engine.js';

function traceEvent(turn, { action = 'ANSWER', scenarioId = 's1', confidence = 0.8, responseText = 'reply' } = {}) {
    return { turn, decision: { action, scenarioId, confidence }, responseText };
}

test('compareReplays: identical before/after produces zero changes on every turn', () => {
    const before = { sessionId: 's1', traceEvents: [traceEvent(1)] };
    const after = { sessionId: 's1', traceEvents: [traceEvent(1)] };
    const result = compareReplays(before, after);
    assert.equal(result.turns[0].actionChanged, false);
    assert.equal(result.turns[0].scenarioChanged, false);
    assert.equal(result.turns[0].confidenceDelta, 0);
    assert.equal(result.turns[0].responseTextChanged, false);
});

test('compareReplays: detects an action change', () => {
    const before = { sessionId: 's1', traceEvents: [traceEvent(1, { action: 'ANSWER' })] };
    const after = { sessionId: 's1', traceEvents: [traceEvent(1, { action: 'FALLBACK' })] };
    const result = compareReplays(before, after);
    assert.equal(result.turns[0].actionChanged, true);
});

test('compareReplays: computes confidenceDelta as after - before', () => {
    const before = { sessionId: 's1', traceEvents: [traceEvent(1, { confidence: 0.5 })] };
    const after = { sessionId: 's1', traceEvents: [traceEvent(1, { confidence: 0.3 })] };
    const result = compareReplays(before, after);
    assert.ok(Math.abs(result.turns[0].confidenceDelta - -0.2) < 1e-9);
});

test('compareReplays: confidenceDelta is null when either side has a null confidence', () => {
    const before = { sessionId: 's1', traceEvents: [traceEvent(1, { confidence: null })] };
    const after = { sessionId: 's1', traceEvents: [traceEvent(1, { confidence: 0.5 })] };
    const result = compareReplays(before, after);
    assert.equal(result.turns[0].confidenceDelta, null);
});

test('compareReplays: detects a scenario change even when action stays the same', () => {
    const before = { sessionId: 's1', traceEvents: [traceEvent(1, { scenarioId: 'a' })] };
    const after = { sessionId: 's1', traceEvents: [traceEvent(1, { scenarioId: 'b' })] };
    const result = compareReplays(before, after);
    assert.equal(result.turns[0].scenarioChanged, true);
    assert.equal(result.turns[0].actionChanged, false);
});

test('compareReplays: detects a response text change', () => {
    const before = { sessionId: 's1', traceEvents: [traceEvent(1, { responseText: 'old text' })] };
    const after = { sessionId: 's1', traceEvents: [traceEvent(1, { responseText: 'new text' })] };
    const result = compareReplays(before, after);
    assert.equal(result.turns[0].responseTextChanged, true);
});

test('compareReplays: merges turns present in only one side, marking the missing side null', () => {
    const before = { sessionId: 's1', traceEvents: [traceEvent(1), traceEvent(2)] };
    const after = { sessionId: 's1', traceEvents: [traceEvent(1)] };
    const result = compareReplays(before, after);
    assert.equal(result.turns.length, 2);
    assert.equal(result.turns[1].after, null);
    assert.ok(result.turns[1].before);
});

test('compareReplays: turns are ordered ascending regardless of input order', () => {
    const before = { sessionId: 's1', traceEvents: [traceEvent(3), traceEvent(1), traceEvent(2)] };
    const after = { sessionId: 's1', traceEvents: [traceEvent(3), traceEvent(1), traceEvent(2)] };
    const result = compareReplays(before, after);
    assert.deepEqual(result.turns.map((t) => t.turn), [1, 2, 3]);
});

test('compareReplays: missing/empty inputs degrade to an empty comparison rather than throwing', () => {
    const result = compareReplays(null, null);
    assert.deepEqual(result.turns, []);
});

test('compareReplays: result round-trips through JSON', () => {
    const before = { sessionId: 's1', traceEvents: [traceEvent(1)] };
    const after = { sessionId: 's1', traceEvents: [traceEvent(1, { confidence: 0.5 })] };
    const result = compareReplays(before, after);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});
