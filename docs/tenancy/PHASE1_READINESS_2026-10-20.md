# Phase 1 readiness review (2026-10-20)

> **Status: no feature switch is enabled.** This is a readiness review only. All 12 switches were still OFF at 2026-10-19 23:13 UTC (read-only check). The ledger head is `107_isolation_readiness`.
> **Migration 108 (`108_phase1_readiness_fixes`) is in the repository only.** It is not applied to production.
> The owner switches flags on in `owner-dashboard.html`. That goes through `owner_set_feature_switch`, which needs a fresh step-up; nothing in this review turns a switch on.

## 1. Verdict

| Switch | Status | Reason |
|---|---|---|
| `company_permissions_enabled` | **READY TO ACTIVATE** | No prerequisite. Tested on and off. Production has 0 company staff, so only company owners see a change (§3.1) |
| `company_isolation_enforced` | **READY WITH EXPLICIT LIMITATIONS** | 107 applied and `mcp` v35 deployed and verified. The database boundary is tested end to end on the prod-shape chain. Production has no company-scope tickets, so it cannot be exercised there. The limitations are in §3.2 |
| `data_access_grants_enabled` | **BLOCKED until 108 is applied** | A medium defect: a grant stayed readable after its holder was demoted. It is fixed in 108, and 108 is not in production. After 108: READY WITH EXPLICIT LIMITATIONS (there is no staff screen; §3.3) |
| `company_suspension_enforced` | **READY WITH EXPLICIT LIMITATIONS** | The owner-only path is tested. Enforcement removes plan features and the inbox only, not ticket access or existing API tokens. There is no suspend screen. No company is suspended, so switching it on changes nothing today (§3.4) |

The edge and frontend audit is in §4. The cross-tenant test matrix is in §5.

## 2. Safe activation order and rollback

**Prerequisites**, all done except 108:
- 107 applied (done 2026-10-19);
- `mcp` v35 from `51a4ac5` deployed and verified byte-for-byte (done);
- 108 applied (pending), needed only before `data_access_grants_enabled`.

**Order**, one switch at a time, with each check below run before the next switch:
1. `company_permissions_enabled`
   - **Check:** the company owner's dashboard still lists the company's tickets.
2. `company_isolation_enforced`
   - **Re-run the rolled-back probe in the real ON state:** the company owner sees their own tickets and none of a direct customer's; platform staff see support tickets.
   - **MCP:** `get_dashboard_stats` through the Mad3oom MCP connector succeeds.
   - **Logs:** no new errors in the function or Postgres logs.
3. `data_access_grants_enabled`, only after 108 is applied.
   - **Check:** `select position('access_requester_rules' in pg_get_functiondef('public._access_grant_active(uuid)'::regprocedure)) > 0` is true.
4. `company_suspension_enforced`
   - **Check:** `select count(*) from companies where status = 'suspended'` is 0, so nothing changes.

**Rollback:** turn the switch OFF in the same panel. Each switch reverts its behaviour immediately (tested, §5 ⑨). Notes per switch:
- **Isolation and permissions** become **one-way** after the first completed customer transfer, the first carried ticket, or the first approved account request (`_guard_isolation_after_transfers`). Phase 1 creates none of these. The switches for those features stay OFF and are Phase 2 or 3 work.
- **Grants:** turning grants OFF stops reads and new requests. Grant rows stay unrevoked, and **they become usable again if the switch is turned back on before they expire** (tested). Revoke them first if that is not wanted.
- **Suspension:** turning it OFF restores features. The company keeps `status = 'suspended'`. Reactivating needs the owner (`delegate_set_company_status`, step-up).
- **Saved company permissions:** they survive OFF and apply again on re-enable.
- **Migration rollbacks** are not a switch rollback: the 097, 098, 099 and 107 `.down` scripts refuse while their switch is on or history exists.
- **No backup to fall back on:** the project is on the free plan, with no point-in-time recovery and no verified backup.

## 3. Per switch

### 3.1 `company_permissions_enabled` (098)
- **Readers:**
  - `_company_ticket_row_access` and `_company_permissions_on`;
  - the permissive `company_team_select` and `company_team_insert` policies on tickets, replies, attachments, activity, ratings and storage;
  - `company_set_role_permission` and `company_set_user_permission`, which raise 0A000 when OFF;
  - `company_customers_list`;
  - inbox staff access (102).
- **What changes when ON:**
  - Supervisors see all of their own company's tickets. Agents see only tickets assigned to them.
  - The company owner gains the team features: internal notes, `company_ticket_set_status` and `company_ticket_assign`.
  - The owner's dashboard list switches to `company_tickets_list`, which shows company-scope tickets only.
  - Platform staff and customers see no change.
