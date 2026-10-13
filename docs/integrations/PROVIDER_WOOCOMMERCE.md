# WooCommerce — capability report and setup

**Status: implemented, tested with mocks only. Not verified against a real store.** Connector: `supabase/functions/_shared/integrations/woocommerce.js`.

## Verified from official sources
- Requirements for REST API v3: **WooCommerce 3.5+, WordPress 4.4+** (`_introduction.md`). The Mad3oom plugin itself declares WordPress 6.0+ / PHP 7.4+ / WooCommerce 7.0+.
- Auth over HTTPS: Basic auth, consumer key as user, secret as password. Keys are created per WordPress user with **Read**, Write or Read/Write access; they stop working if that user is deleted. Format `ck_`/`cs_` + 40 hex.
- `GET /wp-json/wc/v3/orders/<id>`; list filters incl. `search`, `modified_after`, `per_page`.
- Webhooks: topics `order.created`, `order.updated`, `order.deleted`; headers `X-WC-Webhook-Topic/-Resource/-Event/-Signature/-ID/-Delivery-ID/-Source`; signature = base64 HMAC-SHA256 of the JSON body (filterable algorithm, default sha256); creation ping body `webhook_id=<n>` must return HTTP 200; more than 5 consecutive failed deliveries disable the webhook.

## What Mad3oom does
| Operation | Implementation |
|---|---|
| Connect | Validates URL (SSRF rules) and key format; `GET /orders?per_page=1` must return 200 |
| Fetch order | `GET /orders/{id}`; if 404, `GET /orders?search=<n>` and exact `number` match |
| Stored summary | number, status, currency, total, created/paid/completed dates, payment method title, customer name, **masked** e-mail, customer id or guest flag, item count, ≤ 10 item names×qty, refunded flag |
| Never stored | addresses, phone, IP, user agent, transaction id, payment method id, customer note, meta data, coupons, tax lines |
| Webhooks | `order.created`, `order.updated`; only already-linked orders are updated; others acknowledged |
| Writes | None |

## Setup (merchant)
1. WooCommerce > Settings > Advanced > REST API > **Add key**: description "Mad3oom", user = a shop manager, **Permissions: Read**.
2. Mad3oom > Company dashboard > Integrations > WooCommerce > Connect: store URL (`https://…`, the address WordPress answers on, no redirect), key, secret.
3. Copy the **delivery URL** and **secret** shown once. WooCommerce > Settings > Advanced > Webhooks > Add: status Active, topic *Order created*, delivery URL, secret, API version **WP REST API Integration v3**. Repeat for *Order updated*.
4. Disconnect: in Mad3oom (deletes keys and cached data), then revoke the key and delete both webhooks in WooCommerce.

## To verify on staging before enabling
Key permission errors (401 vs 403 wording), HPOS stores (order edit link `post.php?post=<id>&action=edit` redirect), sequential-order-number plugins, webhook signature with a real delivery, and behaviour behind CDNs that strip the `Authorization` header (WooCommerce documents a query-string fallback, deliberately not used because it puts secrets in URLs and logs).
