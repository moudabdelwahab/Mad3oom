import test from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../decision-engine.js';
import { ACTIONS, createEmptyDecisionState } from '../decision-types.js';
import {
    RESOLUTION_CONFIDENCE_THRESHOLD,
    MAX_CLARIFYING_QUESTIONS,
    MAX_TURNS_BEFORE_ESCALATION,
    MAX_NO_PROGRESS_TURNS
} from '../decision-policy.js';
import { ACTIVATION_THRESHOLD } from '../../diagnostics/hypothesis-tracker.js';

const FIXED_TIME = '2026-01-01T00:00:00.000Z';
const fixedClock = () => FIXED_TIME;

function fakeScenario(id, overrides = {}) {
    return {
        id,
        label: { ar: id, en: id },
        category: 'other',
        evidenceSignature: [{ token: 'x', weight: 1 }],
        discriminatingQuestions: [],
        resolution: { hasAutoResolution: false },
        requiresTicketIfUnresolved: true,
        ...overrides
    };
}

function fakeHypothesis(scenarioId, confidence, overrides = {}) {
    return {
        scenarioId,
        status: confidence >= ACTIVATION_THRESHOLD ? 'active' : 'unconsidered',
        confidence,
        supportingEvidenceTokens: [],
        missingEvidenceTokens: [],
        hasEverBeenActive: confidence >= ACTIVATION_THRESHOLD,
        firstSeenTurn: 1,
        lastUpdatedTurn: 1,
        history: [],
        ...overrides
    };
}

function fakeRankedEntry(scenarioId, confidence, { scenarioOverrides = {}, hypothesisOverrides = {} } = {}) {
    return {
        hypothesis: fakeHypothesis(scenarioId, confidence, hypothesisOverrides),
        scenario: fakeScenario(scenarioId, scenarioOverrides),
        rank: 0
    };
}

function fakeRanking({ ranked, isAmbiguous = false, confidenceGap = null, candidateDiscriminatingQuestions = [] }) {
    ranked.forEach((entry, i) => (entry.rank = i + 1));
    return {
        ranked,
        topHypothesis: ranked[0] || null,
        runnerUp: ranked[1] || null,
        confidenceGap,
        isAmbiguous,
        candidateDiscriminatingQuestions
    };
}

// ------------------------------------------------------------------
// Decision object shape: confidence, explanation, evaluatedRules, timestamp
// ------------------------------------------------------------------

test('decide: returns a Decision with confidence, explanation, evaluatedRules, and timestamp populated', () => {
    const ranking = fakeRanking({ ranked: [] });
    const { decision } = decide({ ranking, turn: 1, newEvidenceAddedThisTurn: 0, clock: fixedClock });
    assert.equal(decision.action, ACTIONS.WAIT_FOR_USER);
    assert.equal(decision.confidence, null);
    assert.equal(typeof decision.explanation, 'string');
    assert.ok(decision.explanation.length > 0);
    assert.ok(Array.isArray(decision.evaluatedRules));
    assert.ok(decision.evaluatedRules.length > 0);
    assert.equal(decision.timestamp, FIXED_TIME);
});

test('decide: uses real wall-clock time by default when no clock is injected', () => {
    const ranking = fakeRanking({ ranked: [] });
    const before = Date.now();
    const { decision } = decide({ ranking, turn: 1, newEvidenceAddedThisTurn: 0 });
    const after = Date.now();
    const parsed = new Date(decision.timestamp).getTime();
    assert.ok(parsed >= before && parsed <= after);
});

