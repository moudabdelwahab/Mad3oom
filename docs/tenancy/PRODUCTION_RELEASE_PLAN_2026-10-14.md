# Production release plan — migrations 094 → 102 (all switches OFF)

> **Status: NOT EXECUTED.** Only a rolled-back dry run has touched production (see the update at the end). The recovery-point gate was waived by the owner on 2026-10-14.
> Target: Supabase project `srnelrdpqkcntbgudyto` ("info@mad3oom.online's Project", ap-south-1, Postgres 17.6.1.044, organization `nlcxrkzlikhzyqxexego`, the only project in the account). Identity verified read-only on 2026-10-14.
> Release candidate: branch `claude/dazzling-hypatia-lh1o9i` at `70e7f16`, PR #135, on top of `main` `1124d52`.

## Gates (every one must be true before step 1)

| Gate | State on 2026-10-14 | Evidence |
|---|---|---|
| Final code passes its tests on the exact commit | see PR #135 / release report | CI runner SQL + `npm run test:node` + production-simulation render run |
| Independent security review of the final diff | 3 rounds; last round: no HIGH or CRITICAL | PR #135 description |
| **Human approving review on PR #135, and the PR merged** | **NOT MET**: 0 reviews; draft | GitHub |
| **Verified recovery point** | **WAIVED by the owner on 2026-10-14** (pre-launch; no backup exists). Organization plan is **Free**. Supabase docs: daily backups are for Pro, Team and Enterprise only; PITR is a Pro+ add-on; Free projects should keep their own `supabase db dump`. No backup is visible to any available tool. | `get_organization` → `plan: free`; Supabase docs "Database Backups" |
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

## Update 2026-10-14 ~17:58 UTC — owner decision and pre-flight evidence

- **Recovery-point gate waived by the owner** for this pre-launch deployment ("I am intentionally choosing to proceed without creating a backup"). It is no longer a blocker. The plan is still Free, and no backup exists.
- **Merge:** `main` has no branch protection, and no repository policy authorizes an autonomous merge, so PR #135 is left for the owner to merge. Migrations 094–100 are byte-identical on `main` (`1124d52`, merged by the owner) and on the release candidate. 101 and 102 come from the release candidate `43a9b3c`, which passed independent security review rounds 1–3 with no open HIGH or CRITICAL.
- **Pinned sources verified from inside the production database** (`public.http_get`): all nine files return HTTP 200 with the md5 values below.
- **Full-chain dry run on production, rolled back:** one `DO` block fetched each pinned file, checked its md5, and executed 094 → 102 in order, including every self-check. It then raised `DRYRUN_OK`, so everything rolled back. Timings: 094 1.23 s, 095 0.06 s, 096 0.31 s, 097 0.62 s, 098 0.47 s, 099 0.39 s, 100 0.48 s, 101 0.15 s, 102 0.06 s. Afterwards the ledger head was still `093_continuity_collab_actions` (366 rows), with 13 cron jobs, 6 buckets, 2009 notifications, and no 094+ objects.

## Exact pending commands (the release wrapper used for 092/093)

Run each as **its own** `apply_migration` call, in this order, on project `srnelrdpqkcntbgudyto`. After each one, run the verification in the table above before the next. `apply_migration` records the ledger row. Running a block in the SQL Editor does not, so it would then need a ledger-only registration like `scripts/ledger/register_064_067.sql`.

**094_continuity_reminders** (`apply_migration` name `094_continuity_reminders`):

```sql
do $release094$
declare v_url text := 'https://raw.githubusercontent.com/moudabdelwahab/Mad3oom/1124d52640f422cf350acda8cc9fa386d71a9e9a/migrations/094_continuity_reminders.sql';
  v_status int; v_sql text;
begin
  select r.status, r.content into v_status, v_sql from public.http_get(v_url) r;
  if v_status is distinct from 200 then raise exception '094 release: fetch failed (status %)', v_status; end if;
  if md5(v_sql) <> '986d5a785de6a6a7adac55927716fa99' then raise exception '094 release: checksum mismatch (%), refusing to execute', md5(v_sql); end if;
  execute v_sql;
end $release094$;
```

**095_account_boundaries** (`apply_migration` name `095_account_boundaries`):

```sql
do $release095$
declare v_url text := 'https://raw.githubusercontent.com/moudabdelwahab/Mad3oom/1124d52640f422cf350acda8cc9fa386d71a9e9a/migrations/095_account_boundaries.sql';
  v_status int; v_sql text;
begin
  select r.status, r.content into v_status, v_sql from public.http_get(v_url) r;
  if v_status is distinct from 200 then raise exception '095 release: fetch failed (status %)', v_status; end if;
  if md5(v_sql) <> '40415ef0d3040510e97ac49f446855a9' then raise exception '095 release: checksum mismatch (%), refusing to execute', md5(v_sql); end if;
  execute v_sql;
end $release095$;
```

**096_company_memberships** (`apply_migration` name `096_company_memberships`):

