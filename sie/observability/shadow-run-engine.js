/**
 * shadow-run-engine.js
 * ------------------------------------------------------------
 * The Regression Suite Runner: runs Replay + Comparison + Validation
 * Policy across a SET of stored conversations (sourced from the
 * Learning Queue, or a curated "known good" set) so a proposed
 * Scenario/Knowledge edit can be validated against many real cases at
 * once, not just the one that prompted it. Pure orchestration over
 * replay-engine.js/comparison-engine.js/validation-policy.js — no new
 * logic of its own, and no I/O beyond what replayConversation() already
 * does (which is itself just calling the same pure Modules 1-7 already
 * used everywhere else).
 *
 * Conversations are passed in already-fetched (StoredConversation[]),
 * not fetched by this module itself — whatever calls runShadowRun() is
 * responsible for reading them via observability-read-port.js first.
 * This keeps this module trivially testable with plain fixtures and
 * keeps the one Supabase read path in one place.
 */
import { replayConversation } from './replay-engine.js';
import { compareReplays } from './comparison-engine.js';
import { evaluateComparison, DEFAULT_POLICY } from './validation-policy.js';

/**
 * @typedef {Object} ShadowRunConversationResult
 * @property {string} sessionId
 * @property {import('./comparison-engine.js').ComparisonResult} comparison
 * @property {import('./validation-policy.js').ValidationVerdict} verdict
 *
 * @typedef {Object} ShadowRunResult
 * @property {number} totalConversations
 * @property {number} passedCount
 * @property {number} failedCount
 * @property {boolean} allPassed
 * @property {ShadowRunConversationResult[]} results
 */

/**
 * @param {Object} params
 * @param {import('./observability-read-port.js').StoredConversation[]} params.conversations
 * @param {import('./replay-engine.js').ReplayConfig} [params.before] - defaults to the currently-published catalogs
 * @param {import('./replay-engine.js').ReplayConfig} [params.after] - the proposed edit's providers
 * @param {import('./validation-policy.js').ValidationPolicy} [params.policy]
 * @returns {Promise<ShadowRunResult>}
 */
export async function runShadowRun({ conversations, before = {}, after = {}, policy = DEFAULT_POLICY }) {
    const list = Array.isArray(conversations) ? conversations : [];
    const results = [];

    for (const conversation of list) {
        const beforeReplay = await replayConversation({ sessionId: conversation.sessionId, turns: conversation.turns, config: before });
        const afterReplay = await replayConversation({ sessionId: conversation.sessionId, turns: conversation.turns, config: after });
        const comparison = compareReplays(beforeReplay, afterReplay);
        const verdict = evaluateComparison(comparison, policy);
        results.push({ sessionId: conversation.sessionId, comparison, verdict });
    }

    const passedCount = results.filter((r) => r.verdict.passed).length;
    return {
        totalConversations: results.length,
        passedCount,
        failedCount: results.length - passedCount,
        allPassed: results.length > 0 && passedCount === results.length,
        results
    };
}