test('decide: evaluatedRules trace records every rule checked up to and including the matching one', () => {
    const ranking = fakeRanking({ ranked: [fakeRankedEntry('s1', 0.9, { scenarioOverrides: { resolution: { hasAutoResolution: true, text: { ar: 'x', en: 'x' } } } })] });
    const previousDecisionState = { ...createEmptyDecisionState(), lastAction: 'x' };
    const { decision } = decide({ ranking, turn: 2, previousDecisionState, newEvidenceAddedThisTurn: 1, clock: fixedClock });
    const ruleNames = decision.evaluatedRules.map((r) => r.rule);
    assert.deepEqual(ruleNames, [
        'R0_WAIT_FOR_USER',
        'R1_TURN_BUDGET',
        'R2_COMPLETE_AFTER_ANSWER',
        'R3_NO_PROGRESS_FALLBACK',
        'R4_NO_HYPOTHESES',
        'R5_BELOW_ACTIVATION',
        'R6_AMBIGUOUS',
        'R7_CONFIDENT_LEADER'
    ]);
    assert.equal(decision.evaluatedRules.at(-1).matched, true);
    assert.equal(decision.action, ACTIONS.ANSWER);
});

// ------------------------------------------------------------------
// Rule 0: WAIT_FOR_USER
// ------------------------------------------------------------------

test('Rule 0: brand-new session with zero content -> WAIT_FOR_USER', () => {
    const ranking = fakeRanking({ ranked: [] });
    const { decision } = decide({ ranking, turn: 1, newEvidenceAddedThisTurn: 0, clock: fixedClock });
    assert.equal(decision.action, ACTIONS.WAIT_FOR_USER);
});

test('Rule 0: does not fire once a session already has a lastAction (falls through instead)', () => {
    const ranking = fakeRanking({ ranked: [] });
    const previousDecisionState = { ...createEmptyDecisionState(), lastAction: ACTIONS.FALLBACK };
    const { decision } = decide({ ranking, turn: 2, previousDecisionState, newEvidenceAddedThisTurn: 0, clock: fixedClock });
    assert.notEqual(decision.action, ACTIONS.WAIT_FOR_USER);
});

// ------------------------------------------------------------------
// Rule 1: hard turn-budget escalation, overrides everything
// ------------------------------------------------------------------

test('Rule 1: turn budget cap forces ESCALATE_TO_HUMAN even with a confident, auto-resolvable leader', () => {
    const ranking = fakeRanking({
        ranked: [fakeRankedEntry('s1', 0.95, { scenarioOverrides: { resolution: { hasAutoResolution: true, text: { ar: 'x', en: 'x' } } } })]
    });
    const { decision } = decide({ ranking, turn: MAX_TURNS_BEFORE_ESCALATION, newEvidenceAddedThisTurn: 1, clock: fixedClock });
    assert.equal(decision.action, ACTIONS.ESCALATE_TO_HUMAN);
    assert.ok(decision.ticketDraft);
});

// ------------------------------------------------------------------
// Rule 2: COMPLETE after silence following an ANSWER
// ------------------------------------------------------------------

test('Rule 2: silence after ANSWER -> COMPLETE', () => {
    const ranking = fakeRanking({ ranked: [fakeRankedEntry('s1', 0.9)] });
    const previousDecisionState = { ...createEmptyDecisionState(), lastAction: ACTIONS.ANSWER, lastScenarioId: 's1' };
    const { decision } = decide({ ranking, turn: 2, previousDecisionState, newEvidenceAddedThisTurn: 0, clock: fixedClock });
    assert.equal(decision.action, ACTIONS.COMPLETE);
    assert.equal(decision.scenarioId, 's1');
});

test('Rule 2: does NOT fire if new evidence arrives after an ANSWER (customer is still engaged)', () => {
    const ranking = fakeRanking({ ranked: [fakeRankedEntry('s1', 0.9)] });
    const previousDecisionState = { ...createEmptyDecisionState(), lastAction: ACTIONS.ANSWER, lastScenarioId: 's1' };
    const { decision } = decide({ ranking, turn: 2, previousDecisionState, newEvidenceAddedThisTurn: 1, clock: fixedClock });
    assert.notEqual(decision.action, ACTIONS.COMPLETE);
});

// ------------------------------------------------------------------
// Rule 3: FALLBACK after repeated no-progress turns
// ------------------------------------------------------------------

