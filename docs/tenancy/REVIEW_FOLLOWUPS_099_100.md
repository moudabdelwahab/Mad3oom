# 099 / 100 — open review findings: safe fixes, tests, prerequisites

> **Status (updated 2026-10-14): implemented as forward migrations `103_admin_hierarchy_followups` and `104_company_documents_followups`, with rollbacks and regression tests. Applied to production on 2026-10-19, with all switches off.**
> 099 and 100 were applied to production on 2026-10-14, so their files are unchanged. Every fix is a new migration (see `FOLLOWUPS_103_104_PROD_INSTALL.md`).
> The analysis below is kept as written; the checklist shows where each item landed.

## Implemented vs. pending

| Item | Where | State |
|---|---|---|
| 099 M1 deletion vs. history | 103 (no FKs; deletion ends memberships, revokes delegations, ends company assignment) | implemented, tested |
| 099 M2 dormant delegation | 103 (eligibility triggers on profiles, company staff, memberships, ownership) | implemented, tested |
| 099 M3 (a) suspend-only delegates | 103 | implemented, tested |
| 099 M3 (b) second factor | 103: aal2 JWT claim required for delegate writes | implemented, tested. Delegates must enrol in MFA before `delegation_enabled` |
| 099 L1 final decisions | 103 | implemented, tested |
| 099 L2 conversion blocker and handover button | 103 and owner console | implemented, tested (SQL and render) |
| 099 L3 expired delegations, required expiry | 103 and owner console | implemented, tested (SQL and render) |
| 099 L5 rollback order | rollback guards in 099/100/103/104; single-transaction command documented | implemented, tested |
| 100 M1 deletion vs. documents | 104, **decision A** (documented in the install note) | implemented, tested |
| 100 M2 storage self-check | 104 `_storage_unscoped_policies()` | implemented, tested |
| 100 M3 (a) apply order | done for 094–102; 103/104 follow the same rule | done |
| 100 M3 (b) rollback bucket delete | unchanged: test on a Supabase branch before relying on it | **pending** (needs a branch, which is not available on the Free plan) |
| 100 M3 (c) `--no-verify-jwt` | runbook | documented |
| 100 L1–L7 | 104 and the Edge Functions (not deployed) | implemented, tested (SQL and Node) |
| Real ClamAV scanner and `DOCUMENT_SCAN_SECRET` | — | **pending**: not provisioned, and none invented |

## 099 — admin hierarchy

### M1 — deleting an account or company fails once the hierarchy is used

**Cause.**
- `admin_unit_members.user_id` (099:71), `platform_delegations.delegate_id` (099:107) and `admin_unit_companies.company_id` (099:84) are declared `ON DELETE CASCADE`.
- `trg_hierarchy_no_delete` (099:181-184) then raises on the cascaded delete.
- `profiles` and `companies` cascade from `auth.users`. So deleting a staff member who was ever in a unit or held a delegation, or the owner of a company that was ever assigned, fails with 23514.

**Safe fix.** Follow the 086/096 convention, already applied in 101/102. These columns keep ids **without** foreign keys, the rows stay as history, and readers use `left join` and show a deleted account or company.
- Effective state is never read from these rows alone: `_delegate_can` and `_hierarchy_eligible` already re-check the live profile.
- A member or delegation of a deleted account therefore grants nothing.

**Test.** In `admin-hierarchy.test.sql`:
1. Delete the `auth.users` row of a unit member who holds an (expired) delegation; the deletion succeeds and the history rows remain.
2. Delete a company's owner; the company's `admin_unit_companies` history remains.
3. Assert that no foreign key from those three tables to `profiles` or `companies` remains.

### M2 — a dormant delegation comes back to life

**Cause.**
- `owner_set_staff_role` (053) and banning do not end unit memberships or revoke delegations.
- They are inert only because eligibility is re-checked on each use. A later re-promotion or unban silently reactivates an old, unexpired delegation (for example `companies.suspend` on the root unit).

**Safe fix.** An `AFTER UPDATE OF role, ban_status ON profiles` trigger: when `_hierarchy_eligible(new.id)` turns false,
- set `revoked_at = now()` and `revoke_cause = 'eligibility_lost'` on the user's open delegations;
- end their unit memberships;
- write one `hierarchy_events` row each.

It must use the same transaction-local bypass pattern as the other guarded writes, and it never re-grants anything on re-promotion.

**Test.**
1. Grant a delegation, demote the user to `user`, then re-promote to `admin`: `_delegate_can` stays false and the delegation shows as revoked.
2. Repeat with ban then unban.

### M3 — a delegate can suspend companies without step-up

**Cause.** `delegate_set_company_status` (099:661) requires only `_delegate_can('companies.suspend', unit)`. The existing step-up (`step_up_fresh()`, 053:168) works **only for the platform owner**. 5 of the 6 admins have no second factor (H1 note). A delegate can also lift a suspension the owner imposed.

