# E-commerce Store accounts & Shopify — production install note

> **Status 2026-10-28 (approved by the product owner):**
> - **§2–§3 done.** 118 and 119 were run by the owner in the SQL Editor (not through `apply_migration`, so `supabase_migrations.schema_migrations` has **no** rows for them). Verified read-only afterwards: all 65 functions they define match a local build of the same files (the Editor stored them with CRLF line endings; identical once `\r` is removed, so production md5 fingerprints include `\r`); existing plans, plan features, companies, subscriptions and the four existing providers unchanged; new tables RLS-only with no grants; no new security advisor findings beyond the intended "authenticated can execute security-definer RPC".
> - **§4 done.** `integrations-worker`, `integrations-inbound`, `ihub-api` deployed as v7 (same `verify_jwt` as before) from the unbundled sources (`index.ts` + `_shared/integrations/*`, import path `./_shared/…`); each deployed file was read back and matches the repo byte for byte. Smoke checks: install → 302 `not_configured`, webhooks → 503 `not_configured`, unknown WooCommerce id → 404, `ihub-api` without JWT → 401.
> - **Pre-existing, not caused by this change:** the `ihub-worker` cron has returned **503 `not_configured` since before this work** — `IHUB_WORKER_SECRET` is not set as an Edge secret (see `docs/integrations/PROD_INSTALL.md` §5). Nothing depends on it yet (no connections, every provider disabled).
> - **Not done (each still needs separate approval):** Shopify app + secrets (§5), development-store verification (§6), store plan pricing/activation and provider enablement (§7).
> Production on 2026-10-28 (read-only): ledger has `088`, `090`, `092`, `095`–`111`, `114` and the Pi migrations; **not** `112`, `113`, `117`. Edge Functions `ihub-api`, `integrations-inbound`, `integrations-worker` are deployed (v6). `ihub-worker` cron runs every 5 min.

## 0. Order of operations
1. Merge the front end. It is safe before 118/119: `my_account_type` missing → no store navigation; store plan missing → the pricing card stays «قريبًا» with a disabled button; the owner «المتاجر» page shows error states.
2. Apply **118** (§2), then **119** (§3).
3. Only then deploy the three Edge Functions (§4). **Do not deploy them before 119**: the new worker calls `ihub_svc_schedule_reconciliation` / `ihub_svc_claim_sync_jobs` and the new API calls `ihub_shopify_*`; against a database without 119 every worker run would fail.
4. Create the Shopify app and set secrets (§5). Provider stays **disabled**.
5. Verify on a development store (§6).
6. Product-owner decisions, then enablement (§7).

## 1. Pre-apply checks (read-only)
- No `companies.account_kind` column; no `subscription_plans` row with key `store`; no relation `ihub_sync_jobs`, `store_%`.
- md5 of the functions 118/119 rewrite equals the fingerprints in `tests/sql/ecommerce-store-accounts.test.sql` ⓪ and `tests/sql/shopify-store-integration.test.sql` ⓪ (`my_company_account_request`, `admin_list_company_account_requests`, `_ihub_ticket_viewer`, `_ihub_connection_json`, `ihub_ticket_context`, `ihub_customer_link`, `ihub_svc_claim_due_events`). A mismatch means production drifted: stop and rebase the migration on the live text.
- `platform_feature_switches`: `company_isolation_enforced`, `company_permissions_enabled` ON (the tests ran in that state).

## 2. Apply 118
- Idempotent, additive, no `begin/commit` inside: run in one transaction (`apply_migration` name `118_ecommerce_store_accounts`).
- Effects: `companies.account_kind` default `company` (every existing company unchanged); request columns; `subscription_plans.audience`; plan `store` **inactive, NULL prices**; feature flags `shopify_integration`, `store_support` (no existing plan granted); `enforce_plan_audience`; `my_account_type`, `submit_store_account_request`, `owner_set_company_account_kind`.
- Its verification block aborts if an existing plan's audience is not `company`, an active store plan has no prices, or the new functions have unexpected grants. (Existing prices/features are not touched by 118; the post-check below confirms it.)
- Post-check: `select key, is_active, price_monthly, price_yearly, audience from subscription_plans order by sort_order;` → existing rows identical, `store` inactive with NULLs.

## 3. Apply 119
- Same way (`119_shopify_store_integration`). Seeds provider `shopify` **disabled**; adds tables (RLS, no grants), RPCs, permission keys `store.orders`/`store.requests`, cron `store-maintenance-sweep` (`23 * * * *`).
- Its final block aborts on any permissive policy, any direct table privilege, any function exposed to `anon`, or any `ihub_svc_*` exposed to `authenticated`.
- Then run `get_advisors` (security): "RLS enabled, no policy" on the new tables is intended (RPC-only).

## 4. Deploy Edge Functions
`ihub-api` (verify_jwt **true**), `integrations-inbound` (**false**), `integrations-worker` (**false**) with `_shared/integrations/*`. Never deploy over `integrations-api` (a different, existing product).
The shared modules were tested under Node only; **they were not run under Deno in this session**. Smoke checks after deploy:
- `GET integrations-inbound/shopify/install` without params → redirect to the dashboard with `ihub_result=error&ihub_code=signature_invalid` (`not_configured` while `SHOPIFY_CLIENT_SECRET` is unset).
- `POST integrations-inbound/shopify/webhooks` with a wrong `X-Shopify-Hmac-Sha256` → **401**.
- Existing WooCommerce/Salla/Daftra/WordPress smoke checks from `docs/integrations/PROD_INSTALL.md` §4 still pass.
- Next worker run returns 200 (check `ihub-worker` cron history).

