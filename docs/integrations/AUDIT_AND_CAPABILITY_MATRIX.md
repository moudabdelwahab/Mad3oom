# Integrations Hub — Phase Zero audit and capability matrix

> Prepared 2026-10-12/13 on branch `claude/intelligent-knuth-izp05g` (base `main` = `e2c0a21`).
> Production project `srnelrdpqkcntbgudyto` was **read-only**: `list_migrations`, `list_branches` and `SELECT` only.
> Evidence labels: **[repo]** read in this checkout · **[prod]** read-only query · **[official]** provider's own source/docs · **[search]** provider docs seen only through web-search snippets · **[assumption]** not verified.

## 1. Repository and platform audit

| Area | Finding | Evidence |
|---|---|---|
| API style | No versioned REST API. The browser calls PostgREST RPCs (`supabase.rpc`) and Edge Functions (`supabase.functions.invoke`). External clients use the MCP server (`/mcp`) with API tokens or OAuth 2.1. | [repo] `api-config.js`, `supabase/functions/mcp/*`, `vercel.json` rewrites |
| API tokens | `api_tokens` (bearer or key+secret, SHA-256 hashed, scopes, expiry, 60 req/min via usage logs). Issuance gated in the DB (`can_create_api_token`, 036). MCP `create_ticket` always creates the ticket **as the token owner**, so it cannot create a ticket for a company's customer. | [repo] 036, `mcp/_shared/api-auth.ts`, `tickets-service.ts` |
| Tenant model | `companies(user_id = owner)`. `current_company_id()` derives the company from `auth.uid()`; no company function takes a company id. Company customers = `profiles.super_user_id = owner`. Company staff (supervisor/agent) are an explicit relation since 086 (`company_staff`, `company_staff_role()`); the owner is `admin` by ownership. | [repo] 020, 035, 086 |
| Ticket visibility | `ticket_in_my_scope()`: own tickets + tickets of users the caller supervises (the owner). **Company staff do not see customer tickets yet** (086 grants no access). | [repo] 033, [repo fixture] `ticket_in_my_scope` |
| Existing integration tables | `external_integrations` (per **user**, AI providers, AES-GCM with `INTEGRATIONS_ENC_KEY`); `integrations` (WhatsApp channels); **prod-only** `integration_clients / integration_api_keys / integration_message_requests / integration_request_logs / integration_settings / integration_templates` + 13 `integration_*` functions (outbound WhatsApp client API — ledger `20260820210140 integration_platform_tables_and_rls`, **no source in the repo**: drift); `webhooks` / `webhook_deliveries` (platform-wide outbound, no tenant column, 0 rows). None is company-scoped or knows tickets. | [repo], [prod] |
| Inbound webhooks | `meta-webhook` (HMAC, fail-open if secret unset), `telegram-webhook` (per-user secret), `resend-inbound-webhook` (Svix, fail-open if unset). | [repo] `supabase/functions/_AUDIT_NOTES.md` |
| Background work | `pg_cron` running pure-SQL functions (`inbox_dispatch_scheduled`, `continuity_*_sweep`, …); `pg_net` installed; `FOR UPDATE SKIP LOCKED` scheduler pattern (058). No queue system. | [prod] `cron.job`, `pg_extension` |
| Secrets | Edge Functions use env keys + AES-GCM (`INTEGRATIONS_ENC_KEY`, `MCP_ENC_KEY`, `WHATSAPP_TOKEN_ENC_KEY`). Supabase Vault installed, 0 secrets. | [prod] |
| Audit logging | Append-only per-domain logs with guards (`company_staff_events`, `privileged_audit`, continuity events). | [repo] |
| Entitlements | `plan_features` → `feature_flags`; `company_has_feature(key)` for the caller's company. | [repo fixture] |
| Provider references | **None.** No WordPress, WooCommerce, Salla or Daftra code, table, doc or config anywhere in the repository. | [repo] full-text search |
| Environments | One Supabase project (production, Postgres 17.6). Its only branch is the default `main`. **No staging environment and no provider sandbox credentials.** | [prod] `list_projects`, `list_branches` |
| Migration ledger | Production head `086_company_staff`. `075_workspace_layouts` is in the repo but not in production (unrelated drift, already known). | [prod] `list_migrations` |
| Tests | `node --test` (unit + Playwright render), `tests/run-sql-tests.sh` applying migrations to a production-shape fixture (PG 16 locally/CI), CI `tests.yml`. | [repo] |

### Blocking or shaping findings

