# Account hierarchy, customer ownership and owner-approved account requests (105)

> **Status:** implemented on branch `claude/dazzling-hypatia-lh1o9i` as migration `105_account_hierarchy_customers` with a rollback, SQL tests, render tests and two admin pages.
> **Not applied to production.** No switch was enabled. No account was transferred, no Edge Function was deployed and no production configuration was changed.
> Install steps are in `ACCOUNT_HIERARCHY_105_PROD_INSTALL.md`. The full-transfer design is in `CUSTOMER_TRANSFER_DESIGN.md`.

## 1. Hierarchy

```
Platform Owner (role platform_owner + platform_authority.level = 'owner')
└── Platform Administration (role admin / support; elevated_admin via platform_authority)
    ├── Direct Platform Customers ............ platform_direct_customers (explicit, 105)
    └── Companies (companies; owner = companies.user_id → role company_admin)
        ├── Company Account / Owner ........... companies.user_id
        ├── Company Team ...................... company_staff (086): admin / supervisor / agent
        └── Company Customers ................. company_memberships (096), primary ⇒ super_user_id mirror
```

An account's **type** is derived from explicit relationships only, in this order (`_customer_accounts()`):

| Type | Source of truth |
|---|---|
| `platform_staff` | `profiles.role` in (`platform_owner`, `admin`, `support`). Excluded from the customer directory |
| `company_owner` | a `companies` row with `user_id` = account |
| `company_staff` | an active `company_staff` row, with the same conditions as `_company_staff_role_of` (086) |
| `company_customer` | an active `company_memberships` row in a company the account neither owns nor staffs |
| `direct` | an active `platform_direct_customers` row |
| `direct_and_company` | both of the last two |
| `unclassified` | none of the above, for example an account that left its only company. It is shown as such and never guessed |

A direct relationship is **independent** of company memberships. A direct customer who is also served by a company is `direct_and_company`. "Transfer" means ending the direct relationship, which is not available yet; "add to company" means adding a membership.

## 2. Audit (evidence from code, migrations and production on 2026-10-19, read-only)

### Production state
- 41 profiles:
  - 6 `admin`;
  - 1 `platform_owner`, who owns 1 company;
  - 33 `user` with no `super_user_id`;
  - 1 `company_user` that follows the owner's company. It has an active membership and **no** `company_staff` row, so it is a legacy sub-user and is classified as a company customer.
- `user_type` is `individual` for all 41, including the owner. It is **not reliable** and is not used.
- `ban_status` is `none` for all; `whatsapp_phone` is stored for 0 profiles and `phone` for 9.
- `platform_capability_grants`: 0. `platform_authority`: 1 owner and 2 elevated admins.
- `company_account_requests` (068): 0. `customer_transfers` (101): 0.
- Every feature switch is OFF (11 keys).

### What exists, and whether it was reused

