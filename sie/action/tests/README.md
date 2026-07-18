# Action Layer — Test Suite

37 tests total in this folder (plus 15 more in `observability/tests/
action-layer-observability-writers.test.mjs`, testing the 8 methods added
to this same module during Module 9 — see that module's test README).
Node's built-in test runner, no external dependencies. Zero live database
writes — every test goes through `helpers/mock-supabase-port.js`.

## Running

```bash
node --test action/tests/*.test.mjs
```

(Use explicit file paths or `tests/*.test.mjs`, not `tests/**/*.test.mjs` —
see the note on shell globbing in the Ranking Engine's test README, which
applies identically here.)

## What's covered

| File | Covers |
|---|---|
| `action-types.test.mjs` | `buildActionResult()` for every step-count/success combination (the only place the atomicity flags are computed), `checkActionResultShape`, `formatTicketDescription()` (real trail formatting, missing `ticketDraft`, empty trail, null decision) |
| `supabase-port.test.mjs` | `createSupabasePort()`'s contract check across all 10 methods (2 from this module, 8 added during Module 9) — accepts a complete implementation, throws immediately (naming every missing method) whether a Module 8 or Module 9 method is missing, or present-but-not-a-function |
| `action-layer.test.mjs` | `executeDecision()` routing (message-only actions → `persistBotTurn`, ticket actions → `createTicketWithMessageAndSessionUpdate`), exact params forwarded, structured write failures, thrown exceptions caught and reported as data, missing-input validation, JSON round-trip |
| `action-layer.e2e.test.mjs` | Real Modules 1–6 producing a genuine `ANSWER` and a genuine two-turn `CREATE_TICKET` journey (same as Module 5's Journey C), each carried through `executeDecision()` for real — including the core structural proof: a downstream write failure never touches or invalidates the Decision object itself |

## Why the mock, not the real port, is what every test calls

`supabase-port.supabase.js` is real, reviewable code — but per explicit
instruction, no test in this project performs a live database write.
`tests/helpers/mock-supabase-port.js` implements the exact same
`SupabasePort` contract (validated through the same `createSupabasePort()`
used by the real implementation) as an in-memory fake, with optional failure
injection (`failMethod`) for exercising the "the write failed, and the
engine handled that honestly" paths. This mirrors the same "real
implementation exists, only the stub/mock is exercised" posture already
established for `live-evidence-provider.js` (Module 3) and
`live-knowledge.provider.js` (Module 7).
