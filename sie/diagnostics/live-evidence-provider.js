/**
 * live-evidence-provider.js
 * ------------------------------------------------------------
 * Provider INTERFACE for evidence that comes from the customer's
 * account data rather than their message text — e.g. an expired
 * subscription, a recently-locked account, recent site errors. This is
 * what lets the Diagnostic Engine notice things the customer didn't
 * type (per the approved architecture's "live-data evidence" concept).
 *
 * Per this module's isolation requirement, NO real Supabase queries are
 * wired up yet. This file defines the contract only; live-evidence-
 * provider.stub.js (a no-op implementation returning no evidence) is
 * what the engine actually uses for now. When live-data wiring happens
 * in a later phase (the Action/Adapter integration), a new
 * live-evidence-provider.supabase.js would implement this same
 * createLiveEvidenceProvider(fetchFn) contract with real queries against
 * tickets/whatsapp_subscriptions/activity_logs/site_errors — no change
 * to diagnostic-engine.js or anything downstream.
 *
 * Unlike the Scenario/Glossary providers, this one deliberately does
 * NOT cache — live account data can change between turns within the
 * same session (e.g. a lock clearing), so every call re-fetches.
 */

/**
 * @typedef {Object} LiveEvidenceContext
 * @property {string} userId
 * @property {number} turn
 */

/**
 * Creates a live-evidence provider around a given async fetch function.
 * Resilient by design: if fetchFn throws or returns something unusable,
 * the provider degrades to "no live evidence" rather than breaking the
 * diagnostic turn — a live-data hiccup should never stop the engine from
 * still reasoning over the customer's text evidence.
 *
 * @param {(context: LiveEvidenceContext) => Promise<import('./evidence-types.js').Evidence[]>} fetchFn
 * @returns {{ getLiveEvidence: (context: LiveEvidenceContext) => Promise<import('./evidence-types.js').Evidence[]> }}
 */
export function createLiveEvidenceProvider(fetchFn) {
    async function getLiveEvidence(context) {
        try {
            const result = await fetchFn(context);
            return Array.isArray(result) ? result : [];
        } catch (err) {
            // eslint-disable-next-line no-console
            console.warn('[live-evidence-provider] fetch failed, continuing with no live evidence:', err?.message || err);
            return [];
        }
    }
    return { getLiveEvidence };
}