1. **No API creates a ticket for a company's customer from outside.** MCP `create_ticket` creates tickets owned by the token holder (path ① company↔Mad3oom). Using it from a website would route visitors' requests to **Mad3oom's** own support queue. → The WordPress form creates **intake requests** that a company admin converts into a ticket for an existing customer they choose (§4 of `ARCHITECTURE.md`). Direct ticket creation for non-account visitors is equivalent to decision D1-b (anonymous widget) and is **left to the product owner**.
2. **Company staff cannot read customer tickets yet.** The ticket context panel therefore requires the same visibility as the ticket (`ticket_in_my_scope`) *and* a staff role ≥ the connection's `min_view_role`. Today that means the company owner only; it opens automatically when staff ticket access is added.
3. **Name collision with production-only `integration_*` objects.** A first draft of 088 used `integration_` and its grant loop would have revoked access to the 13 live WhatsApp functions, and its rollback would have dropped them. Caught by a read-only query; the hub uses the `ihub_` prefix and the SQL test pins the old functions' definitions and grants.
4. **No staging.** Nothing can be verified against real providers in this session. Every provider capability is at best *implemented but unverified*.

## 2. Provider documentation actually verified

The container's network policy blocks `woocommerce.github.io`, `docs.salla.dev`, `docs.daftara.dev` and `developer.wordpress.org`. `raw.githubusercontent.com`, the npm registry and Packagist are reachable, and web search returns snippets.

| Provider | Source used | What it confirmed |
|---|---|---|
| WooCommerce | [official] `woocommerce/woocommerce-rest-api-docs` (`_authentication.md`, `_orders.md`, `_customers.md`, `_webhooks.md`, `_introduction.md`) and `woocommerce/woocommerce` `class-wc-webhook.php`, `class-wc-auth.php`, `wc-core-functions.php` | REST v3 needs WooCommerce 3.5+ and WordPress 4.4+; HTTPS Basic auth with consumer key/secret (query-string fallback exists, not used); key permission Read / Write / Read-Write; `GET /wp-json/wc/v3/orders/<id>`, list filters (`search`, `modified_after`, `customer`, …); order fields; topics `order.created/updated/deleted`; `X-WC-Webhook-Signature = base64(HMAC-SHA256(body, secret))`; delivery headers; the creation ping body `webhook_id=<n>` must get HTTP 200; webhooks are disabled after more than 5 consecutive failures; keys are `ck_`/`cs_` + 40 hex |
| Salla | [official] `SallaApp/oauth2-merchant` (`Provider/Salla.php`, `SallaUser.php`, README), `SallaApp/laravel-starter-kit`, `SallaApp/express-starter-kit`, npm `@salla.sa/webhooks-actions`; [search] docs.salla.dev webhook page | OAuth endpoints `accounts.salla.sa/oauth2/{auth,token,user/info}`; `offline_access` for a refresh token; access token lifetime 14 days; user-info shape `data.merchant.id`; API base `api.salla.dev/admin/v2`; webhook envelope `{event, merchant, created_at, data}`; event names; Easy vs Custom authorization modes; [search] `X-Salla-Security-Strategy: Signature` default + `X-Salla-Signature` = SHA-256 with the webhook secret |
| Daftra | [search] docs.daftara.dev snippets only; no official SDK on npm/Packagist | `https://<subdomain>.daftra.com/api2`; API-key auth (key from account settings; no `Authorization` header alongside it); `GET /clients/{id}` → `Client` with `business_name`; invoice payload wrapper `Invoice` with `client_id`, `currency_code`; OAuth2 is mentioned but its endpoints were not found |
| WordPress | Not needed from docs: the plugin uses core APIs (`wp_safe_remote_post`, options, nonces, shortcodes, `admin-post.php`) whose behaviour is long-stable; WooCommerce hook `woocommerce_my_account_my_orders_actions` | — |

**Documentation still needed** (please provide or allow the hosts): Salla's exact `X-Salla-Signature` encoding and the `GET /admin/v2/orders/{id}` response schema; Salla token-revocation and refresh-token rotation rules; Daftra's invoice/client response schemas, the `.json` path suffix, pagination/`modified` filters, OAuth token endpoint, and whether webhooks exist.

## 3. Capability matrix

Status vocabulary (as requested): **Verified** = implemented and verified against the real provider · **Unverified** = implemented, tested only with mocks · **Partial** · **Missing** · **Blocked** (external approval/permission/decision). Nothing is *Verified*: there is no staging and no provider credential.

### WordPress (Mad3oom Support plugin)

