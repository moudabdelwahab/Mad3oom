# Mad3oom Continuity: reminders, escalation and in-app notifications (094), production install note

> **Design:** `docs/relay/CONTINUITY_ARCHITECTURE_PROPOSAL.md` §4.2, §5.3, §5.4, §7 and §14 (phases S and N; `relay_*` names became `continuity_*`).
> **Decisions:**
> - **D1–D4** (2026-10-12): 60 minutes before plus an alert at due time; no repeat by default; escalate overdue after 240 minutes; pending handover reminder after 60 and escalation after 240.
> - **R3, R4, R7** (2026-10-13): working hours read in Africa/Cairo; supervisors are elevated admins plus the owner; 180-day retention.
>
> **Prerequisite F1** (notification XSS): merged in PR #114. The sidebar renders title and message with `textContent`, the notifications page escapes both, and links must be same-origin.

## What 094 adds
- **Planner** (`_continuity_replan`). It runs from triggers inside the same transaction whenever the planning basis changes:
  - record: `due_at`, `due_tz`, `owner_id`, `status`, `closure_seq`;
  - handover: insert or state change;
  - timing or switch columns of the policy.

  It compares the record's pending jobs with what is needed now: obsolete jobs become `superseded`, new ones are inserted, and repeating the same call adds nothing. The dedupe key covers due time, offset, owner and `closure_seq`, so a basis that already fired is never sent again. **Nothing more than 15 minutes in the past is planned**, so enabling a switch or changing the policy never releases a backlog.
- **Jobs:**

  | Job | When | Recipient |
  |---|---|---|
  | `due_reminder` | `due_at` − each offset (default 60 min) | Owner |
  | `overdue_alert` | `due_at` | Owner |
  | `overdue_repeat` | Off (D2) | Owner |
  | `escalation_overdue` (E1) | `due_at` + 240 min | Supervisors, except the owner |
  | `escalation_unassigned` (E3) | `due_at`, when the record has no owner | Supervisors |
  | `handover_reminder` | Request + 60 min | The recipient. Link to the page only, never the record, since a pending request gives no access |
  | `escalation_handover` (E2) | Request + 240 min | Supervisors |

- **Executor** (`continuity_tick`, pg_cron every minute). It claims due jobs with `SKIP LOCKED` and re-checks each one when it fires:
  - **Record closed:** the job is cancelled.
  - **Due time, owner or reopen count changed:** the job is superseded.
  - **Switch off:** the job is cancelled. Nothing is sent and no backlog builds up.
  - **Pre-due reminder after due, or any reminder more than 6 hours late** (after downtime): superseded.
  - **Escalation outside working hours:** deferred to the next window. Owner reminders are never deferred.
  - **Recipient no longer eligible:** nothing is sent to them.

  It then writes one delivery per job, recipient and channel, and delivers `in_app` by inserting into `notifications` in the same transaction. A failed delivery retries after 1 and then 5 minutes, and is marked `dead` after 3 attempts, with an event.
- **Notification text comes from fixed templates only:** record kind, due time in its zone, and priority. It never contains the title, summary, next action, excerpts or customer data, because elevated admins can read every notification (F2). Category `continuity`; the link is `/admin/continuity.html?record=<id>`.
- **Supervisors as recipients (R4):** active staff with `elevated_admin` authority and the admin role, plus the platform owner, whatever their current session context. No new authority is created.
- **Working hours (R3):** `working_hours` is read in the platform workspace zone (`Africa/Cairo`). If it has no rows, nothing is deferred. In production every day is 09:00–17:00.
- **Retention (R7):**
  - finished jobs and deliveries are deleted after 180 days by `continuity-job-retention` (`29 3 * * *`);
  - policy history is kept;
  - a table guard refuses any other delete.
- **Record page:** a "التذكيرات" section shows upcoming jobs and what happened to recent ones, as kinds and times only, to anyone who can read the record (`continuity_reminders_for`).
- **Switches:** `reminders_enabled` (owner and recipient reminders) and `escalation_enabled` (E1/E2/E3), both **off**. 094 installs the capability markers, so the platform owner can turn them on from Continuity settings. No automatic reassignment ever happens.

