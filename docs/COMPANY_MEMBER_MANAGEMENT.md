# Company member management (migration 113)

Nothing in this document has been applied to production by this change. Migration 113 is **not** applied and the Edge Function `company-member-admin` is **not** deployed. No feature switch, secret, Auth setting or DNS record was changed.

## 1. What the company owner can now do

The members list gets an **«التفاصيل والإدارة»** (details and management) button next to every member except the owner. This covers team members and customers. The button appears only for the company manager: the owner, on a plan that includes sub-users, outside preview mode. The details window has these sections:

| Section | What it does | Who it applies to |
|---|---|---|
| Member's company profile | Display name, contact phone, job title and internal notes. They belong to this company only: the member's account does not change, and no other company sees them. | Every member, including suspended ones |
| Login details | Edit **name, phone and email** (the login email). | Only accounts **the company created** (via «إضافة مستخدم») that have been tied to this company alone since creation. Otherwise a short explanation is shown and the account owner edits their own details. |
| Password reset link | A link is sent to the member's own email. The company sees neither the link nor the password. | Every active member (10-minute cooldown per member, 20 per company per day) |
| Temporary suspension and reactivation | Access to the company stops immediately. A team role is dropped and restored on reactivation. Data and tickets are kept. | Every member. Suspension never bans the platform account; banning stays with the platform. |
| Transfer to another company | The company submits a request with the destination (commercial registration number or company email) and a reason. The **platform owner** reviews it in «حوكمة الشركات», and on approval the transfer runs. | Customers whose primary company is this one. A team member's role must be removed first. Requires `customer_transfers_enabled` + isolation + permissions (all ON in production since 2026-10-21). |
| Tickets with the company | Counts, the latest 5, and last activity, for **this company's tickets only** (`scope = company`). Nothing from the member's other companies or from Mad3oom support. | Every member |
| History | Membership and team events in this company, newest first. | Every member |

The members section also shows **suspended members**, with a reactivate button, and **member transfer requests**, with their status, the rejection reason and a cancel button for pending ones.

## 2. Design and why

**Suspension reuses the removal path.** Access in about 19 database functions flows through `profiles.super_user_id` and active memberships. A new "suspended" membership status would have to be taught to every one of them, and a single miss would leak access. Suspension therefore ends the membership with `end_cause = 'suspended'`, which goes through `_membership_end` exactly as removal does, so every existing access check applies unchanged. `company_member_suspensions` records what to restore: whether the membership was primary, and the staff role. Reactivation inserts a membership with `joined_via = 'reactivated'`, restores primary if the account has no other primary, and restores the staff role under the same rules as `company_staff_set`.

**Login edits use the service role, under guards that are not weakened.**
- The login email lives in GoTrue (`auth.users`).
- `guard_profile_security_columns` blocks any session from changing an email, and from changing another account's phone.
- Flow:
  1. The browser calls `company-member-admin` with the manager's JWT.
  2. The function calls `company_member_account_check` **under that JWT**. This checks the manager, eligibility, formats, uniqueness and rate limits, and records a pending change.
  3. The function calls `auth.admin.updateUserById` with the service role (email confirmed, `user_metadata.full_name`).
  4. The function calls `_company_member_account_apply`, which is service-role only. It re-checks eligibility, writes the profile, logs the event and notifies the member in-app.
  5. A security email goes to the old and the new address.
- If step 4 refuses, the function restores the login system to its old values.

**Eligibility to edit login details** is decided by `_company_member_account_scope`. Every one of these must hold:
- `app_metadata.company_created = true` (only `create-sub-user` sets this, using the service role);
- `super_user_id` is this company's owner;
- the primary membership here dates from creation (`legacy`/`backfill`, not invitation or transfer);
- there is no other active membership;
- the account is not a company owner or platform staff.

Reasons that concern the account's relationships *outside* the company are reported as one generic code (`not_exclusive`), so nothing about other companies leaks.

**The phone can be changed but not removed.** The account gate `account_verification_ok` counts a valid phone as verification. Clearing it would make the account inactive (found by the HTTP test). The database, the Edge Function and the form all refuse to clear it.

**Transfers reuse the 101 engine.** On approval, `owner_decide_member_transfer` calls `owner_transfer_exceptional(member, destination, reason, false, request_id)`, with all its checks:
- switches;
- step-up;
- 20-character reason;
- the member is a primary customer of the source;
- the destination is valid;
- idempotency.

The destination is resolved on the server. The response to the company is identical whether or not it matched, so the company learns nothing about which companies exist. The owner sees the resolved company and can correct the destination.

> **Irreversibility:** after the **first completed transfer**, `company_isolation_enforced` and `company_permissions_enabled` can no longer be turned off (`_guard_isolation_after_transfers`, 101). The owner UI says this next to the approve button.

