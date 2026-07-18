import test from 'node:test';
import assert from 'node:assert/strict';
import { composeAnswerDecision } from '../answer-composer.js';
import { renderDecision } from '../../dialogue/dialogue-renderer.js';
import { createLiveKnowledgeProvider } from '../live-knowledge.provider.js';
import { liveKnowledgeProviderStub } from '../live-knowledge.stub.js';
import { runPipelineTurnToDecision, createRealStaticKnowledgeProvider } from './helpers/node-providers.js';

const fixedClock = () => '2026-01-01T00:00:00.000Z';
const staticKnowledgeProvider = createRealStaticKnowledgeProvider();

// Numbers below were empirically captured by running the real pipeline
// (Language -> Scenario -> Diagnostic -> Ranking -> Decision) for each
// message before writing these assertions — same discipline established
// in Modules 3-6: verify first, assert what's actually true.

test('full pipeline: a pricing question resolves via static knowledge, not the generic fallback text', async () => {
    const turn1 = await runPipelineTurnToDecision('عايز اعرف اسعار خطط باقات بكام عروض ايه', 1, { clock: fixedClock });
    assert.equal(turn1.decision.action, 'ANSWER');
    assert.equal(turn1.decision.scenarioId, 'pricing_inquiry');
    assert.equal(turn1.decision.resolution.knowledgeSource, 'pricing');

    const composed = await composeAnswerDecision({ decision: turn1.decision, staticKnowledgeProvider });
    assert.ok(composed.knowledgeData, 'expected static "pricing" content to be attached');
    assert.equal(composed.knowledgeData.source, 'pricing');

    const rendered = renderDecision(composed, turn1.responseLanguage);
    // The static content, not the scenario's generic "couldn't find it" fallback:
    assert.ok(rendered.text.includes('باقة الدعم الفني'));
    assert.ok(!rendered.text.includes('مش لاقي المعلومة'));
    // Informational ANSWER: no "did that solve it" options.
    assert.equal(rendered.options.length, 0);
});

test('full pipeline: a platform-info question resolves via static knowledge', async () => {
    const turn1 = await runPipelineTurnToDecision('عايز اعرف عن منصه ازاي بتشتغل', 1, { clock: fixedClock });
    assert.equal(turn1.decision.action, 'ANSWER');
    assert.equal(turn1.decision.resolution.knowledgeSource, 'platform_info');

    const composed = await composeAnswerDecision({ decision: turn1.decision, staticKnowledgeProvider });
    const rendered = renderDecision(composed, turn1.responseLanguage);
    assert.ok(rendered.text.includes('الدعم الفني والتواصل مع العملاء'));
});

test('full pipeline: a ticket-status question resolves via LIVE knowledge when an account is known and tickets exist', async () => {
    const turn1 = await runPipelineTurnToDecision('تذكرتي فين ووصلت لحد فين، عايز اعرف حالتي', 1, { clock: fixedClock });
    assert.equal(turn1.decision.action, 'ANSWER');
    assert.equal(turn1.decision.scenarioId, 'ticket_status_inquiry');
    assert.equal(turn1.decision.resolution.knowledgeSource, 'ticket_status');

    const liveKnowledgeProvider = createLiveKnowledgeProvider(async () => ({
        available: true,
        data: { tickets: [{ ticketNumber: 101, title: 'مشكلة تسجيل الدخول', status: 'in-progress' }] }
    }));

    const composed = await composeAnswerDecision({
        decision: turn1.decision,
        liveKnowledgeContext: { userId: 'customer-1' },
        staticKnowledgeProvider,
        liveKnowledgeProvider
    });

    const rendered = renderDecision(composed, turn1.responseLanguage);
    assert.ok(rendered.text.includes('#101'));
    assert.ok(rendered.text.includes('قيد التنفيذ')); // in-progress, Arabic label
});

test('full pipeline: a ticket-status question falls back to the scenario\'s static fallback text when live knowledge is unavailable (the stub, as currently wired)', async () => {
    const turn1 = await runPipelineTurnToDecision('تذكرتي فين ووصلت لحد فين، عايز اعرف حالتي', 1, { clock: fixedClock });

    const composed = await composeAnswerDecision({
        decision: turn1.decision,
        liveKnowledgeContext: { userId: 'customer-1' },
        staticKnowledgeProvider,
        liveKnowledgeProvider: liveKnowledgeProviderStub
    });
    assert.equal(composed.knowledgeData, undefined);

    const rendered = renderDecision(composed, turn1.responseLanguage);
    assert.ok(rendered.text.includes('مش لاقي بيانات تذاكرك'));
});

test('full pipeline: a subscription-status question resolves via live knowledge with plan/status/expiry formatting', async () => {
    const turn1 = await runPipelineTurnToDecision('عايز اعرف اشتراكي فاضل قد ايه', 1, { clock: fixedClock });
    assert.equal(turn1.decision.action, 'ANSWER');
    assert.equal(turn1.decision.resolution.knowledgeSource, 'subscription_status');

    const liveKnowledgeProvider = createLiveKnowledgeProvider(async () => ({
        available: true,
        data: { plan: 'bundle', status: 'active', billingCycle: 'yearly', daysLeft: 40 }
    }));

    const composed = await composeAnswerDecision({
        decision: turn1.decision,
        liveKnowledgeContext: { userId: 'customer-1' },
        staticKnowledgeProvider,
        liveKnowledgeProvider
    });
    const rendered = renderDecision(composed, turn1.responseLanguage);
    assert.ok(rendered.text.includes('الباقة الشاملة'));
    assert.ok(rendered.text.includes('فعّال'));
    assert.ok(rendered.text.includes('40'));
});

test('full pipeline: a technical scenario (no knowledgeSource) passes through the composer completely untouched', async () => {
    const turn1 = await runPipelineTurnToDecision('Token expired, Error 401', 1, { clock: fixedClock });
    assert.equal(turn1.decision.action, 'ANSWER');
    assert.equal(turn1.decision.resolution.knowledgeSource, undefined);

    const composed = await composeAnswerDecision({ decision: turn1.decision });
    assert.equal(composed, turn1.decision);

    const rendered = renderDecision(composed, turn1.responseLanguage);
    assert.equal(rendered.options.length, 2); // the normal "did that solve it?" ANSWER options
});

test('full pipeline: the composed + rendered output is JSON-safe end to end', async () => {
    const turn1 = await runPipelineTurnToDecision('عايز اعرف اسعار خطط باقات بكام عروض ايه', 1, { clock: fixedClock });
    const composed = await composeAnswerDecision({ decision: turn1.decision, staticKnowledgeProvider });
    const rendered = renderDecision(composed, turn1.responseLanguage);
    assert.deepEqual(JSON.parse(JSON.stringify(composed)), composed);
    assert.deepEqual(JSON.parse(JSON.stringify(rendered)), rendered);
});
