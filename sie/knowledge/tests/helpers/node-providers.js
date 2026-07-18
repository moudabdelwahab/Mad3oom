/**
 * node-providers.js — test-only helper.
 * ------------------------------------------------------------
 * Same fetch-vs-fs rationale as every other module's test helper (see
 * Module 6's dialogue/tests/helpers/node-providers.js). Wires up real
 * Modules 1-6 (normalize -> diagnose -> rank -> decide) plus Module 7's
 * own real static knowledge content, so this module's end-to-end tests
 * exercise the actual shipped scenario/content data, not hand-crafted
 * fixtures.
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
import { createStaticKnowledgeProvider } from '../../static-knowledge.provider.js';

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

export function createRealStaticKnowledgeProvider() {
    return createStaticKnowledgeProvider(async () => {
        const raw = fs.readFileSync(path.join(SUPPORT_ENGINE_ROOT, 'knowledge', 'static-knowledge.data', 'content.json'), 'utf-8');
        return JSON.parse(raw).entries;
    });
}

/**
 * Runs one full real turn through Modules 1->2->3->4->5: normalize ->
 * diagnose -> rank -> decide. Returns { decision, decisionState,
 * responseLanguage, newEvidenceAddedThisTurn }.
 */
export async function runPipelineTurnToDecision(text, turn, { previousState, previousDecisionState, previousLanguage = 'ar', clock } = {}) {
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

    return { decision, decisionState, diagnosticState, responseLanguage: normalized.responseLanguage, newEvidenceAddedThisTurn };
}