```sql
do $release096$
declare v_url text := 'https://raw.githubusercontent.com/moudabdelwahab/Mad3oom/1124d52640f422cf350acda8cc9fa386d71a9e9a/migrations/096_company_memberships.sql';
  v_status int; v_sql text;
begin
  select r.status, r.content into v_status, v_sql from public.http_get(v_url) r;
  if v_status is distinct from 200 then raise exception '096 release: fetch failed (status %)', v_status; end if;
  if md5(v_sql) <> 'd42128464e895f321680486c2079988b' then raise exception '096 release: checksum mismatch (%), refusing to execute', md5(v_sql); end if;
  execute v_sql;
end $release096$;
```

**097_ticket_scope_isolation** (`apply_migration` name `097_ticket_scope_isolation`):

```sql
do $release097$
declare v_url text := 'https://raw.githubusercontent.com/moudabdelwahab/Mad3oom/1124d52640f422cf350acda8cc9fa386d71a9e9a/migrations/097_ticket_scope_isolation.sql';
  v_status int; v_sql text;
begin
  select r.status, r.content into v_status, v_sql from public.http_get(v_url) r;
  if v_status is distinct from 200 then raise exception '097 release: fetch failed (status %)', v_status; end if;
  if md5(v_sql) <> 'a4e2ce599bc4803956049ca40b8d7f87' then raise exception '097 release: checksum mismatch (%), refusing to execute', md5(v_sql); end if;
  execute v_sql;
end $release097$;
```

**098_company_permissions_usage_ledger** (`apply_migration` name `098_company_permissions_usage_ledger`):

```sql
do $release098$
declare v_url text := 'https://raw.githubusercontent.com/moudabdelwahab/Mad3oom/1124d52640f422cf350acda8cc9fa386d71a9e9a/migrations/098_company_permissions_usage_ledger.sql';
  v_status int; v_sql text;
begin
  select r.status, r.content into v_status, v_sql from public.http_get(v_url) r;
  if v_status is distinct from 200 then raise exception '098 release: fetch failed (status %)', v_status; end if;
  if md5(v_sql) <> '9ed8d49a6edea7e478cc9eb040cc7f2a' then raise exception '098 release: checksum mismatch (%), refusing to execute', md5(v_sql); end if;
  execute v_sql;
end $release098$;
```

**099_admin_hierarchy** (`apply_migration` name `099_admin_hierarchy`):

```sql
do $release099$
declare v_url text := 'https://raw.githubusercontent.com/moudabdelwahab/Mad3oom/1124d52640f422cf350acda8cc9fa386d71a9e9a/migrations/099_admin_hierarchy.sql';
  v_status int; v_sql text;
begin
  select r.status, r.content into v_status, v_sql from public.http_get(v_url) r;
  if v_status is distinct from 200 then raise exception '099 release: fetch failed (status %)', v_status; end if;
  if md5(v_sql) <> 'ad5fa21b4ea6bb03c77ec6b192dd8100' then raise exception '099 release: checksum mismatch (%), refusing to execute', md5(v_sql); end if;
  execute v_sql;
end $release099$;
```

**100_company_documents** (`apply_migration` name `100_company_documents`):

```sql
do $release100$
declare v_url text := 'https://raw.githubusercontent.com/moudabdelwahab/Mad3oom/1124d52640f422cf350acda8cc9fa386d71a9e9a/migrations/100_company_documents.sql';
  v_status int; v_sql text;
begin
  select r.status, r.content into v_status, v_sql from public.http_get(v_url) r;
  if v_status is distinct from 200 then raise exception '100 release: fetch failed (status %)', v_status; end if;
  if md5(v_sql) <> '762bac9a4009a4c74bf7261f5e41057e' then raise exception '100 release: checksum mismatch (%), refusing to execute', md5(v_sql); end if;
  execute v_sql;
end $release100$;
```

**101_customer_transfers_carry** (`apply_migration` name `101_customer_transfers_carry`):

```sql
do $release101$
declare v_url text := 'https://raw.githubusercontent.com/moudabdelwahab/Mad3oom/43a9b3c5956ac98b8a683fd361a2336aa3868d09/migrations/101_customer_transfers_carry.sql';
  v_status int; v_sql text;
begin
  select r.status, r.content into v_status, v_sql from public.http_get(v_url) r;
  if v_status is distinct from 200 then raise exception '101 release: fetch failed (status %)', v_status; end if;
  if md5(v_sql) <> '9f5ec69ed41e4815cf01e5e7e834089c' then raise exception '101 release: checksum mismatch (%), refusing to execute', md5(v_sql); end if;
  execute v_sql;
end $release101$;
```

**102_company_conversations** (`apply_migration` name `102_company_conversations`):

```sql
do $release102$
declare v_url text := 'https://raw.githubusercontent.com/moudabdelwahab/Mad3oom/43a9b3c5956ac98b8a683fd361a2336aa3868d09/migrations/102_company_conversations.sql';
  v_status int; v_sql text;
begin
  select r.status, r.content into v_status, v_sql from public.http_get(v_url) r;
  if v_status is distinct from 200 then raise exception '102 release: fetch failed (status %)', v_status; end if;
  if md5(v_sql) <> 'f8204a3909f749281f2e7980a50d3d09' then raise exception '102 release: checksum mismatch (%), refusing to execute', md5(v_sql); end if;
  execute v_sql;
end $release102$;
```
