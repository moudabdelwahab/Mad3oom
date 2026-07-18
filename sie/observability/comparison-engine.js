/**
 * comparison-engine.js
 * ------------------------------------------------------------
 * Given two ReplayResults (before/after) for the SAME conversation:
 * per-turn action/confidence/response-text deltas. Pure and
 * synchronous, no policy judgment here — "is this delta acceptable" is
 * validation-policy.js's job, kept deliberately separate so the raw
 * diff (useful for the Validation Lab UI regardless of policy) and the
 * pass/fail decision (a policy choice, the Publish Gate's real
 * concern) can evolve independently.
 */

/**
 * @typedef {Object} TurnComparison
 * @property {number} turn
 * @property {{action: string, scenarioId: string|null, confidence: number|null, responseText: string}|null} before
 * @property {{action: string, scenarioId: string|null, confidence: number|null, responseText: string}|null} after
 * @property {boolean} actionChanged
 * @property {number|null} confidenceDelta - after.confidence - before.confidence, or null if either side lacks a numeric confidence
 * @property {boolean} responseTextChanged
 * @property {boolean} scenarioChanged
 *
 * @typedef {Object} ComparisonResult
 * @property {string} sessionId
 * @property {TurnComparison[]} turns
 */

function projectTraceEvent(traceEvent) {
    if (!traceEvent) return null;
    return {
        action: traceEvent.decision?.action ?? null,
        scenarioId: traceEvent.decision?.scenarioId ?? null,
        confidence: typeof traceEvent.decision?.confidence === 'number' ? traceEvent.decision.confidence : null,
        responseText: traceEvent.responseText ?? ''
    };
}

/**
 * @param {import('./replay-engine.js').ReplayResult} beforeResult
 * @param {import('./replay-engine.js').ReplayResult} afterResult
 * @returns {ComparisonResult}
 */
export function compareReplays(beforeResult, afterResult) {
    const beforeByTurn = new Map((beforeResult?.traceEvents || []).map((t) => [t.turn, t]));
    const afterByTurn = new Map((afterResult?.traceEvents || []).map((t) => [t.turn, t]));
    const allTurns = [...new Set([...beforeByTurn.keys(), ...afterByTurn.keys()])].sort((a, b) => a - b);

    const turns = allTurns.map((turn) => {
        const before = projectTraceEvent(beforeByTurn.get(turn));
        const after = projectTraceEvent(afterByTurn.get(turn));

        const confidenceDelta =
            typeof before?.confidence === 'number' && typeof after?.confidence === 'number' ? after.confidence - before.confidence : null;

        return {
            turn,
            before,
            after,
            actionChanged: before?.action !== after?.action,
            scenarioChanged: before?.scenarioId !== after?.scenarioId,
            confidenceDelta,
            responseTextChanged: before?.responseText !== after?.responseText
        };
    });

    return { sessionId: beforeResult?.sessionId ?? afterResult?.sessionId ?? null, turns };
}
