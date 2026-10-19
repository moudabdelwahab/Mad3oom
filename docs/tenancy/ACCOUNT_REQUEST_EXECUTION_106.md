# Account request execution (106) and isolation readiness (107) — design, data policy, prerequisites and release plan

> **Status:** implemented and tested; merged to `main` through PR #139, with the MCP follow-up fix in PR #141 (merge commit `3aab6fe`).
> **Applied to production on 2026-10-19** (105 → 106 → 107); see §6 "Applied". Every switch stays OFF. No real customer was added or transferred. No Edge Function was deployed and no secret was changed.

## 1. What now works end to end

| Step | Add a customer to a company | Transfer a direct platform customer to a company |
|---|---|---|
| Who submits | A platform admin (role `admin`) from «إدارة العملاء» → customer drawer | same |
| Inputs | Type, the customer's stable ID (taken from the drawer, not typed), the customer's email for verification, the destination company and a mandatory reason. The requester and submission time are set on the server | same |
| Eligibility at submit | The 105 checks, plus: no active or pending personal subscription if the customer would become the company's **primary** member | The 105 checks, plus: the customer is a **pure direct** customer (no company at all), and has no active or pending personal subscription |
| Owner review | «طلبات الحسابات» shows identity, current relationship, destination company and its contact email, reason, a per-data-category impact summary, live checks and execution availability | same |
| Decision | Platform owner only, with a fresh step-up, never on their own request. Rejecting needs a reason (≥ 10 characters) | same |
| On approval (one transaction) | A 096 membership (primary if the customer has none, otherwise secondary), the `joined` event, and the `super_user_id` mirror if primary. **The direct relationship is kept** | A primary 096 membership, the `transferred_in` event and the mirror. **The direct relationship ends** (`end_cause = transferred`), and so does **the platform account-manager assignment** (history kept) |
| Result | `approved` + `outcome` (membership, primary, what ended) + `privileged_audit` + generic notifications (requester, customer, previous manager) | same (audit action `account_request.transferred`) |
| On any failure | Everything is rolled back (savepoint). The failure is recorded on the request (`attempts`, `last_failure`), audited and notified generically. The request **stays pending** and can be retried or rejected | same |

The customer keeps **the same account**: no new `auth.users` row, no second profile, and the same login. In every case the customer stays a customer. They never become an employee or administrator: there is no `company_staff` row, `company_staff_role()` is null, and `_company_staff_role_of` is null. Migration 035 sets the role to `company_user` because `super_user_id` now points to the company owner. That role means "follows a company"; staff rights come only from `company_staff`.

## 2. Data-access rules per category (after execution, with company isolation ON)

