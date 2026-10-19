# Account request execution (106) and isolation readiness (107) — design, data policy, prerequisites and release plan

> **Status:** implemented and tested on branch `claude/dazzling-hypatia-lh1o9i-transfers`, which is stacked on PR #138 (105).
> **Not applied to production.** Every switch stays OFF. No real customer was added or transferred. No Edge Function was deployed and no secret was changed.

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

This combines the production read-only audit of 2026-10-19 with the work in this PR. Production currently has 1 company, 1 linked customer with no data, 39 platform tickets, 0 company tickets, 0 company staff, and every switch OFF.

| Prerequisite | Current production state | Required action | Verification |
|---|---|---|---|
| Migrations 095–104 | Applied (head `104_company_documents_followups`) | none | `select name from supabase_migrations.schema_migrations order by version desc limit 1` |
| 105 (hierarchy, requests) | Not applied (PR #138) | Review and merge #138, then apply 105 | `ACCOUNT_HIERARCHY_105_PROD_INSTALL.md` checks |
| 106 (execution) | Not applied | Merge this PR, then apply 106 | `select position('transfer_direct_to_company' in pg_get_functiondef('public.owner_decide_account_request(uuid,boolean,text)'::regprocedure)) > 0` |
| 107 (isolation-readiness RPCs) | Not applied; the bypass exists in production today, latent while isolation is off | Apply 107 **before** enabling isolation | `select count(*) from pg_proc where proname in ('ticket_in_my_scope','can_access_ticket') and prosrc ~ '_ticket_id_visible'` → 2 |
| 097 policies and ticket stamps | Present: 6 `tenant_isolation` policies and storage `ticket_files_isolation`; 39/39 tickets stamped | none | `select scope, count(*) from tickets group by 1` |
| MCP Edge Function | **Deployed v34 is older than 097**: no `mcp_ticket_tenancy`, and subscription tickets are inserted without `category: 'subscription'` | Deploy `supabase/functions/mcp` from this branch's merge commit (it includes 097 and the 107 subscription fix) — **separate approval** | `get_edge_function mcp` contains `_shared/ticket-isolation.js` and `_shared/subscription-access.js`. Also `select count(*) from tickets t join whatsapp_subscriptions s on s.ticket_id = t.id where t.scope = 'company'` → 0 |
| `create-sub-user` Edge Function | Deployed version has no `company_created` flag (105 fallback covers it) | Redeploy with 105 — **separate approval** | Create a test sub-user; it gets no `platform_direct_customers` row |
| Other service-role functions | Audit: `sie-api`, `integrations-api`, `whatsapp-webhook`, `register-whatsapp`, `gemini-proxy`, `chat-bot-reply` and `wf-executor` are safe. The external SIE runtime was not reviewed | Optional: review the SIE runtime | — |
| Frontend 097/098/105/106 files | Not verified (hosting is outside Supabase) | Deploy from the merge commits | Load the company dashboard and the admin pages |
| `company_permissions_enabled` (098) | OFF; no blockers (ledger 39 = tickets, 0 reconciliation mismatches, 0 staff) | Enable **first**, owner step-up and reason | `select enabled from platform_feature_switches where key = 'company_permissions_enabled'` |
| `company_isolation_enforced` (097) | OFF; blocked until 107 + MCP deploy | Enable after 107 and the MCP deploy. **One-way** after the first approved request, transfer or carry | `select _isolation_on()` |
| `account_request_execution_enabled` (105/106) | Does not exist yet (created by 105, OFF) | Enable last, after a dry-run review | `select _account_request_execution('transfer_direct_to_company', null)` → `available: true` |
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
