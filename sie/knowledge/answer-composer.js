/**
 * answer-composer.js
 * ------------------------------------------------------------
 * The one function this module adds to the pipeline: it sits between
 * the Decision Engine (Module 5) and the Dialogue Engine (Module 6). If
 * an ANSWER decision's resolution declares a `knowledgeSource`, it
 * looks up real data and attaches it as `knowledgeData`; otherwise it
 * passes the decision through completely unchanged.
 *
 * Neither Module 5 nor Module 6 needs to know this module exists — the
 * composer takes a Decision and returns a Decision, same shape in and
 * out (with one additive field), so decision-engine.js and
 * dialogue-renderer.js keep working exactly as before. This is what
 * keeps the Knowledge Layer a strict addition rather than a redesign of
 * either module.
 *
 * Resolution order for a `knowledgeSource` key:
 *   1. Static knowledge (content-managed but fixed, e.g. "platform_info",
 *      "pricing") — checked first because it's cheap (cached) and not
 *      customer-specific.
 *   2. Live knowledge (per-customer, e.g. "ticket_status",
 *      "subscription_status") — only attempted if a
 *      `liveKnowledgeContext` (i.e. a known userId) was supplied, and
 *      only reached when nothing static matched that key.
 *   3. Neither found -> the decision is returned unchanged. The
 *      Dialogue Engine's ANSWER template already falls back to
 *      `resolution.text` (the scenario's own "couldn't find that right
 *      now" copy) whenever `decision.knowledgeData` is absent, so this
 *      composer never needs to invent fallback text itself.
 *
 * This ordering means a single `knowledgeSource` key never needs to be
 * pre-classified as "static" or "live" anywhere — whichever provider
 * actually has an entry for it wins, and a key can even move from one
 * to the other later (e.g. pricing becoming per-customer) with zero
 * change here.
 */
import { ACTIONS } from '../decision/decision-types.js';
import { staticKnowledgeProvider as defaultStaticKnowledgeProvider } from './static-knowledge.local.js';
import { liveKnowledgeProviderStub as defaultLiveKnowledgeProvider } from './live-knowledge.stub.js';

/**
 * @param {Object} params
 * @param {import('../decision/decision-types.js').Decision} params.decision
 * @param {{userId: string}} [params.liveKnowledgeContext] - if omitted, live knowledge is never
 *   attempted (e.g. an unauthenticated/unidentified session)
 * @param {{getEntryByKey: Function}} [params.staticKnowledgeProvider] - defaults to Module 7's
 *   local provider
 * @param {{getLiveKnowledge: Function}} [params.liveKnowledgeProvider] - defaults to the no-op stub
 * @param {number} [params.turn]
 * @returns {Promise<import('../decision/decision-types.js').Decision & {knowledgeData?: {source: string, data: *}}>}
 */
export async function composeAnswerDecision({
    decision,
    liveKnowledgeContext,
    staticKnowledgeProvider = defaultStaticKnowledgeProvider,
    liveKnowledgeProvider = defaultLiveKnowledgeProvider,
    turn
}) {
    if (!decision || decision.action !== ACTIONS.ANSWER) return decision;

    const knowledgeSource = decision.resolution?.knowledgeSource;
    if (!knowledgeSource) return decision;

    const staticEntry = await staticKnowledgeProvider.getEntryByKey(knowledgeSource);
    if (staticEntry) {
        return { ...decision, knowledgeData: { source: knowledgeSource, data: { text: staticEntry.text } } };
    }

    if (!liveKnowledgeContext) return decision;

    const liveResult = await liveKnowledgeProvider.getLiveKnowledge({
        source: knowledgeSource,
        userId: liveKnowledgeContext.userId,
        turn: turn ?? decision.turn
    });

    if (liveResult?.available) {
        return { ...decision, knowledgeData: { source: knowledgeSource, data: liveResult.data } };
    }

    return decision;
}
