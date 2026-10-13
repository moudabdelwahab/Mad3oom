# Integrations Hub — production install note and deployment checklist (NOT EXECUTED)

> **Nothing here has been run against production.** Applying 087, deploying the three Edge Functions, setting secrets, scheduling the worker, granting the entitlement and enabling any provider each need **separate explicit approval** from the product owner. Merging the PR is not that approval.
> Production on 2026-10-12: ledger head `086_company_staff`; no staging project or branch exists.

## 0. Order of operations
1. Merge the PR (front end is safe before 087: `ihub_overview` missing → the section shows "for the company admin" state with no controls; the ticket panel stays hidden).
2. Apply **087** (§2).
3. Set Edge secrets and deploy the three functions (§3, §4).
4. Schedule the worker (§5).
5. **Verify each provider on a staging account** (§6). Only then:
6. Grant `integrations_hub` to chosen plans and enable verified providers one at a time (§7).

## 1. Pre-apply checks (read-only)
- `list_migrations`: no `087_integrations_hub`; `086_company_staff` present (087 depends on `company_staff_role()`).
- No relation or function named `ihub_*`: `select count(*) from pg_class where relname like 'ihub\_%'` → 0; same for `pg_proc`.
- Production's `integration_*` functions exist and their grants are recorded (087 must not touch them):
  ```sql
  select p.oid::regprocedure, has_function_privilege('authenticated', p.oid, 'EXECUTE') auth,
         has_function_privilege('service_role', p.oid, 'EXECUTE') svc
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like 'integration\_%' order by 1;
  ```

## 2. Apply 087
- The file is idempotent and has no `begin/commit`; wrap it in `begin; … commit;` in the SQL editor (or `apply_migration` with name `087_integrations_hub`).
- The final block aborts the transaction unless: 11 tables with RLS, restrictive `gate_account_active`, preview trigger, no permissive policy, no table privilege for `authenticated/anon/service_role`; exactly 16 `ihub_*` functions executable by `authenticated`; `ihub_svc_*` only for `service_role`; internal helpers for nobody; fixed `search_path`.
- It registers `feature_flags('integrations_hub')` (no plan grant), seeds 4 providers **disabled**, and schedules `ihub-retention-sweep` (`41 3 * * *`).

### Post-apply verification (read-only)
```sql
select key, enabled from public.ihub_providers order by key;                       -- 4 rows, all false
select count(*) from public.plan_features where feature_key = 'integrations_hub'; -- 0
select jobname, schedule from cron.job where jobname = 'ihub-retention-sweep';    -- 1 row
-- repeat the §1 integration_* query: identical output
```
Then `get_advisors` (security): "RLS enabled, no policy" on `ihub_*` is intended.

## 3. Edge secrets
| Secret | Value |
|---|---|
| `IHUB_ENC_KEY` | ≥ 32 random characters, **new** (not `INTEGRATIONS_ENC_KEY`). Losing it makes stored credentials unreadable; companies would reconnect |
| `IHUB_KEY_VERSION` | `1` |
| `IHUB_PUBLIC_BASE` | `https://srnelrdpqkcntbgudyto.supabase.co/functions/v1` |
| `IHUB_DASHBOARD_URL` | `https://mad3oom.com/company-dashboard/` |
| `IHUB_WORKER_SECRET` | ≥ 32 random characters (also stored in Vault, §5) |
| `SALLA_CLIENT_ID`, `SALLA_CLIENT_SECRET`, `SALLA_REDIRECT_URI`, `SALLA_WEBHOOK_SECRET` | From Salla Partners (only when enabling Salla); redirect = `IHUB_PUBLIC_BASE/integrations-inbound/salla/callback` |

## 4. Deploy the Edge Functions
| Function | `verify_jwt` | Files |
|---|---|---|
| `integrations-api` | **true** | `integrations-api/index.ts` + `_shared/integrations/*` |
| `integrations-inbound` | **false** (webhooks, OAuth callback, plugin — each route authenticates itself) | `integrations-inbound/index.ts` + `_shared/integrations/*` |
| `integrations-worker` | **false** (secret header) | `integrations-worker/index.ts` + `_shared/integrations/*` |

The shared modules are plain ES modules (no Deno APIs) except `deno-deps.ts`. **They were not executed under Deno in this session** (no Deno available); a staging deploy must confirm they bundle and run. Smoke checks after deploy:
- `POST integrations-inbound/salla` with no headers → **503** while Salla secrets are unset (fail closed).
- `POST integrations-worker` without the header → **401** (or 503 if the secret is unset).
- `POST integrations-inbound/woocommerce/<random uuid>` → **404**.

## 5. Schedule the worker
```sql
select vault.create_secret('<IHUB_WORKER_SECRET>', 'ihub_worker_secret');
select cron.schedule('ihub-worker', '*/5 * * * *', $$
  select net.http_post(
    url := 'https://srnelrdpqkcntbgudyto.supabase.co/functions/v1/integrations-worker',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-ihub-worker-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'ihub_worker_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 30000);
$$);
```

## 6. Staging verification plan (required before enabling a provider)
Use a non-production company with fixture data and provider sandbox accounts; enable the provider **only** inside a transaction or on a staging project.
| Provider | Verify |
|---|---|
| WordPress | Install the ZIP on WordPress 6.x/PHP 7.4+ and 8.x; pair; Test; submit the form as guest and as a customer with an order; check rate limit, honeypot, uninstall; Arabic locale |
| WooCommerce | Read key connect; wrong key → `auth_failed`; link an order; HPOS on/off; webhook ping and a signed `order.updated`; out-of-order delivery; disconnect + key revoke |
| Salla | Demo store OAuth (same tab completes; another tab/browser does not); signature encoding with a real delivery; order field mapping; `app.uninstalled`; token refresh via worker |
| Daftra | Trial account: header name, `.json` paths, invoice/client field names, error codes |
Record results in each `PROVIDER_*.md` and flip capabilities to `implemented_verified` only for what was observed.

## 7. Enable (after verification)
```sql
-- entitlement (product decision): example for the 'support' and 'ultimate' plans
insert into public.plan_features (plan_id, feature_key, enabled)
select id, 'integrations_hub', true from public.subscription_plans where key in ('support', 'ultimate')
on conflict do nothing;
-- one provider at a time
update public.ihub_providers set enabled = true, updated_at = now() where key = 'woocommerce';
```
Kill switch: `update public.ihub_providers set enabled = false where key = '<provider>';` blocks new connections, tests, linking and inbound events immediately; existing data stays until disconnect.

## 8. Rollback and recovery
- **Front end only:** revert the dashboard files; RPCs become inert.
- **Functions:** delete or redeploy previous versions; with them gone, webhooks return 404 and the dashboard shows errors on connect/test.
- **Schema:** `migrations/_rollback/087_integrations_hub.down.sql` (one transaction). It refuses while connections, intake, audit rows or plan grants exist unless the session sets `integrations_hub.rollback_discard_data = 'on'`; it drops only `ihub_*` objects, the cron job and the `integrations_hub` feature flag (plan grants cascade). It never touches tickets, companies, `company_staff` or production's `integration_*` objects (tested). Roll back 087 **before** 086 if both are ever rolled back.
- Partial apply: nothing to undo (single transaction; the verification block aborts it).
- Key loss (`IHUB_ENC_KEY`): stored credentials cannot be decrypted (`not_configured`); companies disconnect and reconnect.