| Area | Exists | Reused? |
|---|---|---|
| `profiles.super_user_id` | "follows company owner X". Written by `create-sub-user`, the legacy main-admin path (`check_super_user_creation`), and the 096 mirror (`_membership_apply_mirror`). Drives `supervises()`, legacy `can_access_ticket()`, and `sync_company_role` (035), which sets the role to `company_user` | **Kept as is.** 105 never writes it directly; the approval path goes through the 096 mirror. Classification does not read it alone |
| Role `company_user` | Shared by company **staff and customers** (035 derives it from `super_user_id`) | Not used to tell staff from customers. `company_staff` decides |
| `companies` | owner, `status` (`active`/`suspended`), `company_email` (contact) | Yes: destination, status check, and the contact email shown separately |
| `company_staff` (086) | the company team | Yes, for classification |
| `company_memberships` (096) | customer memberships, primary mirror, events | **Yes: approval execution inserts a membership** (`joined_via = 'account_request'`, widened check) and writes the 096 event and mirror |
| `customer_transfers` (101) | company→company transfer (source and destination admins approve, customer confirms; owner exceptional path) | **Not reused for direct→company.** Its semantics need a source company with a primary membership (`from_company not null`). Pending transfers block new account requests, and vice versa. Its guard `_guard_isolation_after_transfers` is extended |
| `company_account_requests` (068) | a **customer's own** request to become a company account, decided by `is_admin()` | **Not reused.** It is a different actor, decider and effect (it creates a company). The new table follows its patterns: one pending per account, decisions via RPC only, generic notification |
| `data_access_requests` (097) | a staff request decided by the owner with a step-up, no self-decision | The **pattern** was reused (owner step-up, `requested_by <> decider`, pending→final) |
| `historical_access_requests` (101) | a company asks, the customer agrees, then the owner decides | Not applicable |
| Account manager / representative (مندوب) | **Does not exist.** `grep` found nothing for مندوب, representative, account_manager or sales_rep in the app, and no "اسم المندوب" column exists. `admin/users.html` shows name, email, role, date and actions | New table `customer_account_managers` |
| Platform admin customer list | `admin/users.html` loads **all** profiles into the browser (`select('*')`) with no pagination | Left untouched (it is still used for ban/role/points/SIE). The new `admin/customers.html` filters on the server |
| Platform permission helpers | `is_support_user()` (role admin, or owner in a staff context) gates "read all profiles". `owner_capability()`, `owner_critical_ok()` (step-up), `has_capability()` with `platform_capability_grants` (closed list) | Directory reader = `is_support_user()` (no new readers). New capability `customers.assign_manager` in the same closed list, granted by `owner_set_capability` (owner + step-up) |
| Subscriptions | `whatsapp_subscriptions(user_id, company_id, plan, status, dates)` | Shown in the details drawer; never changed |
| Notifications | `notifications`, readable by elevated authority (040) | Reused with **generic text** only |
| Audit | `privileged_audit` (053, append-only), `company_membership_events` (096) | Details show real rows (action, actor, time; no old/new values). Manager history is its own append-only table. Nothing is reconstructed from current state |
| Navigation | the static `assets/components/sidebar.html` plus `applySidebarPermissions` | Two hidden links shown for admins; also linked from the owner governance tab |

### Uses of `super_user_id` that still assume "company = super_user_id" (unchanged, documented)
- `assets/js/admin/super-users.js`, `my-users.js`: list "sub-users" through `super_user_id`, so they miss secondary memberships. They are kept as legacy screens; `admin/customers.html` is the membership-aware replacement.
- `assets/js/company/tickets-service.js` `fetchMemberTickets`: the owner's view of follower tickets. It is already superseded by 097/098 when isolation is on.
- MCP `authz.ts` (`getVisibleUserIds`, `canAccessCustomer`) and `customers/tickets/subscriptions-service.ts`: visibility through `super_user_id`, so they miss secondary-membership customers. The behaviour is unchanged (narrower, never wider). A follow-up is listed in §8.
- `create-sub-user`: attaches through `super_user_id`, and the 096 trigger creates a `legacy` membership. A test proves it is still classified as a company customer and is not marked direct.

## 3. Database changes (105)

| Object | Purpose |
|---|---|
| `platform_direct_customers(id, user_id, since, source backfill/signup, ended_at, ended_by, end_cause)` | Explicit direct relationship. Backfill covers `role` in (`user`, `customer`), no `super_user_id`, no active membership and no company (33 in production). Trigger `trg_direct_customer_on_signup` covers each new account with no company, **except** accounts that `create-sub-user` marks with the service-only `app_metadata.company_created` flag |
| `customer_account_managers(id, customer_id, manager_id, scope 'platform', company_id null, assigned_by, assigned_at, reason, ended_*)` | One active per (customer, scope, company). `scope = 'company'` is reserved; the check widens with `company_id` when needed |
| `account_requests(id, request_type, customer_id, customer_email, target_email, company_id, reason, requested_by, requested_at, idempotency_key, snapshot, status, decided_by, decided_at, decision_reason, outcome)` | One pending per customer (unique partial index); `(requested_by, idempotency_key)` unique; `requested_by <> decided_by` enforced by a CHECK |
| `trg_customer_history_guard` | No delete. Only ending/deciding a row in place. A finalized request is immutable; material fields of a pending one are immutable |
| `trg_customer_relationships_on_profile` | On delete: end direct, manager rows and pending requests. On role/ban change: end that manager's active assignments (`manager_ineligible`, not revived on unban) and cancel that requester's pending requests (`requester_ineligible`). If the service role attaches a fresh `signup` account to a company (the pre-flag `create-sub-user` path), the direct row ends with `company_created` |
| `trg_account_requests_company_deleted` | Cancels pending requests of a deleted company |
| `_guard_isolation_after_transfers` (101, extended) | Isolation and 098 cannot be turned off after an approved request |
| `platform_capability_grants` check | + `customers.assign_manager` |
| `company_memberships.joined_via` check | + `account_request` |
| Switch `account_request_execution_enabled` | OFF. Required, with isolation and 098, to execute an approval |

