# Multi-tenant isolation verification (2026-10-21)

> **Verdict: NOT READY.** `company_isolation_enforced` stays OFF and must not be treated as ready for activation.
>
> Cross-company isolation was tested on synthetic data with 112 cases: every case shows the company-A data refused across the company boundary, and every refusal is paired with a positive control. Two confirmed defects were found (§4). They are **fixed in branch, awaiting review and deployment**: migration `111_billing_ticket_isolation`. Migration 111 is **NOT applied to production**, so both defects still exist there.
>
> Once 111 is applied and verified, the recommendation becomes **READY WITH LIMITATIONS** (§8). Activation remains the owner's decision.
>
> No production flag, data, policy, migration, Edge Function, credential or setting was changed. Production was only read (catalog fingerprints, row counts, deployed versions).

## 1. Scope

- **Question:** does company A's private data (tickets and their children, files, conversations, documents, notifications, dashboard and company RPCs) stay out of reach of:
  - company B (owner, staff, customers);
  - platform staff (elevated admin, admin, support) once isolation is ON;
  - anonymous callers?
- **Paths covered:**
  - RLS on direct PostgREST-equivalent reads and writes;
  - every `SECURITY DEFINER` RPC reachable by `authenticated` that reads ticket data;
  - the service-role database functions used by MCP and workflows;
  - the Edge Functions that read tenant tables with the service role.

## 2. Environment and commit

