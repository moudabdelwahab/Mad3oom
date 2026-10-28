# Shopify — capability report and setup

**Status (2026-10-28): read integration (119) deployed with the provider disabled; store management (120) implemented in the repository and tested locally only — migration 120 not applied anywhere, Edge Functions not redeployed, provider not enabled. Nothing has been run against a real or development store. No Shopify app exists yet. Not submitted for protected-customer-data review or App Store review.**

Code: `supabase/functions/_shared/integrations/shopify.js` (OAuth, reads, sync, webhooks), `shopify-admin.js` (management operations), `shopify-session.js` (token refresh), `api.js` (`shopify_*` actions). App config template: `integrations/shopify/shopify.app.toml`. Capability matrix and audit: `SHOPIFY_MANAGEMENT_MATRIX.md`.

> A successful development-store test will **not** show production readiness: protected customer data approval, App Store review (if listed), and the merchant-facing install flow on a real store are separate gates.

## Verified on shopify.dev (read 2026-10-28, Admin GraphQL `2026-10`)
- Multi-merchant SaaS → **public app**; non-embedded → **authorization code grant**.
- Install/callback `hmac`: hex HMAC-SHA256 with the client secret over the query string without `hmac`, keys sorted, `key=value` joined with `&`. `shop` must match `^[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com$` (anchored), `state` must be the one we issued.
- Token exchange `POST https://{shop}/admin/oauth/access_token`, form-encoded; `expiring=1` → **expiring offline token** (mandatory for new public apps): access ~1 h, refresh 90 days, **refresh token rotates**.
- Webhooks: `X-Shopify-Hmac-Sha256` = base64 HMAC-SHA256 of the **raw** body with the client secret; `X-Shopify-Webhook-Id` for dedupe; respond 2xx within 5 s; no ordering guarantee. Compliance topics only through app-specific subscriptions in `shopify.app.toml`.
- Cost-based rate limit (`THROTTLED`, `extensions.cost.throttleStatus`), max 1,000 points per query. `read_orders` covers the last 60 days.
- Protected customer data: Level 1 for customer objects, Level 2 for name/e-mail/phone/address fields. Unapproved fields come back `null` with an `errors` entry and HTTP 200.
- Management (120): `inventoryAdjustQuantities` / `inventorySetQuantities` **require** `@idempotent(key:)` since 2026-04 and an explicit `changeFromQuantity` (compare-and-swap); `orderCancel` is an async job with `refundMethod`; `draftOrderComplete` marks the order paid by default; `fulfillmentCreate` needs `write_merchant_managed_fulfillment_orders` (not `write_fulfillments`); `collectionAddProducts/RemoveProducts`, `ruleSet` and `returnReason` are deprecated; discounts take `context: { all: ALL }` and a 0–1 `percentage`; `publishablePublish` needs `write_publications`; `orderCreate` only works with offline tokens.
- **Schema check:** every GraphQL document `shopify-admin.js` sends, and the variables our validators produce for each operation, were validated against the real Admin API **2026-10 schema** (introspection from the shopify.dev explorer proxy): 61 operations, 99 distinct documents/variable sets, 0 errors (`integrations/shopify/schema-check.mjs`). This proves names, types and enum values; it does **not** prove Shopify's business rules (plan limits, eligibility, protected data).

## Capabilities

### Read (119, unchanged)
| Area | Behaviour |
|---|---|
| Orders / customers / products | Lookup and search for support (`shopify_search`, `shopify_get`, `link_record`), allowlisted mappers, masked e-mail in summaries. |
| Sync | Bounded incremental order sync, reconciliation every 6 h. |
| Webhooks | 12 topics + 3 compliance topics, HMAC-verified, deduped, refetched by the worker. |

### Store management (120 — feature `shopify_management`, off for every plan)
61 operations, catalogued server-side in `_ihub_shopify_op_catalog()` (permission, risk, confirmation, Shopify scopes) and mirrored in `shopify-admin.js` (a test keeps the two identical). Full list in `SHOPIFY_MANAGEMENT_MATRIX.md` §2.

