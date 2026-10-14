# A1 — Account boundaries (migration 095) — production install note

> **Status: NOT EXECUTED.** Nothing here has been applied to production or deployed.
> Prepared 2026-10-14 on branch `claude/dazzling-hypatia-lh1o9i`. Production ledger at the time:
> `093_continuity_collab_actions`. `094_continuity_reminders` (PR #133) was merged into `main` on 2026-10-13 and merged into
> this branch. Apply it first, through its own install note (`docs/continuity/REMINDERS_094_PROD_INSTALL.md`). Every
> tenancy test (095–102) now runs on 093 → 094 → 095 …, the production order.

## What 095 does

| # | Change | Why |
|---|---|---|
| 1 | `my_account_kind()` | One server-side answer for routing: `platform_owner`, `platform_staff`, `company_admin`, `company_employee`, `company_customer`, `independent`, `anonymous`. |
| 2 | `my_company_portal()` | What a company customer may see about their company: the **name only**. |
| 3 | `get_my_company_dashboard()` gated | Team only (`company_staff_role()` not null). Registration, tax id, contact data and subscriptions go to the company admin only. Customers get `null`. |
| 4 | `companies` read policy (same name) | Team only. Customers no longer read the full company row (tax id, CR number) through REST. |
| 5 | Subscription linking | `link_subscription_to_my_company()` and trigger `enforce_subscription_company_owner` accept the company admin only. A customer's personal subscription can no longer grant the company features or expose personal billing. |
| 6 | `is_owner_or_super_of(x)` = `auth.uid() = x` | Same name and signature (9 policies + one Edge Function call it). Closes the company-owner path into customers' API tokens, API usage logs (IP, user agent) and personal integrations. |
| 7 | `external_integrations` (+ models) | A personal integration belongs to its owner only — not the company owner, not a platform admin. Admins manage platform-scope integrations only. |
| 8 | `activity_logs_select_policy` | IP, user agent, device and location go to the account itself and platform security only. |
| 9 | `profiles_update_policy` + `guard_profile_points_change` | A company owner cannot edit a customer's profile or reward points. Removing a member stays available through `remove_company_member()`. |
| 10 | `context_destination('company_user_preview')` = `/portal/` | The owner's "member view" now opens the customer portal. |

Production data affected at the time of writing: **none** (0 company-linked accounts, 0 non-platform integrations).

## Frontend that ships with 095

- `assets/js/account-destination.js`: routes by `my_account_kind()`; falls back to the old lookup if 095 is not applied.
- `assets/js/company/company-dashboard.js` (+ `company-model.js`, `company-data.js`): customers see a message with a button to `/portal/`; supervisors and agents do not see Subscriptions or API.
- `portal/index.html`, `assets/js/portal/*`: the company customer portal (my tickets: open, reply, close, reopen). No purchases, no company internals.
- `assets/js/company/company-tickets.js`: a `portal` stream that reuses the existing ticket UI.

Order: either order is safe. Before 095 the frontend behaves exactly as today. After 095 without the new frontend, a customer who opens `/company-dashboard/` sees "no company" instead of company data.

## Edge Function: URGENT, independent of 095

`manage-external-integration` (deployed version 22, verified read-only on 2026-10-14) let **any signed-in account delete or overwrite platform-scope AI integrations**. The update path included the credentials and `base_url`, which could redirect platform AI traffic. Both paths checked only that the row was *visible* to the caller (platform rows are visible to everyone) and then wrote with the service role.

The fix is in `supabase/functions/manage-external-integration/authz.js` + `index.ts`. It is tested in `tests/manage-external-integration-authz.test.mjs`. **It is not deployed.** Deploying it needs your explicit approval:

```
supabase functions deploy manage-external-integration --project-ref srnelrdpqkcntbgudyto
```

## Apply (when approved)

1. Confirm the ledger head and that no other migration claims 095: `list_migrations`.
2. Apply `migrations/095_account_boundaries.sql` (re-runnable; it checks its own prerequisites and self-verifies).
3. Verify (read-only):
   ```sql
   select public.context_destination('company_user_preview');          -- '/portal/'
   select qual from pg_policies where tablename='companies'
     and policyname='Company members can view their company';            -- contains company_staff_role()
   select count(*) from pg_policies where qual like '%supervises%'
     and policyname in ('activity_logs_select_policy','profiles_update_policy'); -- 0
   select has_function_privilege('anon','public.my_account_kind()','execute');  -- false
   ```
4. Deploy the frontend files listed above.

## Rollback

`migrations/_rollback/095_account_boundaries.down.sql` restores every function and policy text byte-for-byte. That includes the CRLF line endings of the two production bodies, proven by digest in `tests/sql/account-boundaries.test.sql` §⑪ج. **Rolling back reopens every boundary listed above.**

## Tests

- `tests/sql/account-boundaries.test.sql`: proves each of the 10 leaks exists before 095 and is closed after it, with positive and negative cases per actor; no other function, policy or row changes; re-run, rollback (leaks return) and re-apply.
- `tests/account-destination.test.mjs`, `tests/portal-model.test.mjs`, `tests/manage-external-integration-authz.test.mjs`, `tests/owner-context-authority.test.mjs`, `tests/company-navigation.test.mjs`.
