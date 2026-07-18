# Ranking Engine — Test Suite

16 unit tests + 7 end-to-end integration tests, using Node's built-in test
runner (same approach as every prior module).

## Running

```bash
node --test tests/ranking-engine.test.mjs tests/ranking-engine.e2e.test.mjs
```

## What's covered

| File | Covers |
|---|---|
| `ranking-engine.test.mjs` | Pure `rankHypotheses()`: empty/null input, sorting, deterministic tie-breaking, rank numbering, scenario attachment (including the defensive null case), `confidenceGap`/`isAmbiguous` at and around both thresholds, `candidateDiscriminatingQuestions` filtering and the top-3 cap |
| `ranking-engine.e2e.test.mjs` | `rankDiagnosticState()`'s provider injection, plus **full real-pipeline integration**: Module 1 normalization → Module 2 catalog → Module 3 diagnosis → Module 4 ranking, using actual shipped data, not fixtures |

## Why the end-to-end numbers are empirically captured, not hand-calculated

Before writing the e2e assertions, the real pipeline was run interactively
to capture actual confidence figures (e.g. `"Token expired"` →
`login_token_expired` at confidence ≈0.30 with no second candidate; `"عندي
مشكلة اشتراك"` → `subscription_payment_not_reflected` ≈0.229 vs
`subscription_expired` ≈0.160, gap ≈0.069, both clearing the activation
threshold → ambiguous). This avoids the mistake from Module 3's first pass,
where two hand-calculated expectations turned out to be wrong. Assertions
here check the *properties* that matter (which scenario leads, whether it's
ambiguous, which discriminating question surfaces) rather than brittle exact
floats, so they stay meaningful if scenario weights are tuned later.

## A note on shell globbing

`tests/**/*.test.mjs` looked like it silently dropped one of the two test
files during development — it hadn't; in bash without `shopt -s globstar`,
`**` doesn't recurse the way you'd expect, and Node's own internal handling
of the resulting literal string was inconsistent to observe from the
outside. `tests/*.test.mjs` (or listing files explicitly) is reliable and
is what's documented here and in every other module's README.