| Area | Reads | Writes (C = server-enforced confirmation, D = destructive) |
|---|---|---|
| Products & variants | list, detail (variants, collections, metafields), sales channels | create (always DRAFT), update, status ACTIVE/DRAFT (C), archive (C, D), delete (C, D), publish/unpublish (C), collections, variants create / update price-SKU-tracking-policy (C) / delete (C, D), metafields (typed allowlist) |
| Collections | list, detail | create/update (custom collections), delete (C, D) |
| Orders | list with Shopify status filters, detail with **financial state exactly as Shopify reports it** | notes/tags, contact & shipping address (C), create with variant lines — **prices and currency read from Shopify**, `financialStatus: PENDING`, no transactions, receipt only if ticked (C), cancel **unpaid + unfulfilled only, never refunds**, result "submitted" (C, D) |
| Draft orders | list, detail | create/update (variant lines, % discount), delete (C, D). **Completion is not offered** (it marks the order paid). |
| Customers | list, detail (contact for editing), order history | create/update (name, e-mail, phone, note, tags; **no marketing consent**) |
| Inventory | levels per location (available, on hand, committed, incoming), locations | adjust ± (C), set (C), stock at a new location (C). Item ↔ location checked against Shopify; compare-and-swap with the quantity the user saw; idempotency key = journal id; reason from an allowlist; every adjustment journaled with item, location, delta, reason and resulting quantity. |
| Discounts | code and automatic lists, detail | basic code / automatic create & update (C), activate / deactivate (C), delete (C, D). Dates (start ≥ 1 year ago, end after start, in the future, ≤ 5 years), usage limit, %, fixed amount, minimum subtotal/quantity, all items / products / collections, combinations validated. |
| Fulfillment | fulfillment orders and fulfillments with tracking | create with tracking (FO must belong to the order, be OPEN/IN_PROGRESS and support CREATE_FULFILLMENT; quantities ≤ remaining) (C), tracking update (C) |
| Returns | returns per order, returnable quantities | create (quantities ≤ returnable) (C), approve / decline / close (C), cancel (C, D). **No refunds.** |
| Store | shop info (incl. development-store flag), locations | — |

### Controls on every operation
- **Server-side isolation and permissions** (`ihub_shopify_op_authorize` / `_confirm_begin`): caller's company from the session (never from the request), store account, not preview, entitlements `integrations_hub` + `shopify_integration` + `shopify_management`, provider enabled, connection of that company and within `min_view_role`, the operation's Mad3oom permission, and the operation's Shopify scopes in `granted_scopes` (`write_x` covers `read_x`).
- **Permissions** (team catalog, default **off** for supervisor and agent; the store admin has them): `store.catalog`, `store.inventory`, `store.orders_manage`, `store.customers_manage`, `store.discounts`, `store.fulfillment`, `store.returns`. Reads of orders/customers keep `store.orders`.
- **Strict validation** before anything else: unknown keys are refused (a browser sending `company_id`, `price` or a permission claim gets `invalid_input` naming that key), ids must be numeric or a gid of the expected type, money/integers/dates/enums/lengths bounded, HTML without scripts/handlers/frames, E.164 phones, https tracking URLs.
- **No trust in browser values for prices, quantities or ids that matter**: order prices come from Shopify; inventory, fulfillment, return, publication and variant ids are checked against Shopify before confirmation **and again before execution**.
- **Confirmation** for every consequential operation: step one returns what Shopify shows now (prices before/after, quantities current vs. seen, order payment state, fulfillable/returnable lines) and a one-time token; the database stores only its hash, bound to user + connection + operation + SHA-256 of the validated input, for 5 minutes. Changing anything after confirming, reusing the token, another user, or another operation → `confirmation_invalid`. An Edge build that skips step one still gets `confirmation_required` from the database (tested).
- **Rate limits**: reads share the 60/min/user lookup limit; writes 20/min/user and 100/min/company; destructive 5/min/user; confirmations 30/min/user.
- **Audit**: `ihub_audit_events` (`data.viewed`, `shopify.confirm.issued`, `shopify.write.requested/succeeded/submitted/failed`) and the operation journal `ihub_shopify_ops` (no customer data, no free text, ≤ 4 KB detail). The store admin sees it in «إدارة المتجر» → «سجل العمليات»; a `requested` row older than 10 minutes shows as "unknown outcome".
- **Errors**: Shopify `userErrors` → `provider_rejected` with field path and code only (no Shopify text reaches the browser, logs or database); `THROTTLED`/429 → `rate_limited` + `retry_after`; `ACCESS_DENIED` with no payload → `forbidden_scope` (with a payload → the write ran; restricted reply fields are not a failure); expired token → refreshed once under the lease, a dead refresh token → `token_expired` + reconnect; missing scope → `missing_scope` before Shopify is called; a lost reply → `outcome: unknown` ("check Shopify before retrying").
- **Secrets**: tokens are decrypted only inside the Edge Function for the call; never in responses, logs or the journal (tested for all 61 operations).

