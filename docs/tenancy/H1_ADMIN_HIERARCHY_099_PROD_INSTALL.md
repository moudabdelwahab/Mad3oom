# H1 — Administrative hierarchy, delegations and admin review (migration 099) — production install note

> **Status: NOT EXECUTED.** Nothing here has been applied to production or deployed.
> Prepared 2026-10-14 on branch `claude/dazzling-hypatia-lh1o9i`. Requires 095–098.
> New switches ship **OFF**: `delegation_enabled` and `company_suspension_enforced`.

## Production facts (read-only, 2026-10-14)

There are 7 privileged accounts: 1 platform owner and 6 admins.

| Account (id prefix) | Role | Authority | 2FA | Open assigned tickets | Open Continuity records owned |
|---|---|---|---|---|---|
| fa9c0d85 | admin | elevated_admin | no | 0 | 0 |
| dcd13822 | admin | elevated_admin | no | 0 | 0 |
| e129b0e0 | admin | — | **yes** | 0 | 0 |
| 4e14c2e7 | admin | — | no | 0 | 0 |
| ca08bf0e | admin | — | no | 0 | 0 |
| c8209a98 | admin | — | no | 0 | 0 |
| 44d55aef (owner) | platform_owner | owner | yes | 0 | 1 |

- Applying 099 seeds `admin_account_reviews` with the 6 admins. The owner is excluded. Each review starts as `pending`, with this snapshot.
- None of the 6 has assigned work today, so any decision could be applied immediately once you decide. **No decision is taken by the migration.** Every account stays exactly as it is until you decide and apply.
- 5 of the 6 have no second factor. 099 shows this as readiness (`mfa_ready`) and enforces nothing (safe default 6): no lockout, and no change to authentication settings.

## What 099 does

| Part | Detail |
|---|---|
| Units | `admin_units`: a tree, max depth 6, no cycles, archive instead of delete. A unit can only be archived when it is empty. |
| Members | `admin_unit_members`: platform staff (admin/support) only, as lead or member. Ending a membership keeps the row. |
| Separation (safe default 7) | A member or delegate must not own a company, hold an active company membership, or hold a company staff role. This is re-checked on every delegate call, not only at grant time. |
| Companies | `admin_unit_companies`: one active unit per company. Reassignment ends the old row, so the full history is kept. |
| Capabilities (fixed catalog) | `companies.view_registry` (name, status, plans, member counts only), `companies.suspend`, `units.manage_members` (cannot add self, cannot delegate), `documents.review` (reviewer of assigned documents, used by DOC). |
| Delegations | Granted by the platform owner only (owner context + step-up), with a reason. They cover the unit and its subtree, can expire, can be revoked, are never granted to oneself, and are written to `privileged_audit`. Grants cannot be edited, only revoked and re-granted. |
| No data through hierarchy | No RLS policy references the hierarchy (the migration self-checks this). A delegate who is also an admin sees no company tickets once isolation is on, as proven in the test. |
| Suspension | `delegate_set_company_status` applies within scope and is logged. `guard_company_status` keeps its rule (admin only) plus this logged path. With `company_suspension_enforced` on, `company_has_feature()` returns false for a suspended company. |
| Admin review | `owner_admin_reviews()` shows the snapshot, current facts and readiness. `owner_decide_admin_review(user, keep\|convert_support\|convert_user\|revoke_authority, note)` records a decision. `owner_apply_admin_review(user)` applies it only when there is no open assigned ticket, no open Continuity record and no active delegation. Conversion goes through the existing `owner_set_staff_role`, and `convert_user` also ends unit memberships. `owner_reassign_admin_tickets(from, to, reason)` hands over Mad3oom-support tickets to active platform staff. Continuity records are handed over through Continuity's own handover flow. |
| History | `hierarchy_events`: append-only (no update, delete or truncate). |

The earlier finding that "an owner can change `companies.status`" was already closed in production by `guard_company_status`. 099 keeps that guard and tests it again.

## Apply (when approved)

1. Confirm 098 is applied.
2. Apply `migrations/099_admin_hierarchy.sql`. It is re-runnable. It self-checks that switches are off and that no policy depends on the hierarchy.
3. Verify (read-only):
   ```sql
   select count(*) from public.admin_account_reviews;               -- 6
   select key, enabled from public.platform_feature_switches;       -- all false
   ```
4. Build the hierarchy and decide each review in the owner console (owner context + step-up).

## Rollback

`migrations/_rollback/099_admin_hierarchy.down.sql` restores `guard_company_status` and `company_has_feature` byte-for-byte and drops the rest. This is proven by schema digest.

It **refuses** when:
- a 099 switch is on;
- any unit, delegation or hierarchy event exists;
- any review decision has been taken.

Administrative history is not deleted by a rollback.

## Tests

`tests/sql/admin-hierarchy.test.sql`:

- ⓪ Baseline.
- ① Objects, switches off, reviews seeded with exactly the 3 harness admins (not the owner).
- ①ب Rollback by schema digest, and double re-apply.
- ② Structure:
  - owner-only with step-up;
  - no cycles, depth 6;
  - separation rejects a company owner, a customer, company staff and a plain user;
  - company reassignment history;
  - delegation catalog, reason and audit.
- ③ Delegate:
  - nothing while the switch is off;
  - registry in scope only, with no private fields;
  - suspension in scope only, with an event;
  - **no ticket access through delegation** (with isolation on);
  - member management within the subtree only, never self, never granting delegations;
  - revocation and expiry take effect immediately.
- ④ Suspension enforcement is off by default and on behind the switch; the owner still cannot set status.
- ⑤ Reviews:
  - owner-only decision, MFA readiness shown;
  - authority revocation applied;
  - conversion blocked while a ticket is assigned, and allowed after handover;
  - conversion ends unit memberships; applied once; handover only to platform staff.
- ⑥ Invariants: no policy on the hierarchy, append-only, no delete, no direct read.
- ⑦ Rollback refused once a hierarchy exists.

## MFA enforcement plan (not executed)

1. Ask each admin to enable 2FA. `owner_admin_reviews().mfa_ready` tracks progress.
2. Once all kept admins are `mfa_ready`, add a database gate on `has_elevated_authority()` and `is_admin()` that requires a verified second factor. Start in report-only mode (log refusals) for one week.
3. Turn the gate on with a recovery path agreed in advance: the owner's own account, and a break-glass procedure documented outside the system.

None of this changes Supabase Auth settings.
