import test from 'node:test';
import assert from 'node:assert/strict';
import {
    validateStaticKnowledgeEntry,
    validateStaticKnowledgeEntries,
    checkLiveKnowledgeResultShape
} from '../knowledge-types.js';

function validEntry(overrides = {}) {
    return {
        key: 'test_entry',
        text: { ar: 'نص تجريبي', en: 'Test text' },
        ...overrides
    };
}

// ------------------------------------------------------------------
// validateStaticKnowledgeEntry
// ------------------------------------------------------------------

test('validateStaticKnowledgeEntry: accepts a well-formed entry', () => {
    const { valid, errors } = validateStaticKnowledgeEntry(validEntry());
    assert.equal(valid, true);
    assert.deepEqual(errors, []);
});

test('validateStaticKnowledgeEntry: rejects a non-object', () => {
    const { valid, errors } = validateStaticKnowledgeEntry(null);
    assert.equal(valid, false);
    assert.ok(errors[0].includes('not an object'));
});

test('validateStaticKnowledgeEntry: reports every missing required field', () => {
    const { valid, errors } = validateStaticKnowledgeEntry({});
    assert.equal(valid, false);
    assert.ok(errors.some((e) => e.includes('key')));
    assert.ok(errors.some((e) => e.includes('text')));
});

test('validateStaticKnowledgeEntry: rejects an empty-string key', () => {
    const { valid, errors } = validateStaticKnowledgeEntry(validEntry({ key: '  ' }));
    assert.equal(valid, false);
    assert.ok(errors.some((e) => e.includes('key must be')));
});

test('validateStaticKnowledgeEntry: rejects text missing either language', () => {
    const { valid, errors } = validateStaticKnowledgeEntry(validEntry({ text: { ar: 'نص' } }));
    assert.equal(valid, false);
    assert.ok(errors.some((e) => e.includes('text must be')));
});

test('validateStaticKnowledgeEntry: rejects an empty-string language value', () => {
    const { valid } = validateStaticKnowledgeEntry(validEntry({ text: { ar: '', en: 'Test' } }));
    assert.equal(valid, false);
});

// ------------------------------------------------------------------
// validateStaticKnowledgeEntries
// ------------------------------------------------------------------

test('validateStaticKnowledgeEntries: separates valid from invalid entries', () => {
    const { valid, invalid } = validateStaticKnowledgeEntries([validEntry({ key: 'good' }), { key: 'bad' }]);
    assert.equal(valid.length, 1);
    assert.equal(invalid.length, 1);
    assert.equal(valid[0].key, 'good');
});

test('validateStaticKnowledgeEntries: flags duplicate keys, keeping only the first', () => {
    const { valid, invalid } = validateStaticKnowledgeEntries([validEntry({ key: 'dup' }), validEntry({ key: 'dup' })]);
    assert.equal(valid.length, 1);
    assert.equal(invalid.length, 1);
    assert.ok(invalid[0].errors[0].includes('duplicate key'));
});

test('validateStaticKnowledgeEntries: a non-array input degrades to an empty result rather than throwing', () => {
    const { valid, invalid } = validateStaticKnowledgeEntries(null);
    assert.deepEqual(valid, []);
    assert.deepEqual(invalid, []);
});

// ------------------------------------------------------------------
// checkLiveKnowledgeResultShape
// ------------------------------------------------------------------

test('checkLiveKnowledgeResultShape: accepts an unavailable result', () => {
    assert.deepEqual(checkLiveKnowledgeResultShape({ available: false, data: null }), []);
});

test('checkLiveKnowledgeResultShape: accepts an available result with data', () => {
    assert.deepEqual(checkLiveKnowledgeResultShape({ available: true, data: { tickets: [] } }), []);
});

test('checkLiveKnowledgeResultShape: flags a non-boolean available field', () => {
    const problems = checkLiveKnowledgeResultShape({ available: 'yes', data: null });
    assert.ok(problems.some((p) => p.includes('available')));
});

test('checkLiveKnowledgeResultShape: flags available:true with no data field at all', () => {
    const problems = checkLiveKnowledgeResultShape({ available: true });
    assert.ok(problems.some((p) => p.includes('data')));
});

test('checkLiveKnowledgeResultShape: rejects a non-object', () => {
    assert.deepEqual(checkLiveKnowledgeResultShape(undefined), ['result is not an object']);
});
