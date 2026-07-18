# Dialogue Engine — Test Suite

22 tests, Node's built-in test runner, no external dependencies.

## Running

```bash
node --test dialogue/tests/templates.test.mjs dialogue/tests/dialogue-renderer.test.mjs dialogue/tests/dialogue-engine.e2e.test.mjs
```

## What's covered

| File | Covers |
|---|---|
| `templates.test.mjs` | Every one of the 12 actions has a template in both languages; content correctness for `ANSWER`/`ASK_CLARIFYING_QUESTION` (targeted and generic)/`VERIFY_INFORMATION`; the three evidence-request actions produce genuinely distinct text; every option across every template has a valid non-empty `label`/`value` |
| `dialogue-renderer.test.mjs` | Language selection and fallback (missing/unrecognized language → Arabic), and — since this is the customer-facing path — resilience: a `null` decision, an unrecognized action, and a template that throws on a malformed decision all degrade to a safe message rather than propagating an error |
| `dialogue-engine.e2e.test.mjs` | Full six-module pipeline (Language → Scenario → Diagnostic → Ranking → Decision → Dialogue) on real text, checking the final rendered output is correct and JSON-safe |

## Why this suite is smaller than prior modules

There's genuinely less to test: no thresholds, no scoring, no state
transitions — just "does this template produce sensible, safe output for
its action." The bulk of meaningful behavior (which action, why, with what
data) was already locked down by Module 5's 52 tests; this suite mostly
confirms rendering doesn't lose or corrupt anything on the way to text.
