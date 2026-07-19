/**
 * decision-engine.js
 * ------------------------------------------------------------
 * Consumes Module 4's RankingResult (which already carries full
 * Scenario objects and confidence-scored Hypotheses) and decides
 * exactly ONE next action. Performs no diagnosis, no ranking, no
 * dialogue/text generation — the returned Decision is data only, for
 * the future Dialogue Engine to render.
 *
 * Fully synchronous, zero I/O: everything it needs is already present
 * in the RankingResult and the DecisionState it's given. The only
 * "impure" ingredient is wall-clock time for the Decision's timestamp,
 * which is injected via a `clock` parameter (default: real time) so the
 * module stays deterministic and testable — tests can supply a fixed
 * clock instead of asserting against real time.
 *
 * Every returned Decision carries an `evaluatedRules` trace: an ordered
 * list of every rule this turn considered, up to and including the one
 * that matched, each tagged with whether it matched and why. This is
 * what makes "why was this decided" fully auditable from the Decision
 * object alone, not just a single free-text explanation.
 */
import { ACTIONS, createEmptyDecisionState } from './decision-types.js';
import {
    RESOLUTION_CONFIDENCE_THRESHOLD,
    MAX_CLARIFYING_QUESTIONS,
    MAX_TURNS_BEFORE_ESCALATION,
    MAX_NO_PROGRESS_TURNS,
    EVIDENCE_REQUEST_ACTION_BY_CATEGORY,
    DEFAULT_EVIDENCE_REQUEST_ACTION
} from './decision-policy.js';
import { ACTIVATION_THRESHOLD } from '../diagnostics/hypothesis-tracker.js';

const defaultClock = () => new Date().toISOString();

function buildTicketDraft(ranking) {
    return {
        scenarioId: ranking.topHypothesis?.hypothesis.scenarioId ?? null,
        category: ranking.topHypothesis?.scenario?.category ?? 'other',
        diagnosticTrail: ranking.ranked.slice(0, 5).map((r) => ({
            scenarioId: r.hypothesis.scenarioId,
            confidence: r.hypothesis.confidence,
            status: r.hypothesis.status
        }))
    };
}

function hasMissingLiveEvidence(entry) {
    if (!entry?.scenario) return false;
    const liveTokens = new Set(
        entry.scenario.evidenceSignature.filter((sig) => sig.source === 'live').map((sig) => sig.token)
    );
    if (liveTokens.size === 0) return false;
    return (entry.hypothesis.missingEvidenceTokens || []).some((token) => liveTokens.has(token));
}

function pickEvidenceRequestAction(category) {
    return EVIDENCE_REQUEST_ACTION_BY_CATEGORY[category] || DEFAULT_EVIDENCE_REQUEST_ACTION;
}

function findUnaskedCandidateQuestion(candidateQuestions, askedQuestionIds, scenarioIdFilter = null) {
    return (candidateQuestions || []).find(
        (cq) =>
            !askedQuestionIds.includes(cq.question.id) &&
            (scenarioIdFilter === null || cq.scenarioId === scenarioIdFilter)
    );
}

export function decide({ ranking, turn, previousDecisionState, newEvidenceAddedThisTurn, clock = defaultClock }) {
    const prevState = previousDecisionState || createEmptyDecisionState();
    const noNewEvidence = !newEvidenceAddedThisTurn || newEvidenceAddedThisTurn === 0;
    const consecutiveNoNewEvidenceTurns = noNewEvidence ? prevState.consecutiveNoNewEvidenceTurns + 1 : 0;

    const evaluatedRules = [];
    let decision = decideAction(
        { ranking, turn, prevState, noNewEvidence, consecutiveNoNewEvidenceTurns },
        evaluatedRules,
        clock
    );

    // R1 (turn budget), R5's exhausted-questions branch, and R6's exhausted-
    // ambiguity branch all key off conditions that never revert once true
    // (turn only increases, questionsAskedCount only increases), so left
    // alone they'd re-decide CREATE_TICKET/ESCALATE_TO_HUMAN — and open a
    // fresh duplicate ticket — on every single subsequent turn forever. If
    // this session already has one, keep the same action (still true: a
    // human is on it) but drop ticketDraft so the Action Layer won't create
    // another, and flag it so the Dialogue Engine can phrase it as a
    // reminder rather than repeating the first-time announcement verbatim.
    const isTicketAction = decision.action === ACTIONS.CREATE_TICKET || decision.action === ACTIONS.ESCALATE_TO_HUMAN;
    if (isTicketAction && prevState.ticketAlreadyCreated) {
        decision = { ...decision, ticketDraft: null, alreadyTicketed: true };
    }

    const decisionState = updateDecisionState(prevState, decision, consecutiveNoNewEvidenceTurns);

    return { decision, decisionState };
}