| Category | Rule | Enforced by | Tested |
|---|---|---|---|
| Platform relationship | Transfer: ended, history kept. Add: kept | 106 `owner_decide_account_request` | 106 ② ③ |
| Company membership | One active membership per (company, customer); primary or secondary as described above | 096 unique indexes + guard | 106 ② ③ ⑨ ⑩ |
| `profiles.super_user_id` | Mirror of the primary membership, written only by `_membership_apply_mirror` | 096 | 106 ② ③ |
| Legacy paths via `super_user_id` | `tickets_select_policy` / `supervises()` are overridden by the 097 restrictive `tenant_isolation`. The SECURITY DEFINER `ticket_in_my_scope` / `can_access_ticket` respect isolation since **107**. MCP tickets use `mcp_ticket_tenancy` (repo), and MCP subscriptions are owner/admin only since **107** | 097, 107, MCP | 107 ⓪–③, `tests/mcp-ticket-isolation.test.mjs` |
| Earlier tickets, replies, attachments, activity, ratings, tags, ticket files | **Stay private.** They keep `scope = mad3oom_support` (stamped at creation, immutable). The customer and platform staff still see them; the company does not. Access is only through 101 `historical_access` (customer consent + owner) | 097 | 106 ② ③ |
| Ticket assignments and history | Unchanged. Platform agents keep handling the old tickets | 097 scope | 106 ③ |
| New tickets after execution | Belong to the company (`scope = company`, `company_id` = destination) | 097 stamp | 106 ③ |
| Chats (`chat_sessions`, `chat_messages`, `chat-attachments`) | Unchanged and private: own rows plus platform staff; there is no `super_user_id` path | existing RLS (audit 2026-10-19) | audit |
| Company conversations (102) | New company-scoped tables; nothing historical is copied | 102 | — |
| Notifications | Unchanged; own only | existing RLS | 106 ③ (count) |
| Subscriptions, wallet, points | **Stay with the customer** (no move, no cancellation). Becoming a primary member moves the ticket quota to the company plan (`ticket_account_owner`), so an active personal subscription, or **any** pending one, **blocks** execution instead of breaking silently. Approval locks the customer's `auth.users` row, so a purchase cannot slip in between the check and the execution. A personal subscription bought **after** joining follows the existing company-customer rule: the quota is shared with the company (`ticket_quota_status.shared_account = true`) | 106 check `no_active_personal_subscription`, lock on `auth.users` | 106 ④ ⑦ ⑩ب |
| Ticket quota history | Only tickets created **after** the customer's primary-membership `joined_at` count against the company. Earlier personal tickets are neither counted nor revealed through the company's `used` / `billing_used`, which matches what the 098 ledger recorded at creation | 106 `ticket_quota_status` (one condition changed; the rollback restores production text) | 106 ③ |
| Account gate (042) | The customer must pass the account gate (whitelist + verification) **before** execution. The execution makes the role `company_user`, which the waitlist lets through, so a request cannot be used to bypass a rejected waitlist entry | 106 check `customer_gate_ok` | 106 ⑦ |
| API tokens, personal integrations | Unchanged (owner-only since 095) | 095 | 106 ① (the execution writes no such table) |
| External integration links (088) | None are created; a company may link later through its own flow | 088 | — |
| Platform account manager | Transfer: ended (`transferred`), history kept, previous manager notified generically. Add: unchanged | 106 | 106 ③ |
| Audit | `privileged_audit` (`account_request.approved` / `.transferred` / `.execution_failed`), 096 membership events, request `outcome` / `last_failure`. Nothing is deleted | 053, 096, 105, 106 | 106 ③ ⑧ |
| Legal retention | No record is deleted or rewritten by execution. Finalized requests are immutable (105 guard) | 105 | 105 ⑦ |

**Reverse transfer** (company customer → direct platform customer) is **not implemented** and has no policy yet. A customer can leave a company through 096 (`leave_company`), which leaves the account `unclassified` (no explicit relationship). Re-establishing a direct relationship needs a documented business rule first.

## 2b. Independent security review (2026-10-19) and how each finding was resolved

There were no CRITICAL or HIGH findings.

| Finding | Resolution |
|---|---|
| M1: a transfer could admit a waitlist-gated account | Fixed: `customer_gate_ok` at submit and at approval; `customer_now.gate_ok` shown to the owner |
| M2: the customer's earlier personal tickets counted against, and were revealed to, the company | Fixed: `ticket_quota_status` counts a follower's tickets from `joined_at` only |
| M3: a stale pending subscription was not detected; a purchase could race the approval | Fixed: every `pending` row blocks; approval locks `auth.users` (two-session test). Purchases after joining follow the existing shared-quota rule (documented) |
| M4a: MCP isolation failed **open** on an RPC error | Fixed: `tenancyFromRpc` fails closed (non-admins see their own tickets only) |
| M4b: the database cannot verify the MCP deploy order | Release checklist: `account_request_execution_enabled` is enabled **last**, after the MCP redeploy and the isolation checks (§4 steps 4 → 7 → 8). A database switch cannot prove a deployment; this is a human attestation, like the switch itself |
| L4: requester conflict of interest | Fixed: `requester_not_destination_party` |
| L1: MCP `send_notification` lets a company owner write to its customers | Pre-existing MCP feature, write-only, same-origin links only. Follow-up: limit it to row owner or admin |
| L2: MCP `get_customer` returns more columns than `company_customers_list` | Pre-existing. Follow-up: align the column set |
| L3: `evaluate_customer_badges(uuid)` counts any user's tickets without isolation | Pre-existing, outside 097/106. Follow-up: restrict to self or staff |
| INFO: failure notifications are not rate-limited | Only the owner with step-up can trigger them; accepted |

## 3. Prerequisite matrix

This combines the production read-only audit of 2026-10-19 with the work in this PR. The rows for the migrations, the MCP deploy and `account_request_execution_enabled` were updated after the apply in §6; the other rows are kept as audited before it. Production currently has 1 company, 1 linked customer with no data, 39 platform tickets, 0 company tickets, 0 company staff, and every switch OFF.

