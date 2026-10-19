# 103 + 104 — forward fixes for the 099/100 review follow-ups — production install note

> **Status: APPLIED to production on 2026-10-19** (after PR #136 was reviewed and merged as `b9dbc7e`). Every switch stays OFF. See "Applied" at the end.
> 099 and 100 are live in production, so their files stay as they are; every correction is a new forward migration.
> Switches stay **OFF**: `delegation_enabled`, `company_suspension_enforced` and `company_documents_enabled`. Each migration refuses to apply while its own switches are on.

## What changes

### 103_admin_hierarchy_followups (099)

| Item | Change | Regression test (`tests/sql/admin-hierarchy-followups.test.sql`) |
|---|---|---|
| M1 | No FKs from `admin_unit_members.user_id`, `platform_delegations.delegate_id` or `admin_unit_companies.company_id` to accounts or companies (the 086/096/101/102 convention). Deleting an account ends its memberships and revokes its delegations. Deleting a company ends its unit assignment. The rows stay as history. | ⓪ shows the deletion failing before 103 (23514); ② deletes a member with an expired delegation and the owner of an assigned company, then checks the history rows and events |
| M2 | `trg_hierarchy_eligibility` on `profiles` (role, ban, delete) and `trg_hierarchy_company_tie` on `company_staff`, `company_memberships` and `companies`. Losing eligibility ends memberships and revokes delegations at once (`eligibility_lost:<cause>`). Nothing is re-granted on re-promotion. | ③ demote then re-promote; ban then unban; owning a company; a staff role change between admin and support keeps eligibility |
| M3 | Delegate write actions (`delegate_set_company_status`, `unit_member_set`, `unit_member_end`) require an **aal2** session: the `aal` claim in the Supabase Auth JWT, not the profile flag. A delegate may only **suspend**; reactivation is owner-only (`owner_critical_ok`). | ④ no aal2, aal1, aal2; delegate reactivation refused; owner reactivates; events record `as` |
| L1 | `owner_decide_admin_review` refuses once the decision is applied (55000 `review_final`). | ⑤ |
| L2 | The conversion blocker counts open `mad3oom_support` tickets only, which is what `owner_reassign_admin_tickets` moves. Company-scope tickets are reported as `open_company_tickets`, for information. The owner console gets a handover button. | ⑥ and the render test |
| L3 | Expired delegations are closed (`revoke_reason = 'expired'`) before a regrant or a unit archive, and hidden from `owner_hierarchy`. A grant without an expiry gets 7 days; the maximum is 90. The console requires a date (default +7 days). | ⑦ and the render test |
| L5 | Rollback order is enforced: the 099 rollback refuses up front while 100 or 103 is applied; 103's refuses while 104 is applied. | ⑧ |

### 104_company_documents_followups (100)

| Item | Change | Regression test (`tests/sql/company-documents-followups.test.sql`) |
|---|---|---|
| M1 | **Decision A** (below). No FK from `company_documents` or `legal_holds` to `companies`. `assigned_reviewer` becomes `ON DELETE SET NULL`, with a `reviewer_removed` event. Company deletion logs `company_deleted`. The owner queue shows «شركة محذوفة», and a hold can still be placed on a deleted company's documents. | ⓪ shows both deletions failing before 104 (23514 and 23503); ⑧ |
| M2 | `_storage_unscoped_policies()`; the self-check fails on any permissive `storage.objects` policy that does not mention `bucket_id`. | ② adds an unscoped policy and the migration refuses |
| L1 | An owner download requires a fresh step-up (42501 `step_up_required`). | ⑤ and the Node test |
| L2 | Reviewers download the current version only (55000 `not_current`). Reviewer access needs an aal2 session, as with 103. | ⑤ |
| L3 | `document_upload_commit` with the user's identity is refused (`server_commit_only`). `document_upload_commit_server(version, actor, sha256)` is service-role only; `company-document-upload` passes the user it verified and the SHA-256 it computed from the bytes it uploaded. | ③ and the Node test |
| L4 | `scan_attempts`; `scan_error` re-enters the queue until 3 attempts, then stays quarantined with a `scan_gave_up` event. | ④ |
| L5 | `document_scan_result(…, p_nonce)`: the callback's verified HMAC signature is accepted once (`document_scan_nonces`, pruned after a day); a replay gives 409 `replayed`. The old 4-argument form is refused. | ④ and the Node test |
| L6 | `document_upload_begin` allows 3 pending uploads per document and 20 new versions per hour per uploader (54000, which the upload function returns as 429 `rate_limited`). Resending with the same idempotency key is not counted. | ⑦ and the Node test |
| L7 | The retention dry run never lists the current version, even when it is rejected or quarantined. | ⑥ |

### Decision A for 100 M1 (documented choice)

Company documents (commercial registrations, tax cards, authorisation letters) and legal holds **outlive the company account**. Deleting the account succeeds, and the rows and files stay under the retention and legal-hold rules. The retention dry run still covers them, and nothing is deleted automatically.

This was chosen over B (refusing the deletion) for three reasons:
- it follows the 086/096/101/102 history convention;
- it never loses records that may be legally required;
- it does not block account deletion requests.

If legal review prefers B, it can be done as a later forward migration that adds a refusal trigger. A's data stays compatible with that.

## Apply (only after review and approval; not executed)

1. Confirm the ledger head is `102_company_conversations` and that the three switches are off.
2. Apply `103_admin_hierarchy_followups`, then `104_company_documents_followups`. Use one `apply_migration` call each, with the release wrapper (fetch at the merged commit, check md5, execute), as for 094–102.
3. Verify:

```sql
select key, enabled from public.platform_feature_switches
 where key in ('delegation_enabled', 'company_suspension_enforced', 'company_documents_enabled');          -- all false
select count(*) from pg_trigger where not tgisinternal and tgname in
  ('trg_hierarchy_eligibility', 'trg_hierarchy_company_tie', 'trg_hierarchy_company_deleted',
   'trg_documents_reviewer_deleted', 'trg_documents_company_deleted');                                   -- 7
select public._storage_unscoped_policies();                                                             -- {}
select has_function_privilege('authenticated', 'public.document_upload_commit_server(uuid,uuid,text)', 'execute'); -- false
```

4. **Edge Functions**: none are deployed today. When documents are enabled later, deploy `company-document-upload`, `company-document-download` and `document-scan-callback` from the same commit. The upload function needs 104, because it commits through the service role.

## Rollback

Order: **104 → 103 → 102 → 101 → 100 → 099**. Run each rollback as one transaction:

```
psql --single-transaction -v ON_ERROR_STOP=1 -f migrations/_rollback/<n>.down.sql
```

Each rollback checks its guards before changing anything:
- 104 refuses while documents are enabled, or while documents or holds of a deleted company exist.
- 103 refuses while 104 is applied, while delegation or suspension is on, or while history rows of deleted accounts or companies exist.
- 100 refuses while 104 is applied; 099 refuses while 100 or 103 is applied.

With no such data, each restores the previous schema exactly; the tests check this with a schema digest. Memberships ended and delegations revoked by 103 stay ended: a rollback never restores authority.

## Prerequisites before enabling the switches (after 103/104)

| Switch | Still required |
|---|---|
| `delegation_enabled` | Delegates must enrol in Supabase Auth MFA, because write actions need an aal2 session. Only an owner-reviewed delegation should be active. |
| `company_suspension_enforced` | The same as above, for delegates with `companies.suspend`. Reactivation is owner-only. |
| `company_documents_enabled` | A real ClamAV worker deployed and verified (`DOCUMENT_SCANNER_RUNBOOK.md`), and `DOCUMENT_SCAN_SECRET` set at the same time. Deploy the three document Edge Functions from the commit that contains 104. Reviewers need MFA (aal2). Legal sign-off on retention periods, which are still `legally_approved = false`. |

## Independent security review (2026-10-14) — round 1

The reviewer found **no HIGH or CRITICAL issues**. It checked privileges against Supabase's default grants, trigger safety, the aal2 and reactivation paths, the 104 commit/nonce/limit/download rules, rollback order and the Edge Function handlers.

| # | Severity | Finding | Resolution |
|---|---|---|---|
| 1 | LOW | A retried upload whose object already existed was committed with the SHA-256 of the *new* request's bytes | Fixed: on 409 the upload function downloads the stored object and hashes it. If the download fails, nothing is committed. Node test added |
| 2 | LOW | Concurrent `begin` calls for different document types could exceed the hourly limit | Fixed: `pg_advisory_xact_lock` per uploader before counting |
| 3 | LOW | The storage self-check was a plain text match (`bucket_id = 'x' OR …` passed) | Fixed: each permissive policy must have `bucket_id = <literal>` (or `ANY` of literals) as its top-level conjunct. `OR`, `IS NOT NULL` and nested `OR` forms are rejected, as tested. Verified read-only against production: 0 of 16 policies flagged |
| 4 | LOW | The 104 rollback dropped the "104 applied" marker first, so a partial run without a transaction weakened the 103 and 100 guards | Fixed: the marker is dropped last |
| 5 | LOW | The 104 rollback discarded scan attempts and nonces | Fixed: the rollback refuses while any scan history exists |
| 6 | LOW | The owner could not reactivate a suspended company after unassigning it from its unit | Fixed: the owner path does not require a unit assignment. SQL test added |
| 7 | INFO | Tests read `aal` from a stub setting; real Supabase reads it from `request.jwt.claims` | **Pending (manual):** before enabling `delegation_enabled`, sign in a delegate with MFA and confirm `select auth.jwt() ->> 'aal'` returns `aal2` |
| 8 | INFO | A scanner re-sending an identical signed result now gets 409 `replayed` | Documented: the worker should treat `replayed` as "already delivered", or re-sign with a fresh timestamp |
| 9 | INFO | An admin converted under L2 keeps any company-scope tickets assigned to them | Accepted: there is no access leak (company tickets need company permissions). Reassign such tickets inside the company before converting |

Residual: the storage check inspects policy text as `pg_get_expr` prints it. It is not an effective-access probe, which would be meaningless while the bucket holds no objects. Re-run `select public._storage_unscoped_policies();` before enabling documents.

## Applied (2026-10-19, project `srnelrdpqkcntbgudyto`)

Before the apply:
- `get_project` returned ACTIVE_HEALTHY.
- The ledger head was `102_company_conversations` (375 rows), with 0 switches on.
- A full rolled-back dry run of 103 → 104 on production passed: 103 in 0.80 s, 104 in 0.27 s, 7 triggers, `_storage_unscoped_policies()` = `{}`.

Each migration was its own `apply_migration` call through the release wrapper, pinned to merge commit `b9dbc7e7815dec78472d8e639fa27dc9e0f1dd4e` with an md5 check (103 `c12e46d3…`, 104 `41abc4ef…`). Both returned `{"success":true}`.

| Migration | Checks after apply |
|---|---|
| `103_admin_hierarchy_followups` | 5 eligibility/deletion triggers; 0 FKs from hierarchy history to `profiles`/`companies`; internal functions closed to users; 6 reviews, 0 units, 0 delegations (unchanged); `delegation_enabled`/`company_suspension_enforced` false |
| `104_company_documents_followups` | ledger head `104_company_documents_followups` (377 rows); 7 triggers in all; `_storage_unscoped_policies()` = `{}`; `document_upload_commit_server` service-role only; 5-argument `document_scan_result` closed to users; `assigned_reviewer` FK is `SET NULL`; 0 document FKs to companies; bucket private; 0 documents; 0 switches on; 39 tickets, 41 profiles, 2009 notifications (unchanged) |

`get_advisors(security)` showed no ERROR. Each WARN group kept its size. INFO `rls_enabled_no_policy` went from 24 to 25 because of `document_scan_nonces`, which is intended: no grants, reached only by the service-only scan function.

Not done: no Edge Function was deployed, no secret was set, and no switch was enabled. The prerequisites table above still applies.