function finalize(action, opts, turn, evaluatedRules, clock) {
    const { scenarioId = null, scenarioLabel = null, confidence = null, explanation, targetQuestion = null, resolution = null, ticketDraft = null } = opts;
    return {
        action,
        scenarioId,
        scenarioLabel,
        confidence,
        explanation,
        evaluatedRules: [...evaluatedRules],
        timestamp: clock(),
        targetQuestion,
        resolution,
        ticketDraft,
        turn
    };
}

function decideAction({ ranking, turn, prevState, noNewEvidence, consecutiveNoNewEvidenceTurns }, evaluatedRules, clock) {
    const { topHypothesis, runnerUp, isAmbiguous, candidateDiscriminatingQuestions } = ranking;

    const rule0Matches = noNewEvidence && !topHypothesis && prevState.lastAction === null;
    evaluatedRules.push({
        rule: 'R0_WAIT_FOR_USER',
        matched: rule0Matches,
        detail: rule0Matches
            ? 'No evidence yet and no prior decision this session.'
            : 'Either evidence exists, a hypothesis exists, or this is not the first turn.'
    });
    if (rule0Matches) {
        return finalize(
            ACTIONS.WAIT_FOR_USER,
            { explanation: 'No interpretable content received yet in a brand-new session; waiting for a substantive message.' },
            turn, evaluatedRules, clock
        );
    }

    const rule1Matches = turn >= MAX_TURNS_BEFORE_ESCALATION;
    evaluatedRules.push({ rule: 'R1_TURN_BUDGET', matched: rule1Matches, detail: `turn=${turn}, cap=${MAX_TURNS_BEFORE_ESCALATION}` });
    if (rule1Matches) {
        return finalize(
            ACTIONS.ESCALATE_TO_HUMAN,
            {
                scenarioId: topHypothesis?.hypothesis.scenarioId ?? null,
                scenarioLabel: topHypothesis?.scenario?.label ?? null,
                confidence: topHypothesis?.hypothesis.confidence ?? null,
                explanation: `Turn ${turn} reached the maximum turn budget (${MAX_TURNS_BEFORE_ESCALATION}) without a confident, resolved diagnosis.`,
                ticketDraft: buildTicketDraft(ranking)
            },
            turn, evaluatedRules, clock
        );
    }

    const rule2Matches = prevState.lastAction === ACTIONS.ANSWER && noNewEvidence;
    evaluatedRules.push({
        rule: 'R2_COMPLETE_AFTER_ANSWER',
        matched: rule2Matches,
        detail: rule2Matches
            ? `Previous action was ANSWER for "${prevState.lastScenarioId}" and no new evidence followed.`
            : 'Previous action was not ANSWER, or new evidence arrived since.'
    });
    if (rule2Matches) {
        const stillTop = topHypothesis?.hypothesis.scenarioId === prevState.lastScenarioId;
        const lastEntry = stillTop ? topHypothesis : ranking.ranked.find((r) => r.hypothesis.scenarioId === prevState.lastScenarioId);
        return finalize(
            ACTIONS.COMPLETE,
            {
                scenarioId: prevState.lastScenarioId,
                scenarioLabel: lastEntry?.scenario?.label ?? null,
                confidence: stillTop ? topHypothesis.hypothesis.confidence : null,
                explanation: `Previous turn presented a resolution for "${prevState.lastScenarioId}" and no new problem evidence followed; considering the issue resolved.`
            },
            turn, evaluatedRules, clock
        );
    }

    const rule3Matches = consecutiveNoNewEvidenceTurns >= MAX_NO_PROGRESS_TURNS;
    evaluatedRules.push({ rule: 'R3_NO_PROGRESS_FALLBACK', matched: rule3Matches, detail: `consecutiveNoNewEvidenceTurns=${consecutiveNoNewEvidenceTurns}, cap=${MAX_NO_PROGRESS_TURNS}` });
    if (rule3Matches) {
        return finalize(
            ACTIONS.FALLBACK,
            {
                scenarioId: topHypothesis?.hypothesis.scenarioId ?? null,
                scenarioLabel: topHypothesis?.scenario?.label ?? null,
                confidence: topHypothesis?.hypothesis.confidence ?? null,
                explanation: `${consecutiveNoNewEvidenceTurns} consecutive turns produced no new diagnostic evidence; unable to make further progress.`
            },
            turn, evaluatedRules, clock
        );
    }

    const rule4Matches = !topHypothesis;
    evaluatedRules.push({ rule: 'R4_NO_HYPOTHESES', matched: rule4Matches, detail: rule4Matches ? 'ranking.topHypothesis is null.' : 'At least one hypothesis exists.' });
    if (rule4Matches) {
        return finalize(ACTIONS.FALLBACK, { explanation: 'No ranked hypotheses are available to reason about.' }, turn, evaluatedRules, clock);
    }

    const rule5Matches = topHypothesis.hypothesis.confidence < ACTIVATION_THRESHOLD;
    evaluatedRules.push({
        rule: 'R5_BELOW_ACTIVATION',
        matched: rule5Matches,
        detail: `topConfidence=${topHypothesis.hypothesis.confidence.toFixed(3)}, activationThreshold=${ACTIVATION_THRESHOLD}`
    });
    if (rule5Matches) {
        if (prevState.questionsAskedCount < MAX_CLARIFYING_QUESTIONS) {
            return finalize(
                ACTIONS.ASK_CLARIFYING_QUESTION,
                { explanation: `Top hypothesis "${topHypothesis.hypothesis.scenarioId}" confidence ${topHypothesis.hypothesis.confidence.toFixed(2)} is below the activation threshold (${ACTIVATION_THRESHOLD}); no scenario is a real candidate yet, requesting more detail.` },
                turn, evaluatedRules, clock
            );
        }
        return finalize(
            ACTIONS.ESCALATE_TO_HUMAN,
            { explanation: `No scenario reached the activation threshold after ${prevState.questionsAskedCount} clarifying questions.`, ticketDraft: buildTicketDraft(ranking) },
            turn, evaluatedRules, clock
        );
    }

    evaluatedRules.push({
        rule: 'R6_AMBIGUOUS',
        matched: isAmbiguous,
        detail: isAmbiguous
            ? `confidenceGap=${ranking.confidenceGap?.toFixed(3)} between "${topHypothesis.hypothesis.scenarioId}" and "${runnerUp?.hypothesis.scenarioId}".`
            : 'Ranking Engine did not flag ambiguity.'
    });
    if (isAmbiguous) {
        const unasked = findUnaskedCandidateQuestion(candidateDiscriminatingQuestions, prevState.askedQuestionIds);
        if (unasked && prevState.questionsAskedCount < MAX_CLARIFYING_QUESTIONS) {
            const entry = ranking.ranked.find((r) => r.hypothesis.scenarioId === unasked.scenarioId);
            return finalize(
                ACTIONS.ASK_CLARIFYING_QUESTION,
                {
                    scenarioId: unasked.scenarioId,
                    scenarioLabel: entry?.scenario?.label ?? null,
                    confidence: entry?.hypothesis.confidence ?? null,
                    explanation: `Top candidates "${topHypothesis.hypothesis.scenarioId}" (${topHypothesis.hypothesis.confidence.toFixed(2)}) and "${runnerUp.hypothesis.scenarioId}" (${runnerUp.hypothesis.confidence.toFixed(2)}) are within the ambiguity margin (gap ${ranking.confidenceGap.toFixed(2)}); asking a discriminating question to separate them.`,
                    targetQuestion: unasked.question
                },
                turn, evaluatedRules, clock
            );
        }
        if (prevState.questionsAskedCount >= MAX_CLARIFYING_QUESTIONS) {
            return finalize(
                ACTIONS.ESCALATE_TO_HUMAN,
                {
                    scenarioId: topHypothesis.hypothesis.scenarioId,
                    scenarioLabel: topHypothesis.scenario?.label ?? null,
                    confidence: topHypothesis.hypothesis.confidence,
                    explanation: `Ambiguity between "${topHypothesis.hypothesis.scenarioId}" and "${runnerUp.hypothesis.scenarioId}" remains unresolved after ${prevState.questionsAskedCount} clarifying questions.`,
                    ticketDraft: buildTicketDraft(ranking)
                },
                turn, evaluatedRules, clock
            );
        }
        if (hasMissingLiveEvidence(topHypothesis) && !prevState.accountDetailsRequested) {
            return finalize(
                ACTIONS.REQUEST_ACCOUNT_DETAILS,
                {
                    scenarioId: topHypothesis.hypothesis.scenarioId,
                    scenarioLabel: topHypothesis.scenario?.label ?? null,
                    confidence: topHypothesis.hypothesis.confidence,
                    explanation: `Ambiguity persists and "${topHypothesis.hypothesis.scenarioId}" depends on account data not yet available; requesting account details to look it up.`
                },
                turn, evaluatedRules, clock
            );
        }
        return finalize(
            ACTIONS.CREATE_TICKET,
            {
                scenarioId: topHypothesis.hypothesis.scenarioId,
                scenarioLabel: topHypothesis.scenario?.label ?? null,
                confidence: topHypothesis.hypothesis.confidence,
                explanation: `Ambiguity between "${topHypothesis.hypothesis.scenarioId}" and "${runnerUp.hypothesis.scenarioId}" cannot be further resolved automatically (no unasked discriminating questions available); escalating with the current diagnostic trail.`,
                ticketDraft: buildTicketDraft(ranking)
            },
            turn, evaluatedRules, clock
        );
    }

    const rule7Matches = topHypothesis.hypothesis.confidence >= RESOLUTION_CONFIDENCE_THRESHOLD;
    evaluatedRules.push({
        rule: 'R7_CONFIDENT_LEADER',
        matched: rule7Matches,
        detail: `topConfidence=${topHypothesis.hypothesis.confidence.toFixed(3)}, resolutionThreshold=${RESOLUTION_CONFIDENCE_THRESHOLD}`
    });
    if (rule7Matches) {
        if (topHypothesis.scenario?.resolution?.hasAutoResolution) {
            return finalize(
                ACTIONS.ANSWER,
                {
                    scenarioId: topHypothesis.hypothesis.scenarioId,
                    scenarioLabel: topHypothesis.scenario?.label ?? null,
                    confidence: topHypothesis.hypothesis.confidence,
                    explanation: `"${topHypothesis.hypothesis.scenarioId}" confidence ${topHypothesis.hypothesis.confidence.toFixed(2)} clears the resolution threshold (${RESOLUTION_CONFIDENCE_THRESHOLD}) and has an automatic resolution available.`,
                    resolution: topHypothesis.scenario.resolution
                },
                turn, evaluatedRules, clock
            );
        }
        if (!prevState.supplementaryEvidenceRequested) {
            const action = pickEvidenceRequestAction(topHypothesis.scenario?.category);
            return finalize(
                ACTIONS[action],
                {
                    scenarioId: topHypothesis.hypothesis.scenarioId,
                    scenarioLabel: topHypothesis.scenario?.label ?? null,
                    confidence: topHypothesis.hypothesis.confidence,
                    explanation: `"${topHypothesis.hypothesis.scenarioId}" confidence ${topHypothesis.hypothesis.confidence.toFixed(2)} clears the resolution threshold but has no automatic resolution; requesting supplementary evidence (category "${topHypothesis.scenario?.category}") before creating a ticket.`
                },
                turn, evaluatedRules, clock
            );
        }
        return finalize(
            ACTIONS.CREATE_TICKET,
            {
                scenarioId: topHypothesis.hypothesis.scenarioId,
                scenarioLabel: topHypothesis.scenario?.label ?? null,
                confidence: topHypothesis.hypothesis.confidence,
                explanation: `"${topHypothesis.hypothesis.scenarioId}" confidence ${topHypothesis.hypothesis.confidence.toFixed(2)} clears the resolution threshold, has no automatic resolution, and supplementary evidence was already requested; creating a ticket.`,
                ticketDraft: buildTicketDraft(ranking)
            },
            turn, evaluatedRules, clock
        );
    }

    evaluatedRules.push({
        rule: 'R8_REFINE',
        matched: true,
        detail: `topConfidence=${topHypothesis.hypothesis.confidence.toFixed(3)} is active but below resolution threshold, and not ambiguous.`
    });
    const ownUnasked = findUnaskedCandidateQuestion(candidateDiscriminatingQuestions, prevState.askedQuestionIds, topHypothesis.hypothesis.scenarioId);
    if (ownUnasked && prevState.questionsAskedCount < MAX_CLARIFYING_QUESTIONS) {
        return finalize(
            ACTIONS.ASK_CLARIFYING_QUESTION,
            {
                scenarioId: topHypothesis.hypothesis.scenarioId,
                scenarioLabel: topHypothesis.scenario?.label ?? null,
                confidence: topHypothesis.hypothesis.confidence,
                explanation: `"${topHypothesis.hypothesis.scenarioId}" confidence ${topHypothesis.hypothesis.confidence.toFixed(2)} is below the resolution threshold (${RESOLUTION_CONFIDENCE_THRESHOLD}); asking a discriminating question to confirm it.`,
                targetQuestion: ownUnasked.question
            },
            turn, evaluatedRules, clock
        );
    }
    if (hasMissingLiveEvidence(topHypothesis) && !prevState.accountDetailsRequested) {
        return finalize(
            ACTIONS.REQUEST_ACCOUNT_DETAILS,
            {
                scenarioId: topHypothesis.hypothesis.scenarioId,
                scenarioLabel: topHypothesis.scenario?.label ?? null,
                confidence: topHypothesis.hypothesis.confidence,
                explanation: `"${topHypothesis.hypothesis.scenarioId}" depends on account data not yet available; requesting account details to verify.`
            },
            turn, evaluatedRules, clock
        );
    }
    if (prevState.questionsAskedCount < MAX_CLARIFYING_QUESTIONS) {
        return finalize(
            ACTIONS.ASK_CLARIFYING_QUESTION,
            {
                scenarioId: topHypothesis.hypothesis.scenarioId,
                scenarioLabel: topHypothesis.scenario?.label ?? null,
                confidence: topHypothesis.hypothesis.confidence,
                explanation: `"${topHypothesis.hypothesis.scenarioId}" confidence ${topHypothesis.hypothesis.confidence.toFixed(2)} is below the resolution threshold with no specific discriminating question available; requesting more detail.`
            },
            turn, evaluatedRules, clock
        );
    }
    if (!prevState.verificationDone) {
        return finalize(
            ACTIONS.VERIFY_INFORMATION,
            {
                scenarioId: topHypothesis.hypothesis.scenarioId,
                scenarioLabel: topHypothesis.scenario?.label ?? null,
                confidence: topHypothesis.hypothesis.confidence,
                explanation: `Question budget (${MAX_CLARIFYING_QUESTIONS}) exhausted without reaching the resolution threshold for "${topHypothesis.hypothesis.scenarioId}"; confirming current understanding before escalating.`
            },
            turn, evaluatedRules, clock
        );
    }
    return finalize(
        ACTIONS.CREATE_TICKET,
        {
            scenarioId: topHypothesis.hypothesis.scenarioId,
            scenarioLabel: topHypothesis.scenario?.label ?? null,
            confidence: topHypothesis.hypothesis.confidence,
            explanation: `Confidence for "${topHypothesis.hypothesis.scenarioId}" plateaued at ${topHypothesis.hypothesis.confidence.toFixed(2)} with no further automated disambiguation available; creating a ticket.`,
            ticketDraft: buildTicketDraft(ranking)
        },
        turn, evaluatedRules, clock
    );
}

