# M — Multi-company memberships (migration 096) — production install note

> **Status: NOT EXECUTED.** Nothing here has been applied to production or deployed.
> Prepared 2026-10-14 on branch `claude/dazzling-hypatia-lh1o9i`. Requires 095 first.
> The switch `multi_company_memberships_enabled` ships **OFF**. With it off, every actor sees exactly what they saw after 095 (proven per actor in the test, §②).

## What 096 does

| # | Change | Why |
|---|---|---|
| 1 | `platform_feature_switches` + `owner_set_feature_switch(key, enabled, reason)` + `owner_feature_switches()` | One table for every tenancy switch. Only the platform owner, in owner context with a fresh step-up, can change a switch, with a reason (≥ 10 chars). Each change is written to `privileged_audit`. No role has direct table access. |
| 2 | `company_memberships` (+ `company_membership_invitations`, `customer_company_context`, `company_membership_events`) | Membership is now its own record (Q4: one primary company plus additional ones). `profiles.super_user_id` stays as the **mirror of the primary**, so every existing policy and function keeps working unchanged. The events table is append-only. |
| 3 | Backfill | One active primary membership per `super_user_id` link (production had 0 at the time of writing). |
| 4 | Mirror trigger on `profiles.super_user_id` | Legacy writers (`create-sub-user`, elevated admin edits, `remove_company_member`) keep working: each write is translated into a membership change. Integration customer links in the old company are unlinked. |
| 5 | `current_company_id()` | Order: owned company → customer context (switch on, active membership) → primary → oldest active membership (switch on). With the switch off, it returns the same result as before. |
| 6 | `my_account_kind()`, `my_company_portal()` | A customer with only additional memberships counts as a company customer (switch on). The portal payload adds `multi_company`, `memberships` (name + flags only) and `pending_invitations`. |
| 7 | `company_members()`, `remove_company_member()` | Source is active memberships. The role is reported relative to the company. Removing an additional membership leaves the primary intact. |
| 8 | `company_customers_list()` | Admin and supervisor only. Excludes staff. Shows no trace of the customer's memberships in other companies. |
| 9 | Invitations: `company_invite_customer`, `company_invitations_list`, `company_invitation_cancel`, `my_company_invitations`, `company_invitation_respond` | The company admin invites by email. The reply is the same for every email (no account enumeration). Only the account owner can accept. Acceptance creates a primary membership if the account has none, otherwise an additional one. Invitations expire after 7 days. |
| 10 | `enter_customer_company`, `my_company_memberships`, `leave_company`, `set_primary_company` | The customer chooses the current company (server-checked). Leaving a primary does not auto-promote another. Changing an existing primary is a transfer (H2), not a button. |
| 11 | Integrations hub (`_ihub_guard_customer_link`, `ihub_customer_link`, `ihub_intake_convert`) | Use active membership instead of the raw `super_user_id` join. |
| 12 | `membership_mirror_drift()` | Monitoring: must return `[]`. |

Functions replaced: 9 (`current_company_id`, `my_account_kind`, `my_company_portal`, `company_members`, `remove_company_member`, `check_super_user_creation`, `_ihub_guard_customer_link`, `ihub_customer_link`, `ihub_intake_convert`). No existing policy is changed (proven by policy digest in the test).

## Frontend that ships with 096

- `portal/index.html`, `assets/js/portal/portal.js`, `assets/js/portal/portal-data.js`: invitations panel (`/portal/#invitations`, shown even before the account belongs to any company), company switcher, leave, and "make this my primary" when there is no primary.
- `company-dashboard/index.html`, `assets/js/company/company-dashboard.js`, `company-data.js`, `company-model.js`: "Company customers" panel. Admins get the invite form and invitation list when the switch is on; supervisors get a read-only customer list.

Order: either order is safe. Before 096 the new calls return "missing function" and the panels stay hidden. With 096 and the switch off, the panels stay hidden (`invitations_enabled = false`, `multi_company = false`).

## Apply (when approved)

1. Confirm the ledger head (`list_migrations`) and that 095 is applied.
2. Apply `migrations/096_company_memberships.sql` (re-runnable, checks prerequisites, self-verifies: switches false, mirror drift 0).
3. Verify (read-only):
   ```sql
   select key, enabled from public.platform_feature_switches;                 -- multi_company_memberships_enabled | false
   select public.membership_mirror_drift();                                    -- []  (as service role / owner)
   select count(*) from public.company_memberships where status = 'active';    -- = count of profiles with super_user_id
   select has_table_privilege('authenticated', 'public.company_memberships', 'select');  -- false
   ```
4. Deploy the frontend files listed above.

**Do not enable the switch** as part of the install. Enabling is a separate owner decision through `owner_set_feature_switch` (owner context + step-up + reason) and is audited.

## Rollback

`migrations/_rollback/096_company_memberships.down.sql` restores the 9 function texts byte-for-byte (including the CRLF endings of `current_company_id` on production) and drops the 096 objects. It **refuses to run** while any active additional membership or any invitation exists, because those relationships cannot be represented by `super_user_id` alone. Primary memberships are recovered from the mirror.

## Tests

- `tests/sql/company-memberships.test.sql` (on the production-equivalent chain + 095):
  - ⓪ baseline per actor.
  - ① objects, grants, switch off, backfill, mirror drift 0.
  - ② switch off = identical behaviour per actor.
  - ③ legacy paths become memberships.
  - ④ rollback restores 9 functions byte-for-byte; re-apply and re-run.
  - ⑤ switch closes every new operation; only the owner with context + step-up + reason can enable it; audited.
  - ⑥ invitations: no enumeration, admin-only, owner-only acceptance, primary vs additional, decline/cancel/expiry.
  - ⑦ isolation between companies and server-checked context; an employee of A who is a customer of B has no staff powers in B.
  - ⑧ leave and set primary.
  - ⑨ table guards; rollback refused while data exists.
- `tests/portal-model.test.mjs`, `tests/portal.render.test.mjs`, `tests/company-members-model.test.mjs`, `tests/company-dashboard.render.test.mjs`, `tests/company-navigation.test.mjs`.

## Not in 096 (later phases)

- Tickets are not yet stamped with a company (A2, 097). Until then the portal lists all of the customer's own tickets regardless of the selected company.
- Primary transfer with approvals, carry-over of tickets, historical access requests: H2.
