# Salla — capability report and setup

**Status: implemented, tested with mocks only. Not verified against a real store. Not published on the Salla App Store.** Connector: `supabase/functions/_shared/integrations/salla.js`.

## Verified from official Salla sources
- `SallaApp/oauth2-merchant`: authorize `https://accounts.salla.sa/oauth2/auth`, token `…/oauth2/token`, user info `…/oauth2/user/info` (response `data.id`, `data.merchant.id`, `data.merchant.name`); scopes comma-separated; `offline_access` needed for a refresh token; **access tokens expire after 14 days**; API `https://api.salla.dev/admin/v2/...`.
- `SallaApp/laravel-starter-kit`: webhook body `{event, merchant, created_at, data}`; an `app.uninstalled` action exists.
- `SallaApp/express-starter-kit`: event names (`order.created`, `order.updated`, `order.status.updated`, …); Easy vs Custom authorization modes; app credentials (client id, client secret, **webhook secret**) come from the Salla Partners portal.

## Seen only through search snippets of docs.salla.dev (blocked here)
- Default webhook security strategy is **Signature**: headers `X-Salla-Security-Strategy: Signature` and `X-Salla-Signature`, a SHA-256 hash of the body using the webhook secret.

## Unverified — must be confirmed on a demo store
- Signature **encoding** (hex or base64). Mad3oom accepts both of the same HMAC.
- `GET /admin/v2/orders/{id}` response fields. Mapping reads only `id`, `reference_id`, `status.name|slug`, `amounts.total.{amount,currency}`, `date.date`, `payment_method`, `customer.{id,first_name,last_name,email}`, `items[].{name,quantity}`, `urls.admin` (salla.sa only), and marks the summary `field_mapping: unverified`.
- Whether refresh tokens rotate and are single-use (assumed; the worker is the only refresher).
- Any token-revocation endpoint (none used).
- Rate limits.
- Whether PKCE is supported (not used; confidential client with secret on the server, plus state and browser binding).

## Why Custom mode
Easy mode delivers tokens in an `app.store.authorize` webhook with no `state`, so Mad3oom could not tell which company installed the app. Custom mode returns to our callback with a `state` we issued.

## Setup (Mad3oom platform owner, once)
1. Create an app in **Salla Partners**: type *Custom/Private* for beta, authorization mode **Custom**, callback `https://<project>.supabase.co/functions/v1/integrations-inbound/salla/callback`, webhook URL `https://<project>.supabase.co/functions/v1/integrations-inbound/salla`, security strategy **Signature**, scopes **orders.read** (and `customers.read` only if later needed), events `order.created`, `order.updated`, `order.status.updated`, `app.uninstalled`.
2. Set Edge secrets `SALLA_CLIENT_ID`, `SALLA_CLIENT_SECRET`, `SALLA_REDIRECT_URI`, `SALLA_WEBHOOK_SECRET`.
3. Verify on a demo store (see above), then publish through Salla's review if public availability is wanted. **Until that review is complete, do not describe the app as available on the Salla App Store.**

## Setup (merchant)
Mad3oom > Integrations > Salla > *Connect via Salla* → approve on Salla → you return to the dashboard **in the same tab** and the connection completes. To disconnect: Mad3oom > Disconnect, then remove the app in the Salla dashboard.
