import test from 'node:test';
import assert from 'node:assert/strict';
import { validateScenario, validateCatalog } from '../scenario-types.js';

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

test('validateScenario: accepts a well-formed scenario', () => {
    const { valid, errors } = validateScenario(validScenario());
    assert.equal(valid, true);
    assert.deepEqual(errors, []);
});

test('validateScenario: rejects null/non-object input', () => {
    assert.equal(validateScenario(null).valid, false);
    assert.equal(validateScenario('not an object').valid, false);
    assert.equal(validateScenario(undefined).valid, false);
});

test('validateScenario: rejects missing required top-level fields', () => {
    const { id, ...missingId } = validScenario();
    const result = validateScenario(missingId);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('id')));
});

test('validateScenario: rejects empty-string id', () => {
    const result = validateScenario(validScenario({ id: '   ' }));
    assert.equal(result.valid, false);
});

test('validateScenario: rejects a label missing either language', () => {
    const arOnly = validateScenario(validScenario({ label: { ar: 'مشكلة' } }));
    assert.equal(arOnly.valid, false);
    const enOnly = validateScenario(validScenario({ label: { en: 'Problem' } }));
    assert.equal(enOnly.valid, false);
});

test('validateScenario: rejects empty evidenceSignature', () => {
    const result = validateScenario(validScenario({ evidenceSignature: [] }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('evidenceSignature')));
});

test('validateScenario: rejects evidenceSignature entries with non-numeric weight', () => {
    const result = validateScenario(
        validScenario({ evidenceSignature: [{ token: 'x', weight: 'high' }] })
    );
    assert.equal(result.valid, false);
});

test('validateScenario: rejects evidenceSignature entries with an invalid source value', () => {
    const result = validateScenario(
        validScenario({ evidenceSignature: [{ token: 'x', weight: 1, source: 'telepathy' }] })
    );
    assert.equal(result.valid, false);
});

test('validateScenario: accepts evidenceSignature entries without an explicit source', () => {
    const result = validateScenario(
        validScenario({ evidenceSignature: [{ token: 'x', weight: 1 }] })
    );
    assert.equal(result.valid, true);
});

test('validateScenario: rejects a discriminating question missing a prompt', () => {
    const result = validateScenario(
        validScenario({
            discriminatingQuestions: [{ id: 'q1', resolvesEvidence: [] }]
        })
    );
    assert.equal(result.valid, false);
});

test('validateScenario: accepts an empty discriminatingQuestions array', () => {
    const result = validateScenario(validScenario({ discriminatingQuestions: [] }));
    assert.equal(result.valid, true);
});

test('validateScenario: requires resolution.text when hasAutoResolution is true', () => {
    const result = validateScenario(
        validScenario({ resolution: { hasAutoResolution: true } })
    );
    assert.equal(result.valid, false);
});

test('validateScenario: accepts resolution without text when hasAutoResolution is false', () => {
    const result = validateScenario(validScenario({ resolution: { hasAutoResolution: false } }));
    assert.equal(result.valid, true);
});

test('validateScenario: rejects non-boolean requiresTicketIfUnresolved', () => {
    const result = validateScenario(validScenario({ requiresTicketIfUnresolved: 'yes' }));
    assert.equal(result.valid, false);
});

test('validateScenario: rejects empty category', () => {
    const result = validateScenario(validScenario({ category: '' }));
    assert.equal(result.valid, false);
});

test('validateCatalog: separates valid and invalid entries without throwing', () => {
    const good = validScenario({ id: 'good_one' });
    const bad = { id: 'bad_one' }; // missing everything else
    const { valid, invalid } = validateCatalog([good, bad]);
    assert.equal(valid.length, 1);
    assert.equal(valid[0].id, 'good_one');
    assert.equal(invalid.length, 1);
});

test('validateCatalog: flags duplicate ids as invalid rather than silently overwriting', () => {
    const first = validScenario({ id: 'dup' });
    const second = validScenario({ id: 'dup', label: { ar: 'تاني', en: 'Second' } });
    const { valid, invalid } = validateCatalog([first, second]);
    assert.equal(valid.length, 1);
    assert.equal(invalid.length, 1);
    assert.ok(invalid[0].errors[0].includes('duplicate id'));
});

test('validateCatalog: non-array input degrades to an empty catalog rather than throwing', () => {
    const { valid, invalid } = validateCatalog(null);
    assert.deepEqual(valid, []);
    assert.deepEqual(invalid, []);
});

test('validateCatalog: empty array input is valid and produces an empty catalog', () => {
    const { valid, invalid } = validateCatalog([]);
    assert.deepEqual(valid, []);
    assert.deepEqual(invalid, []);
});
