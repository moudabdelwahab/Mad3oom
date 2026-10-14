# Production release plan — migrations 094 → 102 (all switches OFF)

> **Status: NOT EXECUTED — blocked by release gates** (see "Gates"). Nothing in this document has been run against production.
> Target: Supabase project `srnelrdpqkcntbgudyto` ("info@mad3oom.online's Project", ap-south-1, Postgres 17.6.1.044, organization `nlcxrkzlikhzyqxexego`, the only project in the account). Identity verified read-only on 2026-10-14.
> Release candidate: branch `claude/dazzling-hypatia-lh1o9i` at `70e7f16`, PR #135, on top of `main` `1124d52`.

## Gates (every one must be true before step 1)

| Gate | State on 2026-10-14 | Evidence |
|---|---|---|
| Final code passes its tests on the exact commit | see PR #135 / release report | CI runner SQL + `npm run test:node` + production-simulation render run |
| Independent security review of the final diff | 3 rounds; last round: no HIGH or CRITICAL | PR #135 description |
| **Human approving review on PR #135, and the PR merged** | **NOT MET**: 0 reviews; draft | GitHub |
| **Verified recovery point** | **NOT MET**: organization plan is **Free**. Supabase docs: daily backups are for Pro, Team and Enterprise only; PITR is a Pro+ add-on; Free projects should keep their own `supabase db dump`. No backup is visible to any available tool. | `get_organization` → `plan: free`; Supabase docs "Database Backups" |
| Migration order verified against the production ledger | MET: ledger ends at `093_continuity_collab_actions`; 0 rows for 094+; no 094–102 objects | read-only SQL |

### How the owner can satisfy the recovery-point gate (choose one)

1. **Upgrade the organization to Pro.** Daily backups then become accessible: Supabase says up to 7 existing daily backups become available after upgrading. Optionally enable PITR. Confirm a backup dated today in Dashboard → Database → Backups.
2. **Take a logical dump yourself** (the database password stays with you):
   `supabase db dump --db-url "$PROD_DB_URL" -f mad3oom-pre-094.sql` plus `--data-only -f mad3oom-pre-094-data.sql`. Store both off-site, and confirm the files are non-empty and contain `093_continuity_collab_actions`.
3. **Storage objects are not in any database backup.** No migration here deletes objects, but keep this in mind for a restore.

## Ordered migration plan

Apply **one migration per call**, each as a single transaction: `apply_migration` / `supabase db push`, never piecemeal `psql -f`. Stop at the first error; nothing after it may run. Use the repository file contents at `main` **after PR #135 is merged**, verified by md5 against the reviewed commit.

| # | File | Precondition check (read-only) | Verification after apply |
|---|---|---|---|
| 1 | `094_continuity_reminders.sql` | ledger head = `093_continuity_collab_actions` | `continuity_jobs` exists; `reminders_enabled` / `escalation_enabled` false in every `continuity_policies` row |
| 2 | `095_account_boundaries.sql` | 094 present | `my_account_kind()` exists; A1 note verification SELECTs |
| 3 | `096_company_memberships.sql` | 095 present | `platform_feature_switches` exists, all `enabled = false`; memberships backfilled = number of linked customers |
| 4 | `097_ticket_scope_isolation.sql` | 096 present | `select scope, count(*) from tickets group by 1` → `mad3oom_support \| 39`; 6 `tenant_isolation` policies |
| 5 | `098_company_permissions_usage_ledger.sql` | 097 present | `usage_reconciliation() -> 'mismatches' = '[]'` (shadow ledger matches the live count) |
| 6 | `099_admin_hierarchy.sql` | 098 present | 7 hierarchy tables, no rows; switches off |
| 7 | `100_company_documents.sql` | 099 present; **re-run the storage-policy check** (all `storage.objects` permissive policies scoped by `bucket_id`) | bucket `company-documents` private; no policy names it; no retention purge function |
| 8 | `101_customer_transfers_carry.sql` | 100 present | `trg_guard_isolation_after_transfers` exists; `usage_reconciliation` mismatches `[]`; quota per account unchanged |
| 9 | `102_company_conversations.sql` | 101 present | no grants on `company_conversation*`; not in `supabase_realtime`; `company_inbox_enabled = false` |

After each step:
- `select name from supabase_migrations.schema_migrations order by version desc limit 1` names the step just applied;
- `select key from platform_feature_switches where enabled` returns **0 rows** (from step 3 on).

### Post-migration smoke tests (read-only, as the API sees it)

- `select public._feature_on(k) from unnest(array['company_isolation_enforced','data_access_grants_enabled','multi_company_memberships_enabled','customer_transfers_enabled','ticket_carry_enabled','company_permissions_enabled','delegation_enabled','company_documents_enabled','company_inbox_enabled','historical_access_enabled','company_suspension_enforced']) k` → all false.
- `get_advisors(security)`: no new ERROR-level findings on 094–102 objects.
- `query_logs` for the 30 minutes after apply: no `42501` or `0A000` storm from existing pages, and no migration errors.
- **Existing frontend** (already on `main` since #134 and deployed by Vercel): before the migrations it degrades safely (production-simulation render run). After them, with switches off, the same paths answer real data, which is covered by the render suite against the implemented RPCs.

## Code deployment

- **Frontend:** goes live through Vercel when PR #135 is merged to `main`. #135 changes only `assets/js/company/company-moves.js` (outcome messages) on the frontend side.
- **Edge Functions:** none in this release. `company-document-*`, `document-scan-callback` and `ticket-carry-copy` stay undeployed until their own features are approved. No secrets are set (`DOCUMENT_SCAN_SECRET` and `CARRY_COPY_SECRET` stay unset).

## Switches (must remain OFF throughout)

`company_isolation_enforced`, `data_access_grants_enabled`, `multi_company_memberships_enabled`, `customer_transfers_enabled`, `ticket_carry_enabled`, `company_permissions_enabled`, `delegation_enabled`, `company_documents_enabled`, `company_inbox_enabled`, `historical_access_enabled`, `company_suspension_enforced`. Also 094's `reminders_enabled` and `escalation_enabled`.

- `usage_ledger_enforced` does not exist: the 098 ledger is shadow-only by design.
- Retention has no purge function, only `owner_retention_dry_run`.
- Malware scanning stays inactive until a real ClamAV worker exists. Without the secret, every document stays quarantined.

## Rollback

- Each migration has `migrations/_rollback/<n>.down.sql`. Roll back in **reverse** order: 102 → 101 → … → 094; 100 must go before 099.
- Each rollback refuses while its switches are on or once it holds data.
- With all switches off and no new data, every rollback restores the previous schema, as proven by a schema digest in tests.
- If a migration fails mid-apply, its transaction rolls back and the ledger does not advance. Investigate; do not retry blindly.
