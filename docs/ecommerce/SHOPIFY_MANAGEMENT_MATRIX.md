# Shopify store management — audit and capability matrix (2026-10-28)

Scope: expand the read-only Shopify integration (migration 119, `shopify.js`) into store management.
API facts below were read from `shopify.dev` Admin GraphQL **2026-10** reference pages on 2026-10-28.
Nothing here was executed against a real or development store.

## 1. Existing read capabilities (before this change, still unchanged)

| Capability | Where | Scope | Authorization |
|---|---|---|---|
| Order by id / `#name`, order search (name, e-mail) | `shopify.js` `fetchOrder`, `search('order')` | `read_orders` (last 60 days) | `ihub_authorize_lookup` (store, entitlement, `store.orders`, `min_view_role`, 60/min, `data.viewed` audit) |
| Customer by id, customer search, profile with last 10 orders | `fetchCustomer`, `customerProfile`, `search('customer')` | `read_customers` | same |
| Product by id, product search by title | `fetchProduct`, `search('product')` | `read_products` | same |
| Incremental order sync (30 days, watermark, reconciliation) | `syncRecords`, `worker.js` | `read_orders` | service role, worker secret |
| Webhooks (12 topics + 3 compliance) | `handleWebhook`, `inbound.js` | — | HMAC over raw body |
| Shop identity check | `fetchShop` | none | inside `verifyConnection` |

Not available before: locations, inventory levels, collections, draft orders, discounts, fulfillment orders, returns, publications. **No mutation of any kind** (`write_operations: missing` in the provider seed).

## 2. Missing write capabilities → implemented in this change

Legend: **C** = server-enforced confirmation (two-step token), **D** = destructive.

| Area | Operation key | Shopify API | Scope | Mad3oom permission | C |
|---|---|---|---|---|---|
| Products | `product.create` | `productCreate` (status forced `DRAFT`) | `write_products` | `store.catalog` | |
| | `product.update` | `productUpdate` (title, description, vendor, type, tags — not status) | `write_products` | `store.catalog` | |
| | `product.set_status` | `productUpdate(status: ACTIVE\|DRAFT)` | `write_products` | `store.catalog` | C |
| | `product.archive` | `productUpdate(status: ARCHIVED)` | `write_products` | `store.catalog` | C |
| | `product.delete` | `productDelete(synchronous: true)` | `write_products` | `store.catalog` | C, D |
| | `product.publish` / `product.unpublish` | `publishablePublish` / `publishableUnpublish` (publication ids checked against `publications`) | `write_publications` | `store.catalog` | C |
| | `product.set_collections` | `productUpdate(collectionsToJoin/Leave)` | `write_products` | `store.catalog` | |
| Variants | `variant.create` | `productVariantsBulkCreate` | `write_products` | `store.catalog` | |
| | `variant.update` (price, compare-at, SKU, tracked, policy) | `productVariantsBulkUpdate` | `write_products` | `store.catalog` | C |
| | `variant.delete` | `productVariantsBulkDelete` | `write_products` | `store.catalog` | C, D |
| Metadata | `metafield.set` (product/variant, typed allowlist) | `metafieldsSet` | `write_products` | `store.catalog` | |
| Collections | `collection.create` / `collection.update` (custom collections) | `collectionCreate` / `collectionUpdate` | `write_products` | `store.catalog` | |
| | `collection.delete` | `collectionDelete` | `write_products` | `store.catalog` | C, D |
| Orders | `order.update_notes` (note, tags) | `orderUpdate` | `write_orders` | `store.orders_manage` | |
| | `order.update_contact` (e-mail, phone, shipping address) | `orderUpdate` | `write_orders` | `store.orders_manage` | C |
| | `order.create` (variant lines; prices read from Shopify; `financialStatus: PENDING`, no transactions, receipts off unless asked) | `orderCreate` | `write_orders` | `store.orders_manage` | C |
| | `order.cancel` (only unpaid/unfulfilled orders, no refund) | `orderCancel` (async job) | `write_orders` | `store.orders_manage` | C, D |
| Draft orders | `draft_order.create` / `draft_order.update` (variant lines, optional % discount) | `draftOrderCreate` / `draftOrderUpdate` | `write_draft_orders` | `store.orders_manage` | |
| | `draft_order.delete` | `draftOrderDelete` | `write_draft_orders` | `store.orders_manage` | C, D |
| Customers | `customer.create` / `customer.update` (name, e-mail, phone, note, tags; **no marketing consent**) | `customerCreate` / `customerUpdate` | `write_customers` | `store.customers_manage` | |
| Inventory | `inventory.adjust` (delta, compare-and-swap, reason allowlist) | `inventoryAdjustQuantities @idempotent` | `write_inventory` | `store.inventory` | C |
| | `inventory.set` (absolute, compare-and-swap) | `inventorySetQuantities @idempotent` | `write_inventory` | `store.inventory` | C |
| | `inventory.activate` (stock an item at a location) | `inventoryActivate` | `write_inventory` | `store.inventory` | C |
| Discounts | `discount.code_create` / `discount.code_update` | `discountCodeBasicCreate` / `…Update` (`context: {all: ALL}`) | `write_discounts` | `store.discounts` | C |
| | `discount.automatic_create` / `discount.automatic_update` | `discountAutomaticBasicCreate` / `…Update` | `write_discounts` | `store.discounts` | C |
| | `discount.activate` / `discount.deactivate` | `discountCode…`/`discountAutomatic…Activate/Deactivate` | `write_discounts` | `store.discounts` | C |
| | `discount.delete` | `discountCodeDelete` / `discountAutomaticDelete` | `write_discounts` | `store.discounts` | C, D |
| Fulfillment | `fulfillment.create` (+ tracking; FO ids and quantities checked against the order) | `fulfillmentCreate` | `write_merchant_managed_fulfillment_orders` | `store.fulfillment` | C |
| | `fulfillment.tracking_update` | `fulfillmentTrackingInfoUpdate` | `write_merchant_managed_fulfillment_orders` | `store.fulfillment` | C |
| Returns | `return.create` (returnable quantities checked) | `returnCreate` | `write_returns` | `store.returns` | C |
| | `return.approve` / `return.decline` / `return.cancel` / `return.close` | `returnApproveRequest` / `returnDeclineRequest` / `returnCancel` / `returnClose` | `write_returns` | `store.returns` | C |