| Capability | Status | Notes |
|---|---|---|
| Authentication | Unverified | One-time pairing code → per-connection secret; HMAC-signed requests with timestamp (±300 s), single-use nonce, and the site's `home_url` in the signed body |
| Read customer / order / invoice | Not applicable | WordPress users are never merged with Mad3oom customers; orders come from WooCommerce |
| Create support tickets | **Partial** | Creates *intake requests*; the company admin converts them into a ticket for an existing customer. Direct ticket creation for visitors: **Blocked** on a product decision (D1-b equivalent) |
| Associate records with tickets | Unverified | Owner-verified WooCommerce order number travels with the request; the admin links it after conversion |
| Receive events | Not applicable | The plugin pushes signed requests (ping, intake) |
| Write operations | Missing (by design) | |
| Revoke / disconnect | Unverified | Disconnect in Mad3oom deletes the server secret (plugin stops working at once); "Disconnect this site" and uninstall delete the local secret |
| Limits | 30 intake requests / connection / 10 min, 5 / e-mail / hour (DB); 5 / visitor IP-hash / 10 min (plugin) |

### WooCommerce

| Capability | Status | Notes |
|---|---|---|
| Authentication | Unverified | Merchant-created **Read** REST keys over HTTPS Basic auth (official) |
| Read customer | Missing | Not needed for the first release; customers are linked explicitly by id |
| Read order | Unverified | `GET /orders/{id}`, falling back to an exact `number` match via `search` (sequential-number plugins). Allowlisted summary only |
| Read invoice | Not applicable | Core WooCommerce has no invoices |
| Create tickets | Not applicable | (through WordPress intake) |
| Associate with tickets | Unverified | |
| Events | Unverified | `order.created`, `order.updated`; signature per official source; ping handled; only orders already linked to a ticket are refreshed |
| Write operations | Missing (by design) | No write method exists in the connector |
| Revoke / disconnect | **Partial** | Disconnect deletes keys and cached data in Mad3oom. WooCommerce has no REST endpoint to revoke a key: the merchant revokes it in WooCommerce > Settings > Advanced > REST API (shown in the confirm dialog) |
| Limits | No documented global rate limit in the official docs; 429/5xx are retried by the worker with back-off |

### Salla

| Capability | Status | Notes |
|---|---|---|
| Authentication | Unverified | OAuth 2.0 *Custom mode*, `offline_access`; state single-use; completion bound to the initiating admin, tab and consenting browser |
| App registration / publication | **Blocked** | Requires a Salla Partners app (client id/secret, webhook secret, callback URL, scopes `orders.read`, `customers.read`). Marketplace listing requires Salla's review — **not done; do not claim public availability** |
| Token refresh | Unverified | Single writer (the worker), 2 days before expiry |
| Read customer | Missing | |
| Read order | Unverified (field mapping unverified) | `GET /admin/v2/orders/{id}`; tolerant allowlist mapping flagged `field_mapping: unverified` |
| Associate with tickets | Unverified | |
| Events | Unverified | `order.created/updated/status.updated`, `app.uninstalled`; signature algorithm per docs, encoding unverified (hex and base64 of the same HMAC accepted); routing by `merchant` after verification |
| Write operations | Missing (by design) | |
| Revoke | **Blocked** | No verified revocation endpoint; the merchant removes the app in Salla (`app.uninstalled` deletes the tokens) |
| Limits | Unknown (docs blocked); 429 handled |

### Daftra

| Capability | Status | Notes |
|---|---|---|
| Authentication | Unverified | API key in `APIKEY` header to `https://<subdomain>.daftra.com/api2`; OAuth: **Missing** (endpoint not documented to us) |
| Read customer | Unverified (mapping unverified) | `GET /clients/{id}.json` → `business_name` only |
| Read invoice | Unverified (mapping unverified) | `GET /invoices/{id}.json`; number, date, currency, total/paid/unpaid, payment-status code |
| Read order | Not applicable | |
| Associate with tickets | Unverified | |
| Events / incremental sync | Missing | No webhook or `modified` filter documented to us; fetched on demand only |
| Write operations (issue invoices, accounting changes) | Missing — **excluded by policy** | Not built, per the request |
| Revoke | Partial | Disconnect deletes the key in Mad3oom; the owner deletes it in Daftra |
| Limits | Unknown |

## 4. Missing APIs and decisions

| Item | Owner |
|---|---|
| Company-staff access to customer tickets (unblocks the context panel for supervisors/agents) | Mad3oom (Continuity increment 3) |
| Ticket creation for non-account visitors from a company website (D1-b) | Product owner decision |
| `integrations_hub` entitlement on plans | Product owner decision |
| Salla Partners app, credentials and review | Product owner + Salla |
| Staging WordPress/WooCommerce site, Salla demo store, Daftra trial account | Product owner |
| Provider docs listed in §2 | Product owner / network allow-list |
