# E-commerce Store accounts & Shopify — architecture

> Companion to `AUDIT_2026-10-28.md`. Migrations `118_ecommerce_store_accounts.sql` and `119_shopify_store_integration.sql`, connector `supabase/functions/_shared/integrations/shopify.js`.
> **Status:** implemented and tested locally (SQL on a production-shaped fixture, Node with mocks, Playwright render tests). **Not applied to production, not deployed, not tested against a real Shopify store.** See `PROVIDER_SHOPIFY.md` and `PROD_INSTALL.md`.

## 1. Account types

| Account type (`my_account_type().account_type`) | How it is represented | Created by |
|---|---|---|
| `individual` | `profiles` row, no organization | sign-up (unchanged) |
| `company` | `companies` row, `account_kind = 'company'` (default — every existing company) | admin approval of a `company_account_requests` row (068, unchanged) |
| `ecommerce_store` | the **same** `companies` row with `account_kind = 'ecommerce_store'` | admin approval of a request created by `submit_store_account_request` (`account_kind = 'ecommerce_store'`) |

- A store **is** an organization: owner (`companies.user_id`), staff (`company_staff`, 086), memberships (096), permissions (098), tenant isolation (097), tickets, inbox, conversations, documents and billing all apply unchanged. There is no second ownership model.
- `account_kind` is protected by `_guard_company_account_kind`: a client write is refused; only the approval trigger (`_account_request_apply_kind`, after `admin_review_company_account_request` approves) and `owner_set_company_account_kind` (owner, step-up, reason, audited, refused while a live Shopify connection exists) change it.
- `my_account_type()` returns `{account_type, organization_kind, organization_id, organization_name, relation}` for the caller (owner, staff or customer of the organization). The company dashboard uses it only for navigation; every store RPC re-derives the company and kind on the server.

## 2. Subscriptions and entitlements

- Account type is **not** subscription status. Status stays in `whatsapp_subscriptions` (pending → admin approval → active/expired), unchanged.
- `subscription_plans.audience` (`company` | `ecommerce_store`). Existing plans keep `company`.
- Plan `store` is seeded **inactive with NULL prices** (`requires_company = true`, EGP). Constraint `subscription_plans_store_priced` refuses an active store plan without two positive prices. Prices, bundle and ticket quota are product-owner decisions; activation uses the existing admin plan-write path (`Admins manage subscription_plans`).
- `enforce_plan_audience` (trigger on `whatsapp_subscriptions`): a store-audience plan can only be requested by the owner of an `ecommerce_store` organization, including direct API calls. Admin and service_role writes are exempt (existing approval tooling).
- New feature flags `shopify_integration`, `store_support`. The store plan's proposed bundle: `support_tickets`, `sub_users`, `integrations_hub`, `shopify_integration`, `store_support`. **No existing plan was granted a new feature.**
- Enforcement is in SQL: `_store_ctx(require_feature)` checks organization kind + `company_has_feature(...)`; Edge actions call a user-scoped RPC first, so an unentitled caller is refused before any Shopify call.

## 3. Shopify connection (Integrations Hub reuse)

Shopify is a fifth provider of the 088 Integrations Hub, not a parallel system:

- `ihub_connections` (one per company; `_ihub_guard_shopify_company` allows only `ecommerce_store` organizations), new columns `granted_scopes`, `external_account_gid`, `sync_watermark`, `last_sync_at/status/error_code`.
- Tokens in `ihub_credentials` (AES-256-GCM, `IHUB_ENC_KEY`, AAD `ihub:v1:<conn>:shopify`), readable only by `ihub_svc_*` (service_role). The browser never sees a token, client secret or refresh token. `refresh_lease_until` makes token refresh single-writer (Shopify refresh tokens rotate).
- OAuth: `ihub_shopify_authorize` → `ihub-api` `shopify_start` (server validates the shop with the anchored `*.myshopify.com` pattern, binds the expected shop to the state) → Shopify → `integrations-inbound/shopify/callback` (query HMAC, timestamp, one-time state, shop must equal the bound shop) → encrypted pending result → the initiating tab completes it with the binding + completion code (`oauth_complete`). Re-authorizing must use the same shop.
- Provider `shopify` is seeded **disabled**; while disabled every Shopify action and webhook is refused/ignored.

