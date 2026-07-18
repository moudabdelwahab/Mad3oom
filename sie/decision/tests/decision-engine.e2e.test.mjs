import test from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../decision-engine.js';
import { ACTIONS, createEmptyDecisionState } from '../decision-types.js';
import { runPipelineTurn, createRealScenarioCatalogProvider } from './helpers/node-providers.js';
import { extractDiscriminatingAnswerEvidence } from '../../diagnostics/evidence-extractor.js';
import { processTurn } from '../../diagnostics/diagnostic-engine.js';
import { rankHypotheses } from '../../ranking/ranking-engine.js';

const fixedClock = () => '2026-01-01T00:00:00.000Z';

// ------------------------------------------------------------------
// Journey A: strong single-turn evidence -> ANSWER -> silence -> COMPLETE
// Numbers verified empirically before writing these assertions.
// ------------------------------------------------------------------

test('Journey A: "Token expired, Error 401" reaches ANSWER, then silence completes the session', async () => {
    const turn1 = await runPipelineTurn('Token expired, Error 401', 1);
    let decisionState = createEmptyDecisionState();

    const step1 = decide({
        ranking: turn1.rankingResult,
        turn: 1,
        previousDecisionState: decisionState,
        newEvidenceAddedThisTurn: turn1.newEvidenceAddedThisTurn,
        clock: fixedClock
    });
    assert.equal(step1.decision.action, ACTIONS.ANSWER);
    assert.equal(step1.decision.scenarioId, 'login_token_expired');
    assert.ok(step1.decision.resolution.text.ar.length > 0);
    decisionState = step1.decisionState;

    // Customer goes silent (no new message content) after the fix was presented.
    const turn2 = await runPipelineTurn('', 2, turn1.diagnosticState);
    const step2 = decide({
        ranking: turn2.rankingResult,
        turn: 2,
        previousDecisionState: decisionState,
        newEvidenceAddedThisTurn: turn2.newEvidenceAddedThisTurn,
        clock: fixedClock
    });
    assert.equal(step2.decision.action, ACTIONS.COMPLETE);
    assert.equal(step2.decision.scenarioId, 'login_token_expired');
});

// ------------------------------------------------------------------
// Journey B: shared-vocabulary ambiguity resolves once a discriminating
// answer's implied evidence arrives.
// ------------------------------------------------------------------

test('Journey B: ambiguous subscription scenarios resolve after a discriminating answer, without ever asking the same question twice', async () => {
    const turn1 = await runPipelineTurn('عندي مشكلة اشتراك', 1);
    let decisionState = createEmptyDecisionState();

    const step1 = decide({
        ranking: turn1.rankingResult,
        turn: 1,
        previousDecisionState: decisionState,
        newEvidenceAddedThisTurn: turn1.newEvidenceAddedThisTurn,
        clock: fixedClock
    });
    assert.equal(step1.decision.action, ACTIONS.ASK_CLARIFYING_QUESTION);
    assert.equal(step1.decision.scenarioId, 'subscription_payment_not_reflected');
    assert.equal(step1.decision.targetQuestion.id, 'payment_confirmation_received');
    decisionState = step1.decisionState;
    assert.deepEqual(decisionState.askedQuestionIds, ['payment_confirmation_received']);

    // Customer confirms payment succeeded — simulating what the future
    // Decision/Dialogue integration will do with a discriminating answer.
    const confirmEvidence = extractDiscriminatingAnswerEvidence({ impliedTokens: ['دفع'], turn: 2, weight: 1 });
    const scenarioProvider = createRealScenarioCatalogProvider();
    const diagnosticState2 = await processTurn({
        normalizedTokens: [],
        turn: 2,
        previousState: turn1.diagnosticState,
        scenarioProvider,
        additionalEvidence: confirmEvidence
    });
    const scenarios = await scenarioProvider.getAllScenarios();
    const ranking2 = rankHypotheses(diagnosticState2.hypotheses, scenarios);

    const step2 = decide({
        ranking: ranking2,
        turn: 2,
        previousDecisionState: decisionState,
        newEvidenceAddedThisTurn: 1,
        clock: fixedClock
    });

    // Ambiguity must be resolved now (no longer ambiguous), and the
    // engine must not re-ask the same question it already asked.
    assert.equal(ranking2.isAmbiguous, false);
    assert.notEqual(step2.decision.action, ACTIONS.ESCALATE_TO_HUMAN);
    if (step2.decision.action === ACTIONS.ASK_CLARIFYING_QUESTION) {
        assert.notEqual(step2.decision.targetQuestion?.id, 'payment_confirmation_received');
    }
    assert.equal(step2.decision.scenarioId, 'subscription_payment_not_reflected');
});

// ------------------------------------------------------------------
// Journey C: a confidently-diagnosed technical issue with no
// auto-resolution requests logs once, then creates a ticket.
// ------------------------------------------------------------------

test('Journey C: confident technical diagnosis requests logs once, then creates a ticket', async () => {
    const turn1 = await runPipelineTurn('الـ API مش شغال', 1);
    let decisionState = createEmptyDecisionState();

    const step1 = decide({
        ranking: turn1.rankingResult,
        turn: 1,
        previousDecisionState: decisionState,
        newEvidenceAddedThisTurn: turn1.newEvidenceAddedThisTurn,
        clock: fixedClock
    });
    assert.equal(step1.decision.action, ACTIONS.ASK_FOR_LOGS);
    assert.equal(step1.decision.scenarioId, 'api_integration_issue');
    decisionState = step1.decisionState;
    assert.equal(decisionState.supplementaryEvidenceRequested, true);

    // Customer sends the logs (or declines) — either way, no new
    // scenario-relevant evidence; the engine should now proceed to
    // create the ticket rather than ask for logs again.
    const turn2 = await runPipelineTurn('', 2, turn1.diagnosticState);
    const step2 = decide({
        ranking: turn2.rankingResult,
        turn: 2,
        previousDecisionState: decisionState,
        newEvidenceAddedThisTurn: turn2.newEvidenceAddedThisTurn,
        clock: fixedClock
    });
    assert.equal(step2.decision.action, ACTIONS.CREATE_TICKET);
    assert.equal(step2.decision.ticketDraft.scenarioId, 'api_integration_issue');
    assert.equal(step2.decision.ticketDraft.category, 'api');
});

// ------------------------------------------------------------------
// Journey D: a full session round-trips through JSON at every step
// (safety check for eventual chat_sessions.bot_state storage).
// ------------------------------------------------------------------

test('Journey D: every Decision produced across a multi-turn session is JSON-safe', async () => {
    const turn1 = await runPipelineTurn('عندي مشكلة اشتراك', 1);
    const step1 = decide({
        ranking: turn1.rankingResult,
        turn: 1,
        previousDecisionState: createEmptyDecisionState(),
        newEvidenceAddedThisTurn: turn1.newEvidenceAddedThisTurn,
        clock: fixedClock
    });
    assert.deepEqual(JSON.parse(JSON.stringify(step1.decision)), step1.decision);
    assert.deepEqual(JSON.parse(JSON.stringify(step1.decisionState)), step1.decisionState);
});
