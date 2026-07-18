/**
 * node-providers.js — test-only helper.
 * ------------------------------------------------------------
 * Wires up real Modules 1-4 (normalize -> diagnose -> rank) exactly
 * like Module 5's test helper, plus exposes the response language from
 * normalization so end-to-end Dialogue Engine tests can render in the
 * correct language exactly as the real pipeline would.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalize } from '../../../language/normalizer.js';
import { createTechnicalGlossaryProvider } from '../../../language/technical-glossary.provider.js';
import { createArabiziMapProvider } from '../../../language/arabizi-map.provider.js';
import { createScenarioCatalogProvider } from '../../../scenarios/scenario-catalog.provider.js';
import { processTurn } from '../../../diagnostics/diagnostic-engine.js';
import { rankHypotheses } from '../../../ranking/ranking-engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUPPORT_ENGINE_ROOT = path.join(__dirname, '..', '..', '..');

export function createRealGlossaryProvider() {
    return createTechnicalGlossaryProvider(async () => {
        const raw = fs.readFileSync(path.join(SUPPORT_ENGINE_ROOT, 'language', 'data', 'technical-glossary.json'), 'utf-8');
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
        const raw = fs.readFileSync(path.join(SUPPORT_ENGINE_ROOT, 'scenarios', 'scenario-catalog.data', 'scenarios.json'), 'utf-8');
        return JSON.parse(raw).scenarios;
    });
}

/**
 * Runs one full real turn through Modules 1->2->3->4: normalize ->
 * diagnose -> rank. Returns { rankingResult, diagnosticState,
 * responseLanguage, newEvidenceAddedThisTurn }.
 */
export async function runPipelineTurn(text, turn, previousState, previousLanguage = 'ar') {
    const normalized = await normalize(text, {
        previousLanguage,
        glossaryProvider: createRealGlossaryProvider(),
        arabiziProvider: createRealArabiziProvider()
    });
    const scenarioProvider = createRealScenarioCatalogProvider();
    const diagnosticState = await processTurn({
        normalizedTokens: normalized.normalizedTokens,
        turn,
        previousState,
        scenarioProvider
    });
    const scenarios = await scenarioProvider.getAllScenarios();
    const rankingResult = rankHypotheses(diagnosticState.hypotheses, scenarios);

    const priorEntryCount = previousState?.accumulator?.entries?.length || 0;
    const newEvidenceAddedThisTurn = diagnosticState.accumulator.entries.length - priorEntryCount;

    return { rankingResult, diagnosticState, responseLanguage: normalized.responseLanguage, newEvidenceAddedThisTurn };
}