**Isolation.**
- Every function derives the company from the session (`_company_staff_require_manager`); no function takes a company id from the browser.
- A member of another company and a non-existent account return the same `P0002` error.
- The four new tables have RLS, no grants, a restrictive `gate_account_active` policy and the preview read-only trigger.
- History rows (`company_member_account_changes`, `company_member_transfer_requests`) cannot be deleted.

## 3. Objects

| Object | Kind | Called by |
|---|---|---|
| `company_member_profiles` | table | — |
| `company_member_suspensions` | table | — |
| `company_member_account_changes` | table (history) | — |
| `company_member_transfer_requests` | table (history) | — |
| `company_member_details(user)` | RPC | manager |
| `company_member_profile_save(user, display_name, phone, job_title, notes)` | RPC | manager |
| `company_member_account_check(user, full_name, phone, email)` | RPC | manager (via the Edge Function) |
| `_company_member_account_apply(change, ok, error)` | RPC | **service_role only** |
| `company_member_password_reset_check(user)` | RPC | manager (via the Edge Function) |
| `company_member_suspend(user, reason)` / `company_member_reactivate(user)` / `company_member_suspensions_list()` | RPC | manager |
| `company_member_transfer_request(user, dest_ref, reason, idempotency_key)` / `company_member_transfer_cancel(request)` / `company_member_transfer_requests()` | RPC | manager |
| `owner_member_transfer_requests(status)` / `owner_decide_member_transfer(request, approve, reason, dest_ref)` | RPC | platform owner (approval needs step-up) |
| `supabase/functions/company-member-admin/` | Edge Function (`verify_jwt: true`) | company dashboard |

Constraint changes, all widening only:
- `company_membership_events.action` gets the `member_*` actions;
- `company_memberships.end_cause` gets `suspended`;
- `company_memberships.joined_via` gets `reactivated`.

## 4. Manual production steps (owner)

1. Apply `migrations/113_company_member_management.sql`. Its self-check runs inside the migration.
2. Deploy the Edge Function `company-member-admin` from the merged commit, bundled with `supabase/functions/_shared/email.js` (`verify_jwt: true`). The same command as the invitation function works: `supabase functions deploy company-member-admin --project-ref … --use-api`.
3. Secrets: none new. It uses the existing `RESEND_API_KEY`, `EMAIL_SENDER_DOMAIN` and `PUBLIC_SITE_ORIGIN`, plus the platform-provided `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY`.
4. Supabase Auth → URL Configuration: the Redirect URLs must include `https://mad3oom.com/reset-password.html`. This was already listed for 112, step 6. Without it, GoTrue sends the reset link to the Site URL instead.
5. Smoke test with your own test account, created from «إضافة مستخدم»:
   1. open «التفاصيل والإدارة»;
   2. save a company profile;
   3. change the name;
   4. send a reset link and check the mailbox;
   5. suspend and reactivate;
   6. optionally, submit a transfer request to a second test company and reject it from «حوكمة الشركات».

   Approving a real transfer makes isolation and permissions permanent (§2).
6. Rollback: stop the Edge Function, then run `migrations/_rollback/113_company_member_management.down.sql`. It **refuses** once the feature has been used (any suspension, transfer request, account change or `member_*` event), because those are append-only records. It runs as a single transaction.

## 5. Tests

- `tests/sql/company-member-management.test.sql` runs on the production-shape chain 094→112 plus 113 and covers:
  - ① objects and grants;
  - ①ب exact rollback before use, then re-apply;
  - ② profile and details: manager only, this company's tickets only, another company = unknown account;
  - ③ login edit: eligibility, uniqueness without leaking, phone cannot be cleared, service-role apply exactly once, stale or failed requests;
  - ④ reset-link check, cooldown and limit;
  - ⑤ suspension and reactivation: access and staff role drop and return, a secondary membership only, rejoin by invitation supersedes, an ineligible account is refused;
  - ⑥ transfer request → owner decision through the 101 engine: step-up, reason length, destination correction, rejection, cancellation, expiry, suspension cancels pending, history immutable;
  - ⑦ rollback refused after use.
- `tests/http/company-member-admin-http.test.mjs` runs the real handler against PostgREST 12 with JWTs and migration 113. Only GoTrue and Resend are fakes. Cases:
  - login edit end-to-end;
  - phone required;
  - refusals before reaching Auth;
  - Auth failure recorded;
  - reset link sent only to the member;
  - cooldown;
  - provider failure.
- `tests/company-member-admin-function.test.mjs`: error mapping, the Auth revert when the profile apply refuses, an unsafe link, template escaping, `index.ts`.
- `tests/company-member-admin.render.test.mjs`, in Chromium:
  - details window;
  - profile, login and email-change confirmation;
  - reset, suspend, transfer and reactivate;
  - non-manager sees nothing;
  - 390px.
- `tests/owner-governance.render.test.mjs`: the member-transfer review (reason length, confirmation, destination correction, rejection, irreversibility notice).
- No test sends real email.
