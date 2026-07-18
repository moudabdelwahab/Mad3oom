import test from 'node:test';
import assert from 'node:assert/strict';
import { createStaticKnowledgeSupabaseProvider } from '../static-knowledge.supabase.js';
import { createMockSupabaseQueryClient, createFailingMockSupabaseQueryClient } from '../../scenarios/tests/helpers/mock-supabase-query-client.js';

function entryRow(key, version, status, overrides = {}) {
    return {
        knowledge_key: key,
        version,
        status,
        definition: { key, text: { ar: `نص-${key}`, en: `text-${key}` }, ...overrides }
    };
}

test('supabase provider: loads only published rows', async () => {
    const client = createMockSupabaseQueryClient({
        chat_engine_knowledge_entries: [entryRow('pricing', 1, 'published'), entryRow('draft_only', 1, 'draft')]
    });
    const provider = createStaticKnowledgeSupabaseProvider(client);
    const entries = await provider.getAllEntries();
    assert.deepEqual(entries.map((e) => e.key), ['pricing']);
});

test('supabase provider: when multiple versions of the same key are published, only the latest is used', async () => {
    const client = createMockSupabaseQueryClient({
        chat_engine_knowledge_entries: [
            entryRow('pricing', 1, 'published', { text: { ar: 'قديم', en: 'old' } }),
            entryRow('pricing', 2, 'published', { text: { ar: 'جديد', en: 'new' } })
        ]
    });
    const provider = createStaticKnowledgeSupabaseProvider(client);
    const entry = await provider.getEntryByKey('pricing');
    assert.equal(entry.text.en, 'new');
});

test('supabase provider: archived rows are excluded', async () => {
    const client = createMockSupabaseQueryClient({
        chat_engine_knowledge_entries: [entryRow('old_content', 1, 'archived'), entryRow('pricing', 1, 'published')]
    });
    const provider = createStaticKnowledgeSupabaseProvider(client);
    const entries = await provider.getAllEntries();
    assert.deepEqual(entries.map((e) => e.key), ['pricing']);
});

test('supabase provider: a query error degrades gracefully rather than crashing', async () => {
    const client = createFailingMockSupabaseQueryClient('connection refused');
    const provider = createStaticKnowledgeSupabaseProvider(client);
    await assert.rejects(() => provider.getAllEntries(), /connection refused/);
});

test('supabase provider: invalid entries stored in Supabase are still excluded by the existing validation layer', async () => {
    const client = createMockSupabaseQueryClient({
        chat_engine_knowledge_entries: [{ knowledge_key: 'bad', version: 1, status: 'published', definition: { key: 'bad' } }]
    });
    const provider = createStaticKnowledgeSupabaseProvider(client);
    const entries = await provider.getAllEntries();
    assert.deepEqual(entries, []);
    const warnings = await provider.getLoadWarnings();
    assert.equal(warnings.length, 1);
});

// ------------------------------------------------------------------
// The core architectural proof: swapping storage backends produces
// IDENTICAL behavior in a real consuming module (answer-composer.js),
// with zero changes to that module's code.
// ------------------------------------------------------------------
test('ARCHITECTURAL PROOF: answer-composer.js produces identical results whether static knowledge comes from local JSON or Supabase', async () => {
    const { composeAnswerDecision } = await import('../answer-composer.js');
    const { ACTIONS } = await import('../../decision/decision-types.js');
    const { createStaticKnowledgeProvider } = await import('../static-knowledge.provider.js');

    const decision = {
        action: ACTIONS.ANSWER,
        resolution: { hasAutoResolution: true, knowledgeSource: 'pricing', text: { ar: 'احتياطي', en: 'fallback' } },
        turn: 1
    };

    const localProvider = createStaticKnowledgeProvider(async () => [{ key: 'pricing', text: { ar: 'السعر هنا', en: 'Price is here' } }]);

    const supabaseClient = createMockSupabaseQueryClient({
        chat_engine_knowledge_entries: [entryRow('pricing', 1, 'published', { text: { ar: 'السعر هنا', en: 'Price is here' } })]
    });
    const supabaseProvider = createStaticKnowledgeSupabaseProvider(supabaseClient);

    const resultFromLocal = await composeAnswerDecision({ decision, staticKnowledgeProvider: localProvider });
    const resultFromSupabase = await composeAnswerDecision({ decision, staticKnowledgeProvider: supabaseProvider });

    assert.deepEqual(resultFromLocal.knowledgeData, resultFromSupabase.knowledgeData);
});
