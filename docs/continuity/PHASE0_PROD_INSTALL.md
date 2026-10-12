# Mad3oom Continuity Phase 0: production install note (NOT EXECUTED)

> **Status:** prepared on 2026-10-12. **Nothing here has been run against production.**
> - Applying 078, deploying the frontend and turning on any capability each need Mahmoud's explicit approval.
> - Merging the PR is not that approval.

## What changes
**`migrations/078_continuity_policies.sql`** (requires 077):
- **`continuity_policies`:** one row per workspace.
  - All six capability switches are off: handovers, reminders, escalation, monitor, attachments, AI.
  - Timings use the approved defaults D1–D4: a reminder 60 minutes before the due time, a notification at the due time, escalation to supervisors after 240 minutes overdue, and a pending-handover reminder after 60 minutes and escalation after 240.
  - The working-hours flag is on.
- **`continuity_policy_history`:** append-only. It records who changed which value, before and after.
- **`continuity_get_policies()`:** for members.
- **`continuity_set_policies(patch, expected_version)`:** for the platform owner only (decision R1). It validates the patch, checks the version and writes history.
- **No capability can be switched on before its code is installed.** Each capability's own migration creates a marker function `_continuity_capability_<name>()`. 078 creates none, so every attempt to enable a capability is refused.
- **`continuity_my_access()`** gains `capabilities` (all `false`). All existing keys and values are unchanged.
- The 18 other public RPCs are unchanged byte for byte (tested).

**Frontend:**
- The page header shows the Continuity logo, «الاستمرارية» and "Mad3oom Continuity".
- The sidebar link gets an infinity icon.
- A read-only «إعدادات الاستمرارية» panel appears for the platform owner once 078 is applied. Before that it stays hidden.

**Docs:** the stale "not applied / NOT EXECUTED" status lines for 073, 074 and 076 are corrected.

## Deploy order
- 077 (PR #116) first, then 078, then the frontend.
- The frontend tolerates 078 being absent (no `capabilities` key: the panel stays hidden).

## Pre-apply checks (read-only)
1. Run `list_migrations` and confirm that `077_continuity_namespace` is applied and no 078 exists.
2. Confirm that `continuity_my_access` matches its 077 text. The rollback restores that text.

## Apply
- The file is idempotent and has no `begin`/`commit`. `apply_migration` runs it in one transaction.
- **The final block aborts if any of these fails:**
  - no permissive policy on the 8 Continuity tables;
  - no direct grants;
  - 041/042 conventions present;
  - exactly 21 `continuity_*` RPCs for `authenticated`;
  - `search_path` pinned;
  - the platform policy row exists with every switch off.

## Post-apply verification (read-only)
```sql
select handovers_enabled, reminders_enabled, escalation_enabled, monitor_enabled, attachments_enabled, ai_enabled,
       reminder_offsets_minutes, due_alert, escalate_after_minutes, handover_remind_after_minutes,
       handover_escalate_after_minutes, version
  from public.continuity_policies;                       -- all false; {60}; true; 240; 60; 240; 1
select count(*) from public.continuity_policy_history;   -- 0
```
Then run `get_advisors` (security).

## Rollback
- `migrations/_rollback/078_continuity_policies.down.sql` restores `continuity_my_access` to its 077 text and drops the two tables and two RPCs.
- It refuses to run while the policy history has rows, unless `continuity.rollback_discard_data = 'on'` is set.