**Reads that are new for platform admins** (role `admin`, or the owner in staff/admin context). These are deliberate; please review them:
- company **names and status**, including suspended companies (directory column, filter list). Admins already see company data in the 068 request list; `companies` itself is not readable by them directly.
- a customer's **company-staff role and company** (from `company_staff`, which admins cannot read directly).
- a customer's **memberships**: current and ended, primary flag, how they joined, end cause.
- a customer's **membership history** (`company_membership_events`: action, company, actor, time).
- a **pending 101 transfer** flag and count for a customer.
- **every account request** about a customer (type, status, company), including other admins' requests. «My requests» shows only your own.
- **account-manager assignments**: manager, who assigned them, reason, end cause.
- `whatsapp_subscriptions`, which admins already read (`is_admin()` policy).

Nothing else widens. `privileged_audit` rows stay owner-only, and the company contact email is shown only to the owner, in request details.

All three tables have RLS on, a restrictive `gate_account_active` policy, **no permissive policy** and no grants (`revoke all … from public, anon, authenticated, service_role`). There are no foreign keys to accounts or companies (the 086/096/101/103 convention). The self-check refuses if any RLS policy mentions the new tables.

### RPCs

| RPC | Who | Notes |
|---|---|---|
| `admin_customer_directory(p_filters jsonb)` | `is_support_user()` with an active account | Filters: `view` (all, direct, company, by_manager, pending_transfer, suspended), `q` (name, email, phone, WhatsApp, exact id; LIKE wildcards escaped), `account_type`, `company_id`, `manager_id` (uuid or `none`), `status`, `sort` (whitelist), `dir`, `limit` 1–100, `offset`. Returns `{total, rows}` with named columns only |
| `admin_customer_filter_options()` | same | companies, eligible managers, caller abilities (UI only) |
| `admin_customer_details(p_customer)` | same | Named columns (no 2FA secrets, recovery codes or telegram data), memberships, staff, owned company (name and status only), manager and history, subscriptions, requests, real history. `privileged_audit` rows appear **only for the owner**, matching its existing `privileged_audit_select_owner` policy |
| `customer_manager_assign(p_customer, p_manager, p_reason)` | owner (owner context) or `has_capability('customers.assign_manager')` | Reason ≥ 10. No self-assignment by a delegate; never for your own account; the manager must be platform staff and not banned; the customer must not be staff. Locks the customer row. Audited in `privileged_audit`; generic notification to the manager |
| `account_request_submit(type, customer, customer_email, target_email, company, reason, idempotency_key)` | role `admin`, active, not preview, **not the owner** | Changes nothing on the customer. Verifies the email, refuses ambiguity, checks conflicts, notifies owners generically, audited |
| `account_request_cancel(request, reason)` | the requester, while pending | |
| `my_account_requests(status)` | requester (still `admin`) | |
| `owner_account_requests(p_filters)` | `owner_capability('owner_only')` | status, type, requester, customer email, company, from/to, pagination |
| `owner_account_request_details(request)` | owner | Data, the company's contact email shown separately, current customer state, impact counts, **checks evaluated now**, execution availability |
| `owner_decide_account_request(request, approve, reason)` | `owner_critical_ok()` (owner + fresh step-up) | Row lock → final check → no self-decision → reject (reason ≥ 10), or approve = execute (below) |
| `account_requests_overview()` | staff or owner | The UI's abilities and execution state; grants nothing |

## 4. Account requests: lifecycle and approval safety

```
            submit (admin)                     owner reject (reason)
  ──────────────────────────► pending ───────────────────────────────► rejected  (final)
                                │  │  requester cancel (reason) ─────► cancelled (final)
                                │  └─ account/company deleted ───────► cancelled (final, system)
                                └─ owner approve = revalidate + execute atomically ─► approved (final)
                                   (refused ⇒ stays pending: 0A000 not available / 55000 revalidation)
```

