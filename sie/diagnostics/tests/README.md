# Diagnostic Engine — Test Suite

Permanent regression suite, same approach as Modules 1 and 2: Node's
built-in test runner, no external dependencies.

## Running the tests

```bash
node --test diagnostics/tests/
```

## What's covered

| File | Covers |
|---|---|
| `evidence-types.test.mjs` | `checkEvidenceShape` guard cases, empty-state factories |
| `evidence-extractor.test.mjs` | Weight-by-source mapping, filtering of non-evidence-bearing tokens, discriminating-answer evidence construction |
| `evidence-accumulator.test.mjs` | Noisy-OR combination (support and contradict), purity (no mutation), presence bounded to [0,1], contradiction genuinely lowering presence over time |
| `hypothesis-tracker.test.mjs` | Confidence formula correctness, all three status transitions, hysteresis band, history append-on-change-only, record permanence (never deleted), reactivation |
| `diagnostic-engine.test.mjs` | Orchestration (extraction → merge → scoring wiring), live-evidence opt-in behavior and failure resilience, additional-evidence injection, multi-turn state carry-forward, **and full end-to-end integration using real Module 1 + Module 2 data** |

## Why `diagnostic-engine.test.mjs` uses real Module 1 + Module 2 data

`tests/helpers/node-providers.js` wires up genuine normalization
(`normalizeReal`) and the real shipped scenario catalog
(`createRealScenarioCatalogProvider`) — not hand-crafted fixtures — so a
handful of tests exercise the actual cross-module path: raw Arabic/mixed
text in, a scored `DiagnosticState` out. This is what caught a real gap
during development (see below) rather than only ever testing against
idealized inputs.

## Known limitation, tracked as a test

`"KNOWN LIMITATION: a word with an attached Arabic definite article ("ال")
does not match its bare evidence token"` in `diagnostic-engine.test.mjs` is
an intentional, currently-passing regression test documenting that
`الباسورد` does not match the evidence token `باسورد` (see the module's main
`README.md` for the full explanation). If this test ever starts failing,
it means article-stripping was added to Module 1 — at which point this test
and the corresponding note should be revisited or removed, and phrasing in
the other end-to-end tests that currently works around this gap could be
simplified.

## Adding tests when Module 4 (Ranking Engine) is built

The Ranking Engine will consume `DiagnosticState.hypotheses` (specifically
`confidence`, `status`, `supportingEvidenceTokens`, `missingEvidenceTokens`)
without recomputing them. If the shape of `Hypothesis` changes, update
`evidence-types.js` first, then check whether `hypothesis-tracker.test.mjs`
and `diagnostic-engine.test.mjs` still hold.
