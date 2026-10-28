# Shopify — capability report and setup

**Status: implemented, tested with mocks only. Not verified against a real or development store. No Shopify app exists yet. Not submitted for protected-customer-data review or App Store review.** Connector: `supabase/functions/_shared/integrations/shopify.js` (+ `shopify-session.js`). App config template: `integrations/shopify/shopify.app.toml`.

> A successful development-store test will **not** show production readiness: protected customer data approval, App Store review (if listed), and the merchant-facing install flow on a real store are separate gates.

## Verified on shopify.dev (read 2026-10-28, Admin GraphQL `2026-10`)
- Multi-merchant SaaS → **public app**; non-embedded → **authorization code grant**.
- Install/callback `hmac`: hex HMAC-SHA256 with the client secret over the query string without `hmac`, keys sorted, `key=value` joined with `&`. `shop` must match `^[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com$` (anchored), `state` must be the one we issued.
- Token exchange `POST https://{shop}/admin/oauth/access_token`, form-encoded; `expiring=1` → **expiring offline token** (mandatory for new public apps): access ~1 h, refresh 90 days, **refresh token rotates**.
- Webhooks: `X-Shopify-Hmac-Sha256` = base64 HMAC-SHA256 of the **raw** body with the client secret; `X-Shopify-Webhook-Id` for dedupe; respond 2xx within 5 s; 8 retries over 4 h; no ordering guarantee. App-specific subscriptions in `shopify.app.toml` are recommended and are the only way to subscribe the mandatory compliance topics `customers/data_request`, `customers/redact`, `shop/redact`.
- GraphQL rate limit is cost-based (`extensions.cost.throttleStatus`, `THROTTLED` error), max 1,000 points per query.
- `read_orders` covers the last 60 days; older orders need `read_all_orders`.
- Protected customer data: Level 1 for customer objects, Level 2 for name/email/phone/address fields. Unapproved fields come back `null` with an `errors` entry and HTTP 200. Development stores work without review.

## Implemented
| Area | Behaviour |
|---|---|
| Scopes | `read_customers,read_orders,read_products` only. Granted scopes are recorded; missing ones → health `forbidden_scope` and a reconnect prompt (write implies read). No `read_all_orders`, no write scopes, **no mutations**. |
| OAuth | Server-validated shop, state bound to company + shop + initiating admin + browser tab, callback HMAC + timestamp freshness, one-time state, hold-then-complete. Re-authorization must use the same shop. |
| Tokens | Encrypted in `ihub_credentials`; refresh under a DB lease (single writer); 401 on refresh → `token_expired`, reconnect required. Tokens are never logged (`redact.js` masks `shp??_…`). |
| Reads | Order (status, financial/fulfillment/return status, totals, items, tracking via `Order.fulfillments`), customer (display name, masked e-mail, order count, amount spent), product (title, status, variants/prices, inventory if returned). Allowlisted mappers; admin links to `admin.shopify.com`. |
| Search | Sanitized query for order number / e-mail / name / product title; paginated with cursors; each lookup permission-checked, rate-limited and audited. |
| Sync | Bounded: initial 30 days, incremental from the watermark − 10 min, reconciliation every 6 h; 25/page, ≤ 8 pages / 20 s per run; yields on throttling. |
| Webhooks | Topics: `orders/create`, `orders/updated`, `orders/cancelled`, `refunds/create`, `customers/create`, `customers/update`, `customers/delete`, `products/create`, `products/update`, `products/delete`, `app/uninstalled`, `app/scopes_update`, + 3 compliance topics. HMAC-verified, deduped, queued by id (no payload stored), refetched by the worker. |
| Protected data | A restricted field produces a `restricted` flag in the summary and UI, never a fabricated value. |

## Unverified — must be confirmed on a development store
- The GraphQL queries in `Q` against `2026-10` (field names `displayFulfillmentStatus`, `returnStatus`, `defaultEmailAddress`, `numberOfOrders`, `amountSpent`, `Order.fulfillments.trackingInfo`) — they follow the reference docs but were not executed.
- Refresh response shape and rotation behaviour in practice; the `expiring=1` parameter on the exchange with the chosen CLI/app version.
- `use_legacy_install_flow = true` with app-managed OAuth for a non-embedded app on the Shopify CLI version used (the comment in the TOML says to check).
- Real webhook headers/body for each topic (compliance payload fields `customer.id`, `orders_requested`, `data_request.id`).
- Query cost of the search/sync queries (assumed well below 1,000).
- Behaviour when the merchant changes scopes in the Shopify admin.

## Setup (Mad3oom platform owner, once)
1. Create the app in the **Shopify Dev Dashboard** under the product owner's Partner organization: **public** distribution (start unlisted), non-embedded.
2. From `integrations/shopify/`: `shopify app config link` (fills `client_id`), review URLs, then `shopify app deploy` (publishes scopes, redirect URL and webhook subscriptions).
3. Edge secrets: `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, `SHOPIFY_REDIRECT_URI` (= `<IHUB_PUBLIC_BASE>/integrations-inbound/shopify/callback`), optional `SHOPIFY_API_VERSION`. The Owner page «المتاجر» → diagnostics shows which are set and whether the redirect matches.
4. Test on a **development store** (see `PROD_INSTALL.md` §5). Only then enable the provider.
5. Before real merchants: request **protected customer data** access (Level 1 + the Level 2 fields actually used: name, e-mail), complete the data-protection questionnaire, and — if listing publicly — App Store review. **Until those are approved, do not describe the integration as available to merchants or on the Shopify App Store.**

## Setup (merchant)
Mad3oom company dashboard → المتجر → Shopify → enter `your-store` or `your-store.myshopify.com` → approve on Shopify → you return **in the same tab** and the connection completes; an initial 30-day sync starts. To disconnect: Mad3oom → Disconnect, then uninstall the app in Shopify (the `app/uninstalled` webhook also revokes it).