- **Creating a request changes nothing:** no membership, no `super_user_id`, no email (tested).
- **Email:** `customer_email` must equal the profile email, case-insensitively. A profile email that differs from the auth email means ambiguity, and the request stops. A `target_email` is informational only: it is refused if it belongs to another account and it is never applied. **No auth email is ever changed.**
- **Approval** checks in this order:
  1. step-up;
  2. lock the request;
  3. still pending;
  4. not self;
  5. execution available;
  6. lock the customer;
  7. re-run every check: email unchanged, customer not suspended, still a customer, company exists and is active, not already a member, no pending transfer, no other pending request, **requester still an admin and not suspended**;
  8. insert the membership (primary if none, else secondary) + 096 event + mirror;
  9. (the locks: company `FOR SHARE` → customer profile → request; feature switches `FOR SHARE`, so switching isolation off at the same moment waits and is then refused by the guard — tested with two sessions)
  10. **verify the result** (an active customer membership; the mirror points to the company owner);
  11. mark approved; audit; notify.

  Any failure raises and rolls back everything, so the request stays pending (tested with an injected failure).
- **Replay and concurrency:**
  - A second decision gets `55000 request_final`.
  - Two simultaneous approvals were tested with two real sessions (dblink): the second waits for the row lock, then sees a final request. The membership is created once and audited once.
  - Resubmitting with the same key returns the same request; the same key with different data is refused.
  - One pending request per customer is enforced by a unique index (tested against a direct insert).
- **"Add to company" execution** requires `account_request_execution_enabled` **and** `company_isolation_enforced` **and** `company_permissions_enabled`. Adding a secondary membership also requires `multi_company_memberships_enabled`.
  - Without isolation and 098, the legacy path (`can_access_ticket`: `t.user_id in (profiles where super_user_id = auth.uid())`) would show the company owner **all of the customer's earlier tickets**. That is exactly why 101 has the same prerequisite.
  - A test proves the earlier ticket stays hidden from the company owner after an approval with isolation on, and that isolation cannot then be turned off.
- **"Transfer a direct customer to a company"**: request and review only. Approval always refuses with `0A000 operation_not_available`, and the UI shows «التنفيذ غير متاح بعد». See `CUSTOMER_TRANSFER_DESIGN.md`.
- **Notifications** (in-app `notifications` only; **no email is sent or claimed**):
  - owners get «طلب حساب جديد» on submission;
  - the requester gets «صدر قرار في طلب حساب» on a decision;
  - the customer gets «أُضيف حسابك إلى شركة» on execution.
  - The text never contains a customer name, email or company (tested), because elevated admins can read notifications.

## 5. Authorization matrix

| Action | Owner (owner context) | Owner + step-up | Elevated admin | Admin | Admin + `customers.assign_manager` | Support | Company owner/staff | Customer | Anon |
|---|---|---|---|---|---|---|---|---|---|
| Customer directory / details | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| Assign account manager | ✓ (may assign self) | ✓ | ✗ | ✗ | ✓ (not self, not own account) | ✗ | ✗ | ✗ | ✗ |
| Submit / cancel own request | ✗ (decider) | ✗ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| My requests | ✗ | ✗ | ✓ own | ✓ own | ✓ own | ✗ | ✗ | ✗ | ✗ |
| Owner inbox / request details | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Approve / reject | ✗ | ✓ (never own) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Read 105 tables directly | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |

Being an account manager grants **nothing**: no RLS policy reads `customer_account_managers` (enforced by the self-check), and a test proves a manager in the support role still sees 0 rows of the customer's profile and has no directory access. Every check runs on the server; the UI only hides what the server would refuse anyway.

## 6. Frontend

| File | What |
|---|---|
| `admin/customers.html`, `assets/js/admin/customers.js` | «إدارة العملاء». It provides:<br>• views: all, direct, company customers, by account manager, pending transfer/request, suspended;<br>• search (debounced), filters for type, company, manager (incl. «بلا مدير») and status, sort, page size and prev/next — **all sent to the server**;<br>• columns: ID, name, email, mobile, WhatsApp (— when not stored), **مدير الحساب**, account type, company, status, created date, actions;<br>• loading skeleton, empty and error states (with retry);<br>• a details drawer (Esc closes it; focus returns), with the manager form (reason required) and the request form (type, verification email, optional other email, destination company, reason; idempotency key; transfer marked «التنفيذ غير متاح بعد») |
| `admin/account-requests.html`, `assets/js/admin/account-requests.js` | «طلبات الحسابات — Account Requests».<br>• **Owner** tabs: pending, approved, rejected, cancelled, all; filters: type, requester, customer email, company and date range (server side).<br>• Drawer: details, the company contact email separate from the customer email, the "other email" note, current state, impact summary, live checks, **approve disabled with the reason** unless the server says execution is available, all checks pass and a step-up is fresh; reject needs a reason.<br>• **Requester** tabs: mine, pending, approved, rejected; cancel needs a reason |
| `assets/js/admin/customers-model.js` | Pure labels, filters, error-code mapping, approval state, form checks, attribute-safe escaping |
| `assets/js/admin/customers.css` | Token colours only, so dark mode works; under 760px rows become cards with no horizontal page scroll; RTL via logical properties |
| `assets/components/sidebar.html`, `assets/js/admin/sidebar.js` | Links `customersLink` and `accountRequestsLink` (admins and the owner in admin/owner context) |
| `assets/js/owner/authority-center.js` | Grant/revoke `customers.assign_manager` (existing `owner_set_capability`, owner + step-up) |
| `owner-dashboard.html` | Links from the governance tab |
| `tests/fixtures/supabase-double.js` | `rpcErrors` may be an object `{message, code, details}`. This is backward compatible |

