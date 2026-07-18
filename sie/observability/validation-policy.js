/**
 * validation-policy.js
 * ------------------------------------------------------------
 * Turns a ComparisonResult (comparison-engine.js's raw before/after
 * diff) into a pass/fail ValidationVerdict. Pure and synchronous — this
 * is where "what counts as a regression" is a POLICY decision, kept
 * separate from the diff itself so it can be tuned (or overridden per
 * call) without touching comparison-engine.js.
 *
 * Default policy, per the approved architecture: fail if any
 * previously-passing conversation now regresses below its prior
 * confidence, or its action degrades from ANSWER/COMPLETE toward
 * FALLBACK/ESCALATE_TO_HUMAN.
 */
import { ACTIONS } from '../decision/decision-types.js';

/**
 * @typedef {Object} ValidationPolicy
 * @property {number} confidenceRegressionTolerance - a confidence decrease smaller than this
 *   (floating-point noise) is not treated as a regression
 * @property {Set<string>} degradingActions - actions that represent the engine giving up on an
 *   automated resolution; transitioning INTO one of these from anything else is a regression
 *
 * @typedef {Object} TurnVerdict
 * @property {number} turn
 * @property {boolean} passed
 * @property {string[]} reasons
 *
 * @typedef {Object} ValidationVerdict
 * @property {boolean} passed
 * @property {string[]} reasons - every reason, prefixed with which turn it came from
 * @property {TurnVerdict[]} turnVerdicts
 */

export const DEFAULT_POLICY = Object.freeze({
    confidenceRegressionTolerance: 0.0001,
    degradingActions: new Set([ACTIONS.FALLBACK, ACTIONS.ESCALATE_TO_HUMAN])
});

/**
 * @param {import('./comparison-engine.js').TurnComparison} turnComparison
 * @param {ValidationPolicy} [policy]
 * @returns {TurnVerdict}
 */
export function evaluateTurn({ turn, before, after }, policy = DEFAULT_POLICY) {
    const reasons = [];

    if (!before || !after) {
        return { turn, passed: false, reasons: ['turn present in only one replay (before/after turn sequences differ)'] };
    }

    // Any transition INTO a degrading action from something that wasn't
    // already degrading is a regression — not just the flagship
    // ANSWER/COMPLETE -> FALLBACK/ESCALATE_TO_HUMAN case. Losing a
    // previously-confident CREATE_TICKET or ASK_FOR_LOGS down to FALLBACK
    // is just as real a regression as losing an ANSWER.
    if (!policy.degradingActions.has(before.action) && policy.degradingActions.has(after.action)) {
        reasons.push(`action degraded from ${before.action} to ${after.action}`);
    }

    if (typeof before.confidence === 'number' && typeof after.confidence === 'number') {
        const delta = after.confidence - before.confidence;
        if (delta < -policy.confidenceRegressionTolerance) {
            reasons.push(`confidence regressed from ${before.confidence.toFixed(3)} to ${after.confidence.toFixed(3)}`);
        }
    }

    return { turn, passed: reasons.length === 0, reasons };
}

/**
 * @param {import('./comparison-engine.js').ComparisonResult} comparisonResult
 * @param {ValidationPolicy} [policy]
 * @returns {ValidationVerdict}
 */
export function evaluateComparison(comparisonResult, policy = DEFAULT_POLICY) {
    const turnVerdicts = (comparisonResult?.turns || []).map((t) => evaluateTurn(t, policy));
    const failedTurns = turnVerdicts.filter((v) => !v.passed);

    return {
        passed: failedTurns.length === 0,
        reasons: failedTurns.flatMap((v) => v.reasons.map((r) => `turn ${v.turn}: ${r}`)),
        turnVerdicts
    };
}
