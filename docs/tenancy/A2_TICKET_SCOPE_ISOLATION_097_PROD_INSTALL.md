# A2 — Ticket scope, isolation switch and audited access (migration 097) — production install note

> **Status: NOT EXECUTED.** Nothing here has been applied to production or deployed.
> Prepared 2026-10-14 on branch `claude/dazzling-hypatia-lh1o9i`. Requires 095 and 096.
> Both new switches ship **OFF**: `company_isolation_enforced` and `data_access_grants_enabled`.
> Turning on `company_isolation_enforced` needs your **separate, explicit approval** (Q17). Passing tests is not approval.

Production facts read on 2026-10-14 (read-only SELECT): 39 tickets, 0 tickets by company-linked accounts, 0 attachments on internal replies (2 internal replies), 0 active webhooks, 0 active auto-distribution rules, 1 company. Ledger head: `093_continuity_collab_actions`.
Applying 097 as-is would stamp all 39 tickets as `mad3oom_support`. No visibility changes for any account while the switch is off, except the internal-attachment fix (item 4), which affects 0 production rows today.

## What 097 does

| # | Change | Switch |
|---|---|---|
| 1 | `tickets.scope` (`company` \| `mad3oom_support`) and `tickets.company_id`, stamped at creation by trigger `a_ticket_scope_stamp` and **immutable afterwards** (even for admins and the service role; only a transaction-local `app.ticket_scope_admin` flag can change them, and no code sets it). A company customer's ticket → their company (the server-checked context, else the primary). Personal billing tickets (`category = 'subscription'`), company owners, employees and independent accounts → `mad3oom_support`. A customer may explicitly write to Mad3oom (`scope = 'mad3oom_support'`). | none (data only) |
| 2 | Restrictive policy `tenant_isolation` on `tickets`, `ticket_replies`, `ticket_attachments`, `ticket_activity`, `ticket_ratings`, `ticket_tag_links`, plus `ticket_files_isolation` on `storage.objects` (bucket `tickets`). When on: the author always sees their ticket; platform staff see `mad3oom_support` tickets only; a company's team sees its own company tickets only; a company no longer sees its customers' personal tickets with Mad3oom. Realtime follows RLS, so the same rules apply to subscriptions. | `company_isolation_enforced` |
| 3 | Side channels: the triggers for staff notifications (2), urgent Telegram alerts, the rejected-ticket alert, round-robin auto-assignment to platform agents, outbound webhooks and workflow dispatch get a `WHEN` condition (function bodies unchanged). `check_sla_breaches`, `wf_assign_ticket`, `wf_update_ticket_status` and `mcp_admin_update_ticket` skip or refuse company tickets (MCP answers "not found", so it does not reveal that the ticket exists). | `company_isolation_enforced` |
| 4 | **Permanent fix:** attachments on internal replies (table and file) follow the internal-reply rule: platform staff and elevated authority only. Before 097 the ticket owner could read them. | none |
| 5 | Data-access requests (D9, Q8, Q16): `access_requester_rules` (owner-configurable: support 24 h, admin 72 h, elevated admin 168 h), `request_data_access`, `owner_decide_access_request` (platform owner, owner context + fresh step-up; never on their own request; duration = min(requested, rule, owner choice, 7 days)), `cancel_data_access_request`, `revoke_data_access_grant` (owner or grantee, immediate), `my_data_access`, `owner_access_requests`. | `data_access_grants_enabled` |
| 6 | Reading through a grant never goes through RLS: `granted_company_tickets` and `granted_ticket_view` (non-internal replies, attachment metadata without file paths) write one row to `company_access_audit` per call. That table is append-only (no update, delete or truncate), and grants cannot be extended or deleted. `company_access_log()` shows a company admin who accessed their data, when, and how many reads (role, not name; no request reason). | `data_access_grants_enabled` |
| 7 | Integrations hub: `_ihub_ticket_company` reads the stamp. `ihub_intake_convert` creates the ticket with an explicit company (correct for customers who are additional members). | none |
| 8 | `mcp_ticket_tenancy(actor)` (service role only), for the MCP Edge Function. | — |

## Code that ships with 097 (not deployed)

- `supabase/functions/mcp/_shared/ticket-isolation.js`, `tickets-service.ts`: MCP uses the service role, so RLS does not protect it. The same visibility rule is applied to list, get, update and stats. Before 097, or with the switch off, nothing changes. `subscriptions-service.ts`: MCP subscription requests are created with `category: 'subscription'`, so they stay with Mad3oom and never land in a company's queue.
- `assets/js/portal/*`: the portal lists only tickets of the current company. `assets/js/company/*`: "Customer tickets" lists company-scope tickets only. Rows without `scope` (before 097) show as before.

