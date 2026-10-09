# Mad3oom Relay — Architecture and Implementation Plan

> Status: Mahmoud approved this plan and authorized **Phase B only** on 2026-10-09 11:22 UTC. Phase B is **implemented and tested locally** in `migrations/073_relay_core.sql` (see §26). It is **not applied to production, not deployed, not merged and not enabled** for anyone. Every later phase is still planning only. Product decisions C1, C4 and C5 were recorded at 11:00 UTC and **C3 was revised** at 11:13 UTC so that excerpts require current access to the original conversation (§24).
> Baseline: verified read-only on 2026-10-09 ~10:55 UTC and re-checked ~11:05 UTC (unchanged), see §0. Relay migration numbers are **not reserved**: the first free number is currently `073`, and it is re-checked when the Phase B PR is opened.
> Inputs: the Relay master implementation prompt and the "Source-Agnostic Core, Browser Extension Readiness" addendum (both from Mahmoud, 2026-10-09). The addendum arrived truncated after its "10. API" heading; sections after that are this document's own structure.
> Location decision: repository docs live flat in `docs/` (e.g. `docs/INBOX_HELPDESK_PLAN_AR.md`). Relay gets `docs/relay/` because each phase will add its own production-install note (the 064/068/070 install docs set that precedent), and grouping them keeps `docs/` readable.

---

## 0. Verified baseline (read-only, 2026-10-09)

Labels: **[repo]** = read in this checkout, **[prod]** = read-only SQL / migration list against Supabase project `srnelrdpqkcntbgudyto`, **[gh]** = GitHub API, **[assumption]** = not verified.

