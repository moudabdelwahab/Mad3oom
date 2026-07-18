/**
 * evidence-types.js
 * ------------------------------------------------------------
 * Shape/schema for the Diagnostic Engine's core data: Evidence,
 * Hypothesis, and the DiagnosticState that ties them together.
 *
 * Unlike scenario-types.js (which validates human-edited catalog data
 * and must be forgiving of authoring mistakes), these shapes are
 * produced internally by the engine itself, so the guards here are
 * lightweight sanity checks rather than a full authoring-validation
 * layer — their purpose is to catch programming mistakes early (e.g. a
 * future module passing a malformed evidence object), not to police
 * external data entry.
 *
 * @typedef {Object} Evidence
 * @property {string} token - Canonical evidence token (shared vocabulary
 *   with Module 1's glossary/Arabizi output and Module 2's scenario
 *   evidenceSignature tokens)
 * @property {'text'|'live'} source - Where this observation came from
 * @property {'supports'|'contradicts'} polarity - Whether this occurrence
 *   supports or argues against scenarios that reference this token
 * @property {number} weight - Strength of this single observation, in [0,1]
 * @property {number} turn - Turn number this evidence was observed on
 * @property {string} [raw] - Original raw text fragment, if any, for audit trails
 *
 * @typedef {Object} Hypothesis
 * @property {string} scenarioId
 * @property {'unconsidered'|'active'|'rejected'} status
 * @property {number} confidence - In [0,1]
 * @property {string[]} supportingEvidenceTokens
 * @property {string[]} missingEvidenceTokens
 * @property {boolean} hasEverBeenActive
 * @property {number} firstSeenTurn
 * @property {number} lastUpdatedTurn
 * @property {Array<{ turn: number, confidence: number, status: string }>} history
 *
 * @typedef {Object} EvidenceAccumulator
 * @property {Evidence[]} entries - Full append-only history of observed evidence
 * @property {number} turnCount
 *
 * @typedef {Object} DiagnosticState
 * @property {EvidenceAccumulator} accumulator
 * @property {Hypothesis[]} hypotheses
 * @property {number} turnCount
 */

/**
 * Lightweight sanity check for a single Evidence entry. Returns a list
 * of problems (empty = valid) rather than throwing, so a caller can
 * decide whether to drop a bad entry or surface a warning.
 * @param {*} evidence
 * @returns {string[]}
 */
export function checkEvidenceShape(evidence) {
    const problems = [];
    if (!evidence || typeof evidence !== 'object') return ['evidence is not an object'];
    if (typeof evidence.token !== 'string' || evidence.token.trim() === '') {
        problems.push('token must be a non-empty string');
    }
    if (!['text', 'live'].includes(evidence.source)) {
        problems.push('source must be "text" or "live"');
    }
    if (!['supports', 'contradicts'].includes(evidence.polarity)) {
        problems.push('polarity must be "supports" or "contradicts"');
    }
    if (typeof evidence.weight !== 'number' || evidence.weight < 0 || evidence.weight > 1) {
        problems.push('weight must be a number in [0,1]');
    }
    if (typeof evidence.turn !== 'number' || evidence.turn < 0) {
        problems.push('turn must be a non-negative number');
    }
    return problems;
}

/**
 * Creates a fresh, empty EvidenceAccumulator.
 * @returns {EvidenceAccumulator}
 */
export function createEmptyAccumulator() {
    return { entries: [], turnCount: 0 };
}

/**
 * Creates a fresh, empty DiagnosticState.
 * @returns {DiagnosticState}
 */
export function createEmptyDiagnosticState() {
    return { accumulator: createEmptyAccumulator(), hypotheses: [], turnCount: 0 };
}
