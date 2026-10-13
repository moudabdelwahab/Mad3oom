# Mad3oom Continuity: scoped handover 082a (091), production install note

> **Design:** `SCOPED_HANDOVER_DESIGN.md` (#125), decisions S-1 … S-8 approved 2026-10-12.
> **Authorization:** "Complete Mad3oom Continuity — Fully Functional and Editable" (2026-10-12). It does not cover skipping security review or unexpected destructive changes.
> **Numbering:** 090 is `090_ihub_worker_schedule` (integrations branch, already in the production ledger). This is **091**.

## What 091 adds
- **Review sharing (view only).** The record owner, a supervisor or an assigner shares chosen messages and attachments with one eligible staff member. Ownership never changes.
- **Explicit, frozen scope.** The server resolves the chosen IDs at request time and stores them in `continuity_handover_scopes` as a numbered version. The UI never sends "all". A scope never grows by itself.
- **Optional time range** `[from, to)` in an explicit time zone.
- **Expiry starts at acceptance (S-1).** Default 4 hours, maximum 7 days, a session-bound mode (maximum 12 hours) or an end time. Ongoing access is off by default (S-2). The four values are new policy columns, editable by the platform owner.
- **Review before accept.** The recipient sees counts only (no excerpts, no paths). Accepting requires the digest from `continuity_handover_review`:
  - a material change since review (status, owner, team, kind, category, due, scope items) refuses with `40001 material_change` and names the kinds;
  - ordinary edits do not block, and the recipient is told which fields changed.
- **Gate on every read** (`_continuity_active_grant`). It rechecks the state, expiry, bound session (`auth.sessions`, so sign-out stops access at once), recipient eligibility, grantor authority, record status, the kill switch and the action. Any failure returns the same `P0002 not_found`.
- **Shared read** (`continuity_shared_get`) returns only scoped, active messages, renumbered 1…n. C3 still applies: an excerpt is shown only if the recipient can open the conversation now. Normal reads, lists, events and edits are unchanged and do not see grants.
- **Attachments (S-7).** The recipient never signs a file, and the storage policy is unchanged. The edge function `continuity-shared-attachment` calls `continuity_shared_attachment_check` **as the user**, then signs that path for `min(60 s, remaining grant time)`.
- **Lifecycle:**
  - revoke by the grantor, the owner or a supervisor;
  - reassignment, transfer or closing revokes every grant (trigger), and reopening does not restore them;
  - narrowing applies immediately; widening becomes a proposed version that the recipient accepts or rejects, and the old scope governs until then;
  - an hourly sweep (`continuity-grant-sweep`, `37 * * * *`) records expiries. Access stops at expiry without waiting for the sweep.
- **Collab mode** exists in the schema, but every action except view is refused (`feature_not_enabled`) until 082b.

## How 091 changes existing functions
091 makes the same kind of anchored one-line patches as 087. Each patch runs only if the production md5 matches, and the reverse replacement must give back the same md5. The marker is `091_continuity_scoped_handover`.

| Function | Production md5 (verified 2026-10-13) | Patch |
|---|---|---|
| `continuity_handover_decide(uuid,text,text,integer)` | `2b9abbfecccbc43012330d99a563256c` | Refuses non-transfer requests, so a review request can never move ownership |
| `_continuity_guard_handover()` | `9495867c0549803319815a9018e7fd31` | Calls `_continuity_guard_grant` first: mode is fixed, expiry is capped by policy, and a revoked or expired grant has no way back |
| `_continuity_handover_json(continuity_handovers)` | `380c3b9637a45f14c1d689079a88670b` | Adds mode, scope_version, expires_at, session_bound and revoke fields |
| `_continuity_handover_result(uuid)` | `8e6b6caf332763aba1cd26c171563ecc` | Package by mode (counts only for review) |
| `continuity_handovers_mine()` | `45fe064e8742aaa5fc4c44aa8457ac1c` | Same |
| `continuity_set_policies(jsonb,integer)` | `dbc054543efacebd576acb336be59609` | Accepts the four delegation keys |

**Unchanged:** the 6-argument `continuity_handover_request`, cancel, get, `handovers_for_record`, and the 081 record trigger.

**Constraints replaced on `continuity_handovers`:** `continuity_handovers_state_check`, `continuity_handovers_cancel_cause_check` and `continuity_handovers_state`. Their names were verified in production. The new versions add `revoked`, `time` and `session`; the 081 cases are unchanged.

## Data, locks, access
- **Data:** new columns with defaults on `continuity_handovers` (0 rows in production) and on `continuity_policies` (1 row), plus one new table. No existing row changes.
- **Locks:** `ALTER TABLE … ADD COLUMN` with constant defaults and the constraint swaps on 0-row and 1-row tables take milliseconds.
- **Access:**
  - `continuity_handover_scopes` has RLS, no policy and no direct privileges for any role, plus the 041/042 conventions;
  - 22 internal functions are revoked from everyone;
  - 11 RPCs are executable by `authenticated` only (not `anon` or `service_role`);
  - no `continuity_*` table is in `supabase_realtime`;
  - the storage policy count stays at 1.
- **Edge function:** `continuity-shared-attachment`, deployed with `verify_jwt = true`. The service key is used only to sign the path the database returned.

## Tests
**SQL:** `tests/sql/continuity-scoped-handover.test.sql`, on the production-shaped fixture, 073 → 081 → 087 → 089 → 091:

| Test | What it proves |
|---|---|
| G0 | Install |
| G1 | Request rules |
| G2 | A pending request grants nothing |
| G3 | Decide: review, digest, material change, time starts at acceptance |
| G4 | Scoped read: renumbering, C3, no widening of normal access |
| G5 | Range boundaries (UTC and Cairo) |
| G6 | Attachment check: scope, TTL ≤ remaining, storage unchanged |
| G7 | Session binding and sign-out |
| G8 | Time expiry before the sweep |
| G9 | Revoke, reassign, close, reopen |
| G10 | Narrow, propose, accept, reject |
| G11 | Kill switch, recipient eligibility, grantor authority |
| G12 | Immutability, identical `not_found`, relay-api refused |
| G13 | Transfer unchanged; policy limits |
| RERUN | Running 091 again changes nothing |
| RB | The rollback refuses without consent; with consent it restores all six md5s; re-applying works |

**Mutation checks** (each fails the suite):
- scope list ignored;
- expiry ignored;
- other-session check removed;
- attachment scope check removed;
- C3 removed;
- TTL not bounded;
- narrowing check bypassed;
- reassignment trigger disabled.

**Node:**
- `tests/continuity-shared-attachment.test.mjs` (edge function handler);
- `tests/continuity-model.test.mjs` (scope builder and texts);
- `tests/continuity-phase-c.render.test.mjs`, 6 `share (091)` cases:
  - share dialog with an explicit scope and recipient preview;
  - refusal inside the dialog, with the same idempotency key on retry;
  - incoming review and digest accept, plus the material-change message;
  - shared panel, read-only view, attachment through the function, and proposal consent;
  - grants on the record and revoke;
  - before 091 there is no UI; the dialog fits at 390 px.

## Apply (production), after merge
1. Confirm the ledger contains `089_continuity_attachment_cleanup_schedule`. 091 has no dependency on `090_ihub_worker_schedule`. Confirm the six md5s above still match and `continuity_handover_scopes` does not exist.
2. Apply `091_continuity_scoped_handover` through the release wrapper, pinned to the merge commit with an md5 check.
3. Deploy `continuity-shared-attachment` with `verify_jwt = true`.
4. Verify:
   - 6 functions carry the marker and `pg_cron` has `continuity-grant-sweep`;
   - the fingerprint matches the local rehearsal;
   - a smoke test in a rolled-back transaction: request, review, accept, shared read and revoke between two staff test identities, on no real conversation.

**Enablement:** no new flag. Sharing follows `handovers_enabled`, which is already on, so the UI appears once 091 is applied (it detects `continuity_shared_with_me`). To hold it back without rolling back, switch `handovers_enabled` off; that also stops transfer handovers.

## Rollback
`migrations/_rollback/091_continuity_scoped_handover.down.sql`.
- It refuses if any review or collab request exists, unless the session sets `continuity.rollback_discard_data = 'on'`.
- With consent it deletes only those rows and their scopes, reverses the six patches (proving each md5), restores the 081 constraints and drops the new columns, table, functions, trigger and cron job.
- Transfer history and record ownership are untouched.
- To retire the edge function, delete it after the rollback; without 091 it can only return `not_found`.
