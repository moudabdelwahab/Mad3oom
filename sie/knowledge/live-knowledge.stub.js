/**
 * live-knowledge.stub.js
 * ------------------------------------------------------------
 * The concrete live-knowledge provider actually wired up right now.
 * Reports every source as unavailable, always — deliberately, since
 * this module must stay fully isolated from Supabase/live account data
 * until an explicit future integration task. Scenarios in Module 2's
 * catalog that declare a "live" knowledgeSource (e.g. "ticket_status",
 * "subscription_status") simply fall back to their static
 * resolution.text until a real implementation is wired in.
 *
 * Swapping this for a real implementation later is a one-file change:
 * write live-knowledge-provider.supabase.js implementing the same
 * createLiveKnowledgeProvider(fetchFn) contract with real queries, and
 * point answer-composer.js's default at it instead.
 */
import { createLiveKnowledgeProvider } from './live-knowledge.provider.js';

export const liveKnowledgeProviderStub = createLiveKnowledgeProvider(async () => ({ available: false, data: null }));
