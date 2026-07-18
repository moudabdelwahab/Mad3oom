/**
 * ranking-engine.js
 * ------------------------------------------------------------
 * Turns the Diagnostic Engine's per-scenario hypotheses (already
 * confidence-scored — this module never re-scores anything) into a
 * cross-scenario ranking: an ordering, a measure of how close the top
 * contenders are, and which discriminating questions could help tell
 * them apart.
 *
 * This module makes no decisions (ask/resolve/escalate) and generates
 * no customer-facing text — that remains the Decision Engine's and
 * Dialogue Engine's job (later modules). It only answers: "given what
 * the Diagnostic Engine currently believes, how does that rank, and is
 * it currently ambiguous?"
 */
import { ACTIVATION_THRESHOLD } from '../diagnostics/hypothesis-tracker.js';
import { scenarioCatalogProvider } from '../scenarios/scenario-catalog.local.js';

/** How close two candidates' confidence must be to be considered "too close to call". */
export const AMBIGUITY_MARGIN = 0.1;

/** How many top contenders to surface candidate discriminating questions for. */
export const MAX_CANDIDATE_QUESTIONS_SCENARIOS = 3;

/**
 * @typedef {Object} RankedEntry
 * @property {import('../diagnostics/evidence-types.js').Hypothesis} hypothesis
 * @property {import('../scenarios/scenario-types.js').Scenario|null} scenario
 * @property {number} rank - 1-based position in the ordering
 *
 * @typedef {Object} CandidateDiscriminatingQuestion
 * @property {string} scenarioId
 * @property {import('../scenarios/scenario-types.js').DiscriminatingQuestion} question
 *
 * @typedef {Object} RankingResult
 * @property {RankedEntry[]} ranked - all hypotheses, sorted descending by confidence
 * @property {RankedEntry|null} topHypothesis
 * @property {RankedEntry|null} runnerUp
 * @property {number|null} confidenceGap - gap between the top two CANDIDATES (confidence >= activation
 *   threshold); null if fewer than 2 candidates exist (nothing to compare)
 * @property {boolean} isAmbiguous - true when >=2 candidates are within AMBIGUITY_MARGIN of each other
 * @property {CandidateDiscriminatingQuestion[]} candidateDiscriminatingQuestions
 */

/**
 * Pure ranking function — no I/O, fully deterministic.
 *
 * @param {import('../diagnostics/evidence-types.js').Hypothesis[]} hypotheses
 * @param {import('../scenarios/scenario-types.js').Scenario[]} scenarios
 * @returns {RankingResult}
 */
export function rankHypotheses(hypotheses, scenarios) {
    const list = Array.isArray(hypotheses) ? hypotheses : [];
    const scenarioById = new Map((scenarios || []).map((s) => [s.id, s]));

    const sorted = [...list].sort(
        (a, b) => b.confidence - a.confidence || a.scenarioId.localeCompare(b.scenarioId)
    );

    const ranked = sorted.map((hypothesis, index) => ({
        hypothesis,
        scenario: scenarioById.get(hypothesis.scenarioId) || null,
        rank: index + 1
    }));

    const topHypothesis = ranked[0] || null;
    const runnerUp = ranked[1] || null;

    // Only hypotheses that actually cleared the activation threshold count
    // as real candidates for ambiguity/comparison purposes — a leader at
    // 0.02 confidence with a "runner-up" at 0.01 isn't a meaningful
    // two-horse race, it's just noise.
    const candidates = ranked.filter((entry) => entry.hypothesis.confidence >= ACTIVATION_THRESHOLD);

    const confidenceGap =
        candidates.length >= 2 ? candidates[0].hypothesis.confidence - candidates[1].hypothesis.confidence : null;

    const isAmbiguous = confidenceGap !== null && confidenceGap < AMBIGUITY_MARGIN;

    const candidateDiscriminatingQuestions = buildCandidateDiscriminatingQuestions(
        candidates.slice(0, MAX_CANDIDATE_QUESTIONS_SCENARIOS)
    );

    return { ranked, topHypothesis, runnerUp, confidenceGap, isAmbiguous, candidateDiscriminatingQuestions };
}

/**
 * For each of the given top-contender entries, finds which of its OWN
 * scenario-defined discriminating questions target evidence it's
 * currently missing. Surfaces options only — does not choose one.
 *
 * @param {RankedEntry[]} topEntries
 * @returns {CandidateDiscriminatingQuestion[]}
 */
function buildCandidateDiscriminatingQuestions(topEntries) {
    const result = [];
    for (const entry of topEntries) {
        if (!entry.scenario) continue;
        const missing = new Set(entry.hypothesis.missingEvidenceTokens || []);
        for (const question of entry.scenario.discriminatingQuestions || []) {
            const resolvesSomethingMissing = (question.resolvesEvidence || []).some((token) => missing.has(token));
            if (resolvesSomethingMissing) {
                result.push({ scenarioId: entry.scenario.id, question });
            }
        }
    }
    return result;
}

/**
 * Convenience async wrapper: fetches the scenario catalog via the given
 * provider (defaults to Module 2's real local-JSON provider) and ranks
 * the given DiagnosticState's hypotheses against it.
 *
 * @param {import('../diagnostics/evidence-types.js').DiagnosticState} state
 * @param {{getAllScenarios: Function}} [scenarioProvider]
 * @returns {Promise<RankingResult>}
 */
export async function rankDiagnosticState(state, scenarioProvider = scenarioCatalogProvider) {
    const scenarios = await scenarioProvider.getAllScenarios();
    return rankHypotheses(state?.hypotheses || [], scenarios);
}
