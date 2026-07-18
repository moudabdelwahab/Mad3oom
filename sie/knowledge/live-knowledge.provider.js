/**
 * live-knowledge.provider.js
 * ------------------------------------------------------------
 * Provider INTERFACE for per-customer knowledge that must be looked up
 * live (ticket status, subscription status) rather than served as fixed
 * content — the counterpart to static-knowledge.provider.js. Same
 * pattern and resilience posture as Module 3's live-evidence-
 * provider.js: this file defines the contract only; live-knowledge.
 * stub.js (a no-op implementation always reporting "unavailable") is
 * what the engine actually uses for now. When live-data wiring happens
 * in a later phase (the Action/Adapter integration), a new
 * live-knowledge-provider.supabase.js would implement this same
 * createLiveKnowledgeProvider(fetchFn) contract with real queries
 * against tickets/whatsapp_subscriptions — no change to
 * answer-composer.js or anything downstream.
 *
 * Deliberately does NOT cache, for the same reason live-evidence-
 * provider.js doesn't: a ticket's status or a subscription's expiry can
 * change between turns within the same session.
 */

/**
 * Creates a live-knowledge provider around a given async fetch function.
 * Resilient by design: if fetchFn throws or returns something unusable,
 * the provider degrades to "unavailable" rather than breaking the
 * turn — a live-data hiccup should never stop the engine from falling
 * back to the scenario's static resolution text.
 *
 * @param {(context: import('./knowledge-types.js').LiveKnowledgeContext) => Promise<import('./knowledge-types.js').LiveKnowledgeResult>} fetchFn
 * @returns {{ getLiveKnowledge: (context: import('./knowledge-types.js').LiveKnowledgeContext) => Promise<import('./knowledge-types.js').LiveKnowledgeResult> }}
 */
export function createLiveKnowledgeProvider(fetchFn) {
    async function getLiveKnowledge(context) {
        try {
            const result = await fetchFn(context);
            if (result && typeof result === 'object' && typeof result.available === 'boolean') {
                return result;
            }
            return { available: false, data: null };
        } catch (err) {
            // eslint-disable-next-line no-console
            console.warn('[live-knowledge-provider] fetch failed, treating as unavailable:', err?.message || err);
            return { available: false, data: null };
        }
    }
    return { getLiveKnowledge };
}