test('Rule 3: repeated no-new-evidence turns (not following an ANSWER) -> FALLBACK', () => {
    const ranking = fakeRanking({ ranked: [fakeRankedEntry('s1', 0.05)] });
    let state = { ...createEmptyDecisionState(), lastAction: ACTIONS.ASK_CLARIFYING_QUESTION };
    let result;
    for (let turn = 2; turn <= 1 + MAX_NO_PROGRESS_TURNS; turn++) {
        result = decide({ ranking, turn, previousDecisionState: state, newEvidenceAddedThisTurn: 0, clock: fixedClock });
        state = result.decisionState;
    }
    assert.equal(result.decision.action, ACTIONS.FALLBACK);
});

// ------------------------------------------------------------------
// Rule 4 (defensive): no hypotheses at all
// ------------------------------------------------------------------

test('Rule 4: no ranked hypotheses at all (with some prior state, evidence present) -> FALLBACK', () => {
    const ranking = fakeRanking({ ranked: [] });
    const previousDecisionState = { ...createEmptyDecisionState(), lastAction: ACTIONS.ASK_CLARIFYING_QUESTION };
    const { decision } = decide({ ranking, turn: 2, previousDecisionState, newEvidenceAddedThisTurn: 1, clock: fixedClock });
    assert.equal(decision.action, ACTIONS.FALLBACK);
});

// ------------------------------------------------------------------
// Rule 5: nothing is a real candidate yet
// ------------------------------------------------------------------

test('Rule 5: top hypothesis below activation threshold -> generic ASK_CLARIFYING_QUESTION', () => {
    const ranking = fakeRanking({ ranked: [fakeRankedEntry('unknown', ACTIVATION_THRESHOLD - 0.05)] });
    const previousDecisionState = { ...createEmptyDecisionState(), lastAction: 'x' };
    const { decision } = decide({ ranking, turn: 1, newEvidenceAddedThisTurn: 1, previousDecisionState, clock: fixedClock });
    assert.equal(decision.action, ACTIONS.ASK_CLARIFYING_QUESTION);
    assert.equal(decision.targetQuestion, null);
});

test('Rule 5: below activation threshold with question budget exhausted -> ESCALATE_TO_HUMAN', () => {
    const ranking = fakeRanking({ ranked: [fakeRankedEntry('unknown', 0.01)] });
    const previousDecisionState = { ...createEmptyDecisionState(), lastAction: 'x', questionsAskedCount: MAX_CLARIFYING_QUESTIONS };
    const { decision } = decide({ ranking, turn: 2, previousDecisionState, newEvidenceAddedThisTurn: 1, clock: fixedClock });
    assert.equal(decision.action, ACTIONS.ESCALATE_TO_HUMAN);
});

// ------------------------------------------------------------------
// Rule 6: ambiguity between top two candidates
// ------------------------------------------------------------------

function ambiguousRanking({ questions = [], liveGapOnTop = false } = {}) {
    const topScenarioOverrides = liveGapOnTop ? { evidenceSignature: [{ token: 'live_token', weight: 1, source: 'live' }] } : {};
    const top = fakeRankedEntry('top', 0.5, {
        scenarioOverrides: topScenarioOverrides,
        hypothesisOverrides: liveGapOnTop ? { missingEvidenceTokens: ['live_token'] } : {}
    });
    const runner = fakeRankedEntry('runner', 0.45);
    return fakeRanking({ ranked: [top, runner], isAmbiguous: true, confidenceGap: 0.05, candidateDiscriminatingQuestions: questions });
}

