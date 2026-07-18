import test from 'node:test';
import assert from 'node:assert/strict';
import { createStaticKnowledgeProvider } from '../static-knowledge.provider.js';

function validEntry(overrides = {}) {
    return {
        key: 'test_entry',
        text: { ar: 'نص تجريبي', en: 'Test text' },
        ...overrides
    };
}

test('provider: caches after first load (loadFn called exactly once across multiple methods)', async () => {
    let callCount = 0;
    const provider = createStaticKnowledgeProvider(async () => {
        callCount += 1;
        return [validEntry()];
    });

    await provider.getAllEntries();
    await provider.getEntryByKey('test_entry');
    await provider.getLoadWarnings();

    assert.equal(callCount, 1);
});

test('provider: concurrent calls before first resolution still only load once', async () => {
    let callCount = 0;
    const provider = createStaticKnowledgeProvider(async () => {
        callCount += 1;
        await new Promise((r) => setTimeout(r, 10));
        return [validEntry()];
    });

    await Promise.all([provider.getAllEntries(), provider.getAllEntries(), provider.getAllEntries()]);
    assert.equal(callCount, 1);
});

test('provider: getAllEntries excludes invalid entries rather than throwing', async () => {
    const provider = createStaticKnowledgeProvider(async () => [validEntry({ key: 'good' }), { key: 'bad' }]);
    const entries = await provider.getAllEntries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].key, 'good');
});

test('provider: getLoadWarnings reports which entries were skipped and why', async () => {
    const provider = createStaticKnowledgeProvider(async () => [{ key: 'bad' }]);
    const warnings = await provider.getLoadWarnings();
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes('bad'));
});

test('provider: duplicate keys result in only the first being kept, both flagged in warnings', async () => {
    const provider = createStaticKnowledgeProvider(async () => [validEntry({ key: 'dup' }), validEntry({ key: 'dup' })]);
    const entries = await provider.getAllEntries();
    const warnings = await provider.getLoadWarnings();
    assert.equal(entries.length, 1);
    assert.equal(warnings.length, 1);
});

test('provider: getEntryByKey returns null for an unknown key rather than throwing', async () => {
    const provider = createStaticKnowledgeProvider(async () => [validEntry({ key: 'exists' })]);
    const result = await provider.getEntryByKey('does_not_exist');
    assert.equal(result, null);
});

test('provider: getEntryByKey returns the matching entry', async () => {
    const provider = createStaticKnowledgeProvider(async () => [validEntry({ key: 'exists' })]);
    const result = await provider.getEntryByKey('exists');
    assert.equal(result.key, 'exists');
});

test('provider: non-array loader result degrades to an empty set rather than throwing', async () => {
    const provider = createStaticKnowledgeProvider(async () => null);
    const entries = await provider.getAllEntries();
    assert.deepEqual(entries, []);
});
