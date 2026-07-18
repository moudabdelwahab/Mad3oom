/**
 * diagnostic-engine.js
 * ------------------------------------------------------------
 * Orchestrates one turn of diagnostic reasoning:
 *   1. Extract text evidence from Module 1's normalized token stream
 *   2. Fetch live-account evidence (currently the no-op stub, per this
 *      module's isolation requirement)
 *   3. Merge everything into the running evidence accumulator
 *   4. Recompute every scenario's hypothesis (confidence + status)
 *   5. Return the updated DiagnosticState
 *
 * This module does NOT rank hypotheses against each other, does NOT
 * decide what to say or do next, and does NOT touch Supabase or any
 * live chat code — it is a pure, storage-agnostic reasoning step. The
 * caller is responsible for persisting the returned DiagnosticState
 * (e.g. into chat_sessions.bot_state) and for supplying the previous
 * turn's state back in on the next call — this module holds no memory
 * of its own between calls, which is what keeps it fully testable in
 * isolation.
 */
import { createEmptyDiagnosticState } from './evidence-types.js';
import { extractTextEvidence } from './evidence-extractor.js';
import { mergeEvidence, getAllTokenPresences } from './evidence-accumulator.js';
import { updateHypotheses } from './hypothesis-tracker.js';
import { liveEvidenceProviderStub } from './live-evidence-provider.stub.js';
import { scenarioCatalogProvider } from '../scenarios/scenario-catalog.local.js';

/**
 * @param {Object} params
 * @param {Array<{canonical: string, source: string, raw: string}>} params.normalizedTokens
 *   Output of Module 1's normalize().normalizedTokens for this turn
 * @param {number} params.turn - current turn number (caller-managed, starts at 1)
 * @param {import('./evidence-types.js').DiagnosticState} [params.previousState] - defaults to an empty state
 * @param {{userId: string}} [params.liveEvidenceContext] - if omitted, no live evidence is fetched this turn
 * @param {import('./evidence-types.js').Evidence[]} [params.additionalEvidence] - e.g. from a
 *   discriminating-question answer (see evidence-extractor.extractDiscriminatingAnswerEvidence)
 * @param {{getAllScenarios: Function}} [params.scenarioProvider] - defaults to Module 2's local provider
 * @param {{getLiveEvidence: Function}} [params.liveEvidenceProvider] - defaults to the no-op stub
 * @returns {Promise<import('./evidence-types.js').DiagnosticState>}
 */
export async function processTurn({
    normalizedTokens,
    turn,
    previousState,
    liveEvidenceContext,
    additionalEvidence = [],
    scenarioProvider = scenarioCatalogProvider,
    liveEvidenceProvider = liveEvidenceProviderStub
}) {
    const state = previousState || createEmptyDiagnosticState();

    const scenarios = await scenarioProvider.getAllScenarios();

    const textEvidence = extractTextEvidence(normalizedTokens, turn);
    const liveEvidence = liveEvidenceContext
        ? await liveEvidenceProvider.getLiveEvidence({ ...liveEvidenceContext, turn })
        : [];

    const allNewEvidence = [...textEvidence, ...liveEvidence, ...additionalEvidence];

    const newAccumulator = mergeEvidence(state.accumulator, allNewEvidence, turn);
    const tokenPresences = getAllTokenPresences(newAccumulator);
    const newHypotheses = updateHypotheses(scenarios, tokenPresences, state.hypotheses, turn);

    return {
        accumulator: newAccumulator,
        hypotheses: newHypotheses,
        turnCount: turn
    };
}

/**
 * Convenience accessor: hypotheses currently considered plausible.
 * A neutral filter over the existing `status` field — not a ranking or
 * comparison across scenarios, which remains the Ranking Engine's job.
 * @param {import('./evidence-types.js').DiagnosticState} state
 * @returns {import('./evidence-types.js').Hypothesis[]}
 */
export function getActiveHypotheses(state) {
    return (state?.hypotheses || []).filter((h) => h.status === 'active');
}

/**
 * Convenience accessor: hypotheses that were once plausible and have
 * since been ruled out — kept in state, never deleted.
 * @param {import('./evidence-types.js').DiagnosticState} state
 * @returns {import('./evidence-types.js').Hypothesis[]}
 */
export function getRejectedHypotheses(state) {
    return (state?.hypotheses || []).filter((h) => h.status === 'rejected');
}