test('Rule 6: ambiguous with an unasked candidate question -> targeted ASK_CLARIFYING_QUESTION', () => {
    const question = { id: 'q1', prompt: { ar: 'x', en: 'x' }, resolvesEvidence: ['y'] };
    const ranking = ambiguousRanking({ questions: [{ scenarioId: 'runner', question }] });
    const previousDecisionState = { ...createEmptyDecisionState(), lastAction: 'x' };
    const { decision, decisionState } = decide({ ranking, turn: 2, previousDecisionState, newEvidenceAddedThisTurn: 1, clock: fixedClock });
    assert.equal(decision.action, ACTIONS.ASK_CLARIFYING_QUESTION);
    assert.equal(decision.scenarioId, 'runner');
    assert.equal(decision.targetQuestion.id, 'q1');
    assert.deepEqual(decisionState.askedQuestionIds, ['q1']);
});

test('Rule 6: ambiguous, no candidate questions, no live gap -> CREATE_TICKET', () => {
    const ranking = ambiguousRanking({ questions: [] });
    const previousDecisionState = { ...createEmptyDecisionState(), lastAction: 'x' };
    const { decision } = decide({ ranking, turn: 2, previousDecisionState, newEvidenceAddedThisTurn: 1, clock: fixedClock });
    assert.equal(decision.action, ACTIONS.CREATE_TICKET);
    assert.ok(decision.ticketDraft);
});

test('Rule 6: ambiguous, no candidate questions, top scenario has a live evidence gap -> REQUEST_ACCOUNT_DETAILS', () => {
    const ranking = ambiguousRanking({ questions: [], liveGapOnTop: true });
    const previousDecisionState = { ...createEmptyDecisionState(), lastAction: 'x' };
    const { decision } = decide({ ranking, turn: 2, previousDecisionState, newEvidenceAddedThisTurn: 1, clock: fixedClock });
    assert.equal(decision.action, ACTIONS.REQUEST_ACCOUNT_DETAILS);
});

test('Rule 6: ambiguous with live gap but account details already requested -> falls through to CREATE_TICKET', () => {
    const ranking = ambiguousRanking({ questions: [], liveGapOnTop: true });
    const previousDecisionState = { ...createEmptyDecisionState(), lastAction: 'x', accountDetailsRequested: true };
    const { decision } = decide({ ranking, turn: 2, previousDecisionState, newEvidenceAddedThisTurn: 1, clock: fixedClock });
    assert.equal(decision.action, ACTIONS.CREATE_TICKET);
});

test('Rule 6: ambiguous with question budget exhausted -> ESCALATE_TO_HUMAN even if an unasked question exists', () => {
    const question = { id: 'q1', prompt: { ar: 'x', en: 'x' }, resolvesEvidence: ['y'] };
    const ranking = ambiguousRanking({ questions: [{ scenarioId: 'runner', question }] });
    const previousDecisionState = { ...createEmptyDecisionState(), lastAction: 'x', questionsAskedCount: MAX_CLARIFYING_QUESTIONS };
    const { decision } = decide({ ranking, turn: 2, previousDecisionState, newEvidenceAddedThisTurn: 1, clock: fixedClock });
    assert.equal(decision.action, ACTIONS.ESCALATE_TO_HUMAN);
});

test('Rule 6: an already-asked candidate question is skipped in favor of the next unasked one', () => {
    const q1 = { id: 'q1', prompt: { ar: 'x', en: 'x' }, resolvesEvidence: ['y'] };
    const q2 = { id: 'q2', prompt: { ar: 'x', en: 'x' }, resolvesEvidence: ['z'] };
    const ranking = ambiguousRanking({
        questions: [
            { scenarioId: 'top', question: q1 },
            { scenarioId: 'runner', question: q2 }
        ]
    });
    const previousDecisionState = { ...createEmptyDecisionState(), lastAction: 'x', askedQuestionIds: ['q1'] };
    const { decision } = decide({ ranking, turn: 2, previousDecisionState, newEvidenceAddedThisTurn: 1, clock: fixedClock });
    assert.equal(decision.targetQuestion.id, 'q2');
});

// ------------------------------------------------------------------
// Rule 7: confident, unambiguous leader
// ------------------------------------------------------------------

