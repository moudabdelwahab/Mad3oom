# Phase 1 readiness review (2026-10-20)

> **Status after the 2026-10-20 rollout (§7): no feature switch is enabled.**
> Production at 2026-10-20 21:35 UTC:
> - 12 of 12 switches OFF;
> - ledger head `110_api_token_credentials_immutable` (383 rows). 108 was applied from `main@5017384` and 110 from `main@c5dd986`;
> - `wf-executor` v46, byte-identical to `main@5017384`, with the isolation guard;
> - `regenerate-api-token-secret` v19, byte-identical to `main@c5dd986`, owner-only;
> - `mcp` v35 unchanged.
>
> F1, F2 and F7 are closed in production. Isolation now waits only on the owner's separate, explicit approval (Q17).
> The owner switches flags on in `owner-dashboard.html` (`owner_set_feature_switch`, fresh step-up). Claude cannot do this.

## 1. Decision per switch

| Switch | Decision | Why |
|---|---|---|
| `company_permissions_enabled` | **READY TO ACTIVATE** | No prerequisite, and no unaudited authorization path (§4). Tested on and off, with and without isolation (§5). Production has 0 company staff, so only the one company owner sees a change (§3.1) |
| `company_isolation_enforced` | **READY TO ACTIVATE (owner's explicit approval, Q17)** | F1 is closed: `wf-executor` v46 is deployed with the guard. F2 is closed: the SIE engine was reviewed (§4.2). F7 is closed: 110 is applied and `regenerate-api-token-secret` v19 is deployed (§7). The rolled-back ON probe matches OFF for owner, company member, admin and direct customer. **Limitations:** production has 0 `company`-scope tickets, so the effect cannot be observed live yet, and MCP under isolation has not been tested against real company data (§5.4) |
| `data_access_grants_enabled` | **BLOCKED** | F3 is fixed: 108 is applied. Still blocked because grants need isolation ON first |
| `company_suspension_enforced` | **READY WITH EXPLICIT LIMITATIONS** | The documented contract holds and is tested: a suspended company loses plan and override features through `company_has_feature`, and its inbox. Only the owner can suspend. No company is suspended, so switching it on changes nothing today. Limitations in §3.4: display mismatch until 108 (F4), tickets and existing API tokens unaffected, no suspend screen |

### What unblocked isolation and grants (all done 2026-10-20, §7)
1. **Isolation:** done. Only the owner's explicit approval (Q17) remains.
   - F1: `wf-executor` v46 deployed from `main@5017384`, byte-identical, with `ticket-guard.js` and the four guard calls.
   - F2: the SIE engine `moudabdelwahab/sie@cc3b9f7` was reviewed (§4.2).
   - F7: 110 applied and `regenerate-api-token-secret` v19 deployed from `main@c5dd986`.
   - The rolled-back production probe in the real ON state matches OFF.
2. **Grants:** 108 is applied and its self-check passed. Grants now wait only on isolation being ON.

## 2. Activation order and rollback

**Order:**
1. `company_permissions_enabled` — **can go now**.
2. `company_suspension_enforced` — can go now, with the limitations in §3.4. Apply 108 first if the dashboard should match.
3. `company_isolation_enforced` — §1 "Isolation" is done (2026-10-20, §7). Needs the owner's explicit approval.
4. `data_access_grants_enabled` — after 108 is applied and isolation is ON.

After each switch:
- check the live values and its `privileged_audit` row;
- look for new errors in the function and Postgres logs;
- for isolation, also run `get_dashboard_stats` through the Mad3oom MCP connector.

**Rollback:** turn the switch OFF in the same panel. Each switch reverts immediately (tested, §5 ⑨). Notes per switch:
- **Isolation and permissions** become **one-way** after the first completed customer transfer, carried ticket or approved account request (`_guard_isolation_after_transfers`). Phase 1 creates none of these.
- **Grants:** turning grants OFF stops reads and requests. **Unrevoked grants work again if the switch returns before they expire** (tested). Revoke them first if that is not wanted.
- **Suspension:** turning it OFF restores features, and the company keeps `status = 'suspended'`. Reactivation is owner-only.
- **Saved company permissions** survive OFF.
- **Migration rollbacks** are not switch rollbacks. 097, 098, 099 and 107 `.down` refuse while their switch is on or history exists. **108 `.down` refuses while `data_access_grants_enabled` is on**, because it would restore F3 (tested). Run anywhere else, it restores all three original defects; its header says so.
- **No backup:** the project is on the free plan, with no point-in-time recovery and no verified backup.
- **108 and 109:** 109 (`109_registration_mode_public_read`, merged to `main` in PR #144) changes the `advanced_settings` policy and adds `get_public_registration_settings`. 108 touches none of these. Both orders were checked locally on the prod-shape chain, 107 → 109 → 108 and 107 → 108 → 109: both apply, and the 108 rollback and re-apply still work.

## 3. Per switch

### 3.1 `company_permissions_enabled` (098)
- **Readers:**
  - `_company_ticket_row_access` and `_company_permissions_on`;
  - the permissive `company_team_select` and `company_team_insert` policies on tickets, replies, attachments, activity, ratings and `storage.objects`;
  - `company_set_role_permission` and `company_set_user_permission`, which raise 0A000 when OFF;
  - `company_customers_list`;
  - inbox staff access (102);
  - prerequisite checks in 101, 106 and the 105 guard.
- **What changes when ON:**
  - Supervisors see their own company's tickets; agents see only tickets assigned to them.
  - The owner gains internal notes and `company_ticket_set_status` / `company_ticket_assign`.
  - The owner's dashboard list switches to `company_tickets_list`, which shows company-scope tickets only.
  - Platform staff and customers see no change.
- **UI:** the permission matrix has a screen (`company-data.js` 426/435). `company_set_user_permission` has no caller.
- **MCP:** employees get no company tickets through MCP, because MCP keys on `super_user_id`. This is a functional gap, not a leak.
- **Disable:** staff lose access immediately (tested).

### 3.2 `company_isolation_enforced` (097, 107)
- **Readers:**
  - restrictive `tenant_isolation` on tickets, replies, attachments, activity, ratings and tag links;
  - storage `ticket_files_isolation`;
  - seven side-channel triggers: staff notifications, Telegram, round-robin, webhooks and workflow dispatch;
  - SLA alerts;
  - `wf_assign_ticket` and `wf_update_ticket_status`;
  - `mcp_admin_update_ticket` and `mcp_ticket_tenancy`;
  - `ticket_in_my_scope` and `can_access_ticket` (107).
- **What changes when ON:**
  - Platform staff lose company tickets and their side channels.
  - Company owners lose their customers' and staff's personal platform-support tickets.
  - Customers keep all their own tickets.
- **Verified in production:**
  - 107 is applied;
  - `mcp` v35 equals `51a4ac5` (14 files, checked twice);
  - a rolled-back probe gave identical results OFF and ON for the real owner, member, an admin and a direct customer.
- **Blocking:** F1 and F2 (§4).
- **Further limitations once unblocked:**
  - production has no company-scope tickets, so the boundary is exercised only on the prod-shape chain (§5);
  - MCP shows support tickets only to `role = 'admin'` or the main-admin emails (narrower than the database);
  - `_isolation_on` and the `_ticket_*_visible` helpers are callable by `anon`, revealing the switch state and whether a guessed reply id is internal;
  - `wf-executor` can still create a ticket for a company customer under isolation. The new ticket is stamped company-scope and then hidden from staff.

### 3.3 `data_access_grants_enabled` (097, 108)
- **Flow:**
  - Requests come from platform staff only, per `access_requester_rules`.
  - The owner decides with a step-up; self-approval is impossible. Grants last 1–168 h.
  - Reads go only through `granted_company_tickets` and `granted_ticket_view`, each call audited (append-only). No internal notes or file paths are exposed.
  - The company admin sees `company_access_log`.
- **F3 (medium, fixed in 108, not applied):** reads did not re-check eligibility, so a demoted admin or support member kept reading until expiry. Reproduced before 108, fixed after (§5 ⓪, ⑥).
- **Limitations after 108:**
  - **No staff UI:** there is no screen for requests, the requester's own list, grant reads or cancellation, so the feature is API-only.
  - **Notification link:** the owner notification links `#access-requests`, which doesn't exist (the panel is `#govAccess`).
  - **Stale requests:** a request pending for more than 7 days blocks new ones until cancelled.
  - **Existence probe:** `request_data_access` lets staff probe whether a company or ticket id exists.
  - **Expiry:** checked at read time only.

### 3.4 `company_suspension_enforced` (099, 102, 103)
- **Contract** (`H1_ADMIN_HIERARCHY_099_PROD_INSTALL.md:36`, the switch description, `CD_COMPANY_CONVERSATIONS_102_PROD_INSTALL.md:28`): a suspended company loses its plan and override features through `company_has_feature`, and its inbox closes.
- **Tested** (§5 ⑦):
  - plan features lost: `sub_users`, so member, team and permission management, plus new `api_tokens` and `integrations_hub`;
  - inbox staff access and customer writes closed;
  - only the owner with a step-up suspends or reactivates (`delegate_set_company_status`). `delegation_enabled` is OFF, and a company owner cannot change their own status;
  - enforcement OFF restores immediately.
- **Limitations (outside the documented contract, not changed):**
  - **Tickets:** ticket access for owner and team, and new tickets from customers, are unchanged.
  - **Existing API tokens** keep working. `mcp/_shared/api-auth.ts` checks only active, revoked and expired; token use is not entitlement-gated anywhere in the architecture.
  - **Service-role intake:** ihub service-role intake and `integrations-worker` continue.
  - **Display (F4):** until 108 is applied, `get_my_company_dashboard` lists entitlements that `company_has_feature` refuses. Display only. Fixed in 108 ③, which follows the 021 rule of one entitlement definition.
  - **No suspend or reactivate screen:** the owner must call the RPC.
- **Production effect today:** none; 0 companies are suspended.

## 4. Audit coverage

### 4.1 Database (production, live definitions)
- **Scope:** 443 SECURITY DEFINER functions callable by `authenticated` or `anon`. 46 touch tickets. 30 of those do not reference the isolation helpers; each was triaged:
  - **Company-scope only:** `_company_*`, `company_tickets_list`, `company_ticket_*`.
  - **Own rows:** `cancel_my_subscription_request`, `request_subscription_purchase`.
  - **Staff or owner only:** `admin_list_subscriptions`, `ticket_invoice_document`, `usage_reconciliation`, `owner_reassign_admin_tickets`.
  - **Through the 107 scope check:** close/reopen, and `_ihub_ticket_viewer`.
  - **Token-gated:** `get_public_invoice` (≥32 chars).
  - **Switch-gated:** grants, carry and historical access.
  - **Trigger functions:** not callable through the API.
- **Defects found:** F3 (grants) and F5 (`evaluate_customer_badges(p_user_id)` took any id, so any user could award another account badges and notifications and learn facts about it).
- **Company status writes:** only through `delegate_set_company_status` (owner step-up, or a delegate with `companies.suspend` + aal2) or the service role. The status guard blocks company owners. No RLS UPDATE policy on `companies` lets staff update.
- **108 base definitions:** the three functions 108 replaces match production byte-for-byte (`pg_get_functiondef` md5):
  - `_access_grant_active` `a880cdbb…`;
  - `evaluate_customer_badges` `bccaee87…`;
  - `get_my_company_dashboard` `5f8241ee…`.
  Two functions 108 relies on also match: `company_has_feature` `7f68068e…` and `can_create_api_token` `86512384…`.

### 4.2 Edge Functions (all 65 repository directories, plus production source for the 4 without repository source)
- **`mcp` (v35):** the only service-role path with its own isolation check, on ticket list, get, update and stats; it fails closed. Customers and notifications use `super_user_id`, which mirrors the primary-membership owner. No other-company exposure found.
- **F1 `wf-executor` (v45):**
  - Admin and support are authorized, and the workflow definition comes from the request body.
  - Four steps act on a ticket by id with the service role and no isolation check: add tag, log activity, send email (dry run returns the owner's email) and satisfaction survey.
  - The two RPC-backed steps are gated by 097.
  - **Fixed in the repository:** `supabase/functions/wf-executor/ticket-guard.js`, with the same rule as 097 (with isolation ON, a company ticket is "not found"; fails closed). It is called before any read or write in all four steps; `tests/wf-executor-ticket-guard.test.mjs` covers it.
  - **Deployed as v46** on 2026-10-20 (§7). Customer lookup and notifications are not isolation leaks: staff read all profiles and notify anyone by design.
- **F2 SIE (reviewed 2026-10-20, closed):**
  - Both deployed functions pin the engine to `moudabdelwahab/sie@cc3b9f7`: `sie-api` v24 and `sie-channel-telegram` v28. The earlier `@8252e57` note was wrong.
  - **`sie-api`:** session ownership is proved on the caller's RLS client. Only then does the engine get the service-role writer, which it uses for exactly two RPCs (`sie/action/supabase-port.supabase.js`):
    - `persist_bot_turn` and `create_ticket_with_message_and_session_update` take the actor from `chat_sessions.user_id`;
    - they update only that owner's session.
  - **Ticket scope:** SIE tickets are scoped by `a_ticket_scope_stamp`, from the ticket owner and not the caller. A company customer's SIE ticket is therefore `company`.
  - **`sie-channel-telegram`:** runs on the service role. Its identity comes from a redeemed link code (`channel_redeem_link_code`). Its reads are bound to that user, including `sie-customer-memory`, which reads only `tickets ... eq('user_id', userId)`.
  - **Tables touched:** `chat_sessions`, `chat_messages`, `chat_engine_*`, `sie_*`, `customer_sie_access`, `channel_*`, `profiles`, `ai_usage_events`, and the caller's own tickets. The engine touches no company tables and no other tenant's tickets.
  - **Staff visibility of the website chat** (`chat_sessions` and `chat_engine_*` behind `has_elevated_authority` and `is_chat_engine_staff`) is by design. It is Mad3oom's own helpdesk, and company-private conversations are the separate 102 tables (`CD_COMPANY_CONVERSATIONS_102_PROD_INSTALL.md`).
  - `chat_engine_learning_queue` shows "RLS off", but it is a `security_invoker` view over `chat_engine_trace_events` (staff-only RLS), so it is not a leak.
- **F7 (high; closed in production 2026-10-20, §7):**
  - **Cause:** `api_tokens` RLS (`Admin can view all api tokens`: `is_admin() OR is_owner_or_super_of(user_id)`) lets every admin read every token. The admin page `assets/js/admin/api-integrations.js` lists all of them, each with a regenerate button.
  - **The flaw:** `regenerate-api-token-secret` v18 checks only that the caller can read the row. It then rotates the secret with the service role and returns the new plaintext secret to the caller.
  - **Effect:** an admin obtains a working credential for another account and acts as that account through the API and MCP.
  - **Live exposure:** the 108 tokens of the platform owner, who is also the only company owner (3 active, 105 revoked; regenerating also revives a revoked token, F6). 0 tokens belong to company members or customers.
  - **Second path (found by Codex review on PR #145):** the admin needs no Edge Function at all.
    - `Admin can update any api token` admits admins to every row, and `guard_api_token_protected_columns` (043) exempts `is_admin()` from every column.
    - So one PATCH that sets `secret_hash` (or `bearer_token_hash`) to the SHA-256 of a secret the admin chose is enough, and `mcp/_shared/api-auth.ts` then returns the victim's `user_id`.
    - `user_id` can be rewritten the same way, which moves the token to another account.
    - Reproduced on the production-equivalent chain (⓪ in the test below).
  - **Fix, two parts (both needed):**
    1. **Migration `110_api_token_credentials_immutable`:**
       - identity and credential columns cannot be changed by any JWT caller, including admins and the platform owner (42501): `user_id`, `api_key`, `secret_hash`, `bearer_token_hash`, both `*_last_four`, `credential_type`, `credential_group_id`, `created_at`, `created_by_role`;
       - every legitimate write of those columns runs with the service role (`create-api-token`, `regenerate-api-token-secret`, `oauth-token`);
       - admins keep `scopes` and `expires_at` (their 036 ceiling is already full, and neither yields a secret);
       - enable/disable, name and description are unchanged for everyone;
       - the rollback restores production's exact body (md5 `6b6b4b14…`) and refuses while isolation is ON;
       - test: `tests/sql/api-token-credentials-immutable.test.sql`.
    2. **`regenerate-api-token-secret`:**
       - regeneration is refused (403) unless `existing.user_id` is the caller;
       - revoke and delete via RLS are unchanged;
       - test: `tests/regenerate-api-token-owner-only.test.mjs`, which fails on v18 and passes with the fix.
  - **Deployed** (§7): 110 applied from `main@c5dd986` with the release wrapper, then `regenerate-api-token-secret` v19 from the same commit (`verify_jwt=true`, single file).
- **Production-only sources, reviewed now:**
  - `integrations-api` v10 and `whatsapp-webhook` v67 touch only WhatsApp and integration tables, via RPCs (messages, integrations, bot state, API keys, wallet). They do not touch tickets, profiles, memberships, notifications, subscriptions or company conversations.
  - `register-whatsapp` v30 touches only the caller's own `integrations` row.
- **Other functions:**
  - **Safe:** `chat-bot-reply` and `generate-ai-chat-reply` (own session via RLS); `create-sub-user` (DB gate).
  - **Staff only:** `accounting-sync`, `send-ticket-email`, `get-attachment-url`.
  - **Own or admin:** the subdomain functions.
  - **Own buckets with JWT RPC decisions:** document and continuity functions.
  - **`ihub_svc_*` RPCs only:** `integrations-inbound` and `integrations-worker`.
  - **No service-role access to these domains:** the remaining ~35.
  - **Nothing at all:** no function reads or writes `company_memberships`, `companies`, or company or inbox conversations.
- **F6 (medium, independent of the four switches, not fixed):** `regenerate-api-token-secret` reads the token through RLS, then sets `is_active = true, revoked_at = null` with the service role and no entitlement check. A token revoked by staff, or one whose plan no longer includes `api_tokens`, comes back when its owner regenerates it. The fix needs a product decision (should regenerating revive a revoked token?) and an Edge Function deploy.

### 4.3 Frontend
- **Rule:** client filters only narrow results; the database enforces visibility.
- **Ticket pages:** `tickets-service.js`, `customer-history.js` and `assets/js/admin/*` read through RLS.
- **Company owner's member tickets** (`fetchMemberTickets`): use `supervises()`. With isolation OFF, members' platform-support tickets are hidden only in the UI (`isCompanyScopedTicket`); that is pre-097 behaviour. With isolation ON, the server hides them.
- **Company dashboard and company conversations:** RPC-only; no direct `.from('company_conversation*')`.
- **Not determined:**
  - the text of the 070 tickets policy change;
  - the definition of `can_use_mcp_client`;
  - whether any notification INSERT policy other than the staff one exists.

## 5. Evidence

### 5.1 Local (Postgres from the production schema snapshot plus migrations 094–108; Node 22)
- **Full SQL suite:** 78 files, all pass, including the new `tests/sql/phase1-readiness.test.sql`.
- **Full Node suite:** 1282 tests, 1280 pass, 0 fail, 2 skipped, including the new `tests/wf-executor-ticket-guard.test.mjs` (4 tests; it fails when the guard calls are removed).
- Both suites were run on `d1a7fb0`.

`phase1-readiness.test.sql` enables all four switches through the real owner path with a step-up. The actors are:
- two companies, each with an owner, a supervisor and an agent;
- customers A1, A2 and B1;
- a banned member;
- platform elevated admin, admin and support;
- the owner;
- a standalone user.

| § | Asserted |
|---|---|
| ⓪ | **Before 108**, F3, F5 and F4 all reproduce |
| ① | The 108 rollback restores the exact schema (digest), and re-applying twice works |
| ② / ②b | **Activation:** elevated admin and owner-without-step-up refused; owner enables the four in order; four audit rows |
| ② / ②b | **108 rollback guard:** refused while grants are ON, and no function changes |
| ③ | **Visibility:** exact per-actor counts for tickets, replies, attachments, activity, ratings, tags and files; internal notes hidden |
| ③ | **Refusals:** definer functions refuse other-tenant and personal tickets, with the same 42501 for a missing ticket (no oracle); no cross-tenant update or reply |
| ③ | **Other data:** notifications, subscriptions, profiles, memberships and companies don't cross; `mcp_ticket_tenancy` is service-only and returns the right team companies |
| ④ | **Removed staff:** lose company tickets and their MCP context |
| ④ | **Removed member:** keeps their own ticket only; the company keeps its stamped ticket |
| ⑤ | **Permissions OFF:** staff lose access, owner and customer keep theirs, matrix writes are refused |
| ⑤ | **Permissions ON:** own company only; cross-company status and assign return P0002 |
| ⑥ | **Who:** staff-only requests; step-up decision; elevated admin refused |
| ⑥ | **Reads:** scoped to company and grant, every read audited, no internal notes, another staff member refused, company access log |
| ⑥ | **Ending access:** demotion and a disabled rule stop reads (108); switch OFF stops reads; revoke and expiry work |
| ⑦ | **Suspension:** owner-only; B loses features and team management, A is unaffected; the dashboard matches (108 ③); tickets stay (limitation); OFF restores; owner reactivates |
| ⑧ | **Badges:** evaluating another user returns nothing and writes nothing; self, staff and the trigger path still work |
| ⑨ | **Turning off:** all four OFF through the owner path; legacy behaviour returns |

### 5.2 CI
CI runs only on pushes to `main` and on pull requests into `main`. PR #143, head `d1a7fb0`, 2026-10-20, all green:
- `node + SQL` (the full suites);
- CodeQL, and `Analyze (javascript-typescript)`;
- the drift checks: repository (فحوص المستودع) and comparison with production (مقارنة بالإنتاج);
- Vercel preview.

Supabase Preview was skipped. Codex code review found nothing. **The PR is open and not merged; `main` is still `51a4ac5`.**

### 5.3 Production (read-only or rolled back)
- The 2026-10-19 rolled-back isolation probe.
- `mcp` v35 source compared with the repository (2026-10-19 22:55, 23:14 UTC).
- A live `get_dashboard_stats` call through the connector (200).
- md5 checks of the functions 108 touches (2026-10-20).
- Production source reviewed for `sie-api`, `integrations-api`, `whatsapp-webhook`, `register-whatsapp` and `wf-executor`.
- Switch values and the ledger at 2026-10-20 09:32 UTC: 0 of 12 ON, `_isolation_on()` false, head `107_isolation_readiness`, 380 rows.

### 5.4 Not tested anywhere
- The external SIE engine.
- Frontend rendering under each switch in production.
- MCP under isolation against real company data.
- Cron and background jobs under suspension.

**What would close the gap:** a designated test company in production (free plan, so no Supabase branching; ordinary deletable accounts, created only with the owner's approval):
- one owner and one supervisor;
- two customers: one with a company ticket and a personal support ticket;
- one account in a second company.

Alternatively, a staging project restored from a schema dump.

## 6. Conditions for Phase 2
1. The switches decided here are ON and verified (§2), with no new errors in the function or Postgres logs for at least 24 h.
2. Isolation and grants are unblocked (§1) and verified the same way.
3. 108 is applied and its self-check passes.
4. The §5.4 test fixture exists, or the owner explicitly accepts simulated-only evidence.
5. The Phase 2 candidates are re-validated against live state:
   - `multi_company_memberships_enabled` needs isolation ON;
   - `company_inbox_enabled` needs permissions ON;
   - `historical_access_enabled` needs permissions and isolation ON;
   - `delegation_enabled` stays BLOCKED until an MFA-enrolled delegate exists (0 accounts have Supabase MFA).
6. Nothing in Phase 2 creates a transfer, carry or approved account request.
7. F6 (`regenerate-api-token-secret`) has a decision before any feature relies on token revocation.

## 7. Production rollout record (2026-10-20)

| Time (UTC) | Step | Evidence |
|---|---|---|
| 19:31 | **Re-check:** `main` `5017384`; CI on it green (Tests, CodeQL, Drift); ledger head `109_registration_mode_public_read`, 381 rows; 12/12 switches OFF; pre-108 md5s unchanged; 0 grants; 0 suspended companies | read-only queries |
| 19:33 | **Fetch check:** production fetched `migrations/108_phase1_readiness_fixes.sql` at `5017384` | HTTP 200, md5 `0d0554d4935e8c9dc154ea37090be773`, the same as `git show` |
| 19:34 | **108 applied** with the release wrapper (fetch, checksum, `execute`). Its self-check passed inside the apply | ledger `20261020193408 108_phase1_readiness_fixes`, 382 rows. Markers present in all three functions. `authenticated` cannot execute `_access_grant_active`; `anon` cannot execute badges or the dashboard. 0 switches ON |
| 19:37 | **`wf-executor` v46 deployed** (`index.ts` + `ticket-guard.js`, `verify_jwt=false`) | v45 differed from `main` only by the guard. v46 is byte-identical to `main@5017384` (`get_edge_function`), with 4 guard calls. `service_role` can execute `_isolation_on()` (boolean) |
| 19:38 | **`wf-executor` smoke test** | OPTIONS 200; POST without auth 401; GET 405; bad internal secret 401. Logs: 4 boots of deployment `_46`, no errors |
| 19:40 | **SIE review** (F2 closed, §4.2) | engine source at `cc3b9f7`; production RPC and trigger definitions |
| 19:45 | **Re-check of F6 and F7** | v18 source equals the repository. `api_tokens` policies; token counts |
| 19:47 | **Security advisors** | no ERROR. WARN counts unchanged (71 anon / 444 authenticated security-definer) |
| 19:48 | **Rolled-back probe** (`RAISE` at the end; nothing persists): `company_permissions_enabled`, then permissions + `company_suspension_enforced`, for owner, company member, admin and direct customer | all metrics identical in all three states: ticket counts 5/0/0/2, `can_access_ticket` on owner and customer tickets, `company_has_feature('api_tokens'/'sub_users')`. 0 switches ON afterwards |

| 20:49 | **CI on `main@c5dd986`** (PR #145 merged) | Tests, CodeQL and Drift green. Local suites on `38b811b`: Node 1299 tests, 1297 pass, 0 fail, 2 skipped; SQL 80 files, exit 0 |
| 20:50 | **Fetch check, then 110 applied** with the release wrapper | production fetched md5 `ec2581cec823aab84520fb21db0d8ade`, the same as `git show`. The guard was the expected pre-110 body (`6b6b4b14…`). Ledger `20261020205000 110_api_token_credentials_immutable`, 383 rows; self-check passed |
| 20:52 | **Rolled-back F7 probe**, as the real admin account against a platform-owner token | `secret_hash`, `bearer_token_hash`, `user_id`, `api_key`, `secret_last_four` all return **42501**. `is_active`, `scopes`, `name` return ok. The service role can still rotate. 0 probe leftovers afterwards; tokens 123 / 18 active, unchanged |
| 21:31 | **`regenerate-api-token-secret` v19 deployed** (`verify_jwt=true`, single file) | byte-identical to `main@c5dd986` (`get_edge_function`). OPTIONS 200; POST without auth 401 |
| 21:33 | **Rolled-back probe with isolation ON** (also permissions + suspension + isolation) | every per-actor metric matches OFF: tickets, notifications, subscriptions, tokens, `can_access_ticket`. 0 `company`-scope tickets exist. A real bearer token was issued meanwhile by the normal service path (not the owner's) |
| 21:35 | **Logs since 110** | no new errors. The only ERROR is a pre-existing cron failure (`employee_daily_stats.had_open_session` NULL, every 15 min, already present from 15:00), unrelated |

**Switches changed:** none. The switch path requires the owner's fresh step-up session, which Claude cannot hold; 0 `feature_switch.*` audit rows exist.

**Next, by the owner, in this order** (verify each one before the next, §2):
1. `company_permissions_enabled`;
2. `company_suspension_enforced` (limitations in §3.4);
3. `company_isolation_enforced`: unblocked. F7 is deployed and the rolled-back ON probe passed. Needs the owner's explicit approval;
4. `data_access_grants_enabled`: only after isolation is ON.

**Rollback:**
- **Switches:** OFF in the same panel.
- **108:** `migrations/_rollback/108_phase1_readiness_fixes.down.sql`. It refuses while grants are ON and restores F3, F4 and F5.
- **110:** `migrations/_rollback/110_api_token_credentials_immutable.down.sql`. It refuses while isolation is ON and restores F7.
- **`regenerate-api-token-secret`:** redeploy the v18 source (`git show 5017384:supabase/functions/regenerate-api-token-secret/index.ts`). This restores F7 even while 110 stays applied: an admin can read any token through RLS and receive a newly rotated secret. So `company_isolation_enforced` must be OFF first, the same condition the 110 rollback enforces (check `select public._isolation_on()` returns false immediately before the deploy).
- **`wf-executor`:** redeploy the v45 source (`git show 5017384^1:supabase/functions/wf-executor/index.ts`, single file). This removes the isolation guard, so isolation must be OFF first.
- **No backups:** free plan, so no PITR.
