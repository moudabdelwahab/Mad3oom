import test from 'node:test';
import assert from 'node:assert/strict';
import { createScenarioCatalogProvider } from '../scenario-catalog.provider.js';

function validScenario(overrides = {}) {
    return {
        id: 'test_scenario',
        label: { ar: 'مشكلة تجريبية', en: 'Test scenario' },
        evidenceSignature: [{ token: 'symptom_generic_error', weight: 1, source: 'text' }],
        discriminatingQuestions: [],
        resolution: { hasAutoResolution: false },
        requiresTicketIfUnresolved: true,
        category: 'other',
        ...overrides
    };
}

test('provider: caches after first load (loadFn called exactly once across multiple methods)', async () => {
    let callCount = 0;
    const provider = createScenarioCatalogProvider(async () => {
        callCount += 1;
        return [validScenario()];
    });

    await provider.getAllScenarios();
    await provider.getScenarioById('test_scenario');
    await provider.getEvidenceVocabulary();
    await provider.getLoadWarnings();

    assert.equal(callCount, 1);
});

test('provider: concurrent calls before first resolution still only load once', async () => {
    let callCount = 0;
    const provider = createScenarioCatalogProvider(async () => {
        callCount += 1;
        await new Promise((r) => setTimeout(r, 10));
        return [validScenario()];
    });

    await Promise.all([provider.getAllScenarios(), provider.getAllScenarios(), provider.getAllScenarios()]);
    assert.equal(callCount, 1);
});

test('provider: getAllScenarios excludes invalid entries rather than throwing', async () => {
    const provider = createScenarioCatalogProvider(async () => [
        validScenario({ id: 'good' }),
        { id: 'bad' } // missing required fields
    ]);

    const scenarios = await provider.getAllScenarios();
    assert.equal(scenarios.length, 1);
    assert.equal(scenarios[0].id, 'good');
});

test('provider: getLoadWarnings reports which entries were skipped and why', async () => {
    const provider = createScenarioCatalogProvider(async () => [{ id: 'bad' }]);
    const warnings = await provider.getLoadWarnings();
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes('bad'));
});

test('provider: duplicate ids result in only the first being kept, both flagged in warnings', async () => {
    const provider = createScenarioCatalogProvider(async () => [
        validScenario({ id: 'dup' }),
        validScenario({ id: 'dup' })
    ]);
    const scenarios = await provider.getAllScenarios();
    const warnings = await provider.getLoadWarnings();
    assert.equal(scenarios.length, 1);
    assert.equal(warnings.length, 1);
});

test('provider: getScenarioById returns null for an unknown id rather than throwing', async () => {
    const provider = createScenarioCatalogProvider(async () => [validScenario({ id: 'exists' })]);
    const result = await provider.getScenarioById('does_not_exist');
    assert.equal(result, null);
});

test('provider: getScenarioById returns the matching scenario', async () => {
    const provider = createScenarioCatalogProvider(async () => [validScenario({ id: 'exists' })]);
    const result = await provider.getScenarioById('exists');
    assert.equal(result.id, 'exists');
});

test('provider: getEvidenceVocabulary deduplicates tokens shared across scenarios', async () => {
    const provider = createScenarioCatalogProvider(async () => [
        validScenario({ id: 'a', evidenceSignature: [{ token: 'shared_token', weight: 1 }] }),
        validScenario({ id: 'b', evidenceSignature: [{ token: 'shared_token', weight: 2 }, { token: 'unique_token', weight: 1 }] })
    ]);
    const vocabulary = await provider.getEvidenceVocabulary();
    assert.deepEqual(vocabulary.sort(), ['shared_token', 'unique_token'].sort());
});

test('provider: non-array loader result degrades to an empty catalog rather than throwing', async () => {
    const provider = createScenarioCatalogProvider(async () => null);
    const scenarios = await provider.getAllScenarios();
    assert.deepEqual(scenarios, []);
});