test('Rule 7: confident leader with auto-resolution -> ANSWER carrying the resolution', () => {
    const resolution = { hasAutoResolution: true, text: { ar: 'حل', en: 'fix' } };
    const ranking = fakeRanking({ ranked: [fakeRankedEntry('s1', RESOLUTION_CONFIDENCE_THRESHOLD + 0.1, { scenarioOverrides: { resolution } })] });
    const previousDecisionState = { ...createEmptyDecisionState(), lastAction: 'x' };
    const { decision } = decide({ ranking, turn: 2, previousDecisionState, newEvidenceAddedThisTurn: 1, clock: fixedClock });
    assert.equal(decision.action, ACTIONS.ANSWER);
    assert.equal(decision.resolution, resolution);
});

test('scenarioLabel: is forwarded from the scenario data for an ANSWER decision', () => {
    const resolution = { hasAutoResolution: true, text: { ar: 'حل', en: 'fix' } };
    const ranking = fakeRanking({
        ranked: [fakeRankedEntry('s1', RESOLUTION_CONFIDENCE_THRESHOLD + 0.1, { scenarioOverrides: { resolution, label: { ar: 'مشكلة تسجيل الدخول', en: 'Login issue' } } })]
    });
    const previousDecisionState = { ...createEmptyDecisionState(), lastAction: 'x' };
    const { decision } = decide({ ranking, turn: 2, previousDecisionState, newEvidenceAddedThisTurn: 1, clock: fixedClock });
    assert.deepEqual(decision.scenarioLabel, { ar: 'مشكلة تسجيل الدخول', en: 'Login issue' });
});

test('scenarioLabel: is forwarded for VERIFY_INFORMATION, where the Dialogue Engine needs it most', () => {
    const ranking = fakeRanking({
        ranked: [fakeRankedEntry('s1', RESOLUTION_CONFIDENCE_THRESHOLD - 0.1, { scenarioOverrides: { label: { ar: 'مشكلة الاشتراك', en: 'Subscription issue' } } })]
    });
    const previousDecisionState = {
        ...createEmptyDecisionState(),
        lastAction: 'x',
        questionsAskedCount: MAX_CLARIFYING_QUESTIONS
    };
    const { decision } = decide({ ranking, turn: 2, previousDecisionState, newEvidenceAddedThisTurn: 1, clock: fixedClock });
    assert.equal(decision.action, ACTIONS.VERIFY_INFORMATION);
    assert.deepEqual(decision.scenarioLabel, { ar: 'مشكلة الاشتراك', en: 'Subscription issue' });
});

test('scenarioLabel: is null when no scenario is concerned (e.g. WAIT_FOR_USER)', () => {
    const ranking = fakeRanking({ ranked: [] });
    const { decision } = decide({ ranking, turn: 1, newEvidenceAddedThisTurn: 0, clock: fixedClock });
    assert.equal(decision.scenarioLabel, null);
});

test('Rule 7: confident leader without auto-resolution, category "api" -> ASK_FOR_LOGS first', () => {
    const ranking = fakeRanking({ ranked: [fakeRankedEntry('s1', 0.9, { scenarioOverrides: { category: 'api' } })] });
    const previousDecisionState = { ...createEmptyDecisionState(), lastAction: 'x' };
    const { decision } = decide({ ranking, turn: 2, previousDecisionState, newEvidenceAddedThisTurn: 1, clock: fixedClock });
    assert.equal(decision.action, ACTIONS.ASK_FOR_LOGS);
});

test('Rule 7: confident leader without auto-resolution, category "subscription" -> ASK_FOR_ATTACHMENT first', () => {
    const ranking = fakeRanking({ ranked: [fakeRankedEntry('s1', 0.9, { scenarioOverrides: { category: 'subscription' } })] });
    const previousDecisionState = { ...createEmptyDecisionState(), lastAction: 'x' };
    const { decision } = decide({ ranking, turn: 2, previousDecisionState, newEvidenceAddedThisTurn: 1, clock: fixedClock });
    assert.equal(decision.action, ACTIONS.ASK_FOR_ATTACHMENT);
});

