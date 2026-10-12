# Mad3oom Continuity: closure history and controlled reopen (079), production install note (NOT EXECUTED)

> **Status:** prepared on 2026-10-12. **Nothing here has been run against production.**
> - Applying 079 and deploying the frontend each need Mahmoud's explicit approval.
> - Merging the PR is not that approval.

## Why
Before 079, reopening a record cleared `resolution_note`, `resolved_*` and `cancel_reason` from the record row. The events keep only a hash of that text, so **the earlier closure text was lost** on every reopen. The approved requirement (proposal §15.1):
- a closed record stays visible;
- it is reopened only by an explicit, audited action;
- reopening keeps the closure history;
- an expired deadline is never silently reused.

## What changes
**`migrations/079_continuity_reopen_lifecycle.sql`** (requires 077 and 078):
- **`continuity_closures`**: one row per closure (`seq`). It holds:
  - the status, time and actor;
  - the resolution note or cancel reason;
  - after a reopen: the time, actor and reason.
- **How the table is protected:**
  - Append-only: no delete.
  - The only update allowed fills the `reopened_*` columns once.
  - No direct grants; the 041/042 conventions apply.
  - It is readable only through `continuity_get` (the record's existing access rules).
- **`continuity_records.closure_seq`**: the number of closures.
- **`continuity_transition`, closing:** resolving or cancelling also writes a closure row.
- **`continuity_transition`, reopening:**
  - the target is always `open` (decision L1);
  - the reason is required;
  - it fills `reopened_*` on the latest closure instead of erasing it;
  - a follow-up whose due time has passed, is within 5 minutes, or is missing needs a new `details.due`, otherwise `validation_failed / due_required_on_reopen`;
  - any new due sent at reopen must be strictly in the future (`in_past`), without the 5-minute grace that creation allows;
  - a future due stays unless a new one is sent;
  - who may reopen is unchanged: the owner or a supervisor;
  - the version check is unchanged;
  - retention-expired excerpts are still hidden at reopen;
  - the `reopened` event payload adds `closure_seq` and the due change. It carries no text, only hashes, as before.
- **`_continuity_full`** adds `closures`, newest first.
- **No new public RPC.** `authenticated` can still execute exactly 21 `continuity_*` functions. The `relay_transition` wrapper calls `continuity_transition`, so it gets the new behaviour.
- **Backfill:**
  - Existing records get their closures rebuilt from the `resolved` / `cancelled` / `reopened` events, in order.
  - The current closure of a still-closed record takes its text from the record row.
  - Earlier closures that were reopened before 079 have no text (only hashes were stored) and are marked `backfilled`. The page says "not saved" instead of showing an empty field.
  - No event is modified.

**Frontend:**
- **«تاريخ الإغلاق» section** in the record detail. All text is escaped. The section is hidden when the server sends no `closures` (before 079).
- **Reopen dialog:** the reason is required. A due field is shown, required when the server would require it (`reopenRequirements`). The current due is kept when the field is left empty.
- **Server refusals** (`due_required_on_reopen`, `in_past`) are explained.

## Deploy order
- 077 (PR #116), then 078 (PR #117), then 079, then the frontend.
- **The frontend tolerates 079 being absent:**
  - no closures section;
  - reopen sends `{reason}`, plus `due` only if the user filled it;
  - a pre-079 server ignores `due`, as before.

## Pre-apply checks (read-only)
1. Run `list_migrations` and confirm that 077 and 078 are applied and no 079 exists.
2. Count what the backfill will see:
   ```sql
   select status, count(*) from public.continuity_records group by 1;
   select kind, count(*) from public.continuity_events where kind in ('resolved','cancelled','reopened') group by 1;
   ```

## Apply
- The file is idempotent and has no `begin`/`commit`. `apply_migration` runs it in one transaction.
- **The final block aborts if any of these fails:**
  - no permissive policy and no direct grant on the 9 Continuity tables;
  - the 041/042 conventions are present;
  - exactly 21 functions are executable by `authenticated`;
  - `search_path` is pinned;
  - every closed record has exactly one open closure at `closure_seq`;
  - no active record has an open closure;
  - `closure_seq` equals the number of closures.

## Post-apply verification (read-only)
```sql
select r.status, r.closure_seq, count(c.*) as closures, count(c.*) filter (where c.reopened_at is null) as open_closures
  from public.continuity_records r left join public.continuity_closures c on c.record_id = r.id
 group by r.id, r.status, r.closure_seq;    -- closed: open_closures = 1; active: 0; closures = closure_seq
```
Then run `get_advisors` (security).

## Rollback
- `migrations/_rollback/079_continuity_reopen_lifecycle.down.sql`:
  - restores `continuity_transition` and `_continuity_full` to their 077 text, byte for byte (tested);
  - drops `continuity_closures` and `closure_seq`.
- It refuses to run while a reopened closure holds text that would be lost, unless `continuity.rollback_discard_data = 'on'` is set.
- If the new frontend is deployed, it keeps working after rollback: the closures section disappears.

## Tests (local, production-shaped fixture)
`tests/sql/continuity-reopen.test.sql`:
- **L1:** backfill.
- **L2:** close/reopen cycles keep the text.
- **L3:** due rules, including the strict future check.
- **L4:** permissions for every persona, plus the API path.
- **L5:** idempotent replay and version conflict.
- **L6:** two concurrent reopens, via dblink.
- **L7:** history immutability, even for a superuser owner.
- **L8:** retention at reopen.
- **L9:** the `relay_transition` wrapper.
- **RERUN, RB-a/b/c:** re-run, then rollback and re-apply.

Unit tests: `tests/continuity-reopen.test.mjs`. Render tests: `tests/continuity-phase-c.render.test.mjs` («reopen (079)»).
