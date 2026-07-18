/**
 * scenario-catalog.local.js
 * ------------------------------------------------------------
 * Local-JSON-backed implementation of the scenario catalog provider.
 * Reads ./scenario-catalog.data/scenarios.json relative to this module.
 * This is the ONLY file in the engine that knows the catalog currently
 * lives in a local JSON file — see technical-glossary.local.js for the
 * identical rationale. Migrating to Supabase later means writing a
 * scenario-catalog.supabase.js implementing the same
 * createScenarioCatalogProvider(loadFn) contract with a Supabase query
 * as its loadFn — no other module changes.
 */
import { createScenarioCatalogProvider } from './scenario-catalog.provider.js';

async function loadFromLocalJson() {
    const dataUrl = new URL('./scenario-catalog.data/scenarios.json', import.meta.url);
    const response = await fetch(dataUrl);
    if (!response.ok) {
        throw new Error(`Failed to load scenarios.json: ${response.status}`);
    }
    const data = await response.json();
    return data.scenarios || [];
}

export const scenarioCatalogProvider = createScenarioCatalogProvider(loadFromLocalJson);
