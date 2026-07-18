/**
 * node-providers.js — test-only helper.
 * ------------------------------------------------------------
 * Builds glossary/Arabizi providers backed by the REAL shipped JSON
 * files in ../../data/, using fs instead of fetch. This exists purely
 * because Node's fetch implementation does not resolve file:// URLs the
 * way a browser resolves relative module fetches served over HTTP
 * (which is how technical-glossary.local.js / arabizi-map.local.js are
 * actually used in production, in the website chat widget).
 *
 * Deliberately reads the SAME data files the production local.js
 * providers use (not a separate test fixture), so these tests catch
 * regressions if the shipped glossary/Arabizi JSON is edited later.
 *
 * This also exercises the provider abstraction itself: swapping the
 * loading mechanism (fetch -> fs) requires zero changes to
 * normalizer.js or any other consuming module — only a different
 * loadFn passed into the same createTechnicalGlossaryProvider /
 * createArabiziMapProvider factories used in production.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTechnicalGlossaryProvider } from '../../technical-glossary.provider.js';
import { createArabiziMapProvider } from '../../arabizi-map.provider.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '..', 'data');

/**
 * Creates a fresh glossary provider reading the real technical-glossary.json.
 * A fresh instance (not a shared singleton) is returned so tests that
 * check caching behavior aren't affected by other tests' prior calls.
 */
export function createRealGlossaryProvider() {
    return createTechnicalGlossaryProvider(async () => {
        const raw = fs.readFileSync(path.join(DATA_DIR, 'technical-glossary.json'), 'utf-8');
        return JSON.parse(raw).entries;
    });
}

/**
 * Creates a fresh Arabizi map provider reading the real arabizi-map.json.
 */
export function createRealArabiziProvider() {
    return createArabiziMapProvider(async () => {
        const raw = fs.readFileSync(path.join(DATA_DIR, 'arabizi-map.json'), 'utf-8');
        return JSON.parse(raw);
    });
}
