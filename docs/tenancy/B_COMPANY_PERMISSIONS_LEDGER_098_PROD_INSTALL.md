# B — Company permissions, team tickets and usage ledger (migration 098) — production install note

> **Status: NOT EXECUTED.** Nothing here has been applied to production or deployed.
> Prepared 2026-10-14 on branch `claude/dazzling-hypatia-lh1o9i`. Requires 095, 096 and 097.
> New switch `company_permissions_enabled` ships **OFF**. The usage ledger has no switch: it only records (shadow mode) and decides nothing.

## What 098 does

### Company permissions (Q11) — behind `company_permissions_enabled`

| Permission | Supervisor default | Agent default | Enforced by |
|---|---|---|---|
| `customers.view` | yes | no | `company_customers_list()` |
| `tickets.view` (all company tickets) | yes | no | policies + `company_tickets_list()` |
| `tickets.view_assigned` | yes | yes | same |
| `tickets.reply` | yes | yes | insert policy on `ticket_replies` / `ticket_attachments` / ticket files |
| `tickets.internal_notes` | yes | yes | read and write team internal notes |
| `tickets.status` | yes | yes | `company_ticket_set_status()` (open / in-progress / resolved / rejected) |
| `tickets.assign` | yes | no | `company_ticket_assign()` (active member of the same company only) |

- **Fixed catalog:** a company cannot add keys. The company owner can change the role default (`company_set_role_permission`) and override per employee (`company_set_user_permission`; `null` removes the override). Every change is written to an append-only `company_permission_events`.
- **Hard limits outside the catalog:** no permission opens company subscriptions, API tokens, customers' personal data (095), another company's data, or platform-staff notes.
- **Team internal notes:** visible to members with `tickets.internal_notes` and written by a member of that company's team. Notes written by Mad3oom staff are never shown to the company.
- **Status and assignment:** go through the two functions. There is no direct `UPDATE` on tickets for the team.
- **Isolation:** the 097 restrictive layer still applies, so with isolation on, platform staff see none of this.
- **Switch off:** employees have no ticket access (same as today), and the customer list behaves as in 096 (proven per actor).

### Usage ledger (Q9, Q10) — shadow mode

- `billing_rule_versions`:
  - **v1 `active`** is today's calculation exactly (`ticket_quota_status`: every ticket of an account and its linked accounts is billed to the account owner).
  - **v2 `proposed`**: company tickets billed to the company; Mad3oom-support tickets billed to their author's personal plan; carried tickets not billed.
- `usage_ledger`:
  - One row per event (`ticket_created`, `billing_linked`, `ticket_deleted`), with a unique `idempotency_key`. It is append-only (no update, delete or truncate).
  - The billed account is **fixed at the time of the event**, so a later customer move between companies does not change recorded usage.
- **Backfill:** one `ticket_created` row per existing ticket, plus `billing_linked` pairs for subscription-linked tickets. Production today: 39 tickets, so 39 rows plus links.
- `usage_reconciliation(period)` (owner or service role): compares the ledger with the live count per account. The only expected difference is `membership_changed`, where an account's linked customers moved after their tickets were recorded. Anything else is reported as `unexplained`. The migration refuses to finish if the current month does not match.
- `usage_projection(version, period)`: what each account would be billed under a rule version (v2 keeps the same total and redistributes it).
- **Enforcement is unchanged:** `enforce_ticket_quota` still uses the live count. Switching billing to the ledger, or to v2, is a separate decision after a reconciliation period with no unexplained differences.

### Personal subscriptions (Q10)

- Personal subscriptions stay personal: `user_id` = the customer, with no company. The 095 trigger blocks linking them to a company.
- The portal now links to the customer's personal Mad3oom account (`/customer-dashboard.html`), where personal plans are bought. The portal itself sells nothing.
- Under v1 (today), a company customer's tickets are counted against the company owner's plan. v2 (proposed) bills their Mad3oom-support tickets to their own plan. The projection shows the effect before any decision.

## Frontend that ships with 098

- `assets/js/company/company-tickets.js`: `configure({ load, team })`, plus status and assignment controls shown only when the database grants them.
- `company-dashboard.js`, `company-data.js`, `company-model.js`: when `my_company_permissions().enabled`, "Customer tickets" loads `company_tickets_list()`. Otherwise the section is exactly as before.
- `portal/index.html`: the personal-account link.

## Apply (when approved)

1. Confirm 097 is applied.
2. Apply `migrations/098_company_permissions_usage_ledger.sql`. It is re-runnable, and it self-checks that switches are off, the ledger covers every ticket, and this month reconciles with 0 mismatches.
3. Verify (read-only):
   ```sql
   select count(*) from public.usage_ledger where event = 'ticket_created';   -- = count(*) from tickets
   select public.usage_reconciliation();                                       -- mismatches: []
   select key, enabled from public.platform_feature_switches;                  -- all false
   ```

## Rollback

`migrations/_rollback/098_company_permissions_usage_ledger.down.sql` restores 3 functions byte-for-byte (`_attachment_reply_public`, `_ticket_object_allowed`, `company_customers_list`) and drops the rest. This is proven by a schema digest equal to the pre-098 state.

- It **refuses** while the switch is on, or once any company has saved permissions (configuration and its append-only history are not discarded by a rollback).
- The shadow ledger is dropped. Re-applying rebuilds it from tickets, minus the history of deleted tickets and of membership moves.

## Tests

`tests/sql/company-permissions-ledger.test.sql` (production-equivalent chain + 095 + 096 + 097, shared ticket fixtures):

- ⓪ Baseline: employees have no ticket access.
- ① Objects, switch off, catalog, ledger backfill and reconciliation, grants.
- ①ب Rollback by schema digest, and double re-apply with no duplicate ledger rows.
- ② Switch off: same visibility and customer list per actor; no reply, status or settings.
- ③ Switch on:
  - the supervisor sees their company's tickets only; the agent sees assigned tickets only;
  - replies and team notes (platform notes stay hidden from the company); note attachments and files go to the team, not the customer;
  - uploads; status and assignment rules; the other company is isolated; combined with isolation on.
- ④ Settings:
  - owner-only and fixed catalog;
  - user override over role default, and clearing it;
  - no customer and no other company's staff;
  - customer-list permission; assignee lists; append-only history.
- ⑤ Ledger:
  - idempotency, subscription link once, delete reversal;
  - a customer move leaves recorded usage unchanged and the difference is explained;
  - the v2 projection keeps the total;
  - append-only; owner-only reconciliation.
- ⑥ Rollback refused with saved permissions.

Plus `tests/company-add-member.render.test.mjs` (team controls), `tests/company-members-model.test.mjs`, `tests/portal.render.test.mjs`, `tests/company-navigation.test.mjs`.

## Known gaps

- `reports.view`, `activity.view` and `integrations.*` are not in the catalog yet. They would need company-scoped report and activity functions for employees; today those sections are owner-only. They were left out rather than added unenforced.
- There is no owner UI yet for the permission matrix. `company_permissions_matrix()`, `company_set_role_permission()` and `company_set_user_permission()` are ready and tested.
- Pre-existing rule kept: the storage policy "Allow authenticated uploads" lets any account upload into **its own folder** with any ticket id in the path. With isolation on, 097 blocks paths for tickets the uploader cannot see.