| Item | Evidence | Value |
|---|---|---|
| Working branch | [repo] `git branch --show-current` | `claude/project-thread-57d9cw`, created from `origin/main`; not pushed |
| Working tree | [repo] `git status --short` | only `?? docs/relay/` (this file); no code or migration changes |
| `origin/main` HEAD | [repo] `git rev-parse origin/main` after fetch | `6725ad6` (merge of PR #103), last migration file `070_owner_admin_context_tickets.sql` |
| PR #104 | [gh] `pull_request_read get` | **open, not merged**, head `5f5da41`, `mergeable_state: unstable`, 14 files. Adds `071_owner_admin_context_billing_requests.sql` **and `072_invoice_pdf_attachment.sql`** (with rollbacks and SQL tests) |
| Migration 071 | [prod] `list_migrations` | applied: `20261009075932 071_owner_admin_context_billing_requests` |
| Migration 072 (invoice PDF) | [prod] `list_migrations` | **not applied**; exists only in PR #104 |
| Production migration head | [prod] `list_migrations` | `071`; history begins `20260126…`, ~300 entries, most not in the repo |
| Relay objects in prod | [prod] `pg_class` / `pg_proc` like `relay%` | none |
| Postgres | [prod] `version()` | 17.6 |
| Extensions | [prod] `pg_extension` | `pg_cron 1.6.4`, `pg_net 0.19.5`, `pgcrypto`, `supabase_vault`, `http`, `btree_gist` |
| Cron jobs | [prod] `cron.job` | 7 active: `sla-breach-check`, `data-retention-cleanup`, `expire-stale-subscriptions-hourly`, `oauth-cleanup-daily`, `emp_ops_maintenance_tick`, `emp_ops_daily_rollup`, `inbox-dispatch-scheduled` |
| `auth.uid()` | [prod] `pg_get_functiondef` | `coalesce(request.jwt.claim.sub, request.jwt.claims->>'sub')`: the legacy per-claim setting wins |
| `inbox_can_access` | [prod] | matches repo 057 |
| `chat_messages` columns | [prod] | matches 054/056/064 incl. `deleted_at`, `seq` |
| `notifications` | [prod] | columns as 011/015; **no CHECK on `category` or `action`**, so a new `open_relay_record` action needs no constraint change |
| OAuth scopes | [prod] `oauth_scopes` | 23 scopes, no `relay:*` |
| Data volume | [prod] counts | 48 chat sessions, 540 messages, **0 inbox teams** |
| Shift data | [prod] `emp_ops` schema | tables `shifts`, `shift_assignments`, `employees`, … exist (not in repo); 2 shifts, **0 assignments**, 2 employees |
| Prod-shape SQL fixture | [repo] `tests/fixtures/prod-shape/` | **already on `main`** (earlier draft wrongly attributed it to PR #104) |

**Re-check 2026-10-09 ~11:05 UTC:** `origin/main` still `6725ad6`; PR #104 head still `5f5da41` (open); prod migration head still `071`; working tree still only `docs/relay/`. Additional read-only facts used by §25: `inbox_delete_message` only deletes **staff replies** (`_inbox_own_reply`: author, or elevated admin) and copies the original into `chat_message_revisions` (readable only by inbox agents with access to that conversation); customer, bot and SIE messages cannot be deleted through the product; prod has 0 deleted messages; `chat_messages` / `chat_sessions` FKs to `auth.users` have no `ON DELETE` action (account deletion cannot silently cascade); `data_retention` is enabled with action `archive` and touches **tickets only** (chat messages have no retention today); `data-deletion.html` promises manual deletion by email request within 30 days.

Not verified: CI status of `main` (the GitHub checks connector failed to connect in this session), the deployed versions of Edge Functions other than those documented in their READMEs, and whether PostgREST in prod still sets `request.jwt.claim.sub` [assumption: it does not, PostgREST ≥ 10 sets only `request.jwt.claims`].

---

## 1. Executive summary

Relay is a work-continuity layer: it turns evidence (selected messages, a selected passage on a web page, an email, a URL, or nothing at all for a manual task) into a **continuity record** with an accountable owner, a next action, a deadline with an explicit timezone, a verified completion, and an append-only history. Its value is what happens after creation: reminders, overdue detection, handovers that must be accepted, and a monitor that surfaces work at risk of disappearing.

The architecture has four separable parts:

1. **Relay domain in Postgres.** Tables plus `SECURITY DEFINER` RPCs that own every business rule (validation, state machine, ownership, handover, scheduling, audit). This is how Mad3oom already builds critical features (inbox 055–060, conversation core 064).
2. **Two entry doors to the same RPCs.** The native UI calls the RPCs with the user's Supabase session (existing convention). External clients (future browser extension, integrations) call a thin Edge Function, `relay-api`, authenticated with tokens from Mad3oom's **existing OAuth 2.1 server** (PKCE, scoped opaque bearer tokens, revocable). `relay-api` executes the *same* RPCs as the token's user, so there is one rulebook.
3. **Source references, separate from records.** A record has N source references (normalized, provider-agnostic), and each reference can have an optional, minimal, redactable **snapshot**. Audit events record identifiers and hashes, never source content, so content can be removed without breaking history.
4. **Source adapters on the client side.** Small pure functions that translate a source (Mad3oom message selection today; browser selection later) into the canonical request. No plugin framework.

Phase 1 ships the native experience in the platform support inbox, where Mad3oom conversations actually live today. The extension is not built in Phase 1, but nothing in Phase 1 has to change to add it.

---

## 2. Product scope and goals

**Problem.** Work loses its context, owner or next action when responsibility moves between people or shifts: forgotten follow-ups, problems that outlive a shift, handovers without context, commitments discussed in chat and never tracked, customers re-explaining issues.

**Goals (to be measured, not assumed):**
1. Fewer forgotten follow-ups.
2. Less repeated explanation and lost context.
3. Explicit ownership at every stage.
4. Reliable, auditable handovers.
5. Detection of overdue and unassigned work.
6. Minimal manual documentation.
7. Original evidence preserved behind every record.

**Record types:** follow-up (متابعة بموعد محدد), issue (مشكلة تحتاج حلًا), handover (تسليم لموظف آخر).

**Phase 1 in scope (decision C1: platform support inbox only):** native creation from inbox messages and manual creation, in the platform workspace only; full lifecycle; handovers (ad hoc and end-of-shift bundles); reminders, overdue, escalation; continuity monitor; the domain + API boundary that a future extension will use.

**Not in Phase 1:** the browser extension itself, email/CRM adapters, AI extraction (flagged later step), automatic shift-triggered handovers (shift data exists only in the separate `emp_ops` product with no assignments, §0, decision C7), anything in company workspaces (C1: company support comes later; the schema keeps `workspace_id` so it can be added without redesign, but Phase 1 RPCs reject any non-platform workspace).

**Success measures to instrument from day one:** records created per source type, % active records with owner and next action, overdue count and age, handover acceptance latency, reminders delivered vs failed, records resolved with evidence.

---

## 3. Existing architecture findings

| # | Finding (evidence) | Consequence for Relay |
|---|---|---|
| A1 | Vanilla ES modules, no build step, deployed on Vercel. Features split into pure `*-model.js`, Supabase `*-data.js`, and a view (e.g. `assets/js/admin/inbox-model.js`, `inbox-data.js`, `inbox.js`). | Same split for Relay. No framework, no bundler. |
| A2 | Business rules in Postgres: `SECURITY DEFINER` RPCs, no INSERT/UPDATE/DELETE policies on new tables, every write logged to an events table (`inbox_events`, 055). | Relay writes only through `relay_*` RPCs; tables have SELECT policies only. |
| A3 | Mandatory conventions on every new table/RPC: `trg_preview_read_only` (041), RESTRICTIVE `gate_account_active` (042), `account_is_active()` check, authority via `is_platform_staff()` / `has_elevated_authority()` / `_inbox_is_supervisor()` / company relations (035, 040), never by email. | Applied to all Relay objects. |
| A4 | Three non-overlapping authority domains: platform staff, company roles (`is_company_admin()`, `is_company_member()`, `current_company_id()`), and `emp_ops` (separate product, structurally isolated by rule ③ in 035). | Relay has a `workspace` concept covering platform and company. It never reads `emp_ops`. |
| A5 | Scheduling is in-database: `pg_cron` + `pg_net` enabled; `inbox_dispatch_scheduled` runs every minute with `FOR UPDATE SKIP LOCKED`, re-validates at send time, and records failures as `failed` + event + notification (058). Migration guards make local DBs without `pg_cron` still testable. | One `relay_tick()` job over a `relay_jobs` table. No Edge-Function scheduler, no per-record cron. |
| A6 | Notifications are rows in `notifications` with `category` (011) and `action` / `action_target` (015). | New action `open_relay_record`. |
| A7 | OAuth 2.1 server exists: `oauth-register` (RFC 7591 DCR, HTTPS redirect URIs, `token_endpoint_auth_method` `none` allowed), `oauth-authorize` (**PKCE mandatory**), `oauth-token` (opaque `mad3oom_bt_…` access tokens stored hashed in `api_tokens` with `scopes`, 1h TTL; `mad3oom_rt_…` refresh tokens, 30d, rotated on use), `oauth-connected-apps` (user-visible revocation). Scope ceiling enforced in SQL by `api_token_scope_ceiling()` (036). | The extension reuses this. Relay adds `relay:read` / `relay:write` scopes. |
| A8 | `mcp` Edge Function verifies bearer tokens (`_shared/api-auth.ts`, 60 req/min) and then queries with the service role, enforcing ownership in TypeScript. The engineering audit flags service-role-as-gateway (S9). | `relay-api` must **not** copy that pattern: it propagates the user identity into SQL so RLS/RPC rules apply unchanged (§10.4). |
| A9 | Engineering audit §6.1: most production migrations are not in the repo. A production-shaped fixture exists on `main` (`tests/fixtures/prod-shape/`). | Relay SQL tests load the prod-shape fixture; every Relay migration pins its prerequisites in a precondition block (as 055/058 do). |
| A10 | Tests: `node --test` model tests, Playwright render tests against Supabase fakes, `tests/sql/*.test.sql` on real Postgres incl. real concurrency (dblink); CI `tests.yml` runs both; rollbacks in `migrations/_rollback/`. No real E2E harness. | Same conventions; E2E = Playwright with fakes + SQL integration + a staging smoke script. |
| A11 | No partial Relay implementation exists. | Greenfield inside existing conventions. |
| A12 | The repo has no shift model. Production has `emp_ops.shifts` / `shift_assignments` (separate product, not in the repo, isolated by 035 rule ③) with 2 shifts and 0 assignments. | Phase 1 handovers are ad hoc or user-initiated "end of my shift" bundles. Using `emp_ops` shifts later is a product decision (§24, C7), not a Phase 1 dependency. |
| A13 | AI: `ai-gateway` (multi-provider registry). SIE lives in another repo with no verified structured-extraction contract. | Deterministic + manual extraction first; AI later, flagged, schema-validated. |

---

## 4. Existing data model and integration points

**Conversations.** `chat_sessions` / `chat_messages` (website, Telegram, Android). Platform staff read them through `inbox_can_access(session)` (055/057): supervisors (elevated admin, or owner in admin context) see all, admin/support see assigned or team conversations. Customers own their sessions. Helpdesk state lives in side tables (`inbox_conversations`, `inbox_notes`, `inbox_events`, `inbox_teams`, `inbox_team_members`) because customers can update any column of their own `chat_sessions` row (F2 in the inbox plan). **Relay follows the same rule: no columns or triggers on the chat tables.**

**Messages.** `chat_messages` has no UPDATE/DELETE policy; staff edits/deletes go through `inbox_edit_message` / `inbox_delete_message` (056), which blank the row, set `deleted_at`, and keep the original in `chat_message_revisions`. `seq` exists for messages since 064. → A Relay source reference to a deleted message stays valid; its snapshot (if kept) still shows what was selected; the live link reports "deleted".

**Companies.** `companies`, `company_members`, company roles (035), company tickets (033). No company conversation inbox. WhatsApp `messages` is a separate product table and is **not** a Relay source in Phase 1 (inbox plan F10).

**Integration points Relay touches (additively):**
- `admin/inbox.html` + `assets/js/admin/inbox.js`: message selection mode and "create continuity record" entry.
- `assets/js/admin/sidebar.js`: Relay navigation entry.
- `notifications`: new `open_relay_record` action, routed by the existing notification router.
- `inbox_teams`: team ownership and monitor filters.
- `api_token_scope_ceiling()` (036): new `relay:read`, `relay:write` scopes.
- `oauth-*` Edge Functions: a pre-registered first-party extension client (later phase).
- `pg_cron`: one job, `relay-tick`.

---

## 5. Reference screenshots and UX requirements

The two reference screenshots were re-attached by Mahmoud on 2026-10-09 (14:21 UTC) and are design references only, not backend behavior. They supersede the earlier reading of Reference B: the second screen picks one of **nine categories** (a suggested one marked "موصى به" plus a grid) and an optional note; the record kind (follow-up or issue), title, next action, owner and due date come in a third "details" step. What Phase C built from them is in §27.

**Reference A — message selection.** Conversation of message cards; multi-select with a clear selected state; selection count; easy deselection and cancel; native Arabic RTL; no retyping.
→ In the inbox conversation pane: a "تحديد رسائل" toggle; each message card gets a checkbox (44px touch target) and a selected style from existing inbox tokens; a sticky bar "٣ رسائل مختارة · إلغاء · إنشاء سجل استمرارية" reusing the existing conversation `bulkBar` pattern. Keyboard: Tab to card, Space toggles, Esc cancels, focus ring visible. Messages from both customer and staff are selectable; the same message cannot be added twice.

**Reference B — type and preview.** Three choices (متابعة بموعد محدد / مشكلة تحتاج حلًا / تسليم لموظف آخر); preview with source messages; explanation that the system extracts context and proposes next action and deadline; primary action "إنشاء سجل استمرارية"; confirmation before creation.
→ Dialog step 1: three large choice cards. Step 2: editable preview with source excerpts, title, summary, next action, owner, deadline + timezone, a "missing / needs confirmation" panel; values marked *explicit* (stated in a message) vs *suggested*. The confirm button is disabled while required fields are missing and while a request is in flight.

**General UX rules.** Arabic-first RTL; existing admin styles (`assets/js/admin/design-tokens.css`, `admin/styles.css`); no new design system, decorative gradients or fake controls; loading / empty / error / success states; confirmation for consequential actions (cancel, reassign, decline handover); record ⇄ source navigation without losing context (deep link to the inbox conversation at the message, and back).

**Areas:** Relay overview · My Commitments · All records (permission-gated) · Handovers (incoming / outgoing / end-of-shift builder) · Continuity Monitor · Record detail with audit timeline.

---

## 6. Continuity record model

Names follow existing conventions (`inbox_*` → `relay_*`).

### 6.1 `relay_workspaces` (thin)
Makes tenancy explicit instead of inferring it per query.
- `id uuid pk`, `kind` (`platform` | `company`), `company_id uuid null unique` (FK `companies`), check: `company_id` present iff `kind='company'`. Exactly one `platform` row.
- Settings (inline columns, not JSON): `handover_requires_acceptance bool default true`, `reminder_lead_minutes int default 60`, `escalate_after_minutes int default 240`, `escalation_team_id uuid null`, `default_timezone text default 'Africa/Cairo'` (validated against `pg_timezone_names`).

Phase 1 (C1) creates only the `platform` row; `relay_create` and every other RPC reject a company workspace with `feature_not_enabled` until a later phase lifts it.

- `snapshot_retention_days int not null default 365 check (snapshot_retention_days = 365)`: decision C5 is fixed at 365 days; changing it requires a migration and a new decision.

Workspace membership is **derived**, never stored or accepted from clients: platform workspace ⇔ `is_platform_staff()`; company workspace ⇔ `is_company_member()` for that company (`is_company_admin()` = supervisor).

**Correction (review R3):** those helpers answer only for the *caller* (`auth.uid()`). Validating a *target* owner (assign, handover) needs a separate predicate `_relay_is_eligible_owner(workspace, user)`: platform ⇒ the same set `inbox_list_agents()` returns (role `admin`/`support`, or `platform_owner`), active, not banned; company ⇒ company owner or `company_user` of that company, active, not banned. Owner context is a property of a session, not of a target user, so it is ignored for eligibility.

### 6.2 `relay_records`
| Column | Notes |
|---|---|
| `id uuid pk`, `workspace_id uuid not null` | FK, from server-side resolution only |
| `kind` | `follow_up` \| `issue` \| `handover` |
| `title text not null` (≤160), `summary text` (≤4000) | |
| `next_action text null` | Active records without it are flagged |
| `status` | §7; `overdue` is derived, not stored |
| `priority smallint` 1–4, default 3 | |
| `owner_id uuid null` | null = explicitly unassigned (flagged) |
| `team_id uuid null` | FK `inbox_teams` (platform) |
| `due_at timestamptz null`, `due_tz text null` | check: both or neither; `due_tz` is the IANA zone the user meant |
| `problem`, `known_facts`, `unknowns`, `resolution_criteria` | issue fields, nullable |
| `resolution_note`, `resolved_at`, `resolved_by` | required to resolve |
| `closed_at timestamptz null` | set on `resolved` or `cancelled`, cleared on reopen; the C5 retention clock |
| `cancel_reason` | required to cancel |
| `created_by`, `created_at`, `updated_at`, `version int` | optimistic concurrency |
| `created_via` | `native` \| `extension` \| `integration` \| `system` |
| `idempotency_key uuid`, `request_hash text` | unique (`created_by`, `idempotency_key`) |

Constraints: active `follow_up` needs `due_at`; `resolved` needs `resolution_note`; `cancelled` needs `cancel_reason`.
Indexes: (`workspace_id`, `status`, `owner_id`), (`due_at`) where active, (`team_id`) where active.

### 6.3 `relay_handovers`
`id`, `record_id`, `batch_id` (one end-of-shift package = many rows), `from_owner`, `to_owner` / `to_team`, `note`, `outstanding_actions`, `state` (`pending` | `accepted` | `clarification_requested` | `declined` | `cancelled` | `auto_accepted`), `decided_by`, `decided_at`, `created_at`. Partial unique: one `pending` per record.

### 6.4 `relay_events` (immutable audit)
`id`, `record_id`, `actor_id` (null = system), `client` (`native` | `extension` | `integration` | `cron`), `kind`, `payload jsonb`, `created_at`. Payload holds ids, enum/date/owner diffs, and hashes; **never source excerpt text and never free-text values** (`title`, `summary`, `next_action`, `problem`, `known_facts`, `unknowns`, `resolution_note`, notes): for those it stores only the field name and the new value's sha256 (§25, M5). Otherwise an immutable log would keep copies of content that C5 retention must remove. No UPDATE/DELETE path (trigger rejects both, including for definer functions).

### 6.5 `relay_jobs` (scheduling)
`id`, `record_id`, `kind` (`due_reminder` | `overdue_alert` | `handover_reminder` | `escalation`), `run_at`, `state` (`pending` | `done` | `failed` | `cancelled`), `attempts`, `last_error`, `dedupe_key text unique`. Index on `run_at` where `pending`.

Sources are §8.

---

## 7. Lifecycle and state-transition rules

```
                    ┌──────────────► cancelled ◄──────────┐
                    │                                       │
 open ─► scheduled ─┼─► in_progress ◄─► waiting            │
   │                │        │                              │
   └────────────────┴────────┴─► ready_for_handover ──(accepted)──► open (new owner)
                    │
                    └──────────────► resolved ──(reopen)──► open
```

| From | To | Who | Required |
|---|---|---|---|
| open / scheduled / in_progress / waiting | in_progress, waiting, scheduled | owner, supervisor | `waiting` needs a `waiting_on` note |
| any active | ready_for_handover | owner, supervisor | pending handover created in same call |
| ready_for_handover | open | system on accept | new owner set, previous kept in handover row |
| any active | resolved | owner, supervisor | `resolution_note`; issues also need it to address `resolution_criteria` when set |
| any active | cancelled | owner, supervisor | `cancel_reason`; confirmation in UI |
| resolved / cancelled | open | owner, supervisor | reason; logged as `reopened` |

**Handover semantics (clarified in review R6):**
- `kind = 'handover'` means "this record was created *as* a handover": it is created together with a pending handover in one transaction. Its lifecycle is otherwise the same as any record. Any record of any kind can be handed over later.
- While a handover is `pending` or `clarification_requested`, `owner_id` stays the **previous owner**: ownership changes only on `accepted` / `auto_accepted`. The handover row stores `prior_status`.
- `declined` or `cancelled` ⇒ record returns to `prior_status`, owner unchanged, previous owner notified.
- `clarification_requested` ⇒ previous owner is notified and must answer (note) or cancel; the handover stays open and keeps escalating.
- Handover to a team: any eligible team member may accept; the first accept wins (row lock), others get `invalid_transition`.
- A supervisor reassigning a record with an open handover cancels that handover in the same transaction (event `handover_cancelled_by_reassign`).
- If the target owner becomes ineligible (banned, inactive, no longer staff), the pending handover is flagged in the monitor and escalates; it is never auto-accepted.

**Invariants (each has a SQL test):**
1. Every active record has an owner, or is unassigned and appears in the monitor.
2. Every active record has a next action, or appears in the monitor.
3. A due date always has a timezone.
4. Handovers never erase previous owners (history in `relay_handovers` + events).
5. A passing deadline never resolves anything; overdue is derived.
6. Failed jobs stay visible (`failed` + event + monitor) and are retryable.
7. Closing preserves sources and events.
8. Workspace isolation is enforced in SQL.
9. Repeated ticks/requests do not duplicate reminders or records (unique keys).
10. State is fully recoverable from tables.
11. Every write checks `version`; a stale write fails with a conflict, nothing is written.

---

## 8. Source-reference model

### 8.1 Concepts
- **Continuity record** (§6): the operational entity.
- **Source reference**: a structured pointer to material that justifies the record. Many per record, mixed types.
- **Source snapshot**: an optional, minimal, redactable copy of the selected content at capture time.
- **Source adapter**: client-side code that turns a source into the canonical request (§9). Adapters never write to the database.

### 8.2 `relay_sources` (reference, immutable identity)
| Column | Notes |
|---|---|
| `id`, `record_id`, `workspace_id` | `workspace_id` copied from the record for RLS |
| `position smallint` | order in the record |
| `source_type` | `mad3oom_message` \| `mad3oom_conversation` \| `mad3oom_ticket` \| `web_selection` \| `url` \| `external_message` \| `email` \| `manual_note` \| `integration` |
| `provider text` | `mad3oom`, `web`, later `gmail`, `whatsapp_cloud`, … (allow-list table `relay_source_providers`) |
| `adapter`, `adapter_version` | which adapter produced it |
| `chat_message_id`, `chat_session_id`, `ticket_id` | internal FKs, `on delete set null` |
| `url_original text`, `url_canonical text` | ≤2048; canonical strips fragment-less tracking params (`utm_*`, `fbclid`, `gclid`), lowercases host |
| `page_title text` | ≤300, as captured |
| `external_conversation_id`, `external_message_id` | ≤512, provider-scoped |
| `provider_ids jsonb` | small, schema-validated per provider (≤2KB) |
| `captured_at`, `captured_by`, `capture_client` | |
| `dedupe_key text` | computed server-side (below); unique per (`record_id`, `dedupe_key`) |
| `access_state` | `accessible` \| `deleted` \| `revoked` \| `unavailable` \| `unknown` |
| `access_checked_at` | |
| `snapshot_id uuid null` | |

`dedupe_key` = `type:provider:` + first available of internal id → external message id → (`url_canonical` + sha256 of normalized excerpt) → (`url_canonical`). It prevents duplicate references in one record and powers lookup by source (§10.2 `relay_find_by_source`).

### 8.3 `relay_source_snapshots` (content, deletable)
`id`, `source_id`, `workspace_id`, `origin_session_id uuid null` (immutable copy of the source conversation id, **no FK**, so authorization can still be evaluated if the FK on `relay_sources` is nulled; required for Mad3oom sources), `excerpt text` (≤4000 chars, only what the user selected), `excerpt_sha256` (server-side only, never returned to clients: a hash of a short message could be guessed), `sender_label` (role label "العميل" / "الدعم" / "البوت"; no names, phone or email), `original_created_at`, `truncated bool`, `source_deleted_at timestamptz null` (C4: set when the origin message is deleted; the excerpt is kept), `redacted_at`, `redacted_by` (null = system), `redaction_reason` (`retention` \| `manual` \| `data_subject_request`).
Redaction sets `excerpt = null` and `sender_label = null`, keeps the hash, and logs `source_redacted` in `relay_events` with the hash and reason only. Redaction is **irreversible** (no un-redact path, not even for supervisors).

### 8.4 Contract (canonical JSON, version 1)
```json
{
  "type": "web_selection",
  "provider": "web",
  "adapter": "browser-selection", "adapter_version": "1",
  "url": "https://example.com/tickets/42?utm_source=x",
  "page_title": "Ticket 42",
  "external_conversation_id": null,
  "external_message_id": null,
  "provider_ids": {},
  "internal": { "chat_message_id": null, "chat_session_id": null, "ticket_id": null },
  "excerpt": { "text": "…selected text…", "sender_label": null, "original_created_at": null },
  "captured_at": "2026-10-09T10:40:00Z"
}
```
For `mad3oom_message` the client sends only `internal.chat_message_id`; **the server** fills excerpt, sender, timestamps and session from the database (the client is not trusted to describe internal evidence).

### 8.5 Behavior when the source changes or disappears
| Situation | Behavior |
|---|---|
| Mad3oom message edited | For a viewer who passes the excerpt check (§12): snapshot shows the text as selected and "edited after capture" (server compares `excerpt_sha256` with live text). |
| Mad3oom message deleted (`deleted_at`), conversation still exists | **Decision C4: the excerpt is retained in storage.** `source_deleted_at` is stamped by the next `relay_tick` sweep (no trigger on chat tables). It is shown **only** to a viewer who passes the excerpt check (§12) on `origin_session_id`, with "حُذفت الرسالة الأصلية في …"; everyone else gets the hidden placeholder. Those viewers can already read the original through `chat_message_revisions` (same `inbox_can_access` rule), so Relay adds no new audience. Only staff replies can be deleted (§0), so this applies to support replies, never customer messages. Mandatory controls M2–M4 (§25) apply. |
| Source from another workspace | Rejected: `mad3oom_message` / `mad3oom_conversation` / `mad3oom_ticket` sources are only allowed when the conversation/ticket belongs to the record's workspace (platform inbox ⇒ platform workspace only). |
| Viewer can open the record but not the conversation (never had access, or lost it: unassigned, team change, handover/reassign to someone outside the conversation) | **Decision C3 (revised): excerpt hidden.** The record is returned with each such source as a placeholder `{ excerpt: null, excerpt_hidden: "no_conversation_access" }`, no sender label, no timestamps, no hash, no conversation link; UI label "محتوى من محادثة لا تملك صلاحية الوصول إليها". Checked on every read, never from permissions at creation time. Losing conversation access does not remove record access. |
| Conversation row no longer exists, `origin_session_id` missing, or the check cannot be evaluated (error, unknown provider) | **Fail closed:** excerpt hidden for everyone including supervisors. *Phase B implementation:* the code is the same `no_conversation_access` as above, not a separate `unverifiable`, so a viewer cannot tell a deleted conversation from one they lack access to (§26). Needed because the verified `inbox_can_access` returns true for supervisors on *any* non-null id without checking that the session exists (§0). |
| Viewer loses Relay access (no longer staff, banned, inactive, preview mode, owner leaves staff context) | No record, no excerpt: `relay_can_access` fails, so `relay_get` returns `not_found`. Nothing is cached server-side per viewer. |
| Record closed (resolved/cancelled) | Excerpts stay visible to record viewers; `closed_at` starts the C5 clock. |
| Record reopened before 365 days | `closed_at` cleared; no redaction happens while active; the next close starts a new 365-day clock. |
| Record reopened after redaction | Excerpts stay redacted (irreversible); references, hashes and events remain. |
| Retention deadline reached (`closed_at + 365 days`) | Excerpt hidden on the read path immediately, physically redacted by the daily sweep (§14, M6–M7). |
| Customer data-deletion request (manual process on `data-deletion.html`) | Supervisor runs `relay_redact_for_subject` for that customer; all excerpts sourced from their sessions are redacted with reason `data_subject_request` (M8). |
| External URL changes / page moves | Stored URL kept as captured. Relay **never fetches external URLs server-side** (no crawling, no SSRF surface). Users can add a new reference. |
| External site unavailable or access revoked | No server effect. Extension may report `unavailable` / `revoked` when the user opens the link; that updates `access_state` with an event. |
| Snapshot redacted | Reference keeps type, URL, ids, hash; UI shows "تم حذف المحتوى" with who/when/why. |

---

## 9. Source-adapter architecture

**Shape.** An adapter is a plain ES module exporting:
```js
export const id = 'mad3oom-inbox';      // adapter + version recorded on each source
export const version = '1';
export function toSourceRefs(input) { /* returns canonical source refs (§8.4) */ }
export function draftHints(input)    { /* optional: title/explicit-date hints for the preview */ }
```
A registry is a literal object in `assets/js/relay/adapters/index.js`. No dynamic loading, no plugin framework.

**Phase 1 adapters:** `mad3oom-inbox` (selected `chat_messages` ids), `manual` (no source or a free note).

**Excerpt authorization per provider (C3 revised).** Each provider must declare a server-side `can_view_excerpt(viewer, source)` rule before its phase starts. Only `mad3oom` has one in Phase 1 (`inbox_can_access` on `origin_session_id`, §12). `inbox_can_access` is **not** assumed to apply to browser selections, emails, CRM records or any other provider. A provider without an approved rule stores references and excerpts but returns `excerpt_hidden: "no_provider_rule"` to every viewer.
**Later:** `browser-selection` (URL, title, selected text; lives in the extension), `email-*`, `crm-*` (server-side integration adapters in Edge Functions using the same contract).

| Layer | Responsibilities |
|---|---|
| Source adapter (client or integration) | Read only what the user selected; build canonical refs; never decide ownership, deadlines, or permissions; never write data. |
| UI (native or extension) | Selection, type choice, editable preview, explicit confirmation, idempotency key per draft, displaying server validation errors. |
| Shared contract module `assets/js/relay/relay-contract.js` (pure) | Field limits, enums, client-side pre-validation for fast feedback. Copied into the extension at build time. **Advisory only**; the server re-validates everything. |
| API layer: native = PostgREST RPC; external = `relay-api` Edge Function | AuthN (session JWT or OAuth bearer), scope check, rate limit, request-size limit, CORS, HTTP error mapping, identity propagation. **No business rules.** |
| Relay application service = SQL RPCs | Validation, workspace resolution, authorization, state machine, ownership, handover, snapshot capture for internal sources, dedupe, idempotency, audit events, job scheduling. Single source of truth for both doors. |
| Database | Constraints, FKs, unique keys, RLS SELECT policies, immutability triggers, preview/gate conventions. |
| Background jobs (`relay_tick` via `pg_cron`) | Reminders, overdue alerts, handover reminders, escalation, retries, notification writes, retention. Re-validate before acting. |

---

## 10. API and domain boundaries

### 10.1 Two doors, one rulebook
```
Native UI ──supabase-js (user JWT)──► relay_* RPCs ◄──service role + actor── relay-api ◄──OAuth bearer── Extension / integrations
                                         │
                                   tables, events, jobs
```
The native UI keeps the repo's convention (RPC via supabase-js). `relay-api` is a new Edge Function used only by non-native clients.

### 10.2 Operations
| Operation | RPC | `relay-api` route | Scope |
|---|---|---|---|
| Create from canonical request | `relay_create(p_request jsonb)` | `POST /v1/records` | `relay:write` |
| Attach source(s) | `relay_attach_sources(p_record, p_sources jsonb, p_expected_version)` | `POST /v1/records/{id}/sources` | `relay:write` |
| Redact snapshot | `relay_redact_source(p_source, p_reason)` (record owner, creator, supervisor) | `POST /v1/sources/{id}/redact` | `relay:write` |
| Redact for a data-deletion request | `relay_redact_for_subject(p_user, p_reason)` (supervisor only, native only) | not exposed | — |
| Get record (+ sources, handovers) | `relay_get(p_record)` | `GET /v1/records/{id}` | `relay:read` |
| List / My commitments | `relay_list(p_filters jsonb)` | `GET /v1/records` | `relay:read` |
| Update permitted fields | `relay_update(p_record, p_patch, p_expected_version)` | `PATCH /v1/records/{id}` | `relay:write` |
| Reassign | `relay_assign(p_record, p_owner, p_team, p_expected_version)` | `POST /v1/records/{id}/assign` | `relay:write` |
| Schedule / reschedule | via `relay_update` (`due_at`, `due_tz`) → jobs replaced atomically | same | `relay:write` |
| Transition / resolve / cancel / reopen | `relay_transition(p_record, p_to, p_details jsonb, p_expected_version)` | `POST /v1/records/{id}/transition` | `relay:write` |
| Create handover (1..n records) | `relay_handover_create(p_request jsonb)` | `POST /v1/handovers` | `relay:write` |
| Decide handover | `relay_handover_decide(p_handover, p_decision, p_note)` | `POST /v1/handovers/{id}/decision` | `relay:write` |
| Audit history | `relay_events_for(p_record, p_before, p_limit)` | `GET /v1/records/{id}/events` | `relay:read` |
| Find by source | `relay_find_by_source(p_source jsonb)` | `POST /v1/records/lookup` | `relay:read` |
| Monitor | `relay_monitor(p_filters jsonb)` | not exposed externally in v1 | — |
| Tick | `relay_tick()` | none (cron only, not granted) | — |

Excerpt text is returned **only** by `relay_get` (record detail) and only per source that passes the excerpt check (§12); other sources come back as hidden placeholders. `relay_list`, `relay_monitor`, `relay_find_by_source`, `relay_events_for`, notifications, logs and `relay-api` responses never carry excerpt text, sender labels or excerpt hashes (M4). Responses are not cached server-side; clients must not persist excerpts (no `localStorage`, no extension storage).

`relay_find_by_source` for a Mad3oom message or conversation first requires the caller to pass `inbox_can_access` on that conversation; otherwise it returns an empty result, so it cannot reveal that a message is quoted somewhere.

`relay_find_by_source` returns only records the caller can access, matched by `dedupe_key`; it lets the extension show "already tracked" for the selected text/URL and the inbox show a badge on messages already linked.

### 10.3 Canonical create request / response
```json
{
  "contract_version": 1,
  "idempotency_key": "4b0c…uuid",
  "kind": "follow_up",
  "title": "اتصال بالعميل بخصوص الشحنة",
  "summary": "…",
  "next_action": "الاتصال بالعميل وتأكيد موعد التسليم",
  "priority": 2,
  "owner_id": "uuid-or-null",
  "team_id": null,
  "due": { "at": "2026-10-10T10:00:00", "tz": "Africa/Cairo" },
  "issue": null,
  "handover": null,
  "sources": [ { "…": "§8.4" } ],
  "provenance": { "title": "explicit|suggested|user", "due": "explicit|suggested|user" }
}
```
`due.at` is a **local** wall-clock time interpreted in `due.tz` by the server (DST-safe), stored as `timestamptz` + `due_tz`. Response: `{ "record": {…}, "sources": [...], "replayed": false }`.

### 10.4 Identity propagation in `relay-api`
`relay-api` verifies the bearer token (reusing `verifyApiToken`), checks the scope, then calls `relay_api_invoke(p_actor uuid, p_token_id uuid, p_op text, p_args jsonb)`: a service-role-only function that sets **transaction-local** `request.jwt.claims` (`sub` = token user, `role` = `authenticated`, `relay_client` = `extension`, `token_id`) and calls the same public `relay_*` RPC. Every existing authority helper (`auth.uid()`, `is_platform_staff()`, `account_is_active()`, …) then evaluates the real user. Precedent: 053 already reads `request.jwt.claims`. Before adopting, a SQL test must prove `auth.uid()` in this Supabase version reads the local claim, and that the function is not callable by `anon`/`authenticated`.
Rejected alternative: re-implementing authorization in TypeScript with the service role (the `mcp` pattern, audit S9).

**Corrections from review R2 (blocking for Phase G, not for Phase B):**
1. Prod `auth.uid()` reads `request.jwt.claim.sub` **before** `request.jwt.claims` (§0). `relay_api_invoke` must set **both** settings transaction-locally (`set_config(…, true)`), plus `request.jwt.claim.role`, or a stale legacy setting could win.
2. **Owner context leaks across channels.** `owner_capability()` → `active_context()` reads `owner_context_state` **per user**, not per login session. A platform owner using the extension would act with whatever context their web dashboard last set (staff, admin, customer…), and that can change mid-flight. Required rule: `relay_api_invoke` sets a claim `relay_client = 'extension'`, and `relay_can_access` / eligibility treat the platform owner coming through `relay-api` as a plain staff member (own/created/targeted/team records), never as supervisor. Supervisor actions from the owner stay native-only. (Decision C6.)
3. Session-bound checks (`_jwt_session_id()`, `step_up_fresh()`) see no `session_id` for extension calls and therefore fail closed. Relay must not use step-up for anything the extension needs.
4. Relay public RPCs are `SECURITY DEFINER`; nested calls from `relay_api_invoke` run as the function owner, so `grant execute … to authenticated` is not what protects them. Every Relay RPC must authorize explicitly from `auth.uid()` (it already must, per A2), and reads must go through `relay_get` / `relay_list` RPCs, not table SELECTs, so the native and API paths are identical.
5. Required SQL tests before Phase G: claim propagation with a stale `request.jwt.claim.sub` present; `relay_api_invoke` not executable by `anon` / `authenticated`; owner-through-API cannot see another staff member's record even when the owner's dashboard context is `admin`.

### 10.5 Validation
- Server: enum checks; text limits; `owner_id` must be a member of the resolved workspace and able to work there; `team_id` belongs to the workspace; `due.tz` in `pg_timezone_names`; `due.at` not more than 365 days ahead (configurable) and not in the past for new follow-ups (warning not error when within 5 minutes); ≤20 sources per request, ≤4000 chars per excerpt, total request ≤64KB; for `mad3oom_message`, caller must currently pass `inbox_can_access(session)` for every message; all messages in one request may span sessions only if the caller can access each.
- Kind rules: follow-up needs `next_action` + `due`; issue needs `problem` (falls back to `summary`); handover needs a target owner or team.
- Never invented: the server never fills `owner_id` or `due` itself; missing values stay null and make the record appear in the monitor.

### 10.6 Errors
| Case | SQLSTATE | HTTP (`relay-api`) | Code |
|---|---|---|---|
| Validation | `22023` (+ JSON detail with field errors) | 422 | `validation_failed` |
| Not found or not visible | `P0002` | 404 | `not_found` |
| Not allowed | `42501` | 403 | `forbidden` |
| Stale `expected_version` | `40001` | 409 | `version_conflict` (returns current version) |
| Same idempotency key, different payload | `23505` | 409 | `idempotency_conflict` |
| Invalid transition | `55000` | 409 | `invalid_transition` |
| Token missing/expired/revoked | — | 401 | `unauthorized` |
| Missing scope | — | 403 | `insufficient_scope` |
| Rate limited | — | 429 | `rate_limited` (+ `Retry-After`) |

Native UI maps the same SQLSTATEs to Arabic messages in `relay-model.js`. No partial success: every RPC is one transaction.

### 10.7 Idempotency
The client generates `idempotency_key` when the preview opens. Server stores it with `request_hash` (sha256 of normalized request). Same key + same hash → returns the existing record with `replayed: true`; same key + different hash → `idempotency_conflict`. Unique index (`created_by`, `idempotency_key`) is the backstop under concurrency (tested with two real sessions). Jobs use `dedupe_key`; handover decisions are idempotent per state.

**Corrections from review R4:**
- Concurrency: the create path is `insert … on conflict (created_by, idempotency_key) do nothing returning id`; on no row, re-select the existing record and compare `request_hash`. A plain insert would surface a raw `23505` to the second of two concurrent identical requests instead of a replay.
- `request_hash` is computed **server-side** from the canonical `jsonb` (key order is normalized by `jsonb`), excluding `idempotency_key` and client timestamps. Clients never send a hash.
- A replay after the record was edited returns the record's **current** state with `replayed: true`, not the original payload.
- `relay_handover_create` and `relay_attach_sources` also take an `idempotency_key` (a batch handover retried after a timeout must not create a second batch). Transitions and updates are protected by `expected_version` instead.
- Keys are retained for the record's lifetime; no expiry is needed at this volume (§0: 540 messages total).

---

## 11. Browser extension readiness (future phase)

### 11.1 Flow
User selects text → context menu "إضافة إلى Mad3oom Relay" → extension popup with the three types → `browser-selection` adapter builds `{url, page_title, excerpt}` → `POST /v1/records/lookup` (shows "already tracked" if so) → draft hints → user edits and confirms → `POST /v1/records` with an idempotency key → link to the record in the native Relay page for all later work.

### 11.2 Authentication and account linking
- **Reuse the existing OAuth 2.1 server**, authorization code + PKCE (already mandatory), public client (`token_endpoint_auth_method: none`).
- **Pre-registered first-party client**, not DCR: fixed `client_id`, redirect URI `https://<extension-id>.chromiumapp.org/relay` (HTTPS, already accepted by the registration rules), via `chrome.identity.launchWebAuthFlow`. The consent screen (`admin/oauth-consent.html` / `auth-consent.html`) names the extension and the scopes.
- **Scopes:** `relay:read`, `relay:write`; inserted into `oauth_scopes` (verified: `oauth-authorize-approve` only grants scopes present there) and added to `api_token_scope_ceiling()` for platform staff and company members. No other scopes granted to this client. Scope is coarse on purpose: authorization stays in SQL, so a customer holding `relay:write` still cannot touch any record.
- **Token lifecycle:** access 1h (existing), refresh 30d with rotation (existing). Before launch, harden `oauth-token`: refresh-token reuse detection (revoke the family when a rotated token is reused) and make rotation atomic (today it reads, then revokes, then issues, so two concurrent refreshes can both succeed).
- **Revocation:** the existing connected-apps page revokes the client; `relay-api` checks `is_active`/`revoked_at`/`expires_at` on every call (existing `verifyApiToken`).
- **Why not reuse the Mad3oom web session:** it would need `cookies` or host permissions on Mad3oom's origin and would expose a full-power Supabase session to the extension. A scoped, separately revocable token is safer.
- **Account/workspace linking:** the token belongs to a user; the workspace is resolved server-side from that user's relations on every call. A user in several workspaces picks one per request from `GET /v1/workspaces` (list derived server-side); the server re-checks membership.

### 11.3 Extension security requirements
- Manifest V3; permissions `activeTab`, `contextMenus`, `identity`, `scripting`, `storage`; **no** `<all_urls>` host permission; content script injected only on user action.
- Captures only the user's selection, URL and title; no DOM scraping, no background capture.
- Content script never holds tokens; the service worker makes API calls. Tokens in `chrome.storage.session` (access) and `chrome.storage.local` (refresh) — documented trade-off; no source content persisted (drafts kept in memory only).
- All page content treated as untrusted: rendered as text, never HTML; sent as data; server validates and size-limits.
- CSRF: bearer token in `Authorization`, no cookies, so classic CSRF does not apply; `relay-api` CORS allows only the extension origin and Mad3oom origins; rejects requests without a bearer.
- Rate limits: per token (reuse the 60/min pattern) + per-user creation cap (e.g. 120 records/hour) enforced in SQL.
- No service-role keys or Supabase anon writes from the extension; it never talks to PostgREST directly.

---

## 12. Security and tenant isolation

- `relay_can_access(record)`: platform workspace → supervisor sees all; staff see records they own, created, are pending handover target of, or whose team they belong to. Company workspace → company admin sees all; members see owned/created/targeted/team records. Customers: no policy on any `relay_*` table.
- RLS: SELECT-only policies via `relay_can_access`; sources/snapshots/events/handovers inherit through `record_id` + denormalized `workspace_id`; RESTRICTIVE `gate_account_active`; `trg_preview_read_only`.
- `workspace_id`, `created_by`, `created_via` always server-derived. Client-supplied tenant ids are ignored.
- Platform owner through `relay-api` is treated as plain staff, never supervisor (§10.4 R2-2).
- A user who is both platform staff and a company member gets two workspaces; each request names one and the server re-checks it.
- Every write RPC: `account_is_active()`, access check, `version` check, event in the same transaction.
- `relay_tick`, `relay_api_invoke`: `revoke all … from public, anon, authenticated`.
- AI output (later): schema-validated, provenance-tagged, never auto-confirmed.
- **Excerpt visibility (C3, revised):** a Mad3oom-sourced excerpt is returned only when, on that read, **all** hold: the caller passes `relay_can_access(record)`; `account_is_active()` (covers inactive and banned); not in preview mode; the record is in the platform workspace (C1); `origin_session_id` is present, the session row exists and belongs to the platform inbox; the caller passes `_relay_can_read_conversation(origin_session_id)`; the excerpt is not redacted and not past the C5 deadline. `_relay_can_read_conversation` = `inbox_can_access(session)`, except for a platform owner calling through `relay-api`, where it requires direct assignment/team (`_inbox_is_assigned`) because owner context is per user, not per session (§10.4 R2-2). Any error or unknown input returns hidden (fail closed).
- Previous owners lose record access after an accepted handover unless they are the creator, on the record's team, or a supervisor; even then, excerpts still need conversation access.
- **Background jobs** run without `auth.uid()`; they never read or return excerpts to anyone, only redact or stamp them, each statement filtered by record id and workspace (§25, M7).
- Tests prove: cross-workspace reads/writes fail by id, unauthorized reassign fails, customer sees nothing, preview mode cannot write, banned/inactive accounts cannot write, and the C3/C4/C5 rules in §17.

---

## 13. Privacy and source lifecycle

- **Store excerpts, not conversations.** Only the user-selected text is snapshotted, capped at 4000 chars per source; for Mad3oom messages the server copies only the selected messages.
- **Is a snapshot necessary?** Yes, for two reasons that survive the C3 revision: it preserves what was selected when the source is later edited or deleted (C4), and future external sources cannot be fetched again. Under revised C3 it no longer shares context with people who cannot open the conversation.
- **Sensitive data:** UI warns before saving excerpts that look like card numbers, OTPs, passwords or national IDs and offers to trim; the server repeats the same pattern check and rejects a create that contains a match unless the request carries `sensitive_ack: true` (logged as an event flag, not content) (M1). `sender_label` holds a role label only.
- **Retention (decision C5):** excerpts of a record are redacted **365 days after `closed_at`**, fixed (`snapshot_retention_days = 365` by CHECK). Enforced twice: the read path hides them at the deadline (M6), and the daily sweep redacts them physically (M7). References, hashes and events remain. The ticket setting `advanced_settings.data_retention.ticket_retention_days` is not reused. Active records keep excerpts indefinitely (only closure starts the clock).
- **Deleted origin (decision C4):** excerpts are retained after the source message is deleted, marked `source_deleted_at`, and still subject to C5 and manual redaction.
- **Free text outside snapshots:** title, summary, next action and notes are user-written and are **not** covered by C5. To stop machine-copied excerpt text from escaping retention, extraction never pre-fills them with excerpt text (§16, M5). Text a user types or pastes there stays until the record is edited; this is a documented residual risk (§25).
- **User removal:** owner/creator/supervisor can redact a snapshot with a reason at any time; the record, references and audit remain. Deleting a whole record is not offered; cancel instead. Data-deletion requests use `relay_redact_for_subject` (M8).
- **Audit vs content:** events never contain excerpt text, so redaction is complete and audit stays intact.
- **Permissions on sources:** record access to see that a source exists; record access **plus current conversation access** to see a Mad3oom excerpt (C3 revised, §12); a provider-specific rule for any future provider (§9).
- **Free text and C3:** title, summary, next action and notes are visible to every record viewer. Text copied into them from a conversation is therefore readable without conversation access. Extraction never copies message text into them (M5); text a user types or pastes is residual risk U2.
- **Backups:** Supabase backups / point-in-time recovery keep data for their own window; redaction does not reach backups. No claim of erasure from backups is made.
- **Usability without source:** a record never depends on a source being reachable; title, summary, next action and history live on the record.

---

## 14. Scheduling, reminders, escalation

- On create/reschedule/assign/handover, the RPC replaces the record's pending jobs atomically: `due_reminder` at `due_at - reminder_lead`, `overdue_alert` at `due_at`, `handover_reminder` at `created + N`, `escalation` at `due_at + escalate_after` or handover `created + escalate_after`.
- `relay_tick()` every minute: `select … where state='pending' and run_at <= now() for update skip locked limit 200`; re-validates (record still active, still due, owner still valid); writes a `notifications` row (`open_relay_record`), marks `done`, logs event. Failure → `attempts+1`, backoff (1, 5, 15 min), `failed` after 3 with `last_error`, event, and monitor entry. Exits immediately when nothing is due (index on `run_at`).
- Dedupe: `dedupe_key` = `record:kind:run_at-bucket`; one notification per job.
- Timezones: due times stored as `timestamptz` + IANA zone; display in the viewer's zone with the record's zone shown when different.

**Corrections from review R5:**
- **Per-job isolation.** Each job runs in its own `begin … exception when others … end` block inside the loop, exactly as `inbox_dispatch_scheduled` does (058). Without it, one bad job rolls back the whole batch and every reminder in it.
- **What "notification failure" means here.** Phase 1 delivers only in-app `notifications` rows (same transaction). A failure is therefore a re-validation failure (owner ineligible, record gone, recipient banned) or a database error, not a transport failure. External delivery (email/Telegram/WhatsApp) is out of Phase 1; if added it goes through `pg_net` with its own delivery row, never marking success at enqueue time (the defect the audit found in `dispatch_ticket_webhooks`).
- **Late jobs after downtime.** A `due_reminder` processed after `due_at` is skipped (`done`, reason `superseded`) because the overdue alert covers it; escalations still fire. No burst of stale reminders after a cron outage.
- **Lifecycle coupling.** Resolve/cancel cancels all pending jobs; reassign and accepted handover re-target them; reopen re-creates them from `due_at`.
- **Cron health.** The monitor shows a platform-level warning when the last successful `relay_tick` is older than 5 minutes (from `cron.job_run_details`, read through a definer function).
- **DST.** Egypt observes DST again since 2023. A local due time that does not exist (spring-forward gap) is rejected with a validation error; an ambiguous time (fall-back) resolves to the earlier instant. Both have unit and SQL tests.
- **Retention and deletion sweeps (daily branch of `relay_tick`, M7).** (a) Stamp `source_deleted_at` on snapshots whose `chat_message_id` now has `deleted_at` and send the M3 notice; (b) redact excerpts where `record.closed_at <= now() - 365 days` and `redacted_at is null`, `limit 500` per run, each batch in its own exception block, logging one `source_redacted` event per source. Both are `update`-only on `relay_source_snapshots`, never `delete`, never touch other tables' content, and are idempotent.
- **Escalation recipients.** `escalation_team_id` members, else workspace supervisors. With 0 inbox teams in prod today (§0), the default is supervisors.

---

## 15. Continuity monitor

`relay_monitor(filters)` returns flagged records, each with machine `reason` codes and a direct action:
`retention_overdue` (excerpts past `closed_at + 365d` still unredacted > 24h, platform-level, supervisors only) · `unassigned` · `no_next_action` · `overdue` · `handover_pending` (with age) · `handover_clarification_requested` · `job_failed` · `blocked` (waiting longer than threshold) · `follow_up_without_due` · `owner_inactive` (owner banned/inactive/no longer staff).
Severity separates failures (`overdue`, `job_failed`, `owner_inactive`, `unassigned`) from incompleteness (`no_next_action`). Filters: owner, team, kind, status, due range, priority.

---

## 16. Context extraction

- **Phase C (deterministic):** **title and summary are not pre-filled with message text** (revised C3: they are visible to record viewers who may not open the conversation; the title field shows a placeholder by record type) (the preview shows the excerpts as sources; the user writes the summary) so retention under C5 is not bypassed (M5); explicit date/time literals detected in Arabic and English ("بكرة الساعة ١٠", "10/10 10am") proposed as `explicit` with the source message cited; owner never proposed; `missing[]` lists required fields; manual fallback always available.
- **Later (flagged, `relay_ai_extraction`):** `relay-extract` Edge Function → `ai-gateway`; messages passed as quoted data with a fixed system prompt; output validated against a strict JSON schema; any field without a cited source id is dropped; values tagged `explicit` | `inferred`; inferred deadlines/owners never pre-filled as confirmed.

---

## 17. Testing strategy

- **Model unit tests** (`tests/relay-*.test.mjs`): contract validation, state-machine mirror, deadline + timezone parsing (DST), extraction never-invent rules, missing-field detection, dedupe-key computation, URL canonicalization, adapter output shape.
- **SQL tests** (`tests/sql/relay-*.test.sql`, on the prod-shape fixture already on `main`): workspace isolation by id, conversation-access rule for message sources, customer/preview/inactive denial, idempotency (sequential and two concurrent sessions), version conflicts, every allowed and forbidden transition, resolve without note rejected, handover accept/clarify/decline/never-accepted, previous owner retained, tick under two overlapping sessions sends once, reschedule cancels jobs, failed notification visible and retried, retention redaction keeps hashes/events, events immutable, `relay_api_invoke` claim propagation and grants, migration re-run and rollback.
- **Render tests** (Playwright + fakes, desktop + 390px RTL): select messages, choose type, edit preview, double-click creates once, error shows error, record detail, handover accept, monitor reasons.
- **`relay-api` tests:** request mapping, scope enforcement, error mapping, CORS, size limits (Deno tests; first Edge Function with behavioral tests, closing an audit gap).
- **Added by the review (§23, must exist before the phase that needs them):** concurrent create with the same key returns a replay, not `23505` (B); target-owner eligibility for banned/inactive/non-staff users (B); message source from another workspace rejected (B); deleted source message ⇒ snapshot redacted per C4 (B); handover decline/cancel restores `prior_status` and owner (D); reassign cancels open handover (D); first-accept-wins for team handovers (D); one failing job does not roll back the batch (E); late `due_reminder` after downtime is superseded (E); DST gap rejected / overlap resolves earlier (E); cron-health warning (E); stale `request.jwt.claim.sub` cannot override the propagated actor and owner-through-API is plain staff (G).
- **Decision tests for C1/C3/C4/C5 and controls M1–M11 (all proposed, none executed):**
  - C1: any RPC with a company workspace returns `feature_not_enabled`; no company workspace row exists after migration.
  - C3 (revised), each against `relay_get` and the `relay-api` path: record access **with** conversation access ⇒ excerpt returned; record access **without** conversation access ⇒ record returned, excerpt placeholder with no text, sender, timestamps or hash; conversation access **revoked after creation** (unassign, team removal) ⇒ next read hides it; creator who later loses conversation access ⇒ hidden; **after handover or reassignment** to someone outside the conversation ⇒ new owner sees placeholder, and sees the excerpt once assigned to the conversation; supervisor ⇒ excerpt; owner through `relay-api` with dashboard context `admin` but no assignment ⇒ hidden; banned/inactive/preview/customer ⇒ nothing; **unresolvable authorization context** (session row deleted, `origin_session_id` null, check raises) ⇒ hidden for everyone including supervisors.
  - C3 leak paths: `relay_list`, `relay_monitor`, `relay_events_for`, notifications and `relay_find_by_source` never return excerpt text, sender label or hash (seeded marker string search); `relay_find_by_source` on a message the caller cannot access returns empty; a non-Mad3oom provider without a rule returns `no_provider_rule`.
  - C4: deleting a quoted staff reply keeps the excerpt in storage and the sweep stamps `source_deleted_at`; **deleted source with current conversation access** ⇒ excerpt shown with the deleted label; **deleted source without conversation access** ⇒ placeholder; M3 notice is sent once (idempotent on re-run).
  - C5: record closed 364 days ago keeps excerpt; 365 days + 1 minute is hidden by `relay_get` before the sweep runs (M6) and redacted after it (M7); reopen before the deadline cancels it; re-close restarts the clock; reopen after redaction keeps it redacted; active records are never redacted; `snapshot_retention_days` cannot be set to anything but 365.
  - Sweep isolation (M7): seeded records in two workspaces plus active and recently closed records, only due excerpts change; the sweep never deletes rows, never updates other tables, is idempotent on a second run, one failing row does not stop the batch.
  - M4/M5: `relay_list`, `relay_monitor`, `relay_find_by_source`, events and notifications contain no excerpt text and no free-text values (assert by searching payloads for a marker string seeded in the excerpt and title).
  - M1: create with a card-number-like excerpt fails without `sensitive_ack`, succeeds with it, and the event records only the flag.
  - M8: `relay_redact_for_subject` redacts only excerpts from that customer's sessions, is supervisor-only, and leaves other customers' excerpts untouched.
  - M10: no RPC can restore a redacted excerpt; redaction event has actor, time and reason.
- **Staging smoke:** `scripts/prod-smoke/relay.mjs` covering the 11-step journey.
- Results reported as executed commands and real totals.

---

## 18. Phased implementation plan

Each phase is one PR with its migration, rollback file, tests, and a production-install note; production apply only after explicit approval.

**Gates:**
- **Phase B may start only when** (1) decisions C1, C3 (revised), C4, C5 are recorded (done, §24), (2) Mahmoud explicitly approves this plan, and (3) the migration number is re-checked against `origin/main`, open PRs and `list_migrations`. Recording decisions is not approval.
- **Phase B must include** the revised C3 excerpt check (M11) and controls M1, M4–M8 and M10 in the schema/RPCs, with the tests in §17. M2–M3 need the sweep and land in Phase E, but the `source_deleted_at` column ships in B.
- **Owner instruction (2026-10-09 11:22 UTC):** C5 must ship with "the specified daily sweep and actual content removal, not merely a UI mask". The retention sweep (M7) therefore moved from Phase E into Phase B as its own daily `pg_cron` job (`relay-retention-sweep`). Deleted-source stamping and the M3 notice stay in Phase E.
- **Phase C** needed the reference screenshots (received 2026-10-09) and the permission decisions P1–P4 (§27). **Phase D** needs C2. **Phase G** needs C6 and the `oauth-token` hardening.
- **Production apply of any phase** needs a separate explicit approval.

| Phase | Content | Migration |
|---|---|---|
| **A** Design sign-off | This document; approval checklist §24; screenshots | — |
| **B** Core persistence + security | platform workspace only (C1); records, sources, snapshots (`origin_session_id`, C4 fields), per-read excerpt check (C3 revised, M11), events (M5); `relay_can_access`; create/get/list/update/assign/transition/attach/redact/redact_for_subject/find_by_source; read-path retention mask (M6); idempotency; contract module; SQL tests | `0NN_relay_core.sql` (first free number, currently `073`) |
| **C** Native selection + conversion | inbox selection dialog, type preview (9 categories), details step, deterministic suggestions, record detail, Relay page, sidebar; server-side assignment rules P3–P4 and the category column (§27) | `074_relay_phase_c.sql` (was "frontend only"; P3–P4 need server enforcement) |
| **D** Lifecycle + handover | handover tables/RPCs, acceptance policy, end-of-shift bundle, timeline, handover tab | next free number |
| **E** Scheduling + monitor | `relay_jobs`, `relay_tick`, cron job, notifications (M4), escalation, deleted-source stamping + notice (M2–M3), retention sweep (M7), monitor incl. `retention_overdue` | next free number |
| **F** Verification + release | full suite, advisors, `EXPLAIN` on list/monitor, mobile RTL pass, staging smoke, install doc | — |
| **G** External API (extension-ready) | `relay-api` Edge Function, `relay_api_invoke`, `relay:*` scopes, OAuth refresh hardening, Deno tests | next free number |
| **H** Browser extension | MV3 extension, `browser-selection` adapter, first-party OAuth client, store listing | — |
| **Later** | AI extraction, company-workspace UI, ticket/email/CRM adapters, shift-aware automation once a schedule source exists | — |

Phase B ships the source model in full, so G and H add a door and a client, not a schema redesign.

---

## 19. Migration and rollback strategy

- Additive only; no changes to `chat_*`, `tickets`, `profiles`; re-runnable (`if not exists`, guarded `do` blocks).
- Precondition block per migration (functions/tables it relies on), as in 055/058.
- Verify production definitions read-only before applying (`chat_messages` columns, `inbox_can_access`, `notifications` columns, `companies`), because of schema drift (A9).
- Rollback files in `migrations/_rollback/0NN_relay_*.down.sql`, tested (apply → rollback → re-apply).
- Numbering: PR #104 already claims `071` (applied in prod) and `072_invoice_pdf_attachment` (not applied). Relay takes the first free number when its PR opens and re-checks `list_migrations` right before any production apply.
- Cron job registration guarded like 058; rollback unschedules it.

---

## 20. Risks

| Risk | Mitigation |
|---|---|
| Regressions in the inbox (`inbox.js` is ~1.9k lines) | New code in `assets/js/relay/`; inbox touched only for the toggle and hooks; existing inbox render tests must stay green. |
| Schema drift vs production | Read-only verification and pinned preconditions; prod-shape fixture. |
| Identity propagation via local JWT claims behaves differently than expected | Dedicated SQL test before Phase G; fall back to actor-parameterized internal functions if it fails. |
| OAuth refresh race / no reuse detection | Hardening in Phase G before any extension release. |
| Excerpts copy customer content into another table and, by C4, outlive source deletion in storage | Revised C3 per-read conversation check, controls M1–M11 and residual risks in §25. |
| Cron load | One job, indexed, early exit. |
| Workspace confusion for users in several workspaces | Server-derived workspace list; explicit picker. |
| Over-scoping | Phase gates; extension and AI explicitly later. |

---

## 21. Decisions

Superseded by the approval checklist in §24 (earlier D1–D6 are folded into C1–C8 there).

---

## 22. Acceptance criteria

Relay Phase 1 is accepted only when, with evidence:
- A user selects multiple existing messages and creates each of the three record types.
- Source references and snapshots are traceable; edited/deleted sources behave per §8.5.
- Phase 1 works only in the platform workspace; company workspaces are rejected (C1).
- A Mad3oom excerpt is shown only to a viewer with record access **and** current access to the original conversation, re-checked on every read; everyone else gets a placeholder; unverifiable context fails closed; no list, lookup, event, notification or API path reveals it (C3 revised).
- Excerpts survive deletion of the source message in storage and are marked as deleted at source; visibility still follows C3 (C4).
- Excerpts are hidden at `closed_at + 365 days` on the read path and physically redacted by the sweep; reopen/re-close follow §8.5 (C5).
- Controls M1–M11 are implemented and each has a passing test, with commands and totals reported.
- Extracted values are editable before confirmation; missing critical fields are explicit.
- Records persist across sessions; ownership and transitions are enforced server-side.
- Handover preserves context and history; never-accepted handovers stay visible.
- Due and overdue work is detected by the backend; failed jobs are visible and retryable.
- Duplicate creates are prevented under retries and concurrency.
- Unauthorized and cross-workspace access is rejected (SQL tests).
- The reference interaction works on 390px RTL.
- Existing Mad3oom tests stay green; the canonical contract is documented and the same RPCs are callable via `relay-api` in Phase G without schema change.
- Each status is reported separately: implemented, tested, deployed, verified in production.

---

## 23. Pre-implementation review (2026-10-09)

Scope: the areas Mahmoud asked to be checked. Each finding says whether it was a defect in the earlier draft, where it is now corrected, and what still blocks.

### 23.1 Defects found in the earlier draft (now corrected in this file)
| # | Area | Defect | Evidence | Correction |
|---|---|---|---|---|
| R1 | Baseline | Said Relay starts at `072`, the prod-shape fixture comes from #104, and Mad3oom has no shift data. All three were wrong. | §0 ([gh], [prod], [repo]) | §0, A9, A12, §18, §19 |
| R2 | Identity propagation | Setting only `request.jwt.claims` can be overridden by `request.jwt.claim.sub` (prod `auth.uid()` reads it first); owner context is per user, so an owner using the extension inherits their dashboard context. | prod `auth.uid()`; 038 `active_context()` | §10.4 corrections 1–5, §12 |
| R3 | Authorization | Assign/handover validated the target with caller-only helpers (`is_platform_staff()`), which cannot answer for another user. | 040 `is_platform_staff()` uses `auth.uid()` | §6.1 `_relay_is_eligible_owner` |
| R4 | Idempotency | Plain insert + unique index returns a raw `23505` to the second of two concurrent identical requests; handover batches had no key. | design reading | §10.7 corrections |
| R5 | Scheduling | No per-job isolation, stale reminders after downtime, DST undefined, "notification failure" undefined. | 058 dispatcher pattern; Egypt DST | §14 corrections |
| R6 | Handover | Owner during a pending handover, decline/cancel outcome, team acceptance and reassign-during-handover were undefined; `kind = handover` vs handing over any record was ambiguous. | design reading | §7 handover semantics |
| R7 | Privacy | Snapshots keep text a staff member deleted with `inbox_delete_message`. | 056 delete blanks the row | Decided by C4 (retain in storage); visibility limited by revised C3; §25 |
| R8 | Tenant isolation | Nothing stopped a Mad3oom-message source from being attached to a company-workspace record. | design reading | §8.5 new row |
| R9 | Retention | Reused `ticket_retention_days`, which is ticket-specific. | 035 `run_data_retention_cleanup` | §13; decided by C5 (365 days after close) |

### 23.2 Still blocking
| Blocks | Item | Needed |
|---|---|---|
| Phase B | Explicit approval of this plan (C1, C3 revised, C4, C5 are recorded) | Mahmoud's approval |
| ~~Phase C~~ | ~~The two reference screenshots~~ | Received 2026-10-09; see §27 |
| Phase D | Decision C2 (acceptance default) | §24 |
| Phase G | OAuth refresh rotation is read-then-revoke (two concurrent refreshes can both succeed) and reused refresh tokens are not detected | Fix in `oauth-token` before any extension ships; it is shared with MCP, so it is its own PR |
| Phase G | Decision C6 (owner via extension) | §24 |

No defect found that requires changing the existing Mad3oom architecture; every correction is inside Relay's own design or in Phase G hardening.

### 23.3 Verified vs assumed
- **Verified:** everything labelled [repo]/[prod]/[gh] in §0; 058 per-item `exception` blocks; `oauth-authorize-approve` grants only scopes present in `oauth_scopes`; `oauth-token` rotation code path; `notifications` has no category/action CHECK.
- **Assumed, to verify in the phase that depends on it:** PostgREST no longer sets `request.jwt.claim.sub` (G); `cron.job_run_details` is readable from a definer function in this project (E); Chrome `launchWebAuthFlow` redirect `https://<id>.chromiumapp.org/` passes `oauth-register`'s HTTPS check for a pre-registered client (G); main's CI is green (not readable in this session).
- **Not tested:** nothing in this plan is implemented, so nothing is tested.

---

## 24. Approval checklist (product-owner decisions only)

Engineering choices that do not change what users get (RPC layout, idempotency mechanics, job isolation, OAuth reuse) and the mandatory controls M1–M11 (§25) are not product decisions; they follow the plan unless you object.

### 24.1 Recorded decisions (Mahmoud, 2026-10-09 11:00 UTC)
| # | Decision | Where it is applied |
|---|---|---|
| **C1** | Phase 1 supports the platform support inbox only; company support comes later. | §2, §6.1, §12, §17, §18, §22 |
| **C3 (revised 11:13 UTC)** | A user must have **current** authorization to the original conversation (`inbox_can_access`) to see an excerpt sourced from it; record access alone is insufficient. Re-checked on every read; fails closed. Replaces the 11:00 version (record access was enough). | §8.3, §8.5, §9, §10.2, §12, §13, §16, §17, §22, §25 |
| **C4** | The selected excerpt is retained in storage after the source message is deleted; its visibility follows C3. | §8.3, §8.5, §13, §14, §17, §22, §25 |
| **C5** | Excerpts are redacted automatically 365 days after the record is closed. | §6.1, §6.2, §8.5, §13, §14, §15, §17, §22, §25 |

### 24.2 Still open
| # | Decision | Recommended default | Practical consequence | Needed before |
|---|---|---|---|---|
| C2 | Must the new owner accept a handover? | Yes by default, switchable per workspace | Work stays with the previous owner until accepted; unaccepted handovers remind and escalate. | Phase D |
| C6 | Platform owner using the future extension | Acts as plain staff; supervisor actions only in the web app | The extension's power never changes with your dashboard context; no supervising from the extension. | Phase G |
| C7 | Use `emp_ops` shift schedules for automatic end-of-shift handovers | Not in Phase 1 (prod has 0 shift assignments) | End-of-shift handovers are started by the employee. | Later |
| C8 | AI-assisted extraction | Not in Phase 1 | No AI cost or risk at launch; staff type a little more in the preview. | Later |

### 24.3 Optional product choices (defaults apply unless you change them)
| # | Choice | Default | Consequence of the default |
|---|---|---|---|
| O1 | Log every view of an excerpt whose source was deleted | Off | Lower volume and complexity; you can see who changed or redacted an excerpt, not who read it. |
| O2 | ~~Extension API and deleted-source excerpts~~ | Withdrawn: revised C3 applies the same per-read conversation check on every path. | — |
| O5 | When handing over or reassigning to someone who cannot open the source conversation, offer to also assign them (or their team) to that conversation | On: a prompt in the handover dialog, using the existing `inbox_assign` and its own permission checks; never automatic | The new owner gets the context only if the person handing over is allowed to assign the conversation; otherwise they see placeholders. |
| O3 | Let the staff member who deleted a message redact its excerpts without having record access | No; they get a notice (M3) and ask a supervisor | Keeps record access rules intact; one extra step for them. |
| O4 | Flag active records idle for 180+ days so their excerpts don't live forever (C5 only starts at close) | On, as a monitor item only (no automatic action) | Supervisors see stale records to close or redact. |

Phase B starts only after you explicitly approve this plan. Recording or revising C1, C3, C4 and C5 is not that approval.

---

## 25. Security and privacy review of C1, C3 (revised), C4, C5 (2026-10-09, updated 11:13 UTC)

Scope: whether retained excerpts can expose sensitive information after conversation access is lost or the origin message is deleted; who can see them; deletion, minimization and audit; lifecycle; enforceability of the 365-day rule; and residual risks. Facts marked §0 were read from the repo or production (read-only). No legal compliance is claimed.

### 25.1 What C3 and C4 change compared with today
- Today, deleted support replies survive only in `chat_message_revisions`, readable by inbox agents **who can access that conversation** (verified policy `inbox_is_agent() and inbox_can_access(session_id)`). Customer, bot and SIE messages cannot be deleted at all (§0).
- **Revised C3 (11:13 UTC)** requires current conversation access for every excerpt read. A retained excerpt of a deleted reply (C4) is therefore visible only to people who can already read the same text in `chat_message_revisions` under the same `inbox_can_access` rule. Relay no longer widens the audience of conversation content through excerpts. The earlier version of C3 (record access sufficient) did widen it; that exposure (old U1) is removed by the revision.
- What record viewers without conversation access can still learn: that a record has N sources from a conversation they cannot open (placeholder), and anything users wrote into title/summary/notes (U2).
- C1 limits all of this to the platform workspace and platform staff; no company or customer can read any `relay_*` row.

### 25.2 Who can view an excerpt (normative)
An excerpt is returned only by `relay_get(record)` and only when **all** hold, evaluated on every read: caller passes `relay_can_access(record)`; account active and not banned (`account_is_active()`); not in preview mode; the record is in the platform workspace (C1); `origin_session_id` is present and the session exists; the caller **currently** passes `_relay_can_read_conversation(origin_session_id)` (= `inbox_can_access`, with the owner-through-API restriction in §12); the excerpt is not redacted and `now() < closed_at + 365 days` (or the record is active). Anything else returns a placeholder; any error returns a placeholder (fail closed). Workspace and tenant isolation are enforced in SQL by `workspace_id` on records, sources and snapshots and by `relay_can_access`; client-supplied workspace ids are ignored (§12).

### 25.3 Mandatory security controls (must ship; not product choices)
| # | Control | Why | Phase |
|---|---|---|---|
| M1 | Server-side sensitive-pattern check (card numbers, OTP-like codes, passwords, national IDs) on excerpts; create rejected unless `sensitive_ack: true`; event stores only the flag. | Defense in depth: excerpts are a second copy of conversation content, retained after deletion (C4). | B |
| M2 | `source_deleted_at` stamped by sweep; detail view labels the excerpt as deleted at source with the date. | Viewers must know the text was withdrawn at its origin. | B (column), E (sweep) |
| M3 | When a quoted message is deleted, the deleting staff member and supervisors get one in-app notice: "quoted in N records" with a link; idempotent. | Gives a human the chance to redact under C4 instead of silent retention. | E |
| M4 | Excerpt text, sender label and excerpt hash only in `relay_get`, per source that passes M11; never in list, monitor, lookup, events, notifications, logs, API error bodies or caches. Notifications contain record kind and due time, not title or excerpt. `relay_find_by_source` on a Mad3oom source requires conversation access. | Closes alternative paths around the C3 check. | B, E |
| M5 | Events store hashes, not values, for free-text fields; extraction never pre-fills title or summary with message text. | Otherwise copies escape C5 retention and bypass the C3 conversation check (title/summary are visible to all record viewers). | B, C |
| M6 | Read-path mask: `relay_get` returns `excerpt = null, retention_expired = true` when `closed_at + 365 days <= now()`, even if the sweep has not run. | Makes C5 effective for every reader even if cron is down. | B |
| M7 | Retention sweep: `SECURITY DEFINER`, cron-only (revoked from all roles), update-only on `relay_source_snapshots`, filtered per row by `record.closed_at` and `workspace_id`, batched with per-batch exception blocks, idempotent, one event per redaction; monitor `retention_overdue` if anything is > 24h late. | The job runs without `auth.uid()`; it must not touch unrelated workspaces, active records or other tables, and failures must be visible. | B (sweep, per owner instruction §18), E (monitor item) |
| M8 | `relay_redact_for_subject(customer, reason)` (supervisor-only, native-only) plus a step in the manual data-deletion runbook. | `data-deletion.html` promises deletion within 30 days on request; Relay copies must be included. | B |
| M9 | Previous owners lose record access after an accepted handover unless creator/team/supervisor; no bulk export endpoint in Phase 1. | Least privilege for retained content. | B, D |
| M10 | Redaction irreversible and audited (actor or system, time, reason, hash). | Deletion must mean deletion; audit must survive it. | B |
| M11 | Per-read excerpt check (C3 revised): `_relay_can_read_conversation(origin_session_id)` evaluated in `relay_get` for each Mad3oom source, never cached or taken from creation time; session must exist; fail closed on null, missing row or error; owner through `relay-api` needs direct assignment; non-Mad3oom providers hidden until they have an approved rule (§9). | Makes conversation authorization, not record authorization, the gate for conversation content. | B (native), G (API) |

### 25.4 Lifecycle behavior
See §8.5 for the full table (deleted source, access lost, closed, reopened before/after redaction, retention reached, data-deletion request).

### 25.5 Is the 365-day rule enforceable?
- **Yes for every application reader**, because of M6 (computed from `closed_at` on each read), independent of cron.
- **Physical removal** depends on `pg_cron` (verified active, §0); delays are surfaced by M7's monitor item. The sweep cannot widen access: it returns nothing to any user and only nulls excerpt columns.
- **Not enforceable for backups / point-in-time recovery**, which follow Supabase's own retention window. Not claimed.
- **Active records never expire** (C5 counts from closure). Mitigated by O4 if kept on.

### 25.6 Residual risks (unresolved, documented)
| # | Risk | Status |
|---|---|---|
| U1 | (Was: staff without conversation access could read deleted support replies through excerpts.) | **Removed** by revised C3 + M11. Residual: the same text stays readable to conversation-authorized staff via both Relay and `chat_message_revisions`, as it already is today. |
| U2 | Text that users type or paste into title/summary/notes is visible to every record viewer (bypassing the C3 conversation check) and is not covered by C5. | Open; M5 removes machine copies only; UI hint in the preview ("لا تنسخ نص المحادثة هنا"). A stronger control (e.g. scanning free text for overlap with the selected messages) would be a new decision. |
| U3 | Backups retain redacted content for the provider's window. | Open; outside Relay. |
| U4 | Legal: the privacy policy, terms and `data-deletion.html` were not reviewed for internal copies, the 365-day period or Egypt's Personal Data Protection Law (Law 151 of 2020). | Open; legal review recommended before production and before any company or external source. No compliance claim. |
| U5 | Excerpts of records that stay active indefinitely are never redacted. | Partly mitigated by O4. |
| U6 | Retention delay if `pg_cron` stops. | Readers protected by M6; physical delay visible via M7. |
| U7 | Revised C3 reduces handover usefulness: a new owner outside the conversation sees placeholders. | Product trade-off of the decision; O5 offers to assign the conversation through existing permissions. |
| U8 | Future providers have no authorization rule yet. | By design hidden by default (`no_provider_rule`); each provider's rule is a documented gate before its phase. |
| U9 | `inbox_can_access` returns true for supervisors on any non-null id, including a deleted session. | Mitigated in Relay by requiring the session row to exist (M11); not changed in the inbox itself. |

### 25.7 Validation performed for this revision
- **Executed (read-only):** `git fetch` / `rev-parse` / `status` / `ls-remote` / `ls-tree` on the repo; GitHub PR #104 read; Supabase `list_migrations` and read-only `SELECT`s for the facts in §0; a consistency check of this document (stale "recommended"/"open decision" wording for C1/C3/C4/C5, section cross-references, table column counts).
- **Not executed:** no unit, SQL, render or E2E tests were run for Relay because nothing is implemented. Every test in §17 is proposed.
- **11:13 UTC revision:** re-read the prod definition of `inbox_can_access` (supervisor branch does not check session existence, basis for U9/M11) and re-ran the document consistency check; no other new reads.

---

## 26. Phase B implementation record (2026-10-09)

Authorized by Mahmoud at 11:22 UTC: Phase B only. No production apply, no deploy, no merge and no enablement without separate approval.

### 26.1 What shipped
- `migrations/073_relay_core.sql` and `migrations/_rollback/073_relay_core.down.sql`.
- Tables: `relay_workspaces` (one `platform` row), `relay_records`, `relay_sources`, `relay_source_snapshots`, `relay_events`.
- Public RPCs (granted to `authenticated` only): `relay_create`, `relay_get`, `relay_list`, `relay_update`, `relay_assign`, `relay_transition`, `relay_attach_sources`, `relay_redact_source`, `relay_redact_for_subject`, `relay_find_by_source`, `relay_events_for`.
- Cron-only: `relay_retention_sweep()`, scheduled daily at 03:17 UTC when `pg_cron` exists.
- `assets/js/relay/relay-contract.js`: the pure, advisory contract module.
- Tests: `tests/sql/relay-core.test.sql` (prod-shape fixture) and `tests/relay-contract.test.mjs`.
- Production-install note: `docs/relay/RELAY_PHASE_B_PROD_INSTALL.md` (not executed).

### 26.2 Decisions taken while implementing (deviations from the text above)
| Topic | Implementation | Why |
|---|---|---|
| Kill switch | `relay_workspaces.enabled boolean default false`. Every public RPC returns `feature_not_enabled` (`0A000`) until it is turned on. | "Enabling Relay functionality for real users" needs separate approval. |
| Data-deletion redaction and sweep while disabled | `relay_redact_for_subject` and the sweep run even when `enabled = false`. | Deletion and retention must not depend on the feature flag. |
| Retention arithmetic | `closed_at + 365 × 24 hours`, not calendar days. | The result does not depend on the session time zone. |
| Reopen after the deadline, before the sweep | Reopening redacts the record's excerpts immediately (reason `retention`). | Otherwise reopening would clear `closed_at` and bring expired content back. |
| Placeholder code | The single code `no_conversation_access` covers no access, a missing session, a null `origin_session_id` and a check that errors. `no_provider_rule` is used for providers without an approved rule. | Prevents inferring whether a conversation still exists. |
| Deleted source (C4) | `source_deleted` and `source_deleted_at` are derived on read from `chat_messages.deleted_at`, or from the FK having been nulled. The column ships, but stamping stays in Phase E (M2). | Gives the C4 label now without the Phase E sweep and notice. |
| `relay_find_by_source` | Returns `[]` unless the caller passes the conversation check, so "untracked", "not found" and "not allowed" look identical. | M4 / C3. |
| M1 event | `sensitive_ack` events store only `{sensitive_ack: true}`, never the category. | Record viewers without conversation access must not learn what kind of content the excerpt holds. |
| M8 | A `data_subject_request` redaction is supervisor-only (native) and blocks new captures from that customer's conversations (`subject_redacted`). `relay_events_for` shows the reason only to supervisors (`not_shown` otherwise). | Stops re-capture right after a deletion request, and avoids telling record viewers that a request exists. |
| Owner via the API path | A request whose `request.jwt.claims` carries `relay_client` other than `native`, cannot be read, or is absent while a user id is present is treated as the API path: never a supervisor, and conversation access only through direct assignment. | R2-2 (owner context is per user); fail closed. |
| `service_role` | Revoked from every Relay table, sequence and function, including the public RPCs. | Supabase grants new objects to `service_role` by default; no path should skip the per-user checks. |
| Source types | Only `mad3oom_message` (adapter `mad3oom-inbox`) is accepted. Other types return `feature_not_enabled`. | Phase 1 adapter scope (§9). |
| Workspace settings columns | The handover, reminder and escalation settings from §6.1 are not created in B. | They belong to Phases D and E. |
| Handover | `kind = handover` and `ready_for_handover` return `feature_not_enabled`. | Phase D (C2 open). |
| Who may update or attach | Anyone who passes `relay_can_access` on an active record. Assign is limited to a supervisor, the current owner, or self-claiming an unassigned record. Transitions are limited to the owner or a supervisor. | §7 table. Worth confirming before Phase C. |

### 26.3 Residual risks added by implementation
- **U10:** `relay_redact_for_subject` matches by the customer id stored at capture time and by the customer's current sessions. Guest sessions (`user_id` null) cannot be targeted by customer and need a manual redaction per source.
- **U11:** Repeatedly reopening and closing a record before day 365 keeps restarting the clock (allowed by C5 as written). Every cycle is visible in events.
- **U12:** `relay_list` evaluates access for each row before it applies the limit. This is fine at today's volume (§0); revisit with `EXPLAIN` in Phase F.
- **U13:** `excerpt_sha256` is kept after redaction as audit evidence, per §8.3. It is never returned by any RPC or included in any event. A hash of very short or low-entropy text could still be brute-forced by anyone with direct database access.

### 26.4 Validation performed (local, disposable PostgreSQL 16 only)
Exact commands and totals are in the PR description. Production was used only read-only (`list_migrations`).

---

## 27. Phase C implementation record (2026-10-09)

Authorized by Mahmoud at 14:21 UTC: the selection and type-preview flow, the approved permissions below, tests and a reviewable PR. No merge, no production migration, no deploy, no production configuration or data change. Relay stays as it is in production (073 applied and enabled).

### 27.1 Permission decisions (normative)
| # | Rule | Where it is enforced |
|---|---|---|
| **P1** | Anyone who can view a Relay record may edit it. | `relay_update` (unchanged from 073: `relay_can_access` on an active record). |
| **P2** | Anyone who can view a Relay record may attach sources to it. Every attached message still needs current `inbox_can_access` on its conversation. Viewing a record never grants an excerpt (C3, M11 unchanged). | `relay_attach_sources` and `_relay_attach` (unchanged). |
| **P3** | Only supervisors and staff explicitly granted the assign privilege may create a record owned by someone else or tied to a team. Everyone else may create with owner = self or no owner, and no team. | `relay_create` in 074. The check runs before the eligibility check, so a refusal says nothing about the target (`42501`, detail `{"code":"forbidden","field":"owner_id"|"team_id"}`). |
| **P4** ("Restrict owners", 14:24 UTC) | On an existing record, a current owner without the privilege may set the owner only to themselves or to nobody, and cannot change the team. Claiming an unassigned record for yourself (team unchanged) stays allowed. Assigners may assign any eligible owner or team. | `relay_assign` in 074. |

The privilege is `_relay_can_assign()`: an active Relay member who is a supervisor (`_relay_is_supervisor`) or holds an active row in `relay_assigners`. Grants and revokes are supervisor-only (`relay_grant_assigner`, `relay_revoke_assigner`), only eligible owners can be granted, and history is kept (a revoke only sets `revoked_at`; one trigger blocks un-revoking and retargeting a row, another blocks `TRUNCATE`, and no role has direct table privileges). A banned or deactivated grantee loses the privilege through the existing account-active checks, because `_relay_is_member` fails for them.

### 27.2 What shipped
- `migrations/074_relay_phase_c.sql` and `migrations/_rollback/074_relay_phase_c.down.sql`.
- `relay_records.category`: nullable, one of nine values (`order_status`, `order_problem`, `general_inquiry`, `return_exchange`, `payment_billing`, `product_service`, `technical_issue`, `complaint`, `other`). It is returned by `relay_get`/`relay_list`, filterable in `relay_list`, editable with `relay_update`, and logged in events as a value (never message text).
- New RPCs (authenticated only): `relay_my_access`, `relay_list_assigners`, `relay_grant_assigner`, `relay_revoke_assigner`. `authenticated` can now execute 15 Relay RPCs.
- Inbox: a "سجل استمرارية" button on the open conversation (shown only when `relay_my_access` says member and enabled) opens a three-step dialog: select messages, type preview, details (new record, or attach to an existing one).
- `admin/relay.html`: list with status, owner and category filters; record detail with edit, assignment, transitions, sources, redaction and events; supervisor management of assigners. A sidebar link appears only when Relay is on and the caller is a member.
- Frontend modules: `assets/js/relay/relay-model.js` (pure), `relay-data.js` (RPC wrappers), `relay-composer.js`, `relay-page.js`, `relay-icons.js`, and `assets/css/relay.css`.
- Production install note: `docs/relay/RELAY_PHASE_C_PROD_INSTALL.md` (not executed).

### 27.3 Decisions taken while implementing
| Topic | Implementation | Why |
|---|---|---|
| Phase C needs a migration | 074 adds the category column and the P3–P4 rules. The plan had Phase C as frontend only. | The approved assignment rules must be enforced on the server. |
| Type suggestion | Deterministic keyword matching over the selected messages; generic categories weigh half. With no match nothing is pre-selected and the user must pick. The reason (matched words) is shown on demand. | No AI in Phase 1 (C8). The suggestion is never saved until confirmed. |
| Title, summary, next action | Never pre-filled from message text. The optional note from the type step (the user's own words) pre-fills the summary. | M5: events and record fields must not copy excerpts. |
| Due date | Only explicit dates and times written in a message are offered, anchored to that message's day in the chosen time zone. A missing time is flagged and defaults to 09:00; past candidates are shown but cannot be picked. | §16 deterministic extraction. |
| Owner default | The caller. Without the privilege the list holds only "me" and "no owner", and the team field is hidden. | P3; the server still decides. |
| Idempotency | The same payload reuses its idempotency key after an error; any change makes a new key. | A retry after a lost response returns the first record instead of a duplicate. |
| Sensitive content | If the selected messages look sensitive (M1 categories), creating or attaching needs an explicit acknowledgement. | M1, unchanged. |
| Before 074 is applied | `relay_my_access` does not exist, the client treats any error as "no access", and the button, page and sidebar link stay hidden or show a reason. | Merging the frontend before applying 074 cannot expose anything. |
| API path | A grant applies through the future `relay-api` too; supervisor status still does not (073 R2-2). | A grant belongs to the person, not to a dashboard context. Worth confirming before Phase G. |
| NULL-safe checks | The allow conditions in `relay_assign` and `_relay_can_assign` are wrapped in `coalesce(…, false)`, so an unknown value refuses. A no-change call on an unassigned record by a non-assigner is now refused instead of passing. | Closes the 073 hole in U18 and keeps a later edit from reopening it. |
| Rollback of `relay_assign` | The rollback restores the 073 text of `relay_assign` with one change: the same `coalesce` around its allow condition. The other four functions are restored word for word. | A rollback should not bring back a known hole. |

### 27.4 Residual risks
- **U14:** Never re-run `073_relay_core.sql` after 074. It would restore the Phase B versions of five functions (without P3–P4), and its own verification block would then fail on the 074 RPCs. The 074 header and the install note say so.
- **U15:** A revoked or banned assigner keeps the assignments they already made; revocation is not retroactive. A grant is inert while its holder is inactive or no longer eligible, but it is not revoked automatically and works again if the person is restored. Supervisors should revoke it when someone leaves. Grants cannot be revoked while Relay is switched off (they are inert then too).
- **U18 (in production now, found in the Phase C review):** in 073's `relay_assign`, on a record with no owner, `r.owner_id = auth.uid()` is NULL and `if not (…)` does not refuse. Anyone who can view an unassigned record (its creator or a member of its team) can assign it to any eligible owner or change its team. Reproduced on the prod-shape fixture (`HOLE-073` in `tests/sql/relay-phase-c.test.sql`); production was not touched. 074 closes it. Applying 074, or a one-line hotfix, is a production change that needs Mahmoud's approval.
- **U19:** If a record's team is archived, a non-assigner cannot claim or release it, because the team check rejects archived teams (same as 073). A supervisor or assigner can.
- **U16:** Category suggestion is keyword-based and Arabic-dialect coverage is partial; a wrong suggestion costs one click, and nothing is saved without confirmation.
- **U17:** The 390px and RTL checks run in headless Chromium only; Safari and Firefox were not tested.

### 27.5 Validation performed (local only)
Exact commands and totals are in the PR description. Production was not touched.

Status update: PR #107 was merged, and Mahmoud applied 074 to production at 15:20 UTC on 2026-10-09 (ledger `20261009152023`, verified). U18 is closed in production.

## 28. Trash and platform-owner control (076, 2026-10-09)

Mahmoud's request at 15:33 UTC asked for three things. A message removed from a record should go to a "deleted" section that supports undo. The platform owner's account should hold the strongest control over Relay. Confirmations should be in-page dialogs, which shipped separately in PR #110. At 15:39 UTC he chose "محذوفات + مسح للمالك". The migration is numbered 076 because `075_workspace_layouts.sql` already exists.

### 28.1 Rules (normative)
| # | Rule | Where it is enforced |
|---|---|---|
| **T1** | Anyone who can view a record may remove one of its sources, which moves it to المحذوفات, and may restore it. Both need an active (not closed) record and the current version. Removing hides nothing more than the source's place in the record: an excerpt in the trash is still shown only under C3, rechecked on every read. | `relay_remove_source`, `relay_restore_source`, `_relay_full` (`removed`), `relay_list_removed`. |
| **T2** | Permanent erase is owner-only and cannot be undone. It covers manual erase (`relay_redact_source(…, 'manual')`) and emptying the trash (`relay_purge_removed`, for one record or for all records). Erase redacts the snapshot and stamps `purged_at`. An erased source disappears from the record and the trash, cannot be restored or removed again, and cannot be re-captured, because the dedupe key still blocks it. | `_relay_is_owner()` in those RPCs. Trigger `trg_relay_source_trash_guard` blocks changing a purged row even for the superuser. |
| **T3** | Only the owner may grant, revoke or list the assign privilege. Before 076 supervisors could. Supervisors still assign records themselves (P3 and P4 are unchanged). | `_relay_require_owner()` in `relay_grant_assigner`, `relay_revoke_assigner` and `relay_list_assigners`. |

"Owner" means `public.is_platform_owner()`: an `owner` row in `platform_authority` and the `platform_owner` role. The check reads no email. The owner must also be an active Relay member, which means the admin context, and must not be calling through `relay-api`. `relay_my_access` now returns `owner`.

Unchanged:
- Data-subject requests (M8): `relay_redact_for_subject` and `relay_redact_source(…, 'data_subject_request')` stay supervisor-only. They redact the snapshot and do not hide the source.
- Retention (C5) also applies to sources in the trash.
- Excerpt rules (C3/M11) and the P1–P4 rules.

### 28.2 What shipped
- `migrations/076_relay_trash_owner.sql` and `migrations/_rollback/076_relay_trash_owner.down.sql`.
  - The rollback restores the nine redefined functions to their exact pre-076 text and drops the new columns.
  - It refuses to run while anything is in the trash or erased, unless the session sets `relay.rollback_discard_data=on`.
- New columns on `relay_sources`: `removed_at`/`removed_by` and `purged_at`/`purged_by`, with pairing checks.
- Four new RPCs: `relay_remove_source`, `relay_restore_source`, `relay_list_removed` and `relay_purge_removed`. `authenticated` can now execute 19 Relay RPCs.
- Redefined functions:
  - `_relay_full` returns `sources` without removed ones, plus a separate `removed` list.
  - `relay_list` counts only sources that are not removed.
  - `relay_find_by_source` ignores removed sources.
  - `relay_attach_sources` restores a removed (not erased) source when its message is attached again, instead of silently skipping it.
- Events (no text): `source_removed`, `source_restored`, and `source_redacted` with `purged: true`.
- `admin/relay.html`:
  - "إزالة" on every source.
  - An "المحذوفات" section in the record, with "استرجاع", plus "مسح نهائي" and "تفريغ المحذوفات" for the owner.
  - A page-level "المحذوفات" panel across all visible records.
  - The assign-privilege panel is shown only to the owner.
  - Before 076 is applied, `relay_my_access` has no `owner` key and the page keeps the 074 behavior.

### 28.3 Residual risks
- **U20:** An erased message cannot be attached to the same record again, because the dedupe key remains. It can still be attached to a different record. This is intentional: erase is final.
- **U21:** The trash is per record and has no automatic expiry. Removed sources keep their excerpt until the owner erases them or the C5 retention sweep runs after the record closes.
- **U22:** Supervisors who could redact manually under 073/074 no longer can. Only the owner erases. The data-subject path is unchanged.
