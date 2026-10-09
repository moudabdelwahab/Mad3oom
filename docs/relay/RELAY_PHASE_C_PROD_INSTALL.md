# Relay Phase C: production install note (NOT EXECUTED)

> Status: prepared 2026-10-09. **Nothing here has been run against production.** Applying 074 and deploying the Phase C pages each need a separate explicit approval from Mahmoud. Approving or merging the PR is not approval to apply.

## What changes
- `migrations/074_relay_phase_c.sql` (plan §27):
  - adds `relay_records.category` (nullable, nine fixed values) and the `relay_assigners` table;
  - redefines `relay_create`, `relay_assign`, `relay_update`, `relay_list` and `_relay_record_json` with the same signatures and grants;
  - adds `relay_my_access`, `relay_list_assigners`, `relay_grant_assigner` and `relay_revoke_assigner` (authenticated only).
- It changes no chat, inbox, ticket or profile object, and does not change excerpt visibility (C3/M11), retention (C5) or redaction (M10).
- Existing Relay records keep working. Their `category` is null.
- It closes a hole that is in production today (plan §27.4 U18): in 073, anyone who can view a record with no owner can assign it to anyone or change its team. After 074 that is refused.
- Behavior change once applied: staff without the assign privilege can no longer create a record for someone else or a team (P3), and a current owner without it can only take the record or release it (P4). Until a supervisor grants the privilege, only supervisors can assign to others.

## Deploy order
The frontend is safe to deploy before or after 074:
- **Before 074:** `relay_my_access` does not exist, so the inbox button and the sidebar link stay hidden, and `/admin/relay.html` shows a "not available" reason without calling anything else.
- **After 074, before the frontend:** the Phase B RPCs keep working with the new rules; nothing calls the new ones yet.

## 1. Pre-apply checks (read-only)
1. Run `list_migrations` and confirm that 074 is free and `073_relay_core` is applied.
   - On 2026-10-09 the ledger had `20261009133459 073_relay_core`. `072_invoice_pdf_attachment` (PR #104) was not applied; 074 does not depend on it.
   - If another 074 has landed, renumber this file and its rollback before applying.
2. `tests/company-navigation.test.mjs` pins the newest migration file name. Whichever of PR #104 and this PR merges second must keep both entries and expect the highest number.
3. Confirm the production `relay_create`, `relay_assign`, `relay_update`, `relay_list` and `_relay_record_json` still match `migrations/073_relay_core.sql` (074 replaces them, and the rollback restores the 073 text).

## 2. Apply (only after explicit approval)
- Apply the file unchanged as migration `074_relay_phase_c`. It is idempotent.
- The file has no `begin`/`commit`. `apply_migration` runs it in one transaction. In the SQL Editor, wrap it in `begin; … commit;` so a failed check rolls everything back.
- Its final block raises an error, which aborts the migration, if any of these fails:
  - no permissive policy on the six Relay tables;
  - no direct table privileges for `authenticated` or `anon`;
  - the 041/042 conventions (`trg_preview_read_only`, restrictive `gate_account_active`) on every Relay table;
  - no Relay function executable by `anon` or `service_role`; `authenticated` can execute exactly the 15 RPCs;
  - every `SECURITY DEFINER` Relay function has a fixed `search_path`;
  - the installed `relay_create` and `relay_assign` contain the new `_relay_can_assign()` check.
- **Never re-run `073_relay_core.sql` after 074.** It would restore the Phase B rules on five functions.

## 3. Post-apply verification (read-only)
```sql
select count(*) filter (where category is not null) as categorized, count(*) as records from public.relay_records;
select count(*) from public.relay_assigners;                                             -- 0
select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname like 'relay\_%'
   and has_function_privilege('authenticated', p.oid, 'EXECUTE') order by 1;            -- the 15 RPCs
select pg_get_functiondef('public.relay_create(jsonb)'::regprocedure) like '%_relay_can_assign()%';  -- true
```
Then run `get_advisors` (security) and confirm that no new finding names a `relay_*` object.

## 4. Granting the assign privilege (after apply, by a supervisor)
From the Relay page ("صلاحية الإسناد" section), or in a native admin session:
```sql
select public.relay_grant_assigner('<staff uuid>');   -- eligible staff only
select public.relay_revoke_assigner('<staff uuid>');  -- one-way; history is kept
```

## 5. Rollback
- `migrations/_rollback/074_relay_phase_c.down.sql` runs in one transaction.
  - It restores the five functions to their 073 text, drops the four new RPCs, the helpers, `relay_assigners` and the `category` column.
  - It refuses to run if any record has a category or any grant row exists, unless the session sets `relay.rollback_discard_data = 'on'`.
- Relay records, sources, snapshots and events are kept. Chat, inbox, ticket and profile data are untouched.
- After rollback the Phase B rules apply again: any member can assign a new record to any eligible owner. The one exception is `relay_assign`, which keeps the NULL fix so the U18 hole does not come back. The rollback, the restored 073 text and a re-apply were tested on the prod-shape fixture (`tests/sql/relay-phase-c.test.sql`).
