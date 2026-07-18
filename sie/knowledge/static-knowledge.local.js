/**
 * static-knowledge.local.js
 * ------------------------------------------------------------
 * Local-JSON-backed implementation of the static knowledge provider.
 * Reads ./static-knowledge.data/content.json relative to this module.
 * This is the ONLY file in the engine that knows static knowledge
 * content currently lives in a local JSON file — see
 * scenario-catalog.local.js for the identical rationale. Migrating to
 * Supabase later means writing a static-knowledge.supabase.js
 * implementing the same createStaticKnowledgeProvider(loadFn) contract
 * with a Supabase query as its loadFn — no other module changes.
 */
import { createStaticKnowledgeProvider } from './static-knowledge.provider.js';

async function loadFromLocalJson() {
    const dataUrl = new URL('./static-knowledge.data/content.json', import.meta.url);
    const response = await fetch(dataUrl);
    if (!response.ok) {
        throw new Error(`Failed to load content.json: ${response.status}`);
    }
    const data = await response.json();
    return data.entries || [];
}

export const staticKnowledgeProvider = createStaticKnowledgeProvider(loadFromLocalJson);