## Scopes and purposes
Requested only when the store has `shopify_management` (`api.js` asks `ihub_shopify_manage_status`; any error → the three read scopes, as before 120). The OAuth callback still requires only the three read scopes, so existing connections keep working read-only and get a per-operation "re-authorize" prompt.

| Scope | Purpose |
|---|---|
| `read_orders`, `read_customers`, `read_products` | Support lookups, sync, health (required) |
| `write_products` | Products, variants, collections, product/variant metafields |
| `read_publications`, `write_publications` | Sales channels list and publish/unpublish |
| `write_orders` | Order notes/contact, order creation, cancellation |
| `read_draft_orders`, `write_draft_orders` | Draft orders |
| `write_customers` | Customer create/update |
| `read_inventory`, `write_inventory`, `read_locations` | Inventory levels and mutations, location validation |
| `read_discounts`, `write_discounts` | Discounts |
| `read_merchant_managed_fulfillment_orders`, `write_merchant_managed_fulfillment_orders` | Fulfillment orders, fulfillment creation, tracking |
| `read_returns`, `write_returns` | Returns |

Not requested: `read_all_orders`, `write_fulfillments`, `*_assigned_fulfillment_orders`, `*_third_party_fulfillment_orders`, `read_product_listings`, marketplace/quick-sale/payment-terms/store-credit/gift-card scopes.

## Approvals and merchant permissions
- **Protected customer data** (before real merchants): Level 1, plus Level 2 for name, e-mail, phone and address — now also **written** (customers, order contact, order creation). Complete the data-protection questionnaire. Development stores work without it.
- **App Store review** only if listed; every requested scope maps to an implemented operation (asserted in tests).
- **`read_all_orders`** not requested (separate approval).
- **Merchant**: approves the scope list at install / re-authorization. Offline token ⇒ Shopify's per-staff permission notes do not apply; Mad3oom's per-user permissions above are the control.
- **Shopify plan limits**: collection writes are refused on Starter/Retail plans (shown as `provider_rejected`).

## Limitations (by design or not yet built)
- **No financial operations**: no refunds, capture, voids, mark-as-paid, draft-order completion, store credit, `returnProcess`. Cancelling paid/authorized orders is refused (`cancel_requires_refund_review`) — done in Shopify admin.
- No customer-facing messages unless the user ticks "notify customer" / "send receipt" (default off); no invoice sending.
- Smart (automated) collections are read-only; no BXGY / free-shipping discounts; discount eligibility = all buyers (no segments); changing a discount's product/collection scope needs a new discount.
- No order edits (`orderEdit*`), fulfillment holds/moves/cancellation, gift cards, metaobjects, themes/online-store content, markets, B2B.
- Draft-order fixed-amount discounts and custom (non-variant) line items are not offered.
- `provider_rejected` shows the field, not Shopify's message (no provider text policy).
- Shopify's "user must have permission X" checks for staff are not mirrored beyond Mad3oom permissions.

## Unverified — must be confirmed on a development store
Read integration (119): the queries in `Q` against `2026-10`, refresh response and rotation in practice, `expiring=1`, `use_legacy_install_flow = true` with app-managed OAuth on the CLI version used, real webhook headers/bodies, query costs, merchant scope changes.