## 4. Data held in Mad3oom

| Data | Where | Bound |
|---|---|---|
| Order / customer / product summaries | `ihub_external_records` (088), types `order`, `customer`, `product` | allowlisted fields only (`mapOrder`, `mapCustomer`, `mapProduct`), ≤ 4 KB, masked e-mail, no street address, no phone, no payment details; 30-day retention sweep (088) |
| Ticket ↔ record links | `ihub_ticket_links` (088) | company staff with role ≥ connection `min_view_role` |
| Sync jobs | `ihub_sync_jobs` | one active per connection; cleaned by `store_maintenance_sweep` |
| Webhook inbox | `ihub_webhook_events` (088) | **no payloads**; dedupe key = `X-Shopify-Webhook-Id` |
| Compliance requests | `ihub_compliance_requests` | metadata only (topic, shop, status, timestamps) |
| Support categories | `store_support_categories` | per company; 10 defaults |
| Ticket store meta | `store_ticket_meta` | category per ticket, same tenant |
| Order follow-up requests | `store_order_requests` + append-only `store_order_request_events` | same tenant; assignee must be company staff |

All new tables: RLS on, **no table grants** to `anon`/`authenticated`, restrictive `gate_account_active`, preview read-only trigger. Access only through `security definer` RPCs that derive the company from `auth.uid()`.

## 5. Sync, webhooks, reconciliation

- **Initial sync** is enqueued after a successful connect (`_ihub_enqueue_sync`, last 30 days). **Incremental** syncs start from `sync_watermark − 10 min`. `ihub_svc_schedule_reconciliation(360)` enqueues one for connections not synced in 6 h.
- Worker (`integrations-worker`, pg_cron every 5 min via `_ihub_worker_call()`): `runSyncJobs` claims jobs with `SKIP LOCKED` and a 10-minute lease, pages 25 records with `updated_at` filters and cursors, stops at 8 pages or 20 s, and **yields** on `THROTTLED`/429 with Shopify's wait time. Progress is saved per page, so a crash resumes from the last cursor.
- **Webhooks** (`POST integrations-inbound/shopify/webhooks`): `X-Shopify-Hmac-Sha256` over the raw body with the client secret (constant-time), 401 on mismatch, 200 for everything verified (Shopify retries non-2xx 8 times over 4 h). Order/customer/product topics are **queued by id** (no payload stored) and fetched by the worker, so delivery order does not matter: the newest `updatedAt` from the API wins (`apply_record` refuses older data). Deletes forget the record. `app/uninstalled` revokes the connection; `app/scopes_update` re-records scopes and flags missing ones.
- Retries for our own processing: 1 m / 5 m / 30 m / 2 h / 12 h, then `dead` (088). Admins can retry failed events (`ihub_events_retry`).
- **Compliance** (`customers/data_request`, `customers/redact`, `shop/redact`) is handled even when the provider is disabled or the shop is unknown: redact deletes cached records and links for that customer/orders immediately; shop/redact purges everything for the shop and disconnects; data_request notifies the store owner, who can export what Mad3oom holds (`ihub_compliance_export`).

## 6. Support experience

- Ticket panel (`ticket-integrations.js`): Shopify order/customer/product context (status, items, totals, tracking links), restricted/deleted flags, store category select, the ticket's follow-up requests and a «تسجيل طلب متابعة» button.
- Search / lookup (`shopify_search`, `shopify_get`) goes through `ihub_authorize_lookup`: store context, entitlement, `store.orders` permission, role ≥ `min_view_role`, not in preview, rate-limited 60/min/user, each lookup audited as `data.viewed`.
- Categories are configurable by the store admin (`store_category_save`).

## 7. Order operations: tracking only

`store_order_requests.kind` ∈ `return`, `exchange`, `cancellation`, `refund_inquiry`, `shipping_issue`, `other`. Status ∈ `recorded` (initial), `in_review`, `awaiting_customer`, `escalated`, `resolved`, `declined`; resolved/declined are terminal (only a store admin may reopen, to `in_review`). Every change is appended to `store_order_request_events`. Every JSON result carries `executes_in_shopify: false` and the UI repeats it (`NOT_EXECUTED_NOTE`). **A follow-up request executes nothing in Shopify** — not even after 120: Shopify actions that exist (§10, behind `shopify_management`) are separate, confirmed operations on «إدارة المتجر», and refunds are never executed from Mad3oom. A resolved refund request is a recorded decision, not a completed refund.

