# Observability, Review Center & Validation Lab — Test Suite

97 tests total, Node's built-in test runner, no external dependencies. Zero
live database reads or writes.

## Running

```bash
node --test observability/tests/*.test.mjs
```

(Use explicit file paths or `tests/*.test.mjs`, not `tests/**/*.test.mjs` —
see the note on shell globbing in the Ranking Engine's test README, which
applies identically here.)

## What's covered

| File | Covers |
|---|---|
| `trace-types.test.mjs` | `checkTraceEventShape`'s field-by-field validation |
| `trace-logger.test.mjs` | `buildTraceEvent()` (hypothesis projection, ranking-snapshot derivation, degrade-gracefully-on-nulls, JSON round-trip) and `learningQueueReason()`/`filterLearningQueue()` (all three flagging conditions, plus the "known scenario ≠ unknown" and confidence-boundary edge cases) |
| `observability-read-port.test.mjs` | The interface's resilience (thrown error / malformed / null result all degrade to `null`) and the stub's always-not-found behavior |
| `observability-read-port-supabase.test.mjs` | The real implementation against a mock query client: customer-only messages, turn ordering, session filtering, unknown session → `null`, query-error resilience |
| `comparison-engine.test.mjs` | `compareReplays()`: no-change baseline, action/scenario/response-text change detection, `confidenceDelta` computation (including the null-propagation case), turn-only-in-one-side merging, ordering, JSON round-trip |
| `validation-policy.test.mjs` | `evaluateTurn()`/`evaluateComparison()`: the confidence-regression-tolerance boundary, the broadened degrading-action check (see the module README's "Regression policy" section), the turn-present-in-only-one-replay failure, multi-reason turns, aggregate pass/fail |
| `publish-gate.test.mjs` | `canTransition()`'s full state machine (including the terminal `published` state) and `decidePublishability()`'s three cases: verdict passed, verdict failed with/without a real (non-whitespace) override reason, and no verdict recorded at all |
| `replay-engine.e2e.test.mjs` | The real pipeline replayed end to end: reproduces Module 5's Journey C exactly, carries diagnostic/decision state correctly across turns, turn-order independence, an alternate ("after") knowledge provider changing only the rendered text, an alternate ("after") scenario provider changing which scenario resolves, JSON safety |
| `shadow-run-engine.e2e.test.mjs` | The full Regression Suite Runner over real conversations: a no-op edit passes everything, a content-only Knowledge edit passes (no action/confidence regression), a genuinely broken edit (empty scenario catalog) is correctly caught as a failure, an empty conversation set doesn't crash (and isn't vacuously "passed"), JSON safety |
| `action-layer-observability-writers.test.mjs` | The 8 Observability write functions added to `action/action-layer.js`: routing, return-value shape (`reviewId`/`draftVersion`/`runId`), structured-failure and thrown-exception resilience, and a JSON round-trip — kept in `observability/tests/` rather than `action/tests/` because these were added *during* Module 9, even though they live in a Module 8 file |

## Why the mock query client, not the real Supabase client, is what every storage-swap test calls

`observability-read-port-supabase.test.mjs` reuses the exact same
`mock-supabase-query-client.js` helper from `scenarios/tests/helpers/` that
Module 2's own `scenario-catalog-supabase.test.mjs` uses — not a copy, the
same file, imported across the module boundary. This was a deliberate
choice already baked into that helper's own docstring before this module's
work began (it explicitly anticipates being used for "the two new
Supabase-backed providers"), so reusing it here keeps that promise rather
than duplicating a parallel fake.

## Why the empirically-captured numbers matter here too

`replay-engine.e2e.test.mjs` and `shadow-run-engine.e2e.test.mjs` run the
real pipeline before asserting anything, the same discipline established in
Modules 3–8. One assumption this actually caught during development: a
Knowledge edit that deletes the `pricing` static-content entry entirely does
**not** change the decision's action (the scenario still auto-resolves via
its own `resolution.text` fallback) — worth knowing before assuming any
content deletion is automatically a regression under the default policy.
