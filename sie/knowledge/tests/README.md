# Knowledge Layer — Test Suite

57 tests total, Node's built-in test runner, no external dependencies.

## Running

```bash
node --test knowledge/tests/*.test.mjs
```

(Use explicit file paths or `tests/*.test.mjs`, not `tests/**/*.test.mjs` —
see the note on shell globbing in the Ranking Engine's test README, which
applies identically here.)

## What's covered

| File | Covers |
|---|---|
| `knowledge-types.test.mjs` | `validateStaticKnowledgeEntry`/`validateStaticKnowledgeEntries` (missing fields, empty strings, duplicate keys, non-array input), `checkLiveKnowledgeResultShape` (malformed `available`/`data`) |
| `static-knowledge-provider.test.mjs` | Cache-after-first-load (including concurrent calls before the first resolution), invalid-entry skipping, duplicate-key handling, `getEntryByKey` miss/hit, non-array loader result degrading to an empty set |
| `static-knowledge.test.mjs` | The real shipped `content.json`: zero validation warnings, `platform_info`/`pricing` present with non-empty bilingual text, a live-only key (`ticket_status`) correctly absent |
| `live-knowledge-provider.test.mjs` | Pass-through of a well-formed result, context forwarding, degrade-to-unavailable on a thrown error or a malformed/null return, the stub's always-unavailable behavior across sources |
| `answer-composer.test.mjs` | The core resolution logic in isolation with fake providers: non-ANSWER/no-`knowledgeSource` pass-through (same reference, no new object), static hit, immutability, static-before-live priority, live hit when static misses, no live attempt without a `liveKnowledgeContext`, live-unavailable pass-through, unknown-source pass-through, real-content resolution, JSON round-trip |
| `knowledge-engine.e2e.test.mjs` | Full real pipeline (Language → Scenario → Diagnostic → Ranking → Decision → **Knowledge** → Dialogue) for all four current `knowledgeSource` scenarios: pricing and platform info via static content, ticket status and subscription status via a fake live provider, the live-unavailable fallback path rendering the scenario's own fallback text, a technical (non-knowledge) ANSWER passing through untouched, and an end-to-end JSON-safety check |
| `static-knowledge-supabase.test.mjs` | The Module 9 storage-backend swap: `createStaticKnowledgeSupabaseProvider()` against a mock query client — published-only rows, latest-version-per-key selection, archived-row exclusion, query-error resilience, the existing validation layer still excluding malformed entries — plus an **architectural-proof** test confirming `composeAnswerDecision()` produces byte-identical `knowledgeData` whether static knowledge comes from local JSON or Supabase |

## Why the end-to-end numbers are empirically captured

Before writing the `knowledge-engine.e2e.test.mjs` assertions, each message
was run through the real pipeline to confirm the actual scenario, confidence,
and `knowledgeSource` it resolves to (e.g. `"عايز اعرف اسعار خطط باقات بكام
عروض ايه"` → `pricing_inquiry` at 0.8; the ticket-status probe needed all
four of its evidence tokens present to clear the 0.6 resolution threshold,
since plain Arabic-word evidence carries weight 0.8 per observation, not
1.0). Same discipline established in Modules 3–6 — verify first, assert what's
actually true, not what's assumed. Also worth noting for anyone writing more
of these: a leading Arabic definite article (`ال`) fused onto a word with no
space (e.g. `الاسعار`) tokenizes as one token distinct from the bare
evidence token (`اسعار`) and won't match — the same known Module 1/3
tokenization gap documented in `diagnostics/README.md`, not anything new here.

## Fetch-vs-fs in test helpers

`static-knowledge.local.js` (like every other `*.local.js` provider in this
project) loads its data with `fetch(new URL(...))`, which does not work
under Node's plain test runner in this environment (there's no bundler
resolving `import.meta.url`-relative `fetch` calls to a readable resource).
Every test in this suite that needs real content therefore goes through
`helpers/node-providers.js`'s `createRealStaticKnowledgeProvider()` (an
`fs.readFileSync`-backed equivalent), never through the `.local.js` default
directly — the same convention already established by every other module's
tests (e.g. Ranking Engine's tests always inject an explicit
`scenarioProvider` rather than relying on `rankDiagnosticState`'s default).