- **UI:** the owner permission matrix exists (`company-data.js` 426/435). There is no caller for `company_set_user_permission`.
- **Production effect today:** 0 company staff, 1 company. Only the one company owner's dashboard behaviour changes.
- **Disable:** staff lose access immediately (tested). One-way only after transfers, carry or approved requests.

### 3.2 `company_isolation_enforced` (097, 107)
- **Readers:**
  - restrictive `tenant_isolation` on tickets, replies, attachments, activity, ratings and tag links;
  - storage `ticket_files_isolation`;
  - the side-channel triggers: staff notifications, Telegram, round-robin, webhooks, workflows and SLA;
  - `wf_assign_ticket` and `wf_update_ticket_status`;
  - `mcp_admin_update_ticket` and `mcp_ticket_tenancy`;
  - `ticket_in_my_scope` and `can_access_ticket` (107).
- **What changes when ON:**
  - Platform staff lose company-scope tickets and their side channels.
  - Company owners lose their customers' and staff's personal platform-support tickets.
  - Customers keep all their own tickets.
- **Verified in production:** 107 is applied (both functions carry the check). `mcp` v35 is byte-identical to `51a4ac5` and serves requests. A rolled-back probe on 2026-10-19 returned identical results with isolation OFF and ON for the real company owner, member, an admin and a direct customer.
- **Limitations:**
  1. **No company data in production:** there are no company-scope tickets and no company staff, so the boundary can only be exercised on the prod-shape test chain (§5), not on production data.
  2. **External SIE runtime:** it is outside the repository and was not reviewed (see §4).
  3. **MCP for support staff:** with isolation ON, MCP shows platform-support tickets only to `role = 'admin'` or the main-admin emails. The database also allows `support` staff. MCP is narrower here, not a leak.
  4. **wf-executor email handlers:** `h_send_email` and `h_send_satisfaction_survey` read a ticket by an explicit `ticket_id` with the service role and no isolation check. They are reachable only through a workflow an admin configures with that id; the automatic dispatch is gated.
  5. **Anonymous helpers:** `_isolation_on` and the `_ticket_*_visible` helpers are callable by `anon`. They reveal the switch state and whether a guessed reply id is an internal note.

### 3.3 `data_access_grants_enabled` (097, 108)
- **Flow:**
  - Requests come from platform staff only: admin, elevated admin or support, per `access_requester_rules`.
  - The owner decides with a step-up. Self-approval is impossible.
  - Grants last 1–168 h.
  - Reads go only through `granted_company_tickets` and `granted_ticket_view`. Each call writes an append-only `company_access_audit` row. Internal notes and file paths are not exposed. The company admin sees `company_access_log`.
- **Defect fixed in 108 (medium):** `_access_grant_active` did not re-check eligibility at read time. A demoted admin or support member, or a staff type whose right to request was withdrawn, kept reading until expiry. 108 adds the same eligibility rule that request and decision already use. It is reproduced before 108 and fixed after (§5 ⓪, ⑥).
- **Limitations after 108:**
  - **No staff UI:** `request_data_access`, `my_data_access`, `granted_*` and `cancel_data_access_request` have no screen, so in practice the feature is API-only.
  - **Notification link:** the owner notification points to `#access-requests`, which doesn't exist (the panel is `#govAccess`).
  - **Stale requests:** a request pending for more than 7 days can't be decided and blocks new ones until it is cancelled.
  - **Existence probe:** `request_data_access` lets staff probe whether a company or ticket id exists.
  - **Expiry:** checked at read time only, with no sweeper. This is correct, but rows stay "active" in lists until they expire.

### 3.4 `company_suspension_enforced` (099, 102, 103)
- **Who suspends:** `delegate_set_company_status`. With `delegation_enabled` OFF, that means only the platform owner with a step-up. A company owner cannot change their own status (`guard_company_status`). There is no frontend screen.
- **What a suspended company loses:** every plan and override feature through `company_has_feature`:
  - `sub_users`, so member and team management, including permission changes;
  - creating new `api_tokens`;
  - `integrations_hub`;
  - inbox access for staff, and writes for customers.
- **What it keeps (limitation):** ticket access for owner and team, new tickets from customers, existing API tokens, sessions, ihub service-role intake, cron jobs, and the dashboard entitlement display.
- **Production effect today:** none; 0 companies are suspended.

## 4. Edge Functions and frontend

See §4 below, completed from the audit of `supabase/functions/*` and `assets/js/**`.

## 5. Tests performed

### 5.1 New: `tests/sql/phase1-readiness.test.sql` (prod-shape chain to 107, then 108; all sections pass)
All four switches are enabled together through the real path: `owner_set_feature_switch` with owner context and a step-up.