function updateDecisionState(prevState, decision, consecutiveNoNewEvidenceTurns) {
    const askedQuestionIds =
        decision.action === ACTIONS.ASK_CLARIFYING_QUESTION && decision.targetQuestion
            ? [...prevState.askedQuestionIds, decision.targetQuestion.id]
            : prevState.askedQuestionIds;

    const questionsAskedCount =
        decision.action === ACTIONS.ASK_CLARIFYING_QUESTION ? prevState.questionsAskedCount + 1 : prevState.questionsAskedCount;

    const isEvidenceRequestAction = [ACTIONS.ASK_FOR_SCREENSHOT, ACTIONS.ASK_FOR_ATTACHMENT, ACTIONS.ASK_FOR_LOGS].includes(decision.action);

    const ticketAlreadyCreated =
        prevState.ticketAlreadyCreated ||
        (decision.action === ACTIONS.CREATE_TICKET || decision.action === ACTIONS.ESCALATE_TO_HUMAN);

    return {
        askedQuestionIds,
        questionsAskedCount,
        supplementaryEvidenceRequested: prevState.supplementaryEvidenceRequested || isEvidenceRequestAction,
        accountDetailsRequested: prevState.accountDetailsRequested || decision.action === ACTIONS.REQUEST_ACCOUNT_DETAILS,
        verificationDone: prevState.verificationDone || decision.action === ACTIONS.VERIFY_INFORMATION,
        consecutiveNoNewEvidenceTurns,
        lastAction: decision.action,
        lastScenarioId: decision.scenarioId,
        ticketAlreadyCreated,
        history: [
            ...prevState.history,
            { turn: decision.turn, action: decision.action, scenarioId: decision.scenarioId, confidence: decision.confidence, explanation: decision.explanation }
        ]
    };
}
