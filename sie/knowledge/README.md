# Knowledge Layer — Module 7

Completes ANSWER decisions that need real data instead of fixed text: static
content (pricing, platform info) and, once wired to real data later,
per-customer live data (ticket status, subscription status). Adds exactly one
integration point to the pipeline — `composeAnswerDecision()`, which sits
between the Decision Engine (Module 5) and the Dialogue Engine (Module 6).
Neither of those modules needed to change: the composer takes a `Decision`
and returns a `Decision`, same shape in, one additive field out.

## Files

| File | Responsibility |
|---|---|
| `knowledge-types.js` | Shapes for `StaticKnowledgeEntry` and `LiveKnowledgeResult`, plus validation (content-authoring guard for static entries, lightweight sanity guard for live results) |
| `static-knowledge.provider.js` | Provider INTERFACE for static content — same cache/validate-and-skip pattern as Module 2's `scenario-catalog.provider.js` |
| `static-knowledge.local.js` | Local-JSON-backed implementation, reading `static-knowledge.data/content.json` |
| `static-knowledge.data/content.json` | The actual static content: `platform_info`, `pricing` |
| `live-knowledge.provider.js` / `.stub.js` | Interface for per-customer live data (tickets, subscriptions) — **stub only, no real Supabase calls in this module**, same posture as Module 3's `live-evidence-provider.js` |
| `answer-composer.js` | `composeAnswerDecision()` — the one new pipeline function |

## Why static knowledge didn't need new infrastructure

A scenario whose resolution declares a `knowledgeSource` (Module 2's
additive `resolution.knowledgeSource` field) is still, mechanically, just
another auto-resolving scenario going through the exact same
Scenario → Diagnostic → Ranking → Decision pipeline as every other one.
Nothing in Modules 3, 4, or 5 changed to support this. The only genuinely new
work is: (1) a place to store and look up the *real* content behind a
`knowledgeSource` key, and (2) the one function that fetches it and attaches
it to the decision before Dialogue renders it.

## How `composeAnswerDecision()` resolves a `knowledgeSource`

1. **Static first.** Look up the key in the static knowledge provider. This
   is cheap (cached, not customer-specific) and checked first regardless of
   the key's "intended" nature — a key never has to be pre-classified as
   static or live anywhere in code.
2. **Live second**, only if nothing static matched *and* a
   `liveKnowledgeContext` (i.e. a known `userId`) was supplied. An
   unauthenticated/unidentified session simply never attempts a live lookup.
3. **Neither found → unchanged.** The composer never invents fallback text.
   The Dialogue Engine's ANSWER template already falls back to
   `resolution.text` (the scenario's own "couldn't find that right now"
   copy, written by Module 2) whenever `decision.knowledgeData` is absent —
   so an unavailable live provider (the stub, always) degrades gracefully
   with zero special-casing here.

```
decision.knowledgeData = { source: knowledgeSource, data: <static text passthrough | live data> }
```

`data` for a static hit is `{ text: { ar, en } }` — the same bilingual-text
shape used everywhere else, so the Dialogue Engine's generic formatter can
render it without knowing it came from Module 7 rather than Module 2. `data`
for a live hit is source-specific (see `knowledge-formatters.js` in Module 6
for the two currently-consumed shapes) and was defined by Module 6 ahead of
this module being built — this module's job was to match that existing
contract exactly, not design a new one.

## Isolation

- No Supabase calls. `live-knowledge.stub.js` always reports every source
  `unavailable`; scenarios whose `knowledgeSource` is a live one (currently
  `ticket_status`, `subscription_status`) simply fall back to their static
  `resolution.text` until a future integration task wires in real queries.
- Not wired into `chat-logic.js` / `chatbot-engine.js`. Nothing in the live
  chat changed.
- `composeAnswerDecision()` is a pure async function over its inputs — no
  module-level state, no caching beyond what the injected static provider
  already does internally. Its output round-trips through JSON (verified by
  a test), so it can be dropped straight into the pipeline between Decision
  and Dialogue without any transformation.

## Storage-backend swap (delivered during Module 9)

`static-knowledge.supabase.js` implements the exact same
`createStaticKnowledgeProvider(loadFn)` contract as `static-knowledge.
local.js` — only the `loadFn` changed, to a query against
`chat_engine_knowledge_entries` (`status='published'`, latest version per
key). `answer-composer.js` and everything downstream is completely
unaware which backend is wired in. An architectural-proof test
(`tests/static-knowledge-supabase.test.mjs`) confirms `composeAnswerDecision
()` produces byte-identical `knowledgeData` regardless of backend. See
`observability/README.md`'s "Storage-backend swap" section for the fuller
picture (this and Module 2's equivalent swap were delivered together,
alongside the migration that creates the tables both read from).

## Running the tests

```bash
node --test knowledge/tests/
```

See `tests/README.md` for the full breakdown of what each test file covers.