The actors are:
- two companies (A and B), each with an owner, a supervisor and an agent;
- customers A1, A2 and B1;
- a banned member;
- platform elevated admin, admin and support;
- the platform owner;
- a standalone user.

| § | What is asserted |
|---|---|
| ⓪ | **Before 108:** a demoted ex-admin still reads through a grant; the company owner can evaluate a customer's badges, which awards them, notifies the customer and reveals the result |
| ① | The 108 rollback restores the exact schema (digest). Re-applying twice works |
| ② | Elevated admin refused; owner without a fresh step-up refused; owner with step-up enables the four in order; exactly four on; four audit rows |
| ③ | **Visibility:** exact per-actor counts for tickets, replies, attachments, activity, ratings, tags and files. Platform staff see support tickets only; each company sees its own; customers see their own; the banned member sees nothing. Internal notes are hidden |
| ③ | **Refusals:** the definer functions refuse cross-company and personal tickets. Close and reopen return the same 42501 for another tenant's ticket and for a missing one, so there is no existence oracle. Cross-tenant update and reply are refused |
| ③ | **Other data:** notifications are visible to their owner only. Subscriptions go to their owner and admins, never the company owner. Profiles, memberships and companies don't cross. `mcp_ticket_tenancy` is service-only and returns the right team companies |
| ④ | A staff member removed from the team loses company tickets and their MCP context. A removed member keeps their own ticket only, and the company keeps its stamped ticket |
| ⑤ | Permissions OFF: staff lose access, owner and customer keep theirs, matrix writes are refused. ON: access returns, own company only. Cross-company status and assign return P0002 |
| ⑥ | **Grants:** non-staff cannot request; a decision needs a step-up; elevated admin cannot decide; reads are scoped to the company and the grant, audited on every call, and show no internal notes; another staff member cannot use the grant; the company access log shows company A's grant to A and nothing to B |
| ⑥ | **Stopping reads:** demotion and a disabled rule stop reads (108). Switch OFF stops reads and requests; an unrevoked grant works again after re-enable. Revocation, a single-ticket grant and expiry all work |
| ⑦ | **Suspension:** elevated admin without delegation refused; company owner cannot change status. The owner suspends B: B loses features and team management, A is unaffected, B's tickets stay visible (limitation). Enforcement OFF restores; the owner reactivates |
| ⑧ | Badges after 108: evaluating another user returns nothing and writes nothing. Evaluating yourself, as staff, and through the trigger path all still work |
| ⑨ | All four switch OFF through the owner path in reverse order. The legacy behaviour returns |

### 5.2 Existing suites
- **Full SQL suite and full Node suite:** see the results line below.
- **MCP pure modules:** fail-closed tenancy and subscription access (`tests/mcp-ticket-isolation.test.mjs`).
- **Production checks** (read-only or rolled back):
  - the 2026-10-19 isolation probe;
  - `mcp` v35 source compared with the repository on 2026-10-19 at 22:55 and again at 23:14 UTC;
  - a live MCP call through the connector (`get_dashboard_stats`, 200).

### 5.3 What is simulated vs untested
- **Simulated:** every cross-tenant case above, on a local Postgres built from the production schema snapshot (`tests/fixtures/prod-shape`) plus migrations 094–108.
- **Tested in production:** only the rolled-back probe (no company tickets exist), the MCP call, and the read-only state.
- **Untested anywhere:**
  - the external SIE runtime;
  - frontend rendering under each switch in production;
  - MCP under isolation ON against real company data;
  - background jobs (cron, wf-executor) under suspension.
- **What would close the gap:**
  - **In production:** a designated test company. Free-plan projects have no Supabase branching, so this would be ordinary, deletable accounts: one company owner, one employee (supervisor), and two customers. One customer holds a company ticket and a personal platform-support ticket. One account belongs to a second company. Creating them is a production write and needs the owner's approval.
  - **Or a staging project** restored from a schema dump.

## 6. Conditions for Phase 2
1. All four Phase 1 switches are on, each verified after activation (§2). No new errors in the function or Postgres logs for at least 24 h.
2. 108 is reviewed, merged and applied; its self-check passes in production.
3. The test fixture in §5.3 exists, or the owner explicitly accepts the simulated-only evidence.
4. The Phase 2 candidates are re-validated against live state:
   - `multi_company_memberships_enabled` needs isolation ON;
   - `company_inbox_enabled` needs permissions ON;
   - `historical_access_enabled` needs permissions and isolation ON;
   - `delegation_enabled` stays BLOCKED until an MFA-enrolled delegate exists (0 accounts have Supabase MFA today).
5. Nothing in Phase 2 creates a transfer, carry or approved account request. Those make isolation and permissions one-way.
