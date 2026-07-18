# Decision Engine — Module 5

The most important module in the Support Intelligence Engine, and deliberately
the narrowest in scope: it is responsible **only** for deciding what happens
next. It performs no diagnosis (Module 3), no ranking (Module 4), and
generates no customer-facing text (future Dialogue Engine). It consumes
Module 4's `RankingResult` and produces exactly one structured `Decision`
per turn.

## Files

| File | Responsibility |
|---|---|
| `decision-types.js` | `ACTIONS` enum (the fixed 12), `Decision`/`DecisionState` shapes, `checkDecisionShape` guard |
| `decision-policy.js` | All tunable thresholds, kept separate from the logic that applies them |
| `decision-engine.js` | `decide()` — pure, synchronous, zero I/O |

## The twelve actions and their genuine, distinct triggers

| Action | Triggered when |
|---|---|
| `WAIT_FOR_USER` | Brand-new session, zero interpretable content yet |
| `ANSWER` | Leading scenario ≥ resolution threshold AND has an auto-resolution |
| `ASK_CLARIFYING_QUESTION` | Nothing is a real candidate yet, OR top two are ambiguous, OR leader is plausible but under-confident — targeted (from Module 4's candidate questions) when one is available and unasked, generic otherwise |
| `ASK_FOR_LOGS` | Confident leader, no auto-resolution, category `api` |
| `ASK_FOR_ATTACHMENT` | Confident leader, no auto-resolution, category `subscription` (or any unmapped category — the safe default) |
| `ASK_FOR_SCREENSHOT` | Confident leader, no auto-resolution, category `whatsapp`/`login`/`other` |
| `REQUEST_ACCOUNT_DETAILS` | Leading (or ambiguous top) scenario has a missing evidence token whose only source is live account data, not yet requested |
| `VERIFY_INFORMATION` | Plausible-but-unconfident leader, question budget exhausted, not yet verified once |
| `CREATE_TICKET` | Confident-but-unresolvable leader after its one evidence request, OR ambiguity/refinement exhausted with no further automated path |
| `ESCALATE_TO_HUMAN` | Hard turn-budget cap (overrides everything), OR question budget exhausted while still unrecognized/ambiguous |
| `COMPLETE` | Previous action was `ANSWER` and no new evidence followed (silence = presumed resolved) |
| `FALLBACK` | No ranked hypotheses at all, or repeated turns with zero new evidence (and not case above) |

`ASK_FOR_SCREENSHOT`/`ASK_FOR_LOGS`/`ASK_FOR_ATTACHMENT` are chosen by **scenario
category**, not hardcoded per-scenario (`decision-policy.js`'s
`EVIDENCE_REQUEST_ACTION_BY_CATEGORY`), so new scenarios automatically get
sensible behavior without declaring it themselves — same design principle as
Module 2's category-driven ticket tagging.

## Every Decision includes

- `action`, `scenarioId`, `confidence` — what was decided and about what
- `explanation` — a dynamic, numbers-citing engineering explanation (e.g.
  `"login_token_expired" confidence 0.82 clears the resolution threshold
  (0.6) and has an automatic resolution available.`) — **not** customer-facing
  text; that's the Dialogue Engine's job
- `evaluatedRules` — an ordered trace of every rule considered this turn, up
  to and including the one that matched, each tagged `matched: true/false`
  with a `detail` string. This makes "why this and not something else" fully
  reconstructable from the Decision object alone
- `timestamp` — ISO-8601, via an injectable `clock` parameter (defaults to
  real time; tests supply a fixed clock for determinism)
- `targetQuestion` / `resolution` / `ticketDraft` — populated only for the
  actions that need them, `null` otherwise

## DecisionState — the engine's own memory

Separate from Module 3's evidence memory. Tracks: which question ids have
been asked (never re-asked), whether supplementary evidence / account
details / verification have each been requested once (one-shot gates), a
consecutive-no-progress counter, and a full decision history. This state is
plain-JSON-serializable (tested) and is what a later Action Layer would
persist into `chat_sessions.bot_state` alongside Module 3's `DiagnosticState`.

## Isolation

Zero I/O — no providers, no Supabase, no async at all except the injectable
clock. Not wired into `chat-logic.js`/`chatbot-engine.js`. WhatsApp untouched.

## Running the tests

```bash
node --test decision/tests/decision-types.test.mjs decision/tests/decision-engine.test.mjs decision/tests/decision-engine.e2e.test.mjs
```

See `tests/README.md` for details.
