# Dialogue Engine — Module 6

The presentation layer, and nothing else. Renders one `Decision` (Module 5)
into `{ text, options }` — the exact shape `chat-logic.js`'s
`renderQuickOptions()` already expects. Contains zero decision-making,
zero diagnosis, zero ranking.

## Files

| File | Responsibility |
|---|---|
| `templates/ar.js` | Arabic phrasing, one function per action |
| `templates/en.js` | English phrasing, structurally identical to `ar.js` |
| `dialogue-renderer.js` | Picks the right template function for the decision's action + given language, calls it, degrades safely if anything is malformed |

## Design

Each template function takes a `Decision` and returns `{ text, options }`
using **only** data already present on the Decision — `resolution.text`,
`targetQuestion.prompt`/`.options`, `scenarioLabel`. No template re-derives
anything or makes a choice; the choice was already made by Module 5. This is
what keeps the module honestly presentation-only rather than "Decision
Engine's logic, just written differently."

`renderDecision(decision, language)`:
- Defaults to Arabic for a missing/unrecognized `language` value.
- Falls back to a generic, safe message (in the requested language) if the
  action is unrecognized, the decision is malformed, or a template throws —
  this sits directly in the customer-facing path, so it must never throw
  itself, no matter what it's handed.

## The one Module 5 change this module needed

To phrase `VERIFY_INFORMATION` (*"just to confirm, you're describing X"*)
and similar, Dialogue needed to know which scenario a decision concerns in
human terms, not just its id. Module 5's `Decision` now carries
`scenarioLabel: {ar, en} | null` — forwarded from scenario data Module 5
already had in scope (`topHypothesis.scenario.label`), not new decision
logic. Module 5's full test suite was re-run (and 3 new tests added
specifically for this field) before starting this module, confirming zero
regressions.

## Isolation

No I/O, no state. Not wired into `chat-logic.js`/`chatbot-engine.js`.
WhatsApp untouched.

## Running the tests

```bash
node --test dialogue/tests/templates.test.mjs dialogue/tests/dialogue-renderer.test.mjs dialogue/tests/dialogue-engine.e2e.test.mjs
```