Automation reuses `notifications`: owner on connection error/reauth, assignees on new/changed requests, the owner and assignees when a linked order changes, overdue requests once (`store_maintenance_sweep`, cron `23 * * * *`). No customer-facing message is sent automatically.

## 8. Metric definitions (store_overview / store_report)

All counts are computed from Mad3oom tables at request time, for the caller's company only, and only over tickets the caller may view (`_company_ticket_access(ticket, 'view')`). No Shopify revenue or sales figure is reported.

| Metric | Definition |
|---|---|
| `open_tickets` / `unresolved_tickets` | company tickets with status `open` or `in-progress` |
| `active_conversations` | `company_conversations` with status `open` (null if 102 absent) |
| `unresolved_requests` | order requests not `resolved`/`declined` |
| `overdue_requests` | unresolved requests with `due_at < now()` |
| `order_linked_open_tickets` | open tickets with an active link to a store record |
| `ticket_volume` | company tickets created in the window (1–365 days, default 30) |
| `first_response_minutes_median` | median of `first_response_at − created_at` over window tickets with a first response |
| `resolution_hours_median` | median of `resolved_at − created_at` over window tickets with `resolved_at` |
| `order_related_tickets` | window tickets linked to a store record or carrying an order request |
| `categories` | window tickets per store category (`uncategorized` when none) |
| `requests_by_kind` / `requests_by_status` | order requests created in the window |
| `integration.webhook_events` / `sync_jobs` | Shopify inbox events / sync jobs in the window by status |

`store_report` is for store admin and supervisor; `store_overview` for any staff member (request figures only with `store_support`).

## 9. Owner dashboard (`owner/stores.html`)

The Owner stays distinct from Admin. Read-only, metadata-only RPCs behind `owner_capability('owner_only')`:
`owner_accounts_overview` (individual/company/store, subscription status), `owner_store_integrations` (connection health, last sync, failed events, compliance counts — no tokens, no customer/order data), `owner_store_events`, `owner_entitlement_diagnostics`, plus the `shopify_config` action (which secrets are set, as booleans, and the public callback/webhook URLs).
Writes need `owner_critical_ok()` (fresh step-up), a reason, and are written to `privileged_audit`: `owner_set_company_account_kind` and `owner_store_test_entitlements` (**only the owner's own store company**, ≤ 30 days, via `company_feature_overrides`). Viewing a store as staff uses the existing preview contexts (`company_user_preview`), which are read-only. The Owner cannot open another merchant's data, impersonate a merchant, or grant paid entitlements to real customers.

## 10. Store management (120)

`shopify-admin.js` holds 61 operations (20 reads, 41 writes), each `validate` (pure, strict) → `inputHash` → database authorization → `check` (reads Shopify's current state; refuses what Shopify state makes ineligible) → `run` (one GraphQL request) → journal result from the service role. The database owns the decision: `_ihub_shopify_op_catalog()` (permission, risk, confirmation, scopes), `_ihub_shopify_op_gate` (store, preview, entitlements incl. `shopify_management`, connection of the caller's company and role, permission, scopes), `ihub_shopify_op_confirm_begin` / `ihub_shopify_op_authorize` (one-time confirmation bound to user + connection + operation + input hash; rate limits; journal row), `ihub_svc_shopify_op_result`. The page «إدارة المتجر» (`store-manage.js`, `store-manage-model.js`) renders only what `ihub_shopify_manage_status` allows and runs every consequential operation as form → confirmation with Shopify's current state → execution. Financial mutations are absent by design (`SHOPIFY_MANAGEMENT_MATRIX.md` §2).

## 11. Rollback

`migrations/_rollback/118_*.down.sql`, `119_*.down.sql` and `120_*.down.sql` refuse while store data or Shopify connections exist, restore the production text of every rewritten function (md5-verified in the SQL tests), and can be re-applied afterwards.
