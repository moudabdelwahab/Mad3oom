# Company Dashboard: capability matrix and information architecture

Audit date: 2026-10-14.

**Evidence sources:**
- **Production database:** read-only queries on project `srnelrdpqkcntbgudyto`: `pg_proc` with `has_function_privilege('authenticated', …)`, `platform_feature_switches`, `pg_policies` and `list_edge_functions`.
- **Repository:** migrations, `assets/js/company/*` and the shared services.

Nothing was applied, deployed or switched while preparing this document.

**Status legend:**
- **Ready:** the backend contract, authorization and frontend access path are verified.
- **Partial:** some pieces exist, but more safe work is needed.
- **Backend only:** the backend exists, but there is no usable frontend workflow.
- **Not ready:** the feature is disabled, incomplete or depends on missing infrastructure.
- **Not implemented:** the capability does not exist.

## Information architecture

| Area (sidebar group) | Pages (`#hash` routes) |
|---|---|
| الرئيسية | `overview` (alerts, KPIs, ticket summary, quick actions, latest notifications and activity) |
| الدعم والتذاكر | `tickets`, `customerTickets`, `inbox` (only when the database returns an inbox), `support` |
| الفريق والصلاحيات | `members`, `customers`, `permissions` (admin), `accessLog` (admin) |
| الاشتراك والفوترة | `subscriptions` (admin), `entitlements`, `usage` |
| التكاملات وواجهة API | `integrations`, `api` (admin) |
| التقارير والنشاط | `reports`, `activity` |
| الإشعارات | `notifications` |
| حساب الشركة | `company` (company data and documents) |
| حسابي والأمان | `profile`, `security` |

**Where the structure lives:**
- `assets/js/company/company-routes.js` is the single source for the sidebar, the breadcrumb, each area's header and sibling tabs, and route availability per role.
- Each page is an independent container, `#<page>TabContent`, with a loader that runs the first time the page opens.

**Navigation behavior:**
- Every hash that existed before still works.
- Clicks push browser history, so back and forward move between pages.
- A direct link to a page the viewer's role can't open is replaced with `#overview`, without calling that page's data.

## Capability matrix

### Ready: surfaced by this change

| Capability | Backend evidence | Previous UI | Access | Status | Destination |
|---|---|---|---|---|---|
| Roles and company permissions matrix | `company_permissions_matrix()` (098). Returns `null` unless `company_staff_role() = 'admin'`. Readable while the switch is OFF and carries `enabled`. | none | company admin | Ready (read). Writes are refused while `company_permissions_enabled` is OFF (`_company_permissions_require_enabled`, production: OFF). | `#permissions`. Read-only pills while OFF. Switches call `company_set_role_permission(role, key, allowed)` only when the database reports `enabled: true`; a refusal reverts the switch. |
| Mad3oom access log for company tickets | `company_access_log()` (097). Admin only, read-only: grants, requester kind, scope, period, read count. | none | company admin | Ready. It's empty in production while `data_access_grants_enabled` is OFF, which is shown as an explicit empty state. | `#accessLog` |
| Ticket allowance (usage and limits) | `my_ticket_wallet()` → `ticket_quota_status(auth.uid())` (065/069), the same function the `tickets_enforce_quota` trigger enforces | header popover only (its links point to customer-portal pages) | any signed-in member | Ready | `#usage`: remaining/limit, usage bar, reset date, billing-request cap (`billing_used`/`billing_limit`), shared-account note |
| Cancel a pending subscription request | `cancel_my_subscription_request(id)` (023). Deletes only a `pending` row owned by `auth.uid()` plus its still-open ticket. Returns `false` otherwise. | customer portal only | subscription owner (company owner) | Ready | `#subscriptions`: "إلغاء الطلب" on pending rows for the owner, behind a confirm dialog. `false` is shown as a failure, never as success. |
| Overview alerts | `get_my_company_dashboard()` payload (registration expiry, subscription states) | partially spread across KPIs | admin (the payload withholds these from other roles, 095) | Ready | `#overview` alerts, each linking to its page |
| Latest notifications and activity | `notifications-service.fetchNotifications`, `customer-data.fetchAccountActivity` (RLS: own rows) | only on their full pages | any member | Ready | `#overview` short feeds, linking to the full pages |

### Already in the UI, reorganized into pages

