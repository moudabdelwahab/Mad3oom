# Ranking Engine — Module 4

Turns the Diagnostic Engine's per-scenario hypotheses (already confidence-
scored — this module never re-scores anything) into a **cross-scenario**
comparison: an ordering, a measure of how close the top contenders are, and
which discriminating questions could help tell them apart.

Makes no decisions and generates no customer-facing text. That's the
Decision Engine's (Module 5) and Dialogue Engine's job.

## Files

| File | Responsibility |
|---|---|
| `ranking-engine.js` | `rankHypotheses()` (pure, sync) + `rankDiagnosticState()` (async convenience wrapper fetching scenarios via Module 2's provider) |

## Why this module exists separately from the Diagnostic Engine

Module 3 answers "how confident am I in scenario X, on its own?" Module 4
answers "given every scenario's confidence, what does that mean *together*?"
— which one leads, whether the top two are too close to call, and what
would help separate them. That's inherently a comparison across the whole
catalog, not a property of any single hypothesis, so it stays out of Module
3 to keep both modules swappable independently (a smarter scoring method
could replace Module 3's formula, or a smarter comparison strategy could
replace Module 4's, without the other needing to change).

## What `rankHypotheses()` returns

```
{
  ranked: [{ hypothesis, scenario, rank }, ...],   // all hypotheses, sorted desc by confidence
  topHypothesis: RankedEntry | null,
  runnerUp: RankedEntry | null,
  confidenceGap: number | null,   // gap between top 2 CANDIDATES (>= activation threshold); null if <2 candidates
  isAmbiguous: boolean,           // true when >=2 candidates are within AMBIGUITY_MARGIN (0.1)
  candidateDiscriminatingQuestions: [{ scenarioId, question }, ...]  // for top 3 candidates, questions targeting their own missing evidence
}
```

`confidenceGap: null` covers two different real situations: a single clear
leader with nothing else close, or genuinely too little evidence for any
comparison to be meaningful. Both cases mean the same thing downstream —
"nothing to disambiguate between right now" — so they're intentionally not
distinguished here; Module 5 decides what to do with a clear leader (present
a resolution) versus ambiguity (ask a question), using `isAmbiguous` and the
scenario's own confidence, not `confidenceGap` alone.

## Thresholds reused, not duplicated

`ACTIVATION_THRESHOLD` (which hypotheses count as "candidates" at all) is
imported directly from Module 3's `hypothesis-tracker.js` rather than
redefined here, so the two modules can't silently drift apart on what
"a real contender" means. Only `AMBIGUITY_MARGIN` (0.1) and
`MAX_CANDIDATE_QUESTIONS_SCENARIOS` (3) are new, Ranking-Engine-specific
constants.

## Isolation

Pure function core has zero I/O. The async wrapper only talks to Module 2's
scenario provider (same one Module 3 already uses) — no Supabase calls, no
live chat wiring, no WhatsApp references.

## Running the tests

```bash
node --test ranking/tests/ranking-engine.test.mjs ranking/tests/ranking-engine.e2e.test.mjs
```

(Note: on some shells, `tests/**/*.test.mjs` may not expand as expected
without `shopt -s globstar` — prefer `tests/*.test.mjs` or listing files
explicitly, both of which reliably match every test file used throughout
this project.)

See `tests/README.md` for what each test file covers.
