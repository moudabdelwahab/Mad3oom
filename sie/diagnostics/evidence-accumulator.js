/**
 * evidence-accumulator.js
 * ------------------------------------------------------------
 * Maintains the running, append-only record of all evidence observed
 * across a session, and computes each token's aggregated "net presence"
 * — a single [0,1] value combining every observation of that token,
 * supporting and contradicting, seen so far.
 *
 * Combination method: noisy-OR, separately for supporting and
 * contradicting observations, then combined:
 *
 *   supportPresence(token)    = 1 - Π(1 - w_i)   over all "supports" evidence for token
 *   contradictPresence(token) = 1 - Π(1 - w_i)   over all "contradicts" evidence for token
 *   netPresence(token)        = supportPresence * (1 - contradictPresence)
 *
 * This is what makes repeated evidence for the same token have
 * diminishing returns (bounded at 1, never grows unbounded), and what
 * gives contradicting evidence real teeth: enough contradiction can
 * drive a token's net presence back down toward 0 even after strong
 * prior support — which is the mechanism that ultimately lets a
 * Hypothesis be genuinely rejected (see hypothesis-tracker.js), not
 * just labeled.
 */
import { createEmptyAccumulator } from './evidence-types.js';

/**
 * Merges a batch of new Evidence into an existing accumulator, returning
 * a NEW accumulator (does not mutate the input) — kept pure so it's
 * trivial to test and so the caller controls exactly when/whether state
 * is persisted.
 *
 * @param {import('./evidence-types.js').EvidenceAccumulator} accumulator
 * @param {import('./evidence-types.js').Evidence[]} newEvidence
 * @param {number} turn
 * @returns {import('./evidence-types.js').EvidenceAccumulator}
 */
export function mergeEvidence(accumulator, newEvidence, turn) {
    const base = accumulator || createEmptyAccumulator();
    const additions = Array.isArray(newEvidence) ? newEvidence : [];

    return {
        entries: [...base.entries, ...additions],
        turnCount: Math.max(base.turnCount, turn)
    };
}

/**
 * Computes the aggregated net presence (in [0,1]) for a single token
 * across all evidence observed so far.
 *
 * @param {import('./evidence-types.js').EvidenceAccumulator} accumulator
 * @param {string} token
 * @returns {number}
 */
export function getTokenPresence(accumulator, token) {
    const relevant = (accumulator?.entries || []).filter((e) => e.token === token);
    if (relevant.length === 0) return 0;

    const supportPresence = noisyOr(relevant.filter((e) => e.polarity === 'supports').map((e) => e.weight));
    const contradictPresence = noisyOr(relevant.filter((e) => e.polarity === 'contradicts').map((e) => e.weight));

    return supportPresence * (1 - contradictPresence);
}

/**
 * Returns a Map of token -> net presence for every distinct token
 * observed in the accumulator, so callers that need to look at many
 * tokens at once (e.g. the hypothesis tracker scoring a scenario with
 * several evidence tokens) don't need to re-filter the full entry list
 * once per token.
 *
 * @param {import('./evidence-types.js').EvidenceAccumulator} accumulator
 * @returns {Map<string, number>}
 */
export function getAllTokenPresences(accumulator) {
    const entries = accumulator?.entries || [];
    const byToken = new Map();

    for (const entry of entries) {
        if (!byToken.has(entry.token)) byToken.set(entry.token, { supports: [], contradicts: [] });
        byToken.get(entry.token)[entry.polarity === 'contradicts' ? 'contradicts' : 'supports'].push(entry.weight);
    }

    const result = new Map();
    for (const [token, { supports, contradicts }] of byToken) {
        const supportPresence = noisyOr(supports);
        const contradictPresence = noisyOr(contradicts);
        result.set(token, supportPresence * (1 - contradictPresence));
    }
    return result;
}

/**
 * Noisy-OR combination of a list of independent weights in [0,1]:
 * 1 - Π(1 - w_i). Empty list -> 0.
 * @param {number[]} weights
 * @returns {number}
 */
function noisyOr(weights) {
    if (!weights || weights.length === 0) return 0;
    let productOfComplements = 1;
    for (const w of weights) {
        productOfComplements *= 1 - Math.min(Math.max(w, 0), 1);
    }
    return 1 - productOfComplements;
}
