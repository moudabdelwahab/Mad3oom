import test from 'node:test';
import assert from 'node:assert/strict';
import { createTechnicalGlossaryProvider } from '../technical-glossary.provider.js';
import { createArabiziMapProvider } from '../arabizi-map.provider.js';

test('technical-glossary provider: caches after first load (loadFn called exactly once)', async () => {
    let callCount = 0;
    const provider = createTechnicalGlossaryProvider(async () => {
        callCount += 1;
        return [{ canonical: 'x', labels: { ar: 'x', en: 'x' }, patterns: ['x'] }];
    });

    await provider.getEntries();
    await provider.getEntries();
    await provider.getEntries();

    assert.equal(callCount, 1);
});

test('technical-glossary provider: concurrent calls before first resolution still only load once', async () => {
    let callCount = 0;
    const provider = createTechnicalGlossaryProvider(async () => {
        callCount += 1;
        await new Promise((r) => setTimeout(r, 10));
        return [];
    });

    await Promise.all([provider.getEntries(), provider.getEntries(), provider.getEntries()]);
    assert.equal(callCount, 1);
});

test('technical-glossary provider: non-array loader result degrades to empty list rather than throwing', async () => {
    const provider = createTechnicalGlossaryProvider(async () => null);
    const entries = await provider.getEntries();
    assert.deepEqual(entries, []);
});

test('arabizi-map provider: caches after first load (loadFn called exactly once)', async () => {
    let callCount = 0;
    const provider = createArabiziMapProvider(async () => {
        callCount += 1;
        return { digitLetterMap: { '3': 'ع' }, wordMap: { msh: 'مش' } };
    });

    await provider.getMap();
    await provider.getMap();

    assert.equal(callCount, 1);
});

test('arabizi-map provider: missing sub-maps in loader result default to empty objects, not undefined', async () => {
    const provider = createArabiziMapProvider(async () => ({}));
    const map = await provider.getMap();
    assert.deepEqual(map.digitLetterMap, {});
    assert.deepEqual(map.wordMap, {});
});

test('arabizi-map provider: entirely null/undefined loader result is handled without throwing', async () => {
    const provider = createArabiziMapProvider(async () => null);
    const map = await provider.getMap();
    assert.deepEqual(map, { digitLetterMap: {}, wordMap: {} });
});
