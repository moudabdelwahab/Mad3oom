/**
 * technical-glossary.local.js
 * ------------------------------------------------------------
 * Local-JSON-backed implementation of the technical glossary provider.
 *
 * Reads ./data/technical-glossary.json relative to this module. This is
 * the ONLY file in the engine that knows the glossary currently lives in
 * a local JSON file. When/if this is migrated to Supabase, a new
 * technical-glossary.supabase.js would implement the same
 * createTechnicalGlossaryProvider(loadFn) contract with a Supabase query
 * as its loadFn, and every other module (normalizer, evidence-extractor,
 * etc.) would be swapped over without any change to their own code.
 */
import { createTechnicalGlossaryProvider } from './technical-glossary.provider.js';

async function loadFromLocalJson() {
    const dataUrl = new URL('./data/technical-glossary.json', import.meta.url);
    const response = await fetch(dataUrl);
    if (!response.ok) {
        throw new Error(`Failed to load technical-glossary.json: ${response.status}`);
    }
    const data = await response.json();
    return data.entries || [];
}

export const technicalGlossaryProvider = createTechnicalGlossaryProvider(loadFromLocalJson);