**Safe fix, in two parts.**
- **(a)** Until there is a staff step-up mechanism, a delegate may only **suspend**, never reactivate. Only the owner (`owner_critical_ok`) may reactivate, so the owner's suspension takes precedence.
- **(b)** Require a verified second factor for the delegate: a Supabase Auth `aal2` session claim, not the profile flag (see I5). Until that exists, do not grant `companies.suspend` to anyone.

**Test.** A delegate's reactivation is refused, and the owner's is allowed. With (b), a delegate session without `aal2` is refused.

**Prerequisite.** Do not enable `company_suspension_enforced` or `delegation_enabled` with a `companies.suspend` delegation until M3 (a) and (b) are in.

### Lower items (fix with the next 099 change)

- **L1.** `owner_decide_admin_review` clears `applied_at`, so an applied decision can be decided and applied again. Make applied decisions final, and use a new review row for later changes.
- **L2.** The conversion blocker counts open company-scope tickets that the handover function never moves. Count `mad3oom_support` tickets only, and add the handover button to the owner UI.
- **L3.** Expired delegations still count as active for the unique index, unit archiving and `owner_hierarchy`. Treat `expires_at <= now()` as inactive everywhere. The owner UI should require an expiry, defaulting to the 7-day policy, instead of `null`.
- **L5.** Rolling back 099 while 100 is applied fails partway, because `company_documents.assigned_unit` references `admin_units`. Document "roll back 100 before 099", and wrap rollbacks in a single transaction.

## 100 — company documents

### M1 — documents block account and company deletion

**Cause.**
- `company_documents.company_id` (100:107) and `legal_holds.company_id` (100:160) are `ON DELETE CASCADE` into tables guarded by `trg_documents_no_delete`.
- `assigned_reviewer` (100:114) references `profiles` with no ON DELETE action.

**Decision needed (legal).** Commercial registrations, tax cards and legal holds may need to outlive a company's account.

| Option | Behaviour |
|---|---|
| **A, recommended** | No foreign keys to `companies`; rows and files stay under retention and legal-hold rules; deleting the account succeeds. |
| **B** | Keep the refusal as a deliberate legal guard, and document an owner-run "close company" procedure: export, then the retention run, then deletion. |

Either way, set `assigned_reviewer` to `ON DELETE SET NULL`.

**Test.** Delete a company owner whose company has a document and a legal hold. Under A it succeeds and the rows remain; under B it is refused with a clear message, as documented.

### M2 — storage self-check only catches policies that name the bucket

Resolved by evidence for today's production. A read-only check on 2026-10-14 showed all 14 permissive `storage.objects` policies restricted by `bucket_id`.

**Hardening.** Make the 100 self-check fail on any permissive `storage.objects` policy whose condition does not mention `bucket_id`. Re-run the read-only check right before applying.

### M3 — production-apply risks

- **(a)** The self-check refuses if any switch is on. Apply 094→102 in order, each in one transaction (`apply_migration` is transactional), **before** enabling any switch.
- **(b)** The rollback's `delete from storage.buckets` may be blocked by newer Supabase Storage versions.
  - Test it on a Supabase branch before relying on it.
  - If it is blocked: delete the empty bucket through the Storage API first, then run the rollback without that line.
- **(c)** Deploy `document-scan-callback` with `--no-verify-jwt`. It authenticates with its own HMAC signature; the gateway would otherwise reject the worker with 401. This is now stated in the runbook.

### Lower items

- **L1.** Downloading a document from the owner console uses `owner_capability` without step-up, while review uses `owner_critical_ok`. Require step-up for downloads, since this is the most sensitive read.
- **L2.** A reviewer can download superseded clean versions. Limit downloads to the current version.
- **L3.** The SHA-256 is client-supplied at commit. Compute it server-side in the Edge Function, and stop accepting it from the RPC caller.
- **L4.** `scan_error` versions never re-enter the queue. Either re-queue with an attempt cap, or fix the runbook's "error → retry" line.
- **L5–L7.** A nonce for callback replays; a rate limit on `upload_begin`; the retention dry run should exclude current versions as documented.

## Summary of prerequisites per switch

| Switch | Must be resolved first | After 103/104 |
|---|---|---|
| `delegation_enabled` | 099 M1, M2, L3 | 103 applied; delegates enrolled in MFA (aal2) |
| `company_suspension_enforced` | 099 M1, M2, M3 (a)+(b) | 103 applied; delegates enrolled in MFA (aal2) |
| `company_documents_enabled` | 100 M1 decision; a real scanner (ClamAV) deployed with `DOCUMENT_SCAN_SECRET`; 100 L1, L3 | 104 applied; the three document Edge Functions deployed from the 104 commit; a real scanner and secret; legal sign-off on retention periods |
