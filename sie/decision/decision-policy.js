/**
 * decision-policy.js
 * ------------------------------------------------------------
 * All tunable thresholds for the Decision Engine, kept separate from
 * decision-engine.js's control flow so policy can be adjusted without
 * touching the logic that applies it — same separation-of-concerns
 * reasoning as hypothesis-tracker's ACTIVATION_THRESHOLD/
 * REJECTION_THRESHOLD and ranking-engine's AMBIGUITY_MARGIN.
 */

/** Confidence a leading hypothesis needs to be treated as "confirmed enough" to answer/ticket. */
export const RESOLUTION_CONFIDENCE_THRESHOLD = 0.6;

/** Hard cap on clarifying questions per session before forcing escalation. */
export const MAX_CLARIFYING_QUESTIONS = 3;

/** Hard cap on turns in a session before forcing escalation, regardless of confidence. */
export const MAX_TURNS_BEFORE_ESCALATION = 6;

/** Consecutive turns with zero new evidence (and no prior ANSWER) before giving up with FALLBACK. */
export const MAX_NO_PROGRESS_TURNS = 2;

/**
 * Which "please give us more to work with" action fits a scenario's
 * category best, used once per session before creating a ticket for a
 * confidently-diagnosed-but-not-auto-resolvable scenario. Deliberately
 * driven by category (a small, stable set) rather than per-scenario, so
 * new scenarios automatically get sensible behavior without needing to
 * declare this themselves.
 */
export const EVIDENCE_REQUEST_ACTION_BY_CATEGORY = Object.freeze({
    api: 'ASK_FOR_LOGS',
    subscription: 'ASK_FOR_ATTACHMENT',
    whatsapp: 'ASK_FOR_SCREENSHOT',
    login: 'ASK_FOR_SCREENSHOT',
    other: 'ASK_FOR_SCREENSHOT'
});

/** Fallback evidence-request action for any category not listed above. */
export const DEFAULT_EVIDENCE_REQUEST_ACTION = 'ASK_FOR_ATTACHMENT';
