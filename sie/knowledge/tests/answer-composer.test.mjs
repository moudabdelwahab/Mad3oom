import test from 'node:test';
import assert from 'node:assert/strict';
import { composeAnswerDecision } from '../answer-composer.js';
import { ACTIONS } from '../../decision/decision-types.js';
import { createStaticKnowledgeProvider } from '../static-knowledge.provider.js';
import { createLiveKnowledgeProvider } from '../live-knowledge.provider.js';
import { liveKnowledgeProviderStub } from '../live-knowledge.stub.js';
import { createRealStaticKnowledgeProvider } from './helpers/node-providers.js';

function fakeDecision(overrides = {}) {
    return {
        action: ACTIONS.ANSWER,
        scenarioId: 's1',
        scenarioLabel: { ar: 'x', en: 'x' },
        confidence: 0.9,
        explanation: 'test',
        evaluatedRules: [{ rule: 'R7', matched: true, detail: 'x' }],
        timestamp: '2026-01-01T00:00:00.000Z',
        targetQuestion: null,
        resolution: { hasAutoResolution: true, text: { ar: 'نص افتراضي', en: 'fallback text' } },
        ticketDraft: null,
        turn: 2,
        ...overrides
    };
}

function fakeStaticProvider(entries) {
    return createStaticKnowledgeProvider(async () => entries);
}

function fakeLiveProvider(fn) {
    return createLiveKnowledgeProvider(fn);
}

// ------------------------------------------------------------------
// Pass-through cases: nothing to compose
// ------------------------------------------------------------------

test('composeAnswerDecision: non-ANSWER decisions pass through completely unchanged', async () => {
    const decision = fakeDecision({ action: ACTIONS.ASK_CLARIFYING_QUESTION, resolution: null });
    const result = await composeAnswerDecision({ decision });
    assert.equal(result, decision); // same reference: no new object needed
});

test('composeAnswerDecision: an ANSWER with no knowledgeSource passes through unchanged', async () => {
    const decision = fakeDecision({ resolution: { hasAutoResolution: true, text: { ar: 'x', en: 'y' } } });
    const result = await composeAnswerDecision({ decision });
    assert.equal(result, decision);
    assert.equal(result.knowledgeData, undefined);
});

test('composeAnswerDecision: null decision is handled without throwing', async () => {
    const result = await composeAnswerDecision({ decision: null });
    assert.equal(result, null);
});

// ------------------------------------------------------------------
// Static knowledge hit
// ------------------------------------------------------------------

test('composeAnswerDecision: attaches knowledgeData from static content when the key matches', async () => {
    const decision = fakeDecision({ resolution: { hasAutoResolution: true, knowledgeSource: 'pricing', text: { ar: 'احتياطي', en: 'fallback' } } });
    const staticKnowledgeProvider = fakeStaticProvider([{ key: 'pricing', text: { ar: 'الأسعار هنا', en: 'Pricing is here' } }]);

    const result = await composeAnswerDecision({ decision, staticKnowledgeProvider });

    assert.deepEqual(result.knowledgeData, { source: 'pricing', data: { text: { ar: 'الأسعار هنا', en: 'Pricing is here' } } });
});

test('composeAnswerDecision: does not mutate the original decision object', async () => {
    const decision = fakeDecision({ resolution: { hasAutoResolution: true, knowledgeSource: 'pricing', text: { ar: 'x', en: 'y' } } });
    const staticKnowledgeProvider = fakeStaticProvider([{ key: 'pricing', text: { ar: 'a', en: 'b' } }]);

    const result = await composeAnswerDecision({ decision, staticKnowledgeProvider });

    assert.notEqual(result, decision);
    assert.equal(decision.knowledgeData, undefined);
});

test('composeAnswerDecision: static content takes priority over live, even when a live context is supplied', async () => {
    const decision = fakeDecision({ resolution: { hasAutoResolution: true, knowledgeSource: 'pricing', text: { ar: 'x', en: 'y' } } });
    const staticKnowledgeProvider = fakeStaticProvider([{ key: 'pricing', text: { ar: 'ثابت', en: 'static' } }]);
    let liveCalled = false;
    const liveKnowledgeProvider = fakeLiveProvider(async () => {
        liveCalled = true;
        return { available: true, data: { should: 'not be used' } };
    });

    const result = await composeAnswerDecision({
        decision,
        liveKnowledgeContext: { userId: 'u1' },
        staticKnowledgeProvider,
        liveKnowledgeProvider
    });

    assert.equal(liveCalled, false);
    assert.deepEqual(result.knowledgeData.data, { text: { ar: 'ثابت', en: 'static' } });
});

