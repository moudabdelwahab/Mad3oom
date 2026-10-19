# 105_account_hierarchy_customers — production install note

> **Status: APPLIED to production on 2026-10-19** (merge commit `3aab6fe`, followed by 106 and 107). Every switch stays OFF. The apply record is in `ACCOUNT_REQUEST_EXECUTION_106.md` §6. Steps 4 (frontend) and 5 (`create-sub-user`) below were not done.
> Design and audit: `ACCOUNT_HIERARCHY_105.md`. Transfer design: `CUSTOMER_TRANSFER_DESIGN.md`.

## What applying changes in production

With every switch off, applying 105:
- Adds three tables:
  - `platform_direct_customers`, with a backfill of about 33 rows (accounts with role `user`, no company, no membership);
  - `customer_account_managers`, empty;
  - `account_requests`, empty.
  Each table has RLS, no permissive policy and no grants.
- Adds a signup trigger (a new account with no company becomes a direct customer), plus history and deletion triggers.
- Adds a new switch `account_request_execution_enabled` = **false**.
- Widens two checks: capability `customers.assign_manager`, and membership `joined_via = 'account_request'`.
- Replaces `_guard_isolation_after_transfers` (101) with a version that also counts approved account requests. Its behaviour is identical while there are none.
- Adds read RPCs for the admin customer directory. Their audience is the same as who already reads every profile.

It leaves these untouched:
- `super_user_id` values and the legacy write path;
- `admin/users.html` and its RPCs;
- subscriptions, tickets and notifications. The only new notifications come from new actions.

## Apply

1. Pre-checks:
   - the ledger head is `104_company_documents_followups`;
   - `select count(*) from platform_feature_switches where enabled` is `0`.
2. Run one `apply_migration` call through the release wrapper: fetch the file at the merged commit, check its md5, execute.
3. Verify:

```sql
select key, enabled from public.platform_feature_switches where key = 'account_request_execution_enabled';  -- false
select count(*) from public.platform_direct_customers;                                                      -- = backfill count (33 on 2026-10-19)
select count(*) from public.customer_account_managers;                                                      -- 0
select count(*) from public.account_requests;                                                               -- 0
select count(*) from pg_trigger where not tgisinternal and tgname in
  ('trg_customer_history_guard', 'trg_direct_customer_on_signup', 'trg_customer_relationships_on_profile',
   'trg_account_requests_company_deleted');                                                                -- 6
select has_table_privilege('authenticated', 'public.account_requests', 'select');                          -- false
select has_function_privilege('anon', 'public.admin_customer_directory(jsonb)', 'execute');                -- false
select count(*) from public.platform_feature_switches where enabled;                                       -- 0
```

4. Deploy the frontend files listed in `ACCOUNT_HIERARCHY_105.md` §6. Before 105 is applied, the pages show an error state because the RPCs are missing.
5. **Edge Function (separate approval):** redeploy `create-sub-user` from the merged commit. It now marks company-created accounts with `app_metadata.company_created`. Until it is redeployed, the database fallback ends the direct relationship it would otherwise create. No secret is involved.

## Rollback

```
psql --single-transaction -v ON_ERROR_STOP=1 -f migrations/_rollback/105_account_hierarchy_customers.down.sql
```

The rollback first takes exclusive locks on its tables, so nothing can be written between its checks and the drops. It refuses before changing anything while:
- the execution switch is on;
- any account request or manager assignment exists;
- any membership came from a request;
- a `customers.assign_manager` grant exists;
- any ended direct relationship exists.

With none of these, it restores the 104 schema exactly. A test checks this with a schema digest.

## Before enabling `account_request_execution_enabled`

- Decide on customer consent (A: owner approval executes, as implemented; B: approval issues a 096 invitation).
- Enable `company_isolation_enforced` and `company_permissions_enabled` first, each with its own approval. After the first approved request, both become one-way.
- A secondary membership (a customer who already has a primary company) also needs `multi_company_memberships_enabled`.