test('Rule 7: confident leader without auto-resolution, unmapped category -> default ASK_FOR_ATTACHMENT', () => {
    const ranking = fakeRanking({ ranked: [fakeRankedEntry('s1', 0.9, { scenarioOverrides: { category: 'totally_unmapped_category' } })] });
    const previousDecisionState = { ...createEmptyDecisionState(), lastAction: 'x' };
    const { decision } = decide({ ranking, turn: 2, previousDecisionState, newEvidenceAddedThisTurn: 1, clock: fixedClock });
    assert.equal(decision.action, ACTIONS.ASK_FOR_ATTACHMENT);
});

test('Rule 7: after supplementary evidence already requested -> CREATE_TICKET', () => {
    const ranking = fakeRanking({ ranked: [fakeRankedEntry('s1', 0.9, { scenarioOverrides: { category: 'api' } })] });
    const previousDecisionState = { ...createEmptyDecisionState(), lastAction: 'x', supplementaryEvidenceRequested: true };
    const { decision } = decide({ ranking, turn: 2, previousDecisionState, newEvidenceAddedThisTurn: 1, clock: fixedClock });
    assert.equal(decision.action, ACTIONS.CREATE_TICKET);
    assert.equal(decision.ticketDraft.scenarioId, 's1');
});

// ------------------------------------------------------------------
// Rule 8: plausible but not yet confident, unambiguous
// ------------------------------------------------------------------

test('Rule 8: below resolution threshold with an unasked question for the top scenario -> targeted ASK_CLARIFYING_QUESTION', () => {
    const question = { id: 'q1', prompt: { ar: 'x', en: 'x' }, resolvesEvidence: ['y'] };
    const ranking = fakeRanking({
        ranked: [fakeRankedEntry('s1', RESOLUTION_CONFIDENCE_THRESHOLD - 0.1)],
        candidateDiscriminatingQuestions: [{ scenarioId: 's1', question }]
    });
    const previousDecisionState = { ...createEmptyDecisionState(), lastAction: 'x' };
    const { decision } = decide({ ranking, turn: 2, previousDecisionState, newEvidenceAddedThisTurn: 1, clock: fixedClock });
    assert.equal(decision.action, ACTIONS.ASK_CLARIFYING_QUESTION);
    assert.equal(decision.targetQuestion.id, 'q1');
});

test('Rule 8: below resolution threshold, live evidence gap, no account details requested yet -> REQUEST_ACCOUNT_DETAILS', () => {
    const ranking = fakeRanking({
        ranked: [
            fakeRankedEntry('s1', RESOLUTION_CONFIDENCE_THRESHOLD - 0.1, {
                scenarioOverrides: { evidenceSignature: [{ token: 'live_x', weight: 1, source: 'live' }] },
                hypothesisOverrides: { missingEvidenceTokens: ['live_x'] }
            })
        ]
    });
    const previousDecisionState = { ...createEmptyDecisionState(), lastAction: 'x' };
    const { decision } = decide({ ranking, turn: 2, previousDecisionState, newEvidenceAddedThisTurn: 1, clock: fixedClock });
    assert.equal(decision.action, ACTIONS.REQUEST_ACCOUNT_DETAILS);
});

test('Rule 8: below resolution threshold, no specific question, under question budget -> generic ASK_CLARIFYING_QUESTION', () => {
    const ranking = fakeRanking({ ranked: [fakeRankedEntry('s1', RESOLUTION_CONFIDENCE_THRESHOLD - 0.1)] });
    const previousDecisionState = { ...createEmptyDecisionState(), lastAction: 'x' };
    const { decision } = decide({ ranking, turn: 2, previousDecisionState, newEvidenceAddedThisTurn: 1, clock: fixedClock });
    assert.equal(decision.action, ACTIONS.ASK_CLARIFYING_QUESTION);
    assert.equal(decision.targetQuestion, null);
});