| Capability | Backend evidence | Previous UI | Access | Status | Destination |
|---|---|---|---|---|---|
| Company profile and edit | `get_my_company_dashboard`, `upsert_my_company` | the overview's long page | edit: owner | Ready | `#company` |
| Members and staff roles | `company_members`, `company_staff_list/set/revoke`, `remove_company_member`, Edge function `create-sub-user` | `#members` | role-dependent (database decides) | Ready | `#members` |
| Company customers and invitations | `company_customers_list`, `company_invitations_list`, `company_invite_customer`, `company_invitation_cancel` (096) | inside `#members` | admin with invitations enabled, or supervisor | Ready (invitations are switch-gated) | `#customers` |
| Subscriptions | dashboard payload | `#subscriptions` | admin | Ready | `#subscriptions` |
| Entitlements | dashboard payload | inside `#subscriptions` | any member | Ready | `#entitlements` |
| Tickets with Mad3oom, customer tickets, team tools | `tickets` (RLS), `company_tickets_list`, `company_ticket_set_status/assign` (098, switch OFF) | existing pages | role and RLS | Ready | `#tickets`, `#customerTickets` |
| Support center | ticket creation, `service_status`, help articles | `#support` | any member | Ready | `#support` |
| API tokens | `api_tokens` (RLS, read), Edge function `create-api-token` | `#api` | admin | Ready | `#api` |
| Integrations hub | `ihub_*` RPCs (088), audit `ihub_audit_list` | `#integrations` | database-decided | Ready | `#integrations` |
| Reports and activity | stream rows, `activity_logs` (own) | existing pages | any member | Ready | `#reports`, `#activity` |
| Profile and security | `account-settings.js` (shared) | existing pages | self | Ready | `#profile`, `#security` |

### Deferred: not exposed, with the exact reason

| Capability | Backend evidence | Status | Reason and what's needed |
|---|---|---|---|
| Company inbox (customer conversations) | `company_inbox_*`, `company_conversation_*` (102) | Not ready | `company_inbox_enabled` is OFF in production. The page and link appear only when `company_inbox_summary()` returns a box. No change. |
| Company documents | `company_documents_mine`, `document_upload_begin/commit` (100) | Not ready | `company_documents_enabled` is OFF. The upload, download and scan-callback Edge functions aren't deployed. There's no scanner or `DOCUMENT_SCAN_SECRET`. Follow-ups are in PR #136 (104). The panel on `#company` stays database-gated. |
| Customer transfers, ticket carry, historical access | `transfer_*`, `carry_*`, `historical_access_*` (101) | Not ready | Switches are OFF and need isolation and permissions first (one-way). The panel on `#customers` stays gated by `h2_features()`. |
| Admin hierarchy and delegation | `owner_*`, `delegate_*`, `unit_member_*` (099) | Not company-facing | These are platform-owner and delegate tools, not company tools. |
| Usage ledger, billing projection | `usage_projection`, `usage_reconciliation` (098) | Not company-facing | Platform owner only (`_usage_caller_ok`). |
| Invoices or billing history list | Invoice PDFs attach to the purchase ticket (072 `attach_accounting_invoice_pdf`); `ticket_invoice_status/document` are staff-side | Partial | There's no company-facing "list my invoices" RPC. The invoice is visible inside the purchase ticket. **Proposal:** a read-only `company_invoices()` (security definer, company resolved from `auth.uid()`, owner only), with SQL tests for cross-company isolation. Not applied. |
| Per-user permission overrides editor | `company_set_user_permission` (098) | Partial | Same switch as role permissions (OFF). The matrix page shows the override count. A per-member editor belongs with the switch's activation. |
| Multi-company memberships | `my_company_memberships`, `set_primary_company`, `leave_company` (096) | Not for this dashboard | Customer-side (portal) capability; switch OFF. |
| Subscription purchase and upgrade | `request_subscription_purchase/upgrade`, `subscription_upgrade_quote` | Ready elsewhere | Existing workflow on the public pricing page `/subscriptions.html`, linked from the subscriptions and usage pages. Not re-implemented. |

## Security notes

- Every new call is an RPC that resolves the company from the session. No company id is sent from the browser.
- Hidden links aren't an authorization boundary. Each RPC enforces its own role check (`company_staff_role()` / owner), and the UI only mirrors it.
- No feature switch was changed, and no migration or Edge Function was added or deployed.
