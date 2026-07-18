# Decision Engine — Test Suite

49 tests total, Node's built-in test runner, no external dependencies.

## Running

```bash
node --test decision/tests/decision-types.test.mjs decision/tests/decision-engine.test.mjs decision/tests/decision-engine.e2e.test.mjs
```

(Use explicit file paths or `tests/*.test.mjs`, not `tests/**/*.test.mjs` —
see the note on shell globbing in the Ranking Engine's test README, which
applies identically here.)

## What's covered

| File | Covers |
|---|---|
| `decision-types.test.mjs` | `ACTIONS` enum completeness and immutability, `checkDecisionShape` validation for every required field (`confidence`, `explanation`, `evaluatedRules`, `timestamp`, `turn`), `createEmptyDecisionState` defaults |
| `decision-engine.test.mjs` | Every rule branch (R0–R8) individually, in isolation, with hand-built fake rankings — including the `evaluatedRules` trace itself, clock injection (fixed vs. real time), and `DecisionState` bookkeeping (question budget, one-shot gates, immutability, JSON round-trip) |
| `decision-engine.e2e.test.mjs` | Four realistic multi-turn journeys through **all four upstream modules for real**: strong evidence → `ANSWER` → silence → `COMPLETE`; ambiguity → targeted question → confirming answer → resolved, never re-asking; confident technical diagnosis → `ASK_FOR_LOGS` once → `CREATE_TICKET`; and a full-session JSON-safety check |

## Why the end-to-end numbers are empirically captured

Before writing the Journey A/B/C assertions, each pipeline was run
interactively to confirm actual confidence values and category assignments
(e.g. `"Token expired, Error 401"` → `login_token_expired` at exactly 0.600;
`"الـ API مش شغال"` → `api_integration_issue` at exactly 0.600, category
`api`; the subscription ambiguity resolving from `0.229/0.160` to
`0.514/0.160` after a confirming answer). This is the same discipline
established in Modules 3 and 4 after an earlier hand-calculation mistake —
verify first, assert what's actually true, not what's assumed.

## What `evaluatedRules` buys you

Every test that reaches a specific action also implicitly exercises the
rules that were checked and rejected before it — `decide: evaluatedRules
trace records every rule checked...` asserts the exact rule sequence for one
case explicitly, but any test can inspect `decision.evaluatedRules` to see
precisely which conditions were true/false that turn. This is the mechanism
that makes the Decision Engine's output audit-ready without needing to trust
a single free-text explanation string.
