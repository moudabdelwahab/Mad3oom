/**
 * technical-glossary.provider.js
 * ------------------------------------------------------------
 * Provider INTERFACE for the technical vocabulary glossary (API, DNS,
 * Token, SSL, HTTP status codes, etc.).
 *
 * This file defines the contract every implementation must satisfy.
 * Nothing in the rest of the engine is allowed to read the glossary's
 * underlying storage directly — only through this interface. That is
 * what makes it possible to swap the local-JSON implementation
 * (technical-glossary.local.js) for a Supabase-backed one later without
 * changing any consuming module.
 *
 * Consumers call createTechnicalGlossaryProvider(loadFn) and use the
 * returned provider's getEntries(). The `loadFn` is injected so the
 * loading mechanism (fetch from a local JSON file today, a Supabase
 * query later) is fully decoupled from the matching logic that uses it.
 */

/**
 * @typedef {Object} GlossaryEntry
 * @property {string} canonical - Canonical evidence token, e.g. "http_status_401"
 * @property {{ar: string, en: string}} labels - Human-readable labels per language
 * @property {string[]} patterns - Surface forms that map to this canonical token,
 *                                   e.g. ["error 401", "401 error", "401"]
 */

/**
 * Creates a technical glossary provider around a given async loader function.
 * The loader is responsible only for producing the raw entries array —
 * everything else (caching, shape validation) is handled here so every
 * implementation behaves consistently regardless of storage backend.
 *
 * @param {() => Promise<GlossaryEntry[]>} loadFn
 * @returns {{ getEntries: () => Promise<GlossaryEntry[]> }}
 */
export function createTechnicalGlossaryProvider(loadFn) {
    let cachedEntries = null;
    let inFlight = null;

    async function getEntries() {
        if (cachedEntries) return cachedEntries;
        if (!inFlight) {
            inFlight = Promise.resolve(loadFn()).then((entries) => {
                cachedEntries = Array.isArray(entries) ? entries : [];
                inFlight = null;
                return cachedEntries;
            });
        }
        return inFlight;
    }

    return { getEntries };
}
