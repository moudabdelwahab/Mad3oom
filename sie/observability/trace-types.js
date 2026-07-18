/**
 * trace-types.js
 * ------------------------------------------------------------
 * Shape for one turn's full reasoning trace — the record that makes an
 * escalated ticket or a Learning Queue entry auditable after the fact:
 * not just the final Decision, but what evidence/ranking state led to
 * it. Same "produced internally, lightweight sanity guard" posture as
 * Module 3's evidence-types.js / Module 5's decision-types.js.
 *
 * @typedef {Object} HypothesisSnapshot
 * @property {string} scenarioId
 * @property {number} confidence
 * @property {string} status - 'unconsidered'|'active'|'rejected'
 *
 * @typedef {Object} RankingSnapshot
 * @property {string|null} topScenarioId
 * @property {number|null} topConfidence
 * @property {boolean} isAmbiguous
 *
 * @typedef {Object} TraceEvent
 * @property {string} sessionId
 * @property {number} turn
 * @property {string} rawText - the customer's raw message this turn (empty string for a silent turn)
 * @property {string[]} normalizedTokenCanonicals - the canonical tokens Module 1 produced, for
 *   replay/debugging without needing the full NormalizedToken objects
 * @property {HypothesisSnapshot[]} hypothesesSnapshot - Module 3's active/rejected hypotheses
 *   after this turn (a compact projection, not the full DiagnosticState)
 * @property {RankingSnapshot} rankingSnapshot - Module 4's summary for this turn
 * @property {import('../decision/decision-types.js').Decision} decision - Module 5's full decision
 * @property {string} responseText - Module 6's rendered text this turn
 * @property {string} timestamp
 */

/**
 * Lightweight sanity check for a TraceEvent. Catches programming
 * mistakes in this internally-produced data, not authoring errors.
 * @param {*} trace
 * @returns {string[]} problems (empty = valid)
 */
export function checkTraceEventShape(trace) {
    const problems = [];
    if (!trace || typeof trace !== 'object') return ['trace is not an object'];
    if (typeof trace.sessionId !== 'string' || trace.sessionId.trim() === '') problems.push('sessionId must be a non-empty string');
    if (typeof trace.turn !== 'number') problems.push('turn must be a number');
    if (typeof trace.rawText !== 'string') problems.push('rawText must be a string');
    if (!Array.isArray(trace.normalizedTokenCanonicals)) problems.push('normalizedTokenCanonicals must be an array');
    if (!Array.isArray(trace.hypothesesSnapshot)) problems.push('hypothesesSnapshot must be an array');
    if (!trace.rankingSnapshot || typeof trace.rankingSnapshot !== 'object') problems.push('rankingSnapshot must be an object');
    if (!trace.decision || typeof trace.decision !== 'object') problems.push('decision must be an object');
    if (typeof trace.responseText !== 'string') problems.push('responseText must be a string');
    if (typeof trace.timestamp !== 'string' || trace.timestamp.trim() === '') problems.push('timestamp must be a non-empty string');
    return problems;
}
