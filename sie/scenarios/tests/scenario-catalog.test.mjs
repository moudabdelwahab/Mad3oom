import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRealScenarioCatalogProvider } from './helpers/node-providers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('scenario catalog: the real shipped scenarios.json loads with zero validation warnings', async () => {
    const provider = createRealScenarioCatalogProvider();
    const warnings = await provider.getLoadWarnings();
    assert.deepEqual(warnings, [], 'scenarios.json should be fully schema-valid');
});

test('scenario catalog: loads all expected scenarios with unique ids', async () => {
    const provider = createRealScenarioCatalogProvider();
    const scenarios = await provider.getAllScenarios();
    assert.ok(scenarios.length >= 12, `expected at least 12 scenarios, got ${scenarios.length}`);

    const ids = scenarios.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length, 'all scenario ids must be unique');
});

test('scenario catalog: includes the fallback "unknown" scenario as a safety net', async () => {
    const provider = createRealScenarioCatalogProvider();
    const scenario = await provider.getScenarioById('unknown');
    assert.ok(scenario, 'catalog must include an "unknown" fallback scenario');
    assert.equal(scenario.requiresTicketIfUnresolved, true);
    assert.equal(scenario.resolution.hasAutoResolution, false);
});

test('scenario catalog: getScenarioById returns null for a non-existent id', async () => {
    const provider = createRealScenarioCatalogProvider();
    const result = await provider.getScenarioById('this_scenario_does_not_exist');
    assert.equal(result, null);
});

test('scenario catalog: login_token_expired is correctly configured with auto-resolution', async () => {
    const provider = createRealScenarioCatalogProvider();
    const scenario = await provider.getScenarioById('login_token_expired');
    assert.ok(scenario);
    assert.equal(scenario.category, 'login');
    assert.equal(scenario.resolution.hasAutoResolution, true);
    assert.ok(scenario.resolution.text.ar.length > 0);
    assert.ok(scenario.resolution.text.en.length > 0);
});

test('scenario catalog: every scenario with hasAutoResolution=true has non-empty bilingual resolution text', async () => {
    const provider = createRealScenarioCatalogProvider();
    const scenarios = await provider.getAllScenarios();
    for (const scenario of scenarios) {
        if (scenario.resolution.hasAutoResolution) {
            assert.ok(
                scenario.resolution.text?.ar?.length > 0 && scenario.resolution.text?.en?.length > 0,
                `${scenario.id} claims auto-resolution but is missing bilingual text`
            );
        }
    }
});

test('scenario catalog: getEvidenceVocabulary contains expected key technical tokens', async () => {
    const provider = createRealScenarioCatalogProvider();
    const vocabulary = await provider.getEvidenceVocabulary();
    for (const expectedToken of ['entity_api', 'entity_dns', 'entity_webhook', 'http_status_500', 'entity_token']) {
        assert.ok(vocabulary.includes(expectedToken), `expected "${expectedToken}" in evidence vocabulary`);
    }
});

test('scenario catalog: discriminating questions (where present) always carry bilingual prompts', async () => {
    const provider = createRealScenarioCatalogProvider();
    const scenarios = await provider.getAllScenarios();
    for (const scenario of scenarios) {
        for (const q of scenario.discriminatingQuestions) {
            assert.ok(q.prompt.ar.length > 0 && q.prompt.en.length > 0, `${scenario.id}/${q.id} missing bilingual prompt`);
        }
    }
});

test('cross-module consistency: every glossary-shaped evidence token used by scenarios exists in Module 1\'s technical glossary', async () => {
    // Evidence tokens following the glossary's own naming convention
    // (entity_*, http_status_*, symptom_*) are expected to correspond to
    // an ACTUAL canonical token Module 1's normalizer can produce. This
    // guards against the two modules silently drifting apart — e.g. if
    // someone renames a canonical token in the glossary without updating
    // the scenario catalog (or vice versa), this test fails loudly
    // instead of the mismatch being discovered later via a silently
    // never-matching scenario.
    const glossaryPath = path.join(__dirname, '..', '..', 'language', 'data', 'technical-glossary.json');
    const glossaryData = JSON.parse(fs.readFileSync(glossaryPath, 'utf-8'));
    const glossaryCanonicals = new Set(glossaryData.entries.map((e) => e.canonical));

    const provider = createRealScenarioCatalogProvider();
    const vocabulary = await provider.getEvidenceVocabulary();

    const glossaryShaped = vocabulary.filter(
        (token) => token.startsWith('entity_') || token.startsWith('http_status_') || token.startsWith('symptom_')
    );

    const missing = glossaryShaped.filter((token) => !glossaryCanonicals.has(token));
    assert.deepEqual(
        missing,
        [],
        `these scenario evidence tokens look glossary-shaped but don't exist in technical-glossary.json: ${missing.join(', ')}`
    );
});