## Data, locks, access
- **New tables:** `continuity_jobs` and `continuity_deliveries`. They hold IDs, times and short codes only. RLS is on with no policy and no direct privileges for any role, following the 041/042 conventions. Terminal rows are immutable.
- **Data:** no existing table changes shape. Only new jobs are inserted, for records that are still active.
- **Cron:** `continuity-tick` (`* * * * *`, returns at once when nothing is due, using a partial index) and `continuity-job-retention`.
- **Access:**
  - `continuity_tick` and the retention sweep are closed to everyone except the scheduler;
  - only `continuity_reminders_for` is open, and only to `authenticated`.

## Tests
**SQL:** `tests/sql/continuity-reminders.test.sql`, on the production-shaped fixture, 073 → 081 → 087 → 089 → 091 → 093 → 094:

| Test | What it proves |
|---|---|
| M0 | Install |
| M1 | Planning: kinds and times; reschedule replaces; no duplicates; owner change; close and reopen; E3; D4 |
| M1b | Nothing missed is planned |
| M2 | Switch off at fire time |
| M3 | Reminder: fixed text, record link, no duplicate |
| M4 | No stale batch after downtime |
| M5 | R3 deferral; R4 recipients (a plain admin and a banned elevated admin are excluded; the owner is excluded) |
| M6 | Handover reminder links only to the page; the decision supersedes the escalation |
| M7 | Ineligible owner gets nothing |
| M8 | Failed delivery: retry with backoff, then `dead` with an event |
| M9 | Privacy: no record or customer text in any notification or event |
| M10 | Real concurrency: two ticks at once produce exactly one notification |
| M11 | Retention: only rows older than 180 days are deleted; direct delete is refused |
| M12 | Immutability; readers only; users cannot run the tick |
| RERUN | Running 094 again changes nothing |
| RB | The rollback refuses while deliveries exist; with consent it switches both off (with history), removes everything, sent notifications stay, re-applying works |

**Mutation checks:**
- **Caught (each fails the suite):**
  - switch check removed;
  - late rule removed;
  - working-hours deferral removed;
  - active-account check for supervisors removed;
  - owner exclusion removed;
  - recipient eligibility removed;
  - record title put into the message;
  - retention window shortened (the guard refuses the early delete);
  - superseding removed;
  - backlog cutoff removed;
  - record link given to the handover recipient.
- **Not caught:** the supervisor role check. The fixture has no non-admin with elevated authority, and the authority table's guard keeps it that way.

**Node:**
- model labels;
- a static check that the notification templates read no free-text column;
- a render case for the reminders section: on, off, and before 094.

## Apply (production), after merge
1. Confirm the ledger ends at `093_continuity_collab_actions`, no `094_*` exists, and F1 is deployed.
2. Apply `094_continuity_reminders` through the release wrapper, pinned to the merge commit with an md5 check.
3. Verify:
   - the fingerprint matches the local rehearsal;
   - both cron jobs exist;
   - jobs are planned only for active records;
   - both switches are off.
4. Run a smoke test in a rolled-back transaction: enable inside the transaction, force a reminder due, tick, and check one fixed-text notification to the owner and that escalation recipients are correct.
5. **Enable** `reminders_enabled` and `escalation_enabled` (recorded in the policy history). From then on, real notifications are sent to real staff. To roll back the enablement, switch them off: pending jobs are then cancelled at fire time, and nothing queued is sent.

## Rollback
`migrations/_rollback/094_continuity_reminders.down.sql`.
- It refuses while delivery rows exist, unless the session sets `continuity.rollback_discard_data = 'on'`.
- With consent it:
  - unschedules both cron jobs and drops the triggers;
  - switches both capabilities off, with a history row;
  - drops the functions, both tables and the capability markers, so enabling is refused again.
- Notifications already sent stay with their recipients.
