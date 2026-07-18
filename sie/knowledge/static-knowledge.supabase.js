/**
 * static-knowledge.supabase.js
 * ------------------------------------------------------------
 * Supabase-backed implementation of the static knowledge provider —
 * the storage-backend swap promised since Module 7, delivered here
 * alongside Module 9's Review Center (this is what lets a staff member
 * edit "pricing"/"platform_info" content and publish a new version
 * without a code deploy). Reuses createStaticKnowledgeProvider()
 * completely unchanged — same factory, same validation, same caching,
 * same getAllEntries/getEntryByKey/getLoadWarnings interface every
 * other module already depends on. Only the loadFn is new.
 * answer-composer.js remains completely unaware this file exists — it
 * only ever calls the provider interface.
 *
 * Reads only the latest PUBLISHED version of each knowledge_key from
 * chat_engine_knowledge_entries (see
 * observability/migrations/0001_add_chat_engine_observability_and_review_center.sql).
 * Draft and archived rows are never surfaced to the running engine —
 * only the Review Center / Validation Lab reads those.
 *
 * static-knowledge.local.js is untouched and remains the default; this
 * file is opt-in, used wherever a Supabase-backed catalog is explicitly
 * wanted (e.g. production, once wired in).
 */
import { createStaticKnowledgeProvider } from './static-knowledge.provider.js';

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseClient
 * @returns {ReturnType<typeof createStaticKnowledgeProvider>}
 */
export function createStaticKnowledgeSupabaseProvider(supabaseClient) {
    return createStaticKnowledgeProvider(async () => {
        const { data, error } = await supabaseClient
            .from('chat_engine_knowledge_entries')
            .select('knowledge_key, version, definition')
            .eq('status', 'published')
            .order('version', { ascending: false });

        if (error) {
            throw new Error(`Failed to load knowledge entries from Supabase: ${error.message}`);
        }

        // Rows are ordered by version descending, so the first row seen
        // for a given knowledge_key is its latest published version.
        const seenKeys = new Set();
        const entries = [];
        for (const row of data || []) {
            if (seenKeys.has(row.knowledge_key)) continue;
            seenKeys.add(row.knowledge_key);
            entries.push(row.definition);
        }
        return entries;
    });
}
