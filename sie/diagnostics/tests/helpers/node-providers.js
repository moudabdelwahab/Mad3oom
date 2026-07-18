/**
 * node-providers.js — test-only helper.
 * ------------------------------------------------------------
 * Same fetch-vs-fs rationale as Module 1 and Module 2's test helpers.
 * This one goes one step further: it wires up REAL Module 1 (language)
 * and Module 2 (scenarios) data together, so the Diagnostic Engine's
 * integration tests can run genuine end-to-end turns ("normalize this
 * raw message, then diagnose it") using the actual shipped vocabulary
 * and catalog — not hand-crafted fixtures — which is what makes those
 * tests meaningful as cross-module regression coverage.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalize } from '../../../language/normalizer.js';
import { createTechnicalGlossaryProvider } from '../../../language/technical-glossary.provider.js';
import { createArabiziMapProvider } from '../../../language/arabizi-map.provider.js';
import { createScenarioCatalogProvider } from '../../../scenarios/scenario-catalog.provider.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUPPORT_ENGINE_ROOT = path.join(__dirname, '..', '..', '..');

export function createRealGlossaryProvider() {
    return createTechnicalGlossaryProvider(async () => {
        const raw = fs.readFileSync(
            path.join(SUPPORT_ENGINE_ROOT, 'language', 'data', 'technical-glossary.json'),
            'utf-8'
        );
        return JSON.parse(raw).entries;
    });
}

export function createRealArabiziProvider() {
    return createArabiziMapProvider(async () => {
        const raw = fs.readFileSync(path.join(SUPPORT_ENGINE_ROOT, 'language', 'data', 'arabizi-map.json'), 'utf-8');
        return JSON.parse(raw);
    });
}

export function createRealScenarioCatalogProvider() {
    return createScenarioCatalogProvider(async () => {
        const raw = fs.readFileSync(
            path.join(SUPPORT_ENGINE_ROOT, 'scenarios', 'scenario-catalog.data', 'scenarios.json'),
            'utf-8'
        );
        return JSON.parse(raw).scenarios;
    });
}

/**
 * Runs real Module 1 normalization for a message, using Node-compatible
 * (fs-based) providers instead of the shipped fetch-based ones.
 * @param {string} text
 * @param {'ar'|'en'} [previousLanguage]
 * @returns {Promise<{rawText: string, normalizedTokens: Array, responseLanguage: string}>}
 */
export async function normalizeReal(text, previousLanguage = 'ar') {
    return normalize(text, {
        previousLanguage,
        glossaryProvider: createRealGlossaryProvider(),
        arabiziProvider: createRealArabiziProvider()
    });
}