Management (120) — schema-valid, never executed:
- Each mutation actually succeeds on a development store with the payloads in `tests/fixtures/shopify/admin-fixtures.mjs` (especially `productCreate.productOptions`, `productVariantsBulkCreate` option creation and `strategy`, `orderCreate` with `priceSet` + `financialStatus: PENDING`, `orderCancel` with `refundMethod: { originalPaymentMethodsRefund: false }` on a pending order, `inventorySetQuantities` CAS, `returnCreate` without a reason definition).
- `CHANGE_FROM_QUANTITY_STALE` and other `userErrors` codes appear as expected; idempotent retries return the same adjustment.
- Granted `scope` string after re-authorization with write scopes (whether Shopify returns `read_*` implied scopes) and `app/scopes_update` payload.
- Protected-data behaviour on writes without approval (customer create/update, order contact).
- Query costs of `product.get` (100 variants) and `fulfillment_order.list` stay well under 1,000 points.
- Collection writes on the dev store's plan; publication ids for Online Store.
- The dashboard page against real data (only rendered with fixtures).

## Setup (Mad3oom platform owner, once)
1. Create the app in the **Shopify Dev Dashboard** (public distribution, unlisted, non-embedded).
2. From `integrations/shopify/`: `shopify app config link`, review, `shopify app deploy` (scopes, redirect, webhooks).
3. Edge secrets: `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, `SHOPIFY_REDIRECT_URI`, optional `SHOPIFY_API_VERSION` (Owner → «المتاجر» → diagnostics shows which are set; the `shopify_config` action also returns the management scope list).
4. Development-store verification (below). Only then enable the provider.
5. Before real merchants: protected customer data approval (Level 1 + Level 2 fields above) and, if listed, App Store review.

## Development-store testing steps (management)
Prerequisites (each needs separate approval): 118/119 applied (done), **120 applied**, Edge Functions redeployed with `shopify-admin.js`, app created with the toml scopes, secrets set.
1. Owner → own test company → store account → `owner_store_test_entitlements(true, 7, reason)` and `owner_store_test_management(true, 7, reason)` (own store only, ≤ 30 days, step-up).
2. Enable the provider for the test window only (`update ihub_providers set enabled = true where key = 'shopify'`).
3. Connect (or re-authorize) a Shopify **development store**: the authorize URL must list the 19 scopes; afterwards `ihub_connections.granted_scopes` covers them and «إدارة المتجر» shows no "re-authorize" notice.
4. Optional: run `integrations/shopify/schema-check.mjs` against an introspection taken from the dev store.
5. For each section, run one operation per row of the capability table with a disposable record; confirm in the Shopify admin that the change happened, and in «سجل العمليات» that the journal row is `succeeded`/`submitted` with the expected detail. Specifically:
   - inventory adjust with a stale "current quantity" → refused with the stale warning; retry with the fresh value → applied once;
   - cancel a **pending test order** → submitted, then cancelled in Shopify (webhook `orders/cancelled` arrives); try to cancel a paid test order → refused;
   - create an order → PENDING, no transaction, no e-mail to the customer;
   - fulfillment with tracking → fulfillment visible; return create/approve/close → no refund created;
   - discounts with past end date / end before start / 0 % → refused before Shopify.
6. Rate limits (21st write in a minute → 429), permissions (supervisor without `store.catalog` → no product buttons; grant → available), cross-store (another test store's admin cannot see or act on this connection).
7. Revoke: `owner_store_test_management(false)`, `owner_store_test_entitlements(false)`, disable the provider. Record each result in "Unverified" above.

## Setup (merchant)
Mad3oom company dashboard → المتجر → Shopify → enter `your-store` → approve on Shopify → return in the same tab. Management (when the platform enables it for the store): «إدارة المتجر»; the store admin grants team members the store permissions in «الأدوار والصلاحيات». To disconnect: Mad3oom → Disconnect, then uninstall the app in Shopify.