## 5. Shopify app and secrets
Follow `PROVIDER_SHOPIFY.md` → Setup. Edge secrets (values never in git, chat or tickets):

| Secret | Value |
|---|---|
| `SHOPIFY_CLIENT_ID` | from the Dev Dashboard |
| `SHOPIFY_CLIENT_SECRET` | from the Dev Dashboard |
| `SHOPIFY_REDIRECT_URI` | `https://srnelrdpqkcntbgudyto.supabase.co/functions/v1/integrations-inbound/shopify/callback` |
| `SHOPIFY_API_VERSION` | optional, default `2026-10` |
| existing `IHUB_ENC_KEY`, `IHUB_PUBLIC_BASE`, `IHUB_DASHBOARD_URL`, `IHUB_WORKER_SECRET` | unchanged |

Check: Owner → «المتاجر» → diagnostics shows every value as set and «رابط الرجوع يطابق المتوقع: نعم».

## 6. Development-store verification (before enabling)
Use the Owner's **own** test company only:
1. Owner → «المتاجر» → step-up → convert the test company to a store (`owner_set_company_account_kind`, reason) → grant test entitlements ≤ 30 days (`owner_store_test_entitlements`). Do not grant entitlements to real customers.
2. Enable the provider **only for the test window** (`update ihub_providers set enabled = true where key = 'shopify'` by an admin), or test on a staging project if one is created.
3. Connect a Shopify **development store**; confirm: callback completes in the same tab; `granted_scopes` = 3 read scopes; initial sync finishes; order/customer/product lookups render; a restricted field shows as restricted, not invented.
4. Webhooks: create/update an order → event queued and applied; send the same delivery twice → one event; `shopify app webhook trigger` for the 3 compliance topics → `ihub_compliance_requests` rows with the expected status; uninstall the app → connection revoked.
5. Token refresh: wait > 1 h (or force expiry) → refresh succeeds once, no concurrent refresh.
6. Record the result for each item in `PROVIDER_SHOPIFY.md` → "Unverified". Disable the provider again until §7.

A passing development-store test does **not** prove production readiness.

## 7. Decisions and enablement (product owner)
- Store plan **price** (monthly/yearly), bundle and ticket quota → set via the existing admin plan-write path, then `is_active = true` (the constraint refuses it without two positive prices).
- Grant `integrations_hub` only through the plan bundle you decide on.
- Shopify **protected customer data** approval (Level 1 + name/e-mail fields used) before connecting real merchants; App Store review if the app will be listed.
- Then enable `shopify` in `ihub_providers`.

## 7b. Store management (120) — not applied, needs separate approval
Implemented and tested locally only (`SHOPIFY_MANAGEMENT_MATRIX.md`, `PROVIDER_SHOPIFY.md`). Order when approved:
1. Read-only pre-check: `migrations/120_*.sql` touches no 088/119 function (the SQL test fingerprints `ihub_authorize_lookup`, `_ihub_shopify_admin`, `owner_store_test_entitlements`, `ihub_shopify_begin` before/after); `company_permission_catalog` has no `store.catalog…store.returns`; no `ihub_shopify_ops`.
2. Apply **120** (`apply_migration` name `120_shopify_store_management`; idempotent, additive). It adds the `shopify_management` feature (**granted to no plan**), seven permission keys (default off for supervisor/agent), the operation catalog, confirmations and journal tables (RLS, no grants), the RPCs, and capability metadata. Its final block aborts on any policy/direct grant, an inconsistent catalog, a plan granting `shopify_management`, or an exposed internal function.
3. Then redeploy `ihub-api` with `_shared/integrations/shopify-admin.js` (and the updated `shopify.js`, `api.js`, `errors.js`). The new `ihub-api` is safe **before** 120 too: `shopify_start` falls back to the read scopes when `ihub_shopify_manage_status` is missing, and `shopify_admin` fails closed. `integrations-inbound` changed only its Shopify redirect target (`#shopify`); `integrations-worker` did not change (it imports `shopify.js`, whose changes are additive) — redeploy it only to keep the shared files identical.
4. Shopify app: `shopify app deploy` with the new toml (scopes, App URL = the `/shopify/install` handler). Each store that gets management re-authorizes from the upgrade card on its Shopify page. Redeploy `integrations-inbound` too: Shopify redirects now land on `#shopify`.
5. Development-store verification: `PROVIDER_SHOPIFY.md` → "Development-store testing steps (management)", with `owner_store_test_management` on the owner's own store only.
6. Product-owner decisions before any merchant: which plan (if any) includes `shopify_management`, and protected customer data approval covering the Level 2 fields that are now written.
Rollback: `migrations/_rollback/120_*.down.sql` (refuses while the journal has rows unless `mad3oom.rollback_discard_shopify_ops = 'on'` is set in the same transaction after exporting it; restores the pilot-override constraint and capability metadata; 119 untouched). Redeploy the previous `ihub-api` first.

## 8. Rollback
- Disable first: `update ihub_providers set enabled = false where key = 'shopify'` (webhooks are ignored, actions refused, compliance still recorded).
- `migrations/_rollback/119_*.down.sql` then `118_*.down.sql`; both refuse while Shopify connections, store requests or store companies exist, and restore the exact production text of every rewritten function. Redeploy the previous Edge Function versions **before** rolling back 119.
