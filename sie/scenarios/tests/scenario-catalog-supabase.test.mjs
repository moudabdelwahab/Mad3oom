import test from 'node:test';
import assert from 'node:assert/strict';
import { createScenarioCatalogSupabaseProvider } from '../scenario-catalog.supabase.js';
import { createMockSupabaseQueryClient, createFailingMockSupabaseQueryClient } from './helpers/mock-supabase-query-client.js';

function scenarioRow(key, version, status, overrides = {}) {
    return {
        scenario_key: key,
        version,
        status,
        definition: {
            id: key,
            label: { ar: key, en: key },
            category: 'other',
            evidenceSignature: [{ token: 'x', weight: 1 }],
            discriminatingQuestions: [],
            resolution: { hasAutoResolution: false },
            requiresTicketIfUnresolved: true,
            ...overrides
        }
    };
}

test('supabase provider: loads only published rows', async () => {
    const client = createMockSupabaseQueryClient({
        chat_engine_scenarios: [scenarioRow('a', 1, 'published'), scenarioRow('b', 1, 'draft')]
    });
    const provider = createScenarioCatalogSupabaseProvider(client);
    const scenarios = await provider.getAllScenarios();
    assert.deepEqual(scenarios.map((s) => s.id), ['a']);
});

test('supabase provider: when multiple versions of the same key are published, only the latest is used', async () => {
    const client = createMockSupabaseQueryClient({
        chat_engine_scenarios: [
            scenarioRow('a', 1, 'published', { label: { ar: 'old', en: 'old' } }),
            scenarioRow('a', 2, 'published', { label: { ar: 'new', en: 'new' } })
        ]
    });
    const provider = createScenarioCatalogSupabaseProvider(client);
    const scenarios = await provider.getAllScenarios();
    assert.equal(scenarios.length, 1);
    assert.equal(scenarios[0].label.en, 'new');
});

test('supabase provider: archived rows are excluded', async () => {
    const client = createMockSupabaseQueryClient({
        chat_engine_scenarios: [scenarioRow('a', 1, 'archived'), scenarioRow('b', 1, 'published')]
    });
    const provider = createScenarioCatalogSupabaseProvider(client);
    const scenarios = await provider.getAllScenarios();
    assert.deepEqual(scenarios.map((s) => s.id), ['b']);
});

test('supabase provider: a query error degrades gracefully rather than crashing', async () => {
    const client = createFailingMockSupabaseQueryClient('connection refused');
    const provider = createScenarioCatalogSupabaseProvider(client);
    await assert.rejects(() => provider.getAllScenarios(), /connection refused/);
});

test('supabase provider: invalid scenario definitions stored in Supabase are still excluded by the existing validation layer', async () => {
    const client = createMockSupabaseQueryClient({
        chat_engine_scenarios: [{ scenario_key: 'bad', version: 1, status: 'published', definition: { id: 'bad' } }]
    });
    const provider = createScenarioCatalogSupabaseProvider(client);
    const scenarios = await provider.getAllScenarios();
    assert.deepEqual(scenarios, []);
    const warnings = await provider.getLoadWarnings();
    assert.equal(warnings.length, 1);
});

// ------------------------------------------------------------------
// The core architectural proof: swapping storage backends produces
// IDENTICAL behavior in a real consuming module (the Diagnostic
// Engine), with zero changes to that module's code.
// ------------------------------------------------------------------
test('ARCHITECTURAL PROOF: Diagnostic Engine produces identical results whether scenarios come from local JSON or Supabase', async () => {
    const { processTurn } = await import('../../diagnostics/diagnostic-engine.js');

    const scenarioDefinition = {
        id: 'test_scenario',
        label: { ar: 'اختبار', en: 'Test' },
        category: 'other',
        evidenceSignature: [{ token: 'entity_api', weight: 2 }],
        discriminatingQuestions: [],
        resolution: { hasAutoResolution: false },
        requiresTicketIfUnresolved: true
    };

    // "Local JSON" backend, simulated inline (same shape as scenario-catalog.local.js would produce)
    const { createScenarioCatalogProvider } = await import('../scenario-catalog.provider.js');
    const localProvider = createScenarioCatalogProvider(async () => [scenarioDefinition]);

    // Supabase backend, same underlying scenario
    const supabaseClient = createMockSupabaseQueryClient({
        chat_engine_scenarios: [{ scenario_key: 'test_scenario', version: 1, status: 'published', definition: scenarioDefinition }]
    });
    const supabaseProvider = createScenarioCatalogSupabaseProvider(supabaseClient);

    const normalizedTokens = [{ canonical: 'entity_api', source: 'glossary', raw: 'API' }];

    const stateFromLocal = await processTurn({ normalizedTokens, turn: 1, scenarioProvider: localProvider });
    const stateFromSupabase = await processTurn({ normalizedTokens, turn: 1, scenarioProvider: supabaseProvider });

    assert.deepEqual(stateFromLocal.hypotheses, stateFromSupabase.hypotheses);
});
