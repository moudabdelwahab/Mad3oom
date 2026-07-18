/**
 * hypothesis-tracker.js
 * ------------------------------------------------------------
 * Computes and maintains one Hypothesis per scenario in the catalog,
 * turn over turn. This is where "confidence scoring" and "keep rejected
 * hypotheses" actually live.
 *
 * Confidence formula (per scenario):
 *   confidence = Σ( presence(token) * scenarioWeight(token) ) / Σ( scenarioWeight(token) )
 *   over the scenario's own evidenceSignature entries.
 *
 * This is a weighted average bounded to [0,1], using each token's
 * aggregated net presence from evidence-accumulator.js. It is
 * deliberately the exact quantity the future Ranking Engine will
 * consume and compare across scenarios — this module computes it once,
 * per scenario, without any cross-scenario comparison of its own (that
 * comparison/ranking is explicitly out of scope here).
 *
 * Status has three values, with hysteresis to prevent flapping on noisy
 * evidence right at a threshold boundary:
 *   - "unconsidered": confidence has never reached the activation threshold
 *   - "active":       confidence is currently at/above the activation threshold,
 *                      OR was active before and hasn't dropped below the
 *                      (lower) rejection threshold yet
 *   - "rejected":      was active at some point, and confidence has since
 *                      dropped below the rejection threshold
 *
 * A hypothesis's record is NEVER removed once created — only its status
 * and confidence change, and every change is appended to its `history`.
 * This is what makes an escalated ticket's diagnostic trail meaningful:
 * it can show not just the final belief, but how it got there,
 * including hypotheses that were considered and ruled out.
 */

export const ACTIVATION_THRESHOLD = 0.15;
export const REJECTION_THRESHOLD = 0.05;

/**
 * Computes a single scenario's confidence given a token->presence map.
 * @param {import('../scenarios/scenario-types.js').Scenario} scenario
 * @param {Map<string, number>} tokenPresences
 * @returns {{ confidence: number, supportingEvidenceTokens: string[], missingEvidenceTokens: string[] }}
 */
export function computeScenarioConfidence(scenario, tokenPresences) {
    let weightedSum = 0;
    let totalWeight = 0;
    const supportingEvidenceTokens = [];
    const missingEvidenceTokens = [];

    for (const { token, weight } of scenario.evidenceSignature) {
        const presence = tokenPresences.get(token) || 0;
        weightedSum += presence * weight;
        totalWeight += weight;

        if (presence > 0) supportingEvidenceTokens.push(token);
        else missingEvidenceTokens.push(token);
    }

    const confidence = totalWeight > 0 ? weightedSum / totalWeight : 0;
    return { confidence, supportingEvidenceTokens, missingEvidenceTokens };
}

function deriveStatus(confidence, wasEverActive) {
    if (confidence >= ACTIVATION_THRESHOLD) return 'active';
    if (wasEverActive && confidence < REJECTION_THRESHOLD) return 'rejected';
    if (wasEverActive) return 'active'; // hysteresis band: stay active until it actually drops below rejection
    return 'unconsidered';
}

/**
 * Recomputes hypotheses for every scenario in the catalog against the
 * current evidence accumulator, merging with the previous turn's
 * hypothesis records so history/status-continuity is preserved.
 *
 * @param {import('../scenarios/scenario-types.js').Scenario[]} scenarios
 * @param {Map<string, number>} tokenPresences - from evidence-accumulator.getAllTokenPresences()
 * @param {import('./evidence-types.js').Hypothesis[]} previousHypotheses
 * @param {number} turn
 * @returns {import('./evidence-types.js').Hypothesis[]}
 */
export function updateHypotheses(scenarios, tokenPresences, previousHypotheses, turn) {
    const previousById = new Map((previousHypotheses || []).map((h) => [h.scenarioId, h]));

    return scenarios.map((scenario) => {
        const previous = previousById.get(scenario.id);
        const { confidence, supportingEvidenceTokens, missingEvidenceTokens } = computeScenarioConfidence(
            scenario,
            tokenPresences
        );

        const wasEverActive = previous?.hasEverBeenActive || confidence >= ACTIVATION_THRESHOLD;
        const status = deriveStatus(confidence, wasEverActive);

        const history = previous?.history ? [...previous.history] : [];
        const statusOrConfidenceChanged =
            !previous || previous.status !== status || previous.confidence !== confidence;
        if (statusOrConfidenceChanged) {
            history.push({ turn, confidence, status });
        }

        return {
            scenarioId: scenario.id,
            status,
            confidence,
            supportingEvidenceTokens,
            missingEvidenceTokens,
            hasEverBeenActive: wasEverActive,
            firstSeenTurn: previous?.firstSeenTurn ?? turn,
            lastUpdatedTurn: turn,
            history
        };
    });
}
