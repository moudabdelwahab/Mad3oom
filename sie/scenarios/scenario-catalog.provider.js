/**
 * scenario-catalog.provider.js
 * ------------------------------------------------------------
 * Provider INTERFACE for the Scenario Catalog — the domain knowledge of
 * "what can be wrong". Same pattern as technical-glossary.provider.js /
 * arabizi-map.provider.js: consumers only ever call methods on the
 * object returned here, never touch storage directly, so the
 * local-JSON implementation (scenario-catalog.local.js) can be swapped
 * for a Supabase-backed one later with zero change to any consuming
 * module (Diagnostic Engine, Ranking Engine, Decision Engine).
 *
 * Unlike the Language layer's providers, this one validates its data on
 * load (via scenario-types.js) and silently excludes invalid entries
 * (logging a warning) rather than throwing — a malformed scenario
 * definition should degrade the catalog, not crash the engine.
 */
import { validateCatalog } from './scenario-types.js';

/**
 * Creates a scenario catalog provider around a given async loader
 * function that returns the raw (unvalidated) scenario array.
 *
 * @param {() => Promise<Object[]>} loadFn
 * @returns {{
 *   getAllScenarios: () => Promise<import('./scenario-types.js').Scenario[]>,
 *   getScenarioById: (id: string) => Promise<import('./scenario-types.js').Scenario|null>,
 *   getEvidenceVocabulary: () => Promise<string[]>,
 *   getLoadWarnings: () => Promise<string[]>
 * }}
 */
export function createScenarioCatalogProvider(loadFn) {
    let cached = null; // { scenarios, warnings }
    let inFlight = null;

    async function loadAndValidate() {
        if (cached) return cached;
        if (!inFlight) {
            inFlight = Promise.resolve(loadFn()).then((rawScenarios) => {
                const { valid, invalid } = validateCatalog(rawScenarios);
                const warnings = invalid.map(
                    ({ scenario, errors }) =>
                        `Skipped invalid scenario (id: ${scenario?.id ?? 'unknown'}): ${errors.join('; ')}`
                );
                for (const warning of warnings) {
                    // eslint-disable-next-line no-console
                    console.warn(`[scenario-catalog] ${warning}`);
                }
                cached = { scenarios: valid, warnings };
                inFlight = null;
                return cached;
            });
        }
        return inFlight;
    }

    async function getAllScenarios() {
        const { scenarios } = await loadAndValidate();
        return scenarios;
    }

    async function getScenarioById(id) {
        const { scenarios } = await loadAndValidate();
        return scenarios.find((s) => s.id === id) || null;
    }

    async function getEvidenceVocabulary() {
        const { scenarios } = await loadAndValidate();
        const tokens = new Set();
        for (const scenario of scenarios) {
            for (const entry of scenario.evidenceSignature) tokens.add(entry.token);
        }
        return Array.from(tokens);
    }

    async function getLoadWarnings() {
        const { warnings } = await loadAndValidate();
        return warnings;
    }

    return { getAllScenarios, getScenarioById, getEvidenceVocabulary, getLoadWarnings };
}
