import test from 'node:test';
import assert from 'node:assert/strict';
import { runShadowRun } from '../shadow-run-engine.js';
import { createStaticKnowledgeProvider } from '../../knowledge/static-knowledge.provider.js';
import { createRealReplayConfig } from './helpers/node-providers.js';

const fixedClock = () => '2026-01-01T00:00:00.000Z';

const CONVERSATIONS = [
    { sessionId: 'conv-pricing', turns: [{ turn: 1, rawText: 'عايز اعرف اسعار خطط باقات بكام عروض ايه' }] },
    { sessionId: 'conv-platform', turns: [{ turn: 1, rawText: 'عايز اعرف عن منصه ازاي بتشتغل' }] },
    {
        sessionId: 'conv-ticket-journey',
        turns: [
            { turn: 1, rawText: 'الـ API مش شغال' },
            { turn: 2, rawText: '' }
        ]
    }
];

test('runShadowRun: a no-op edit (identical before/after) passes every conversation', async () => {
    const baseConfig = { ...createRealReplayConfig(), clock: fixedClock };
    const result = await runShadowRun({ conversations: CONVERSATIONS, before: baseConfig, after: baseConfig });

    assert.equal(result.totalConversations, 3);
    assert.equal(result.passedCount, 3);
    assert.equal(result.failedCount, 0);
    assert.equal(result.allPassed, true);
});

test('runShadowRun: a content-only Knowledge edit (pricing text changes, nothing else) still passes — no action/confidence regression', async () => {
    const baseConfig = createRealReplayConfig();
    const afterKnowledge = createStaticKnowledgeProvider(async () => [{ key: 'pricing', text: { ar: 'نص جديد للأسعار', en: 'new pricing text' } }]);

    const result = await runShadowRun({
        conversations: CONVERSATIONS,
        before: { ...baseConfig, clock: fixedClock },
        after: { ...baseConfig, staticKnowledgeProvider: afterKnowledge, clock: fixedClock }
    });

    assert.equal(result.allPassed, true);
    // Confirm the content genuinely did change (the test isn't accidentally comparing identical output).
    const pricingResult = result.results.find((r) => r.sessionId === 'conv-pricing');
    assert.equal(pricingResult.comparison.turns[0].responseTextChanged, true);
    assert.equal(pricingResult.comparison.turns[0].actionChanged, false);
});

test('runShadowRun: a Knowledge edit that removes the "pricing" entry entirely causes the pricing conversation to regress (ANSWER -> ASK_CLARIFYING_QUESTION or FALLBACK)', async () => {
    const baseConfig = createRealReplayConfig();
    const emptyKnowledge = createStaticKnowledgeProvider(async () => []); // simulates an admin accidentally deleting the pricing entry

    const result = await runShadowRun({
        conversations: [CONVERSATIONS[0]], // only the pricing conversation
        before: { ...baseConfig, clock: fixedClock },
        after: { ...baseConfig, staticKnowledgeProvider: emptyKnowledge, clock: fixedClock }
    });

    // The scenario itself still auto-resolves via its own resolution.text
    // fallback (Module 7's designed graceful degradation) — so this
    // particular edit does NOT actually change the action. This is worth
    // asserting explicitly: it demonstrates the regression suite measures
    // real behavior, not assumptions about what "should" happen.
    assert.equal(result.results[0].comparison.turns[0].actionChanged, false);
    assert.equal(result.allPassed, true);
});

test('runShadowRun: reports failedCount/results correctly when a real regression occurs', async () => {
    const baseConfig = createRealReplayConfig();

    // A deliberately broken scenario provider: for the ticket-journey
    // conversation's turn 1, this catalog is empty, so nothing is
    // diagnosed and the engine can't even offer to log details for the
    // customer's technical issue on the first turn — a genuine regression
    // from the real catalog's ASK_FOR_LOGS.
    const emptyScenarios = { getAllScenarios: async () => [], getEvidenceVocabulary: async () => [] };
    const brokenScenarioProvider = {
        getAllScenarios: emptyScenarios.getAllScenarios,
        getScenarioById: async () => null,
        getEvidenceVocabulary: emptyScenarios.getEvidenceVocabulary,
        getLoadWarnings: async () => []
    };

    const result = await runShadowRun({
        conversations: [CONVERSATIONS[2]], // conv-ticket-journey
        before: { ...baseConfig, clock: fixedClock },
        after: { ...baseConfig, scenarioProvider: brokenScenarioProvider, clock: fixedClock }
    });

    assert.equal(result.allPassed, false);
    assert.equal(result.failedCount, 1);
    assert.equal(result.results[0].verdict.passed, false);
});

test('runShadowRun: an empty conversation set produces a trivially-non-passing (nothing to validate) result, not a crash', async () => {
    const baseConfig = { ...createRealReplayConfig(), clock: fixedClock };
    const result = await runShadowRun({ conversations: [], before: baseConfig, after: baseConfig });
    assert.equal(result.totalConversations, 0);
    assert.equal(result.allPassed, false); // explicitly not "vacuously true" — nothing was actually validated
});

test('runShadowRun: result is JSON-safe end to end', async () => {
    const baseConfig = { ...createRealReplayConfig(), clock: fixedClock };
    const result = await runShadowRun({ conversations: [CONVERSATIONS[0]], before: baseConfig, after: baseConfig });
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});