## Known gaps (documented, not hidden)

- **No UI yet** for staff requests or owner decisions. All functions exist and are tested; the owner console page is a follow-up.
- Granted reads cover tickets only (scope `tickets`). Attachment files are not downloadable through a grant (metadata only).
- Company employees (supervisor and agent) still have **no ticket access** of their own. Permissions are Phase B (098), and the isolation layer already admits them for their own company.
- Edge Functions that read tickets with the service role outside MCP: `chat-bot-reply` (filters by the caller's own `user_id`, safe) and `wf-executor` (acts only on tickets handed to it by `dispatch_workflow_on_ticket_created`, which is gated). Reviewed, unchanged.
- `continuity_sources.ticket_id`: platform Continuity records may already reference a company ticket created before isolation. Production has 0 company tickets, so 0 such rows.
- Found while testing: `mcp_admin_update_ticket` is granted to `service_role` only and checks `is_admin_user(auth.uid())`. The MCP calls it with the service key and no user JWT, so the admin update and close tools likely always fail with 42501 in production. This was pre-existing and is left unchanged; it needs a decision.

## Apply (when approved)

1. Confirm the ledger head and that 095 and 096 are applied.
2. Apply `migrations/097_ticket_scope_isolation.sql` (re-runnable). It self-checks: switches off, every ticket has a valid scope, 6 isolation policies present.
3. Verify (read-only):
   ```sql
   select scope, count(*) from public.tickets group by 1;                     -- mad3oom_support | 39 (today)
   select key, enabled from public.platform_feature_switches order by 1;       -- all false
   select tablename from pg_policies where policyname = 'tenant_isolation';    -- 6 tables
   select policyname from pg_policies where schemaname = 'storage' and policyname = 'ticket_files_isolation';
   ```
4. Deploy the MCP function (`supabase functions deploy mcp`) and the frontend files, in either order.

**Activation (separate approval, later):** `owner_set_feature_switch('company_isolation_enforced', true, '<reason>')` from the owner context with a fresh step-up. Turning it off is the same call with `false`, and takes effect immediately (proven in the test).

## Rollback

`migrations/_rollback/097_ticket_scope_isolation.down.sql` restores 6 functions and 7 triggers byte-for-byte and drops every 097 object. Proven by a full schema digest (functions with ACLs, policies, triggers, columns, table grants, switches) equal to the pre-097 state. It **refuses** while:
- a 097 switch is on;
- any access request, grant or audit row exists (the audit is append-only and is not deleted by a rollback);
- a company ticket's company is not its author's current primary company (the pre-097 rule could not represent it).

Rolling back reopens the internal-attachment leak.

## Tests

`tests/sql/ticket-isolation.test.sql` (production-equivalent chain + 095 + 096):

- ⓪ Visibility per actor (EA, AD, SUP, PU, OA, A1, A2, AS, AG, OB, B1, BS) across tickets, replies, attachments, activity, ratings, tag links and storage objects, plus proof of the internal-attachment leak.
- ① Objects, switches off, backfill with no activity or notification side effects, grants.
- ② With the switch off, visibility is identical per actor except the internal-attachment fix.
- ③ Stamping, including:
  - an explicit Mad3oom ticket, a foreign company, contradictions;
  - billing tickets never going to a company;
  - immutability for an admin and for the superuser;
  - context-based stamping for an additional membership;
  - integrations-hub intake.
- ④ Rollback (schema digest equal) and double re-apply.
- ⑤ Isolation on:
  - staff visibility and writes (update, delete, reply, upload);
  - the company owner's view;
  - the customer's own tickets;
  - turning the switch off restores the previous behaviour.
- ⑥ Side channels: notifications, round robin, webhooks, workflows, MCP, SLA; Mad3oom tickets are unaffected.
- ⑦ Access requests:
  - rules, durations, owner-only decision with step-up, no self-approval;
  - a pending request gives no access;
  - per-call audit, internal content excluded, out-of-scope tickets refused;
  - the company sees the log; revocation, expiry, no extension;
  - audit append-only, tables closed.
- ⑧ Rollback refused with switches on or with audit rows.

Plus `tests/mcp-ticket-isolation.test.mjs`, `tests/portal-model.test.mjs`, `tests/portal.render.test.mjs`, `tests/company-members-model.test.mjs`, `tests/company-navigation.test.mjs`.
