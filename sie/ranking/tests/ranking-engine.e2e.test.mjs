import test from 'node:test';
import assert from 'node:assert/strict';
import { rankDiagnosticState, AMBIGUITY_MARGIN } from '../ranking-engine.js';
import { createScenarioCatalogProvider } from '../../scenarios/scenario-catalog.provider.js';
import { createEmptyDiagnosticState } from '../../diagnostics/evidence-types.js';
import { diagnoseRealTurn, createRealScenarioCatalogProvider } from './helpers/node-providers.js';

function fakeScenario(id, evidenceSignature, discriminatingQuestions = []) {
    return {
        id,
        label: { ar: id, en: id },
        category: 'other',
        evidenceSignature,
        discriminatingQuestions,
        resolution: { hasAutoResolution: false },
        requiresTicketIfUnresolved: true
    };
}

test('rankDiagnosticState: accepts an injected scenarioProvider and ranks accordingly', async () => {
    const provider = createScenarioCatalogProvider(async () => [fakeScenario('s1', [{ token: 'x', weight: 1 }])]);
    const state = {
        hypotheses: [
            {
                scenarioId: 's1',
                status: 'active',
                confidence: 0.5,
                supportingEvidenceTokens: ['x'],
                missingEvidenceTokens: [],
                hasEverBeenActive: true,
                firstSeenTurn: 1,
                lastUpdatedTurn: 1,
                history: []
            }
        ]
    };

    const result = await rankDiagnosticState(state, provider);
    assert.equal(result.topHypothesis.hypothesis.scenarioId, 's1');
});

test('rankDiagnosticState: an empty/undefined state degrades to an empty ranking rather than throwing', async () => {
    const provider = createScenarioCatalogProvider(async () => []);
    const result = await rankDiagnosticState(createEmptyDiagnosticState(), provider);
    assert.deepEqual(result.ranked, []);

    const resultUndefined = await rankDiagnosticState(undefined, provider);
    assert.deepEqual(resultUndefined.ranked, []);
});

// ------------------------------------------------------------------
// End-to-end integration: real Module 1 normalization + real Module 2
// catalog + real Module 3 diagnosis, ranked together. Exact confidence
// figures below were captured by running the real pipeline before
// writing these assertions (not hand-calculated), so they reflect
// actual current behavior rather than an assumed model of it.
// ------------------------------------------------------------------

test('end-to-end: a message with strong, specific evidence produces a clear, unambiguous winner', async () => {
    const state = await diagnoseRealTurn('Token expired', 1);
    const scenarios = await createRealScenarioCatalogProvider().getAllScenarios();
    const result = (await import('../ranking-engine.js')).rankHypotheses(state.hypotheses, scenarios);

    assert.equal(result.topHypothesis.hypothesis.scenarioId, 'login_token_expired');
    assert.ok(result.topHypothesis.hypothesis.confidence > 0.25);
    assert.equal(result.isAmbiguous, false);
    assert.equal(result.confidenceGap, null); // no second scenario even cleared the activation threshold
});

test('end-to-end: a message with evidence shared between two related scenarios produces genuine ambiguity', async () => {
    const state = await diagnoseRealTurn('عندي مشكلة اشتراك', 1);
    const scenarios = await createRealScenarioCatalogProvider().getAllScenarios();
    const { rankHypotheses } = await import('../ranking-engine.js');
    const result = rankHypotheses(state.hypotheses, scenarios);

    const topTwoIds = result.ranked.slice(0, 2).map((r) => r.hypothesis.scenarioId).sort();
    assert.deepEqual(topTwoIds, ['subscription_expired', 'subscription_payment_not_reflected'].sort());
    assert.equal(result.isAmbiguous, true);
    assert.ok(result.confidenceGap < AMBIGUITY_MARGIN);
});

test('end-to-end: ambiguity between subscription scenarios surfaces the payment-confirmation discriminating question', async () => {
    const state = await diagnoseRealTurn('عندي مشكلة اشتراك', 1);
    const scenarios = await createRealScenarioCatalogProvider().getAllScenarios();
    const { rankHypotheses } = await import('../ranking-engine.js');
    const result = rankHypotheses(state.hypotheses, scenarios);

    const questionIds = result.candidateDiscriminatingQuestions.map((q) => q.question.id);
    assert.ok(questionIds.includes('payment_confirmation_received'));
    // subscription_expired has no discriminatingQuestions defined, so it
    // must not contribute anything here.
    assert.ok(!result.candidateDiscriminatingQuestions.some((q) => q.scenarioId === 'subscription_expired'));
});

test('end-to-end: ranking result is stable and re-derivable — ranking the same DiagnosticState twice gives identical output', async () => {
    const state = await diagnoseRealTurn('SSL Certificate', 1);
    const scenarios = await createRealScenarioCatalogProvider().getAllScenarios();
    const { rankHypotheses } = await import('../ranking-engine.js');

    const result1 = rankHypotheses(state.hypotheses, scenarios);
    const result2 = rankHypotheses(state.hypotheses, scenarios);
    assert.deepEqual(
        result1.ranked.map((r) => r.hypothesis.scenarioId),
        result2.ranked.map((r) => r.hypothesis.scenarioId)
    );
});

test('end-to-end: accumulating more turns of evidence can resolve an initially ambiguous ranking', async () => {
    const { rankHypotheses } = await import('../ranking-engine.js');
    const scenarios = await createRealScenarioCatalogProvider().getAllScenarios();

    let state = await diagnoseRealTurn('عندي مشكلة اشتراك', 1);
    const ambiguousResult = rankHypotheses(state.hypotheses, scenarios);
    assert.equal(ambiguousResult.isAmbiguous, true);

    // Customer confirms payment went through — this is exactly the kind
    // of answer extractDiscriminatingAnswerEvidence (Module 3) is meant
    // to turn into evidence; simulated here directly since the Decision/
    // Dialogue Engines that would actually ask the question don't exist
    // yet.
    const { extractDiscriminatingAnswerEvidence } = await import('../../diagnostics/evidence-extractor.js');
    const { processTurn } = await import('../../diagnostics/diagnostic-engine.js');
    const confirmationEvidence = extractDiscriminatingAnswerEvidence({
        impliedTokens: ['دفع'],
        turn: 2,
        weight: 1
    });
    state = await processTurn({
        normalizedTokens: [],
        turn: 2,
        previousState: state,
        scenarioProvider: createRealScenarioCatalogProvider(),
        additionalEvidence: confirmationEvidence
    });

    const resolvedResult = rankHypotheses(state.hypotheses, scenarios);
    assert.equal(resolvedResult.topHypothesis.hypothesis.scenarioId, 'subscription_payment_not_reflected');
    assert.equal(resolvedResult.isAmbiguous, false);
});
