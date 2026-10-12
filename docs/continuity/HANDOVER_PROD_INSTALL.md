# Mad3oom Continuity: handover with recipient acceptance (081), production install note (NOT EXECUTED)

> **Status:** prepared on 2026-10-12. **Nothing here has been run against production.**
> Each of these needs Mahmoud's explicit approval, and merging the PR is not that approval:
> - applying 081;
> - deploying the frontend;
> - **switching on `handovers_enabled`**.
>
> Reminders and escalation for pending handovers (D4: 60 / 240 minutes) belong to the scheduler increment, not this one.

## Decision implemented: H1 with guardrails (2026-10-12)
| Guardrail | Enforcement (`migrations/081_continuity_handovers.sql`) | Test |
|---|---|---|
| **The requester** can access and manage the record now | Requires `continuity_can_access` and one of: the current owner, a supervisor, or an assigner. An unassigned record can be handed over only by a supervisor or assigner. The record must be active, and the version must match | H1 |
| **The recipient** is active and eligible, and is not the current owner | `_continuity_is_eligible_owner` (same as P3/P4); `already_owner` is refused | H1 |
| **A pending request grants no access** | `continuity_can_access` is unchanged. The recipient cannot read the record, its events or its history, and cannot edit it. They read a **package** through `continuity_handover_get` / `continuity_handovers_mine`: descriptive fields plus source and attachment **counts**, with no excerpts, snapshots or file paths | H2, and a static check on the package query |
| **The owner stays responsible** until acceptance | `owner_id` changes only inside `continuity_handover_decide(…, 'accept')` | H3, H4 |
| **Acceptance re-validates everything** | In one transaction: lock the record then the request; the caller must be the recipient and still eligible; the record must be active; the version must be **the one the recipient saw**; the requester must still be the owner, a supervisor or an assigner (otherwise the request is cancelled with `requester_lost_authority`, and ownership does not move) | H3, H7 |
| **Decline, cancel, expiry or a failed acceptance never move ownership** | Those paths update only the request row, the record version and an event | H3, H4, H5, H7 |
| **Auditable and safe under concurrency** | One pending request per record (partial unique index). Idempotent request, decisions idempotent per state. Events carry hashes, never text | H1, H8a (accept vs cancel), H8b (reassign vs accept), both with two real sessions |
| **Direct reassignment stays with supervisors and assigners** | `continuity_assign`, `continuity_transition` and `_continuity_full` are **unchanged**, byte for byte (tested). A trigger on the record cancels a pending request when the owner or team changes (`reassigned`) or the record closes (`record_closed`), in the same transaction | H6, H9 |

**Team:** a handover never changes the team.

**Deviation from the proposal (documented in the migration):** acceptance compares the record version **the recipient saw** (`p_expected_version`), not the version stored when the request was made. With the stored version, any small edit by the owner would make acceptance impossible forever. With the version seen, such an edit only asks the recipient to look again (`40001`).

**Who may cancel:** the requester, or a supervisor or assigner who can see the record.

**Expiry:** never by time (R2). The `expired` state is reserved for "the recipient became ineligible", which the scheduler will detect.

## Other properties
- **Kill switch** (`handovers_enabled`, off from 078):
  - Off blocks requests, decisions and reads immediately, and ownership does not change.
  - Cancel stays available for cleanup.
  - Closing or reassigning a record always cancels a pending request.
- **History:**
  - Immutable: no delete or truncate, and a decision is made once.
  - Deleting a staff profile keeps the rows, with null actors (lesson from the Codex finding on #118). Tested in H10.
- **Function count:** 33 `continuity` functions are executable by `authenticated` (27 before; 6 new). No `service_role` access.
- **Rollback:** `migrations/_rollback/081_continuity_handovers.down.sql` drops the trigger, functions and table.
  - It refuses while any request exists, unless `continuity.rollback_discard_data = 'on'` is set.
  - Current ownership is untouched.
  - 080's rollback now refuses while 081 is installed.

## Frontend
- **Record page:**
  - «تسليم السجل لموظف» opens a dialog: recipient (the current owner is not listed), reason (required) and context (optional).
  - A pending request shows a banner: who it is for, the reason (as text), and "the owner stays responsible". The requester or a supervisor gets «إلغاء الطلب».
  - The last 5 decided requests appear under «تاريخ التسليم».
- **Main page:**
  - «طلبات تسليم لك» lists incoming requests as packages, with no messages and only counts.
  - «قبول» sends the version that was shown; «رفض» needs a reason.
- **Hidden entirely while the capability is off,** and no handover RPC is called.

## Deploy order
1. Apply 077 → 080 (earlier PRs), then 081.
2. Deploy the frontend.
3. **Decision:** switch on `handovers_enabled`.

## Post-apply verification (read-only)
```sql
select handovers_enabled from public.continuity_policies;                                    -- false
select count(*) from pg_indexes where indexname = 'continuity_handovers_one_pending';         -- 1
select tgname from pg_trigger where tgname = 'trg_continuity_handover_on_record';             -- 1 row
```
Then run `get_advisors` (security).

## Tests
- **`tests/sql/continuity-handovers.test.sql`:** H0–H12, RERUN, and RB-a/b/c.
- **Mutation-checked:** making any of these changes makes a test fail:
  - any record viewer may request;
  - acceptance ignores the version;
  - acceptance ignores the requester's authority;
  - the reassign/close trigger is removed;
  - the package leaks sources.
- **`tests/continuity-handovers.test.mjs`:** the UI rules match the server; the package and banner text is escaped.
- **5 Playwright render tests («handover (081)»).** Mutation-checked: offering the owner as a target, or rendering the reason unescaped, makes a test fail.
