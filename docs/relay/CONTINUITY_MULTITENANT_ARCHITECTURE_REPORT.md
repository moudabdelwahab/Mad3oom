# Mad3oom Continuity — Multi-Tenant Company Workspace & Customer Chat: Architecture and Dependency Report

> **Status:** audit and proposal, plus **increment 1 implemented (§9)** and the post-increment-1 follow-ups (§10). D1–D3 approved by Mahmoud on 2026-10-12. **D0 was later reversed by Mahmoud: the internal namespace is `continuity_*` (PR #116), not `relay_*`** (§7, §10). Nothing was merged, applied to production or deployed.
> - Prepared 2026-10-12 against `origin/main` at `b2a45ce` (PR #111).
> - Production (`srnelrdpqkcntbgudyto`) was read-only: `list_migrations` and `SELECT` only.
> - Evidence labels: **[repo]** read in this checkout · **[branch]** read on an unmerged branch · **[prod]** read-only query · **[assumption]** not verified.
> - Companion documents: `CONTINUITY_ARCHITECTURE_PROPOSAL.md` and `RELAY_CURRENT_ARCHITECTURE_AR.md` (both on PR #115, **not on `main`**), `RELAY_ARCHITECTURE_AND_IMPLEMENTATION_PLAN.md` (on `main`).

---

## 0. Executive summary

**Nothing company-scoped exists for conversations or Continuity today.** The company dashboard has tickets, members, API tokens, reports and notifications. It has no inbox and no conversations. Relay works only in the platform workspace. The Chat Widget is a first-party, login-only component that talks to the **platform** support inbox.

**Five findings decide the design:**

1. **Company employees and company customers are the same database relation (blocking).** A company "member" (`company_user`, `company_members()`, `is_company_member()`) and a company "customer" (033: *customer tickets* = tickets of profiles whose `super_user_id` = the company owner) are both `profiles.super_user_id = <owner>`. Today nothing can tell an employee from a customer. Any inbox or Continuity rule built on `is_company_member()` would let the company's customers read other customers' conversations. **A real employee-membership model must come first.**
2. **The existing chat tables fail open toward platform staff.** `chat_sessions`, `chat_messages`, the `chat-attachments` bucket and `notifications` have RLS branches that let `has_elevated_authority()` or `is_platform_staff()` read every row. A company conversation stored in those tables would be readable by Mad3oom staff by default, which contradicts the requirement that platform admins do not automatically get company access.
3. **The widget has no tenant binding.** It requires a Mad3oom login, inserts `chat_sessions.user_id = auth.uid()`, and is loaded only in `customer-dashboard.html` and `admin-dashboard.html`. There is no public key, no origin check and no company column. Supporting "customers of company X chat with company X" is a new trust boundary, not just a routing change.
4. **The Relay core is tenant-ready in schema but not in code.** `relay_workspaces(kind, company_id)` and `workspace_id` on every table exist. About 28 code sites hard-wire `kind = 'platform'` (073: 15, 074: 5, 076: 8). Membership, supervisor and eligibility predicates are built on platform staff and the platform inbox.
5. **Naming conflict with open PRs.** PR #116 (unmerged, not applied) renames the whole `relay_*` namespace to `continuity_*`. It was requested earlier the same day and recorded in proposal §16. This request says to keep `relay_*`. PRs #117 and #118 are stacked on #116. **This needs one decision before any migration is numbered** (§7, D0). *Resolved in §10: `continuity_*` (PR #116) stands.*

**Recommended shape (details in §5):**
- Keep **one Continuity core** (the existing `relay_*` engine) and make it workspace-aware.
- Add a **company conversation domain** that **reuses the widget UI, attachment helpers, voice recorder, Realtime and SIE patterns**, but stores rows in **company-scoped tables that are deny-by-default**. This avoids retrofitting a tenant guard into every RLS, storage and Realtime branch, and the 40 `inbox_*` functions, that grant platform staff access to `chat_*`.
- Build it as **five small, gated increments**, each its own migration, tests and kill switch, with no production change without separate approval.

---

## 1. Repository and production baseline

| Item | Evidence | Value |
|---|---|---|
| `main` | [repo] | `b2a45ce`; working branch `claude/mad3oom-continuity-multitenant-h9o0kc` = `main` |
| Requested docs | [repo] | `CONTINUITY_ARCHITECTURE_PROPOSAL.md` and `RELAY_CURRENT_ARCHITECTURE_AR.md` are **not on `main`**. They live on `claude/wizardly-keller-tuauoa` (PR #115, open) |
| Open Continuity PRs | [GitHub] | #114 notification XSS fix (F1); #115 docs; #116 namespace rename `077`; #117 Phase 0 policies `078` (base #116); #118 reopen lifecycle `079` (base #117). **None merged** |
| Production migration head | [prod] | `076_relay_trash_owner`. Relay 073/074/076 applied. **`075_workspace_layouts` is in the repo but not in the production ledger** (unrelated to this work, noted for drift) |
| Companies | [prod] | **1** company, active, **owned by the platform owner**; 1 `company_user`; 0 follower chat sessions; 0 follower tickets. No real multi-tenant data exists, so all isolation testing must use fixtures |
| Chat | [prod] | 48 `chat_sessions`; 0 routed through Conversation Core (`core_ingest_website=false`, `core_ingest_telegram=false`, `agent_runtime_enabled=false`) |
| Owner context | [prod] | One `owner_context_state` row in `company_admin` context |

---

## 2. Implemented vs. proposed

| Capability | State | Evidence |
|---|---|---|
| Company record, company dashboard sections (overview, members, subscriptions, tickets ×2, support, notifications, API, reports, activity, profile, security) | **Implemented** | [repo] `company-dashboard/index.html`, `assets/js/company/*` |
| Company roles `company_admin` / `company_user` (relation-derived) | **Implemented** | [repo] 035; [prod] `is_company_admin`, `is_company_member` |
| Company entitlements (`company_has_feature`) | **Implemented** | [prod] via `whatsapp_subscriptions` → `plan_features` |
| Company sub-user creation | **Implemented** (Edge Function `create-sub-user`, derives `super_user_id` from the caller) | [repo] |
| Distinction company **employee** vs company **customer** | **Missing** | §3.1 |
| Company conversation inbox | **Missing** | [repo] no section, no RPC |
| Tenant binding of chat sessions | **Missing**: no `company_id` on `chat_sessions` / `chat_messages` | [prod] columns |
| Embeddable widget for a company's own site | **Missing**: login-only, first-party | [repo] `chat-widget.js:15-16,126`; loaded by 2 first-party pages |
| Platform inbox (assign, transfer, notes, tags, teams, scheduled replies, handoff bot↔human) | **Implemented, platform-only** | [prod] 40 `inbox_*` functions, all gated by `is_platform_staff` / `_inbox_is_supervisor` |
| Conversation Core (ingest, seq, delivery outbox, atomic turn) | **Implemented, flags off** | [prod] 064/067 |
| Relay record core (records, sources, excerpts, lifecycle, trash, erase, audit, retention) | **Implemented, platform-only, enabled** | [prod] 073/074/076 |
| Relay company workspaces | **Schema only**: `_relay_workspace()` rejects anything but `platform` | [prod] function body |
| Handover, reminders, escalation, monitor, notifications, AI extraction, attachments, standalone record URL | **Proposed only** (PR #115, partly coded on #117/#118, not merged) | [branch] |
| Platform-operator access to another company | **Does not exist.** `owner_capability('company_admin'/'company_member')` requires `owns_a_company(auth.uid())`, so the platform owner can act only as admin of **their own** company | [prod] `owner_capability` |

---

## 3. Authorization trace (user → company → record → source)

### 3.1 User → company (as built)
```
current_company_id() = companies.id WHERE user_id = auth.uid()
                                   OR user_id = profiles(auth.uid()).super_user_id
is_company_admin()   = owns_a_company(uid) AND (role='company_admin' OR owner_capability('company_admin'))
is_company_member()  = (role='company_user' AND belongs_to_a_company(uid)) OR owner_capability('company_member')
```
- **Sound:** the company is derived from the caller and never taken from the request (020, 035). Company functions take no company-id parameter.
- **Single-company limit:** `super_user_id` is one column, so a user belongs to at most one company. A person who is a customer of two companies cannot be represented.
- **Ambiguity (blocking):** `create-sub-user` creates followers as `company_user` ("members"). Migration 033 calls the same followers the company's **customers** ("العميل ↔ الشركة: `tickets.user_id ∈` التابعين للمالك"). The dashboard shows them in both the *members* section and the *customer tickets* section. The original Relay plan (§ "Workspace membership") also maps company workspace membership to `is_company_member()`, so it inherits the same flaw.

**Consequence:** company employees and company customers must become different relations before any company inbox or Continuity record exists. Otherwise:
- a customer could open the company inbox, which holds other customers' conversations;
- a customer could become an eligible owner of a Continuity record.

### 3.2 Company → conversation (as built: none)
- `chat_sessions` RLS: `user_id = auth.uid() OR has_elevated_authority()`; plus `inbox_assigned_select` for platform staff.
- `chat_messages` RLS: own session, sender, `has_elevated_authority()`, or platform inbox access.
- Storage `chat-attachments`: `is_platform_staff()` reads **every** object; customers read their own folder and staff replies in their own sessions.
- Realtime: `chat_sessions`, `chat_messages`, `inbox_*` and `notifications` are in `supabase_realtime`. Delivery is filtered by the same RLS, so it inherits the same staff-wide visibility.
- **No company path exists.** A company owner cannot read the chat of their own followers. Their chats go to **Mad3oom's** platform inbox.

### 3.3 Conversation → Continuity record → source (as built)
- `relay_can_access(record)` = `_relay_is_member()` (platform staff or inbox supervisor, active, not preview) **and** the record is in the enabled **platform** workspace **and** (supervisor / owner / creator / team member).
- Excerpt read = record access **and** `_relay_can_read_conversation(session)` = `inbox_can_access(session)`, rechecked on every read; fails closed.
- Eligible owner = `_inbox_is_eligible_agent` (platform staff) and active.
- **None of these predicates has a company branch.**

### 3.4 Other paths that must be scoped per tenant
| Path | Today | Risk for company data |
|---|---|---|
| `notifications` | `has_elevated_authority()` reads all rows; `is_platform_staff()` inserts for anyone; admin list has a stored-XSS sink (F1, PR #114 open) | Company notifications would be readable by Mad3oom admins. Templates must carry ids only (already a Continuity rule) |
| Inbox mention / assign notices | Copy customer `full_name` and up to 140 characters of note text into `notifications.message` | The same pattern must not be reused for companies |
| AI (`ai-gateway`) | Admin-only; router falls back to the highest-priority integration | A company's conversation must never reach a provider chosen by Mad3oom or by another company |
| SIE bot replies | Platform `bot_settings` (per `user_id`), one engine | A company widget needs that company's bot configuration, or no bot |
| MCP / API tokens | `mcp/_shared/*` read customers through `super_user_id` | Inherits the employee/customer ambiguity |
| Cron jobs | `relay-retention-sweep`, `inbox-dispatch-scheduled`, `sla-breach-check` (Telegram alert includes the ticket title) | Every job must be workspace-aware and must not cross-notify |

---

## 4. Reuse assessment

| Component | Reuse for companies? | Reason |
|---|---|---|
| Relay record core (`relay_*`) | **Yes: one core, made workspace-aware** | Schema already has `workspace_id`/`kind`/`company_id`. Requires rewriting the ~28 platform-only sites and 4 predicates; all RPCs keep their signatures |
| Relay contract/model/page JS (`assets/js/relay/*`) | **Yes** | Workspace comes from `relay_my_access`, never from the URL |
| Widget UI, `chat-attachments.js`, `voice-recorder.js`, `chat-message-state.js`, `storage-urls.js` | **Yes, as modules** | Parameterized by a "conversation backend" adapter |
| `chat_sessions` / `chat_messages` tables | **Recommend no** (decision D3) | Fail-open toward platform staff in RLS, storage, Realtime and ~40 inbox functions. Every one would need a `company_id IS NULL` guard, and a single miss leaks a company's conversations to Mad3oom. A parallel deny-by-default table set fails closed instead. This is the earlier proposal's CO1 recommendation, re-confirmed by this trace |
| Platform inbox RPCs (`inbox_*`) | **Pattern only** | Logic (assignment, notes, scheduled replies, handoff guarantee) is copied as company-scoped RPCs with the same tests, not by widening the platform functions |
| Conversation Core (`conv_*`) | **Pattern + seq/delivery design** | Flags are off in prod; company ingestion can use the same atomic-turn design |
| Notifications table | **Yes**, with id-only templates and a recipient-scoped check | After F1 merges |
| `pg_cron` + `FOR UPDATE SKIP LOCKED` scheduler pattern (058) | **Yes** | Jobs carry `workspace_id` |

---

## 5. Target architecture

### 5.1 Scopes
```
Platform scope                         Company scope (one per company)
──────────────                         ───────────────────────────────
platform staff (035)                   company_staff membership (NEW, explicit)
platform inbox (chat_*, inbox_*)       company inbox (company_conv_*, NEW, deny-by-default)
relay_workspaces(kind='platform')      relay_workspaces(kind='company', company_id)
                 \                      /
                  one relay_* core, every predicate keyed by workspace
```

**Rules:**
- **R1. No implicit platform access.** `is_platform_staff()`, `has_elevated_authority()` and owner context grant **nothing** in a company scope.
- **R2. Explicit operator access.** Cross-company support access by Mad3oom is a separate, explicit, time-boxed grant: a `company_support_grants` row created by the company admin, reason required, every read audited. It is not built until decision D6.
- **R3. Server-derived workspace.** The workspace is always derived on the server from the caller (`current_company_id()` plus active staff membership). A request may only *select* among workspaces the caller already belongs to, and the server re-checks it.
- **R4. Same-tenant references.** Every row carries `company_id` / `workspace_id`. Every join between tenant tables asserts equality (`record.workspace_id = source.workspace_id = session.company workspace`), enforced by triggers, not only by RPCs.

### 5.2 Company employee membership (prerequisite, increment 1)
- New table `company_staff(company_id, user_id, role in ('admin','supervisor','agent'), status, invited_by, created_at, revoked_at)`:
  - unique `(company_id, user_id)`;
  - the owner is seeded as `admin`;
  - **existing followers are NOT migrated automatically** (decision D2).
- Predicates:
  - `company_staff_role(company_id)`: caller's active role, or null;
  - `_company_is_eligible_agent(company_id, user)`: recipient-side check for active staff, not banned, account active.
- *As implemented in 077 (§9):* the admin is **derived** from ownership instead of seeded, and only `supervisor`/`agent` are stored. Delegated non-owner admins are deferred.
- Customers stay as they are today: `profiles` with `super_user_id`, and in a later step a `company_customers` link if D1 picks the many-companies model.
- `is_company_member()` keeps its meaning for tickets and members, so nothing existing changes. Inbox and Continuity use **only** `company_staff`.
- Management: company admin through RPCs, gated by `company_has_feature('sub_users')` (or a new `company_inbox` feature, D5), audited.

### 5.3 Company conversation domain (increments 2–3)
- **Tables:**
  - `company_chat_channels(company_id, public_key, allowed_origins[], enabled, bot_mode)`;
  - `company_conversations(id, company_id, customer_user_id | visitor_id, status, assignee_id, team_id, …)`;
  - `company_conversation_messages(id, conversation_id, company_id, sender_kind, sender_id, body, attachment, seq, …)`.
- **Security conventions:** RLS on with **no permissive policy for platform roles**; restrictive `gate_account_active`; `trg_preview_read_only`; access only through `SECURITY DEFINER` RPCs.
- **Customer side:** a customer reads and writes only their own conversation with that company. The company is set **on the server** from the channel key and origin, never from the browser.
- **Staff side:** `company_inbox_list/get/reply/assign/transfer/note/close`, each requiring an active `company_staff` role in that conversation's company. Agents see conversations assigned to them or their team; supervisors and admins see all of their company.
- **Storage:** a new private bucket `company-chat-attachments`, path `<company_id>/<conversation_id>/<uuid>`, read policy = conversation access. Platform staff get no policy branch.
- **Realtime:** a broadcast channel per company or per conversation, authorized through Realtime authorization (`realtime.messages` RLS) with the same predicate. Postgres-changes on the new tables are not published until that authorization is in place.
- **Widget:** `chat-widget.js` gains a backend adapter: `platform` (today's behavior, unchanged) or `company(public_key)`. The company mode depends on D1:
  - **D1-a (recommended first):** authenticated Mad3oom customers on the company's Mad3oom subdomain or in the customer dashboard. No anonymous writes.
  - **D1-b (later):** an embeddable script on the company's own website with anonymous visitors. This needs a signed visitor token from an Edge Function, an origin allow-list, rate limits, Turnstile and abuse controls. It is a significant new attack surface and should be its own increment.

### 5.4 Company Continuity (increment 4)
- One `relay_workspaces(kind='company', company_id)` row per company, created **disabled** and enabled per company by policy and entitlement.
- Predicates become workspace-aware:
  - `_relay_workspace(p)`: the caller's workspaces;
  - `_relay_is_member(ws)`: platform → staff; company → active `company_staff`;
  - `_relay_is_supervisor(ws)`: company → `admin`/`supervisor`;
  - `_relay_is_eligible_owner(ws, user)`: company → `_company_is_eligible_agent`;
  - `_relay_can_read_conversation(ws, source)`: company → company inbox access to that conversation.
- **New source adapter `company_message`:** the source must be in the record's company (trigger-checked). A platform record can never reference a company message, and the reverse is also impossible.
- **Every list, count, search, export, event and trash query** filters by the caller's workspace **before** the access predicate. This also fixes U12 (`relay_list` evaluates access before `limit`).
- Handover, reminders, escalation, monitor and AI (proposal §5–§8) are written workspace-aware from the start. Recipients are resolved inside the record's workspace only.
- **Company UI:** a «الاستمرارية» section inside `company-dashboard` reusing `assets/js/relay/*`. Platform URLs never resolve company records (the same `P0002` for "not found" and "not allowed").

### 5.5 AI, notifications and jobs per tenant (increment 5)
- **AI:** per-workspace `relay_ai_settings` (already keyed by workspace in the proposal). A company may only select integrations **it** owns, or none. The no-fallback rule (F3) applies. The ledger stores no content.
- **Notifications:** id-only templates and recipient re-authorization at send time inside the workspace. Links point to the company dashboard route for company records.
- **Jobs:** `relay_jobs` / `relay_deliveries` carry `workspace_id`. The tick processes each row inside its own workspace context.

---

## 6. Dependency-ordered plan

| # | Increment | Depends on | Ships behind | Proves (tests) |
|---|---|---|---|---|
| 0 | Resolve D0 (namespace): `continuity_*` via #116 → #117 → #118 (§10) | D0 | — | Existing suites green |
| 1 | `company_staff` membership + admin RPCs + dashboard "Team" UI | D2, D5 | Feature `company_inbox` off | A customer (follower) is **not** staff; staff of A ≠ staff of B; owner seeded; revoked staff lose access immediately; platform staff and owner context get nothing |
| 2 | Company conversation tables, customer-side RPCs, storage bucket, widget adapter (D1-a) | 1, D3 | Per-company `company_chat_channels.enabled=false` | Cross-tenant by id for every RPC and storage path; key or origin spoofing; a customer cannot read another customer's conversation; platform admin has no path (RLS, storage, Realtime) |
| 3 | Company inbox for staff (list/reply/assign/notes/close), Realtime authorization, notifications | 2, F1 merged | Same flag | Agent/supervisor matrix; company A agent → company B id → `P0002`; notification text contains no content (marker-string search) |
| 4 | Company Continuity: workspace-aware `continuity_*` (after #116), `company_message` source, company UI | 3, D0 | `continuity_workspaces.enabled=false` per company | All existing Relay tests unchanged for platform; full cross-workspace matrix for the ~22 Relay RPCs; source/record workspace mismatch rejected by trigger |
| 5 | Workspace-aware handover/scheduler/escalation/monitor/AI (proposal phases H, S, N, M, AI) | 4 | Proposal kill switches | Proposal §12.1 tests, each repeated across two companies plus the platform |
| later | D1-b embeddable anonymous widget; D6 operator support grants; multi-company customers | as decided | — | — |

Every increment ships as one branch and one PR with its migration, rollback, SQL and node tests, and a "NOT EXECUTED" install note. **Nothing is merged, applied to production or enabled without separate approval.**

---

## 7. Decisions needed

| # | Question | Recommendation | Blocks |
|---|---|---|---|
| **D0** ✅ decided: `continuity_*` | Namespace: PR #116 renames `relay_*` → `continuity_*` | ~~Keep `relay_*`~~ (approved earlier on 2026-10-12, then **reversed by Mahmoud's latest instruction: use `continuity_*` internally**). #116 → #117 → #118 keep `077`/`078`/`079`; company staff moves to `081` and the privacy fix takes `080` (§10). New company Continuity objects use `continuity_*`. Product labels: «مدعوم — الاستمرارية» / "Mad3oom Continuity" | Every migration number |
| **D1** ✅ approved | Who can start a company conversation | **D1-a first:** logged-in Mad3oom customers linked to the company; D1-b (anonymous, embeddable on external sites) as its own later increment | Increment 2 |
| **D2** ✅ approved | Existing followers (`super_user_id`): employees or customers? | Treat them as **customers**, and require the company admin to explicitly add employees to `company_staff`. No automatic promotion | Increment 1 |
| **D3** ✅ approved | Conversation storage: new company tables vs. `company_id` on `chat_*` | **New company tables** (deny-by-default), sharing JS modules and patterns. Adding a column to `chat_*` would need a tenant guard in every staff branch of RLS, storage, Realtime and ~40 functions | Increment 2 |
| **D4** | May a customer belong to several companies? | Not in v1 (keeps the current one-company `super_user_id`). Add a `company_customers` link only if needed | Increment 2 |
| **D5** | Entitlement for the company inbox and company Continuity | New plan feature keys `company_inbox` and `company_continuity` in `plan_features` | Increments 1, 4 |
| **D6** | Should Mad3oom staff ever access a company's conversations? | Only through an explicit, company-granted, time-boxed, audited grant; not built in v1 | Later |
| **D7** | Company bot (SIE) on company conversations | Off in v1: human-only inbox. The company bot comes later with per-company `bot_settings` | Increment 2 |

---

## 8. Validation performed

| Check | Result |
|---|---|
| `git fetch`, `git log`, branch and PR survey | `main` = `b2a45ce`; PRs #113–#118 open; #116–#118 stacked |
| Supabase `list_migrations` | Head `076_relay_trash_owner`; `075` missing from ledger |
| Read-only `SELECT` on `pg_proc` | Bodies of `current_company_id`, `is_company_admin`, `is_company_member`, `owner_capability`, `is_platform_staff`, `has_elevated_authority`, `inbox_can_access`, `relay_can_access`, `_relay_workspace`, `_relay_is_member`, `_relay_is_supervisor`, `_relay_is_eligible_owner`, `_relay_can_read_conversation` |
| Read-only `SELECT` on `pg_policies`, `storage.buckets`, `pg_publication_tables` | Policies for `chat_sessions`, `chat_messages`, `notifications`, `companies`, `storage.objects`; bucket settings; the Realtime table list |
| Counts | Companies, followers, follower sessions/tickets, Core-routed sessions, owner contexts (no personal data read) |

**Not done:** no code, migration or configuration change; no test run (nothing changed); no production write.

---

## 9. Increment 1 — company staff membership (implemented, not applied)

**Branch:** `claude/mad3oom-continuity-multitenant-h9o0kc`. **Migration:** `081_company_staff`. It was written as `077` and moved to `081` with no content change, because `077`–`079` belong to the continuity stack (#116–#118) and `080` to the privacy fix (§10).

### 9.1 What was built
| Piece | Detail |
|---|---|
| `company_staff` | One active row per `(company, user)`, role `supervisor` \| `agent`. Revoked rows stay as history (`revoked_at`, `revoked_by`, `revoke_cause` = `admin` \| `left_company`). RLS on, no permissive policy, no grants to any role (including `service_role`), 041/042 conventions |
| `company_staff_events` | Append-only (`granted`, `role_changed`, `revoked`); UPDATE, DELETE and TRUNCATE blocked by trigger, even for the table owner |
| Owner = admin | Derived from `companies.user_id`, never stored, so it cannot drift. For the caller it also requires `is_company_admin()`, so the platform owner is admin of **their own** company only, and only in the `owner` or `company_admin` context |
| `company_staff_role()` | The caller's role, or `null` for a customer, for someone without a company, in preview mode, or for an inactive account |
| `company_staff_list()` | Staff and admin only (customers get `null`, so they cannot enumerate employees). Returns names and roles; **no email or phone** |
| `company_staff_set(user, role)` / `company_staff_revoke(user)` | Company admin + `sub_users` entitlement (the same gate as member management; no new feature key before D5). The target must be a follower of the caller's company. A foreign account and a missing one get the **same** `P0002` |
| Same-tenant invariant (R4) | The INSERT trigger re-checks that the user follows the company, so even the table owner cannot attach a foreign account |
| Leaving the company | `trg_company_staff_unlink` on `profiles` revokes the role (`left_company`), so coming back makes the account a customer again. The predicates also re-check the follower relation on every read, as a second layer |
| Recipient predicate | `_company_is_eligible_agent(company, user)`, internal, ready for increments 2–4 |
| UI | The existing members section gains a role selector for the admin (customer / support agent / supervisor), a confirmation before demoting to customer, role labels for staff, and nothing for customers. It tolerates 077 being absent |

### 9.2 What it does not do
- **Grants no access:** nothing else reads `company_staff` yet.
- **Changes no existing object:** `company_members()`, `remove_company_member()`, every existing policy and every existing table are byte-identical (proved by digests in the SQL test).

### 9.3 Validation
| Command | Result |
|---|---|
| `tests/sql/company-staff.test.sql` (prod-shape fixture, PostgreSQL 16; re-run after the move to 081) | Every section (⓪–⑩, including ⑦ب and both ⑨ races) PASS, exit 0 |
| Mutation checks (dropping the follower re-check, dropping the `is_company_admin()` check, dropping the follower check in `set`) | Each makes the suite fail |
| `npm run test:sql` | 50 files, exit 0, 797 `PASS` lines, 0 `FAIL` / `ERROR` |
| `npm run test:node` (Chromium 1194 mapped locally for Playwright 1.49) | 951 tests: 948 pass, 2 skipped, **1 fail**: `remediation-static` "would catch a modification to a deferred file", which needs commit `faf193a` that this shallow clone does not have (environmental, unrelated) |

### 9.4 Finding while building increment 1 (pre-existing, not changed)
**F4. `company_members()` shows every follower's name and email to every follower.** [repo + prod-shape]
- The function only requires `current_company_id()` to be set.
- Since followers are the company's customers (033, D2), each customer of a company can list every other customer's name and email.
- 081 does not change this, because it is existing behavior outside this increment.
- **Status: fixed in a separate PR, [#120](https://github.com/moudabdelwahab/Mad3oom/pull/120) (`080_company_members_privacy`, not merged, not applied).** The full list goes to the company admin only; everyone else sees themselves and the admin's name. Active staff read the team through `company_staff_list()` (names and roles, no contact data). Whether supervisors may list customers is left to increment 3.

### 9.5 Next
- **D0 follow-up:** none to port. #116 → #117 → #118 stand as written (§10).
- **Increment 2 (not started):**
  - company conversation tables, customer-side RPCs, the private storage bucket and the widget adapter (D1-a);
  - it builds on `_company_is_eligible_agent` and `company_staff_role()`.

---

## 10. Post-increment-1 follow-ups (2026-10-12)

### 10.1 Naming: `continuity_*` stands
Mahmoud's latest instruction is to use `continuity_*` internally. This reverses the D0 "keep `relay_*`" approval recorded earlier the same day. Nothing was reverted: #116–#118 are untouched, and nothing in the new PRs uses either namespace.

### 10.2 Conflict check (read on the branches, not assumed)
| Pair | Database objects in common | Repo files in common | Verdict |
|---|---|---|---|
| #116 (`077_continuity_namespace`) vs company staff | None. #116 renames `relay_*` objects only and states it does not touch `profiles`; company staff creates `company_staff*` plus one trigger on `profiles` | `tests/company-navigation.test.mjs` (newest-migration assertion); the file number `077` | **Number collision only.** Resolved by moving company staff to `081` |
| #117 (`078_continuity_policies`), #118 (`079_continuity_reopen_lifecycle`) vs company staff | None (`continuity_*` only) | The same assertion | Text conflict only |
| #120 (`080_company_members_privacy`) vs everything else | Only `company_members()`, which none of the others define | The same assertion; `company-dashboard.js` and `company-model.js` (additive hunks in different functions from company staff) | Text conflicts only, resolved at merge |

### 10.3 Production ledger (read-only, 2026-10-12)
- The head is `20261009193924 076_relay_trash_owner`. **No `077`–`081` is applied.**
- `075_workspace_layouts` is in the repo but not in the ledger (unrelated).
- The ledger already shows an out-of-order application (`073` at `…133459` before `072` at `…133855`). File numbers order the repo; they do not have to match apply order when the files are independent.

### 10.4 Migration sequence
| File | PR | Depends on | Notes |
|---|---|---|---|
| `077_continuity_namespace` | #116 | 073/074/076 | Forward-only rename; `relay_*` RPC wrappers kept |
| `078_continuity_policies` | #117 | 077 | Stacked on #116 |
| `079_continuity_reopen_lifecycle` | #118 | 078 | Stacked on #117; 078's rollback refuses while 079 is installed |
| `080_company_members_privacy` | #120 | none of 077–079 | Security fix, one function |
| `081_company_staff` | this branch | none of 077–080 | No access granted yet |

Company work after 081 (increment 2 onward) takes the next free number at the time, re-checked against `ls migrations`, open PRs and `list_migrations`. The proposal's planned numbers (080 attachments, 081–084 handover → monitor) are plans only and shift accordingly.

### 10.5 Recommended merge and deploy order
1. **#120 (080, privacy).** Merge and apply first. It is small, independent, and closes a data exposure. Its frontend is safe before or after the migration.
2. **#114 (F1, notification XSS).** Independent and already a prerequisite for any Continuity notification.
3. **#116 → #117 → #118 (077–079).** In stack order, each applied only after its own approval. Before each merge, update its newest-migration assertion in `tests/company-navigation.test.mjs` to the highest file on `main` (080 or 081 by then).
4. **Company staff (081).** Independent of 3, so it can go before or after. If it merges before #116, then #116–#118 must keep their numbers and only update the assertion; renumbering them is not needed.
5. **#115 (docs).** Any time.

Each production apply is its own approval. No step above was performed.

### 10.6 Remaining security findings
| # | Finding | State |
|---|---|---|
| F1 | Stored-XSS sink in the admin notification list | PR #114 open, not merged |
| F2 | Elevated admins can read every user's notifications (RLS) | Open. Continuity notifications carry ids only, by design |
| F3 | AI router falls back to the highest-priority integration | Open. `continuity-extract` must pass an explicit integration and refuse otherwise |
| F4 | `company_members()` lets customers list other customers | Fixed in #120 (not merged or applied) |
| **F5 (new)** | `resolve_company_member_login(company, member)` is granted to `anon` and returns the member's email when given the company identifier plus the member's phone (or email). Rate-limited (5 per 10 min per company, 60 per 5 min overall) and needs a guess, so it cannot enumerate members, but it discloses phone → email and confirms membership | Open. It is part of the login flow. A fix (for example, returning an opaque login token, or doing the lookup inside the auth Edge Function) needs its own design and approval |
| — | Chat tables (`chat_*`, `chat-attachments`, `notifications`) grant platform staff wide reads | By design for the platform. This is why company conversations go in new tables (D3) |
