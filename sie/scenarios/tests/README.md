# Scenario Engine — Test Suite

Permanent regression suite for `/support-engine/scenarios/`, using Node's
built-in test runner (same approach as the Language & Normalization Layer's
suite).

## Running the tests

```bash
node --test scenarios/tests/
```

Or a single file:

```bash
node --test scenarios/tests/scenario-catalog.test.mjs
```

## What's covered

| File | Covers |
|---|---|
| `scenario-types.test.mjs` | Schema validation: every required field, type check, and rejection case (missing fields, bad types, empty arrays, invalid `source` enum, conditional `resolution.text` requirement, duplicate-id detection) |
| `scenario-catalog-provider.test.mjs` | Provider contract: caching, concurrent-load dedup, graceful exclusion of invalid entries (never throws on bad data), `getScenarioById`, `getEvidenceVocabulary` deduplication |
| `scenario-catalog.test.mjs` | Integration/golden-file tests against the **real shipped** `scenarios.json` — zero validation warnings, expected scenario count, specific scenario correctness, and a **cross-module consistency check** against Module 1's technical glossary |

## Why the cross-module consistency test matters

Scenario evidence tokens are deliberately meant to reuse Module 1's canonical
vocabulary (`entity_api`, `http_status_500`, `symptom_not_working`, etc.) so
the Language Layer and Scenario Engine interlock without any translation
step. `scenario-catalog.test.mjs` checks every evidence token that *looks*
glossary-shaped (`entity_*`, `http_status_*`, `symptom_*`) actually exists in
`language/data/technical-glossary.json`. If someone renames a canonical
token in one file without updating the other, this test fails immediately —
instead of the mismatch silently causing a scenario to never match anything
once the Diagnostic/Ranking Engines are wired up.

## Why `helpers/node-providers.js` exists

Same reason as Module 1: the shipped `scenario-catalog.local.js` uses
`fetch(new URL('./scenario-catalog.data/scenarios.json', import.meta.url))`,
correct for a browser but not resolvable by Node's `fetch`. The test helper
injects an fs-based loader through the exact same
`createScenarioCatalogProvider(loadFn)` factory used in production, reading
the real shipped JSON — not a separate fixture — so edits to the catalog are
regression-checked automatically.

## Adding a new scenario

When adding a scenario to `scenario-catalog.data/scenarios.json`:
1. Run the suite — `scenario-catalog.test.mjs`'s "zero validation warnings"
   test will fail loudly if the shape is wrong, with a specific error message
   from `validateScenario`.
2. If it introduces a new evidence token that looks glossary-shaped, either
   add the matching entry to Module 1's `technical-glossary.json` first, or
   use a plain dialect-derived token (a normalized Arabic word) instead.
3. Consider adding a specific assertion for the new scenario in
   `scenario-catalog.test.mjs`, the way `login_token_expired` has one.
