# Company isolation rollout procedure (2026-10-21)

> **Decision for `company_isolation_enforced`: NO-GO today. It becomes GO for one supervised, reversible activation once the three gates in §1 are met.**
> Every check that can run before activation has passed (§3). The production HTTP and Edge runtime under isolation (§4) can only be observed with the switch ON. The steps in §2 therefore turn it on in a window where turning it back off is still possible, and they verify it immediately.
> `data_access_grants_enabled` stays **OFF** until isolation has been ON and verified, including on the first company ticket (§2.4).

## 0. Production state (read-only, 2026-10-21)

| Item | Value |
|---|---|
| Migration ledger | 384 rows, head `20261021115448 111_billing_ticket_isolation` |
| Switches | 12 of 12 OFF. No `feature_switch.*` row in `privileged_audit` |
| Tenancy data | 1 company (the platform owner's, active), 1 membership, **0** `company`-scope tickets |
| One-way guard inputs | 0 completed transfers, 0 carry items, 0 approved account requests, 0 access grants. Permissions and isolation can still be turned back OFF |
| SLA processing | `pg_cron` job `sla-breach-check`, `*/15 * * * *`, runs `SELECT public.check_sla_breaches();` in SQL only, with no HTTP path |
| `main` | `86dbba1`. Its only change after `2c05fd2` (PR #148) is the owner-dashboard layout. No migration was added after 111 |

## 1. Gates before isolation

1. **This PR merged with CI green**, including the new HTTP isolation job (`npm run test:http`, PostgREST pinned by sha256).
2. **`company_permissions_enabled` ON and verified** (§2.1). The matrix and HTTP suites turn isolation on only after permissions, so isolation without permissions is untested. `_transfers_require_enabled`, `_carry_require_enabled` and `_account_request_execution` also treat the two as a pair.
3. **The owner's explicit approval (Q17)**, recorded as the switch reason, for one supervised window with the rollback triggers in §2.3.

## 2. Activation sequence

Every change goes through the owner dashboard → «حوكمة الشركات» → «مفاتيح التفعيل»: a fresh step-up, a reason of at least 10 characters, and a confirmation. That calls `owner_set_feature_switch` and writes a `privileged_audit` row named `feature_switch.<key>`. Never use a raw `UPDATE`.

**The order is not enforced by `owner_set_feature_switch`.** The function checks only the step-up, the reason and that the key exists. The order below is a procedure.

The real dependencies are in the code:

| Switch | Requires (checked by the database) | Requires (procedure only) | Turning it OFF |
|---|---|---|---|
| `company_permissions_enabled` | — | — | Refused once any completed transfer, carry item or approved account request exists (`_guard_isolation_after_transfers`) |
| `company_suspension_enforced` | — | — | Always possible |
| `company_isolation_enforced` | — | permissions ON; Q17 | Same one-way guard as permissions |
| `data_access_grants_enabled` | — (`_access_require_enabled` and `_access_grant_active` check only this switch) | isolation ON and verified, first company ticket checked (§2.4), separate approval | Always possible |
| `customer_transfers_enabled`, `ticket_carry_enabled`, `account_request_execution_enabled` | isolation **and** permissions (they raise `prerequisite_not_enabled`) | — | The first use makes permissions and isolation one-way |

Keep `customer_transfers_enabled`, `ticket_carry_enabled` and `account_request_execution_enabled` **OFF** throughout. That way isolation can always be turned back off.

### 2.1 `company_permissions_enabled`
- **Before:** switches all OFF, one-way inputs at 0 (§0).
- **After (read-only):**
  - the switch is `true` with an audit row;
  - rolled-back role probes for the owner, the company member, an admin and a direct customer match the OFF results recorded in `PHASE1_READINESS_2026-10-20.md` §5.3.
- **Roll back:** switch it OFF in the same panel.

### 2.2 `company_suspension_enforced`
- **Before:** §2.1 done. No company has `status = 'suspended'`.
- **After:** the switch is `true` with an audit row. `company_has_feature` is unchanged for the active company.
- **Roll back:** switch it OFF.

### 2.3 `company_isolation_enforced`: supervised window
- **Before:**
  - gates §1.1–§1.3;
  - one-way inputs still 0;
  - record these baselines: staff-visible support-ticket count (rolled-back probe as one admin), `wf-executor` and `mcp` error counts for the last hour (`query_logs`), and the last `sla-breach-check` run status (`cron.job_run_details`).
- **Activate.** Then, within 15 minutes, run read-only checks only:
  1. `_isolation_on()` is true; `data_access_grants_enabled` is false; there is one new audit row.
  2. The function and policy fingerprints are unchanged from the post-111 values (`ISOLATION_VERIFICATION_2026-10-21.md` §9).
  3. A rolled-back probe as an admin and as support sees the same support tickets as the baseline. Company tickets: 0 exist today.
  4. The owner opens the admin ticket list and an existing support ticket in the browser. They load, and the counts match. Nothing is written.
  5. `wf-executor` and `mcp` logs show no new errors. In particular, no `التذكرة غير موجودة` on a `mad3oom_support` ticket, which would mean the guard failed closed.
  6. The next `sla-breach-check` run succeeds.
- **Rollback triggers** (any one is enough): staff lose a support ticket; a new 5xx or error spike in `wf-executor` or `mcp`; `sla-breach-check` fails; customers report a missing ticket.
- **Roll back:** switch isolation OFF in the panel. This is allowed while the one-way inputs are 0. The policies return to OFF behaviour in the same statement; nothing is cached.

### 2.4 First company ticket (closes the "0 company tickets" gap)
Do **not** create a synthetic company ticket in production. A ticket insert fires 22 triggers, including `trg_dispatch_ticket_webhooks`, `trg_dispatch_workflow_on_ticket_created`, notification and usage-ledger triggers. These have external effects that a rollback or delete does not undo.

When the first real `company`-scope ticket exists, run read-only probes inside `BEGIN … ROLLBACK`, using `set_config` and `SET LOCAL ROLE authenticated` for each role:

| Role | `tickets` | `ticket_replies` | `ticket_attachments` | `storage.objects` (bucket `tickets`) | `ticket_invoice_status` / `ticket_invoice_document` |
|---|---|---|---|---|---|
| Admin and support | 0 rows | 0 rows | 0 rows | 0 rows | `none`; same error as a missing ticket |
| The company's owner or active staff (control) | 1 row | ≥ 1 row | ≥ 1 row | ≥ 1 row | — |
| The ticket's customer (control) | 1 row | ≥ 1 row | ≥ 1 row | ≥ 1 row | — |
| Another company's owner (once a second company exists) | 0 rows | 0 rows | 0 rows | 0 rows | — |

Run the same checks again as the owner in the browser: the admin ticket list does not show it, and the company dashboard does.

### 2.5 `data_access_grants_enabled`
Only after §2.3 has run for at least one SLA cycle without a rollback trigger, §2.4 has passed, and separate approval is given. Afterwards:
- a `request_data_access` → owner approval → `granted_ticket_view` round trip on the company ticket works only for the approved grantee and logs each read;
- an expired or revoked grant returns nothing.

**Roll back:** switch it OFF. Active grants stop working at once, because `_access_grant_active` checks the switch.

## 3. Verified before activation

| Path | Evidence | Where |
|---|---|---|
| Company A vs company B, members, customers, platform staff, anonymous: tickets, replies, attachments, activity, ratings, tags, storage | 112-row matrix with a positive control for every denial | `tests/sql/tenant-isolation-matrix.test.sql` (SQL; not re-run, since no SQL or migration changed) |
| Invoice RPCs; purchase and upgrade ticket ownership after 111; support billing unchanged | SQL suite plus a rolled-back production probe | `tests/sql/billing-ticket-isolation.test.sql`; `ISOLATION_VERIFICATION_2026-10-21.md` §9 |
| SLA, workflow, MCP, notifications and webhooks skip company tickets | SQL side-channel tests | `tests/sql/ticket-isolation.test.sql` ⑥ |
| **New: the same paths over real HTTP.** PostgREST 12.2.3 with JWTs signed per synthetic persona; identity arrives through `request.jwt.claims`; the production `auth.uid()`, `auth.role()` and `auth.jwt()` bodies; HTTP status codes and error texts as the browser sees them; HTTP results equal SQL results for all 12 personas, OFF and ON | 11 tests | `tests/http/tenant-isolation-http.test.mjs` |
| **New: Edge-function logic on real HTTP responses.** The `wf-executor` guard (`ticket-guard.js`) through the service role: company ticket = "not found", same as a random id; support tickets allowed. The MCP decision (`ticket-isolation.js`) on real `mcp_ticket_tenancy` output never grants more than `_ticket_row_visible`, and equals it for company tickets | same file | — |
| Owner panel: every registered switch shown, the action button visible on all widths, step-up, reason and confirmation kept | Chromium render tests | `tests/owner-governance.render.test.mjs` |

## 4. Not verified: what remains, and how it gets closed

| Gap | Why it can't be closed before activation | Closed by |
|---|---|---|
| Production PostgREST, Storage API and GoTrue with isolation ON | There is no staging project (free plan, no branching), and the switch is global | §2.3 checks 3–4 |
| `wf-executor` and `mcp` running in the Deno runtime under isolation | No Deno or Edge runtime here. Their decision code is tested over real HTTP (§3); their runtime is not | §2.3 check 5 |
| Supabase Storage API itself | Locally, `storage.objects` is read through PostgREST under the same role and policies. Signed-URL issuance is not exercised | §2.4 storage row; the owner opens an attachment |
| Real company data | Production has 0 company tickets | §2.4 |
| MCP for the `support` role | MCP allows support-scope tickets only for `role = 'admin'`, which is narrower than the database. Not a leak | — (documented) |
