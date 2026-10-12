# 080 company_members privacy: production install note (NOT EXECUTED)

> Status: prepared on 2026-10-12. **Nothing here has been run against production.** Applying 080 needs a separate explicit approval from Mahmoud. Merging the PR is not that approval.

## The finding (F4)
`company_members()` (SECURITY DEFINER) only checked that the caller belongs to a company. It then returned the name and email of every follower of that company. Followers are the company's customers (033, decision D2), so any customer of a company could list every other customer's name and email with one RPC call. RLS on `profiles` does not allow this (`supervises()` covers the owner only); the function was the only path.

Production today has 1 company with 1 follower, so the realistic exposure is currently nil. It grows with the first real customer company.

## What 080 changes
- **One function: `company_members()`.** No table, policy, grant or row changes.
  - **`scope: 'full'`:** the company admin. That means `is_company_admin()` (rank, relation and owner context), the caller owns the company, the account is active, and the session is not in preview. The output is **byte-identical** to before 080, plus the `scope` key. The test compares the old and new JSON.
  - **`scope: 'self'`:** any other follower, and member preview (041). `members` holds the company admin (name only; never their email, not even as a fallback name) and the caller.
  - **`null`:** no company. Unchanged.
- **The frontend** shows a one-line note when `scope = 'self'`. A database without 080 sends no `scope`, and the page behaves as today, so frontend and database can deploy in either order.

## 1. Pre-apply checks (read-only)
1. Run `list_migrations`. The head should be `076_relay_trash_owner`. 077–079 (the continuity stack) and 081 (company staff) are independent of 080, so any of them may or may not be applied.
2. Run `select md5(pg_get_functiondef('public.company_members()'::regprocedure));` and expect `0e4030f30af1586d7f8f2ced6c3e7307`. The migration's first block checks the same value and aborts on any other text, so it never overwrites a function someone changed by hand.

## 2. Apply (only after explicit approval)
- The file is idempotent and has no `begin`/`commit`. Wrap it in `begin; … commit;`.
- The final block aborts if `anon` can execute the function, if `authenticated` cannot, or if the function was not replaced.

## 3. Post-apply verification (read-only)
```sql
select position('080_company_members_privacy' in pg_get_functiondef('public.company_members()'::regprocedure)) > 0;  -- true
select has_function_privilege('anon', 'public.company_members()', 'EXECUTE');                                         -- false
```
In the company dashboard, the owner's members section must look exactly as before.

## 4. Rollback
- `migrations/_rollback/080_company_members_privacy.down.sql` restores the pre-080 text and comment exactly.
- It verifies the md5 against production's pre-080 value and aborts otherwise.
- **Rolling back re-opens F4.** Use it only if 080 breaks a legitimate admin path, then fix forward.
- No data is touched.

## Tests
- **`tests/sql/company-members-privacy.test.sql`** runs on the production-shape fixture, whose function text matches production by md5. It covers:
  - reproducing F4 before 080;
  - admin output byte-identical after 080;
  - customers see only themselves and the admin's name: no other customer's name, email, id or phone;
  - cross-company, platform owner in `company_admin` / `owner` / `admin` / preview contexts, banned admin, platform staff, anon;
  - other paths (`profiles`, `tickets`) still closed, and member removal still works;
  - idempotent re-run, the unexpected-text guard, exact rollback and re-apply.
- **Mutation checks:** granting `full` to everyone fails ③; dropping `is_company_admin()` fails ④.
- **`tests/company-members-model.test.mjs`** covers `membersScopeIsSelf` and that no company id is sent.
- **`tests/company-add-member.render.test.mjs`** has 2 Chromium tests: the admin sees the full list with no note; a customer sees only the server rows, the note, and no admin email.
