/**
 * arabizi-map.local.js
 * ------------------------------------------------------------
 * Local-JSON-backed implementation of the Arabizi map provider.
 * Reads ./data/arabizi-map.json relative to this module. Only this file
 * knows the data currently lives locally — see technical-glossary.local.js
 * for the identical rationale.
 */
import { createArabiziMapProvider } from './arabizi-map.provider.js';

async function loadFromLocalJson() {
    const dataUrl = new URL('./data/arabizi-map.json', import.meta.url);
    const response = await fetch(dataUrl);
    if (!response.ok) {
        throw new Error(`Failed to load arabizi-map.json: ${response.status}`);
    }
    return response.json();
}

export const arabiziMapProvider = createArabiziMapProvider(loadFromLocalJson);
