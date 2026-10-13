# Mad3oom Continuity: attachment cleanup schedule (089) and enabling attachments and handovers

> **Authorization:** "Complete Mad3oom Continuity — Fully Functional and Editable" (2026-10-12), Phase 4. A feature that is complete and verified is enabled under a safe rollout plan, verified after enablement, and documented with how to stop it.

## Why 089 comes first
When an attachment is removed by the owner, erased (`purge`), redacted by retention or abandoned while uploading, 080 queues its file for deletion. Until now nothing deleted the file:
- the queue is `continuity_attachment_deletion_queue`;
- the cleanup function `continuity-attachment-cleanup` was deployed, but `CONTINUITY_CLEANUP_SECRET` and the schedule were never set.

The file could not be read (the bucket policy requires an active attachment), but it stayed in storage. **Attachments are not switched on before this is fixed.**

## 089
**What it adds (following the project's pattern: `internal_service_secrets` plus `net.http_post`):**
- **Secret:** 32 random bytes, generated **inside the database**, stored in `internal_service_secrets`.
  - That table has RLS on and no policy, and only `service_role` can read it.
  - The secret never appears in a file, a log or a tool call.
  - Re-running 089 keeps the existing secret.
- **`_continuity_attachment_cleanup_call()`:** posts to the function with `X-Cleanup-Secret`. It is closed to every role; only pg_cron calls it.
- **pg_cron job `continuity-attachment-cleanup`:** runs at minute 41 every hour, after the sweep at :23 has queued files.

**Function change:**
- `continuity-attachment-cleanup/index.ts` takes the secret from `CONTINUITY_CLEANUP_SECRET` if that is set, otherwise from the database row.
- A request **without** the header is refused before any database read.
- It is redeployed **without `verify_jwt`**, like the other internally triggered functions (`wf-executor`, `send-ticket-email`), because pg_cron has no JWT.
- The shared secret, compared in constant time, is the authentication. It was already enforced by `handler.js`, and is tested in `tests/continuity-attachments.test.mjs`.

**Tests:** `tests/sql/continuity-attachment-cleanup-schedule.test.sql`
| Test | What it proves |
|---|---|
| C1 | Secret format; unreadable to `authenticated` and `anon`; a re-run keeps it and touches no other secret |
| C2 | Correct URL; the secret travels only in the header; the call function is closed to every role |
| C3 | No secret means no call |
| RB | The rollback removes the function and the secret; re-applying generates a new secret |

**Rollback:** `_rollback/089_continuity_attachment_cleanup_schedule.down.sql`. Erased files then stay (unreadable) until 089 is re-applied.

## Enabling (owner setting, `continuity_set_policies`)
| Capability | Installed by | Precondition | Verification after enabling |
|---|---|---|---|
| `attachments_enabled` | 080 (+087 edit gate, +089 cleanup) | 087 and 089 applied; upload and cleanup functions deployed | `continuity_my_access.capabilities.attachments = true` for platform staff and false for others. Bucket private with one policy. Read-only smoke test in a rolled-back transaction (owner can begin, team member gets `42501`, non-reader gets `P0002`). A cleanup run reports 200. |
| `handovers_enabled` | 081 | 087 applied | `capabilities.handovers = true`. Rolled-back smoke test: request and decide paths for owner, recipient and stranger. No notification is sent (there is no notifier yet) |

**Stop or roll back** (the owner can do this at any time from «إعدادات الاستمرارية»):
- **Attachments off:** uploads, reads (signed URLs) and attachment lists stop immediately. Rows and files are kept; turning it back on restores them.
- **Handovers off:** requests, decisions and reads stop. Cancel stays available. Ownership never changes while it is off.

**Production data:** verification uses rolled-back transactions only. No customer conversation is created and no notification is sent.