New reads (same journal, same `data.viewed` audit and 60/min limit as lookups):
`shop.info`, `location.list` (`read_locations`), `product.list/get`, `collection.list/get`, `publication.list` (`read_publications`), `order.list/get` (financial detail), `customer.list/get`, `customer.orders`, `draft_order.list/get` (`read_draft_orders`), `inventory.levels` (`read_inventory`), `discount.list/get` (`read_discounts`), `fulfillment_order.list` (`read_merchant_managed_fulfillment_orders`), `return.list`, `returnable.list` (`read_returns`).

### Deliberately **not** implemented (separate design + approval needed)
| Operation | Why |
|---|---|
| `draftOrderComplete` | Marks the order **paid** by default (`paymentPending` deprecated) — a financial mutation. |
| `refundCreate`, `orderCapture`, `transactionVoid`, `orderMarkAsPaid`, `returnProcess` refunds, store credit | Financial mutations — excluded by instruction until reviewed and tested separately. |
| Cancelling a **paid / partially paid / authorized** order | `orderCancel` would have to decide refund vs. no refund (or void an authorization). Refused with `cancel_requires_refund_review`; the merchant cancels in Shopify admin. |
| `draftOrderInvoiceSend`, `notifyCustomer: true` defaults | Customer-facing messages — only when the user explicitly ticks "notify customer" (default off). |
| Smart (automated) collections write, BXGY / free-shipping discounts, customer segments in discounts, order edits (`orderEditBegin…`), fulfillment holds/moves, `fulfillmentCancel`, gift cards, metaobjects, themes/content, markets | Higher risk or not requested; listed in `PROVIDER_SHOPIFY.md` → Limitations. |
| `collectionAddProducts` / `collectionRemoveProducts`, `ruleSet`, `returnReason` | Deprecated in 2026-10 (we use `productUpdate.collectionsToJoin/Leave`, no rule sets, `returnReasonDefinitionId`/note). |

## 3. Scopes (app config `integrations/shopify/shopify.app.toml`)

