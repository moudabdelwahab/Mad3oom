/**
 * static-knowledge.provider.js
 * ------------------------------------------------------------
 * Provider INTERFACE for static knowledge content (pricing, platform
 * info) — the counterpart, for genuinely static answers, to Module 2's
 * scenario-catalog.provider.js. Same pattern exactly: consumers only
 * ever call methods on the object returned here, never touch storage
 * directly, so the local-JSON implementation (static-knowledge.local.js)
 * can be swapped for a Supabase-backed one later with zero change to
 * any consuming module (currently only answer-composer.js).
 *
 * Also validates on load and silently excludes invalid entries (logging
 * a warning) rather than throwing, for the same "malformed content
 * should degrade the set, not crash the engine" reason as the scenario
 * catalog provider.
 */
import { validateStaticKnowledgeEntries } from './knowledge-types.js';

/**
 * Creates a static knowledge provider around a given async loader
 * function that returns the raw (unvalidated) entry array.
 *
 * @param {() => Promise<Object[]>} loadFn
 * @returns {{
 *   getAllEntries: () => Promise<import('./knowledge-types.js').StaticKnowledgeEntry[]>,
 *   getEntryByKey: (key: string) => Promise<import('./knowledge-types.js').StaticKnowledgeEntry|null>,
 *   getLoadWarnings: () => Promise<string[]>
 * }}
 */
export function createStaticKnowledgeProvider(loadFn) {
    let cached = null; // { entries, warnings }
    let inFlight = null;

    async function loadAndValidate() {
        if (cached) return cached;
        if (!inFlight) {
            inFlight = Promise.resolve(loadFn()).then((rawEntries) => {
                const { valid, invalid } = validateStaticKnowledgeEntries(rawEntries);
                const warnings = invalid.map(
                    ({ entry, errors }) => `Skipped invalid static knowledge entry (key: ${entry?.key ?? 'unknown'}): ${errors.join('; ')}`
                );
                for (const warning of warnings) {
                    // eslint-disable-next-line no-console
                    console.warn(`[static-knowledge] ${warning}`);
                }
                cached = { entries: valid, warnings };
                inFlight = null;
                return cached;
            });
        }
        return inFlight;
    }

    async function getAllEntries() {
        const { entries } = await loadAndValidate();
        return entries;
    }

    async function getEntryByKey(key) {
        const { entries } = await loadAndValidate();
        return entries.find((e) => e.key === key) || null;
    }

    async function getLoadWarnings() {
        const { warnings } = await loadAndValidate();
        return warnings;
    }

    return { getAllEntries, getEntryByKey, getLoadWarnings };
}
