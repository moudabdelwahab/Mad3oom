/**
 * node-providers.js — test-only helper.
 * ------------------------------------------------------------
 * Same fetch-vs-fs rationale as every prior module's test helper.
 * Wires up real Module 1 (normalization), Module 2 (scenario catalog),
 * and Module 3 (diagnostic processing) so the Ranking Engine's
 * integration tests can run genuine end-to-end turns — raw text in, a
 * real ranked result out — using the actual shipped vocabulary and
 * catalog, not hand-crafted fixtures.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalize } from '../../../language/normalizer.js';
import { createTechnicalGlossaryProvider } from '../../../language/technical-glossary.provider.js';
import { createArabiziMapProvider } from '../../../language/arabizi-map.provider.js';
import { createScenarioCatalogProvider } from '../../../scenarios/scenario-catalog.provider.js';
import { processTurn } from '../../../diagnostics/diagnostic-engine.js';

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

export async function normalizeReal(text, previousLanguage = 'ar') {
    return normalize(text, {
        previousLanguage,
        glossaryProvider: createRealGlossaryProvider(),
        arabiziProvider: createRealArabiziProvider()
    });
}

/**
 * Runs one full real turn: normalize -> diagnose, using real Module 1/2
 * data. Returns the resulting DiagnosticState, ready to be ranked.
 * @param {string} text
 * @param {number} turn
 * @param {import('../../../diagnostics/evidence-types.js').DiagnosticState} [previousState]
 * @returns {Promise<import('../../../diagnostics/evidence-types.js').DiagnosticState>}
 */
export async function diagnoseRealTurn(text, turn, previousState) {
    const normalized = await normalizeReal(text);
    return processTurn({
        normalizedTokens: normalized.normalizedTokens,
        turn,
        previousState,
        scenarioProvider: createRealScenarioCatalogProvider()
    });
}
