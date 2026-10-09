# Relay Phase B: production install note (NOT EXECUTED)

> Status: prepared 2026-10-09. **Nothing here has been run against production.** Applying 073, scheduling the cron job, and enabling Relay each need a separate explicit approval from Mahmoud. Approving the plan or the PR is not approval to apply.

## What the migration does
- `migrations/073_relay_core.sql` adds 5 new tables, 11 RPCs callable by `authenticated`, internal helpers, immutability triggers, and the daily `relay-retention-sweep` cron job.
- It does not change any existing table, policy, function or row in chat, inbox, tickets or profiles.
- Relay ships **disabled** (`relay_workspaces.enabled = false`). Every public RPC returns `feature_not_enabled` until it is enabled.
- Retention and data-deletion redaction still run while it is disabled.

## 1. Pre-apply checks (read-only)
1. **Migration number.** Run `list_migrations` and confirm that 073 is still free.
   - On 2026-10-09 the production head was `071_owner_admin_context_billing_requests`.
   - `072_invoice_pdf_attachment` (PR #104) was not applied.
   - If anything else has landed, renumber the file before applying.
2. **Order relative to PR #104.** 073 does not depend on 071 or 072.
   - `tests/company-navigation.test.mjs` ("لا ترحيل جديد بلا قرار صريح") pins the last migration file name.
   - PR #104 and this PR both edit that line. Whichever merges second must keep both entries and set the assertion to the highest number.
3. **Preconditions.** The migration checks these itself and aborts if any is missing. To confirm ahead of time:
   ```sql
   select to_regprocedure(f) is not null as ok, f from unnest(array[
     'public.inbox_can_access(uuid)', 'public._inbox_is_assigned(uuid, uuid)', 'public._inbox_is_supervisor()',
     'public._inbox_is_eligible_agent(uuid)', 'public._inbox_account_active(uuid)', 'public.account_is_active()',
     'public.preview_mode()', 'public.is_platform_staff()', 'public.guard_preview_read_only()']) f;
   select exists (select 1 from pg_extension where extname = 'pg_cron') as has_cron;
   ```
4. Re-read the production definition of `inbox_can_access` and confirm it still matches `tests/fixtures/prod-shape` (the C3 rule depends on it).

## 2. Apply (only after explicit approval)
- Apply the file unchanged as migration `073_relay_core` (Supabase `apply_migration`). It runs in one transaction.
- Its final block verifies every precondition below and raises an error if any fails, which aborts the whole migration:
  - No permissive policy exists on any Relay table.
  - `anon`, `authenticated` and `service_role` have no table privileges.
  - The 041/042 conventions are present.
  - No Relay function is executable by `anon` or `service_role`.
  - `authenticated` can execute only the 11 RPCs.
  - Exactly one workspace exists, of kind `platform`.
  - Every `SECURITY DEFINER` function has a fixed `search_path`.
  - The cron job is active.

## 3. Post-apply verification (read-only)
```sql
select kind, enabled, snapshot_retention_days from public.relay_workspaces;          -- 1 row: platform, false, 365
select jobname, schedule, active from cron.job where jobname = 'relay-retention-sweep'; -- '17 3 * * *', true
select count(*) from public.relay_records;                                              -- 0
select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname like 'relay\_%'
   and has_function_privilege('authenticated', p.oid, 'EXECUTE') order by 1;            -- the 11 RPCs
```
Then run `get_advisors` (security) and confirm that no new finding names a `relay_*` object.

## 4. Enabling (separate decision, not part of Phase B)
```sql
update public.relay_workspaces set enabled = true where kind = 'platform';
```
Phase C (the UI) does not exist yet, so enabling now would only expose the RPCs.

## 5. Rollback
- `migrations/_rollback/073_relay_core.down.sql` runs in one transaction.
  - It unschedules the cron job and drops every Relay function and table.
  - It refuses to run if any Relay record exists, unless the session sets `relay.rollback_discard_data = 'on'`.
- Dropping the tables permanently deletes Relay data, including the audit events. Take a backup first if records exist.
- Chat, inbox, ticket and profile data are untouched. This was tested on the prod-shape fixture (tests 24a–24c).

## 6. Data-deletion runbook addition (M8)
When a customer's data-deletion request is processed:
1. A supervisor, in the native admin session, runs:
   ```sql
   select public.relay_redact_for_subject('<customer uuid>');
   ```
2. Record the returned count in the request ticket.
3. Guest sessions (no customer id) must be redacted per source with `relay_redact_source(<source id>, 'data_subject_request')`, also by a supervisor.
4. After a deletion redaction, new captures from that customer's conversations are refused (`subject_redacted`).
