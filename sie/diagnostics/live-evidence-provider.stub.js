/**
 * live-evidence-provider.stub.js
 * ------------------------------------------------------------
 * The concrete live-evidence provider actually wired up right now.
 * Returns no evidence, always — deliberately, since this module must
 * stay fully isolated from Supabase/live account data until an explicit
 * future integration task. Scenarios in Module 2's catalog that declare
 * "live" source evidence (e.g. "account_recently_locked",
 * "subscription_recently_expired") simply never receive support from
 * this evidence type yet; their text-evidence-derived confidence still
 * works normally.
 *
 * Swapping this for a real implementation later is a one-file change:
 * write live-evidence-provider.supabase.js implementing the same
 * createLiveEvidenceProvider(fetchFn) contract with real queries, and
 * point diagnostic-engine.js's default at it instead.
 */
import { createLiveEvidenceProvider } from './live-evidence-provider.js';

export const liveEvidenceProviderStub = createLiveEvidenceProvider(async () => []);