// ------------------------------------------------------------------
// Live knowledge hit (no static entry for the key)
// ------------------------------------------------------------------

test('composeAnswerDecision: falls through to live knowledge when nothing static matches the key', async () => {
    const decision = fakeDecision({ resolution: { hasAutoResolution: true, knowledgeSource: 'ticket_status', text: { ar: 'x', en: 'y' } } });
    const staticKnowledgeProvider = fakeStaticProvider([]); // nothing static
    const liveKnowledgeProvider = fakeLiveProvider(async (context) => {
        assert.equal(context.source, 'ticket_status');
        assert.equal(context.userId, 'u1');
        return { available: true, data: { tickets: [{ ticketNumber: 42, title: 'x', status: 'open' }] } };
    });

    const result = await composeAnswerDecision({
        decision,
        liveKnowledgeContext: { userId: 'u1' },
        staticKnowledgeProvider,
        liveKnowledgeProvider
    });

    assert.deepEqual(result.knowledgeData, {
        source: 'ticket_status',
        data: { tickets: [{ ticketNumber: 42, title: 'x', status: 'open' }] }
    });
});

test('composeAnswerDecision: does not attempt live knowledge when no liveKnowledgeContext is supplied', async () => {
    const decision = fakeDecision({ resolution: { hasAutoResolution: true, knowledgeSource: 'ticket_status', text: { ar: 'x', en: 'y' } } });
    const staticKnowledgeProvider = fakeStaticProvider([]);
    let liveCalled = false;
    const liveKnowledgeProvider = fakeLiveProvider(async () => {
        liveCalled = true;
        return { available: true, data: {} };
    });

    const result = await composeAnswerDecision({ decision, staticKnowledgeProvider, liveKnowledgeProvider });

    assert.equal(liveCalled, false);
    assert.equal(result.knowledgeData, undefined);
    assert.equal(result, decision);
});

test('composeAnswerDecision: live knowledge unavailable -> decision passes through unchanged (Dialogue falls back to resolution.text)', async () => {
    const decision = fakeDecision({ resolution: { hasAutoResolution: true, knowledgeSource: 'subscription_status', text: { ar: 'x', en: 'y' } } });
    const staticKnowledgeProvider = fakeStaticProvider([]);

    const result = await composeAnswerDecision({
        decision,
        liveKnowledgeContext: { userId: 'u1' },
        staticKnowledgeProvider,
        liveKnowledgeProvider: liveKnowledgeProviderStub
    });

    assert.equal(result, decision);
    assert.equal(result.knowledgeData, undefined);
});

test('composeAnswerDecision: neither static nor live source found for an unknown knowledgeSource -> unchanged', async () => {
    const decision = fakeDecision({ resolution: { hasAutoResolution: true, knowledgeSource: 'totally_unknown_source', text: { ar: 'x', en: 'y' } } });
    const staticKnowledgeProvider = fakeStaticProvider([]);

    const result = await composeAnswerDecision({
        decision,
        liveKnowledgeContext: { userId: 'u1' },
        staticKnowledgeProvider,
        liveKnowledgeProvider: liveKnowledgeProviderStub
    });

    assert.equal(result, decision);
});

// ------------------------------------------------------------------
// Defaults + JSON safety
// ------------------------------------------------------------------

test('composeAnswerDecision: resolves against the real shipped static knowledge content', async () => {
    const decision = fakeDecision({ resolution: { hasAutoResolution: true, knowledgeSource: 'platform_info', text: { ar: 'x', en: 'y' } } });
    const result = await composeAnswerDecision({ decision, staticKnowledgeProvider: createRealStaticKnowledgeProvider() });
    assert.ok(result.knowledgeData);
    assert.equal(result.knowledgeData.source, 'platform_info');
    assert.ok(result.knowledgeData.data.text.ar.length > 0);
});

test('composeAnswerDecision: result round-trips through JSON', async () => {
    const decision = fakeDecision({ resolution: { hasAutoResolution: true, knowledgeSource: 'pricing', text: { ar: 'x', en: 'y' } } });
    const result = await composeAnswerDecision({ decision, staticKnowledgeProvider: createRealStaticKnowledgeProvider() });
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});
