import test from 'node:test';
import assert from 'node:assert/strict';
import { extractTextEvidence, extractDiscriminatingAnswerEvidence } from '../evidence-extractor.js';

test('extractTextEvidence: extracts glossary-sourced tokens at full weight (1.0)', () => {
    const evidence = extractTextEvidence(
        [{ canonical: 'entity_api', source: 'glossary', raw: 'API' }],
        1
    );
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0].token, 'entity_api');
    assert.equal(evidence[0].source, 'text');
    assert.equal(evidence[0].polarity, 'supports');
    assert.equal(evidence[0].weight, 1.0);
    assert.equal(evidence[0].turn, 1);
    assert.equal(evidence[0].raw, 'API');
});

test('extractTextEvidence: extracts arabic-sourced tokens at weight 0.8', () => {
    const evidence = extractTextEvidence([{ canonical: 'مشكله', source: 'arabic', raw: 'مشكلة' }], 1);
    assert.equal(evidence[0].weight, 0.8);
});

test('extractTextEvidence: extracts arabizi-sourced tokens at weight 0.75', () => {
    const evidence = extractTextEvidence([{ canonical: 'عندي', source: 'arabizi', raw: '3andy' }], 1);
    assert.equal(evidence[0].weight, 0.75);
});

test('extractTextEvidence: excludes unrecognized-latin tokens (no diagnostic signal)', () => {
    const evidence = extractTextEvidence([{ canonical: 'randomword', source: 'unrecognized-latin', raw: 'randomword' }], 1);
    assert.deepEqual(evidence, []);
});

test('extractTextEvidence: excludes bare digit tokens', () => {
    const evidence = extractTextEvidence([{ canonical: '12345', source: 'digit', raw: '12345' }], 1);
    assert.deepEqual(evidence, []);
});

test('extractTextEvidence: excludes tokens with no canonical value', () => {
    const evidence = extractTextEvidence([{ canonical: '', source: 'glossary', raw: '' }], 1);
    assert.deepEqual(evidence, []);
});

test('extractTextEvidence: handles a realistic mixed token stream, keeping order', () => {
    const tokens = [
        { canonical: 'ال', source: 'arabic', raw: 'ال' },
        { canonical: 'entity_api', source: 'glossary', raw: 'API' },
        { canonical: 'مش', source: 'arabic', raw: 'مش' },
        { canonical: 'fel', source: 'unrecognized-latin', raw: 'fel' }
    ];
    const evidence = extractTextEvidence(tokens, 3);
    assert.equal(evidence.length, 3);
    assert.deepEqual(evidence.map((e) => e.token), ['ال', 'entity_api', 'مش']);
    assert.ok(evidence.every((e) => e.turn === 3));
});

test('extractTextEvidence: non-array input returns empty list rather than throwing', () => {
    assert.deepEqual(extractTextEvidence(null, 1), []);
    assert.deepEqual(extractTextEvidence(undefined, 1), []);
});

test('extractDiscriminatingAnswerEvidence: builds supporting evidence by default', () => {
    const evidence = extractDiscriminatingAnswerEvidence({ impliedTokens: ['مقفول'], turn: 2 });
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0].polarity, 'supports');
    assert.equal(evidence[0].weight, 0.9);
    assert.equal(evidence[0].turn, 2);
});

test('extractDiscriminatingAnswerEvidence: can build contradicting evidence', () => {
    const evidence = extractDiscriminatingAnswerEvidence({
        impliedTokens: ['باسورد'],
        polarity: 'contradicts',
        turn: 2
    });
    assert.equal(evidence[0].polarity, 'contradicts');
});

test('extractDiscriminatingAnswerEvidence: filters out empty/non-string tokens', () => {
    const evidence = extractDiscriminatingAnswerEvidence({ impliedTokens: ['valid', '', null, '  '], turn: 1 });
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0].token, 'valid');
});

test('extractDiscriminatingAnswerEvidence: non-array impliedTokens returns empty list', () => {
    assert.deepEqual(extractDiscriminatingAnswerEvidence({ impliedTokens: null, turn: 1 }), []);
});
