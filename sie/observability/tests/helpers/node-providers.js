/**
 * node-providers.js — test-only helper.
 * ------------------------------------------------------------
 * Same fetch-vs-fs rationale as every other module's test helper.
 * replay-engine.js's defaults are the fetch-based `.local.js` singletons
 * (consistent with every other module's production defaults), which
 * don't work under Node's plain test runner in this environment — so
 * every test that needs real content builds an explicit ReplayConfig
 * from fs-based providers here instead, the same convention already
 * established in knowledge/tests/helpers/node-providers.js and
 * action/tests/helpers/node-providers.js.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTechnicalGlossaryProvider } from '../../../language/technical-glossary.provider.js';
import { createArabiziMapProvider } from '../../../language/arabizi-map.provider.js';
import { createScenarioCatalogProvider } from '../../../scenarios/scenario-catalog.provider.js';
import { createStaticKnowledgeProvider } from '../../../knowledge/static-knowledge.provider.js';

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

/** A full ReplayConfig built from real fs-based providers — the "currently published" baseline. */
export function createRealReplayConfig(overrides = {}) {
    return {
        language: { glossaryProvider: createRealGlossaryProvider(), arabiziProvider: createRealArabiziProvider() },
        scenarioProvider: createRealScenarioCatalogProvider(),
        staticKnowledgeProvider: createRealStaticKnowledgeProvider(),
        ...overrides
    };
}
