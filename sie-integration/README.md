# SIE Integration Layer (Adapter / Bridge)

This folder is the **only** place that wires the frozen engine under `/sie`
into Mad3oom's live chat widget and Supabase project. Nothing in `/sie` is
modified to make this work — every file in here is new, and it depends on
`/sie`'s public exports only (never the other way around).

```
Frozen /sie (Modules 1-9)
        ↓ imported by
sie-integration/  (this folder)
        ↓ imported by
assets/js/chat-logic.js  (one small, additive hook — see "Chat widget hook" below)
        ↓
Supabase (existing chat_messages / chat_sessions / chat_engine_* tables,
          plus the new customer_sie_access table — see the DB design doc)
```

## Files

| File | Responsibility |
|---|---|
| `sie-entitlement.js` | Thin client for the `customer_sie_access` table: "is this user SIE-enabled right now, and do they have quota left?" Used by both the chat bridge (to gate/consume a turn) and the admin panel (read-only status display uses the same source of truth). |
| `sie-chat-bridge.js` | The actual orchestrator: wires Language → Scenarios → Diagnostics → Ranking → Decision → Knowledge → Dialogue → Action for one customer turn, in the exact call order the `/sie` READMEs describe. Exposes `getSieReply()` with the **same input/output shape as `chatbot-engine.js`'s `getBotReply()`**, so the widget only needs one small branch, not a rewrite. |

## Why not touch "Chatbot Modes" / its `SIE` placeholder

Per the integration brief, `assets/js/chatbot-mode-service.js`'s `CHATBOT_MODES.SIE`
entry is a separate, unrelated, not-yet-built placeholder and must not be used
here. Frozen-SIE access is therefore modeled as its own concept
(`customer_sie_access`, admin-granted, independent of the customer's own
chatbot-mode preference) rather than being wired into that placeholder. See
the chat widget hook below for exactly how the two coexist without
conflicting.

## Chat widget hook

`chat-logic.js`'s `sendCustomerMessage()` already calls `getBotReply()` once
per customer message and then inserts the returned text into `chat_messages`
itself. The hook added there is:

1. Before calling `getBotReply()`, ask `sie-entitlement.js` whether this
   customer currently has SIE access (enabled, not expired, quota remaining).
2. If yes, call `getSieReply()` instead. It returns `{ reply, options,
   alreadyPersisted: true }` — `alreadyPersisted` because the frozen Action
   Layer already wrote the bot's message + session state atomically via
   `persist_bot_turn` / `create_ticket_with_message_and_session_update`
   (the same RPCs the frozen module's own `supabase-port.supabase.js`
   targets). `chat-logic.js` skips its own `chat_messages.insert(...)` step
   in that case, to avoid a double-write.
3. If no (not enabled, expired, or quota exhausted), or if `getSieReply()`
   itself reports a hard failure, `chat-logic.js` falls back to the existing
   `getBotReply()` exactly as before. This is what satisfies "stop SIE
   responses automatically... preserve conversation history" — the customer
   keeps chatting with the same widget and the same session, just answered
   by the traditional local engine instead, rather than getting no reply at
   all. **This fallback choice is an assumption on my part — flag it if you
   intended something else (e.g. a static "this feature is currently
   unavailable" message instead of falling back to the traditional bot).**

## What still depends on the DB design being approved

Both files here call RPCs that don't exist yet (`is_sie_admin`,
`sie_consume_message`, `sie_admin_set_access`, `sie_admin_reset_usage`) —
see the DB design in the main report. The code is written against that
design now so it's ready to go the moment it's applied; until then, calls
will fail closed (entitlement check returns "not enabled"), which safely
falls back to the traditional bot rather than breaking the widget.