test('Rule 8: question budget exhausted, verification not yet done -> VERIFY_INFORMATION', () => {
    const ranking = fakeRanking({ ranked: [fakeRankedEntry('s1', RESOLUTION_CONFIDENCE_THRESHOLD - 0.1)] });
    const previousDecisionState = { ...createEmptyDecisionState(), lastAction: 'x', questionsAskedCount: MAX_CLARIFYING_QUESTIONS };
    const { decision } = decide({ ranking, turn: 2, previousDecisionState, newEvidenceAddedThisTurn: 1, clock: fixedClock });
    assert.equal(decision.action, ACTIONS.VERIFY_INFORMATION);
});

test('Rule 8: question budget exhausted and verification already done -> CREATE_TICKET', () => {
    const ranking = fakeRanking({ ranked: [fakeRankedEntry('s1', RESOLUTION_CONFIDENCE_THRESHOLD - 0.1)] });
    const previousDecisionState = {
        ...createEmptyDecisionState(),
        lastAction: 'x',
        questionsAskedCount: MAX_CLARIFYING_QUESTIONS,
        verificationDone: true
    };
    const { decision } = decide({ ranking, turn: 2, previousDecisionState, newEvidenceAddedThisTurn: 1, clock: fixedClock });
    assert.equal(decision.action, ACTIONS.CREATE_TICKET);
});

// ------------------------------------------------------------------
// DecisionState bookkeeping
// ------------------------------------------------------------------

test('decisionState: questionsAskedCount increments only for ASK_CLARIFYING_QUESTION, not other actions', () => {
    const ranking = fakeRanking({ ranked: [fakeRankedEntry('s1', RESOLUTION_CONFIDENCE_THRESHOLD + 0.1, { scenarioOverrides: { category: 'api' } })] });
    const previousDecisionState = { ...createEmptyDecisionState(), lastAction: 'x' };
    const { decisionState } = decide({ ranking, turn: 2, previousDecisionState, newEvidenceAddedThisTurn: 1, clock: fixedClock });
    assert.equal(decisionState.questionsAskedCount, 0); // this was an ASK_FOR_LOGS, not a clarifying question
});

test('decisionState: history accumulates one entry per decide() call, using "explanation" as the key', () => {
    const ranking = fakeRanking({ ranked: [fakeRankedEntry('s1', 0.01)] });
    let state = { ...createEmptyDecisionState(), lastAction: 'x' };
    for (let turn = 2; turn <= 4; turn++) {
        const result = decide({ ranking, turn, previousDecisionState: state, newEvidenceAddedThisTurn: 1, clock: fixedClock });
        state = result.decisionState;
    }
    assert.equal(state.history.length, 3);
    assert.ok(typeof state.history[0].explanation === 'string' && state.history[0].explanation.length > 0);
});

test('decisionState: is not mutated in place (previousDecisionState stays untouched)', () => {
    const ranking = fakeRanking({ ranked: [fakeRankedEntry('s1', 0.01)] });
    const previousDecisionState = { ...createEmptyDecisionState(), lastAction: 'x' };
    const frozenCopy = JSON.parse(JSON.stringify(previousDecisionState));
    decide({ ranking, turn: 2, previousDecisionState, newEvidenceAddedThisTurn: 1, clock: fixedClock });
    assert.deepEqual(previousDecisionState, frozenCopy);
});

test('Decision object round-trips through JSON (safe for chat_sessions.bot_state storage later)', () => {
    const ranking = fakeRanking({ ranked: [fakeRankedEntry('s1', 0.9, { scenarioOverrides: { category: 'api' } })] });
    const previousDecisionState = { ...createEmptyDecisionState(), lastAction: 'x' };
    const { decision } = decide({ ranking, turn: 2, previousDecisionState, newEvidenceAddedThisTurn: 1, clock: fixedClock });
    assert.deepEqual(JSON.parse(JSON.stringify(decision)), decision);
});
