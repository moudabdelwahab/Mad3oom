# Action Layer — Module 8

The sole writer. `action-layer.js` is the only file in the whole engine that
calls a database port — every other module (1–7, and later 9) remains
exactly as storage-agnostic as it already was; none of them import or
reference this module.

> **Extended during Module 9** (Observability / Review Center / Validation
> Lab): trace logging, conversation review, Scenario/Knowledge draft
> editing, and gated publishing all need writes, and this module's whole
> point is being the *only* place those happen — so `supabase-port.js` grew
> from 2 to 10 methods and `action-layer.js` grew 8 new exported functions
> (`logTraceEvent`, `flagConversationForReview`,
> `updateConversationReviewStatus`, `saveScenarioDraft`,
> `saveKnowledgeDraft`, `recordValidationRun`, `publishScenarioVersion`,
> `publishKnowledgeVersion`). Everything below describes the original 2;
> the extension follows the identical pattern for the other 8 — see
> `observability/README.md`'s "Action Layer is still the sole writer"
> section, and `observability/tests/action-layer-observability-writers.
> test.mjs` for their tests (kept there since they were added during that
> module's work, even though they live in this file).

## Files

| File | Responsibility |
|---|---|
| `action-types.js` | `ActionResult`/`ActionStep` shapes, `buildActionResult()` (the only place success/atomicity flags are computed), `formatTicketDescription()` (folds a ticket's diagnostic trail into plain text) |
| `supabase-port.js` | The narrow port CONTRACT the Action Layer depends on — 10 methods (2 from this module, 8 added during Module 9), not the raw Supabase client |
| `supabase-port.supabase.js` | Real, thin implementation calling the two atomic RPC functions — **never invoked by any test** |
| `action-layer.js` | `executeDecision()` — maps a Decision + its rendered reply to exactly one port call |
| `migrations/0001_add_chat_engine_atomic_write_functions.sql` | The two Postgres RPC functions the real port implementation calls |

## Honest, database-enforced transactionality

Every decision action requires at least one write (persist the bot's
message + update session state; ticket actions add a third write). Rather
than stitching multiple independent writes together client-side and hoping
nothing fails halfway, each action maps to exactly **one** port call → one
Postgres RPC → one transaction:

- `persistBotTurn` → the `persist_bot_turn` RPC — inserts into
  `chat_messages` and updates `chat_sessions.bot_state` atomically.
- `createTicketWithMessageAndSessionUpdate` → the
  `create_ticket_with_message_and_session_update` RPC — inserts the ticket,
  inserts the bot's message, and updates session state atomically, returning
  the generated ticket number.

`ActionResult.atomicityGuaranteed` / `.requiresFuturePostgresRPC` are
**computed from the actual step count** in `buildActionResult()`, never
hardcoded — so if a future action ever genuinely needed more than one
independent write again, these flags would honestly flip back rather than
silently claiming a guarantee that no longer holds.

## No new DB columns

The ticket diagnostic trail (which scenarios were considered, at what
confidence, with what status) is folded into the existing `tickets.
description` field as formatted text (`formatTicketDescription()`), together
with the Decision Engine's own audit `explanation` — avoiding any schema
change beyond the two RPC functions.

## Narrow port, not the raw Supabase builder

`action-layer.js` depends on `SupabasePort` — 10 named async methods
(`supabase-port.js`) — rather than the full chainable Supabase client, which
is hard to mock faithfully and far wider than this layer actually needs.
`createSupabasePort()` validates at wiring time that an implementation has
every method, so a typo fails loudly immediately rather than as a confusing
runtime error mid-conversation. A real implementation
(`supabase-port.supabase.js`) exists and is reviewable, but is never invoked
by any test — only `tests/helpers/mock-supabase-port.js` (an in-memory fake)
is, per the same "no live database writes in any test" posture as every
other module's live/real-backend providers.

## The Decision Engine never assumes success — by construction

Module 5 (`decision-engine.js`) has zero knowledge this module exists: it
doesn't call it, import it, or reference `ActionResult` anywhere. This
requirement is satisfied structurally, not by adding a check inside Module
5 — proven by `action-layer.e2e.test.mjs`, where a real Decision reaches
`ANSWER` exactly as before even while the simulated write underneath it
fails. Whatever future orchestrator wires Decision → Dialogue → Action must
inspect `ActionResult.success` itself; nothing upstream will do it for that
orchestrator.

## Isolation

- Not wired into `chat-logic.js` / `chatbot-engine.js`. Nothing in the live
  chat changed — no customer traffic goes through this module yet.
- WhatsApp-owned code and tables are untouched; only the two new RPC
  functions were added, and only as a migration file here (not applied to
  any live database from this environment).
- Zero live database writes in any test — `mock-supabase-port.js` is a pure
  in-memory fake.

## Remaining work before production integration

- Confirm the real `chat_messages` / `chat_sessions` / `tickets` column
  names against the live schema — the names used in
  `supabase-port.supabase.js` and the migration are inferred from the
  approved architecture description (this project doesn't have access to
  the existing `chatbot-engine.js` source to confirm verbatim), not copied
  from a verified source.
- Apply the migration to a real Supabase project and confirm RLS behavior
  end to end (this environment has no network access to Supabase).
- Wire a real orchestrator that calls `decide()` → `renderDecision()` →
  `executeDecision()` in sequence and actually inspects `ActionResult.
  success` — this module only makes that inspection possible, it doesn't
  perform it.

## Running the tests

```bash
node --test action/tests/*.test.mjs
```

See `tests/README.md` for the full breakdown of what each test file covers.
