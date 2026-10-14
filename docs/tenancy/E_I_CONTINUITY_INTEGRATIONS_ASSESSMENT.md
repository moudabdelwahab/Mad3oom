# E + I — Company-level Continuity and integrations: assessment (no migration)

> Prepared 2026-10-14 on branch `claude/dazzling-hypatia-lh1o9i`. The order says: "Proceed when their dependencies and current architecture have been verified. Keep every company-private path scoped from inception."
> Result: **Phase I needs no new migration**; its company paths were scoped in 088 and 096–099. **Phase E is not implemented**. The verified architecture shows it is a cross-cutting rewrite of Continuity's access model, and a partial version would open the platform paths this programme closes. The current state is safe, and the plan is below.
> Production was only read (`list_edge_functions`, read-only SELECTs). Nothing was changed.

## Phase E — Continuity for company workspaces

### What exists (verified on the local production-shaped chain, 093 + 094)

| Item | State |
|---|---|
| Schema | `continuity_workspaces.kind` already allows `'platform'` and `'company'`. It has `company_id` (unique, FK to companies with cascade) and the check `(kind = 'company') = (company_id is not null)`. Only the single platform workspace exists. |
| Access predicate | `continuity_can_access(record)` joins `w.kind = 'platform'` and requires `_continuity_is_member()`, which means Mad3oom staff. **A company workspace would be unreachable today: fail-closed.** |
| Sources | `_continuity_attach` accepts only `mad3oom_message` (platform inbox messages), checked with `_continuity_can_read_conversation` → `inbox_can_access`. Any other type answers `0A000 feature_not_enabled`. `continuity_sources.ticket_id` exists but no ticket source type is enabled. |
| 094 (PR #133, merged into `main` 2026-10-13, now merged into this branch) | Reminders and escalations go to "active elevated admins plus the platform owner". That is right for platform records, and **wrong for company records**: it would notify Mad3oom staff about a company's private follow-ups. |

### Why platform Continuity cannot reach company data today

- Its only source type is platform inbox messages. Those are Mad3oom's own conversations: company owners and customers talking to Mad3oom support.
- Company tickets are not a source type, and the 097 install note records 0 such references in production.
- Company conversations (102) live in tables with no grants and no platform path. Continuity has no adapter for them.

### What company Continuity needs (one dedicated migration series, after its own review)

1. A workspace-aware membership predicate: company admin plus employees with new 098 catalog keys (`continuity.view`, `continuity.edit`, `continuity.assign`, …). Platform staff get **nothing** in a company workspace, outside 097-style audited grants.
2. `continuity_can_access` and every `_continuity_*` predicate (about 60 functions) branch on the workspace kind. Handovers and delegations stay within the same company.
3. New source adapters: `company_message` (102, checked with `_inbox_staff_access`) and `company_ticket` (097/098, checked with `_company_ticket_access`). Each is verified at capture time and again on read, and a cross-company source is refused.
4. 094 recipients by workspace kind: company admins and supervisors for a company workspace, never elevated admins. Policy rows exist per workspace.
5. Attachments: storage paths scoped by workspace, plus the existing quarantine and purge rules.
6. Company dashboard UI and a `company_continuity_enabled` switch (OFF).
7. Tests: the cross-company matrix (company A ↔ B, platform ↔ company, delegate ↔ company), attachments, reminders, redaction and retention, plus apply/rollback/re-apply.

**Dependency order:** 098 (permissions catalog) → 102 (company conversations as a source) → this series. 094 is now in `main`, and the series must patch its recipient selection.

## Phase I — Integrations

### Verified company scoping (no change needed)

| Path | Scoping |
|---|---|
| Integrations Hub tables (`ihub_*`, 088) | No table grants for `anon` or `authenticated`. The only policy is the restrictive `gate_account_active`. All access goes through RPCs gated by `_ihub_require_admin()`: signed in, active account, not preview, company admin, `integrations_hub` entitlement. That function returns the caller's own `current_company_id()`. |
| Tickets created from integrations | `_ihub_ticket_company` reads the 097 stamp. `ihub_intake_convert` creates the ticket with an explicit company, which is correct for customers who are secondary members. |
| Customer links | 096 unlinks `ihub_customer_links` when a membership ends. No link survives a customer leaving or being transferred (101 uses the same path). |
| Suspension | With `company_suspension_enforced`, `company_has_feature()` is false for a suspended company, so the hub is closed (099). |
| Platform webhooks and workflows (`webhooks`, `wf_*`) | Platform tools (`is_admin`, `wf_is_staff`). With `company_isolation_enforced`, 097 stops company tickets from dispatching to them. |
| MCP | 097 applies the same visibility rule to MCP ticket list, get, update and stats (it uses the service role, so RLS alone would not protect it). MCP has no access to company conversations (102). |
| Company conversations (102) | No integration, webhook, workflow or MCP path exists. Adding one later must go through `_inbox_staff_access`. |

### Edge Functions deployed without source in this repository (read-only check, 2026-10-14)

`sie-api` (v24, `verify_jwt = false`), `integrations-api` (v10, `verify_jwt = false`), `register-whatsapp`, `whatsapp-webhook` and `gemini-proxy` are deployed. Their source is not in this repository. `supabase/functions/_PRODUCTION_SNAPSHOTS.md` records them in the drift baseline, with source in other repositories or in `_retired/`.

**Tenancy risk:** these functions cannot be reviewed from here. If any of them reads tickets, chats or customer data with the service role, RLS (including 097's isolation) does not constrain it.

**Recommendation before turning on `company_isolation_enforced`:**
- bring their source into the repository and review it; or
- confirm in writing that they never read company tickets, company conversations or company customers.

`sie-api` and `integrations-api` take public, non-JWT traffic, so they come first.

Not deployed yet from this branch: `company-document-upload`, `company-document-download`, `document-scan-callback` (100) and `ticket-carry-copy` (101). Each needs its own deployment approval.

### Other findings carried into the final report

- `manage-external-integration` (deployed v22): the bug is fixed in the repository but not deployed. The deployment needs approval.
- `mcp_admin_update_ticket` is granted to `service_role` only but checks `is_admin_user(auth.uid())`. Called by the MCP function with the service key and no user JWT, the admin update and close tools likely always fail in production (recorded in the 097 note).
