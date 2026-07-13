# منصة مدعوم — Website Chat Engine → Support Intelligence Engine
## Diagnostic-Centered Architecture — v1.1 (CANONICAL — FROZEN)

**Changelog:** v1.1 — added §14 Versioning Strategy and §15 Performance Budget (additive per §11.1/§14.1, no contract or dependency-graph changes; renumbered trailing sections accordingly). v1.0 — initial approved & frozen architecture.

**Scope:** Website Chat Engine only (`chat.html` / `chat.js` / `chatbot-engine.js` + related Supabase tables).
**Explicitly out of scope:** WhatsApp bot (`whatsapp-webhook`, `bot_user_states`, `flow_templates`, `flow_analytics_events`, `wf_*` workflow tables). Not analyzed, not touched, not referenced beyond this line.
**Status:** ✅ **APPROVED & FROZEN — Canonical specification of the Mad3oom Support Intelligence Engine (SIE).**
Architectural redesign of any approved module is out of bounds unless explicitly requested. All future work is implementation, validation, and production integration against this document — every new feature is an extension of it (via §10's extension points), never a replacement of it. Any proposed change is first checked against §11; anything beyond a clearly additive/compatible change is not made without coming back to this spec.
Canonical Modules

1. Normalization Layer
2. Scenario Engine
3. Diagnostic Engine
4. Ranking Engine
5. Decision Engine
6. Dialogue Engine
7. Knowledge Module
8. Action Layer
9. Observability
---

## 1. Supabase Audit — What Already Exists

Project `srnelrdpqkcntbgudyto` (`info@mad3oom.online's Project`) was inspected directly (106 tables in `public`). Key finding: **the database already has scaffolding for exactly this redesign**, seemingly prepared in advance but never wired up (all at 0 rows):

| Table | Purpose (inferred from columns) | Status |
|---|---|---|
| `chat_engine_scenarios` | `scenario_key`, `version`, `status`, `definition (jsonb)`, `published_at` | Empty, unused — **this is the Scenario Engine's storage** |
| `chat_engine_knowledge_entries` | `knowledge_key`, `version`, `status`, `content (jsonb)`, `published_at` | Empty, unused — versioned FAQ/knowledge store |
| `chat_engine_trace_events` | `session_id`, `turn`, `normalized_tokens`, `hypotheses`, `ranking`, `decision`, `knowledge_data`, `rendered`, `action_result`, `processing_time_ms` | Empty, unused — **this is a per-turn diagnostic trace table whose columns map 1:1 onto Scenario → Diagnostic → Ranking → Decision → Dialogue** |
| `chat_engine_validation_runs` | `run_type`, `before_version`, `after_version`, `conversation_count`, `pass_fail`, `publish_recommendation` | Empty, unused — safe rollout/regression testing for scenario or knowledge changes |
| `chat_engine_publish_overrides` | links to a validation run, `overridden_by`, `reason` | Empty, unused — manual override to publish despite a failed validation |
| `chat_engine_conversation_reviews` | `session_id`, `status`, `corrected_scenario_id`, `reviewed_by`, `notes` | Empty, unused — human-in-the-loop correction of a diagnosis (feedback loop) |

A Postgres function `public.is_chat_engine_staff()` already exists and gates all of the above via RLS (`admin`, `support`, `super_user`, or `is_main_admin()` via the two mad3oom support emails). This means the security model for the new engine is **already deployed** — nothing to add there.

This document's architecture is designed to populate and use these six tables as the system of record. **No schema changes are proposed for them.**

### 1.1 Tables the new engine will read/write (already exist, in active use)

| Table | Rows | Role |
|---|---|---|
| `chat_sessions` | 24 | Session/context container. `bot_state (jsonb)` currently holds the linear-flow state (`{flow, ticket_draft}`); will be repurposed to hold diagnostic state (§4.2). `is_manual_mode` already exists as the human-takeover switch. |
| `chat_messages` | 264 | Raw conversation log. Input to normalization. Already has `image_url`/`audio_url` for attachments. |
| `tickets`, `ticket_replies`, `ticket_attachments`, `ticket_activity`, `ticket_tags`/`ticket_tag_links`, `ticket_ratings` | 12 / 2 / 1 / 46 / 4+2 / 1 | The action target when diagnosis concludes "needs a ticket." Full activity/audit trail already modeled. |
| `customer_notes` | 0 | Admin-authored notes per customer — usable as prior evidence for the Diagnostic Engine ("this customer has had 2 WhatsApp disconnect issues before"). |
| `suggested_questions`, `canned_responses` | 0 / 0 | Existing but unused content sources that should feed the Knowledge module instead of being duplicated in code. |
| `memory_firewall_rules` | 0 | Admin-defined guardrails (`rule_type`, `rule_value`, `is_active`) — natural home for the Decision Engine's safety checks (what must never be said/promised/leaked). |
| `rules_engine` | 0 | Generic `trigger_event` / `conditions (jsonb)` / `actions (jsonb)` automation table — candidate for post-diagnosis automations (auto-tag, auto-assign, notify) instead of hardcoding these in the Decision Engine. |
| `feature_flags` | 2 | Can gate the phased rollout described in §6 without a deploy. |
| `profiles` | 10 | `role` (`admin`/`support`/`super_user`/`customer`), `super_user_id` (sub-account hierarchy). Confirms this chat is مدعوم's own first-party support for its business-owner customers, not a per-tenant embedded widget — so **one global scenario/knowledge library is correct**, no per-tenant scoping needed. |

### 1.2 Audit findings worth flagging (no action taken, decisions needed)

- **`conversations` table (0 rows)** has an overlapping but different shape from `chat_sessions` (`customer_name/phone/email`, `is_outside_work_hours`, `admin_id`) — looks like a legacy or parallel design. Recommend clarifying whether it's dead and safe to ignore, or whether it belongs to another surface. Not used by `chat.js`/`chatbot-engine.js` today, so out of scope for this redesign either way.
- **`chatbot_memory` (0 rows)** overlaps with `chat_engine_trace_events` conceptually (`conversation_id`, `user_message`, `admin_reply`) but pre-dates it and is unused by the current code. Superseded by the trace table — no migration needed, just don't build on it.
- **`bot_settings`** mixes website-chat concerns (`welcome_message`, `ticket_confirmation_message`, `ai_enabled`, `system_prompt`) with WhatsApp-only concerns (`phone_number_id`) in one row. Out of scope to restructure now (touches the WhatsApp bot), but flagged for later cleanup — the new engine should read only the website-relevant columns and not assume `phone_number_id` semantics.
- An edge function `generate-ai-chat-reply` already exists (separate from `chatbot-engine.js`'s local pattern-matching engine) — worth checking with you whether this is currently live for the website chat or dormant, since it would be a natural place to host the Diagnostic Engine's LLM-assisted steps later.

---

## 2. Current Architecture (As-Is)

`chatbot-engine.js` is a **linear, flow-driven state machine**:

```
idle → main_menu → awaiting_problem_category → awaiting_problem_desc
     → awaiting_problem_image → ticket created → main_menu
```

Pattern matching (`normalizeArabic` + `levenshtein` fuzzy match) decides *intent* (greeting / thanks / cancel / menu choice), and a fixed `flow` string in `chat_sessions.bot_state` decides *what question to ask next*. There is no concept of:
- competing hypotheses about what's actually wrong,
- confidence scoring,
- evidence accumulation across turns,
- reuse of prior tickets/notes as context,
- versioned, testable content (scenarios/knowledge are hardcoded JS constants: `PLAN_TEXT`, `CATEGORY_MAP`, `PROBLEM_CATEGORY_OPTIONS`).

This is solid, safe, well-sanitized (XSS-safe, URL-safe) UI/session plumbing — that layer is being **kept**, not replaced. What's being replaced is *what decides the next message*.

---

## 3. Target Architecture — Diagnosis-Centered

**Core principle:** the conversation is not the product; the diagnosis is. Every turn's job is to move a *root-cause probability distribution* forward, not to advance a script. The dialogue is just how that gets asked and answered.

```
User message
   │
   ▼
┌─────────────────────────┐
│ 1. Normalization Layer   │  (existing normalizeArabic/fuzzy-match, promoted to a shared module)
│    text → tokens, intent │
└───────────┬──────────────┘
            │ normalized_tokens
            ▼
┌─────────────────────────┐
│ 2. Scenario Engine       │  reads chat_engine_scenarios (published only)
│    "which known problem  │  matches symptoms/keywords/entities against
│     space(s) apply?"     │  scenario trigger definitions
└───────────┬──────────────┘
            │ activated scenarios + matched/missing evidence
            ▼
┌─────────────────────────┐
│ 3. Diagnostic Engine     │  the brain — builds ranked-candidate root causes
│    "what could actually  │  using: session evidence, chat_messages history,
│     be wrong, and how    │  customer_notes, prior tickets (by user_id),
│     sure are we?"        │  and each scenario's causal model
└───────────┬──────────────┘
            │ hypotheses[] {root_cause, confidence, evidence_for, evidence_missing}
            ▼
┌─────────────────────────┐
│ 4. Ranking Engine        │  orders hypotheses; computes confidence + the
│    "what's most likely,  │  gap to the runner-up; decides if that gap is
│     and how confident?"  │  wide enough to act vs. keep asking
└───────────┬──────────────┘
            │ ranked hypotheses + confidence_gap
            ▼
┌─────────────────────────┐
│ 5. Decision Engine       │  chooses ONE action:
│    "what do we DO about  │   a) ask the next discriminating question
│     it?"                 │   b) answer directly (chat_engine_knowledge_entries)
│                          │   c) create a ticket pre-filled with the diagnosis
│                          │   d) hand off to a human (is_manual_mode)
│  + memory_firewall_rules │  runs safety checks before finalizing
│  + rules_engine          │  triggers any matching post-decision automations
└───────────┬──────────────┘
            │ decision {action, payload}
            ▼
┌─────────────────────────┐
│ 6. Dialogue Engine       │  PRESENTATION ONLY. Turns the decision into
│    (was: the whole bot;  │  Arabic RTL text + quick-reply buttons. No
│     now: just the mouth) │  business logic, no state decisions.
└───────────┬──────────────┘
            │ rendered message + options
            ▼
        chat_messages (+ chat_engine_trace_events row logging every step above)
```

Every turn writes **one row** to `chat_engine_trace_events` covering steps 1–6 (`normalized_tokens`, `hypotheses`, `ranking`, `decision`, `rendered`, `action_result`). This gives full explainability for free — for any past conversation you can see exactly why the bot asked what it asked or concluded what it concluded, using a table that already exists.

### 3.1 Module responsibilities (explicit)

| Module | Owns | Does NOT own |
|---|---|---|
| **Scenario Engine** | Recognizing *which problem domain(s)* a message activates, from versioned, published scenario definitions | Deciding the root cause, deciding what to say |
| **Diagnostic Engine** | Generating and updating hypotheses (candidate root causes) with confidence, using all available evidence (session + customer history) | Ranking/ordering, phrasing, deciding actions |
| **Ranking Engine** | Scoring and ordering hypotheses; deciding if confidence is high enough to stop asking questions | Generating hypotheses, choosing the action |
| **Decision Engine** | Choosing the single next action (ask / answer / ticket / handoff), applying safety rules and automations | Wording, UI, session persistence mechanics |
| **Dialogue Engine** | Rendering the decision as Arabic text + buttons; nothing more | Any judgment about what's true or what to do |
| **Knowledge Module** | Serving factual answers (pricing, platform info, FAQ) from `chat_engine_knowledge_entries`/`suggested_questions`/`canned_responses` when the Decision Engine needs one | Diagnosis of problems |

---

## 4. Data Flow & Memory Model

### 4.1 Evidence, not "answers"

Today, each user reply overwrites the previous flow step. In the new model, every user reply is treated as **evidence** that gets accumulated in session state, so the Diagnostic Engine can revisit or re-weigh earlier evidence instead of only looking at the last message. This is what allows the Ranking Engine to ask *the most discriminating* next question instead of the next question in a fixed script.

### 4.2 `chat_sessions.bot_state` — proposed shape (same column, richer contents)

```jsonc
{
  "turn": 4,
  "active_scenarios": ["whatsapp_no_incoming_messages", "whatsapp_number_unregistered"],
  "evidence": {
    "category": "whatsapp",
    "symptom_keywords": ["مش بيوصلني رسايل", "من امبارح"],
    "attachments": ["<image_url>"]
  },
  "hypotheses_snapshot": [
    {"root_cause": "whatsapp_webhook_disconnected", "confidence": 0.62},
    {"root_cause": "whatsapp_number_reregistration_needed", "confidence": 0.31}
  ],
  "diagnosis_status": "awaiting_evidence",   // awaiting_evidence | confident | resolved | escalated
  "last_action": "ask_question"
}
```

This replaces `{flow, ticket_draft}` but is backward-compatible in spirit: it's still one JSONB blob on the same column, so no migration of `chat_sessions` is required — only a change in what the application writes to it.

### 4.3 Memory layers

| Layer | Lives in | Scope | Used by |
|---|---|---|---|
| **Turn memory** | `chat_engine_trace_events` (one row/turn) | This exchange only | Debugging, review, ranking-weight tuning |
| **Session memory** | `chat_sessions.bot_state` + `chat_messages` | This conversation | Diagnostic Engine (current evidence) |
| **Customer memory** | `tickets` (by `user_id`), `customer_notes`, `ticket_ratings` | Across all past sessions for this customer | Diagnostic Engine (priors — "this customer has had this before") |
| **Domain memory (the "brain")** | `chat_engine_scenarios`, `chat_engine_knowledge_entries` | Global, versioned, human-curated | Scenario Engine, Decision Engine, Knowledge Module |
| **Governance memory** | `chat_engine_validation_runs`, `chat_engine_publish_overrides`, `chat_engine_conversation_reviews` | Global | Safe publishing + feedback loop (§5) |

### 4.4 Feedback loop (already has a home in the schema)

1. A support agent reviews a past session and disagrees with the diagnosis → writes a row to `chat_engine_conversation_reviews` with `corrected_scenario_id`.
2. When a scenario or knowledge entry is edited, a new `version` is drafted (`status='draft'`) and tested against a batch of historical sessions; results land in `chat_engine_validation_runs` (`pass_fail`, `publish_recommendation`).
3. Publishing sets `status='published'`, `published_at`; only published versions are used live. If someone needs to force-publish despite a failing validation, that's an explicit, audited `chat_engine_publish_overrides` row — never a silent skip.

This turns scenario/knowledge changes into a reviewable, testable release process instead of an code deploy of hardcoded constants.

---

## 5. Safety & Automation

- **`memory_firewall_rules`** is checked by the Decision Engine before finalizing any action — e.g., rules like "never state another customer's data," "never promise a refund amount," "never confirm account deletion without human review." This is config, not code, so support staff can add a guardrail without a deploy.
- **`rules_engine`** (`trigger_event`/`conditions`/`actions`) is the natural place for post-decision automations the Decision Engine triggers rather than hardcodes — e.g., "if `category = whatsapp` and `confidence < 0.4` twice in a row → auto-tag ticket `needs-engineering`," or "if diagnosis = `subscription_expired` → auto-suggest the relevant plan." Reusing this table avoids building a second, parallel rules system inside the chat engine.

---

## 6. Migration Strategy (Phased, No Big-Bang)

| Phase | What happens | Risk |
|---|---|---|
| **0 — Content migration** | Move today's hardcoded `PLAN_TEXT`, `CATEGORY_MAP`, `PROBLEM_CATEGORY_OPTIONS`, FAQ-like replies into `chat_engine_knowledge_entries` (facts) and a first cut of `chat_engine_scenarios` (the 5 existing categories: whatsapp/tickets/subscription/login/other) as version 1, `status='draft'`. | None — no live traffic affected |
| **1 — Shadow mode** | New pipeline (Scenario → Diagnostic → Ranking → Decision) runs *alongside* the current `chatbot-engine.js` for every real message, writing full `chat_engine_trace_events` rows, but the **old code still sends the actual reply**. Compare old vs. new decisions offline. | None — new engine is read-only from the user's perspective |
| **2 — Gated cutover** | Use the existing `feature_flags` table to switch the Dialogue Engine's output to live for a subset (e.g., only the `whatsapp` scenario, or only for `support`-role test accounts). | Small, reversible via flag |
| **3 — Full cutover** | New pipeline drives all replies; `chatbot-engine.js`'s linear flow logic is retired (its safe UI/sanitization code in `chat.js` is untouched and reused as-is). | Ticket-creation path already validated in phases 1–2 |
| **4 — Feedback loop live** | Support staff start using `chat_engine_conversation_reviews`; validation runs become a required step before publishing any scenario/knowledge change. | None — additive |
| **5 — Channel adapters (future, not now)** | Telegram/other channels talk to the Decision Engine's output contract (`{action, payload}`) through a thin adapter that only translates rendering, not logic. Not implemented in this phase — the module boundary above (`Decision Engine` outputs a channel-agnostic decision; `Dialogue Engine` is the only channel-specific piece) is what makes this possible later without another redesign. | N/A — deferred |

---

## 7. Architectural Principles

These are the rules every future change to the Support Intelligence Engine (SIE) must follow, regardless of who implements it or when. Where a future decision conflicts with one of these, the principle wins unless explicitly overridden by you as an architectural change (§10).

1. **Single Responsibility per module.** Each module in §3.1 does exactly one job. A change that makes the Dialogue Engine decide something, or makes the Scenario Engine phrase something, is a violation regardless of how small it seems.
2. **Deterministic diagnosis.** Given the same evidence, the same scenario/knowledge version, and the same ranking weights, the engine must produce the same hypotheses and the same decision. Any probabilistic or LLM-assisted component must be isolated behind a module boundary (see §9) so the rest of the pipeline stays reproducible and traceable. Non-determinism is never allowed to leak into the Ranking or Decision Engine's own logic.
3. **Storage-agnostic providers.** No module reasons about Postgres/Supabase specifics directly in its core logic. Each module talks to a narrow provider interface (e.g., `ScenarioRepository.getPublished()`, `EvidenceStore.get(sessionId)`). Supabase is today's implementation of those interfaces, not a dependency baked into the diagnostic logic. This is what allows storage or schema details to change later without touching the Diagnostic/Ranking/Decision logic.
4. **Backward compatibility by default.** New scenario versions, new knowledge entries, new evidence fields must not break sessions that are mid-diagnosis on an older version. See §10 for the precise rules.
5. **Explainability is mandatory, not optional.** Every decision the engine makes must be traceable to the evidence and scenario version that produced it (via `chat_engine_trace_events`). A module that cannot explain its own output is not shippable.
6. **Extensibility over rewrites.** New capabilities (new scenario types, new evidence sources, new action types) must be addable by adding data (a new scenario, a new rule) or a new provider — not by branching core module logic. If a feature request requires an `if` statement inside the Diagnostic or Ranking Engine that only applies to one scenario, that's a signal the logic belongs in scenario data instead.
7. **One-way data flow.** Evidence and control flow forward through the pipeline (§3). Nothing downstream mutates a module's job upstream (see §8).
8. **No silent action.** Any action with a real-world effect (ticket creation, status change, notification) is only ever triggered by the Decision Engine, and only ever after the safety check (`memory_firewall_rules`) passes. No other module is permitted to write to `tickets`, `ticket_replies`, or trigger `rules_engine` actions directly.
9. **Channel-agnostic core.** Nothing above the Dialogue Engine may assume "website chat." The moment domain logic references a channel-specific concept (a button shape, a WhatsApp template, a Telegram chat ID), it has leaked out of its module (see §9, §12).
10. **The engine proposes; it does not execute business process.** The SIE's authority ends at "here is the decision and the recommended action." Executing multi-step business processes belongs to a Workflow Automation Engine, not the SIE (see §13).

---

## 8. Module Contracts

Each module below is a contract, not an implementation. Any implementation is compliant as long as it honors this contract; any implementation that doesn't is a violation regardless of how it's written internally.

### 8.1 Normalization Layer
- **Responsibilities:** Convert raw user input (text, and metadata like attached image presence) into a normalized, structured token/intent representation. Detect low-level intents (greeting, thanks, cancel) that are not diagnosis-relevant.
- **Inputs:** Raw `chat_messages` row (text, `image_url`/`audio_url` presence), prior `normalized_tokens` if relevant for context (e.g. repeated corrections).
- **Outputs:** `normalized_tokens` object — cleaned text, detected low-level intent, detected entities/keywords. Written verbatim into `chat_engine_trace_events.normalized_tokens`.
- **Dependencies:** None on other SIE modules. May depend on a language/NLP utility library.
- **Must never:** Decide a scenario, a hypothesis, or an action. Must never write to `chat_sessions`, `tickets`, or any table other than the trace event it emits into.

### 8.2 Scenario Engine
- **Responsibilities:** Determine which published problem domain(s) (`chat_engine_scenarios`) a message plausibly activates, based on `normalized_tokens` and current session evidence. Report matched and missing evidence per scenario.
- **Inputs:** `normalized_tokens`, current `chat_sessions.bot_state.evidence`, published rows from `chat_engine_scenarios`.
- **Outputs:** `activated_scenarios[]` — each with `scenario_key`, `matched_evidence`, `missing_evidence`. Written into the trace event (part of `hypotheses` context or a dedicated field).
- **Dependencies:** `ScenarioRepository` provider (reads only `status='published'` scenarios). Normalization Layer's output.
- **Must never:** Compute confidence scores, rank scenarios against each other, decide a root cause, or decide what to say. Must never read or write `tickets`.

### 8.3 Diagnostic Engine
- **Responsibilities:** Given activated scenarios and all available evidence (session + customer memory), generate/update a set of hypotheses — candidate root causes, each with supporting evidence and a raw confidence signal. Identify what evidence, if gathered, would most reduce uncertainty between competing hypotheses.
- **Inputs:** `activated_scenarios[]`, session evidence, customer memory (`tickets` history by `user_id`, `customer_notes`), scenario `definition.jsonb` (causal model: which symptoms imply which root causes).
- **Outputs:** `hypotheses[]` — `{root_cause, confidence, evidence_for[], evidence_missing[]}`. Written into `chat_engine_trace_events.hypotheses`.
- **Dependencies:** Scenario Engine's output, `CustomerHistoryProvider`, `ScenarioRepository` (for causal model data). Never depends on Ranking, Decision, or Dialogue Engine.
- **Must never:** Decide ordering/priority between hypotheses (that's Ranking's job), decide or trigger any action, or produce user-facing text.

### 8.4 Ranking Engine
- **Responsibilities:** Score and order the hypotheses produced by the Diagnostic Engine. Compute the confidence gap between the top hypothesis and the runner-up. Decide, as a pure function of that gap and a configured threshold, whether confidence is sufficient to act or more evidence is needed.
- **Inputs:** `hypotheses[]` from the Diagnostic Engine, ranking weights/config (versioned, not hardcoded — see §10).
- **Outputs:** `ranking` object — ordered hypotheses, `top_confidence`, `confidence_gap`, `sufficient_to_act: boolean`. Written into `chat_engine_trace_events.ranking`.
- **Dependencies:** Diagnostic Engine's output only.
- **Must never:** Generate new hypotheses, choose the actual action to take, or touch evidence directly.

### 8.5 Decision Engine
- **Responsibilities:** Given the ranking output, choose exactly one action: ask a specific discriminating question, answer directly from the Knowledge Module, create a ticket pre-filled with the diagnosis, or hand off to a human. Run `memory_firewall_rules` safety checks before finalizing. Evaluate `rules_engine` for any post-decision automations to trigger.
- **Inputs:** `ranking` output, `memory_firewall_rules` (active rules), `rules_engine` (active rules), Knowledge Module (for direct-answer content when applicable).
- **Outputs:** `decision` object — `{action, payload, safety_checks_passed, triggered_automations[]}`. Written into `chat_engine_trace_events.decision`. Any real-world write (ticket creation, tag, notification) happens here and only here.
- **Dependencies:** Ranking Engine's output, Knowledge Module, `memory_firewall_rules`, `rules_engine`.
- **Must never:** Render user-facing text, know about UI/channel formatting, or bypass a failed safety check.

### 8.6 Dialogue Engine
- **Responsibilities:** Render the Decision Engine's output as channel-appropriate content — for this scope, Arabic RTL text plus quick-reply buttons matching today's `chat.js` UI conventions (SVG icons, `escapeHtml`/`sanitizeUrl`, quick-option buttons).
- **Inputs:** `decision` object only.
- **Outputs:** `rendered` object — final message text, options/buttons. Written into `chat_engine_trace_events.rendered`, then persisted as a `chat_messages` row and shown in the UI.
- **Dependencies:** `decision` object only. No direct access to `hypotheses`, `ranking`, evidence, or any table other than what it needs to render (it does not query `tickets`, `chat_engine_scenarios`, etc. itself).
- **Must never:** Make any judgment about what's true, what the next question should logically be, or which action to take. If the Dialogue Engine finds itself needing information the `decision` object didn't provide, that's a contract violation upstream, not something to work around by reaching into other tables.

### 8.7 Knowledge Module
- **Responsibilities:** Serve factual, non-diagnostic answers (pricing, platform info, FAQ) from `chat_engine_knowledge_entries` / `suggested_questions` / `canned_responses` when the Decision Engine requests one.
- **Inputs:** A lookup key or query from the Decision Engine.
- **Outputs:** `knowledge_data` — the matched content, written into `chat_engine_trace_events.knowledge_data`.
- **Dependencies:** `KnowledgeRepository` provider (reads only `status='published'` entries). Called only by the Decision Engine.
- **Must never:** Be called directly by the Dialogue Engine, Scenario Engine, or Diagnostic Engine. Must never contain diagnostic logic — it answers "what is true," not "what's wrong."

---

## 9. Dependency Rules

Allowed communication is **strictly forward, one module deep**, matching §3's diagram:

```
Normalization → Scenario Engine → Diagnostic Engine → Ranking Engine → Decision Engine → Dialogue Engine
                                                                    ↘ Knowledge Module ↗
```

Rules:
1. **A module may only call the module immediately downstream of it, or a provider/repository interface.** Normalization never calls Diagnostic Engine directly, Scenario Engine never calls Ranking Engine directly, etc.
2. **No module may call upstream.** The Dialogue Engine must never call back into the Decision Engine mid-render; the Decision Engine must never call back into the Diagnostic Engine mid-decision. If a downstream module needs more information, the fix is to widen the upstream module's output contract (§8), not to add a reverse call.
3. **No module may skip a layer** except the Decision Engine's explicit, contract-defined call to the Knowledge Module (the one documented exception, because a direct answer is itself a decision, not a diagnosis).
4. **Only the Decision Engine may perform writes with real-world effect** (`tickets`, `ticket_replies`, `rules_engine`-triggered actions). No other module may write to those tables under any circumstance.
5. **Only the Dialogue Engine may know about presentation/channel concerns** (HTML, buttons, RTL, icons). If any other module starts importing UI concerns, that's a violation.
6. **All persistence goes through providers, never ad-hoc queries scattered across modules.** Each module's "Dependencies" list in §8 is the complete list of providers it may use — nothing outside that list.
7. **No circular dependency is ever acceptable**, including indirect ones (e.g., Knowledge Module depending on something that depends back on Decision Engine). If a future feature seems to require one, that's a signal the feature needs a new extension point (§9 → §11), not a shortcut.

Violations of these rules are architectural regressions even if they "work," and should be treated as bugs against this document, not accepted as pragmatic exceptions.

---

## 10. Extension Points

These are the seams where new capability is meant to be added **without modifying the core pipeline's logic**:

| Extension need | Where it plugs in | How, without touching core logic |
|---|---|---|
| **New problem domain / new root cause** | `chat_engine_scenarios` | Add a new scenario version (data), not new code in the Diagnostic Engine. |
| **New factual content** | `chat_engine_knowledge_entries` | Add/version a knowledge entry; Knowledge Module already serves anything published. |
| **New safety guardrail** | `memory_firewall_rules` | Add a rule row; Decision Engine already evaluates all active rules. |
| **New post-decision automation** | `rules_engine` | Add a `trigger_event`/`conditions`/`actions` row; Decision Engine already evaluates it. |
| **Workflow Automation Engine (future)** | Decision Engine's output contract | Decision Engine emits a recommended trigger/action payload; a separate Workflow Engine subscribes to and executes it. The SIE never calls the Workflow Engine directly — see §13. |
| **MCP tool integrations (future)** | Decision Engine's action layer, behind a provider | Any MCP tool call is a provider the Decision Engine can invoke through the same "action" contract used for ticket creation — never a direct dependency inside Diagnostic/Ranking logic. |
| **Additional channels (Telegram, etc.)** | A new Dialogue Engine implementation | Because the Decision Engine's output is channel-agnostic (§7.9), a new channel only needs a new renderer downstream of Decision. Nothing upstream changes. |
| **Additional AI/LLM providers** | Behind a provider interface used *inside* a single module (e.g., an LLM-assisted evidence extractor inside Normalization, or an LLM-assisted hypothesis generator inside Diagnostic Engine) | The provider is swappable; the module's output contract (§8) does not change shape because the provider changed. Non-determinism stays contained per Principle 2. |
| **Analytics / reporting** | Read-only consumer of `chat_engine_trace_events` | Analytics never sits in the live pipeline; it only reads historical trace rows. No pipeline module should be modified to "support analytics." |
| **New evidence sources** (e.g., subscription status, uptime data) | A new provider registered with the Diagnostic Engine | Added as a new named evidence provider; existing scenarios/hypotheses logic doesn't change, only the evidence available to it grows. |

---

## 11. Compatibility Rules

### 11.1 Backward compatible (safe to ship without architectural review)
- Adding a new `chat_engine_scenarios` version (new `scenario_key`, or a new `version` of an existing key) as a draft, validated, then published.
- Adding a new `chat_engine_knowledge_entries` entry or version.
- Adding a new `memory_firewall_rules` or `rules_engine` row.
- Adding new optional fields to `chat_sessions.bot_state.evidence` that older sessions simply won't have populated.
- Adding a new evidence provider that the Diagnostic Engine can optionally consult.
- Adding a new action type to the Decision Engine's vocabulary, as long as existing action types keep their existing meaning and payload shape.
- Adding a new Dialogue Engine renderer for a new channel.
- Performance improvements, refactors, or provider swaps that do not change any module's input/output contract (§8).

### 11.2 Requires explicit architectural approval (must come back to this document)
- Any change to a module's Responsibilities, Inputs, Outputs, or "must never" list in §8.
- Any change to the dependency direction or the allowed-communication graph in §9.
- Removing or repurposing the meaning of an existing `chat_engine_trace_events` field (`hypotheses`, `ranking`, `decision`, etc.) — additive fields are fine, redefining existing ones is not.
- Any change to `chat_sessions.bot_state`'s top-level shape (§4.2) that isn't purely additive.
- Giving any module other than the Decision Engine write access to `tickets`/`ticket_replies`/automation triggers.
- Introducing a reverse or cross-layer call that violates §9.
- Merging or coupling this engine's logic with the WhatsApp bot in any way.
- Letting the SIE directly execute a multi-step business process instead of recommending it to a Workflow Engine (§13).
- Any change to the security/RLS model around `is_chat_engine_staff()` or who can read/write the `chat_engine_*` tables.

When in doubt, treat a change as requiring approval rather than assuming it's additive.

---

## 12. Non-Goals

The Support Intelligence Engine is explicitly **not**:
- **A Workflow Engine.** It does not sequence multi-step business processes, retries, or long-running automations. That's a separate system it hands recommendations to (§13).
- **An LLM.** It may use one as an optional provider inside a specific module (§9), but the SIE's own reasoning (scenario matching, hypothesis ranking, decision selection) is deterministic, versioned, and auditable — it is not "the model."
- **Channel-specific.** It is not "the website chat bot" at its core; the website is the first (and for now, only) Dialogue Engine implementation, not something baked into the Scenario/Diagnostic/Ranking/Decision layers.
- **Responsible for business process execution.** It decides *what should happen next* and *recommends* it; it does not itself own retries, scheduling, external API orchestration, or multi-step execution guarantees.
- **The WhatsApp bot, or a replacement for it.** No shared code, no shared runtime state, no merged logic. They remain separate products, as scoped at the start of this document.
- **A ticketing system.** It uses the existing `tickets` schema as an action target; it does not reimplement ticket lifecycle, SLAs, or assignment logic beyond triggering it.
- **A CRM.** It reads customer history (`tickets`, `customer_notes`) as evidence; it does not own customer relationship data.

---

## 13. Future Workflow Integration

The SIE's authority is **understanding, diagnosis, reasoning, and decision-making** — it stops at producing a decision and a recommended action. It is not, now or later, responsible for *executing* that action beyond the narrow, already-modeled actions in §8.5 (ask/answer/create-ticket/handoff).

When a future Workflow Automation Engine exists:
- The Decision Engine's output (`decision.payload`) becomes a **trigger** the Workflow Engine subscribes to — not a function the SIE calls into.
- The SIE never holds a direct dependency on the Workflow Engine (consistent with §9's forward-only rule — a trigger emitted outward is not the same as a call inward).
- Multi-step processes (e.g., "diagnose → create ticket → wait 24h → escalate if unresolved → notify manager") belong entirely to the Workflow Engine once triggered. The SIE's job ends at "create ticket, category=X, confidence=Y, evidence=Z."
- `rules_engine` (§1.1, §9) is the likely handoff point: the Decision Engine's action can populate a `rules_engine`-compatible trigger event; the Workflow Engine (or a future evolution of `wf_workflows`/`wf_runs`, which belong to the WhatsApp/flow-builder surface and are out of scope here) is what actually executes long-running steps.
- This separation is deliberate and permanent: it keeps the SIE deterministic, testable, and explainable (§7) even as the surrounding automation grows more complex.

---

## 14. Versioning Strategy

Two independent things get versioned, and they must not be conflated: **this document** (the architecture) and **the content the architecture governs** (scenarios, knowledge, ranking config).

### 14.1 Document versioning
- This specification follows `MAJOR.MINOR` versioning. Current: **v1.1**.
- **MINOR bump** (v1.1, v1.2…): a change that §11.1 already classifies as backward compatible — clarifications, new extension points, additive fields. Does not require re-approval, just a changelog entry at the top of this document.
- **MAJOR bump** (v2.0): anything in §11.2 — a module contract change, a dependency-graph change, a redefinition of an existing trace field, etc. Requires you to explicitly request the redesign, and requires going back through the approval/freeze cycle before it supersedes v1.0.
- Superseded major versions are kept (not deleted) for historical reference, same principle as §14.2's scenario archiving.

### 14.2 Scenario & knowledge content versioning
- Governed entirely by the existing schema (§1) — `chat_engine_scenarios.version` / `chat_engine_knowledge_entries.version`, both integers, monotonically increasing per `scenario_key` / `knowledge_key`.
- Lifecycle: `draft` → validated via `chat_engine_validation_runs` (`pass_fail`, `publish_recommendation`) → `published` (`status='published'`, `published_at` set) → eventually `deprecated`.
- **Never delete, only supersede.** A new version is a new row, not an edit of a published row. This is what keeps `chat_engine_trace_events` explainable months later — a past decision stays attributable to the exact scenario/knowledge version that was live at the time.
- **Trace events must record the version(s) consulted**, not just the `scenario_key`/`knowledge_key`. Add this to any trace-writing logic as a hard requirement: `hypotheses`/`knowledge_data` payloads include the `version` used, so "why did it decide that" is answerable even after the content has moved on to v3.
- **Only one `published` version per key at a time.** Publishing a new version is what deprecates the previous one (`status` transitions to `deprecated` on the old row) — this is enforced at the application layer, not the DB, so the Scenario/Knowledge repositories (§7, Principle 3 — storage-agnostic providers) are the single place this rule lives.
- **Rollback = republish an older version as a new version number**, never a destructive revert. E.g. if `v4` of a scenario is bad, `v5` is published with `v3`'s content. This preserves the "never delete" rule and keeps the audit trail linear.
- **`chat_engine_publish_overrides`** remains the only sanctioned way to publish something that failed validation — still requires a `reason`, still fully audited (unchanged from §4.4).

### 14.3 Ranking weights / configuration versioning
- Ranking Engine weights/thresholds (§8.4) must be versioned the same way, not hardcoded constants in application code — treat them as another form of published, versioned content so that changing "how confident is confident enough" goes through the same draft → validate → publish discipline as a scenario, and is equally traceable per decision.

---

## 15. Performance Budget

Diagnosis has to stay conversational — a technically-correct answer that arrives after a long pause defeats the purpose. Budgets below are targets for the pipeline in §3, using `chat_engine_trace_events.processing_time_ms` (already in the schema) as the enforcement/monitoring mechanism — no new column needed.

### 15.1 Per-turn target: ≤ 1500ms end-to-end (P95)

| Stage | Budget | Notes |
|---|---|---|
| Normalization Layer | ≤ 50ms | Pure text processing, no I/O beyond reading the message already in hand. |
| Scenario Engine | ≤ 100ms | Reads published scenarios — should be served from a per-request cache (§15.2), not a fresh query per turn. |
| Diagnostic Engine | ≤ 300ms | The heaviest deterministic step — may query customer history (`tickets`, `customer_notes`). This is the stage most likely to need query optimization if it grows. |
| Ranking Engine | ≤ 50ms | Pure computation over already-fetched hypotheses, no I/O. |
| Decision Engine | ≤ 250ms | Includes `memory_firewall_rules` + `rules_engine` evaluation and, if applicable, a Knowledge Module lookup. |
| Dialogue Engine | ≤ 50ms | Pure rendering, no I/O. |
| Persistence (trace event + `chat_messages` write) | ≤ 200ms | Should not block the user-visible reply longer than necessary; consider writing the trace event without making the user wait on it if it's not needed synchronously. |
| **Buffer / network overhead** | ~150-200ms | Realtime channel round-trip, Supabase client overhead. |

These are targets, not hard contract fields — but any stage that structurally cannot meet its budget (e.g., an evidence provider doing a slow join across many tables) is an implementation problem to fix in that module, not a reason to loosen another module's contract.

### 15.2 Structural rules that protect the budget
- **No N+1 queries.** Customer history and published scenario/knowledge lookups must be single batched queries, not per-hypothesis or per-scenario round trips.
- **Published scenario/knowledge sets are cached per invocation** (not re-fetched per module inside the same turn) — Scenario Engine, Decision Engine, and Knowledge Module reading the same published set should share one fetch, not three.
- **No synchronous chained external calls beyond what §8 already declares.** A module cannot introduce a new blocking network dependency without that becoming a module-contract change (§11.2).
- **Any future LLM-assisted provider (§10) carries its own, stricter timeout and a deterministic fallback.** If an LLM-backed evidence extractor or hypothesis generator doesn't respond within its own sub-budget, the pipeline falls back to the non-LLM deterministic path rather than blocking the whole turn — this protects both Principle 2 (deterministic diagnosis) and this budget.
- **Decision Engine has a hard fallback action.** If the pipeline is approaching the budget ceiling for any reason, the Decision Engine defaults to a safe, cheap action (ask a generic clarifying question, or hand off to `is_manual_mode`) rather than stalling — never a silent failure or a hung turn.

### 15.3 Monitoring
- `processing_time_ms` on every `chat_engine_trace_events` row is the source of truth for whether the budget is being met in production — no separate observability system needs to be introduced for this (consistent with §12 — the SIE doesn't own its own analytics stack, it just emits the data).
- A P95 budget breach pattern on a specific stage is a signal to optimize that module's provider/query, not to relax the budget.

---

## 16. What I Need From You Before Implementation

- Confirm the `conversations` table is safely out of scope (looks unused/legacy from this code's perspective).
- Confirm whether `generate-ai-chat-reply` (edge function) is currently live for the website chat, dormant, or meant to become the future host for LLM-assisted diagnostic steps.
- Sign off on the `chat_sessions.bot_state` shape in §4.2 (no column/schema change, just contents).
- Sign off on treating the 5 current categories as the first `chat_engine_scenarios` v1 draft content in Phase 0.

Once approved, Phase 0 (content migration) can start without touching any live behavior.

---

## 17. Document Status

**APPROVED & FROZEN — v1.1 is the canonical specification of the Mad3oom Support Intelligence Engine (SIE)**, scoped to the website Chat Engine only. (v1.1 is an additive revision of the approved v1.0 baseline — see changelog at the top of this document; no module contract or dependency-graph changes were made, per §14.1.)

From this point forward:
- This document is the single source of truth for how the SIE is structured.
- Approved modules (§8) are not redesigned unless an architectural change is explicitly requested by you.
- Every future feature is treated as an **extension** of this architecture (§10), never a replacement for it.
- Changes are evaluated against §11 — additive/compatible changes proceed directly; anything else comes back to this document first, as an explicit architectural-change request, before any implementation work starts.
- The architecture is preserved by default. Changes are proposed only when they provide a clear architectural benefit, not for novelty.
- Future work — implementation, validation, and production integration — proceeds *against* this spec, not in parallel with a redesign of it.

Architectural Governance

Every implementation must preserve:

- Module Contracts
- Dependency Rules
- Compatibility Rules
- Versioning Strategy

If a feature cannot be implemented as an extension of this architecture,
implementation must stop until an architectural review is approved.

No implementation may bypass these rules for convenience.
