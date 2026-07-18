/**
 * publish-gate.js
 * ------------------------------------------------------------
 * A small, pure state machine: a proposed Scenario/Knowledge edit is
 * draft -> validated -> published (or rejected). "Publish" is blocked
 * unless the regression suite passed (a ValidationVerdict from
 * validation-policy.js), OR a staff member explicitly overrides — with
 * the override always requiring a non-empty reason, which the caller is
 * responsible for logging (via action-layer.js's publishScenarioVersion
 * /publishKnowledgeVersion, whose `overrideReason` param maps straight
 * into chat_engine_publish_overrides).
 *
 * No I/O here — this module only decides whether a publish SHOULD be
 * allowed; actually performing it is action-layer.js's job.
 */

export const DRAFT_STATES = Object.freeze(['draft', 'validated', 'published', 'rejected']);

const ALLOWED_TRANSITIONS = Object.freeze({
    draft: ['validated', 'rejected'],
    validated: ['published', 'rejected', 'draft'], // a failed/edited validation can go back to draft
    published: [], // terminal - a new edit starts a new draft version, it doesn't unpublish this one
    rejected: ['draft'] // can be revised and resubmitted
});

/**
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
export function canTransition(from, to) {
    return Array.isArray(ALLOWED_TRANSITIONS[from]) && ALLOWED_TRANSITIONS[from].includes(to);
}

/**
 * @typedef {Object} PublishDecision
 * @property {boolean} allowed
 * @property {boolean} requiresOverride - true if `allowed` is only true because of an override
 * @property {string} reason
 */

/**
 * Decides whether a "validated" draft may transition to "published"
 * right now.
 *
 * @param {Object} params
 * @param {import('./validation-policy.js').ValidationVerdict|null} params.verdict - null if no
 *   validation run has been recorded yet for this draft version
 * @param {string|null} [params.overrideReason]
 * @returns {PublishDecision}
 */
export function decidePublishability({ verdict, overrideReason }) {
    if (!verdict) {
        return { allowed: false, requiresOverride: true, reason: 'no validation run has been recorded for this draft version yet' };
    }

    if (verdict.passed) {
        return { allowed: true, requiresOverride: false, reason: 'regression suite passed' };
    }

    const hasOverrideReason = typeof overrideReason === 'string' && overrideReason.trim().length > 0;
    if (hasOverrideReason) {
        return {
            allowed: true,
            requiresOverride: true,
            reason: `published despite a failing regression verdict; override reason: "${overrideReason.trim()}"`
        };
    }

    return {
        allowed: false,
        requiresOverride: true,
        reason: `regression suite failed (${verdict.reasons.join('; ') || 'see turnVerdicts'}) and no override reason was provided`
    };
}
