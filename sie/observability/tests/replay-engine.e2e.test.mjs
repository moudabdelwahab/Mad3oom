import test from 'node:test';
import assert from 'node:assert/strict';
import { replayConversation } from '../replay-engine.js';
import { createStaticKnowledgeProvider } from '../../knowledge/static-knowledge.provider.js';
import { createScenarioCatalogProvider } from '../../scenarios/scenario-catalog.provider.js';
import { createRealReplayConfig } from './helpers/node-providers.js';
import { ACTIONS } from '../../decision/decision-types.js';

const fixedClock = () => '2026-01-01T00:00:00.000Z';

// Numbers were empirically captured by running replayConversation() with
// the real pipeline before writing these assertions — same discipline
// established in Modules 3-8.

test('replayConversation: reproduces the exact same two-turn CREATE_TICKET journey as the live pipeline (Journey C)', async () => {
    const result = await replayConversation({
        sessionId: 'test-session',
        turns: [
            { turn: 1, rawText: 'الـ API مش شغال' },
            { turn: 2, rawText: '' }
        ],
        config: { ...createRealReplayConfig(), clock: fixedClock }
    });

    assert.equal(result.sessionId, 'test-session');
    assert.equal(result.traceEvents.length, 2);
    assert.equal(result.traceEvents[0].decision.action, ACTIONS.ASK_FOR_LOGS);
    assert.equal(result.traceEvents[1].decision.action, ACTIONS.CREATE_TICKET);
    assert.equal(result.traceEvents[1].decision.ticketDraft.scenarioId, 'api_integration_issue');
});

test('replayConversation: carries state (diagnostic + decision) correctly across turns — turn 2 does not re-ask for logs', async () => {
    const result = await replayConversation({
        sessionId: 'test-session',
        turns: [
            { turn: 1, rawText: 'الـ API مش شغال' },
            { turn: 2, rawText: '' }
        ],
        config: { ...createRealReplayConfig(), clock: fixedClock }
    });
    assert.notEqual(result.traceEvents[1].decision.action, ACTIONS.ASK_FOR_LOGS);
});

test('replayConversation: turns are processed in ascending order regardless of input order', async () => {
    const config = { ...createRealReplayConfig(), clock: fixedClock };
    const inOrder = await replayConversation({
        sessionId: 's1',
        turns: [
            { turn: 1, rawText: 'الـ API مش شغال' },
            { turn: 2, rawText: '' }
        ],
        config
    });
    const outOfOrder = await replayConversation({
        sessionId: 's1',
        turns: [
            { turn: 2, rawText: '' },
            { turn: 1, rawText: 'الـ API مش شغال' }
        ],
        config
    });
    assert.deepEqual(
        inOrder.traceEvents.map((t) => t.decision.action),
        outOfOrder.traceEvents.map((t) => t.decision.action)
    );
});

test('replayConversation: an alternate ("after") staticKnowledgeProvider changes the rendered pricing answer with zero engine code changes', async () => {
    const baseConfig = createRealReplayConfig();
    const before = await replayConversation({
        sessionId: 'pricing-session',
        turns: [{ turn: 1, rawText: 'عايز اعرف اسعار خطط باقات بكام عروض ايه' }],
        config: { ...baseConfig, clock: fixedClock }
    });

    const afterKnowledge = createStaticKnowledgeProvider(async () => [{ key: 'pricing', text: { ar: 'السعر الجديد بعد التعديل', en: 'new updated price' } }]);
    const after = await replayConversation({
        sessionId: 'pricing-session',
        turns: [{ turn: 1, rawText: 'عايز اعرف اسعار خطط باقات بكام عروض ايه' }],
        config: { ...baseConfig, staticKnowledgeProvider: afterKnowledge, clock: fixedClock }
    });

    assert.notEqual(before.traceEvents[0].responseText, after.traceEvents[0].responseText);
    assert.ok(after.traceEvents[0].responseText.includes('السعر الجديد بعد التعديل'));
    // Confirming the decision-level facts (action, scenario) are unaffected — only the knowledge content changed.
    assert.equal(before.traceEvents[0].decision.action, after.traceEvents[0].decision.action);
    assert.equal(before.traceEvents[0].decision.scenarioId, after.traceEvents[0].decision.scenarioId);
});

test('replayConversation: an alternate ("after") scenarioProvider (a proposed Scenario edit) changes which scenario resolves', async () => {
    const baseConfig = createRealReplayConfig();
    const before = await replayConversation({
        sessionId: 'edit-session',
        turns: [{ turn: 1, rawText: 'Token expired, Error 401' }],
        config: { ...baseConfig, clock: fixedClock }
    });
    assert.equal(before.traceEvents[0].decision.scenarioId, 'login_token_expired');

    // Simulate a proposed edit: raise the evidence weight so a *different*,
    // otherwise-lower-ranked scenario wins the same evidence instead.
    const afterScenarios = createScenarioCatalogProvider(async () => [
        {
            id: 'higher_priority_edit',
            label: { ar: 'تعديل', en: 'Edit' },
            category: 'login',
            evidenceSignature: [
                { token: 'entity_token', weight: 10 },
                { token: 'http_status_401', weight: 10 }
            ],
            discriminatingQuestions: [],
            resolution: { hasAutoResolution: true, text: { ar: 'نص جديد', en: 'new text' } },
            requiresTicketIfUnresolved: false
        }
    ]);
    const after = await replayConversation({
        sessionId: 'edit-session',
        turns: [{ turn: 1, rawText: 'Token expired, Error 401' }],
        config: { ...baseConfig, scenarioProvider: afterScenarios, clock: fixedClock }
    });
    assert.equal(after.traceEvents[0].decision.scenarioId, 'higher_priority_edit');
});

test('replayConversation: an empty turns list produces an empty (not throwing) result', async () => {
    const result = await replayConversation({ sessionId: 's1', turns: [], config: createRealReplayConfig() });
    assert.deepEqual(result.traceEvents, []);
});

test('replayConversation: output is JSON-safe end to end', async () => {
    const result = await replayConversation({
        sessionId: 's1',
        turns: [{ turn: 1, rawText: 'Token expired, Error 401' }],
        config: { ...createRealReplayConfig(), clock: fixedClock }
    });
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});