| Scope | Needed by | Note |
|---|---|---|
| `read_orders`, `read_customers`, `read_products` | existing reads, sync, health check | **Still the only required scopes**: a connection with just these keeps working read-only. |
| `write_products` | product/variant/collection/metafield writes | implies `read_products` |
| `write_orders` | `orderUpdate`, `orderCreate`, `orderCancel` | `orderCreate` only with offline tokens (we use expiring offline tokens) |
| `read_draft_orders`, `write_draft_orders` | draft orders | |
| `write_customers` | customer create/update | protected customer data Level 2 for name/e-mail/phone/address |
| `read_inventory`, `write_inventory` | inventory levels and mutations | |
| `read_locations` | location list, validating location ids | |
| `read_discounts`, `write_discounts` | discounts | |
| `read_merchant_managed_fulfillment_orders`, `write_merchant_managed_fulfillment_orders` | fulfillment orders, `fulfillmentCreate`, tracking | Not `write_fulfillments` (legacy) and not `*_assigned_*` (fulfillment-service apps) or `*_third_party_*` (other services' locations). |
| `read_returns`, `write_returns` | returns | |
| `read_publications`, `write_publications` | sales channel publish/unpublish | |

Not requested: `read_all_orders` (orders > 60 days; needs Shopify approval), `write_fulfillments`, `*_assigned_fulfillment_orders`, `*_third_party_fulfillment_orders`, `read_product_listings`, `write_marketplace_*`, `write_quick_sale`, `read_markets`, `write_payment_terms`, store credit, gift cards.

Each management operation checks **its own scope** against `ihub_connections.granted_scopes` in the database before anything is sent to Shopify (`write_x` satisfies `read_x`). A connection made under the old read-only scopes gets `missing_scope` per operation and a "re-authorize" prompt; it is not marked unhealthy.

## 4. Files that change

| File | Change |
|---|---|
| `supabase/functions/_shared/integrations/shopify.js` | `REQUESTED_SCOPES` (authorize URL), `graphql()` also returns `errors` (additive). Required scopes and read paths unchanged. |
| `supabase/functions/_shared/integrations/shopify-admin.js` (new) | Operation catalog, strict validators, GraphQL documents, userErrors/throttle/scope mapping, preview (eligibility) checks, result mappers. |
| `supabase/functions/_shared/integrations/api.js` | New action `shopify_admin` (confirm step / execute); `shopify_start` requests management scopes only for an entitled store; other actions unchanged. |
| `supabase/functions/_shared/integrations/errors.js` | Codes `provider_rejected`, `not_eligible` (confirmation codes come from the database). |
| `integrations/shopify/shopify.app.toml` | Scopes. |
| `migrations/120_shopify_store_management.sql` (+ `_rollback/120_*.down.sql`) | See §5. |
| `assets/js/company/store-manage-model.js`, `store-manage.js` (new), `store-data.js`, `company-routes.js`, `store-model.js`, `company-dashboard.js`, `company-dashboard/index.html`, `assets/components/company-sidebar.html`, `assets/css/company-dashboard.css` | New page «إدارة المتجر» (reads `ihub_shopify_manage_status` / `ihub_shopify_ops_list` directly; operations through `ihub-api`). |
| Tests: `tests/shopify-management.test.mjs`, `tests/store-manage-model.test.mjs`, `tests/store-manage.render.test.mjs`, `tests/sql/shopify-store-management.test.sql`, `tests/fixtures/shopify/admin-fixtures.mjs`; updates to `tests/shopify-integration.test.mjs`, `tests/company-routes.test.mjs`, `tests/ecommerce-store.render.test.mjs`, `tests/fixtures/supabase-double.js` (`byOp`) | |
| `integrations/shopify/schema-check.mjs` (new, outside `npm test`) | Validates every document and variable set against the real 2026-10 schema. |
| Docs: `PROVIDER_SHOPIFY.md`, `PROD_INSTALL.md`, `ARCHITECTURE.md` | |

`inbound.js`, `worker.js`, `shopify-session.js`, `registry.js`, OAuth callback and webhook verification: **unchanged**.

## 5. Database migration 120 (additive)

- Feature flag `shopify_management` — **not granted to any plan**; allowed as a pilot override; `owner_store_test_management()` grants it to the platform owner's own test store only (≤ 30 days, reason, step-up).
- Permission catalog keys (default **off** for supervisor and agent; the store admin has them): `store.catalog`, `store.inventory`, `store.orders_manage`, `store.customers_manage`, `store.discounts`, `store.fulfillment`, `store.returns`.
- `_ihub_shopify_op(key)` — the server-side operation catalog (permission, risk, confirmation, required scope). The Edge catalog is tested to match it.
- `ihub_shopify_confirmations` — one-time confirmation tokens (hash only) bound to user + connection + operation + input hash, 5 minutes.
- `ihub_shopify_ops` — operation journal (who, what, input hash, status, error code, non-PII detail such as inventory item/location/delta/reason and resulting quantities).
- RPCs: `ihub_shopify_op_confirm_begin`, `ihub_shopify_op_authorize` (authenticated), `ihub_svc_shopify_op_result` (service role), `ihub_shopify_manage_status`, `ihub_shopify_ops_list`.
- Rate limits: reads share the lookup limit (60/min/user); writes 20/min/user and 100/min/company; destructive 5/min/user; confirmations 30/min/user.
- Provider capability metadata updated to `implemented_unverified`. Provider stays **disabled**.

## 6. Shopify approval requirements and merchant permissions

- **Protected customer data**: Level 1 for any customer/order object; Level 2 for the name, e-mail, phone and address fields we read and now write (`customerCreate/Update`, `orderUpdate` contact, `orderCreate` shipping address). Required before real merchants. Development stores work without it.
- **App Store review** only if listed. All requested scopes must be justified in the listing; reviewers reject unused scopes — each scope above maps to an implemented operation.
- **`read_all_orders`**: not requested (needs a separate Shopify approval).
- **Merchant permissions**: we use an **offline** token, so Shopify's "user must have permission X" notes (staff permissions for online tokens) do not apply; Mad3oom's own per-user permissions (§5) are the control. The merchant approves all scopes at install / re-authorization.
- **Store plan limits**: `collectionCreate/Update/Delete` refuse on Starter/Retail plans (Shopify returns an error, mapped to `provider_rejected`).
- Re-authorization is needed for existing connections to gain write scopes (`use_legacy_install_flow = true` → our own OAuth start with the new scope list). The Shopify page offers it to an entitled store whose healthy connection lacks the management scopes.