| Prerequisite | Current production state | Required action | Verification |
|---|---|---|---|
| Migrations 095–104 | Applied | none | `select name from supabase_migrations.schema_migrations order by version desc limit 1` |
| 105 (hierarchy, requests) | Applied 2026-10-19 (§6) | none | `ACCOUNT_HIERARCHY_105_PROD_INSTALL.md` checks |
| 106 (execution) | Applied 2026-10-19 (§6) | none | `select position('transfer_direct_to_company' in pg_get_functiondef('public.owner_decide_account_request(uuid,boolean,text)'::regprocedure)) > 0` |
| 107 (isolation-readiness RPCs) | Applied 2026-10-19 (§6); the definer bypass is closed in the database | none | `select count(*) from pg_proc where proname in ('ticket_in_my_scope','can_access_ticket') and prosrc ~ '_ticket_id_visible'` → 2 |
| 097 policies and ticket stamps | Present: 6 `tenant_isolation` policies and storage `ticket_files_isolation`; 39/39 tickets stamped | none | `select scope, count(*) from tickets group by 1` |
| MCP Edge Function | **Deployed v34 is older than 097** (still v34 after the 105–107 apply): no `mcp_ticket_tenancy`, and subscription tickets are inserted without `category: 'subscription'` | Deploy `supabase/functions/mcp` from `3aab6fe` or later (it includes 097, the 107 subscription fix and the PR #141 fail-closed fix) — **separate approval** | `get_edge_function mcp` contains `_shared/ticket-isolation.js` and `_shared/subscription-access.js`. Also `select count(*) from tickets t join whatsapp_subscriptions s on s.ticket_id = t.id where t.scope = 'company'` → 0 |
| `create-sub-user` Edge Function | Deployed version has no `company_created` flag (105 fallback covers it) | Redeploy with 105 — **separate approval** | Create a test sub-user; it gets no `platform_direct_customers` row |
| Other service-role functions | Audit: `sie-api`, `integrations-api`, `whatsapp-webhook`, `register-whatsapp`, `gemini-proxy`, `chat-bot-reply` and `wf-executor` are safe. The external SIE runtime was not reviewed | Optional: review the SIE runtime | — |
| Frontend 097/098/105/106 files | Not verified (hosting is outside Supabase) | Deploy from the merge commits | Load the company dashboard and the admin pages |
| `company_permissions_enabled` (098) | OFF; no blockers (ledger 39 = tickets, 0 reconciliation mismatches, 0 staff) | Enable **first**, owner step-up and reason | `select enabled from platform_feature_switches where key = 'company_permissions_enabled'` |
| `company_isolation_enforced` (097) | OFF; blocked until 107 + MCP deploy | Enable after 107 and the MCP deploy. **One-way** after the first approved request, transfer or carry | `select _isolation_on()` |
| `account_request_execution_enabled` (105/106) | Exists since the 105 apply; OFF | Enable last, after a dry-run review | `select _account_request_execution('transfer_direct_to_company', null)` → `available: true` |
| Customer-consent decision | Open (105 §8.1) | Decide: owner approval executes (implemented), or the approval sends a 096 invitation | — |
| Designated test accounts | None | Create one test company and one test direct customer, both clearly named | see §4 |

## 4. Release checklist (each step needs its own explicit approval)

1. **Review and merge** PR #138 (105), then this PR (106/107). CI green on each merge commit.
2. **Backup / PITR checkpoint** recorded before any migration.
3. **Apply migrations** one at a time with the release wrapper (fetch at the merge commit, check md5, execute), in this order:
   1. `105_account_hierarchy_customers`, then its install-note checks;
   2. `106_account_request_execution`, then its check above;
   3. `107_isolation_readiness`, then its check above.

   All switches must still be OFF afterwards: `select count(*) from platform_feature_switches where enabled` → 0.
4. **Deploy Edge Functions** from the merge commit: `mcp` (with 097 and 107) and `create-sub-user` (105). Then run the verification queries above.
5. **Deploy the frontend** from the merge commit. Smoke-check `admin/customers.html` and `admin/account-requests.html`; their banners should read «التنفيذ غير متاح بعد» with the missing switches listed.
6. **Enable `company_permissions_enabled`**: owner step-up and reason. Check that the company dashboard still works for the company owner.
7. **Enable `company_isolation_enforced`**: owner step-up and reason. Check:
   - the company owner no longer sees platform tickets of followers;
   - `ticket_in_my_scope` refuses them;
   - platform staff still see the 39 platform tickets;
   - MCP list/get for a company token returns company-scope tickets only.

   Isolation stays reversible until the first approved request, transfer or carry. Hold it there for an observation period.
8. **Controlled test with designated test accounts only:**
   1. create «شركة اختبار» and a direct test customer with no subscription;
   2. enable `account_request_execution_enabled`;
   3. a platform admin submits a **transfer** request; the owner reviews the impact and approves;
   4. verify the request is `approved`, the outcome is correct, the direct relationship and platform manager have ended, the customer is a company customer, the test company's dashboard lists the customer, and the customer's earlier test ticket is not visible to the company;
   5. repeat with an **add** request.
9. **Monitor** `privileged_audit` (`account_request.%`), requests with `last_failure`, and `membership_mirror_drift()` = 0.
10. **Rollback.** Before any real execution, the order is 107 → 106 → 105, each refusing while its switches or history exist. After real executions, the history stays and the rollbacks refuse by design; corrections are forward migrations.

## 5. Tests

- `tests/sql/account-request-execution.test.sql` (106): sections ①–⑫. It covers:
  - rollback byte-for-byte;
  - add: membership, kept direct relationship, not an employee, single identity, the company sees the customer but not their history, the customer sees the company;
  - transfer: ends the direct relationship and the manager assignment, same identity, private tickets/replies/attachments, platform staff keep the old ticket, quota goes to the company, new tickets go to the company, notifications are kept, audit and outcome;
  - subscription block, at submit and at approval;
  - switches off (failure recorded);
  - unauthorized users, no step-up, self-approval;
  - suspended company at approval and at submit, email mismatch, non-direct and staff accounts;
  - injected failure, nothing changed, then a successful retry;
  - replay refused;
  - two-session concurrent approval;
  - the requester sees the recoverable failure and the real outcome;
  - generic notifications;
  - rollback refused with history.
- `tests/sql/isolation-readiness.test.sql` (107): ⓪ reproduces the bypass before 107; ① rollback byte-for-byte; ② isolation off is unchanged; ③ isolation on: no close, reopen or existence oracle through `super_user_id`, company tickets work, the customer closes their own, platform staff follow 097, another company is refused; ④ rollback refused while isolation is on.
- `tests/mcp-ticket-isolation.test.mjs`: MCP subscriptions are visible to the owner of the row or an admin only, and have no `super_user_id` path.
- `tests/account-hierarchy.render.test.mjs`: server-driven impact, the failed-recoverable badge and retry, success text only from the server's confirmed outcome, and the requester's view of failure and outcome.

## 6. Applied (2026-10-19, project `srnelrdpqkcntbgudyto`)

Release checklist steps 1 (merge) and 3 (migrations) are done. Step 2 (backup checkpoint) was **not** done; see "Recovery" below. Steps 4–10 are not done.

Before the apply (read-only, about 22:19 UTC):
- The ledger head was `104_company_documents_followups` (377 rows), with 0 switches on and `_isolation_on()` = false.
- 0 of the 2 ticket functions contained `_ticket_id_visible`.
- The three pinned files, fetched from inside production with `public.http_get`, returned HTTP 200 with the md5 values below.
- Unlike 103/104, no rolled-back dry run was run on production for this apply.

Each migration was its own `apply_migration` call through the release wrapper (fetch at the pinned commit, check md5, execute), pinned to merge commit `3aab6fe54988196a7c7e75b9189f1003fbed02b5`. Each file's md5 was the same at the reviewed commit, on `main`, and as fetched from production:

| Migration | md5 | Ledger version | Result |
|---|---|---|---|
| `105_account_hierarchy_customers` | `d258b10840542011b0d42e164d8ef6cf` | `20261019221945` | `{"success":true}` |
| `106_account_request_execution` | `aa996941a8711d2496ba57226b350e7e` | `20261019222050` | `{"success":true}` |
| `107_isolation_readiness` | `6aedbf20eb5d5a2e27a113679491c157` | `20261019222122` | `{"success":true}` |

Each migration's self-check ran as part of its apply.

### Checks after each apply (production queries)

| Migration | Checks after apply |
|---|---|
| `105_account_hierarchy_customers` | ledger head 105; the `ACCOUNT_HIERARCHY_105_PROD_INSTALL.md` checks all pass: `account_request_execution_enabled` false; 33 `platform_direct_customers` rows (the backfill); 0 `customer_account_managers`; 0 `account_requests`; 6 triggers; `authenticated` cannot select `account_requests`; `anon` cannot execute `admin_customer_directory(jsonb)`; 0 switches on; `_isolation_on()` false |
| `106_account_request_execution` | ledger head 106; `owner_decide_account_request` contains the `transfer_direct_to_company` branch; `account_requests` has the 2 new columns `attempts` and `last_failure`; `_account_request_execution('transfer_direct_to_company', null)` = `{"available": false, "code": "prerequisite_not_enabled", "missing": ["account_request_execution_enabled", "company_isolation_enforced", "company_permissions_enabled"]}`; 0 switches on; `_isolation_on()` false. With 0 requests, no customer was added or transferred |
| `107_isolation_readiness` | ledger head 107 (380 rows); `can_access_ticket` and `ticket_in_my_scope` both contain `_ticket_id_visible`; the verification count is 2; `_isolation_on()` false; 0 switches on; 39 tickets and 33 active direct customers (unchanged) |

That both functions behave as before while isolation is off is a **test result**, not a production check: `tests/sql/isolation-readiness.test.sql` ② on the prod-shape chain. It was not re-run in production.

### Final state (re-checked read-only at 2026-10-19 22:24:41 UTC)

- **Ledger:** top entries `107_isolation_readiness`, `106_account_request_execution`, `105_account_hierarchy_customers`, `104_company_documents_followups`; 380 rows.
- **Isolation:** `_isolation_on()` = false; 2 of 2 ticket functions contain `_ticket_id_visible`.
- **Switches:** 0 enabled; `account_request_execution_enabled` = false.
- **Data:** 0 account requests, 0 account-manager assignments, 33 `platform_direct_customers` rows.
- **Edge Functions** (`list_edge_functions`): `mcp` is still **version 34** and `create-sub-user` is still **version 32**.

### Not done

- **Edge Functions:** neither `mcp` nor `create-sub-user` was deployed. The MCP fixes are therefore **not live in production**: the 097 tenancy filter, `subscription-access.js` and the fail-closed tenancy parsing from PR #141. `company_isolation_enforced` must stay off until `mcp` is redeployed (checklist step 4).
- **No secret or production configuration was changed.** No switch was enabled. Company isolation and account-request execution were not activated.
- **Customers:** no customer account was added, transferred or modified.
- **Frontend:** deploying the frontend was not part of this operation and was not verified.

### Recovery

- **No backup checkpoint:** checklist step 2 was skipped; no separate backup checkpoint was recorded before the apply.
- **Recovery reference:** the point immediately before 105 was applied, ledger version `20261019221945` (about 22:19:45 UTC on 2026-10-19). Whether point-in-time recovery is available on this project's plan was not checked.
- **Rollback scripts:** each migration has one, run in the order 107 → 106 → 105. Each refuses while its switches are on or history exists (see the install notes), so they are not a substitute for a verified backup.

### Security advisors (`get_advisors(security)`, right after the apply)

- **ERROR:** none.
- **Group totals:**
  - WARN: `function_search_path_mutable` 28, `extension_in_public` 3, `anon_security_definer_function_executable` 70, `authenticated_security_definer_function_executable` 443, `auth_leaked_password_protection` 1;
  - INFO: `rls_enabled_no_policy` 25.

  No advisor snapshot was taken just before this apply, so a per-group before/after comparison like the 103/104 record is not available.
- **WARN `function_search_path_mutable` (new): `_json_or_null` (106) and `_account_request_first_failure` (105).** Reported as minor because:
  - both are SECURITY INVOKER and `immutable`;
  - both call built-ins only (a `jsonb` cast, and `jsonb_array_elements`);
  - both have execute revoked from `public`, `anon`, `authenticated` and `service_role` in their migrations.

  **Not resolved:** no follow-up migration was created. A fix would be a forward migration that pins `search_path` on both.
- **WARN `authenticated_security_definer_function_executable`:** this group includes the 11 RPCs that 105 grants to `authenticated`:
  - `admin_customer_directory`, `admin_customer_filter_options`, `admin_customer_details`;
  - `customer_manager_assign`;
  - `account_request_submit`, `account_request_cancel`, `my_account_requests`, `account_requests_overview`;
  - `owner_account_requests`, `owner_account_request_details`, `owner_decide_account_request`.

  It also lists `can_access_ticket` and `ticket_in_my_scope`, whose bodies 107 replaced in place. This is by design: each function checks its caller itself.
- **INFO `rls_enabled_no_policy`:** none of the three new tables appears.
