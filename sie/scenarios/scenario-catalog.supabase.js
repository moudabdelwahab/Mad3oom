/**
 * scenario-catalog.supabase.js
 * ------------------------------------------------------------
 * Supabase-backed implementation of the scenario catalog provider.
 *
 * This is the storage-backend swap promised since Module 2: it reuses
 * createScenarioCatalogProvider() from scenario-catalog.provider.js
 * completely unchanged — the same factory, the same validation, the
 * same caching, the same getAllScenarios/getScenarioById/
 * getEvidenceVocabulary/getLoadWarnings interface every other module
 * already depends on. Only the loadFn (where the raw rows come from)
 * is new. Diagnostic, Ranking, Decision, Dialogue, and Knowledge remain
 * completely unaware this file exists — they only ever call the
 * provider interface, never touch Supabase.
 *
 * Reads only the latest PUBLISHED version of each scenario_key from
 * chat_engine_scenarios (see migration
 * add_chat_engine_observability_and_review_center). Draft and archived
 * rows are never surfaced to the running engine — only the Review
 * Center / Validation Lab reads those, for editing and simulation.
 *
 * scenario-catalog.local.js is untouched and remains the default;
 * this file is opt-in, used wherever a Supabase-backed catalog is
 * explicitly wanted (e.g. production, once wired in).
 */
import { createScenarioCatalogProvider } from './scenario-catalog.provider.js';

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseClient
 * @returns {ReturnType<typeof createScenarioCatalogProvider>}
 */
export function createScenarioCatalogSupabaseProvider(supabaseClient) {
    return createScenarioCatalogProvider(async () => {
        const { data, error } = await supabaseClient
            .from('chat_engine_scenarios')
            .select('scenario_key, version, definition')
            .eq('status', 'published')
            .order('version', { ascending: false });

        if (error) {
            throw new Error(`Failed to load scenarios from Supabase: ${error.message}`);
        }

        // Rows are ordered by version descending, so the first row seen
        // for a given scenario_key is its latest published version.
        const seenKeys = new Set();
        const scenarios = [];
        for (const row of data || []) {
            if (seenKeys.has(row.scenario_key)) continue;
            seenKeys.add(row.scenario_key);
            scenarios.push(row.definition);
        }
        return scenarios;
    });
}
