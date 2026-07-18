# Diagnostic Engine — Module 3

The reasoning core of the Support Intelligence Engine. Turns evidence into a
persistent, confidence-scored belief state — one Hypothesis per Scenario
(Module 2), tracked turn over turn. Produces no replies and makes no
decisions; that remains the Ranking Engine's (Module 4) and Decision
Engine's (Module 5) job.

## Files

| File | Responsibility |
|---|---|
| `evidence-types.js` | Shapes for `Evidence`, `Hypothesis`, `EvidenceAccumulator`, `DiagnosticState`, plus lightweight internal sanity guards |
| `evidence-extractor.js` | Converts Module 1's normalized token stream into weighted `Evidence`; also builds evidence from discriminating-question answers (for future Decision/Dialogue Engine use) |
| `evidence-accumulator.js` | Append-only evidence log + noisy-OR presence combination (supports **and** contradicts) |
| `hypothesis-tracker.js` | Per-scenario confidence scoring + status/history tracking with hysteresis |
| `live-evidence-provider.js` / `.stub.js` | Interface for account-derived evidence (tickets, subscriptions, etc.) — **stub only, no real Supabase calls in this module** |
| `diagnostic-engine.js` | Orchestrates one turn: extract → merge → score → return `DiagnosticState` |

## How confidence is computed

For each scenario, each evidence token's **net presence** is combined across
every observation of it so far via noisy-OR:

```
supportPresence(token)    = 1 − Π(1 − weight_i)   over all "supports" evidence
contradictPresence(token) = 1 − Π(1 − weight_i)   over all "contradicts" evidence
netPresence(token)        = supportPresence × (1 − contradictPresence)
```

Then the scenario's confidence is a weighted average against its own
`evidenceSignature` (from Module 2):

```
confidence = Σ(netPresence(token) × scenarioWeight(token)) / Σ(scenarioWeight(token))
```

Bounded to `[0,1]`, deterministic, and this is the exact number the Ranking
Engine will consume — it will not recompute it.

## Status & hysteresis

- `unconsidered` — never reached the activation threshold (`0.15`)
- `active` — at/above `0.15`, or was active and hasn't dropped below the
  rejection threshold (`0.05`) yet
- `rejected` — was active, and confidence has since dropped below `0.05`

A hypothesis record is **never deleted** — only its status/confidence change,
and every change is appended to `history`. A rejected hypothesis can become
active again if new evidence justifies it (a reactivation, also recorded).
This is what makes a future escalated ticket's diagnostic trail meaningful:
it can show what was considered and ruled out, not just the final belief.

## Isolation

- No Supabase calls. `live-evidence-provider.stub.js` always returns no
  evidence; scenarios that declare `source: 'live'` evidence simply don't
  receive support from it yet.
- Not wired into `chat-logic.js` / `chatbot-engine.js`. Nothing in the live
  chat changed.
- `processTurn()` is a pure orchestration function — the caller supplies the
  previous `DiagnosticState` and gets a new one back; this module holds no
  memory between calls, and the returned state is plain-JSON-serializable
  (verified by a round-trip test) so it can later be dropped straight into
  `chat_sessions.bot_state` without transformation.

## Known limitation: Arabic definite article ("ال") is not stripped

Module 1's tokenizer/dialect-normalizer does not perform morphological
stemming. A word written with the definite article fused on with no space —
standard Arabic orthography, e.g. `الباسورد` ("the password"), `الدخول`
("the login") — tokenizes as one token distinct from the catalog's bare
evidence token (`باسورد`, `دخول`), and will not match it.

This is **not** a Diagnostic Engine bug — the exact-token matching here is
working correctly against whatever Module 1 produces. It's a vocabulary/
tokenization gap between modules, worth fixing at some point (likely a small,
explicitly-scoped addition to `dialect-normalizer.js` to strip a leading
`ال` when a bare form is also a known vocabulary token — NOT done here, since
that would mean reopening an already-approved, already-tested module
mid-task). It's locked in as an explicit regression test
(`diagnostic-engine.test.mjs`, `"KNOWN LIMITATION: ..."`) so it's tracked
and won't be silently rediscovered later, and other integration tests were
written using phrasing that avoids it (documented inline where relevant).

## Running the tests

```bash
node --test diagnostics/tests/
```

See `tests/README.md` for the full breakdown of what each test file covers.
