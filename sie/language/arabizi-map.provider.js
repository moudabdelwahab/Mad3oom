/**
 * arabizi-map.provider.js
 * ------------------------------------------------------------
 * Provider INTERFACE for Arabizi (Franco-Arabic) transliteration data:
 * digit-letter substitutions (3->ع, 7->ح, ...) and common word-level
 * Franco spellings of Egyptian words (msh->مش, 3ayez->عايز, ...).
 *
 * Same pattern as technical-glossary.provider.js: consumers only ever
 * call getMap() on the object returned here, never touch storage
 * directly, so the local-JSON implementation can be swapped for a
 * Supabase-backed one later with zero change to consuming modules.
 */

/**
 * @typedef {Object} ArabiziMap
 * @property {Object<string,string>} digitLetterMap - e.g. { "3": "ع", "7": "ح" }
 * @property {Object<string,string>} wordMap - e.g. { "msh": "مش", "3ayez": "عايز" }
 */

/**
 * Creates an Arabizi map provider around a given async loader function.
 * @param {() => Promise<ArabiziMap>} loadFn
 * @returns {{ getMap: () => Promise<ArabiziMap> }}
 */
export function createArabiziMapProvider(loadFn) {
    let cachedMap = null;
    let inFlight = null;

    async function getMap() {
        if (cachedMap) return cachedMap;
        if (!inFlight) {
            inFlight = Promise.resolve(loadFn()).then((map) => {
                cachedMap = {
                    digitLetterMap: (map && map.digitLetterMap) || {},
                    wordMap: (map && map.wordMap) || {}
                };
                inFlight = null;
                return cachedMap;
            });
        }
        return inFlight;
    }

    return { getMap };
}
