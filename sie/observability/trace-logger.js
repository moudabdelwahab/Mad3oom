/**
 * trace-logger.js
 * ------------------------------------------------------------
 * Module 9a (Reasoning Trace Logging) + 9b (Learning Queue), together,
 * because the Learning Queue is not separate storage — it's a
 * filter/query over the exact same trace log 9a produces. Both are
 * pure, synchronous functions: building a TraceEvent from this turn's
 * pipeline artifacts, and filtering a list of TraceEvents down to the
 * ones that need staff attention. Persisting a TraceEvent (via
 * action-layer.js's logTraceEvent) and persisting a Learning Queue
 * entry (via flagConversationForReview) are separate, explicit writes
 * — this module decides WHAT should happen, never performs I/O itself.
 */
import { ACTIONS } from '../decision/decision-types.js';

/** Confidence below this is considered "the engine wasn't sure" for Learning Queue purposes. */
export const LOW_CONFIDENCE_THRESHOLD = 0.2;

/**
 * Builds a TraceEvent from one turn's real pipeline artifacts. Pure and
 * synchronous — every input is already-computed data from Modules 1-6,
 * so this is just a compact, replay/audit-friendly projection of it.
 *
 * @param {Object} params
 * @param {string} params.sessionId
 * @param {number} params.turn
 * @param {string} params.rawText
 * @param {Array<{canonical: string}>} params.normalizedTokens - Module 1's normalize().normalizedTokens
 * @param {import('../diagnostics/evidence-types.js').DiagnosticState} params.diagnosticState
 * @param {import('../ranking/ranking-engine.js').RankingResult} params.ranking
 * @param {import('../decision/decision-types.js').Decision} params.decision
 * @param {string} params.responseText - Module 6's rendered text
 * @param {string} [params.timestamp]
 * @returns {import('./trace-types.js').TraceEvent}
 */
export function buildTraceEvent({ sessionId, turn, rawText, normalizedTokens, diagnosticState, ranking, decision, responseText, timestamp }) {
    const hypothesesSnapshot = (diagnosticState?.hypotheses || [])
        .filter((h) => h.status !== 'unconsidered')
        .map((h) => ({ scenarioId: h.scenarioId, confidence: h.confidence, status: h.status }));

    return {
        sessionId,
        turn,
        rawText: rawText ?? '',
        normalizedTokenCanonicals: (normalizedTokens || []).map((t) => t.canonical).filter(Boolean),
        hypothesesSnapshot,
        rankingSnapshot: {
            topScenarioId: ranking?.topHypothesis?.hypothesis?.scenarioId ?? null,
            topConfidence: ranking?.topHypothesis?.hypothesis?.confidence ?? null,
            isAmbiguous: Boolean(ranking?.isAmbiguous)
        },
        decision,
        responseText: responseText ?? '',
        timestamp: timestamp ?? new Date().toISOString()
    };
}

/**
 * Decides whether a given Decision should surface in the Learning
 * Queue, and why. This is the single source of truth for the
 * criteria — the SQL view backing the real chat_engine_learning_queue
 * (see observability/migrations/) implements the exact same three
 * conditions, so this function is also what any test proving that view
 * correct should check against.
 *
 * @param {import('../decision/decision-types.js').Decision|null} decision
 * @returns {'low_confidence'|'fallback'|'escalated_unknown'|null}
 */
export function learningQueueReason(decision) {
    if (!decision) return null;
    if (decision.action === ACTIONS.FALLBACK) return 'fallback';
    if (decision.action === ACTIONS.ESCALATE_TO_HUMAN && (decision.scenarioId === 'unknown' || decision.scenarioId == null)) {
        return 'escalated_unknown';
    }
    if (typeof decision.confidence === 'number' && decision.confidence < LOW_CONFIDENCE_THRESHOLD) return 'low_confidence';
    return null;
}

/**
 * Filters a list of TraceEvents down to the Learning Queue: entries
 * whose decision was low-confidence, a FALLBACK, or an
 * ESCALATE_TO_HUMAN for an unresolved/unknown scenario.
 *
 * @param {import('./trace-types.js').TraceEvent[]} traceEvents
 * @returns {Array<{traceEvent: import('./trace-types.js').TraceEvent, reason: string}>}
 */
export function filterLearningQueue(traceEvents) {
    const list = Array.isArray(traceEvents) ? traceEvents : [];
    return list
        .map((traceEvent) => ({ traceEvent, reason: learningQueueReason(traceEvent.decision) }))
        .filter((entry) => entry.reason !== null);
}
