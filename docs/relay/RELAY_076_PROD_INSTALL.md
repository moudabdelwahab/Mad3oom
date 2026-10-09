# Relay 076 (trash and owner control): production install note (NOT EXECUTED)

> Status: prepared on 2026-10-09. **Nothing here has been run against production.** Applying 076 needs a separate explicit approval from Mahmoud. Merging the PR is not that approval. The rules are in plan §28.

## Deploy order
The frontend is safe to deploy before 076 is applied:
- Without 076, `relay_my_access` has no `owner` key, so the page keeps the 074 behavior. That means no trash and no remove buttons. Manual redaction stays with the record owner, the creator or a supervisor, and supervisors manage grants.
- After 076, the page switches to the trash and owner rules on the next load.

## 1. Pre-apply checks (read-only)
1. Run `list_migrations`. Confirm that `074_relay_phase_c` is applied (`20261009152023`) and that no 076 exists yet.
2. Confirm that the production `_relay_full`, `relay_find_by_source`, `relay_attach_sources` and `relay_redact_source` still match `migrations/073_relay_core.sql`. Confirm that `relay_list`, `relay_my_access`, `relay_list_assigners`, `relay_grant_assigner` and `relay_revoke_assigner` match `migrations/074_relay_phase_c.sql`. The rollback restores exactly those texts.
3. Confirm that `public.is_platform_owner()` returns true for the owner account in the admin context. That account is the only one with `platform_authority.level = 'owner'`.

## 2. Apply (only after explicit approval)
- The file is idempotent and has no `begin`/`commit`. In the SQL Editor, wrap it in `begin; … commit;`.
- The final block aborts the transaction if any of these fails:
  - there is no permissive policy on the Relay tables;
  - `authenticated` and `anon` have no direct table privileges;
  - every Relay table follows the 041/042 conventions;
  - no Relay function can be executed by `anon` or `service_role`;
  - `authenticated` can execute exactly the 19 RPCs;
  - every SECURITY DEFINER function has a fixed `search_path`;
  - the owner checks and the trash guard trigger are installed.
- Never re-run 073 or 074 after 076. Either would restore older versions of the redefined functions.

## 3. Post-apply verification (read-only)
```sql
select count(*) filter (where removed_at is not null) as removed, count(*) filter (where purged_at is not null) as purged
  from public.relay_sources;                                                              -- 0, 0
select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and (p.proname like 'relay\_%' or p.proname like '\_relay\_%')
   and has_function_privilege('authenticated', p.oid, 'EXECUTE');                        -- 19
select pg_get_functiondef('public.relay_grant_assigner(uuid)'::regprocedure) like '%_relay_require_owner()%';  -- true
```
Then run `get_advisors` (security) and confirm that no new finding names a `relay_*` object.

## 4. Rollback
- `migrations/_rollback/076_relay_trash_owner.down.sql` runs in one transaction.
- It restores the nine functions to their pre-076 text and drops the four RPCs, the helpers, the trigger and the four columns.
- It refuses to run while any source is in the trash or erased, unless the session sets `relay.rollback_discard_data = 'on'`.
- After a forced rollback:
  - sources that were in the trash show again in their records;
  - erased sources show as "content deleted", because the excerpt is already gone.
- Records, sources, snapshots and events are kept. Chat, inbox, ticket and profile data are untouched.
