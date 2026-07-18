# Observability, Review Center & Validation Lab — Module 9

The final module in the roadmap: turns every turn's reasoning into an
inspectable trace, surfaces the conversations that need a human's attention,
and gives staff a safe way to edit Scenario/Knowledge content and prove an
edit is safe *before* it ever reaches a customer.

Four sub-capabilities, matching the approved architecture exactly:

| # | Capability | What it does |
|---|---|---|
| 9a | Reasoning Trace Logging | Records the full per-turn trace (evidence → ranking → decision → rendered reply) |
| 9b | Learning Queue | Surfaces low-confidence / FALLBACK / unresolved-escalation entries — a **filter over the trace log**, not separate storage |
| 9c | Simulation & Validation Workspace | Replay Engine, Comparison Engine, Regression Suite Runner (Shadow Run), Publish Gate, and the two admin UIs |
| 9d | Analytics & Feedback | Out of scope for this pass — see "Remaining work" |

## Files

| File | Responsibility |
|---|---|
| `trace-types.js` | The `TraceEvent` shape + a lightweight internal sanity guard |
| `trace-logger.js` | `buildTraceEvent()` (9a) + `learningQueueReason()`/`filterLearningQueue()` (9b) — both pure, no I/O |
| `observability-read-port.js` / `.stub.js` | The **one read path** in the whole engine: historical `chat_messages`, for replay only. Stub only, no live Supabase reads in this module |
| `observability-read-port.supabase.js` | Real, thin implementation — never invoked by any test |
| `replay-engine.js` | Replays a stored conversation through Modules 1–7 **unchanged**, capturing a trace at every turn |
| `comparison-engine.js` | Pure before/after diff between two replay results — no policy judgment |
| `validation-policy.js` | Turns a diff into a pass/fail `ValidationVerdict` — the actual regression policy |
| `shadow-run-engine.js` | Runs Replay + Comparison + Policy across a whole set of stored conversations |
| `publish-gate.js` | Pure `draft → validated → published/rejected` state machine + the actual publish-or-block decision |
| `admin-ui/review-center.html` | Learning Queue + seven-step trace inspector + diagnosis correction (Arabic, RTL) |
| `admin-ui/validation-lab.html` | Simulation / Shadow Run / Publish Gate workspace (Arabic, RTL) |
| `migrations/0001_add_chat_engine_observability_and_review_center.sql` | Every table, view, and function this module (and Modules 2/7's storage swap) depends on |

Plus, delivered alongside this module (see "Storage-backend swap" below):
`scenarios/scenario-catalog.supabase.js` (Module 2), `knowledge/static-
knowledge.supabase.js` (Module 7), and eight new write functions added to
Module 8's `action/action-layer.js` and `action/supabase-port.js`.

## Why replay needed zero engine code changes

Every module from 1 through 7 already takes its dependencies (scenario
catalog, knowledge providers, glossary, etc.) as injected parameters — that
provider-injection pattern was built in from Module 1 onward, not added for
this. `replay-engine.js` is pure orchestration over the exact same
`normalize()` / `processTurn()` / `rankHypotheses()` / `decide()` /
`composeAnswerDecision()` / `renderDecision()` functions every other module
already exports. "Before" is simply the default (currently-published)
providers; "after" is the same functions called with an alternate provider
wrapping an admin's draft edit. No engine file was touched to make this
work.

## The Learning Queue is a filter, not a table

`filterLearningQueue()` in `trace-logger.js` and the `chat_engine_learning_
queue` SQL view implement the **exact same three conditions**, deliberately
kept in sync:

1. the decision's action is `FALLBACK`, or
2. the action is `ESCALATE_TO_HUMAN` for a `null`/`"unknown"` scenario, or
3. confidence is below `0.2` (`LOW_CONFIDENCE_THRESHOLD`).

If the JS and the SQL view ever need to diverge, the JS function — the one
every test in this project actually runs against — is the source of truth
to fix the view against, not the other way around.

## Regression policy: broader than the literal spec, on purpose

The approved default policy is stated as "fail if action degrades from
ANSWER/COMPLETE toward FALLBACK/ESCALATE_TO_HUMAN." Implementing that
literally missed a real case caught while testing this module: a
`CREATE_TICKET` or `ASK_FOR_LOGS` regressing to `FALLBACK` is just as real a
regression (the engine used to make progress on a technical issue; now it
can't even classify it) but isn't an ANSWER/COMPLETE origin. `validation-
policy.js`'s `DEFAULT_POLICY` therefore flags **any** transition into a
degrading action (`FALLBACK`/`ESCALATE_TO_HUMAN`) from a non-degrading one —
a strict superset of the literal wording, still exactly matching it for the
flagship ANSWER/COMPLETE case. `shadow-run-engine.e2e.test.mjs` has a test
that would have passed under the narrower, literal policy and correctly
fails under this one — worth reading if you're tuning the policy further.

## Publish Gate

`publish-gate.js`'s `decidePublishability()` is the one function that
decides whether a `validated` draft may become `published`:

- **Verdict passed** → allowed, no override needed.
- **Verdict failed (or missing entirely)** → blocked, unless a non-empty
  `overrideReason` is supplied — which is then logged to
  `chat_engine_publish_overrides` for audit (via `action-layer.js`'s
  `publishScenarioVersion`/`publishKnowledgeVersion`, whose `overrideReason`
  param maps straight into the RPC).

This module only decides; `action-layer.js` is what actually performs the
write, keeping Action Layer the sole writer even here.

## Action Layer is still the sole writer

Trace logging, conversation reviews, Scenario/Knowledge drafts, validation
runs, and publishing all need writes — and per the Module 8 architecture,
Action Layer remains the *only* file that calls a database port. So this
module added 8 new methods to `action/supabase-port.js` and 8 new exported
functions to `action/action-layer.js` (`logTraceEvent`,
`flagConversationForReview`, `updateConversationReviewStatus`,
`saveScenarioDraft`, `saveKnowledgeDraft`, `recordValidationRun`,
`publishScenarioVersion`, `publishKnowledgeVersion`) rather than adding any
write capability inside `observability/` itself. Every one of them follows
the exact same "one port call → one ActionResult, never assume success"
posture as the original two.

## Storage-backend swap (Modules 2 & 7)

Delivered as part of this module's migration, since the tables they read
from (`chat_engine_scenarios`, `chat_engine_knowledge_entries`) are defined
here: `scenario-catalog.supabase.js` and `knowledge/static-knowledge.
supabase.js` implement the exact same provider factory
(`createScenarioCatalogProvider(loadFn)` / `createStaticKnowledgeProvider
(loadFn)`) their local-JSON siblings already used — only the `loadFn`
changed, to a Supabase query for `status='published'` rows. An
architectural-proof test in each module's test suite confirms a real
consuming function (`answer-composer.js`'s `composeAnswerDecision`, and the
diagnostic/ranking pipeline for scenarios) produces byte-identical results
regardless of which backend is wired in.

## One new read path, clearly scoped

Replay needs to read historical `chat_messages`. This is different from the
Action Layer (write-only) and from Module 3's live-evidence provider
(per-customer *live* lookups during an in-progress conversation) — so it's
its own narrow, read-only capability (`observability-read-port.js`) living
inside `observability/`, not inside `action/`. This keeps "Action Layer is
the only writer" intact while being explicit that this is the only module
with any Supabase read access to historical data.

## The admin UIs

Both are real, hand-built single-file HTML/CSS/JS — no framework, no build
step — in Arabic with a right-to-left layout, matching the engine's primary
language. They render with realistic **demo fixture data** (clearly flagged
in-page: "بيانات تجريبية — غير متصلة بقاعدة بيانات حقيقية") because no
authenticated browser session or live Supabase connection exists in this
environment. Every write action they trigger (saving a review, publishing a
draft) is commented inline with the exact real function it would call
(`updateConversationReviewStatus(...)`, `publishKnowledgeVersion(...)`) —
wiring them to the real backend means replacing the fixture arrays with real
`fetch`/RPC calls, not restructuring the UI.

**Review Center** (`review-center.html`): the Learning Queue as a table,
click through to a seven-step trace inspector (a connected "spine," one node
per engine module — Language → Scenario → Diagnostic → Ranking → Decision →
Knowledge → Dialogue), a diagnosis-correction form, and review-status
controls.

**Validation Lab** (`validation-lab.html`): three tabs — Simulation (single
conversation, before/after side by side), Shadow Run (batch regression
results with a pass/fail summary), and Publish Gate (blocked/unblocked
state with a mandatory-reason override flow).

## Isolation

- Not wired into `chat-logic.js` / `chatbot-engine.js`. Nothing in the live
  chat changed.
- WhatsApp-owned code and tables untouched; the migration is entirely
  additive (new tables/view/functions only).
- Zero live database writes or reads in any test — every test uses either
  pure fixtures, the mock Supabase port (Module 8's), or the shared mock
  Supabase query client (`scenarios/tests/helpers/mock-supabase-query-
  client.js`, reused across module boundaries the same way Module 7 already
  did for its own Supabase-provider tests).
- Admin UIs are real but unauthenticated/unexercised in a live browser —
  verified by structural checks (balanced tags, script presence), not a
  running session.

## Remaining work before production integration

- Wire `chat-logic.js`/`chatbot-engine.js` to actually call the full
  pipeline (Modules 1–9) for real customer traffic — nothing built across
  Modules 1–9 is live yet.
- First real browser sign-in to Review Center / Validation Lab, to replace
  the fixture arrays with real `fetch`/RPC calls and validate the auth flow.
- Apply the migration to a real Supabase project; this environment has no
  network access to verify it against a live database.
- Analytics & Feedback (9d — aggregate metrics, satisfaction tracking) was
  scoped out of this pass; the trace log (9a) already has everything needed
  to build it later without new storage.
- Populate `chat_engine_scenarios`/`chat_engine_knowledge_entries` with
  published rows — the engine still runs on local JSON until a first
  migration is performed via the Review Center.

## Running the tests

```bash
node --test observability/tests/*.test.mjs
```

See `tests/README.md` for the full breakdown of what each test file covers.
