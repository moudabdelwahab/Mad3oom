/**
 * node-providers.js — test-only helper.
 * ------------------------------------------------------------
 * Same rationale as Module 1's tests/helpers/node-providers.js: the
 * shipped scenario-catalog.local.js uses fetch(new URL(...,
 * import.meta.url)), correct for a browser loading these as static
 * assets over HTTP. Node's fetch does not resolve file:// the same way,
 * so this injects an fs-based loader through the exact same
 * createScenarioCatalogProvider(loadFn) factory used in production,
 * reading the REAL shipped scenarios.json (not a separate fixture) so
 * these tests catch regressions if the catalog data is edited later.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createScenarioCatalogProvider } from '../../scenario-catalog.provider.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, '..', '..', 'scenario-catalog.data', 'scenarios.json');

/**
 * Creates a fresh provider reading the real scenarios.json.
 * A fresh instance (not shared) per call so caching tests don't leak
 * across other tests.
 */
export function createRealScenarioCatalogProvider() {
    return createScenarioCatalogProvider(async () => {
        const raw = fs.readFileSync(DATA_FILE, 'utf-8');
        return JSON.parse(raw).scenarios;
    });
}