## 7. Tests

- `tests/sql/account-hierarchy-customers.test.sql`: sections ①–⑩ plus ⑦ب, run on the prod-shape chain 093 → 094…104 → 105:
  - objects;
  - rollback byte-for-byte, then re-apply twice;
  - classification and the `super_user_id` workflows (create-sub-user, main-admin legacy write, plain admin refused);
  - directory authorization, filters, search, sort, pagination, no secrets and no direct table access;
  - account managers (who, no self, eligibility, immutability, no access gained, end on ineligibility);
  - submission (who, nothing changes, email verification and ambiguity, idempotency, conflicts, invalid inputs);
  - the owner inbox and its filters;
  - decisions:
    - unauthorized users and a missing step-up;
    - self-approval, by function and by constraint;
    - no approval without execution;
    - rejection reason and finality;
    - transfer not available;
    - revalidation (email changed, company suspended);
    - an injected execution failure leaves nothing;
    - a successful approval: membership + mirror, history private, no replay, isolation held;
    - a secondary membership;
  - two-session concurrent approval;
  - deletions;
  - generic notifications;
  - rollback refused with history.
- `tests/account-hierarchy.render.test.mjs` (Chromium):
  - model functions;
  - server-side paging and filters;
  - the column set with no «اسم المندوب»;
  - XSS-safe drawer;
  - manager and request forms, with `p_customer` from the server record and an idempotency key;
  - forms hidden without the abilities;
  - the error state;
  - mobile at 390px with no horizontal scroll, dark theme and RTL, for both pages;
  - the owner inbox: approve disabled when execution is unavailable, for transfers, your own request, without a step-up or with a failing check; reject needs a reason; filters sent to the server;
  - approve with confirmation;
  - requester tabs and cancel;
  - no service key and no direct table writes.

## 8. Outstanding prerequisites and decisions

1. **Customer consent for "add to company".** 096's principle is "no membership without the account holder's acceptance". Owner approval (like 101's exceptional transfer) does not ask the customer. Execution stays behind `account_request_execution_enabled` (OFF) until you decide.
   - **A (implemented):** the owner's approval executes.
   - **B:** the approval issues a 096 invitation that the customer accepts. This requires `multi_company_memberships_enabled`.
2. **Enabling execution** needs `company_isolation_enforced` and `company_permissions_enabled` first. Both are one-way after an approved request, as after a 101 transfer. Each needs its own approval.
3. **Full transfer** (direct → company ownership, billing, history): design only, see `CUSTOMER_TRANSFER_DESIGN.md`.
4. **Legacy screens** (`super-users.js`, `my-users.js`, MCP visibility) still list followers through `super_user_id`. Decide whether to migrate them to memberships, which would be a separate change.
5. **Account managers in support role**: allowed (they are platform staff). Restrict to `admin` if preferred; it is a one-line change in `_account_manager_eligible`.
6. **Deploy `create-sub-user`** from this commit together with applying 105. It sets the `company_created` flag. Until then, the database fallback ends the direct row it creates for company sub-users.
7. **101 transfers (follow-up):** `_transfer_execute` does not take the same `FOR SHARE` lock on the isolation switches, so a transfer completing at the exact moment the owner switches isolation off could slip past the guard. This is not exploitable while transfers are off. Fix it in a forward migration before `customer_transfers_enabled` is turned on.
8. **Company-scope account managers**: reserved (`scope = 'company'`). They would be assigned by company admins under 098 permissions.
