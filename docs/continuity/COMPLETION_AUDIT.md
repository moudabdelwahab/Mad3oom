# Mad3oom Continuity — completion audit (2026-10-12)

**Scope.** Inspected:
- `main` at `e2c0a21`;
- production `srnelrdpqkcntbgudyto`, ledger through `086_company_staff`;
- `admin/continuity.html`, `admin/continuity-record.html` and the inbox composer;
- `assets/js/continuity/*` and `supabase/functions/continuity-*`;
- migrations 073–086;
- the Node, SQL and Playwright suites.

**Note on file names.** `admin/relay.html` no longer exists; it became `admin/continuity.html` in 077.

**Rule applied.** A button, RPC or table alone does not count as a finished feature. "Works" below means:
- a server path exists for each read and write;
- it is permission-checked on the server;
- it is reachable from the UI;
- it is covered by a test that exercises it.

## 1. Feature table (state on `main` before increment 1)

| Feature | UI | Backend wired | Read / write / edit / delete | Permissions correct | Tested | Missing |
|---|---|---|---|---|---|---|
| List and filters (status, owner, type) | yes | `continuity_list` | read | yes (`continuity_can_access`) | SQL + render | — |
| Create a record from the inbox (with messages) | yes (composer) | `continuity_create` | write | yes (P3) | SQL + render | — |
| **Create a record from the Continuity page** | **no** | `continuity_create` (accepts `sources: []`) | — | — | — | No UI at all → **increment 1** |
| Edit fields | partial: title, summary/problem, next action, due, priority, category | `continuity_update` | edit | **no**: anyone who can read can edit (P1) | SQL + render | Issue fields `known_facts` / `unknowns` / `resolution_criteria` are in the DB but not in the UI. Edit ≠ read → **increment 1** |
| Status, close, reopen | yes | `continuity_transition` (079) | edit | yes (owner or supervisor) | SQL + render | — |
| Assign, reassign, claim | yes (owner select) | `continuity_assign` (P3/P4) | edit | yes | SQL + render | No one-click "claim" for an unassigned record → **increment 1** |
| Attach messages | yes (inbox, «إرفاق بسجل موجود») | `continuity_attach_sources` | write | **no**: any viewer (P2) | SQL + render | Edit ≠ read → **increment 1** |
| Remove / restore a message (trash) | yes | `continuity_remove_source` / `restore_source` (076) | delete/restore | **no**: any viewer (T1) | SQL + render | → **increment 1** |
| Permanent erase | yes | `continuity_redact_source` / `purge_removed` | delete | yes (platform owner only, T2) | SQL + render | — |
| History (events) | labels only, newest 50 | `continuity_events_for` (paged by `p_before`) | read | yes | partial | No detail (which fields, from → to), no paging → **increment 1** |
| Closure history | yes | `closures` in `_continuity_full` (079) | read | yes | SQL + render | — |
| Standalone record window | yes | same RPCs | — | yes (link grants nothing) | render | — |
| Attachments: upload, voice, view, remove, restore, erase | yes | 080 RPCs + `continuity-attachment-upload` (deployed) + private bucket + one SELECT policy | all | **no**: any viewer can upload or remove | SQL + Node + render | Edit ≠ read → **increment 1**. Capability **off in production**. `continuity-attachment-cleanup` deployed, but `CONTINUITY_CLEANUP_SECRET` and its schedule are not set (purged objects are not deleted from storage yet) |
| Handover, full ownership transfer (081) | yes (request, accept/decline, cancel, incoming list) | 081 RPCs, record trigger | all | yes | SQL + render | Capability **on in production** (2026-10-13) |
| **Scoped handover, 082a** (review = view only; explicit scope; expiry from acceptance; revoke; amend; 60 s attachment proxy) | yes (share dialog, incoming review + digest accept, shared-with-me panel, read-only shared view, grants on record) | 091 + `continuity-shared-attachment` | all | yes | SQL G0–G13 + mutation checks, Node, render | Built; see `SCOPED_HANDOVER_091_PROD_INSTALL.md`. Collab actions (082b) not built: the server refuses them (`feature_not_enabled`) |
| Policies and kill switches | **read-only** panel | `continuity_get_policies` / `continuity_set_policies` (owner, versioned, with history) | read | yes (owner) | SQL + render | The owner cannot change anything from the UI → **increment 1** |
| Assign privilege (grant/revoke) | yes | 076 RPCs | write | yes (owner) | SQL + render | — |
| **Reminders / due alerts (D1)** | no | no scheduler, jobs or deliveries | — | — | — | Not installed (`_continuity_capability_reminders` absent) |
| **Escalation (D3/D4)** | no | no | — | — | — | Not installed. Open items: R3 (working-hours source), R4 (supervisor recipient predicate), R7 (retention of job rows) |
| **Monitor** | no | no | — | — | — | Not installed. No supervisor metrics were ever specified; only per-record reasons |
| **Notifications for Continuity** | none | none | — | — | — | `notifications` exists with `is_read`. Elevated admins can read every row (F2), so templates must carry IDs and fixed labels only. No preferences table exists |
| **AI suggestions (A1)** | no | no | — | — | — | Not installed. Sending production conversation content needs A2 (legal check, U4) and a chosen processor (R9). Neither is approved |
| **API & integrations** | no | no | — | — | — | No approved spec (C6 open). Not built, by design |
| Company scope (company workspace) | no | 086 staff roles, no consumer | — | — | SQL | Increment 2+ of the multi-tenant plan; not started |

## 2. Feature flags and kill switches (production, read-only check)
| Switch | Installed | Production value |
|---|---|---|
| `handovers_enabled` | yes (081) | false |
| `attachments_enabled` | yes (080) | false |
| `reminders_enabled` / `escalation_enabled` / `monitor_enabled` / `ai_enabled` | **no** | false. The server refuses to enable them |
| `continuity_workspaces.enabled` (platform) | — | true |
| pg_cron `continuity-retention-sweep` | — | active (17 3 * * *) |
| pg_cron `continuity-attachment-sweep` | — | active (23 * * * *) |

## 3. Tests
**Playwright: the 36 failures were caused in the repo, not by the environment.**
- **Which tests:** `tests/chat-page.render.test.mjs` (13) and `tests/chat-widget.render.test.mjs` (23).
- **Cause:** both call `chromium.launch()` with no `executablePath`. Playwright 1.49.1 then looks only for its pinned build, `chromium_headless_shell-1148`. Every other render test resolves the installed Chromium first (`resolveChromium()`).
- **Why CI was green:** CI downloads build 1148 (`tests.yml`: `npx playwright install`). The container ships 1194.
- **Proof:** with the same resolver, the result is 36 pass and 0 fail on Chromium 1194. Fixed in increment 1.
- **The 37th "not ok":** the opt-in visual test, which is a `# SKIP` and not a failure.

## 4. Decisions applied
- **E1 (2026-10-12, this brief): "do not allow editing just because the user can see the record."** This replaces P1/P2/T1 (Phase C, 2026-10-09):
  - **Read:** unchanged.
  - **Edit fields, manage sources and manage attachments:** record owner or supervisor.
  - **Assign:** P3/P4, unchanged.
  - **Status:** owner or supervisor, unchanged.
  - **Erase:** platform owner, unchanged.
- **Migration numbering:** production applied 077–081, then 085 and 086. New work continues at **087+**. 090 is `090_ihub_worker_schedule` (applied from the integrations branch on 2026-10-13), so scoped handover is **091**. The reserved numbers 082–084 stay unused, so the ledger never applies a lower number after a higher one.