| Item | Value |
|---|---|
| Repository | `main@d020909` (PR #146 merged), plus this branch: `111`, two SQL tests, one Node test change |
| Production | `srnelrdpqkcntbgudyto`, ledger head `110_api_token_credentials_immutable` (383 rows), 12/12 switches OFF |
| Hosted test environment | **None exists.** The account has one project (production) and its default branch; branching is not available on the free plan |
| Isolated environment used | Throwaway local PostgreSQL 16 (`initdb` per run), built from `tests/fixtures/prod-shape` + migrations 094→110 (+111) in production's order (109 before 108). Synthetic personas and data only (`tests/fixtures/tenancy`) |
| Edge runtime | Not available (no Deno, no Docker daemon). Edge Function paths were reviewed in source against the deployed versions, and their pure decision modules were run in Node |

**Fidelity of the local environment** (read-only fingerprint of production, 2026-10-21; local chain through 110):
- **Functions:** all 1,088 public functions are identical in body md5, `SECURITY DEFINER`, `proconfig`, and `authenticated`/`anon` EXECUTE.
- **Public schema:** all 458 RLS policies and all table privileges are identical.
- **Differences (only these):**
  - production has 19 extra `http` extension functions;
  - production has 8 extra permissive `storage.objects` policies, for the `avatars`, `subdomain-logos` and `chat-attachments` buckets. They are added verbatim in the matrix test, so storage matches too;
  - storage-internal tables differ.
- **The six functions changed by 111** match production md5 exactly.
- **Conclusion:** the local results represent production's database authorization layer. They do not cover the HTTP gateway, Storage API or Edge runtime (§7).

**Deployed versions re-checked:** `mcp` v35, `wf-executor` v46, `sie-api` v24, `sie-channel-telegram` v28, `regenerate-api-token-secret` v19, `accounting-sync` v7, `chat-bot-reply` v14.

## 3. What was executed

```
# per SQL file: fresh cluster, then
psql -h <sock> -U postgres -q -f tests/sql/tenant-isolation-matrix.test.sql postgres   # 112 cases, ALL PASS (with 111); 7 FAIL without 111
psql ... -f tests/sql/billing-ticket-isolation.test.sql                                 # ⓪ reproduce, ① fixed ×2, ② controls, ③ rollback, ALL PASS
node --test tests/mcp-ticket-isolation.test.mjs                                          # 7/7
node --test tests/company-navigation.test.mjs                                            # 21/21 (last migration = 111)
npm run test:node && bash tests/run-sql-tests.sh                                         # full suites, §9
```

The production queries were read-only:
- the catalog fingerprint;
- the inventory of ticket-linked tables and definer functions;
- invoice counts and scopes (4 invoices, all on `mad3oom_support` tickets);
- the `accounting_invoices` policies;
- the Edge Function list;
- the `storage.objects` policy texts.

**Method.** Cases are recorded in `t.m` as expected and actual values.
- **Personas:** companies A and B (plus the platform owner's company W); for each, an owner, a supervisor, an agent and customers; platform elevated admin, admin and support; a standalone account; anonymous.
- **Activation:** switches are turned on through the real owner path (`owner_set_feature_switch` with a fresh step-up), in the order permissions → suspension → isolation. Grants stay OFF.
- **Positive controls:** every denial has one. Either the same access succeeds for the owning company, or it succeeds with isolation OFF (the OFF rows). A refusal therefore cannot pass because the data is missing.

## 4. Findings

### I1 — Platform staff reach company tickets through the accounting-invoice RPCs (Medium; fixed in branch by 111, awaiting review and deployment; still present in production)
- **Affected:** `ticket_invoice_status`, `ticket_invoice_document`, `attach_accounting_invoice`, `attach_accounting_invoice_pdf`, and `accounting_invoices` RLS.
  - The four functions are `SECURITY DEFINER`, callable by `authenticated`, and gated only by `is_platform_staff()`. They have no isolation check.
  - `accounting_invoices` has a single SELECT policy, `user_id = auth.uid() OR is_admin()`.
- **Effect, with isolation ON and an invoice row on company ticket TA1:**
  - the admin reads the invoice status, and the invoice document (company ticket number, customer contact);
  - `attach_accounting_invoice` writes a **public reply and an attachment into the company-private ticket**;
  - the invoice row stays readable.
- **Reproduced:** matrix rows 90–92, and ⓪ in `billing-ticket-isolation.test.sql`.
- **Fix:**
  - with isolation ON a company ticket is "without invoice" for staff, with the same response as a missing invoice (`{"state":"none","has_pdf":false}` / P0002), so there is no oracle;
  - `accounting_invoices` gets the same restrictive `tenant_isolation` policy as the ticket child tables (097);
  - owners keep seeing their own invoices, and support-scope invoices are unchanged (rows 87–89, positive).

### I2 — A subscription request can be linked to a company ticket, including another account's (Medium; fixed in branch by 111, awaiting review and deployment; still present in production)
- **Affected:**
  - `request_subscription_purchase` accepted any ticket the caller owns, whatever its scope;
  - `request_subscription_upgrade` accepted **any ticket id for any account**, with no ownership check.
- **Why it matters:** `accounting-sync` invoices `whatsapp_subscriptions.ticket_id`. This is how an invoice reaches a company ticket (the precondition for I1).
- **Effect:**
  - company A's customer can link a purchase to their company ticket;
  - company B's owner can link an upgrade to company A's ticket. After the next sync, staff would attach B's invoice into A's ticket. That cross-company write does not depend on the isolation switch.
- **Reproduced:** rows 93–95: 2 subscriptions ended up referencing TA1.
- **Fix:**
  - both functions now accept only a ticket the caller owns that is `mad3oom_support` (personal billing goes to Mad3oom, Q10);
  - the real client flow (`submit_subscription_request` / `submit_subscription_upgrade`) creates its own ticket with `category = subscription`, which is always stamped `mad3oom_support`, so it is unchanged (tested in ②).
- **Production today:** 4 invoices, 0 on company tickets, 0 company-scope tickets. There is no current exposure, but the path exists.

### Informational (no change proposed)
- **Fail-open default:** `_feature_on` returns false for a missing switch row, so a deleted `company_isolation_enforced` row means isolation OFF.
  - **Mitigation:** no role (`authenticated`, `service_role`) has any privilege on `platform_feature_switches`. Writes go only through `owner_set_feature_switch`, which requires owner and fresh step-up and is audited, and `_guard_isolation_after_transfers` guards UPDATE and DELETE.
- **Fail-closed paths:**
  - MCP's `tenancyFromRpc` treats any error or malformed response as isolation ON with no team (7 Node tests);
  - `wf-executor` v46's guard treats an unreadable flag or ticket as "not found".
- **Billing metadata:** `wa_wallet_adjust` and `wa_wallet_charge_message` store an arbitrary `p_ticket_id` as metadata on a wallet transaction, without reading the ticket. There is no cross-tenant read; it is a metadata-integrity issue only. Not fixed here.
- **Continuity:** ticket sources (`mad3oom_ticket`) are not implemented. `_continuity_attach` rejects every type except `mad3oom_message` with 0A000 (row 74), and no `continuity_sources` row references a ticket.
- **Website/SIE chats:** `chat_sessions` and `chat_messages` are Mad3oom's own helpdesk and readable by platform staff by design. Company-private conversations are the separate 102 tables, tested in rows 36–49. The SIE engine review (F2) stands, at unchanged versions.

### Review of 111 (2026-10-21)
- **Placement:** every new check runs before any sensitive read or write.
  - In the four invoice functions, it runs right after the staff gate and before the first `accounting_invoices` read.
  - In `request_subscription_upgrade`, it runs right after the login check, before the quote, the lock or the insert.
  - In `request_subscription_purchase`, the existing ownership check gains the scope condition.
- **Identity:** the caller is always `auth.uid()`. Neither function takes a user or company id, so the only substitutable input is `p_ticket_id`. Its refusal is byte-identical to the one for a nonexistent ticket (`errfull` comparison in `billing-ticket-isolation.test.sql` ①).
- **Reuse:** no new helper. The invoice functions use 097's `_ticket_private_to_company` (the helper `mcp_admin_update_ticket` uses), and the policy reuses `_isolation_on` and `_ticket_id_visible` exactly as the 097 child-table policies do.
- **Service-role paths:**
  - `service_role` and `postgres` have `rolbypassrls = true` in production (read-only check), and every function touching `accounting_invoices` is `SECURITY DEFINER` owned by `postgres`. The new policy therefore constrains only direct `authenticated`/`anon` reads.
  - `accounting-sync` (`record_accounting_invoice`) still records and reads invoices with isolation ON (②).
  - `get_public_invoice` (anon, unguessable ≥32-character token) is unchanged.
  - No service-role flow calls the invoice-attach functions, which require `auth.uid()`.
- **Remaining inventory:** after 111, the inventory of `authenticated`-callable definer functions that read ticket data without an isolation helper no longer contains the invoice functions. The remaining entries are designed paths with their own gates (grants, historical access, carry, owner tooling, ihub admin, own subscriptions), plus the two subscription RPCs, whose check filters `scope` directly.
- **Unchanged since the audit:**
  - `mcp` v35 (DB-guarded `mcp_admin_update_ticket`, plus the fail-closed in-memory filter);
  - `wf-executor` v46 (guard plus the 097-gated `wf_*` RPCs);
  - `chat-bot-reply` v14 (only the caller's own `user_id`);
  - `accounting-sync` v7.
- **Baseline and rollback:**
  - The migration body is the production definition (md5 of `prosrc` verified for all six) with only the inserted checks.
  - The rollback restores the six bodies byte-for-byte (`digest6` comparison) and drops the policy.
  - It refuses while isolation is ON.
  - Re-application works: 111 is applied twice, and again after the rollback.

## 5. Pass/fail matrix (`tests/sql/tenant-isolation-matrix.test.sql`)

`denied` = refused with 42501, P0002, 0A000, 22023 or P0001, 0 rows affected or visible, or the anonymous role refused outright with 42501. `rows:n` = rows visible or affected.

| # | Phase | Area | Access path | Actor | Expected | Before 111 | After 111 |
|---|---|---|---|---|---|---|---|
| 1 | OFF | tickets | direct lookup TA1 (company A) | AD | `rows:1` | `rows:1` PASS | `rows:1` PASS |
| 2 | OFF | tickets | direct lookup TB1 (company B) | SUP | `rows:1` | `rows:1` PASS | `rows:1` PASS |
| 3 | OFF | replies | replies on TA1 | AD | `rows:2` | `rows:2` PASS | `rows:2` PASS |
| 4 | OFF | storage | ticket files of TA1 | AD | `rows:2` | `rows:2` PASS | `rows:2` PASS |
| 5 | OFF | mcp | mcp_admin_update_ticket TA1 (priority unchanged) | svc:AD | `ok` | `ok` PASS | `ok` PASS |
| 6 | OFF | workflow | wf_update_ticket_status TA1 | svc | `ok` | `ok` PASS | `ok` PASS |
| 7 | ON | tickets | list: company-scope tickets visible | AD | `rows:0` | `rows:0` PASS | `rows:0` PASS |
| 8 | ON | tickets | list: company-scope tickets visible | SUP | `rows:0` | `rows:0` PASS | `rows:0` PASS |
| 9 | ON | tickets | list: company-scope tickets visible | EA | `rows:0` | `rows:0` PASS | `rows:0` PASS |
| 10 | ON | tickets | list: company A tickets (positive) | OA | `rows:2` | `rows:2` PASS | `rows:2` PASS |
| 11 | ON | tickets | list: company A tickets | OB | `rows:0` | `rows:0` PASS | `rows:0` PASS |
| 12 | ON | tickets | list: company A tickets | BS | `rows:0` | `rows:0` PASS | `rows:0` PASS |
| 13 | ON | tickets | list: company B tickets | AS | `rows:0` | `rows:0` PASS | `rows:0` PASS |
| 14 | ON | tickets | list: company A tickets (positive) | AS | `rows:2` | `rows:2` PASS | `rows:2` PASS |
| 15 | ON | tickets | direct lookup TA1 | AD | `rows:0` | `rows:0` PASS | `rows:0` PASS |
| 16 | ON | tickets | direct lookup TA1 | OB | `rows:0` | `rows:0` PASS | `rows:0` PASS |
| 17 | ON | tickets | direct lookup TA1 | B1 | `rows:0` | `rows:0` PASS | `rows:0` PASS |
| 18 | ON | tickets | direct lookup TB1 | A1 | `rows:0` | `rows:0` PASS | `rows:0` PASS |
| 19 | ON | tickets | direct lookup TA1 (own, positive) | A1 | `rows:1` | `rows:1` PASS | `rows:1` PASS |
| 20 | ON | replies | read replies on TA1 | AD | `rows:0` | `rows:0` PASS | `rows:0` PASS |
| 21 | ON | replies | read replies on TA1 | OB | `rows:0` | `rows:0` PASS | `rows:0` PASS |
| 22 | ON | replies | read public reply on TA1 (positive) | OA | `rows:1` | `rows:1` PASS | `rows:1` PASS |
| 23 | ON | replies | insert reply into TA1 | OB | `denied` | `denied` PASS | `denied` PASS |
| 24 | ON | replies | insert reply into TA1 | AD | `denied` | `denied` PASS | `denied` PASS |
| 25 | ON | replies | insert reply into TA1 | B1 | `denied` | `denied` PASS | `denied` PASS |
| 26 | ON | tickets | update TA1 priority | AD | `denied` | `denied` PASS | `denied` PASS |
| 27 | ON | tickets | update TA1 priority | BS | `denied` | `denied` PASS | `denied` PASS |
| 28 | ON | tickets | update TA1 company_id to B | OA | `denied` | `denied` PASS | `denied` PASS |
| 29 | ON | tickets | delete TA1 | AD | `denied` | `denied` PASS | `denied` PASS |
| 30 | ON | tickets | insert ticket scoped to company A | B1 | `denied` | `denied` PASS | `denied` PASS |
| 31 | ON | tickets | company_ticket_set_status TA1 | BS | `denied` | `denied` PASS | `denied` PASS |
| 32 | ON | tickets | company_ticket_assign TA1 to BS | BS | `denied` | `denied` PASS | `denied` PASS |
| 33 | ON | tickets | company_ticket_set_status TA1 (positive) | AS | `ok` | `ok` PASS | `ok` PASS |
| 34 | ON | tickets | company_tickets_list contains TA1 | BS | `false` | `false` PASS | `false` PASS |
| 35 | ON | tickets | company_tickets_list contains TA1 (positive) | AS | `true` | `true` PASS | `true` PASS |
| 36 | ON | conversations | thread of A conversation (positive) | OA | `ok` | `ok` PASS | `ok` PASS |
| 37 | ON | conversations | thread of A conversation | OB | `denied` | `denied` PASS | `denied` PASS |
| 38 | ON | conversations | thread of A conversation | BS | `denied` | `denied` PASS | `denied` PASS |
| 39 | ON | conversations | thread of A conversation | B1 | `denied` | `denied` PASS | `denied` PASS |
| 40 | ON | conversations | thread of A conversation | AD | `denied` | `denied` PASS | `denied` PASS |
| 41 | ON | conversations | thread of A conversation | EA | `denied` | `denied` PASS | `denied` PASS |
| 42 | ON | conversations | post into A conversation | OB | `denied` | `denied` PASS | `denied` PASS |
| 43 | ON | conversations | post into A conversation | AD | `denied` | `denied` PASS | `denied` PASS |
| 44 | ON | conversations | set status of A conversation | BS | `denied` | `denied` PASS | `denied` PASS |
| 45 | ON | conversations | assign A conversation to BS | OB | `denied` | `denied` PASS | `denied` PASS |
| 46 | ON | conversations | inbox list contains A conversation | OB | `false` | `false` PASS | `false` PASS |
| 47 | ON | conversations | inbox list contains A conversation (positive) | OA | `true` | `true` PASS | `true` PASS |
| 48 | ON | conversations | direct table read of conversations | OB | `rows:0` | `rows:0` PASS | `rows:0` PASS |
| 49 | ON | conversations | direct table read of conversations | AD | `rows:0` | `rows:0` PASS | `rows:0` PASS |
| 50 | ON | storage | ticket files of TA1 | AD | `rows:0` | `rows:0` PASS | `rows:0` PASS |
| 51 | ON | storage | ticket files of TA1 | OB | `rows:0` | `rows:0` PASS | `rows:0` PASS |
| 52 | ON | storage | public ticket file of TA1 (positive) | OA | `rows:1` | `rows:1` PASS | `rows:1` PASS |
| 53 | ON | storage | upload into own folder naming TA1 | OB | `denied` | `denied` PASS | `denied` PASS |
| 54 | ON | storage | upload into own folder naming TA1 | AD | `denied` | `denied` PASS | `denied` PASS |
| 55 | ON | storage | ticket_attachments rows of TA1 | AD | `rows:0` | `rows:0` PASS | `rows:0` PASS |
| 56 | ON | storage | company-documents bucket read | OB | `rows:0` | `rows:0` PASS | `rows:0` PASS |
| 57 | ON | storage | company-documents bucket upload | OB | `denied` | `denied` PASS | `denied` PASS |
| 58 | ON | storage | company_documents table read | OB | `rows:0` | `rows:0` PASS | `rows:0` PASS |
| 59 | ON | storage | company_documents table read | AD | `rows:0` | `rows:0` PASS | `rows:0` PASS |
| 60 | ON | notifications | staff notified of new company ticket | AD/SUP/EA/OW | `rows:0` | `rows:0` PASS | `rows:0` PASS |
| 61 | ON | notifications | read notifications of company A owner | OB | `rows:0` | `rows:0` PASS | `rows:0` PASS |
| 62 | ON | notifications | read notifications of company A owner | AS | `rows:0` | `rows:0` PASS | `rows:0` PASS |
| 63 | ON | notifications | insert notification for company A owner | OB | `denied` | `denied` PASS | `denied` PASS |
| 64 | OFF | notifications | staff notified of new company ticket (control) | AD/SUP/EA/OW | `notified` | `notified` PASS | `notified` PASS |
| 65 | ON | dashboard | get_my_company_dashboard company id (positive) | OA | `ca000000-0000-4000-8000-00000000000a` | `ca000000-0000-4000-8000-00000000000a` PASS | `ca000000-0000-4000-8000-00000000000a` PASS |
| 66 | ON | dashboard | get_my_company_dashboard company id | OB | `cb000000-0000-4000-8000-00000000000b` | `cb000000-0000-4000-8000-00000000000b` PASS | `cb000000-0000-4000-8000-00000000000b` PASS |
| 67 | ON | dashboard | get_my_company_dashboard company id | BS | `cb000000-0000-4000-8000-00000000000b` | `cb000000-0000-4000-8000-00000000000b` PASS | `cb000000-0000-4000-8000-00000000000b` PASS |
| 68 | ON | dashboard | get_my_company_dashboard | AD | `null` | `null` PASS | `null` PASS |
| 69 | ON | dashboard | get_my_company_dashboard | B1 | `null` | `null` PASS | `null` PASS |
| 70 | ON | dashboard | dashboard mentions company A | OB | `false` | `false` PASS | `false` PASS |
| 71 | ON | dashboard | companies row of A | OB | `rows:0` | `rows:0` PASS | `rows:0` PASS |
| 72 | ON | dashboard | company_memberships of A | BS | `rows:0` | `rows:0` PASS | `rows:0` PASS |
| 73 | ON | dashboard | company_access_log of A | OB | `false` | `false` PASS | `false` PASS |
| 74 | ON | continuity | attach mad3oom_ticket source (TA1) | AD | `denied` | `denied` PASS | `denied` PASS |
| 75 | ON | continuity | rows referencing a ticket | superuser | `rows:0` | `rows:0` PASS | `rows:0` PASS |
| 76 | ON | mcp | mcp_ticket_tenancy team companies | svc:AD | `[]` | `[]` PASS | `[]` PASS |
| 77 | ON | mcp | mcp_ticket_tenancy team companies (positive) | svc:AS | `["ca000000-0000-4000-8000-00000000000a"]` | `["ca000000-0000-4000-8000-00000000000a"]` PASS | `["ca000000-0000-4000-8000-00000000000a"]` PASS |
| 78 | ON | mcp | mcp_ticket_tenancy team companies | svc:BS | `["cb000000-0000-4000-8000-00000000000b"]` | `["cb000000-0000-4000-8000-00000000000b"]` PASS | `["cb000000-0000-4000-8000-00000000000b"]` PASS |
| 79 | ON | mcp | mcp_ticket_tenancy isolation flag | svc | `true` | `true` PASS | `true` PASS |
| 80 | ON | mcp | mcp_ticket_tenancy callable by user JWT | AD | `denied` | `denied` PASS | `denied` PASS |
| 81 | ON | mcp | mcp_admin_update_ticket TA1 | svc:AD | `denied` | `denied` PASS | `denied` PASS |
| 82 | ON | mcp | mcp_admin_update_ticket TA1S (support scope, positive) | svc:AD | `ok` | `ok` PASS | `ok` PASS |
| 83 | ON | workflow | wf_update_ticket_status TA1 | svc | `denied` | `denied` PASS | `denied` PASS |
| 84 | ON | workflow | wf_assign_ticket TA1 to AD | svc | `denied` | `denied` PASS | `denied` PASS |
| 85 | ON | workflow | wf_update_ticket_status callable by user JWT | AD | `denied` | `denied` PASS | `denied` PASS |
| 86 | ON | staff-rpc | ticket_invoice_status TA1 (same as no invoice) | AD | `none` | — | `none` PASS |
| 87 | ON | staff-rpc | ticket_invoice_status TA1S support ticket (positive) | AD | `ready` | — | `ready` PASS |
| 88 | ON | staff-rpc | accounting_invoices row of TA1S (positive) | AD | `rows:1` | — | `rows:1` PASS |
| 89 | ON | staff-rpc | own invoice row of TA1 (customer, positive) | A1 | `rows:1` | — | `rows:1` PASS |
| 90 | ON | staff-rpc | ticket_invoice_document TA1 | AD | `denied` | `ok` **FAIL** | `denied` PASS |
| 91 | ON | staff-rpc | attach_accounting_invoice TA1 | AD | `denied` | `ok` **FAIL** | `denied` PASS |
| 92 | ON | staff-rpc | accounting_invoices row of TA1 | AD | `rows:0` | `rows:1` **FAIL** | `rows:0` PASS |
| 93 | ON | billing | request_subscription_purchase linked to own company ticket TA1 | A1 | `denied` | `ok` **FAIL** | `denied` PASS |
| 94 | ON | billing | request_subscription_upgrade linked to company A ticket TA1 | OB | `denied` | `ok` **FAIL** | `denied` PASS |
| 95 | ON | billing | subscriptions referencing TA1 after the attempts | superuser | `rows:0` | `rows:2` **FAIL** | `rows:0` PASS |
| 96 | ON | integrations | ihub_ticket_context TA1 | OB | `denied` | `denied` PASS | `denied` PASS |
| 97 | ON | integrations | ihub_ticket_context TA1 | AD | `denied` | `denied` PASS | `denied` PASS |
| 98 | ON | integrations | ihub_authorize_ticket_link TA1 | OB | `denied` | `denied` PASS | `denied` PASS |
| 99 | ON | grants | granted_ticket_view random grant + TA1 | SUP | `denied` | `denied` PASS | `denied` PASS |
| 100 | ON | grants | granted_company_tickets random grant | AD | `denied` | `denied` PASS | `denied` PASS |
| 101 | ON | grants | request_data_access while grants OFF | SUP | `denied` | `denied` PASS | `denied` PASS |
| 102 | ON | grants | historical_ticket_view random request + TA1 | OB | `denied` | `denied` PASS | `denied` PASS |
| 103 | ON | grants | data_access_grants table read | SUP | `rows:0` | `rows:0` PASS | `rows:0` PASS |
| 104 | ON | api-tokens | rewrite secret_hash of company owner token | AD | `denied` | `denied` PASS | `denied` PASS |
| 105 | ON | api-tokens | reassign company owner token to self | EA | `denied` | `denied` PASS | `denied` PASS |
| 106 | ON | api-tokens | read company A owner token | OB | `rows:0` | `rows:0` PASS | `rows:0` PASS |
| 107 | ON | anonymous | tickets | anon | `denied` | `denied` PASS | `denied` PASS |
| 108 | ON | anonymous | ticket_replies | anon | `denied` | `denied` PASS | `denied` PASS |
| 109 | ON | anonymous | notifications | anon | `denied` | `denied` PASS | `denied` PASS |
| 110 | ON | anonymous | ticket files | anon | `denied` | `denied` PASS | `denied` PASS |
| 111 | ON | anonymous | get_my_company_dashboard | anon | `denied` | `denied` PASS | `denied` PASS |
| 112 | ON | anonymous | company_conversation_thread | anon | `denied` | `denied` PASS | `denied` PASS |

The seventh pre-111 failure was `ticket_invoice_status TA1` returning `ready`. After 111 it is split into row 86 (same response as "no invoice") and positive row 87 (`ready` on support ticket TA1S).

## 6. Coverage against the requested access paths

| # | Requested | Implemented as | Result |
|---|---|---|---|
| 1 | Ticket list, direct lookup, replies, updates, status | RLS reads and writes, `company_tickets_list`, `company_ticket_set_status` / `_assign` | PASS (rows 1–3, 7–35); phase1-readiness ③ also pins exact per-actor counts |
| 2 | Conversations and messages | 102 RPCs (`company_conversation_*`, `company_inbox_list`) and direct table reads | PASS (rows 36–49) |
| 3 | Attachments and storage | `ticket_attachments`; `storage.objects` read and upload for the `tickets` bucket (paths that name another company's ticket); the `company-documents` bucket and table | PASS (rows 4, 50–59) |
| 4 | Notifications | the 097 side-channel gates on staff notifications for a new company ticket (with an OFF control), cross-user reads and inserts | PASS (rows 60–64) |
| 5 | Company dashboard and company RPCs | `get_my_company_dashboard`, `companies`, `company_memberships`, `company_access_log` | PASS (rows 65–73) |
| 6 | Continuity | ticket sources not implemented (0A000); staff workspace is Mad3oom-helpdesk only | PASS / **absent** (rows 74–75) |
| 7 | MCP and service-role operations | `mcp_ticket_tenancy`, `mcp_admin_update_ticket`, `wf_update_ticket_status`, `wf_assign_ticket`; MCP filter in Node | PASS (rows 5–6, 76–85, plus 7 Node tests) |
| 8 | SIE/chat | source review at deployed versions (F2); writer used only for the caller's own session; scope stamped from the ticket owner | PASS by review; **not executed** (no Edge runtime) |
| 9 | Direct PostgREST and RPC bypassing the UI | every case runs as `authenticated` (or `anon` / `service_role`) against tables and RPCs directly, the same role and claims PostgREST sets | PASS |
| 10 | ID substitution | another company's ticket, conversation, grant, request or token id in every call | PASS (incl. rows 86–106) |
| 11 | Owners, employees, customers, platform admins, anonymous | OA/OB, AS/AG/BS, A1/B1, EA/AD/SUP, `anon` | PASS (rows 107–112 anonymous) |

## 7. Not tested, and why

- **HTTP layer:** PostgREST, the Storage API and the Edge gateway (JWT verification, signed URLs) were not exercised over HTTP. No staging project exists, and production may not be used. The database decisions they rely on were tested directly.
- **Edge Functions at runtime** (`mcp`, `wf-executor`, `sie-api`, `sie-channel-telegram`, `accounting-sync`, document and continuity functions): no Deno runtime here. They were reviewed in source at their deployed versions, and pure modules ran in Node.
- **Real company data under isolation in production:** production has 0 company-scope tickets. A live probe would prove nothing, so none was claimed.
- **`data_access_grants_enabled`:** stays OFF here. Grant flows are covered with grants ON by `phase1-readiness.test.sql` ⑥.

**What would close these gaps:** a staging project (Supabase Pro branching, or a second free project), restored from a schema-only dump of production, with the same Edge Functions deployed and these synthetic personas seeded. Then run the matrix over HTTP with real JWTs: PostgREST, the Storage API with signed URLs, MCP, and `wf-executor` with a test workflow. No production data or tokens are needed.

## 8. Recommendation

**NOT READY** for `company_isolation_enforced` until 111 is applied. With 111 applied and verified: **READY WITH LIMITATIONS** (§7), on the owner's explicit approval (Q17).

**Order:**
1. Merge this branch after review (CI green).
2. Apply `111_billing_ticket_isolation` with the release wrapper (fetch from the merge commit, then an md5 check).
3. Verify with a rolled-back probe:
   - staff `ticket_invoice_status` on a company ticket returns `none`;
   - an upgrade linked to another account's ticket returns 42501.
4. The owner enables, verifying each before the next:
   1. `company_permissions_enabled`
   2. `company_suspension_enforced`
   3. `company_isolation_enforced`
   4. `data_access_grants_enabled`, only after isolation is ON and verified.

**Rollback:**
- **Switches:** OFF in the owner panel. Isolation and permissions become one-way after the first completed transfer, carry or approved account request.
- **111:** `migrations/_rollback/111_billing_ticket_isolation.down.sql`. It refuses while isolation is ON, restores the six exact production bodies, and drops the invoice policy.

## 9. Full suites

All runs below used a throwaway local PostgreSQL 16 cluster (fresh `initdb` per SQL file), built from the production schema snapshot and the migration chain, with synthetic fixtures only. They are **local results, not production verification**.

| Suite | Command | Exit | Result |
|---|---|---|---|
| Node (full) | `npm run -s test:node` (= `node --test --test-concurrency=1 tests/*.test.mjs`) | 0 | 1299 tests: 1297 pass, 0 fail, 2 skipped |
| SQL (full) | `bash tests/run-sql-tests.sh` | 0 | 82 of 82 files executed; no `FAIL`, no `psql exited`; includes `billing-ticket-isolation` and `tenant-isolation-matrix` |
| 111 regression (final file, `843af42`) | `psql -f tests/sql/billing-ticket-isolation.test.sql` | 0 | ⓪ reproduce I1/I2, ① closed (111 applied twice), ② legitimate flows, ③ rollback refused with isolation ON, exact restore, re-apply: ALL PASS |
| Isolation matrix | `psql -f tests/sql/tenant-isolation-matrix.test.sql` | 0 | 112 of 112 cases PASS with 111 (7 FAIL without it) |
| Phase 1 readiness | `psql -f tests/sql/phase1-readiness.test.sql` | 0 | ALL PASS |
| 110 regression | `psql -f tests/sql/api-token-credentials-immutable.test.sql` | 0 | ALL PASS |
| MCP isolation (Node) | `node --test tests/mcp-ticket-isolation.test.mjs` | 0 | 7 of 7 pass |

**Not executed:** Edge runtime (no Deno), Docker-based local Supabase (no daemon), hosted staging (none exists). See §7.

**Production:** unchanged by this work. 111 is not applied, no Edge Function was deployed, and all 12 switches are OFF (`company_isolation_enforced` OFF). Production was only read: catalog fingerprint, role attributes, invoice counts, function list.
