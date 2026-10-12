# Company staff 086 (Continuity multi-tenant, increment 1): production install note (NOT EXECUTED)

> Status: prepared on 2026-10-12. **Nothing here has been run against production.** Applying 086 needs a separate explicit approval from Mahmoud. Merging the PR is not that approval.
>
> Design: `CONTINUITY_MULTITENANT_ARCHITECTURE_REPORT.md` §5.2, §9 and §10. Decisions D1–D3 were approved on 2026-10-12; the namespace is `continuity_*` (#116).
>
> **Numbering:** this was written as `077`, then `081`, and moved to `086` with no content change. `077`–`081` are the continuity stack (#116 → #117 → #118 → #119 → #121 → #124; 080 = attachments, 081 = handover), `082`–`084` are reserved for it, and `085` is the `company_members` privacy fix (#120). 086 depends on none of them and none depends on 086 (report §10.2).

## What 086 changes
- **New tables:** `company_staff` (an explicit employee role, `supervisor` or `agent`, for a follower of the company) and `company_staff_events` (append-only history).
- **New RPCs:** `company_staff_role()`, `company_staff_list()`, `company_staff_set(uuid, text)` and `company_staff_revoke(uuid)` for `authenticated`. Internal predicates `_company_staff_role_of` and `_company_is_eligible_agent` are granted to no role.
- **One new trigger on `profiles`:** `trg_company_staff_unlink` (`AFTER UPDATE OF super_user_id`). When an account leaves a company, it revokes that account's staff role there.
- **What does not change:** no existing function, policy, table or row. Every follower stays a customer: there is no automatic promotion (D2).
- **No new access:** the role grants nothing until increment 2 or 3 reads it.

## Deploy order
The frontend is safe to deploy before 086 is applied:
- Before 086, `company_staff_list` does not exist. `company-data.js` treats the missing RPC (`PGRST202` / `42883` / 404) as `null`, and the members section looks exactly as it does today.
- After 086, the company admin sees a role selector on each follower on the next load. Supervisors and agents see the role as a label. Customers see nothing new.

## 1. Pre-apply checks (read-only)
1. Run `list_migrations`. Confirm that no `086_company_staff` exists. Any of `077`–`085` may or may not be applied by then; that is fine, because 086 is independent of them. On 2026-10-12 the head was `076_relay_trash_owner`. `075_workspace_layouts` is in the repo but not in the production ledger; it is unrelated.
2. Confirm that these prerequisite functions exist: `current_company_id()`, `is_company_admin()`, `is_company_member()`, `can_manage_company_members()`, `account_is_active()`, `preview_mode()`, `_inbox_account_active(uuid)` and `guard_preview_read_only()`. The migration's first block also checks them and aborts if one is missing.
3. Confirm that no table named `company_staff` or `company_staff_events` exists.

## 2. Apply (only after explicit approval)
- The file is idempotent and has no `begin`/`commit`. In the SQL Editor, wrap it in `begin; … commit;`.
- The final block aborts the transaction if any of these fails:
  - neither table has a permissive policy;
  - `authenticated`, `anon` and `service_role` have no direct table privileges;
  - both tables follow the 041/042 conventions (restrictive `gate_account_active`, `trg_preview_read_only`);
  - no staff function can be executed by `anon` or `service_role`;
  - `authenticated` can execute exactly the 4 public RPCs;
  - every SECURITY DEFINER function has a fixed `search_path`;
  - the `profiles` trigger is installed.

## 3. Post-apply verification (read-only)
```sql
select count(*) from public.company_staff;                                                  -- 0 (D2: nobody promoted)
select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and (p.proname like 'company\_staff\_%' or p.proname like '\_company\_staff\_%' or p.proname = '_company_is_eligible_agent')
   and has_function_privilege('authenticated', p.oid, 'EXECUTE');                          -- 4
select count(*) from pg_policies where tablename in ('company_staff','company_staff_events')
   and permissive = 'PERMISSIVE';                                                          -- 0
select tgname from pg_trigger where tgrelid = 'public.profiles'::regclass
   and tgname = 'trg_company_staff_unlink';                                                -- 1 row
```
Then run `get_advisors` (security) and confirm that no new finding names a `company_staff*` object. "RLS enabled, no policy" on the two tables is intended.

## 4. Rollback
- `migrations/_rollback/086_company_staff.down.sql` runs in one transaction.
- It drops the trigger on `profiles`, the functions and both tables.
- It refuses to run while either table has rows, unless the session sets `company_staff.rollback_discard_data = 'on'`. Dropping the tables loses every staff role and its history.
- No other object depends on 086. Profiles, companies, tickets, chat, inbox and Relay are untouched.

## 5. Recovery (without a full rollback)
| Situation | Action |
|---|---|
| The apply fails part-way | Nothing to undo. The file runs inside the `begin; … commit;` you wrapped it in, and the verification block aborts the whole transaction |
| An admin granted the wrong person a role | The admin uses the role selector (or `company_staff_revoke`). History is kept in `company_staff_events`. No database access is needed |
| A role must be removed by Mahmoud (for example, an abuse report) | As the database owner: `update public.company_staff set revoked_at = now(), revoke_cause = 'admin', updated_at = now() where id = '<row>';`, then insert the matching `company_staff_events` row (`action = 'revoked'`, `cause = 'admin'`). The guards allow exactly this transition and nothing else |
| `trg_company_staff_unlink` blocks a legitimate `profiles.super_user_id` change (unexpected) | `alter table public.profiles disable trigger trg_company_staff_unlink;`, make the change, then re-enable it. The role is still not counted for an account that left the company, because every predicate re-checks the relation on each read (test ⑦ب). Any stale active row can be revoked as above |
| The frontend must hide the feature immediately | Revert the frontend only. Without the UI, the RPCs are inert: nothing else reads `company_staff` |

## Tests behind this note
- `tests/sql/company-staff.test.sql` runs on the production-shape fixture. It covers:
  - roles, grants and their idempotency;
  - cross-company attempts (`P0002`, with the same message for a foreign account and a missing one);
  - platform staff and owner context;
  - preview mode;
  - list privacy;
  - recipient eligibility;
  - revoke and re-grant;
  - leaving a company (trigger and per-read re-check);
  - table guards;
  - two concurrency races with real sessions (dblink);
  - untouched digests of the existing functions, policies and tables;
  - re-run, refused rollback, forced rollback and re-apply.
- `tests/company-staff-model.test.mjs` covers the pure UI model plus static guards: no company id in any staff RPC call, and no platform branch in the staff functions.
- `tests/company-add-member.render.test.mjs` contains 6 Chromium tests for the role selector, confirmation, server rejection, the supervisor view and the customer view.
