/**
 * node-providers.js — test-only helper.
 * ------------------------------------------------------------
 * Same fetch-vs-fs rationale as every other module's test helper (see
 * Module 6's dialogue/tests/helpers/node-providers.js). Wires up real
 * Modules 1-6: normalize -> diagnose -> rank -> decide -> render, so
 * this module's end-to-end test exercises a genuine Decision + rendered
 * reply, not hand-crafted fixtures.
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
import { decide } from '../../../decision/decision-engine.js';
import { createEmptyDecisionState } from '../../../decision/decision-types.js';
import { renderDecision } from '../../../dialogue/dialogue-renderer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUPPORT_ENGINE_ROOT = path.join(__dirname, '..', '..', '..');

function createRealGlossaryProvider() {
    return createTechnicalGlossaryProvider(async () => {
        const raw = fs.readFileSync(path.join(SUPPORT_ENGINE_ROOT, 'language', 'data', 'technical-glossary.json'), 'utf-8');
        return JSON.parse(raw).entries;
    });
}

function createRealArabiziProvider() {
    return createArabiziMapProvider(async () => {
        const raw = fs.readFileSync(path.join(SUPPORT_ENGINE_ROOT, 'language', 'data', 'arabizi-map.json'), 'utf-8');
        return JSON.parse(raw);
    });
}

function createRealScenarioCatalogProvider() {
    return createScenarioCatalogProvider(async () => {
        const raw = fs.readFileSync(path.join(SUPPORT_ENGINE_ROOT, 'scenarios', 'scenario-catalog.data', 'scenarios.json'), 'utf-8');
        return JSON.parse(raw).scenarios;
    });
}

/**
 * Runs one full real turn through Modules 1->2->3->4->5->6: normalize ->
 * diagnose -> rank -> decide -> render. Returns { decision, rendered,
 * responseLanguage }.
 */
export async function runPipelineTurn(text, turn, { previousState, previousDecisionState, previousLanguage = 'ar', clock } = {}) {
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

    const { decision, decisionState } = decide({
        ranking: rankingResult,
        turn,
        previousDecisionState: previousDecisionState || createEmptyDecisionState(),
        newEvidenceAddedThisTurn,
        clock
    });

    const rendered = renderDecision(decision, normalized.responseLanguage);

    return { decision, decisionState, diagnosticState, rendered, responseLanguage: normalized.responseLanguage };
}
